import { expect, test } from "bun:test";
import {
  edgeMultiplier,
  effSeconds,
  minMultiplier,
  type RouteWeights,
  WALK_METERS_PER_SECOND,
} from "./cost";
import { NO_GEOMETRY, otherEnd, type RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import { haversineMeters, type Snap } from "./snap";

// Phase-3 oracle for the three new scenic factors (landmark and art discounts, the highway penalty).
// The reference optimum is a self-contained Dijkstra over effective seconds rather than findRoute — a
// stronger, independent check than comparing one A* against another.

const SCALE = 1e-6;
const NAME_NONE = 0xffff;
const KIND_SIDEWALK = 0;

const noScenic = (over: Partial<RouteWeights> = {}): RouteWeights => ({
  tree: 0,
  ferry: 0,
  landmark: 0,
  art: 0,
  highway: 0,
  allowFerries: false,
  ...over,
});

interface NodeSpec {
  lat: number;
  lng: number;
}

// A walking edge with its four scenic attribute fractions (0..1); the ingest bytes are these × 255.
interface EdgeSpec {
  a: number;
  b: number;
  cover?: number;
  landmark?: number;
  art?: number;
  highway?: number;
}

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
  const edgeLandmark = new Uint8Array(edgeCount);
  const edgeArt = new Uint8Array(edgeCount);
  const edgeHighway = new Uint8Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const edgeDurationSeconds = new Float32Array(edgeCount);
  const edgeNameId = new Uint16Array(edgeCount).fill(NAME_NONE);
  const edgeGeomOffset = new Uint32Array(edgeCount).fill(NO_GEOMETRY);
  const edgeGeomCount = new Uint16Array(edgeCount);
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  const byte = (fraction: number | undefined): number =>
    Math.min(254, Math.round((fraction ?? 0) * 255));
  let maxCover = 0;
  let maxLandmark = 0;
  let maxArt = 0;
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
    edgeKindSide[edge] = KIND_SIDEWALK;
    edgeCover[edge] = byte(spec.cover);
    edgeLandmark[edge] = byte(spec.landmark);
    edgeArt[edge] = byte(spec.art);
    edgeHighway[edge] = byte(spec.highway);
    maxCover = Math.max(maxCover, edgeCover[edge]);
    maxLandmark = Math.max(maxLandmark, edgeLandmark[edge]);
    maxArt = Math.max(maxArt, edgeArt[edge]);
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
    maxCover: maxCover / 255,
    edgeLandmark,
    edgeArt,
    edgeHighway,
    maxLandmark: maxLandmark / 255,
    maxArt: maxArt / 255,
    edgeDurationSeconds,
    ferryEdges: new Uint32Array(0),
    names: [],
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

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

// The reference optimum: a plain Dijkstra over effective seconds with findRoute's virtual-source and
// virtual-goal partial-edge semantics.
function dijkstraCost(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  weights: RouteWeights,
): number {
  const nodeCount = graph.nodeCount;
  const distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
  const settled = new Uint8Array(nodeCount);

  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startPerMeter =
    edgeMultiplier(graph, start.edge, weights) / WALK_METERS_PER_SECOND;
  const startLength = graph.edgeLength[start.edge];
  distance[startA] = start.metersFromA * startPerMeter;
  distance[startB] = (startLength - start.metersFromA) * startPerMeter;

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destPerMeter =
    edgeMultiplier(graph, dest.edge, weights) / WALK_METERS_PER_SECOND;
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
      const relaxed = distance[node] + effSeconds(graph, edge, weights);
      const neighbour = otherEnd(graph, edge, node);
      if (relaxed < distance[neighbour]) {
        distance[neighbour] = relaxed;
      }
    }
  }

  return Math.min(
    best,
    distance[destA] + dest.metersFromA * destPerMeter,
    distance[destB] + (destLength - dest.metersFromA) * destPerMeter,
  );
}

function effectiveCostOf(
  graph: RoutingGraph,
  result: RouteResult,
  weights: RouteWeights,
): number {
  let cost = 0;
  for (const step of result.steps) {
    cost +=
      (step.lengthMeters / WALK_METERS_PER_SECOND) *
      edgeMultiplier(graph, step.edge, weights);
  }
  return cost;
}

// A diamond: from 0 to 3 by an upper path (node 1) or a lower path (node 2), plus the snap stubs at
// each end. The two interior routes carry different scenic attributes so the weights steer the choice;
// `upperLat`/`lowerLat` set how far each bows out, so one path can be made a genuine detour of the
// other. 0->1->3 is the "upper", 0->2->3 the "lower".
function diamond(
  upper: EdgeSpec,
  lower: EdgeSpec,
  upperLat = 0.001,
  lowerLat = 0.001,
): {
  graph: RoutingGraph;
  start: Snap;
  dest: Snap;
} {
  const nodes: NodeSpec[] = [
    { lat: 0, lng: 0 }, // 0 origin
    { lat: upperLat, lng: 0.0015 }, // 1 upper
    { lat: -lowerLat, lng: 0.0015 }, // 2 lower
    { lat: 0, lng: 0.003 }, // 3 destination
    { lat: 0, lng: -0.0005 }, // 4 start stub
    { lat: 0, lng: 0.0035 }, // 5 dest stub
  ];
  const edges: EdgeSpec[] = [
    { a: 4, b: 0 }, // start stub (plain)
    { a: 0, b: 1, ...upper },
    { a: 1, b: 3, ...upper },
    { a: 0, b: 2, ...lower },
    { a: 2, b: 3, ...lower },
    { a: 3, b: 5 }, // dest stub (plain)
  ];
  const graph = buildGraph(nodes, edges);
  return {
    graph,
    start: snapAtNode(graph, 0, 0),
    dest: snapAtNode(graph, 3, 5),
  };
}

