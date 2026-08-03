// What the router does over the whole city, measured on real trips rather than a fixture: the
// route-level companion to crates/tiler/src/invariants.rs, which holds every EDGE of the finished
// network to what an edge can be held to. It routes 400 trips in each of the five boroughs (2,000 in
// all) between the real tax lots of data/landuse/nyc.bin, by borough, so a borough-specific
// regression is visible instead of being averaged into the city. DESIGN.md, "What the whole city is
// held to", is why, and carries the calibration campaign every bound below was read off.
//
// WHERE THIS RUNS. Not in `bun test src`, and not in ordinary CI. It reads public/routing/nyc.bin,
// which is gitignored, ~37 MB and only exists after a `tiler graph` build, and two LFS files under
// data/ that standard CI deliberately checks out as pointers (see .github/workflows/build.yml — the
// LFS payload burned the account's whole bandwidth budget). So it runs on the manual deploy path,
// after `bun export` has built the graph, beside `bun run check-sheds`. `bun run test-routes` runs it
// locally against whatever graph is in public/routing.

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildLandTest } from "../scripts/land-filter";
import type { RouteWeights } from "../src/routing/cost";
import { decodeGraph, type RoutingGraph } from "../src/routing/graph";
import {
  type CrossingReversal,
  crossingReversals,
  detourRatio,
  longestCrossingRun,
} from "../src/routing/route-metrics";
import { findRoute } from "../src/routing/search";
import {
  buildSnapIndex,
  haversineMeters,
  SNAP_RADIUS_METERS,
  type SnapIndex,
  snapPair,
} from "../src/routing/snap";
import { DEFAULT_WEIGHTS } from "../src/url-state";

const ROOT = join(import.meta.dirname, "..");
const GRAPH_PATH = join(ROOT, "public/routing/nyc.bin");
const LAND_PATH = join(ROOT, "data/land/nyc.bin");
const LOTS_PATH = join(ROOT, "data/landuse/nyc.bin");

// Trips per borough. 400 puts the sampling error on a ~19% share at about 2 points, so a bound five
// or more points clear of the measurement is not chasing noise; 2,000 routes in all cost ~13 s.
const TRIPS_PER_BOROUGH = 400;
// The trip lengths a person actually walks: far enough that the route has to make choices, near
// enough that nobody would take the train instead. Straight-line, before any routing.
const MIN_TRIP_METERS = 400;
const MAX_TRIP_METERS = 2500;

// A walk must never be this much longer than the straight line between its ends. The structural
// floor is the grid itself: over uniformly-drawn directions a perfect rectangular grid walks 4/pi ~
// 1.273 times the straight line, and a shortest path over this network measures 1.22-1.34 by
// borough — essentially that. The app's default weights add scenic detours on top (1.31-1.42) and
// the strongest setting one slider can ask for reaches 1.48 on Staten Island. 1.50 clears the
// defaults by 0.08 on the worst borough and that strongest setting by 0.02; a build that crosses it
// is one where routes are systematically going round something.
const MAX_DETOUR_MEDIAN = 1.5;
// The same guard on the tail, where a route round a park, a rail cut or a highway lives. The 90th
// percentile rather than the 95th because the 95th is not stable at this sample size: over four
// seeds it moved by 0.3 on one borough, which would make a tight bound flap, where the 90th moved by
// 0.09. It measures 1.45-1.87 over the five boroughs at the app's defaults, so 2.00 is 0.13 clear of
// the worst — and the strongest setting one slider can ask for puts Staten Island at 2.19, well
// over, which is the gap this bound sits in.
const MAX_DETOUR_P90 = 2.0;

// The share of routes containing at least one AVOIDABLE reversal — one the network joined by some
// path of no more distance than the reversal itself spent, so the cost model BOUGHT it rather than
// being forced into it. This is the sharp bound, and it is calibrated from both sides:
//
//   every scenic weight at 0 (a plain shortest path)   0.0% in all five boroughs
//   the app's defaults                                 0.0-0.3%  (worst Brooklyn)
//   every scenic weight at 1 (the sliders' extreme)    0.0-15.8% (worst Manhattan)
//
// The zero-weight row has to be 0 — an avoidable reversal is strictly extra distance, so a shortest
// path can never take one — which is what says this measures the cost model and not the network. 3%
// is ten times the worst the defaults produce and below what the extreme produces in two boroughs,
// so the bound sits in a real gap rather than on top of today's number.
const MAX_AVOIDABLE_SHARE = 0.03;

