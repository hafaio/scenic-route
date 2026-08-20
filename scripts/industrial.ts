// `bun run scripts/industrial.ts`: fetches New York's manufacturing and industrial tax lots and
// writes them as data/industrial/nyc.bin (magic INDL) — the lot POLYGONS, drawn by the industrial
// overlay. This is an inspection layer: it exists so the industrial land can be looked at on the
// map. Nothing routes off it.
//
// The geometry comes from DCP's MAPPLUTO ArcGIS FeatureServer, not from Socrata: the Socrata copy of
// PLUTO (`64uk-42ks`, which scripts/landuse.ts reads) carries lot CENTROIDS and its `geom` column is
// null on all 858,602 rows. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pRetry from "p-retry";
import { cached } from "./cache";
import { encodePolygons } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Polygon } from "./overpass";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const INDUSTRIAL_DIR = join(DATA_DIR, "industrial");
const INDUSTRIAL_MAGIC = "INDL";
const INDUSTRIAL_FORMAT = 1;

// DCP's MAPPLUTO (24v4, at the last probe): 856,614 lot polygons, `maxRecordCount` 2000, pagination
// supported. Native CRS is EPSG:2263, so every query asks for `outSR=4326`.
const SERVICE =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
const WHERE = "LandUse = '06'";
const PAGE_SIZE = 2000;
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
// 9,295 lots matched the `where` at the last probe (2026-08-19). A floor, not an exact count: it
// catches a server-side page cut that would pass for the end of the layer, but tolerates the city
// reclassifying a few lots between refreshes.
const EXPECTED_LOTS = 9_000;
const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";

type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

interface LotFeature {
  geometry?: GeoJsonGeometry | null;
}

// A GeoJSON query still reports a failure the Esri way: a 200 carrying an `error` body.
interface LotPage {
  features?: LotFeature[];
  properties?: { exceededTransferLimit?: boolean };
  error?: { code: number; message: string };
}

// One page's request URL, ordered by OBJECTID so `resultOffset` paging is stable: without an order
// an ArcGIS layer may repeat or skip rows between pages.
function pageUrl(offset: number): string {
  const url = new URL(SERVICE);
  url.searchParams.set("where", WHERE);
  url.searchParams.set("outFields", "OBJECTID");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

async function fetchPage(url: string): Promise<LotPage> {
  try {
    return await pRetry(
      async () => {
        const response = await fetch(url, {
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        const body = (await response.json()) as LotPage;
        if (body.error) {
          throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
        } else if (!Array.isArray(body.features)) {
          throw new Error("no features in the response");
        }
        return body;
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
    throw new Error(`industrial page ${url} failed: ${error}`);
  }
}

// A feature's parts as lon/lat rings, a MultiPolygon's disjoint parts one polygon each. A ring of
// fewer than four vertices is degenerate and dropped, and a part left with none is dropped with it.
function partsOf(geometry: GeoJsonGeometry): Polygon[] {
  const parts =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return parts
    .map((part) =>
      part
        .map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))
        .filter((ring) => ring.length >= 4),
    )
    .filter((part) => part.length > 0);
}

// A lot is kept if any vertex of it is on land, not if its centroid is: much of this land is
// waterfront, and a lot whose bulkhead reaches past the coastline the borough boundaries draw tests
// as land only at the vertices that meet the shore. At the 2026-08-19 read no lot missed entirely.
function touchesLand(part: Polygon, onLand: LandContext["onLand"]): boolean {
  return part.some((ring) => ring.some(onLand));
}

interface Lots {
  polygons: Polygon[];
  lots: number; // features kept, as against the polygon parts they expand to
  offLand: number; // features every part of which missed the coastline
}

// Pages the whole `where`, each page cached by its request URL through scripts/cache.ts, so a
// re-run — or a resume after a transient failure — serves the completed pages from disk.
async function fetchLots(land: LandContext): Promise<Lots> {
  const polygons: Polygon[] = [];
  let fetched = 0;
  let lots = 0;
  let offLand = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = pageUrl(offset);
    const page = await cached("arcgis-mappluto-industrial", url, () =>
      fetchPage(url),
    );
    const features = page.features ?? [];
    fetched += features.length;
    for (const feature of features) {
      if (!feature.geometry) {
        continue;
      }
      const parts = partsOf(feature.geometry).filter((part) =>
        touchesLand(part, land.onLand),
      );
      if (parts.length === 0) {
        offLand += 1;
        continue;
      }
      lots += 1;
      polygons.push(...parts);
    }
    console.error(
      `  industrial: ${fetched} lots fetched, ${polygons.length} parts kept`,
    );
    if (features.length < PAGE_SIZE) {
      break;
    }
  }
  if (fetched < EXPECTED_LOTS) {
    throw new Error(
      `industrial fetch returned ${fetched} lots, ${EXPECTED_LOTS} expected: the read was truncated`,
    );
  }
  return { polygons, lots, offLand };
}

export async function ingestIndustrial(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  // New York only: MAPPLUTO is a New York layer, and another city would clip its lots against its
  // own coastline, drop every one of them and write a silently empty artifact.
  if (cityId !== "nyc") {
    throw new Error(`no industrial land-use source for ${cityId}`);
  }

  const started = performance.now();
  await mkdir(INDUSTRIAL_DIR, { recursive: true });

  const { polygons, lots, offLand } = await fetchLots(land);
  const bytes = encodePolygons(INDUSTRIAL_MAGIC, INDUSTRIAL_FORMAT, polygons);
  const file = `${cityId}.bin`;
  await writeFile(join(INDUSTRIAL_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const mib = (bytes.length / 1024 / 1024).toFixed(2);
  console.error(
    `industrial: ${lots} lots kept (${offLand} off land), ` +
      `${polygons.length} polygon parts, ${mib} MiB in ${seconds}s`,
  );
  return {
    file,
    format: INDUSTRIAL_FORMAT,
    count: polygons.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestIndustrial(cityId, await loadLandContext(cityId));
}
