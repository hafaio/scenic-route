// Properties of a finished route, as opposed to properties of the network it was found in. The
// whole-city graph checks (crates/tiler/src/invariants.rs) hold every edge to what an edge can be
// held to; these three hold a *walk* to what a walk should look like, which no edge can answer on
// its own — whether a double crossing was worth taking, how far round the houses the walk went, and
// whether a divided street was crossed in one move.
//
// Each is a pure function of the route and the graph, unit-tested on a hand-built network in
// route-metrics.test.ts and then run over thousands of sampled real trips in
// tests/route-sampling.test.ts — the same shape as the graph invariants.

import { edgePath, otherEnd, type RoutingGraph } from "./graph";
import type { RouteResult } from "./search";
import { haversineMeters } from "./snap";

const METERS_PER_DEGREE_LAT = 111_320;

// How far a walker may go between the two crossings and still have them read as one reversal. A
// street's own two crossings at one corner sit 0 m apart (they share the far kerb node); the widest
// case that still reads as "and straight back" is the corner wrap, a few metres of pavement.
export const REVERSAL_GAP_METERS = 20;
// How anti-parallel the second crossing has to be to count as going back the way you came: -0.7 is
// 135 degrees, so the two legs of a corner (a right angle, cosine 0) are never a reversal.
export const REVERSAL_COSINE = -0.7;

// One "crossed the street and crossed straight back": two crossings the route takes one after the
// other, pointing opposite ways, with almost no walking in between.
export interface CrossingReversal {
  stepIndex: number; // the first of the two crossing steps
  name: string | null; // the street crossed, as the first crossing names it
  walkBetweenMeters: number; // pavement walked between leaving the first crossing and starting the second
  crossedMeters: number; // the two crossings' own lengths, i.e. what the reversal cost
  at: { lat: number; lng: number }; // where the first crossing starts, for a failure message
  // Was there another way? True when the network joins the reversal's two ends by some path of no
  // more than the metres the reversal itself spent, with those two crossings taken out. A reversal
  // that is avoidable was BOUGHT — the cost model paid two crossings for greener pavement. One that
  // is not was FORCED: the two pavement ends are not joined and going into the road is the only way
  // round. This is the distinction the graph cannot make on its own, and it is the whole reason this
  // check has to look at a walk.
  avoidable: boolean;
}

// Is `to` within `budget` metres of `from` through the network with `banned` taken out? A Dijkstra
// bounded by the budget, so it walks a corner's worth of edges and stops — the frontier never grows
// past a few dozen nodes at the tens of metres a reversal costs.
function reachableWithout(
  graph: RoutingGraph,
  from: number,
  to: number,
  budget: number,
  banned: readonly [number, number],
): boolean {
  const best = new Map<number, number>([[from, 0]]);
  // A linear-scan frontier: at these budgets it holds a handful of nodes, so a heap would cost more
  // to maintain than it saves.
  const frontier: number[] = [from];
  while (frontier.length > 0) {
    let at = 0;
    for (let index = 1; index < frontier.length; index++) {
      if ((best.get(frontier[index]) ?? 0) < (best.get(frontier[at]) ?? 0)) {
        at = index;
      }
    }
    const node = frontier[at];
    frontier[at] = frontier[frontier.length - 1];
    frontier.pop();
    if (node === to) {
      return true;
    }
    const distance = best.get(node) ?? 0;
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      if (edge === banned[0] || edge === banned[1]) {
        continue;
      }
      const relaxed = distance + graph.edgeLength[edge];
      const neighbour = otherEnd(graph, edge, node);
      if (relaxed <= budget && relaxed < (best.get(neighbour) ?? Infinity)) {
        best.set(neighbour, relaxed);
        frontier.push(neighbour);
      }
    }
  }
  return false;
}