// The share containing a reversal of ANY kind, forced ones included. Measured 26.0% in Brooklyn and
// 3.3% on Staten Island, 12.2% city-wide — the ~10% the browser agent reported. MOST OF IT IS NOT
// THE COST MODEL: with every scenic weight at zero, where a reversal is strictly extra distance and
// a shortest path would never buy one, Brooklyn still measures 12.5%, because the graph's own
// corners force it. (Drilled: Jerome Ave at E 21 St, where the two pavement ends of one corner are
// nodes 3.5 m apart with nothing joining them, so crossing out and back is the only way round.) So
// this bound is loose by necessity — a per-borough share that swings 7 points between seeds cannot
// carry a tight one — and the avoidable share above is what actually watches the cost model. 35% is
// 9 points clear of the worst borough measured.
const MAX_REVERSAL_SHARE = 0.35;
// City-wide the sampling error is ~0.7 points and the measurement 12.2%, so 15% is four standard
// errors clear.
const MAX_CITY_REVERSAL_SHARE = 0.15;

// The most crossing edges one route may traverse back to back. One is a plain street; two is a
// divided street, whose crossing is drawn as two ways chained through the traffic island — which is
// precisely why "a crossing goes kerb to kerb" cannot be checked edge by edge, since half of a
// median crossing looks exactly like a whole small one until a walk goes through it. A junction of
// several streets chains more: the worst measured over 2,000 city routes is 6, and the junctions
// drilled at that length — Broadway/W 70 St/Amsterdam Ave, Kings Hwy/Ave P/E 22 St — really do take
// that many legs. 8 leaves two legs of headroom over the most complicated junction in New York.
const MAX_CROSSING_RUN = 8;

// The smallest borough (Manhattan) holds ~37,000 of the 788,591 tax lots; anything near this floor
// means a borough was labelled onto the wrong polygon or a PLUTO refresh dropped one, which would
// otherwise show up as a suspiciously clean pass rather than as a failure.
const MIN_LOTS_PER_BOROUGH = 20_000;

// The five boroughs, each named by a point everyone would agree is in it: the polygon of
// data/land/nyc.bin containing it is that borough's mainland. The blob flattens the five boundary
// rows into 117 shoreline-clipped polygons and keeps no identity, so the labels have to come from
// somewhere; a landmark coordinate is checkable by eye in a way a polygon index is not.
const BOROUGH_LANDMARKS: readonly (readonly [string, Coord])[] = [
  ["Manhattan", { lat: 40.758, lng: -73.9855 }], // Times Square
  ["Bronx", { lat: 40.8448, lng: -73.8648 }], // Bronx Zoo
  ["Brooklyn", { lat: 40.6782, lng: -73.9442 }], // Bedford-Stuyvesant
  ["Queens", { lat: 40.7282, lng: -73.7949 }], // Jamaica
  ["Staten Island", { lat: 40.5795, lng: -74.1502 }], // St George
];

interface Coord {
  lat: number;
  lng: number;
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
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

// The header every `scripts/geometry.ts` blob starts with; the body that follows it is quantized
// against the origin and scale it carries.
function readHeader(bytes: Uint8Array, magic: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (found !== magic) {
    throw new Error(`not a ${magic} blob`);
  }
  return {
    view,
    count: view.getUint32(8, true),
    originLng: view.getFloat64(16, true),
    originLat: view.getFloat64(24, true),
    scale: view.getFloat64(32, true),
    bodyOffset: view.getUint16(6, true),
  };
}

// LAND: encodePolygons — per polygon a u16 ring count, then per ring a u32 vertex count and the
// zigzag-varint (x, y) deltas, restarting from the origin at each ring.
function decodeLandPolygons(bytes: Uint8Array): Coord[][][] {
  const head = readHeader(bytes, "LAND");
  const cursor = { offset: head.bodyOffset };
  const polygons: Coord[][][] = [];
  for (let polygon = 0; polygon < head.count; polygon++) {
    const ringCount = head.view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    const rings: Coord[][] = [];
    for (let ring = 0; ring < ringCount; ring++) {
      const vertexCount = head.view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      const vertices: Coord[] = new Array(vertexCount);
      let quantizedX = 0;
      let quantizedY = 0;
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        quantizedX += readVarint(bytes, cursor);
        quantizedY += readVarint(bytes, cursor);
        vertices[vertex] = {
          lng: head.originLng + quantizedX * head.scale,
          lat: head.originLat + quantizedY * head.scale,
        };
      }
      rings.push(vertices);
    }
    polygons.push(rings);
  }
  return polygons;
}

