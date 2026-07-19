import { beforeEach, expect, test } from "bun:test";
import {
  edgeMultiplier,
  effSeconds,
  FERRY_FLOOR,
  type RouteWeights,
  WALK_METERS_PER_SECOND,
} from "./cost";
import {
  clearEdgePathCache,
  NO_GEOMETRY,
  otherEnd,
  type RoutingGraph,
} from "./graph";
import { type RouteResult, RouteSolver, reverseResult } from "./search";
import { haversineMeters, type Snap } from "./snap";

// The oracle here is a self-contained Dijkstra over effective seconds, not findRoute: route-cache.test.ts
// mock.modules "./search" process-wide, so a newly added test file that imports findRoute receives that
// stub. RouteSolver and reverseResult are unaffected, and a Dijkstra optimum is a stronger reference
// than another A* anyway — the same approach ferry-cost.test.ts takes.

const SCALE = 1e-6;
const NAME_NONE = 0xffff;
const KIND_SIDEWALK = 0;
const KIND_FERRY = 4;

const weights = (
  tree: number,
  ferry: number,
  allowFerries: boolean,
): RouteWeights => ({
  tree,
  ferry,
  landmark: 0,
  art: 0,
  highway: 0,
  allowFerries,
});

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

// Build a synthetic routing graph from nodes and edges, straight-line edges only — the same fixture
// shape the other routing tests use, so the A* heuristic reads exactly the coordinates it snaps to.
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
    edgeLandmark: new Uint8Array(edgeCount),
    edgeArt: new Uint8Array(edgeCount),
    edgeHighway: new Uint8Array(edgeCount),
    maxLandmark: 0,
    maxArt: 0,
    edgeDurationSeconds,
    ferryEdges: Uint32Array.from(ferryEdges),
    names: [],
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

// A snap sitting exactly on a node, entered through an incident walking edge, coinciding with the
// node (metersFromA 0 or the full edge length).
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
// virtual-goal partial-edge semantics. Copied from ferry-cost.test.ts's oracle.
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

// The effective-seconds cost of a returned route, reconstructed from its steps.
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

// True when every step's exit node is the next step's entry node — a physically connected chain.
function isConnected(graph: RoutingGraph, result: RouteResult): boolean {
  for (let index = 0; index + 1 < result.steps.length; index++) {
    const step = result.steps[index];
    const exit = step.forward
      ? graph.edgeNodeB[step.edge]
      : graph.edgeNodeA[step.edge];
    const next = result.steps[index + 1];
    const entry = next.forward
      ? graph.edgeNodeA[next.edge]
      : graph.edgeNodeB[next.edge];
    if (exit !== entry) {
      return false;
    }
  }
  return true;
}

// The summed step length must equal the reported total, and ferry spans must be excluded from the
// walked mileage — a self-consistency check on the reconstructed route.
function assertTotalsConsistent(result: RouteResult, label: string): void {
  let length = 0;
  let walk = 0;
  for (const step of result.steps) {
    length += step.lengthMeters;
    if (step.kind !== "ferry") {
      walk += step.lengthMeters;
    }
  }
  expect(result.lengthMeters, label).toBeCloseTo(length, 3);
  expect(result.walkMeters, label).toBeCloseTo(walk, 3);
}

// A 4x4 core grid with varied covers, plus a dead-end stub edge per core node used for snapping.
// Snapping through a stub makes the reachable core node settle before its unreachable leaf, so the
// solver's approximate goal test lands on the true optimum — exact against the Dijkstra oracle.
function buildGrid(withFerry: boolean): {
  graph: RoutingGraph;
  stubOf: number[];
} {
  const nodes: NodeSpec[] = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      nodes.push({ lat: 40.7 + row * 0.01, lng: -74.0 + col * 0.012 });
    }
  }
  const idx = (row: number, col: number): number => row * 4 + col;
  const edges: EdgeSpec[] = [];
  let bump = 0;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      if (col < 3) {
        edges.push({
          a: idx(row, col),
          b: idx(row, col + 1),
          ferry: false,
          cover: 0.1 + (bump++ % 7) * 0.09,
          durationSeconds: 0,
        });
      }
      if (row < 3) {
        edges.push({
          a: idx(row, col),
          b: idx(row + 1, col),
          ferry: false,
          cover: 0.05 + (bump++ % 6) * 0.11,
          durationSeconds: 0,
        });
      }
    }
  }
  if (withFerry) {
    // A diagonal ferry shortcut between opposite corners.
    edges.push({ a: 0, b: 15, ferry: true, cover: 0, durationSeconds: 200 });
  }
  const stubOf: number[] = [];
  for (let core = 0; core < 16; core++) {
    const leaf = nodes.length;
    nodes.push({
      lat: 40.7 + Math.floor(core / 4) * 0.01 + 0.003,
      lng: -74.0 + (core % 4) * 0.012 + 0.003,
    });
    stubOf[core] = edges.length;
    edges.push({
      a: core,
      b: leaf,
      ferry: false,
      cover: 0.2,
      durationSeconds: 0,
    });
  }
  return { graph: buildGraph(nodes, edges), stubOf };
}

