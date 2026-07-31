// The writer for the `SHED` artifact — every scaffolding permit New York has issued since
// 2017-12-28, as the graph edges it stands over and the days it stood there. `src/routing/sheds.ts`
// is the reader and scripts/README.md is the layout; the two files have to agree byte for byte, and
// `src/routing/sheds.test.ts` pins this one against a checked-in slice of the real history.
//
// A permit that came down and went back up is two records sharing geometry rather than one record
// with a list of intervals. Both layouts were built and measured: the interval list is 3% smaller
// overall but 30% BIGGER on open.bin, which is the only file the common query reads, because an open
// shed's earlier closed intervals would have to ride in the hot file.

import { durableKey } from "../src/routing/graph";

const MAGIC = "SHED";
const FORMAT_VERSION = 2;
const HEADER_BYTES = 32;
const CLOSED_FLAG = 0x1;
const MILLISECONDS_PER_DAY = 86_400_000;
const EPOCH_MS = Date.UTC(2017, 11, 28); // the first DOB snapshot; every day number counts from here

// The side label takes the low three bits of the span's packed side-and-ordinal varint, as the
// graph's own kind-and-side byte packs it.
export const SIDE_BITS = 3;

// One span's durable key, which is also the order the format stores spans in.
function spanKey(span: EncodedSpan): number {
  return durableKey(span.sourceId, span.side, span.ordinal);
}

export const FRACTION_SCALE = 255; // t0/t1 are a fraction of the edge, and 255 is exactly 1.0
export const CONFIDENCE_CEILING = 254; // as the graph's cover and scenic bytes, so a client attribute stays under 1
// The deck's depth in DECIMETRES, which a byte carries to 25.5 m against a placement that refuses
// anything past 8. 0 is not a depth of zero, it is "the placement could not measure one here".
export const DEPTH_SCALE = 10;
export const DEPTH_CEILING = 255;

// A stretch of one edge, as the bytes the format stores rather than the quantities they stand for.
// The edge is named by its DURABLE key rather than by its position in the graph: a rebuild renumbers
// every edge id, and an artifact keyed on those would silently move scaffolding to other streets.
export interface EncodedSpan {
  sourceId: number; // the edge's CSCL physicalid, or an OSM way id for a path
  side: number; // its N/E/S/W label, 0-4, which tells the two sidewalks of one street apart
  ordinal: number; // 0-255, separating the several edges one source segment becomes
  t0: number; // 0..255
  t1: number; // 0..255
  depth: number; // the deck's depth in decimetres, 0 where it could not be measured
}

// One (permit, presence interval) pair: which permit it is, when it stood, how much to trust it, and
// where it stood. A permit the placement could put nowhere still gets its record, with no spans.
export interface EncodedShed {
  // The permit's DOB job number, which `open.bin` stores and `closed.bin` does not — a record read
  // back out of the closed half carries the empty string, and nothing asks it for one.
  job: string;
  first: number; // day number of the interval's first day
  close: number | null; // day number of its last, or null while it is still provisional
  confidence: number; // 0..254
  spans: EncodedSpan[];
}

export interface ShedArtifact {
  open: Uint8Array;
  closed: Uint8Array;
  index: Uint8Array;
}

// What the header's graph field carries: FNV-1a 64 over the GRPH file's own bytes, the same figure
// `tiler graph` writes into routing/version.json (crates/tiler/src/graph.rs). Run on 16-bit limbs:
// the 64-bit multiply has to be exact well past 2^53, and a BigInt one over 27 MB of graph costs
// minutes where this costs under a second.
export function graphHashOf(bytes: Uint8Array): string {
  const LOW = 0x01b3; // 0x100000001b3, as its two non-zero 16-bit limbs
  const HIGH = 0x0100;
  const limbs = [0x2325, 0x8422, 0x9ce4, 0xcbf2]; // 0xcbf29ce484222325, least significant first
  let [limb0, limb1, limb2, limb3] = limbs;
  for (const byte of bytes) {
    limb0 ^= byte;
    const product0 = limb0 * LOW;
    const product1 = limb1 * LOW + Math.floor(product0 / 0x10000);
    const product2 =
      limb2 * LOW + limb0 * HIGH + Math.floor(product1 / 0x10000);
    const product3 =
      limb3 * LOW + limb1 * HIGH + Math.floor(product2 / 0x10000);
    limb0 = product0 & 0xffff;
    limb1 = product1 & 0xffff;
    limb2 = product2 & 0xffff;
    limb3 = product3 & 0xffff;
  }
  return [limb3, limb2, limb1, limb0]
    .map((limb) => limb.toString(16).padStart(4, "0"))
    .join("");
}

