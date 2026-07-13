// Usage:
//   bun run build-tree-data
//
// Builds the two inputs the map overlays are rendered from, and the manifest that
// describes them.
//
// The model is one quantity — tree density per unit area — estimated at two scales off
// the same points, so the background and the roads are directly comparable:
//
//   * every standing tree in the city inventory is splatted onto a 20 m grid, and that
//     grid is Gaussian-blurred twice: once wide (BROAD_SIGMA_METERS) for the background
//     field, once tight (TIGHT_SIGMA_METERS) for what a road itself is lined with.
//   * the inventory is a street/managed-tree register, so it has no woodland in it at
//     all — the Ramble is 0 trees in it, not sparse ones. OpenStreetMap wood/forest
//     polygons are filled into a canopy mask, and inside that mask both fields are
//     raised to WOODLAND_FLOOR.
//   * both fields are divided by the SAME constant, the SATURATION percentile of the
//     broad field over land, so a tree-lined street reads darker than its neighbourhood
//     and a bare one reads as a pale gap through it.
//
// Writes data/tree-cover/<id>.bin (the field), data/streets/<id>.bin (the road geometry
// carrying the tight field at every vertex) and src/tree-cover/manifest.json. The two
// binaries are build inputs, committed via Git LFS and rendered into the map overlays by
// scripts/build-street-tiles.ts, so this only needs re-running when the sources are
// refreshed.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Bounds,
  type CityEntry,
  type Distribution,
  type FieldLayer,
  type Percentile,
  readManifest,
  type StreetLayer,
  writeManifest,
} from "./manifest";
import { fetchWoodland, type Polygon } from "./overpass";
import { type Coord, fetchDataset, fetchNycTrees } from "./socrata";

// CSCL road-way types that carry pedestrians: street, boardwalk, path/trail, step
// street, alley. Highways, ramps, bridges, tunnels, driveways, ferry routes, u-turns
// and non-physical segments are not part of the walkable network.
type RoadType = 1 | 5 | 6 | 7 | 10;

interface Segment {
  physicalId: number;
  roadType: RoadType;
  streetWidth: number; // feet, 0 unknown
  postedSpeed: number; // mph, 0 unknown
  points: Coord[]; // densified, so the field is sampled at least every DENSIFY_METERS
  lengthMeters: number;
}

// A regular lat/lng grid. Column `col` spans [west + col * degreesPerCol, +1) and its
// centre sits at col + 0.5; rows run south from `north` the same way.
interface Grid {
  cols: number;
  rows: number;
  west: number;
  north: number;
  degreesPerCol: number;
  degreesPerRow: number;
}

interface Fields {
  grid: Grid;
  broad: Float32Array; // normalized 0..1, the background fill
  tight: Float32Array; // normalized 0..1 on the same scale, sampled along the roads
  landMask: Uint8Array; // 1 on city land; the population the saturation is taken over
  saturation: number; // trees per cell that both fields divide by
  landCells: number;
  woodlandCells: number;
}

interface StreetRow {
  the_geom?: { type: string; coordinates: [number, number][][] };
  physicalid?: string;
  rw_type?: string;
  streetwidth?: string;
  posted_speed?: string;
}

interface BoroughRow {
  the_geom?: { type: string; coordinates: [number, number][][][] };
}

const STREET_DIR = join(import.meta.dirname, "..", "data", "streets");
const FIELD_DIR = join(import.meta.dirname, "..", "data", "tree-cover");

const STREET_FORMAT = 2;
const STREET_HEADER_BYTES = 56;
const STREET_RECORD_BYTES = 24;
const FIELD_FORMAT = 1;
const FIELD_HEADER_BYTES = 48;
const COORD_SCALE = 1e-6; // degrees per quantized coordinate unit, ~0.1 m

const CELL_METERS = 20;
const BROAD_SIGMA_METERS = 70; // neighbourhood leafiness
const TIGHT_SIGMA_METERS = 20; // what this street is lined with
// The canopy mask has no tree count to give, so it is combined at the normalized level:
// woodland is simply treed, and the mask is feathered so a park edge is not a hard cut.
const WOODLAND_FLOOR = 0.85;
const WOODLAND_FEATHER_METERS = 30;
// A blurred mask sags in the middle of anything narrower than the blur, and OSM maps a
// wood like the Ramble as a scatter of small polygons around its paths and clearings, so
// the blur is divided by this and clamped: a cell the blur says is at least half covered
// is fully wooded, and only the outer half of the kernel is left to taper. That keeps the
// soft edge and gives back the interior.
const WOODLAND_PLATEAU = 0.5;
// Both fields divide by this percentile of the broad field over land, so the top few
// percent of the city's leafiest ground is where the ramp tops out.
const SATURATION: Percentile = "p97";
const BLUR_RADII = 3; // kernel half-width, in sigmas
const PAD_METERS = 3 * BROAD_SIGMA_METERS; // room for the widest kernel to run off the city

