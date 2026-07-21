import { afterAll, beforeAll, expect, test } from "bun:test";
import * as SunCalc from "suncalc";
import { declinationOf, hourAngleOf, seasonBand } from "../shade/sun";
import manifest from "../tree-cover/manifest.json";
import type { RoutingGraph } from "./graph";
import { computeEdgeShade, loadShadeBin, type ShadeBins } from "./shade";

// suncalc as shade.ts consumes it, replicated here so the test can predict the sun position for a date
// and place bins around it.
const sun = SunCalc as unknown as {
  getPosition: (
    date: Date,
    lat: number,
    lng: number,
  ) => { altitude: number; azimuth: number };
};
const [city] = manifest.cities;
const CENTRE_LAT = (city.bounds.north + city.bounds.south) / 2;
const CENTRE_LNG = (city.bounds.east + city.bounds.west) / 2;

function sunAt(date: Date): { elevation: number; azimuth: number } {
  const position = sun.getPosition(date, CENTRE_LAT, CENTRE_LNG);
  return {
    elevation: position.altitude,
    azimuth: ((position.azimuth % 360) + 360) % 360,
  };
}

const HEADER_BYTES = 12;
const EDGE_COUNT = 4;
const DAY = new Date("2026-07-19T16:30:00Z"); // ~12:30 EDT, sun well up over NYC
// ~23:00 EDT: dark at departure and still dark 4 h on, so the whole elapsed-time schedule is night
// (a departure whose forward window reached sunrise would bake a non-null, part-daylight field).
const NIGHT = new Date("2026-07-20T03:00:00Z");

// Encode one SHDB bin file: magic + u16 version + u16 pad + u32 edgeCount, then edgeCount signed bytes.
function buildBin(attrs: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + attrs.length);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes[0] = "S".charCodeAt(0);
  bytes[1] = "H".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "B".charCodeAt(0);
  view.setUint16(4, 1, true); // version
  view.setUint32(8, attrs.length, true);
  new Int8Array(buffer, HEADER_BYTES, attrs.length).set(attrs);
  return buffer;
}

// The sun for DAY, in the (declination, hourAngle) the bins are keyed on: two bins in its season band
// straddle its hour angle symmetrically (equal distance) and a third sits far off in the same band;
// the nearest two by hour angle are then bins 0 and 1, blended 50/50.
const daySun = sunAt(DAY);
const dayDecl = declinationOf(daySun.elevation, daySun.azimuth, CENTRE_LAT);
const dayHour = hourAngleOf(
  daySun.elevation,
  daySun.azimuth,
  CENTRE_LAT,
  dayDecl,
);
const daySeason = seasonBand(dayDecl);
const binFiles: Record<number, ArrayBuffer> = {
  0: buildBin([10, -20, 40, 0]),
  1: buildBin([30, -40, 60, 100]),
  2: buildBin([0, 0, 0, 0]),
};
const binsJson: ShadeBins = {
  edgeCount: EDGE_COUNT,
  bins: [
    {
      index: 0,
      season: daySeason,
      hourAngle: dayHour + 5,
      elevation: daySun.elevation,
      azimuth: daySun.azimuth,
    },
    {
      index: 1,
      season: daySeason,
      hourAngle: dayHour - 5,
      elevation: daySun.elevation,
      azimuth: daySun.azimuth,
    },
    {
      index: 2,
      season: daySeason,
      hourAngle: dayHour + 150,
      elevation: daySun.elevation,
      azimuth: daySun.azimuth,
    },
  ],
};

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "routing/shade/bins.json") {
      return Promise.resolve(new Response(JSON.stringify(binsJson)));
    }
    const match = url.match(/routing\/shade\/(\d+)\.bin$/);
    if (match) {
      const index = Number(match[1]);
      return Promise.resolve(new Response(binFiles[index]));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function makeGraph(edgeCount: number): RoutingGraph {
  return {
    edgeCount,
    shade: null,
  } as unknown as RoutingGraph;
}

test("loadShadeBin decodes a bin file to its signed attributes", async () => {
  const attr = await loadShadeBin(0);
  expect(Array.from(attr)).toEqual([10, -20, 40, 0]);
});

test("computeEdgeShade blends the two nearest bins inversely by distance at departure", async () => {
  expect(daySun.elevation).toBeGreaterThan(0.5); // precondition: the sun is up, so a blend is computed

  const graph = makeGraph(EDGE_COUNT);
  await computeEdgeShade(graph, DAY);

  expect(graph.shade).not.toBeNull();
  const shade = graph.shade as NonNullable<RoutingGraph["shade"]>;
  // At the departure instant (elapsed 0) bins 0 and 1 straddle the sun at equal distance, so the blend
  // is their average, /128.
  const expected = [20, -30, 50, 50].map((value) => value / 128);
  for (let edge = 0; edge < expected.length; edge++) {
    expect(shade.attrAt(edge, 0)).toBeCloseTo(expected[edge], 6);
  }
  // maxAbs is over every loaded bin row (0 and 1), not the departure blend: bin 1's 100 is the largest
  // magnitude. A convex blend of i8/128 stays < 1, so the admissible floor is safe.
  expect(shade.maxAbs).toBeCloseTo(100 / 128, 6);
  expect(shade.maxAbs).toBeLessThan(1);
});

test("computeEdgeShade advances the sun with elapsed walking time", async () => {
  const graph = makeGraph(EDGE_COUNT);
  await computeEdgeShade(graph, DAY);
  const shade = graph.shade as NonNullable<RoutingGraph["shade"]>;

  // Edge 3 reads 0 in bin 0 (the later, larger-hour-angle bin) and 100 in bin 1. As the walk elapses
  // the sun's hour angle grows toward bin 0, so the blend shifts off bin 1 toward 0 — a metre reached
  // an hour in is costed against a later sun than one reached at the start.
  const atStart = shade.attrAt(3, 0);
  const anHourIn = shade.attrAt(3, 3600);
  expect(atStart).toBeCloseTo(50 / 128, 6);
  expect(anHourIn).toBeLessThan(atStart - 0.05);
  expect(anHourIn).toBeGreaterThanOrEqual(0);
});

test("computeEdgeShade clears the field when the whole walk is below the horizon", async () => {
  expect(sunAt(NIGHT).elevation).toBeLessThanOrEqual(0.5); // precondition: it is night at departure

  const graph = makeGraph(EDGE_COUNT);
  graph.shade = { attrAt: () => 0.5, maxAbs: 0.5 }; // stale daytime field, to prove reset
  await computeEdgeShade(graph, NIGHT);

  expect(graph.shade).toBeNull();
});

test("computeEdgeShade asserts the manifest edge count matches the graph", async () => {
  await expect(
    computeEdgeShade(makeGraph(EDGE_COUNT + 1), DAY),
  ).rejects.toThrow();
});
