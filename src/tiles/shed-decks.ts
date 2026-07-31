import {
  edgeGeometryRight,
  type RoutingGraph,
  subEdgePath,
} from "../routing/graph";
import {
  deckDepth,
  measuredDepth,
  type Shed,
  type ShedHistory,
  shedsOn,
} from "../routing/sheds";
import manifest from "../tree-cover/manifest.json";
import { projectX, projectY } from "./mercator";
import type { PolygonSink } from "./sweep";

// One day's sidewalk-shed decks, as both the display overlay (components/shed-layer.tsx) and the
// shade sweep (src/tiles/sweep.ts) read them, so a band and the shadow leaving it cannot disagree.
// A deck is one continuous run of a shed — the SHED artifact's spans chained back into the polyline
// they wrap, so a corner is a bend in one deck rather than two decks meeting — and it is carried as
// the POLYGON it covers rather than as a line to be stroked to a width.
//
// A stroke has one width for the whole path, so a chain had to break wherever the measured depth
// changed — which is exactly a shed turning off an avenue onto a side street, the one place a corner
// most needs mitring rather than leaving as two bands meeting. The ring states its own width per
// segment instead, and a corner is where the two edges' offset lines cross.
//
// The band is not centred on the sidewalk's baked polyline either. A shed stands against the building
// it is up for and runs out to just short of the kerb, so the two edges are pinned to those two
// lines: the graph puts the kerb a fixed `sidewalkInsetMeters` inboard of its polyline, the deck
// stops a hand's breadth short of it, and the artifact's measured depth carries the other edge to the
// building. On a wide Midtown pavement that is two metres of band outside the polyline, which is
// exactly the gap of sunlight a centred band used to leave between a shed and its building.
//
// The vertices land as ZOOM-0 world pixels, the same space the caster chunks decode into: Mercator is
// the same projection at every zoom up to a factor of 2^z, so projecting once here turns a tile's
// draw into a multiply and a subtract, and — since it is conformal — a translation down the shadow
// into a constant pixel offset.
//
// Which sheds are standing depends on the picked DATE, so unlike buildings and crowns this geometry
// is rebuilt whenever the date moves. It takes ~10 ms for a day's ~13k spans, which is why the two
// readers just build their own rather than sharing one through a cache.

const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;
const TILE_SIZE = 256;

const [city] = manifest.cities;
const CENTRE_LAT = (city.bounds.north + city.bounds.south) / 2;
// Kerb to the baked sidewalk line, the offset `tiler graph` bakes the sidewalks at.
const SIDEWALK_INSET_METERS = city.streets.sidewalkInsetMeters;
// What the deck stops short of the kerb by, as scripts/shed-map.ts measured the depth with.
const KERB_MARGIN_METERS = 0.3;

// A day's decks, flattened so a draw walks typed arrays rather than objects. Deck `d`'s ring runs
// `points[2 * rings[d]]` up to `2 * rings[d + 1]`, closed by the reader.
//
// Every ring is a STRIP of an even number of vertices, the building edge out and the kerb edge back,
// so vertex `i` and its mirror `from + to - 1 - i` are the pair straddling one point of the run. That
// pairing is what lets `traceDeck` open a band out to a minimum width without carrying a centreline
// or a depth alongside. Every ring is wound positively, for the nonzero fill that draws it.
export interface ShedDecks {
  points: Float64Array; // x/y interleaved, zoom-0 world pixels
  rings: Uint32Array; // one entry per deck plus the end
  boxes: Float64Array; // per deck, its ring's own box: minX, minY, maxX, maxY
  grid: DeckGrid;
}

// A uniform grid over the deck boxes, so a tile tests the decks near it rather than all ~13k of them.
// The casters get this for free — they are chunked per z15 tile at BUILD time — but which sheds are
// standing depends on the picked date, so the decks are bucketed here instead, once per day change.
//
// Same shape as the snap index in src/routing/snap.ts, except dense: the decks' own extent is known by
// the time this is built, so the cells are one CSR array rather than a hash of the populated ones.
export interface DeckGrid {
  cellSize: number; // zoom-0 world pixels per cell
  originX: number; // the world position column 0 starts at, so a cell coordinate is never negative
  originY: number;
  columns: number;
  rows: number;
  starts: Uint32Array; // columns * rows + 1 offsets into `decks`
  decks: Uint32Array; // deck ids grouped by cell; a deck sits in every cell its box touches
}

