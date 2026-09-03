// Squeezing a scenic route into the handful of points an outside router will accept. Google Maps
// takes up to nine waypoints on a URL and nothing else — there is no way to hand it a polyline — so
// a route it should follow has to be described by a few pins and its own walking router asked to
// fill the gaps.
//
// The pins are picked by an exact dynamic program rather than by a "keep the sharpest corners" rule,
// because the error decomposes. Once `a` and `b` are both pinned, what the outside router walks
// between them is settled, and its error against our route's `a`..`b` stretch depends on no other
// pin. Total error is then a plain sum over consecutive pinned pairs, which turns the choice into a
// shortest path in a small DAG: positions along the route are the nodes, a leg is an edge carrying
// that stretch's error, and the answer is the cheapest route-start-to-route-end path using at most
// ten edges.
//
// A leg is scored by SCENIC VALUE LOST, not by geometric deviation: both stretches are priced with
// the reader's own weighted cost, so the number says how much of the tree cover or the shade that
// motivated the detour the outside router will not actually walk. Deviation would protect the shape
// of the route rather than the reason for its shape.
//
// One candidate per intersection, not one per kerb. This network draws a street corner as several
// nodes — the kerb, the far side of the crossing it meets, and an island for every piece a divided
// roadway breaks that crossing into — and Google snaps every one of them to the same road node. On
// real routes that had the DP spending about half its nine pins on pairs standing 7 to 32 m apart at
// one junction, which is a pin describing nothing. So corners are walked in route order and one is
// dropped when a chain of crossings joins it to the last corner kept; the earlier of a group
// survives, which is also where the leg the pin holds actually begins.

import {
  crossingWait,
  edgeForward,
  effSeconds,
  type RouteWeights,
  WALK_METERS_PER_SECOND,
  walkSpeedOn,
} from "./cost";
import { edgeKind, otherEnd, type RoutingGraph } from "./graph";
import { NodeHeap } from "./node-heap";
import { type RouteResult, stepFrom, stepSeconds } from "./search";

export interface Waypoint {
  lat: number;
  lng: number;
}

export interface WaypointPlan {
  waypoints: Waypoint[]; // the pinned points, in route order
  lostSeconds: number; // effective seconds of scenic value the approximation gives up
  candidateCount: number; // corners the choice was made over, for diagnostics
}

// What we imitate the outside router with. Every scenic weight off leaves pure Tobler walking time,
// which is the closest thing our graph has to what Google walks. Note that zeroing the weights is
// not by itself enough to make it plain: `allowCrossings` defaults to false, which prices every
// crossing at CROSSING_AVOID_MULTIPLE times its delay, so the flag has to be flipped too. Ferries
// are barred because Google's walking mode will not put a walker on a boat of our choosing, and
// scaffolding is allowed because Google has never heard of it.
export const PROXY_WEIGHTS: RouteWeights = {
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
  allowCrossings: true,
};

// What a leg the proxy cannot walk at all is charged. The route crossed water on a ferry the proxy
// is barred from, so no sequence of pins can describe that stretch; priced far above any real leg so
// the plan spends as few such legs as it can, and finite so that a plan still comes out and the URL
// still gets emitted — what Google does over the water is Google's business.
const UNREACHABLE_LEG_SECONDS = 1e9;

// Floating slack on the search radius, so a bound that is exactly the answer still admits it.
const BOUND_SLACK_SECONDS = 1e-6;

function nodeLat(graph: RoutingGraph, node: number): number {
  return graph.originLat + graph.nodeQy[node] * graph.scale;
}

function nodeLng(graph: RoutingGraph, node: number): number {
  return graph.originLng + graph.nodeQx[node] * graph.scale;
}

// Whether a node is a kerb corner, the only kind of point worth pinning. Google snaps every
// coordinate it is given to its own road network, and a mid-block point can land on the far side of
// the street and turn one leg into an out-and-back. A node an actual crossing meets is standing on a
// corner, which snaps where you meant; a node whose every edge is a crossing is a median island,
// standing in the roadway; anything else is mid-block. Restricting the candidates this way is also
// most of what keeps the search count down.
function isCorner(graph: RoutingGraph, node: number): boolean {
  if (graph.nodeMidRoadway[node] === 1) {
    return false;
  } else {
    let touchesCrossing = false;
    const to = graph.csr[node + 1];
    for (let slot = graph.csr[node]; slot < to && !touchesCrossing; slot += 1) {
      touchesCrossing = edgeKind(graph, graph.adjacency[slot]) === "crossing";
    }
    return touchesCrossing;
  }
}

