import { expect, test } from "bun:test";
import { buildDirections } from "./directions";
import {
  type EdgeKind,
  NO_GEOMETRY,
  type RoutingGraph,
  type SideLabel,
} from "./graph";
import type { RouteResult, RouteStep } from "./search";

const SCALE = 1e-6;

// A minimal geometry-less graph: every edge is a straight line between two node coordinates, which
// is all buildDirections needs (it reads step labels directly and only calls edgePath for bearings).
function makeGraph(nodes: ReadonlyArray<[number, number]>): RoutingGraph {
  const count = nodes.length;
  const nodeQx = new Int32Array(count);
  const nodeQy = new Int32Array(count);
  for (let index = 0; index < count; index++) {
    const [lat, lng] = nodes[index];
    nodeQx[index] = Math.round(lng / SCALE);
    nodeQy[index] = Math.round(lat / SCALE);
  }
  return {
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx,
    nodeQy,
    edgeGeomOffset: new Uint32Array(0),
    edgeGeomCount: new Uint16Array(0),
    edgeNodeA: new Uint32Array(0),
    edgeNodeB: new Uint32Array(0),
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

interface EdgeSpec {
  a: number;
  b: number;
  kind: EdgeKind;
  side: SideLabel;
  name: string | null;
  lengthMeters: number;
}

// Build steps (and the geometry-less edge arrays they reference) walking a -> b along each spec.
function makeResult(graph: RoutingGraph, specs: ReadonlyArray<EdgeSpec>) {
  const edgeCount = specs.length;
  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeGeomOffset = new Uint32Array(edgeCount).fill(NO_GEOMETRY);
  const edgeGeomCount = new Uint16Array(edgeCount);
  const steps: RouteStep[] = [];
  for (let edge = 0; edge < edgeCount; edge++) {
    const spec = specs[edge];
    edgeNodeA[edge] = spec.a;
    edgeNodeB[edge] = spec.b;
    steps.push({
      edge,
      forward: true,
      kind: spec.kind,
      side: spec.side,
      name: spec.name,
      cover: 0,
      lengthMeters: spec.lengthMeters,
    });
  }
  const wired = graph as unknown as {
    edgeNodeA: Uint32Array;
    edgeNodeB: Uint32Array;
    edgeGeomOffset: Uint32Array;
    edgeGeomCount: Uint16Array;
  };
  wired.edgeNodeA = edgeNodeA;
  wired.edgeNodeB = edgeNodeB;
  wired.edgeGeomOffset = edgeGeomOffset;
  wired.edgeGeomCount = edgeGeomCount;
  return { steps } as unknown as RouteResult;
}

test("start, cross with suppressed continuation, left turn, arrive", () => {
  // North up 5th Ave (west side), cross E 20 St, continue north (suppressed), left onto E 21 St.
  const graph = makeGraph([
    [40.74, -73.99], // 0
    [40.741, -73.99], // 1
    [40.7412, -73.99], // 2
    [40.742, -73.99], // 3
    [40.742, -73.991], // 4 (due west of 3)
  ]);
  const result = makeResult(graph, [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 111,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "E 20 ST",
      lengthMeters: 18,
    },
    {
      a: 2,
      b: 3,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 20,
    },
    {
      a: 3,
      b: 4,
      kind: "sidewalk",
      side: "north",
      name: "E 21 ST",
      lengthMeters: 90,
    },
  ]);
  const maneuvers = buildDirections(graph, result);

  expect(maneuvers.map((m) => m.kind)).toEqual([
    "start",
    "cross",
    "turn",
    "arrive",
  ]);
  expect(maneuvers[0].text).toBe("Walk north on the west side of 5th Avenue");
  expect(maneuvers[1].text).toBe("Cross East 20th Street");
  // The suppressed continuation folds its length into the crossing.
  expect(maneuvers[1].lengthMeters).toBe(38);
  expect(maneuvers[1].stepRange).toEqual([1, 3]);
  expect(maneuvers[2].turn).toBe("left");
  expect(maneuvers[2].text).toBe(
    "Turn left onto the north side of East 21st Street",
  );
  expect(maneuvers[3].text).toBe(
    "Arrive — on the north side of East 21st Street",
  );
});

test("link steps are silent and paths follow", () => {
  const graph = makeGraph([
    [40.57, -73.98], // 0
    [40.571, -73.98], // 1
    [40.5711, -73.9801], // 2 (link hop)
    [40.5711, -73.981], // 3 (boardwalk, heading west)
  ]);
  const result = makeResult(graph, [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "east",
      name: "STILLWELL AVE",
      lengthMeters: 120,
    },
    { a: 1, b: 2, kind: "link", side: null, name: null, lengthMeters: 8 },
    {
      a: 2,
      b: 3,
      kind: "path",
      side: null,
      name: "BOARDWALK",
      lengthMeters: 200,
    },
  ]);
  const maneuvers = buildDirections(graph, result);

  expect(maneuvers.map((m) => m.kind)).toEqual(["start", "path", "arrive"]);
  expect(maneuvers[0].text).toBe(
    "Walk north on the east side of Stillwell Avenue",
  );
  // The link's 8 m fold into the start run's length (120 + 8 goes to the run it touches).
  expect(maneuvers[1].text).toBe("Follow Boardwalk");
  expect(maneuvers[1].lengthMeters).toBe(200);
});

