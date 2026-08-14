// `bun run check-sheds`: the deploy's guard on the one pairing nothing else can see. The routing
// graph is built by the deploy and the shed artifact is committed, so the two travel separately —
// and the artifact only means a graph whose durable key space its header names. A deploy whose graph
// inputs moved without a `bun run build-sheds` in the same push does not put scaffolding down the
// wrong street, it makes every shed on the map vanish, which is invisible until someone looks.
//
// The KEY SPACE and not the graph's bytes, which this compared until 2026-08: those carry f32 edge
// lengths that macOS and Linux land a ulp apart, so an artifact placed on a laptop could never match
// the graph a deploy builds, and the gate failed on a difference no shed can feel.
//
// This is the last point that holds both halves at once: the graph exists only after `bun run
// build-tiles`, and the artifact is only ever read out of the checkout. So .github/workflows/build.yml
// runs this between the tile build and the Pages upload, and a mismatch fails the deploy rather than
// shipping one. Nothing catches it earlier: a push or a PR has no graph to compare against.
//
// Run by hand after any graph-input change — `bun run check-sheds [graph] [shed-dir]` — which is the
// same check with the deploy's own defaults.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphIdentity } from "../src/routing/graph";
import { loadGraphBytes } from "./build-sheds";
import { decodeShedArtifact, shedGraphMismatch } from "./shed-encode";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const GRAPH_PATH = join(PUBLIC_DIR, "routing", "nyc.bin");
const SHED_DIR = join(PUBLIC_DIR, "sheds");

export async function checkSheds(
  graphPath: string,
  shedDir: string,
): Promise<void> {
  const [graphBytes, open, closed] = await Promise.all([
    readFile(graphPath),
    readFile(join(shedDir, "open.bin")),
    readFile(join(shedDir, "closed.bin")),
  ]);
  // Recomputed here in TypeScript from the graph `tiler graph` wrote in Rust, so the two
  // implementations of the key-space hash are compared against each other on every deploy as well.
  const { hash, keyHash } = loadGraphBytes(graphBytes);

  // The client gates on what `version.json` states, not on anything it recomputes, so a version file
  // that has drifted from the bytes beside it blanks the map exactly as a stale artifact would.
  const version = await readFile(
    graphPath.replace(/\.bin$/, ".version.json"),
    "utf-8",
  ).catch(() => null);
  if (version !== null) {
    const declared = JSON.parse(version) as Partial<GraphIdentity>;
    if (declared.hash !== hash || declared.keyHash !== keyHash) {
      throw new Error(
        `${graphPath} is ${hash}/${keyHash} and its version file says` +
          ` ${declared.hash}/${declared.keyHash}: the deploy would serve a graph it names wrongly,` +
          " and every shed would resolve to nothing",
      );
    }
  }

  const artifact = decodeShedArtifact(
    new Uint8Array(open.buffer, open.byteOffset, open.byteLength),
    new Uint8Array(closed.buffer, closed.byteOffset, closed.byteLength),
  );
  const mismatch = shedGraphMismatch(artifact, keyHash);
  if (mismatch !== null) {
    throw new Error(
      `${mismatch}, so every shed would resolve to nothing on the deployed map.` +
        " A graph-input change and its re-place are one deploy: `bun run build-sheds`, commit" +
        " public/sheds, then deploy. scripts/README.md has the whole refresh procedure.",
    );
  }
  console.error(
    `sheds: ${artifact.open.length.toLocaleString()} standing, placed against key space ${keyHash}` +
      ` (graph ${hash})`,
  );
}

if (import.meta.main) {
  const [graphPath = GRAPH_PATH, shedDir = SHED_DIR] = process.argv.slice(2);
  await checkSheds(graphPath, shedDir);
}
