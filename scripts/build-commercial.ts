// `bun run build-commercial` (also called from build-street-tiles after `tiler chunks`): precomputes
// the commercial overlay's per-segment SIGNALS at build time and writes them as public/commercial/
// {x}/{y}.bin, one file per served STCK street chunk, in the SAME segment order (aligned by index).
// The signals are heavy to snap (≈800k land-use lots + ≈1M building footprints against every street
// segment), and the building set is ~30 MB — far too much to snap in the browser on toggle. So the
// snapping happens here; the overlay reads the signals and applies the (tunable) THRESHOLDS client-
// side, so the gate can be retuned without a rebuild.
//
// Per segment we write three bytes: commercialFrac (commercial lots / all fronting lots, 0..255),
// medianHeightMeters (median snapped roof height, 0..255, 255 when none — so a bare block reads as
// not-low-rise), and flags (bit0 an Open Street sample snapped, bit1 a dining/seating point snapped).
// public/commercial/ is gitignored derived output, like public/streets. Layout: this file's writers.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import manifest from "../src/tree-cover/manifest.json";
import { encodePolygons } from "./geometry";
import type { Bounds } from "./manifest";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const DATA_DIR = join(import.meta.dirname, "..", "data");
const CHUNK_DIR = join(PUBLIC_DIR, "streets");
const COMMERCIAL_DIR = join(PUBLIC_DIR, "commercial");
// The qualifying-block centrelines for the ROUTING bake, one file per city (magic CMLN, the LAND
// polygon layout — each segment is a single-ring "polygon"). `tiler graph` proximity-bakes these
// into a per-edge commercial discount. Derived + gitignored, like the per-chunk signals above.
const COMMERCIAL_LINES_DIR = join(PUBLIC_DIR, "commercial-lines");
const COMMERCIAL_LINES_MAGIC = "CMLN";
const COMMERCIAL_LINES_FORMAT = 1;

// The routing bake reads its qualifying-block lines from here; build-street-tiles passes this path
// to `tiler graph --commercial` when the file exists.
export function commercialLinesPath(cityId: string): string {
  return join(COMMERCIAL_LINES_DIR, `${cityId}.bin`);
}

const CHUNK_MAGIC = "STCK";
const CHUNK_FORMAT = 3;
const CHUNK_ZOOM = 12;
const SIDES = 2; // density bytes per street vertex in a chunk; skipped, we only read geometry

const COMMERCIAL_MAGIC = "CMRC";
const COMMERCIAL_VERSION = 1;
const COMMERCIAL_HEADER_BYTES = 12; // magic(4) + version(2) + headerSize(2) + count(4)

// A lot / point / building centroid is attributed to the segment it FRONTS: its perpendicular
// projection must fall ON a piece of the segment (not past the ends) and within this ground distance.
// The in-span requirement — not the reach — is what keeps corner and cross-street lots out (their
// projection onto a block's segment falls beyond its endpoints), so the reach can be generous enough
// to pull in deep frontage lots. Lots reach ~35 m; a set-back building centroid ~40 m; the flag
// points ~30 m.
const FRONTAGE_METERS = 35;
const BUILDING_FRONTAGE_METERS = 40;
const FLAG_FRONTAGE_METERS = 30;
// A block needs at least this many fronting lots before its commercial fraction is trusted; below it,
// commercialFrac is written 0 (can't pass the client gate).
const MIN_LOTS = 4;

// The land-use digit split the overlay's old client snap used: 4/5 commercial, 1..3 residential.
const COMMERCIAL_CLASS = 4; // this class and above (4 mixed-res/commercial, 5 commercial/office)

// The default client thresholds, mirrored here only to log how many segments pass the full gate.
const GATE_COMMERCIAL_FRACTION = 0.5;
const GATE_LOW_RISE_METERS = 25;

