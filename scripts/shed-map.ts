// Placing a DOB sidewalk-shed permit on the sidewalk edges it actually stands over.
//
// A shed is one continuous structure on the pavement at a property line, so the tax lot is both the
// geometry it runs along and the whole of what it may cover: the stretch of lot boundary facing a
// sidewalk that carries the permit's street name is the measured frontage, a corner lot's second
// frontage is its own too, and a permit longer than everything its lot fronts has the overrun
// DROPPED. DESIGN.md, "Where a shed actually stands", is why, and what the rule cost when it was
// measured against the alternative.
//
// Every constant here was chosen by measuring the whole feed against it — do not tune them by eye.
// Three are load-bearing in ways that do not look it: the side band, which is what tells a lot's own
// pavement from the pavement across the road, the preference for continuing along the permit's own
// street over taking a straighter turn off it, and the recovery pass that spends a stranded run on
// the lot's own unreached frontage.

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
// How far along a sidewalk one step of boundary may move and still be the same frontage. Twice the
// sample step, so ordinary boundary always continues and a projection pinned to the end of a
// polyline never does.
const FRONTAGE_STEP_METERS = 2 * RING_STEP_METERS;
const NORMAL_WINDOW = 3;
const NAME_MATCH_THRESHOLD = 0.6;
// A span shorter than this on one edge is projection noise, not coverage.
const MIN_SPAN_METERS = 2;
// Only the boundary plane nearest a sidewalk is its frontage; a deep lot's side lines are still
// "facing" at a glancing angle and would stretch the span down the block.
const FRONTAGE_DEPTH_METERS = 8;
// A same-name sidewalk further out than this behind the near one is the opposite side of the street.
const SIDE_BAND_METERS = 7;
// A shed describes one street and, on a corner lot, the one it turns onto. One corner costs ~90
// degrees, so this allows a corner and a little drift but not a lap of a cul-de-sac. What a run may
// COVER is the lot's frontage and only that; this stops the walk tracing the network looking for it.
const MAX_WRAP_TURN_DEGREES = 150;
// A single junction that doubles back this far is a dead end or a service loop, not a continuation.
const MAX_JUNCTION_TURN_DEGREES = 100;
// Step for ordering unused pieces of frontage by how near the anchor they are. Coarse on purpose:
// it only has to order the arcs, not measure them.
const ARC_SAMPLE_STEP_METERS = 5;
const GRID_CELL_METERS = 150;
// Cell coordinates never reach this, so packing two of them into one key never collides.
const CELL_KEY_OFFSET = 1 << 20;
const CELL_KEY_STRIDE = 1 << 21;

// How deep the deck is: the pavement's own width less a margin at the kerb, since no dataset New York
// publishes carries a sidewalk width. The kerb comes out of the graph's offset byte and the building
// line off the tax lot the frontage is already measured against, so the width is the lot line's
// signed offset from the baked polyline plus the inset. DESIGN.md, "Where a shed actually stands",
// for why those two lines and what the measurement is worth.
const SIDEWALK_INSET_METERS = 2; // the manifest's streets.sidewalkInsetMeters, kerb to the baked line
// A shed's deck stops short of the kerb rather than overhanging the gutter — DOB wants the roadway
// clear, and a foot is what the drawings leave.
const KERB_MARGIN_METERS = 0.3;
// The lot's street wall runs parallel to the pavement, so its samples sit at one distance and the
// side lot lines running back off it climb away. Only samples this near the closest one are the
// street wall.
const STREET_WALL_BAND_METERS = 2;
// What the measurement is clamped into; DESIGN.md, "Where a shed actually stands", for the
// distribution it was read off and why the tail is clamped rather than discarded. The floor is the
// encoding's own — a depth rounds to decimetres and 0 decimetres is the byte meaning "not measured" —
// so what CANNOT be built is floored by the reader instead (MIN_DECK_DEPTH_METERS in
// src/routing/sheds.ts), the only side that knows where the kerb was put.
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
  offStreetMeters: number; // coverage on the lot's frontage on a street the permit does not name
  unplacedMeters: number; // claimed length the lot has no frontage left to hold
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

