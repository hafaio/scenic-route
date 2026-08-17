// The encoders the tree-cover ingest writes its .bin sources with: the varint coordinate codec
// and the two source layouts built on it. Only the ingest needs them — crates/tiler reads these
// files back, and the model math lives there. Layouts are documented in scripts/README.md.
//
// The network layout (STRT, PATH, SWLK) carries a decoder beside its encoder, which nothing in the
// pipeline calls: the format test reads a hand-written fixture with it, so a mistake mirrored into
// an encoder/decoder pair cannot pass by round-tripping (DESIGN.md, "Repository traps").

import type { Bounds } from "./manifest";
import type { Polygon } from "./overpass";
import type { Coord } from "./socrata";

export const HEADER_BYTES = 40;
export const COORD_SCALE = 1e-6; // degrees per quantized unit, ~0.1 m

export const EARTH_RADIUS_METERS = 6_371_008.8;

// Great-circle distance in metres. Used where a source dedups or clips by a real ground radius.
export function haversineMeters(from: Coord, to: Coord): number {
  const fromLat = from.lat * (Math.PI / 180);
  const toLat = to.lat * (Math.PI / 180);
  const deltaLat = toLat - fromLat;
  const deltaLng = (to.lng - from.lng) * (Math.PI / 180);
  const chord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

export function zigzag(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

export function writeVarint(
  bytes: Uint8Array,
  offset: number,
  value: number,
): number {
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

export function boxOf(polygons: readonly Polygon[]): Bounds {
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

function writeHeader(
  bytes: Uint8Array,
  view: DataView,
  magic: string,
  format: number,
  count: number,
  originLng: number,
  originLat: number,
): void {
  for (let index = 0; index < 4; index++) {
    bytes[index] = magic.charCodeAt(index);
  }
  view.setUint16(4, format, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, count, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
}

// A tree, with the crown disc already sized from its dbh: the genus overlay draws each tree at
// this crown size, so it travels with the point through the encoder. `genusId` is the top-11
// genus id 0..10, or 11 ("Other") for a tail genus, an unknown genus, or an OSM tree.
export interface CrownedTree extends Coord {
  crownRadiusM: number;
  genusId: number;
}

export const DECIMETERS_PER_METER = 10; // the crown byte's unit: a decimetre of crown radius

// Every point carries a crown-radius byte and a genus byte, each written as a fixed-size trailing
// region after the coordinate stream and in the very same sorted order, so byte i sizes/labels
// point i. The points are sorted by quantized (lat, lng), so a delta carries a step along a row
// rather than a jump across the city and the whole inventory fits in about five bytes a tree.
// Crown and genus ride through the sort with each point, so the two blocks stay parallel. TREE v3.
// layout: scripts/README.md
export function encodeTrees(
  format: number,
  trees: readonly CrownedTree[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  for (const { lat, lng } of trees) {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  }

  const quantized = trees
    .map(({ lat, lng, crownRadiusM, genusId }) => ({
      x: Math.round((lng - originLng) / COORD_SCALE),
      y: Math.round((lat - originLat) / COORD_SCALE),
      // Clamped into the byte: a decimetre of radius, 0..25.5 m, which the allometry never
      // approaches even at the largest trunk the ingest keeps.
      crown: Math.min(
        255,
        Math.max(0, Math.round(crownRadiusM * DECIMETERS_PER_METER)),
      ),
      genusId, // 0..12, one byte
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  // Two varints of at most five bytes each per point, then one crown byte and one genus byte each.
  const bytes = new Uint8Array(HEADER_BYTES + trees.length * 12);
  const view = new DataView(bytes.buffer);
  let offset = HEADER_BYTES;
  let previousX = 0;
  let previousY = 0;
  for (const { x, y } of quantized) {
    offset = writeVarint(bytes, offset, zigzag(x - previousX));
    offset = writeVarint(bytes, offset, zigzag(y - previousY));
    previousX = x;
    previousY = y;
  }
  for (const { crown } of quantized) {
    bytes[offset] = crown;
    offset += 1;
  }
  for (const { genusId } of quantized) {
    bytes[offset] = genusId;
    offset += 1;
  }
  writeHeader(bytes, view, "TREE", format, trees.length, originLng, originLat);
  return bytes.subarray(0, offset);
}

// A point carrying a small class byte: e.g. a land-use lot at its coordinate, tagged with its
// PLUTO land-use digit. The class rides through the sort with each point, so byte i classes point i.
export interface ClassifiedPoint extends Coord {
  klass: number; // 0..255, the per-point class the trailing byte stores
}

// A classified point set (e.g. magic `PLUT`): the header, then the coordinate stream as zigzag-varint
// (x, y) deltas in (y, x)-sorted order, then ONE trailing class byte per point in that same sorted
// order — mirroring how encodeTrees keeps its crown and genus regions parallel to the coordinates.
// The header count is the number of points. layout: scripts/README.md
export function encodeClassifiedPoints(
  magic: string,
  format: number,
  points: readonly ClassifiedPoint[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  for (const { lat, lng } of points) {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  }

  const quantized = points
    .map(({ lat, lng, klass }) => ({
      x: Math.round((lng - originLng) / COORD_SCALE),
      y: Math.round((lat - originLat) / COORD_SCALE),
      klass,
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  // Two varints of at most five bytes each per point, then one class byte each.
  const bytes = new Uint8Array(HEADER_BYTES + points.length * 11);
  const view = new DataView(bytes.buffer);
  let offset = HEADER_BYTES;
  let previousX = 0;
  let previousY = 0;
  for (const { x, y } of quantized) {
    offset = writeVarint(bytes, offset, zigzag(x - previousX));
    offset = writeVarint(bytes, offset, zigzag(y - previousY));
    previousX = x;
    previousY = y;
  }
  for (const { klass } of quantized) {
    bytes[offset] = klass;
    offset += 1;
  }
  writeHeader(bytes, view, magic, format, points.length, originLng, originLat);
  return bytes.subarray(0, offset);
}

// A named point: a POI's coordinate and the label the client draws (empty when the source names none).
export interface NamedPoint extends Coord {
  name?: string;
}

// A point set with per-point names: the header, then the coordinate stream as zigzag-varint (x, y)
// deltas in (y, x)-sorted order, then a trailing name blob — per point (in that same sorted order) a
// u16 UTF-8 byte length and its bytes. The name blob is client-only (the overlay labels read it); the
// Rust reader reads only `count` points from the header and ignores it, so the graph bake is
// unaffected. The scenic-factor ingests (landmarks, public art) write their POIs with this.
// layout: scripts/README.md
export function encodePoints(
  magic: string,
  format: number,
  points: readonly NamedPoint[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  for (const { lat, lng } of points) {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  }

  const encoder = new TextEncoder();
  const quantized = points
    .map(({ lat, lng, name }) => ({
      x: Math.round((lng - originLng) / COORD_SCALE),
      y: Math.round((lat - originLat) / COORD_SCALE),
      name: encoder.encode(name ?? ""),
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  // Two varints of at most five bytes each per point.
  const pointBytes = new Uint8Array(HEADER_BYTES + points.length * 10);
  const view = new DataView(pointBytes.buffer);
  let offset = HEADER_BYTES;
  let previousX = 0;
  let previousY = 0;
  for (const { x, y } of quantized) {
    offset = writeVarint(pointBytes, offset, zigzag(x - previousX));
    offset = writeVarint(pointBytes, offset, zigzag(y - previousY));
    previousX = x;
    previousY = y;
  }
  writeHeader(
    pointBytes,
    view,
    magic,
    format,
    points.length,
    originLng,
    originLat,
  );

  let nameBlobLength = 0;
  for (const { name } of quantized) {
    nameBlobLength += 2 + name.length;
  }
  const nameBlob = new Uint8Array(nameBlobLength);
  const nameView = new DataView(nameBlob.buffer);
  let nameCursor = 0;
  for (const { name } of quantized) {
    nameView.setUint16(nameCursor, name.length, true);
    nameCursor += 2;
    nameBlob.set(name, nameCursor);
    nameCursor += name.length;
  }

  const out = new Uint8Array(offset + nameBlobLength);
  out.set(pointBytes.subarray(0, offset));
  out.set(nameBlob, offset);
  return out;
}

// layout: scripts/README.md
export function encodePolygons(
  magic: string,
  format: number,
  polygons: readonly Polygon[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  let vertices = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      vertices += ring.length;
      for (const { lat, lng } of ring) {
        originLng = Math.min(originLng, lng);
        originLat = Math.min(originLat, lat);
      }
    }
  }

  // Two varints of at most five bytes per vertex, four bytes of count per ring, two per
  // polygon.
  const bytes = new Uint8Array(
    HEADER_BYTES + polygons.length * 2 + vertices * 14,
  );
  const view = new DataView(bytes.buffer);
  let offset = HEADER_BYTES;
  for (const polygon of polygons) {
    view.setUint16(offset, polygon.length, true);
    offset += 2;
    for (const ring of polygon) {
      view.setUint32(offset, ring.length, true);
      offset += 4;
      let previousX = 0;
      let previousY = 0;
      for (const { lat, lng } of ring) {
        const x = Math.round((lng - originLng) / COORD_SCALE);
        const y = Math.round((lat - originLat) / COORD_SCALE);
        offset = writeVarint(bytes, offset, zigzag(x - previousX));
        offset = writeVarint(bytes, offset, zigzag(y - previousY));
        previousX = x;
        previousY = y;
      }
    }
  }
  writeHeader(
    bytes,
    view,
    magic,
    format,
    polygons.length,
    originLng,
    originLat,
  );
  return bytes.subarray(0, offset);
}

// The measured canopy polygons, magic `CNPY`: the encodePolygons body, then ONE trailing region of
// one u16 little-endian per polygon in the same polygon order — the crown height in decimetres, as
// BLDG carries its roof heights. The ingest writes the region zeroed and the height pass samples
// the LiDAR height model into it in place, the way the density pass fills the street density blob;
// a polygon the model saw no cell for keeps the 0, which reads as unknown. layout: scripts/README.md
export function encodeCanopy(
  format: number,
  polygons: readonly Polygon[],
): Uint8Array {
  const body = encodePolygons("CNPY", format, polygons);
  const out = new Uint8Array(body.length + polygons.length * 2);
  out.set(body);
  return out;
}

// A building footprint carrying the roof height the shade model raises the wall to, plus the ground
// elevation its base sits at (for terrain-aware shade). Both ride through the encoder parallel to
// the polygon: a MultiPolygon with disjoint parts becomes several entries, each repeating that
// building's height and base elevation.
export interface HeightedBuilding {
  polygon: Polygon;
  heightMeters: number;
  baseElevationMeters: number;
}

// The metres of positive bias added to a base elevation before it is quantized, so the harbour's
// slightly-negative ground (min ~ -3 m) survives the unsigned u16 store. A reader recovers the true
// elevation as `decimetres / 10 - ELEVATION_BIAS_METERS`.
export const ELEVATION_BIAS_METERS = 100;

// The building footprints, magic `BLDG`: the encodePolygons body (a header, then per-polygon
// varint-delta rings), then TWO parallel trailing regions of one u16 little-endian per polygon, in
// the same polygon order and mirroring how encodeTrees keeps its crown and genus regions parallel:
// first the roof height in decimetres, then the base (ground) elevation in decimetres biased by
// +ELEVATION_BIAS_METERS so a below-sea-level base stays non-negative. The header count is the
// number of polygons. layout: scripts/README.md
export function encodeBuildings(
  format: number,
  buildings: readonly HeightedBuilding[],
): Uint8Array {
  const polygons = buildings.map((building) => building.polygon);
  const body = encodePolygons("BLDG", format, polygons);
  const trailing = new Uint8Array(buildings.length * 4);
  const trailingView = new DataView(trailing.buffer);
  for (let index = 0; index < buildings.length; index++) {
    const heightDecimetres = Math.round(
      buildings[index].heightMeters * DECIMETERS_PER_METER,
    );
    trailingView.setUint16(
      index * 2,
      Math.min(65535, Math.max(0, heightDecimetres)),
      true,
    );
  }
  const baseOffset = buildings.length * 2;
  for (let index = 0; index < buildings.length; index++) {
    const biasedDecimetres = Math.round(
      (buildings[index].baseElevationMeters + ELEVATION_BIAS_METERS) *
        DECIMETERS_PER_METER,
    );
    trailingView.setUint16(
      baseOffset + index * 2,
      Math.min(65535, Math.max(0, biasedDecimetres)),
      true,
    );
  }
  const out = new Uint8Array(body.length + trailing.length);
  out.set(body);
  out.set(trailing, body.length);
  return out;
}

export const NETWORK_HEADER_BYTES = 64;
export const NETWORK_RECORD_BYTES = 24;
export const NETWORK_SIDES = 2; // the density blob carries both sidewalks of every vertex, left then right
export const UNNAMED_ID = 0xffff; // a record's name id when its source carried no label

// Splits every piece longer than `stepMeters`, so the field is sampled often enough along a line
// for its colour to vary rather than come out in one flat block. Returns the geodesic length too:
// it is what the network record stores, and the graph sums those rather than recomputing.
export function densify(
  points: readonly Coord[],
  stepMeters: number,
): { points: Coord[]; lengthMeters: number } {
  const dense: Coord[] = [points[0]];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const meters = haversineMeters(from, to);
    total += meters;
    const steps = Math.max(1, Math.ceil(meters / stepMeters));
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

// Anything the encoder names: a street segment, a path way, a sidewalk way. Its `nameId` is
// stamped in place by buildNameTable from its (already trimmed and, for OSM ways, uppercased) name.
export interface Named {
  name: string;
  nameId: number;
}

// Collects the distinct names, sorts them, and stamps each record with its index into that
// sorted table; a record with no label keeps UNNAMED_ID. Returns the table, which the encoder
// writes once as the trailing name blob. Each network builds its own.
export function buildNameTable(records: readonly Named[]): string[] {
  const distinct = new Set<string>();
  for (const record of records) {
    if (record.name) {
      distinct.add(record.name);
    }
  }
  const names = [...distinct].sort();
  const idOf = new Map(names.map((name, index) => [name, index]));
  for (const record of records) {
    record.nameId = record.name
      ? (idOf.get(record.name) ?? UNNAMED_ID)
      : UNNAMED_ID;
  }
  return names;
}

// One record of any of the three committed networks, mapped to the shared byte layout: the id at
// offset 0, the kind at 20, and the width/speed/flags bytes. STRT fills all three; PATH and SWLK
// leave width and speed 0.
export interface NetworkRecord {
  id: number; // record offset 0 (u32): CSCL physicalid, or an OSM way id
  nameId: number; // record offset 10
  lengthMeters: number; // record offset 12 (f32)
  kind: number; // record byte 20: rw_type, or the PATH / SWLK kind
  width: number; // record byte 21
  speed: number; // record byte 22
  flags: number; // record byte 23
  points: Coord[];
}

// The one encoder all three networks share: STRT's layout, parameterized by magic and format. The
// density blob is written zeroed — two bytes a vertex, one sidewalk each — and filled in place by
// the density pass for STRT and PATH, so the coordinates it offsets the sidewalks from are the
// ones that ship rather than a parallel copy. SWLK's stays zeroed and no pass fills it: a mapped
// sidewalk takes the cover byte of the street side it was matched to. layout: scripts/README.md
export function encodeNetwork(
  magic: string,
  format: number,
  records: readonly NetworkRecord[],
  names: readonly string[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  let vertices = 0;
  for (const record of records) {
    vertices += record.points.length;
    for (const { lat, lng } of record.points) {
      originLng = Math.min(originLng, lng);
      originLat = Math.min(originLat, lat);
    }
  }

  const table = new Uint8Array(
    NETWORK_HEADER_BYTES + records.length * NETWORK_RECORD_BYTES,
  );
  const view = new DataView(table.buffer);
  // Two varints of at most five bytes each per vertex.
  const blob = new Uint8Array(vertices * 10);
  let blobEnd = 0;
  let vertex = 0;

  for (let index = 0; index < records.length; index++) {
    const entry = records[index];
    const start = blobEnd;
    let previousX = 0;
    let previousY = 0;
    for (const { lat, lng } of entry.points) {
      const quantizedX = Math.round((lng - originLng) / COORD_SCALE);
      const quantizedY = Math.round((lat - originLat) / COORD_SCALE);
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedX - previousX));
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedY - previousY));
      previousX = quantizedX;
      previousY = quantizedY;
    }

    const record = NETWORK_HEADER_BYTES + index * NETWORK_RECORD_BYTES;
    view.setUint32(record, entry.id, true);
    view.setUint32(record + 4, start, true);
    view.setUint16(record + 8, entry.points.length, true);
    view.setUint16(record + 10, entry.nameId, true);
    view.setFloat32(record + 12, entry.lengthMeters, true);
    view.setUint32(record + 16, vertex, true);
    table[record + 20] = entry.kind;
    table[record + 21] = entry.width;
    table[record + 22] = entry.speed;
    table[record + 23] = entry.flags;
    vertex += entry.points.length;
  }

  for (let index = 0; index < 4; index++) {
    table[index] = magic.charCodeAt(index);
  }
  view.setUint16(4, format, true);
  view.setUint16(6, NETWORK_HEADER_BYTES, true);
  view.setUint16(8, NETWORK_RECORD_BYTES, true);
  view.setUint32(12, records.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  // The name blob is the file's final region: a u32 count, then each name as a u16 byte length
  // and its UTF-8 bytes, back to back. Read once, sequentially, by the one Rust reader.
  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  let nameBlobLength = 4;
  for (const bytes of nameBytes) {
    nameBlobLength += 2 + bytes.length;
  }
  const nameBlob = new Uint8Array(nameBlobLength);
  const nameView = new DataView(nameBlob.buffer);
  nameView.setUint32(0, names.length, true);
  let nameCursor = 4;
  for (const bytes of nameBytes) {
    nameView.setUint16(nameCursor, bytes.length, true);
    nameCursor += 2;
    nameBlob.set(bytes, nameCursor);
    nameCursor += bytes.length;
  }

  const densityBytes = NETWORK_SIDES * vertices;
  const nameBlobOffset = table.length + blobEnd + densityBytes;
  view.setUint32(40, table.length, true);
  view.setUint32(44, blobEnd, true);
  view.setUint32(48, table.length + blobEnd, true);
  view.setUint32(52, densityBytes, true);
  view.setUint32(56, nameBlobOffset, true);
  view.setUint32(60, nameBlobLength, true);

  const encoded = new Uint8Array(nameBlobOffset + nameBlobLength);
  encoded.set(table);
  encoded.set(blob.subarray(0, blobEnd), table.length);
  encoded.set(nameBlob, nameBlobOffset);
  return encoded;
}

// One decoded network file: its records in file order, plus the regions a caller may want whole.
export interface DecodedNetwork {
  magic: string;
  format: number;
  records: NetworkRecord[];
  names: string[];
  densities: Uint8Array; // two bytes a vertex, left then right, in record order
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let shift = 0;
  let value = 0;
  for (;;) {
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7;
  }
}

// The reader for the layout above, driven off the header's own offsets rather than the encoder's
// arithmetic — so a header that disagrees with the regions it points at fails here rather than
// decoding into whatever happens to sit at the offset the encoder would have used.
export function decodeNetwork(bytes: Uint8Array): DecodedNetwork {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  const headerBytes = view.getUint16(6, true);
  const recordBytes = view.getUint16(8, true);
  const count = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const coordOffset = view.getUint32(40, true);
  const densityOffset = view.getUint32(48, true);
  const densityBytes = view.getUint32(52, true);
  const nameOffset = view.getUint32(56, true);

  const names: string[] = [];
  const decoder = new TextDecoder();
  const nameCount = view.getUint32(nameOffset, true);
  let nameCursor = nameOffset + 4;
  for (let index = 0; index < nameCount; index++) {
    const length = view.getUint16(nameCursor, true);
    nameCursor += 2;
    names.push(decoder.decode(bytes.subarray(nameCursor, nameCursor + length)));
    nameCursor += length;
  }

  const records: NetworkRecord[] = [];
  for (let index = 0; index < count; index++) {
    const record = headerBytes + index * recordBytes;
    const vertexCount = view.getUint16(record + 8, true);
    const cursor = { offset: coordOffset + view.getUint32(record + 4, true) };
    const points: Coord[] = [];
    let x = 0;
    let y = 0;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const deltaX = readVarint(bytes, cursor);
      const deltaY = readVarint(bytes, cursor);
      x += deltaX % 2 === 0 ? deltaX / 2 : -(deltaX + 1) / 2;
      y += deltaY % 2 === 0 ? deltaY / 2 : -(deltaY + 1) / 2;
      points.push({ lng: originLng + x * scale, lat: originLat + y * scale });
    }
    records.push({
      id: view.getUint32(record, true),
      nameId: view.getUint16(record + 10, true),
      lengthMeters: view.getFloat32(record + 12, true),
      kind: bytes[record + 20],
      width: bytes[record + 21],
      speed: bytes[record + 22],
      flags: bytes[record + 23],
      points,
    });
  }

  return {
    magic,
    format: view.getUint16(4, true),
    records,
    names,
    densities: bytes.subarray(densityOffset, densityOffset + densityBytes),
  };
}
