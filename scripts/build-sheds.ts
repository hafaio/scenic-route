// `bun run build-sheds`: places every sidewalk-shed permit New York has issued since 2017-12-28 on
// the sidewalk edges it stands over, and writes the result as public/sheds/{open,closed,
// index}.bin (magic SHED). Three sources feed it — the DOB's own daily CSV snapshots, kept as the
// git history of NYCDOB/ActiveShedPermits, for what was standing when; the DOF digital tax map for
// the property line a shed runs along; and the building footprints for which part of a multi-part
// lot is in use. The placement is scripts/shed-map.ts and the layout is scripts/README.md.
//
// The artifact has to be a function of the feed and its end date alone, so that an incremental job
// can land on the bytes this writes however far apart the two were run. Two things buy that:
// `open.bin` carries every standing permit's job number, so identity is stated rather than
// re-derived, and a record is placed from the reading the feed carried on the day its own interval
// ended, never from the one it carries now.
//
// It reads public/routing/nyc.bin, so it runs AFTER `bun run build-tiles` — which bakes that graph
// and clears public/routing on its way. What it writes sits outside that directory and is committed,
// so no ordering against the tile build can take it back out again.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeGraph,
  NO_SOURCE_ID,
  type RoutingGraph,
} from "../src/routing/graph";
import {
  CONFIDENCE_CEILING,
  DEPTH_CEILING,
  DEPTH_SCALE,
  type EncodedShed,
  type EncodedSpan,
  encodeSheds,
  FRACTION_SCALE,
  graphHashOf,
  SIDE_BITS,
  shedDayOf,
} from "./shed-encode";
import {
  buildSidewalkIndex,
  pickShedParts,
  placeShed,
  type ShedPlacement,
  type ShedRequest,
  type SidewalkIndex,
} from "./shed-map";
import {
  bblOf,
  fetchShedParcels,
  lotFor,
  quantizeRing,
  type Ring,
  type ShedParcels,
} from "./shed-parcels";
import {
  MERGE_TOLERANCE_DAYS,
  readShedPermits,
  type ShedAttributes,
  type ShedInterval,
  type ShedPermit,
} from "./shed-permits";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const ROUTING_DIR = join(PUBLIC_DIR, "routing");
// Committed, and the one directory under public/ that is: SHED_BASE in src/routing/sheds.ts names it
// as the client's relative path, and the tile build neither renders nor clears it.
export const SHED_DIR = join(PUBLIC_DIR, "sheds");
const GRAPH_PATH = join(ROUTING_DIR, "nyc.bin");
const VERSION_PATH = join(ROUTING_DIR, "version.json");
// The DOB publishes one CSV a day and keeps the old ones only as git history, so the whole record of
// what stood when is the repository rather than any single file.
const SNAPSHOT_REPO = "https://github.com/NYCDOB/ActiveShedPermits.git";
export const SNAPSHOT_DIR =
  process.env.SHED_SNAPSHOTS ??
  join(import.meta.dirname, "..", ".cache", "ActiveShedPermits");
const SIDE_MASK = 0x7; // the graph's kind-and-side byte, bits 3-5
const METERS_PER_MILE = 1609.344;
const PROGRESS_EVERY = 5_000;

export async function cloneSnapshots(): Promise<string> {
  if ((await stat(SNAPSHOT_DIR).catch(() => null)) !== null) {
    return SNAPSHOT_DIR;
  }
  await mkdir(join(SNAPSHOT_DIR, ".."), { recursive: true });
  console.error(`  cloning ${SNAPSHOT_REPO} (~370 MB, once)`);
  const clone = spawnSync(
    "git",
    ["clone", "--bare", SNAPSHOT_REPO, SNAPSHOT_DIR],
    {
      stdio: "inherit",
    },
  );
  if (clone.status !== 0) {
    throw new Error(`could not clone ${SNAPSHOT_REPO}`);
  }
  return SNAPSHOT_DIR;
}

