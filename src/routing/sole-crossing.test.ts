// What the router does when the boat is the ONLY way across.
//
// New York's ferries compete with bridges: bar them, or miss the last one, and the walk is longer.
// The Bay Area's do not. San Francisco and the East Bay are two land masses with no walking edge
// between them — nobody walks the Bay Bridge — so every ferry edge there is a cut edge of the
// graph, and three of the router's behaviours that never mattered before decide whether a crossing
// works at all:
//
//   - the search has to FIND it, with an A* heuristic that scales straight-line distance by the
//     least seconds a walked metre can cost. A boat crosses twelve kilometres in twenty-five
//     minutes, which is five times walking pace, so the walking estimate alone would exceed the
//     true cost and the heuristic would be inadmissible. The bounded ferry credit is what repairs
//     that, and this is the shape it has to survive.
//
//   - once the last boat has gone, the edge costs Infinity, and there is then no path at all. The
//     answer has to be no route — promptly, and without a walk over the water.
//
//   - the same when a boat exists but is further off than the ninety-minute wait cap, which for
//     SF Bay Ferry is the whole of the night: the real timetable's last sailing to Oakland leaves
//     at 21:20 and the first at 07:05, so a walk planned at two in the morning has no crossing.
//
// The graph is synthetic (src/routing/ferry.fixture.ts) because "the two halves are joined by one
// scheduled boat and nothing else" is a statement about the graph, not about anyone's geometry.