const grid = buildGrid(false);
const ferryGrid = buildGrid(true);
const gridSnap = (core: number): Snap =>
  snapAtNode(grid.graph, core, grid.stubOf[core]);
const ferrySnap = (core: number): Snap =>
  snapAtNode(ferryGrid.graph, core, ferryGrid.stubOf[core]);

// A star of independent spurs: a 3x3 hub grid, and per dest a private junction+leaf spur off a hub
// node. No two dests share a junction, so a reused solver never needs a previously-settled dest
// node's outgoing edges — persistent state stays sound across a run of queries.
function buildStar(): { graph: RoutingGraph; source: Snap; dests: Snap[] } {
  const nodes: NodeSpec[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      nodes.push({ lat: 40.7 + row * 0.01, lng: -74.0 + col * 0.012 });
    }
  }
  const idx = (row: number, col: number): number => row * 3 + col;
  const edges: EdgeSpec[] = [];
  let bump = 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (col < 2) {
        edges.push({
          a: idx(row, col),
          b: idx(row, col + 1),
          ferry: false,
          cover: 0.1 + (bump++ % 5) * 0.12,
          durationSeconds: 0,
        });
      }
      if (row < 2) {
        edges.push({
          a: idx(row, col),
          b: idx(row + 1, col),
          ferry: false,
          cover: 0.08 + (bump++ % 4) * 0.13,
          durationSeconds: 0,
        });
      }
    }
  }
  const sourceLeaf = nodes.length;
  nodes.push({ lat: 40.697, lng: -74.003 });
  const sourceStub = edges.length;
  edges.push({
    a: 0,
    b: sourceLeaf,
    ferry: false,
    cover: 0.2,
    durationSeconds: 0,
  });

  const anchors = [8, 2, 6, 4, 5, 1, 7, 3];
  const destStubs: number[] = [];
  const destLeaves: number[] = [];
  for (const anchor of anchors) {
    const junction = nodes.length;
    nodes.push({
      lat: 40.7 + Math.floor(anchor / 3) * 0.01 + 0.004,
      lng: -74.0 + (anchor % 3) * 0.012 + 0.004,
    });
    const leaf = nodes.length;
    nodes.push({
      lat: 40.7 + Math.floor(anchor / 3) * 0.01 + 0.007,
      lng: -74.0 + (anchor % 3) * 0.012 + 0.007,
    });
    edges.push({
      a: anchor,
      b: junction,
      ferry: false,
      cover: 0.15,
      durationSeconds: 0,
    });
    destStubs.push(edges.length);
    edges.push({
      a: junction,
      b: leaf,
      ferry: false,
      cover: 0.25,
      durationSeconds: 0,
    });
    destLeaves.push(leaf);
  }

  const graph = buildGraph(nodes, edges);
  const source = snapAtNode(graph, 0, sourceStub);
  const dests = destStubs.map((stub, index) =>
    snapAtNode(graph, destLeaves[index], stub),
  );
  return { graph, source, dests };
}

const star = buildStar();

// Fixtures reuse edge ids across graphs, so reset the id-keyed geometry cache between tests.
beforeEach(clearEdgePathCache);

const TREE_WEIGHTS = [0, 0.3, 0.6, 1];

test("solveApprox is optimal with ferries off (matches the Dijkstra oracle)", () => {
  // Ferries off, the heuristic is consistent and the stub-snapped dest settles its reachable
  // endpoint first, so the approximate goal test coincides with the true optimum.
  const ods: [number, number][] = [
    [0, 5],
    [0, 10],
    [0, 15],
    [3, 12],
    [1, 14],
    [6, 9],
    [15, 0],
    [11, 4],
  ];
  let checks = 0;
  for (const [from, to] of ods) {
    for (const treeWeight of TREE_WEIGHTS) {
      clearEdgePathCache();
      const start = gridSnap(from);
      const dest = gridSnap(to);
      const solved = new RouteSolver(
        grid.graph,
        start,
        weights(treeWeight, 0, false),
      ).solveApprox(dest);
      const label = `${from}->${to} tw=${treeWeight}`;
      expect(solved, label).not.toBeNull();
      expect(isConnected(grid.graph, solved as RouteResult), label).toBe(true);
      assertTotalsConsistent(solved as RouteResult, label);
      const optimum = dijkstraCost(
        grid.graph,
        start,
        dest,
        treeWeight,
        0,
        false,
      );
      const cost = effectiveCostOf(
        grid.graph,
        solved as RouteResult,
        treeWeight,
        0,
      );
      expect(cost, label).toBeCloseTo(optimum, 3);
      checks += 1;
    }
  }
  expect(checks).toBe(ods.length * TREE_WEIGHTS.length);
});

