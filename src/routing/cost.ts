// Cost is effective seconds: an edge's raw travel time times a product of scenic factors. Each
// walked metre is discounted toward a floor by the tree cover, the landmarks and public art it
// passes, the nice commercial frontage it runs along, the designated historic district it runs
// inside, and the shelter overhead (a factor 1 - w*attr per element) and made dearer by a nearby
// highway or elevated rail and by the industrial land it runs past (penalty factors 1 + w*attr); a
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
// One of the two weights whose maximum is not 1 (industrial is the other), because at 1 the slider
// ran out of authority before it ran out of hill. Measured across Potrero Hill: at full strength the chosen route still climbed a block
// at or past 12% grade, and only at 2 did it stop using one at all (relief 614 m -> 431 m for 9%
// more walking). Past about 5 the routes stop changing much and start going a long way round, so
// that is where the top of the slider sits.
//
// The slider still reads 0-100%: a factor's percentage is taken against its own maximum, so this
// changes what the far end means and not how it is shown. Admissibility is untouched at any value —
// hill is a penalty, its minimum factor is 1, and `minMultiplier` never sees it.
export const MAX_HILL_WEIGHT = 5;

// The grade each relief byte's full range spans. Mirrors REFERENCE_GRADE in crates/tiler/src/relief.rs
// — the byte carries a fraction, and this is what the fraction is a fraction OF. Change one and the
// other is wrong, which is why the graph format version moves with it.
const RELIEF_MAX_GRADE = 0.35;

// The grade the hill slider is calibrated against: at this steepness the penalty is exactly the
// weight, which is where the Potrero measurements above were taken. Steeper costs more than
// proportionally and gentler costs less, because the penalty is SQUARED in the grade.
//
// That square is the whole point of the shape. A penalty proportional to grade is a penalty
// proportional to height climbed, so two routes that climb the same hill over the same distance cost
// the same however the climb is distributed — three flat blocks and one wall priced identically to
// four gradual ones. Squaring breaks the tie the way a walker would: spread the climb out and it
// costs less, concentrate it and it costs more.
const HILL_REFERENCE_GRADE = 0.12;

// The height an edge climbs, and the height it drops, over its length, walking it a -> b: real
// grade fractions rather than the bytes' own scale.
export function edgeAscentGrade(graph: RoutingGraph, edge: number): number {
  return (graph.edgeAscent[edge] / 255) * RELIEF_MAX_GRADE;
}

export function edgeDescentGrade(graph: RoutingGraph, edge: number): number {
  return (graph.edgeDescent[edge] / 255) * RELIEF_MAX_GRADE;
}

// The absolute grade of one edge: everything it climbs plus everything it drops, over its length.
// Direction-free by construction, which is what the hill penalty wants — a route that avoids a hill
// avoids it both ways. Reaches 70% on an edge that crests, since the two bytes clamp separately.
export function edgeGrade(graph: RoutingGraph, edge: number): number {
  return edgeAscentGrade(graph, edge) + edgeDescentGrade(graph, edge);
}

// Which way an edge is being walked, given the node it is entered by. The `-1` no-node default (and
// every test that passes it) means the stored a -> b direction.
export function edgeForward(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): boolean {
  return fromNode !== graph.edgeNodeB[edge];
}

// How much of the hill slider's authority an edge draws, 0 at flat and 1 at the reference grade.
// Clamped only for the summary's sake; the cost below deliberately runs past 1.
export function hillFractionOf(graph: RoutingGraph, edge: number): number {
  return Math.min(1, edgeGrade(graph, edge) / HILL_REFERENCE_GRADE);
}

// Tobler's hiking function, which is where the shape of "steep is slow" comes from: walking speed
// falls off exponentially in the grade, and its peak sits at a gentle DESCENT rather than at flat.
// Signed, so a downhill is no longer charged the climb's slowdown: a 5% descent is the fastest
// walking there is (factor 1.1912) and a 10% descent is back to flat, past which dropping is slow
// and unpleasant again.
//
// Normalized to 1 on the flat, so it scales the measured 1.3 m/s rather than replacing it with
// Tobler's own 1.4.
const TOBLER_FALLOFF = 3.5;
const TOBLER_PEAK_GRADE = 0.05; // the descent Tobler walks fastest on

