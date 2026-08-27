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
const DAY = new Date("2026-07-19T16:30:00Z"); // ~12:30 EDT, sun well up over NYC, canopy in leaf
const WINTER = new Date("2026-01-15T17:30:00Z"); // ~12:30 EST, sun up, canopy leaf-off
// ~23:00 EDT: dark at departure and still dark 4 h on, so the whole elapsed-time schedule is night
// (a departure whose forward window reached sunrise would bake a non-null, part-daylight field).
const NIGHT = new Date("2026-07-20T03:00:00Z");

// Encode one SHDB bin file: magic + u16 version + u16 pad + u32 edgeCount, then the building and tree
// occlusion rows, one unsigned byte per edge each.
function buildBin(buildings: number[], trees: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + buildings.length * 2);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes[0] = "S".charCodeAt(0);
  bytes[1] = "H".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "B".charCodeAt(0);
  view.setUint16(4, 2, true); // version
  view.setUint32(8, buildings.length, true);
  bytes.set(buildings, HEADER_BYTES);
  bytes.set(trees, HEADER_BYTES + buildings.length);
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
// Edge 0 sits under a building in both near bins, edge 1 under a crown in EVERY bin (so its blend is
// the same whichever bins are selected — what the seasonal test turns on), edge 2 only half-covered
// in bin 1, edge 3 in the open.
const binFiles: Record<number, ArrayBuffer> = {
  0: buildBin([255, 0, 0, 0], [0, 255, 0, 0]),
  1: buildBin([255, 0, 128, 0], [0, 255, 0, 0]),
  2: buildBin([0, 0, 0, 0], [0, 255, 0, 0]),
};
// A 90° elevation is a sun that never rises over NYC; it is here so each bin's derived intensity is
// exactly 1 and the composited bytes are hand-checkable. Only season/hourAngle select a bin.
const bin = (index: number, hourAngle: number) => ({
  index,
  season: daySeason,
  hourAngle,
  elevation: 90,
  azimuth: daySun.azimuth,
});
const binsJson: ShadeBins = {
  edgeCount: EDGE_COUNT,
  bins: [bin(0, dayHour + 5), bin(1, dayHour - 5), bin(2, dayHour + 150)],
};

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    // The city segment is what keeps two latitudes' bins apart; the default city is nyc.
    if (url === "routing/shade/nyc/bins.json") {
      return Promise.resolve(new Response(JSON.stringify(binsJson)));
    }
    const match = url.match(/routing\/shade\/nyc\/(\d+)\.bin$/);
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

test("loadShadeBin decodes a bin file to its two occlusion rows", async () => {
  const { buildings, trees } = await loadShadeBin(0);
  expect(Array.from(buildings)).toEqual([255, 0, 0, 0]);
  expect(Array.from(trees)).toEqual([0, 255, 0, 0]);
});

test("a rejected bin load only forgets itself", async () => {
  // A stalled fetch is evicted by the cache, a second fetch of the same bin succeeds, and only then
  // does the first one fail. Deleting by key alone would throw away the good entry it never owned.
  const outer = globalThis.fetch;
  let fetches = 0;
  let stall: ((error: Error) => void) | null = null;
  const stalled = new Promise<Response>((_, reject) => {
    stall = reject;
  });
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/9.bin")) {
      fetches += 1;
      return fetches === 1
        ? stalled
        : Promise.resolve(new Response(buildBin([1, 2, 3, 4], [0, 0, 0, 0])));
    }
    return Promise.resolve(new Response(buildBin([0, 0, 0, 0], [0, 0, 0, 0])));
  }) as typeof fetch;
  try {
    const first = loadShadeBin(9, "stalled");
    first.catch(() => undefined); // the rejection below is the point; it must not go unhandled
    // Past any capacity this cache is given, so the stalled entry is certainly gone.
    for (let filler = 0; filler < 40; filler += 1) {
      await loadShadeBin(0, `filler${filler}`);
    }
    expect(Array.from((await loadShadeBin(9, "stalled")).buildings)).toEqual([
      1, 2, 3, 4,
    ]);
    (stall as unknown as (error: Error) => void)(new Error("stalled"));
    await expect(first).rejects.toThrow("stalled");
    expect(Array.from((await loadShadeBin(9, "stalled")).buildings)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(fetches).toBe(2);
  } finally {
    globalThis.fetch = outer;
  }
});

