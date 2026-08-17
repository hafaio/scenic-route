// Reconstructs the life of every NYC sidewalk shed from a clone of NYCDOB/ActiveShedPermits, a repo
// whose only content is one CSV snapshot of the city's active shed permits, committed most days
// since December 2017. Walking the history turns those snapshots into one record per permit: the
// attributes the feed last carried for it, and the stretches of days it was actually standing.
// Every commit is resolved to its snapshot blob in one batch, and each distinct blob is parsed
// exactly once as it streams past, so the ~2,600 snapshots are read in a single pass.
//
// The git half of that is package.json's, not this file's: `git log` naming every commit's candidate
// paths, `git cat-file --batch-check` resolving them into .build/shed-index.txt, and `git cat-file
// --batch` streaming the blobs into the walk's stdin. What is left here is the reading — which commit
// a blob belongs to, and the framing the batch stream hands its bytes over in.

import { readFile } from "node:fs/promises";

// Everything the placement reads off a snapshot row, parsed. An interval carries the reading in
// force on the day it ended and is placed from that, never from the one the feed carries now: the
// DOB goes on correcting a permit's geocode and length years after the shed came down, and a record
// that moved with those corrections could not be appended to `closed.bin` and then left alone —
// which is the whole of what makes an update's output independent of where the update started.
export interface ShedAttributes {
  bin: string;
  street: string;
  linearFeet: number; // NaN when the feed carries none
  lat: number | null;
  lng: number | null;
  boroughDigit: string; // the last non-blank Borough Digit / Block / Lot the feed had given it
  block: string;
  lot: string;
}

// One shed permit over its whole life: the attributes of the last snapshot that carried it,
// and every stretch of days it stood.
export interface ShedPermit extends ShedAttributes {
  job: string;
  houseNumber: string; // the one attribute of the row the placement does not read
  runs: ShedInterval[]; // every stretch it was actually in the feed, ascending and disjoint
  intervals: ShedInterval[]; // the same runs with renewal gaps merged; what a query for a day reads
  // The feed changed something the placement reads while this walk was watching. The daily job places
  // only the permits it has never seen, so this is how it hears about a corrected length or geocode
  // on one it has: over a three-month catch-up it fires on 1.6% of the standing set.
  corrected: boolean;
}

export interface ShedInterval {
  first: string; // ISO YYYY-MM-DD
  last: string;
  open: boolean; // still standing in the newest snapshot
  attributes: ShedAttributes; // as the feed had them on `last`, which is what places this record
}

// A shed that reappears within this many days of coming down was never really down: the feed drops
// permits for a few days around a renewal, and the two runs are one shed standing.
export const MERGE_TOLERANCE_DAYS = 14;
// Snapshots this far below the row count of the thirty snapshots BEFORE them are partial writes, not
// a day when the city's sheds vanished. The window is wide because degraded writes come in multi-week
// runs; 30 days still outvotes the longest observed break, a fortnight in mid-2019. It looks only
// backwards, so a day's verdict is final the moment it is made — a two-sided window would let a later
// run disagree with an earlier one about a day both had seen, which is the whole reason the old job
// needed a settled-day clock. The same depth doubles as the reorder buffer: snapshots are filed under
// the day they claim and judged thirty behind the read head, which is what collapses the several
// commits a day the repo often has into one snapshot.
export const TRUNCATION_NEIGHBOURS = 30;
const TRUNCATION_RATIO = 0.75;
// How many judged days a walk keeps the row count of, so it can hand the next one its window. A run
// re-reads the last MERGE_TOLERANCE_DAYS of the feed, so the thirty counts that window has to be
// seeded with are thirty days further back than the last day this walk saw.
const JUDGED_TAIL = TRUNCATION_NEIGHBOURS + MERGE_TOLERANCE_DAYS;
const PROGRESS_INTERVAL = 500;
const DAY_MS = 86_400_000;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;
const COMMA = 0x2c;

type Column =
  | "job"
  | "bin"
  | "street"
  | "houseNumber"
  | "linearFeet"
  | "lat"
  | "lng"
  | "boroughDigit"
  | "block"
  | "lot"
  | "currentDate";

