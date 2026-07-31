// Placing a DOB sidewalk-shed permit on the sidewalk edges it actually stands over.
//
// A shed is one continuous structure on the pavement at a property line, so the tax lot is the
// geometry it runs along: the stretch of the lot boundary facing a sidewalk that carries the
// permit's street name is the shed's measured frontage. A permit longer than that frontage runs on
// past the property and around the corner, which is a bounded walk over the sidewalk network; a
// permit shorter than it is a single run anchored at the building being worked on.
//
// Every constant here was chosen by measuring the whole feed against it, and three of them are
// load-bearing in ways that do not look it: the 10 m off-street budget (at 0 m the verified
// three-street wrap at 80 Pine Street breaks, and past 15 m the walk buys more off-lot error than
// placed length), the preference for continuing along the permit's own street over taking a
// straighter turn off it, and the recovery pass that spends a stranded run on the lot's own
// unreached frontage. Do not tune them by eye.

import {
  edgeGeometryRight,
  edgeKind,
  edgeName,
  edgePath,
  edgeSideLabel,
  type RoutingGraph,
  type SideLabel,
} from "../src/routing/graph";
import {
  boundsOf,
  boxGap,
  densifyRing,
  type LineProjection,
  newProjection,
  outwardNormals,
  pointAt,
  polylineLength,
  projectToPolyline,
  projectX,
  projectY,
  ringCentroid,
  ringSignedArea,
  ringToPoint,
  ringToPolyline,
  ringToRing,
} from "./planar";
import type { Ring } from "./shed-parcels";
import { streetScore } from "./shed-streets";

const FEET_PER_METER = 3.280839895;
// A boundary point further than this from every sidewalk is under no sidewalk at all — a rear wall,
// an interior lot line, a waterfront edge. Set well past the widest plausible setback.
const MAX_FRONTAGE_METERS = 30;
// A wall fronts a sidewalk only if the sidewalk lies within ~70 degrees of its outward normal.
const FACING_COSINE = 0.34;
// Candidate sidewalks are gathered this far out, so the named street is always in the pool even when
// the lot does not reach it.
const CANDIDATE_RADIUS_METERS = 70;
const RING_STEP_METERS = 1;
const NORMAL_WINDOW = 3;
const NAME_MATCH_THRESHOLD = 0.6;
// A span shorter than this on one edge is projection noise, not coverage.
const MIN_SPAN_METERS = 2;
// Only the boundary plane nearest a sidewalk is its frontage; a deep lot's side lines are still
// "facing" at a glancing angle and would stretch the span down the block.
const FRONTAGE_DEPTH_METERS = 8;
// A same-name sidewalk further out than this behind the near one is the opposite side of the street.
const SIDE_BAND_METERS = 7;
// A shed describes one street. One corner costs ~90 degrees, so this allows a corner and a little
// drift but not a lap of a cul-de-sac.
const MAX_WRAP_TURN_DEGREES = 150;
// A single junction that doubles back this far is a dead end or a service loop, not a continuation.
const MAX_JUNCTION_TURN_DEGREES = 100;
// Off the permit's street and off the lot's own frontage the walk is guessing. This is the whole
// budget for that guess, shared by both directions: enough to round a corner and cover the return,
// not enough to run a block face of a cross street.
const MAX_OFF_STREET_METERS = 10;
// A wrap onto a cross street the lot genuinely fronts may overrun that frontage by this much, so a
// corner is not cut off a metre short by the facing test.
const LOT_ARC_SLACK_METERS = 5;
// Step for ordering unused pieces of frontage by how near the anchor they are. Coarse on purpose:
// it only has to order the arcs, not measure them.
const ARC_SAMPLE_STEP_METERS = 5;
const GRID_CELL_METERS = 150;
// Cell coordinates never reach this, so packing two of them into one key never collides.
const CELL_KEY_OFFSET = 1 << 20;
const CELL_KEY_STRIDE = 1 << 21;

// How deep the deck is, which is the sidewalk's own width less a margin at the kerb — and no dataset
// New York publishes carries a sidewalk width. Two lines fix it here.
//
// The KERB comes out of the graph: a sidewalk's baked polyline is the centreline offset by the
// half-offset byte, which is half the roadway plus the manifest's `sidewalkInsetMeters`. So the kerb
// is always exactly that inset inboard of the polyline — and nothing else about the pavement is in
// the byte, which measures the ROADWAY and stops at the kerb. The polyline is where the inset says
// the middle of the sidewalk is, not where it is.
//
// The BUILDING line is the lot boundary the placement already measures its frontage against, so the
// pavement's width is the lot line's signed offset from the polyline plus that inset.
const SIDEWALK_INSET_METERS = 2; // the manifest's streets.sidewalkInsetMeters, kerb to the baked line
// A shed's deck stops short of the kerb rather than overhanging the gutter — DOB wants the roadway
// clear, and a foot is what the drawings leave.
const KERB_MARGIN_METERS = 0.3;
// The lot's street wall runs parallel to the pavement, so its samples sit at one distance and the
// side lot lines running back off it climb away. Only samples this near the closest one are the
// street wall.
const STREET_WALL_BAND_METERS = 2;
// What the measurement is clamped into. The pavement widths come out as a clean bell around 3.7 m —
// a 12 ft sidewalk, which is what New York builds — with a tail either side that is not pavement.
//
// The CEILING is where the bell ends: past 8 m — 26 ft, wider than a Midtown avenue's pavement — the
// counts stop falling and go flat all the way out to 32 m, which is a different population entirely
// (superblocks, forecourts, plazas, a lot line that simply is not the building line). 3.7% of spans
// are up there. Clamping rather than discarding is the honest drawing: the deck runs out from the
// kerb over as much pavement as there can be, and the ground between it and a tower set 20 m back is
// not decked by anyone.
//
// The FLOOR is the artifact's own: a depth rounds to decimetres and 0 decimetres is the byte that
// means "not measured". What CANNOT be built is floored by the reader instead
// (MIN_DECK_DEPTH_METERS in src/routing/sheds.ts), which is the only side that knows where the kerb
// was put and so the only one that can widen a deck outward over the roadway rather than into the
// building the measurement found.
const MIN_DECK_DEPTH_METERS = 0.1;
const MAX_DECK_DEPTH_METERS = 8;

