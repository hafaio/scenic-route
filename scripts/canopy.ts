// NYC's 2017 LiDAR tree-canopy polygons, from NYC Parks' public ArcGIS FeatureServer. This is the
// *measured* canopy footprint — every crown the LiDAR saw — where the field's own cover is a
// point-KDE inferred from the street-tree register, which structurally cannot show park forest: a
// densely wooded Central Park box carries only ~5 ForMS trees yet reads as solid canopy on
// satellite. Same polygon shape as the OSM woodland source, so the ingest encodes it to
// data/canopy/<id>.bin with the shared polygon encoder (magic `CNPY`). Display-only, never in
// routing. See scripts/README.md.

import { cached } from "./cache";
import type { Polygon } from "./overpass";

// NYC Parks (AGOL owner hayley.small@parks.nyc.gov_nycdpr) publishes the 2017 LiDAR canopy as
// simplified polygons here; `maxRecordCount` is 2000 and the layer supports pagination. Fields are
// only OBJECTID + Shape__Area — geometry is all the ingest needs, so `outFields` is empty.
const SERVICE =
  "https://services3.arcgis.com/xJHn8F2NTtwCMFtX/arcgis/rest/services/TreeCanopy2017_Simplified_1ft/FeatureServer/0/query";

const PAGE_SIZE = 2000; // the service's maxRecordCount; a larger resultRecordCount is capped here
const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 5_000; // grows with the attempt, so a rate-limited service is given room
const REQUEST_TIMEOUT_MS = 120_000; // only cuts off a request that hung, not one merely slow
// ~1,077,146 polygons at the last probe (2026-07-17). A floor, not an exact count: it catches a
// server-side page cut that would otherwise pass for the end of the layer, but tolerates the
// service growing or shrinking a little between refreshes.
const EXPECTED_POLYGONS = 1_000_000;
const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";

// The Esri JSON a `f=json` query returns: features carry `geometry.rings` (already lon/lat under
// `outSR=4326`), and a query error arrives as a 200 with an `error` body rather than a bad status.
interface EsriResponse {
  features?: { geometry?: { rings?: [number, number][][] } }[];
  exceededTransferLimit?: boolean;
  error?: { code: number; message: string };
}

export interface CanopyPolygons {
  polygons: Polygon[]; // one polygon per feature, its Esri rings as lon/lat Coord rings
  fetched: number; // features the service returned across every page
  dropped: number; // features dropped as carrying no non-degenerate ring
}

// One page's request URL, ordered by OBJECTID so `resultOffset` paging is stable: without an
// order an ArcGIS layer may repeat or skip rows between pages.
function pageUrl(offset: number): string {
  const url = new URL(SERVICE);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

// One page, retried with a growing backoff over the service's rate limit. ArcGIS reports a query
// error as a 200 with an `{ error }` body, so the status alone is not enough — an unchecked error
// page would otherwise cache as a permanent empty page and truncate the layer.
async function fetchPage(url: string): Promise<EsriResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as EsriResponse;
      if (body.error) {
        throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
      } else if (!Array.isArray(body.features)) {
        throw new Error("no features in the response");
      }
      return body;
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
  throw new Error(`canopy page ${url} failed: ${lastError}`);
}

// Pages the whole layer, each page cached by its request URL through scripts/cache.ts, so this
// ~540-page, ~1M-polygon fetch runs once and a re-run — or a resume after a transient failure —
// serves the completed pages from disk. Each feature's Esri rings become one polygon in lon/lat;
// a ring shorter than four vertices is degenerate and dropped, and a feature left with no ring is
// counted out.
export async function fetchCanopyPolygons(): Promise<CanopyPolygons> {
  const polygons: Polygon[] = [];
  let fetched = 0;
  let dropped = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = pageUrl(offset);
    const page = await cached("arcgis-canopy-2017", url, () => fetchPage(url));
    const features = page.features ?? [];
    fetched += features.length;
    for (const feature of features) {
      const rings = (feature.geometry?.rings ?? [])
        .map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))
        .filter((ring) => ring.length >= 4);
      if (rings.length > 0) {
        polygons.push(rings);
      } else {
        dropped += 1;
      }
    }
    console.error(`  canopy: ${fetched} features fetched`);
    // A short page — fewer than requested, or the transfer-limit flag cleared — is the end of
    // the layer. Both are checked: some ArcGIS builds return a full final page with the flag off.
    if (features.length < PAGE_SIZE || page.exceededTransferLimit === false) {
      break;
    }
  }
  if (fetched < EXPECTED_POLYGONS) {
    throw new Error(
      `canopy fetch returned ${fetched} features, ${EXPECTED_POLYGONS} expected: the read was truncated`,
    );
  }
  return { polygons, fetched, dropped };
}
