import { afterAll, beforeAll, expect, test } from "bun:test";
import { setBaseUrl } from "./base-url";
import {
  type CasterManifest,
  casterManifest,
  chunksFor,
  decodeChunk,
} from "./casters";
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

// One building: its height in decimetres and its rings in degrees, quantized about the chunk origin
// with the delta chain running across the rings and restarting here.
function encodeBuilding(
  bytes: number[],
  heightDm: number,
  rings: [number, number][][],
): void {
  writeVarint(bytes, heightDm);
  writeVarint(bytes, rings.length);
  encodeRings(bytes, rings, [0, 0]);
}

// One crown: its height, how many slices it carries, then per slice a ring count and those rings.
function encodeCrown(
  bytes: number[],
  heightDm: number,
  levels: [number, number][][][],
): void {
  writeVarint(bytes, heightDm);
  writeVarint(bytes, levels.length);
  const previous: [number, number] = [0, 0];
  for (const rings of levels) {
    writeVarint(bytes, rings.length);
    encodeRings(bytes, rings, previous);
  }
}

function encodeRings(
  bytes: number[],
  rings: [number, number][][],
  previous: [number, number],
): void {
  for (const ring of rings) {
    writeVarint(bytes, ring.length);
    for (const [lng, lat] of ring) {
      const x = Math.round((lng - ORIGIN_LNG) / SCALE);
      const y = Math.round((lat - ORIGIN_LAT) / SCALE);
      writeVarint(bytes, zigzag(x - previous[0]));
      writeVarint(bytes, zigzag(y - previous[1]));
      previous[0] = x;
      previous[1] = y;
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
  crowns: [number, number][][][][],
  trunks: [lng: number, lat: number, radiusCm: number, heightDm: number][] = [],
): ArrayBuffer {
  const body: number[] = [];
  for (const [index, rings] of buildings.entries()) {
    encodeBuilding(body, 100 + index, rings);
  }
  for (const [index, levels] of crowns.entries()) {
    encodeCrown(body, 50 + index, levels);
  }
  encodeTrunks(body, trunks);
  const buffer = new ArrayBuffer(44 + body.length);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set([...new TextEncoder().encode("CSTR")], 0);
  view.setUint16(4, 3, true);
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
// A crown as it ships: its outline, then the slice that outline insets to.
const CROWN: [number, number][][][] = [
  [
    [
      [-74.006, 40.712],
      [-74.0058, 40.712],
      [-74.0059, 40.7122],
    ],
  ],
  [
    [
      [-74.00595, 40.71205],
      [-74.00585, 40.71205],
      [-74.0059, 40.71215],
    ],
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
  // The courtyard's two rings, one for the plain footprint, then the crown's two slices.
  expect([...decoded.records]).toEqual([0, 2, 3, 5]);
  // Which slice a ring is in is what says how far down the shadow it is swept; a footprint's rings
  // are all level 0.
  expect([...decoded.levels]).toEqual([0, 0, 0, 0, 1]);

  const flat = [COURTYARD, PLAIN, CROWN.flat()];
  for (const [record, source] of flat.entries()) {
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

  // A hull per RING now, since a crown's slices are swept as well: the courtyard's outer ring and its
  // hole, the plain footprint, and the crown's two triangular slices.
  expect([...decoded.hulls].filter((_, index) => index % 2 === 1)).toEqual([
    4, 4, 4, 3, 3,
  ]);

  for (const ring of [0, 2, 3, 4]) {
    const from = decoded.hulls[ring * 2];
    const count = decoded.hulls[ring * 2 + 1];
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

// The gather's completeness, which is what stands between a dropped chunk and a tile that renders its
// buildings as sunlit ground. A chunk the manifest lists always has geometry in it, so anything short
// of every listed chunk arriving is a hole, not an empty patch of city.

const MANIFEST: CasterManifest = {
  chunkZoom: 15,
  coordScale: SCALE,
  maxShadowMeters: 0, // no halo, so the gather asks for exactly the cells the box covers
  chunks: [
    { x: 100, y: 200, bytes: 0 },
    { x: 101, y: 200, bytes: 0 },
    { x: 110, y: 200, bytes: 0 },
    { x: 111, y: 200, bytes: 0 },
  ],
};

// The zoom-0 world-pixel box covering chunk cells `from` to `to` on one row, at chunkZoom 15.
function boxOver(from: number, to: number): [number, number, number, number] {
  const cell = 256 / 2 ** MANIFEST.chunkZoom;
  return [from * cell, 200 * cell, to * cell, 200 * cell];
}

const originalFetch = globalThis.fetch;

function serve(fail: (url: string) => boolean): void {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (fail(url)) {
      return Promise.reject(new Error("offline"));
    }
    return Promise.resolve(new Response(chunk([PLAIN], [])));
  }) as typeof fetch;
}

beforeAll(() => {
  setBaseUrl("https://example.test/");
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("a gather missing one of its chunks says so", async () => {
  serve((url) => url.endsWith("casters/100/200.bin"));
  const gather = await chunksFor(MANIFEST, ...boxOver(100, 101), ORIGIN_LAT);

  expect(gather.chunks.length).toBe(1);
  expect(gather.complete).toBe(false);
});

test("a gather that got everything the manifest lists is complete", async () => {
  serve(() => false);
  const gather = await chunksFor(MANIFEST, ...boxOver(110, 111), ORIGIN_LAT);

  expect(gather.chunks.length).toBe(2);
  expect(gather.complete).toBe(true);
});

test("a manifest that could not be reached is not remembered as absent", async () => {
  let attempts = 0;
  globalThis.fetch = ((): Promise<Response> => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error("offline"))
      : Promise.resolve(new Response(JSON.stringify(MANIFEST)));
  }) as typeof fetch;

  expect(await casterManifest()).toBeNull();
  expect(await casterManifest()).toEqual(MANIFEST);
});