// Every sidewalk edge of the routing graph as a polyline in the metre frame, with a uniform grid
// over their bounding boxes and the incidence the wrap walk steps through.
export interface SidewalkIndex {
  graph: RoutingGraph;
  edges: Uint32Array; // position -> graph edge id
  positionOf: Int32Array; // graph edge id -> position, -1 when the edge is not a sidewalk
  lines: Float64Array[]; // position -> projected polyline
  lengths: Float64Array; // position -> that polyline's length, which the walk asks for constantly
  boxes: Float64Array[]; // position -> its bounding box
  cells: Map<number, Uint32Array>; // grid cell -> the positions whose box touches it
  nodeSidewalks: Map<number, number[]>; // node id -> incident sidewalk edge ids
}

function cellKey(cellX: number, cellY: number): number {
  return (
    (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cellY + CELL_KEY_OFFSET)
  );
}

export function buildSidewalkIndex(graph: RoutingGraph): SidewalkIndex {
  const edges: number[] = [];
  const lines: Float64Array[] = [];
  const lengths: number[] = [];
  const boxes: Float64Array[] = [];
  const positionOf = new Int32Array(graph.edgeCount).fill(-1);
  const nodeSidewalks = new Map<number, number[]>();
  const buckets = new Map<number, number[]>();

  for (let edge = 0; edge < graph.edgeCount; edge++) {
    if (edgeKind(graph, edge) !== "sidewalk") {
      continue;
    }
    const { lngs, lats } = edgePath(graph, edge);
    if (lngs.length < 2) {
      continue;
    }
    const coords = new Float64Array(lngs.length * 2);
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      coords[vertex * 2] = projectX(lngs[vertex]);
      coords[vertex * 2 + 1] = projectY(lats[vertex]);
    }
    const position = edges.length;
    positionOf[edge] = position;
    edges.push(edge);
    lines.push(coords);
    lengths.push(polylineLength(coords));
    const box = boundsOf(coords);
    boxes.push(box);
    for (const node of [graph.edgeNodeA[edge], graph.edgeNodeB[edge]]) {
      const incident = nodeSidewalks.get(node);
      if (incident) {
        incident.push(edge);
      } else {
        nodeSidewalks.set(node, [edge]);
      }
    }
    for (
      let cellX = Math.floor(box[0] / GRID_CELL_METERS);
      cellX <= Math.floor(box[2] / GRID_CELL_METERS);
      cellX++
    ) {
      for (
        let cellY = Math.floor(box[1] / GRID_CELL_METERS);
        cellY <= Math.floor(box[3] / GRID_CELL_METERS);
        cellY++
      ) {
        const key = cellKey(cellX, cellY);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.push(position);
        } else {
          buckets.set(key, [position]);
        }
      }
    }
  }

  const cells = new Map<number, Uint32Array>();
  for (const [key, bucket] of buckets) {
    cells.set(key, Uint32Array.from(bucket));
  }
  return {
    graph,
    edges: Uint32Array.from(edges),
    positionOf,
    lines,
    lengths: Float64Array.from(lengths),
    boxes,
    cells,
    nodeSidewalks,
  };
}

// Every sidewalk whose bounding box reaches into a box, ascending by edge id.
function edgesNear(index: SidewalkIndex, box: Float64Array): number[] {
  const found = new Set<number>();
  for (
    let cellX = Math.floor(box[0] / GRID_CELL_METERS);
    cellX <= Math.floor(box[2] / GRID_CELL_METERS);
    cellX++
  ) {
    for (
      let cellY = Math.floor(box[1] / GRID_CELL_METERS);
      cellY <= Math.floor(box[3] / GRID_CELL_METERS);
      cellY++
    ) {
      for (const position of index.cells.get(cellKey(cellX, cellY)) ?? []) {
        const other = index.boxes[position];
        if (
          other[0] <= box[2] &&
          other[2] >= box[0] &&
          other[1] <= box[3] &&
          other[3] >= box[1]
        ) {
          found.add(index.edges[position]);
        }
      }
    }
  }
  return [...found].sort((left, right) => left - right);
}

function lineOf(index: SidewalkIndex, edge: number): Float64Array {
  return index.lines[index.positionOf[edge]];
}

function lengthOf(index: SidewalkIndex, edge: number): number {
  return index.lengths[index.positionOf[edge]];
}

// One shed's coverage of one sidewalk edge, as the fractions of the edge it runs between.
export interface ShedSpan {
  edge: number;
  t0: number;
  t1: number;
  meters: number;
  // The deck's depth here, building line to just short of the kerb, in metres — NaN where this run
  // has no lot boundary behind it to measure against and the shed has none anywhere else either.
  depthMeters: number;
}

