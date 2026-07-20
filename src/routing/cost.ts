// Cost is effective seconds: an edge's raw travel time times a product of scenic factors. Each
// walked metre is discounted toward a floor by the tree cover, the landmarks and public art it
// passes, and the nice commercial frontage it runs along (a factor 1 - w*attr per element) and made
// dearer by a nearby highway or elevated rail (a penalty factor 1 + w*attr); a ferry's crossing time
// is discounted by the ferry weight. The sun/shade
// axis is a single signed factor `1 - w*attr` whose weight `w in [-1, 1]` and edge attribute
// `attr in (-1, 1)` are both signed (attr positive = net sunlit, negative = net shaded, for the
// current sun): w > 0 discounts sun and penalizes shade, w < 0 flips it, w = 0 is neutral. Every
// unsigned attribute byte is at most its graph-wide max, which the ingest clamps below 1, so every
// discount factor stays positive and the product never reaches 0 — no metre is ever free, so the
// search never wanders. The A* heuristic scales straight-line distance by `minMultiplier`, the product
// of each discount at its max (the penalty only raises cost, and the shade factor at its per-edge
// lower bound 1 - |w|*maxAbsAttr): a lower bound on any edge's multiplier, so the estimate never
// overestimates and the search stays optimal. INVARIANT: this holds only while each discount's max
// attribute stays < 1 (the ingest's 254 byte ceiling) and |w| <= 1 with maxAbsAttr < 1 for shade.

import { edgeKind, type RoutingGraph } from "./graph";

export const WALK_METERS_PER_SECOND = 1.4;

// Every weight spans [0, 1]. w must stay <= 1 or a discount floor (1 - w*max) can go negative, and a
// negative edge cost breaks Dijkstra/A*. Defaults sit a little in from the extremes for a mild bias.
export const MAX_TREE_WEIGHT = 1;
export const DEFAULT_TREE_WEIGHT = 0.8;
// A ferry costs FERRY_FLOOR of its duration at w = 1 (never free, so the search cannot loop a ferry
// for a heuristic credit). Defaults low — a stronger default over-favours ferries into odd detours.
export const MAX_FERRY_WEIGHT = 1;
export const DEFAULT_FERRY_WEIGHT = 0.1;
export const FERRY_FLOOR = 1e-3;
// Landmark and public-art discounts, and the highway/rail penalty. Modest defaults, tunable by eye.
export const MAX_LANDMARK_WEIGHT = 1;
export const DEFAULT_LANDMARK_WEIGHT = 0.1;
export const MAX_ART_WEIGHT = 1;
export const DEFAULT_ART_WEIGHT = 0.1;
export const MAX_HIGHWAY_WEIGHT = 1;
export const DEFAULT_HIGHWAY_WEIGHT = 0.5;
// A discount for edges fronting a nice commercial block. Modest default, tunable by eye.
export const MAX_COMMERCIAL_WEIGHT = 1;
export const DEFAULT_COMMERCIAL_WEIGHT = 0.1;
// The signed sun/shade axis spans [-1, 1] (0 = no preference): positive prefers sun, negative prefers
// shade. |w| <= 1 keeps the shade factor's floor (1 - |w|*maxAbsAttr) positive since maxAbsAttr < 1.
export const MAX_SHADE_WEIGHT = 1;
export const DEFAULT_SHADE_WEIGHT = 0;

// A cover gap (0..255) at or under this reads as "too close to call" (~5% cover) — the threshold
// Phase 3 directions use before bothering to name a greener side.
export const SIDE_TIE_BYTES = 12;

// The full cost context a search runs against: the scenic weights and the ferry gate.
export interface RouteWeights {
  tree: number;
  ferry: number;
  landmark: number;
  art: number;
  highway: number;
  commercial: number;
  shade: number; // signed sun/shade preference in [-1, 1]; positive prefers sun, negative shade
  allowFerries: boolean;
}

// This edge's own cover, 0..1. In v2 the side is topology, so an edge carries a single value.
export function edgeCover(graph: RoutingGraph, edge: number): number {
  return graph.edgeCover[edge] / 255;
}

