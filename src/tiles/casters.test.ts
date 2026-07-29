import { expect, test } from "bun:test";
import { decodeChunk } from "./casters";
import { projectX, projectY } from "./mercator";

// The decoder against a chunk written the way crates/tiler/src/caster_chunks.rs writes one. Both bugs
// these pin cost a whole render: the delta chain restarts per RECORD, not per chunk, and the convex
// hulls have to live outside `points`, which only carries ring ends and so must stay contiguous.

const ORIGIN_LNG = -74.0114;
const ORIGIN_LAT = 40.713;
const SCALE = 1e-6;

function writeVarint(bytes: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
}

function zigzag(value: number): number {
  return value < 0 ? -2 * value - 1 : 2 * value;
}

// One record: its height in decimetres and its rings in degrees, quantized about the chunk origin with
// the delta chain running across the rings and restarting here.
function encodeRecord(
  bytes: number[],
  heightDm: number,
  rings: [number, number][][],
): void {
  writeVarint(bytes, heightDm);
  writeVarint(bytes, rings.length);
  let previousX = 0;
  let previousY = 0;
  for (const ring of rings) {
    writeVarint(bytes, ring.length);
    for (const [lng, lat] of ring) {
      const x = Math.round((lng - ORIGIN_LNG) / SCALE);
      const y = Math.round((lat - ORIGIN_LAT) / SCALE);
      writeVarint(bytes, zigzag(x - previousX));
      writeVarint(bytes, zigzag(y - previousY));
      previousX = x;
      previousY = y;
    }
  }
}

// The trunk section: its own chain of deltas about the chunk origin, then a radius in centimetres and
// a height in decimetres.
function encodeTrunks(
  bytes: number[],
  trunks: [lng: number, lat: number, radiusCm: number, heightDm: number][],
): void {
  let previousX = 0;
  let previousY = 0;
  for (const [lng, lat, radiusCm, heightDm] of trunks) {
    const x = Math.round((lng - ORIGIN_LNG) / SCALE);
    const y = Math.round((lat - ORIGIN_LAT) / SCALE);
    writeVarint(bytes, zigzag(x - previousX));
    writeVarint(bytes, zigzag(y - previousY));
    writeVarint(bytes, radiusCm);
    writeVarint(bytes, heightDm);
    previousX = x;
    previousY = y;
  }
}

function chunk(
  buildings: [number, number][][][],
  crowns: [number, number][][][],
  trunks: [lng: number, lat: number, radiusCm: number, heightDm: number][] = [],
): ArrayBuffer {
  const body: number[] = [];
  for (const [index, rings] of buildings.entries()) {
    encodeRecord(body, 100 + index, rings);
  }
  for (const [index, rings] of crowns.entries()) {
    encodeRecord(body, 50 + index, rings);
  }
  encodeTrunks(body, trunks);
  const buffer = new ArrayBuffer(44 + body.length);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set([...new TextEncoder().encode("CSTR")], 0);
  view.setUint16(4, 2, true);
  view.setUint16(6, 44, true);
  view.setUint32(8, buildings.length, true);
  view.setUint32(12, crowns.length, true);
  view.setFloat64(16, ORIGIN_LNG, true);
  view.setFloat64(24, ORIGIN_LAT, true);
  view.setFloat64(32, SCALE, true);
  view.setUint32(40, trunks.length, true);
  new Uint8Array(buffer).set(new Uint8Array(body), 44);
  return buffer;
}

// A courtyard building, a plain one and a crown. The first record's hull is what would corrupt the
// second's ring range if the two shared a buffer.
const COURTYARD: [number, number][][] = [
  [
    [-74.01, 40.71],
    [-74.009, 40.71],
    [-74.009, 40.7105],
    [-74.01, 40.7105],
  ],
  [
    [-74.0098, 40.7101],
    [-74.0092, 40.7101],
    [-74.0092, 40.7104],
    [-74.0098, 40.7104],
  ],
];
const PLAIN: [number, number][][] = [
  [
    [-74.008, 40.711],
    [-74.0075, 40.711],
    [-74.0075, 40.7112],
    [-74.008, 40.7112],
  ],
];
const CROWN: [number, number][][] = [
  [
    [-74.006, 40.712],
    [-74.0058, 40.712],
    [-74.0059, 40.7122],
  ],
];

