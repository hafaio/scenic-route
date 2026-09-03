import { expect, test } from "bun:test";
import { effSeconds, type RouteWeights, walkSpeedOn } from "./cost";
import {
  clearEdgePathCache,
  edgeKind,
  NO_GEOMETRY,
  type RoutingGraph,
} from "./graph";
import { findRoute, type RouteResult, type RouteStep } from "./search";
import { haversineMeters, type Snap } from "./snap";
import { PROXY_WEIGHTS, planWaypoints } from "./waypoints";

const SCALE = 1e-6;
const NAME_NONE = 0xffff;
const METERS_PER_DEGREE = 111_320;
// The kind bits `edgeKind` reads back out of `edgeKindSide`.
const KIND_BITS = { sidewalk: 0, crossing: 1, link: 2 } as const;

const weightsWith = (over: Partial<RouteWeights> = {}): RouteWeights => ({
  tree: 0,
  ferry: 0,
  landmark: 0,
  art: 0,
  highway: 0,
  hill: 0,
  commercial: 0,
  industrial: 0,
  historic: 0,
  shade: 0,
  shelter: 0,
  allowFerries: false,
  allowSheds: true,
  allowCrossings: false,
  ...over,
});

interface NodeSpec {
  east: number; // metres east of the origin
  north: number;
}

interface EdgeSpec {
  a: number;
  b: number;
  cover?: number; // 0..1 tree cover
  kind?: keyof typeof KIND_BITS; // sidewalk unless said otherwise
}

