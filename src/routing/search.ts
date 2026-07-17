// A* over the routing graph with virtual start/dest points sitting partway along their snapped
// edges. A shaded edge can cost less than its length at high weight, so the straight-line heuristic
// is scaled by the least possible multiplier (minMultiplier) — a lower bound on remaining cost that
// keeps the search admissible and consistent, and so optimal.

import {
  edgeCover,
  edgeMultiplier,
  minMultiplier,
  WALK_METERS_PER_SECOND,
} from "./cost";
import {
  type EdgeKind,
  edgeKind,
  edgeName,
  edgePath,
  edgeSideLabel,
  otherEnd,
  type RoutingGraph,
  type SideLabel,
} from "./graph";
import { haversineMeters, type Snap } from "./snap";

export interface RouteStep {
  edge: number;
  forward: boolean; // travelled a -> b?
  kind: EdgeKind;
  side: SideLabel; // the stored side of the sidewalk (null for crossings/links/paths), not travel-flipped
  name: string | null; // the edge's street name, unprettified, or null
  cover: number; // 0..1, this edge's cover
  lengthMeters: number; // walked length; partial on the end edges
}

export interface RouteResult {
  path: { lats: Float64Array; lngs: Float64Array }; // stitched, end-edge partials trimmed at the snaps
  steps: RouteStep[];
  lengthMeters: number;
  walkSeconds: number;
  coverFraction: number; // length-weighted mean of the chosen-side cover
  start: Snap;
  dest: Snap;
}

// Last-search instrumentation, for profiling and tests. Not part of the route itself.
export const routeDiagnostics = { nodesSettled: 0 };

// A binary min-heap over parallel key/id arrays, grown by doubling. Stale entries are left in
// place and skipped on pop (lazy deletion), which is cheaper than sifting on every relaxation.
class NodeHeap {
  private keys: Float64Array;
  private ids: Uint32Array;
  private size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.ids = new Uint32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  push(key: number, id: number): void {
    if (this.size === this.keys.length) {
      const grownKeys = new Float64Array(this.keys.length * 2);
      const grownIds = new Uint32Array(this.ids.length * 2);
      grownKeys.set(this.keys);
      grownIds.set(this.ids);
      this.keys = grownKeys;
      this.ids = grownIds;
    }
    let child = this.size;
    this.keys[child] = key;
    this.ids[child] = id;
    this.size += 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.keys[parent] <= this.keys[child]) {
        break;
      }
      this.swap(parent, child);
      child = parent;
    }
  }

  peekKey(): number {
    return this.keys[0];
  }

  pop(): number {
    const id = this.ids[0];
    this.size -= 1;
    this.keys[0] = this.keys[this.size];
    this.ids[0] = this.ids[this.size];
    let parent = 0;
    for (;;) {
      const left = 2 * parent + 1;
      const right = left + 1;
      let smallest = parent;
      if (left < this.size && this.keys[left] < this.keys[smallest]) {
        smallest = left;
      }
      if (right < this.size && this.keys[right] < this.keys[smallest]) {
        smallest = right;
      }
      if (smallest === parent) {
        break;
      }
      this.swap(parent, smallest);
      parent = smallest;
    }
    return id;
  }

  private swap(left: number, right: number): void {
    const key = this.keys[left];
    this.keys[left] = this.keys[right];
    this.keys[right] = key;
    const id = this.ids[left];
    this.ids[left] = this.ids[right];
    this.ids[right] = id;
  }
}

