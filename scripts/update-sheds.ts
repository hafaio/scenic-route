// `bun run update-sheds`: brings the sidewalk-shed artifact up to date with the DOB's feed. Run by
// .github/workflows/sheds.yml once a day, and by hand whenever.
//
// The job keeps nothing of its own between runs. The artifact says which day it was built through,
// the DOB's CSV history says what stood on that day and on every day since, and the difference
// between the two is the update. Identity comes out of the artifact too: `open.bin` carries every
// standing permit's job number, so which record is which permit is stated rather than re-derived.
// The feed's own answer — the permits still provisional on that day, in job order — is then a CHECK
// on it, and a disagreement stops the run rather than shifting every shed onto its neighbour's
// street.
//
// The one thing it must not assume is that it ran yesterday. Cron on a public repo is best-effort and
// is switched off entirely after sixty days of repository inactivity; a run can fail for a week
// before anyone notices; and the feed has 74 gaps of its own, 392 days in total, the worst a 66-day
// hole in early 2021. Reading the artifact's own day and replaying every snapshot published since
// covers all of that with no extra machinery.
//
// What it writes cannot depend on when it was last run, which three properties of the rest of the
// pipeline are what buy. The truncated-snapshot rule looks only BACKWARDS and its window travels in
// the artifact, so a day's verdict is final the moment it is made and a run that picks the feed up
// yesterday judges it exactly as a walk over the whole history would. A record is placed from the
// attributes the feed carried on the day its own interval ended, so a correction the DOB publishes
// later cannot move a shed that has already come down — which is what lets `closed.bin` be appended
// to rather than revisited. And spans are keyed by the graph's durable edge id, so within one graph
// nothing has to be kept in order to place a span again: the day's new permits are the only thing
// that ever needs placing. Across a rebuild that moved the key space the artifact means nothing at
// all — the header's key-space hash is what the client gates on — so a run that finds the site
// serving another key space STOPS rather than carrying its records onto one they were never placed
// against.
//
// What it costs in steady state: a shallow fetch of the DOB repo, the deployed graph off the Pages
// site, and one Socrata batch for the ~16 permits that are new. No LFS object is touched on any path,
// nothing deploys, and what it leaves behind is a commit on `main`.
//
// package.json fetches that history and pipes the snapshots in, so the clone happens before the
// graph check below rather than after it: a run that stops on a key-space mismatch has spent a
// shallow fetch it did not need, and writes nothing either way.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoutingGraph } from "../src/routing/graph";
import {
  byJobNumber,
  encodedShedsOf,
  loadGraphBytes,
  parcelRequestsOf,
  placementAttributes,
  placeRecords,
  SHED_DIR,
  type ShedCoverage,
  toConfidenceByte,
  toEncodedSpans,
  toShedRecord,
  writeShedArtifact,
} from "./build-sheds";
import {
  type DecodedShedArtifact,
  decodeShedArtifact,
  type EncodedShed,
  shedDayOf,
  shedGraphMismatch,
} from "./shed-encode";
import { buildSidewalkIndex } from "./shed-map";
import { fetchShedParcels } from "./shed-parcels";
import {
  daysBetween,
  MERGE_TOLERANCE_DAYS,
  mergeIntervals,
  readShedPermits,
  resumeFrom,
  type ShedAttributes,
  type ShedPermit,
  shedSnapshots,
} from "./shed-permits";

// The graph the day's new sheds are placed against has to be the one the client is running, and the
// client runs whatever the last deploy put on Pages — not necessarily what a checkout would build.
const SITE = process.env.SHED_SITE ?? "https://hafaio.github.io/scenic-route";
const GRAPH_URL = `${SITE}/routing/nyc.bin`;
// Where the artifact this run carries forward comes from: the committed copy the last run pushed,
// read out of the checkout and written back over. SHED_ARTIFACT names another directory, or a URL to
// read one over HTTP — what `raw` serves off `main`, say.
const ARTIFACT = process.env.SHED_ARTIFACT ?? SHED_DIR;
// How far back the history this run reads reaches, counted from the first day the walk applies.
const SHALLOW_DAYS = 30;
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2017, 11, 28); // the first DOB snapshot; every day number counts from here

function isoDay(day: number): string {
  return new Date(EPOCH_MS + day * DAY_MS).toISOString().slice(0, 10);
}