// A synthetic graph over points placed in metres. Only the fields the waypoint planner and findRoute
// read are filled; the cast covers the rest of the artifact's arrays.
function buildGraph(nodes: NodeSpec[], edges: EdgeSpec[]): RoutingGraph {
  clearEdgePathCache();
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const nodeQx = new Int32Array(nodeCount);
  const nodeQy = new Int32Array(nodeCount);
  for (const [node, { east, north }] of nodes.entries()) {
    nodeQx[node] = Math.round(east / METERS_PER_DEGREE / SCALE);
    nodeQy[node] = Math.round(north / METERS_PER_DEGREE / SCALE);
  }
  const nodeLat = (node: number): number => nodeQy[node] * SCALE;
  const nodeLng = (node: number): number => nodeQx[node] * SCALE;

  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeCover = new Uint8Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const incident: number[][] = Array.from({ length: nodeCount }, () => []);
  let maxCover = 0;
  for (const [edge, spec] of edges.entries()) {
    edgeNodeA[edge] = spec.a;
    edgeNodeB[edge] = spec.b;
    edgeLength[edge] = haversineMeters(
      nodeLat(spec.a),
      nodeLng(spec.a),
      nodeLat(spec.b),
      nodeLng(spec.b),
    );
    edgeKindSide[edge] = KIND_BITS[spec.kind ?? "sidewalk"];
    edgeCover[edge] = Math.min(254, Math.round((spec.cover ?? 0) * 255));
    maxCover = Math.max(maxCover, edgeCover[edge]);
    incident[spec.a].push(edge);
    incident[spec.b].push(edge);
  }

  const csr = new Uint32Array(nodeCount + 1);
  const adjacency = new Uint32Array(2 * edgeCount);
  let cursor = 0;
  for (const [node, own] of incident.entries()) {
    csr[node] = cursor;
    for (const edge of own) {
      adjacency[cursor] = edge;
      cursor += 1;
    }
  }
  csr[nodeCount] = cursor;

  const nodeMidRoadway = new Uint8Array(nodeCount);
  for (const [node, own] of incident.entries()) {
    nodeMidRoadway[node] =
      own.length > 0 && own.every((edge) => edges[edge].kind === "crossing")
        ? 1
        : 0;
  }

  return {
    nodeCount,
    edgeCount,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx,
    nodeQy,
    csr,
    adjacency,
    edgeNodeA,
    edgeNodeB,
    edgeLength,
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
    edgeCover,
    edgeNameId: new Uint16Array(edgeCount).fill(NAME_NONE),
    edgeKindSide,
    nodeMidRoadway,
    maxCover: maxCover / 255,
    edgeLandmark: new Uint8Array(edgeCount),
    edgeArt: new Uint8Array(edgeCount),
    edgeHighway: new Uint8Array(edgeCount),
    edgeCommercial: new Uint8Array(edgeCount),
    edgeIndustrial: new Uint8Array(edgeCount),
    edgeHistoric: new Uint8Array(edgeCount),
    edgeDirectCanopy: new Uint8Array(edgeCount),
    edgeAscent: new Uint8Array(edgeCount),
    edgeDescent: new Uint8Array(edgeCount),
    maxRelief: 0,
    maxDirectCanopy: 0,
    maxLandmark: 0,
    maxArt: 0,
    maxCommercial: 0,
    maxIndustrial: 0,
    maxHistoric: 0,
    shade: null,
    sheds: null,
    ferries: null,
    edgeDurationSeconds: new Float32Array(edgeCount),
    ferryEdges: new Uint32Array(0),
    minFerrySecPerMetre: Number.POSITIVE_INFINITY,
    edgeFlags: new Uint8Array(edgeCount),
    names: [],
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

const at = (graph: RoutingGraph, node: number) => ({
  lat: graph.originLat + graph.nodeQy[node] * graph.scale,
  lng: graph.originLng + graph.nodeQx[node] * graph.scale,
});

// One step of a hand-built route, for the shapes findRoute is not supposed to produce.
function walkStep(
  graph: RoutingGraph,
  edge: number,
  forward: boolean,
  lengthMeters = graph.edgeLength[edge],
): RouteStep {
  return {
    edge,
    forward,
    kind: edgeKind(graph, edge),
    side: null,
    name: null,
    cover: 0,
    lengthMeters,
  };
}

// A snap halfway along an edge, so the route's first and last steps are partial walks the way a real
// query's are.
function midEdgeSnap(graph: RoutingGraph, edge: number): Snap {
  const from = at(graph, graph.edgeNodeA[edge]);
  const to = at(graph, graph.edgeNodeB[edge]);
  return {
    edge,
    metersFromA: graph.edgeLength[edge] / 2,
    point: { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 },
    distanceMeters: 0,
    component: 0,
  };
}

// A chain of `covers.length` diamonds: between two junctions runs a bare 300 m street and a leafy
// one 8% longer over a mid-block corner, so a tree-weighted route takes the long way round every time
// and a plain walking router takes the short one. Each detour's corner is the only thing that can
// hold an outside router to it.
interface Diamond {
  corner: number; // the node a pin would land on
  direct: number; // the bare edge the proxy prefers
  around: [number, number]; // the two leafy edges the route takes instead
}

function diamondChain(covers: readonly number[]): {
  graph: RoutingGraph;
  route: RouteResult;
  diamonds: Diamond[];
} {
  const nodes: NodeSpec[] = [
    { east: -200, north: 0 }, // the lead-in's far end, which the start snap sits halfway along
    { east: 0, north: 0 },
  ];
  const edges: EdgeSpec[] = [{ a: 0, b: 1 }];
  const diamonds: Diamond[] = [];
  let junction = 1;
  for (const [index, cover] of covers.entries()) {
    nodes.push({ east: index * 300 + 150, north: 60 }); // the detour's corner
    const corner = nodes.length - 1;
    nodes.push({ east: index * 300 + 150, north: 120 }); // a kerb across the street from it
    const kerb = nodes.length - 1;
    nodes.push({ east: (index + 1) * 300, north: 0 });
    const next = nodes.length - 1;
    edges.push({ a: junction, b: next });
    const direct = edges.length - 1;
    edges.push({ a: junction, b: corner, cover });
    edges.push({ a: corner, b: next, cover });
    edges.push({ a: corner, b: kerb, kind: "crossing" });
    diamonds.push({ corner, direct, around: [direct + 1, direct + 2] });
    junction = next;
  }
  nodes.push({ east: covers.length * 300 + 200, north: 0 });
  edges.push({ a: junction, b: nodes.length - 1 });
  const leadOut = edges.length - 1;

  const graph = buildGraph(nodes, edges);
  const route = findRoute(
    graph,
    midEdgeSnap(graph, 0),
    midEdgeSnap(graph, leadOut),
    weightsWith({ tree: 0.8 }),
  );
  if (!route) {
    throw new Error("the fixture route should exist");
  }
  return { graph, route, diamonds };
}

test("proxy weights price an edge at exactly the walk along it", () => {
  // The planner's inner loop writes this walk out rather than calling the multiplier, so the two have
  // to agree: every scenic factor is 1 at these weights and a freely-spent crossing adds nothing.
  const graph = buildGraph(
    [
      { east: 0, north: 0 },
      { east: 100, north: 0 },
      { east: 100, north: 20 },
    ],
    [
      { a: 0, b: 1, cover: 0.9 },
      { a: 1, b: 2, kind: "crossing" },
    ],
  );
  for (const edge of [0, 1]) {
    expect(
      effSeconds(graph, edge, PROXY_WEIGHTS, 0, graph.edgeNodeA[edge]),
    ).toBeCloseTo(graph.edgeLength[edge] / walkSpeedOn(graph, edge, true), 9);
  }
});

test("a route whose every detour fits in the waypoint budget loses nothing", () => {
  const { graph, route, diamonds } = diamondChain([0.5, 0.5, 0.5]);
  const plan = planWaypoints(graph, route, weightsWith({ tree: 0.8 }), 9);
  expect(plan.candidateCount).toBe(3);
  expect(plan.waypoints).toEqual(
    diamonds.map(({ corner }) => at(graph, corner)),
  );
  expect(plan.lostSeconds).toBeCloseTo(0, 6);
});

test("with no waypoints at all the loss is the scenic value of every detour", () => {
  const { graph, route, diamonds } = diamondChain([0.5, 0.5, 0.5]);
  const weights = weightsWith({ tree: 0.8 });
  const plan = planWaypoints(graph, route, weights, 0);
  expect(plan.waypoints).toEqual([]);
  // Every bare street walked in place of the leafy way round it, priced by the reader's own weights.
  const forfeited = diamonds.reduce(
    (total, { direct, around }) =>
      total +
      effSeconds(graph, direct, weights) -
      around.reduce((sum, edge) => sum + effSeconds(graph, edge, weights), 0),
    0,
  );
  expect(plan.lostSeconds).toBeCloseTo(forfeited, 6);
});

test("a budget too small for every detour is spent on the leafiest", () => {
  const { graph, route, diamonds } = diamondChain([0.2, 0.5, 0.9]);
  const plan = planWaypoints(graph, route, weightsWith({ tree: 0.8 }), 1);
  expect(plan.waypoints).toEqual([at(graph, diamonds[2].corner)]);
  const two = planWaypoints(graph, route, weightsWith({ tree: 0.8 }), 2);
  expect(two.waypoints).toEqual([
    at(graph, diamonds[1].corner),
    at(graph, diamonds[2].corner),
  ]);
  expect(two.lostSeconds).toBeLessThan(plan.lostSeconds);
});

test("two corners of one intersection give the planner one candidate", () => {
  // The kerb and the far side of the crossing it meets are one place to Google, which snaps both to
  // the same road node, so the crossing between them is what joins them — and the earlier of the two
  // is what a pin lands on.
  const graph = buildGraph(
    [
      { east: -100, north: 0 }, // the lead-in's far end
      { east: 0, north: 0 }, // where the interior walk starts
      { east: 150, north: 0 }, // the near kerb
      { east: 150, north: 50 }, // the far kerb, one crossing away
      { east: 300, north: 50 },
      { east: 500, north: 50 }, // the lead-out's far end
    ],
    [
      { a: 0, b: 1 },
      { a: 1, b: 2, cover: 0.6 },
      { a: 2, b: 3, kind: "crossing" },
      { a: 3, b: 4, cover: 0.6 },
      { a: 4, b: 5 },
      { a: 1, b: 4 }, // the bare street the proxy would take instead
    ],
  );
  const throughTheCorners = {
    steps: [
      walkStep(graph, 0, true, graph.edgeLength[0] / 2),
      walkStep(graph, 1, true),
      walkStep(graph, 2, true),
      walkStep(graph, 3, true),
      walkStep(graph, 4, true, graph.edgeLength[4] / 2),
    ],
  } as RouteResult;

  const plan = planWaypoints(
    graph,
    throughTheCorners,
    weightsWith({ tree: 0.8 }),
    9,
  );
  expect(plan.candidateCount).toBe(1);
  expect(plan.waypoints).toEqual([at(graph, 2)]);
});

test("a crossing chained through an island is still one intersection", () => {
  // A divided street is crossed in two 30 m pieces with an island between them, which puts the far
  // kerb 60 m of walking from the near one. Nothing about the distance says these are one place; the
  // chain of crossings through a node standing in the roadway is what says it.
  const graph = buildGraph(
    [
      { east: -100, north: 0 }, // the lead-in's far end
      { east: 0, north: 0 }, // where the interior walk starts
      { east: 150, north: 0 }, // the near kerb
      { east: 150, north: 30 }, // the island, its every edge a crossing
      { east: 150, north: 60 }, // the far kerb
      { east: 300, north: 60 },
      { east: 500, north: 60 }, // the lead-out's far end
    ],
    [
      { a: 0, b: 1 },
      { a: 1, b: 2, cover: 0.6 },
      { a: 2, b: 3, kind: "crossing" },
      { a: 3, b: 4, kind: "crossing" },
      { a: 4, b: 5, cover: 0.6 },
      { a: 5, b: 6 },
      { a: 1, b: 5 }, // the bare street the proxy would take instead
    ],
  );
  const acrossTheAvenue = {
    steps: [
      walkStep(graph, 0, true, graph.edgeLength[0] / 2),
      walkStep(graph, 1, true),
      walkStep(graph, 2, true),
      walkStep(graph, 3, true),
      walkStep(graph, 4, true),
      walkStep(graph, 5, true, graph.edgeLength[5] / 2),
    ],
  } as RouteResult;

  const plan = planWaypoints(
    graph,
    acrossTheAvenue,
    weightsWith({ tree: 0.8 }),
    9,
  );
  expect(plan.candidateCount).toBe(1);
  expect(plan.waypoints).toEqual([at(graph, 2)]);
});

test("a link to a nearby path junction is a second intersection", () => {
  // A kerb and the mouth of a park path 20 m along the link that joins them: two places a walker can
  // be told to go, however close together they stand, since a link is not a way across a street. The
  // bare street the proxy prefers leaves both leafy edges behind, and the shortcut off the kerb
  // leaves the second, so it takes a pin at each to hold it to the route.
  const graph = buildGraph(
    [
      { east: -100, north: 0 }, // the lead-in's far end
      { east: 0, north: 0 }, // where the interior walk starts
      { east: 150, north: 60 }, // the kerb
      { east: 150, north: 100 }, // a kerb across the street, making it a corner
      { east: 170, north: 60 }, // the path junction, one 20 m link away
      { east: 170, north: 100 }, // the far side of the path's own crossing
      { east: 400, north: 0 },
      { east: 600, north: 0 }, // the lead-out's far end
    ],
    [
      { a: 0, b: 1 },
      { a: 1, b: 2, cover: 0.6 },
      { a: 2, b: 3, kind: "crossing" },
      { a: 2, b: 4, kind: "link" },
      { a: 4, b: 5, kind: "crossing" },
      { a: 4, b: 6, cover: 0.6 },
      { a: 6, b: 7 },
      { a: 1, b: 6 }, // the bare street the proxy would take instead
      { a: 2, b: 6 }, // and its shortcut back to the far end from the kerb
    ],
  );
  const ontoThePath = {
    steps: [
      walkStep(graph, 0, true, graph.edgeLength[0] / 2),
      walkStep(graph, 1, true),
      walkStep(graph, 3, true),
      walkStep(graph, 5, true),
      walkStep(graph, 6, true, graph.edgeLength[6] / 2),
    ],
  } as RouteResult;

  const plan = planWaypoints(graph, ontoThePath, weightsWith({ tree: 0.8 }), 9);
  expect(plan.candidateCount).toBe(2);
  expect(plan.waypoints).toEqual([at(graph, 2), at(graph, 4)]);
});

test("an equal-cost alternative does not cost the route its own value", () => {
  // Two ways round of identical walking cost, one of them the route's: a leafy detour and a bare
  // mirror image of it. The leg gives up nothing whichever the proxy walks, since the walker Google
  // sends could as well have taken ours. The edge order below is what makes its search settle the
  // bare way first, which is the order that used to settle the question.
  const graph = buildGraph(
    [
      { east: -100, north: 0 }, // the lead-in's far end
      { east: 0, north: 0 }, // where the two ways part
      { east: 150, north: 80 }, // the leafy corner the route takes
      { east: 150, north: -80 }, // its bare mirror image
      { east: 300, north: 0 }, // where they meet again
      { east: 500, north: 0 }, // the lead-out's far end
      { east: 150, north: 140 }, // a kerb across the street, making the corner one
    ],
    [
      { a: 0, b: 1 },
      { a: 1, b: 2, cover: 0.9 },
      { a: 2, b: 4, cover: 0.9 },
      { a: 1, b: 3 },
      { a: 3, b: 4 },
      { a: 4, b: 5 },
      { a: 2, b: 6, kind: "crossing" },
    ],
  );
  const theLeafyWay = {
    steps: [
      walkStep(graph, 0, true, graph.edgeLength[0] / 2),
      walkStep(graph, 1, true),
      walkStep(graph, 2, true),
      walkStep(graph, 5, true, graph.edgeLength[5] / 2),
    ],
  } as RouteResult;

  const plan = planWaypoints(graph, theLeafyWay, weightsWith({ tree: 0.8 }), 0);
  expect(plan.waypoints).toEqual([]);
  expect(plan.lostSeconds).toBeCloseTo(0, 6);
});

test("a route that doubles back through a node it already used still terminates", () => {
  // Our graph is not supposed to produce one, which is exactly why this is built by hand: a walk out
  // to a dead end and back visits its junction twice, and the junction must not become a second
  // candidate — a leg that ends where an earlier one began makes no progress and the DAG cannot
  // express it. The junction carries a crossing of its own, so it is a corner and nothing but the
  // route's own history keeps it out of the candidates.
  const graph = buildGraph(
    [
      { east: -100, north: 0 }, // the lead in's far end
      { east: 0, north: 0 }, // the junction, visited twice
      { east: 0, north: 120 }, // the spur's far end
      { east: 0, north: 180 }, // a kerb across the street from the spur, making it a corner
      { east: 200, north: 0 },
      { east: 400, north: 0 }, // the lead out's far end
      { east: 0, north: -60 }, // a kerb across the street from the junction
    ],
    [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
      { a: 2, b: 3, kind: "crossing" },
      { a: 1, b: 4 },
      { a: 4, b: 5 },
      { a: 1, b: 6, kind: "crossing" },
    ],
  );
  const doubledBack = {
    steps: [
      walkStep(graph, 0, true, graph.edgeLength[0] / 2),
      walkStep(graph, 1, true),
      walkStep(graph, 1, false),
      walkStep(graph, 3, true),
      walkStep(graph, 4, true, graph.edgeLength[4] / 2),
    ],
  } as RouteResult;

  const plan = planWaypoints(graph, doubledBack, weightsWith(), 9);
  expect(plan.candidateCount).toBe(1); // the spur's end; the junction's second visit is not a candidate
  expect(plan.waypoints.length).toBeLessThanOrEqual(1);
});