test("decodes a chunk's records, rings and heights", () => {
  const decoded = decodeChunk(chunk([COURTYARD, PLAIN], [CROWN]));

  expect(decoded.buildings).toBe(2);
  expect(decoded.records.length - 1).toBe(3);
  // Decimetres in the blob, metres out, through a Float32Array.
  for (const [record, height] of [10, 10.1, 5].entries()) {
    expect(decoded.heights[record]).toBeCloseTo(height, 5);
  }
  // The courtyard's two rings, then one apiece.
  expect([...decoded.records]).toEqual([0, 2, 3, 4]);

  for (const [record, source] of [COURTYARD, PLAIN, CROWN].entries()) {
    for (const [offset, ring] of source.entries()) {
      const at = decoded.records[record] + offset;
      const from = decoded.rings[at];
      expect(decoded.rings[at + 1] - from).toBe(ring.length);
      for (const [vertex, [lng, lat]] of ring.entries()) {
        // Half a quantization unit in degrees, in zoom-0 world pixels.
        const tolerance = (SCALE / 2) * (256 / 360);
        expect(decoded.points[(from + vertex) * 2]).toBeCloseTo(
          projectX(lng, 0),
          6,
        );
        expect(
          Math.abs(decoded.points[(from + vertex) * 2 + 1] - projectY(lat, 0)),
        ).toBeLessThan(tolerance);
      }
    }
  }
});

test("keeps a hull off the ring buffer and winds it positively", () => {
  const decoded = decodeChunk(chunk([COURTYARD, PLAIN], [CROWN]));

  // Both footprints are rectangles, so both are swept as their own hull and neither is a crown's.
  expect(decoded.hulls[1]).toBe(4);
  expect(decoded.hulls[3]).toBe(4);
  expect(decoded.hulls[5]).toBe(0);
  expect(decoded.hullPoints.length / 2).toBe(8);

  for (const record of [0, 1]) {
    const from = decoded.hulls[record * 2];
    const count = decoded.hulls[record * 2 + 1];
    let area = 0;
    for (let step = 0; step < count; step++) {
      const next = from + ((step + 1) % count);
      area +=
        decoded.hullPoints[(from + step) * 2] *
          decoded.hullPoints[next * 2 + 1] -
        decoded.hullPoints[next * 2] *
          decoded.hullPoints[(from + step) * 2 + 1];
    }
    expect(area).toBeGreaterThan(0);
  }
});

test("decodes the trunks as points with a radius, a height and a box", () => {
  const decoded = decodeChunk(
    chunk(
      [PLAIN],
      [CROWN],
      [
        [-74.009, 40.711, 12, 30],
        [-74.0085, 40.7115, 76, 52],
      ],
    ),
  );

  expect(decoded.trunkRadii[0]).toBeCloseTo(0.12, 6);
  expect(decoded.trunkRadii[1]).toBeCloseTo(0.76, 6);
  expect(decoded.trunkHeights[0]).toBeCloseTo(3, 6);
  expect(decoded.trunkHeights[1]).toBeCloseTo(5.2, 6);
  expect(decoded.trunkMaxHeight).toBeCloseTo(5.2, 6);
  expect(decoded.trunks[0]).toBeCloseTo(projectX(-74.009, 0), 6);
  expect(decoded.trunks[3]).toBeCloseTo(projectY(40.7115, 0), 6);
  // North is a SMALLER world y, so the higher latitude is the box's top.
  expect([...decoded.trunkBox]).toEqual([
    decoded.trunks[0],
    decoded.trunks[3],
    decoded.trunks[2],
    decoded.trunks[1],
  ]);
});

test("reads a ring's winding rather than its stored order", () => {
  const reversed = COURTYARD.map((ring) => [...ring].reverse());
  const forward = decodeChunk(chunk([COURTYARD], []));
  const backward = decodeChunk(chunk([reversed], []));

  expect(forward.wound[0]).not.toBe(backward.wound[0]);
  expect(forward.wound[1]).not.toBe(backward.wound[1]);
});
