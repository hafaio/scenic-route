// The SHED artifact: every sidewalk shed New York has permitted since 2017-12-28, as the graph edges
// it stands on and the days it stood there. Written by scripts/shed-encode.ts; this is the only thing
// that reads it. scripts/README.md has the layout (magic `SHED`, v2) — the open/closed split almost
// every query is "today" pays for, and why a span names its edge by the graph's durable key rather
// than by its position, resolved per query. DESIGN.md, "Sidewalk sheds", is why any of that is so.

import { rainTau } from "../shade/phenology";
import { type Cursor, readUnsignedVarint, readVarint } from "../tiles/varint";
import { durableKey, edgePath, NO_SOURCE_ID, type RoutingGraph } from "./graph";
import {
  SCHEDULE_BUCKETS,
  SCHEDULE_STEP_SECONDS,
  scheduleBucket,
  sunAt,
} from "./shade";

// How high the deck stands, which the permit feed does not carry and nothing measures: 4 m is the
// middle of the range DOB leaves — it requires 8 ft of clearance and typical decks run 12-15 ft.
// It sets the length of the shadow the deck throws (src/tiles/sweep.ts).
export const DECK_HEIGHT_METERS = 4;

// What a span with no measured depth falls back to. The pipeline measures the pavement its deck
// stands on for every span it can (scripts/shed-map.ts), and the whole feed's median comes out at
// 3.7 m; 4 m was the flat assumption this replaced, and it is close enough to that median to stay
// the answer where there is nothing to measure.
export const DEFAULT_DECK_DEPTH_METERS = 4;

// The narrowest deck that can be BUILT, which is not the narrowest that can be measured. The code
// wants a clear path of 5 ft under a shed (BC 3307.6.2, and BC 3307.6.3 has the deck cover the whole
// pavement bar 18 in at the kerb), the frame's posts and their bracing stand outside that path either
// side, and 8 ft is where the standard shed frame starts. So a measurement under it is a lot line or
// a kerb estimate that is off rather than a sliver of a shed, and the correction belongs to the
// MEASUREMENT: the band, the shadow it throws and the shade it holds all take the corrected number.
export const MIN_DECK_DEPTH_METERS = 2.4;

// What the pipeline measured across the pavement, or the fallback where it could not — which is
// where the building line is, since the measurement ran from it.
export function measuredDepth(depth: number): number {
  return depth > 0 ? depth : DEFAULT_DECK_DEPTH_METERS;
}

// One span's depth as a reader should use it: the measurement, floored at what can be built. The
// extra goes OUTWARD, over what the graph took for roadway — the lot line the measurement started
// from is evidence and the kerb is a fixed inset off a centreline, so the kerb is the one to move.
export function deckDepth(depth: number): number {
  return Math.max(MIN_DECK_DEPTH_METERS, measuredDepth(depth));
}

const MAGIC = "SHED";
const FORMAT_VERSION = 3;
const CLOSED_FLAG = 0x1; // header byte 26, set in closed.bin
const INDEX_ENTRY_BYTES = 8; // u16 month, u32 offset, u16 close day
const FRACTION_SCALE = 255; // a span's t0/t1 are a fraction of its edge; 255 is exactly 1.0
const CONFIDENCE_SCALE = 255; // the byte is capped at 254, as the graph's cover and scenic bytes are
const DEPTH_SCALE = 10; // a span's depth byte is decimetres; 0 means the placement could not measure one
const SIDE_BITS = 3; // a span's packed side-and-ordinal varint, as the graph's kind-and-side byte packs it
const SIDE_MASK = 0x7;
const MILLISECONDS_PER_DAY = 86_400_000;
const EPOCH_MS = Date.UTC(2017, 11, 28); // the first DOB snapshot; every day number counts from here

// The epoch as the date picker's "YYYY-MM-DD": the earliest day the map has scaffolding for, and so
// the earliest one worth offering.
export const SHED_EPOCH_DAY = new Date(EPOCH_MS).toISOString().slice(0, 10);

// Where the day's artifact comes from: `public/sheds/` on `main`, which the daily job
// (.github/workflows/sheds.yml) commits the three files to, read over raw.githubusercontent.com
// rather than out of the deploy — DESIGN.md, "Sidewalk sheds", for why not same-origin. In
// development it stays on the local `public/sheds/`, as every other artifact a dev server reads does,
// and that is also the only way to see a pipeline change before it is pushed. NEXT_PUBLIC_SHED_BASE
// overrides either way.
const SHED_MAIN_URL =
  "https://raw.githubusercontent.com/hafaio/scenic-route/main/public/sheds";