import { expect, test } from "bun:test";
import { buildTimetable, encodeTimetable } from "../../scripts/ferry-schedule";
import type { GtfsFeed, GtfsRow } from "../../scripts/gtfs";
import { buildGraph, snapAtNode, weights } from "./ferry.fixture";
import { decodeSchedule, resolveTimetable } from "./ferry-schedule";
import type { RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";

const WEST_TERMINAL = "West Ferry Building";
const EAST_TERMINAL = "East Ferry Terminal";

// Two land masses joined by one ferry. The west chain is nodes 0-2 and the east chain 3-5; the only
// edge between them is the ferry 2 -> 3, which is roughly the Ferry Building to Jack London Square
// both in bearing and in span.
const WEST_END = 0;
const EAST_END = 5;
const FERRY_EDGE = 2;
const WEST_WALK = 0; // walking edge 0 -> 1, for a snap at node 0
const EAST_WALK = 4; // walking edge 4 -> 5, for a snap at node 5
const CROSSING_SECONDS = 25 * 60;

const graph = buildGraph(
  [
    { lat: 37.7749, lng: -122.4394 }, // 0 west, a long walk in from the far side
    { lat: 37.7855, lng: -122.4058 }, // 1
    { lat: 37.7955, lng: -122.3937 }, // 2 west pier
    { lat: 37.7955, lng: -122.2777 }, // 3 east pier
    { lat: 37.8044, lng: -122.2712 }, // 4
    { lat: 37.8272, lng: -122.2513 }, // 5 east, a long walk out the far side
  ],
  [
    { a: 0, b: 1, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 1, b: 2, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 2, b: 3, ferry: true, cover: 0, durationSeconds: CROSSING_SECONDS },
    { a: 3, b: 4, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 4, b: 5, ferry: false, cover: 0.3, durationSeconds: 0 },
  ],
);
graph.ferryEndpointNames = new Map([
  [FERRY_EDGE, { a: WEST_TERMINAL, b: EAST_TERMINAL }],
]);

const start = snapAtNode(graph, WEST_END, WEST_WALK);
const dest = snapAtNode(graph, EAST_END, EAST_WALK);

// SF Bay Ferry's real weekday pattern between the Ferry Building and Oakland, as the committed
// timetable reads it: sailings from 07:05 to 21:20 and nothing overnight.
const SAILINGS = [
  "07:05",
  "08:20",
  "09:35",
  "11:20",
  "14:10",
  "16:00",
  "17:20",
  "18:30",
  "20:00",
  "21:20",
];

function feedOf(sailings: readonly string[]): GtfsFeed {
  const trips: GtfsRow[] = [];
  const stopTimes: GtfsRow[] = [];
  const clockOf = (seconds: number): string =>
    [seconds / 3600, (seconds / 60) % 60, seconds % 60]
      .map((part) => String(Math.floor(part)).padStart(2, "0"))
      .join(":");
  sailings.forEach((clock, index) => {
    for (const [from, to] of [
      ["west", "east"],
      ["east", "west"],
    ]) {
      const tripId = `${from}-${index}`;
      trips.push({ trip_id: tripId, route_id: "r", service_id: "daily" });
      const [hour, minute] = clock.split(":").map(Number);
      const departure = hour * 3600 + minute * 60;
      stopTimes.push({
        trip_id: tripId,
        stop_id: from,
        stop_sequence: "1",
        departure_time: clockOf(departure),
        arrival_time: clockOf(departure),
      });
      stopTimes.push({
        trip_id: tripId,
        stop_id: to,
        stop_sequence: "2",
        departure_time: clockOf(departure + CROSSING_SECONDS),
        arrival_time: clockOf(departure + CROSSING_SECONDS),
      });
    }
  });
  return {
    routes: [{ route_id: "r", route_type: "4", route_long_name: "Bay Line" }],
    trips,
    stops: [
      { stop_id: "west", stop_name: WEST_TERMINAL },
      { stop_id: "east", stop_name: EAST_TERMINAL },
    ],
    stopTimes,
    calendar: [
      {
        service_id: "daily",
        monday: "1",
        tuesday: "1",
        wednesday: "1",
        thursday: "1",
        friday: "1",
        saturday: "1",
        sunday: "1",
        start_date: "20260101",
        end_date: "20271231",
      },
    ],
    calendarDates: [],
    shapes: [],
    frequencies: [],
  };
}

// The timetable in effect at a wall clock on 2026-08-12, a Wednesday.
function departingAt(clock: string): RoutingGraph {
  const built = buildTimetable([
    { source: { id: "t" } as never, feed: feedOf(SAILINGS) },
  ]);
  const { record } = decodeSchedule(encodeTimetable(built, 20260101, 0));
  const [hour, minute] = clock.split(":").map(Number);
  graph.ferries = resolveTimetable(
    graph,
    record,
    new Date(2026, 7, 12, hour, minute),
  );
  return graph;
}

const routeWeights = weights(0.8, 0.1, true);

test("a crossing solves in service hours, walk then boat then walk", () => {
  const result = findRoute(departingAt("09:00"), start, dest, routeWeights);
  expect(result).not.toBeNull();
  const kinds = (result?.steps ?? []).map((step) => step.kind);
  expect(kinds.filter((kind) => kind === "ferry")).toHaveLength(1);
  // Walking on both sides of the one boat, which is what makes it a crossing rather than a pier
  // the route happens to end at.
  const boat = kinds.indexOf("ferry");
  expect(boat).toBeGreaterThan(0);
  expect(boat).toBeLessThan(kinds.length - 1);
});

test("the wait for the boat is in the reported time", () => {
  // The walk to the pier is the same in both — about an hour — so the difference is the pier. A
  // 06:00 departure reaches it in time for the 07:05; a 09:00 one arrives just after the 09:35 has
  // gone and stands there until 11:20.
  const early = findRoute(departingAt("06:00"), start, dest, routeWeights);
  const late = findRoute(departingAt("09:00"), start, dest, routeWeights);
  expect(early).not.toBeNull();
  expect(late).not.toBeNull();
  const walked = (result: RouteResult): number =>
    result.steps
      .filter((step) => step.kind !== "ferry")
      .reduce((sum, step) => sum + step.lengthMeters, 0);
  expect(walked(late as RouteResult)).toBeCloseTo(
    walked(early as RouteResult),
    0,
  );
  const extra =
    (late as RouteResult).travelSeconds - (early as RouteResult).travelSeconds;
  expect(extra).toBeGreaterThan(60 * 60);
});

test("after the last boat there is no route at all rather than a walk over the water", () => {
  // 22:30, past the 21:20 sailing; the next is 07:05, eight and a half hours off.
  const result = findRoute(departingAt("22:30"), start, dest, routeWeights);
  expect(result).toBeNull();
});

test("the wait cap is measured at the pier, not at the front door", () => {
  // The one boat everything below turns on is the 07:05, and the walk to the pier is about an hour.
  //
  // Leaving at 04:30 reaches the pier around 05:30 — ninety-five minutes to wait, past the cap, so
  // there is no crossing. Leaving fifteen minutes later reaches it at 05:45 and waits eighty, and
  // the same boat is now reachable. Which is the point: the cap is a bound on standing about, so it
  // is charged from the arrival at the terminal rather than from the departure instant, and a walk
  // long enough to close the gap is a walk that catches the boat.
  expect(findRoute(departingAt("04:30"), start, dest, routeWeights)).toBeNull();
  expect(
    findRoute(departingAt("04:45"), start, dest, routeWeights),
  ).not.toBeNull();
});

test("barring ferries leaves the two halves unreachable rather than walkable", () => {
  const barred = findRoute(
    departingAt("09:00"),
    start,
    dest,
    weights(0.8, 0.1, false),
  );
  expect(barred).toBeNull();
});

test("the search terminates on an unreachable destination without exploring for ever", () => {
  // The A* heuristic's ferry credit is built at zero wait, so it still promises a shortcut across
  // water no boat will carry anyone over tonight. A search that took that promise literally would
  // keep reopening pier nodes; this pins that it settles and answers.
  const started = performance.now();
  expect(findRoute(departingAt("02:00"), start, dest, routeWeights)).toBeNull();
  expect(performance.now() - started).toBeLessThan(1000);
});

test("the pier wait a region will bear is the region's own", () => {
  // 04:30 reaches the pier ninety-five minutes before the 07:05 — past New York's default, which is
  // set by a ferry that runs all night beside a bridge. Here the boat is the only way over, so the
  // same wait is the difference between a trip and a refusal, and the region says how long it will
  // stand about.
  const bay = departingAt("04:30");
  expect(findRoute(bay, start, dest, routeWeights)).toBeNull();

  bay.maxFerryWaitSeconds = 150 * 60;
  expect(findRoute(bay, start, dest, routeWeights)).not.toBeNull();

  // The bound moved rather than lifting: a wait past the region's own cap is still refused.
  bay.maxFerryWaitSeconds = 60 * 60;
  expect(findRoute(bay, start, dest, routeWeights)).toBeNull();
});
