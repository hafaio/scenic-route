import { resolveUrl } from "./base-url";
import { projectX, projectY } from "./mercator";
import { type Cursor, readUnsignedVarint, readVarint } from "./varint";

// The shadow casters as vectors, one chunk per z15 tile (public/casters, magic `CSTR`; layout in
// scripts/README.md). Fetched, decoded and cached here so src/tiles/sweep.ts can generate the shadows
// deep in, where the baked pyramid would only be magnified.
//
// A chunk's rings land as ZOOM-0 world pixels rather than degrees: Mercator is the same projection at
// every zoom up to a factor of 2^z, so projecting once at decode turns the per-vertex draw cost into a
// multiply and a subtract — and, since it is conformal, a translation down the shadow into a constant
// pixel offset rather than a per-vertex reprojection.

const CHUNK_URL = "casters/{x}/{y}.bin";
const MANIFEST_URL = "casters/manifest.json";
const CASTER_MAGIC = "CSTR";
const CASTER_FORMAT = 3;
const DECIMETERS_PER_METER = 10;
const CENTIMETERS_PER_METER = 100;
const TILE_SIZE = 256;

export const EQUATOR_METERS_PER_PIXEL = 156_543.033_92;

// A footprint whose convex hull over-fills it by less than this is swept as that one hull rather than
// as an exact Minkowski sum. Keep in sync with MIN_CONCAVITY_M2 in crates/tiler/src/shade.rs.
const MIN_CONCAVITY_M2 = 200;

// Decoded chunks held between draws. Sized off the measured worst case: a screenful of z15 tiles over
// a canopy-heavy park gathers 48 chunks, which the crown slices took from 43 MiB decoded to about 100,
// and a working set that does not fit would re-fetch on every pan. The geometry is sun-independent, so
// holding it also means a scrub through the clock re-sweeps out of the cache without a fetch.
const CACHE_BYTES = 160 * 1024 * 1024;

export interface CasterManifest {
  chunkZoom: number;
  coordScale: number;
  maxShadowMeters: number; // how far outside its own tile a chunk's shadows can reach
  chunks: { x: number; y: number; bytes: number }[];
}

// One z15 chunk's casters, flattened so a draw walks typed arrays rather than objects. Ring `r` covers
// `points[2 * rings[r]]` up to `2 * rings[r + 1]`, and record `i` owns rings `records[i]` up to
// `records[i + 1]`. A footprint's are its outer ring then its holes; a crown's are its SLICES, and
// `levels` is what says which slice a ring belongs to and so how far down the shadow it is swept.
export interface CasterChunk {
  points: Float64Array; // x/y interleaved, zoom-0 world pixels
  rings: Uint32Array;
  records: Uint32Array;
  heights: Float32Array; // metres
  boxes: Float64Array; // per record, the box of everything it casts from, as minX, minY, maxX, maxY
  // Per RING, its convex hull as a start vertex and a count into `hullPoints`, positively wound. Zero
  // where the ring is concave enough to need the exact sweep, and for a footprint's holes. Held apart
  // from `points` because `rings` gives only ring ends, so the rings have to stay contiguous.
  hulls: Uint32Array;
  hullPoints: Float64Array;
  wound: Uint8Array; // per ring, 1 when its own winding is already positive in world pixels
  levels: Uint8Array; // per ring, which slice of its crown it is; 0 for every footprint ring
  buildings: number; // records below this are footprints, the rest crowns
  // The census trunks, which are points rather than records: x/y interleaved in zoom-0 world pixels,
  // then per trunk a radius and the height it stands to, both in metres.
  trunks: Float64Array;
  trunkRadii: Float32Array;
  trunkHeights: Float32Array;
  trunkBox: Float64Array; // minX, minY, maxX, maxY over the points alone
  trunkMaxHeight: number; // how far past that box a trunk shadow can reach, as a height in metres
  bytes: number;
}

