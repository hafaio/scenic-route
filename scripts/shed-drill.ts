// `bun run shed-drill [job...]`: the append-only property of the shed artifact, measured
// against the real feed rather than a fixture.
//
// `closed.bin` is only append-only if a record is a function of ITS OWN permit and the graph — if
// what one permit places over depended on which other permits were in the run, then a daily job that
// appends today's permits would have written yesterday's records differently, and a chain of updates
// would not land on the bytes a full rebuild writes. So: build the record set from every permit,
// build it again with one permit dropped, and compare every surviving record's (first, close,
// confidence, spans), which is the whole of what the artifact stores. Only the dropped permit's own
// records may differ.
//
// The coupling this is looking for is not hypothetical. Placement reads the tax lot, and the tax lot
// is read from Socrata in batches of sorted keys: dropping a permit that is the only one to name its
// BBL shifts every batch boundary after it, which reorders the parts of unrelated lots and — before
// scripts/shed-parcels.ts sorted them — moved where their sheds started. Placement itself has been
// the other half: it once anchored to a graph EDGE rather than to the pavement, so a rebuild that cut
// a kerb into different edges moved the anchor. That is why the drill re-runs the whole pipeline
// below the permit walk, parcel fetch included, rather than re-placing the requests it already has.
//
// It reads public/routing/nyc.bin and the DOB snapshots package.json pipes in, so it is a by-hand
// check next to `bun run check-sheds` after a graph change, not part of `bun test src`.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { edgeName, type RoutingGraph } from "../src/routing/graph";
import {
  byJobNumber,
  encodedShedsOf,
  loadGraphBytes,
  parcelRequestsOf,
  placementAttributes,
  placeRecords,
  type ShedRecord,
  toConfidenceByte,
  toEncodedSpans,
  toShedRecord,
} from "./build-sheds";
import { type EncodedShed, shedDayOf } from "./shed-encode";
import {
  buildSidewalkIndex,
  type ShedPlacement,
  type SidewalkIndex,
} from "./shed-map";
import { bblOf, fetchShedParcels } from "./shed-parcels";
import {
  readShedPermits,
  type ShedAttributes,
  type ShedPermit,
  shedSnapshots,
} from "./shed-permits";

const GRAPH_PATH = join(
  import.meta.dirname,
  "..",
  "public",
  "routing",
  "nyc.bin",
);
// A run this long on one street is a superblock frontage rather than a townhouse's.
const LONG_RUN_METERS = 120;
// What a mid-block lot fronts: one street, one ordinary building's worth of it, and no length the
// placement had to throw away.
const MIDBLOCK_MIN_METERS = 15;
const MIDBLOCK_MAX_METERS = 45;
const MIDBLOCK_SLACK_METERS = 3;
const SHAPES = ["corner", "midblock", "superblock", "overdeclared"] as const;
type Shape = (typeof SHAPES)[number];

// One record as the artifact stores it. Two runs agree exactly when every surviving record's digest
// does.
function digestOf(record: EncodedShed): string {
  const spans = record.spans
    .map(
      (span) =>
        `${span.sourceId}/${span.side}/${span.ordinal}/${span.t0}-${span.t1}@${span.depth}`,
    )
    .join(" ");
  return `${record.first} ${record.close} ${record.confidence} [${spans}]`;
}

function digestsByJob(records: readonly EncodedShed[]): Map<string, string[]> {
  const byJob = new Map<string, string[]>();
  for (const record of records) {
    const digests = byJob.get(record.job);
    if (digests === undefined) {
      byJob.set(record.job, [digestOf(record)]);
    } else {
      digests.push(digestOf(record));
    }
  }
  return byJob;
}

interface RecordSet {
  digests: Map<string, string[]>;
  placements: Map<string, ShedPlacement[]>; // job -> one placement per interval
  // What each reading resolved to on the tax map, so a record that moved can be told from an input
  // that moved. The readings themselves are the same objects in every run, which is what lets this be
  // keyed on them.
  inputs: Map<ShedAttributes, string>;
}

