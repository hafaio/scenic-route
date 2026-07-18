import { beforeEach, expect, test } from "bun:test";
import {
  edgeMultiplier,
  effSeconds,
  FERRY_FLOOR,
  WALK_METERS_PER_SECOND,
} from "./cost";
import {
  clearEdgePathCache,
  NO_GEOMETRY,
  otherEnd,
  type RoutingGraph,
} from "./graph";
import { findRoute, type RouteResult } from "./search";
import { haversineMeters, type Snap } from "./snap";

const SCALE = 1e-6;
const NAME_NONE = 0xffff;
const KIND_SIDEWALK = 0;
const KIND_FERRY = 4;

interface NodeSpec {
  lat: number;
  lng: number;
}

interface EdgeSpec {
  a: number;
  b: number;
  ferry: boolean;
  cover: number; // 0..1, walking edges only
  durationSeconds: number; // ferry edges only
}

// Build a synthetic routing graph from nodes and edges. Every edge is a straight line, so its
// length is the geodesic span between its two (quantized-and-reconstructed) endpoints — exactly the
// coordinates the A* heuristic reads, which keeps the walking lower bound admissible by construction.
function buildGraph(nodes: NodeSpec[], edges: EdgeSpec[]): RoutingGraph {
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const nodeQx = new Int32Array(nodeCount);
  const nodeQy = new Int32Array(nodeCount);
  for (let node = 0; node < nodeCount; node++) {
    nodeQx[node] = Math.round(nodes[node].lng / SCALE);
    nodeQy[node] = Math.round(nodes[node].lat / SCALE);
  }
  const nodeLat = (node: number): number => nodeQy[node] * SCALE;
  const nodeLng = (node: number): number => nodeQx[node] * SCALE;

  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeCover = new Uint8Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const edgeDurationSeconds = new Float32Array(edgeCount);
  const edgeNameId = new Uint16Array(edgeCount).fill(NAME_NONE);
  const edgeGeomOffset = new Uint32Array(edgeCount).fill(NO_GEOMETRY);
  const edgeGeomCount = new Uint16Array(edgeCount);
  const ferryEdges: number[] = [];
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  let maxCoverByte = 0;
  for (let edge = 0; edge < edgeCount; edge++) {
    const spec = edges[edge];
    edgeNodeA[edge] = spec.a;
    edgeNodeB[edge] = spec.b;
    edgeLength[edge] = haversineMeters(
      nodeLat(spec.a),
      nodeLng(spec.a),
      nodeLat(spec.b),
      nodeLng(spec.b),
    );
    if (spec.ferry) {
      edgeKindSide[edge] = KIND_FERRY;
      edgeDurationSeconds[edge] = spec.durationSeconds;
      ferryEdges.push(edge);
    } else {
      edgeKindSide[edge] = KIND_SIDEWALK;
      const coverByte = Math.round(spec.cover * 255);
      edgeCover[edge] = coverByte;
      maxCoverByte = Math.max(maxCoverByte, coverByte);
    }
    adjacency[spec.a].push(edge);
    adjacency[spec.b].push(edge);
  }

  const csr = new Uint32Array(nodeCount + 1);
  const flatAdjacency = new Uint32Array(2 * edgeCount);
  let cursor = 0;
  for (let node = 0; node < nodeCount; node++) {
    csr[node] = cursor;
    for (const edge of adjacency[node]) {
      flatAdjacency[cursor] = edge;
      cursor += 1;
    }
  }
  csr[nodeCount] = cursor;

  return {
    nodeCount,
    edgeCount,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx,
    nodeQy,
    csr,
    adjacency: flatAdjacency,
    edgeNodeA,
    edgeNodeB,
    edgeLength,
    edgeGeomOffset,
    edgeGeomCount,
    edgeCover,
    edgeNameId,
    edgeKindSide,
    maxCover: maxCoverByte / 255,
    edgeDurationSeconds,
    ferryEdges: Uint32Array.from(ferryEdges),
    names: [],
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

// A start/dest snap sitting exactly on a node, entered through one of its incident walking edges
// (snaps never land on a ferry). metersFromA is 0 or the full length so the virtual point coincides
// with the node.
function snapAtNode(graph: RoutingGraph, node: number, walkEdge: number): Snap {
  const atA = graph.edgeNodeA[walkEdge] === node;
  return {
    edge: walkEdge,
    metersFromA: atA ? 0 : graph.edgeLength[walkEdge],
    point: {
      lat: graph.nodeQy[node] * graph.scale,
      lng: graph.nodeQx[node] * graph.scale,
    },
    distanceMeters: 0,
    component: 0,
  };
}

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

  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startPerMeter =
    edgeMultiplier(graph, start.edge, treeWeight) / WALK_METERS_PER_SECOND;
  const startLength = graph.edgeLength[start.edge];
  distance[startA] = start.metersFromA * startPerMeter;
  distance[startB] = (startLength - start.metersFromA) * startPerMeter;

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destPerMeter =
    edgeMultiplier(graph, dest.edge, treeWeight) / WALK_METERS_PER_SECOND;
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
      const relaxed =
        distance[node] +
        effSeconds(graph, edge, treeWeight, ferryWeight, allowFerries);
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
        edgeMultiplier(graph, step.edge, treeWeight);
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
            treeWeight,
            ferryWeight,
            allowFerries,
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

test("the big-shortcut route boards the ferry when it is allowed", () => {
  for (const ferryWeight of FERRY_WEIGHTS) {
    const result = findRoute(
      graphA,
      snapAtNode(graphA, 0, walkEdgeA0),
      snapAtNode(graphA, 1, walkEdgeA1),
      1,
      ferryWeight,
      true,
    );
    expect(hasFerryStep(result)).toBe(true);
  }
});

test("the two-ferry route boards both ferries when they are allowed", () => {
  const result = findRoute(
    graphB,
    snapAtNode(graphB, 0, walkEdgeB0),
    snapAtNode(graphB, 3, walkEdgeB3),
    1,
    0.4,
    true,
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
        1,
        ferryWeight,
        false,
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