const DENSIFY_METERS = 25; // road sampling step, close enough to the tight kernel to be smooth
const DROP_LENGTH_METERS = 1; // shorter than this the geometry is degenerate
const EARTH_RADIUS_METERS = 6_371_008.8;
const METERS_PER_DEGREE_LAT = 111_320;
const SQUARE_METERS_PER_HECTARE = 10_000;
const PERCENTILES: readonly Percentile[] = [
  "p1",
  "p5",
  "p10",
  "p20",
  "p30",
  "p40",
  "p50",
  "p60",
  "p70",
  "p80",
  "p90",
  "p95",
  "p97",
  "p99",
];

const ROAD_TYPES: readonly RoadType[] = [1, 5, 6, 7, 10];
const NYC_SEGMENT_COUNT = 109_463;
const NYC_BOROUGH_COUNT = 5;

function toInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function haversineMeters(from: Coord, to: Coord): number {
  const fromLat = from.lat * (Math.PI / 180);
  const toLat = to.lat * (Math.PI / 180);
  const deltaLat = toLat - fromLat;
  const deltaLng = (to.lng - from.lng) * (Math.PI / 180);
  const chord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

// Splits every piece longer than DENSIFY_METERS, so the field is sampled often enough
// along a road for its colour to vary smoothly rather than in one flat block.
function densify(points: Coord[]): { points: Coord[]; lengthMeters: number } {
  const dense: Coord[] = [points[0]];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const meters = haversineMeters(from, to);
    total += meters;
    const steps = Math.max(1, Math.ceil(meters / DENSIFY_METERS));
    for (let step = 1; step <= steps; step++) {
      const along = step / steps;
      dense.push({
        lat: from.lat + (to.lat - from.lat) * along,
        lng: from.lng + (to.lng - from.lng) * along,
      });
    }
  }
  return { points: dense, lengthMeters: total };
}

// A CSCL row is a MultiLineString, virtually always with a single part; a row with
// several parts becomes several records sharing one physicalid.
function toSegments(rows: StreetRow[]): Segment[] {
  const segments: Segment[] = [];
  let degenerate = 0;
  for (const row of rows) {
    const roadType = toInt(row.rw_type) as RoadType;
    if (!row.the_geom || !ROAD_TYPES.includes(roadType)) {
      continue;
    }
    for (const part of row.the_geom.coordinates) {
      const points: Coord[] = [];
      for (const [lng, lat] of part) {
        const previous = points[points.length - 1];
        if (!previous || previous.lng !== lng || previous.lat !== lat) {
          points.push({ lng, lat });
        }
      }
      if (points.length < 2) {
        degenerate += 1;
        continue;
      }
      const dense = densify(points);
      if (dense.lengthMeters < DROP_LENGTH_METERS) {
        degenerate += 1;
        continue;
      }
      segments.push({
        physicalId: toInt(row.physicalid),
        roadType,
        streetWidth: Math.min(255, toInt(row.streetwidth)),
        postedSpeed: Math.min(255, toInt(row.posted_speed)),
        points: dense.points,
        lengthMeters: dense.lengthMeters,
      });
    }
  }
  if (degenerate > 0) {
    console.error(`  dropped ${degenerate} degenerate segments`);
  }
  return segments;
}

async function fetchNycStreets(): Promise<Segment[]> {
  const rows = await fetchDataset<StreetRow>(
    "inkn-q76z",
    {
      $select: "the_geom,physicalid,rw_type,streetwidth,posted_speed",
      $where: `rw_type in (${ROAD_TYPES.map((type) => `'${type}'`).join(",")})`,
    },
    NYC_SEGMENT_COUNT,
  );
  return toSegments(rows);
}

