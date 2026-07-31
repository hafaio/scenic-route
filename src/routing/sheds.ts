// The SHED artifact: every sidewalk shed New York has permitted since 2017-12-28, as the graph edges
// it stands on and the days it stood there. Layout: scripts/README.md (magic `SHED`, v1). Written by
// scripts/shed-encode.ts; this is the only thing that reads it.
//
// A span names its edge by the graph's DURABLE key — the source segment's CSCL physicalid, its
// N/E/S/W side and an ordinal — not by the edge's position in the graph, which shifts on every
// rebuild. Resolving that back to an edge index is one pass over the graph's own key column, done per
// query rather than as a standing index: the standing set is ~13k spans against 531k edges, so a
// Map of the keys a day actually wants is a hundredth of the size of a Map of every edge.
//
// It ships as two files because almost every query is "today". `open.bin` holds the sheds still up —
// 80 KB, and a query for today reads nothing else. `closed.bin` holds the ones that have come down,
// sorted by the day they did, so a query for a past day seeks into it with `index.bin` and decodes
// only the suffix that could still have been standing. Reading a day eight years back costs the whole
// file; reading today costs a tenth of it.

import { type Cursor, readUnsignedVarint, readVarint } from "../tiles/varint";
import { durableKey, NO_SOURCE_ID, type RoutingGraph } from "./graph";

const MAGIC = "SHED";
const FORMAT_VERSION = 2;
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

// Where the day's artifact comes from: `public/sheds/` on `main`, read over
// raw.githubusercontent.com rather than out of the deploy. The sheds change every morning and the
// site does not — the daily job (.github/workflows/sheds.yml) commits the three files to `main`,
// while Pages ships on `workflow_dispatch` alone, so anything read same-origin would be exactly as
// fresh as the last manual deploy: ~16 new permits a day against ~13k standing, so a month between
// deploys is ~4% of the standing set wrong. `raw` decouples the two — it serves any branch with
// `access-control-allow-origin: *`, gzip, an etag, a five-minute cache and range requests.
//
// `main` rather than a side branch because that is where the artifact is committed, and because
// `main` always exists: there is no branch to bootstrap before the client can read anything. LFS is
// the one store this may never move to (DESIGN.md), and `raw` would serve a pointer's text rather
// than its bytes anyway.
//
// In development it stays on the local `public/sheds/` — every other artifact a dev server reads
// comes out of local `public/` (the graph, the tile pyramids, the caster chunks), and this is also
// the only way to see a pipeline change before it is pushed. NEXT_PUBLIC_SHED_BASE overrides either
// way.
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
  graphHash: string; // FNV-1a 64 of the GRPH bytes, as routing/version.json spells it
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

// The 64-bit graph hash as the hex routing/version.json carries, read as its two halves so nothing
// here needs BigInt.
function decodeGraphHash(view: DataView): string {
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
  const openHash = decodeGraphHash(new DataView(openBuffer));
  const closedHash = decodeGraphHash(new DataView(closedBuffer));
  if (openHash !== closedHash) {
    throw new Error(
      `shed halves were baked against different graphs (${openHash}, ${closedHash})`,
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
    graphHash: openHash,
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

// Every shed standing on `day`, both halves together, with their spans resolved onto `graph`.
export function shedsOn(
  graph: RoutingGraph,
  history: ShedHistory,
  day: number,
): Shed[] {
  const standing = [...openOn(history.open, day), ...closedOn(history, day)];
  resolveSpans(graph, standing);
  return standing;
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