export interface ShedPlacement {
  status: "ok" | "noFootprint" | "noSidewalk" | "noNamedStreet";
  spans: ShedSpan[]; // descending by length; empty when nothing could be placed
  geometrySource: "lot" | "building" | "none";
  primaryEdge: number | null;
  oppositeEdge: number | null;
  primaryDistance: number; // frontage geometry to the chosen sidewalk, metres
  oppositeDistance: number; // and to the sidewalk across the street
  sideMargin: number; // gap to the next-nearest same-name frontage candidate
  frontageMeters: number; // the length of the lot's arc on the permit's street
  shedMeters: number; // what the permit claims
  coveredMeters: number;
  offStreetMeters: number; // coverage on an edge that is not the permit's street
  offLotMeters: number; // of that, the part with no lot frontage behind it either
  unplacedMeters: number; // permit length the walk refused to place anywhere
  recoveredMeters: number; // length put on lot frontage the walk could not reach on foot
  measuredDepths: number; // spans whose depth was measured against their own frontage
  nameMatched: boolean;
  nameScore: number;
  confidence: number;
}

export interface ShedRequest {
  street: string;
  linearFeet: number; // NaN when the feed carries none
  lot: readonly Ring[] | null;
  footprint: readonly Ring[] | null;
  lng: number | null; // the permit's own geocode, which picks the part of a multi-part lot
  lat: number | null;
}

interface Arc {
  low: number;
  high: number;
}

interface Shadow extends Arc {
  distance: number;
  // The lot's street wall as a SIGNED offset from the sidewalk's baked polyline, positive away from
  // the roadway. It takes either sign: the polyline sits a fixed inset out from the kerb, so on a
  // pavement narrower than twice that inset the lot line falls on the roadway side of it. NaN when
  // nothing here reads as a street wall.
  offset: number;
}

// Where the wrap walk is allowed to spend a permit that overruns its measured frontage. Two places
// are legitimate: further along the permit's own street, and around a corner onto a street the lot
// itself fronts — a corner building's shed really does turn, for exactly the length of the side lot
// line. Everywhere else it is inventing, so it gets one small shared budget and then stops.
interface WrapContext {
  street: string;
  lotArcs: Map<number, Arc>;
  scores: Map<number, number>; // memoized across the walk
  budget: number;
  charged: number; // metres already taken out of that budget
}

function onStreet(
  index: SidewalkIndex,
  context: WrapContext,
  edge: number,
): boolean {
  let score = context.scores.get(edge);
  if (score === undefined) {
    score = streetScore(context.street, edgeName(index.graph, edge));
    context.scores.set(edge, score);
  }
  return score >= NAME_MATCH_THRESHOLD;
}

function toRing(ring: Ring): Float64Array {
  const projected = new Float64Array(ring.length);
  for (let at = 0; at < ring.length; at += 2) {
    projected[at] = projectX(ring[at]);
    projected[at + 1] = projectY(ring[at + 1]);
  }
  return ringSignedArea(projected) < 0 ? reverseRing(projected) : projected;
}

function reverseRing(ring: Float64Array): Float64Array {
  const out = new Float64Array(ring.length);
  for (let at = 0; at < ring.length; at += 2) {
    out[at] = ring[ring.length - 2 - at];
    out[at + 1] = ring[ring.length - 1 - at];
  }
  return out;
}

function ringArea(ring: Float64Array): number {
  return Math.abs(ringSignedArea(ring));
}

// Which part of a multi-part lot or building the permit actually sits on: the one nearest whatever
// is known about where it is, and the largest when nothing is. Returns the index rather than the
// ring, so a caller holding the source rings can keep the one that was chosen.
function pickPartIndex(
  parts: readonly Float64Array[],
  anchorRing: Float64Array | null,
  anchorX: number,
  anchorY: number,
): number {
  const anchored = anchorRing !== null || Number.isFinite(anchorX);
  if (parts.length === 1 || !anchored) {
    let widest = 0;
    for (const [index, part] of parts.entries()) {
      if (ringArea(part) > ringArea(parts[widest])) {
        widest = index;
      }
    }
    return widest;
  } else {
    const distanceTo = (part: Float64Array): number =>
      anchorRing !== null
        ? ringToRing(part, anchorRing)
        : ringToPoint(part, anchorX, anchorY);
    let best = 0;
    let bestDistance = distanceTo(parts[0]);
    let bestArea = ringArea(parts[0]);
    for (const [index, part] of parts.entries()) {
      const distance = distanceTo(part);
      const area = ringArea(part);
      if (
        distance < bestDistance ||
        (distance === bestDistance && area > bestArea)
      ) {
        best = index;
        bestDistance = distance;
        bestArea = area;
      }
    }
    return best;
  }
}

function pickPart(
  parts: readonly Float64Array[],
  anchorRing: Float64Array | null,
  anchorX: number,
  anchorY: number,
): Float64Array {
  return parts[pickPartIndex(parts, anchorRing, anchorX, anchorY)];
}

// The one lot part and the one building part a permit stands on, in lng/lat. This is the whole of
// what a placement reads about the world besides the permit's own street and length, and it is
// graph-independent — which is what lets the daily job store it and re-snap against a rebuilt graph
// instead of going back to the tax map. `placeShed` re-runs the same choice, but on a single-part
// list it is the identity, so feeding these back in reproduces the placement exactly.
export function pickShedParts(request: ShedRequest): {
  lot: Ring | null;
  footprint: Ring | null;
} {
  const pointX = request.lng === null ? Number.NaN : projectX(request.lng);
  const pointY = request.lat === null ? Number.NaN : projectY(request.lat);
  const buildings = (request.footprint ?? []).map(toRing);
  const footprint =
    buildings.length > 0
      ? pickPartIndex(buildings, null, pointX, pointY)
      : null;
  const lots = (request.lot ?? []).map(toRing);
  const lot =
    lots.length > 0
      ? pickPartIndex(
          lots,
          footprint === null ? null : buildings[footprint],
          pointX,
          pointY,
        )
      : null;
  return {
    lot: lot === null ? null : (request.lot as readonly Ring[])[lot],
    footprint:
      footprint === null
        ? null
        : (request.footprint as readonly Ring[])[footprint],
  };
}