// The graph the placement snaps against, and what it hashes to. The hash is recomputed from the
// bytes rather than taken on trust from version.json beside them, because the daily job reads a graph
// off the live site where that file may be older than the deploy that put it there.
export function loadGraphBytes(source: Uint8Array): {
  graph: RoutingGraph;
  hash: string;
} {
  // Copied out of the read rather than viewed in place: decodeGraph takes typed-array views over the
  // buffer, and a Buffer from readFile can sit at an offset in a pooled one.
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return { graph: decodeGraph(bytes.buffer), hash: graphHashOf(bytes) };
}

async function loadGraph(): Promise<{ graph: RoutingGraph; hash: string }> {
  const loaded = loadGraphBytes(await readFile(GRAPH_PATH));
  const version = (await readFile(VERSION_PATH, "utf-8").catch(() => null)) as
    | string
    | null;
  if (version !== null) {
    const declared = (JSON.parse(version) as { hash: string }).hash;
    if (declared !== loaded.hash) {
      throw new Error(
        `${GRAPH_PATH} hashes to ${loaded.hash}, version.json says ${declared}`,
      );
    }
  }
  return loaded;
}

// A permit as the placement reads it: the attributes that decide where the shed goes, and the one lot
// part and one building part it stands along, on the 1e-6 degree grid every blob in this repo uses.
export interface ShedRecord {
  street: string;
  linearFeet: number; // NaN when the feed carries none
  lng: number | null;
  lat: number | null;
  lot: Ring | null; // the tax-lot part the permit sits on
  footprint: Ring | null; // and the building part, which anchors a permit shorter than its frontage
}

export function toShedRecord(
  attributes: ShedAttributes,
  parcels: ShedParcels,
): ShedRecord {
  const bbl = bblOf(attributes.boroughDigit, attributes.block, attributes.lot);
  const parts = pickShedParts({
    street: attributes.street,
    linearFeet: attributes.linearFeet,
    lot: lotFor(parcels, bbl, attributes.bin),
    footprint: parcels.footprints.get(attributes.bin) ?? null,
    lng: attributes.lng,
    lat: attributes.lat,
  });
  return {
    street: attributes.street,
    linearFeet: attributes.linearFeet,
    lng: attributes.lng,
    lat: attributes.lat,
    lot: parts.lot === null ? null : quantizeRing(parts.lot),
    footprint: parts.footprint === null ? null : quantizeRing(parts.footprint),
  };
}

// Every distinct reading the placement has to answer for, in the order the records need them. One
// per permit for the attributes the feed has now, and one more wherever a record's interval ended
// under a reading the feed has since corrected — a few hundred against sixty thousand, because the
// walk replaces a permit's attributes only when they actually change.
export function placementAttributes(
  permits: readonly ShedPermit[],
): ShedAttributes[] {
  const distinct: ShedAttributes[] = [];
  const seen = new Set<ShedAttributes>();
  for (const permit of permits) {
    for (const interval of permit.intervals) {
      if (!seen.has(interval.attributes)) {
        seen.add(interval.attributes);
        distinct.push(interval.attributes);
      }
    }
  }
  return distinct;
}

export function parcelRequestsOf(
  attributes: readonly ShedAttributes[],
): { bin: string; bbl: string | null }[] {
  return attributes.map((reading) => ({
    bin: reading.bin,
    bbl: bblOf(reading.boroughDigit, reading.block, reading.lot),
  }));
}

// The order the artifact stores its records in, and the only one the daily job can rebuild from the
// DOB's CSV without keeping anything of its own: ascending by job number. A permit with more than one
// presence interval keeps them in date order within its own group.
export function byJobNumber(left: ShedPermit, right: ShedPermit): number {
  return left.job < right.job ? -1 : left.job > right.job ? 1 : 0;
}

export function shedRequestOf(record: ShedRecord): ShedRequest {
  return {
    street: record.street,
    linearFeet: record.linearFeet,
    lot: record.lot === null ? null : [record.lot],
    footprint: record.footprint === null ? null : [record.footprint],
    lng: record.lng,
    lat: record.lat,
  };
}

