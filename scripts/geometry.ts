// The encoders the tree-cover ingest writes its .bin sources with: the varint coordinate codec
// and the two source layouts built on it. Only the ingest needs them — crates/tiler reads these
// files back, and the model math lives there. Layouts are documented in scripts/README.md.

import type { Bounds } from "./manifest";
import type { Polygon } from "./overpass";
import type { Coord } from "./socrata";

export const HEADER_BYTES = 40;
export const COORD_SCALE = 1e-6; // degrees per quantized unit, ~0.1 m

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

// A tree, with the crown disc it shades the ground with already sized from its dbh: the model
// weights each tree by this crown, so it travels with the point. `genusId` is the top-12 genus
// id 0..11, or 12 ("Other") for a tail genus, an unknown genus, or an OSM tree.
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