const SHED_BASE =
  process.env.NEXT_PUBLIC_SHED_BASE ??
  (process.env.NODE_ENV === "development" ? "sheds" : SHED_MAIN_URL);

export const SHED_URLS = {
  open: `${SHED_BASE}/open.bin`,
  closed: `${SHED_BASE}/closed.bin`,
  index: `${SHED_BASE}/index.bin`,
} as const;

// A stretch of one edge a shed stands over, as the fractions of the edge's length it runs between.
// `edge` is the graph position the artifact's durable key resolved to, or -1 when this graph has no
// edge by that name — a source segment the rebuild dropped or changed enough to break the key.
export interface ShedSpan {
  edge: number;
  t0: number;
  t1: number;
  // How deep the deck runs ACROSS the pavement here, in metres: the pipeline measured the building
  // line off the tax lot and the kerb off the graph's own sidewalk offset (scripts/README.md). 0
  // where it could measure neither, which every reader turns into the fallback depth.
  depth: number;
}

// One shed over one presence interval. A permit that came down and went back up is two of these
// sharing geometry — the intervals are disjoint, so no day sees the same shed twice.
export interface Shed {
  first: number; // day number of the first day it stood
  close: number | null; // day number of the last, or null while it is still up
  confidence: number; // 0..1, how much to trust the placement (the prototype's confidence column)
  spans: ShedSpan[];
}

// One of the two record files, held as its undecoded bytes: a suffix read is the point of the format,
// so records are walked per query rather than decoded up front.
interface ShedFile {
  bytes: Uint8Array;
  count: number;
  spanCount: number;
  firstDay: number; // the day the file's delta chain starts from — the first record's own day
  // Where the records start. The header carries its own length because both files end theirs with
  // state for the daily job — `closed.bin` the row counts it picks the DOB's feed back up with,
  // `open.bin` the job numbers naming its records — which nothing here reads and which are none of
  // the client's business beyond skipping them.
  records: number;
}

export interface ShedHistory {
  graphKeyHash: string; // FNV-1a 64 of the graph's durable key space, as routing/version.json spells it
  lastDay: number; // the newest usable DOB snapshot the artifact was built through
  open: ShedFile;
  closed: ShedFile;
  // The month index over closed.bin, ascending: per calendar month that has a record in it, the
  // month's first day, the byte offset of the first record closing on or after it, and that record's
  // absolute close day.
  months: Uint16Array;
  offsets: Uint32Array;
  closeDays: Uint16Array;
}

// The day number a Date falls on, by its LOCAL calendar date: a shed's dates are New York calendar
// days, and the viewer of a New York map is reading them in that calendar.
export function shedDay(date: Date): number {
  const midnight = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  return Math.round((midnight - EPOCH_MS) / MILLISECONDS_PER_DAY);
}