// PLUT: encodeClassifiedPoints — the zigzag-varint (x, y) deltas of every tax lot. The trailing
// land-use class byte per lot is not read here; a residence and a shop are both places people walk
// between, which is all this wants of them.
function decodeTaxLots(bytes: Uint8Array): Coord[] {
  const head = readHeader(bytes, "PLUT");
  const cursor = { offset: head.bodyOffset };
  const lots: Coord[] = new Array(head.count);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let lot = 0; lot < head.count; lot++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lots[lot] = {
      lng: head.originLng + quantizedX * head.scale,
      lat: head.originLat + quantizedY * head.scale,
    };
  }
  return lots;
}

// mulberry32, seeded per borough: the sample has to be the same on every run, or a bound near the
// measurement would pass and fail at random.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function percentileOf(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

interface TripFailure {
  reason: string;
  origin: Coord;
  dest: Coord;
}

interface BoroughResult {
  borough: string;
  routed: number;
  failures: TripFailure[];
  detours: number[]; // sorted
  reversalRoutes: number; // trips with at least one reversal, forced or bought
  avoidableRoutes: number; // trips with at least one the network offered a way round
  worstReversal: (CrossingReversal & { borough: string }) | null;
  worstAvoidable: (CrossingReversal & { borough: string }) | null;
  longestRun: number;
  longestRunAt: Coord | null;
  farthestSnapMeters: number;
}

// Route `count` trips between tax lots of one borough and reduce each to the three route metrics.
function measureBorough(
  borough: string,
  lots: readonly Coord[],
  graph: RoutingGraph,
  index: SnapIndex,
  weights: RouteWeights,
  count: number,
  seed: number,
): BoroughResult {
  const random = seededRandom(seed);
  const result: BoroughResult = {
    borough,
    routed: 0,
    failures: [],
    detours: [],
    reversalRoutes: 0,
    avoidableRoutes: 0,
    worstReversal: null,
    worstAvoidable: null,
    longestRun: 0,
    longestRunAt: null,
    farthestSnapMeters: 0,
  };
  const pick = (): Coord => lots[Math.floor(random() * lots.length)];
  let attempts = 0;
  while (result.routed < count && attempts < count * 40) {
    attempts += 1;
    const origin = pick();
    // A destination in the same borough at a walkable distance, by rejection — cheaper and less
    // biased than any index, since the band holds a large share of any borough's lots.
    let dest: Coord | null = null;
    for (let tries = 0; tries < 60 && dest === null; tries++) {
      const candidate = pick();
      const straight = haversineMeters(
        origin.lat,
        origin.lng,
        candidate.lat,
        candidate.lng,
      );
      if (straight >= MIN_TRIP_METERS && straight <= MAX_TRIP_METERS) {
        dest = candidate;
      }
    }
    if (dest === null) {
      continue;
    }
    result.routed += 1;

    const pair = snapPair(graph, index, origin, dest);
    if (!pair.ok) {
      result.failures.push({ reason: `snap ${pair.reason}`, origin, dest });
      continue;
    }
    result.farthestSnapMeters = Math.max(
      result.farthestSnapMeters,
      pair.start.distanceMeters,
      pair.dest.distanceMeters,
    );
    const route = findRoute(graph, pair.start, pair.dest, weights);
    if (route === null) {
      result.failures.push({ reason: "no route", origin, dest });
      continue;
    }

    const ratio = detourRatio(route);
    if (ratio !== null) {
      result.detours.push(ratio);
    }
    const reversals = crossingReversals(graph, route);
    if (reversals.length > 0) {
      result.reversalRoutes += 1;
    }
    if (reversals.some((reversal) => reversal.avoidable)) {
      result.avoidableRoutes += 1;
    }
    for (const reversal of reversals) {
      if (
        result.worstReversal === null ||
        reversal.crossedMeters > result.worstReversal.crossedMeters
      ) {
        result.worstReversal = { ...reversal, borough };
      }
      if (
        reversal.avoidable &&
        (result.worstAvoidable === null ||
          reversal.crossedMeters > result.worstAvoidable.crossedMeters)
      ) {
        result.worstAvoidable = { ...reversal, borough };
      }
    }
    const run = longestCrossingRun(route);
    if (run > result.longestRun) {
      result.longestRun = run;
      result.longestRunAt = pair.start.point;
    }
  }
  result.detours.sort((left, right) => left - right);
  return result;
}

