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

// Oracle for the signed sun/shade axis. The reference optimum is a self-contained Dijkstra over
// effective seconds — not findRoute — so a mocked ./search elsewhere can't substitute it. The edge
// attribute is the already-decoded signed value (positive = sunlit, negative = shaded), set straight
// onto graph.edgeShadeNow as computeEdgeShade would.

const SCALE = 1e-6;
const NAME_NONE = 0xffff;
const KIND_SIDEWALK = 0;

const noPref = (over: Partial<RouteWeights> = {}): RouteWeights => ({
  tree: 0,
  ferry: 0,
  landmark: 0,
  art: 0,
  highway: 0,
  shade: 0,
  allowFerries: false,
  ...over,
});

interface NodeSpec {
  lat: number;
  lng: number;
}

// A walking edge with its signed shade attribute in (-1, 1); positive is net sunlit, negative shaded.
interface EdgeSpec {
  a: number;
  b: number;
  shade?: number;
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
  const edgeShadeNow = new Float32Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const edgeDurationSeconds = new Float32Array(edgeCount);
  const edgeNameId = new Uint16Array(edgeCount).fill(NAME_NONE);
  const edgeGeomOffset = new Uint32Array(edgeCount).fill(NO_GEOMETRY);
  const edgeGeomCount = new Uint16Array(edgeCount);
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  let maxAbsShadeNow = 0;
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
    edgeShadeNow[edge] = spec.shade ?? 0;
    maxAbsShadeNow = Math.max(maxAbsShadeNow, Math.abs(edgeShadeNow[edge]));
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
    edgeCover: new Uint8Array(edgeCount),
    edgeNameId,
    edgeKindSide,
    maxCover: 0,
    edgeLandmark: new Uint8Array(edgeCount),
    edgeArt: new Uint8Array(edgeCount),
    edgeHighway: new Uint8Array(edgeCount),
    maxLandmark: 0,
    maxArt: 0,
    edgeShadeNow,
    maxAbsShadeNow,
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

// The scenic-cost diamond: 0 -> 3 by an upper path (node 1) or a lower path (node 2), plus snap stubs.
function diamond(
  upper: EdgeSpec,
  lower: EdgeSpec,
  upperLat = 0.001,
  lowerLat = 0.001,
): { graph: RoutingGraph; start: Snap; dest: Snap } {
  const nodes: NodeSpec[] = [
    { lat: 0, lng: 0 }, // 0 origin
    { lat: upperLat, lng: 0.0015 }, // 1 upper
    { lat: -lowerLat, lng: 0.0015 }, // 2 lower
    { lat: 0, lng: 0.003 }, // 3 destination
    { lat: 0, lng: -0.0005 }, // 4 start stub
    { lat: 0, lng: 0.0035 }, // 5 dest stub
  ];
  const edges: EdgeSpec[] = [
    { a: 4, b: 0 }, // start stub (neutral)
    { a: 0, b: 1, ...upper },
    { a: 1, b: 3, ...upper },
    { a: 0, b: 2, ...lower },
    { a: 2, b: 3, ...lower },
    { a: 3, b: 5 }, // dest stub (neutral)
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

test("a positive shade weight discounts sunlit edges and penalizes shaded ones", () => {
  const { graph } = diamond({ shade: 0.5 }, { shade: -0.5 });
  const sunlit = 1; // 0 -> 1, attr +0.5
  const shaded = 3; // 0 -> 2, attr -0.5
  const preferSun = noPref({ shade: 0.75 });
  // Prefer-sun: the sunlit edge falls below 1 (a discount), the shaded edge rises above 1 (a penalty).
  expect(edgeMultiplier(graph, sunlit, preferSun)).toBeCloseTo(
    1 - 0.75 * 0.5,
    6,
  );
  expect(edgeMultiplier(graph, sunlit, preferSun)).toBeLessThan(1);
  expect(edgeMultiplier(graph, shaded, preferSun)).toBeCloseTo(
    1 + 0.75 * 0.5,
    6,
  );
  expect(edgeMultiplier(graph, shaded, preferSun)).toBeGreaterThan(1);
});

test("a negative shade weight flips: it discounts shaded edges and penalizes sunlit ones", () => {
  const { graph } = diamond({ shade: 0.5 }, { shade: -0.5 });
  const sunlit = 1;
  const shaded = 3;
  const preferShade = noPref({ shade: -0.75 });
  // Prefer-shade: signs invert — the shaded edge is discounted, the sunlit edge penalized.
  expect(edgeMultiplier(graph, shaded, preferShade)).toBeCloseTo(
    1 - 0.75 * 0.5,
    6,
  );
  expect(edgeMultiplier(graph, shaded, preferShade)).toBeLessThan(1);
  expect(edgeMultiplier(graph, sunlit, preferShade)).toBeCloseTo(
    1 + 0.75 * 0.5,
    6,
  );
  expect(edgeMultiplier(graph, sunlit, preferShade)).toBeGreaterThan(1);
});

test("findRoute matches the Dijkstra optimum across both shade signs", () => {
  // The upper path is sunlit, the lower shaded; sweeping the signed weight makes each route optimal in
  // some regime, so agreement with the oracle exercises admissibility on both signs.
  const { graph, start, dest } = diamond({ shade: 0.7 }, { shade: -0.7 });
  const grid = [-1, -0.5, 0, 0.5, 1];
  let combinations = 0;
  for (const shade of grid) {
    const weights = noPref({ shade });
    const optimum = dijkstraCost(graph, start, dest, weights);
    const result = findRoute(graph, start, dest, weights);
    expect(result).not.toBeNull();
    const cost = effectiveCostOf(graph, result as RouteResult, weights);
    expect(Math.abs(cost - optimum), `shade=${shade}`).toBeLessThan(1e-3);
    combinations += 1;
  }
  expect(combinations).toBe(5);
});

test("the signed shade weight steers the route toward sun or shade", () => {
  // The upper path bows out far (a genuine detour) and is fully sunlit; the lower is the short shaded
  // way. Prefer-sun should tip onto the longer sunlit detour; prefer-shade must never take it.
  const { graph, start, dest } = diamond(
    { shade: 0.9 },
    { shade: -0.9 },
    0.0028, // upper bows far out — the longer path
    0.0002, // lower stays near the straight line — the shorter path
  );
  // No preference: the shorter lower path wins on distance alone.
  expect(upperTaken(findRoute(graph, start, dest, noPref()))).toBe(false);
  // Full prefer-sun makes the sunlit detour worth it.
  expect(upperTaken(findRoute(graph, start, dest, noPref({ shade: 1 })))).toBe(
    true,
  );
  // Full prefer-shade keeps the short shaded path.
  expect(upperTaken(findRoute(graph, start, dest, noPref({ shade: -1 })))).toBe(
    false,
  );
});

test("minMultiplier stays strictly positive at the weight extremes", () => {
  // maxAbsShadeNow at the decode ceiling 127/128, weight at either extreme: the floor is 1/128 > 0.
  const { graph } = diamond({ shade: 0 }, { shade: 0 });
  graph.maxAbsShadeNow = 127 / 128;
  for (const shade of [1, -1]) {
    const floor = minMultiplier(graph, noPref({ shade }));
    expect(floor).toBeCloseTo(1 - 127 / 128, 12);
    expect(floor).toBeGreaterThan(0);
  }
});
