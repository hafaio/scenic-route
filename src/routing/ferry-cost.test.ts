import { beforeEach, expect, test } from "bun:test";
import {
  edgeMultiplier,
  effSeconds,
  FERRY_FLOOR,
  WALK_METERS_PER_SECOND,
} from "./cost";
import { buildGraph, snapAtNode, weights } from "./ferry.fixture";
import { clearEdgePathCache, otherEnd, type RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import type { Snap } from "./snap";

// The reference optimum: a plain Dijkstra (heuristic identically 0, no early exit) over effective
// seconds, using exactly findRoute's virtual-source and virtual-goal partial-edge semantics.
function dijkstraCost(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  treeWeight: number,
  ferryWeight: number,
  allowFerries: boolean,
): number {
  const nodeCount = graph.nodeCount;
  const distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
  const settled = new Uint8Array(nodeCount);

  const routeWeights = weights(treeWeight, ferryWeight, allowFerries);
  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startPerMeter =
    edgeMultiplier(graph, start.edge, routeWeights) / WALK_METERS_PER_SECOND;
  const startLength = graph.edgeLength[start.edge];
  distance[startA] = start.metersFromA * startPerMeter;
  distance[startB] = (startLength - start.metersFromA) * startPerMeter;

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destPerMeter =
    edgeMultiplier(graph, dest.edge, routeWeights) / WALK_METERS_PER_SECOND;
  const destLength = graph.edgeLength[dest.edge];

  let best = Number.POSITIVE_INFINITY;
  if (start.edge === dest.edge) {
    best = Math.abs(dest.metersFromA - start.metersFromA) * startPerMeter;
  }

  for (;;) {
    let node = -1;
    let nodeDistance = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < nodeCount; candidate++) {
      if (!settled[candidate] && distance[candidate] < nodeDistance) {
        nodeDistance = distance[candidate];
        node = candidate;
      }
    }
    if (node === -1) {
      break;
    }
    settled[node] = 1;
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      const relaxed = distance[node] + effSeconds(graph, edge, routeWeights);
      const neighbour = otherEnd(graph, edge, node);
      if (relaxed < distance[neighbour]) {
        distance[neighbour] = relaxed;
      }
    }
  }

  best = Math.min(
    best,
    distance[destA] + dest.metersFromA * destPerMeter,
    distance[destB] + (destLength - dest.metersFromA) * destPerMeter,
  );
  return best;
}

// The effective-seconds cost of a returned route, reconstructed from its steps: walking steps by
// their walked span, ferry steps by their discounted duration. Must equal the Dijkstra optimum.
function effectiveCostOf(
  graph: RoutingGraph,
  result: RouteResult,
  treeWeight: number,
  ferryWeight: number,
): number {
  let cost = 0;
  for (const step of result.steps) {
    if (step.kind === "ferry") {
      cost +=
        graph.edgeDurationSeconds[step.edge] *
        Math.max(FERRY_FLOOR, 1 - ferryWeight);
    } else {
      cost +=
        (step.lengthMeters / WALK_METERS_PER_SECOND) *
        edgeMultiplier(
          graph,
          step.edge,
          weights(treeWeight, ferryWeight, false),
        );
    }
  }
  return cost;
}

function pathSignature(result: RouteResult | null): string {
  if (!result) {
    return "∅";
  }
  return result.steps
    .map((step) => `${step.edge}${step.forward ? "f" : "b"}`)
    .join(";");
}

function hasFerryStep(result: RouteResult | null): boolean {
  return result?.steps.some((step) => step.kind === "ferry") ?? false;
}

// Fixture A — one ferry that is a large shortcut: crossing 0 -> 1 by water is far cheaper than the
// long walk 0 -> 2 -> 1 around it. The plain walking heuristic from 0 would over-estimate the true
// (ferry) cost, so this exercises the ferry credit.
const graphA = buildGraph(
  [
    { lat: 40.7, lng: -74.02 }, // 0 start shore
    { lat: 40.62, lng: -74.08 }, // 1 far shore
    { lat: 40.58, lng: -74.16 }, // 2 detour inland, making the walk long
  ],
  [
    { a: 0, b: 1, ferry: true, cover: 0, durationSeconds: 400 },
    { a: 0, b: 2, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 2, b: 1, ferry: false, cover: 0.6, durationSeconds: 0 },
  ],
);
const walkEdgeA0 = 1; // walking edge 0 -> 2, for a snap at node 0
const walkEdgeA1 = 2; // walking edge 2 -> 1, for a snap at node 1

