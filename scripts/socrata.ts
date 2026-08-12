// Shared access to the NYC Open Data (Socrata) endpoints the data pipelines read.

import pRetry from "p-retry";
import { cached } from "./cache";

export interface Coord {
  lat: number;
  lng: number;
}

// A standing tree, with the trunk diameter its crown is sized from. ForMS records `dbh` in
// whole inches; 734 of the 898,618 standing trees carry none, and the ingest is what decides
// what to do about that. `genus` is the first token of the scientific name, "" when unknown.
export interface Tree extends Coord {
  dbhInches: number;
  genus: string;
}

const PAGE_SIZE = 50_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const BATCH_KEYS = 200; // keys per `field in (...)`; longer lists start timing out
const BATCH_WORKERS = 8;
const BATCH_PROGRESS = 50; // batches between progress lines
const TREE_DATASET = "hn5i-inap"; // ForMS "Forestry Tree Points"
const TREE_COUNT = 898_618; // standing trees at the last refresh; a floor, not a number
// The city keeps planting, so only a shortfall this far below the expected count is a page
// the server quietly cut short rather than a year of removals.
const SHORTFALL = 0.05;

async function fetchJson<Row>(url: string): Promise<Row[]> {
  try {
    return await pRetry(
      async () => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return (await response.json()) as Row[];
      },
      {
        retries: MAX_ATTEMPTS - 1,
        minTimeout: RETRY_BASE_MS,
        maxTimeout: RETRY_CAP_MS,
        randomize: true,
        onFailedAttempt: ({ error, attemptNumber }) => {
          console.error(
            `  attempt ${attemptNumber}/${MAX_ATTEMPTS} failed: ${error}`,
          );
        },
      },
    );
  } catch (error) {
    throw new Error(`failed to fetch ${url}: ${error}`);
  }
}

// Pages in `:id` order, the only ordering Socrata guarantees is stable across the requests
// that make up one paged read.
export async function fetchDataset<Row>(
  dataset: string,
  query: Record<string, string>,
  expected: number,
): Promise<Row[]> {
  return await cached(dataset, JSON.stringify(query), async () => {
    const rows: Row[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const url = new URL(
        `https://data.cityofnewyork.us/resource/${dataset}.json`,
      );
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set("$order", ":id");
      url.searchParams.set("$limit", String(PAGE_SIZE));
      url.searchParams.set("$offset", String(offset));

      const page = await fetchJson<Row>(url.toString());
      for (const row of page) {
        rows.push(row);
      }
      console.error(`  fetched ${rows.length}/${expected}`);
      if (page.length < PAGE_SIZE) {
        // A short page ends the read, so a server-side cap or a throttled response would
        // otherwise pass for the end of the dataset and truncate it silently.
        if (rows.length < expected * (1 - SHORTFALL)) {
          throw new Error(
            `${dataset} returned ${rows.length} rows, ${expected} expected: the read was truncated`,
          );
        } else if (rows.length !== expected) {
          console.error(
            `  note: ${dataset} has ${rows.length} rows, not the ${expected} expected`,
          );
        }
        return rows;
      }
    }
  });
}

// Every row whose `field` is one of `keys`, read as `field in (...)` batches run `concurrency` at a
// time. Each batch is cached on its own, so a re-run costs nothing and a batch the server 500s on
// costs one batch rather than the whole read.
export async function fetchKeyed<Row>(
  dataset: string,
  select: string,
  field: string,
  keys: Iterable<string>,
  concurrency: number = BATCH_WORKERS,
): Promise<Row[]> {
  const sorted = [...new Set(keys)].sort();
  const batches: string[][] = [];
  for (let start = 0; start < sorted.length; start += BATCH_KEYS) {
    batches.push(sorted.slice(start, start + BATCH_KEYS));
  }

  const pages: Row[][] = new Array(batches.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const index = next++;
      const batch = batches[index];
      pages[index] = await cached(
        `${dataset}.${field}`,
        `${select}|${batch.join(",")}`,
        async () => {
          const url = new URL(
            `https://data.cityofnewyork.us/resource/${dataset}.json`,
          );
          const list = batch.map((key) => `'${key}'`).join(",");
          url.searchParams.set("$select", select);
          url.searchParams.set("$where", `${field} in (${list})`);
          url.searchParams.set("$limit", String(PAGE_SIZE));
          return await fetchJson<Row>(url.toString());
        },
        true,
      );
      done += 1;
      if (done % BATCH_PROGRESS === 0 || done === batches.length) {
        console.error(`  ${dataset}: ${done}/${batches.length} batches`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, worker),
  );
  return pages.flat();
}

// Socrata returns points as WKT, e.g. "POINT(-73.8165 40.7162)" (lng first).
export function parseWktPoint(wkt: string): Coord | null {
  const match =
    /^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/.exec(
      wkt.trim(),
    );
  if (!match) {
    return null;
  } else {
    return { lng: Number(match[1]), lat: Number(match[2]) };
  }
}

// The genus is the first whitespace token of the scientific name, the part of `genusspecies`
// before " - " (e.g. "Acer nigrum - black maple" -> "Acer", "Quercus" -> "Quercus"). A blank
// or "Unknown" name has no genus and comes back as "".
function genusOf(genusspecies: string | undefined): string {
  const scientific = (genusspecies ?? "").split(" - ")[0].trim();
  const genus = scientific.split(/\s+/)[0] ?? "";
  if (genus === "" || genus === "Unknown") {
    return "";
  } else {
    return genus;
  }
}

// Every standing tree in the NYC Parks forestry inventory; stumps and empty pits
// are excluded by tpstructure. A missing dbh comes back as 0 — the ingest imputes it.
export async function fetchNycTrees(): Promise<Tree[]> {
  // `*` so a newly-read column (here genusspecies) is free after one refetch: the disk cache
  // keys on the query, so narrowing $select would force a full re-page on every added column.
  const rows = await fetchDataset<{
    geometry?: string;
    dbh?: string;
    genusspecies?: string;
  }>(TREE_DATASET, { $select: "*", $where: "tpstructure='Full'" }, TREE_COUNT);
  const trees: Tree[] = [];
  for (const row of rows) {
    const coord = row.geometry ? parseWktPoint(row.geometry) : null;
    if (coord) {
      const dbh = Number.parseInt(row.dbh ?? "", 10);
      trees.push({
        ...coord,
        dbhInches: Number.isFinite(dbh) ? dbh : 0,
        genus: genusOf(row.genusspecies),
      });
    }
  }
  return trees;
}
