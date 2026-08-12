// Turn-by-turn directions: a pure function of the labeled step sequence, no React or Leaflet. The
// A* result carries, per step, its kind ("sidewalk"|"crossing"|"link"|"path"), stored side, raw
// street name, cover, and walked length; directions are assembled from those plus the step geometry
// (for bearings and the maneuver anchor). Grouping collapses steps into runs, then emission turns
// runs into human maneuvers.

import { edgeName, edgePath, type RoutingGraph, type SideLabel } from "./graph";
import type { PassedPoi } from "./pois";
import {
  type RouteResult,
  type RouteStep,
  stepFrom,
  stepSeconds,
} from "./search";
import { prettifyStreetName } from "./street-names";

export type Turn =
  | "left"
  | "right"
  | "slight left"
  | "slight right"
  | "around"
  | null;

export interface Maneuver {
  kind:
    | "start"
    | "continue"
    | "turn"
    | "cross"
    | "path"
    | "ferry"
    | "arrive"
    | "landmark" // a POI passed along the route, spliced in between the walking maneuvers
    | "art";
  text: string; // assembled, prettified, ready to render
  name: string | null; // prettified street name
  side: SideLabel;
  turn: Turn;
  lengthMeters: number; // walked length this maneuver covers
  durationSeconds?: number; // a ferry leg's crossing time, shown where a walk shows its distance
  stepRange: [number, number]; // half-open indexes into RouteResult.steps
  at: { lat: number; lng: number };
}

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;
const FEET_ROUNDING = 50;

// Miles at one decimal from 0.1 mi up, else feet rounded to the nearest 50 (never below 50 for a
// real walked leg, so a short crossing never reads "0 ft").
export function formatDistance(meters: number): string {
  const miles = meters / METERS_PER_MILE;
  if (miles >= 0.1) {
    return `${miles.toFixed(1)} mi`;
  }
  const feet =
    Math.round(meters / METERS_PER_FOOT / FEET_ROUNDING) * FEET_ROUNDING;
  return `${Math.max(FEET_ROUNDING, feet)} ft`;
}

// A ferry leg's crossing time, shown in the same slot a walking leg shows its distance.
export function formatDuration(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

const COMPASS_8: readonly string[] = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
];

// Compass bearing (0 = north, clockwise) of the great-circle segment; the short legs here make the
// spherical formula and a flat one agree to well within a degree.
function bearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = Math.PI / 180;
  const deltaLng = (lng2 - lng1) * toRad;
  const y = Math.sin(deltaLng) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// Signed turn from bearing `from` to bearing `to`, in (-180, 180]; positive is clockwise (a right).
function signedTurn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function compass8(deg: number): string {
  return COMPASS_8[Math.round(deg / 45) % 8];
}

// A step's polyline in travel order (edge geometry is stored a -> b; a reverse step walks it b -> a).
function stepTravelPoints(
  graph: RoutingGraph,
  step: RouteStep,
): { lngs: number[]; lats: number[] } {
  const { lngs, lats } = edgePath(graph, step.edge);
  if (step.forward) {
    return { lngs: Array.from(lngs), lats: Array.from(lats) };
  }
  return { lngs: Array.from(lngs).reverse(), lats: Array.from(lats).reverse() };
}

// One run: a maximal group of same-labeled steps, with its travel polyline retained for bearings and
// the maneuver anchor.
interface Run {
  kind: "sidewalk" | "crossing" | "path" | "ferry";
  name: string | null; // raw, unprettified
  side: SideLabel;
  stepStart: number;
  stepEnd: number; // half-open
  lengthMeters: number;
  durationSeconds: number; // summed ferry crossing seconds; 0 for walking runs
  ferryRoute: string | null; // a ferry run's route display name (its first edge's), else null
  ferryDest: string | null; // a ferry run's destination terminal (its final edge's), else null
  // A ferry run's boarding time, seconds from midnight of the departure day: the sailing the walker
  // actually catches, so the maneuver can name it. Null with no timetable loaded, where the graph's
  // baked figure is an average wait rather than a departure.
  ferryDeparture: number | null;
  lngs: number[];
  lats: number[];
}

// A ferry step's destination terminal: node b when travelled a -> b, else node a.
function ferryDestName(graph: RoutingGraph, step: RouteStep): string | null {
  const ends = graph.ferryEndpointNames.get(step.edge);
  if (!ends) {
    return null;
  }
  return step.forward ? ends.b : ends.a;
}

