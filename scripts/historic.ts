// `bun run scripts/historic.ts [city]`: fetches New York's designated historic districts and writes
// them as data/historic/<id>.bin (magic HDST) — the district BOUNDARIES as polygons, drawn by the
// historic-districts overlay and sampled per edge into the graph's historic-district discount.
// Layout: scripts/README.md.
//
// These are whole neighbourhoods the Landmarks Preservation Commission has designated (Park Slope,
// Brooklyn Heights, Greenwich Village …), not the individual landmarked buildings scripts/landmarks.ts
// reads — a different source, a different artifact, and areas rather than points.
//
// The geometry comes from the LPC's own ArcGIS FeatureServer, not from the Socrata dataset the city
// catalogues as "Historic Districts (Map)" (`xbvj-gfnw`): that one is a map visualization whose rows
// read back empty, and the table under it is in state-plane feet and missing 18 designated districts
// — a third of Park Slope's landmarked area among them. scripts/README.md has the whole comparison.

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
const HISTORIC_DIR = join(DATA_DIR, "historic");
const HISTORIC_MAGIC = "HDST";
const HISTORIC_FORMAT = 1;

// The LPC's Historic_Districts layer: every district it has designated, `maxRecordCount` 2000, native
// CRS EPSG:3857, so every query asks for `outSR=4326`. The layer is designated-only — `STATUS_OF_`,
// `LAST_ACTIO` and `CURRENT_` read DESIGNATED/DESIGNATED/Yes on all of it — so the read needs no
// `where` beyond `1=1`. Districts merely calendared or under study are a separate service.
const SERVICE =
  "https://services5.arcgis.com/Oos4pNA2538iVFA1/arcgis/rest/services/Historic_Districts/FeatureServer/0/query";
const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
// 159 districts at the last probe (2026-08-20). A floor, not an exact count: it catches a server-side
// page cut that would pass for the end of the layer, but tolerates the LPC designating a few more.
const EXPECTED_DISTRICTS = 150;
const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";

type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

interface DistrictFeature {
  geometry?: GeoJsonGeometry | null;
}

// A GeoJSON query still reports a failure the Esri way: a 200 carrying an `error` body.
interface DistrictPage {
  features?: DistrictFeature[];
  error?: { code: number; message: string };
}

// One page's request URL, ordered by OBJECTID so `resultOffset` paging is stable: without an order
// an ArcGIS layer may repeat or skip rows between pages.
function pageUrl(offset: number): string {
  const url = new URL(SERVICE);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "OBJECTID");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

async function fetchPage(url: string): Promise<DistrictPage> {
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
        const body = (await response.json()) as DistrictPage;
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
    throw new Error(`historic page ${url} failed: ${error}`);
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

// A district is kept if any vertex of it is on land, as the industrial lots are: a boundary drawn
// around a waterfront block runs out over the water, and the harbour districts (Governors Island,
// Ellis Island, South Street Seaport) meet the coastline the borough boundaries draw only at the
// shore. At the 2026-08-20 read no district missed entirely.
function touchesLand(part: Polygon, onLand: LandContext["onLand"]): boolean {
  return part.some((ring) => ring.some(onLand));
}

interface Districts {
  polygons: Polygon[];
  districts: number; // features kept, as against the polygon parts they expand to
  offLand: number; // features every part of which missed the coastline
}

// Pages the whole layer, each page cached by its request URL through scripts/cache.ts, so a re-run —
// or a resume after a transient failure — serves the completed pages from disk.
async function fetchDistricts(land: LandContext): Promise<Districts> {
  const polygons: Polygon[] = [];
  let fetched = 0;
  let districts = 0;
  let offLand = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = pageUrl(offset);
    const page = await cached("arcgis-lpc-historic-districts", url, () =>
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
      districts += 1;
      polygons.push(...parts);
    }
    console.error(
      `  historic: ${fetched} districts fetched, ${polygons.length} parts kept`,
    );
    if (features.length < PAGE_SIZE) {
      break;
    }
  }
  if (fetched < EXPECTED_DISTRICTS) {
    throw new Error(
      `historic fetch returned ${fetched} districts, ${EXPECTED_DISTRICTS} expected: the read was truncated`,
    );
  }
  return { polygons, districts, offLand };
}

export async function ingestHistoric(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  // Only New York has a source. A city with none throws rather than defaulting to another's, which
  // would clip New York's districts against a foreign shoreline and write a silently empty artifact.
  if (cityId !== "nyc") {
    throw new Error(`no historic-district source for ${cityId}`);
  }
  const started = performance.now();
  await mkdir(HISTORIC_DIR, { recursive: true });

  const { polygons, districts, offLand } = await fetchDistricts(land);
  const bytes = encodePolygons(HISTORIC_MAGIC, HISTORIC_FORMAT, polygons);
  const file = `${cityId}.bin`;
  await writeFile(join(HISTORIC_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const mib = (bytes.length / 1024 / 1024).toFixed(2);
  console.error(
    `historic: ${districts} districts kept (${offLand} off land), ` +
      `${polygons.length} polygon parts, ${mib} MiB in ${seconds}s`,
  );
  return {
    file,
    format: HISTORIC_FORMAT,
    count: polygons.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestHistoric(cityId, await loadLandContext(cityId));
}