// Columns are resolved by header name, not position: the feed has shipped seven distinct headers
// and has both added and reordered columns. The first candidate a header carries wins.
const COLUMNS: Record<Column, readonly string[]> = {
  job: ["job number", "job_number", "job #", "job"],
  bin: ["bin number", "bin_number", "bin"],
  street: ["street name", "street_name", "street"],
  houseNumber: ["house number", "house_number", "house #"],
  linearFeet: [
    "sidewalk shed/linear feet",
    "sidewalk shed linear feet",
    "linear feet",
  ],
  lat: ["latitude point", "latitude", "latitude_point"],
  lng: ["longitude point", "longitude", "longitude_point"],
  boroughDigit: ["borough digit", "borough_digit", "boro digit"],
  block: ["block"],
  lot: ["lot"],
  currentDate: ["current date", "current_date"],
};

type ColumnIndex = Record<Column, number>;

// The fields of one row, cleaned but unparsed. Every string here is a slice of the one line it was
// decoded from, so a row kept for the final record pins a few hundred bytes rather than the whole
// snapshot text.
export interface SnapshotRow {
  bin: string;
  street: string;
  houseNumber: string;
  linearFeet: string;
  lat: string;
  lng: string;
  boroughDigit: string;
  block: string;
  lot: string;
}

interface ParsedSnapshot {
  csvDate: string | null; // the date the rows claim, absent when none of them parse
  rows: Map<string, SnapshotRow>;
}

// A snapshot pinned to the day it describes, ready to be folded into the runs.
export interface DatedSnapshot {
  date: string;
  rows: Map<string, SnapshotRow>;
}

function clean(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"') && !trimmed.endsWith('"')) {
    return trimmed;
  } else {
    return trimmed.replace(/^"+|"+$/g, "").trim();
  }
}

// The feed started decorating BIS job numbers with a "(BIS)" suffix in 2018. It is the same job.
function normalizeJob(job: string): string {
  return job.replace(/\(BIS\)$/i, "").trim();
}

function isoDate(year: number, month: number, day: number): string | null {
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() !== month - 1 ||
    stamp.getUTCDate() !== day
  ) {
    return null;
  } else {
    return stamp.toISOString().slice(0, 10);
  }
}

// The Current Date column, which the feed has written as YYYY-MM-DD, M/D/YYYY and M/D/YY, each
// sometimes with a time trailing it. Anything else — including an impossible day — is no date.
function parseSnapshotDate(raw: string): string | null {
  const text = clean(raw);
  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  const shortYear = /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/.exec(text);
  if (dashed) {
    return isoDate(Number(dashed[1]), Number(dashed[2]), Number(dashed[3]));
  } else if (slashed) {
    return isoDate(Number(slashed[3]), Number(slashed[1]), Number(slashed[2]));
  } else if (shortYear) {
    const twoDigit = Number(shortYear[3]);
    const year = twoDigit < 69 ? 2000 + twoDigit : 1900 + twoDigit;
    return isoDate(year, Number(shortYear[1]), Number(shortYear[2]));
  } else {
    return null;
  }
}

export function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / DAY_MS;
}

function shiftDay(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

// The day a walk that has read the feed through `lastDay` has to be picked up from: every day whose
// intervals could still change, which is the renewal tolerance and no more. A shed last seen before
// it can no longer be extended by anything the feed publishes next.
export function resumeFrom(lastDay: string): string {
  return shiftDay(lastDay, 1 - MERGE_TOLERANCE_DAYS);
}

// A number the feed may have written with thousands separators. A blank or unparseable value is NaN,
// which is what the record carries for a shed the feed gave no linear feet.
function toNumber(raw: string): number {
  if (raw === "") {
    return Number.NaN;
  } else {
    return Number(raw.replace(/,/g, ""));
  }
}

function toCoordinate(raw: string): number | null {
  const value = toNumber(raw);
  return Number.isNaN(value) ? null : value;
}

function resolveHeader(header: readonly string[]): ColumnIndex {
  const byName = new Map<string, number>();
  for (const [index, name] of header.entries()) {
    // trim() drops the BOM as well as spaces, so the first name is not read as "﻿Job Number".
    byName.set(name.trim().toLowerCase(), index);
  }
  const columns: ColumnIndex = {
    job: -1,
    bin: -1,
    street: -1,
    houseNumber: -1,
    linearFeet: -1,
    lat: -1,
    lng: -1,
    boroughDigit: -1,
    block: -1,
    lot: -1,
    currentDate: -1,
  };
  const wanted = Object.entries(COLUMNS) as [Column, readonly string[]][];
  for (const [column, candidates] of wanted) {
    for (const candidate of candidates) {
      const index = byName.get(candidate);
      if (index !== undefined) {
        columns[column] = index;
        break;
      }
    }
  }
  return columns;
}

// One record of a snapshot CSV, read in place and reused for the next. A plain line is kept as its
// decoded text with the offset of each of its fields beside it, so only the eleven columns the
// record reads ever become strings — the feed's snapshots carry twenty-five. A line with a quote in
// it cannot be sliced (a "" collapses to one character) and arrives already split.
interface CsvRecord {
  line: string;
  starts: number[]; // the offset of each field, then one past the end of the line
  fields: string[] | null;
  next: number; // where the record after this one starts
}

function field(record: CsvRecord, index: number): string {
  if (index < 0) {
    return "";
  } else if (record.fields !== null) {
    return index < record.fields.length ? clean(record.fields[index]) : "";
  } else if (index + 1 < record.starts.length) {
    const from = record.starts[index];
    return clean(record.line.slice(from, record.starts[index + 1] - 1));
  } else {
    return "";
  }
}

// Every field of a record, which only the header needs.
function recordFields(record: CsvRecord): string[] {
  if (record.fields !== null) {
    return record.fields;
  } else {
    return record.line.split(",");
  }
}

// Splits one record's text into fields. A field is quoted only when the quote opens it, a "" inside
// a quoted field is one literal quote, and an embedded line break is just another character.
function splitQuotedRecord(text: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  let atFieldStart = true;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        value += char;
      } else if (text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = false;
      }
    } else if (char === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (char === ",") {
      fields.push(value);
      value = "";
      atFieldStart = true;
    } else {
      value += char;
      atFieldStart = false;
    }
  }
  fields.push(value);
  return fields;
}