// The spatial grid the snap searches: each segment is registered in every ~330 m cell its bounding
// box overlaps, and a source point scans the cells within its snap radius.
const SEGMENT_CELL_DEG = 0.003;
const METERS_PER_DEGREE_LAT = 111_320; // longitude scales by cos(lat)

interface Segment {
  lngs: Float64Array;
  lats: Float64Array;
}

// One served STCK chunk: its tile coordinates, its segments, and where they start in the flat city
// array (so a signal read back at start + localIndex writes this chunk's file in its own order).
interface Chunk {
  tileX: number;
  tileY: number;
  start: number;
  segments: Segment[];
}

interface Points {
  lngs: Float64Array;
  lats: Float64Array;
}

interface ClassifiedPoints extends Points {
  klasses: Uint8Array;
}

interface Buildings {
  lngs: Float64Array;
  lats: Float64Array;
  heights: Float64Array; // roof height in metres
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

async function readBin(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function magicOf(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

// Decode one STCK v3 street chunk into its segment geometry, in file order. Mirrors the overlay's
// decoder; the per-vertex density bytes are stepped over so the cursor stays aligned.
function decodeChunk(bytes: Uint8Array): Segment[] {
  const view = dataView(bytes);
  if (
    magicOf(bytes) !== CHUNK_MAGIC ||
    view.getUint16(4, true) !== CHUNK_FORMAT
  ) {
    throw new Error(`not a v${CHUNK_FORMAT} street chunk`);
  }
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const segments: Segment[] = [];
  for (let segment = 0; segment < count; segment++) {
    const vertices = view.getUint16(cursor.offset, true);
    cursor.offset += 3; // vertex count u16, then the sidewalk-offset byte we don't need
    const lngs = new Float64Array(vertices);
    const lats = new Float64Array(vertices);
    let quantizedX = 0;
    let quantizedY = 0;
    for (let vertex = 0; vertex < vertices; vertex++) {
      quantizedX += readVarint(bytes, cursor);
      quantizedY += readVarint(bytes, cursor);
      lngs[vertex] = originLng + quantizedX * scale;
      lats[vertex] = originLat + quantizedY * scale;
    }
    cursor.offset += SIDES * vertices; // skip the per-vertex density bytes
    segments.push({ lngs, lats });
  }
  return segments;
}

// Decode a point blob written by encodePoints (DINE, OSTR): header, then per-point zigzag-varint
// (lng, lat) deltas. The trailing name blob is ignored — only `count` points are read.
function decodePoints(bytes: Uint8Array, magic: string): Points {
  const view = dataView(bytes);
  if (magicOf(bytes) !== magic) {
    throw new Error(`not a ${magic} point blob`);
  }
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };
  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let point = 0; point < count; point++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lngs[point] = originLng + quantizedX * scale;
    lats[point] = originLat + quantizedY * scale;
  }
  return { lngs, lats };
}

// Decode the PLUT classified points (encodeClassifiedPoints): header, per-lot varint deltas, then one
// trailing class byte per lot.
function decodeClassified(bytes: Uint8Array): ClassifiedPoints {
  const points = decodePoints(bytes, "PLUT");
  const view = dataView(bytes);
  const count = view.getUint32(8, true);
  const klasses = new Uint8Array(count);
  // The class block is the last `count` bytes of the file (parallel to the sorted points).
  klasses.set(bytes.subarray(bytes.byteLength - count));
  return { ...points, klasses };
}

// Decode the BLDG building footprints (encodeBuildings = encodePolygons body + trailing u16 heights
// then u16 base elevations). Returns one entry per polygon: its outer-ring centroid and roof height.
function decodeBuildings(bytes: Uint8Array): Buildings {
  const view = dataView(bytes);
  if (magicOf(bytes) !== "BLDG") {
    throw new Error("not a BLDG polygon blob");
  }
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  for (let polygon = 0; polygon < count; polygon++) {
    const rings = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    let sumLng = 0;
    let sumLat = 0;
    let outerVertices = 0;
    for (let ring = 0; ring < rings; ring++) {
      const vertices = view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      let quantizedX = 0;
      let quantizedY = 0;
      for (let vertex = 0; vertex < vertices; vertex++) {
        quantizedX += readVarint(bytes, cursor);
        quantizedY += readVarint(bytes, cursor);
        // The centroid is the mean of the OUTER ring's vertices; inner rings (holes) are skipped.
        if (ring === 0) {
          sumLng += originLng + quantizedX * scale;
          sumLat += originLat + quantizedY * scale;
          outerVertices += 1;
        }
      }
    }
    lngs[polygon] = outerVertices > 0 ? sumLng / outerVertices : originLng;
    lats[polygon] = outerVertices > 0 ? sumLat / outerVertices : originLat;
  }
  // The trailing region: `count` u16 roof heights in decimetres, then `count` u16 base elevations.
  const heightsOffset = cursor.offset;
  const heights = new Float64Array(count);
  for (let polygon = 0; polygon < count; polygon++) {
    heights[polygon] = view.getUint16(heightsOffset + polygon * 2, true) / 10;
  }
  return { lngs, lats, heights };
}

// The z12 slippy-tile range a lat/lng box covers: standard web-mercator, north maps to the smaller
// tile y. Used to group the served chunks by city.
function tileRange(bounds: Bounds): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const scale = 2 ** CHUNK_ZOOM;
  const lngToX = (lng: number): number =>
    Math.floor(((lng + 180) / 360) * scale);
  const latToY = (lat: number): number => {
    const radians = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) /
        2) *
        scale,
    );
  };
  return {
    minX: lngToX(bounds.west),
    maxX: lngToX(bounds.east),
    minY: latToY(bounds.north),
    maxY: latToY(bounds.south),
  };
}