// The day number an ISO calendar date falls on. Dates in the feed are New York calendar days and
// carry no time, so they are read as such.
export function shedDayOf(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Math.round(
    (Date.UTC(year, month - 1, day) - EPOCH_MS) / MILLISECONDS_PER_DAY,
  );
}

// The day number of the first of the calendar month `day` falls in, clamped at the epoch: that falls
// mid-December 2017, and a day number cannot express a day before it.
function monthStart(day: number): number {
  const date = new Date(EPOCH_MS + day * MILLISECONDS_PER_DAY);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return Math.max(0, Math.round((start - EPOCH_MS) / MILLISECONDS_PER_DAY));
}

class ByteWriter {
  bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  unsignedVarint(value: number): void {
    let remaining = value;
    while (remaining >= 0x80) {
      this.bytes.push((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.bytes.push(remaining);
  }

  varint(value: number): void {
    this.unsignedVarint(value < 0 ? -2 * value - 1 : 2 * value);
  }
}

// `extension` is what the file carries for the daily job rather than for a reader of the records:
// `closed.bin`'s truncation window, `open.bin`'s job numbers. It is written after the fixed fields
// and covered by the header-bytes field, so a reader reaches the records without knowing what is in
// it.
function header(
  records: readonly EncodedShed[],
  firstDay: number,
  closed: boolean,
  graphHash: string,
  lastDay: number,
  extension: Uint8Array,
): Uint8Array {
  if (HEADER_BYTES + extension.length > 0xffff) {
    // The header-bytes field is a u16, which the job block would have to reach ~21,000 records to
    // exhaust; the standing set has sat near 7,500 for eight years. Loud rather than truncated.
    throw new Error(
      `a ${extension.length}-byte header does not fit the u16 that says where the records start`,
    );
  }
  const bytes = new Uint8Array(HEADER_BYTES + extension.length);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) {
    bytes[index] = MAGIC.charCodeAt(index);
  }
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, bytes.length, true);
  view.setUint32(8, records.length, true);
  view.setUint32(
    12,
    records.reduce((total, record) => total + record.spans.length, 0),
    true,
  );
  // The hash is written as its two halves, matching how the reader takes it apart, so nothing here
  // needs BigInt.
  view.setUint32(16, Number.parseInt(graphHash.slice(8), 16), true);
  view.setUint32(20, Number.parseInt(graphHash.slice(0, 8), 16), true);
  view.setUint16(24, firstDay, true);
  bytes[26] = closed ? CLOSED_FLAG : 0;
  view.setUint16(28, lastDay, true);
  bytes.set(extension, HEADER_BYTES);
  return bytes;
}

// The truncation window as `closed.bin` carries it: one u16 per row count, in the order the walk
// judged them.
function windowBytes(counts: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(2 * counts.length);
  const view = new DataView(bytes.buffer);
  for (const [order, count] of counts.entries()) {
    view.setUint16(2 * order, count, true);
  }
  return bytes;
}

// The source-id chain restarts at every record, so a suffix read never drifts: a chain running
// across records would silently produce wrong ids instead of failing. Spans are ascending by durable
// key, which makes the source-id deltas non-negative and puts the two sidewalks of one street next
// to each other at a delta of zero.
function writeSpans(writer: ByteWriter, record: EncodedShed): void {
  const spans = [...record.spans].sort(
    (left, right) => spanKey(left) - spanKey(right),
  );
  writer.unsignedVarint(spans.length);
  let previous = 0;
  for (const span of spans) {
    writer.unsignedVarint(span.sourceId - previous);
    previous = span.sourceId;
    writer.unsignedVarint(span.side | (span.ordinal << SIDE_BITS));
    writer.u8(span.t0);
    writer.u8(span.t1);
    writer.u8(span.depth);
  }
}

function join(head: Uint8Array, body: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  return bytes;
}

// A job number as two numbers that reconstruct it. The feed has issued exactly two shapes in eight
// and a half years: a nine-digit BIS number, and a DOB NOW one — a borough letter, eight digits, and
// a job-type letter and digit after a hyphen.
interface JobCode {
  key: number; // ascending with the job STRING, so a job-ordered file's deltas are non-negative
  suffix: number; // 0 for a BIS number, else 1 + 10*(type letter - "A") + the type digit
}

// The borough letters in the order they sort. A closed set — there are five boroughs — where the
// job-type letter is not, so that one is carried as its own letter rather than as an index into a
// list this would have to be right about.
const BOROUGH_LETTERS = "BMQSX";
const LETTER_A = "A".charCodeAt(0);
const SUFFIX_DIGITS = 10; // the one digit that follows the job-type letter
const BIS_JOB = /^(\d{9})$/;
const NOW_JOB = /^([A-Z])(\d{8})-([A-Z])(\d)$/;
// Where a DOB NOW key starts. Digits sort below letters, so every BIS number sorts before every DOB
// NOW one and their keys have to as well; a BIS number is its own nine digits, under a billion.
const NOW_KEY_BASE = 1e9;
const NOW_DIGITS = 1e8; // what a DOB NOW number carries after its borough letter

function jobCodeOf(job: string): JobCode {
  const legacy = BIS_JOB.exec(job);
  const now = NOW_JOB.exec(job);
  const borough = now === null ? -1 : BOROUGH_LETTERS.indexOf(now[1]);
  if (legacy !== null) {
    return { key: Number(legacy[1]), suffix: 0 };
  } else if (now === null || borough < 0) {
    // A third shape is a code change and a full rebuild, so it stops the run rather than being
    // stored as something that will not read back as itself.
    throw new Error(
      `"${job}" is neither a nine-digit BIS job number nor a DOB NOW one, so open.bin cannot name it`,
    );
  } else {
    return {
      key: NOW_KEY_BASE + borough * NOW_DIGITS + Number(now[2]),
      suffix:
        1 + (now[3].charCodeAt(0) - LETTER_A) * SUFFIX_DIGITS + Number(now[4]),
    };
  }
}

function jobOf({ key, suffix }: JobCode): string {
  if (suffix === 0) {
    return String(key).padStart(9, "0");
  } else {
    const digits = key - NOW_KEY_BASE;
    const letter = String.fromCharCode(
      LETTER_A + Math.floor((suffix - 1) / SUFFIX_DIGITS),
    );
    return (
      `${BOROUGH_LETTERS[Math.floor(digits / NOW_DIGITS)]}` +
      `${String(digits % NOW_DIGITS).padStart(8, "0")}-${letter}${(suffix - 1) % SUFFIX_DIGITS}`
    );
  }
}

// `open.bin`'s job numbers, one entry per record and in record order: the key's delta from the
// previous record's, then the suffix. The file is in job order and a permit has at most one
// provisional interval, so the deltas are non-negative and a permit's own digits — the part that
// moves — cost two bytes rather than the twelve the string does.
function jobBlock(records: readonly EncodedShed[]): Uint8Array {
  const writer = new ByteWriter();
  let previous = 0;
  for (const record of records) {
    const { key, suffix } = jobCodeOf(record.job);
    if (key < previous) {
      throw new Error(`open.bin reaches ${record.job} out of job order`);
    }
    writer.unsignedVarint(key - previous);
    writer.unsignedVarint(suffix);
    previous = key;
  }
  return Uint8Array.from(writer.bytes);
}

// Every shed still standing, in the order the caller gave them, which is ascending by JOB NUMBER.
// The job numbers themselves ride in the header, where the daily job reads them and the client walks
// past them: that is the artifact saying which record is which permit rather than leaving it to be
// re-derived from the feed. The records are not sorted here and their first-day deltas are signed,
// where a sort by day would have made them monotone and saved a byte a record — the file stays in
// job order because that is the order its identity column is a delta chain over.
function encodeOpen(
  records: readonly EncodedShed[],
  graphHash: string,
  lastDay: number,
): Uint8Array {
  const anchor = records.length > 0 ? records[0].first : 0;
  const writer = new ByteWriter();
  let previous = anchor;
  for (const record of records) {
    writer.varint(record.first - previous);
    previous = record.first;
    writer.u8(record.confidence);
    writeSpans(writer, record);
  }
  return join(
    header(records, anchor, false, graphHash, lastDay, jobBlock(records)),
    writer.bytes,
  );
}

// Every shed that has come down, ascending by close day, plus the month index. A month's entry is
// the offset of the first record closing on or after its first day and that record's ABSOLUTE close
// day, which is what lets a reader start the chain there instead of replaying the file.
//
// The sort is STABLE and on the close day alone, so records closing on one day stay in the job order
// the caller supplied. That is what lets the daily job append a run's worth of new closures without
// rewriting the ones already there: everything it closes was still standing on the day the artifact
// reached, so its close days are all later than every close day already in the file.
function encodeClosed(
  records: readonly EncodedShed[],
  graphHash: string,
  lastDay: number,
  counts: readonly number[],
): { closed: Uint8Array; index: Uint8Array } {
  const ordered = [...records].sort(
    (left, right) => (left.close ?? 0) - (right.close ?? 0),
  );
  const anchor = ordered.length > 0 ? (ordered[0].close ?? 0) : 0;
  const head = header(
    ordered,
    anchor,
    true,
    graphHash,
    lastDay,
    windowBytes(counts),
  );
  const writer = new ByteWriter();
  const index = new ByteWriter();
  let month = -1;
  let previous = anchor;
  for (const record of ordered) {
    const close = record.close ?? 0;
    if (month < monthStart(close)) {
      // An empty month gets no entry; a reader seeking one lands on the last entry at or before it
      // and skips forward, which costs it at most that month's records.
      month = monthStart(close);
      const entry = new Uint8Array(8);
      const view = new DataView(entry.buffer);
      view.setUint16(0, month, true);
      view.setUint32(2, head.length + writer.bytes.length, true);
      view.setUint16(6, close, true);
      index.bytes.push(...entry);
    }
    writer.unsignedVarint(close - previous);
    previous = close;
    writer.unsignedVarint(close - record.first);
    writer.u8(record.confidence);
    writeSpans(writer, record);
  }
  return {
    closed: join(head, writer.bytes),
    index: Uint8Array.from(index.bytes),
  };
}

// `records` must already be in the artifact's canonical order: ascending by job number, and by first
// day within a job. `open.bin` is written in exactly that order and `closed.bin` is that order stably
// re-sorted by close day. `lastDay` is the newest usable snapshot the artifact was built through,
// which is what the daily job reads to know where to pick the feed up, and `counts` is the
// truncation window it picks the feed up with.
export function encodeSheds(
  records: readonly EncodedShed[],
  graphHash: string,
  lastDay: number,
  counts: readonly number[] = [],
): ShedArtifact {
  const { closed, index } = encodeClosed(
    records.filter((record) => record.close !== null),
    graphHash,
    lastDay,
    counts,
  );
  return {
    open: encodeOpen(
      records.filter((record) => record.close === null),
      graphHash,
      lastDay,
    ),
    closed,
    index,
  };
}

// The artifact read back, which only the daily job does: it carries every record forward, so it has
// to see them exactly as they were written — the quantized bytes, and the file order, which is the
// job order `open.bin` was built in and the close-day order `closed.bin` was.
export interface DecodedShedArtifact {
  graphHash: string;
  lastDay: number; // the newest usable DOB snapshot the artifact was built through
  counts: number[]; // the truncation window a walk resuming from `lastDay` has to be seeded with
  open: EncodedShed[];
  closed: EncodedShed[];
}

class ByteReader {
  offset: number;