// The median of `count` values held at the front of `scratch`, which it reorders.
function medianOf(scratch: Float64Array, count: number): number {
  if (count === 0) {
    return Number.NaN;
  }
  const values = scratch.subarray(0, count);
  values.sort();
  return count % 2 === 1
    ? values[(count - 1) / 2]
    : (values[count / 2 - 1] + values[count / 2]) / 2;
}

// Per candidate sidewalk: the along-span of the boundary facing it, how far away it is, and where its
// street wall sits relative to the sidewalk's own line.
//
// Which sidewalk the shed belongs to is decided on raw distance alone — the facing test only shapes
// the span, because a baked sidewalk offset that lands inside the lot makes every wall "face away"
// and would hand the shed to the far side of the street.
function frontageShadows(
  index: SidewalkIndex,
  ring: Float64Array,
  candidates: readonly number[],
): Map<number, Shadow> {
  const points = densifyRing(ring, RING_STEP_METERS);
  const normals = outwardNormals(points, NORMAL_WINDOW);
  const box = boundsOf(points);
  const shadows = new Map<number, Shadow>();
  const projection: LineProjection = newProjection();
  const alongs = new Float64Array(points.length / 2);
  const distances = new Float64Array(points.length / 2);
  const facings = new Float64Array(points.length / 2);
  const offsets = new Float64Array(points.length / 2);
  const wall = new Float64Array(points.length / 2);

  for (const edge of candidates) {
    const coords = lineOf(index, edge);
    // The boundary points can be no nearer than the boxes are, so this rejects the bulk of the
    // candidate pool before touching a segment.
    if (
      boxGap(box, index.boxes[index.positionOf[edge]]) > MAX_FRONTAGE_METERS
    ) {
      continue;
    }
    // The side the sidewalk was baked to, which is the side its building line is on: a sidewalk
    // polyline is the centreline pushed to its geometry-left unless the flag says right.
    const outward = edgeGeometryRight(index.graph, edge) ? -1 : 1;
    let nearest = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < alongs.length; sample++) {
      const pointX = points[sample * 2];
      const pointY = points[sample * 2 + 1];
      projectToPolyline(coords, pointX, pointY, projection);
      alongs[sample] = projection.along;
      distances[sample] = projection.distance;
      nearest = Math.min(nearest, projection.distance);
      // The same distance, signed by which side of the line the point fell on: the line's left
      // normal is its direction turned a quarter turn counter-clockwise, and `outward` flips it to
      // point away from the roadway either way.
      offsets[sample] =
        outward *
        (projection.tangentX * (pointY - projection.y) -
          projection.tangentY * (pointX - projection.x));
      const towardsX = projection.x - pointX;
      const towardsY = projection.y - pointY;
      const reach = Math.hypot(towardsX, towardsY);
      // A lot line running along the sidewalk itself has an offset vector that is numerical noise
      // rather than a direction, so such a point is frontage by construction.
      facings[sample] =
        reach < 0.5
          ? 1
          : (towardsX * normals[sample * 2] +
              towardsY * normals[sample * 2 + 1]) /
            reach;
    }
    if (nearest > MAX_FRONTAGE_METERS) {
      continue;
    }
    const depth = nearest + FRONTAGE_DEPTH_METERS;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let walls = 0;
    for (let sample = 0; sample < alongs.length; sample++) {
      if (distances[sample] <= depth && facings[sample] >= FACING_COSINE) {
        low = Math.min(low, alongs[sample]);
        high = Math.max(high, alongs[sample]);
      }
      // The street wall: near the closest the lot comes, and square to the line rather than running
      // back off it. The facing is taken in magnitude because a polyline inside the lot makes the
      // wall face away from it while still being the wall.
      if (
        distances[sample] <= nearest + STREET_WALL_BAND_METERS &&
        Math.abs(facings[sample]) >= FACING_COSINE
      ) {
        wall[walls] = offsets[sample];
        walls += 1;
      }
    }
    if (low > high) {
      for (let sample = 0; sample < alongs.length; sample++) {
        if (distances[sample] <= depth) {
          low = Math.min(low, alongs[sample]);
          high = Math.max(high, alongs[sample]);
        }
      }
    }
    // The median rather than the nearest sample: a stoop, a bay or a quantized corner reaches a
    // metre past the wall, and a shed follows the wall.
    shadows.set(edge, {
      low,
      high,
      distance: nearest,
      offset: medianOf(wall, walls),
    });
  }
  return shadows;
}

const FLIPPED_SIDES: Readonly<Record<string, SideLabel>> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

