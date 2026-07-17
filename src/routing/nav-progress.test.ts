import { expect, test } from "bun:test";
import type { Maneuver } from "./directions";
import { navProgress } from "./nav-progress";
import type { RouteResult } from "./search";

const METERS_PER_DEGREE_LAT = 111_320;

// An L-shaped route: north from A to B, then east from B to C. The maneuver lengths are set to the
// geodesic leg lengths so the along-route intervals line up with the polyline.
const START_LAT = 40.74;
const START_LNG = -73.99;
const CORNER_LAT = 40.741;
const EAST_LNG = -73.988;

const metersPerDegreeLng =
  METERS_PER_DEGREE_LAT * Math.cos((CORNER_LAT * Math.PI) / 180);
const northLegMeters = (CORNER_LAT - START_LAT) * METERS_PER_DEGREE_LAT;
const eastLegMeters = (EAST_LNG - START_LNG) * metersPerDegreeLng;

function makeManeuver(
  kind: Maneuver["kind"],
  lengthMeters: number,
  at: { lat: number; lng: number },
): Maneuver {
  return {
    kind,
    text: kind,
    name: null,
    side: null,
    turn: null,
    lengthMeters,
    stepRange: [0, 0],
    at,
  };
}

function makeRoute(): RouteResult {
  return {
    path: {
      lats: Float64Array.from([START_LAT, CORNER_LAT, CORNER_LAT]),
      lngs: Float64Array.from([START_LNG, START_LNG, EAST_LNG]),
    },
  } as unknown as RouteResult;
}

const maneuvers: Maneuver[] = [
  makeManeuver("start", northLegMeters, { lat: START_LAT, lng: START_LNG }),
  makeManeuver("turn", eastLegMeters, { lat: CORNER_LAT, lng: START_LNG }),
  makeManeuver("arrive", 0, { lat: CORNER_LAT, lng: EAST_LNG }),
];

test("a point near the start points at the first action with the right distance", () => {
  // A fifth of the way up the north leg.
  const along = northLegMeters / 5;
  const user = {
    lat: START_LAT + (CORNER_LAT - START_LAT) / 5,
    lng: START_LNG,
  };
  const progress = navProgress(makeRoute(), maneuvers, user);
  expect(progress).not.toBeNull();
  if (!progress) {
    throw new Error("expected progress");
  }
  expect(progress.currentManeuver).toBe(0);
  expect(progress.nextManeuver).toBe(1);
  expect(progress.offRouteMeters).toBeLessThan(1);
  expect(progress.alongMeters).toBeCloseTo(along, 1);
  expect(progress.distanceToNextMeters).toBeCloseTo(northLegMeters - along, 1);
});

test("a mid-route point sits in the second maneuver with arrive next", () => {
  // Halfway along the east leg.
  const user = { lat: CORNER_LAT, lng: (START_LNG + EAST_LNG) / 2 };
  const progress = navProgress(makeRoute(), maneuvers, user);
  expect(progress).not.toBeNull();
  if (!progress) {
    throw new Error("expected progress");
  }
  expect(progress.currentManeuver).toBe(1);
  expect(progress.nextManeuver).toBe(2);
  expect(progress.offRouteMeters).toBeLessThan(1);
  expect(progress.alongMeters).toBeCloseTo(
    northLegMeters + eastLegMeters / 2,
    1,
  );
  expect(progress.remainingMeters).toBeCloseTo(eastLegMeters / 2, 1);
});

test("distance to next decreases as the walker advances along the route", () => {
  const near = navProgress(makeRoute(), maneuvers, {
    lat: START_LAT + (CORNER_LAT - START_LAT) / 5,
    lng: START_LNG,
  });
  const far = navProgress(makeRoute(), maneuvers, {
    lat: START_LAT + (4 * (CORNER_LAT - START_LAT)) / 5,
    lng: START_LNG,
  });
  expect(near?.remainingMeters).toBeGreaterThan(far?.remainingMeters ?? 0);
});

test("a point far off the route returns null", () => {
  // ~1.1 km north of the corner, far beyond OFF_ROUTE_METERS.
  const user = { lat: CORNER_LAT + 0.01, lng: EAST_LNG };
  expect(navProgress(makeRoute(), maneuvers, user)).toBeNull();
});