// The polyline of an edge between two along-distances (a -> b order), with the boundaries
// interpolated. Along-distance is measured in the same scaled metric as Snap.metersFromA.
function subPolyline(
  graph: RoutingGraph,
  edge: number,
  fromMeters: number,
  toMeters: number,
): { lngs: number[]; lats: number[] } {
  const { lngs, lats } = edgePath(graph, edge);
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(lats[0] * toRad);
  const cumulative = new Float64Array(lngs.length);
  for (let vertex = 1; vertex < lngs.length; vertex++) {
    const deltaX = (lngs[vertex] - lngs[vertex - 1]) * cosLat;
    const deltaY = lats[vertex] - lats[vertex - 1];
    cumulative[vertex] = cumulative[vertex - 1] + Math.hypot(deltaX, deltaY);
  }
  const total = cumulative[lngs.length - 1];
  const scale = total > 0 ? graph.edgeLength[edge] / total : 0;

  const at = (distance: number): { lng: number; lat: number } => {
    if (scale === 0) {
      return { lng: lngs[0], lat: lats[0] };
    }
    const raw = distance / scale;
    let vertex = 1;
    while (vertex < lngs.length - 1 && cumulative[vertex] < raw) {
      vertex += 1;
    }
    const span = cumulative[vertex] - cumulative[vertex - 1];
    const param = span > 0 ? (raw - cumulative[vertex - 1]) / span : 0;
    return {
      lng: lngs[vertex - 1] + param * (lngs[vertex] - lngs[vertex - 1]),
      lat: lats[vertex - 1] + param * (lats[vertex] - lats[vertex - 1]),
    };
  };

  const start = at(fromMeters);
  const outLngs = [start.lng];
  const outLats = [start.lat];
  for (let vertex = 0; vertex < lngs.length; vertex++) {
    const along = cumulative[vertex] * scale;
    if (along > fromMeters && along < toMeters) {
      outLngs.push(lngs[vertex]);
      outLats.push(lats[vertex]);
    }
  }
  const end = at(toMeters);
  outLngs.push(end.lng);
  outLats.push(end.lat);
  return { lngs: outLngs, lats: outLats };
}

// Append a step's polyline to the running path, dropping the shared junction vertex except on the
// very first step.
function appendPolyline(
  lngsOut: number[],
  latsOut: number[],
  lngs: number[],
  lats: number[],
  forward: boolean,
  first: boolean,
): void {
  const count = lngs.length;
  for (let index = 0; index < count; index++) {
    const source = forward ? index : count - 1 - index;
    if (!first && index === 0) {
      continue;
    }
    lngsOut.push(lngs[source]);
    latsOut.push(lats[source]);
  }
}

function makeStep(
  graph: RoutingGraph,
  edge: number,
  forward: boolean,
  lengthMeters: number,
): RouteStep {
  return {
    edge,
    forward,
    kind: edgeKind(graph, edge),
    side: edgeSideLabel(graph, edge),
    name: edgeName(graph, edge),
    cover: edgeCover(graph, edge),
    lengthMeters,
  };
}

