// The daily update (scripts/update-sheds.ts), over a feed small enough to reason about.
//
// The job keeps no state outside the artifact, so everything it does rests on three things being
// true of it: that its records are in an order the DOB's own CSVs can reproduce, that a record it
// carries forward untouched is one no later snapshot could have changed, and that the truncation
// window it hands on is the one the next run would have found for itself. Those are the properties
// pinned here, and the one they add up to — that the artifact is a function of the day it was built
// through and of nothing else, so an update from any starting point lands on a full rebuild's bytes.
// Running after a long silence and running twice in one day are corollaries. Cron is best-effort,
// GitHub switches a schedule off after sixty days of repository quiet, and the DOB's own feed has 74
// gaps in it, so "diff against yesterday" is not something this job is allowed to assume.
//
// Checked against a synthetic feed rather than the real one, which is a 370 MB clone and a two-minute
// walk. `scripts/shed-permits.ts` exposes the fold with the git reading taken out, so the days can
// just be handed to it: a permit that vanishes for a week and comes back inside the renewal tolerance,
// one that really comes down, one that comes back long after it did with a length the feed has
// corrected in the meantime, one that comes down between the two runs, one first seen in the last few
// days, a day the feed publishes nothing at all, and a truncated write.

import { expect, test } from "bun:test";
import {
  byJobNumber,
  encodedShedsOf,
  isProvisional,
  placementAttributes,
} from "../../scripts/build-sheds";
import {
  decodeShedArtifact,
  type EncodedShed,
  encodeSheds,
  shedDayOf,
  shedGraphMismatch,
} from "../../scripts/shed-encode";
import {
  type DatedSnapshot,
  finishFold,
  foldSnapshot,
  MERGE_TOLERANCE_DAYS,
  mergeIntervals,
  resumeFrom,
  type ShedAttributes,
  type ShedInterval,
  type ShedPermit,
  type ShedWalk,
  type SnapshotRow,
  startFold,
  TRUNCATION_NEIGHBOURS,
} from "../../scripts/shed-permits";
import { reconcileSheds, standingOn } from "../../scripts/update-sheds";

const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2020, 0, 1);
const DAYS = 120;
const FILLERS = 20; // permits that are simply always there, so the row count has a stable median
const TRUNCATED_DAY = 85; // a partial write: two rows where there should be two dozen
const SILENT_DAY = 90; // the feed publishes nothing, which is not a day every shed came down
const GRAPH_HASH = "a362598948ca0eb3";

function isoDay(day: number): string {
  return new Date(START_MS + day * DAY_MS).toISOString().slice(0, 10);
}

// The feed's own day 0 is 2020-01-01 and the artifact counts from 2017-12-28, so a day number read
// back out of a header has to come back through the calendar.
function feedDay(shedDay: number): number {
  return shedDay - shedDayOf(isoDay(0));
}

// Every permit the feed carries, named here for what it does to the walk. `open.bin` names its
// records by job number, so the feed's own have to be shaped like the DOB's: a nine-digit BIS number
// for the first, which the artifact has to be able to name too, and DOB NOW numbers for the rest.
const PERMITS = [
  "always",
  "brief",
  "ending",
  "flapping",
  "late",
  "returning",
  ...Array.from({ length: FILLERS }, (_, filler) => `filler${filler}`),
];

function jobFor(name: string): string {
  const order = PERMITS.indexOf(name);
  if (order < 0) {
    throw new Error(`${name} is not one of the feed's permits`);
  } else if (order === 0) {
    return "104416464";
  } else {
    return `M${String(1_000 + order).padStart(8, "0")}-I1`;
  }
}

function rowFor(job: string, feet: number): SnapshotRow {
  return {
    bin: `10000${job.length.toString().padStart(2, "0")}`,
    street: `${job.toUpperCase()} STREET`,
    houseNumber: "100",
    linearFeet: String(feet),
    lat: "40.712345",
    lng: "-74.005678",
    boroughDigit: "1",
    block: "01234",
    lot: "0001",
  };
}