async function readBlob(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error: unknown) {
    throw new Error(
      `${path} is unreadable, so the ${what} cannot be sampled. This suite runs on the deploy ` +
        `path, after \`bun export\` has built the graph and with the data/ LFS payload checked ` +
        `out; \`bun run test-routes\` runs it locally against the same files. (${error})`,
    );
  }
}

const [landBytes, lotBytes, graphBytes] = await Promise.all([
  readBlob(LAND_PATH, "borough boundaries"),
  readBlob(LOTS_PATH, "tax lots"),
  readBlob(GRAPH_PATH, "routing graph"),
]);

// Each borough's mainland: the land polygon its landmark falls in, as a point-in-polygon test.
const landPolygons = decodeLandPolygons(landBytes);
const polygonTests = landPolygons.map((polygon) => buildLandTest([polygon]));
const boroughTests = BOROUGH_LANDMARKS.map(([borough, landmark]) => {
  const test = polygonTests.find((inside) => inside(landmark));
  if (!test) {
    throw new Error(`no land polygon contains the ${borough} landmark`);
  }
  return { borough, inside: test };
});

const lotsByBorough = new Map<string, Coord[]>(
  BOROUGH_LANDMARKS.map(([borough]) => [borough, [] as Coord[]]),
);
for (const lot of decodeTaxLots(lotBytes)) {
  for (const { borough, inside } of boroughTests) {
    if (inside(lot)) {
      (lotsByBorough.get(borough) as Coord[]).push(lot);
      break;
    }
  }
}

const graph = decodeGraph(
  graphBytes.buffer.slice(
    graphBytes.byteOffset,
    graphBytes.byteOffset + graphBytes.byteLength,
  ) as ArrayBuffer,
  "",
);
const snapIndex = buildSnapIndex(graph);

// The app's own defaults, imported rather than restated so a retuned slider moves this sample with
// it — except that ferries are barred: a crossing would put a boat leg in a walk-versus-straight-line
// ratio that has no meaning, and both ends of every sampled trip are in one borough anyway.
const WEIGHTS: RouteWeights = { ...DEFAULT_WEIGHTS, allowFerries: false };

const measured = [...lotsByBorough].map(([borough, lots], index) =>
  measureBorough(
    borough,
    lots,
    graph,
    snapIndex,
    WEIGHTS,
    TRIPS_PER_BOROUGH,
    0x5ca1ab1e + index,
  ),
);

const percent = (share: number): string => `${(100 * share).toFixed(1)}%`;

test("every borough offers enough real addresses to sample from", () => {
  // A borough labelled onto the wrong polygon, or a PLUTO refresh that dropped a borough, would
  // otherwise show up as a suspiciously clean pass rather than as a failure.
  const thin = [...lotsByBorough]
    .filter(([, lots]) => lots.length < MIN_LOTS_PER_BOROUGH)
    .map(([borough, lots]) => `${borough}: ${lots.length} lots`);

  expect(thin).toEqual([]);

  const short = measured
    .filter((result) => result.routed < TRIPS_PER_BOROUGH)
    .map((result) => `${result.borough}: ${result.routed} trips sampled`);
  expect(short).toEqual([]);
});

test("a trip between two real addresses always routes", () => {
  // The graph's component check catches gross disconnection; this catches the rest — a lot whose
  // nearest pavement is out of snap range, or two lots the network cannot join. Every sampled point
  // is a real addressed parcel on land, so one failure is one address the app cannot serve.
  const failures = measured.flatMap((result) =>
    result.failures.map(
      (failure) =>
        `${result.borough}: ${failure.reason} for ${failure.origin.lat.toFixed(6)},${failure.origin.lng.toFixed(6)} -> ${failure.dest.lat.toFixed(6)},${failure.dest.lng.toFixed(6)}`,
    ),
  );

  expect(failures).toEqual([]);

  // How much room the snap radius has left: the farthest a sampled address sat from the pavement it
  // snapped to, against the radius itself. Measured 80 m against 300, i.e. 3.8x.
  const farthest = Math.max(
    ...measured.map((result) => result.farthestSnapMeters),
  );
  expect(farthest).toBeLessThan(SNAP_RADIUS_METERS / 2);
});