// Where the record starting at `start` ends: the first line break that is not inside a quoted field.
function findRecordEnd(bytes: Uint8Array, start: number): number {
  let quoted = false;
  let atFieldStart = true;
  for (let index = start; index < bytes.length; index++) {
    const byte = bytes[index];
    if (quoted) {
      if (byte === QUOTE) {
        if (bytes[index + 1] === QUOTE) {
          index += 1;
        } else {
          quoted = false;
        }
      }
    } else if (byte === QUOTE && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (byte === COMMA) {
      atFieldStart = true;
    } else if (byte === NEWLINE) {
      return index;
    } else {
      atFieldStart = false;
    }
  }
  return bytes.length;
}

// Reads the record at `start` into `record`. Decoding a line at a time rather than the whole
// snapshot at once is what keeps the memory flat: a field the run builder keeps is a view on its own
// ~200 byte line, not on the 2 MB snapshot text it came from.
function readRecord(
  bytes: Uint8Array,
  start: number,
  decoder: TextDecoder,
  record: CsvRecord,
): void {
  let stop = bytes.indexOf(NEWLINE, start);
  if (stop === -1) {
    stop = bytes.length;
  }
  const end =
    stop > start && bytes[stop - 1] === CARRIAGE_RETURN ? stop - 1 : stop;
  const line = decoder.decode(bytes.subarray(start, end));
  record.starts.length = 0;
  if (line.includes('"')) {
    const recordEnd = findRecordEnd(bytes, start);
    record.line = "";
    record.fields = splitQuotedRecord(
      decoder.decode(bytes.subarray(start, recordEnd)),
    );
    record.next = recordEnd + 1;
  } else {
    record.line = line;
    record.fields = null;
    record.next = stop + 1;
    for (let from = 0; ; ) {
      record.starts.push(from);
      const comma = line.indexOf(",", from);
      if (comma === -1) {
        break;
      }
      from = comma + 1;
    }
    record.starts.push(line.length + 1);
  }
}

// One snapshot CSV. The date is the one the most rows claim, so a handful of stale rows cannot
// misfile the day; a later row for a job replaces an earlier one.
function parseSnapshot(bytes: Uint8Array): ParsedSnapshot {
  const rows = new Map<string, SnapshotRow>();
  const decoder = new TextDecoder();
  if (bytes.length === 0) {
    return { csvDate: null, rows };
  }
  const record: CsvRecord = { line: "", starts: [], fields: null, next: 0 };
  readRecord(bytes, 0, decoder, record);
  const header = recordFields(record);
  const columns = resolveHeader(header);
  if (columns.job < 0) {
    throw new Error(`no job column in header: ${header.slice(0, 5).join(",")}`);
  }
  const votes = new Map<string, number>();
  // Nearly every row of a snapshot repeats the same Current Date, so the last one parsed is worth
  // remembering: it turns one date parse per row into one per distinct date.
  let lastRaw = "";
  let lastDate: string | null = null;
  let cursor = record.next;
  while (cursor < bytes.length) {
    readRecord(bytes, cursor, decoder, record);
    cursor = record.next;
    const job = normalizeJob(field(record, columns.job));
    if (job === "") {
      continue;
    }
    rows.set(job, {
      bin: field(record, columns.bin),
      street: field(record, columns.street),
      houseNumber: field(record, columns.houseNumber),
      linearFeet: field(record, columns.linearFeet),
      lat: field(record, columns.lat),
      lng: field(record, columns.lng),
      boroughDigit: field(record, columns.boroughDigit),
      block: field(record, columns.block),
      lot: field(record, columns.lot),
    });
    const raw = field(record, columns.currentDate);
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastDate = parseSnapshotDate(raw);
    }
    if (lastDate !== null) {
      votes.set(lastDate, (votes.get(lastDate) ?? 0) + 1);
    }
  }
  let csvDate: string | null = null;
  let best = 0;
  for (const [stamp, count] of votes) {
    if (count > best) {
      csvDate = stamp;
      best = count;
    }
  }
  return { csvDate, rows };
}

