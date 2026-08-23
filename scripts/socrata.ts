// Shared access to the Socrata endpoints the data pipelines read. Every city publishing on Socrata
// speaks the same API, so a second city is a second host here rather than a second reader.

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
// The ladder has to outlast an outage, not a blip: on 2026-08-12 the building footprints went away
// for the seven minutes six attempts covered, and the read that failed answered in 0.2 s once it
// came back. Eight attempts capped at two minutes reach past twenty.
const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 120_000;
// four times the heaviest observed read
const REQUEST_TIMEOUT_MS = 90_000;
// Empty rather than absent on a fork: an unset secret reaches the step as "", and sending that as a
// token is worse than sending none.
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || undefined;
// Keys per `field in (...)` for a light row; a call site whose rows are heavy passes its own. The
// ceiling is the URL rather than the query: past ~1,100 keys the request comes back 414.
const BATCH_KEYS = 200;
const BATCH_WORKERS = 8;
const BATCH_PROGRESS = 50; // batches between progress lines
const TREE_DATASET = "hn5i-inap"; // ForMS "Forestry Tree Points"
const TREE_COUNT = 898_618; // standing trees at the last refresh; a floor, not a number
// The city keeps planting, so only a shortfall this far below the expected count is a page
// the server quietly cut short rather than a year of removals.
const SHORTFALL = 0.05;

// The host is part of what was asked for, so it is part of the cache key: two cities can publish
// the same 4x4 dataset id, and a stale entry serving one city's rows for the other's read would be
// invisible — the rows parse, the counts look plausible, and nothing downstream knows better.
function cacheKey(host: string, query: Record<string, string>): string {
  return JSON.stringify({ host, ...query });
}

// Bun's own suggestion when a socket dies mid-request, behind a switch because it prints per
// connection and only CI needs it.
const VERBOSE = process.env.SOCRATA_VERBOSE === "1";

// What a failed attempt took, which is the difference between a request that was never accepted and
// one the server thought about. Reading it off the CI timestamps meant reconstructing it by hand.
function attemptShape(elapsedMs: number): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  if (elapsedMs >= REQUEST_TIMEOUT_MS - 1_000) {
    return `${seconds}s (ran out the clock)`;
  } else if (elapsedMs < 5_000) {
    return `${seconds}s (refused early)`;
  } else {
    return `${seconds}s`;
  }
}

// A network failure, restated so p-retry will try again. Its own message and stack are kept — only
// the constructor changes, because that is the whole of what p-retry inspects. A deliberate abort
// keeps its name so the timeout still stops the attempt.
async function retryable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TypeError) {
      const restated = new Error(error.message, { cause: error });
      restated.stack = error.stack;
      throw restated;
    }
    throw error;
  }
}