// Every served STCK chunk whose tile falls in the city's z12 range, decoded, with each chunk's start
// index into the flat segment array recorded.
async function loadCityChunks(
  bounds: Bounds,
): Promise<{ chunks: Chunk[]; segments: Segment[] }> {
  const { minX, maxX, minY, maxY } = tileRange(bounds);
  const chunks: Chunk[] = [];
  const segments: Segment[] = [];
  let tileXs: string[];
  try {
    tileXs = await readdir(CHUNK_DIR);
  } catch {
    return { chunks, segments };
  }
  for (const tileXName of tileXs.sort()) {
    const tileX = Number.parseInt(tileXName, 10);
    if (!Number.isInteger(tileX) || tileX < minX || tileX > maxX) {
      continue;
    }
    const files = await readdir(join(CHUNK_DIR, tileXName));
    for (const file of files.sort()) {
      const tileY = Number.parseInt(file.replace(/\.bin$/, ""), 10);
      if (!Number.isInteger(tileY) || tileY < minY || tileY > maxY) {
        continue;
      }
      const bytes = await readBin(join(CHUNK_DIR, tileXName, file));
      if (!bytes) {
        continue;
      }
      const chunkSegments = decodeChunk(bytes);
      chunks.push({
        tileX,
        tileY,
        start: segments.length,
        segments: chunkSegments,
      });
      for (const segment of chunkSegments) {
        segments.push(segment);
      }
    }
  }
  return { chunks, segments };
}

