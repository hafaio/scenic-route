// Usage:
//   bun run build-tiles
//
// Renders the tree-density field and the street network (data/tree-cover/<id>.bin and
// data/streets/<id>.bin, both tracked in Git LFS) into the two overlays the client
// draws: the field as raster tiles at public/tiles/tree-cover/{z}/{x}/{y}.png, and the
// streets as vector chunks at public/streets/{x}/{y}.bin, bucketed by z12 tile so the
// client can redraw them crisply at any zoom. Both are build output — gitignored,
// rebuilt by `bun dev` and `bun export` whenever the inputs change.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { PNG } from "pngjs";
import manifest from "../src/tree-cover/manifest.json";
import { rampAlpha, rampColor } from "../src/tree-cover/ramp";

type City = (typeof manifest.cities)[number];

// Deflating a few thousand PNGs is the bulk of the work and each tile is independent, so
// this file runs as its own worker: the main thread plans the tiles and hands each worker
// a contiguous slice of that plan by index. The plan is a pure function of the manifest,
// so a worker rebuilds the identical one rather than being shipped it.
interface Slice {
  from: number;
  to: number;
}

// The normalized density on a regular lat/lng grid, straight off disk: one byte per
// cell, whose centre sits half a cell in from its north-west corner.
interface Field {
  cells: Uint8Array;
  cols: number;
  rows: number;
  west: number;
  north: number;
  degreesPerCol: number;
  degreesPerRow: number;
}

interface Network {
  lngs: Float64Array; // every vertex of every segment, concatenated
  lats: Float64Array;
  densities: Uint8Array; // the tight field at each vertex, on the field's 0..255 scale
  starts: Uint32Array; // segments + 1 entries; segment i owns [starts[i], starts[i + 1])
  west: number;
  south: number;
  east: number;
  north: number;
}

interface Cursor {
  offset: number;
}

const DATA_DIR = join(import.meta.dirname, "..", "data");
const STREET_DIR = join(DATA_DIR, "streets");
const FIELD_DIR = join(DATA_DIR, "tree-cover");
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const TILE_DIR = join(PUBLIC_DIR, "tiles", "tree-cover");
const CHUNK_DIR = join(PUBLIC_DIR, "streets");
const STAMP_PATH = join(TILE_DIR, ".stamp");
const MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "manifest.json",
);
const RAMP_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "ramp.ts",
);

// data/<layer>/<id>.bin layouts, both documented in scripts/build-tree-data.ts
const STREET_FORMAT = 2;
const FIELD_FORMAT = 1;
const CHUNK_FORMAT = 2;
const CHUNK_HEADER_BYTES = 40;
const CHUNK_COORD_SCALE = 1e-6; // degrees per quantized unit, ~0.1 m
const CHUNK_ZOOM = 12;

const TILE_SIZE = 256;
const MIN_ZOOM = 9;
const MAX_ZOOM = 15;
// Below this the fill is invisible anyway, and a tile of it costs more than it says.
const MIN_ALPHA = 2;

function readVarint(bytes: Uint8Array, cursor: Cursor): number {
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

// Also the guard against an unresolved Git LFS pointer file, which is ~130 bytes of text
// and would otherwise decode into nonsense.
function checkMagic(
  bytes: Uint8Array,
  view: DataView,
  expected: string,
  format: number,
  path: string,
): void {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== expected || version !== format) {
    throw new Error(
      `${path} is not a v${format} "${expected}" file (magic "${magic}", version ${version})`,
    );
  }
}

function checkLength(
  bytes: Uint8Array,
  needed: number,
  what: string,
  path: string,
): void {
  if (bytes.byteLength < needed) {
    throw new Error(
      `${path} is truncated: ${bytes.byteLength} bytes, ${needed} needed for ${what}`,
    );
  }
}