// The shoreline-clipped borough boundaries: land only, so the harbour is not part of the
// distribution the ramp is normalized against, and so the OSM woodland that the city's
// bounding box also catches in New Jersey and Westchester is cut away.
async function fetchNycLand(): Promise<Polygon[]> {
  const rows = await fetchDataset<BoroughRow>(
    "gthc-hcne",
    { $select: "the_geom" },
    NYC_BOROUGH_COUNT,
  );
  const polygons: Polygon[] = [];
  for (const row of rows) {
    for (const parts of row.the_geom?.coordinates ?? []) {
      polygons.push(
        parts.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
      );
    }
  }
  return polygons;
}

function boxOf(polygons: Polygon[]): Bounds {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const { lat, lng } of ring) {
        south = Math.min(south, lat);
        north = Math.max(north, lat);
        west = Math.min(west, lng);
        east = Math.max(east, lng);
      }
    }
  }
  return { south, west, north, east };
}

function gridOf(segments: Segment[], trees: Coord[]): Grid {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  const swallow = ({ lat, lng }: Coord): void => {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  };
  for (const segment of segments) {
    for (const point of segment.points) {
      swallow(point);
    }
  }
  for (const tree of trees) {
    swallow(tree);
  }

  const metersPerDegreeLng =
    METERS_PER_DEGREE_LAT * Math.cos((((south + north) / 2) * Math.PI) / 180);
  const degreesPerCol = CELL_METERS / metersPerDegreeLng;
  const degreesPerRow = CELL_METERS / METERS_PER_DEGREE_LAT;
  const padCols = Math.ceil(PAD_METERS / CELL_METERS);
  return {
    cols: Math.ceil((east - west) / degreesPerCol) + 2 * padCols,
    rows: Math.ceil((north - south) / degreesPerRow) + 2 * padCols,
    west: west - padCols * degreesPerCol,
    north: north + padCols * degreesPerRow,
    degreesPerCol,
    degreesPerRow,
  };
}

function boundsOf(grid: Grid): Bounds {
  return {
    north: grid.north,
    west: grid.west,
    south: grid.north - grid.rows * grid.degreesPerRow,
    east: grid.west + grid.cols * grid.degreesPerCol,
  };
}

// Even-odd scanline fill: a cell is inside when its centre is between an odd and an even
// crossing of the polygon's rings. Taking every ring of a multipolygon together is what
// makes its inner rings cut holes rather than fill them.
function fill(mask: Uint8Array, grid: Grid, polygons: Polygon[]): number {
  const { cols, rows, west, north, degreesPerCol, degreesPerRow } = grid;
  const crossings: number[] = [];
  for (const polygon of polygons) {
    let lowRow = Number.POSITIVE_INFINITY;
    let highRow = Number.NEGATIVE_INFINITY;
    const rings = polygon.map((ring) => {
      const xs = new Float64Array(ring.length);
      const ys = new Float64Array(ring.length);
      for (let point = 0; point < ring.length; point++) {
        xs[point] = (ring[point].lng - west) / degreesPerCol;
        ys[point] = (north - ring[point].lat) / degreesPerRow;
        lowRow = Math.min(lowRow, ys[point]);
        highRow = Math.max(highRow, ys[point]);
      }
      return { xs, ys };
    });

    const firstRow = Math.max(0, Math.floor(lowRow));
    const lastRow = Math.min(rows - 1, Math.ceil(highRow));
    for (let row = firstRow; row <= lastRow; row++) {
      const line = row + 0.5;
      crossings.length = 0;
      for (const { xs, ys } of rings) {
        for (
          let point = 0, previous = xs.length - 1;
          point < xs.length;
          previous = point++
        ) {
          if (ys[point] > line !== ys[previous] > line) {
            crossings.push(
              xs[point] +
                ((line - ys[point]) / (ys[previous] - ys[point])) *
                  (xs[previous] - xs[point]),
            );
          }
        }
      }
      crossings.sort((left, right) => left - right);
      for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
        const from = Math.max(0, Math.ceil(crossings[pair] - 0.5));
        const to = Math.min(cols - 1, Math.floor(crossings[pair + 1] - 0.5));
        for (let col = from; col <= to; col++) {
          mask[row * cols + col] = 1;
        }
      }
    }
  }

  let filled = 0;
  for (const cell of mask) {
    filled += cell;
  }
  return filled;
}

