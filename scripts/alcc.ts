// The East Bay's canopy, from the Alameda / Contra Costa 1-metre lidar canopy height model.
//
// New York and San Francisco are each handed canopy POLYGONS by their city. No Bay Area county
// publishes any: what Alameda and Contra Costa publish — jointly, from one unified point cloud — is
// a 1 m canopy height model in feet, and beside it a canopy-cover mask that is that model cut at
// 15 feet. So both of this pipeline's canopy inputs come out of the one raster here: the cover
// polygons are the model thresholded and vectorized (scripts/canopy-raster.ts), and the crown
// heights are the model itself, cut into the GeoTIFF tiles the tiler's mosaic sampler already
// reads. The county's own cover product is not fetched at all — it would be the same threshold of
// the same cells, arriving as a second 200 MB download that could only ever disagree with this one.
//
// The raster is read through the publisher's tiled image service rather than the 7.1 GB zip its
// item also offers: the service caches it lossless (LERC, maxZError 0) on its OWN grid — NAD83(2011)
// UTM zone 10N, 1 m cells, no resampling — so a city's window costs the tiles it covers instead of
// two counties, and the bytes are the published bytes. The zip is a single 5.9 GB member compressed
// with Deflate64, which neither Bun, macOS's unzip nor libarchive can read.
//
// Licence: Pacific Veg Map, which publishes it, states "All of the map data accessible via this
// site is in the public domain and is freely accessible to all" (read 2026-08-27). The item's own
// licence field carries a warranty disclaimer and no restriction.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decode, load } from "lerc";
import pRetry from "p-retry";
import { CACHE_DIR, cachedFile } from "./cache";
import {
  encodeFloatTiff,
  forwardTmerc,
  type Grid,
  polygonsOfMask,
  ringToCoords,
  UTM_10N,
} from "./canopy-raster";
import type { Bounds } from "./manifest";
import type { Polygon } from "./overpass";

const SERVICE =
  "https://tiledimageservices2.arcgis.com/Pw6oQMuXLspbq6zz/arcgis/rest/services/ALCC_UNIFIED_CHM_1M/ImageServer";
export const ALCC_ATTRIBUTION =
  "Canopy © EBRPD / CAL FIRE / Tukman Geospatial (ALCC 1 m LiDAR)";
export const ALCC_SOURCE_URL =
  "https://www.arcgis.com/home/item.html?id=7b57097b6b274419951ed51d0f6f20f4";

// The service's own cache, checked against the service on every run rather than trusted: the level
// whose cells are the raster's own metre, the 256-cell blocks it is cut into, and the ground corner
// its tile (0, 0) starts at. A cache rebuilt on a different origin would otherwise shift every
// crown by a fraction of a tile, silently.
const LEVEL = 9;
const TILE = 256;
const CELL_METERS = 1;
const ORIGIN_X = 549_868;
const ORIGIN_Y = 4_218_438;

// The height a cell has to reach to count as canopy. This is the publisher's own threshold for the
// companion cover raster — "pixels that contain a lidar return greater than or equal to 15 feet
// above the ground" — so the polygons here are the county's published canopy cover, and the East
// Bay's cover field means what Marin's, San Mateo's and Santa Clara's will when their rasters come
// through the same step. It is also the one number that separates a tree from the shrubs and the
// parked cars the point cloud sees, and 15 ft ≈ 4.6 m is a low bar for a tree and a high one for
// anything else. The floor does mean a young street tree is not canopy until it clears it; New
// York's and San Francisco's sources have no floor at all, which is recorded in the manifest as the
// difference between the two.
const CANOPY_FLOOR_FEET = 15;
const METERS_PER_FOOT = 0.3048;

// How far a simplified ring may leave the cells it was traced from. A 1 m raster boundary is a
// staircase carrying a vertex per metre; at this tolerance a crown keeps its shape and its area to
// a percent while its vertex count falls by about four fifths. Measured over the whole window:
// {SIMPLIFY_NOTE}
const SIMPLIFY_METERS = 0.75;
// The smallest component kept. Below this a "crown" is a lidar speck — the transmission lines the
// publisher warns are mapped as vegetation are the commonest kind — and it costs a polygon record
// to say nothing.
const MINIMUM_SQUARE_METERS = 4;

const FETCH_WORKERS = 8;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const PROGRESS_TILES = 250;
const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";

// Where the height tiles the tiler samples are cut. They are build inputs the tiler opens itself,
// like San Francisco's 3DEP tiles, and are never committed.
const HEIGHT_DIR = join(CACHE_DIR, "alcc-chm");

