// A* over the routing graph with virtual start/dest points sitting partway along their snapped
// edges. Cost is effective seconds (raw travel time times a clipped discount): a shaded metre costs
// less at high tree weight, and a ferry costs its discounted crossing time. The straight-line
// heuristic scales distance by the least seconds a walked metre can cost, then subtracts a bounded
// ferry credit (the two best ferry shortcuts) — a lower bound on remaining cost that keeps the
// search admissible. The heap allows node reopening (no closed set), so admissible suffices for
// optimality even though the ferry credit makes the heuristic inconsistent.

import {
  edgeCover,
  edgeMultiplier,
  effSeconds,
  ferryCredit,
  type RouteWeights,
  rawSeconds,
  WALK_METERS_PER_SECOND,
  walkSecondsCoeff,
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
  lengthMeters: number; // total trip distance, walking plus ferry spans (nav-progress and the path rely on it)
  walkMeters: number; // walking-only distance, ferry spans excluded — the mileage the summary shows
  travelSeconds: number; // reported ETA: sum of undiscounted raw seconds over the chosen steps
  coverFraction: number; // length-weighted mean cover, over the walked length only (ferries excluded)
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

// Build the oriented route from a settled search: the parent-edge tree, the dest endpoint the
// route reaches through (bestDestNode, or -1 with bestSameEdge for a walk along the shared edge),
// and the two snaps. Reads only the parent tree and graph geometry — no distance array needed.
function reconstruct(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  parentEdge: Int32Array,
  bestDestNode: number,
  bestSameEdge: boolean,
): RouteResult {
  const startB = graph.edgeNodeB[start.edge];
  const startLength = graph.edgeLength[start.edge];
  const destA = graph.edgeNodeA[dest.edge];
  const destLength = graph.edgeLength[dest.edge];

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
  let walkLengthMeters = 0; // ferry spans excluded, so shade % is over the walked route only
  let coverLengthMeters = 0;
  let travelSeconds = 0; // undiscounted ETA: walked time by span, ferry time by its baked duration
  for (const step of steps) {
    lengthMeters += step.lengthMeters;
    if (step.kind === "ferry") {
      travelSeconds += rawSeconds(graph, step.edge);
    } else {
      walkLengthMeters += step.lengthMeters;
      coverLengthMeters += step.cover * step.lengthMeters;
      travelSeconds += step.lengthMeters / WALK_METERS_PER_SECOND;
    }
  }

  return {
    path: {
      lats: Float64Array.from(latsOut),
      lngs: Float64Array.from(lngsOut),
    },
    steps,
    lengthMeters,
    walkMeters: walkLengthMeters,
    travelSeconds,
    coverFraction:
      walkLengthMeters > 0 ? coverLengthMeters / walkLengthMeters : 0,
    start,
    dest,
  };
}

export function findRoute(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  weights: RouteWeights,
): RouteResult | null {
  const nodeCount = graph.nodeCount;
  const distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
  // Raw walking seconds along each node's min-cost path — the ACTUAL time elapsed, not the weighted
  // cost, so the shade field advances the sun by how long the walk really takes to get here.
  const elapsed = new Float64Array(nodeCount);
  const parentEdge = new Int32Array(nodeCount).fill(-1);
  const heuristic = new Float64Array(nodeCount).fill(-1);

  // The walking floor (seconds per straight-line metre) and the bounded ferry credit both depend on
  // the weights, so they are computed once here and reused for every node's estimate.
  const walkCoeff = walkSecondsCoeff(graph, weights);
  const credit = ferryCredit(graph, weights);
  const heuristicOf = (node: number): number => {
    if (heuristic[node] < 0) {
      const straight =
        walkCoeff *
        haversineMeters(
          graph.originLat + graph.nodeQy[node] * graph.scale,
          graph.originLng + graph.nodeQx[node] * graph.scale,
          dest.point.lat,
          dest.point.lng,
        );
      heuristic[node] = Math.max(0, straight - credit);
    }
    return heuristic[node];
  };

  // The snap edges are always walking edges (ferries are excluded from the snap index), so their
  // per-metre cost is the walking multiplier over speed — effective seconds, matching the interior.
  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startPerMeter =
    edgeMultiplier(graph, start.edge, weights) / WALK_METERS_PER_SECOND;
  const startLength = graph.edgeLength[start.edge];

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destLength = graph.edgeLength[dest.edge];
  // The dest edge is a partial walked at the very end, so its shade is the sun at the arrival time —
  // the elapsed raw seconds of the endpoint the route reaches it through.
  const destPerMeterAt = (node: number): number =>
    edgeMultiplier(graph, dest.edge, weights, elapsed[node]) /
    WALK_METERS_PER_SECOND;

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
      Math.abs(dest.metersFromA - start.metersFromA) * startPerMeter,
      -1,
      true,
    );
  }

  const heap = new NodeHeap(1024);
  distance[startA] = start.metersFromA * startPerMeter;
  distance[startB] = (startLength - start.metersFromA) * startPerMeter;
  // Seed the elapsed clock with the raw time to walk each half of the start edge to its node.
  elapsed[startA] = start.metersFromA / WALK_METERS_PER_SECOND;
  elapsed[startB] = (startLength - start.metersFromA) / WALK_METERS_PER_SECOND;
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
        distance[destA] + dest.metersFromA * destPerMeterAt(destA),
        destA,
        false,
      );
    }
    if (node === destB) {
      consider(
        distance[destB] +
          (destLength - dest.metersFromA) * destPerMeterAt(destB),
        destB,
        false,
      );
    }

    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      // A ferry is boardable only when ferries are allowed; otherwise skip it so no route uses one.
      if (!weights.allowFerries && edgeKind(graph, edge) === "ferry") {
        continue;
      }
      const neighbour = otherEnd(graph, edge, node);
      const relaxed =
        distance[node] + effSeconds(graph, edge, weights, elapsed[node]);
      if (relaxed < distance[neighbour]) {
        distance[neighbour] = relaxed;
        elapsed[neighbour] = elapsed[node] + rawSeconds(graph, edge);
        parentEdge[neighbour] = edge;
        heap.push(relaxed + heuristicOf(neighbour), neighbour);
      }
    }
  }

  routeDiagnostics.nodesSettled = settled;
  if (bestTotal === Number.POSITIVE_INFINITY) {
    return null;
  }

  return reconstruct(
    graph,
    start,
    dest,
    parentEdge,
    bestDestNode,
    bestSameEdge,
  );
}