// Which permits the feed carries on a given day, or nothing at all on the day it publishes nothing.
function snapshotFor(day: number): DatedSnapshot | null {
  if (day === SILENT_DAY) {
    return null;
  }
  const names = day === TRUNCATED_DAY ? ["always", "filler0"] : ["always"];
  if (day !== TRUNCATED_DAY) {
    for (let filler = 0; filler < FILLERS; filler++) {
      names.push(`filler${filler}`);
    }
    if (day <= 20 || day >= 30) {
      names.push("flapping"); // nine days away, well inside the fortnight the merge forgives
    }
    if (day <= 10) {
      names.push("brief"); // this one really did come down
    }
    if (day <= 60 || day >= 100) {
      names.push("returning"); // and this one came back, far too late to be the same shed
    }
    if (day <= 95) {
      names.push("ending"); // still up when a rewound artifact was written, down by the time it updates
    }
    if (day >= 118) {
      names.push("late"); // first seen inside the window the update re-derives
    }
  }
  const rows = new Map<string, SnapshotRow>();
  for (const name of names) {
    // The feed corrects one standing permit's length halfway through, which the walk has to carry
    // forward, and gives another a new one only after an earlier stint of its has closed — which is
    // the correction a record already in `closed.bin` must NOT move with.
    const corrected =
      (name === "always" && day >= 40) || (name === "returning" && day >= 100);
    rows.set(jobFor(name), rowFor(jobFor(name), corrected ? 88 : 40));
  }
  return { date: isoDay(day), rows };
}

const feed = Array.from({ length: DAYS }, (_, day) => snapshotFor(day));

// The permits the feed mentions between `from` and `through`, in the artifact's own order, with the
// truncation window the walk carries away. `from` is "" for a walk over the whole feed and a day for
// the window an update reads, and `before` is the window the artifact it is updating handed over.
function walk(through: number, from = "", before: number[] = []): ShedWalk {
  const fold = startFold(from, before);
  for (const snapshot of feed.slice(0, through + 1)) {
    if (snapshot !== null) {
      foldSnapshot(fold, snapshot);
    }
  }
  const walked = finishFold(fold);
  walked.permits.sort(byJobNumber);
  return walked;
}

// A reading's spans, standing in for the tax map and the placement: two per record, derived from the
// street and the length, so a record placed from a corrected reading can be told from one that kept
// the reading its own stint ended under.
function coverageOf(attributes: ShedAttributes): {
  spans: {
    sourceId: number;
    side: number;
    ordinal: number;
    t0: number;
    t1: number;
    depth: number;
  }[];
  confidence: number;
} {
  let hash = 0;
  for (const character of `${attributes.street}/${attributes.linearFeet}`) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_000;
  }
  return {
    spans: [
      { sourceId: hash, side: 1, ordinal: 0, t0: 10, t1: 200, depth: 0 },
      {
        sourceId: hash + 7,
        side: 3,
        ordinal: 1,
        t0: 0,
        t1: 255,
        depth: 18 + (hash % 62),
      },
    ],
    confidence: 128 + (hash % 100),
  };
}

// The artifact a full rebuild would write for the feed up to `through`.
function build(through: number) {
  const { permits, counts } = walk(through);
  const day = shedDayOf(isoDay(through));
  return encodeSheds(
    encodedShedsOf(permits, (interval) => coverageOf(interval.attributes), day),
    GRAPH_HASH,
    day,
    counts,
  );
}

// The artifact after an update from `from` to `through`, which is what the daily job does: the same
// window, the same seeded truncation rule, and a parcel read for every permit the artifact has never
// placed and every one whose reading the feed has corrected since.
function update(from: ReturnType<typeof build>, through: number) {
  const artifact = decodeShedArtifact(from.open, from.closed);
  const reached = feedDay(artifact.lastDay);
  const { permits, counts } = walk(
    through,
    resumeFrom(isoDay(reached)),
    artifact.counts,
  );
  const standing = new Set(
    standingOn(permits, isoDay(reached)).map((permit) => permit.job),
  );
  const fresh = permits.filter(
    (permit) => !standing.has(permit.job) || permit.corrected,
  );
  const placed = new Map(
    placementAttributes(fresh).map((reading) => [reading, coverageOf(reading)]),
  );
  const day = shedDayOf(isoDay(through));
  return encodeSheds(
    reconcileSheds(artifact, permits, isoDay(through), placed),
    GRAPH_HASH,
    day,
    counts,
  );
}

// An interval as the feed's own days, without the reading frozen on it.
function days(intervals: readonly ShedInterval[]) {
  return intervals.map(({ first, last, open }) => ({ first, last, open }));
}