// A grid of segment bounding boxes: each segment is registered in every ~330 m cell its box overlaps.
function buildSegmentIndex(segments: Segment[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < segments.length; index++) {
    const { lngs, lats } = segments[index];
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      minLng = Math.min(minLng, lngs[vertex]);
      maxLng = Math.max(maxLng, lngs[vertex]);
      minLat = Math.min(minLat, lats[vertex]);
      maxLat = Math.max(maxLat, lats[vertex]);
    }
    const cellX0 = Math.floor(minLng / SEGMENT_CELL_DEG);
    const cellX1 = Math.floor(maxLng / SEGMENT_CELL_DEG);
    const cellY0 = Math.floor(minLat / SEGMENT_CELL_DEG);
    const cellY1 = Math.floor(maxLat / SEGMENT_CELL_DEG);
    for (let cellX = cellX0; cellX <= cellX1; cellX++) {
      for (let cellY = cellY0; cellY <= cellY1; cellY++) {
        const key = `${cellX},${cellY}`;
        const cell = buckets.get(key);
        if (cell) {
          cell.push(index);
        } else {
          buckets.set(key, [index]);
        }
      }
    }
  }
  return buckets;
}

// Perpendicular distance squared from the origin to the piece (ax, ay)-(bx, by), in a local planar
// (metres) frame, but ONLY when the perpendicular foot falls within the piece (0 <= t <= 1); otherwise
// +Infinity. Squared to avoid a sqrt. This is the frontage test: a point counts for a piece only when
// it sits alongside it, so a corner or cross-street point — whose foot lands past an endpoint — is
// rejected rather than snapped to the nearest end.
function perpendicularInSpanSquared(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const t = -(ax * dx + ay * dy) / lengthSquared;
  if (t < 0 || t > 1) {
    return Number.POSITIVE_INFINITY;
  }
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  return closestX * closestX + closestY * closestY;
}

// Attributes a point to the segment it FRONTS, over the shared index. `seen` + `generation` dedup a
// candidate found in two cells without a per-call allocation. Among every candidate piece whose
// perpendicular foot from the point falls on the piece (in-span) and within `reachMeters`, it returns
// the segment of the closest; a point that fronts no piece (e.g. a lot at a corner, whose foot on
// every nearby block segment lands past an endpoint) returns -1. The hot path — called once per lot,
// per building, and per flag point.
class Attributor {
  private readonly seen: Int32Array;
  private generation = 0;

  constructor(
    private readonly segments: Segment[],
    private readonly buckets: Map<string, number[]>,
  ) {
    this.seen = new Int32Array(segments.length).fill(-1);
  }

  frontage(lng: number, lat: number, reachMeters: number): number {
    this.generation += 1;
    const generation = this.generation;
    const metersPerDegreeLng =
      METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
    const reachDegLat = reachMeters / METERS_PER_DEGREE_LAT;
    const reachDegLng = reachMeters / metersPerDegreeLng;
    const cellX0 = Math.floor((lng - reachDegLng) / SEGMENT_CELL_DEG);
    const cellX1 = Math.floor((lng + reachDegLng) / SEGMENT_CELL_DEG);
    const cellY0 = Math.floor((lat - reachDegLat) / SEGMENT_CELL_DEG);
    const cellY1 = Math.floor((lat + reachDegLat) / SEGMENT_CELL_DEG);
    const reachSquared = reachMeters * reachMeters;

    let best = Number.POSITIVE_INFINITY;
    let bestSegment = -1;
    for (let cellX = cellX0; cellX <= cellX1; cellX++) {
      for (let cellY = cellY0; cellY <= cellY1; cellY++) {
        const cell = this.buckets.get(`${cellX},${cellY}`);
        if (!cell) {
          continue;
        }
        for (const index of cell) {
          if (this.seen[index] === generation) {
            continue;
          }
          this.seen[index] = generation;
          const { lngs, lats } = this.segments[index];
          // The perpendicular-in-span distance to the closest FRONTED piece of this segment; +Infinity
          // if the point fronts no piece of it (foot past every piece's ends).
          let nearest = Number.POSITIVE_INFINITY;
          let previousX = (lngs[0] - lng) * metersPerDegreeLng;
          let previousY = (lats[0] - lat) * METERS_PER_DEGREE_LAT;
          for (let vertex = 1; vertex < lngs.length; vertex++) {
            const currentX = (lngs[vertex] - lng) * metersPerDegreeLng;
            const currentY = (lats[vertex] - lat) * METERS_PER_DEGREE_LAT;
            nearest = Math.min(
              nearest,
              perpendicularInSpanSquared(
                previousX,
                previousY,
                currentX,
                currentY,
              ),
            );
            previousX = currentX;
            previousY = currentY;
          }
          if (nearest < best) {
            best = nearest;
            bestSegment = index;
          }
        }
      }
    }
    return best <= reachSquared ? bestSegment : -1;
  }
}

