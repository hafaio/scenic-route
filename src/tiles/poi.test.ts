import { expect, test } from "bun:test";
import { projectX, projectY, unproject } from "./mercator";
import { decodePoints, poiRenderer } from "./poi";
import type { PoiParams } from "./protocol";

// Label placement used to be greedy per tile, over a candidate window that differed from tile to
// tile: a label near a shared edge could lose to a competitor one neighbour saw and the other did
// not, and be drawn by one tile only — half a name, cut mid-glyph at the seam. These pin the
// property that fixes it: placement is a whole-city decision, so every tile a label reaches into
// draws it at the same world position.

const TILE_SIZE = 256;
const ZOOM = 17; // over LABEL_MIN_ZOOM, so labels draw
const LINE_HEIGHT = 12;
const GAP_PX = 3;
const RADIUS = Math.min(7, 3.5 + Math.max(0, ZOOM - 14) * 0.6);

// Per character rather than a flat width, so truncated names and same-length names still differ.
function measure(text: string): number {
  let width = 0;
  for (const character of text) {
    width += 6 + ((character.codePointAt(0) ?? 0) % 3);
  }
  return width;
}

interface TextOp {
  text: string;
  x: number;
  y: number;
}

// A 2D context that records only what the assertions read: the fill of each label. Widths come from
// `measure`, so the placement pass and the checks below agree on every box.
function recordingContext(ops: TextOp[]): OffscreenCanvasRenderingContext2D {
  return {
    font: "",
    textAlign: "",
    textBaseline: "",
    lineWidth: 0,
    lineJoin: "",
    strokeStyle: "",
    fillStyle: "",
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    measureText: (text: string) => ({ width: measure(text) }),
    strokeText: () => {},
    fillText: (text: string, x: number, y: number) => {
      ops.push({ text, x, y });
    },
  } as unknown as OffscreenCanvasRenderingContext2D;
}

function writeVarint(bytes: number[], value: number): void {
  let zigzag = (value << 1) ^ (value >> 31);
  do {
    const byte = zigzag & 0x7f;
    zigzag >>>= 7;
    bytes.push(zigzag === 0 ? byte : byte | 0x80);
  } while (zigzag !== 0);
}

// The LMRK/ARTW point blob the tiler writes: a 40-byte header, per-point zigzag-varint (lng, lat)
// deltas of the quantized coordinates, then a u16-length UTF-8 name per point.
function encodePoints(
  magic: string,
  places: readonly { lng: number; lat: number; name: string }[],
): ArrayBuffer {
  const HEADER_BYTES = 40;
  const originLng = -75;
  const originLat = 40;
  const scale = 1e-7;
  const body: number[] = [];
  let previousX = 0;
  let previousY = 0;
  for (const { lng, lat } of places) {
    const quantizedX = Math.round((lng - originLng) / scale);
    const quantizedY = Math.round((lat - originLat) / scale);
    writeVarint(body, quantizedX - previousX);
    writeVarint(body, quantizedY - previousY);
    previousX = quantizedX;
    previousY = quantizedY;
  }
  const encoder = new TextEncoder();
  const encodedNames = places.map(({ name }) => encoder.encode(name));
  const nameBytes = encodedNames.reduce(
    (total, name) => total + 2 + name.length,
    0,
  );
  const buffer = new ArrayBuffer(HEADER_BYTES + body.length + nameBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = magic.charCodeAt(index);
  }
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, places.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, scale, true);
  bytes.set(body, HEADER_BYTES);
  let offset = HEADER_BYTES + body.length;
  for (const name of encodedNames) {
    view.setUint16(offset, name.length, true);
    offset += 2;
    bytes.set(name, offset);
    offset += name.length;
  }
  return buffer;
}

const baseTileX = Math.floor(projectX(-73.99, ZOOM) / TILE_SIZE);
const baseTileY = Math.floor(projectY(40.72, ZOOM) / TILE_SIZE);
const BLOCK_TILES = 4;

// Points scattered over the block densely enough that labels compete, plus one placed 30 px left of
// an interior vertical seam so its name is guaranteed to straddle it. World pixels go through
// `unproject` so the points land exactly where intended once projected back.
function testPoints(): { lng: number; lat: number; name: string }[] {
  const originX = baseTileX * TILE_SIZE;
  const originY = baseTileY * TILE_SIZE;
  const seam = (baseTileX + 2) * TILE_SIZE;
  const straddler = unproject(seam - 30, originY + TILE_SIZE * 1.5, ZOOM);
  // First, so the greedy pass keeps it whatever else lands nearby.
  const places = [
    { lng: straddler.lng, lat: straddler.lat, name: "Straddles The Seam" },
  ];
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const span = BLOCK_TILES * TILE_SIZE;
  for (let index = 0; index < 160; index++) {
    const { lng, lat } = unproject(
      originX + random() * span,
      originY + random() * span,
      ZOOM,
    );
    // Some names run past LABEL_MAX_CHARS, so the truncation is exercised too.
    const name = `Place ${index} ${"long name ".repeat(index % 4)}`.trim();
    places.push({ lng, lat, name });
  }
  return places;
}