// Separable Gaussian, zero-padded at the edges — O(cells * sigma) rather than the
// O(cells * sigma^2) a 2-D kernel would cost. The grid is padded by PAD_METERS, so the
// truncation at the edges never reaches the city.
function blur(
  values: Float32Array,
  grid: Grid,
  sigmaMeters: number,
): Float32Array {
  const { cols, rows } = grid;
  const sigma = sigmaMeters / CELL_METERS;
  const radius = Math.ceil(BLUR_RADII * sigma);
  const kernel = new Float64Array(radius * 2 + 1);
  let total = 0;
  for (let offset = -radius; offset <= radius; offset++) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + radius] = weight;
    total += weight;
  }
  for (let index = 0; index < kernel.length; index++) {
    kernel[index] /= total;
  }

  const scratch = new Float32Array(values.length);
  for (let row = 0; row < rows; row++) {
    const start = row * cols;
    for (let col = 0; col < cols; col++) {
      let sum = 0;
      const low = Math.max(-radius, -col);
      const high = Math.min(radius, cols - 1 - col);
      for (let offset = low; offset <= high; offset++) {
        sum += values[start + col + offset] * kernel[offset + radius];
      }
      scratch[start + col] = sum;
    }
  }
  const blurred = new Float32Array(values.length);
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      let sum = 0;
      const low = Math.max(-radius, -row);
      const high = Math.min(radius, rows - 1 - row);
      for (let offset = low; offset <= high; offset++) {
        sum += scratch[(row + offset) * cols + col] * kernel[offset + radius];
      }
      blurred[row * cols + col] = sum;
    }
  }
  return blurred;
}

function percentileOf(sorted: Float64Array, fraction: number): number {
  const last = sorted.length - 1;
  return sorted[Math.min(last, Math.max(0, Math.round(fraction * last)))];
}

function buildFields(
  grid: Grid,
  trees: Coord[],
  land: Polygon[],
  woodland: Polygon[],
): Fields {
  const { cols, rows, west, north, degreesPerCol, degreesPerRow } = grid;
  const cells = cols * rows;

  const counts = new Float32Array(cells);
  for (const { lat, lng } of trees) {
    const col = Math.floor((lng - west) / degreesPerCol);
    const row = Math.floor((north - lat) / degreesPerRow);
    if (col >= 0 && col < cols && row >= 0 && row < rows) {
      counts[row * cols + col] += 1;
    }
  }
  const broad = blur(counts, grid, BROAD_SIGMA_METERS);
  const tight = blur(counts, grid, TIGHT_SIGMA_METERS);

  const landMask = new Uint8Array(cells);
  const landCells = fill(landMask, grid, land);
  const woodlandMask = new Uint8Array(cells);
  fill(woodlandMask, grid, woodland);
  let woodlandCells = 0;
  const canopy = new Float32Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    const wooded = woodlandMask[cell] & landMask[cell];
    canopy[cell] = wooded;
    woodlandCells += wooded;
  }
  const feathered = blur(canopy, grid, WOODLAND_FEATHER_METERS);

  const onLand = new Float64Array(landCells);
  let index = 0;
  for (let cell = 0; cell < cells; cell++) {
    if (landMask[cell] === 1) {
      onLand[index] = broad[cell];
      index += 1;
    }
  }
  onLand.sort();
  const saturation = percentileOf(onLand, Number(SATURATION.slice(1)) / 100);
  // Both fields are divided by it, so a city with no trees under its land mask would come
  // out entirely NaN rather than empty.
  if (!(saturation > 0)) {
    throw new Error(
      `the ${SATURATION} of the broad field over ${landCells} land cells is ${saturation}: there is nothing to normalize against`,
    );
  }

  for (let cell = 0; cell < cells; cell++) {
    const floor =
      WOODLAND_FLOOR * Math.min(1, feathered[cell] / WOODLAND_PLATEAU);
    broad[cell] = Math.max(Math.min(1, broad[cell] / saturation), floor);
    tight[cell] = Math.max(Math.min(1, tight[cell] / saturation), floor);
  }
  return {
    grid,
    broad,
    tight,
    landMask,
    saturation,
    landCells,
    woodlandCells,
  };
}

