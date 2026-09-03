// The East Bay's street-tree registers: Oakland's and Berkeley's, the two points-with-a-trunk
// inventories the genus overlay draws on this side of the bay.
//
// What a register is for here is narrow and worth stating, because the name suggests more: these
// points do NOT feed the cover field or the shade. Cover comes from the measured canopy polygons
// (scripts/alcc.ts) and a crown's height from the raster under it. A register carries a species,
// which becomes a genus byte and a colour, and a trunk diameter, which the published allometry in
// scripts/allometry.ts turns into the radius of the dot drawn for it. A city with no register loses
// one overlay and nothing else.
//
// The two are fetched differently on purpose. Oakland publishes an "Oakland Public Tree Inventory"
// layer that is maintained and answers today, so it is read live and disk-cached like every other
// source. Berkeley's is not: the service the city's own hub links is token-protected, the Socrata
// copy was delisted, and the only public copy left is a layer literally named `Trees_Test` whose
// last edit was February 2022. Building on an endpoint in that state is building on sand, so what
// this reads is a COPY of it, committed under data/trees/ — the same treatment the raw ferry GTFS
// feeds get, and for the same reason. `bun run scripts/east-bay-trees.ts --snapshot` is what
// rewrites the copy; nothing in a build ever touches the live layer.
//
// Licences, for the record. Neither city states one. Oakland's sits on its open-data hub with no
// terms and no share-alike; Berkeley's layer credits "Arborwell. City of Berkeley Parks, Recreation
// & Waterfront - Parks Division. City of Berkeley Information Technology Department." and states no
// restriction. Both are credited in the About dialog as a courtesy.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import pRetry from "p-retry";
import { cached } from "./cache";
import type { Coord, Tree } from "./socrata";

const OAKLAND_SERVICE =
  "https://services.arcgis.com/9tC74aDHuml0x5Yz/arcgis/rest/services/Oakland_Public_Tree_Inventory_/FeatureServer/0";
const BERKELEY_SERVICE =
  "https://services1.arcgis.com/IYiCpZoSIq9lAxi8/arcgis/rest/services/Trees_Test/FeatureServer/0";

export const OAKLAND_TREE_ATTRIBUTION = "Oakland Public Tree Inventory";
export const BERKELEY_TREE_ATTRIBUTION =
  "City of Berkeley street trees (Arborwell survey), frozen copy";

// The committed copy of the Berkeley layer: gzipped JSON, one array per tree of the four things the
// ingest reads. Not LFS — data/trees/*.bin is, a .json.gz is not, and this is under a megabyte and
// written once.
const BERKELEY_SNAPSHOT = join(
  import.meta.dirname,
  "..",
  "data",
  "trees",
  "berkeley-trees.json.gz",
);

// Each page is a request of its own, cached by its URL, so a read interrupted halfway keeps what it
// already has. Oakland's layer caps a page at 1,000 rows and Berkeley's at 2,000; asking for more
// is silently capped, so the page size has to be the layer's own.
const OAKLAND_PAGE_SIZE = 1_000;
const BERKELEY_PAGE_SIZE = 2_000;
// Floors, not exact counts: a service that answers a truncated layer fails here rather than shipping
// a city with a third of its trees. Measured 2026-08-29 — Oakland 70,420 rows, Berkeley 46,732.
const OAKLAND_ROW_FLOOR = 65_000;
const BERKELEY_ROW_FLOOR = 45_000;

const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";

interface GeoJsonFeature<Properties> {
  properties?: Properties;
  geometry?: { type?: string; coordinates?: [number, number] } | null;
}

interface GeoJsonPage<Properties> {
  features?: GeoJsonFeature<Properties>[];
  error?: { code: number; message: string };
}

// One page. ArcGIS reports a query error as a 200 with an `{ error }` body, so the status alone is
// not enough — an unchecked error page would cache as a permanent empty page and truncate the layer.
async function fetchPage<Properties>(
  url: string,
): Promise<GeoJsonFeature<Properties>[]> {
  return await pRetry(
    async () => {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as GeoJsonPage<Properties>;
      if (body.error) {
        throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
      } else if (!Array.isArray(body.features)) {
        throw new Error("no features in the response");
      }
      return body.features;
    },
    {
      retries: MAX_ATTEMPTS - 1,
      minTimeout: RETRY_BASE_MS,
      maxTimeout: RETRY_CAP_MS,
      randomize: true,
    },
  );
}