// Web Mercator's ground resolution at the city's latitude, which is what turns the deck's metres
// into the pixels it is drawn at.
export function pixelsPerMeter(zoom: number): number {
  const cosLat = Math.cos((CENTRE_LAT * Math.PI) / 180);
  return (TILE_SIZE * 2 ** zoom) / (EARTH_CIRCUMFERENCE_METERS * cosLat);
}

// A cell a few blocks across: at a day's ~13k decks that is a handful per cell, and a z15 tile — the
// shallowest zoom the client sweeps shadows at — covers two or three of them.
const TARGET_CELL_METERS = 500;

const EMPTY_GRID: DeckGrid = {
  cellSize: 1,
  originX: 0,
  originY: 0,
  columns: 0,
  rows: 0,
  starts: Uint32Array.of(0),
  decks: new Uint32Array(0),
};

// No decks at all, which is what a reader holds until a day's set arrives.
export const NO_DECKS: ShedDecks = {
  points: new Float64Array(0),
  rings: Uint32Array.of(0),
  boxes: new Float64Array(0),
  grid: EMPTY_GRID,
};

// Bucket the boxes: one counting pass for the cell offsets, one to fill them.
function buildGrid(boxes: Float64Array): DeckGrid {
  const count = boxes.length / 4;
  if (count === 0) {
    return EMPTY_GRID;
  }
  const cellSize = TARGET_CELL_METERS * pixelsPerMeter(0);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let deck = 0; deck < count; deck++) {
    minX = Math.min(minX, boxes[deck * 4]);
    minY = Math.min(minY, boxes[deck * 4 + 1]);
    maxX = Math.max(maxX, boxes[deck * 4 + 2]);
    maxY = Math.max(maxY, boxes[deck * 4 + 3]);
  }
  const originX = Math.floor(minX / cellSize) * cellSize;
  const originY = Math.floor(minY / cellSize) * cellSize;
  const columns = Math.floor((maxX - originX) / cellSize) + 1;
  const rows = Math.floor((maxY - originY) / cellSize) + 1;

  const starts = new Uint32Array(columns * rows + 1);
  for (let deck = 0; deck < count; deck++) {
    const fromX = Math.floor((boxes[deck * 4] - originX) / cellSize);
    const fromY = Math.floor((boxes[deck * 4 + 1] - originY) / cellSize);
    const toX = Math.floor((boxes[deck * 4 + 2] - originX) / cellSize);
    const toY = Math.floor((boxes[deck * 4 + 3] - originY) / cellSize);
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        starts[cellY * columns + cellX + 1] += 1;
      }
    }
  }
  for (let cell = 0; cell < columns * rows; cell++) {
    starts[cell + 1] += starts[cell];
  }

  const decks = new Uint32Array(starts[columns * rows]);
  const cursors = starts.slice(0, columns * rows);
  for (let deck = 0; deck < count; deck++) {
    const fromX = Math.floor((boxes[deck * 4] - originX) / cellSize);
    const fromY = Math.floor((boxes[deck * 4 + 1] - originY) / cellSize);
    const toX = Math.floor((boxes[deck * 4 + 2] - originX) / cellSize);
    const toY = Math.floor((boxes[deck * 4 + 3] - originY) / cellSize);
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        const cell = cellY * columns + cellX;
        decks[cursors[cell]] = deck;
        cursors[cell] += 1;
      }
    }
  }
  return { cellSize, originX, originY, columns, rows, starts, decks };
}

// A day's flattened decks with their grid over them, which is the only way a `ShedDecks` is made.
export function packDecks(
  points: Float64Array,
  rings: Uint32Array,
  boxes: Float64Array,
): ShedDecks {
  return { points, rings, boxes, grid: buildGrid(boxes) };
}

