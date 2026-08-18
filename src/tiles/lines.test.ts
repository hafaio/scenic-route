import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeLines, linesRenderer } from "./lines";
import { projectX, projectY, unproject } from "./mercator";
import { METERS_PER_DEGREE_LAT, metersPerLng } from "./polylines";
import type { LinesParams } from "./protocol";

// Ferry crossings are drawn per tile but shaped globally: the spline's control points, the lane
// offset's perpendicular and the company a crossing keeps all read vertices the tile it is drawing
// does not contain. These pin that — a crossing comes out at the same world position from either
// side of a seam, it is drawn on its own shape points wherever it has the water to itself, and the
// lane it takes where it does not sits the same number of pixels off its path at every zoom in.

const TILE_SIZE = 256;
const ORIGIN_LNG = -74.1;
const ORIGIN_LAT = 40.6;
const SCALE = 1e-6;

type PathOp = { op: string; args: number[]; stroke: string };

function recordingContext(ops: PathOp[]): OffscreenCanvasRenderingContext2D {
  let stroking: PathOp[] = [];
  const record = (op: string) => {
    return (...args: number[]) => {
      stroking.push({ op, args, stroke: String(context.strokeStyle) });
    };
  };
  const context = {
    lineWidth: 0,
    lineJoin: "",
    lineCap: "",
    strokeStyle: "",
    beginPath: () => {
      stroking = [];
    },
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    bezierCurveTo: record("bezierCurveTo"),
    stroke: () => {
      ops.push(...stroking);
    },
  } as unknown as OffscreenCanvasRenderingContext2D;
  return context;
}

function writeVarint(bytes: number[], value: number): void {
  let zigzag = (value << 1) ^ (value >> 31);
  do {
    const byte = zigzag & 0x7f;
    zigzag >>>= 7;
    bytes.push(zigzag === 0 ? byte : byte | 0x80);
  } while (zigzag !== 0);
}

interface Crossing {
  route: string;
  points: readonly { lng: number; lat: number }[];
}

// The FERR layout of scripts/README.md, enough of it to draw: a 56-byte header, the two endpoints of
// every crossing as stops, one segment per crossing, the varint geometry blob and the name blob.
function encodeFerr(crossings: readonly Crossing[]): ArrayBuffer {
  const HEADER_BYTES = 56;
  const encoder = new TextEncoder();
  const names: string[] = [];
  const nameId = (name: string) => {
    const seen = names.indexOf(name);
    return seen < 0 ? names.push(name) - 1 : seen;
  };
  const quantize = (value: number, origin: number) =>
    Math.round((value - origin) / SCALE);

  const stops: { x: number; y: number; name: number }[] = [];
  const segments: {
    a: number;
    b: number;
    offset: number;
    count: number;
    route: number;
  }[] = [];
  const geometry: number[] = [];
  for (const { route, points } of crossings) {
    const ends = [points[0], points[points.length - 1]].map((point, index) => {
      stops.push({
        x: quantize(point.lng, ORIGIN_LNG),
        y: quantize(point.lat, ORIGIN_LAT),
        name: nameId(`${route} end ${index}`),
      });
      return stops.length - 1;
    });
    const offset = geometry.length;
    let previousX = 0;
    let previousY = 0;
    for (const { lng, lat } of points) {
      const x = quantize(lng, ORIGIN_LNG);
      const y = quantize(lat, ORIGIN_LAT);
      writeVarint(geometry, x - previousX);
      writeVarint(geometry, y - previousY);
      previousX = x;
      previousY = y;
    }
    segments.push({
      a: ends[0],
      b: ends[1],
      offset,
      count: points.length,
      route: nameId(route),
    });
  }

  const stopTable = HEADER_BYTES;
  const segmentTable = stopTable + stops.length * 12;
  const geometryOffset = segmentTable + segments.length * 20;
  const nameOffset = geometryOffset + Math.ceil(geometry.length / 4) * 4;
  const encoded = names.map((name) => encoder.encode(name));
  const nameBytes = encoded.reduce((total, name) => total + 2 + name.length, 4);

  const buffer = new ArrayBuffer(nameOffset + nameBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(encoder.encode("FERR"));
  view.setUint16(4, 2, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, stops.length, true);
  view.setUint32(12, segments.length, true);
  view.setFloat64(16, ORIGIN_LNG, true);
  view.setFloat64(24, ORIGIN_LAT, true);
  view.setFloat64(32, SCALE, true);
  view.setUint32(40, geometryOffset, true);
  view.setUint32(44, geometry.length, true);
  view.setUint32(48, nameOffset, true);
  view.setUint32(52, nameBytes, true);
  stops.forEach(({ x, y, name }, index) => {
    const record = stopTable + index * 12;
    view.setInt32(record, x, true);
    view.setInt32(record + 4, y, true);
    view.setUint32(record + 8, name, true);
  });
  segments.forEach(({ a, b, offset, count, route }, index) => {
    const record = segmentTable + index * 20;
    view.setUint32(record, a, true);
    view.setUint32(record + 4, b, true);
    view.setFloat32(record + 8, 600, true);
    view.setUint32(record + 12, offset, true);
    view.setUint16(record + 16, count, true);
    view.setUint16(record + 18, route, true);
  });
  bytes.set(geometry, geometryOffset);
  let cursor = nameOffset;
  view.setUint32(cursor, names.length, true);
  cursor += 4;
  for (const name of encoded) {
    view.setUint16(cursor, name.length, true);
    cursor += 2;
    bytes.set(name, cursor);
    cursor += name.length;
  }
  return buffer;
}

// HWAY's shared polygon layout: a 40-byte header, then one single-ring polygon whose ring is the
// line, as varint deltas of the quantized coordinates.
function encodeHway(
  points: readonly { lng: number; lat: number }[],
): ArrayBuffer {
  const HEADER_BYTES = 40;
  const body: number[] = [];
  body.push(1, 0); // one ring
  body.push(points.length & 0xff, points.length >> 8, 0, 0);
  let previousX = 0;
  let previousY = 0;
  for (const { lng, lat } of points) {
    const x = Math.round((lng - ORIGIN_LNG) / SCALE);
    const y = Math.round((lat - ORIGIN_LAT) / SCALE);
    writeVarint(body, x - previousX);
    writeVarint(body, y - previousY);
    previousX = x;
    previousY = y;
  }
  const buffer = new ArrayBuffer(HEADER_BYTES + body.length);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new TextEncoder().encode("HWAY"));
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, 1, true);
  view.setFloat64(16, ORIGIN_LNG, true);
  view.setFloat64(24, ORIGIN_LAT, true);
  view.setFloat64(32, SCALE, true);
  bytes.set(body, HEADER_BYTES);
  return buffer;
}