// An incremental A* from a fixed source that reuses its settled search across successive dests, for
// live endpoint dragging. It keeps the g-values, parent tree, and closed set from one call to the
// next and never reopens a closed node — the deliberate approximation that makes reuse cheap. When a
// dragged dest lands in already-explored territory it answers with no search at all; otherwise it
// resumes the frontier toward the new goal. Exact when the heuristic is consistent (ferries off and
// no shade), near-optimal otherwise.
//
// The elapsed clock counts raw walking seconds from the source, but the sun runs on WALL-CLOCK time
// from the fixed departure. A dest-drag roots at the true start, so departure is elapsed 0 and the sun
// counts forward (sunAnchorSeconds 0, sunDirection +1). A start-drag roots at the DEST and reverses the
// path, so the source is where you ARRIVE: pin sunAnchorSeconds to the last route's trip time and count
// the sun BACKWARD (sunDirection -1), so a node reached partway back from the dest is costed against
// the sun at its true forward time. The anchor is a stale estimate the release's fresh A* corrects.
export class RouteSolver {
  private readonly graph: RoutingGraph;
  private readonly source: Snap;
  private readonly weights: RouteWeights;
  private readonly sunAnchorSeconds: number; // forward wall-clock seconds since departure AT the source
  private readonly sunDirection: number; // +1 counts the sun forward from the source, -1 backward

  private readonly distance: Float64Array; // best-known g (effective seconds) from source
  private readonly elapsed: Float64Array; // raw walking seconds from source along the min-cost path
  private readonly parentEdge: Int32Array;
  private readonly closed: Uint8Array; // 1 once a node has been settled; never reopened
  private readonly reached: number[] = []; // every node ever given a finite distance