export function gradeSpeedFactor(grade: number): number {
  return Math.exp(
    -TOBLER_FALLOFF * (Math.abs(grade + TOBLER_PEAK_GRADE) - TOBLER_PEAK_GRADE),
  );
}

// The speed multiplier for an edge that climbs `ascent` and drops `descent` per metre of it. With
// g = ascent + descent, the climbing run is a fraction ascent/g of the length and rises `ascent`
// times the length, so its grade is exactly g, and the dropping run's is -g. That collapses the whole
// edge to one effective speed: seconds = L/(V*g) * (ascent/f(g) + descent/f(-g)).
//
// Exact when the edge really is one constant-grade climb followed by one constant-grade drop, an
// approximation otherwise: the bytes do not say how the height was distributed along the polyline,
// and this reads them as the arrangement where every metre of it tips at the same |grade|.
//
// The result is a weighted harmonic mean of f(g) and f(-g), so it can exceed 1 only where f(-g)
// does, i.e. on descents under 10%; `maxSpeedFactor` below is what keeps the A* bound honest.
function speedFactor(ascent: number, descent: number): number {
  const grade = ascent + descent;
  if (grade === 0) {
    return 1;
  } else {
    return (
      grade /
      (ascent / gradeSpeedFactor(grade) + descent / gradeSpeedFactor(-grade))
    );
  }
}

// How fast this edge is actually walked, in the given direction (the stored a -> b one by default).
// Every place that turns a length into seconds goes through here, so the ETA and the cost cannot
// disagree about how long a hill takes.
export function walkSpeedOn(
  graph: RoutingGraph,
  edge: number,
  forward = true,
): number {
  const ascent = edgeAscentGrade(graph, edge);
  const descent = edgeDescentGrade(graph, edge);
  return (
    WALK_METERS_PER_SECOND *
    (forward ? speedFactor(ascent, descent) : speedFactor(descent, ascent))
  );
}

// The fastest any edge in the graph can be walked, as a multiple of the flat speed — the divisor the
// A* heuristic's per-metre floor needs now that a descent can beat flat. Deliberately computed here
// rather than baked into the graph header: a figure in the file would go silently stale the moment
// the Tobler constants moved without a format bump.
//
// Memoized per graph because `solveApprox` runs this on every drag frame. The scan is cheap: an
// edge's factor is a weighted harmonic mean of f(g) and f(-g), so it cannot exceed f(-g), which is
// itself at most 1 once the total grade reaches twice Tobler's peak. So only gentle edges need an
// `exp` at all, and a flat city (every byte 0) settles at exactly 1 without one.
const DOWNHILL_GRADE_CEILING = 2 * TOBLER_PEAK_GRADE;
const maxSpeedFactors = new WeakMap<RoutingGraph, number>();