async function readField(city: City): Promise<Field> {
  const path = join(FIELD_DIR, city.field.file);
  const bytes = new Uint8Array(await readFile(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  checkMagic(bytes, view, "TFLD", FIELD_FORMAT, path);

  const headerBytes = view.getUint16(6, true);
  const cols = view.getUint32(8, true);
  const rows = view.getUint32(12, true);
  // A subarray past the end clamps, so a short file would render as transparent pixels
  // rather than as an error.
  checkLength(
    bytes,
    headerBytes + cols * rows,
    `a ${cols}x${rows} field`,
    path,
  );
  return {
    cells: bytes.subarray(headerBytes, headerBytes + cols * rows),
    cols,
    rows,
    west: view.getFloat64(16, true),
    north: view.getFloat64(24, true),
    degreesPerCol: view.getFloat64(32, true),
    degreesPerRow: view.getFloat64(40, true),
  };
}

async function readNetwork(city: City): Promise<Network> {
  const path = join(STREET_DIR, city.streets.file);
  const bytes = new Uint8Array(await readFile(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  checkMagic(bytes, view, "STRT", STREET_FORMAT, path);

  const headerBytes = view.getUint16(6, true);
  const recordBytes = view.getUint16(8, true);
  const count = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const coordOffset = view.getUint32(40, true);
  const densityOffset = view.getUint32(48, true);
  const vertices = view.getUint32(52, true);
  // The density blob is last, so this covers the records and the coordinates before it.
  checkLength(bytes, densityOffset + vertices, `${count} segments`, path);

  const lngs = new Float64Array(vertices);
  const lats = new Float64Array(vertices);
  const starts = new Uint32Array(count + 1);
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  let vertex = 0;
  for (let segment = 0; segment < count; segment++) {
    const record = headerBytes + segment * recordBytes;
    const cursor: Cursor = {
      offset: coordOffset + view.getUint32(record + 4, true),
    };
    const length = view.getUint16(record + 8, true);
    starts[segment] = vertex;

    let quantizedX = 0;
    let quantizedY = 0;
    for (let index = 0; index < length; index++) {
      quantizedX += readVarint(bytes, cursor);
      quantizedY += readVarint(bytes, cursor);
      const lng = originLng + quantizedX * scale;
      const lat = originLat + quantizedY * scale;
      lngs[vertex] = lng;
      lats[vertex] = lat;
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      vertex += 1;
    }
  }
  starts[count] = vertex;
  return {
    lngs,
    lats,
    densities: bytes.subarray(densityOffset, densityOffset + vertices),
    starts,
    west,
    south,
    east,
    north,
  };
}

function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

function lngToPixelX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * worldSize(zoom);
}

function latToPixelY(lat: number, zoom: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  return (
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize(zoom)
  );
}

function pixelXToLng(pixelX: number, zoom: number): number {
  return (pixelX / worldSize(zoom)) * 360 - 180;
}

function pixelYToLat(pixelY: number, zoom: number): number {
  const mercator = Math.PI * (1 - (2 * pixelY) / worldSize(zoom));
  return (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
}

function tileIndex(pixel: number, zoom: number): number {
  return Math.min(2 ** zoom - 1, Math.max(0, Math.floor(pixel / TILE_SIZE)));
}

// RGBA for every density the field can hold, so the per-pixel loop is a lookup rather
// than a ramp evaluation. The field is already normalized, so a byte of it indexes this
// table directly.
function buildRamp(): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256 * 4);
  for (let step = 0; step < 256; step++) {
    const density = step / 255;
    const { red, green, blue } = rampColor(density);
    const offset = step * 4;
    table[offset] = red;
    table[offset + 1] = green;
    table[offset + 2] = blue;
    table[offset + 3] = 255 * rampAlpha(density);
  }
  return table;
}

// Grid columns are linear in longitude and rows linear in latitude, but Mercator y is
// not linear in latitude, so every tile row needs its own unprojection. The field is
// then sampled bilinearly, which is what keeps the fill smooth instead of blocky — at
// z15 a 20 m cell is about 7 px across, so nearest-neighbour would show the grid.
function paint(
  pixels: Uint8ClampedArray,
  field: Field,
  ramp: Uint8ClampedArray,
  zoom: number,
  tileX: number,
  tileY: number,
): boolean {
  const { cells, cols, rows } = field;
  const originX = tileX * TILE_SIZE;
  const originY = tileY * TILE_SIZE;

  const columns = new Float64Array(TILE_SIZE);
  for (let x = 0; x < TILE_SIZE; x++) {
    const lng = pixelXToLng(originX + x + 0.5, zoom);
    columns[x] = (lng - field.west) / field.degreesPerCol - 0.5;
  }
  const lines = new Float64Array(TILE_SIZE);
  for (let y = 0; y < TILE_SIZE; y++) {
    const lat = pixelYToLat(originY + y + 0.5, zoom);
    lines[y] = (field.north - lat) / field.degreesPerRow - 0.5;
  }

  let painted = false;
  for (let y = 0; y < TILE_SIZE; y++) {
    const rowFloor = Math.floor(lines[y]);
    if (rowFloor < 0 || rowFloor >= rows) {
      continue;
    }
    const alongRow = lines[y] - rowFloor;
    const topRow = rowFloor * cols;
    // The last row and column have nothing beyond them to interpolate towards, so they
    // stand in for themselves rather than the cell being skipped.
    const bottomRow = rowFloor + 1 < rows ? topRow + cols : topRow;

    for (let x = 0; x < TILE_SIZE; x++) {
      const colFloor = Math.floor(columns[x]);
      if (colFloor < 0 || colFloor >= cols) {
        continue;
      }
      const alongCol = columns[x] - colFloor;
      const nextCol = colFloor + 1 < cols ? colFloor + 1 : colFloor;
      const top =
        cells[topRow + colFloor] * (1 - alongCol) +
        cells[topRow + nextCol] * alongCol;
      const bottom =
        cells[bottomRow + colFloor] * (1 - alongCol) +
        cells[bottomRow + nextCol] * alongCol;

      const stop = Math.round(top * (1 - alongRow) + bottom * alongRow) * 4;
      if (ramp[stop + 3] < MIN_ALPHA) {
        continue;
      }
      const pixel = (y * TILE_SIZE + x) * 4;
      pixels[pixel] = ramp[stop];
      pixels[pixel + 1] = ramp[stop + 1];
      pixels[pixel + 2] = ramp[stop + 2];
      pixels[pixel + 3] = ramp[stop + 3];
      painted = true;
    }
  }
  return painted;
}

function encodePng(pixels: Uint8ClampedArray): Buffer {
  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  png.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  return PNG.sync.write(png, { deflateLevel: 9 });
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

// Binary layout of public/streets/{x}/{y}.bin — the segments touching one z12 tile,
// little-endian throughout, decoded by components/street-score-layer.tsx:
//
//   header, CHUNK_HEADER_BYTES
//     0   u8[4]  magic "STCK"
//     4   u16    format version
//     6   u16    header bytes
//     8   u32    segment count
//     12  u32    reserved
//     16  f64    origin longitude, degrees
//     24  f64    origin latitude, degrees
//     32  f64    coordinate scale, degrees per quantized unit
//
//   segments, one after another, `segment count` of them
//     u16    vertex count, at least 2
//     then `vertex count` (longitude, latitude) pairs, each the zigzag LEB128 varint
//     delta from the previous vertex — the first from the origin. Degrees are
//     origin + unit * scale, quantized to about 0.1 m.
//     then `vertex count` bytes, the normalized tree density at each of those vertices,
//     so the line is drawn as a gradient rather than as one flat colour.
function encodeChunk(
  network: Network,
  members: number[],
  originLng: number,
  originLat: number,
): Uint8Array {
  const { lngs, lats, densities, starts } = network;
  let vertices = 0;
  for (const segment of members) {
    vertices += starts[segment + 1] - starts[segment];
  }
  // Two bytes of vertex count per segment, then per vertex two varints of at most five
  // bytes and one density byte.
  const bytes = new Uint8Array(
    CHUNK_HEADER_BYTES + members.length * 2 + vertices * 11,
  );
  const view = new DataView(bytes.buffer);

  let offset = CHUNK_HEADER_BYTES;
  for (const segment of members) {
    const from = starts[segment];
    const to = starts[segment + 1];
    view.setUint16(offset, to - from, true);
    offset += 2;
    let previousX = 0;
    let previousY = 0;
    for (let vertex = from; vertex < to; vertex++) {
      const quantizedX = Math.round(
        (lngs[vertex] - originLng) / CHUNK_COORD_SCALE,
      );
      const quantizedY = Math.round(
        (lats[vertex] - originLat) / CHUNK_COORD_SCALE,
      );
      offset = writeVarint(bytes, offset, zigzag(quantizedX - previousX));
      offset = writeVarint(bytes, offset, zigzag(quantizedY - previousY));
      previousX = quantizedX;
      previousY = quantizedY;
    }
    bytes.set(densities.subarray(from, to), offset);
    offset += to - from;
  }

  bytes[0] = "S".charCodeAt(0);
  bytes[1] = "T".charCodeAt(0);
  bytes[2] = "C".charCodeAt(0);
  bytes[3] = "K".charCodeAt(0);
  view.setUint16(4, CHUNK_FORMAT, true);
  view.setUint16(6, CHUNK_HEADER_BYTES, true);
  view.setUint32(8, members.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, CHUNK_COORD_SCALE, true);
  return bytes.subarray(0, offset);
}

// A segment goes into every z12 tile its bounding box touches; segments are short, so the
// few it lands in beyond the ones it truly crosses cost nothing and cannot leave a gap at
// a tile seam. The chunk's origin is its tile's north-west corner, which keeps the first
// delta of each segment small.
async function writeChunks(network: Network): Promise<[number, number]> {
  const { starts, lngs, lats } = network;
  const segments = starts.length - 1;
  const buckets = new Map<string, number[]>();
  for (let segment = 0; segment < segments; segment++) {
    let west = Number.POSITIVE_INFINITY;
    let south = Number.POSITIVE_INFINITY;
    let east = Number.NEGATIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;
    for (let vertex = starts[segment]; vertex < starts[segment + 1]; vertex++) {
      west = Math.min(west, lngs[vertex]);
      east = Math.max(east, lngs[vertex]);
      south = Math.min(south, lats[vertex]);
      north = Math.max(north, lats[vertex]);
    }
    const minX = tileIndex(lngToPixelX(west, CHUNK_ZOOM), CHUNK_ZOOM);
    const maxX = tileIndex(lngToPixelX(east, CHUNK_ZOOM), CHUNK_ZOOM);
    const minY = tileIndex(latToPixelY(north, CHUNK_ZOOM), CHUNK_ZOOM);
    const maxY = tileIndex(latToPixelY(south, CHUNK_ZOOM), CHUNK_ZOOM);
    for (let tileX = minX; tileX <= maxX; tileX++) {
      for (let tileY = minY; tileY <= maxY; tileY++) {
        const key = `${tileX}/${tileY}`;
        const existing = buckets.get(key);
        if (existing) {
          existing.push(segment);
        } else {
          buckets.set(key, [segment]);
        }
      }
    }
  }

  let bytes = 0;
  for (const [key, members] of buckets) {
    const [tileX, tileY] = key.split("/").map(Number);
    const originLng = pixelXToLng(tileX * TILE_SIZE, CHUNK_ZOOM);
    const originLat = pixelYToLat(tileY * TILE_SIZE, CHUNK_ZOOM);
    const encoded = encodeChunk(network, members, originLng, originLat);
    const path = join(CHUNK_DIR, `${key}.bin`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, encoded);
    bytes += encoded.length;
  }
  return [buckets.size, bytes];
}

async function newestInputMtime(cities: City[]): Promise<number> {
  const paths = [
    MANIFEST_PATH,
    RAMP_PATH,
    import.meta.filename,
    ...cities.flatMap((city) => [
      join(STREET_DIR, city.streets.file),
      join(FIELD_DIR, city.field.file),
    ]),
  ];
  const stats = await Promise.all(paths.map((path) => stat(path)));
  return Math.max(...stats.map((entry) => entry.mtimeMs));
}

async function isFresh(cities: City[]): Promise<boolean> {
  try {
    const stamp = await stat(STAMP_PATH);
    await stat(CHUNK_DIR);
    return stamp.mtimeMs >= (await newestInputMtime(cities));
  } catch {
    return false;
  }
}

// Cities can share a tile at low zoom, so tiles are keyed globally and every city
// touching one paints into the same buffer rather than overwriting it.
function planTiles(fields: Map<string, Field>): Map<string, Field[]> {
  const plan = new Map<string, Field[]>();
  for (const field of fields.values()) {
    const west = field.west;
    const north = field.north;
    const east = west + field.cols * field.degreesPerCol;
    const south = north - field.rows * field.degreesPerRow;
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom++) {
      const minX = tileIndex(lngToPixelX(west, zoom), zoom);
      const maxX = tileIndex(lngToPixelX(east, zoom), zoom);
      const minY = tileIndex(latToPixelY(north, zoom), zoom);
      const maxY = tileIndex(latToPixelY(south, zoom), zoom);
      for (let tileX = minX; tileX <= maxX; tileX++) {
        for (let tileY = minY; tileY <= maxY; tileY++) {
          const key = `${zoom}/${tileX}/${tileY}`;
          const existing = plan.get(key);
          if (existing) {
            existing.push(field);
          } else {
            plan.set(key, [field]);
          }
        }
      }
    }
  }
  return plan;
}

async function readFields(cities: City[]): Promise<Map<string, Field>> {
  const fields = new Map<string, Field>();
  for (const city of cities) {
    fields.set(city.id, await readField(city));
  }
  return fields;
}

// One worker's share of the plan: it rebuilds the whole tile list and renders the slice
// the main thread gave it. Directories are made as they are first needed — a recursive
// mkdir is idempotent, so two workers meeting at a tile-row directory is not a race.
async function render({ from, to }: Slice): Promise<number> {
  const plan = planTiles(await readFields(manifest.cities));
  const ramp = buildRamp();
  const pixels = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  const blank = encodePng(new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4));
  const directories = new Set<string>();
  let tileBytes = 0;

  const tiles = [...plan.entries()].slice(from, to);
  for (const [key, tileFields] of tiles) {
    const [zoom, tileX, tileY] = key.split("/").map(Number);
    pixels.fill(0);
    let painted = false;
    for (const field of tileFields) {
      painted = paint(pixels, field, ramp, zoom, tileX, tileY) || painted;
    }

    const png = painted ? encodePng(pixels) : blank;
    const path = join(TILE_DIR, `${key}.png`);
    const directory = dirname(path);
    if (!directories.has(directory)) {
      await mkdir(directory, { recursive: true });
      directories.add(directory);
    }
    await writeFile(path, png);
    tileBytes += png.length;
  }
  return tileBytes;
}

function spawn(slice: Slice): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(import.meta.filename, { workerData: slice });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`tile worker exited with ${code}`));
      }
    });
  });
}