const params: LinesParams = {
  kind: "lines",
  url: "test",
  format: "ferr",
  color: "#2563eb",
};

// A crossing bending its way east along a fixed row of tiles, so it enters and leaves several of
// them, sampled at the coarse spacing a ferry shape has.
function crossing(route: string, zoom: number, shiftPx: number): Crossing {
  const startX = 9650 * TILE_SIZE;
  const startY = 12317 * TILE_SIZE;
  const points = [];
  for (let step = 0; step <= 6; step++) {
    points.push(
      unproject(
        startX + step * 120,
        startY + shiftPx + Math.sin(step) * 40,
        zoom,
      ),
    );
  }
  return { route, points };
}

function drawTile(
  data: ReturnType<typeof decodeLines>,
  tileX: number,
  tileY: number,
  zoom: number,
): PathOp[] {
  const ops: PathOp[] = [];
  linesRenderer.draw(
    recordingContext(ops),
    data,
    { x: tileX, y: tileY, z: zoom },
    params,
    1,
  );
  // Back into world pixels, which is where two tiles' drawings are comparable.
  return ops.map(({ op, args, stroke }) => ({
    op,
    stroke,
    args: args.map((value, index) =>
      index % 2 === 0 ? value + tileX * TILE_SIZE : value + tileY * TILE_SIZE,
    ),
  }));
}

test("neighbouring tiles draw a crossing at the same world position", () => {
  const zoom = 15;
  const data = decodeLines(
    encodeFerr([crossing("East River", zoom, 0)]),
    "ferr",
  );
  const left = drawTile(data, 9650, 12317, zoom);
  const right = drawTile(data, 9651, 12317, zoom);
  expect(left.length).toBeGreaterThan(1);
  for (const [index, op] of left.entries()) {
    expect(op.op).toBe(right[index].op);
    expect(op.stroke).toBe(right[index].stroke);
    for (const [axis, value] of op.args.entries()) {
      expect(value).toBeCloseTo(right[index].args[axis], 6);
    }
  }
});

// Two routes over the same water: identical shapes, so any gap between them is the lane offset.
function laneGap(zoom: number): number {
  const data = decodeLines(
    encodeFerr([crossing("East River", zoom, 0), crossing("Astoria", zoom, 0)]),
    "ferr",
  );
  const starts = drawTile(data, 9650, 12317, zoom).filter(
    ({ op }) => op === "moveTo",
  );
  expect(starts).toHaveLength(2);
  const [first, second] = starts;
  return Math.hypot(
    first.args[0] - second.args[0],
    first.args[1] - second.args[1],
  );
}