async function fetchJson<Row>(url: string): Promise<Row[]> {
  const headers: Record<string, string> =
    APP_TOKEN === undefined ? {} : { "X-App-Token": APP_TOKEN };
  try {
    // Written by the attempt and read by its failure handler, which runs outside the attempt's own
    // scope.
    let attemptStarted = Date.now();
    return await pRetry(
      async () => {
        attemptStarted = Date.now();
        // A fetch that dies mid-body throws a TypeError, and p-retry ABANDONS the retry on any
        // TypeError whose message its `is-network-error` list does not recognise — reasoning that a
        // TypeError is usually a bug rather than a network fault. Bun's message for it, "The socket
        // connection was closed unexpectedly", is not on that list, and the gate runs before
        // `shouldRetry` so it cannot be overridden. The effect was silent and total: eight retries
        // collapsed to one attempt the day CI moved from bun 1.3.14 to 1.4.0, and the shed job failed
        // every day after on a fault a second attempt clears.
        //
        // Rethrowing as a plain Error is what gets the retries back. This reads a public dataset over
        // the open internet, where a failure is transient until proven otherwise.
        const response = await retryable(() =>
          fetch(url, {
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            verbose: VERBOSE,
          } as RequestInit),
        );
        if (!response.ok) {
          // Socrata says WHY in its own headers, and a bare status line throws that away — an
          // expired token and an over-quota address are both "403" until you read them.
          const told = ["x-socrata-requestid", "x-error-code", "server", "date"]
            .map((name) => `${name}=${response.headers.get(name) ?? "-"}`)
            .join(" ");
          throw new Error(`${response.status} ${response.statusText} ${told}`);
        }
        return (await retryable(() => response.json())) as Row[];
      },
      {
        retries: MAX_ATTEMPTS - 1,
        minTimeout: RETRY_BASE_MS,
        maxTimeout: RETRY_CAP_MS,
        randomize: true,
        onFailedAttempt: ({ error, attemptNumber }) => {
          console.error(
            `  attempt ${attemptNumber}/${MAX_ATTEMPTS} failed after ${attemptShape(Date.now() - attemptStarted)}: ${error}`,
          );
        },
      },
    );
  } catch (error) {
    // One last read of the same URL without the token, from this process and this network stack, so
    // the token is tested where the failure actually happens rather than from a laptop that cannot
    // reproduce it. Short, and its own failure is swallowed — this is a note for the log, not a
    // retry.
    if (APP_TOKEN !== undefined) {
      const verdict = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      }).then(
        (response) => `answered ${response.status}`,
        (reason) => `failed too: ${reason}`,
      );
      console.error(`  the same read without the app token ${verdict}`);
    }
    throw new Error(`failed to fetch ${url}: ${error}`);
  }
}

// Pages in `:id` order, the only ordering Socrata guarantees is stable across the requests
// that make up one paged read.
async function fetchDataset<Row>(
  host: string,
  dataset: string,
  query: Record<string, string>,
  expected: number,
): Promise<Row[]> {
  return await cached(dataset, cacheKey(host, query), async () => {
    const rows: Row[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const url = new URL(`https://${host}/resource/${dataset}.json`);
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

// How a keyed read is cut up. Named rather than positional because both are counts, and a call site
// that swapped them would still typecheck.
export interface Batching {
  batchKeys?: number;
  concurrency?: number;
}

// Every row whose `field` is one of `keys`, read as `field in (...)` batches run `concurrency` at a
// time. Each batch is cached on its own, so a re-run costs nothing and a batch the server 500s on
// costs one batch rather than the whole read.
async function fetchKeyed<Row>(
  host: string,
  dataset: string,
  select: string,
  field: string,
  keys: Iterable<string>,
  { batchKeys = BATCH_KEYS, concurrency = BATCH_WORKERS }: Batching = {},
): Promise<Row[]> {
  const sorted = [...new Set(keys)].sort();
  const batches: string[][] = [];
  for (let start = 0; start < sorted.length; start += batchKeys) {
    batches.push(sorted.slice(start, start + batchKeys));
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
        cacheKey(host, { $select: select, batch: batch.join(",") }),
        async () => {
          const url = new URL(`https://${host}/resource/${dataset}.json`);
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

// One city's Socrata deployment. Reads go through a bound host rather than taking one as an
// argument, so a source module names its city once and cannot then read the wrong one.
export interface Socrata {
  dataset<Row>(
    dataset: string,
    query: Record<string, string>,
    expected: number,
  ): Promise<Row[]>;
  keyed<Row>(
    dataset: string,
    select: string,
    field: string,
    keys: Iterable<string>,
    batching?: Batching,
  ): Promise<Row[]>;
  // Where a human goes to read about a dataset, for the manifest's source links.
  page(dataset: string): string;
}

function socrata(host: string): Socrata {
  return {
    dataset: (dataset, query, expected) =>
      fetchDataset(host, dataset, query, expected),
    keyed: (dataset, select, field, keys, batching) =>
      fetchKeyed(host, dataset, select, field, keys, batching),
    page: (dataset) => `https://${host}/d/${dataset}`,
  };
}

export const NYC_OPEN_DATA = socrata("data.cityofnewyork.us");
export const DATA_SF = socrata("data.sfgov.org");

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
  const rows = await NYC_OPEN_DATA.dataset<{
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