test("one reused solver stays optimal across a sequence of dests", () => {
  // Proves the persistent distance/parent/closed state is not corrupted between drags.
  for (const treeWeight of TREE_WEIGHTS) {
    clearEdgePathCache();
    const solver = new RouteSolver(
      star.graph,
      star.source,
      weights(treeWeight, 0, false),
    );
    for (let index = 0; index < star.dests.length; index++) {
      const dest = star.dests[index];
      const solved = solver.solveApprox(dest);
      const label = `tw=${treeWeight} dest#${index}`;
      expect(solved, label).not.toBeNull();
      expect(isConnected(star.graph, solved as RouteResult), label).toBe(true);
      const optimum = dijkstraCost(
        star.graph,
        star.source,
        dest,
        treeWeight,
        0,
        false,
      );
      const cost = effectiveCostOf(
        star.graph,
        solved as RouteResult,
        treeWeight,
        0,
      );
      expect(cost, label).toBeCloseTo(optimum, 3);
    }
  }
});

test("a reused solver stays optimal dragging through already-settled dests", () => {
  // The dests share grid corridors and wander near and far, so later queries must route through a core
  // node an earlier query already settled — the case the expand-before-goal-stop fix covers.
  const sequence = [5, 6, 10, 9, 15, 11, 2, 8, 13, 0];
  for (const treeWeight of TREE_WEIGHTS) {
    clearEdgePathCache();
    const solver = new RouteSolver(
      grid.graph,
      gridSnap(0),
      weights(treeWeight, 0, false),
    );
    for (const to of sequence) {
      clearEdgePathCache();
      const dest = gridSnap(to);
      const solved = solver.solveApprox(dest);
      const label = `tw=${treeWeight} ->${to}`;
      expect(solved, label).not.toBeNull();
      expect(isConnected(grid.graph, solved as RouteResult), label).toBe(true);
      const optimum = dijkstraCost(
        grid.graph,
        gridSnap(0),
        dest,
        treeWeight,
        0,
        false,
      );
      const cost = effectiveCostOf(
        grid.graph,
        solved as RouteResult,
        treeWeight,
        0,
      );
      expect(cost, label).toBeCloseTo(optimum, 3);
    }
  }
});

test("reverseResult flips orientation and preserves the scalar totals", () => {
  const start = gridSnap(0);
  const dest = gridSnap(14);
  const forward = new RouteSolver(
    grid.graph,
    start,
    weights(0.6, 0, false),
  ).solveApprox(dest);
  expect(forward).not.toBeNull();
  const reversed = reverseResult(forward as RouteResult);

  expect(reversed.lengthMeters).toBe((forward as RouteResult).lengthMeters);
  expect(reversed.walkMeters).toBe((forward as RouteResult).walkMeters);
  expect(reversed.coverFraction).toBe((forward as RouteResult).coverFraction);
  expect(reversed.travelSeconds).toBe((forward as RouteResult).travelSeconds);
  expect(reversed.start).toBe(dest);
  expect(reversed.dest).toBe(start);

  const fwdLats = (forward as RouteResult).path.lats;
  const fwdLngs = (forward as RouteResult).path.lngs;
  const last = fwdLats.length - 1;
  expect(reversed.path.lats[0]).toBe(fwdLats[last]);
  expect(reversed.path.lngs[0]).toBe(fwdLngs[last]);
  expect(reversed.path.lats[last]).toBe(fwdLats[0]);
  expect(reversed.path.lngs[last]).toBe(fwdLngs[0]);
  // Every step flips its travel direction; the stored side is untouched.
  const fwdSteps = (forward as RouteResult).steps;
  expect(reversed.steps).toHaveLength(fwdSteps.length);
  for (let index = 0; index < fwdSteps.length; index++) {
    const mirror = reversed.steps[reversed.steps.length - 1 - index];
    expect(mirror.edge).toBe(fwdSteps[index].edge);
    expect(mirror.forward).toBe(!fwdSteps[index].forward);
    expect(mirror.side).toBe(fwdSteps[index].side);
  }
});

test("with ferries on solveApprox is connected and near-optimal", () => {
  // With the inconsistent ferry-credit heuristic the solver may settle a slightly costlier path than
  // the exact optimum, but it stays connected and within a small factor.
  const ods: [number, number][] = [
    [0, 15],
    [0, 12],
    [3, 15],
    [0, 9],
  ];
  let boarded = 0;
  for (const [from, to] of ods) {
    clearEdgePathCache();
    const start = ferrySnap(from);
    const dest = ferrySnap(to);
    const solved = new RouteSolver(
      ferryGrid.graph,
      start,
      weights(0.6, 0.8, true),
    ).solveApprox(dest);
    const label = `${from}->${to}`;
    expect(solved, label).not.toBeNull();
    expect(isConnected(ferryGrid.graph, solved as RouteResult), label).toBe(
      true,
    );
    const optimum = dijkstraCost(ferryGrid.graph, start, dest, 0.6, 0.8, true);
    const cost = effectiveCostOf(
      ferryGrid.graph,
      solved as RouteResult,
      0.6,
      0.8,
    );
    expect(cost, label).toBeGreaterThanOrEqual(optimum - 1e-6);
    expect(cost, label).toBeLessThanOrEqual(optimum * 1.05);
    if ((solved as RouteResult).steps.some((step) => step.kind === "ferry")) {
      boarded += 1;
    }
  }
  // At least one route actually rides the ferry, so the ferry path is exercised.
  expect(boarded).toBeGreaterThan(0);
});