// A commit that carries a snapshot, paired with the blob it carries.
export interface SnapshotSource {
  blob: string;
  commitDate: string; // the commit's own UTC date, the fallback when the CSV carries none
}

// The commit-to-blob table package.json resolves before the walk starts, as `git cat-file
// --batch-check` answered it: one line per commit and candidate path, in commit order, reading
// "<blob> blob <commit sha> <commit seconds>" for a path that commit carries and "<commit sha>:<path>
// missing" for one it does not. A commit is read from the FIRST path it carries — 747 of them carry
// both, having kept the old copy beside the new one when the snapshot moved into data/ — so which
// paths the log names, and in which order, is package.json's to say and is not repeated here.
//
// `readFrom` drops everything before that day, which is how an update reads a month of history rather
// than nine years of it. It takes the whole run of commits from the first one that reaches the day
// rather than filtering by date, because a commit stamp can fall before the one committed ahead of it
// and a filter would leave a hole where the walk needs a stretch.
export function readSnapshotIndex(
  text: string,
  readFrom?: string,
): SnapshotSource[] {
  const sources: SnapshotSource[] = [];
  let taken = ""; // the commit the last source came from, so a second path it carries is skipped
  for (const line of text.split("\n")) {
    const [blob, kind, commit, seconds] = line.split(" ");
    if (kind !== "blob") {
      // "missing" is a path the commit does not carry, and the empty line is the one the file ends
      // with. Anything else is a git that answered something this cannot read.
      if (kind !== "missing" && line !== "") {
        throw new Error(`git cat-file --batch-check answered "${line}"`);
      }
    } else if (commit !== taken) {
      const stamp = new Date(Number(seconds) * 1000);
      if (Number.isNaN(stamp.getTime())) {
        throw new Error(`git cat-file --batch-check answered "${line}"`);
      }
      taken = commit;
      sources.push({ blob, commitDate: stamp.toISOString().slice(0, 10) });
    }
  }
  if (readFrom === undefined) {
    return sources;
  }
  const pivot = sources.findIndex((source) => source.commitDate >= readFrom);
  return pivot === -1 ? [] : sources.slice(pivot);
}

export async function loadSnapshotIndex(
  path: string,
  readFrom?: string,
): Promise<SnapshotSource[]> {
  return readSnapshotIndex(await readFile(path, "utf-8"), readFrom);
}

// What the pipeline package.json puts a shed script at the END of reads: the commit index git
// resolved, named as the script's first argument, and the blobs git is piping into its stdin.
// `readFrom` has to be the day package.json handed `scripts/shed-blobs.ts`, because that is what
// decided which blobs are in the stream — a script reading further back would wait for one nobody
// asked git for.
export async function shedSnapshots(
  script: string,
  readFrom?: string,
): Promise<{
  sources: SnapshotSource[];
  blobs: AsyncIterable<Uint8Array>;
}> {
  const index = process.argv[2];
  if (index === undefined || process.stdin.isTTY === true) {
    throw new Error(
      `${script} reads the DOB snapshots off a git pipeline: run \`bun run ${script}\`, which is` +
        " where package.json clones the feed, resolves the commit index and streams the blobs",
    );
  }
  return {
    sources: await loadSnapshotIndex(index, readFrom),
    blobs: process.stdin,
  };
}