function sample(values: Float32Array, grid: Grid, { lat, lng }: Coord): number {
  const { cols, rows, west, north, degreesPerCol, degreesPerRow } = grid;
  const x = Math.min(
    cols - 1.5,
    Math.max(0, (lng - west) / degreesPerCol - 0.5),
  );
  const y = Math.min(
    rows - 1.5,
    Math.max(0, (north - lat) / degreesPerRow - 0.5),
  );
  const col = Math.floor(x);
  const row = Math.floor(y);
  const alongCol = x - col;
  const alongRow = y - row;
  const top = row * cols + col;
  const bottom = top + cols;
  return (
    (values[top] * (1 - alongCol) + values[top + 1] * alongCol) *
      (1 - alongRow) +
    (values[bottom] * (1 - alongCol) + values[bottom + 1] * alongCol) * alongRow
  );
}

function distributionOf(values: Float64Array): Distribution {
  const sorted = values.slice().sort();
  let sum = 0;
  for (const value of sorted) {
    sum += value;
  }
  const percentiles = {} as Record<Percentile, number>;
  for (const percentile of PERCENTILES) {
    percentiles[percentile] = round(
      percentileOf(sorted, Number(percentile.slice(1)) / 100),
    );
  }
  return {
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
    median: round(percentileOf(sorted, 0.5)),
    percentiles,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function zigzag(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function writeVarint(bytes: Uint8Array, offset: number, value: number): number {
  let cursor = offset;
  let remaining = value;
  while (remaining >= 0x80) {
    bytes[cursor] = (remaining & 0x7f) | 0x80;
    remaining >>>= 7;
    cursor += 1;
  }
  bytes[cursor] = remaining;
  return cursor + 1;
}

// Binary layout of data/tree-cover/<id>.bin, little-endian throughout: the normalized
// broad field, one byte per cell, row-major from the grid's north-west corner. Cell
// (col, row) covers [west + col * degreesPerCol, +1) by [north - row * degreesPerRow, -1)
// and its centre is half a cell in from that corner.
//
//   header, FIELD_HEADER_BYTES
//     0   u8[4]  magic "TFLD"
//     4   u16    format version
//     6   u16    header bytes
//     8   u32    columns
//     12  u32    rows
//     16  f64    west, degrees
//     24  f64    north, degrees
//     32  f64    degrees per column
//     40  f64    degrees per row
//
//   cells, columns * rows bytes: the normalized density, 0 for none and 255 for the
//   saturation point the manifest records.
function encodeField(fields: Fields): Uint8Array {
  const { grid, broad } = fields;
  const bytes = new Uint8Array(FIELD_HEADER_BYTES + broad.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = "T".charCodeAt(0);
  bytes[1] = "F".charCodeAt(0);
  bytes[2] = "L".charCodeAt(0);
  bytes[3] = "D".charCodeAt(0);
  view.setUint16(4, FIELD_FORMAT, true);
  view.setUint16(6, FIELD_HEADER_BYTES, true);
  view.setUint32(8, grid.cols, true);
  view.setUint32(12, grid.rows, true);
  view.setFloat64(16, grid.west, true);
  view.setFloat64(24, grid.north, true);
  view.setFloat64(32, grid.degreesPerCol, true);
  view.setFloat64(40, grid.degreesPerRow, true);
  for (let cell = 0; cell < broad.length; cell++) {
    bytes[FIELD_HEADER_BYTES + cell] = Math.round(broad[cell] * 255);
  }
  return bytes;
}

// Binary layout of data/streets/<id>.bin, little-endian throughout:
//
//   header, STREET_HEADER_BYTES
//     0   u8[4]  magic "STRT"
//     4   u16    format version
//     6   u16    header bytes
//     8   u16    record bytes
//     10  u16    reserved
//     12  u32    segment count
//     16  f64    origin longitude, degrees
//     24  f64    origin latitude, degrees
//     32  f64    coordinate scale, degrees per quantized unit
//     40  u32    coordinate blob offset, from the start of the file
//     44  u32    coordinate blob length
//     48  u32    density blob offset, from the start of the file
//     52  u32    density blob length, one byte per vertex
//
//   segment records, one per segment, STREET_RECORD_BYTES each, starting at the header end
//     0   u32    physicalid (CSCL id; repeated if a row contributed several parts)
//     4   u32    offset of this segment's vertices within the coordinate blob
//     8   u16    vertex count, at least 2
//     10  u16    reserved
//     12  f32    geodesic length, metres
//     16  u32    index of this segment's first vertex within the density blob
//     20  u8     rw_type: 1 street, 5 boardwalk, 6 path, 7 step street, 10 alley
//     21  u8     street width, feet (0 unknown)
//     22  u8     posted speed, mph (0 unknown)
//     23  u8     reserved
//
//   coordinate blob
//     per segment, `vertex count` (longitude, latitude) pairs, each the zigzag LEB128
//     varint delta from the previous vertex — the first from the origin. Degrees are
//     origin + unit * scale, quantized to about 0.1 m.
//
//   density blob
//     the normalized tight field at each vertex, on the same 0..255 scale as the field
//     grid, in the same order as the coordinate blob.
function encodeStreets(segments: Segment[], densities: Uint8Array): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  let vertices = 0;
  for (const segment of segments) {
    vertices += segment.points.length;
    for (const { lat, lng } of segment.points) {
      originLng = Math.min(originLng, lng);
      originLat = Math.min(originLat, lat);
    }
  }

  const records = new Uint8Array(
    STREET_HEADER_BYTES + segments.length * STREET_RECORD_BYTES,
  );
  const view = new DataView(records.buffer);
  // Two varints of at most five bytes each per vertex.
  const blob = new Uint8Array(vertices * 10);
  let blobEnd = 0;
  let vertex = 0;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const start = blobEnd;
    let previousX = 0;
    let previousY = 0;
    for (const { lat, lng } of segment.points) {
      const quantizedX = Math.round((lng - originLng) / COORD_SCALE);
      const quantizedY = Math.round((lat - originLat) / COORD_SCALE);
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedX - previousX));
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedY - previousY));
      previousX = quantizedX;
      previousY = quantizedY;
    }

    const record = STREET_HEADER_BYTES + index * STREET_RECORD_BYTES;
    view.setUint32(record, segment.physicalId, true);
    view.setUint32(record + 4, start, true);
    view.setUint16(record + 8, segment.points.length, true);
    view.setFloat32(record + 12, segment.lengthMeters, true);
    view.setUint32(record + 16, vertex, true);
    records[record + 20] = segment.roadType;
    records[record + 21] = segment.streetWidth;
    records[record + 22] = segment.postedSpeed;
    vertex += segment.points.length;
  }

  records[0] = "S".charCodeAt(0);
  records[1] = "T".charCodeAt(0);
  records[2] = "R".charCodeAt(0);
  records[3] = "T".charCodeAt(0);
  view.setUint16(4, STREET_FORMAT, true);
  view.setUint16(6, STREET_HEADER_BYTES, true);
  view.setUint16(8, STREET_RECORD_BYTES, true);
  view.setUint32(12, segments.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  view.setUint32(40, records.length, true);
  view.setUint32(44, blobEnd, true);
  view.setUint32(48, records.length + blobEnd, true);
  view.setUint32(52, vertices, true);

  const encoded = new Uint8Array(records.length + blobEnd + vertices);
  encoded.set(records);
  encoded.set(blob.subarray(0, blobEnd), records.length);
  encoded.set(densities, records.length + blobEnd);
  return encoded;
}

