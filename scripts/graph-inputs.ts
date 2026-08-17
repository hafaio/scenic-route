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
// The stamp therefore has two halves, and both are narrow on purpose. Widening either back out costs
// a full shed re-place on every push that touches the widened part, which is what this replaced: the
// set was every data blob and the whole tiler crate, so editing shade.rs demanded a re-place, and
// the change that provoked the narrowing produced a byte-identical placement.
//
// THE DATA HALF is the committed files `tiler graph` reads that can put a key in the space, hashed
// as bytes. There are three, and `graphInputPaths` says which and argues the rest out. It is
// deliberately computable with no LFS objects and no tiler run: every blob under data/ is tracked by
// Git LFS, and what the repository holds is a pointer whose oid IS the sha256 of the object it
// stands for. So `inputOid` hashes the pointer when it finds one and the bytes when it does not, and
// a checkout that took the pointers (the push/PR job, `lfs: false`) stamps identically to one that
// smudged them.
//
// THE CODE HALF is `tiler key-probe`: the graph pipeline itself, run over a committed fixture cut
// out of the real city, reporting the key hash it lands on. It is a stamp of the key assignment's
// BEHAVIOUR rather than of its source text, which is the only thing that can tell a change that
// moves keys from a change to the same file that cannot. scripts/README.md has the measured
// sensitivity and the one hole it leaves.

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import manifest from "../src/tree-cover/manifest.json";
import { runTiler } from "./tiler";

const ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(ROOT, "data");
// The module that decides which files `tiler graph` is handed and under which flags — the keys turn
// on that as much as on the files themselves, since a source passed puts keys in the space and one
// withheld does not. Its import closure stands in for the TypeScript half, minus the leaves below,
// so a new import is IN until someone argues it out.
const BUILD_ENTRY = join(import.meta.dirname, "build-street-tiles.ts");
// The imports the walk stops at, and everything reached only through them. Each produces something
// `tiler graph` bakes onto edges that were final before the bake ran — the same argument
// `graphInputPaths` makes about the data those modules read.
const ATTRIBUTE_ONLY_IMPORTS = new Set([
  // The sun-position bins the shade pyramid and the per-edge SHDE bake are cut by, the latter
  // written after the graph blob is. Takes src/shade/sun.ts with it.
  "./shade-schedule",
  // The colour ramp the canopy pyramid is painted with, which the graph never sees at all.
  "../src/tree-cover/ramp",
]);
// Nine 0.01-degree slices of the committed networks, spread over Manhattan, Brooklyn and Queens and
// cut out of data/{streets,paths,sidewalks}/nyc.bin. Real geometry rather than a drawn network,
// because what the probe has to be sensitive to is the pipeline's near-threshold decisions and only
// real data holds them in quantity: 4,226 durable keys over 1,283 streets, 3,358 OSM sidewalk ways
// and 518 paths, with alleys, step streets, bridge decks, kerb cuts, island drops, T-splits and
// one-sided pavement all populated. Committed as plain bytes — no .gitattributes rule reaches this
// path — so the push/PR job reads it under `lfs: false` like everything else here.
const FIXTURE_DIR = join(ROOT, "crates", "tiler", "fixtures", "key-probe");
// Build glue: `tiler graph` writes a graph wherever it is pointed, and the probe wants only the
// number in the report it prints.
const PROBE_OUT = join(tmpdir(), "scenic-route-key-probe", "graph.bin");
// Recorded beside the artifact rather than inside it: `open.bin` and `closed.bin` have a versioned
// header the client parses and `update-sheds` rewrites daily, and a format bump there breaks both
// readers at once (scripts/README.md). A separate file also states the pairing where a person reading
// the diff can see it, and the daily job leaves it alone because it only ever writes *.bin.
export const SHED_INPUTS_PATH = join(ROOT, "public", "sheds", "inputs.json");
const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";
const POINTER_HEAD = 512; // a pointer is ~130 bytes; this reads its head without decoding a blob
const IMPORTED = /\bfrom\s*"([^"]+)"/g;
// Type-only imports are erased before anything runs, so a module reached solely through one cannot
// move a byte of the graph — and following them would drag the whole ingest layer in behind a single
// `import type { Bounds }`.
const TYPE_IMPORT = /\bimport\s+type\b[^;]*?\bfrom\s*"[^"]+"/g;

// What one input is, in the form both kinds of checkout agree on: the LFS oid when the file is a
// pointer, and the sha256 of the bytes when it is the object itself — which is the same hex string,
// since that oid is defined as the object's sha256.
export function lfsPointerOid(bytes: Uint8Array): string | null {
  const head = new TextDecoder().decode(bytes.subarray(0, POINTER_HEAD));
  if (!head.startsWith(LFS_POINTER)) {
    return null;
  }
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(head);
  if (oid === null) {
    throw new Error("an LFS pointer with no sha256 oid to name its object");
  }
  return oid[1];
}

export async function inputOid(path: string): Promise<string> {
  const bytes = await readFile(path);
  return (
    lfsPointerOid(bytes) ?? createHash("sha256").update(bytes).digest("hex")
  );
}

