// What the routing graph's DURABLE KEY SPACE is a function of, and the stamp that names it.
//
// The shed artifact is placed onto graph edges and committed, while the graph itself is derived,
// gitignored build output — so the two can only be paired by what they were both made from. But a
// shed resolves through one thing and one thing only: the durable key `(source id, side, ordinal)`
// its span was placed on, looked up as set membership (`resolveSpans` in src/routing/sheds.ts). So
// the question this file answers is not what can change the graph. It is what can change the SET OF
// KEYS — and most of what goes into a graph cannot. An input that only bakes a per-edge attribute
// byte moves no key, because the edge it is written onto was final before the bake ran.
//
// Nothing is computed here. Both halves of the stamp are the tiler's, because both are answers only
// it can give without being asked twice, and this reads the two reports package.json leaves:
//
// THE DATA HALF is `tiler graph-inputs`, over the plan `scripts/write-plan.ts` writes. The plan
// carries the resolved decision — which sources each city hands `graph::run`, under which flags —
// and crates/tiler/src/build.rs stamps that decision together with the bytes of the files it names.
// It used to be stamped here instead, from the import closure of write-plan.ts, because the decision
// lived in TypeScript with no artifact to point at; it has one now, so the code that made the
// decision is out of the set and an edit to it that decides the same thing costs no re-place.
//
// THE CODE HALF is `tiler key-probe`: the graph pipeline itself, run over a committed fixture cut
// out of the real city, reporting the key hash it lands on. It is a stamp of the key assignment's
// BEHAVIOUR rather than of its source text, which is the only thing that can tell a change that
// moves keys from a change to the same file that cannot. scripts/README.md has the measured
// sensitivity and the one hole it leaves.

import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
// Where `bun run key-probe` and `bun run graph-inputs` leave their reports. `.build/` is gitignored
// build glue at the repo root, because a package.json script can name no temporary directory of the
// machine's.
const PROBE_REPORT = join(ROOT, ".build", "key-probe.json");
const INPUTS_REPORT = join(ROOT, ".build", "graph-inputs.json");
// Recorded beside the artifact rather than inside it: `open.bin` and `closed.bin` have a versioned
// header the client parses and `update-sheds` rewrites daily, and a format bump there breaks both
// readers at once (scripts/README.md). A separate file also states the pairing where a person reading
// the diff can see it, and the daily job leaves it alone because it only ever writes *.bin.
export const SHED_INPUTS_PATH = join(ROOT, "public", "sheds", "inputs.json");

// Both reports are cargo runs, so package.json runs them and this reads what they left: nothing here
// spawns the tiler.
async function report<Report>(path: string, script: string): Promise<Report> {
  const text = await readFile(path, "utf-8").catch(() => null);
  if (text === null) {
    throw new Error(
      `${relative(ROOT, path)} is missing: run \`bun run ${script}\` first, which every` +
        " package.json script that needs the key space chains ahead of itself",
    );
  }
  return JSON.parse(text) as Report;
}

// The data half: the sources decision the plan records, plus the bytes of the files it names, as
// `tiler graph-inputs` stamps it. `files` is how many of those files there were, so a set that
// quietly shrank shows up in the diff rather than only in a digest.
export async function graphInputStamp(): Promise<{
  stamp: string;
  files: number;
}> {
  const { stamp, files } = await report<{ stamp?: string; files?: number }>(
    INPUTS_REPORT,
    "graph-inputs",
  );
  if (stamp === undefined || files === undefined) {
    throw new Error("tiler graph-inputs reported no stamp");
  }
  return { stamp, files };
}

// The code half: what the key assignment DOES to the fixture, as `tiler key-probe` reports it. The
// fixture is nine 0.01-degree slices of the committed networks, spread over Manhattan, Brooklyn and
// Queens and cut out of data/{streets,paths,sidewalks}/nyc.bin — real geometry rather than a drawn
// network, because what the probe has to be sensitive to is the pipeline's near-threshold decisions
// and only real data holds them in quantity: 4,226 durable keys over 1,283 streets, 3,358 OSM
// sidewalk ways and 518 paths, with alleys, step streets, bridge decks, kerb cuts, island drops,
// T-splits and one-sided pavement all populated. Its own bytes are deliberately out of the data half
// — an edit to it that moves no key is an edit no shed can feel, and one that moves a key moves this
// figure. Committed as plain bytes, so the push/PR job reads it under `lfs: false` like everything
// else here.
export async function keySpaceProbe(): Promise<string> {
  const { keyHash } = await report<{ keyHash?: string }>(
    PROBE_REPORT,
    "key-probe",
  );
  if (keyHash === undefined) {
    throw new Error("tiler key-probe reported no keyHash");
  }
  return keyHash;
}

// What the placement recorded. The two halves are kept apart so a mismatch can say which one moved.
export interface ShedInputs {
  stamp: string;
  files: number;
  keySpace: string;
}

export async function currentShedInputs(): Promise<ShedInputs> {
  const [{ stamp, files }, keySpace] = await Promise.all([
    graphInputStamp(),
    keySpaceProbe(),
  ]);
  return { stamp, files, keySpace };
}

export async function readShedInputs(): Promise<ShedInputs | null> {
  const text = await readFile(SHED_INPUTS_PATH, "utf-8").catch(() => null);
  return text === null ? null : (JSON.parse(text) as ShedInputs);
}

export async function writeShedInputs(): Promise<ShedInputs> {
  const inputs = await currentShedInputs();
  await writeFile(SHED_INPUTS_PATH, `${JSON.stringify(inputs, null, 2)}\n`);
  return inputs;
}
