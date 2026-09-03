// The synthetic routing graph the ferry tests are run over, and the two questions that need one.
//
// A ferry test cannot use a fixture cut out of a real city: the crossings that matter are the ones
// where the water is the only way through, and the shape of that — two land masses, no walking edge
// between them — is a statement about the graph rather than about any city's geometry. So it is
// built here, and both the cost tests (src/routing/ferry-cost.test.ts) and the sole-crossing tests
// (src/routing/sole-crossing.test.ts) read it, which is what keeps the two asking about the same
// object.

import type { RouteWeights } from "./cost";
import type { RoutingGraph } from "./graph";
import { NO_GEOMETRY } from "./graph";
import { haversineMeters, type Snap } from "./snap";

export const SCALE = 1e-6;
export const NAME_NONE = 0xffff;
export const KIND_SIDEWALK = 0;
export const KIND_FERRY = 4;

export const weights = (
  tree: number,
  ferry: number,
  allowFerries: boolean,
): RouteWeights => ({
  tree,
  ferry,
  landmark: 0,
  art: 0,
  highway: 0,
  hill: 0,
  commercial: 0,
  industrial: 0,
  historic: 0,
  shade: 0,
  shelter: 0,
  allowFerries,
  allowSheds: true,
  // The fixture draws no crossing edges, so this is free either way; it is stated because a
  // RouteWeights that omits it reads as "avoid crossings", which is not what these tests mean.
  allowCrossings: true,
});

export interface NodeSpec {
  lat: number;
  lng: number;
}

export interface EdgeSpec {
  a: number;
  b: number;
  ferry: boolean;
  cover: number; // 0..1, walking edges only
  durationSeconds: number; // ferry edges only
}

// Build a synthetic routing graph from nodes and edges. Every edge is a straight line, so its
// length is the geodesic span between its two (quantized-and-reconstructed) endpoints — exactly the
// coordinates the A* heuristic reads, which keeps the walking lower bound admissible by construction.
export function buildGraph(nodes: NodeSpec[], edges: EdgeSpec[]): RoutingGraph {
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
    edgeAscent: new Uint8Array(edgeCount),
    edgeDescent: new Uint8Array(edgeCount),
    maxRelief: 0,
    edgeCommercial: new Uint8Array(edgeCount),
    edgeIndustrial: new Uint8Array(edgeCount),
    edgeHistoric: new Uint8Array(edgeCount),
    maxLandmark: 0,
    maxArt: 0,
    maxCommercial: 0,
    maxIndustrial: 0,
    maxHistoric: 0,
    shade: null,
    edgeDurationSeconds,
    ferryEdges: Uint32Array.from(ferryEdges),
    names: [],
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

// A start/dest snap sitting exactly on a node, entered through one of its incident walking edges
// (snaps never land on a ferry). metersFromA is 0 or the full length so the virtual point coincides
// with the node.
export function snapAtNode(
  graph: RoutingGraph,
  node: number,
  walkEdge: number,
): Snap {
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