// Fixture B — a two-ferry chain: 0 =ferry= 1 -walk- 2 =ferry= 3, with a very long all-walking
// detour 0 -walk- 4 -walk- 3. The optimum from 0 to 3 rides both ferries, so admissibility needs
// the sum of the two largest ferry shortcuts.
const graphB = buildGraph(
  [
    { lat: 40.6, lng: -74.12 }, // 0 start
    { lat: 40.61, lng: -74.06 }, // 1 island A
    { lat: 40.62, lng: -74.05 }, // 2 island B (short walk from 1)
    { lat: 40.7, lng: -74.0 }, // 3 dest
    { lat: 40.45, lng: -73.85 }, // 4 far detour node
  ],
  [
    { a: 0, b: 1, ferry: true, cover: 0, durationSeconds: 300 },
    { a: 1, b: 2, ferry: false, cover: 0.4, durationSeconds: 0 },
    { a: 2, b: 3, ferry: true, cover: 0, durationSeconds: 300 },
    { a: 0, b: 4, ferry: false, cover: 0.2, durationSeconds: 0 },
    { a: 4, b: 3, ferry: false, cover: 0.5, durationSeconds: 0 },
  ],
);
const walkEdgeB0 = 3; // walking edge 0 -> 4, for a snap at node 0
const walkEdgeB3 = 4; // walking edge 4 -> 3, for a snap at node 3

// Fixture C — the Bay Area's shape: two land masses with NO walking edge between them, joined by
// one ferry. Every fixture above has a walk to fall back on, so none of them asks what the heuristic
// does when the only path crosses water five times faster than anyone walks. Kept separate from the
// scenarios above because barring its ferry leaves no path at all, and those assert one.
const graphC = buildGraph(
  [
    { lat: 37.7749, lng: -122.4394 }, // 0 west, a long walk in
    { lat: 37.7955, lng: -122.3937 }, // 1 west pier
    { lat: 37.7955, lng: -122.2777 }, // 2 east pier
    { lat: 37.8272, lng: -122.2513 }, // 3 east, a long walk out
  ],
  [
    { a: 0, b: 1, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 1, b: 2, ferry: true, cover: 0, durationSeconds: 1500 },
    { a: 2, b: 3, ferry: false, cover: 0.3, durationSeconds: 0 },
  ],
);
const walkEdgeC0 = 0; // walking edge 0 -> 1
const walkEdgeC3 = 2; // walking edge 2 -> 3

const TREE_WEIGHTS = [0, 0.4, 1];
const FERRY_WEIGHTS = [0, 0.4, 1];
const ALLOW = [true, false];

interface Scenario {
  name: string;
  graph: RoutingGraph;
  start: Snap;
  dest: Snap;
}

const scenarios: Scenario[] = [
  {
    name: "A: big ferry shortcut, 0 -> 1",
    graph: graphA,
    start: snapAtNode(graphA, 0, walkEdgeA0),
    dest: snapAtNode(graphA, 1, walkEdgeA1),
  },
  {
    name: "A: reverse, 1 -> 0",
    graph: graphA,
    start: snapAtNode(graphA, 1, walkEdgeA1),
    dest: snapAtNode(graphA, 0, walkEdgeA0),
  },
  {
    name: "B: two-ferry chain, 0 -> 3",
    graph: graphB,
    start: snapAtNode(graphB, 0, walkEdgeB0),
    dest: snapAtNode(graphB, 3, walkEdgeB3),
  },
];

// The edge-geometry cache is keyed by edge id; these fixtures reuse ids across graphs, so reset it
// before each test so no stale polyline leaks in (also protecting other files' synthetic graphs).
beforeEach(clearEdgePathCache);