function upperTaken(result: RouteResult | null): boolean {
  // The upper path uses edges 1 and 2 (node 1); the lower uses edges 3 and 4 (node 2).
  return (result?.steps ?? []).some(
    (step) => step.edge === 1 || step.edge === 2,
  );
}

test("edgeMultiplier and minMultiplier reduce to the tree-only model when the new weights are zero", () => {
  const { graph } = diamond({ cover: 0.6, landmark: 0.4 }, { highway: 0.5 });
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    // No weights at all: every metre costs 1.
    expect(edgeMultiplier(graph, edge, noScenic())).toBeCloseTo(1, 12);
    // Only the tree weight: exactly 1 - w*cover, unchanged from before the product model.
    const treeOnly = noScenic({ tree: 0.8 });
    expect(edgeMultiplier(graph, edge, treeOnly)).toBeCloseTo(
      1 - 0.8 * (graph.edgeCover[edge] / 255),
      12,
    );
  }
  expect(minMultiplier(graph, noScenic())).toBeCloseTo(1, 12);
  expect(minMultiplier(graph, noScenic({ tree: 0.8 }))).toBeCloseTo(
    1 - 0.8 * graph.maxCover,
    12,
  );
});

test("edgeMultiplier is the product of the three discounts and the highway penalty", () => {
  const { graph } = diamond(
    { cover: 0.5, landmark: 0.4, art: 0.2, highway: 0.6 },
    {},
  );
  const weights = noScenic({
    tree: 0.8,
    landmark: 0.5,
    art: 0.3,
    highway: 0.7,
  });
  const edge = 1; // the upper 0->1 edge, which carries all four attributes
  const expected =
    (1 - 0.8 * (graph.edgeCover[edge] / 255)) *
    (1 - 0.5 * (graph.edgeLandmark[edge] / 255)) *
    (1 - 0.3 * (graph.edgeArt[edge] / 255)) *
    (1 + 0.7 * (graph.edgeHighway[edge] / 255));
  expect(edgeMultiplier(graph, edge, weights)).toBeCloseTo(expected, 12);
  // The penalty makes this edge dearer than raw, the discounts alone would make it cheaper.
  expect(edgeMultiplier(graph, edge, weights)).toBeGreaterThan(0);
});

test("findRoute matches the Dijkstra optimum across scenic-weight combinations", () => {
  // The lower path is shorter-feeling under a highway penalty (it has none); the upper is richer in
  // landmarks and art. Sweeping the weights makes each route optimal in some regime.
  const { graph, start, dest } = diamond(
    { landmark: 0.8, art: 0.6 },
    { highway: 0.7 },
  );
  const grid = [0, 0.5, 1];
  let combinations = 0;
  for (const tree of grid) {
    for (const landmark of grid) {
      for (const art of grid) {
        for (const highway of grid) {
          const weights = noScenic({ tree, landmark, art, highway });
          const optimum = dijkstraCost(graph, start, dest, weights);
          const result = findRoute(graph, start, dest, weights);
          expect(result).not.toBeNull();
          const cost = effectiveCostOf(graph, result as RouteResult, weights);
          const label = `tree=${tree} lm=${landmark} art=${art} hw=${highway}`;
          expect(Math.abs(cost - optimum), label).toBeLessThan(1e-3);
          combinations += 1;
        }
      }
    }
  }
  expect(combinations).toBe(81);
});

test("a strong landmark weight steers the route onto a longer landmarked path", () => {
  // The upper path bows out far (a genuine detour, ~35% longer) but is rich in landmarks; the lower
  // is the short plain way. The discount has to overcome real extra distance to be chosen.
  const { graph, start, dest } = diamond(
    { landmark: 0.9 },
    {},
    0.0028, // upper bows far out — the longer path
    0.0002, // lower stays near the straight line — the shorter path
  );
  // No preference: the shorter lower path wins on distance alone.
  expect(upperTaken(findRoute(graph, start, dest, noScenic()))).toBe(false);
  // A full landmark weight makes the landmarked detour worth it.
  expect(
    upperTaken(findRoute(graph, start, dest, noScenic({ landmark: 1 }))),
  ).toBe(true);
});

test("a highway weight steers the route away from a shorter nuisance path", () => {
  // The upper path is the short way but runs by a highway; the lower is a longer plain detour.
  const { graph, start, dest } = diamond(
    { highway: 0.9 },
    {},
    0.0002, // upper is the shorter path...
    0.001, // ...the lower a modestly longer detour the penalty can tip
  );
  // No penalty: the shorter upper path wins on distance.
  expect(upperTaken(findRoute(graph, start, dest, noScenic()))).toBe(true);
  // A full highway weight makes the nuisance path dear enough that the longer plain detour wins.
  expect(
    upperTaken(findRoute(graph, start, dest, noScenic({ highway: 1 }))),
  ).toBe(false);
});