// The other sidewalk of the same street: same name, opposite side label, nearest. What the side-of-
// street margin is measured against.
function oppositeSidewalk(
  index: SidewalkIndex,
  edge: number,
  candidates: readonly number[],
): number | null {
  const { graph } = index;
  const nameId = graph.edgeNameId[edge];
  const flipped = FLIPPED_SIDES[edgeSideLabel(graph, edge) ?? ""];
  const reference = lineOf(index, edge);
  let best: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const other of candidates) {
    if (other === edge || graph.edgeNameId[other] !== nameId) {
      continue;
    }
    if (flipped !== undefined && edgeSideLabel(graph, other) !== flipped) {
      continue;
    }
    const line = lineOf(index, other);
    const middle = pointAt(line, lengthOf(index, other) / 2);
    const projection = projectToPolyline(
      reference,
      middle.x,
      middle.y,
      newProjection(),
    );
    // The paired sidewalk runs alongside this one down the block, so require overlap in the along
    // direction rather than mere proximity at a shared corner.
    const score =
      Math.max(0, polylineDistance(reference, line)) + projection.distance;
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function polylineDistance(left: Float64Array, right: Float64Array): number {
  let best = Number.POSITIVE_INFINITY;
  for (let at = 0; at < right.length; at += 2) {
    best = Math.min(
      best,
      pointToPolylineDistance(left, right[at], right[at + 1]),
    );
  }
  for (let at = 0; at < left.length; at += 2) {
    best = Math.min(
      best,
      pointToPolylineDistance(right, left[at], left[at + 1]),
    );
  }
  return best;
}

function pointToPolylineDistance(
  coords: Float64Array,
  x: number,
  y: number,
): number {
  return projectToPolyline(coords, x, y, newProjection()).distance;
}

// How deep the deck standing on one sidewalk is: the pavement from the lot's street wall out to the
// kerb, less the margin the deck stops short by. NaN where there is no wall behind this run at all —
// the walk wrapped onto a street the lot does not front.
function deckDepth(shadow: Shadow | undefined): number {
  if (shadow === undefined || !Number.isFinite(shadow.offset)) {
    return Number.NaN;
  }
  const depth = SIDEWALK_INSET_METERS + shadow.offset - KERB_MARGIN_METERS;
  return Math.min(
    MAX_DECK_DEPTH_METERS,
    Math.max(MIN_DECK_DEPTH_METERS, depth),
  );
}

// A run with no wall behind it takes the median of the runs that have one — the shed's own lot
// rather than the city's, which is the nearest evidence there is. Nothing left to go on leaves NaN,
// and the artifact stores that as "not measured" for the client to fall back on. Returns how many
// spans measured their own.
function fillDepths(spans: ShedSpan[]): number {
  const measured = Float64Array.from(
    spans.map((span) => span.depthMeters).filter(Number.isFinite),
  );
  const fallback = medianOf(measured, measured.length);
  for (const span of spans) {
    if (!Number.isFinite(span.depthMeters)) {
      span.depthMeters = fallback;
    }
  }
  return measured.length;
}

export function placeShed(
  index: SidewalkIndex,
  request: ShedRequest,
): ShedPlacement {
  const { graph } = index;
  const result: ShedPlacement = {
    status: "ok",
    spans: [],
    geometrySource: "none",
    primaryEdge: null,
    oppositeEdge: null,
    primaryDistance: Number.NaN,
    oppositeDistance: Number.NaN,
    sideMargin: Number.NaN,
    frontageMeters: Number.NaN,
    shedMeters:
      request.linearFeet > 0 ? request.linearFeet / FEET_PER_METER : Number.NaN,
    coveredMeters: 0,
    offStreetMeters: 0,
    offLotMeters: 0,
    unplacedMeters: 0,
    recoveredMeters: 0,
    measuredDepths: 0,
    nameMatched: false,
    nameScore: 0,
    confidence: 0,
  };

  const pointX = request.lng === null ? Number.NaN : projectX(request.lng);
  const pointY = request.lat === null ? Number.NaN : projectY(request.lat);
  const buildings = (request.footprint ?? []).map(toRing);
  const footprint =
    buildings.length > 0 ? pickPart(buildings, null, pointX, pointY) : null;
  const lots = (request.lot ?? []).map(toRing);
  const lot =
    lots.length > 0 ? pickPart(lots, footprint, pointX, pointY) : null;
  const frontage = lot ?? footprint;
  result.geometrySource =
    lot !== null ? "lot" : footprint !== null ? "building" : "none";
  if (frontage === null) {
    result.status = "noFootprint";
    return result;
  }

  const box = boundsOf(frontage);
  const candidates = edgesNear(
    index,
    Float64Array.of(
      box[0] - CANDIDATE_RADIUS_METERS,
      box[1] - CANDIDATE_RADIUS_METERS,
      box[2] + CANDIDATE_RADIUS_METERS,
      box[3] + CANDIDATE_RADIUS_METERS,
    ),
  );
  if (candidates.length === 0) {
    result.status = "noSidewalk";
    return result;
  }

  const shadows = frontageShadows(index, frontage, candidates);
  if (shadows.size === 0) {
    result.status = "noSidewalk";
    return result;
  }

  const scores = new Map<number, number>();
  for (const edge of candidates) {
    scores.set(edge, streetScore(request.street, edgeName(graph, edge)));
  }
  let named = [...shadows].filter(
    ([edge]) => (scores.get(edge) ?? 0) >= NAME_MATCH_THRESHOLD,
  );
  result.nameMatched = named.length > 0;
  if (named.length === 0) {
    // Nothing in front of this lot carries the permit's street name: a renamed street, a private
    // drive, a plaza address. Fall back to the closest frontage there is.
    result.status = "noNamedStreet";
    let closest = candidates[0];
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const [edge, shadow] of shadows) {
      if (shadow.distance < closestDistance) {
        closestDistance = shadow.distance;
        closest = edge;
      }
    }
    named = [[closest, shadows.get(closest) as Shadow]];
  }

  // The lot's own side of the street: the opposite sidewalk of the same name also faces the lot and
  // would otherwise seed a span a full roadbed away.
  const nearest = Math.min(...named.map(([, shadow]) => shadow.distance));
  const behind = named
    .map(([, shadow]) => shadow.distance)
    .filter((distance) => distance > nearest + 1e-6);
  result.sideMargin =
    behind.length > 0
      ? Math.min(...behind) - nearest
      : Number.POSITIVE_INFINITY;

  const seeds = new Map<number, Arc>();
  for (const [edge, shadow] of named) {
    if (shadow.distance <= nearest + SIDE_BAND_METERS) {
      seeds.set(edge, { low: shadow.low, high: shadow.high });
    }
  }
  const spans = new Map<number, Arc>();
  let frontageMeters = 0;
  let primary = -1;
  let primaryDistance = Number.POSITIVE_INFINITY;
  for (const [edge, arc] of seeds) {
    spans.set(edge, { low: arc.low, high: arc.high });
    frontageMeters += arc.high - arc.low;
    const distance = (shadows.get(edge) as Shadow).distance;
    if (distance < primaryDistance) {
      primaryDistance = distance;
      primary = edge;
    }
  }
  result.frontageMeters = frontageMeters;
  result.nameScore = scores.get(primary) ?? 0;

  // When nothing carried the permit's name the fallback edge's own street stands in for it, so the
  // walk still has a street to follow rather than treating every step as a guess.
  const context: WrapContext = {
    street: result.nameMatched
      ? request.street
      : (edgeName(graph, primary) ?? request.street),
    lotArcs: new Map(
      [...shadows].map(([edge, shadow]) => [
        edge,
        { low: shadow.low, high: shadow.high },
      ]),
    ),
    scores: result.nameMatched ? scores : new Map(),
    budget: MAX_OFF_STREET_METERS,
    charged: 0,
  };

  const target =
    Number.isFinite(result.shedMeters) && result.shedMeters > 0
      ? result.shedMeters
      : frontageMeters;
  if (target < frontageMeters) {
    // A shed is one continuous structure, so a permit shorter than the frontage is a single run in
    // front of the building being worked on — not the whole lot line thinned out.
    const bounds = new Map(
      [...spans].map(([edge, arc]) => [edge, { low: arc.low, high: arc.high }]),
    );
    // A seed arc pinches to nothing where the lot only clips the end of a stub edge, which leaves
    // the run nowhere to grow. Anchor on the widest piece of frontage instead; `primary` still names
    // the sidewalk the lot is measured against.
    let start = primary;
    const primaryArc = bounds.get(primary) as Arc;
    if (primaryArc.high - primaryArc.low < MIN_SPAN_METERS) {
      for (const [edge, arc] of bounds) {
        const widest = bounds.get(start) as Arc;
        if (arc.high - arc.low > widest.high - widest.low) {
          start = edge;
        }
      }
    }
    const startArc = bounds.get(start) as Arc;
    let anchor = (startArc.low + startArc.high) / 2;
    if (footprint !== null && lot !== null) {
      const centroid = ringCentroid(footprint);
      const projection = projectToPolyline(
        lineOf(index, start),
        centroid.x,
        centroid.y,
        newProjection(),
      );
      anchor = Math.min(
        Math.max(projection.along, startArc.low),
        startArc.high,
      );
    }
    spans.clear();
    spans.set(start, { low: anchor, high: anchor });
    const stranded = growSpans(index, spans, start, target, context, bounds);
    if (stranded > MIN_SPAN_METERS) {
      const anchorPoint = pointAt(lineOf(index, start), anchor);
      result.recoveredMeters =
        stranded - placeOnSeeds(index, spans, bounds, anchorPoint, stranded);
    }
  } else if (target > frontageMeters) {
    growSpans(index, spans, primary, target - frontageMeters, context, null);
  }

  const placed: ShedSpan[] = [];
  for (const [edge, arc] of spans) {
    const rawLength = lengthOf(index, edge);
    if (rawLength <= 0) {
      continue;
    }
    const meters = ((arc.high - arc.low) / rawLength) * graph.edgeLength[edge];
    if (meters < MIN_SPAN_METERS) {
      continue;
    }
    placed.push({
      edge,
      t0: Math.max(0, arc.low / rawLength),
      t1: Math.min(1, arc.high / rawLength),
      meters,
      depthMeters: deckDepth(shadows.get(edge)),
    });
  }
  placed.sort((left, right) => right.meters - left.meters);
  result.measuredDepths = fillDepths(placed);
  result.spans = placed;
  result.coveredMeters = placed.reduce((total, span) => total + span.meters, 0);
  result.offStreetMeters = placed
    .filter((span) => !onStreet(index, context, span.edge))
    .reduce((total, span) => total + span.meters, 0);
  result.offLotMeters = Math.min(context.charged, result.offStreetMeters);
  result.unplacedMeters = Number.isFinite(result.shedMeters)
    ? Math.max(0, result.shedMeters - result.coveredMeters)
    : 0;

  result.primaryEdge = primary;
  result.primaryDistance = ringToPolyline(frontage, lineOf(index, primary));
  const opposite = oppositeSidewalk(index, primary, candidates);
  result.oppositeEdge = opposite;
  if (opposite !== null) {
    result.oppositeDistance = ringToPolyline(frontage, lineOf(index, opposite));
  }
  result.confidence = confidenceOf(result);
  return result;
}