// The rings of a set of runs, flattened with the boxes and the grid over them. The box is the ring's
// own — the width is already in it — so a reader only has to widen a window by what it opens a band
// out by, rather than by the deepest deck there could be.
export function packRuns(runs: readonly DeckRun[]): ShedDecks {
  const points: number[] = [];
  const rings: number[] = [0];
  const boxes: number[] = [];
  for (const run of runs) {
    const ring = deckRing(run);
    if (ring.length === 0) {
      continue;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex * 2 < ring.length; vertex++) {
      const x = ring[vertex * 2];
      const y = ring[vertex * 2 + 1];
      points.push(x, y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    rings.push(points.length / 2);
    boxes.push(minX, minY, maxX, maxY);
  }
  return packDecks(
    new Float64Array(points),
    new Uint32Array(rings),
    new Float64Array(boxes),
  );
}

// Every deck whose box touches a window of zoom-0 world pixels, each handed over exactly once.
export function forEachDeckIn(
  { boxes, grid }: ShedDecks,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  visit: (deck: number) => void,
): void {
  const { cellSize, originX, originY, columns, rows, starts, decks } = grid;
  const fromX = Math.max(0, Math.floor((minX - originX) / cellSize));
  const fromY = Math.max(0, Math.floor((minY - originY) / cellSize));
  const toX = Math.min(columns - 1, Math.floor((maxX - originX) / cellSize));
  const toY = Math.min(rows - 1, Math.floor((maxY - originY) / cellSize));
  for (let cellY = fromY; cellY <= toY; cellY++) {
    for (let cellX = fromX; cellX <= toX; cellX++) {
      const cell = cellY * columns + cellX;
      for (let at = starts[cell]; at < starts[cell + 1]; at++) {
        const deck = decks[at];
        // A deck spanning several cells sits in all of them, so it is visited only from the first one
        // this window reaches — otherwise a window covering two of its cells would hand it over twice.
        const firstX = Math.max(
          fromX,
          Math.floor((boxes[deck * 4] - originX) / cellSize),
        );
        const firstY = Math.max(
          fromY,
          Math.floor((boxes[deck * 4 + 1] - originY) / cellSize),
        );
        if (cellX !== firstX || cellY !== firstY) {
          continue;
        }
        if (
          boxes[deck * 4 + 2] >= minX &&
          boxes[deck * 4] <= maxX &&
          boxes[deck * 4 + 3] >= minY &&
          boxes[deck * 4 + 1] <= maxY
        ) {
          visit(deck);
        }
      }
    }
  }
}

// One deck's run: the sidewalk polyline it stands over, in zoom-0 world pixels, and where the band's
// two edges sit across it. The offsets are per SEGMENT and signed along the segment's geometry-left
// normal, so a run carries a change of depth — and a change of which side of its street the sidewalk
// was baked to — without breaking. Closed where the wrap came back round to where it started, which
// rings as an annulus rather than as a band with the corner it closed on missing.
export interface DeckRun {
  xs: Float64Array;
  ys: Float64Array;
  building: Float64Array; // per segment, world pixels from the polyline to the building edge
  kerb: Float64Array; // per segment, ditto to the kerb edge
  closed: boolean;
}

// One span of a shed, projected once, plus the corner nodes its ends sit on. The wrap walk that placed
// a shed crossed the network's nodes, so a span running to the very end of its edge (t of exactly 0 or
// 1) meets the next span of the same shed there, on a coordinate both edges' polylines carry
// identically. An end that stops mid-edge is -1: nothing continues from it.
interface SpanPath {
  xs: Float64Array;
  ys: Float64Array;
  depth: number; // metres across the pavement, floored at what can be built
  wall: number; // metres from the baked line to the building edge, as measured
  right: boolean; // the sidewalk was baked to its street's geometry-right, so the building is too
  head: number; // the node the polyline starts at
  tail: number; // the node it ends at
}

// One step of a chain: a span and whether it is walked against its own direction.
interface Step {
  span: number;
  reversed: boolean;
}

// Where the band's BUILDING edge sits, in metres from the sidewalk's own baked line toward the
// building. The pipeline measured from the lot's street wall to a hand's breadth short of the kerb,
// and the graph puts that kerb one inset in from the line, so the measurement itself says where the
// wall is. The kerb edge is the deck's depth back from there — the FLOORED depth, so a shed measured
// narrower than one can be built keeps the wall it was measured from and reaches over the roadway.
function buildingEdgeMeters(depth: number): number {
  return measuredDepth(depth) + KERB_MARGIN_METERS - SIDEWALK_INSET_METERS;
}

function spanPaths(graph: RoutingGraph, shed: Shed): SpanPath[] {
  const paths: SpanPath[] = [];
  for (const { edge, t0, t1, depth } of shed.spans) {
    // A durable key this graph has no edge for decks nothing placeable, and a span pinched to nothing
    // decks no length — either would only sit in the way of the chaining below.
    if (edge < 0 || t1 <= t0) {
      continue;
    }
    const length = graph.edgeLength[edge];
    const { lngs, lats } = subEdgePath(graph, edge, t0 * length, t1 * length);
    const xs = new Float64Array(lngs.length);
    const ys = new Float64Array(lats.length);
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      xs[vertex] = projectX(lngs[vertex], 0);
      ys[vertex] = projectY(lats[vertex], 0);
    }
    paths.push({
      xs,
      ys,
      depth: deckDepth(depth),
      wall: buildingEdgeMeters(depth),
      // Away from the roadway is the side the sidewalk was baked to: a sidewalk polyline is its
      // centreline pushed to the geometry-LEFT unless the flag says right, and it keeps the
      // centreline's own direction, so the building is a quarter turn off the way the vertices run.
      right: edgeGeometryRight(graph, edge),
      head: t0 === 0 ? graph.edgeNodeA[edge] : -1,
      tail: t1 === 1 ? graph.edgeNodeB[edge] : -1,
    });
  }
  return paths;
}

// The span this one continues into through `node`, or null where that corner is not a clean pair —
// nothing else ends there, or three spans do, which is a fork with no single path through it. A
// corner onto a pavement of a different width IS a pair: the ring carries a width per segment, so a
// shed turning off an avenue onto a side street stays one deck that narrows at the corner.
function neighbour(
  ends: Map<number, number[]>,
  span: number,
  node: number,
): number | null {
  const meeting = ends.get(node);
  if (meeting?.length !== 2) {
    return null;
  } else {
    const other = meeting[0] === span ? meeting[1] : meeting[0];
    // A span whose two ends are the same node fills its own pair and continues into nothing.
    return other === span ? null : other;
  }
}

// One chain of spans and whether the walk came back round to the span it started from.
interface Chain {
  steps: Step[];
  closed: boolean;
}

// One shed's spans in the order they run, chained at the corners they share. The artifact stores them
// longest first rather than in walk order, and a wrap can come back round to where it started, so the
// chains are walked from each span both ways rather than read off. Spans of DIFFERENT sheds are never
// chained, however flush they abut: `ends` only ever holds the one shed's.
function chainSpans(paths: readonly SpanPath[]): Chain[] {
  const ends = new Map<number, number[]>();
  for (let span = 0; span < paths.length; span++) {
    for (const node of [paths[span].head, paths[span].tail]) {
      if (node >= 0) {
        const meeting = ends.get(node);
        if (meeting) {
          meeting.push(span);
        } else {
          ends.set(node, [span]);
        }
      }
    }
  }

  const taken = new Uint8Array(paths.length);
  // Follow the wrap out of `span` through `node`, taking every span it reaches. It stops at a corner
  // that is not a clean pair, at an end that stops mid-edge, and at a span already taken — which is
  // what closes a wrap that came back round on itself, and the only way `closed` comes back set,
  // since a chain takes every span it can reach and so can only run into its own.
  const follow = (span: number, node: number): Chain => {
    const steps: Step[] = [];
    let current = span;
    let exit = node;
    for (;;) {
      const next = neighbour(ends, current, exit);
      if (next === null) {
        return { steps, closed: false };
      } else if (taken[next] === 1) {
        return { steps, closed: true };
      }
      taken[next] = 1;
      const forward = paths[next].head === exit;
      steps.push({ span: next, reversed: !forward });
      exit = forward ? paths[next].tail : paths[next].head;
      current = next;
    }
  };

  const chains: Chain[] = [];
  for (let span = 0; span < paths.length; span++) {
    if (taken[span] === 1) {
      continue;
    }
    taken[span] = 1;
    // Walking out of the head runs backwards, so those steps are reversed and turned end for end
    // before the seed, and the walk out of the tail follows it.
    const before = follow(span, paths[span].head);
    const after = follow(span, paths[span].tail);
    chains.push({
      steps: [
        ...before.steps.reverse().map(({ span: step, reversed }) => ({
          span: step,
          reversed: !reversed,
        })),
        { span, reversed: false },
        ...after.steps,
      ],
      closed: before.closed || after.closed,
    });
  }
  return chains;
}

// One shed's decks: its spans projected and chained into the runs they form, each carrying the two
// offsets its band's edges sit at. A span is the edge's own baked polyline, which for a sidewalk runs
// corner to corner one half-offset out from the centreline (scripts/README.md); the offsets are what
// carry the band across the pavement to stand between the building line and the kerb.
export function shedRuns(graph: RoutingGraph, shed: Shed): DeckRun[] {
  const paths = spanPaths(graph, shed);
  const scale = pixelsPerMeter(0);
  const runs: DeckRun[] = [];
  for (const { steps, closed } of chainSpans(paths)) {
    // The corner is ONE vertex: the spans either side of it meet on the node's own coordinate, and
    // the two bands' edges are offset lines that meet where the deck really turns. A depth that
    // changes there changes the offset the building edge is at, not the vertex it turns on.
    const xs: number[] = [];
    const ys: number[] = [];
    const building: number[] = [];
    const kerb: number[] = [];
    for (const { span, reversed } of steps) {
      const path = paths[span];
      // Walking a span against its own direction turns its geometry-left round with it.
      const side = (path.right ? -1 : 1) * (reversed ? -1 : 1);
      for (let step = 0; step < path.xs.length; step++) {
        const vertex = reversed ? path.xs.length - 1 - step : step;
        if (step > 0 || xs.length === 0) {
          xs.push(path.xs[vertex]);
          ys.push(path.ys[vertex]);
        }
        if (step > 0) {
          building.push(side * path.wall * scale);
          kerb.push(side * (path.wall - path.depth) * scale);
        }
      }
    }
    // A closed run comes back to the vertex it started on, which the ring repeats for itself.
    if (closed && xs.length > 1) {
      xs.pop();
      ys.pop();
    }
    runs.push({
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      building: Float64Array.from(building),
      kerb: Float64Array.from(kerb),
      closed,
    });
  }
  return runs;
}

// How far a corner is allowed to run out from the vertex it turns on, as a multiple of the deck's
// own depth. Two offset lines meet further and further out as the turn sharpens — a shed wrapping
// the sharp end of a Flatiron block would reach metres past where any deck stands — and where a run
// carries on straight into a DIFFERENT depth they never meet at all. Past this the corner is cut
// square across instead. 2 leaves every turn up to 120° meeting exactly, which is every ordinary
// street corner and then some.
const MITER_LIMIT = 2;

// The unit direction of each of a run's segments. A segment pinched to nothing takes its neighbour's
// direction, so a repeated vertex in the baked geometry turns into a corner that does not turn rather
// than a hole in the walk. Null where the whole run is one point and there is no direction to be had.
function runDirections({
  xs,
  ys,
  building,
}: DeckRun): { dirX: Float64Array; dirY: Float64Array } | null {
  const segments = building.length;
  const dirX = new Float64Array(segments);
  const dirY = new Float64Array(segments);
  let found = false;
  for (let segment = 0; segment < segments; segment++) {
    // The last segment of a closed run comes back round to the vertex it started from.
    const next = segment + 1 === xs.length ? 0 : segment + 1;
    const runX = xs[next] - xs[segment];
    const runY = ys[next] - ys[segment];
    const length = Math.hypot(runX, runY);
    if (length > 0) {
      dirX[segment] = runX / length;
      dirY[segment] = runY / length;
      found = true;
    }
  }
  if (!found) {
    return null;
  }
  for (const step of [1, -1]) {
    for (
      let segment = step === 1 ? 1 : segments - 2;
      segment >= 0 && segment < segments;
      segment += step
    ) {
      if (dirX[segment] === 0 && dirY[segment] === 0) {
        dirX[segment] = dirX[segment - step];
        dirY[segment] = dirY[segment - step];
      }
    }
  }
  return { dirX, dirY };
}

// Where one edge of the band turns: the point sitting `intoOffset` off the segment arriving at the
// corner and `outOffset` off the one leaving it, which is where the two offset lines meet. Null where
// they meet further out than `reach`, or not at all — parallel lines at different offsets, which is
// the run carrying straight on into a deeper deck.
function edgeCorner(
  intoX: number,
  intoY: number,
  intoOffset: number,
  outX: number,
  outY: number,
  outOffset: number,
  reach: number,
): [number, number] | null {
  const cosine = intoX * outX + intoY * outY;
  const spread = 1 - cosine * cosine;
  if (spread < 1e-12) {
    return intoOffset === outOffset && cosine > 0
      ? [intoX * intoOffset, intoY * intoOffset]
      : null;
  }
  const alongInto = (intoOffset - cosine * outOffset) / spread;
  const alongOut = (outOffset - cosine * intoOffset) / spread;
  const x = alongInto * intoX + alongOut * outX;
  const y = alongInto * intoY + alongOut * outY;
  return Math.hypot(x, y) > reach ? null : [x, y];
}

// One run as the ring it covers: out along the building edge and back along the kerb edge, x/y
// interleaved in zoom-0 world pixels and wound positively.
//
// Both edges are the polyline offset sideways, so a corner is where two offset lines MEET — the
// building's own corner and the kerb's own corner, which is what a shed wraps around — and a depth
// that changes only moves the line the building edge is on. Where they would meet too far out, or
// are parallel at different offsets, the corner is cut square across both edges instead: two
// vertices a side rather than one, which is a chamfer at a hairpin and the step across a change of
// depth. The band's INNER edge folds over itself where a turn is sharper than the segments either
// side are long; the fold lies inside the band, so the nonzero fill both readers use takes it as
// part of the band rather than as a hole. A closed run repeats its first vertex, which joins the
// annulus with a slit of no width instead of leaving the corner it closed on undecked.
export function deckRing(run: DeckRun): Float64Array {
  const { xs, ys, building, kerb, closed } = run;
  const count = xs.length;
  if (count < 2 || building.length === 0) {
    return new Float64Array(0);
  }
  const directions = runDirections(run);
  if (!directions) {
    return new Float64Array(0);
  }
  const { dirX, dirY } = directions;
  const segments = dirX.length;

  // The two edges as they are walked: the building's in order, the kerb's to be walked back.
  const outer: number[] = [];
  const inner: number[] = [];
  for (let vertex = 0; vertex <= (closed ? count : count - 1); vertex++) {
    // A closed run's last vertex is the repeat of its first, and turns on the same two segments.
    const at = vertex === count ? 0 : vertex;
    const into = closed ? (at + segments - 1) % segments : Math.max(at - 1, 0);
    const outOf = closed ? at : Math.min(at, segments - 1);
    // y runs SOUTH in world pixels, so the left normal of (dx, dy) is (dy, -dx).
    const intoX = dirY[into];
    const intoY = -dirX[into];
    const outX = dirY[outOf];
    const outY = -dirX[outOf];
    const reach =
      MITER_LIMIT *
      Math.max(
        Math.abs(building[into] - kerb[into]),
        Math.abs(building[outOf] - kerb[outOf]),
      );
    const buildingCorner = edgeCorner(
      intoX,
      intoY,
      building[into],
      outX,
      outY,
      building[outOf],
      reach,
    );
    const kerbCorner = edgeCorner(
      intoX,
      intoY,
      kerb[into],
      outX,
      outY,
      kerb[outOf],
      reach,
    );
    // Both edges turn on one vertex or neither does, so the two stay in step and every vertex of
    // the ring keeps the one across the band from it as its mirror.
    if (buildingCorner && kerbCorner) {
      outer.push(xs[at] + buildingCorner[0], ys[at] + buildingCorner[1]);
      inner.push(xs[at] + kerbCorner[0], ys[at] + kerbCorner[1]);
    } else {
      outer.push(
        xs[at] + intoX * building[into],
        ys[at] + intoY * building[into],
        xs[at] + outX * building[outOf],
        ys[at] + outY * building[outOf],
      );
      inner.push(
        xs[at] + intoX * kerb[into],
        ys[at] + intoY * kerb[into],
        xs[at] + outX * kerb[outOf],
        ys[at] + outY * kerb[outOf],
      );
    }
  }

  const ring = new Float64Array(outer.length + inner.length);
  ring.set(outer);
  for (let vertex = 0; vertex * 2 < inner.length; vertex++) {
    const back = inner.length - 2 - vertex * 2;
    ring[outer.length + vertex * 2] = inner[back];
    ring[outer.length + vertex * 2 + 1] = inner[back + 1];
  }

  let area = 0;
  const vertices = ring.length / 2;
  for (let vertex = 0; vertex < vertices; vertex++) {
    const next = (vertex + 1) % vertices;
    area +=
      ring[vertex * 2] * ring[next * 2 + 1] -
      ring[next * 2] * ring[vertex * 2 + 1];
  }
  if (area < 0) {
    // Which edge the walk leaves along depends on which side of its own street the sidewalk was
    // baked to, so half of them come out wound the wrong way for a nonzero fill. Reversing the flat
    // array turns every x/y pair back to front as well, hence the swap.
    ring.reverse();
    for (let vertex = 0; vertex < vertices; vertex++) {
      const swap = ring[vertex * 2];
      ring[vertex * 2] = ring[vertex * 2 + 1];
      ring[vertex * 2 + 1] = swap;
    }
  }
  return ring;
}

// Trace one deck's ring into `sink`, in the tile pixels `scale` and the origin give. A band that
// would come out narrower than `minWidth` is opened out to it about its own middle — the ring's
// vertices come in pairs straddling the run, so the width is read off the pair rather than carried
// alongside — which keeps a band legible at a zoom where its real depth is a tenth of a pixel, and a
// sliver off the floor a sample grid would drop it below. Pass 0 to draw it exactly as it stands.
export function traceDeck(
  sink: PolygonSink,
  { points, rings }: ShedDecks,
  deck: number,
  scale: number,
  originX: number,
  originY: number,
  minWidth: number,
): void {
  const from = rings[deck];
  const to = rings[deck + 1];
  for (let vertex = from; vertex < to; vertex++) {
    let x = points[vertex * 2] * scale - originX;
    let y = points[vertex * 2 + 1] * scale - originY;
    if (minWidth > 0) {
      const mirror = from + to - 1 - vertex;
      const acrossX = (points[vertex * 2] - points[mirror * 2]) * scale;
      const acrossY = (points[vertex * 2 + 1] - points[mirror * 2 + 1]) * scale;
      // Squared until it has to be a width, which is a root a tile's every vertex would pay.
      const spread = acrossX * acrossX + acrossY * acrossY;
      const across =
        spread < minWidth * minWidth ? Math.sqrt(spread) : minWidth;
      if (across > 0 && across < minWidth) {
        const open = (minWidth - across) / 2 / across;
        x += acrossX * open;
        y += acrossY * open;
      }
    }
    if (vertex === from) {
      sink.moveTo(x, y);
    } else {
      sink.lineTo(x, y);
    }
  }
  sink.closePath();
}

// Every shed standing on `day`, as the polygons their decks cover.
export function shedDecks(
  graph: RoutingGraph,
  history: ShedHistory,
  day: number,
): ShedDecks {
  const runs: DeckRun[] = [];
  for (const shed of shedsOn(graph, history, day)) {
    runs.push(...shedRuns(graph, shed));
  }
  return packRuns(runs);
}
