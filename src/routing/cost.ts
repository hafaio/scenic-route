// Cost is effective seconds: an edge's raw travel time times a product of scenic factors. Each
// walked metre is discounted toward a floor by the tree cover, the landmarks and public art it
// passes, the nice commercial frontage it runs along, and the shelter overhead (a factor 1 - w*attr
// per element) and made dearer by a nearby highway or elevated rail (a penalty factor 1 + w*attr); a
// ferry's crossing time is discounted by the ferry weight. The sun/shade axis is a single signed
// factor `1 - w*attr` whose weight `w in [-1, 1]` and edge attribute `attr in (-1, 1)` are both
// signed (attr positive = net sunlit, negative = net shaded, for the sun at the moment the edge is
// reached): w > 0 discounts sun and penalizes shade, w < 0 flips it, w = 0 is neutral. Every
// unsigned attribute byte is at most its graph-wide max, which the ingest clamps below 1, so every
// discount factor stays positive and the product never reaches 0 — no metre is ever free, so the
// search never wanders. The A* heuristic scales straight-line distance by `minMultiplier`, the product
// of each discount at its max (the penalty only raises cost, and the shade factor at its per-edge
// lower bound 1 - |w|*maxAbsAttr): a lower bound on any edge's multiplier, so the estimate never
// overestimates and the search stays optimal. INVARIANT: this holds only while each discount's max
// attribute stays < 1 (the ingest's 254 byte ceiling) and |w| <= 1 with maxAbsAttr < 1 for shade.
// Scaffolding rides on top of that: a deck's share of an edge is sheltered from rain outright and
// shaded for as long as the sun has not slid its shadow off the sidewalk, whether or not the toggle
// bars scaffolding — a deck you were told to avoid is still overhead. Barring it adds a flat per-metre
// penalty on the decked share, which only raises the multiplier, so the heuristic still bounds it.

import { edgeKind, type RoutingGraph } from "./graph";
import { shedShade } from "./sheds";

// NYC DCP's Pedestrian Level of Service Study (2006) timed 8,978 Lower Manhattan pedestrians at a
// mean of 1.30 m/s; work trips ran 1.34, over-65s 1.11.
export const WALK_METERS_PER_SECOND = 1.3;

// What one crossing costs beyond walking its length. The same study's 50 timed walks over 18
// signalized blocks lost 75-155 s to crosswalks against 1,490-1,850 s of walking — about 3 s a
// crossing for walkers who cross on whichever leg is green rather than waiting out a full phase, and
// well under the ~15 s a compliant random arrival would face. Deliberately one number for every
// crossing: signalized share runs from 88% in midtown to 17% on Staten Island, but the whole term is
// worth a minute on a half-hour walk, so telling them apart buys less than it costs.
export const CROSSING_SECONDS = 3;

// How long a walker will stand on a pier before the ferry stops counting as a way to get anywhere.
// The timetable always has a next sailing — tomorrow's first boat, if nothing else — so without a
// bound a route planned at midnight would propose waiting until morning. Past this the edge costs
// Infinity and the search walks instead; that only ever raises cost, so the heuristic's ferry credit
// (built at zero wait) stays a lower bound. NYC's overnight service sets the floor: the Staten
// Island Ferry runs every 30-60 minutes all night.
export const MAX_FERRY_WAIT_SECONDS = 90 * 60;

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
// Shelter from rain: a scaffolding deck plus the canopy directly overhead. Off by default — it is a
// preference for the days it is raining, not a standing bias.
export const MAX_SHELTER_WEIGHT = 1;
export const DEFAULT_SHELTER_WEIGHT = 0;

// What a metre under a deck costs while scaffolding is barred, as a multiple of walking it. Dodging
// scaffolding means crossing the street, and you cannot cross mid-block, so the real detour is
// corner-cross-back: up to about a block (~160 m) to miss maybe 40 m of deck. That breaks even near
// 4x, so this sits far enough above it that the detour is taken whenever one exists. Finite on
// purpose — a start or destination under scaffolding stays routable, and a penalty every candidate
// path has to pay cannot change which of them wins.
export const SHED_AVOID_PENALTY = 20;

// A cover gap (0..255) at or under this reads as "too close to call" (~5% cover) — the threshold
// Phase 3 directions use before bothering to name a greener side.
export const SIDE_TIE_BYTES = 12;

// The full cost context a search runs against: the scenic weights and the two gates.
export interface RouteWeights {
  tree: number;
  ferry: number;
  landmark: number;
  art: number;
  highway: number;
  commercial: number;
  shade: number; // signed sun/shade preference in [-1, 1]; positive prefers sun, negative shade
  shelter: number; // preference for cover overhead in the rain: decks and canopy
  allowFerries: boolean;
  allowSheds: boolean; // false routes around scaffolding, at a large per-metre penalty
}

// This edge's own cover, 0..1. In v2 the side is topology, so an edge carries a single value.
export function edgeCover(graph: RoutingGraph, edge: number): number {
  return graph.edgeCover[edge] / 255;
}