const params: PoiParams = {
  kind: "poi",
  url: "test",
  magic: "LMRK",
  color: "#abc",
  labelAnchor: "top",
};

// Every label each tile drew, in world pixels.
function drawBlock(): Map<string, TextOp[]> {
  const points = decodePoints(encodePoints("LMRK", testPoints()), "LMRK");
  const drawn = new Map<string, TextOp[]>();
  for (let tileX = baseTileX - 1; tileX <= baseTileX + BLOCK_TILES; tileX++) {
    for (let tileY = baseTileY - 1; tileY <= baseTileY + BLOCK_TILES; tileY++) {
      const ops: TextOp[] = [];
      poiRenderer.draw(
        recordingContext(ops),
        points,
        { x: tileX, y: tileY, z: ZOOM },
        params,
        1,
      );
      drawn.set(
        `${tileX},${tileY}`,
        ops.map(({ text, x, y }) => ({
          text,
          x: x + tileX * TILE_SIZE,
          y: y + tileY * TILE_SIZE,
        })),
      );
    }
  }
  return drawn;
}

// The label's box, from the recorded fill: text starts at x, and the anchor is "top" so the baseline
// y is its bottom edge.
function labelBox({ text, x, y }: TextOp) {
  return { x0: x, x1: x + measure(text), y0: y - LINE_HEIGHT, y1: y };
}

test("both tiles sharing a seam draw a label that spans it, identically", () => {
  const drawn = drawBlock();
  const seam = (baseTileX + 2) * TILE_SIZE;
  const left = drawn
    .get(`${baseTileX + 1},${baseTileY + 1}`)
    ?.find(({ text }) => text === "Straddles The Seam");
  const right = drawn
    .get(`${baseTileX + 2},${baseTileY + 1}`)
    ?.find(({ text }) => text === "Straddles The Seam");
  expect(left).toBeDefined();
  expect(right).toEqual(left as TextOp);
  // Vacuous unless the name really does cross: it starts left of the seam and ends right of it.
  const { x0, x1 } = labelBox(left as TextOp);
  expect(x0).toBeCloseTo(seam - 30 + RADIUS + GAP_PX, 1);
  expect(x1).toBeGreaterThan(seam);
});

test("a label is drawn by every tile its box reaches, at one world position", () => {
  const drawn = drawBlock();
  const everywhere = new Map<string, TextOp>();
  for (const ops of drawn.values()) {
    for (const op of ops) {
      const seen = everywhere.get(op.text);
      if (seen) {
        expect(op).toEqual(seen);
      } else {
        everywhere.set(op.text, op);
      }
    }
  }

  let spanning = 0;
  for (const label of everywhere.values()) {
    const { x0, x1, y0, y1 } = labelBox(label);
    let tiles = 0;
    for (const [key, ops] of drawn) {
      const [tileX, tileY] = key.split(",").map(Number);
      const overlaps =
        x0 < (tileX + 1) * TILE_SIZE &&
        x1 > tileX * TILE_SIZE &&
        y0 < (tileY + 1) * TILE_SIZE &&
        y1 > tileY * TILE_SIZE;
      const drewIt = ops.some(({ text }) => text === label.text);
      expect({ label: label.text, key, drewIt }).toEqual({
        label: label.text,
        key,
        drewIt: overlaps,
      });
      tiles += overlaps ? 1 : 0;
    }
    spanning += tiles > 1 ? 1 : 0;
  }
  // The block has to actually exercise seams for the check above to mean anything.
  expect(spanning).toBeGreaterThan(5);
});

test("placement does not depend on the order tiles are drawn", () => {
  const places = testPoints();
  const forward = decodePoints(encodePoints("LMRK", places), "LMRK");
  const reverse = decodePoints(encodePoints("LMRK", places), "LMRK");
  const coords: { x: number; y: number; z: number }[] = [];
  for (let tileX = baseTileX; tileX < baseTileX + BLOCK_TILES; tileX++) {
    for (let tileY = baseTileY; tileY < baseTileY + BLOCK_TILES; tileY++) {
      coords.push({ x: tileX, y: tileY, z: ZOOM });
    }
  }
  const render = (
    points: ReturnType<typeof decodePoints>,
    order: typeof coords,
  ) =>
    order.map((coord) => {
      const ops: TextOp[] = [];
      poiRenderer.draw(recordingContext(ops), points, coord, params, 1);
      return `${coord.x},${coord.y}:${JSON.stringify(ops)}`;
    });
  expect(render(reverse, [...coords].reverse()).sort()).toEqual(
    render(forward, coords).sort(),
  );
});
