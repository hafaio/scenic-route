// Where the ground surface comes from: a mosaic of DEM tiles, fetched once and handed to the tiler.
//
// Nothing in the model read ground height before this. New York is flat enough that ignoring terrain
// costs almost nothing; San Francisco is not. Two things read the mosaic — the terrain overlay's
// pyramid, and the graph's per-edge relief byte, which is what the hill weight steers by.
//
// It also sets how long a walk takes: `walkSpeedOn` scales the flat 1.3 m/s by Tobler's hiking
// function off the same per-edge grade, so a route over a hill is reported as the longer walk it is.
//
// The tiles are a build input and never shipped — cached, sampled, and then not needed again, the
// same contract `scripts/chm.ts` has with the canopy height model.

import { readFile } from "node:fs/promises";
import pRetry from "p-retry";
import { cachedFile } from "./cache";

const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const PROGRESS_TILES = 50;
const FETCH_WORKERS = 8;

export interface ElevationRaster {
  // Every tile of the mosaic, as paths on disk. The tiler opens them itself; nothing here reads a
  // pixel.
  paths: string[];
  attribution: string;
  sourceUrl: string;
  // Which band of a multi-band tile carries the ground surface.
  band: number;
  // What the tiler calls the projection these tiles are published on. A GeoTIFF names its CRS by
  // EPSG code and not by parameters, so something has to know that 7131 is San Francisco's grid.
  crs: string;
}

// The 3DEP topographic products for San Francisco, flown 2023-04-20 and published as five-band
// float32 COGs: DTM, DSM, CHM, slope, aspect. Public domain (CC0), no key, and enumerable from a
// STAC collection — 651 tiles, 1.77 GB cached once.
//
// The tiles are NAD83(2011) / San Francisco CS13 (EPSG:7131), a transverse Mercator like the UTM
// zone New York's canopy raster uses, which is why the tiler reads both with one projection.
const WERK_COLLECTION =
  "https://nationaldataplatform.org/stac/collections/nasa-werk-dem-ca-sanfrancisco-1-b23";
const WERK_ATTRIBUTION = "Elevation © USGS 3DEP / NASA WERK (CC0)";
const DTM_BAND = 0;
// Band 2 is the surface model less the terrain model: how far above the ground each cell's return
// stood. It is not a canopy product — the Salesforce Tower measures 324 m in it — so it is only
// ever read through the measured-canopy polygons, in `tiler heights`.
export const SF_CANOPY_BAND = 2;

interface StacItem {
  id: string;
  assets?: Record<string, { href?: string }>;
}

interface StacPage {
  features?: StacItem[];
  links?: { rel?: string; href?: string }[];
}

async function fetchJson<Value>(url: string): Promise<Value> {
  return await pRetry(
    async () => {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return (await response.json()) as Value;
    },
    {
      retries: MAX_ATTEMPTS - 1,
      minTimeout: RETRY_BASE_MS,
      maxTimeout: RETRY_CAP_MS,
      randomize: true,
    },
  );
}

// The collection paginates, and the last page's `next` link is what ends the walk — a page with no
// features would otherwise loop on the same href for ever.
async function tileHrefs(): Promise<string[]> {
  const hrefs: string[] = [];
  let url: string | null = `${WERK_COLLECTION}/items?limit=500`;
  while (url) {
    const page: StacPage = await fetchJson<StacPage>(url);
    const features = page.features ?? [];
    for (const feature of features) {
      const href = feature.assets?.data?.href;
      if (href) {
        hrefs.push(href);
      }
    }
    const next = page.links?.find((link) => link.rel === "next")?.href;
    url = features.length > 0 && next ? next : null;
  }
  return hrefs;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// One cache entry per tile rather than one for the mosaic: a run interrupted halfway keeps what it
// already has, and a tile the server 500s on costs one tile.
async function fetchTiles(hrefs: string[]): Promise<string[]> {
  const paths: string[] = new Array(hrefs.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < hrefs.length) {
      const index = next++;
      const href = hrefs[index];
      const name = href.slice(href.lastIndexOf("/") + 1);
      paths[index] = await cachedFile(`werk-${name}`, href, () =>
        pRetry(() => download(href), {
          retries: MAX_ATTEMPTS - 1,
          minTimeout: RETRY_BASE_MS,
          maxTimeout: RETRY_CAP_MS,
          randomize: true,
        }),
      );
      done += 1;
      if (done % PROGRESS_TILES === 0 || done === hrefs.length) {
        console.error(`  elevation: ${done}/${hrefs.length} tiles`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_WORKERS, hrefs.length) }, worker),
  );
  return paths;
}

export const SF_ELEVATION: () => Promise<ElevationRaster> = async () => {
  const hrefs = await tileHrefs();
  if (hrefs.length === 0) {
    throw new Error("the 3DEP collection listed no tiles");
  }
  console.error(`  elevation: ${hrefs.length} tiles in the 3DEP collection`);
  return {
    paths: await fetchTiles(hrefs),
    attribution: WERK_ATTRIBUTION,
    sourceUrl: WERK_COLLECTION,
    band: DTM_BAND,
    crs: "sf-cs13",
  };
};

// A city with no elevation source keeps a flat model: every edge's relief reads 0, and the hill
// weight greys out rather than moving nothing silently.
export async function fetchElevationRaster(
  cityId: string,
): Promise<ElevationRaster | null> {
  return cityId === "sf" ? await SF_ELEVATION() : null;
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "sf";
  const raster = await fetchElevationRaster(cityId);
  if (!raster) {
    console.error(`${cityId}: no elevation source`);
  } else {
    let bytes = 0;
    for (const path of raster.paths) {
      bytes += (await readFile(path)).byteLength;
    }
    console.error(
      `${cityId}: ${raster.paths.length} tiles, ${(bytes / 1e9).toFixed(2)} GB cached`,
    );
  }
}