export function placeRecords(
  index: SidewalkIndex,
  records: readonly ShedRecord[],
): ShedPlacement[] {
  const started = performance.now();
  return records.map((record, order) => {
    if ((order + 1) % PROGRESS_EVERY === 0) {
      const elapsed = (performance.now() - started) / 1000;
      console.error(
        `  ${order + 1}/${records.length} placed, ${elapsed.toFixed(0)}s (${((elapsed / (order + 1)) * 1000).toFixed(1)} ms/shed)`,
      );
    }
    return placeShed(index, shedRequestOf(record));
  });
}

// One placement as the spans the artifact stores: named by the graph's DURABLE key rather than by the
// edge id they were placed on, because the artifact outlives the graph it was snapped against and a
// positional id would quietly point at another street after the next rebuild.
export function toEncodedSpans(
  graph: RoutingGraph,
  placement: ShedPlacement,
): EncodedSpan[] {
  return placement.spans.map((span) => {
    const sourceId = graph.edgeSourceId[span.edge];
    if (sourceId === NO_SOURCE_ID) {
      // Placement only ever lands on sidewalks, and every sidewalk carries its source segment.
      throw new Error(`edge ${span.edge} has no durable id to key a shed on`);
    }
    const t0 = Math.min(
      FRACTION_SCALE,
      Math.max(0, Math.round(span.t0 * FRACTION_SCALE)),
    );
    return {
      sourceId,
      side: (graph.edgeKindSide[span.edge] >> SIDE_BITS) & SIDE_MASK,
      ordinal: graph.edgeOrdinal[span.edge],
      t0,
      t1: Math.min(
        FRACTION_SCALE,
        Math.max(t0, Math.round(span.t1 * FRACTION_SCALE)),
      ),
      // A span the placement could measure no pavement width for stores 0, not a guess: the client
      // has one fallback depth and it is better that it is applied in one place.
      depth: Number.isFinite(span.depthMeters)
        ? Math.min(DEPTH_CEILING, Math.round(span.depthMeters * DEPTH_SCALE))
        : 0,
    };
  });
}

// The confidence byte, on the 0-254 ceiling the graph's own attribute bytes use.
export function toConfidenceByte(placement: ShedPlacement): number {
  return Math.min(CONFIDENCE_CEILING, Math.round(placement.confidence * 255));
}

// Whether an interval is still PROVISIONAL on `lastDay`, the newest usable snapshot: a reappearance
// within the renewal tolerance would extend it, and the feed drops 40-70 permits a day around a
// renewal. A provisional interval goes in `open.bin` with no close day, and one that can never be
// extended again goes in `closed.bin` and is final. That is the whole of the open/closed split, and
// it is what lets the daily job append closures rather than revisit them.
export function isProvisional(last: number, lastDay: number): boolean {
  return lastDay - last < MERGE_TOLERANCE_DAYS;
}

// What a permit's spans and confidence are, however the caller came by them.
export interface ShedCoverage {
  spans: EncodedSpan[];
  confidence: number; // 0..254
}

// One record per (permit, presence interval), spans repeated: the intervals are disjoint, so no day
// ever sees a permit twice. `permits` must already be in job order, which is the order `open.bin`
// stores its records and its job numbers in.
export function encodedShedsOf(
  permits: readonly ShedPermit[],
  coverageOf: (interval: ShedInterval, permit: ShedPermit) => ShedCoverage,
  lastDay: number,
): EncodedShed[] {
  const encoded: EncodedShed[] = [];
  for (const permit of permits) {
    for (const interval of permit.intervals) {
      const { spans, confidence } = coverageOf(interval, permit);
      const last = shedDayOf(interval.last);
      encoded.push({
        job: permit.job,
        first: shedDayOf(interval.first),
        close: isProvisional(last, lastDay) ? null : last,
        confidence,
        spans,
      });
    }
  }
  return encoded;
}

export async function writeShedArtifact(
  encoded: readonly EncodedShed[],
  hash: string,
  lastDay: number,
  counts: readonly number[],
): Promise<void> {
  const artifact = encodeSheds(encoded, hash, lastDay, counts);
  await mkdir(SHED_DIR, { recursive: true });
  for (const [name, bytes] of [
    ["open.bin", artifact.open],
    ["closed.bin", artifact.closed],
    ["index.bin", artifact.index],
  ] as const) {
    await writeFile(join(SHED_DIR, name), bytes);
    console.error(`  ${name}: ${bytes.length.toLocaleString()} bytes`);
  }
}