async function readArtifact(name: string): Promise<Uint8Array> {
  if (ARTIFACT.startsWith("http")) {
    const url = `${ARTIFACT}/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `${url}: ${response.status} ${response.statusText} —` +
          " `bun run build-sheds` has to have laid the artifact down and published it once",
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  } else {
    const file = await readFile(join(ARTIFACT, name));
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  }
}

// The first day of the feed's history this run has to read, which is what package.json bounds both
// its shallow clone and its blob stream by. A month before the day the walk applies from: the walk
// itself wants only the commits from a day or two before that, since a commit's UTC stamp can fall
// after the New York day its CSV claims, and the rest is slack for a feed whose stamps have drifted
// further. It costs a megabyte or two of history against the ~370 MB of the whole of it.
export function readCommitsFrom(applyFrom: string): string {
  return new Date(Date.parse(applyFrom) - SHALLOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// The same day, worked out from the artifact alone, so `scripts/shed-window.ts` can print it before
// any of the pipeline runs. The update reads the artifact again for itself; this is the one thing the
// clone depth has to know and cannot learn from anything already on disk.
export async function shedWindow(): Promise<string> {
  const [open, closed] = await Promise.all([
    readArtifact("open.bin"),
    readArtifact("closed.bin"),
  ]);
  return readCommitsFrom(
    resumeFrom(isoDay(decodeShedArtifact(open, closed).lastDay)),
  );
}

async function loadDeployedGraph(): Promise<RoutingGraph> {
  const local = process.env.SHED_GRAPH;
  if (local !== undefined) {
    console.error(`  graph: ${local}`);
    return loadGraphBytes(await readFile(local));
  }
  console.error(`  graph: ${GRAPH_URL}`);
  const response = await fetch(GRAPH_URL);
  if (!response.ok) {
    throw new Error(
      `${GRAPH_URL}: ${response.status} ${response.statusText} — the site has to have been deployed once`,
    );
  }
  try {
    return loadGraphBytes(new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    // A new shed's durable keys are the ones the client will resolve, so they have to be read off the
    // graph it is running. One this checkout cannot read is one it cannot place against.
    throw new Error(
      `${GRAPH_URL} is not a graph this checkout can read (${String(error)}).` +
        " Deploy the site before running the shed job, so the two agree on the graph.",
    );
  }
}

// The permit's last sighting on or before `through`, or null when it has none.
function lastSeenBy(permit: ShedPermit, through: string): string | null {
  let latest: string | null = null;
  for (const run of permit.runs) {
    if (run.first <= through) {
      const day = run.last < through ? run.last : through;
      if (latest === null || day > latest) {
        latest = day;
      }
    }
  }
  return latest;
}

// What the feed says `open.bin` must hold: one record per permit still provisional on `through` —
// seen within the renewal tolerance of it — ascending by job number, which is the order it was
// written in. The artifact states that mapping itself; this is what it is checked against.
export function standingOn(
  permits: readonly ShedPermit[],
  through: string,
): ShedPermit[] {
  return permits.filter((permit) => {
    const seen = lastSeenBy(permit, through);
    return seen !== null && daysBetween(seen, through) < MERGE_TOLERANCE_DAYS;
  });
}

// The artifact carried forward over everything the feed has published since it was built. `permits`
// is every permit the window mentioned, in job order; `placed` is keyed by the readings the caller
// had to go to the tax map for, which are the ones the artifact has never placed.
//
// The records the window never mentioned are exactly the ones it cannot change: everything already in
// `closed.bin` came down more than a renewal before the artifact's own day, so a reappearance can no
// longer be merged into it and every closure this writes falls after all of them. That is what lets
// the file be appended to rather than revisited.
export function reconcileSheds(
  artifact: DecodedShedArtifact,
  permits: readonly ShedPermit[],
  lastDay: string,
  placed: ReadonlyMap<ShedAttributes, ShedCoverage>,
): EncodedShed[] {
  const through = isoDay(artifact.lastDay);
  const held = new Map<string, EncodedShed>(
    artifact.open.map((record) => [record.job, record]),
  );
  const standing = standingOn(permits, through);
  const missing = standing.find((permit) => !held.has(permit.job));
  if (standing.length !== held.size || missing !== undefined) {
    throw new Error(
      `the feed says ${standing.length} sheds were standing on ${through} and open.bin names` +
        ` ${held.size}${missing === undefined ? "" : `, not including ${missing.job}`}:` +
        " the two disagree, so rebuild with `bun run build-sheds`",
    );
  }
  // A first interval belonging to a record already held keeps that record's first day: its run
  // reaches back past the window and the merge cannot see that far. Everything else is the feed's own,
  // including a second interval, which is a permit that came down and went back up too long after to
  // be one shed — placed from its own reading, which is the same one unless the feed corrected the
  // permit between the two stints.
  const rebuilt = encodedShedsOf(
    permits.map((permit) => {
      const record = held.get(permit.job);
      const intervals = mergeIntervals(permit.runs);
      if (record !== undefined) {
        intervals[0] = { ...intervals[0], first: isoDay(record.first) };
      }
      return { ...permit, intervals };
    }),
    (interval, permit) => {
      // The reading this interval ended under, when it is one the run went to the tax map for, and
      // otherwise the record already on file — which was placed from that same reading, since a
      // permit whose attributes have changed since is one the run placed again.
      const coverage = placed.get(interval.attributes);
      if (coverage !== undefined) {
        return coverage;
      }
      const record = held.get(permit.job);
      if (record === undefined) {
        throw new Error(`${permit.job} is neither on record nor newly placed`);
      }
      return { spans: record.spans, confidence: record.confidence };
    },
    shedDayOf(lastDay),
  );
  return [...artifact.closed, ...rebuilt];
}

export async function updateSheds(): Promise<void> {
  const [openBytes, closedBytes] = await Promise.all([
    readArtifact("open.bin"),
    readArtifact("closed.bin"),
  ]);
  const artifact = decodeShedArtifact(openBytes, closedBytes);
  const through = isoDay(artifact.lastDay);
  console.error(
    `  the artifact reaches ${through}: ${artifact.open.length.toLocaleString()} standing,` +
      ` ${artifact.closed.length.toLocaleString()} come down`,
  );

  // Read before any of the work below, because a disagreement here ends the run. Every record the
  // artifact holds is carried forward untouched, so it can only be extended against the graph it was
  // placed against: a deploy that moved a graph input without re-placing lands here, with the client
  // already showing bare pavement, and going on would replace that with the old keys re-stamped
  // under the new key space — scaffolding on whatever streets they now happen to name.
  const graph = await loadDeployedGraph();
  const mismatch = shedGraphMismatch(artifact, graph.keyHash);
  if (mismatch !== null) {
    throw new Error(
      `${mismatch}. A graph-input change lands as one deploy: \`bun run build-sheds\`` +
        " against the new graph, commit, then deploy. Re-run once the site serves the graph the" +
        " artifact names, or rebuild if that is the stale half.",
    );
  }

  // Every day whose intervals could still change, which is every day a reappearance could still be
  // merged back into: the renewal tolerance and no more.
  const applyFrom = resumeFrom(through);
  const { sources, blobs } = await shedSnapshots(
    "update-sheds",
    readCommitsFrom(applyFrom),
  );
  const { permits, lastDay, counts } = await readShedPermits(
    sources,
    blobs,
    applyFrom,
    artifact.counts,
  );
  permits.sort(byJobNumber);
  console.error(
    `  the feed now reaches ${lastDay}, ${permits.length.toLocaleString()} permits mentioned since ${applyFrom}`,
  );

  // A permit already on record carries its spans forward; one the artifact has never placed, and one
  // whose length or geocode the feed has corrected since, are placed again. In steady state that is
  // the day's ~16 new sheds, one or two corrections, and the few whose last stint ended more than a
  // renewal ago and are up once more.
  const held = new Set(artifact.open.map((record) => record.job));
  const fresh = permits.filter(
    (permit) => !held.has(permit.job) || permit.corrected,
  );
  // One placement per distinct reading, which for a corrected permit is the one its earlier interval
  // ended under as well as the one it stands under now.
  const attributes = placementAttributes(fresh);
  console.error(
    `  ${fresh.length} permits need a parcel read over ${attributes.length} readings,` +
      ` ${permits.length - fresh.length} carry their spans over`,
  );
  const parcels = await fetchShedParcels(parcelRequestsOf(attributes));

  const index = buildSidewalkIndex(graph);
  console.error(
    `  graph ${graph.hash}, key space ${graph.keyHash}, ${index.edges.length} sidewalk edges`,
  );
  const placements = placeRecords(
    index,
    attributes.map((reading) => toShedRecord(reading, parcels)),
  );
  const placed = new Map(
    attributes.map((reading, order) => [
      reading,
      {
        spans: toEncodedSpans(graph, placements[order]),
        confidence: toConfidenceByte(placements[order]),
      },
    ]),
  );

  const records = reconcileSheds(artifact, permits, lastDay, placed);
  await writeShedArtifact(records, graph.keyHash, shedDayOf(lastDay), counts);
  const stillUp = records.filter((record) => record.close === null).length;
  console.error(
    `sheds: ${stillUp} standing on ${lastDay}, ${records.length - stillUp} come down` +
      ` (${fresh.length} newly placed, ${placements.filter((placement) => placement.spans.length > 0).length} onto a sidewalk)`,
  );
}

if (import.meta.main) {
  await updateSheds();
}