// How much of this placement the routing cost model should believe, in [0, 1]. Six independent ways
// it can be wrong, multiplied: the street may be the wrong one, the side of it may be the wrong one,
// the length may be invented rather than measured, on a lot far longer than the permit the length is
// measured but its position along the lot line is a guess, part of the run may have been placed
// around a corner off the permit's street, and part may sit on a piece of the lot's frontage the run
// could not reach on foot.
export function confidenceOf(result: ShedPlacement): number {
  if (result.spans.length === 0) {
    return 0;
  }
  const street = result.nameScore >= 0.99 ? 1 : result.nameMatched ? 0.8 : 0.35;
  const margin = result.oppositeDistance - result.primaryDistance;
  const gap = Number.isFinite(margin) ? margin : result.sideMargin;
  const side = Number.isFinite(gap)
    ? Math.min(1, Math.max(0.15, gap / 8))
    : 0.5;
  const measured =
    !Number.isFinite(result.shedMeters) ||
    result.shedMeters <= result.frontageMeters
      ? 1
      : result.frontageMeters / result.shedMeters;
  // A permit covering half its lot's frontage or more can only sit roughly where we put it; one
  // covering a fifth of a superblock's perimeter could be anywhere along it.
  const fill =
    !Number.isFinite(result.shedMeters) || result.frontageMeters <= 0.5
      ? 1
      : result.shedMeters / result.frontageMeters;
  const placed = fill >= 0.5 ? 1 : Math.min(1, Math.max(0.4, 2 * fill));
  const source = result.geometrySource === "lot" ? 1 : 0.9;
  const share = (meters: number): number =>
    Math.min(1, Math.max(0, meters / result.coveredMeters));
  // A corner wrap the lot actually fronts is discounted mildly; coverage the walk had no licence for
  // at all is discounted hard. Recovered length is on the permit's own street and its own lot, so it
  // is the mildest of the three — but the run could not join the two pieces on foot, so which piece
  // the structure occupies is inferred rather than traced.
  const onLicence =
    result.coveredMeters <= 0
      ? 1
      : 1 -
        0.25 * (share(result.offStreetMeters) - share(result.offLotMeters)) -
        0.6 * share(result.offLotMeters);
  const contiguity =
    result.coveredMeters <= 0 ? 1 : 1 - 0.15 * share(result.recoveredMeters);
  const product =
    street *
    side *
    (0.35 + 0.65 * measured) *
    placed *
    source *
    onLicence *
    contiguity;
  return Math.round(product * 1000) / 1000;
}