function dataPath(kind: string, cityId: string): string {
  return join(DATA_DIR, kind, `${cityId}.bin`);
}

interface Signals {
  commercialFrac: Uint8Array;
  medianHeight: Uint8Array;
  flags: Uint8Array;
}

// Attribute every source to the segment it fronts and reduce to the three per-segment signal bytes.
async function computeSignals(
  cityId: string,
  segments: Segment[],
): Promise<Signals> {
  const buckets = buildSegmentIndex(segments);
  const attributor = new Attributor(segments, buckets);
  const count = segments.length;

  const commercialFrac = new Uint8Array(count);
  const medianHeight = new Uint8Array(count).fill(255); // 255 = no buildings snapped => not low-rise
  const flags = new Uint8Array(count);

  const landuseBytes = await readBin(dataPath("landuse", cityId));
  const commercialLots = new Int32Array(count);
  const totalLots = new Int32Array(count);
  if (landuseBytes) {
    const lots = decodeClassified(landuseBytes);
    for (let lot = 0; lot < lots.lngs.length; lot++) {
      const segment = attributor.frontage(
        lots.lngs[lot],
        lots.lats[lot],
        FRONTAGE_METERS,
      );
      if (segment >= 0) {
        totalLots[segment] += 1;
        if (lots.klasses[lot] >= COMMERCIAL_CLASS) {
          commercialLots[segment] += 1;
        }
      }
    }
  }
  for (let index = 0; index < count; index++) {
    if (totalLots[index] >= MIN_LOTS) {
      commercialFrac[index] = Math.round(
        (255 * commercialLots[index]) / totalLots[index],
      );
    }
  }

  const buildingBytes = await readBin(dataPath("buildings", cityId));
  if (buildingBytes) {
    const buildings = decodeBuildings(buildingBytes);
    const perSegment: number[][] = Array.from({ length: count }, () => []);
    for (let building = 0; building < buildings.lngs.length; building++) {
      const segment = attributor.frontage(
        buildings.lngs[building],
        buildings.lats[building],
        BUILDING_FRONTAGE_METERS,
      );
      if (segment >= 0) {
        perSegment[segment].push(buildings.heights[building]);
      }
    }
    for (let index = 0; index < count; index++) {
      const list = perSegment[index];
      if (list.length > 0) {
        list.sort((left, right) => left - right);
        const median = list[list.length >> 1];
        medianHeight[index] = Math.min(255, Math.max(0, Math.round(median)));
      }
    }
  }

  const openStreetBytes = await readBin(dataPath("openstreets", cityId));
  if (openStreetBytes) {
    const samples = decodePoints(openStreetBytes, "OSTR");
    for (let sample = 0; sample < samples.lngs.length; sample++) {
      const segment = attributor.frontage(
        samples.lngs[sample],
        samples.lats[sample],
        FLAG_FRONTAGE_METERS,
      );
      if (segment >= 0) {
        flags[segment] |= 1;
      }
    }
  }

  const diningBytes = await readBin(dataPath("dining", cityId));
  if (diningBytes) {
    const points = decodePoints(diningBytes, "DINE");
    for (let point = 0; point < points.lngs.length; point++) {
      const segment = attributor.frontage(
        points.lngs[point],
        points.lats[point],
        FLAG_FRONTAGE_METERS,
      );
      if (segment >= 0) {
        flags[segment] |= 2;
      }
    }
  }

  return { commercialFrac, medianHeight, flags };
}