// Every blob the walk has to be sent, in the order it first needs one. Distinct, because the feed
// commits a CSV it did not change often enough that 3,623 snapshot-carrying commits name 2,614
// different blobs, and asking for each one once is 4.6 GB down the pipe rather than 7.5 GB.
export function distinctBlobs(sources: readonly SnapshotSource[]): string[] {
  const blobs: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!seen.has(source.blob)) {
      seen.add(source.blob);
      blobs.push(source.blob);
    }
  }
  return blobs;
}

// The blobs `git cat-file --batch` writes back, in the order they were asked for. Each record is a
// "<sha> blob <size>" line, the bytes, and a newline; the bytes are yielded as they arrive so the
// several gigabytes of history never sit in memory at once. Every blob is handed back in the same
// reused buffer, so it is only valid until the next one is asked for.
//
// The sha on each record is checked against the blob it should be answering. That is what stands in
// for a failed stage of the pipeline being noticed: a pipeline exits with the status of its LAST
// command, so git dying halfway would otherwise reach the walk as a history that simply stopped.
async function* readBlobs(
  stream: AsyncIterable<Uint8Array>,
  blobs: readonly string[],
): AsyncGenerator<Uint8Array> {
  const chunks: AsyncIterator<Uint8Array> = stream[Symbol.asyncIterator]();
  const queue: Uint8Array[] = [];
  let queued = 0;
  let read = 0;

  async function pull(): Promise<void> {
    const next = await chunks.next();
    if (next.done === true) {
      throw new Error(
        `the snapshot stream ended after ${read}/${blobs.length} blobs:` +
          " `git cat-file --batch` did not write the history out",
      );
    }
    queue.push(next.value);
    queued += next.value.length;
  }

  // Moves `size` bytes out of the queue, into `into` when there is one and nowhere when there is not.
  function take(size: number, into: Uint8Array | null): void {
    let filled = 0;
    while (filled < size) {
      const head = queue[0];
      const wanted = Math.min(head.length, size - filled);
      if (into !== null) {
        into.set(head.subarray(0, wanted), filled);
      }
      if (wanted === head.length) {
        queue.shift();
      } else {
        queue[0] = head.subarray(wanted);
      }
      filled += wanted;
    }
    queued -= size;
  }

  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  for (let index = 0; index < blobs.length; index++) {
    let lineEnd = -1;
    while (lineEnd === -1) {
      let scanned = 0;
      for (const chunk of queue) {
        const at = chunk.indexOf(NEWLINE);
        if (at !== -1) {
          lineEnd = scanned + at;
          break;
        }
        scanned += chunk.length;
      }
      if (lineEnd === -1) {
        await pull();
      }
    }
    const header = new Uint8Array(lineEnd);
    take(lineEnd, header);
    take(1, null);
    const line = decoder.decode(header);
    const [sha, kind, bytes] = line.split(" ");
    const size = Number(bytes);
    if (sha !== blobs[index] || kind !== "blob" || !Number.isFinite(size)) {
      throw new Error(
        `git cat-file --batch answered "${line}" where blob ${blobs[index]} was asked for`,
      );
    }
    while (queued < size + 1) {
      await pull();
    }
    if (buffer.length < size) {
      buffer = new Uint8Array(size);
    }
    take(size, buffer);
    take(1, null);
    read += 1;
    yield buffer.subarray(0, size);
  }
}

// A shed's presence run while it is still standing: the first and last day it was seen.
interface OpenRun {
  first: string;
  last: string;
}

interface RunTracker {
  order: string[]; // every job, in the order the feed first mentioned it
  open: Map<string, OpenRun>;
  closed: Map<string, ShedInterval[]>;
  // What the placement reads for the job as the feed has it now. The object is replaced only when
  // one of its fields changes, so two intervals share it exactly when they place the same way and
  // the placement can be run once per distinct object rather than once per record.
  attributes: Map<string, ShedAttributes>;
  houseNumbers: Map<string, string>; // the last one the feed gave, which nothing is placed against
  located: Map<string, SnapshotRow>; // the last row that gave the job a block and lot
  corrected: Set<string>; // jobs whose placement-bearing fields the feed has changed since
}