  private readonly sourceA: number;
  private readonly sourceB: number;
  private readonly sourcePerMeter: number;
  private readonly sourceLength: number;

  constructor(
    graph: RoutingGraph,
    source: Snap,
    weights: RouteWeights,
    sunAnchorSeconds = 0,
    sunDirection: 1 | -1 = 1,
  ) {
    this.graph = graph;
    this.source = source;
    this.weights = weights;
    this.sunAnchorSeconds = sunAnchorSeconds;
    this.sunDirection = sunDirection;

    const nodeCount = graph.nodeCount;
    this.distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
    this.elapsed = new Float64Array(nodeCount);
    this.parentEdge = new Int32Array(nodeCount).fill(-1);
    this.closed = new Uint8Array(nodeCount);

    this.sourceA = graph.edgeNodeA[source.edge];
    this.sourceB = graph.edgeNodeB[source.edge];
    // The source edge is a partial walked at the source's wall-clock time (departure for a dest-drag,
    // arrival for a start-drag), so price it against the sun at the anchor.
    this.sourcePerMeter =
      edgeMultiplier(
        graph,
        source.edge,
        weights,
        Math.max(0, sunAnchorSeconds),
      ) / WALK_METERS_PER_SECOND;
    this.sourceLength = graph.edgeLength[source.edge];

    this.distance[this.sourceA] = source.metersFromA * this.sourcePerMeter;
    this.distance[this.sourceB] =
      (this.sourceLength - source.metersFromA) * this.sourcePerMeter;
    // The elapsed clock is anchored at the source, so it is stable across dest drags — every reused
    // node's raw time from the source is the same no matter where the moving endpoint goes.
    this.elapsed[this.sourceA] = source.metersFromA / WALK_METERS_PER_SECOND;
    this.elapsed[this.sourceB] =
      (this.sourceLength - source.metersFromA) / WALK_METERS_PER_SECOND;
    this.reached.push(this.sourceA, this.sourceB);
  }

  // A node's forward wall-clock seconds since departure: the anchor plus the raw time from the source,
  // signed by the search direction, floored at departure. This is what the sun-dependent shade reads.
  private sunElapsed(node: number): number {
    const seconds =
      this.sunAnchorSeconds + this.sunDirection * this.elapsed[node];
    return seconds > 0 ? seconds : 0;
  }