export function maxSpeedFactor(graph: RoutingGraph): number {
  const memoized = maxSpeedFactors.get(graph);
  if (memoized !== undefined) {
    return memoized;
  }
  let best = 1;
  for (let edge = 0; edge < graph.edgeAscent.length; edge++) {
    const grade = edgeGrade(graph, edge);
    if (grade === 0 || grade >= DOWNHILL_GRADE_CEILING) {
      continue;
    }
    // Either direction may be walked, and the faster one is whichever puts more of the edge on the
    // descent, so the bound reads the larger byte as the drop.
    const ascent = Math.min(
      edgeAscentGrade(graph, edge),
      edgeDescentGrade(graph, edge),
    );
    best = Math.max(best, speedFactor(ascent, grade - ascent));
  }
  maxSpeedFactors.set(graph, best);
  return best;
}
export const DEFAULT_HIGHWAY_WEIGHT = 0.5;
// Hills start at zero, and now mean only what the name says: how much you MIND one, over and above
// the time it costs. The time is charged whatever the slider reads, because the walking speed itself
// is grade-adjusted — so a hilly route is reported as the longer walk it is, and the router prefers
// the flatter one at zero weight without being told to.
export const DEFAULT_HILL_WEIGHT = 0;
// A discount for edges fronting a nice commercial block. Modest default, tunable by eye.
export const MAX_COMMERCIAL_WEIGHT = 1;
export const DEFAULT_COMMERCIAL_WEIGHT = 0.1;
// A discount for walking inside a designated historic district. Parity with the landmark, art and
// commercial discounts, deliberately: it is the same kind of preference, and no measurement yet says
// otherwise. Note the attribute is close to binary — an interior sidewalk reads the 254 ceiling and
// only a boundary edge reads a part — so at w = 1 an in-district metre is nearly free and the
// heuristic floor nearly collapses. That is in-family (tree cover does it too) and admissible, since
// the byte ceiling keeps maxHistoric < 1; it is a reason to move this on measurements rather than to
// pre-inflate the maximum the way industrial's was.
export const MAX_HISTORIC_WEIGHT = 1;
export const DEFAULT_HISTORIC_WEIGHT = 0.1;
// A penalty for edges running past industrial land, in the highway family. The top of the slider sits
// where hill's does, and for the same reason: measured over 234 trips seeded on industrial streets, a
// ceiling of 1 left a third of them on exactly the route they took with the slider off and removed
// only 40% of the industrial frontage walked (17.2% -> 10.4%). The saturated districts moved
// dramatically at that setting, which is what made it look sufficient; the middle of the distribution
// did not. At 5 it reaches 5.1% for 14.5% more walking, and past that routes go a long way round.
//
// The slider still reads 0-100% of this maximum, so raising it changes what the far end means, not
// how it is shown. Admissibility is untouched — a penalty's minimum factor is 1, and `minMultiplier`
// never sees it.
export const MAX_INDUSTRIAL_WEIGHT = 5;
// 1 rather than highway's 0.5: it moves 63% of those trips for 3.6% more walking, where 0.5 moves
// under half. Reads as 20% on the slider.
export const DEFAULT_INDUSTRIAL_WEIGHT = 1;
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
  // Penalty for climbing: how much a walker minds a hill. Absolute, so it costs the same up or
  // down — a route that avoids a hill avoids it in both directions.
  hill: number;
  commercial: number;
  // Penalty for walking past industrial land: the share of the edge's length with a yard or a
  // warehouse beside it, counted per side, so both sides cost twice one.
  industrial: number;
  // Discount for walking inside a designated historic district: the share of the edge's length that
  // falls within one. Independent of `landmark`, which prices passing an individual monument.
  historic: number;
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

// The walking multiplier: the tree-cover, landmark, art, commercial and historic-district discounts
// (each 1 - w*attr) and the signed sun/shade factor (1 - w*attr, attr and w both signed) times the
// nuisance penalty (1 + w*attr). At every weight 0 this is 1 (the shortest path); a shaded,
// landmarked metre far from any highway approaches the floor. No per-factor clip is needed — each unsigned attribute is <= its graph max, and
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
  // Squared, so the same climb spread over a longer stretch costs less than the same climb
  // concentrated into a wall; `HILL_REFERENCE_GRADE` carries the reasoning. Unclamped above the
  // reference — San Francisco has streets at three times it, and they should cost like it.
  const gradeShare = edgeGrade(graph, edge) / HILL_REFERENCE_GRADE;
  const hill = 1 + weights.hill * gradeShare * gradeShare;
  const commercial =
    1 - weights.commercial * (graph.edgeCommercial[edge] / 255);
  const industrial =
    1 + weights.industrial * (graph.edgeIndustrial[edge] / 255);
  const historic = 1 - weights.historic * (graph.edgeHistoric[edge] / 255);
  // The signed shade attribute for the sun at this point in the walk; 0 when no artifact is loaded or at
  // night. The field ignores elapsed time for a fixed sun position (constant field, tests).
  const shade =
    1 - weights.shade * shadeAttrOf(graph, edge, elapsedSeconds, shaded);
  const shelter = 1 - weights.shelter * shelterAttrOf(graph, edge, shed);
  const scenic =
    tree *
    landmark *
    art *
    highway *
    hill *
    commercial *
    industrial *
    historic *
    shade *
    shelter;
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
    (1 - weights.historic * graph.maxHistoric) *
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
      graph.edgeLength[edge] /
        walkSpeedOn(graph, edge, edgeForward(graph, edge, fromNode)) +
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
      (graph.edgeLength[edge] /
        walkSpeedOn(graph, edge, edgeForward(graph, edge, fromNode))) *
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
  // Divided by the fastest speed any edge in the graph can be walked at, which a gentle descent puts
  // above the flat 1.3 m/s — so this stays a LOWER bound on the seconds a metre costs, which is all
  // the heuristic needs.
  return (
    minMultiplier(graph, weights) /
    (WALK_METERS_PER_SECOND * maxSpeedFactor(graph))
  );
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
