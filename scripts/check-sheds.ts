// `bun run check-sheds`: the deploy's guard on the one pairing nothing else can see. The routing
// graph is built by the deploy and the shed artifact is committed, so the two travel separately —
// and the artifact only means the graph its header names. A deploy whose graph inputs moved without
// a `bun run build-sheds` in the same push does not put scaffolding down the wrong street, it makes
// every shed on the map vanish, which is invisible until someone looks.
//
// This is the last point that holds both halves at once: the graph exists only after `bun run
// build-tiles`, and the artifact is only ever read out of the checkout. So .github/workflows/build.yml
// runs this between the tile build and the Pages upload, and a mismatch fails the deploy rather than
// shipping one. Nothing catches it earlier: a push or a PR has no graph to compare against.
//
// Run by hand after any graph-input change — `bun run check-sheds [graph] [shed-dir]` — which is the
// same check with the deploy's own defaults.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  decodeShedArtifact,
  graphHashOf,
  shedGraphMismatch,
} from "./shed-encode";

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
  const hash = graphHashOf(graphBytes);

  // The client gates on the hash `version.json` states, not on one it recomputes, so a version file
  // that has drifted from the bytes beside it blanks the map exactly as a stale artifact would.
  const version = await readFile(
    join(dirname(graphPath), "version.json"),
    "utf-8",
  ).catch(() => null);
  if (version !== null) {
    const declared = (JSON.parse(version) as { hash: string }).hash;
    if (declared !== hash) {
      throw new Error(
        `${graphPath} hashes to ${hash} and version.json beside it says ${declared}:` +
          " the deploy would serve a graph it names wrongly, and every shed would resolve to nothing",
      );
    }
  }

  const artifact = decodeShedArtifact(
    new Uint8Array(open.buffer, open.byteOffset, open.byteLength),
    new Uint8Array(closed.buffer, closed.byteOffset, closed.byteLength),
  );
  const mismatch = shedGraphMismatch(artifact, hash);
  if (mismatch !== null) {
    throw new Error(
      `${mismatch}, so every shed would resolve to nothing on the deployed map.` +
        " A graph-input change and its re-place are one deploy: `bun run build-sheds`, commit" +
        " public/sheds, then deploy. scripts/README.md has the whole refresh procedure.",
    );
  }
  console.error(
    `sheds: ${artifact.open.length.toLocaleString()} standing, placed against graph ${hash}`,
  );
}

if (import.meta.main) {
  const [graphPath = GRAPH_PATH, shedDir = SHED_DIR] = process.argv.slice(2);
  await checkSheds(graphPath, shedDir);
}