export function findRoute(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  treeWeight: number,
): RouteResult | null {
  const nodeCount = graph.nodeCount;
  const distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
  const parentEdge = new Int32Array(nodeCount).fill(-1);
  const heuristic = new Float64Array(nodeCount).fill(-1);

  const minMult = minMultiplier(graph, treeWeight);
  const heuristicOf = (node: number): number => {
    if (heuristic[node] < 0) {
      heuristic[node] =
        minMult *
        haversineMeters(
          graph.originLat + graph.nodeQy[node] * graph.scale,
          graph.originLng + graph.nodeQx[node] * graph.scale,
          dest.point.lat,
          dest.point.lng,
        );
    }
    return heuristic[node];
  };

  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startMultiplier = edgeMultiplier(graph, start.edge, treeWeight);
  const startLength = graph.edgeLength[start.edge];

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destMultiplier = edgeMultiplier(graph, dest.edge, treeWeight);
  const destLength = graph.edgeLength[dest.edge];

  let bestTotal = Number.POSITIVE_INFINITY;
  let bestDestNode = -1; // the edge endpoint the winning route reaches the dest edge through
  let bestSameEdge = false;
  const consider = (total: number, node: number, sameEdge: boolean): void => {
    if (total < bestTotal) {
      bestTotal = total;
      bestDestNode = node;
      bestSameEdge = sameEdge;
    }
  };

  // Walking directly along the shared edge, never leaving it, is a candidate when both snaps sit
  // on the same edge.
  if (start.edge === dest.edge) {
    consider(
      Math.abs(dest.metersFromA - start.metersFromA) * startMultiplier,
      -1,
      true,
    );
  }

  const heap = new NodeHeap(1024);
  distance[startA] = start.metersFromA * startMultiplier;
  distance[startB] = (startLength - start.metersFromA) * startMultiplier;
  heap.push(distance[startA] + heuristicOf(startA), startA);
  heap.push(distance[startB] + heuristicOf(startB), startB);

  let settled = 0;
  while (heap.length > 0) {
    const key = heap.peekKey();
    if (key >= bestTotal) {
      break;
    }
    const node = heap.pop();
    // Lazy deletion: a stale entry has a key above the node's now-final f-value.
    if (key > distance[node] + heuristicOf(node)) {
      continue;
    }
    settled += 1;

    if (node === destA) {
      consider(
        distance[destA] + dest.metersFromA * destMultiplier,
        destA,
        false,
      );
    }
    if (node === destB) {
      consider(
        distance[destB] + (destLength - dest.metersFromA) * destMultiplier,
        destB,
        false,
      );
    }

    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      const neighbour = otherEnd(graph, edge, node);
      const relaxed =
        distance[node] +
        graph.edgeLength[edge] * edgeMultiplier(graph, edge, treeWeight);
      if (relaxed < distance[neighbour]) {
        distance[neighbour] = relaxed;
        parentEdge[neighbour] = edge;
        heap.push(relaxed + heuristicOf(neighbour), neighbour);
      }
    }
  }

  routeDiagnostics.nodesSettled = settled;
  if (bestTotal === Number.POSITIVE_INFINITY) {
    return null;
  }

  const steps: RouteStep[] = [];
  const lngsOut: number[] = [];
  const latsOut: number[] = [];

  if (bestSameEdge) {
    const forward = start.metersFromA <= dest.metersFromA;
    const low = Math.min(start.metersFromA, dest.metersFromA);
    const high = Math.max(start.metersFromA, dest.metersFromA);
    steps.push(makeStep(graph, start.edge, forward, high - low));
    const { lngs, lats } = subPolyline(graph, start.edge, low, high);
    appendPolyline(lngsOut, latsOut, lngs, lats, forward, true);
  } else {
    // Interior edges from the start-edge endpoint we depart through to the dest-edge endpoint.
    const interior: number[] = [];
    let node = bestDestNode;
    while (parentEdge[node] !== -1) {
      const edge = parentEdge[node];
      interior.unshift(edge);
      node = otherEnd(graph, edge, node);
    }
    const seed = node; // startA or startB, whichever the route left the start edge by

    const startForward = seed === startB;
    const startWalked = startForward
      ? startLength - start.metersFromA
      : start.metersFromA;
    const startPiece = startForward
      ? subPolyline(graph, start.edge, start.metersFromA, startLength)
      : subPolyline(graph, start.edge, 0, start.metersFromA);
    steps.push(makeStep(graph, start.edge, startForward, startWalked));
    appendPolyline(
      lngsOut,
      latsOut,
      startPiece.lngs,
      startPiece.lats,
      startForward,
      true,
    );

    let previous = seed;
    for (const edge of interior) {
      const forward = graph.edgeNodeA[edge] === previous;
      steps.push(makeStep(graph, edge, forward, graph.edgeLength[edge]));
      const { lngs, lats } = edgePath(graph, edge);
      appendPolyline(
        lngsOut,
        latsOut,
        Array.from(lngs),
        Array.from(lats),
        forward,
        false,
      );
      previous = otherEnd(graph, edge, previous);
    }

    const destForward = bestDestNode === destA;
    const destWalked = destForward
      ? dest.metersFromA
      : destLength - dest.metersFromA;
    const destPiece = destForward
      ? subPolyline(graph, dest.edge, 0, dest.metersFromA)
      : subPolyline(graph, dest.edge, dest.metersFromA, destLength);
    steps.push(makeStep(graph, dest.edge, destForward, destWalked));
    appendPolyline(
      lngsOut,
      latsOut,
      destPiece.lngs,
      destPiece.lats,
      destForward,
      false,
    );
  }

  let lengthMeters = 0;
  let coverLengthMeters = 0;
  for (const step of steps) {
    lengthMeters += step.lengthMeters;
    coverLengthMeters += step.cover * step.lengthMeters;
  }

  return {
    path: {
      lats: Float64Array.from(latsOut),
      lngs: Float64Array.from(lngsOut),
    },
    steps,
    lengthMeters,
    walkSeconds: lengthMeters / WALK_METERS_PER_SECOND,
    coverFraction: lengthMeters > 0 ? coverLengthMeters / lengthMeters : 0,
    start,
    dest,
  };
}