// The lot and building a reading was placed from, as bytes.
function inputDigestOf(record: ShedRecord): string {
  const digest = createHash("sha256");
  for (const ring of [record.lot, record.footprint]) {
    digest.update(
      ring === null ? new Uint8Array(1) : new Uint8Array(ring.buffer),
    );
  }
  return `${record.street}|${record.linearFeet}|${record.lng},${record.lat}|${digest.digest("hex").slice(0, 16)}`;
}

// The whole of the build below the permit walk: the readings the permits need, the parcels those
// readings resolve to, the placement of each, and the records that come out.
async function recordSetOf(
  index: SidewalkIndex,
  graph: RoutingGraph,
  permits: readonly ShedPermit[],
  day: number,
): Promise<RecordSet> {
  const attributes = placementAttributes(permits);
  const requests = parcelRequestsOf(attributes);
  console.error(
    `  ${attributes.length} readings over ${new Set(requests.map((key) => key.bin)).size} BINs` +
      ` and ${new Set(requests.map((key) => key.bbl)).size} BBLs`,
  );
  const parcels = await fetchShedParcels(requests);
  const records = attributes.map((reading) => toShedRecord(reading, parcels));
  const placements = placeRecords(index, records);
  const placed = new Map(
    attributes.map((reading, order) => [reading, placements[order]]),
  );
  const placementsByJob = new Map<string, ShedPlacement[]>();
  const encoded = encodedShedsOf(
    permits,
    (interval, permit) => {
      const placement = placed.get(interval.attributes)!;
      const held = placementsByJob.get(permit.job);
      if (held === undefined) {
        placementsByJob.set(permit.job, [placement]);
      } else {
        held.push(placement);
      }
      return {
        spans: toEncodedSpans(graph, placement),
        confidence: toConfidenceByte(placement),
      };
    },
    day,
  );
  return {
    digests: digestsByJob(encoded),
    placements: placementsByJob,
    inputs: new Map(
      attributes.map((reading, order) => [
        reading,
        inputDigestOf(records[order]),
      ]),
    ),
  };
}

// Readings whose parcel geometry is not what the other run read. `.cache/` entries never expire and
// are keyed by the batch they were fetched in, so a drop that shifts a batch boundary re-fetches part
// of the key space — and if the city has published a new tax map since the rest of it was cached, the
// two runs are reading different SOURCES and every comparison below is meaningless. This is what says
// so, rather than letting it read as a placement that moved.
function driftedInputs(
  baseline: ReadonlyMap<ShedAttributes, string>,
  dropped: ReadonlyMap<ShedAttributes, string>,
): number {
  let drifted = 0;
  for (const [reading, digest] of baseline) {
    const after = dropped.get(reading);
    if (after !== undefined && after !== digest) {
      drifted += 1;
    }
  }
  return drifted;
}

export interface DrillResult {
  job: string;
  compared: number;
  changed: number;
  examples: string[];
}

const MAX_EXAMPLES = 5;

export function compareRecordSets(
  baseline: ReadonlyMap<string, readonly string[]>,
  dropped: ReadonlyMap<string, readonly string[]>,
  job: string,
): DrillResult {
  let compared = 0;
  let changed = 0;
  const examples: string[] = [];
  const note = (line: string): void => {
    if (examples.length < MAX_EXAMPLES) {
      examples.push(line);
    }
  };
  for (const [other, digests] of baseline) {
    if (other === job) {
      continue;
    }
    const after = dropped.get(other);
    if (after === undefined) {
      compared += digests.length;
      changed += digests.length;
      note(`${other}: ${digests.length} records vanished`);
      continue;
    }
    for (let interval = 0; interval < digests.length; interval++) {
      compared += 1;
      if (after[interval] !== digests[interval]) {
        changed += 1;
        note(
          `${other}#${interval}\n    was ${digests[interval]}\n    now ${after[interval] ?? "(absent)"}`,
        );
      }
    }
    for (let extra = digests.length; extra < after.length; extra++) {
      compared += 1;
      changed += 1;
      note(`${other}#${extra}: appeared as ${after[extra]}`);
    }
  }
  for (const other of dropped.keys()) {
    if (other !== job && !baseline.has(other)) {
      changed += 1;
      compared += 1;
      note(`${other}: appeared`);
    }
  }
  return { job, compared, changed, examples };
}

