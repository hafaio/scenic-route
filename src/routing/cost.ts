// The slider costs each metre by the sun it sees, clipped at a data-derived floor:
//   multiplier = max(1 - w*maxCover, 1 - w*cover)
// where maxCover is the greenest edge in the whole graph. At w = 0 every metre costs 1 (shortest
// path); at w = 1 it is 1 - cover, the unshaded fraction, so a 60%-shaded metre counts as 0.4 of one
// and the search minimises time in the sun. The floor equals the cost of the greenest *possible* edge,
// so it never clips a real one (every cover <= maxCover): the cost stays the clean, undistorted
// 1 - w*cover with a full gradient, yet nothing is ever free (the greenest edge still costs
// 1 - w*maxCover > 0 while maxCover < 1), so no wandering — and it is the tightest admissible A*
// heuristic coefficient. INVARIANT: this holds only while maxCover < 1. If the data ever carries a
// fully shaded edge (cover = 1), the floor hits 0 at w = 1 — that edge becomes free and the heuristic
// collapses — and the fix is to switch to a lexicographic (unshaded, distance) cost, whose distance
// tiebreak handles the free edge (see scratchpad/lexico-analysis.md).

import type { RoutingGraph } from "./graph";

export const WALK_METERS_PER_SECOND = 1.4;

// w must stay <= 1: the floor 1 - w*maxCover goes negative past w = 1/maxCover (~1.07 today), and a
// negative edge cost breaks Dijkstra/A*. The slider spans [0, 1] and rests at the top — w = 1 is the
// clean "minimise unshaded metres" point.
export const MAX_TREE_WEIGHT = 1;
export const DEFAULT_TREE_WEIGHT = 1;

// A cover gap (0..255) at or under this reads as "too close to call" (~5% cover) — the threshold
// Phase 3 directions use before bothering to name a greener side.
export const SIDE_TIE_BYTES = 12;

// This edge's own cover, 0..1. In v2 the side is topology, so an edge carries a single value.
export function edgeCover(graph: RoutingGraph, edge: number): number {
  return graph.edgeCover[edge] / 255;
}

export function edgeMultiplier(
  graph: RoutingGraph,
  edge: number,
  treeWeight: number,
): number {
  return Math.max(
    1 - treeWeight * graph.maxCover,
    1 - treeWeight * edgeCover(graph, edge),
  );
}

// The least any metre can cost at this weight — the greenest edge, 1 - w*maxCover. The A* heuristic
// scales straight-line distance by this so it never overestimates and the search stays optimal; being
// the graph's true minimum, it is also the tightest such coefficient.
export function minMultiplier(graph: RoutingGraph, treeWeight: number): number {
  return 1 - treeWeight * graph.maxCover;
}