test("computeEdgeShade composites the two occlusions and blends the nearest bins", async () => {
  expect(daySun.elevation).toBeGreaterThan(0.5); // precondition: the sun is up, so a blend is computed

  const graph = makeGraph(EDGE_COUNT);
  await computeEdgeShade(graph, DAY);

  expect(graph.shade).not.toBeNull();
  const shade = graph.shade as NonNullable<RoutingGraph["shade"]>;
  // At the departure instant (elapsed 0) bins 0 and 1 straddle the sun at equal distance, so each
  // edge is the average of the two bins' composited bytes, /128. Per bin, at intensity 1:
  //   edge 0: fully building-shaded in both, 1 - 2*1 = -1, clamped to -127.
  //   edge 1: fully crown-shaded in both; in-leaf tau 0.814 gives 1 - 2*0.814 = -0.628 -> -80.
  //   edge 2: open in bin 0 (+127); half building-shaded in bin 1, 1 - 2*(128/255) -> -1.
  //   edge 3: open in both, +127.
  const expected = [-127, -80, (127 - 1) / 2, 127].map((value) => value / 128);
  for (let edge = 0; edge < expected.length; edge++) {
    expect(shade.attrAt(edge, 0)).toBeCloseTo(expected[edge], 6);
  }
  // maxAbs bounds every bin's attributes by its own intensity (1 here), encoded: the admissible floor
  // needs an upper bound, and it must stay under 1.
  expect(shade.maxAbs).toBeCloseTo(127 / 128, 6);
  expect(shade.maxAbs).toBeLessThan(1);
});

test("computeEdgeShade applies the season's canopy transmittance", async () => {
  const graph = makeGraph(EDGE_COUNT);
  await computeEdgeShade(graph, DAY);
  const inLeaf = (graph.shade as NonNullable<RoutingGraph["shade"]>).attrAt(
    1,
    0,
  );
  await computeEdgeShade(graph, WINTER);
  const leafOff = (graph.shade as NonNullable<RoutingGraph["shade"]>).attrAt(
    1,
    0,
  );

  // Edge 1's crown covers it in every bin, so only tau moves between the two dates: in leaf it stops
  // 0.814 of the light (net shaded), leaf-off only 0.40 (net sunlit), off the same baked geometry.
  expect(inLeaf).toBeCloseTo(-80 / 128, 6);
  expect(leafOff).toBeCloseTo(26 / 128, 6);
});

test("computeEdgeShade advances the sun with elapsed walking time", async () => {
  const graph = makeGraph(EDGE_COUNT);
  await computeEdgeShade(graph, DAY);
  const shade = graph.shade as NonNullable<RoutingGraph["shade"]>;

  // Edge 2 is open in bin 0 (the later, larger-hour-angle bin) and half building-shaded in bin 1. As
  // the walk elapses the sun's hour angle grows toward bin 0, so the blend shifts off bin 1 toward 0 —
  // a metre reached an hour in is costed against a later sun than one reached at the start.
  const atStart = shade.attrAt(2, 0);
  const anHourIn = shade.attrAt(2, 3600);
  expect(atStart).toBeCloseTo(63 / 128, 6);
  expect(anHourIn).toBeGreaterThan(atStart + 0.05);
  expect(anHourIn).toBeLessThanOrEqual(127 / 128);
});

test("computeEdgeShade clears the field when the whole walk is below the horizon", async () => {
  expect(sunAt(NIGHT).elevation).toBeLessThanOrEqual(0.5); // precondition: it is night at departure

  const graph = makeGraph(EDGE_COUNT);
  // stale daytime field, to prove reset
  graph.shade = { attrAt: () => 0.5, intensityAt: () => 0.5, maxAbs: 0.5 };
  await computeEdgeShade(graph, NIGHT);

  expect(graph.shade).toBeNull();
});

test("computeEdgeShade asserts the manifest edge count matches the graph", async () => {
  await expect(
    computeEdgeShade(makeGraph(EDGE_COUNT + 1), DAY),
  ).rejects.toThrow();
});