// Twice the area a ring of `count` vertices encloses, signed positive for the winding a nonzero fill
// must see everywhere or two overlapping shadows will subtract instead of union.
//
// Taken about the ring's OWN first vertex, which is also why the closing edge contributes nothing. A
// building spans ~1e-5 of a zoom-0 pixel against coordinates near 78, so the shoelace terms of the
// absolute coordinates cancel down to rounding and the sign comes out of the noise.
function signedDoubleArea(
  points: number[],
  count: number,
  at: (step: number) => number,
): number {
  const originX = points[at(0) * 2];
  const originY = points[at(0) * 2 + 1];
  let sum = 0;
  let previousX = 0;
  let previousY = 0;
  for (let step = 1; step < count; step++) {
    const x = points[at(step) * 2] - originX;
    const y = points[at(step) * 2 + 1] - originY;
    sum += previousX * y - x * previousY;
    previousX = x;
    previousY = y;
  }
  return sum;
}

// Andrew's monotone chain over one ring, as vertex indices into `points`. Mirrors `convex_hull` in
// crates/tiler/src/shade.rs: collinear points are dropped, which only makes the sweep that reads it
// back cheaper.
function convexHull(points: number[], from: number, to: number): number[] {
  const order = Array.from({ length: to - from }, (_, index) => from + index);
  order.sort(
    (left, right) =>
      points[left * 2] - points[right * 2] ||
      points[left * 2 + 1] - points[right * 2 + 1],
  );
  const cross = (origin: number, first: number, second: number): number =>
    (points[first * 2] - points[origin * 2]) *
      (points[second * 2 + 1] - points[origin * 2 + 1]) -
    (points[first * 2 + 1] - points[origin * 2 + 1]) *
      (points[second * 2] - points[origin * 2]);

  const hull: number[] = [];
  for (const index of order) {
    while (
      hull.length >= 2 &&
      cross(hull[hull.length - 2], hull[hull.length - 1], index) <= 0
    ) {
      hull.pop();
    }
    hull.push(index);
  }
  const lower = hull.length + 1; // the upper chain may not pop below the lower one's last vertex
  for (let at = order.length - 1; at >= 0; at--) {
    while (
      hull.length >= lower &&
      cross(hull[hull.length - 2], hull[hull.length - 1], order[at]) <= 0
    ) {
      hull.pop();
    }
    hull.push(order[at]);
  }
  hull.pop(); // the first point closes both chains
  return hull;
}