// Every node of the intersection `node` stands at: what a chain of crossings reaches from it without
// ever setting foot on pavement in between. A marked crossing of a divided street is drawn as
// several crossing edges chained through the islands in it, so the walk goes on through a
// mid-roadway node and stops at the kerb on the far side, however many pieces the crossing is in.
// Bounded by that rule rather than by a distance: the islands of one junction are all it can reach.
function junctionNodes(graph: RoutingGraph, node: number): Set<number> {
  const junction = new Set([node]);
  const frontier = [node];
  for (let head = 0; head < frontier.length; head += 1) {
    const at = frontier[head];
    const to = graph.csr[at + 1];
    for (let slot = graph.csr[at]; slot < to; slot += 1) {
      const edge = graph.adjacency[slot];
      if (edgeKind(graph, edge) === "crossing") {
        const across = otherEnd(graph, edge, at);
        if (!junction.has(across)) {
          junction.add(across);
          if (graph.nodeMidRoadway[across] === 1) {
            frontier.push(across);
          }
        }
      }
    }
  }
  return junction;
}

// The route's own traversal of an edge, as one number. Which way it went along it is part of the
// identity: a climb one way is a descent the other, and they are not priced the same.
function directedEdge(edge: number, forward: boolean): number {
  return edge * 2 + (forward ? 1 : 0);
}

// The route as the sequence of graph nodes it passes through, with the running costs the DP prices
// its legs against.
interface RouteWalk {
  nodes: number[];
  valueCost: Float64Array; // cumulative reader-weighted cost from nodes[0]
  proxyCost: Float64Array; // cumulative proxy cost, which bounds each search's radius
  elapsed: Float64Array; // raw seconds since departure at each node, for the sun
}

function walkRoute(
  graph: RoutingGraph,
  route: RouteResult,
  weights: RouteWeights,
): RouteWalk {
  const nodes: number[] = [];
  const valueCost: number[] = [0];
  const proxyCost: number[] = [0];
  const elapsedAt: number[] = [];
  // The first step is the partial walk off the start snap and the last the partial onto the dest
  // snap; neither runs between two graph nodes, so neither is a stretch any pin can carve. The clock
  // still runs over them, because an edge is priced against the sun at the moment it is reached.
  let elapsed = 0;
  for (const [index, step] of route.steps.entries()) {
    const from = stepFrom(graph, step);
    const last = index === route.steps.length - 1;
    if (index > 0 && !last) {
      valueCost.push(
        valueCost[valueCost.length - 1] +
          effSeconds(graph, step.edge, weights, elapsed, from),
      );
      // A ferry contributes something finite here whatever the proxy thinks of it: this sum is only
      // ever read as a search radius, and pricing its span as a flat walk keeps the radius bounded.
      proxyCost.push(
        proxyCost[proxyCost.length - 1] +
          (step.kind === "ferry"
            ? graph.edgeLength[step.edge] / WALK_METERS_PER_SECOND
            : effSeconds(graph, step.edge, PROXY_WEIGHTS, elapsed, from)),
      );
    }
    const seconds = stepSeconds(graph, step, elapsed);
    if (!last) {
      nodes.push(otherEnd(graph, step.edge, from));
      elapsedAt.push(elapsed + seconds);
    }
    elapsed += seconds;
  }
  return {
    nodes,
    valueCost: Float64Array.from(valueCost),
    proxyCost: Float64Array.from(proxyCost),
    elapsed: Float64Array.from(elapsedAt),
  };
}

// One shortest-path tree per anchor is what makes the DP affordable: a single search from `a`
// settles every position ahead of it, filling the whole cost(a, ·) row at once, so the cost matrix
// costs a search per candidate rather than one per pair. The reader-weighted price of the proxy's
// chosen path rides along the relaxation, which is the same number reconstructing through parent
// pointers and re-summing would give, without the walk back.
//
// The arrays outlive one search and are cleared only where they were written; a fresh clear of every
// node in the city would cost more than the searches it separated.
class ProxyExplorer {
  private readonly graph: RoutingGraph;
  private readonly weights: RouteWeights;
  private readonly routeEdges: ReadonlySet<number>; // `directedEdge` of every step the route walks
  private readonly distance: Float64Array; // proxy cost from the anchor
  private readonly valueCost: Float64Array; // the reader's price for that same proxy path
  private readonly elapsed: Float64Array; // raw seconds since departure along it
  private readonly settled: Uint8Array;
  private readonly touched: number[] = [];
  private readonly heap = new NodeHeap(1024);

