// `bun run scripts/historic.ts [city]`: fetches a city's designated historic districts and writes
// them as data/historic/<id>.bin (magic HDST) — the district BOUNDARIES as polygons, drawn by the
// historic-districts overlay and sampled per edge into the graph's historic-district discount.
// Layout: scripts/README.md.
//
// These are whole neighbourhoods a city has designated (Park Slope, Brooklyn Heights, Greenwich
// Village; Jackson Square, Telegraph Hill, Alamo Square), not the individual landmarked buildings
// scripts/landmarks.ts reads — a different source, a different artifact, areas rather than points.
//
// The two cities do not share a source, and each publishes one that has to be picked past a decoy:
//
//   - **New York.** The geometry comes from the LPC's own ArcGIS FeatureServer, not from the Socrata
//     dataset the city catalogues as "Historic Districts (Map)" (`xbvj-gfnw`): that one is a map
//     visualization whose rows read back empty, and the table under it is in state-plane feet and
//     missing 18 designated districts — a third of Park Slope's landmarked area among them.
//
//   - **San Francisco.** One Planning table holds every district ANY register recognises, of which
//     the city's own designations are the Article 10 / Article 11 subset `fetchSfDistricts` cuts.
//     Its "Map of Historic Districts" (`y75h-nbt2`) is the same decoy `xbvj-gfnw` is, and the
//     dedicated "Landmark Districts" table (`knm6-5ej6`) is three years stale and has no Article 11.
//
// scripts/README.md has both comparisons.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pRetry from "p-retry";
import { cached } from "./cache";
import { encodePolygons } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Polygon } from "./overpass";
import { DATA_SF } from "./socrata";

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

// SF Planning's "Historic Districts" table: 204 areas, every one any register or survey has
// recognised, as WGS84 MultiPolygons — populated on all of them.
const SF_DATASET = "63x5-g3m4";
// The two Planning Code articles, which is what "designated" means here: Article 10 landmark
// districts and Article 11 downtown conservation districts. Without this the read would take in the
// 180 National- and California-Register districts sharing the table, which carry no local
// designation and no controls. The flag's value is the string "Listed" — `a10='Yes'` matches nothing
// and would write a silently empty artifact.
const SF_WHERE = "a10='Listed' OR a11='Listed'";
// 16 Article 10 plus 7 Article 11 at the last probe (2026-08-22). A floor like New York's: the
// shared reader tolerates 5% either way, so a new designation notes rather than fails.
const SF_DISTRICTS = 23;

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
// Ellis Island, South Street Seaport; Northeast Waterfront) meet the coastline the land polygons
// draw only at the shore. At the 2026-08-22 read no district in either city missed entirely.
function touchesLand(part: Polygon, onLand: LandContext["onLand"]): boolean {
  return part.some((ring) => ring.some(onLand));
}

interface Districts {
  polygons: Polygon[];
  districts: number; // features kept, as against the polygon parts they expand to
  offLand: number; // features every part of which missed the coastline
}

// Appends a feature's on-land parts to `polygons`; false when every part missed the coastline.
function keepDistrict(
  geometry: GeoJsonGeometry,
  onLand: LandContext["onLand"],
  polygons: Polygon[],
): boolean {
  const parts = partsOf(geometry).filter((part) => touchesLand(part, onLand));
  polygons.push(...parts);
  return parts.length > 0;
}

// Pages the whole layer, each page cached by its request URL through scripts/cache.ts, so a re-run —
// or a resume after a transient failure — serves the completed pages from disk.
async function fetchNycDistricts(land: LandContext): Promise<Districts> {
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
      if (keepDistrict(feature.geometry, land.onLand, polygons)) {
        districts += 1;
      } else {
        offLand += 1;
      }
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

interface SfDistrictRow {
  the_geom?: GeoJsonGeometry | null;
}

// `*` so a newly-read column is free after one refetch (the disk cache keys on the query);
// SfDistrictRow reads only the geometry, since nothing downstream of the artifact names a district.
async function fetchSfDistricts(land: LandContext): Promise<Districts> {
  const rows = await DATA_SF.dataset<SfDistrictRow>(
    SF_DATASET,
    { $select: "*", $where: SF_WHERE },
    SF_DISTRICTS,
  );
  const polygons: Polygon[] = [];
  let districts = 0;
  let offLand = 0;
  for (const row of rows) {
    if (!row.the_geom) {
      continue;
    }
    if (keepDistrict(row.the_geom, land.onLand, polygons)) {
      districts += 1;
    } else {
      offLand += 1;
    }
  }
  return { polygons, districts, offLand };
}

async function fetchCityDistricts(
  cityId: string,
  land: LandContext,
): Promise<Districts> {
  if (cityId === "nyc") {
    return await fetchNycDistricts(land);
  } else if (cityId === "sf") {
    return await fetchSfDistricts(land);
  } else {
    // A city with no source throws rather than defaulting to another's, which would clip one city's
    // districts against a foreign shoreline and write a silently empty artifact.
    throw new Error(`no historic-district source for ${cityId}`);
  }
}

export async function ingestHistoric(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(HISTORIC_DIR, { recursive: true });

  const { polygons, districts, offLand } = await fetchCityDistricts(
    cityId,
    land,
  );
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