  solveApprox(dest: Snap): RouteResult | null {
    const graph = this.graph;
    const destA = graph.edgeNodeA[dest.edge];
    const destB = graph.edgeNodeB[dest.edge];
    const destLength = graph.edgeLength[dest.edge];
    // The dest edge is a partial walked at the moving endpoint: cost it against the sun at that node's
    // forward wall-clock time.
    const destPerMeterAt = (node: number): number =>
      edgeMultiplier(graph, dest.edge, this.weights, this.sunElapsed(node)) /
      WALK_METERS_PER_SECOND;

    let bestTotal = Number.POSITIVE_INFINITY;
    let bestDestNode = -1;
    let bestSameEdge = false;
    const consider = (total: number, node: number, sameEdge: boolean): void => {
      if (total < bestTotal) {
        bestTotal = total;
        bestDestNode = node;
        bestSameEdge = sameEdge;
      }
    };

    if (this.source.edge === dest.edge) {
      consider(
        Math.abs(dest.metersFromA - this.source.metersFromA) *
          this.sourcePerMeter,
        -1,
        true,
      );
    }

    // Only a settled (closed) endpoint has a final g; a merely-reached one still holds a tentative
    // distance that a resumed search may improve, so it can't shortcut here.
    if (this.closed[destA] === 1) {
      consider(
        this.distance[destA] + dest.metersFromA * destPerMeterAt(destA),
        destA,
        false,
      );
    }
    if (this.closed[destB] === 1) {
      consider(
        this.distance[destB] +
          (destLength - dest.metersFromA) * destPerMeterAt(destB),
        destB,
        false,
      );
    }

    // Fast path: the dest edge is already settled from the explored region, so answer with no
    // search at all.
    if (bestTotal < Number.POSITIVE_INFINITY) {
      return reconstruct(
        graph,
        this.source,
        dest,
        this.parentEdge,
        bestDestNode,
        bestSameEdge,
      );
    }

    // The heuristic and its per-node cache are only needed for the search below, so they are built
    // after the fast path to keep a settled-dest drag frame allocation-free.
    const walkCoeff = walkSecondsCoeff(graph, this.weights);
    const credit = ferryCredit(graph, this.weights);
    const heuristicCache = new Float64Array(graph.nodeCount).fill(-1);
    const heuristicOf = (node: number): number => {
      if (heuristicCache[node] < 0) {
        const straight =
          walkCoeff *
          haversineMeters(
            graph.originLat + graph.nodeQy[node] * graph.scale,
            graph.originLng + graph.nodeQx[node] * graph.scale,
            dest.point.lat,
            dest.point.lng,
          );
        heuristicCache[node] = Math.max(0, straight - credit);
      }
      return heuristicCache[node];
    };

    // Resume the frontier toward this dest: reseed the heap from every open reached node.
    const heap = new NodeHeap(1024);
    for (const id of this.reached) {
      if (this.closed[id] === 0) {
        heap.push(this.distance[id] + heuristicOf(id), id);
      }
    }

    while (heap.length > 0) {
      const key = heap.peekKey();
      const node = heap.pop();
      if (this.closed[node] === 1) {
        continue;
      }
      // Lazy deletion: a stale entry has a key above the node's now-final f-value.
      if (key > this.distance[node] + heuristicOf(node)) {
        continue;
      }
      this.closed[node] = 1;

      if (node === destA) {
        consider(
          this.distance[destA] + dest.metersFromA * destPerMeterAt(destA),
          destA,
          false,
        );
      }
      if (node === destB) {
        consider(
          this.distance[destB] +
            (destLength - dest.metersFromA) * destPerMeterAt(destB),
          destB,
          false,
        );
      }
      // Expand the settled node before any goal stop, so a later drag can still route through a dest
      // endpoint that was closed on this call.
      for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
        const edge = graph.adjacency[slot];
        if (!this.weights.allowFerries && edgeKind(graph, edge) === "ferry") {
          continue;
        }
        const neighbour = otherEnd(graph, edge, node);
        if (this.closed[neighbour] === 1) {
          continue;
        }
        const relaxed =
          this.distance[node] +
          effSeconds(graph, edge, this.weights, this.sunElapsed(node));
        if (relaxed < this.distance[neighbour]) {
          if (this.distance[neighbour] === Number.POSITIVE_INFINITY) {
            this.reached.push(neighbour);
          }
          this.distance[neighbour] = relaxed;
          this.elapsed[neighbour] =
            this.elapsed[node] + rawSeconds(graph, edge);
          this.parentEdge[neighbour] = edge;
          heap.push(relaxed + heuristicOf(neighbour), neighbour);
        }
      }

      // Approximate goal test: stop once a dest endpoint has settled (and been expanded above).
      if (bestTotal < Number.POSITIVE_INFINITY) {
        return reconstruct(
          graph,
          this.source,
          dest,
          this.parentEdge,
          bestDestNode,
          bestSameEdge,
        );
      }
    }

    return bestTotal < Number.POSITIVE_INFINITY
      ? reconstruct(
          graph,
          this.source,
          dest,
          this.parentEdge,
          bestDestNode,
          bestSameEdge,
        )
      : null;
  }
}

// The same route travelled the other way: swap the two snaps, reverse the step list and flip each
// step's travel direction, and reverse the stitched path. Length, walk, ETA, and cover are
// direction-independent and carry over unchanged.
export function reverseResult(result: RouteResult): RouteResult {
  const steps = result.steps
    .slice()
    .reverse()
    .map((step) => ({ ...step, forward: !step.forward }));
  const lats = result.path.lats.slice().reverse();
  const lngs = result.path.lngs.slice().reverse();
  return {
    path: { lats, lngs },
    steps,
    lengthMeters: result.lengthMeters,
    walkMeters: result.walkMeters,
    travelSeconds: result.travelSeconds,
    coverFraction: result.coverFraction,
    start: result.dest,
    dest: result.start,
  };
}