test("a route's lane is the same width in pixels at every zoom it is drawn at", () => {
  const wide = laneGap(14);
  expect(wide).toBeGreaterThan(2); // the line width, so the two are not on top of another
  expect(laneGap(18)).toBeCloseTo(wide, 6);
});

test("the lane collapses with the map below the zoom it is pinned at", () => {
  // Below z14 a lane is a ground distance, so the bundle stays the same fraction of the water it
  // crosses however far out the map goes rather than spilling onto both banks.
  const wide = laneGap(14);
  expect(laneGap(13)).toBeCloseTo(wide / 2, 6);
  expect(laneGap(11)).toBeCloseTo(wide / 8, 6);
});

// The point of assigning lanes per stretch of water rather than once per route: a crossing with the
// water to itself is drawn where the feed published it, to the quantization the artifact stores.
test("a crossing alone in its water draws on its own shape points", () => {
  const zoom = 15;
  const { points } = crossing("East River", zoom, 0);
  const data = decodeLines(
    encodeFerr([{ route: "East River", points }]),
    "ferr",
  );
  const drawn = drawTile(data, 9650, 12317, zoom);
  expect(drawn[0].op).toBe("moveTo");
  const ends = drawn.map(({ args }) => args.slice(-2));
  expect(ends).toHaveLength(points.length);
  for (const [index, [x, y]] of ends.entries()) {
    // Loose by a pixel hundredth: the artifact quantizes coordinates to 1e-6°.
    expect(x).toBeCloseTo(projectX(points[index].lng, zoom), 1);
    expect(y).toBeCloseTo(projectY(points[index].lat, zoom), 1);
  }
});

// And the other half of it: the same route is displaced where it does share, and only there.
test("a crossing takes a lane only over the water it shares", () => {
  const zoom = 15;
  const shared = 2; // the steps of crossing() both routes run
  const points = crossing("East River", zoom, 0).points;
  const data = decodeLines(
    encodeFerr([
      { route: "East River", points },
      { route: "Astoria", points: points.slice(0, shared + 1) },
    ]),
    "ferr",
  );
  const drawn = drawTile(data, 9650, 12317, zoom).filter(
    ({ stroke }) => stroke === "#00839c",
  );
  const offAt = (step: number): number => {
    const [x, y] = drawn[step].args.slice(-2);
    return Math.hypot(
      x - projectX(points[step].lng, zoom),
      y - projectY(points[step].lat, zoom),
    );
  };
  expect(offAt(0)).toBeGreaterThan(2); // the line width, so the two are not on top of another
  expect(offAt(points.length - 1)).toBeLessThan(0.5);
});

test("a route takes its operator's colour, and an unknown one the layer's", () => {
  const zoom = 15;
  const data = decodeLines(
    encodeFerr([
      crossing("East River", zoom, 0),
      crossing("Ferry To Nowhere", zoom, 60),
    ]),
    "ferr",
  );
  const strokes = new Set(
    drawTile(data, 9650, 12317, zoom).map(({ stroke }) => stroke),
  );
  expect(strokes).toEqual(new Set(["#00839c", params.color]));
});

test("highway lines keep their corners and the layer's own colour", () => {
  const zoom = 15;
  const { points } = crossing("unused", zoom, 0);
  const data = decodeLines(encodeHway(points), "hway");
  const drawn = drawTile(data, 9650, 12317, zoom);
  expect(drawn.map(({ op }) => op)).toEqual([
    "moveTo",
    ...points.slice(1).map(() => "lineTo"),
  ]);
  expect(drawn[0].stroke).toBe(params.color);
  // Loose by a pixel hundredth: the artifact quantizes coordinates to 1e-6°.
  expect(drawn[1].args[0]).toBeCloseTo(projectX(points[1].lng, zoom), 1);
  expect(drawn[1].args[1]).toBeCloseTo(projectY(points[1].lat, zoom), 1);
});