// The permit's street, for the walk's preference for staying on it. Where the walk may SPEND is not
// here: that is the lot's own frontage and nothing else, which the walk carries as its bounds.
interface WrapContext {
  street: string;
  scores: Map<number, number>; // memoized across the walk
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

// The stretch of one sidewalk a lot stands behind: the along-interval its boundary SWEEPS out from
// the lot's closest approach to that sidewalk, walked sample by sample and stopped where the
// boundary leaves. Not the interval from the first facing sample to the last, which is a different
// thing wherever a lot reaches the same pavement twice — an arcade arm beside a neighbour's
// building, a U around a rear yard, a corner lot whose second arm projects onto the far end of the
// same edge — because the pavement in between is somebody else's and a min-to-max span takes it.
// Null when no sample is kept at all.
function frontageArc(
  alongs: Float64Array,
  distances: Float64Array,
  keep: (sample: number) => boolean,
): Arc | null {
  const count = alongs.length;
  let anchor = -1;
  for (let sample = 0; sample < count; sample++) {
    if (keep(sample) && (anchor < 0 || distances[sample] < distances[anchor])) {
      anchor = sample;
    }
  }
  if (anchor < 0) {
    return null;
  }
  const arc: Arc = { low: alongs[anchor], high: alongs[anchor] };
  // The samples are a closed ring, so the boundary runs out of the closest approach both ways and
  // wraps at its ends.
  for (const step of [-1, 1]) {
    for (let taken = 1; taken < count; taken++) {
      const sample = (anchor + step * taken + 2 * count) % count;
      const along = alongs[sample];
      // Boundary running along this pavement moves a sample step at a time, so a jump means the
      // boundary is somewhere else — and it is a JUMP rather than a gap in the samples because a
      // projection past either end of the polyline pins to that end however far past it the lot goes.
      if (
        !keep(sample) ||
        along < arc.low - FRONTAGE_STEP_METERS ||
        along > arc.high + FRONTAGE_STEP_METERS
      ) {
        break;
      }
      arc.low = Math.min(arc.low, along);
      arc.high = Math.max(arc.high, along);
    }
  }
  return arc;
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
    let walls = 0;
    for (let sample = 0; sample < alongs.length; sample++) {
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
    const arc =
      frontageArc(
        alongs,
        distances,
        (sample) =>
          distances[sample] <= depth && facings[sample] >= FACING_COSINE,
      ) ??
      // Nothing here reads as a wall facing this pavement, which is what a baked polyline landing
      // inside the lot does; the boundary near enough to be frontage is then all there is to go on.
      (frontageArc(
        alongs,
        distances,
        (sample) => distances[sample] <= depth,
      ) as Arc);
    // The median rather than the nearest sample: a stoop, a bay or a quantized corner reaches a
    // metre past the wall, and a shed follows the wall.
    shadows.set(edge, {
      low: arc.low,
      high: arc.high,
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

// Where a shed sits on its measured frontage: the point of that frontage nearest the building,
// named by the sidewalk edge carrying it and how far along that edge it falls.
//
// The frontage ARCS are ranked, not the edges: the nearest point of the pavement is the same place
// whichever edge happens to be holding it, and a rebuild re-cuts one kerb into different edges. See
// DESIGN.md, "Where a shed actually stands", for what ranking edges did instead.
interface Seat {
  edge: number;
  along: number;
}
function seatOf(
  index: SidewalkIndex,
  seeds: ReadonlyMap<number, Arc>,
  anchorX: number,
  anchorY: number,
): Seat {
  const projection: LineProjection = newProjection();
  const seats = [...seeds].map(([edge, arc]) => {
    const coords = lineOf(index, edge);
    projectToPolyline(coords, anchorX, anchorY, projection);
    const along = Math.min(Math.max(projection.along, arc.low), arc.high);
    const at = pointAt(coords, along);
    const middle = pointAt(coords, (arc.low + arc.high) / 2);
    return {
      edge,
      along,
      distance: Math.hypot(at.x - anchorX, at.y - anchorY),
      width: arc.high - arc.low,
      middle,
    };
  });
  // An arc pinched to nothing is the lot clipping the end of a stub edge, which leaves the run
  // nowhere to grow, so any piece of frontage with room in it wins however much further off it is.
  // The last two keys settle an exact tie — the anchor landing on the node two edges of the same
  // pavement share — on the arcs' own geometry rather than on edge ids, which are positional.
  seats.sort(
    (left, right) =>
      Number(right.width >= MIN_SPAN_METERS) -
        Number(left.width >= MIN_SPAN_METERS) ||
      left.distance - right.distance ||
      right.width - left.width ||
      left.middle.x - right.middle.x ||
      left.middle.y - right.middle.y,
  );
  return seats[0];
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
  for (const [edge, arc] of seeds) {
    spans.set(edge, { low: arc.low, high: arc.high });
    frontageMeters += arc.high - arc.low;
  }
  // Where on that frontage the structure sits: the point of it nearest the building being worked on,
  // or nearest the middle of the lot when the feed names no building.
  const centre = ringCentroid(footprint ?? frontage);
  const seat = seatOf(index, seeds, centre.x, centre.y);
  const primary = seat.edge;
  result.frontageMeters = frontageMeters;
  result.nameScore = scores.get(primary) ?? 0;

  // When nothing carried the permit's name the fallback edge's own street stands in for it, so the
  // walk still has a street to follow rather than treating every step as a guess.
  const context: WrapContext = {
    street: result.nameMatched
      ? request.street
      : (edgeName(graph, primary) ?? request.street),
    scores: result.nameMatched ? scores : new Map(),
  };
  // Every piece of pavement the lot's own boundary stands behind: its frontage on the permit's
  // street, and on a corner property the street it turns onto. This is the whole of what the shed
  // may cover.
  //
  // The band that tells the permit's street from the pavement across it does the work on the other
  // streets too, measured from the same place — a lot stands as near its side street wall as its
  // front one, and the pavement over a road is a whole roadway further off. DESIGN.md, "Where a shed
  // actually stands", has the two populations it separates.
  const lotArcs = new Map<number, Arc>();
  for (const [edge, shadow] of shadows) {
    if (
      shadow.distance <= nearest + SIDE_BAND_METERS &&
      shadow.high - shadow.low >= MIN_SPAN_METERS
    ) {
      lotArcs.set(edge, { low: shadow.low, high: shadow.high });
    }
  }

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
    spans.clear();
    spans.set(primary, { low: seat.along, high: seat.along });
    const stranded = growSpans(index, spans, primary, target, context, bounds);
    if (stranded > MIN_SPAN_METERS) {
      const anchorPoint = pointAt(lineOf(index, primary), seat.along);
      result.recoveredMeters =
        stranded - placeOnSeeds(index, spans, bounds, anchorPoint, stranded);
    }
  } else if (target > frontageMeters) {
    // The overrun goes on the rest of the lot's own frontage and nowhere else, walked round the
    // property's own corner where the pavement is joined and spilled onto it where it is not — the
    // network dead-ends pavement at every kerb, so a corner a shed genuinely turns is often no step
    // at all. Whatever will not fit on the lot is dropped; DESIGN.md, "Where a shed actually stands".
    const stranded = growSpans(
      index,
      spans,
      primary,
      target - frontageMeters,
      context,
      lotArcs,
    );
    if (stranded > MIN_SPAN_METERS) {
      const anchorPoint = pointAt(lineOf(index, primary), seat.along);
      result.recoveredMeters =
        stranded - placeOnSeeds(index, spans, lotArcs, anchorPoint, stranded);
    }
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
// the permit may claim more length than its lot has frontage to hold — which says the geocode or
// the declaration is wrong, whichever way the excess was dropped — on a lot far longer than the
// permit the position along the lot line is a guess, part of the run may have been placed around
// the lot's own corner onto a street the permit does not name, and part may sit on a piece of the
// lot's frontage the run could not reach on foot.
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
  // A wrap onto the lot's frontage on another street is discounted mildly: it is the lot's own
  // ground, but which of its two street walls the structure is against is inferred from the length
  // alone. Recovered length is milder still, being on the permit's own street and its own lot — but
  // the run could not join the two pieces on foot, so which piece it occupies is inferred too.
  const onLicence =
    result.coveredMeters <= 0 ? 1 : 1 - 0.25 * share(result.offStreetMeters);
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
  bounds: ReadonlyMap<number, Arc>,
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
  bounds: ReadonlyMap<number, Arc>,
  context: WrapContext,
): number {
  const { graph } = index;
  let edge = primary;
  let direction = startDirection;
  let remaining = budget;
  let turned = 0;
  const visited = new Set([primary]);
  while (remaining > 0.5) {
    remaining = spend(spans, edge, direction, remaining, bounds);
    if (remaining <= 0.5) {
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
      const arc = bounds.get(edge);
      const clamped = arc
        ? Math.min(Math.max(entry, arc.low), arc.high)
        : entry;
      spans.set(edge, { low: clamped, high: clamped });
    }
    direction = following.atA ? 1 : -1;
  }
  return remaining;
}

// Push one end of this edge's span outward, as far as the lot's own frontage on it reaches.
function spend(
  spans: Map<number, Arc>,
  edge: number,
  direction: number,
  remaining: number,
  bounds: ReadonlyMap<number, Arc>,
): number {
  const limit = bounds.get(edge);
  if (limit === undefined) {
    // No frontage of this lot behind this pavement, so it is only the way through to the next piece
    // of frontage and takes none of the length.
    return remaining;
  }
  const arc = spans.get(edge) as Arc;
  if (direction < 0) {
    const step = Math.min(Math.max(0, arc.low - limit.low), remaining);
    arc.low -= step;
    return remaining - step;
  } else {
    const step = Math.min(Math.max(0, limit.high - arc.high), remaining);
    arc.high += step;
    return remaining - step;
  }
}

// The sidewalk continuing at `node`: its id, whether it leaves from its a-end, and the turn. Only a
// sidewalk MEETING this one at the node qualifies, and a continuation along the permit's own street
// beats the straightest turn off it, because a run along the lot's own street wall is still a run
// along that street.
//
// A step over one crossing or link, onto a sidewalk of the same street and the same side, was built
// and measured before this. A block face's pavement stops at every kerb in this network — 152,629
// sidewalk ends have no other sidewalk on them, against 54 in the derived network it replaced — so
// a walk that only steps sidewalk to sidewalk stops dead at the first corner, and the step across
// lifted placed length on corner lots from 86.33% of claimed to 95.28%. It is REJECTED all the
// same: what it stepped onto was the next block, over a side street's roadway, in front of
// buildings whose permit this is not. Scaffolding stands on the lot it was pulled for, so the
// length it used to find is dropped instead. The same measurement says the lot's own frontage is a
// single walkable piece for 98.40% of lots, so those kerbs almost never cut one lot's frontage in
// two; where they do, the recovery pass spends the stranded run on the piece the walk cannot reach.
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
  // Two pieces of one lot's frontage are equally near the anchor whenever it sits on the node they
  // share, so the order falls back on where the arcs are rather than on their edge ids.
  const order = [...bounds]
    .map(([edge, arc]) => ({
      edge,
      arc,
      distance: distanceToArc(edge, arc),
      middle: pointAt(lineOf(index, edge), (arc.low + arc.high) / 2),
    }))
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.middle.x - right.middle.x ||
        left.middle.y - right.middle.y,
    );

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
