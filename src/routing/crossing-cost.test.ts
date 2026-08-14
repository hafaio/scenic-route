// The crossing wait is charged per crossing, not per crossing EDGE. A divided street is drawn as
// several crossing ways chained through the islands between them, so these fixtures are shaped around
// that: a plain crossing is one edge, a median crossing is three, and both must cost one wait.

import { expect, test } from "bun:test";
import { CROSSING_SECONDS, crossingWait, rawSeconds } from "./cost";
import { markMidRoadwayNodes, type RoutingGraph } from "./graph";

const KIND_SIDEWALK = 0;
const KIND_CROSSING = 1;

interface EdgeSpec {
  a: number;
  b: number;
  crossing: boolean;
  meters: number;
}

// Only the fields the wait reads; the cost model touches nothing else here.
function graphOf(nodeCount: number, edges: EdgeSpec[]): RoutingGraph {
  const edgeCount = edges.length;
  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const incident: number[][] = Array.from({ length: nodeCount }, () => []);
  edges.forEach((spec, edge) => {
    edgeNodeA[edge] = spec.a;
    edgeNodeB[edge] = spec.b;
    edgeLength[edge] = spec.meters;
    edgeKindSide[edge] = spec.crossing ? KIND_CROSSING : KIND_SIDEWALK;
    incident[spec.a].push(edge);
    incident[spec.b].push(edge);
  });

  const csr = new Uint32Array(nodeCount + 1);
  const adjacency = new Uint32Array(2 * edgeCount);
  let cursor = 0;
  for (let node = 0; node < nodeCount; node += 1) {
    csr[node] = cursor;
    for (const edge of incident[node]) {
      adjacency[cursor] = edge;
      cursor += 1;
    }
  }
  csr[nodeCount] = cursor;

  return {
    edgeNodeA,
    edgeNodeB,
    edgeLength,
    edgeKindSide,
    csr,
    adjacency,
    edgeRelief: new Uint8Array(edgeCount), // flat: these fixtures are about crossings, not grades
    edgeDurationSeconds: new Float32Array(edgeCount),
    nodeMidRoadway: markMidRoadwayNodes(
      nodeCount,
      csr,
      adjacency,
      edgeKindSide,
    ),
  } as unknown as RoutingGraph;
}

// kerb 0 -> kerb 1 across one roadway, with pavement running off each kerb.
const PLAIN = graphOf(4, [
  { a: 2, b: 0, crossing: false, meters: 30 },
  { a: 0, b: 1, crossing: true, meters: 12 },
  { a: 1, b: 3, crossing: false, meters: 30 },
]);

// kerb 0 -> island 4 -> island 5 -> kerb 1: one crossing drawn as three chained ways.
const DIVIDED = graphOf(6, [
  { a: 2, b: 0, crossing: false, meters: 30 },
  { a: 0, b: 4, crossing: true, meters: 10 },
  { a: 4, b: 5, crossing: true, meters: 4 },
  { a: 5, b: 1, crossing: true, meters: 10 },
  { a: 1, b: 3, crossing: false, meters: 30 },
]);

test("a kerb is pavement and an island is mid-roadway", () => {
  expect(DIVIDED.nodeMidRoadway[0]).toBe(0); // kerb: a sidewalk runs off it
  expect(DIVIDED.nodeMidRoadway[4]).toBe(1); // island: every edge on it is a crossing
  expect(DIVIDED.nodeMidRoadway[5]).toBe(1);
  expect(PLAIN.nodeMidRoadway[0]).toBe(0);
});

test("stepping off the kerb costs one wait, walking the pavement costs none", () => {
  expect(crossingWait(PLAIN, 1, 0)).toBe(CROSSING_SECONDS);
  expect(crossingWait(PLAIN, 1, 1)).toBe(CROSSING_SECONDS); // crossed the other way
  expect(crossingWait(PLAIN, 0, 2)).toBe(0);
});

test("a median crossing is billed once, not once per chained way", () => {
  const legs: Array<[number, number]> = [
    [1, 0],
    [2, 4],
    [3, 5],
  ];
  const total = legs.reduce(
    (sum, [edge, from]) => sum + crossingWait(DIVIDED, edge, from),
    0,
  );
  expect(total).toBe(CROSSING_SECONDS);
});

test("the wait rides on the ETA unit, on top of the walked time", () => {
  const walked = PLAIN.edgeLength[1] / 1.3;
  expect(rawSeconds(PLAIN, 1, 0)).toBeCloseTo(walked + CROSSING_SECONDS, 6);
  // entered from the island, the same edge is a continuation and owes nothing
  expect(rawSeconds(DIVIDED, 2, 4)).toBeCloseTo(DIVIDED.edgeLength[2] / 1.3, 6);
});