function decodeFile(buffer: ArrayBuffer, closed: boolean): ShedFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} shed file`);
  }
  if (((bytes[26] & CLOSED_FLAG) !== 0) !== closed) {
    throw new Error(
      `shed file is ${closed ? "the open" : "the closed"} half, the other was expected`,
    );
  }
  return {
    bytes,
    count: view.getUint32(8, true),
    spanCount: view.getUint32(12, true),
    firstDay: view.getUint16(24, true),
    records: view.getUint16(6, true),
  };
}

// The 64-bit key-space hash as the hex routing/version.json carries, read as its two halves so
// nothing here needs BigInt.
function decodeGraphKeyHash(view: DataView): string {
  const low = view.getUint32(16, true);
  const high = view.getUint32(20, true);
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

export function decodeSheds(
  openBuffer: ArrayBuffer,
  closedBuffer: ArrayBuffer,
  indexBuffer: ArrayBuffer,
): ShedHistory {
  const open = decodeFile(openBuffer, false);
  const closed = decodeFile(closedBuffer, true);
  const openHash = decodeGraphKeyHash(new DataView(openBuffer));
  const closedHash = decodeGraphKeyHash(new DataView(closedBuffer));
  if (openHash !== closedHash) {
    throw new Error(
      `shed halves were baked against different key spaces (${openHash}, ${closedHash})`,
    );
  }

  const entries = Math.floor(indexBuffer.byteLength / INDEX_ENTRY_BYTES);
  const view = new DataView(indexBuffer);
  const months = new Uint16Array(entries);
  const offsets = new Uint32Array(entries);
  const closeDays = new Uint16Array(entries);
  for (let entry = 0; entry < entries; entry++) {
    const at = entry * INDEX_ENTRY_BYTES;
    months[entry] = view.getUint16(at, true);
    offsets[entry] = view.getUint32(at + 2, true); // unaligned, which a DataView reads fine
    closeDays[entry] = view.getUint16(at + 6, true);
  }
  const lastDay = new DataView(openBuffer).getUint16(28, true);
  if (lastDay !== new DataView(closedBuffer).getUint16(28, true)) {
    throw new Error("the shed halves were built through different days");
  }
  return {
    graphKeyHash: openHash,
    lastDay,
    open,
    closed,
    months,
    offsets,
    closeDays,
  };
}

// One record's spans, still named by durable key: `edge` holds the key until `resolveSpans` swaps in
// this graph's position for it. The source-id delta chain restarts at every record — a chain running
// across records would make the suffix read below impossible and drift the ids instead of failing.
function readSpans(bytes: Uint8Array, cursor: Cursor): ShedSpan[] {
  const count = readUnsignedVarint(bytes, cursor);
  const spans: ShedSpan[] = new Array(count);
  let sourceId = 0;
  for (let span = 0; span < count; span++) {
    sourceId += readUnsignedVarint(bytes, cursor);
    const packed = readUnsignedVarint(bytes, cursor);
    const t0 = bytes[cursor.offset] / FRACTION_SCALE;
    const t1 = bytes[cursor.offset + 1] / FRACTION_SCALE;
    const depth = bytes[cursor.offset + 2] / DEPTH_SCALE;
    cursor.offset += 3;
    spans[span] = {
      edge: durableKey(sourceId, packed & SIDE_MASK, packed >> SIDE_BITS),
      t0,
      t1,
      depth,
    };
  }
  return spans;
}

// The sheds still standing, filtered to those already up on `day`. The file is in job-number order,
// not day order — the order the job numbers in its header run in, which is how the daily job knows
// which record is whose — so the first-day deltas are signed and every record is walked. It holds
// ~7,500 of them; the size that made the seek worth building is all in `closed.bin`.
function openOn(file: ShedFile, day: number): Shed[] {
  const standing: Shed[] = [];
  const cursor: Cursor = { offset: file.records };
  let first = file.firstDay;
  for (let record = 0; record < file.count; record++) {
    first += readVarint(file.bytes, cursor);
    const confidence = file.bytes[cursor.offset] / CONFIDENCE_SCALE;
    cursor.offset += 1;
    const spans = readSpans(file.bytes, cursor); // walked either way: it is how the next record is reached
    if (first <= day) {
      standing.push({ first, close: null, confidence, spans });
    }
  }
  return standing;
}

// Where a scan of closed.bin for `day` starts: the last index entry at or before `day`'s month, or
// the head of the file when `day` predates the index. The entry's close day is the one the chain
// re-bases from — replaying the file to rebuild it would cost exactly what the index exists to save.
function seek(
  history: ShedHistory,
  day: number,
): { offset: number; closeDay: number } {
  let low = 0;
  let high = history.months.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (history.months[middle] <= day) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low === 0) {
    return {
      offset: history.closed.records,
      closeDay: history.closed.firstDay,
    };
  } else {
    return {
      offset: history.offsets[low - 1],
      closeDay: history.closeDays[low - 1],
    };
  }
}

// The sheds that have come down, filtered to those standing on `day`. Walks the suffix from the seek
// point: everything before it closed too early to matter, and the records after it are in close-day
// order, so only the ones that also went up in time survive the filter.
function closedOn(history: ShedHistory, day: number): Shed[] {
  const { bytes } = history.closed;
  const start = seek(history, day);
  const cursor: Cursor = { offset: start.offset };
  const standing: Shed[] = [];
  // The record AT the seek point is the one whose absolute close day the index states, so its own
  // delta is what that value replaces; every record after it chains from there as usual.
  let close = start.closeDay;
  let chained = false;
  while (cursor.offset < bytes.length) {
    const delta = readUnsignedVarint(bytes, cursor);
    if (chained) {
      close += delta;
    } else {
      chained = true;
    }
    const first = close - readUnsignedVarint(bytes, cursor);
    const confidence = bytes[cursor.offset] / CONFIDENCE_SCALE;
    cursor.offset += 1;
    const spans = readSpans(bytes, cursor); // walked either way: it is how the next record is reached
    if (close >= day && first <= day) {
      standing.push({ first, close, confidence, spans });
    }
  }
  return standing;
}

// Turns every span's durable key into this graph's edge position, in one pass over the graph's key
// column. A key the graph does not carry leaves its span at -1 rather than dropping it, so a caller
// that counts spans still sees the shed; every consumer skips a negative edge.
function resolveSpans(graph: RoutingGraph, sheds: readonly Shed[]): void {
  const wanted = new Map<number, number>();
  for (const shed of sheds) {
    for (const span of shed.spans) {
      wanted.set(span.edge, -1);
    }
  }
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const sourceId = graph.edgeSourceId[edge];
    if (sourceId !== NO_SOURCE_ID) {
      const key = durableKey(
        sourceId,
        (graph.edgeKindSide[edge] >> SIDE_BITS) & SIDE_MASK,
        graph.edgeOrdinal[edge],
      );
      if (wanted.has(key)) {
        wanted.set(key, edge);
      }
    }
  }
  for (const shed of sheds) {
    for (const span of shed.spans) {
      span.edge = wanted.get(span.edge) as number;
    }
  }
}

// Whether the artifact names edges in THIS graph. A durable key survives a rebuild but does not
// promise to mean the same edge across one: a conflation fix left 2,284 of 302,985 keys naming an
// edge a median 26 m from the one they had named. So the gate is the whole KEY SPACE — every
// `(source id, side, ordinal)` the graph carries, hashed — rather than any single key. Ordinals are
// handed out 0..n-1 within a `(source id, side)`, so a source segment that splits into a different
// number of edges moves the set, and an artifact placed against another set resolves nothing at all:
// bare pavement is a failure anyone can see, scaffolding down the wrong street is not.
//
// The GRAPH'S BYTES are not the gate, and were until 2026-08. They carry f32 edge lengths that the
// geodesic and offset maths land a ulp apart on macOS/aarch64 and on Linux/x86_64, so an artifact
// placed on a laptop could never match the graph a deploy builds — a blank map over a difference no
// shed can feel. The key space is integers all the way down.
function sameGraph(graph: RoutingGraph, history: ShedHistory): boolean {
  return graph.keyHash === history.graphKeyHash;
}

// Every shed standing on `day`, both halves together, with their spans resolved onto `graph`. None
// of them when the artifact was placed against a different graph, which is what the display layer,
// the router and the shadow caster all go quiet on.
export function shedsOn(
  graph: RoutingGraph,
  history: ShedHistory,
  day: number,
): Shed[] {
  if (!sameGraph(graph, history)) {
    return [];
  }
  const standing = [...openOn(history.open, day), ...closedOn(history, day)];
  resolveSpans(graph, standing);
  return standing;
}

// What a day's sheds add up to on one edge.
export interface EdgeDeck {
  covered: number; // the share of the edge standing under a deck, 0..1
  depth: number; // how deep that deck runs across the pavement, metres; 0 where none was measured
}

// Every decked edge on `day`, by edge id. Sheds overlap — about a tenth of the touched edges are
// covered past their own length by concurrent permits — so the covered share is clamped, and the
// depth is the mean of the spans' own weighted by the length each contributes, which is what makes
// one long shed on a wide pavement outweigh a stub of a narrow one beside it. A span the artifact
// measured no depth for is left out of that mean rather than pulling it toward a stand-in, and an
// edge with no measured span at all reads 0, for a reader to fall back on as it sees fit.
//
// A placement's confidence weights neither: the cost model prices what might be overhead, and being
// unsure of a deck is a reason to steer clear of it rather than to discount it.
export function shedCoverage(
  graph: RoutingGraph,
  history: ShedHistory,
  day: number,
): Map<number, EdgeDeck> {
  const decks = new Map<number, EdgeDeck>();
  const measured = new Map<number, number>(); // the weight behind each depth sum
  for (const shed of shedsOn(graph, history, day)) {
    for (const { edge, t0, t1, depth } of shed.spans) {
      if (edge < 0) {
        continue; // this graph has no edge by that durable name
      }
      const along = t1 - t0;
      const deck = decks.get(edge) ?? { covered: 0, depth: 0 };
      deck.covered += along;
      if (depth > 0) {
        deck.depth += along * depth;
        measured.set(edge, (measured.get(edge) ?? 0) + along);
      }
      decks.set(edge, deck);
    }
  }
  for (const [edge, deck] of decks) {
    // The weighted mean, taken before the clamp so a doubly covered edge is not thinned by it.
    const weight = measured.get(edge) ?? 0;
    deck.depth = weight > 0 ? deck.depth / weight : 0;
    deck.covered = Math.min(1, deck.covered);
  }
  return decks;
}

// A day's scaffolding as the cost model reads it: one byte per graph edge, on the same 0-254 ceiling
// the graph's own attribute bytes use. Coverage feeds discounts (the shade composite and the shelter
// factor), so it has to stay strictly under 1 or a metre under a deck could cost nothing and the
// search would wander. It carries the day's rain tau too, since the shelter factor is the deck and the
// canopy together and only the client knows the date, and the sun across the walk, since how much of
// its own sidewalk a deck still shades depends on where the sun is and which way the street runs.
export interface ShedField {
  coverage: Uint8Array; // per edge, 0-254: the share of it standing under a deck
  depth: Float32Array; // per decked edge, how deep its deck runs across the pavement, metres
  bearing: Float32Array; // per decked edge, the way it runs, in radians clockwise from north
  translate: Float64Array; // per shade-schedule bucket, metres the sun slides a deck's shadow along the ground
  sunAzimuth: Float64Array; // per shade-schedule bucket, where the sun comes from, radians clockwise from north
  rainTau: number; // the share of rain a crown directly overhead keeps off on the day
  maxCoverage: number; // the greatest per-edge coverage, 0..1; an input to the shelter clip floor
}

const COVERAGE_CEILING = 254;
const DEGREES = Math.PI / 180;

// The sun elevation below which a deck's shadow is taken as flat on the ground: at 0.5 deg the
// translate is already 458 m, ~100x the deck's depth, and the shade attribute is 0 at night anyway.
// Clamping rather than dividing by tan(0) keeps the translate finite, so a sun exactly along a street
// stays 0 across it instead of going NaN.
const MIN_ELEVATION_DEG = 0.5;

// What a deck still shades once the sun has slid its shadow clear across the sidewalk. A bare slab
// would let all the light in, but a real shed has a solid fascia along its street edge and posts and
// debris netting between them, so oblique light is cut more than the slab model says. Small on
// purpose: it only bites at a low sun across the street, where the sun's own intensity has already
// gone with it.
export const SHED_OBLIQUE_FLOOR = 0.15;

function quantizeCoverage(fraction: number): number {
  return Math.min(COVERAGE_CEILING, Math.round(fraction * 255));
}

// The way a decked edge runs, in radians clockwise from north. A sidewalk edge runs corner to corner
// and can bend, so this is its segments' mean direction weighted by length — taken on doubled angles,
// because a street has no forward end and the two halves of a bend would otherwise cancel out.
function edgeBearing(graph: RoutingGraph, edge: number): number {
  const { lngs, lats } = edgePath(graph, edge);
  let sumSin = 0;
  let sumCos = 0;
  for (let segment = 0; segment + 1 < lngs.length; segment++) {
    const east =
      (lngs[segment + 1] - lngs[segment]) * Math.cos(lats[segment] * DEGREES);
    const north = lats[segment + 1] - lats[segment];
    const length = Math.hypot(east, north);
    const bearing = Math.atan2(east, north);
    sumSin += length * Math.sin(2 * bearing);
    sumCos += length * Math.cos(2 * bearing);
  }
  return Math.atan2(sumSin, sumCos) / 2;
}

// Point a field's sun schedule at a departure instant. Its own function because which sheds stand
// moves with the DAY while the sun moves with the clock: an hour-slider step has to re-aim the sun,
// and rebuilding the coverage and the bearings for it would cost ~10 ms of work that did not change.
export function setShedSun(field: ShedField, date: Date): void {
  for (let bucket = 0; bucket < SCHEDULE_BUCKETS; bucket++) {
    const when = new Date(
      date.getTime() + bucket * SCHEDULE_STEP_SECONDS * 1000,
    );
    const sun = sunAt(when);
    field.translate[bucket] =
      DECK_HEIGHT_METERS /
      Math.tan(Math.max(sun.elevation, MIN_ELEVATION_DEG) * DEGREES);
    field.sunAzimuth[bucket] = sun.azimuth * DEGREES;
  }
}

// The day's coverage as the cost model reads it, over the graph it was placed against.
export function shedField(
  graph: RoutingGraph,
  decks: ReadonlyMap<number, EdgeDeck>,
  date: Date,
): ShedField {
  const covered = new Uint8Array(graph.edgeCount);
  const depth = new Float32Array(graph.edgeCount);
  const bearing = new Float32Array(graph.edgeCount);
  let maxByte = 0;
  for (const [edge, deck] of decks) {
    if (edge < graph.edgeCount) {
      covered[edge] = quantizeCoverage(deck.covered);
      depth[edge] = deckDepth(deck.depth);
      bearing[edge] = edgeBearing(graph, edge);
      maxByte = Math.max(maxByte, covered[edge]);
    }
  }

  const field: ShedField = {
    coverage: covered,
    depth,
    bearing,
    translate: new Float64Array(SCHEDULE_BUCKETS),
    sunAzimuth: new Float64Array(SCHEDULE_BUCKETS),
    rainTau: rainTau(date),
    maxCoverage: maxByte / 255,
  };
  setShedSun(field, date);
  return field;
}

// The share of an edge a deck actually shades at this point in the walk: its coverage, damped by how
// far the sun has slid the deck's shadow off the sidewalk it stands over.
//
// A deck is a floating opaque slab, not a tunnel. Trace a ray back toward the sun from a point under
// one and the point is lit as soon as that ray has moved further ACROSS the sidewalk than the deck is
// deep — which is why only the across-street component of the translate counts. A sun running ALONG
// the street slides the shadow down the shed's own length, tens of metres of it, so the deck stays
// shaded to a far lower elevation than one across the street does. A single elevation threshold
// cannot say that; the angle between the sun and the street is what decides it.
//
// The depth it is measured against is the edge's own, so a 6 m deck on a Midtown avenue holds its
// shade to a lower sun than a 2 m one on a side street — which is the same number the band is drawn
// at. The zero coverage exits first, so an undecked edge never divides by its empty depth.
export function shedShade(
  field: ShedField,
  edge: number,
  elapsedSeconds: number,
): number {
  const covered = field.coverage[edge] / 255;
  if (covered === 0) {
    return 0;
  } else {
    const bucket = scheduleBucket(elapsedSeconds);
    const across =
      field.translate[bucket] *
      Math.abs(Math.sin(field.sunAzimuth[bucket] - field.bearing[edge]));
    return (
      covered * Math.max(SHED_OBLIQUE_FLOOR, 1 - across / field.depth[edge])
    );
  }
}

// Build the graph's scaffolding field for a date. The canopy half of shelter needs no artifact, so it
// lands first and a slow or failed fetch leaves the shelter slider working on trees alone rather than
// inert; the sheds standing that day replace it once they arrive.
//
// A stale artifact throws rather than resolving to nothing quietly: the field is already seeded, so
// the caller's catch leaves routing working on trees alone, and the mismatch is the one thing here
// worth saying out loud. The other two readers have no such channel and simply draw nothing.
export async function computeEdgeSheds(
  graph: RoutingGraph,
  date: Date,
): Promise<void> {
  graph.sheds = shedField(graph, new Map(), date);
  const history = await loadSheds();
  if (!sameGraph(graph, history)) {
    throw new Error(
      `the shed artifact was placed against key space ${history.graphKeyHash}, this graph's is` +
        ` ${graph.keyHash || "unknown"}`,
    );
  }
  graph.sheds = shedField(
    graph,
    shedCoverage(graph, history, shedDay(date)),
    date,
  );
}

let historyPromise: Promise<ShedHistory> | null = null;

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

export function loadSheds(): Promise<ShedHistory> {
  if (!historyPromise) {
    historyPromise = Promise.all([
      fetchBuffer(SHED_URLS.open),
      fetchBuffer(SHED_URLS.closed),
      fetchBuffer(SHED_URLS.index),
    ])
      .then(([open, closed, index]) => decodeSheds(open, closed, index))
      .catch((error: unknown) => {
        historyPromise = null; // a failed load must not be memoized
        throw error;
      });
  }
  return historyPromise;
}
