// Where the ground surface comes from: a mosaic of DEM tiles, fetched once and handed to the tiler.
//
// Nothing in the model read ground height before this. New York is flat enough that ignoring terrain
// costs almost nothing; San Francisco is not. Two things read the mosaic — the terrain overlay's
// pyramid, and the graph's per-edge ascent and descent bytes, which is what the hill weight steers by.
//
// It also sets how long a walk takes: `walkSpeedOn` scales the flat 1.3 m/s by Tobler's hiking
// function off those two, so a route over a hill is reported as the longer walk it is and the same
// route downhill as the quicker one.
//
// The tiles are a build input and never shipped — cached, sampled, and then not needed again, the
// same contract `scripts/chm.ts` has with the canopy height model.

import { readFile } from "node:fs/promises";
import pRetry from "p-retry";
import { fetchEastBayLand } from "./alameda";
import { cachedFile } from "./cache";
import { inverseTmerc } from "./canopy-raster";
import { boxOf } from "./geometry";
import { buildLandTest } from "./land-filter";
import {
  ALAMEDA_LIDAR,
  DEM_SQUARE_METERS,
  demSquareName,
  demSquaresOf,
  fetchDemTiles,
  type LidarWindow,
  PROJECTIONS,
  project,
} from "./lidar";
import type { Polygon } from "./overpass";

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
// ever read through the measured-canopy polygons, in the height pass (crates/tiler/src/heights.rs).
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
async function fetchTiles(prefix: string, hrefs: string[]): Promise<string[]> {
  const paths: string[] = new Array(hrefs.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < hrefs.length) {
      const index = next++;
      const href = hrefs[index];
      const name = href.slice(href.lastIndexOf("/") + 1);
      paths[index] = await cachedFile(`${prefix}-${name}`, href, () =>
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
    paths: await fetchTiles("werk", hrefs),
    attribution: WERK_ATTRIBUTION,
    sourceUrl: WERK_COLLECTION,
    band: DTM_BAND,
    crs: "sf-cs13",
  };
};

// The East Bay's ground, which is a different survey on a different grid. San Francisco's is a NASA
// WERK product enumerable from a STAC collection; the East Bay's is the plain USGS staging of the
// `CA_AlamedaCounty_2021_B21` campaign — a single-band bare-earth DTM, 10 km tiles on UTM 10N,
// public domain and keyless.
//
// Fetched through scripts/lidar.ts, which already stages exactly these tiles for the roof-height
// pass and names its cache entries after the campaign and the square. Sharing that fetch is not
// merely tidy: it is 1.57 GB, and two functions asking for the same nine files under two names would
// download the county twice and keep both copies. What lidar.ts contributes is the project's own
// `0_file_download_links.txt` — a plain list, no API in front of it — and the UTM square grid a
// window is turned into, which is where the tile names come from.
//
// Off the S3 bucket USGS stages to rather than its `rockyweb.usgs.gov` mirror of the same files,
// which serves them an order of magnitude slower.
const ALAMEDA_ATTRIBUTION = "Elevation © USGS 3DEP (public domain)";
const ALAMEDA_SOURCE_URL =
  "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/CA_AlamedaCounty_2021_B21/";

// The 10 km square of the staged grid a point falls in.
function demSquareOf(lng: number, lat: number): string {
  const [x, y] = project(PROJECTIONS[ALAMEDA_LIDAR.crs], lng, lat);
  return demSquareName(
    Math.floor(x / DEM_SQUARE_METERS),
    Math.floor(y / DEM_SQUARE_METERS),
  );
}

// Every square the region's LAND falls in. A 3DEP project stages whole squares and this one stages
// nothing for the bay-dominated blocks off Bay Farm Island, quite correctly — so what has to be
// checked is not that the grid is complete but that no square holding a street is missing from it.
// A square with no tile reads downstream as flat ground, not as absent ground, which is the whole
// reason this is checked rather than assumed.
//
// The vertices name every square the coastline runs through; the centres name the ones a polygon
// swallows whole, which have no vertex of their own and would otherwise be dropped from a check
// that exists to catch exactly that.
function landSquares(land: readonly Polygon[], box: LidarWindow): Set<string> {
  const squares = new Set<string>();
  for (const polygon of land) {
    for (const ring of polygon) {
      for (const { lat, lng } of ring) {
        squares.add(demSquareOf(lng, lat));
      }
    }
  }
  const onLand = buildLandTest(land);
  const projection = PROJECTIONS[ALAMEDA_LIDAR.crs];
  for (const { squareX, squareY, name } of demSquaresOf(
    box,
    ALAMEDA_LIDAR.crs,
  )) {
    const center = inverseTmerc(
      projection,
      (squareX + 0.5) * DEM_SQUARE_METERS,
      (squareY + 0.5) * DEM_SQUARE_METERS,
    );
    if (onLand(center)) {
      squares.add(name);
    }
  }
  return squares;
}

export const EAST_BAY_ELEVATION: () => Promise<ElevationRaster> = async () => {
  // The land is resolved here rather than stated as four numbers, because both things this needs of
  // it move together: the window the campaign is asked for, and the ground the answer has to cover.
  const land = await fetchEastBayLand();
  const box = boxOf(land);
  const { paths, missing } = await fetchDemTiles(ALAMEDA_LIDAR, box);
  const wanted = landSquares(land, box);
  const absent = missing.filter((square) => wanted.has(square));
  if (absent.length > 0) {
    throw new Error(
      `${ALAMEDA_LIDAR.demProject} stages no ground for ${absent.join(", ")}, which the East Bay has land in`,
    );
  }
  console.error(
    `  elevation: ${paths.length} tiles in ${ALAMEDA_LIDAR.demProject}, covering the ${wanted.size} squares the land falls in`,
  );
  return {
    paths,
    attribution: ALAMEDA_ATTRIBUTION,
    sourceUrl: ALAMEDA_SOURCE_URL,
    band: DTM_BAND,
    crs: ALAMEDA_LIDAR.crs,
  };
};

// Every mosaic a city's ground is read from, in the order the tiler resolves them: where two surveys
// overlap, the FIRST one wins. San Francisco leads because the bay is flown from both sides and its
// own five-band product is the one this city was measured against.
//
// A city with no mosaic keeps a flat model: every edge's relief reads 0, and the hill weight greys
// out rather than moving nothing silently.
export async function fetchElevationMosaics(
  cityId: string,
): Promise<ElevationRaster[]> {
  if (cityId === "sf") {
    return [await SF_ELEVATION(), await EAST_BAY_ELEVATION()];
  } else {
    return [];
  }
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "sf";
  const mosaics = await fetchElevationMosaics(cityId);
  if (mosaics.length === 0) {
    console.error(`${cityId}: no elevation source`);
  }
  for (const mosaic of mosaics) {
    let bytes = 0;
    for (const path of mosaic.paths) {
      bytes += (await readFile(path)).byteLength;
    }
    console.error(
      `${cityId}: ${mosaic.crs}: ${mosaic.paths.length} tiles, ${(bytes / 1e9).toFixed(2)} GB cached`,
    );
  }
}