// The walking multiplier: the tree-cover, landmark, art and commercial discounts (each 1 - w*attr) and
// the signed sun/shade factor (1 - w*attr, attr and w both signed) times the nuisance penalty
// (1 + w*attr). At every weight 0 this is 1 (the shortest path); a shaded, landmarked metre far from
// any highway approaches the floor. No per-factor clip is needed — each unsigned attribute is <= its graph max, and
// the shade factor is >= its `minMultiplier` term 1 - |w|*maxAbsAttr, so the product stays positive.
export function edgeMultiplier(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
): number {
  const tree = 1 - weights.tree * (graph.edgeCover[edge] / 255);
  const landmark = 1 - weights.landmark * (graph.edgeLandmark[edge] / 255);
  const art = 1 - weights.art * (graph.edgeArt[edge] / 255);
  const highway = 1 + weights.highway * (graph.edgeHighway[edge] / 255);
  const commercial =
    1 - weights.commercial * (graph.edgeCommercial[edge] / 255);
  // The signed shade attribute for the resolved sun position; 0 when no artifact is loaded or at night.
  const shadeAttr = graph.edgeShadeNow ? graph.edgeShadeNow[edge] : 0;
  const shade = 1 - weights.shade * shadeAttr;
  return tree * landmark * art * highway * commercial * shade;
}

// The least a walked metre's multiplier can be: the product of each discount at the graph's max
// attribute (the penalty only raises cost, so its minimum factor is 1). A lower bound on every edge's
// multiplier — possibly loose, since one edge need not max every discount at once — so the A* heuristic
// that scales straight-line distance by it never overestimates. Positive because each max < 1.
export function minMultiplier(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  return (
    (1 - weights.tree * graph.maxCover) *
    (1 - weights.landmark * graph.maxLandmark) *
    (1 - weights.art * graph.maxArt) *
    (1 - weights.commercial * graph.maxCommercial) *
    // The shade factor's per-edge floor: whichever sign of attr the weight discounts, at its max
    // magnitude. Positive because |shade| <= 1 and maxAbsShadeNow < 1.
    (1 - Math.abs(weights.shade) * graph.maxAbsShadeNow)
  );
}

// The undiscounted travel time of an edge: a ferry's baked crossing-plus-wait seconds, or a walked
// edge's length over walking speed. This is the ETA unit — the reported trip time sums it.
export function rawSeconds(graph: RoutingGraph, edge: number): number {
  if (edgeKind(graph, edge) === "ferry") {
    return graph.edgeDurationSeconds[edge];
  } else {
    return graph.edgeLength[edge] / WALK_METERS_PER_SECOND;
  }
}

// Cost is effective seconds: raw time times the clipped discount. A ferry discounts by the ferry
// weight (unusable when ferries are barred); every walked edge by the scenic multiplier above.
export function effSeconds(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
): number {
  if (edgeKind(graph, edge) === "ferry") {
    if (!weights.allowFerries) {
      return Number.POSITIVE_INFINITY;
    } else {
      return (
        graph.edgeDurationSeconds[edge] *
        Math.max(FERRY_FLOOR, 1 - weights.ferry)
      );
    }
  } else {
    return (
      (graph.edgeLength[edge] / WALK_METERS_PER_SECOND) *
      edgeMultiplier(graph, edge, weights)
    );
  }
}

// The least seconds a walked metre can cost — the min multiplier over walking speed. The A* heuristic
// scales straight-line distance by this: a lower bound on remaining walking time.
export function walkSecondsCoeff(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  return minMultiplier(graph, weights) / WALK_METERS_PER_SECOND;
}

// The most seconds a route can save by riding ferries instead of walking their spans, bounded to the
// two best ferries. Per ferry, shortcut = max(0, walk-time of its span - its effective time); summing
// the two largest covers any route using <= 2 ferries (every realistic NYC ferry OD). Subtracting it
// from the walking heuristic keeps A* admissible without letting a many-ferry fantasy path make the
// estimate exceed the truth. Zero when ferries are barred or the graph has none.
export function ferryCredit(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  if (!weights.allowFerries) {
    return 0;
  }
  const coeff = walkSecondsCoeff(graph, weights);
  let bestShortcut = 0;
  let secondShortcut = 0;
  for (const edge of graph.ferryEdges) {
    const shortcut = Math.max(
      0,
      coeff * graph.edgeLength[edge] - effSeconds(graph, edge, weights),
    );
    if (shortcut > bestShortcut) {
      secondShortcut = bestShortcut;
      bestShortcut = shortcut;
    } else if (shortcut > secondShortcut) {
      secondShortcut = shortcut;
    }
  }
  return bestShortcut + secondShortcut;
}
