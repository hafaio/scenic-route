// The zigzag varint the tiler writes coordinate deltas as (crates/tiler/src/binfmt.rs), shared by
// every point/line blob decoder. Unchecked: these blobs are whole-file fetches, so a truncated one
// is a broken deploy rather than the tile-by-tile partial reads src/streets/chunk.ts guards against.

export interface Cursor {
  offset: number;
}

// A plain LEB128 varint: the counts and heights a blob writes alongside its zigzagged coordinates.
// Accumulated by multiplication rather than shifting, so a value past 2^31 stays exact.
export function readUnsignedVarint(bytes: Uint8Array, cursor: Cursor): number {
  let value = 0;
  let scale = 1;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return value;
}

export function readVarint(bytes: Uint8Array, cursor: Cursor): number {
  const value = readUnsignedVarint(bytes, cursor);
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}