  constructor(
    graph: RoutingGraph,
    weights: RouteWeights,
    routeEdges: ReadonlySet<number>,
  ) {
    this.graph = graph;
    this.weights = weights;
    this.routeEdges = routeEdges;
    this.distance = new Float64Array(graph.nodeCount).fill(
      Number.POSITIVE_INFINITY,
    );
    this.valueCost = new Float64Array(graph.nodeCount);
    this.elapsed = new Float64Array(graph.nodeCount);
    this.settled = new Uint8Array(graph.nodeCount);
  }

  // Settle every node of `targets` reachable within `bound` of `source`. The bound is the proxy's
  // price for the rest of the route, which the route itself already achieves, so no target we could
  // usefully pin is ever cut off by it — only one on the far side of water the proxy cannot cross,
  // which no radius would have reached.
  run(
    source: number,
    elapsedAtSource: number,
    targets: Iterable<number>,
    bound: number,
  ): void {
    for (const node of this.touched) {
      this.distance[node] = Number.POSITIVE_INFINITY;
      this.settled[node] = 0;
    }
    this.touched.length = 0;
    this.heap.clear();

    const pending = new Set(targets);
    this.distance[source] = 0;
    this.valueCost[source] = 0;
    this.elapsed[source] = elapsedAtSource;
    this.touched.push(source);
    this.heap.push(0, source);

    const { csr, adjacency } = this.graph;
    const limit = bound + BOUND_SLACK_SECONDS;
    while (this.heap.length > 0 && pending.size > 0) {
      if (this.heap.peekKey() > limit) {
        break;
      }
      const node = this.heap.pop();
      if (this.settled[node] === 1) {
        continue; // a stale duplicate left by lazy deletion
      }
      this.settled[node] = 1;
      pending.delete(node);
      const to = csr[node + 1];
      for (let slot = csr[node]; slot < to; slot += 1) {
        const edge = adjacency[slot];
        if (edgeKind(this.graph, edge) === "ferry") {
          continue; // the proxy walks; it cannot put anyone on a boat
        }
        const neighbour = otherEnd(this.graph, edge, node);
        // What PROXY_WEIGHTS price this edge at, written out: every scenic factor is 1 at those
        // weights and a freely-spent crossing adds nothing, so the multiplier machinery would do a
        // dozen multiplications to arrive back at the walk. `proxyPricesAWalk` pins the equality.
        const forward = edgeForward(this.graph, edge, node);
        const walked =
          this.graph.edgeLength[edge] / walkSpeedOn(this.graph, edge, forward);
        const relaxed = this.distance[node] + walked;
        if (relaxed < this.distance[neighbour]) {
          if (this.distance[neighbour] === Number.POSITIVE_INFINITY) {
            this.touched.push(neighbour);
          }
          this.distance[neighbour] = relaxed;
          this.record(neighbour, node, edge, walked);
          this.heap.push(relaxed, neighbour);
        } else if (
          relaxed === this.distance[neighbour] &&
          this.routeEdges.has(directedEdge(edge, forward))
        ) {
          // Two ways of identical walking cost, one of them the route's own: the proxy is a guess at
          // what Google walks and this is the walk we know it is being compared against, so the leg
          // is not charged for a difference no walker would notice. Only the recorded price moves;
          // the key is unchanged, so the heap entry already standing for this node still holds.
          this.record(neighbour, node, edge, walked);
        }
      }
    }
  }

  // What arriving at `neighbour` over `edge` costs the reader, and when it happens.
  private record(
    neighbour: number,
    node: number,
    edge: number,
    walked: number,
  ): void {
    this.valueCost[neighbour] =
      this.valueCost[node] +
      effSeconds(this.graph, edge, this.weights, this.elapsed[node], node);
    this.elapsed[neighbour] =
      this.elapsed[node] + walked + crossingWait(this.graph, edge, node);
  }

  // The reader's price for the proxy's walk to `node`, or null when the last search never reached it.
  costTo(node: number): number | null {
    return this.settled[node] === 1 ? this.valueCost[node] : null;
  }
}