// The unit direction of a step's travel, in a local metre frame.
function stepDirection(
  graph: RoutingGraph,
  edge: number,
  forward: boolean,
): { x: number; y: number; from: { lat: number; lng: number } } {
  const { lngs, lats } = edgePath(graph, edge);
  const first = forward ? 0 : lngs.length - 1;
  const last = forward ? lngs.length - 1 : 0;
  const cosLat = Math.cos((lats[first] * Math.PI) / 180);
  const deltaX = (lngs[last] - lngs[first]) * METERS_PER_DEGREE_LAT * cosLat;
  const deltaY = (lats[last] - lats[first]) * METERS_PER_DEGREE_LAT;
  const norm = Math.hypot(deltaX, deltaY) || 1;
  return {
    x: deltaX / norm,
    y: deltaY / norm,
    from: { lat: lats[first], lng: lngs[first] },
  };
}

// Every crossing reversal in the route. Two causes land here — the cost model buying greener
// pavement for two crossings' worth of walking, and a corner whose two pavement ends are not joined,
// where crossing out and back is the only way round — and each is tagged `avoidable` by asking the
// network whether the second was reachable without them.
export function crossingReversals(
  graph: RoutingGraph,
  result: RouteResult,
): CrossingReversal[] {
  const reversals: CrossingReversal[] = [];
  let previous: {
    stepIndex: number;
    edge: number;
    fromNode: number;
    x: number;
    y: number;
    name: string | null;
    from: { lat: number; lng: number };
    endsAtMeters: number;
    lengthMeters: number;
  } | null = null;
  let along = 0;
  for (let index = 0; index < result.steps.length; index++) {
    const step = result.steps[index];
    const startsAtMeters = along;
    along += step.lengthMeters;
    if (step.kind !== "crossing") {
      continue;
    }
    const { x, y, from } = stepDirection(graph, step.edge, step.forward);
    if (previous) {
      const gap = startsAtMeters - previous.endsAtMeters;
      const cosine = previous.x * x + previous.y * y;
      if (gap <= REVERSAL_GAP_METERS && cosine <= REVERSAL_COSINE) {
        const crossedMeters = previous.lengthMeters + step.lengthMeters;
        const toNode = step.forward
          ? graph.edgeNodeB[step.edge]
          : graph.edgeNodeA[step.edge];
        reversals.push({
          stepIndex: previous.stepIndex,
          name: previous.name,
          walkBetweenMeters: gap,
          crossedMeters,
          at: previous.from,
          avoidable: reachableWithout(
            graph,
            previous.fromNode,
            toNode,
            crossedMeters + gap,
            [previous.edge, step.edge],
          ),
        });
      }
    }
    previous = {
      stepIndex: index,
      edge: step.edge,
      fromNode: step.forward
        ? graph.edgeNodeA[step.edge]
        : graph.edgeNodeB[step.edge],
      x,
      y,
      name: step.name,
      from,
      endsAtMeters: along,
      lengthMeters: step.lengthMeters,
    };
  }
  return reversals;
}

// The most crossing edges the route traverses back to back. A plain street is one, a street with a
// median is two — which is exactly why a crossing cannot be checked edge by edge, since half of a
// median crossing is indistinguishable from a whole one until you see the walk go through it — and a
// junction of several streets chains more. A long run is a route threading roadway to roadway.
export function longestCrossingRun(result: RouteResult): number {
  let longest = 0;
  let run = 0;
  for (const step of result.steps) {
    if (step.kind === "crossing") {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return longest;
}

// Walked metres over the straight line between the two ends. Measured between the *snapped* points
// rather than the requested ones, so it reports what the router did and not how far the query was
// from the pavement. Ferry spans are excluded from the numerator (the sampling suite bars ferries,
// so for it this is the whole trip); a zero-length straight line has no ratio.
export function detourRatio(result: RouteResult): number | null {
  const straight = haversineMeters(
    result.start.point.lat,
    result.start.point.lng,
    result.dest.point.lat,
    result.dest.point.lng,
  );
  return straight > 0 ? result.walkMeters / straight : null;
}