function closeRun(
  tracker: RunTracker,
  job: string,
  run: OpenRun,
  open: boolean,
): void {
  const intervals = tracker.closed.get(job);
  // The attributes in force on the run's last day, which are the ones it is placed from forever
  // after: the job has not been in a snapshot since, so nothing has changed them.
  const interval: ShedInterval = {
    first: run.first,
    last: run.last,
    open,
    attributes: tracker.attributes.get(job)!,
  };
  if (intervals === undefined) {
    tracker.closed.set(job, [interval]);
  } else {
    intervals.push(interval);
  }
}

// One row as the placement reads it. The block and lot come from the last row that CARRIED them
// rather than from this one, so a day the feed leaves them blank is not a change of address.
function attributesOf(
  row: SnapshotRow,
  located: SnapshotRow | undefined,
): ShedAttributes {
  return {
    bin: row.bin,
    street: row.street,
    linearFeet: toNumber(row.linearFeet),
    lat: toCoordinate(row.lat),
    lng: toCoordinate(row.lng),
    boroughDigit: located?.boroughDigit ?? "",
    block: located?.block ?? "",
    lot: located?.lot ?? "",
  };
}

// Whether two readings would put the shed in the same place. `Object.is` for the length, so a permit
// the feed gives no linear feet — NaN — compares equal to itself.
function sameAttributes(left: ShedAttributes, right: ShedAttributes): boolean {
  return (
    left.bin === right.bin &&
    left.street === right.street &&
    Object.is(left.linearFeet, right.linearFeet) &&
    left.lat === right.lat &&
    left.lng === right.lng &&
    left.boroughDigit === right.boroughDigit &&
    left.block === right.block &&
    left.lot === right.lot
  );
}

// Folds one day into the runs: a job present opens or extends its run, a job absent ends it.
function applySnapshot(tracker: RunTracker, snapshot: DatedSnapshot): void {
  for (const [job, row] of snapshot.rows) {
    if (row.block !== "" && row.lot !== "") {
      tracker.located.set(job, row);
    }
    tracker.houseNumbers.set(job, row.houseNumber);
    const attributes = attributesOf(row, tracker.located.get(job));
    const previous = tracker.attributes.get(job);
    if (previous === undefined) {
      tracker.order.push(job);
      tracker.attributes.set(job, attributes);
    } else if (!sameAttributes(previous, attributes)) {
      tracker.attributes.set(job, attributes);
      tracker.corrected.add(job);
    }
    const run = tracker.open.get(job);
    if (run === undefined) {
      tracker.open.set(job, { first: snapshot.date, last: snapshot.date });
    } else {
      run.last = snapshot.date;
    }
  }
  for (const [job, run] of tracker.open) {
    if (!snapshot.rows.has(job)) {
      tracker.open.delete(job);
      closeRun(tracker, job, run, false);
    }
  }
}

