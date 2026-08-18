import { expect, test } from "bun:test";
import { unproject } from "./mercator";
import type { SubwayParams } from "./protocol";
import { decodeSubwayTiles, subwayRenderer } from "./subway";

// The subway's lanes are assigned per stretch of track, not once per route, so what these pin is
// that a route running alone draws on its own track and the same route inside a trunk does not —
// and, as for the ferries, that a line comes out at the same world position from either side of a
// tile seam.

const TILE_SIZE = 256;
const ORIGIN_LNG = -74.1;
const ORIGIN_LAT = 40.6;
const SCALE = 1e-6;
const TILE_X = 9650;
const TILE_Y = 12317;

type PathOp = { op: string; args: number[]; stroke: string };

function recordingContext(ops: PathOp[]): OffscreenCanvasRenderingContext2D {
  let pending: PathOp[] = [];
  const record = (op: string) => {
    return (...args: number[]) => {
      pending.push({ op, args, stroke: String(context.strokeStyle) });
    };
  };
  const context = {
    lineWidth: 0,
    lineJoin: "",
    lineCap: "",
    strokeStyle: "",
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    beginPath: () => {
      pending = [];
    },
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    bezierCurveTo: record("bezierCurveTo"),
    arc: record("arc"),
    fill: () => {},
    stroke: () => {
      ops.push(...pending);
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
    strokeText: () => {},
    fillText: () => {},
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

interface Route {
  color: string; // six hex digits
  shortName: string;
  lines: readonly (readonly { lng: number; lat: number }[])[];
}

interface Station {
  lng: number;
  lat: number;
  name: string;
  routes: number;
}

// The SBWY layout of scripts/README.md: a 60-byte header, the route/line/station tables, then the
// varint geometry and the shared name blob.
function encodeSbwy(
  routes: readonly Route[],
  stations: readonly Station[],
): ArrayBuffer {
  const HEADER_BYTES = 60;
  const encoder = new TextEncoder();
  const names: string[] = [];
  const nameId = (name: string) => {
    const seen = names.indexOf(name);
    return seen < 0 ? names.push(name) - 1 : seen;
  };
  const quantize = (value: number, origin: number) =>
    Math.round((value - origin) / SCALE);

  const geometry: number[] = [];
  const lineRecords: { offset: number; count: number; route: number }[] = [];
  const routeRecords: {
    color: string;
    short: number;
    long: number;
    first: number;
    count: number;
  }[] = [];
  for (const [index, route] of routes.entries()) {
    const first = lineRecords.length;
    for (const points of route.lines) {
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
      lineRecords.push({ offset, count: points.length, route: index });
    }
    routeRecords.push({
      color: route.color,
      short: nameId(route.shortName),
      long: nameId(`${route.shortName} line`),
      first,
      count: lineRecords.length - first,
    });
  }
  const stationRecords = stations.map((station) => ({
    ...station,
    nameId: nameId(station.name),
  }));

  const routeTable = HEADER_BYTES;
  const lineTable = routeTable + routeRecords.length * 16;
  const stationTable = lineTable + lineRecords.length * 8;
  const geometryOffset = stationTable + stationRecords.length * 16;
  const nameOffset = geometryOffset + Math.ceil(geometry.length / 4) * 4;
  const encoded = names.map((name) => encoder.encode(name));
  const nameBytes = encoded.reduce((total, name) => total + 2 + name.length, 4);

  const buffer = new ArrayBuffer(nameOffset + nameBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(encoder.encode("SBWY"));
  view.setUint16(4, 2, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, routeRecords.length, true);
  view.setUint32(12, lineRecords.length, true);
  view.setFloat64(16, ORIGIN_LNG, true);
  view.setFloat64(24, ORIGIN_LAT, true);
  view.setFloat64(32, SCALE, true);
  view.setUint32(40, stationRecords.length, true);
  view.setUint32(44, geometryOffset, true);
  view.setUint32(48, geometry.length, true);
  view.setUint32(52, nameOffset, true);
  view.setUint32(56, nameBytes, true);

  routeRecords.forEach(({ color, short, long, first, count }, index) => {
    const record = routeTable + index * 16;
    for (let channel = 0; channel < 3; channel++) {
      bytes[record + channel] = Number.parseInt(
        color.slice(channel * 2, channel * 2 + 2),
        16,
      );
      bytes[record + 3 + channel] = 0xff;
    }
    view.setUint16(record + 6, short, true);
    view.setUint16(record + 8, long, true);
    view.setUint16(record + 10, first, true);
    view.setUint16(record + 12, count, true);
    view.setUint16(record + 14, index, true);
  });
  lineRecords.forEach(({ offset, count, route }, index) => {
    const record = lineTable + index * 8;
    view.setUint32(record, offset, true);
    view.setUint16(record + 4, count, true);
    view.setUint16(record + 6, route, true);
  });
  stationRecords.forEach(({ lng, lat, nameId: name, routes: mask }, index) => {
    const record = stationTable + index * 16;
    view.setInt32(record, quantize(lng, ORIGIN_LNG), true);
    view.setInt32(record + 4, quantize(lat, ORIGIN_LAT), true);
    view.setUint32(record + 8, name, true);
    view.setUint32(record + 12, mask, true);
  });
  bytes.set(geometry, geometryOffset);
  let cursor = nameOffset;
  view.setUint32(cursor, names.length, true);
  cursor += 4;
  for (const name of encoded) {
    view.setUint16(cursor, name.length, true);
    bytes.set(name, cursor + 2);
    cursor += 2 + name.length;
  }
  return buffer;
}

// A line running east along a fixed row of tiles, sampled every 40 pixels — close enough that
// consecutive vertices land in different trunk cells, as a real shape's 46.6 m spacing does.
function eastward(
  zoom: number,
  fromStep: number,
  toStep: number,
): { lng: number; lat: number }[] {
  const startX = TILE_X * TILE_SIZE;
  const startY = TILE_Y * TILE_SIZE;
  const points = [];
  for (let step = fromStep; step <= toStep; step++) {
    points.push(unproject(startX + step * 40, startY, zoom));
  }
  return points;
}

const params: SubwayParams = { kind: "subway", url: "test" };

function drawTile(
  data: ReturnType<typeof decodeSubwayTiles>,
  tileX: number,
  tileY: number,
  zoom: number,
): PathOp[] {
  const ops: PathOp[] = [];
  subwayRenderer.draw(
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

test("neighbouring tiles draw a line at the same world position", () => {
  const zoom = 16;
  const data = decodeSubwayTiles(
    encodeSbwy(
      [{ color: "009952", shortName: "6", lines: [eastward(zoom, 0, 14)] }],
      [],
    ),
  );
  const left = drawTile(data, TILE_X, TILE_Y, zoom);
  const right = drawTile(data, TILE_X + 1, TILE_Y, zoom);
  expect(left.length).toBeGreaterThan(1);
  for (const [index, op] of left.entries()) {
    expect(op.op).toBe(right[index].op);
    expect(op.stroke).toBe(right[index].stroke);
    for (const [axis, value] of op.args.entries()) {
      expect(value).toBeCloseTo(right[index].args[axis], 6);
    }
  }
});

test("routes take the colour the feed publishes for them", () => {
  const zoom = 16;
  const data = decodeSubwayTiles(
    encodeSbwy(
      [
        { color: "009952", shortName: "6", lines: [eastward(zoom, 0, 14)] },
        { color: "d82233", shortName: "1", lines: [eastward(zoom, 0, 14)] },
      ],
      [],
    ),
  );
  const strokes = new Set(
    drawTile(data, TILE_X, TILE_Y, zoom).map(({ stroke }) => stroke),
  );
  expect(strokes).toEqual(new Set(["#009952", "#d82233"]));
});

// The whole point of assigning lanes per stretch: a route sharing a trunk moves off the track to
// make room, and the same route past the junction goes back onto it.
test("a route takes a lane in a trunk and its own track alone", () => {
  const zoom = 16;
  const shared = 6; // the trunk both routes run, in eastward()'s steps
  const data = decodeSubwayTiles(
    encodeSbwy(
      [
        {
          color: "009952",
          shortName: "4",
          lines: [eastward(zoom, 0, shared + 14)],
        },
        { color: "d82233", shortName: "1", lines: [eastward(zoom, 0, shared)] },
      ],
      [],
    ),
  );
  const drawn = drawTile(data, TILE_X, TILE_Y, zoom);
  const trunkY = TILE_Y * TILE_SIZE;
  const lane = (stroke: string, atX: number) => {
    const nearest = drawn
      .filter((op) => op.stroke === stroke && op.op === "bezierCurveTo")
      .map(({ args }) => ({ x: args[4], y: args[5] }))
      .reduce((best, point) =>
        Math.abs(point.x - atX) < Math.abs(best.x - atX) ? point : best,
      );
    return nearest.y - trunkY;
  };
  const startX = TILE_X * TILE_SIZE;
  // Inside the trunk the two are a lane apart, and neither is on the track the other holds.
  expect(
    Math.abs(lane("#009952", startX) - lane("#d82233", startX)),
  ).toBeGreaterThan(2);
  // Well past where the 1 stops, the 4 is back on its own track.
  expect(Math.abs(lane("#009952", startX + (shared + 12) * 40))).toBeLessThan(
    0.5,
  );
});

test("stations are drawn as markers only once the map can separate them", () => {
  const zoom = 16;
  const [stop] = eastward(zoom, 3, 3); // inside the tile the markers are counted in
  const data = decodeSubwayTiles(
    encodeSbwy(
      [{ color: "009952", shortName: "6", lines: [eastward(zoom, 0, 14)] }],
      [{ lng: stop.lng, lat: stop.lat, name: "51 St", routes: 1 }],
    ),
  );
  const markers = (at: number) =>
    drawTile(data, TILE_X, TILE_Y, at).filter(({ op }) => op === "arc").length;
  expect(markers(zoom)).toBe(1);
  expect(markers(12)).toBe(0);
});