test("consecutive same-name crossings merge into one", () => {
  const graph = makeGraph([
    [40.68, -73.977], // 0
    [40.681, -73.977], // 1
    [40.6812, -73.977], // 2
    [40.6814, -73.977], // 3
  ]);
  const result = makeResult(graph, [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "4 AVE",
      lengthMeters: 100,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "ATLANTIC AVE",
      lengthMeters: 15,
    },
    {
      a: 2,
      b: 3,
      kind: "crossing",
      side: null,
      name: "ATLANTIC AVE",
      lengthMeters: 15,
    },
  ]);
  const maneuvers = buildDirections(graph, result);

  const crossings = maneuvers.filter((m) => m.kind === "cross");
  expect(crossings).toHaveLength(1);
  expect(crossings[0].text).toBe("Cross Atlantic Avenue");
  expect(crossings[0].lengthMeters).toBe(30);
});

test("linear crossings collapse into one walk maneuver", () => {
  // North up 5th Ave (west side), crossing E 23 St then E 22 St, staying on the same street+side.
  const graph = makeGraph([
    [40.74, -73.99], // 0
    [40.741, -73.99], // 1
    [40.7412, -73.99], // 2
    [40.742, -73.99], // 3
    [40.7422, -73.99], // 4
    [40.743, -73.99], // 5
  ]);
  const specs: ReadonlyArray<EdgeSpec> = [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 100,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "E 23 ST",
      lengthMeters: 18,
    },
    {
      a: 2,
      b: 3,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 20,
    },
    {
      a: 3,
      b: 4,
      kind: "crossing",
      side: null,
      name: "E 22 ST",
      lengthMeters: 18,
    },
    {
      a: 4,
      b: 5,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 30,
    },
  ];

  const expanded = buildDirections(graph, makeResult(graph, specs), {
    collapseLinearCrossings: false,
  });
  expect(expanded.map((m) => m.kind)).toEqual([
    "start",
    "cross",
    "cross",
    "arrive",
  ]);
  expect(expanded.filter((m) => m.kind === "cross")).toHaveLength(2);

  const collapsed = buildDirections(graph, makeResult(graph, specs), {
    collapseLinearCrossings: true,
  });
  expect(collapsed.map((m) => m.kind)).toEqual(["start", "arrive"]);
  expect(collapsed[0].text).toBe("Walk north on the west side of 5th Avenue");
  // The whole straight segment (both crossings + every walk run) folds into the one walk.
  expect(collapsed[0].lengthMeters).toBe(186);
  expect(collapsed[0].stepRange).toEqual([0, 5]);
});

test("an action crossing survives collapsing", () => {
  // North up 5th Ave (west) past two linear crossings, then cross E 21 St and turn left onto it — the
  // final crossing is an action (the street+side changes across it), so it must survive collapsing.
  const graph = makeGraph([
    [40.74, -73.99], // 0
    [40.741, -73.99], // 1
    [40.7412, -73.99], // 2
    [40.742, -73.99], // 3
    [40.7422, -73.99], // 4
    [40.743, -73.99], // 5
    [40.7432, -73.99], // 6
    [40.7432, -73.991], // 7 (due west of 6)
  ]);
  const specs: ReadonlyArray<EdgeSpec> = [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 100,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "E 23 ST",
      lengthMeters: 18,
    },
    {
      a: 2,
      b: 3,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 20,
    },
    {
      a: 3,
      b: 4,
      kind: "crossing",
      side: null,
      name: "E 22 ST",
      lengthMeters: 18,
    },
    {
      a: 4,
      b: 5,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 30,
    },
    {
      a: 5,
      b: 6,
      kind: "crossing",
      side: null,
      name: "E 21 ST",
      lengthMeters: 18,
    },
    {
      a: 6,
      b: 7,
      kind: "sidewalk",
      side: "north",
      name: "E 21 ST",
      lengthMeters: 90,
    },
  ];

  const collapsed = buildDirections(graph, makeResult(graph, specs), {
    collapseLinearCrossings: true,
  });
  // The two linear crossings fold away; only the action crossing and the turn remain.
  expect(collapsed.map((m) => m.kind)).toEqual([
    "start",
    "cross",
    "turn",
    "arrive",
  ]);
  expect(collapsed.filter((m) => m.kind === "cross")).toHaveLength(1);
  expect(collapsed[1].text).toBe("Cross East 21st Street");
  expect(collapsed[2].turn).toBe("left");
});