// The share of this edge standing under a scaffolding deck, 0 while no shed artifact is loaded.
export function edgeShed(graph: RoutingGraph, edge: number): number {
  return graph.sheds ? graph.sheds.coverage[edge] / 255 : 0;
}

// `edgeShed` damped by how far the sun has slid the deck's shadow off the sidewalk (shedShade in
// src/routing/sheds.ts). 0 while no shed artifact is loaded.
export function edgeShedShade(
  graph: RoutingGraph,
  edge: number,
  elapsedSeconds: number,
): number {
  return graph.sheds ? shedShade(graph.sheds, edge, elapsedSeconds) : 0;
}

// The signed sun/shade attribute for the sun at this point in the walk, with `shed` of the edge shaded
// by a deck. A deck is opaque, so the share it shades reads shaded whatever the sky is doing while the
// rest keeps what was baked — and since both are length fractions of the same edge the two mix rather
// than stack. That mix is `1 - (1 - bakedShade)(1 - shed)` written on the signed attribute, which reads
// -intensity where an edge is fully shaded. 0 when no artifact is loaded or the sun is down.
export function shadeAttrOf(
  graph: RoutingGraph,
  edge: number,
  elapsedSeconds: number,
  shed: number,
): number {
  if (!graph.shade) {
    return 0;
  } else if (shed === 0) {
    return graph.shade.attrAt(edge, elapsedSeconds);
  } else {
    return (
      graph.shade.attrAt(edge, elapsedSeconds) * (1 - shed) -
      shed * graph.shade.intensityAt(elapsedSeconds)
    );
  }
}

// How much of a walked metre of this edge has something over it in the rain: the deck outright, plus
// the crowns over the share with no deck under them. Both are fractions of the edge's length, so this
// is a union of coverage rather than a stack of opacities, and the `1 - shed` is the assumption that
// the two are spread independently along the edge.
function shelterAttrOf(
  graph: RoutingGraph,
  edge: number,
  shed: number,
): number {
  if (!graph.sheds) {
    return 0;
  } else {
    const canopy =
      graph.sheds.rainTau * (graph.edgeDirectCanopy[edge] / 255) * (1 - shed);
    return shed + canopy;
  }
}

// The most shelter an edge can offer: fully decked, or crowns over whatever a deck does not cover.
// Both inputs sit under their byte ceilings, so this stays < 1 and the factor's floor positive.
export function maxShelter(graph: RoutingGraph): number {
  if (!graph.sheds) {
    return 0;
  } else {
    const { maxCoverage, rainTau } = graph.sheds;
    return maxCoverage + rainTau * graph.maxDirectCanopy * (1 - maxCoverage);
  }
}

// The walking multiplier: the tree-cover, landmark, art and commercial discounts (each 1 - w*attr) and
// the signed sun/shade factor (1 - w*attr, attr and w both signed) times the nuisance penalty
// (1 + w*attr). At every weight 0 this is 1 (the shortest path); a shaded, landmarked metre far from
// any highway approaches the floor. No per-factor clip is needed — each unsigned attribute is <= its graph max, and
// the shade factor is >= its `minMultiplier` term 1 - |w|*maxAbsAttr, so the product stays positive.
// `elapsedSeconds` is how far into the walk the edge is reached; the shade field advances the sun by it,
// so the same edge costs differently early vs late in a long route. It defaults to the departure instant.
export function edgeMultiplier(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
  elapsedSeconds = 0,
): number {
  const shed = edgeShed(graph, edge);
  // Shelter is the deck's whole coverage — a roof keeps rain off from any angle — but shade is only
  // what its 4 m depth still covers once the sun has slid the shadow sideways. Both count whether or
  // not scaffolding is barred: a deck nobody wants to walk under still shelters and still shades the
  // ground it stands over, which is how the route summary reports it too.
  const shaded = edgeShedShade(graph, edge, elapsedSeconds);
  const tree = 1 - weights.tree * (graph.edgeCover[edge] / 255);
  const landmark = 1 - weights.landmark * (graph.edgeLandmark[edge] / 255);
  const art = 1 - weights.art * (graph.edgeArt[edge] / 255);
  const highway = 1 + weights.highway * (graph.edgeHighway[edge] / 255);
  const commercial =
    1 - weights.commercial * (graph.edgeCommercial[edge] / 255);
  // The signed shade attribute for the sun at this point in the walk; 0 when no artifact is loaded or at
  // night. The field ignores elapsed time for a fixed sun position (constant field, tests).
  const shade =
    1 - weights.shade * shadeAttrOf(graph, edge, elapsedSeconds, shaded);
  const shelter = 1 - weights.shelter * shelterAttrOf(graph, edge, shed);
  const scenic = tree * landmark * art * highway * commercial * shade * shelter;
  if (weights.allowSheds) {
    return scenic;
  } else {
    // Charged per metre, not per edge: a deck over a tenth of an edge must not price the whole of it.
    // The decked share costs an undiscounted metre plus the whole penalty however sure the placement
    // is — a shed that might be there is a reason to walk elsewhere, not a reason to walk under it —
    // and the bare share is costed as the bare sidewalk it is.
    return scenic * (1 - shed) + shed + SHED_AVOID_PENALTY * shed;
  }
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
    // The shade factor's per-edge floor: whichever sign of attr the weight discounts, at the field's
    // max magnitude over every edge and elapsed time. Positive because |shade| <= 1 and maxAbs < 1.
    // Compositing a deck in cannot leave that range: it mixes the baked attribute toward -intensity,
    // and the field's intensity is bounded by the same maxAbs.
    (1 - Math.abs(weights.shade) * (graph.shade ? graph.shade.maxAbs : 0)) *
    (1 - weights.shelter * maxShelter(graph))
  );
}