async function build(): Promise<void> {
  const cities: City[] = manifest.cities;
  if (await isFresh(cities)) {
    console.error("street overlays are up to date");
    return;
  }

  const started = performance.now();
  await rm(TILE_DIR, { recursive: true, force: true });
  await rm(CHUNK_DIR, { recursive: true, force: true });
  await mkdir(TILE_DIR, { recursive: true });

  const fields = await readFields(cities);
  let chunks = 0;
  let chunkBytes = 0;
  for (const city of cities) {
    const field = fields.get(city.id) as Field;
    const network = await readNetwork(city);
    console.error(
      `${city.id}: ${field.cols}x${field.rows} field, ${network.starts.length - 1} segments, ramp saturates at ${city.field.saturationTreesPerHectare} trees/ha`,
    );
    const [cityChunks, cityChunkBytes] = await writeChunks(network);
    chunks += cityChunks;
    chunkBytes += cityChunkBytes;
  }

  // Contiguous slices, so the tiles a worker takes share their directories and their
  // corner of the field rather than scattering across the city.
  const tiles = planTiles(fields).size;
  const workers = Math.max(1, Math.min(availableParallelism(), tiles));
  const perWorker = Math.ceil(tiles / workers);
  const slices: Slice[] = [];
  for (let from = 0; from < tiles; from += perWorker) {
    slices.push({ from, to: Math.min(tiles, from + perWorker) });
  }
  console.error(`rendering ${tiles} tiles across ${slices.length} workers`);
  const rendered = await Promise.all(slices.map(spawn));
  const tileBytes = rendered.reduce((total, bytes) => total + bytes, 0);

  await writeFile(STAMP_PATH, "");
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `wrote ${tiles} tiles (z${MIN_ZOOM}-z${MAX_ZOOM}, ${(tileBytes / 1024 / 1024).toFixed(1)} MiB) and ${chunks} street chunks (z${CHUNK_ZOOM}, ${(chunkBytes / 1024 / 1024).toFixed(1)} MiB) in ${seconds}s`,
  );
}

if (isMainThread) {
  await build();
} else {
  parentPort?.postMessage(await render(workerData as Slice));
}