test("A* effective cost matches the Dijkstra oracle across the weight matrix", () => {
  let combinations = 0;
  for (const scenario of scenarios) {
    for (const treeWeight of TREE_WEIGHTS) {
      for (const ferryWeight of FERRY_WEIGHTS) {
        for (const allowFerries of ALLOW) {
          const optimum = dijkstraCost(
            scenario.graph,
            scenario.start,
            scenario.dest,
            treeWeight,
            ferryWeight,
            allowFerries,
          );
          const result = findRoute(
            scenario.graph,
            scenario.start,
            scenario.dest,
            weights(treeWeight, ferryWeight, allowFerries),
          );
          expect(result).not.toBeNull();
          const cost = effectiveCostOf(
            scenario.graph,
            result as RouteResult,
            treeWeight,
            ferryWeight,
          );
          const label = `${scenario.name} tw=${treeWeight} fw=${ferryWeight} allow=${allowFerries}`;
          // The A* optimum must equal the true optimum; a mismatch means the heuristic over-estimated.
          expect(Math.abs(cost - optimum), label).toBeLessThan(1e-3);
          combinations += 1;
        }
      }
    }
  }
  // 3 scenarios x 3 tree x 3 ferry x 2 allow.
  expect(combinations).toBe(54);
});

test("the sole crossing is optimal, and barring it leaves no route", () => {
  const start = snapAtNode(graphC, 0, walkEdgeC0);
  const dest = snapAtNode(graphC, 3, walkEdgeC3);
  for (const treeWeight of TREE_WEIGHTS) {
    for (const ferryWeight of FERRY_WEIGHTS) {
      const label = `C tw=${treeWeight} fw=${ferryWeight}`;
      const result = findRoute(
        graphC,
        start,
        dest,
        weights(treeWeight, ferryWeight, true),
      );
      expect(result, label).not.toBeNull();
      const optimum = dijkstraCost(
        graphC,
        start,
        dest,
        treeWeight,
        ferryWeight,
        true,
      );
      const cost = effectiveCostOf(
        graphC,
        result as RouteResult,
        treeWeight,
        ferryWeight,
      );
      // A twelve-kilometre boat against a 1.3 m/s walking bound is the widest gap the ferry credit
      // has to close; over-estimate here and the search would settle for something worse or, with
      // nothing worse to settle for, wander.
      expect(Math.abs(cost - optimum), label).toBeLessThan(1e-3);
      expect(
        findRoute(graphC, start, dest, weights(treeWeight, ferryWeight, false)),
        label,
      ).toBeNull();
    }
  }
});

test("the big-shortcut route boards the ferry when it is allowed", () => {
  for (const ferryWeight of FERRY_WEIGHTS) {
    const result = findRoute(
      graphA,
      snapAtNode(graphA, 0, walkEdgeA0),
      snapAtNode(graphA, 1, walkEdgeA1),
      weights(1, ferryWeight, true),
    );
    expect(hasFerryStep(result)).toBe(true);
  }
});

test("the two-ferry route boards both ferries when they are allowed", () => {
  const result = findRoute(
    graphB,
    snapAtNode(graphB, 0, walkEdgeB0),
    snapAtNode(graphB, 3, walkEdgeB3),
    weights(1, 0.4, true),
  );
  const ferrySteps = (result?.steps ?? []).filter(
    (step) => step.kind === "ferry",
  );
  expect(ferrySteps).toHaveLength(2);
});

test("barred ferries are never boarded and the walk is ferry-weight-independent", () => {
  for (const scenario of scenarios) {
    let baseline: string | null = null;
    for (const ferryWeight of FERRY_WEIGHTS) {
      const result = findRoute(
        scenario.graph,
        scenario.start,
        scenario.dest,
        weights(1, ferryWeight, false),
      );
      expect(result).not.toBeNull();
      expect(hasFerryStep(result)).toBe(false);
      const signature = pathSignature(result);
      // Ferries barred, so the ferry weight cannot change the walking route.
      baseline ??= signature;
      expect(signature).toBe(baseline);
    }
  }
});
