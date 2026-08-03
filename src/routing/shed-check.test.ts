// The deploy's guard (scripts/check-sheds.ts), which is the only thing that ever sees the routing
// graph and the committed shed artifact at once. The graph is built by the deploy and the artifact
// travels in the checkout, so a refresh that rebuilds one without re-placing the other ships a map
// with no scaffolding on it at all — the hash gate's own correct behaviour, and silent.
//
// The check reads the graph as bytes and never decodes it, so the graph here is bytes: what it has
// to agree with is the hash `tiler graph` wrote down, not anything about the network.

import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSheds } from "../../scripts/check-sheds";
import { encodeSheds, graphHashOf } from "../../scripts/shed-encode";

const GRAPH = new Uint8Array([71, 82, 80, 72, 6, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
const REFRESHED = new Uint8Array([...GRAPH, 9]); // the same graph with one input moved
const LAST_DAY = 3136;

// A deploy on disk: the graph its build wrote, the version file beside it, and the artifact the
// checkout carries — placed against `placedAgainst`, which is the whole question.
async function deploy(
  graph: Uint8Array,
  placedAgainst: Uint8Array,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shed-check-"));
  const artifact = encodeSheds([], graphHashOf(placedAgainst), LAST_DAY, []);
  await Promise.all([
    writeFile(join(dir, "nyc.bin"), graph),
    writeFile(
      join(dir, "version.json"),
      JSON.stringify({ graph: "nyc.bin", hash: graphHashOf(graph) }),
    ),
    writeFile(join(dir, "open.bin"), artifact.open),
    writeFile(join(dir, "closed.bin"), artifact.closed),
  ]);
  return dir;
}

test("a deploy whose artifact names its own graph passes", async () => {
  const dir = await deploy(GRAPH, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).resolves.toBeUndefined();
});

test("a refreshed graph with a stale artifact fails the deploy", async () => {
  const dir = await deploy(REFRESHED, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).rejects.toThrow(
    `placed against graph ${graphHashOf(GRAPH)}, this one is ${graphHashOf(REFRESHED)}`,
  );
});

test("a version file that has drifted from the graph fails too", async () => {
  const dir = await deploy(GRAPH, GRAPH);
  await writeFile(
    join(dir, "version.json"),
    JSON.stringify({ graph: "nyc.bin", hash: graphHashOf(REFRESHED) }),
  );

  // The client takes the hash it gates on from this file rather than recomputing it, so a stale one
  // blanks the map exactly as a stale artifact does.
  await expect(checkSheds(join(dir, "nyc.bin"), dir)).rejects.toThrow(
    "the deploy would serve a graph it names wrongly",
  );
});
