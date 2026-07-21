// The shared STCK street-chunk decoder. One .bin per z12 tile (layout: scripts/README.md), built by
// the tiler and read by every overlay that draws over the streets. Both the street-score layer (which
// needs the per-vertex canopy densities and the sidewalk offset) and the commercial/dining overlay
// (which needs only the geometry) decode the same bytes, so the format lives here once, bounds-checked:
// a truncated or malformed chunk throws a clear error rather than reading past the buffer and drawing
// silent garbage geometry / NaN coordinates.

const CHUNK_FORMAT = 3;
const SIDES = 2; // density bytes per street vertex: left sidewalk then right, interleaved
const METERS_PER_DECIMETER = 0.1;

// One block-length CSCL centreline, decoded. The full segment shape: geometry, the per-vertex canopy
// densities (both sidewalks, left then right, interleaved), and half the distance between the two
// sidewalks. An overlay that only wants geometry keeps lngs/lats and lets the rest be collected.
export interface StreetSegment {
  lngs: Float64Array;
  lats: Float64Array;
  // The canopy cover at each vertex, 0..255 for a covered fraction of 0..1: both sidewalks, left then
  // right, interleaved. A segment with no offset carries the same value in both.
  densities: Uint8Array;
  // Half the distance between the two sidewalks, in metres. Zero for a path or a boardwalk, which *is*
  // the walking surface and is drawn as a single line on its centreline.
  offsetMeters: number;
}

// A varint's bytes may run off the end of a truncated chunk; each read is guarded so it throws the
// clear error rather than reading `undefined` (which coerces to 0) and decoding silent garbage.
function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    if (cursor.offset >= bytes.length) {
      throw new Error("street chunk truncated");
    }
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

// Decode one STCK v3 street chunk into its full segments. Header: magic "STCK", version u16 at 4, the
// body offset u16 at 6, the segment count u32 at 8, then the origin lng/lat and scale as f64 at 16, 24
// and 32. Each segment is a u16 vertex count, a byte at +2 giving the sidewalk offset in decimetres,
// then zigzag-varint delta lng/lat per vertex, then SIDES * vertices density bytes.
export function decodeStreetChunk(buffer: ArrayBuffer): StreetSegment[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== "STCK" || version !== CHUNK_FORMAT) {
    throw new Error(`not a v${CHUNK_FORMAT} street chunk`);
  }

  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const segments: StreetSegment[] = [];
  for (let segment = 0; segment < count; segment++) {
    // The 3-byte segment header (vertex count u16, offset byte) must itself fit before it is read.
    if (cursor.offset + 3 > bytes.length) {
      throw new Error("street chunk truncated");
    }
    const vertices = view.getUint16(cursor.offset, true);
    const offsetMeters = bytes[cursor.offset + 2] * METERS_PER_DECIMETER;
    cursor.offset += 3;
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
    // The density block is a fixed span, so it can be bounds-checked before the slice rather than
    // silently clamping to a short array past the end.
    if (cursor.offset + SIDES * vertices > bytes.length) {
      throw new Error("street chunk truncated");
    }
    const densities = bytes.slice(
      cursor.offset,
      cursor.offset + SIDES * vertices,
    );
    cursor.offset += SIDES * vertices;
    segments.push({ lngs, lats, densities, offsetMeters });
  }
  return segments;
}