export function summarize(
  permits: readonly ShedPermit[],
  placementOf: (interval: ShedInterval) => ShedPlacement,
  lastDay: string,
): void {
  const day = shedDayOf(lastDay);
  const records = permits.flatMap((permit) =>
    permit.intervals.map((interval) => ({
      standing: isProvisional(shedDayOf(interval.last), day),
      placement: placementOf(interval),
    })),
  );
  const placements = records.map((record) => record.placement);
  const assigned = placements.filter((placement) => placement.spans.length > 0);
  const standing = records.filter((record) => record.standing);
  const coverage = (of: readonly ShedPlacement[]): number =>
    of.reduce((total, placement) => total + placement.coveredMeters, 0);
  const weighted =
    assigned.reduce(
      (total, placement) =>
        total + placement.confidence * placement.coveredMeters,
      0,
    ) / coverage(assigned);
  const status = new Map<string, number>();
  for (const placement of placements) {
    status.set(placement.status, (status.get(placement.status) ?? 0) + 1);
  }
  const standingAssigned = standing
    .map((record) => record.placement)
    .filter((placement) => placement.spans.length > 0);
  console.error(
    `sheds: ${assigned.length}/${records.length} records placed over ${permits.length} permits, ` +
      `${(coverage(assigned) / METERS_PER_MILE).toFixed(1)} mi of coverage, ` +
      `coverage-weighted confidence ${weighted.toFixed(3)}`,
  );
  console.error(
    `  standing on ${lastDay}: ${standingAssigned.length}/${standing.length} placed, ` +
      `${(coverage(standingAssigned) / METERS_PER_MILE).toFixed(1)} mi`,
  );
  console.error(
    `  status: ${[...status].map(([name, count]) => `${name} ${count}`).join(", ")}`,
  );
  const depths = placements
    .flatMap((placement) => placement.spans.map((span) => span.depthMeters))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const spans = placements.reduce(
    (total, placement) => total + placement.spans.length,
    0,
  );
  const measured = placements.reduce(
    (total, placement) => total + placement.measuredDepths,
    0,
  );
  const quantile = (share: number): string =>
    depths[
      Math.min(depths.length - 1, Math.floor(share * depths.length))
    ].toFixed(1);
  console.error(
    `  deck depth: ${measured}/${spans} spans measured on their own frontage,` +
      ` ${depths.length - measured} took their shed's median, ${spans - depths.length} none;` +
      ` min ${quantile(0)} p50 ${quantile(0.5)} p90 ${quantile(0.9)}` +
      ` max ${quantile(1)} m`,
  );
}

export async function buildSheds(): Promise<void> {
  const { permits, lastDay, counts } = await readShedPermits(
    await cloneSnapshots(),
  );
  permits.sort(byJobNumber);
  const attributes = placementAttributes(permits);
  const parcels = await fetchShedParcels(parcelRequestsOf(attributes));
  const records = attributes.map((reading) => toShedRecord(reading, parcels));

  const { graph, hash } = await loadGraph();
  const started = performance.now();
  const index = buildSidewalkIndex(graph);
  console.error(
    `  ${index.edges.length} sidewalk edges indexed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  const placements = placeRecords(index, records);
  const placed = new Map(
    attributes.map((reading, order) => [reading, placements[order]]),
  );
  const placementOf = (interval: ShedInterval): ShedPlacement =>
    placed.get(interval.attributes)!;
  const day = shedDayOf(lastDay);
  await writeShedArtifact(
    encodedShedsOf(
      permits,
      (interval) => ({
        spans: toEncodedSpans(graph, placementOf(interval)),
        confidence: toConfidenceByte(placementOf(interval)),
      }),
      day,
    ),
    hash,
    day,
    counts,
  );
  summarize(permits, placementOf, lastDay);
}

if (import.meta.main) {
  await buildSheds();
}
