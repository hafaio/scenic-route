// Where a city's building heights come from when no one publishes them: the raw 3DEP point cloud
// and the bare-earth DEM staged beside it. This fetches both and does nothing else with them — the
// points are binned into a normalized surface model and sampled per footprint in the tiler
// (crates/tiler/src/ndsm.rs), which is where every pixel and every point is read.
//
// The Alameda County flight has no derived surface product at all: no DSM, no canopy model, and its
// points carry no building class. So the surface has to be built from the returns, which is why
// this fetches a point cloud rather than a raster. What makes that affordable is Entwine Point
// Tile: the cloud is published as an octree of small LAZ nodes on plain S3, each level a spatially
// unbiased subsample of the one below, so a window over downtown is a few dozen HTTP GETs rather
// than a county of LAZ swaths. Truncating the walk is a resolution choice and not a spatial one.
//
// Every node and every DEM tile is a separate cache entry, immutable for good: EPT node keys never
// change contents, and an interrupted run resumes at the node it stopped on.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pRetry from "p-retry";
import { cached, cachedFile } from "./cache";

const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const NODE_WORKERS = 16;
// The side of one square of the staged DEM's naming grid: `x56y419` is the 10 km square east of
// 560 km and south of 4 190 km.
export const DEM_SQUARE_METERS = 10_000;
const PROGRESS_NODES = 25;

// Web mercator, which is what an EPT index is laid out in even when the points were flown on a UTM
// grid: the octree's cube bounds and every node's own bounds are in it, so a window has to be
// projected before the walk can compare anything.
const EARTH_RADIUS_METERS = 6_378_137.0;
const MERCATOR_HALF_WIDTH_METERS = 20_037_508.342_789_244;

// The one true metre of ground a 3857 metre stands for shrinks with the cosine of the latitude, and
// the walk's spacing test is in true metres. At 37.8 N the two differ by 21%, which is a whole
// octree level.
function mercatorScale(lat: number): number {
  return 1 / Math.cos((lat * Math.PI) / 180);
}

function mercator(lng: number, lat: number): [number, number] {
  const x = (lng * MERCATOR_HALF_WIDTH_METERS) / 180;
  const y =
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) *
    EARTH_RADIUS_METERS;
  return [x, y];
}

function degrees(x: number, y: number): [number, number] {
  const lng = (x * 180) / MERCATOR_HALF_WIDTH_METERS;
  const lat =
    ((2 * Math.atan(Math.exp(y / EARTH_RADIUS_METERS)) - Math.PI / 2) * 180) /
    Math.PI;
  return [lng, lat];
}

// GRS80 and Snyder's transverse Mercator series, forward only: the same five numbers and the same
// arithmetic as crates/tiler/src/heights.rs, which is where every raster is actually read. It is
// here because the staged DEM names its tiles by the 10 km square of the grid they cover, so
// deciding WHICH tiles a window wants means projecting the window — the one thing this fetcher
// cannot ask the tiler, since the tiler is handed the tiles it fetched.
const SEMI_MAJOR_METERS = 6_378_137.0;
const INVERSE_FLATTENING = 298.257222101;

interface Tmerc {
  centralMeridian: number;
  latOrigin: number;
  scaleFactor: number;
  falseEasting: number;
  falseNorthing: number;
}

// Keyed by the names heights.rs resolves; a city's `crs` is one of these on both sides of the line.
export const PROJECTIONS = {
  utm10n: {
    centralMeridian: -123,
    latOrigin: 0,
    scaleFactor: 0.9996,
    falseEasting: 500_000,
    falseNorthing: 0,
  },
} satisfies Record<string, Tmerc>;

function meridianArc(phi: number, eccentricity2: number): number {
  const e2 = eccentricity2;
  return (
    SEMI_MAJOR_METERS *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) *
        Math.sin(2 * phi) +
      ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * phi))
  );
}

