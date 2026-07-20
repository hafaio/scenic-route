import { afterAll, beforeAll, expect, test } from "bun:test";
import * as SunCalc from "suncalc";
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

const normAzimuth = (azimuth: number): number => ((azimuth % 360) + 360) % 360;

const HEADER_BYTES = 12;
const EDGE_COUNT = 4;
const DAY = new Date("2026-07-19T16:30:00Z"); // ~12:30 EDT, sun well up over NYC
const NIGHT = new Date("2026-07-19T06:00:00Z"); // ~02:00 EDT, sun below the horizon

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

// The sun for DAY, so two bins can straddle it symmetrically (equal angular distance) and a third can
// sit far off; the nearest two are then bins 0 and 1, blended 50/50.
const daySun = sunAt(DAY);
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
      elevation: daySun.elevation,
      azimuth: normAzimuth(daySun.azimuth + 5),
    },
    {
      index: 1,
      elevation: daySun.elevation,
      azimuth: normAzimuth(daySun.azimuth - 5),
    },
    {
      index: 2,
      elevation: daySun.elevation + 30,
      azimuth: normAzimuth(daySun.azimuth + 150),
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
    edgeShadeNow: null,
    maxAbsShadeNow: 0,
  } as unknown as RoutingGraph;
}

test("loadShadeBin decodes a bin file to its signed attributes", async () => {
  const attr = await loadShadeBin(0);
  expect(Array.from(attr)).toEqual([10, -20, 40, 0]);
});

test("computeEdgeShade awaits and blends the two nearest bins inversely by distance", async () => {
  expect(daySun.elevation).toBeGreaterThan(0.5); // precondition: the sun is up, so a blend is computed

  const graph = makeGraph(EDGE_COUNT);
  await computeEdgeShade(graph, DAY);

  expect(graph.edgeShadeNow).not.toBeNull();
  const shade = graph.edgeShadeNow as Float32Array;
  // Bins 0 and 1 straddle the sun at equal distance, so the blend is their average, /128.
  const expected = [20, -30, 50, 50].map((value) => value / 128);
  for (let edge = 0; edge < expected.length; edge++) {
    expect(shade[edge]).toBeCloseTo(expected[edge], 6);
  }
  // maxAbsShadeNow is the running max abs of the blend; a convex blend of i8/128 stays < 1.
  expect(graph.maxAbsShadeNow).toBeCloseTo(50 / 128, 6);
  expect(graph.maxAbsShadeNow).toBeLessThan(1);
});

test("computeEdgeShade clears the field below the horizon", async () => {
  expect(sunAt(NIGHT).elevation).toBeLessThanOrEqual(0.5); // precondition: it is night

  const graph = makeGraph(EDGE_COUNT);
  graph.edgeShadeNow = new Float32Array([0.5, -0.5, 0.5, -0.5]); // stale daytime field, to prove reset
  graph.maxAbsShadeNow = 0.5;
  await computeEdgeShade(graph, NIGHT);

  expect(graph.edgeShadeNow).toBeNull();
  expect(graph.maxAbsShadeNow).toBe(0);
});

test("computeEdgeShade asserts the manifest edge count matches the graph", async () => {
  await expect(
    computeEdgeShade(makeGraph(EDGE_COUNT + 1), DAY),
  ).rejects.toThrow();
});