// How many distinct streets a placement's spans lie along, which is what tells a corner lot's two
// frontages from one run down a single block.
function streetsOf(graph: RoutingGraph, placement: ShedPlacement): number {
  const names = new Set<string>();
  for (const span of placement.spans) {
    const name = edgeName(graph, span.edge);
    if (name !== null && name !== "") {
      names.add(name);
    }
  }
  return names.size;
}

function shapeOf(graph: RoutingGraph, placement: ShedPlacement): Shape | null {
  if (placement.spans.length === 0) {
    return null;
  }
  const streets = streetsOf(graph, placement);
  if (
    Number.isFinite(placement.shedMeters) &&
    placement.coveredMeters < placement.shedMeters / 2
  ) {
    return "overdeclared";
  } else if (streets > 1) {
    return "corner";
  } else if (placement.coveredMeters >= LONG_RUN_METERS) {
    return "superblock";
  } else if (
    placement.coveredMeters >= MIDBLOCK_MIN_METERS &&
    placement.coveredMeters <= MIDBLOCK_MAX_METERS &&
    placement.unplacedMeters <= MIDBLOCK_SLACK_METERS
  ) {
    return "midblock";
  } else {
    return null;
  }
}

// One permit per shape, each in a different borough — a job number's leading digit — so the four
// drops exercise four different placements rather than four neighbours in the same block of the
// feed. Within a shape the choice is the middle candidate by job number, which is arbitrary but
// fixed, so a re-run drills the same permits.
export function pickDrops(
  candidates: ReadonlyMap<Shape, readonly string[]>,
): Map<Shape, string> {
  const picked = new Map<Shape, string>();
  const boroughs = new Set<string>();
  for (const shape of SHAPES) {
    const jobs = [...(candidates.get(shape) ?? [])].sort();
    if (jobs.length === 0) {
      continue;
    }
    const middle = Math.floor(jobs.length / 2);
    const order = jobs
      .map((job, at) => ({ job, distance: Math.abs(at - middle) }))
      .sort((left, right) => left.distance - right.distance);
    const fresh = order.find(({ job }) => !boroughs.has(job[0]));
    const job = (fresh ?? order[0]).job;
    boroughs.add(job[0]);
    picked.set(shape, job);
  }
  return picked;
}

// The permits whose removal actually moves the parcel read: ones naming a BIN and a BBL no other
// permit names. Dropping one takes a key out of the sorted lists `fetchKeyed` batches, so every batch
// after it is composed differently and unrelated lots come back in another order — which is the shape
// the two batch-order bugs took. Dropping a permit that shares its keys leaves the parcel fetch
// byte-identical and tests only the placement half, so the drill spends its runs on these.
export function isolatingJobs(permits: readonly ShedPermit[]): Set<string> {
  const namers = new Map<string, Set<string>>();
  for (const permit of permits) {
    for (const interval of permit.intervals) {
      const { bin, boroughDigit, block, lot } = interval.attributes;
      for (const key of [
        `bin:${bin}`,
        `bbl:${bblOf(boroughDigit, block, lot)}`,
      ]) {
        const jobs = namers.get(key);
        if (jobs === undefined) {
          namers.set(key, new Set([permit.job]));
        } else {
          jobs.add(permit.job);
        }
      }
    }
  }
  const isolating = new Set<string>();
  for (const permit of permits) {
    const keys = permit.intervals.flatMap((interval) => [
      `bin:${interval.attributes.bin}`,
      `bbl:${bblOf(interval.attributes.boroughDigit, interval.attributes.block, interval.attributes.lot)}`,
    ]);
    if (keys.every((key) => namers.get(key)!.size === 1)) {
      isolating.add(permit.job);
    }
  }
  return isolating;
}

