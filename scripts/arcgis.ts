// Shared access to the ArcGIS feature services the Bay Area sources are read from: Alameda County's
// centreline, parcels and address points, Oakland's and Berkeley's own layers, MTC's regional land
// use and the Census Bureau's hydrography. Every Esri service answers the same query API, so a
// second layer is a second query here rather than a second reader.
//
// What differs between them is the query — the fields, the `where`, the page size — and that stays
// with the caller, which builds its own URL. What is shared is everything else: the envelope every
// one of them is clipped to, the error shape, the retry ladder, and the walk down a layer a page at
// a time.

import { cached } from "./cache";
import { fetchJson, type JsonRequest } from "./http";
import type { Bounds } from "./manifest";

const REQUEST_TIMEOUT_MS = 120_000;

interface QueryResponse<Feature> {
  features?: Feature[];
}

// A layer read in hundreds of pages wants a ladder of attempts under it; one read in a single
// request fails the build either way, which is why the default is not to retry.
export type QueryOptions = Omit<JsonRequest<unknown>, "check">;

// One JSON answer from a feature service. ArcGIS reports a query error as a 200 with an `{ error }`
// body, so the status alone is not enough — an unchecked error page would cache as a permanent
// empty page and truncate the layer.
export async function fetchArcgis<Value>(
  url: string,
  { timeoutMs = REQUEST_TIMEOUT_MS, ...options }: QueryOptions = {},
  check?: (value: Value) => void,
): Promise<Value> {
  return await fetchJson<Value>(url, {
    ...options,
    timeoutMs,
    check: (value) => {
      const { error } = value as { error?: { code: number; message: string } };
      if (error) {
        throw new Error(`ArcGIS ${error.code}: ${error.message}`);
      }
      check?.(value);
    },
  });
}

// The features of one query.
export async function fetchFeatures<Feature>(
  url: string,
  options: QueryOptions = {},
): Promise<Feature[]> {
  const answer = await fetchArcgis<QueryResponse<Feature>>(
    url,
    options,
    ({ features }) => {
      if (!Array.isArray(features)) {
        throw new Error("no features in the response");
      }
    },
  );
  return answer.features as Feature[];
}

// The four parameters that clip a query to a lon/lat rectangle. Every layer here is read over a
// box, and an envelope written a degree wrong is a layer that comes back empty rather than one that
// fails.
export function envelopeQuery(url: URL, box: Bounds): void {
  url.searchParams.set(
    "geometry",
    JSON.stringify({
      xmin: box.west,
      ymin: box.south,
      xmax: box.east,
      ymax: box.north,
      spatialReference: { wkid: 4326 },
    }),
  );
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
}

export interface PagedQuery extends QueryOptions {
  // The caller's own query with `resultOffset` set to the offset it is handed. It has to carry an
  // `orderByFields` too: without an order an ArcGIS layer may repeat or skip rows between pages.
  pageUrl: (offset: number) => string;
  pageSize: number;
  // A cache entry per page, named `${cacheName}-${offset}`. `null` for a read that must not be
  // served from disk — see the snapshot in scripts/east-bay-trees.ts.
  cacheName: string | null;
}

// The pages of one layer, in order, until one comes back short of the page size — which is the only
// end-of-layer signal a query answers.
export async function* featurePages<Feature>({
  pageUrl,
  pageSize,
  cacheName,
  ...options
}: PagedQuery): AsyncGenerator<Feature[]> {
  for (let offset = 0; ; offset += pageSize) {
    const url = pageUrl(offset);
    const read = (): Promise<Feature[]> => fetchFeatures<Feature>(url, options);
    // Quietly, because a layer is hundreds of entries and its hit notices would bury the build log.
    const page =
      cacheName === null
        ? await read()
        : await cached(`${cacheName}-${offset}`, url, read, true);
    yield page;
    if (page.length < pageSize) {
      return;
    }
  }
}

// A whole layer, for a caller with no reason to see it a page at a time.
export async function allFeatures<Feature>(
  query: PagedQuery,
): Promise<Feature[]> {
  const features: Feature[] = [];
  for await (const page of featurePages<Feature>(query)) {
    features.push(...page);
  }
  return features;
}