// A sailing's departure as a 12-hour clock label. Seconds run from midnight of the DEPARTURE day, so
// a boat after midnight reads past 86400 and wraps back to a small hour here.
function formatDeparture(seconds: number): string {
  const minutes = Math.round(seconds / 60) % 1440;
  const hour = Math.floor(minutes / 60);
  const period = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minutes % 60).padStart(2, "0")} ${period}`;
}

// Strip a trailing " Ferry Terminal" or " Ferry" from a terminal name for the maneuver destination:
// "St. George Ferry Terminal" -> "St. George", while "Wall St/Pier 11" is left alone.
function stripTerminalSuffix(name: string): string {
  return name.replace(/\s+Ferry Terminal$/i, "").replace(/\s+Ferry$/i, "");
}

function sameRunKey(run: Run, step: RouteStep): boolean {
  if (run.kind !== step.kind) {
    return false;
  }
  if (step.kind === "sidewalk") {
    return run.name === step.name && run.side === step.side;
  }
  // crossings and paths merge on name alone (a divided road is one "Cross ...").
  return run.name === step.name;
}

function appendPoints(
  run: Run,
  points: { lngs: number[]; lats: number[] },
): void {
  // Drop the shared junction vertex where this step meets the previous one.
  const skipFirst = run.lngs.length > 0;
  for (let index = 0; index < points.lngs.length; index++) {
    if (skipFirst && index === 0) {
      continue;
    }
    run.lngs.push(points.lngs[index]);
    run.lats.push(points.lats[index]);
  }
}

// Collapse steps into runs. Link steps are silent — their length is absorbed into the run they touch
// and they contribute no maneuver.
function buildRuns(graph: RoutingGraph, steps: RouteStep[]): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  let pendingLinkMeters = 0;
  // How far into the trip each step is reached, which is what picks a ferry's sailing. It has to be
  // the SAME clock the ETA summary runs (hence the shared `stepSeconds`), or the two disagree about
  // which boat is caught and the maneuver names a sailing the reported time never allowed for.
  let elapsedSeconds = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const reachedAt = elapsedSeconds;
    elapsedSeconds += stepSeconds(graph, step, reachedAt);
    // A ferry is its own run: flush any open walk run, then start (or extend) a ferry run. Its
    // crossing seconds sum onto the run so the maneuver can report the ride time.
    if (step.kind === "ferry") {
      if (current) {
        runs.push(current);
        current = null;
      }
      const last = runs[runs.length - 1];
      const points = stepTravelPoints(graph, step);
      const sailing =
        graph.ferries?.board(step.edge, stepFrom(graph, step), reachedAt) ??
        null;
      // The ride time the maneuver reports is the crossing alone — the wait before it belongs to the
      // walk up to the pier, not to the leg — falling back to the baked crossing-plus-average-wait
      // figure when no timetable is loaded.
      const rideSeconds =
        sailing?.crossing ?? graph.edgeDurationSeconds[step.edge];
      // A ferry line calls at several piers, and each pier-to-pier leg is its own edge — but you
      // board once, so those legs are one maneuver. Still aboard means the timetable put you on the
      // same line with nothing to wait for; a wait, or a different line, is a CHANGE OF BOAT and gets
      // its own maneuver rather than disappearing into the previous one. With no timetable loaded
      // there is no sailing to compare, and consecutive legs merge as they always did.
      const stillAboard =
        last?.kind === "ferry" &&
        (!sailing || (sailing.route === last.ferryRoute && sailing.wait === 0));
      if (last && last.kind === "ferry" && stillAboard) {
        last.lengthMeters += step.lengthMeters;
        last.durationSeconds += rideSeconds;
        last.stepEnd = index + 1;
        // The run keeps its first edge's route; the destination advances to this edge's terminal.
        last.ferryDest = ferryDestName(graph, step);
        appendPoints(last, points);
      } else {
        const ferryRun: Run = {
          kind: "ferry",
          name: null,
          side: null,
          stepStart: index,
          stepEnd: index + 1,
          lengthMeters: step.lengthMeters,
          durationSeconds: rideSeconds,
          // The route the timetable says is sailing beats the edge's own name: a stop pair several
          // routes serve is one graph edge carrying whichever route the ingest picked as primary.
          ferryRoute: sailing?.route ?? edgeName(graph, step.edge),
          ferryDest: ferryDestName(graph, step),
          ferryDeparture: sailing?.departure ?? null,
          lngs: [],
          lats: [],
        };
        appendPoints(ferryRun, points);
        runs.push(ferryRun);
      }
      continue;
    }
    if (step.kind === "link") {
      if (current) {
        current.lengthMeters += step.lengthMeters;
      } else {
        pendingLinkMeters += step.lengthMeters;
      }
      continue;
    }
    if (current && sameRunKey(current, step)) {
      current.lengthMeters += step.lengthMeters;
      current.stepEnd = index + 1;
      appendPoints(current, stepTravelPoints(graph, step));
    } else {
      if (current) {
        runs.push(current);
      }
      current = {
        kind: step.kind,
        name: step.name,
        side: step.side,
        stepStart: index,
        stepEnd: index + 1,
        lengthMeters: step.lengthMeters + pendingLinkMeters,
        durationSeconds: 0,
        ferryRoute: null,
        ferryDest: null,
        ferryDeparture: null,
        lngs: [],
        lats: [],
      };
      pendingLinkMeters = 0;
      appendPoints(current, stepTravelPoints(graph, step));
    }
  }
  if (current) {
    runs.push(current);
  }
  return runs;
}

function firstBearing(run: Run): number | null {
  const { lngs, lats } = run;
  for (let index = 1; index < lngs.length; index++) {
    if (lngs[index] !== lngs[0] || lats[index] !== lats[0]) {
      return bearing(lats[0], lngs[0], lats[index], lngs[index]);
    }
  }
  return null;
}

function lastBearing(run: Run): number | null {
  const { lngs, lats } = run;
  const end = lngs.length - 1;
  for (let index = end - 1; index >= 0; index--) {
    if (lngs[index] !== lngs[end] || lats[index] !== lats[end]) {
      return bearing(lats[index], lngs[index], lats[end], lngs[end]);
    }
  }
  return null;
}

function chordBearing(run: Run): number | null {
  const { lngs, lats } = run;
  const end = lngs.length - 1;
  if (end < 1) {
    return firstBearing(run);
  }
  return bearing(lats[0], lngs[0], lats[end], lngs[end]);
}

function runStart(run: Run): { lat: number; lng: number } {
  return { lat: run.lats[0], lng: run.lngs[0] };
}

function runEnd(run: Run): { lat: number; lng: number } {
  const end = run.lngs.length - 1;
  return { lat: run.lats[end], lng: run.lngs[end] };
}

// "the west side of 5th Avenue" / "5th Avenue" / "the west side" / null, from a side and raw name.
function descriptor(side: SideLabel, prettyName: string | null): string | null {
  if (prettyName && side) {
    return `the ${side} side of ${prettyName}`;
  }
  if (prettyName) {
    return prettyName;
  }
  if (side) {
    return `the ${side} side`;
  }
  return null;
}

// A crossing is "linear" when the walking run immediately before it and immediately after it are the
// same street and side — you keep walking the same street+side across it, so it carries no action. A
// crossing is otherwise an "action" (a turn onto a new street, or a switch to the other side).
function crossingIsLinear(runs: Run[], index: number): boolean {
  const before = runs[index - 1];
  const after = runs[index + 1];
  if (!before || !after) {
    return false;
  }
  if (before.kind !== "sidewalk" || after.kind !== "sidewalk") {
    return false;
  }
  return before.name === after.name && before.side === after.side;
}

function classifyTurn(delta: number): { turn: Turn; word: string } {
  const magnitude = Math.abs(delta);
  const hand = delta > 0 ? "right" : "left";
  if (magnitude < 25) {
    return { turn: null, word: "Continue" };
  }
  if (magnitude <= 60) {
    return { turn: `slight ${hand}` as Turn, word: `Slight ${hand}` };
  }
  if (magnitude <= 150) {
    return { turn: hand as Turn, word: `Turn ${hand}` };
  }
  return { turn: "around", word: "Turn around" };
}

// A passed POI as its own maneuver: "Pass <name>", anchored at the POI, sharing the step it is
// nearest so the render can key on it. It carries no distance and no turn.
function poiManeuver(poi: PassedPoi): Maneuver {
  return {
    kind: poi.kind,
    text: `Pass ${poi.name}`,
    name: poi.name,
    side: null,
    turn: null,
    lengthMeters: 0,
    stepRange: [poi.stepIndex, poi.stepIndex],
    at: poi.at,
  };
}

// Splice each passed POI in after the maneuver whose run contains its nearest step, so a landmark or
// artwork shows up at the point of the walk where you actually reach it. Ties within one maneuver are
// ordered by step; identical names within a maneuver collapse to the first.
function interleavePois(
  maneuvers: Maneuver[],
  passed: readonly PassedPoi[],
): Maneuver[] {
  if (passed.length === 0) {
    return maneuvers;
  }
  const following = new Map<number, PassedPoi[]>();
  for (const poi of passed) {
    let host = 0;
    for (let index = 0; index < maneuvers.length; index++) {
      if (maneuvers[index].stepRange[0] <= poi.stepIndex) {
        host = index;
      } else {
        break;
      }
    }
    const bucket = following.get(host);
    if (bucket) {
      bucket.push(poi);
    } else {
      following.set(host, [poi]);
    }
  }
  const merged: Maneuver[] = [];
  for (let index = 0; index < maneuvers.length; index++) {
    merged.push(maneuvers[index]);
    const bucket = following.get(index);
    if (!bucket) {
      continue;
    }
    bucket.sort((left, right) => left.alongMeters - right.alongMeters);
    const seen = new Set<string>();
    for (const poi of bucket) {
      if (seen.has(poi.name)) {
        continue;
      }
      seen.add(poi.name);
      merged.push(poiManeuver(poi));
    }
  }
  return merged;
}

export function buildDirections(
  graph: RoutingGraph,
  result: RouteResult,
  {
    collapseLinearCrossings = false,
    passed = [],
  }: {
    collapseLinearCrossings?: boolean;
    passed?: readonly PassedPoi[];
  } = {},
): Maneuver[] {
  const runs = buildRuns(graph, result.steps);
  const maneuvers: Maneuver[] = [];
  if (runs.length === 0) {
    return maneuvers;
  }

  // The last emitted walking run, for the next turn's reference bearing and the suppression check —
  // a crossing does not update it, so a turn after a crossing is measured from the walk before it.
  let lastWalk: Run | null = null;
  let lastCrossIndex = -1; // index in `maneuvers` of the crossing that a suppressed run folds into
  // Index in `maneuvers` of the walk maneuver the current straight segment belongs to, so a collapsed
  // linear crossing and the walk after it extend it in place instead of emitting anything.
  let walkManeuverIndex = -1;

  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex];
    const prettyName = run.name ? prettifyStreetName(run.name) : null;

    // A ferry leg is a standalone maneuver reporting the crossing time; it carries no turn and its
    // span isn't a walked distance, so the walk-tracking state resets and the leg after it starts a
    // fresh "Walk ..." rather than turning off the ferry's bearing.
    if (run.kind === "ferry") {
      const dest = run.ferryDest ? stripTerminalSuffix(run.ferryDest) : null;
      // "Take the {route} ferry to {dest}", or "Take the {route} to {dest}" when the route name
      // already ends in "Ferry"; falls back to the generic phrasing if the data lacks the names. The
      // crossing time rides in durationSeconds, rendered where a walking maneuver shows its distance.
      let text: string;
      if (run.ferryRoute && dest) {
        // With a timetable the sailing is named: "Take the 4:40 PM East River ferry to ...".
        const at =
          run.ferryDeparture === null
            ? ""
            : `${formatDeparture(run.ferryDeparture)} `;
        const lead = /ferry$/i.test(run.ferryRoute)
          ? `Take the ${at}${run.ferryRoute}`
          : `Take the ${at}${run.ferryRoute} ferry`;
        text = `${lead} to ${dest}`;
      } else {
        text = "Take the ferry";
      }
      maneuvers.push({
        kind: "ferry",
        text,
        name: null,
        side: null,
        turn: null,
        lengthMeters: run.lengthMeters,
        durationSeconds: run.durationSeconds,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastWalk = null;
      walkManeuverIndex = -1;
      lastCrossIndex = -1;
      continue;
    }

    if (run.kind === "crossing") {
      // A linear crossing carries no action: when collapsing, fold its length into the current walk
      // maneuver and emit nothing (the walk run after it, same street+side, extends it below).
      if (collapseLinearCrossings && crossingIsLinear(runs, runIndex)) {
        if (walkManeuverIndex >= 0) {
          const walk = maneuvers[walkManeuverIndex];
          walk.lengthMeters += run.lengthMeters;
          walk.stepRange = [walk.stepRange[0], run.stepEnd];
        }
        continue;
      }
      maneuvers.push({
        kind: "cross",
        text: `Cross ${prettyName ?? "the street"}`,
        name: prettyName,
        side: null,
        turn: null,
        lengthMeters: run.lengthMeters,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastCrossIndex = maneuvers.length - 1;
      continue;
    }

    if (!lastWalk) {
      const walkDeg = chordBearing(run);
      const phrase = descriptor(run.side, prettyName);
      maneuvers.push({
        kind: "start",
        text:
          walkDeg === null
            ? `Walk${phrase ? ` on ${phrase}` : ""}`
            : `Walk ${compass8(walkDeg)}${phrase ? ` on ${phrase}` : ""}`,
        name: prettyName,
        side: run.side,
        turn: null,
        lengthMeters: run.lengthMeters,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastWalk = run;
      walkManeuverIndex = maneuvers.length - 1;
      continue;
    }

    // A walk right after a crossing that keeps the same street and side is the crossing's own
    // continuation — the "Cross ..." already said it, so fold its length in and emit nothing.
    if (
      lastCrossIndex === maneuvers.length - 1 &&
      run.kind === "sidewalk" &&
      run.name === lastWalk.name &&
      run.side === lastWalk.side
    ) {
      const crossing = maneuvers[lastCrossIndex];
      crossing.lengthMeters += run.lengthMeters;
      crossing.stepRange = [crossing.stepRange[0], run.stepEnd];
      lastWalk = run;
      continue;
    }

    // A walk after one or more collapsed linear crossings resumes the same street+side: extend the
    // walk maneuver those crossings folded into rather than emitting a fresh one.
    if (
      collapseLinearCrossings &&
      walkManeuverIndex >= 0 &&
      run.kind === "sidewalk" &&
      run.name === lastWalk.name &&
      run.side === lastWalk.side
    ) {
      const walk = maneuvers[walkManeuverIndex];
      walk.lengthMeters += run.lengthMeters;
      walk.stepRange = [walk.stepRange[0], run.stepEnd];
      lastWalk = run;
      continue;
    }

    if (run.kind === "path") {
      maneuvers.push({
        kind: "path",
        text: `Follow ${prettyName ?? "the path"}`,
        name: prettyName,
        side: null,
        turn: null,
        lengthMeters: run.lengthMeters,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastWalk = run;
      walkManeuverIndex = maneuvers.length - 1;
      continue;
    }

    const fromDeg = lastBearing(lastWalk);
    const toDeg = firstBearing(run);
    const delta =
      fromDeg === null || toDeg === null ? 0 : signedTurn(fromDeg, toDeg);
    const { turn, word } = classifyTurn(delta);
    const phrase = descriptor(run.side, prettyName);
    const connector = turn === null ? "on" : "onto";
    maneuvers.push({
      kind: turn === null ? "continue" : "turn",
      text: `${word}${phrase ? ` ${connector} ${phrase}` : ""}`,
      name: prettyName,
      side: run.side,
      turn,
      lengthMeters: run.lengthMeters,
      stepRange: [run.stepStart, run.stepEnd],
      at: runStart(run),
    });
    lastWalk = run;
    walkManeuverIndex = maneuvers.length - 1;
  }

  const finalRun = runs[runs.length - 1];
  const arrivePhrase = lastWalk
    ? descriptor(
        lastWalk.side,
        lastWalk.name ? prettifyStreetName(lastWalk.name) : null,
      )
    : null;
  maneuvers.push({
    kind: "arrive",
    text: `Arrive${arrivePhrase ? ` — on ${arrivePhrase}` : ""}`,
    name: lastWalk?.name ? prettifyStreetName(lastWalk.name) : null,
    side: lastWalk?.side ?? null,
    turn: null,
    lengthMeters: 0,
    stepRange: [result.steps.length, result.steps.length],
    at: runEnd(finalRun),
  });

  return interleavePois(maneuvers, passed);
}