// The weave the lanes exist to prevent, and the two things about a line that must not decide which
// side of the water its lane is on: which end of it the file stored first, and how far it turned
// before it got here. A crossing is stored from either end, so a perpendicular taken from a line's
// own direction points the opposite way on the one beside it stored back to front; and a side
// carried through a corner — which a ferry shape has wherever it follows the boat into its slip —
// points the opposite way to one that was not. Three routes over one stretch of water, one of them
// reversed and coming out of a hairpin, have to come out as three parallel lines in route order.
test("routes over one stretch of water stack in order however each is stored", () => {
  const zoom = 15;
  const { points } = crossing("unused", zoom, 0);
  // A leg off the far end of the stretch, turning away sharper than a right angle, as a boat
  // backing into its slip.
  const slip = unproject(
    projectX(points[0].lng, zoom) + 200,
    projectY(points[0].lat, zoom) - 400,
    zoom,
  );
  const data = decodeLines(
    encodeFerr([
      { route: "Astoria", points },
      { route: "East River", points: [...points, slip].reverse() },
      { route: "South Brooklyn", points },
    ]),
    "ferr",
  );
  const drawn = drawTile(data, 9650, 12317, zoom);
  const offsets = (stroke: string): { x: number; y: number }[] => {
    const ends = drawn
      .filter((op) => op.stroke === stroke)
      .map(({ args }) => args.slice(-2));
    // East River is stored from the slip end, so its drawing is read back into the stretch's own
    // order, without the slip.
    const ordered = stroke === "#00839c" ? ends.slice(1).reverse() : ends;
    return ordered.map(([x, y], step) => ({
      x: x - projectX(points[step].lng, zoom),
      y: y - projectY(points[step].lat, zoom),
    }));
  };
  const astoria = offsets("#ff6b00");
  const eastRiver = offsets("#00839c");
  const southBrooklyn = offsets("#ffd100");

  for (const [step, near] of eastRiver.entries()) {
    const far = southBrooklyn[step];
    // Loose by a pixel twentieth: the artifact quantizes coordinates to 1e-6°.
    expect(Math.hypot(astoria[step].x, astoria[step].y)).toBeLessThan(0.05);
    // Both displaced the same way: one stack, not two half ones facing away from each other.
    expect(near.x * far.x + near.y * far.y).toBeGreaterThan(0);
    expect(Math.hypot(near.x, near.y)).toBeGreaterThan(2); // the line width, so they read as two
    if (step + 1 < eastRiver.length) {
      // And the later route by twice as much — except at the last vertex, where East River turns
      // off into its slip and the mitre stretches its normal to hold the lane through the corner.
      expect(Math.hypot(far.x, far.y)).toBeCloseTo(
        2 * Math.hypot(near.x, near.y),
        1,
      );
    }
  }
});

// And the same property over the file the layer actually draws: New York's eight ferry routes, in
// the lane cells ./lines counts their company over. A lane is a sum over the routes that sort before
// this one of how present each of them is at that place, so where two routes are in one cell the
// later one's lane is a whole lane above the earlier one's — everywhere, not just here — which is
// what stops the ribbons weaving.
test("no two of New York's ferry routes swap lanes over the water they share", () => {
  const CELL_M = 60; // LANE_CELL_M, the grid ./lines counts a crossing's company over
  const file = readFileSync(`${import.meta.dir}/../../data/ferries/nyc.bin`);
  const data = decodeLines(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    "ferr",
  );
  // The same grid the layer laid the lanes out on, down to where its cells fall: a grid a fraction
  // of a cell out would compare two routes' lanes across the step between one cell and the next.
  const midLat =
    data.polylines.reduce((sum, { lats }) => sum + lats[0], 0) /
    data.polylines.length;
  const cellLat = CELL_M / METERS_PER_DEGREE_LAT;
  const cellLng = CELL_M / metersPerLng(midLat);

  // Per cell, the lanes each route holds at the vertices it has there. Routes are told apart by
  // their colour, which in this file is one per route.
  const cells = new Map<string, Map<string, number[]>>();
  data.polylines.forEach(({ lngs, lats }, index) => {
    const ribbon = data.ribbons?.[index];
    const route = ribbon?.color;
    for (let vertex = 0; vertex < lngs.length && route && ribbon; vertex++) {
      const key = `${Math.floor(lngs[vertex] / cellLng)},${Math.floor(lats[vertex] / cellLat)}`;
      const cell = cells.get(key) ?? new Map<string, number[]>();
      cells.set(
        key,
        cell.set(route, [...(cell.get(route) ?? []), ribbon.lanes[vertex]]),
      );
    }
  });

  const sides = new Map<string, Set<number>>();
  let shared = 0;
  for (const cell of cells.values()) {
    const routes = [...cell].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [first, [route, lanes]] of routes.entries()) {
      for (const [other, others] of routes.slice(first + 1)) {
        shared++;
        const gap = Math.min(...others) - Math.max(...lanes);
        const pair = `${route} ${other}`;
        sides.set(pair, (sides.get(pair) ?? new Set()).add(Math.sign(gap)));
        // Not merely ordered: a route is fully present in a cell it runs through, so the two are a
        // whole lane apart wherever they meet, and neither is drawn over the other.
        expect(Math.abs(gap)).toBeGreaterThanOrEqual(1);
      }
    }
  }
  expect(shared).toBeGreaterThan(50); // 71 in the committed file, so this cannot pass on nothing
  for (const [pair, taken] of sides) {
    expect([pair, taken.size]).toEqual([pair, 1]);
  }
});