interface ServiceInfo {
  tileInfo?: {
    rows?: number;
    cols?: number;
    origin?: { x?: number; y?: number };
    lods?: { level?: number; resolution?: number }[];
  };
  spatialReference?: { wkt?: string };
  pixelType?: string;
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

// The five things a wrong assumption here would corrupt rather than break: the grid the tiles are
// cut on, the level whose cells are metres, and that the cells are float heights on UTM zone 10.
async function checkService(): Promise<void> {
  const info = await fetchJson<ServiceInfo>(`${SERVICE}?f=json`);
  const tiles = info.tileInfo;
  const lod = tiles?.lods?.find((entry) => entry.level === LEVEL);
  const problems: string[] = [];
  if (tiles?.rows !== TILE || tiles?.cols !== TILE) {
    problems.push(`${tiles?.cols} x ${tiles?.rows} tiles, not ${TILE}`);
  }
  if (tiles?.origin?.x !== ORIGIN_X || tiles?.origin?.y !== ORIGIN_Y) {
    problems.push(
      `tiles start at (${tiles?.origin?.x}, ${tiles?.origin?.y}), not (${ORIGIN_X}, ${ORIGIN_Y})`,
    );
  }
  if (lod?.resolution !== CELL_METERS) {
    problems.push(`level ${LEVEL} is ${lod?.resolution} m, not ${CELL_METERS}`);
  }
  if (info.pixelType !== "F32") {
    problems.push(`${info.pixelType} cells, not F32`);
  }
  if (!(info.spatialReference?.wkt ?? "").includes("UTM_Zone_10")) {
    problems.push("not published on UTM zone 10");
  }
  if (problems.length > 0) {
    throw new Error(
      `the ALCC canopy service has moved: ${problems.join("; ")}`,
    );
  }
}

// One 256-cell tile of the raster, in the feet it is published in, or null where the service has no
// tile at all — the corners of the two-county rectangle that fall outside the flown area. An empty
// tile inside it comes back as a valid all-zero blob instead, which is a real reading: the model is
// 0 over buildings, over water and everywhere the ground was the highest return.
async function fetchTile(
  row: number,
  column: number,
): Promise<Float32Array | null> {
  const url = `${SERVICE}/tile/${LEVEL}/${row}/${column}`;
  const path = await cachedFile(`alcc-chm-${LEVEL}`, url, async () =>
    pRetry(
      async () => {
        const response = await fetch(url, {
          headers: { "user-agent": USER_AGENT },
        });
        // Cached as no bytes rather than as an error: a tile off the raster stays off it, and a
        // re-run should not ask again.
        if (response.status === 404) {
          return new Uint8Array(0);
        }
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      {
        retries: MAX_ATTEMPTS - 1,
        minTimeout: RETRY_BASE_MS,
        maxTimeout: RETRY_CAP_MS,
        randomize: true,
      },
    ),
  );
  const bytes = await readFile(path);
  if (bytes.byteLength === 0) {
    return null;
  }
  const image = decode(bytes);
  if (image.width !== TILE || image.height !== TILE) {
    throw new Error(
      `${url}: a ${image.width} x ${image.height} tile, not ${TILE} square`,
    );
  }
  return image.pixels[0] as Float32Array;
}

export interface AlccCanopy {
  polygons: Polygon[];
  fetched: number; // components traced, before the specks were dropped
  dropped: number; // components dropped as smaller than the minimum
  tiles: number; // raster tiles the window covers
  covered: number; // of those, the ones holding any canopy at all
  canopyCells: number; // cells above the floor, i.e. square metres of canopy
  droppedCells: number;
  vertices: number;
  heightTiles: string[]; // the height rasters, for the tiler's mosaic sampler
}

// The window's polygons and its height tiles, in one pass over the raster.
//
// Tracing runs per raster tile rather than over the window as a whole, so a polygon never spans
// more than 256 m. That is a deliberate cut, not a limitation of the tracer: the East Bay hills
// carry canopy in single components kilometres across, and one polygon that wide would be scanned
// in full by every map tile and every band of the height sampler it touches. Cutting it costs the
// seams — two abutting polygons where there was one — and buys a bounded polygon everywhere. The
// cover field cannot tell the difference, because the union of the pieces is the same set of cells;
// the crown height can, and reads more locally for it.
export async function fetchAlccCanopy(box: Bounds): Promise<AlccCanopy> {
  const started = performance.now();
  await checkService();
  await load();
  await mkdir(HEIGHT_DIR, { recursive: true });

  // The lon/lat box's own corners projected, then grown to whole tiles: a box is not a rectangle on
  // the grid, so the four corners' extremes cover it and a little more.
  const corners = [
    forwardTmerc(UTM_10N, box.west, box.south),
    forwardTmerc(UTM_10N, box.east, box.south),
    forwardTmerc(UTM_10N, box.west, box.north),
    forwardTmerc(UTM_10N, box.east, box.north),
  ];
  const west = Math.min(...corners.map(({ x }) => x));
  const east = Math.max(...corners.map(({ x }) => x));
  const south = Math.min(...corners.map(({ y }) => y));
  const north = Math.max(...corners.map(({ y }) => y));
  const firstColumn = Math.floor((west - ORIGIN_X) / (TILE * CELL_METERS));
  const lastColumn = Math.floor((east - ORIGIN_X) / (TILE * CELL_METERS));
  const firstRow = Math.floor((ORIGIN_Y - north) / (TILE * CELL_METERS));
  const lastRow = Math.floor((ORIGIN_Y - south) / (TILE * CELL_METERS));
  const across = lastColumn - firstColumn + 1;
  const down = lastRow - firstRow + 1;
  const count = across * down;
  console.error(
    `  alcc: ${count} raster tiles (${across} x ${down}) over ${((east - west) / 1000).toFixed(1)} x ${((north - south) / 1000).toFixed(1)} km`,
  );

  const result: AlccCanopy = {
    polygons: [],
    fetched: 0,
    dropped: 0,
    tiles: count,
    covered: 0,
    canopyCells: 0,
    droppedCells: 0,
    vertices: 0,
    heightTiles: [],
  };
  const floorMeters = CANOPY_FLOOR_FEET * METERS_PER_FOOT;
  const mask = new Uint8Array(TILE * TILE);
  const heights = new Float32Array(TILE * TILE);

  let next = 0;
  let done = 0;
  const pending = new Map<number, Promise<Float32Array | null>>();
  // The reads run ahead of the tracing: one worker's worth of latency each, and the tracing that
  // follows is what actually costs, so the queue is kept exactly FETCH_WORKERS deep.
  const queue = (): void => {
    while (pending.size < FETCH_WORKERS && next < count) {
      const index = next++;
      pending.set(
        index,
        fetchTile(
          firstRow + Math.floor(index / across),
          firstColumn + (index % across),
        ),
      );
    }
  };
  queue();
  for (let index = 0; index < count; index++) {
    const feet = await (pending.get(index) as Promise<Float32Array | null>);
    pending.delete(index);
    queue();
    done += 1;
    if (done % PROGRESS_TILES === 0 || done === count) {
      console.error(
        `  [${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s] alcc: ${done}/${count} tiles, ${result.polygons.length} polygons`,
      );
    }
    if (feet === null) {
      continue;
    }
    const row = firstRow + Math.floor(index / across);
    const column = firstColumn + (index % across);
    let covered = 0;
    for (let cell = 0; cell < feet.length; cell++) {
      const meters = feet[cell] * METERS_PER_FOOT;
      heights[cell] = meters;
      const set = meters >= floorMeters ? 1 : 0;
      mask[cell] = set;
      covered += set;
    }
    if (covered === 0) {
      continue;
    }
    result.covered += 1;

    // The height tile is the raster as published, in metres and not thresholded: the sampler reads
    // it only through these polygons, so what lies under a crown's own cells is all it can see, and
    // a ring that simplification nudged a decimetre outside its cells still lands on a reading.
    const path = join(HEIGHT_DIR, `${row}-${column}.tif`);
    await writeFile(
      path,
      encodeFloatTiff(
        heights,
        TILE,
        TILE,
        ORIGIN_X + column * TILE * CELL_METERS,
        ORIGIN_Y - row * TILE * CELL_METERS,
        CELL_METERS,
      ),
    );
    result.heightTiles.push(path);

    const traced = polygonsOfMask(
      mask,
      TILE,
      TILE,
      SIMPLIFY_METERS / CELL_METERS,
      MINIMUM_SQUARE_METERS / (CELL_METERS * CELL_METERS),
    );
    const grid: Grid = {
      originX: ORIGIN_X,
      originY: ORIGIN_Y,
      width: TILE,
      height: TILE,
      cellMeters: CELL_METERS,
      projection: UTM_10N,
    };
    for (const rings of traced.polygons) {
      const polygon: Polygon = rings.map((ring) =>
        ringToCoords(ring, grid, column * TILE, row * TILE),
      );
      result.vertices += polygon.reduce((sum, ring) => sum + ring.length, 0);
      result.polygons.push(polygon);
    }
    result.fetched += traced.polygons.length + traced.dropped;
    result.dropped += traced.dropped;
    result.canopyCells += traced.cells;
    result.droppedCells += traced.droppedCells;
  }
  return result;
}