// Walk one chunk back: the 44-byte header, then the buildings — a height, a ring count and per ring a
// vertex count and the running zigzag deltas — then the crowns, the same but with a SLICE count and a
// ring count per slice, then the trunks as their own chain of deltas, a radius and a height apiece.
export function decodeChunk(buffer: ArrayBuffer): CasterChunk {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== CASTER_MAGIC || version !== CASTER_FORMAT) {
    throw new Error(`not a v${CASTER_FORMAT} caster chunk`);
  }
  const buildings = view.getUint32(8, true);
  const count = buildings + view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  // A chunk spans under a kilometre, so its own origin's scale stands for all of it — this only weighs
  // a footprint against its hull, against a 200 m² threshold.
  const metersPerPoint =
    EQUATOR_METERS_PER_PIXEL * Math.cos((originLat * Math.PI) / 180);
  const points: number[] = [];
  const hullPoints: number[] = [];
  const rings: number[] = [0];
  const wound: number[] = [];
  const levels: number[] = [];
  const hulls: number[] = [];
  const records = new Uint32Array(count + 1);
  const heights = new Float32Array(count);
  const boxes = new Float64Array(count * 4);

  // One ring's vertices, carrying the record's running delta chain on, plus what a sweep reads off it:
  // its winding, its slice, and the convex hull that stands in for it when it is barely concave.
  const readRing = (level: number, quantized: [number, number]): void => {
    const vertices = readUnsignedVarint(bytes, cursor);
    const start = points.length / 2;
    for (let vertex = 0; vertex < vertices; vertex++) {
      quantized[0] += readVarint(bytes, cursor);
      quantized[1] += readVarint(bytes, cursor);
      points.push(
        projectX(originLng + quantized[0] * scale, 0),
        projectY(originLat + quantized[1] * scale, 0),
      );
    }
    const end = points.length / 2;
    const area = signedDoubleArea(points, end - start, (step) => start + step);
    rings.push(end);
    wound.push(area > 0 ? 1 : 0);
    levels.push(level);
    hulls.push(0, 0);

    const hull = convexHull(points, start, end);
    if (hull.length < 3) {
      return; // a ring with no area; the exact sweep handles it and produces nothing
    }
    const hullArea = signedDoubleArea(
      points,
      hull.length,
      (step) => hull[step],
    );
    const concavity =
      ((Math.abs(hullArea) - Math.abs(area)) / 2) *
      metersPerPoint *
      metersPerPoint;
    if (concavity >= MIN_CONCAVITY_M2) {
      return; // a courtyard, an L-block, a park's canopy: swept exactly, so its notches stay unshaded
    }
    if (hullArea < 0) {
      hull.reverse();
    }
    hulls[hulls.length - 2] = hullPoints.length / 2;
    hulls[hulls.length - 1] = hull.length;
    for (const index of hull) {
      hullPoints.push(points[index * 2], points[index * 2 + 1]);
    }
  };

  for (let record = 0; record < count; record++) {
    // The chain runs across a record's rings but restarts at the chunk origin for each record.
    const quantized: [number, number] = [0, 0];
    heights[record] = readUnsignedVarint(bytes, cursor) / DECIMETERS_PER_METER;
    if (record < buildings) {
      const ringCount = readUnsignedVarint(bytes, cursor);
      records[record + 1] = records[record] + ringCount;
      for (let ring = 0; ring < ringCount; ring++) {
        readRing(0, quantized);
      }
    } else {
      const levelCount = readUnsignedVarint(bytes, cursor);
      records[record + 1] = records[record];
      for (let level = 0; level < levelCount; level++) {
        const ringCount = readUnsignedVarint(bytes, cursor);
        records[record + 1] += ringCount;
        for (let ring = 0; ring < ringCount; ring++) {
          readRing(level, quantized);
        }
      }
    }
    // The box a record is gathered by covers its OUTERMOST rings — a footprint's outer ring, a crown's
    // widest slice — which every other ring of it sits inside.
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let ring = records[record]; ring < records[record + 1]; ring++) {
      if (
        levels[ring] !== 0 ||
        (record < buildings && ring > records[record])
      ) {
        continue;
      }
      for (let index = rings[ring]; index < rings[ring + 1]; index++) {
        minX = Math.min(minX, points[index * 2]);
        maxX = Math.max(maxX, points[index * 2]);
        minY = Math.min(minY, points[index * 2 + 1]);
        maxY = Math.max(maxY, points[index * 2 + 1]);
      }
    }
    boxes[record * 4] = minX;
    boxes[record * 4 + 1] = minY;
    boxes[record * 4 + 2] = maxX;
    boxes[record * 4 + 3] = maxY;
  }

  const trunkCount = view.getUint32(40, true);
  const trunks = new Float64Array(trunkCount * 2);
  const trunkRadii = new Float32Array(trunkCount);
  const trunkHeights = new Float32Array(trunkCount);
  const trunkBox = new Float64Array([
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]);
  let trunkMaxHeight = 0;
  let trunkX = 0;
  let trunkY = 0;
  for (let trunk = 0; trunk < trunkCount; trunk++) {
    trunkX += readVarint(bytes, cursor);
    trunkY += readVarint(bytes, cursor);
    const x = projectX(originLng + trunkX * scale, 0);
    const y = projectY(originLat + trunkY * scale, 0);
    trunks[trunk * 2] = x;
    trunks[trunk * 2 + 1] = y;
    trunkRadii[trunk] =
      readUnsignedVarint(bytes, cursor) / CENTIMETERS_PER_METER;
    const height = readUnsignedVarint(bytes, cursor) / DECIMETERS_PER_METER;
    trunkHeights[trunk] = height;
    trunkMaxHeight = Math.max(trunkMaxHeight, height);
    trunkBox[0] = Math.min(trunkBox[0], x);
    trunkBox[1] = Math.min(trunkBox[1], y);
    trunkBox[2] = Math.max(trunkBox[2], x);
    trunkBox[3] = Math.max(trunkBox[3], y);
  }

  const buffers = {
    points: new Float64Array(points),
    rings: new Uint32Array(rings),
    records,
    heights,
    boxes,
    hulls: new Uint32Array(hulls),
    hullPoints: new Float64Array(hullPoints),
    wound: new Uint8Array(wound),
    levels: new Uint8Array(levels),
    trunks,
    trunkRadii,
    trunkHeights,
    trunkBox,
  };
  return {
    ...buffers,
    buildings,
    trunkMaxHeight,
    bytes: Object.values(buffers).reduce(
      (total, buffer) => total + buffer.byteLength,
      0,
    ),
  };
}