  constructor(
    readonly bytes: Uint8Array,
    start: number,
  ) {
    this.offset = start;
  }

  u8(): number {
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  unsignedVarint(): number {
    let value = 0;
    let scale = 1;
    let byte = 0;
    do {
      byte = this.bytes[this.offset];
      this.offset += 1;
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return value;
  }

  varint(): number {
    const value = this.unsignedVarint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }
}

function readHeader(bytes: Uint8Array, closed: boolean): DataView {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || view.getUint16(4, true) !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} shed file`);
  }
  if (((bytes[26] & CLOSED_FLAG) !== 0) !== closed) {
    throw new Error(
      `shed file is ${closed ? "the open" : "the closed"} half, the other was expected`,
    );
  }
  return view;
}

function readSpans(reader: ByteReader): EncodedSpan[] {
  const count = reader.unsignedVarint();
  const spans: EncodedSpan[] = new Array(count);
  let sourceId = 0;
  for (let span = 0; span < count; span++) {
    sourceId += reader.unsignedVarint();
    const packed = reader.unsignedVarint();
    spans[span] = {
      sourceId,
      side: packed & ((1 << SIDE_BITS) - 1),
      ordinal: packed >> SIDE_BITS,
      t0: reader.u8(),
      t1: reader.u8(),
      depth: reader.u8(),
    };
  }
  return spans;
}

export function decodeShedArtifact(
  openBytes: Uint8Array,
  closedBytes: Uint8Array,
): DecodedShedArtifact {
  const openView = readHeader(openBytes, false);
  const closedView = readHeader(closedBytes, true);
  const graphHash =
    closedView.getUint32(20, true).toString(16).padStart(8, "0") +
    closedView.getUint32(16, true).toString(16).padStart(8, "0");
  const lastDay = openView.getUint16(28, true);
  if (
    lastDay !== closedView.getUint16(28, true) ||
    graphHash !==
      openView.getUint32(20, true).toString(16).padStart(8, "0") +
        openView.getUint32(16, true).toString(16).padStart(8, "0")
  ) {
    throw new Error("the two shed halves do not describe the same build");
  }

  const counts: number[] = [];
  for (let at = HEADER_BYTES; at + 1 < closedView.getUint16(6, true); at += 2) {
    counts.push(closedView.getUint16(at, true));
  }

  const openCount = openView.getUint32(8, true);
  const jobReader = new ByteReader(openBytes, HEADER_BYTES);
  const jobs: string[] = new Array(openCount);
  let key = 0;
  for (let record = 0; record < openCount; record++) {
    key += jobReader.unsignedVarint();
    jobs[record] = jobOf({ key, suffix: jobReader.unsignedVarint() });
  }

  const openReader = new ByteReader(openBytes, openView.getUint16(6, true));
  const open: EncodedShed[] = [];
  let first = openView.getUint16(24, true);
  for (let record = 0; record < openCount; record++) {
    first += openReader.varint();
    open.push({
      job: jobs[record],
      first,
      close: null,
      confidence: openReader.u8(),
      spans: readSpans(openReader),
    });
  }

  const closedReader = new ByteReader(
    closedBytes,
    closedView.getUint16(6, true),
  );
  const closed: EncodedShed[] = [];
  let close = closedView.getUint16(24, true);
  for (let record = 0; record < closedView.getUint32(8, true); record++) {
    close += closedReader.unsignedVarint();
    const duration = closedReader.unsignedVarint();
    closed.push({
      job: "", // closed.bin does not carry one, and nothing that reads it asks
      first: close - duration,
      close,
      confidence: closedReader.u8(),
      spans: readSpans(closedReader),
    });
  }
  return { graphHash, lastDay, counts, open, closed };
}