test("the walk is not far longer than the straight line, in any borough", () => {
  const over = measured
    .filter(
      (result) =>
        percentileOf(result.detours, 0.5) > MAX_DETOUR_MEDIAN ||
        percentileOf(result.detours, 0.9) > MAX_DETOUR_P90,
    )
    .map(
      (result) =>
        `${result.borough}: median ${percentileOf(result.detours, 0.5).toFixed(3)} (limit ${MAX_DETOUR_MEDIAN}), ` +
        `p90 ${percentileOf(result.detours, 0.9).toFixed(3)} (limit ${MAX_DETOUR_P90}) over ${result.detours.length} trips`,
    );

  expect(over).toEqual([]);
});

test("a route never buys a crossing reversal the network offered a way round", () => {
  // The sharp half of the property. A reversal the network joins by some path of no more distance
  // than the reversal itself spent was BOUGHT — the cost model paid two crossings for greener
  // pavement — and that is the cost-model artifact the browser agent was pointing at. Measured 1 of
  // 2,000 trips at the app's defaults; at the strongest setting the tree slider offers it is 0.3% of
  // trips in two boroughs, which is the gap this bound sits in.
  const over = measured
    .filter(
      (result) => result.avoidableRoutes / result.routed > MAX_AVOIDABLE_SHARE,
    )
    .map((result) => {
      const worst = result.worstAvoidable;
      return (
        `${result.borough}: ${percent(result.avoidableRoutes / result.routed)} of trips cross and cross back where ` +
        `the pavement joined the same two ends (limit ${percent(MAX_AVOIDABLE_SHARE)}), worst ` +
        `${worst?.name ?? "unnamed"} at ${worst?.at.lat.toFixed(6)},${worst?.at.lng.toFixed(6)} — ` +
        `${worst?.crossedMeters.toFixed(1)} m of roadway for ${worst?.walkBetweenMeters.toFixed(1)} m of pavement`
      );
    });

  expect(over).toEqual([]);
});

test("a route rarely crosses a street and crosses straight back at all", () => {
  // The blunt half: every reversal, forced ones included. Loose on purpose — most of this number is
  // the network's own corners rather than the cost model (see MAX_REVERSAL_SHARE), so it is a guard
  // against a gross change in either, not a tuning signal.
  const over = measured
    .filter(
      (result) => result.reversalRoutes / result.routed > MAX_REVERSAL_SHARE,
    )
    .map((result) => {
      const worst = result.worstReversal;
      return (
        `${result.borough}: ${percent(result.reversalRoutes / result.routed)} of trips reverse a crossing ` +
        `(limit ${percent(MAX_REVERSAL_SHARE)}), worst ${worst?.name ?? "unnamed"} at ` +
        `${worst?.at.lat.toFixed(6)},${worst?.at.lng.toFixed(6)} — ${worst?.crossedMeters.toFixed(1)} m of roadway ` +
        `for ${worst?.walkBetweenMeters.toFixed(1)} m of pavement`
      );
    });

  expect(over).toEqual([]);

  const routes = measured.reduce((sum, result) => sum + result.routed, 0);
  const reversing = measured.reduce(
    (sum, result) => sum + result.reversalRoutes,
    0,
  );
  expect(
    reversing / routes > MAX_CITY_REVERSAL_SHARE
      ? `city-wide ${percent(reversing / routes)} of trips reverse a crossing, over ${percent(MAX_CITY_REVERSAL_SHARE)}`
      : "",
  ).toBe("");
});

test("a crossing is traversed in one move", () => {
  // A divided street's crossing is two chained edges and a big junction is more, so this bounds the
  // run rather than forbidding it: what it rules out is a route threading roadway to roadway,
  // which is the shape a walk takes when it has stepped off the kerb and cannot get back on.
  const over = measured
    .filter((result) => result.longestRun > MAX_CROSSING_RUN)
    .map(
      (result) =>
        `${result.borough}: ${result.longestRun} crossings back to back (limit ${MAX_CROSSING_RUN}) on the trip from ` +
        `${result.longestRunAt?.lat.toFixed(6)},${result.longestRunAt?.lng.toFixed(6)}`,
    );

  expect(over).toEqual([]);
});
