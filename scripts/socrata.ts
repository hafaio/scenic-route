// Shared access to the NYC Open Data (Socrata) endpoints the data pipelines read.

import { cached } from "./cache";

export interface Coord {
  lat: number;
  lng: number;
}

const PAGE_SIZE = 50_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
const TREE_DATASET = "hn5i-inap";
const TREE_COUNT = 898_618;
// The expected counts are constants and the city keeps planting, so what a read is checked
// against is a floor, not a number: anything above it is drift, and only a shortfall this
// far below it is a page the server quietly cut short rather than a year of removals.
const SHORTFALL = 0.05;

async function fetchJson<Row>(url: string): Promise<Row[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return (await response.json()) as Row[];
    } catch (error) {
      lastError = error;
      console.error(`  attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * attempt),
        );
      }
    }
  }
  throw new Error(`failed to fetch ${url}: ${lastError}`);
}

// Pages a dataset in `:id` order, the only ordering Socrata guarantees is stable
// across the requests that make up one paged read. The whole result is cached on disk
// under the dataset and its query, so a second run of the pipeline does no network at all.
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

// Every standing tree in the NYC Parks forestry inventory; stumps and empty pits
// are excluded by tpstructure.
export async function fetchNycTrees(): Promise<Coord[]> {
  const rows = await fetchDataset<{ geometry?: string }>(
    TREE_DATASET,
    { $select: "geometry", $where: "tpstructure='Full'" },
    TREE_COUNT,
  );
  const coords: Coord[] = [];
  for (const row of rows) {
    const coord = row.geometry ? parseWktPoint(row.geometry) : null;
    if (coord) {
      coords.push(coord);
    }
  }
  return coords;
}