// A whole point layer, paged. `order` is the layer's own object-id field: without an order an ArcGIS
// layer may repeat or skip rows between `resultOffset` pages.
//
// `cache` is off for the one read that must not be served from disk: taking the Berkeley copy. Every
// other source here is cached and never expires, which is right for a build — but a snapshot read
// off the cache would rewrite the committed file from the pages of the last snapshot while stamping
// it with today's date and the layer's live edit date, so the file would claim a vintage its rows do
// not have. That is the one thing the copy exists to record.
async function fetchLayer<Properties>(
  name: string,
  service: string,
  fields: string,
  order: string,
  pageSize: number,
  cache = true,
): Promise<GeoJsonFeature<Properties>[]> {
  const features: GeoJsonFeature<Properties>[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`${service}/query`);
    url.searchParams.set("where", "1=1");
    url.searchParams.set("outFields", fields);
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("orderByFields", order);
    url.searchParams.set("f", "geojson");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(pageSize));
    const query = url.toString();
    const page = cache
      ? await cached(
          `${name}-${offset}`,
          query,
          () => fetchPage<Properties>(query),
          true,
        )
      : await fetchPage<Properties>(query);
    features.push(...page);
    if (page.length < pageSize) {
      return features;
    }
  }
}

// When the layer itself was last edited, off its own metadata: the survey's vintage, which is the
// one thing about a frozen copy a reader has to be told and no row carries. Retried like a page,
// because it is asked for after every one of them has been read and a blip here would throw the
// whole snapshot away.
async function lastEditedOn(service: string): Promise<string> {
  const edited = await pRetry(
    async () => {
      const response = await fetch(`${service}?f=json`, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as {
        editingInfo?: { lastEditDate?: number };
        error?: { code: number; message: string };
      };
      if (body.error) {
        throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
      } else if (body.editingInfo?.lastEditDate === undefined) {
        throw new Error("no last edit date in the response");
      }
      return body.editingInfo.lastEditDate;
    },
    {
      retries: MAX_ATTEMPTS - 1,
      minTimeout: RETRY_BASE_MS,
      maxTimeout: RETRY_CAP_MS,
      randomize: true,
    },
  );
  return new Date(edited).toISOString().slice(0, 10);
}

function pointOf(feature: GeoJsonFeature<unknown>): Coord | null {
  const point = feature.geometry?.coordinates;
  if (
    !point ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    (point[0] === 0 && point[1] === 0)
  ) {
    return null;
  }
  return { lng: point[0], lat: point[1] };
}

interface OaklandRow {
  Species___genus?: string | null;
  DBH?: number | null;
}

// What Oakland files under `Species___genus` that is not a genus. Two of them are not a tree at all
// and the row goes; the other two are a tree whose species nobody recorded, and those stay as points
// with an unknown genus, exactly as a tail genus does.
const OAKLAND_NOT_A_TREE = new Set(["stump", "new planting"]);
const OAKLAND_UNIDENTIFIED = new Set(["unknown tree", "palm species"]);

export async function fetchOaklandTrees(): Promise<Tree[]> {
  const features = await fetchLayer<OaklandRow>(
    "oakland-trees",
    OAKLAND_SERVICE,
    "Species___genus,DBH",
    "ObjectId",
    OAKLAND_PAGE_SIZE,
  );
  if (features.length < OAKLAND_ROW_FLOOR) {
    throw new Error(
      `Oakland's tree inventory answered ${features.length} rows, fewer than the ${OAKLAND_ROW_FLOOR} it holds: the read was truncated`,
    );
  }
  const trees: Tree[] = [];
  let notTrees = 0;
  for (const feature of features) {
    const point = pointOf(feature);
    // Every value in this column carries a trailing space, so nothing here can compare untrimmed.
    const genus = (feature.properties?.Species___genus ?? "").trim();
    if (point === null) {
      continue;
    } else if (OAKLAND_NOT_A_TREE.has(genus.toLowerCase())) {
      notTrees += 1;
      continue;
    }
    const dbh = feature.properties?.DBH ?? 0;
    trees.push({
      ...point,
      dbhInches: Number.isFinite(dbh) && dbh > 0 ? dbh : 0,
      genus: OAKLAND_UNIDENTIFIED.has(genus.toLowerCase()) ? "" : genus,
    });
  }
  console.error(
    `  oakland: ${features.length} rows, ${trees.length} standing trees (${notTrees} stumps and empty plantings dropped)`,
  );
  return trees;
}

// One Berkeley row as the snapshot stores it: longitude, latitude, the scientific name its `SPECIES`
// column holds, and the trunk diameter its `DSH` column holds as a string. Four values in an array
// rather than an object with four keys, because there are 46,732 of them and the keys would be most
// of the file.
type BerkeleyRow = [number, number, string, string];

interface BerkeleySnapshot {
  // What the copy is of and when, so the file says where to go to make another and how stale the one
  // in hand is. `lastEdited` is the LAYER's own last edit, which is the survey's vintage; `copied` is
  // only when this file was written.
  service: string;
  lastEdited: string;
  copied: string;
  rows: BerkeleyRow[];
}

interface BerkeleyProperties {
  SPECIES?: string | null;
  DSH?: string | null;
}

// Berkeley's `SPECIES` column is the scientific binomial, and its `GENUS` column is empty on every
// row — so the genus is parsed from the species. The values that are not a plant name at all are
// the vacant planting sites and the stumps, which are not trees and are dropped, plus one row whose
// species is a spreadsheet's `#VALUE!` error.
const BERKELEY_NOT_A_TREE = new Set(["planting site", "stump", "#value!"]);

function berkeleyGenusOf(species: string): string {
  // A nothogenus — a named hybrid between two genera — is written "x Cupressocyparis leylandii" or
  // "× Chitalpa tashkentensis"; the marker is not the genus, the word after it is.
  const words = species
    .replace(/^[x×]\s+/i, "")
    .trim()
    .split(/\s+/);
  const genus = words[0] ?? "";
  return /^[A-Z][a-z-]+$/.test(genus) ? genus : "";
}

function berkeleyTrees(snapshot: BerkeleySnapshot): Tree[] {
  const trees: Tree[] = [];
  let notTrees = 0;
  for (const [lng, lat, species, dsh] of snapshot.rows) {
    const name = species.trim();
    if (BERKELEY_NOT_A_TREE.has(name.toLowerCase())) {
      notTrees += 1;
      continue;
    }
    const dbh = Number.parseFloat(dsh);
    trees.push({
      lat,
      lng,
      dbhInches: Number.isFinite(dbh) && dbh > 0 ? dbh : 0,
      genus: berkeleyGenusOf(name),
    });
  }
  console.error(
    `  berkeley: ${snapshot.rows.length} rows last edited ${snapshot.lastEdited}, ${trees.length} standing trees (${notTrees} planting sites and stumps dropped)`,
  );
  return trees;
}

export async function fetchBerkeleyTrees(): Promise<Tree[]> {
  const snapshot = JSON.parse(
    gunzipSync(await readFile(BERKELEY_SNAPSHOT)).toString("utf-8"),
  ) as BerkeleySnapshot;
  return berkeleyTrees(snapshot);
}

// Both registers, in one list, for the half of the region they cover. Albany, Emeryville, Piedmont,
// Alameda and San Leandro publish none — the other five of the seven municipalities this half of the
// city is built from — so the genus overlay thins out there and the cover field does not.
export async function fetchEastBayTrees(): Promise<Tree[]> {
  return [...(await fetchOaklandTrees()), ...(await fetchBerkeleyTrees())];
}

// `bun run scripts/east-bay-trees.ts --snapshot`: takes a fresh copy of the Berkeley layer. Run by
// hand, never by a build — the whole point of the copy is that a build does not depend on a layer
// named "Test" still being there.
if (import.meta.main) {
  if (!process.argv.includes("--snapshot")) {
    throw new Error("pass --snapshot to rewrite the Berkeley copy");
  }
  const features = await fetchLayer<BerkeleyProperties>(
    "berkeley-trees",
    BERKELEY_SERVICE,
    "SPECIES,DSH",
    "OBJECTID",
    BERKELEY_PAGE_SIZE,
    false,
  );
  if (features.length < BERKELEY_ROW_FLOOR) {
    throw new Error(
      `Berkeley's tree layer answered ${features.length} rows, fewer than the ${BERKELEY_ROW_FLOOR} it holds: the read was truncated`,
    );
  }
  const rows: BerkeleyRow[] = [];
  for (const feature of features) {
    const point = pointOf(feature);
    if (point !== null) {
      rows.push([
        point.lng,
        point.lat,
        (feature.properties?.SPECIES ?? "").trim(),
        (feature.properties?.DSH ?? "").trim(),
      ]);
    }
  }
  const snapshot: BerkeleySnapshot = {
    service: BERKELEY_SERVICE,
    lastEdited: await lastEditedOn(BERKELEY_SERVICE),
    copied: new Date().toISOString().slice(0, 10),
    rows,
  };
  const bytes = gzipSync(JSON.stringify(snapshot), { level: 9 });
  await writeFile(BERKELEY_SNAPSHOT, bytes);
  console.error(
    `berkeley: ${rows.length} of ${features.length} rows carry a point; wrote ${BERKELEY_SNAPSHOT} (${(bytes.length / 1024).toFixed(0)} KiB)`,
  );
  // For its log line: how many of the rows just written are actually trees, which is what a reader
  // of the new copy wants to see next to its size.
  berkeleyTrees(snapshot);
}