let manifest: Promise<CasterManifest | null> | null = null;

// The chunk grid, or null where the deploy carries no casters — then the shade layer stays on the
// baked pyramid at every zoom.
export function casterManifest(): Promise<CasterManifest | null> {
  if (!manifest) {
    manifest = fetch(resolveUrl(MANIFEST_URL))
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }
  return manifest;
}

// Which chunks were written, so the halo around a viewport does not turn its empty tiles into 404s.
const written = new WeakMap<CasterManifest, Set<string>>();

function exists(manifest: CasterManifest, key: string): boolean {
  let index = written.get(manifest);
  if (!index) {
    index = new Set(manifest.chunks.map(({ x, y }) => `${x}/${y}`));
    written.set(manifest, index);
  }
  return index.has(key);
}

interface CacheEntry {
  chunk: Promise<CasterChunk | null>;
  bytes: number; // 0 until it decodes, so an in-flight chunk is free to evict
}

const cache = new Map<string, CacheEntry>();
let cached = 0;

function fetchChunk(key: string): Promise<CasterChunk | null> {
  const hit = cache.get(key);
  if (hit) {
    // Map iterates in insertion order, so re-inserting is what makes the eviction below an LRU.
    cache.delete(key);
    cache.set(key, hit);
    return hit.chunk;
  }
  const [x, y] = key.split("/");
  const url = resolveUrl(CHUNK_URL.replace("{x}", x).replace("{y}", y));
  const entry: CacheEntry = {
    bytes: 0,
    chunk: fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${url}: ${response.status} ${response.statusText}`);
        }
        const chunk = decodeChunk(await response.arrayBuffer());
        if (cache.get(key) === entry) {
          entry.bytes = chunk.bytes;
          cached += chunk.bytes;
          for (const [oldest, evicted] of cache) {
            if (cached <= CACHE_BYTES) {
              break;
            }
            cache.delete(oldest);
            cached -= evicted.bytes;
          }
        }
        return chunk;
      })
      // A chunk that failed draws as nothing, but is dropped rather than cached, so the next tile over
      // the same ground tries again.
      .catch(() => {
        cache.delete(key);
        return null;
      }),
  };
  cache.set(key, entry);
  return entry.chunk;
}

// Every chunk whose casters can throw a shadow into a zoom-0 world-pixel box: the box grown by the
// manifest's shadow reach, in chunks that were written.
export async function chunksFor(
  manifest: CasterManifest,
  west: number,
  north: number,
  east: number,
  south: number,
  latitude: number,
): Promise<CasterChunk[]> {
  const { chunkZoom, maxShadowMeters } = manifest;
  const halo =
    maxShadowMeters /
    (EQUATOR_METERS_PER_PIXEL * Math.cos((latitude * Math.PI) / 180));
  const last = 2 ** chunkZoom - 1;
  const chunkAt = (point: number): number =>
    Math.min(
      last,
      Math.max(0, Math.floor((point * 2 ** chunkZoom) / TILE_SIZE)),
    );
  const wanted: Promise<CasterChunk | null>[] = [];
  for (let y = chunkAt(north - halo); y <= chunkAt(south + halo); y++) {
    for (let x = chunkAt(west - halo); x <= chunkAt(east + halo); x++) {
      const key = `${x}/${y}`;
      if (exists(manifest, key)) {
        wanted.push(fetchChunk(key));
      }
    }
  }
  const loaded = await Promise.all(wanted);
  return loaded.filter((chunk): chunk is CasterChunk => chunk !== null);
}