// Serialize one chunk's slice of the signals as a CMRC file: the 12-byte header, then 3 bytes per
// segment in the chunk's own order.
function encodeCommercial(chunk: Chunk, signals: Signals): Uint8Array {
  const count = chunk.segments.length;
  const bytes = new Uint8Array(COMMERCIAL_HEADER_BYTES + count * 3);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = COMMERCIAL_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, COMMERCIAL_VERSION, true);
  view.setUint16(6, COMMERCIAL_HEADER_BYTES, true);
  view.setUint32(8, count, true);
  let offset = COMMERCIAL_HEADER_BYTES;
  for (let local = 0; local < count; local++) {
    const segment = chunk.start + local;
    bytes[offset] = signals.commercialFrac[segment];
    bytes[offset + 1] = signals.medianHeight[segment];
    bytes[offset + 2] = signals.flags[segment];
    offset += 3;
  }
  return bytes;
}

// The default gate the overlay applies client-side, mirrored here to pick the segments the routing
// bake rewards: over-half commercial frontage, low-rise, and either an open street or seating fronting.
function segmentQualifies(signals: Signals, index: number): boolean {
  return (
    signals.commercialFrac[index] / 255 >= GATE_COMMERCIAL_FRACTION &&
    signals.medianHeight[index] <= GATE_LOW_RISE_METERS &&
    (signals.flags[index] & 3) !== 0
  );
}

// The qualifying segments' polylines as a CMLN line file: each becomes one single-ring polygon — the
// exact LAND layout `tiler graph` reads via read_polygons — so the routing bake needs no new format.
function encodeQualifyingLines(
  segments: Segment[],
  signals: Signals,
): { bytes: Uint8Array; count: number } {
  const lines: { lng: number; lat: number }[][][] = [];
  for (let index = 0; index < segments.length; index++) {
    if (!segmentQualifies(signals, index)) {
      continue;
    }
    const { lngs, lats } = segments[index];
    const ring: { lng: number; lat: number }[] = [];
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      ring.push({ lng: lngs[vertex], lat: lats[vertex] });
    }
    lines.push([ring]);
  }
  return {
    bytes: encodePolygons(
      COMMERCIAL_LINES_MAGIC,
      COMMERCIAL_LINES_FORMAT,
      lines,
    ),
    count: lines.length,
  };
}

export async function buildCommercial(): Promise<void> {
  await rm(COMMERCIAL_DIR, { recursive: true, force: true });
  await mkdir(COMMERCIAL_DIR, { recursive: true });
  await rm(COMMERCIAL_LINES_DIR, { recursive: true, force: true });
  await mkdir(COMMERCIAL_LINES_DIR, { recursive: true });

  for (const city of manifest.cities) {
    const started = performance.now();
    const { chunks, segments } = await loadCityChunks(city.bounds);
    if (segments.length === 0) {
      console.error(
        `commercial: ${city.id} has no served street chunks, skipped`,
      );
      continue;
    }
    const signals = await computeSignals(city.id, segments);

    for (const chunk of chunks) {
      const dir = join(COMMERCIAL_DIR, String(chunk.tileX));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${chunk.tileY}.bin`),
        encodeCommercial(chunk, signals),
      );
    }

    // The qualifying-block lines the routing bake consumes: the same gate, emitted once per city.
    const { bytes: lineBytes, count: passing } = encodeQualifyingLines(
      segments,
      signals,
    );
    await writeFile(commercialLinesPath(city.id), lineBytes);

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.error(
      `commercial: ${city.id} ${segments.length} segments in ${chunks.length} chunks, ${passing} pass the default gate (>=${GATE_COMMERCIAL_FRACTION} commercial, <=${GATE_LOW_RISE_METERS} m, open-street|seating), ${seconds}s`,
    );
  }
}

if (import.meta.main) {
  await buildCommercial();
}