test("the synthetic feed carries the traps it is meant to", () => {
  const byJob = new Map(
    walk(DAYS - 1).permits.map((permit) => [permit.job, permit]),
  );

  // A day the feed publishes nothing is not a day every shed came down, and a truncated write is
  // dropped rather than believed — either read literally would close every standing permit. The
  // truncation rule sees only the thirty days BEFORE each one, and still catches this.
  expect(days(byJob.get(jobFor("always"))?.runs ?? [])).toEqual([
    { first: isoDay(0), last: isoDay(DAYS - 1), open: true },
  ]);
  expect(byJob.get(jobFor("filler1"))?.runs).toHaveLength(1);

  // A nine-day disappearance is two runs on record but one standing shed to a query.
  expect(byJob.get(jobFor("flapping"))?.runs).toHaveLength(2);
  expect(
    days(mergeIntervals(byJob.get(jobFor("flapping"))?.runs ?? [])),
  ).toEqual([{ first: isoDay(0), last: isoDay(DAYS - 1), open: true }]);
  // A permit that really did come down stays down, and one that came back far later is two sheds.
  expect(days(mergeIntervals(byJob.get(jobFor("brief"))?.runs ?? []))).toEqual([
    { first: isoDay(0), last: isoDay(10), open: false },
  ]);
  const returning = mergeIntervals(byJob.get(jobFor("returning"))?.runs ?? []);
  expect(returning).toHaveLength(2);
  // The correction to a permit's length is the one the record ends up with, and the one an interval
  // that had already ended when it arrived does NOT.
  expect(byJob.get(jobFor("always"))?.linearFeet).toBe(88);
  expect(byJob.get(jobFor("returning"))?.linearFeet).toBe(88);
  expect(returning.map((interval) => interval.attributes.linearFeet)).toEqual([
    40, 88,
  ]);
});

test("open.bin names every standing permit, in job order", () => {
  // The load-bearing property: the update reads which record belongs to which permit out of the
  // file, and the feed's own answer only has to agree with it.
  const through = DAYS - 1;
  const { permits } = walk(through);
  const day = shedDayOf(isoDay(through));
  const standing = standingOn(permits, isoDay(through));
  const artifact = decodeShedArtifact(
    build(through).open,
    build(through).closed,
  );

  expect(standing.map((permit) => permit.job)).toEqual(
    [...standing].map((permit) => permit.job).sort(),
  );
  expect(artifact.open).toHaveLength(standing.length);
  for (const [order, permit] of standing.entries()) {
    const { spans, confidence } = coverageOf(permit);
    // Both shapes of job number survive the round trip through the header's delta chain.
    expect(artifact.open[order].job).toBe(permit.job);
    expect(artifact.open[order].spans).toEqual(spans);
    expect(artifact.open[order].confidence).toBe(confidence);
  }
  expect(artifact.open.map((record) => record.job)).toContain("104416464");
  // And every record in the file is one an interval reaching the last few days put there.
  for (const permit of permits) {
    const provisional = mergeIntervals(permit.runs).filter((interval) =>
      isProvisional(shedDayOf(interval.last), day),
    );
    expect(provisional.length).toBe(standing.includes(permit) ? 1 : 0);
  }
});

test("a standing permit open.bin does not name stops the run", () => {
  // The names are the mapping now, so the feed's own answer is free to be a check — and this is the
  // case it exists for: a record missing from the file would otherwise be placed again as if it were
  // new, with the first day the replay window can see rather than the one it really went up.
  const artifact = decodeShedArtifact(
    build(DAYS - 1).open,
    build(DAYS - 1).closed,
  );
  const short = {
    ...artifact,
    open: artifact.open.filter((record) => record.job !== jobFor("flapping")),
  };

  expect(() =>
    reconcileSheds(short, walk(DAYS - 1).permits, isoDay(DAYS - 1), new Map()),
  ).toThrow(jobFor("flapping"));
});

// THE invariant, and the reason for both pieces of state the artifact carries: what the job writes
// is a function of the day it is built through and nothing else. Not of when it last ran, not of how
// far back the replay that produced it started. The real feed says the same thing — a 300-day, a
// 177-day, a 60-day and a 29-day chain of daily `update-sheds` runs all land on the same bytes as a
// full `build-sheds` — but that takes a 370 MB clone and half an hour, and this takes a millisecond.
test("an update lands on a full rebuild wherever the replay started", () => {
  const rebuilt = build(DAYS - 1);

  for (const start of [DAYS - 5, DAYS - 20, DAYS - 45, DAYS - 80]) {
    let replayed = build(start);
    for (let day = start + 1; day < DAYS; day++) {
      replayed = update(replayed, day);
    }
    expect({ start, ...replayed }).toEqual({ start, ...rebuilt });
  }
});