const CITY = {
  id: "nyc",
  name: "New York City",
  attribution: "NYC Parks Forestry (ForMS) via NYC Open Data",
  sourceUrl: "https://data.cityofnewyork.us/d/hn5i-inap",
  streetAttribution: "NYC DoITT Street Centerline (CSCL) via NYC Open Data",
  streetSourceUrl: "https://data.cityofnewyork.us/d/inkn-q76z",
  woodlandAttribution: "OpenStreetMap contributors",
  woodlandSourceUrl: "https://www.openstreetmap.org/copyright",
} as const;

async function ingest(): Promise<void> {
  const started = performance.now();
  // The woodland is fetched first, and over the land polygons' own box: it is the only
  // source here that can be rate-limited away, everything outside the city is discarded
  // anyway, and there is no point spending five minutes on the trees to find out.
  console.error(`${CITY.id}: fetching borough boundaries`);
  const land = await fetchNycLand();
  const box = boxOf(land);
  console.error(`${CITY.id}: fetching woodland polygons`);
  const woodland = await fetchWoodland(
    box.south,
    box.west,
    box.north,
    box.east,
  );
  console.error(
    `${CITY.id}: ${woodland.polygons.length} woodland polygons (${woodland.ways} ways, ${woodland.relations} relations, ${woodland.unclosed} unclosed rings dropped)`,
  );

  console.error(`${CITY.id}: fetching street segments`);
  const segments = await fetchNycStreets();
  console.error(`${CITY.id}: fetching trees`);
  const trees = await fetchNycTrees();

  const grid = gridOf(segments, trees);
  const bounds = boundsOf(grid);
  console.error(
    `${CITY.id}: building a ${grid.cols}x${grid.rows} field at ${CELL_METERS} m from ${trees.length} trees`,
  );
  const fields = buildFields(grid, trees, land, woodland.polygons);
  const cellHectares = CELL_METERS ** 2 / SQUARE_METERS_PER_HECTARE;
  const saturationPerHectare = fields.saturation / cellHectares;
  console.error(
    `${CITY.id}: ${SATURATION} of the broad field over ${fields.landCells} land cells is ${fields.saturation.toFixed(3)} trees/cell (${saturationPerHectare.toFixed(1)} trees/ha)`,
  );
  console.error(
    `${CITY.id}: canopy mask covers ${fields.woodlandCells} cells (${((fields.woodlandCells * CELL_METERS ** 2) / 1e6).toFixed(1)} km2)`,
  );

  let vertices = 0;
  for (const segment of segments) {
    vertices += segment.points.length;
  }
  const densities = new Uint8Array(vertices);
  const streetDensities = new Float64Array(vertices);
  let vertex = 0;
  for (const segment of segments) {
    for (const point of segment.points) {
      const density = sample(fields.tight, grid, point);
      densities[vertex] = Math.round(density * 255);
      streetDensities[vertex] = density;
      vertex += 1;
    }
  }

  const landDensities = new Float64Array(fields.landCells);
  let index = 0;
  for (let cell = 0; cell < fields.landMask.length; cell++) {
    if (fields.landMask[cell] === 1) {
      landDensities[index] = fields.broad[cell];
      index += 1;
    }
  }

  const fieldBytes = encodeField(fields);
  const streetBytes = encodeStreets(segments, densities);
  await mkdir(FIELD_DIR, { recursive: true });
  await mkdir(STREET_DIR, { recursive: true });
  const file = `${CITY.id}.bin`;
  await writeFile(join(FIELD_DIR, file), fieldBytes);
  await writeFile(join(STREET_DIR, file), streetBytes);

  const updated = new Date().toISOString().slice(0, 10);
  const field: FieldLayer = {
    file,
    format: FIELD_FORMAT,
    cols: grid.cols,
    rows: grid.rows,
    bytes: fieldBytes.length,
    sha256: createHash("sha256").update(fieldBytes).digest("hex"),
    cellMeters: CELL_METERS,
    broadSigmaMeters: BROAD_SIGMA_METERS,
    tightSigmaMeters: TIGHT_SIGMA_METERS,
    saturationTreesPerHectare: round(saturationPerHectare),
    woodlandPolygons: woodland.polygons.length,
    woodlandSquareKm: round((fields.woodlandCells * CELL_METERS ** 2) / 1e6),
    woodlandFloor: WOODLAND_FLOOR,
    density: distributionOf(landDensities),
    updated,
    attribution: CITY.woodlandAttribution,
    sourceUrl: CITY.woodlandSourceUrl,
  };
  const streets: StreetLayer = {
    file,
    format: STREET_FORMAT,
    segments: segments.length,
    vertices,
    bytes: streetBytes.length,
    sha256: createHash("sha256").update(streetBytes).digest("hex"),
    densifyMeters: DENSIFY_METERS,
    density: distributionOf(streetDensities),
    updated,
    attribution: CITY.streetAttribution,
    sourceUrl: CITY.streetSourceUrl,
  };
  const entry: CityEntry = {
    id: CITY.id,
    name: CITY.name,
    bounds,
    trees: trees.length,
    updated,
    attribution: CITY.attribution,
    sourceUrl: CITY.sourceUrl,
    field,
    streets,
  };

  const manifest = await readManifest();
  const existing = manifest.cities.findIndex((other) => other.id === CITY.id);
  if (existing === -1) {
    manifest.cities.push(entry);
  } else {
    manifest.cities[existing] = entry;
  }
  await writeManifest(manifest);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `${CITY.id}: wrote tree-cover/${file} (${(fieldBytes.length / 1024 / 1024).toFixed(1)} MiB) and streets/${file} (${segments.length} segments, ${vertices} vertices, ${(streetBytes.length / 1024 / 1024).toFixed(1)} MiB) in ${seconds}s`,
  );
}

await ingest();