// Extend the shed along the sidewalk network from both ends of the run; returns the leftover.
//
// Half the length goes each way, so a shed sits centred on the building it belongs to rather than
// hanging off one end of it. A run that hits the end of the block on one side then spends what is
// left on the other, which is why the two directions are walked twice each.
function growSpans(
  index: SidewalkIndex,
  spans: Map<number, Arc>,
  primary: number,
  extra: number,
  context: WrapContext,
  bounds: Map<number, Arc> | null,
): number {
  const shares = [extra / 2, extra / 2, 0, 0];
  let leftover = 0;
  for (let pass = 0; pass < shares.length; pass++) {
    const budget = leftover + shares[pass];
    if (budget <= 0.5) {
      break;
    }
    leftover = walk(
      index,
      spans,
      primary,
      pass % 2 === 0 ? -1 : 1,
      budget,
      bounds,
      context,
    );
  }
  return leftover;
}

// Spend `budget` metres running one way from `primary`; returns what could not be spent.
function walk(
  index: SidewalkIndex,
  spans: Map<number, Arc>,
  primary: number,
  startDirection: number,
  budget: number,
  bounds: Map<number, Arc> | null,
  context: WrapContext,
): number {
  const { graph } = index;
  let edge = primary;
  let direction = startDirection;
  let remaining = budget;
  let turned = 0;
  const visited = new Set([primary]);
  while (remaining > 0.5) {
    remaining = spend(
      index,
      spans,
      edge,
      direction,
      remaining,
      bounds,
      context,
    );
    if (remaining <= 0.5) {
      break;
    }
    if (
      bounds === null &&
      context.budget <= 0.5 &&
      !onStreet(index, context, edge)
    ) {
      // Anything further along is reached only by paying for more of this edge, and the off-street
      // budget is gone. Leaving the length unplaced beats guessing.
      break;
    }
    const node = direction < 0 ? graph.edgeNodeA[edge] : graph.edgeNodeB[edge];
    const following = nextSidewalk(index, edge, node, visited, context);
    if (following === null) {
      break;
    }
    // A shed is a single structure fronting one property; a wrap that has swung this far off the
    // permit's street is tracing the network, not the shed.
    if (
      following.turn > MAX_JUNCTION_TURN_DEGREES ||
      turned + following.turn > MAX_WRAP_TURN_DEGREES
    ) {
      break;
    }
    turned += following.turn;
    edge = following.edge;
    visited.add(edge);
    if (!spans.has(edge)) {
      const entry = following.atA ? 0 : lengthOf(index, edge);
      // The walk arrives at the graph node, which is not where this edge's frontage arc starts.
      // Filling from the node would cover the pavement in between, so a bounded run enters at the
      // near end of the arc instead.
      const arc = bounds?.get(edge);
      const clamped = arc
        ? Math.min(Math.max(entry, arc.low), arc.high)
        : entry;
      spans.set(edge, { low: clamped, high: clamped });
    }
    direction = following.atA ? 1 : -1;
  }
  return remaining;
}

// Push one end of this edge's span outward, free inside the shed's licence, then on budget.
function spend(
  index: SidewalkIndex,
  spans: Map<number, Arc>,
  edge: number,
  direction: number,
  remaining: number,
  bounds: Map<number, Arc> | null,
  context: WrapContext,
): number {
  const arc = spans.get(edge) as Arc;
  const limit = bounds === null ? null : bounds.get(edge);
  if (bounds !== null && limit === undefined) {
    // Confined to the measured frontage: this edge is not part of it, so it is only the way through
    // to the next piece of frontage and takes none of the length.
    return remaining;
  }
  const limitLow = limit ? limit.low : 0;
  const limitHigh = limit ? limit.high : lengthOf(index, edge);
  let freeLow = limitLow;
  let freeHigh = limitHigh;
  if (!onStreet(index, context, edge)) {
    // Off the permit's street the free run is only the lot's own frontage arc on this edge — the
    // side lot line of a corner property — never the whole block face.
    const lotArc = context.lotArcs.get(edge) ?? {
      low: arc.low,
      high: arc.high,
    };
    freeLow = Math.max(
      limitLow,
      Math.min(lotArc.low - LOT_ARC_SLACK_METERS, arc.low),
    );
    freeHigh = Math.min(
      limitHigh,
      Math.max(lotArc.high + LOT_ARC_SLACK_METERS, arc.high),
    );
  }

  let left = remaining;
  if (direction < 0) {
    const step = Math.min(Math.max(0, arc.low - freeLow), left);
    arc.low -= step;
    left -= step;
  } else {
    const step = Math.min(Math.max(0, freeHigh - arc.high), left);
    arc.high += step;
    left -= step;
  }
  if (left <= 0.5 || onStreet(index, context, edge)) {
    return left;
  }

  let charged = Math.min(left, context.budget);
  if (direction < 0) {
    charged = Math.min(charged, Math.max(0, arc.low - limitLow));
    arc.low -= charged;
  } else {
    charged = Math.min(charged, Math.max(0, limitHigh - arc.high));
    arc.high += charged;
  }
  context.budget -= charged;
  context.charged += charged;
  return left - charged;
}