test("the truncation window travels in the artifact", () => {
  // A run picks the feed up a fortnight behind the day it reached, so the first day it judges is the
  // one the artifact's window was cut off before. Point that at the feed's truncated write: judged
  // against its thirty neighbours it is dropped, and judged against nothing at all — which is what a
  // walk that had to rediscover its own window would start with — it is believed.
  const artifact = decodeShedArtifact(
    build(TRUNCATED_DAY + MERGE_TOLERANCE_DAYS - 1).open,
    build(TRUNCATED_DAY + MERGE_TOLERANCE_DAYS - 1).closed,
  );
  expect(artifact.counts).toHaveLength(TRUNCATION_NEIGHBOURS);
  expect(resumeFrom(isoDay(TRUNCATED_DAY + MERGE_TOLERANCE_DAYS - 1))).toBe(
    isoDay(TRUNCATED_DAY),
  );

  const seeded = startFold(isoDay(TRUNCATED_DAY), artifact.counts);
  const blind = startFold(isoDay(TRUNCATED_DAY));
  for (const fold of [seeded, blind]) {
    for (const snapshot of feed) {
      if (snapshot !== null) {
        foldSnapshot(fold, snapshot);
      }
    }
    finishFold(fold);
  }
  expect(seeded.window.dropped).toBe(1);
  expect(blind.window.dropped).toBe(0);
});

test("catching up after a month idle lands where running daily would have", () => {
  const daily = build(DAYS - 1);
  const caughtUp = update(build(DAYS - 31), DAYS - 1);

  expect(caughtUp.open).toEqual(daily.open);
  expect(caughtUp.closed).toEqual(daily.closed);
  expect(caughtUp.index).toEqual(daily.index);
});

test("an update applied a day at a time agrees with one that jumped", () => {
  let stepped = build(DAYS - 31);
  for (let day = DAYS - 30; day < DAYS; day++) {
    stepped = update(stepped, day);
  }
  const jumped = update(build(DAYS - 31), DAYS - 1);

  expect(stepped.open).toEqual(jumped.open);
  expect(stepped.closed).toEqual(jumped.closed);
  expect(stepped.index).toEqual(jumped.index);
});

test("running twice in one day is a no-op", () => {
  const once = update(build(DAYS - 31), DAYS - 1);
  const twice = update(once, DAYS - 1);

  expect(twice.open).toEqual(once.open);
  expect(twice.closed).toEqual(once.closed);
  expect(twice.index).toEqual(once.index);
});

test("closed.bin is only ever appended to", () => {
  const before = decodeShedArtifact(
    build(DAYS - 31).open,
    build(DAYS - 31).closed,
  );
  const after = update(build(DAYS - 31), DAYS - 1);
  const grown = decodeShedArtifact(after.open, after.closed);

  expect(grown.closed.length).toBeGreaterThan(before.closed.length);
  expect(grown.closed.slice(0, before.closed.length)).toEqual(before.closed);
  // Which is only sound because nothing already down can close again later.
  const oldest = before.closed.map((record) => record.close as number);
  for (const record of grown.closed.slice(before.closed.length)) {
    expect(record.close as number).toBeGreaterThan(Math.max(...oldest));
  }
});

test("a permit that comes back long after it came down is a second record", () => {
  const artifact = decodeShedArtifact(
    build(DAYS - 1).open,
    build(DAYS - 1).closed,
  );
  const returning = walk(DAYS - 1).permits.find(
    (permit) => permit.job === jobFor("returning"),
  ) as ShedPermit;
  const intervals = mergeIntervals(returning.runs);

  // Two records, each placed from the reading its own stint ended under: the feed gave this permit a
  // new length when it came back, and the stint that had already closed keeps the old one.
  expect(intervals).toHaveLength(2);
  const records = [...artifact.open, ...artifact.closed];
  for (const interval of intervals) {
    const { spans } = coverageOf(interval.attributes);
    const found = records.filter(
      (record: EncodedShed) =>
        JSON.stringify(record.spans) === JSON.stringify(spans),
    );
    expect(found).toHaveLength(1);
    expect(found[0].first).toBe(shedDayOf(interval.first));
  }
});

test("an artifact is only extended against the graph it names", () => {
  const artifact = decodeShedArtifact(
    build(DAYS - 1).open,
    build(DAYS - 1).closed,
  );

  expect(shedGraphMismatch(artifact, GRAPH_HASH)).toBeNull();
  // The client resolves nothing against another graph, so a deploy that moved a graph input without
  // a re-place shows bare pavement. What must not happen next is the daily job carrying these
  // records forward under the new hash: that would put every one of them on whatever edge its key
  // now names, which is the failure the key design exists to rule out.
  const other = shedGraphMismatch(artifact, "0123456789abcdef");
  expect(other).toContain(GRAPH_HASH);
  expect(other).toContain("0123456789abcdef");
});