function candidatesOf(
  graph: RoutingGraph,
  placements: ReadonlyMap<string, readonly ShedPlacement[]>,
  isolating: ReadonlySet<string>,
): Map<Shape, string[]> {
  const candidates = new Map<Shape, string[]>(
    SHAPES.map((shape) => [shape, []]),
  );
  for (const [job, ofJob] of placements) {
    // A permit with more than one presence interval places twice, and the two can differ; the drill
    // wants a permit whose one shape is unambiguous.
    if (ofJob.length !== 1 || !isolating.has(job)) {
      continue;
    }
    const shape = shapeOf(graph, ofJob[0]);
    if (shape !== null) {
      candidates.get(shape)!.push(job);
    }
  }
  return candidates;
}

function describe(
  graph: RoutingGraph,
  placement: ShedPlacement,
  permit: ShedPermit,
): string {
  return (
    `${permit.street}, ${streetsOf(graph, placement)} street(s),` +
    ` ${placement.coveredMeters.toFixed(0)} m covered of` +
    ` ${Number.isFinite(placement.shedMeters) ? placement.shedMeters.toFixed(0) : "?"} declared,` +
    ` ${placement.spans.length} spans, status ${placement.status}`
  );
}

export async function runDrill(chosen: readonly string[]): Promise<void> {
  const { sources, blobs } = await shedSnapshots("shed-drill");
  const { permits, lastDay } = await readShedPermits(sources, blobs);
  permits.sort(byJobNumber);
  const day = shedDayOf(lastDay);
  const graph = loadGraphBytes(await readFile(GRAPH_PATH));
  const index = buildSidewalkIndex(graph);
  console.error(
    `  graph ${graph.hash}, key space ${graph.keyHash}, ${index.edges.length} sidewalk edges,` +
      ` ${permits.length} permits`,
  );

  const started = performance.now();
  const baseline = await recordSetOf(index, graph, permits, day);
  const total = [...baseline.digests.values()].reduce(
    (count, digests) => count + digests.length,
    0,
  );
  console.error(
    `drill: baseline is ${total.toLocaleString()} records over ${baseline.digests.size.toLocaleString()} permits,` +
      ` ${((performance.now() - started) / 1000).toFixed(0)}s`,
  );

  const byJob = new Map(permits.map((permit) => [permit.job, permit]));
  const drops: [string, string][] =
    chosen.length > 0
      ? chosen.map((job) => ["given", job])
      : [
          ...pickDrops(
            candidatesOf(graph, baseline.placements, isolatingJobs(permits)),
          ),
        ];
  for (const [shape, job] of drops) {
    const permit = byJob.get(job);
    if (permit === undefined) {
      throw new Error(`${job} is not a permit the feed mentions`);
    }
    console.error(
      `\ndropping ${job} (${shape}): ${describe(graph, baseline.placements.get(job)![0], permit)}`,
    );
    const dropped = await recordSetOf(
      index,
      graph,
      permits.filter((other) => other.job !== job),
      day,
    );
    const result = compareRecordSets(baseline.digests, dropped.digests, job);
    const drifted = driftedInputs(baseline.inputs, dropped.inputs);
    console.error(
      `drill: ${job} (${shape}): ${result.changed} of ${result.compared.toLocaleString()} surviving records changed`,
    );
    if (drifted > 0) {
      console.error(
        `  ${drifted} surviving readings were placed from DIFFERENT parcel geometry, so the two runs` +
          " did not read the same tax map and the count above means nothing." +
          " Re-run with REFRESH=1 to pin the source.",
      );
    }
    for (const example of result.examples) {
      console.error(`  ${example}`);
    }
  }
}

if (import.meta.main) {
  // argv[2] is the commit index the pipeline hands every shed script; the jobs to drop follow it.
  await runDrill(process.argv.slice(3));
}
