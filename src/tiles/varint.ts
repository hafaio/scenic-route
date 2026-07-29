// The zigzag varint the tiler writes coordinate deltas as (crates/tiler/src/binfmt.rs), shared by
// every point/line blob decoder. Unchecked: these blobs are whole-file fetches, so a truncated one
// is a broken deploy rather than the tile-by-tile partial reads src/streets/chunk.ts guards against.

export interface Cursor {
  offset: number;
}

export function readVarint(bytes: Uint8Array, cursor: Cursor): number {
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