export function project(
  projection: Tmerc,
  lng: number,
  lat: number,
): [number, number] {
  const flattening = 1 / INVERSE_FLATTENING;
  const eccentricity2 = flattening * (2 - flattening);
  const second2 = eccentricity2 / (1 - eccentricity2);
  const phi = (lat * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = sinPhi / cosPhi;
  const curvature =
    SEMI_MAJOR_METERS / Math.sqrt(1 - eccentricity2 * sinPhi * sinPhi);
  const tan2 = tanPhi * tanPhi;
  const eta2 = second2 * cosPhi * cosPhi;
  const east = (((lng - projection.centralMeridian) * Math.PI) / 180) * cosPhi;
  const east2 = east * east;
  const meridian =
    meridianArc(phi, eccentricity2) -
    meridianArc((projection.latOrigin * Math.PI) / 180, eccentricity2);
  const easting =
    projection.scaleFactor *
      curvature *
      (east +
        ((1 - tan2 + eta2) * east * east2) / 6 +
        ((5 - 18 * tan2 + tan2 * tan2 + 72 * eta2 - 58 * second2) *
          east *
          east2 *
          east2) /
          120) +
    projection.falseEasting;
  const northing =
    projection.scaleFactor *
      (meridian +
        curvature *
          tanPhi *
          (east2 / 2 +
            ((5 - tan2 + 9 * eta2 + 4 * eta2 * eta2) * east2 * east2) / 24 +
            ((61 - 58 * tan2 + tan2 * tan2 + 600 * eta2 - 330 * second2) *
              east2 *
              east2 *
              east2) /
              720)) +
    projection.falseNorthing;
  return [easting, northing];
}

export interface LidarWindow {
  west: number;
  south: number;
  east: number;
  north: number;
}

// A city's lidar, as data rather than as code: which EPT indexes cover it, which staged DEM project
// its ground comes from, and what the tiler calls the grid both are read on. Nothing below knows
// the county's name.
export interface LidarSource {
  // Every EPT index whose flight reaches the city, queried and unioned. Their cubes overlap on
  // paper and their coverage does not, so a window inside one index's stated bounds can hold none
  // of its points and all of a neighbour's.
  eptRoots: string[];
  // The staged 1 m bare-earth DEM the ground comes from. Which of its 10 km tiles are wanted is
  // derived from the window, and the project's own link list decides which of those exist: the
  // survey stages nothing for the bay-dominated blocks, and the tiler fills those from the cloud's
  // own ground returns.
  demProject: string;
  // What crates/tiler/src/heights.rs calls the projection the DEM tiles are published on, and the
  // grid the surface model is binned to.
  crs: keyof typeof PROJECTIONS;
  attribution: string;
  sourceUrl: string;
}

// The point spacing the octree walk stops at, in true metres of ground. Every level down costs
// about 3.8x the bytes; measured against the level below it over 343 downtown buildings, the
// per-building height it yields differs by 0.74 m mean absolute, which no shade computation can
// see. Half of it — one more level — is what the spike checks its node counts against.
export const NODE_SPACING_METERS = 1.83;

// The USGS project staging Oakland and Berkeley: three EPT subprojects for the 2021 flight and the
// county's bare-earth DEM. Public domain.
export const ALAMEDA_LIDAR: LidarSource = {
  eptRoots: [1, 2, 3].map(
    (subproject) =>
      `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_AlamedaCo_${subproject}_2021`,
  ),
  demProject: "CA_AlamedaCounty_2021_B21",
  crs: "utm10n",
  attribution: "Elevation © USGS 3DEP",
  sourceUrl:
    "https://www.usgs.gov/3d-elevation-program/3dep-lidar-point-cloud-ca-alamedacounty-2021-b21",
};

// Downtown Oakland: 1.05 by 0.89 km holding the Ordway Building, the Kaiser Center and Lake Merritt
// Plaza — the window every number in the method was measured over.
export const OAKLAND_TEST_WINDOW: LidarWindow = {
  west: -122.27,
  south: 37.805,
  east: -122.258,
  north: 37.813,
};

// The contiguous bayshore run this city's East Bay half is built from — Albany, Berkeley,
// Emeryville, Oakland, Piedmont, Alameda and San Leandro — as Overture's own outlines for them
// bound it, plus a few hundred metres. The south edge is Oakland airport and Bay Farm Island, the
// east edge the ridge above the Oakland hills. Written down rather than derived at run time so the
// walk, the ground tiles it names and the cache entries under both are the same on every run.
export const EAST_BAY_WINDOW: LidarWindow = {
  west: -122.376,
  south: 37.628,
  east: -122.112,
  north: 37.909,
};

interface EptIndex {
  bounds: [number, number, number, number, number, number];
  span: number;
  dataType: string;
}

// A hierarchy page maps a node key to its point count. -1 means the subtree hangs off its own page,
// which is what keeps a county's hierarchy from being one enormous document.
type Hierarchy = Record<string, number>;

export interface EptNode {
  root: string;
  key: string; // depth-x-y-z, the octree address the node's LAZ is named by
  depth: number;
  points: number;
  // The ground the node's cube covers, so the rasterizer can decode only the nodes reaching the
  // block it is binning. A cube is axis-aligned in web mercator, so its corners in degrees bound it
  // exactly rather than approximately.
  bounds: LidarWindow;
}

// The S3 mirror rather than rockyweb, which serves the same bytes at under a megabyte a second.
async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchJson<Value>(url: string): Promise<Value> {
  return await pRetry(
    async () => {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
      });
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
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

// The octree walk: every node whose cube reaches the window, from the root down to the level whose
// spacing is fine enough. Each level is a subsample of the whole cube rather than a tier of a
// pyramid, so the nodes visited on the way down are read too — the rasterizer takes the union.
async function walkNodes(
  root: string,
  window: LidarWindow,
  spacingMeters: number,
): Promise<EptNode[]> {
  const index = await cached(
    `ept-index-${root.slice(root.lastIndexOf("/") + 1)}`,
    root,
    () => fetchJson<EptIndex>(`${root}/ept.json`),
  );
  if (index.dataType !== "laszip") {
    throw new Error(`${root}: ${index.dataType} points, not laszip`);
  }
  const [cubeX, cubeY, , cubeMaxX] = index.bounds;
  const cubeEdge = cubeMaxX - cubeX;
  const [minX, minY] = mercator(window.west, window.south);
  const [maxX, maxY] = mercator(window.east, window.north);
  // The window's own latitude, so the spacing test is in true metres at the ground being flown.
  const spacing =
    spacingMeters * mercatorScale((window.south + window.north) / 2);

  const pages = new Map<string, Hierarchy>();
  const page = async (key: string): Promise<Hierarchy> => {
    const held = pages.get(key);
    if (held) {
      return held;
    }
    const url = `${root}/ept-hierarchy/${key}.json`;
    const fetched = await cached(`ept-hierarchy-${key}`, url, () =>
      fetchJson<Hierarchy>(url),
    );
    pages.set(key, fetched);
    return fetched;
  };

  const nodes: EptNode[] = [];
  const visit = async (key: string, hierarchy: Hierarchy): Promise<void> => {
    const [depth, x, y, z] = key.split("-").map(Number);
    const edge = cubeEdge / 2 ** depth;
    const nodeX = cubeX + x * edge;
    const nodeY = cubeY + y * edge;
    if (
      nodeX >= maxX ||
      nodeX + edge <= minX ||
      nodeY >= maxY ||
      nodeY + edge <= minY
    ) {
      return;
    }
    const listed = hierarchy[key];
    if (listed === undefined) {
      return;
    }
    // The subtree hangs off its own page, whose first entry is this node's own count.
    const table = listed === -1 ? await page(key) : hierarchy;
    const points = listed === -1 ? table[key] : listed;
    const [west, south] = degrees(nodeX, nodeY);
    const [east, north] = degrees(nodeX + edge, nodeY + edge);
    nodes.push({
      root,
      key,
      depth,
      points,
      bounds: { west, south, east, north },
    });
    if (edge / index.span <= spacing) {
      return;
    }
    for (const stepZ of [0, 1]) {
      for (const stepY of [0, 1]) {
        for (const stepX of [0, 1]) {
          await visit(
            `${depth + 1}-${2 * x + stepX}-${2 * y + stepY}-${2 * z + stepZ}`,
            table,
          );
        }
      }
    }
  };
  await visit("0-0-0-0", await page("0-0-0-0"));
  return nodes;
}

// Every index's nodes over one window. Unioned and never deduped: the subprojects' point coverage
// is disjoint in practice, and where it is not, taking the maximum per cell downstream is
// idempotent under a duplicate return.
export async function eptNodes(
  source: LidarSource,
  window: LidarWindow,
  spacingMeters: number,
): Promise<EptNode[]> {
  const walked = await Promise.all(
    source.eptRoots.map((root) => walkNodes(root, window, spacingMeters)),
  );
  return walked.flat();
}

async function fetchNodes(nodes: EptNode[]): Promise<string[]> {
  const paths: string[] = new Array(nodes.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < nodes.length) {
      const index = next++;
      const { root, key } = nodes[index];
      const url = `${root}/ept-data/${key}.laz`;
      const dataset = root.slice(root.lastIndexOf("/") + 1);
      paths[index] = await cachedFile(`ept-${dataset}-${key}`, url, () =>
        pRetry(() => download(url), {
          retries: MAX_ATTEMPTS - 1,
          minTimeout: RETRY_BASE_MS,
          maxTimeout: RETRY_CAP_MS,
          randomize: true,
        }),
      );
      done += 1;
      if (done % PROGRESS_NODES === 0 || done === nodes.length) {
        console.error(`  lidar: ${done}/${nodes.length} point-cloud nodes`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(NODE_WORKERS, nodes.length) }, worker),
  );
  return paths;
}

// One square of the DEM's naming grid: which column and row of it, and the name the survey stages
// the square under.
export interface DemSquare {
  squareX: number;
  squareY: number;
  name: string;
}

// A square is named for its NORTH edge, so the row from 4 180 to 4 190 km is y419.
export function demSquareName(squareX: number, squareY: number): string {
  return `x${squareX}y${squareY + 1}`;
}

// The 10 km squares of the DEM's own grid a window falls in. The staged tiles are named for the
// square they cover — `x56y419` is easting 560-570 km and northing 4180-4190 km — so naming them
// means projecting the window's corners and edges onto that grid. Edges as well as corners because
// a lon/lat rectangle is not a rectangle here: the grid convergence rotates it, and its widest
// point is on an edge.
export function demSquaresOf(
  window: LidarWindow,
  crs: keyof typeof PROJECTIONS,
): DemSquare[] {
  const projection = PROJECTIONS[crs];
  const lngs = [window.west, (window.west + window.east) / 2, window.east];
  const lats = [window.south, (window.south + window.north) / 2, window.north];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const lng of lngs) {
    for (const lat of lats) {
      const [x, y] = project(projection, lng, lat);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const squares: DemSquare[] = [];
  for (
    let squareX = Math.floor(minX / DEM_SQUARE_METERS);
    squareX <= Math.floor(maxX / DEM_SQUARE_METERS);
    squareX++
  ) {
    for (
      let squareY = Math.floor(minY / DEM_SQUARE_METERS);
      squareY <= Math.floor(maxY / DEM_SQUARE_METERS);
      squareY++
    ) {
      squares.push({ squareX, squareY, name: demSquareName(squareX, squareY) });
    }
  }
  return squares;
}

// The staged bare-earth DEM tiles the window falls on, out of the project's own link list. A square
// the project never staged is REPORTED rather than fetched or thrown on: the survey stages nothing
// for the bay-dominated blocks in the southwest — Oakland airport and Bay Farm Island are in three
// of them — and the tiler fills those cells from the cloud's own ground-classified returns.
export async function fetchDemTiles(
  source: LidarSource,
  window: LidarWindow,
): Promise<{ paths: string[]; missing: string[] }> {
  const listUrl = `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/${source.demProject}/0_file_download_links.txt`;
  const links = await cached(
    `dem-links-${source.demProject}`,
    listUrl,
    async () => new TextDecoder().decode(await download(listUrl)),
  );
  const staged = new Map<string, string>();
  for (const line of links.split("\n")) {
    const url = line.trim();
    const tile = /_(x\d+y\d+)_/.exec(url)?.[1];
    if (url && tile) {
      staged.set(tile, url);
    }
  }
  const paths: string[] = [];
  const missing: string[] = [];
  const squares = demSquaresOf(window, source.crs);
  for (const { name: tile } of squares) {
    const url = staged.get(tile);
    if (!url) {
      missing.push(tile);
      continue;
    }
    console.error(`  lidar: ground tile ${tile}`);
    paths.push(
      await cachedFile(`dem-${source.demProject}-${tile}`, url, () =>
        pRetry(() => download(url), {
          retries: MAX_ATTEMPTS - 1,
          minTimeout: RETRY_BASE_MS,
          maxTimeout: RETRY_CAP_MS,
          randomize: true,
        }),
      ),
    );
  }
  console.error(
    `  lidar: ${paths.length} of ${squares.length} ground squares staged${
      missing.length > 0 ? `; ${missing.join(", ")} filled from the cloud` : ""
    }`,
  );
  return { paths, missing };
}

// One cached point-cloud node, with the ground its cube covers so the rasterizer can skip it.
export interface NdsmNode extends LidarWindow {
  path: string;
}

// What the tiler is handed: the cached paths and the window, as JSON rather than argv, because a
// city's walk runs to thousands of nodes.
export interface NdsmParams {
  nodes: NdsmNode[];
  dem: string[];
  crs: string;
  window: LidarWindow;
  // The directory the surface and ground mosaics are written into, one 500 m tile at a time.
  out: string;
  // GeoJSON footprints to sample the finished mosaics under, and where the per-footprint readings
  // are written for the ingest to merge and encode.
  footprints?: string;
  heights?: string;
}

export async function fetchLidar(
  source: LidarSource,
  window: LidarWindow,
  spacingMeters: number,
): Promise<{ nodes: NdsmNode[]; dem: string[] }> {
  const walked = await eptNodes(source, window, spacingMeters);
  describe(walked);
  const paths = await fetchNodes(walked);
  const { paths: dem } = await fetchDemTiles(source, window);
  return {
    nodes: walked.map((node, index) => ({
      path: paths[index],
      ...node.bounds,
    })),
    dem,
  };
}

function describe(nodes: EptNode[]): void {
  const depths = new Map<number, { nodes: number; points: number }>();
  for (const node of nodes) {
    const tally = depths.get(node.depth) ?? { nodes: 0, points: 0 };
    tally.nodes += 1;
    tally.points += node.points;
    depths.set(node.depth, tally);
  }
  let points = 0;
  for (const depth of [...depths.keys()].sort((left, right) => left - right)) {
    const tally = depths.get(depth) ?? { nodes: 0, points: 0 };
    points += tally.points;
    console.error(
      `  lidar: depth ${depth}: ${tally.nodes} nodes, ${tally.points.toLocaleString()} points`,
    );
  }
  console.error(
    `  lidar: ${nodes.length} nodes, ${points.toLocaleString()} points in the window's octree`,
  );
}

// Every area a run can be asked for by name, each a source and the ground it covers. Nothing below
// this line names a county: adding a city is an entry here — its EPT roots, the staged DEM project
// its ground comes from, the grid both are read on, and its window — and no code at all. USGS
// indexes the order of two thousand 3DEP projects on the same bucket and stages the 1 m DEM
// nationally, so this is the height story for most of the country.
const AREAS: Record<string, { source: LidarSource; window: LidarWindow }> = {
  downtown: { source: ALAMEDA_LIDAR, window: OAKLAND_TEST_WINDOW },
  "east-bay": { source: ALAMEDA_LIDAR, window: EAST_BAY_WINDOW },
};

function argument(name: string): string | undefined {
  return process.argv
    .find((given) => given.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

if (import.meta.main) {
  const spacing = Number(argument("spacing") ?? NODE_SPACING_METERS);
  const name = argument("window") ?? "downtown";
  const area = AREAS[name];
  if (!area) {
    throw new Error(`no area named ${name}; ${Object.keys(AREAS)} exist`);
  }
  const { source, window } = area;
  const started = performance.now();
  const { nodes, dem } = await fetchLidar(source, window, spacing);
  const build = join(import.meta.dirname, "..", ".build");
  await mkdir(build, { recursive: true });
  const params: NdsmParams = {
    nodes,
    dem,
    crs: source.crs,
    window,
    out: join(build, `ndsm-${name}`),
    footprints: argument("footprints"),
    heights: argument("heights"),
  };
  await writeFile(join(build, `ndsm-${name}.json`), JSON.stringify(params));
  let bytes = 0;
  for (const node of nodes) {
    bytes += (await stat(node.path)).size;
  }
  console.error(
    `lidar: ${nodes.length} nodes at ${spacing} m spacing, ${(bytes / 1e9).toFixed(2)} GB, and ${dem.length} ground tiles cached in ${((performance.now() - started) / 1000).toFixed(0)}s`,
  );
}