// Runs separated by a short gap are one shed: the later run's attributes and open flag win, which is
// what makes the merged record describe the shed as the feed last knew it.
export function mergeIntervals(
  intervals: readonly ShedInterval[],
): ShedInterval[] {
  if (intervals.length === 0) {
    // A permit the durable record still holds the geometry of, whose only sighting a later walk has
    // since judged a truncated snapshot. It stands nowhere and no day sees it.
    return [];
  }
  const merged: ShedInterval[] = [];
  let current = intervals[0];
  for (const next of intervals.slice(1)) {
    if (daysBetween(current.last, next.first) <= MERGE_TOLERANCE_DAYS) {
      current = {
        first: current.first,
        last: next.last,
        open: next.open,
        attributes: next.attributes,
      };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

// The snapshots waiting to be judged. The judgement itself reads only the 30 days BEFORE the one at
// the head, whose row counts are all that is kept of them; the queue exists to file a snapshot under
// the day it claims and to let a later commit for a day replace an earlier one.
interface SnapshotWindow {
  pending: DatedSnapshot[];
  before: number[]; // the row counts of the 30 most recently judged days
  judged: string; // the last day judged, after which a snapshot for that day is too late
  seed: readonly number[]; // the counts this walk was handed, for the ones it hands on in turn
  tail: DayCount[]; // the last JUDGED_TAIL of the days it judged itself
  kept: number;
  dropped: number;
  stale: number;
  firstDate: string;
  lastDate: string;
}

// One judged day's row count, dated so the next walk can be handed the counts from before the day it
// picks up at rather than the ones from before the day this walk stopped at.
export interface DayCount {
  date: string;
  rows: number;
}

function judgeSnapshot(
  window: SnapshotWindow,
  emit: (snapshot: DatedSnapshot) => void,
): void {
  const snapshot = window.pending[0];
  const neighbours = window.before.slice();
  neighbours.sort((left, right) => left - right);
  const median =
    neighbours.length === 0 ? 0 : neighbours[Math.floor(neighbours.length / 2)];
  if (median !== 0 && snapshot.rows.size < TRUNCATION_RATIO * median) {
    window.dropped += 1;
  } else {
    if (window.kept === 0) {
      window.firstDate = snapshot.date;
    }
    window.lastDate = snapshot.date;
    window.kept += 1;
    emit(snapshot);
  }
  // Dropped or kept, the day counts as a neighbour: the rule asks what a snapshot looked like beside
  // the ones around it, and a walk that left the truncated ones out would judge the next one against
  // a window that depends on its own earlier verdicts.
  window.judged = snapshot.date;
  window.pending.shift();
  window.before.push(snapshot.rows.size);
  if (window.before.length > TRUNCATION_NEIGHBOURS) {
    window.before.shift();
  }
  window.tail.push({ date: snapshot.date, rows: snapshot.rows.size });
  if (window.tail.length > JUDGED_TAIL) {
    window.tail.shift();
  }
}

// Files a snapshot under the day it describes and judges whatever the window is now deep enough to
// judge. A later commit for a day still pending replaces it, which is how the several commits a day
// the repo often has collapse to one snapshot.
function acceptSnapshot(
  window: SnapshotWindow,
  snapshot: DatedSnapshot,
  emit: (snapshot: DatedSnapshot) => void,
): void {
  if (snapshot.date <= window.judged) {
    window.stale += 1;
    return;
  }
  let index = window.pending.length - 1;
  while (index >= 0 && window.pending[index].date > snapshot.date) {
    index -= 1;
  }
  if (index >= 0 && window.pending[index].date === snapshot.date) {
    window.pending[index] = snapshot;
  } else {
    window.pending.splice(index + 1, 0, snapshot);
  }
  while (window.pending.length > TRUNCATION_NEIGHBOURS) {
    judgeSnapshot(window, emit);
  }
}

export interface ShedWalk {
  permits: ShedPermit[];
  lastDay: string; // the newest usable snapshot; every run reaches it or ended before it
  // The row counts a walk resuming at `resumeFrom(lastDay)` has to seed its truncation window with.
  counts: number[];
}

// The walk with the git reading taken out: a fold over dated snapshots, in ascending order. Where
// they come from is not its problem, which is what lets the windowing properties be tested against a
// handful of days rather than against a 370 MB clone.
export interface ShedFold {
  tracker: RunTracker;
  window: SnapshotWindow;
  applyFrom: string; // "" reads the whole history; earlier snapshots are dropped unread
}

// `before` is the truncation window the walk starts holding, which a windowed walk takes from the
// artifact it is updating: the first day it judges then sees the same neighbours a walk over the
// whole history would have given it, without reading a day of history to find out what they were.
export function startFold(
  applyFrom = "",
  before: readonly number[] = [],
): ShedFold {
  return {
    tracker: {
      order: [],
      open: new Map(),
      closed: new Map(),
      attributes: new Map(),
      houseNumbers: new Map(),
      located: new Map(),
      corrected: new Set(),
    },
    window: {
      pending: [],
      before: [...before],
      judged: "",
      seed: before,
      tail: [],
      kept: 0,
      dropped: 0,
      stale: 0,
      firstDate: "",
      lastDate: "",
    },
    applyFrom,
  };
}

// One day. A snapshot from before the window the artifact handed over is not read at all: judging it
// would push its row count onto a window that has already been seeded past it.
export function foldSnapshot(fold: ShedFold, snapshot: DatedSnapshot): void {
  if (snapshot.date < fold.applyFrom) {
    fold.window.stale += 1;
    return;
  }
  acceptSnapshot(fold.window, snapshot, (dated) => {
    applySnapshot(fold.tracker, dated);
  });
}

export function finishFold(fold: ShedFold): ShedWalk {
  const { tracker, window } = fold;
  while (window.pending.length > 0) {
    judgeSnapshot(window, (dated) => {
      applySnapshot(tracker, dated);
    });
  }
  for (const [job, run] of tracker.open) {
    closeRun(tracker, job, run, true);
  }
  const permits: ShedPermit[] = [];
  for (const job of tracker.order) {
    const runs = tracker.closed.get(job)!;
    permits.push({
      ...tracker.attributes.get(job)!,
      job,
      houseNumber: tracker.houseNumbers.get(job)!,
      runs,
      intervals: mergeIntervals(runs),
      corrected: tracker.corrected.has(job),
    });
  }
  // The counts the next walk picks up with are the ones from before the day IT starts at, not from
  // before the day this one stopped at: the two overlap by the renewal tolerance, and those days are
  // judged again from the same window rather than taken on trust. A walk of its own window judges too
  // few days to fill thirty, so what it was handed carries on past it.
  // A walk that kept no snapshot at all has no day to resume from, and hands on what it was handed.
  const resume = window.lastDate === "" ? "" : resumeFrom(window.lastDate);
  const counts = [
    ...window.seed,
    ...window.tail
      .filter((judged) => judged.date < resume)
      .map((judged) => judged.rows),
  ].slice(-TRUNCATION_NEIGHBOURS);
  // The day is the SNAPSHOT's, never the day the job ran: a feed that has published nothing since
  // Tuesday leaves Tuesday behind, and Friday's run picks up from there rather than from Thursday.
  return { permits, lastDay: window.lastDate, counts };
}

// Turns the snapshots `git cat-file --batch` is streaming into one record per shed permit, in the
// order the feed first mentioned them. `sources` says which blob every commit carries and is what the
// stream has to answer with, in that order and once per distinct blob. With `applyFrom` only the
// snapshots from that day onward are folded, and `before` is the truncation window the artifact it is
// updating carried away, which is what lets it judge that first day the same way a walk over the
// whole history would.
export async function readShedPermits(
  sources: readonly SnapshotSource[],
  stream: AsyncIterable<Uint8Array>,
  applyFrom?: string,
  before: readonly number[] = [],
): Promise<ShedWalk> {
  if (sources.length === 0) {
    // Nothing upstream can report a failure of its own: a shell pipeline exits with the status of its
    // last command, and an empty index reaches this far as a feed that published nothing at all.
    throw new Error(
      "the commit index names no DOB snapshot at all: the git half of the pipeline resolved" +
        " nothing, so there is no history to walk",
    );
  }
  const blobOrder = distinctBlobs(sources);
  const lastUse = new Map<string, number>();
  for (const [position, source] of sources.entries()) {
    lastUse.set(source.blob, position);
  }
  console.error(
    `  ${sources.length} commits carry a snapshot, ${blobOrder.length} distinct blobs`,
  );

  const fold = startFold(applyFrom, before);
  // A blob is parsed the first time a commit points at it and held only while a later commit still
  // does, which for this history is never more than a handful at a time.
  const parsed = new Map<string, ParsedSnapshot>();
  const blobs = readBlobs(stream, blobOrder);
  for (const [position, source] of sources.entries()) {
    const cached = parsed.get(source.blob);
    let snapshot: ParsedSnapshot;
    if (cached !== undefined) {
      snapshot = cached;
      if (lastUse.get(source.blob) === position) {
        parsed.delete(source.blob);
      }
    } else {
      const next = await blobs.next();
      if (next.done === true) {
        throw new Error(`git cat-file --batch stopped at blob ${source.blob}`);
      }
      snapshot = parseSnapshot(next.value);
      if (lastUse.get(source.blob) !== position) {
        parsed.set(source.blob, snapshot);
      }
    }
    if (snapshot.rows.size > 0) {
      foldSnapshot(fold, {
        date: snapshot.csvDate ?? source.commitDate,
        rows: snapshot.rows,
      });
    }
    if ((position + 1) % PROGRESS_INTERVAL === 0) {
      console.error(
        `  read ${position + 1}/${sources.length} snapshots, ${fold.tracker.open.size} sheds standing on ${fold.window.lastDate}`,
      );
    }
  }
  const walk = finishFold(fold);
  const { window } = fold;
  console.error(
    `  ${window.kept} usable dated snapshots ${window.firstDate}..${window.lastDate}` +
      ` (${window.dropped} truncated dropped, ${window.stale} stale)`,
  );
  return walk;
}

if (import.meta.main) {
  const started = performance.now();
  const { sources, blobs } = await shedSnapshots("shed-walk");
  const { permits } = await readShedPermits(sources, blobs);
  let intervals = 0;
  let open = 0;
  for (const permit of permits) {
    intervals += permit.intervals.length;
    open += permit.intervals.filter((interval) => interval.open).length;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `sheds: ${permits.length} permits, ${intervals} intervals, ${open} standing today, in ${seconds}s`,
  );
}