// The pins to hand an outside router so its route resembles this one, at most `limit` of them.
// Exactly optimal over the corner candidates, given the proxy above.
export function planWaypoints(
  graph: RoutingGraph,
  route: RouteResult,
  weights: RouteWeights,
  limit: number,
): WaypointPlan {
  const walk = walkRoute(graph, route, weights);
  const lastIndex = walk.nodes.length - 1;
  if (lastIndex <= 0) {
    // A walk that never leaves one edge, or leaves it for one more: the ends are snaps part way
    // along an edge, which no pin can carve and no leg can be drawn between.
    return { waypoints: [], lostSeconds: 0, candidateCount: 0 };
  } else {
    // Positions the DP may stop at: the two ends of the interior walk, which are fixed, and the
    // corners between them, one to a junction. A node the route already visited is skipped even
    // where it is a corner — a stretch that ends where an earlier one began is a leg of no progress,
    // which is not a thing the DAG's strictly forward legs can express and would spend a pin on
    // nothing. Our graph is not supposed to produce one; this costs three lines and the alternative
    // failure is a wedged tab.
    const anchors = [0];
    const visited = new Set([walk.nodes[0]]);
    // Seeded with the intersection the walk starts at, so a kerb a crossing away from the origin is
    // not pinned: anchor 0 already stands there.
    let junction = junctionNodes(graph, walk.nodes[0]);
    for (let index = 1; index < lastIndex; index += 1) {
      const node = walk.nodes[index];
      if (!visited.has(node) && !junction.has(node) && isCorner(graph, node)) {
        anchors.push(index);
        junction = junctionNodes(graph, node);
      }
      visited.add(node);
    }
    anchors.push(lastIndex);

    const count = anchors.length;
    // cost[a * count + b] is what pinning `a` then `b` and nothing between gives up: what the proxy
    // spends walking a to b, priced by the reader's weights, less what the route's own a..b stretch
    // costs the same way.
    const cost = new Float64Array(count * count).fill(UNREACHABLE_LEG_SECONDS);
    const explorer = new ProxyExplorer(
      graph,
      weights,
      new Set(route.steps.map((step) => directedEdge(step.edge, step.forward))),
    );
    for (let from = 0; from < count - 1; from += 1) {
      const fromIndex = anchors[from];
      const ahead = anchors.slice(from + 1);
      explorer.run(
        walk.nodes[fromIndex],
        walk.elapsed[fromIndex],
        ahead.map((index) => walk.nodes[index]),
        walk.proxyCost[lastIndex] - walk.proxyCost[fromIndex],
      );
      for (let to = from + 1; to < count; to += 1) {
        const toIndex = anchors[to];
        const reached = explorer.costTo(walk.nodes[toIndex]);
        if (reached !== null) {
          cost[from * count + to] =
            reached - (walk.valueCost[toIndex] - walk.valueCost[fromIndex]);
        }
      }
    }

    if (count === 2) {
      // Nothing between the ends to choose over: every interior node stands mid-block, or the only
      // corners are the ends' own. There is no choice to make, but the one leg still has a price —
      // an outside router handed nothing but the ends is free to walk right past the reason for
      // the route.
      return {
        waypoints: [],
        lostSeconds: cost[count - 1],
        candidateCount: 0,
      };
    } else {
      // best[legs * count + to] is the least error reaching anchor `to` in exactly `legs` legs, and
      // `legs - 1` pins spent. Legs run to one more than the pins allowed, since the last leg lands on
      // the destination rather than on a pin.
      const maxLegs = Math.min(limit, count - 2) + 1;
      const best = new Float64Array((maxLegs + 1) * count).fill(
        Number.POSITIVE_INFINITY,
      );
      const previous = new Int32Array((maxLegs + 1) * count).fill(-1);
      best[0] = 0;
      for (let legs = 1; legs <= maxLegs; legs += 1) {
        for (let to = legs; to < count; to += 1) {
          for (let from = legs - 1; from < to; from += 1) {
            const total =
              best[(legs - 1) * count + from] + cost[from * count + to];
            if (total < best[legs * count + to]) {
              best[legs * count + to] = total;
              previous[legs * count + to] = from;
            }
          }
        }
      }

      let bestLegs = 1;
      for (let legs = 2; legs <= maxLegs; legs += 1) {
        if (
          best[legs * count + count - 1] < best[bestLegs * count + count - 1]
        ) {
          bestLegs = legs;
        }
      }

      const pins: number[] = [];
      let at = count - 1;
      for (let legs = bestLegs; legs > 1; legs -= 1) {
        at = previous[legs * count + at];
        pins.unshift(anchors[at]);
      }
      return {
        waypoints: pins.map((index) => ({
          lat: nodeLat(graph, walk.nodes[index]),
          lng: nodeLng(graph, walk.nodes[index]),
        })),
        lostSeconds: best[bestLegs * count + count - 1],
        candidateCount: count - 2,
      };
    }
  }
}