// The wait this edge owes, charged where a walker steps off the kerb and nowhere else. A divided
// street is several crossing edges chained through its islands, so `fromNode` — the node the walker
// enters by — is what separates the start of a crossing from its continuation.
export function crossingWait(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): number {
  return edgeKind(graph, edge) === "crossing" &&
    graph.nodeMidRoadway[fromNode] === 0
    ? CROSSING_SECONDS
    : 0;
}

// What riding a ferry takes, boarding at `fromNode` after `elapsedSeconds` of walking: the wait for
// the next sailing out of that terminal plus its crossing. Infinity once the day's last boat has gone,
// which is what drops the edge out of the search rather than pricing a walk to a dark terminal.
// Without a timetable loaded it is the graph's baked crossing-plus-average-wait figure, which is
// direction- and time-independent — the behaviour before FSCH existed.
export function ferrySeconds(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
  elapsedSeconds: number,
): { wait: number; crossing: number } {
  if (!graph.ferries?.covers(edge)) {
    return { wait: 0, crossing: graph.edgeDurationSeconds[edge] };
  }
  const sailing = graph.ferries.board(edge, fromNode, elapsedSeconds);
  if (!sailing || sailing.wait > MAX_FERRY_WAIT_SECONDS) {
    return { wait: Number.POSITIVE_INFINITY, crossing: 0 };
  } else {
    return { wait: sailing.wait, crossing: sailing.crossing };
  }
}

// The undiscounted travel time of an edge entered at `fromNode` after `elapsedSeconds` of walking: a
// ferry's wait-plus-crossing, or a walked edge's length over walking speed plus any crossing wait.
// This is the ETA unit — the reported trip time sums it.
export function rawSeconds(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
  elapsedSeconds = 0,
): number {
  if (edgeKind(graph, edge) === "ferry") {
    const { wait, crossing } = ferrySeconds(
      graph,
      edge,
      fromNode,
      elapsedSeconds,
    );
    return wait + crossing;
  } else {
    return (
      graph.edgeLength[edge] / WALK_METERS_PER_SECOND +
      crossingWait(graph, edge, fromNode)
    );
  }
}

// Cost is effective seconds: raw time times the clipped discount. A ferry discounts by the ferry
// weight (unusable when ferries are barred); every walked edge by the scenic multiplier above.
// `elapsedSeconds` — how far into the walk the edge is reached — advances the sun for the shade factor;
// it defaults to the departure instant (a ferry's cost is time-independent, so it ignores it).
export function effSeconds(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
  elapsedSeconds = 0,
  fromNode = -1,
): number {
  if (edgeKind(graph, edge) === "ferry") {
    if (!weights.allowFerries) {
      return Number.POSITIVE_INFINITY;
    } else {
      const { wait, crossing } = ferrySeconds(
        graph,
        edge,
        fromNode,
        elapsedSeconds,
      );
      // The ferry weight is a taste for BEING on a boat, so it discounts the crossing and leaves the
      // wait at full price — otherwise a strong preference would make standing on a pier cheap, and
      // the router would pick the later sailing. The baked figure has the two fused and is discounted
      // whole, which is the closest it can come.
      return wait + crossing * Math.max(FERRY_FLOOR, 1 - weights.ferry);
    }
  } else {
    return (
      (graph.edgeLength[edge] / WALK_METERS_PER_SECOND) *
      edgeMultiplier(graph, edge, weights, elapsedSeconds)
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
//
// Against a timetable the ferry's cost depends on when the walker reaches the terminal, so the bound
// has to be its cost at the LUCKIEST arrival: the quickest sailing, boarded with no wait at all.
// That is looser than the truth — the credit only ever grows, which shrinks the heuristic — so the
// estimate stays a lower bound and the search stays optimal, at the price of expanding more nodes.
export function ferryCredit(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  if (!weights.allowFerries) {
    return 0;
  }
  const coeff = walkSecondsCoeff(graph, weights);
  const discount = Math.max(FERRY_FLOOR, 1 - weights.ferry);
  let bestShortcut = 0;
  let secondShortcut = 0;
  for (const edge of graph.ferryEdges) {
    const quickest = graph.ferries?.covers(edge)
      ? graph.ferries.minRideSeconds(edge)
      : graph.edgeDurationSeconds[edge];
    const shortcut = Math.max(
      0,
      coeff * graph.edgeLength[edge] - quickest * discount,
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
