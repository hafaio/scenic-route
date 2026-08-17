// The land-time half of the shed guard: scripts/graph-inputs.ts, which says what the routing
// graph's durable key space is a function of, and scripts/check-shed-inputs.ts, which compares that
// against what the committed artifact was placed on. It runs on every push and pull request, where
// data/** is present only as Git LFS pointer text — so the first test here is the one the whole
// arrangement rests on.
//
// The other half of the stamp, `tiler key-probe`, is not exercised here: a `bun test` file in a
// subdirectory gets nothing back from `spawnSync`'s captured stdout (a bun 1.3 quirk — the same call
// from the repo root, or from `bun run`, captures fine). The CI job runs `bun run check-shed-inputs`
// immediately after this suite, which is the probe end to end against the committed record.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { shedInputsMismatch } from "../../scripts/check-shed-inputs";
import {
  graphInputPaths,
  inputOid,
  lfsPointerOid,
  stampOf,
} from "../../scripts/graph-inputs";

const ROOT = join(import.meta.dirname, "..", "..");
const OBJECT = new Uint8Array(4096).map((_, at) => (at * 37) & 0xff);
const PLACED = { stamp: "abc", files: 6, keySpace: "0123456789abcdef" };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pointerFor(bytes: Uint8Array): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(bytes)}\nsize ${bytes.length}\n`;
}

test("a checkout that took the LFS pointers stamps what one that smudged them does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shed-inputs-"));
  const smudged = join(dir, "smudged.bin");
  const pointer = join(dir, "pointer.bin");
  await Promise.all([
    writeFile(smudged, OBJECT),
    writeFile(pointer, pointerFor(OBJECT)),
  ]);

  // The pointer's oid IS the object's sha256, so the fast CI job — which checks out data/** with
  // lfs: false and never downloads a byte of it — computes the stamp a laptop does.
  expect(await inputOid(pointer)).toBe(sha256(OBJECT));
  expect(await inputOid(smudged)).toBe(await inputOid(pointer));
});

test("a blob that is not a pointer is hashed as itself", () => {
  expect(lfsPointerOid(OBJECT)).toBeNull();
  expect(lfsPointerOid(new TextEncoder().encode(pointerFor(OBJECT)))).toBe(
    sha256(OBJECT),
  );
});

test("the stamp moves when an input's bytes do, and when its path does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shed-inputs-"));
  const one = join(dir, "one.bin");
  const two = join(dir, "two.bin");
  await Promise.all([writeFile(one, OBJECT), writeFile(two, OBJECT)]);
  const before = await stampOf([one]);

  expect(await stampOf([one])).toBe(before);
  expect(await stampOf([two])).not.toBe(before); // the same bytes under another name
  await writeFile(one, new Uint8Array([...OBJECT, 1]));
  expect(await stampOf([one])).not.toBe(before);
});

// The boundary itself, and why it sits where it does: a shed resolves through the durable key
// `(source id, side, ordinal)` and through nothing else, so the set is what can move a KEY, not what
// can move the graph. Every exclusion below is an input `tiler graph` genuinely reads, and bakes
// into an edge that was final before the bake ran. Widening it back out costs a re-place of every
// shed in the city on every push that touches the widened part — which is what it used to cost, over
// 43 files.
test("the input set is the sources a durable key can come out of", async () => {
  const paths = (await graphInputPaths()).map((path) => relative(ROOT, path));

  // The three that make keys: a source id is a CSCL physicalid or an OSM way id off the streets and
  // the paths, and the OSM sidewalks decide which stretches the derived pavement is trimmed out of,
  // and so how many edges a source is cut into.
  expect(paths).toContain("data/streets/nyc.bin");
  expect(paths).toContain("data/paths/nyc.bin");
  expect(paths).toContain("data/sidewalks/nyc.bin");
  // And the module that decides which of them `tiler graph` is handed, with the manifest that names
  // the files: a source withheld puts no key in the space.
  expect(paths).toContain("scripts/build-street-tiles.ts");
  expect(paths).toContain("src/tree-cover/manifest.json");

  // Not the ferries: their edges carry NO_SOURCE_ID and are appended after the walking sort, so
  // `assign_ordinals` skips them and no earlier edge moves.
  expect(paths).not.toContain("data/ferries/nyc.bin");
  // Not the scenic factors: one per-edge attribute byte each, baked over finished edges.
  expect(paths).not.toContain("data/landmarks/nyc.bin");
  expect(paths).not.toContain("data/art/nyc.bin");
  expect(paths).not.toContain("data/highways/nyc.bin");
  // Nor the chain behind public/commercial-lines, which is one more such byte.
  expect(paths).not.toContain("data/landuse/nyc.bin");
  expect(paths).not.toContain("data/openstreets/nyc.bin");
  expect(paths).not.toContain("data/dining/nyc.bin");
  // Nor the buildings and the sun schedule: the SHDE bake they drive runs after the graph blob is
  // written, and the shade pyramid is not the graph at all.
  expect(paths).not.toContain("data/buildings/nyc.bin");
  expect(paths).not.toContain("scripts/shade-schedule.ts");
  expect(paths).not.toContain("src/shade/sun.ts");
  // Nor the canopy, which is the direct-canopy byte and the shade bake's crowns.
  expect(paths).not.toContain("data/canopy/nyc.bin");
  // And not the tiler's source text or its lockfile: the code half is `tiler key-probe`, which
  // reports what the pipeline DOES rather than what it says. A comment in graph.rs is not a re-place.
  expect(paths.filter((path) => path.endsWith(".rs"))).toEqual([]);
  expect(paths).not.toContain("Cargo.lock");
});

test("an artifact placed against the committed inputs passes", () => {
  expect(shedInputsMismatch(PLACED, { ...PLACED })).toBeNull();
});

test("inputs that moved without a re-place say so, and say what to run", () => {
  const mismatch = shedInputsMismatch(PLACED, { ...PLACED, stamp: "def" });

  expect(mismatch).toContain("stamped abc");
  expect(mismatch).toContain("stamp def");
  expect(mismatch).toContain("bun run build-sheds");
  expect(mismatch).toContain("scripts/README.md");
});

// The half a file hash cannot see: every source byte-identical, and the tiler cutting them into
// different edges.
test("a tiler that assigns keys differently says so on its own", () => {
  const mismatch = shedInputsMismatch(PLACED, {
    ...PLACED,
    keySpace: "fedcba9876543210",
  });

  expect(mismatch).toContain("0123456789abcdef");
  expect(mismatch).toContain("fedcba9876543210");
  expect(mismatch).toContain("bun run build-sheds");
  expect(mismatch).toContain("scripts/README.md");
});

test("an artifact that records nothing is not trusted", () => {
  expect(shedInputsMismatch(null, PLACED)).toContain(
    "public/sheds/inputs.json is missing",
  );
});