// Repo-relative path + oid for each file, in a stable order, so the stamp is deterministic and
// location-independent — the same on a laptop and on a runner.
export async function stampOf(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(relative(ROOT, path));
    hash.update("\0");
    hash.update(await inputOid(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

// A relative import as a file. An unresolvable one throws rather than being skipped: a module the
// walk cannot follow is a hole in the input set, which is the failure this whole file exists to close.
async function importedFile(from: string, spec: string): Promise<string> {
  const base = resolve(dirname(from), spec);
  const candidates =
    extname(base) === ""
      ? [`${base}.ts`, `${base}.json`, join(base, "index.ts")]
      : [base];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${from} imports ${spec}, which resolves to no file`);
}

// Every module reachable from `entry` by relative import, stopping at the specifiers in `stopAt` and
// taking whatever is reachable only through them with it. Package imports are left out: a dependency
// bump moves bun.lock, not the build's own sources.
export async function codeClosure(
  entry: string,
  stopAt: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const reached = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (reached.has(file)) {
      continue;
    }
    reached.add(file);
    if (file.endsWith(".json")) {
      continue;
    }
    const source = (await readFile(file, "utf-8")).replace(TYPE_IMPORT, "");
    for (const [, spec] of source.matchAll(IMPORTED)) {
      if (spec.startsWith(".") && !stopAt.has(spec)) {
        pending.push(await importedFile(file, spec));
      }
    }
  }
  return [...reached];
}

// The committed files a durable key can come out of. `tiler graph` takes eleven sources; these are
// the three that can put one in the space, and the exclusions are the point of the whole file:
//
// - streets (STRT) and paths (PATH) ARE the keys: a source id is a CSCL physicalid or an OSM way id
//   off these two, and how each record is cut into edges sets its ordinals.
// - sidewalks (SWLK) too. A mapped sidewalk the association matches to a street is keyed by that
//   street, and `trim_derived` cuts the derived pavement back out wherever one exists — so the file
//   decides both which keys exist and how many edges a source is split across.
// - ferries carry NO_SOURCE_ID, and are appended after the walking sort and the node renumber having
//   snapped their terminals onto nodes that already exist. `assign_ordinals` skips them and an
//   append moves no earlier edge, so a ferry cannot perturb a key even indirectly.
// - landmarks, art and highways are read after the last edge is pushed: each becomes one per-edge
//   attribute byte over a `scenic::Network` built from the finished edges.
// - the commercial chain — landuse, buildings, openstreets and dining, which `tiler commercial`
//   snaps onto the street chunks to make public/commercial-lines — is one more such byte.
// - canopy is the direct-canopy byte, integrated along edge polylines that are already final, and
//   the crowns of the SHDE bake.
// - buildings and the shade params drive that bake, which runs after `fs::write(&args.out)`: it
//   cannot move a key in the file it is written beside.
// - data/land and data/trees feed the canopy and genus pyramids, and nothing on the graph's chain
//   reads either.
//
// The TypeScript that hands these over is in whole, minus the attribute-only leaves above; the
// manifest names the street and path files and is read for the city ids.
export async function graphInputPaths(): Promise<string[]> {
  const paths = await codeClosure(BUILD_ENTRY, ATTRIBUTE_ONLY_IMPORTS);
  for (const city of manifest.cities) {
    paths.push(join(DATA_DIR, "streets", city.streets.file));
    if (city.paths) {
      paths.push(join(DATA_DIR, "paths", city.paths.file));
    }
    const sidewalks = join(DATA_DIR, "sidewalks", `${city.id}.bin`);
    if (await exists(sidewalks)) {
      paths.push(sidewalks);
    }
  }
  return [...new Set(paths)].sort();
}

// The code half: what the key assignment DOES to the fixture, as `tiler key-probe` reports it. The
// fixture's own bytes are deliberately not in the path list above — an edit to it that moves no key
// is an edit no shed can feel, and one that moves a key moves this figure.
export async function keySpaceProbe(): Promise<string> {
  const report = runTiler(
    [
      "key-probe",
      "--streets",
      join(FIXTURE_DIR, "streets.bin"),
      "--paths",
      join(FIXTURE_DIR, "paths.bin"),
      "--sidewalks",
      join(FIXTURE_DIR, "sidewalks.bin"),
      "--out",
      PROBE_OUT,
    ],
    true,
    true,
  );
  const { keyHash } = JSON.parse(report) as { keyHash?: string };
  if (keyHash === undefined) {
    throw new Error("tiler key-probe reported no keyHash");
  }
  return keyHash;
}

// What the placement recorded. The two halves are kept apart so a mismatch can say which one moved,
// and `files` is there so a set that quietly shrank shows up in the diff rather than only in a digest.
export interface ShedInputs {
  stamp: string;
  files: number;
  keySpace: string;
}

export async function currentShedInputs(): Promise<ShedInputs> {
  const paths = await graphInputPaths();
  const [stamp, keySpace] = await Promise.all([
    stampOf(paths),
    keySpaceProbe(),
  ]);
  return { stamp, files: paths.length, keySpace };
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