// The sidewalk continuing at `node`: its id, whether it leaves from its a-end, and the turn. Any
// usable continuation along the permit's own street beats the straightest turn off it, because a
// shed that runs past the property is still a shed along that street.
function nextSidewalk(
  index: SidewalkIndex,
  edge: number,
  node: number,
  visited: ReadonlySet<number>,
  context: WrapContext,
): { edge: number; atA: boolean; turn: number } | null {
  const { graph } = index;
  const coords = lineOf(index, edge);
  const last = coords.length;
  const arrivingX =
    graph.edgeNodeB[edge] === node
      ? coords[last - 2] - coords[last - 4]
      : coords[0] - coords[2];
  const arrivingY =
    graph.edgeNodeB[edge] === node
      ? coords[last - 1] - coords[last - 3]
      : coords[1] - coords[3];
  const arrivingScale = 1 / Math.max(Math.hypot(arrivingX, arrivingY), 1e-9);

  let bestSame: { edge: number; atA: boolean; turn: number } | null = null;
  let bestSameAlignment = Number.NEGATIVE_INFINITY;
  let bestAny: { edge: number; atA: boolean; turn: number } | null = null;
  let bestAnyAlignment = Number.NEGATIVE_INFINITY;
  for (const other of index.nodeSidewalks.get(node) ?? []) {
    if (other === edge || visited.has(other)) {
      continue;
    }
    const line = lineOf(index, other);
    const atA = graph.edgeNodeA[other] === node;
    const leavingX = atA
      ? line[2] - line[0]
      : line[line.length - 4] - line[line.length - 2];
    const leavingY = atA
      ? line[3] - line[1]
      : line[line.length - 3] - line[line.length - 1];
    const leavingScale = 1 / Math.max(Math.hypot(leavingX, leavingY), 1e-9);
    const alignment = Math.min(
      1,
      Math.max(
        -1,
        (arrivingX * leavingX + arrivingY * leavingY) *
          arrivingScale *
          leavingScale,
      ),
    );
    const turn = (Math.acos(alignment) * 180) / Math.PI;
    if (alignment > bestAnyAlignment) {
      bestAnyAlignment = alignment;
      bestAny = { edge: other, atA, turn };
    }
    if (
      alignment > bestSameAlignment &&
      turn <= MAX_JUNCTION_TURN_DEGREES &&
      onStreet(index, context, other)
    ) {
      bestSameAlignment = alignment;
      bestSame = { edge: other, atA, turn };
    }
  }
  return bestSame ?? bestAny;
}

// Spill a stranded run onto the lot's own unused frontage; returns what still cannot be placed.
//
// A confined walk gives up when it runs out of turning budget crossing an intersection, which
// strands the rest of the permit even though the same lot has measured frontage on the far side of
// that corner. That frontage is the best available evidence about where the structure is, so it is
// used before any length is abandoned — nearest the anchor first, a shed being one structure around
// the building being worked on.
function placeOnSeeds(
  index: SidewalkIndex,
  spans: Map<number, Arc>,
  bounds: Map<number, Arc>,
  anchor: { x: number; y: number },
  stranded: number,
): number {
  const distanceToArc = (edge: number, arc: Arc): number => {
    const coords = lineOf(index, edge);
    const steps = Math.max(
      2,
      Math.floor((arc.high - arc.low) / ARC_SAMPLE_STEP_METERS) + 1,
    );
    let best = Number.POSITIVE_INFINITY;
    for (let step = 0; step < steps; step++) {
      const at = pointAt(
        coords,
        arc.low + ((arc.high - arc.low) * step) / (steps - 1),
      );
      best = Math.min(best, Math.hypot(at.x - anchor.x, at.y - anchor.y));
    }
    return best;
  };
  const order = [...bounds]
    .map(([edge, arc]) => ({ edge, arc, distance: distanceToArc(edge, arc) }))
    .sort((left, right) => left.distance - right.distance);

  let remaining = stranded;
  for (const { edge, arc } of order) {
    if (remaining <= MIN_SPAN_METERS) {
      break;
    }
    if (arc.high - arc.low <= MIN_SPAN_METERS) {
      continue;
    }
    const existing = spans.get(edge);
    if (
      existing === undefined ||
      existing.high - existing.low < MIN_SPAN_METERS
    ) {
      // Untouched frontage: centre the new run on the point of it nearest the anchor, so a spill
      // lands at the near end of the arc rather than in the middle of the block.
      const width = Math.min(remaining, arc.high - arc.low);
      const projection = projectToPolyline(
        lineOf(index, edge),
        anchor.x,
        anchor.y,
        newProjection(),
      );
      const centre = Math.min(
        Math.max(projection.along, arc.low + width / 2),
        arc.high - width / 2,
      );
      spans.set(edge, { low: centre - width / 2, high: centre + width / 2 });
      remaining -= width;
    } else {
      const before = Math.min(Math.max(0, existing.low - arc.low), remaining);
      existing.low -= before;
      remaining -= before;
      const after = Math.min(Math.max(0, arc.high - existing.high), remaining);
      existing.high += after;
      remaining -= after;
    }
  }
  return remaining;
}
