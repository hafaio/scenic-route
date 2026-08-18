// The deploy's guard (scripts/check-sheds.ts), which is the only thing that ever sees the routing
// graph and the committed shed artifact at once. The graph is built by the deploy and the artifact
// travels in the checkout, so a refresh that rebuilds one without re-placing the other ships a map
// with no scaffolding on it at all — the gate's own correct behaviour, and silent.
//
// What the artifact has to agree with is the graph's DURABLE KEY SPACE, so the graphs here are real
// GRPH bytes rather than stand-in blobs: the two things worth pinning are that a rebuild which moved
// only the f32 lengths still passes, and that one which re-split a source still fails.

import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraphBytes } from "../../scripts/build-sheds";
import { checkSheds } from "../../scripts/check-sheds";
import { encodeSheds } from "../../scripts/shed-encode";
import { FORMAT_VERSION as GRAPH_FORMAT_VERSION } from "./graph";

const LAST_DAY = 3136;
const HEADER_BYTES = 64;
const EDGE_RECORD_BYTES = 36;
const NODE_COUNT = 2;
const KIND_SIDEWALK = 0;
const SIDE_SHIFT = 3;

// One edge as the durable key names it, plus the length that names nothing.
interface Edge {
  sourceId: number;
  side: number;
  ordinal: number;
  length: number;
}

const EDGES: readonly Edge[] = [
  { sourceId: 88, side: 1, ordinal: 0, length: 41.5 },
  { sourceId: 88, side: 1, ordinal: 1, length: 12.25 },
  { sourceId: 19, side: 4, ordinal: 0, length: 7.5 },
];

// A GRPH file carrying exactly these edges: two nodes, no geometry, no names, no ferries. Enough
// for `decodeGraph`, which is all the gate reads.
function graphBytes(edges: readonly Edge[]): Uint8Array {
  const nodes = HEADER_BYTES + NODE_COUNT * 10;
  const csr = nodes + ((4 - (nodes % 4)) % 4);
  const records = csr + (NODE_COUNT + 1) * 4 + edges.length * 8;
  const names = records + edges.length * EDGE_RECORD_BYTES;
  const bytes = new Uint8Array(names + 8);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("GRPH"));
  view.setUint16(4, GRAPH_FORMAT_VERSION, true);
  view.setUint32(8, NODE_COUNT, true);
  view.setUint32(12, edges.length, true);
  view.setFloat64(16, -73.98, true);
  view.setFloat64(24, 40.75, true);
  view.setFloat64(32, 1e-6, true);
  view.setUint32(44, names, true); // the name table: a count of zero and its one closing offset
  view.setUint32(52, bytes.length, true); // an empty geometry blob past the end
  for (const [index, edge] of edges.entries()) {
    const record = records + index * EDGE_RECORD_BYTES;
    view.setFloat32(record + 8, edge.length, true);
    bytes[record + 22] = KIND_SIDEWALK | (edge.side << SIDE_SHIFT);
    view.setUint32(record + 29, edge.sourceId, true);
    bytes[record + 33] = edge.ordinal;
  }
  return bytes;
}

// A deploy on disk: the graph its build wrote, the version file beside it, and the artifact the
// checkout carries — placed against `placedAgainst`, which is the whole question.
async function deploy(
  graph: Uint8Array,
  placedAgainst: Uint8Array,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shed-check-"));
  const built = loadGraphBytes(graph);
  const artifact = encodeSheds(
    [],
    loadGraphBytes(placedAgainst).keyHash,
    LAST_DAY,
    [],
  );
  await Promise.all([
    writeFile(join(dir, "nyc.bin"), graph),
    writeFile(
      join(dir, "nyc.version.json"),
      JSON.stringify({
        graph: "nyc.bin",
        hash: built.hash,
        keyHash: built.keyHash,
      }),
    ),
    writeFile(join(dir, "open.bin"), artifact.open),
    writeFile(join(dir, "closed.bin"), artifact.closed),
  ]);
  return dir;
}

const GRAPH = graphBytes(EDGES);

test("a deploy whose artifact names its own key space passes", async () => {
  const dir = await deploy(GRAPH, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).resolves.toBeUndefined();
});

// The failure this gate had all along: the graph pass runs on the deploy's Linux and by hand on a
// macOS laptop, and the geodesic and offset maths land a few f32 lengths a ulp apart between them.
// Not one shed moves, and a gate on the graph's bytes could never be passed by an artifact placed on
// the other machine.
test("a rebuild that moved only the lengths still passes", async () => {
  const perturbed = new Uint8Array(GRAPH);
  const view = new DataView(perturbed.buffer);
  const records = perturbed.length - 8 - EDGES.length * EDGE_RECORD_BYTES;
  for (let edge = 0; edge < EDGES.length; edge++) {
    const at = records + edge * EDGE_RECORD_BYTES + 8;
    const bits = new DataView(new ArrayBuffer(4));
    bits.setFloat32(0, view.getFloat32(at, true), true);
    bits.setUint32(0, bits.getUint32(0, true) + 1, true); // the next float up
    view.setFloat32(at, bits.getFloat32(0, true), true);
  }
  expect(loadGraphBytes(perturbed).hash).not.toBe(loadGraphBytes(GRAPH).hash);
  const dir = await deploy(perturbed, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).resolves.toBeUndefined();
});

test("a rebuild that split a source differently fails the deploy", async () => {
  // The same street cut in three where it was cut in two: every span placed on the old ordinal 1
  // now names a different stretch of pavement.
  const resplit = graphBytes([
    ...EDGES,
    { sourceId: 88, side: 1, ordinal: 2, length: 12.25 },
  ]);
  const dir = await deploy(resplit, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).rejects.toThrow(
    `placed against key space ${loadGraphBytes(GRAPH).keyHash}, this graph's is` +
      ` ${loadGraphBytes(resplit).keyHash}`,
  );
});

test("a rebuild that shifted an ordinal fails the deploy", async () => {
  const shifted = graphBytes(
    EDGES.map((edge, index) =>
      index === 1 ? { ...edge, ordinal: 2 } : { ...edge },
    ),
  );
  const dir = await deploy(shifted, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).rejects.toThrow(
    "so every shed would resolve to nothing on the deployed map",
  );
});

test("a version file that has drifted from the graph fails too", async () => {
  const dir = await deploy(GRAPH, GRAPH);
  await writeFile(
    join(dir, "nyc.version.json"),
    JSON.stringify({
      graph: "nyc.bin",
      hash: loadGraphBytes(GRAPH).hash,
      keyHash: "0000000000000000",
    }),
  );

  // The client takes what it gates on from this file rather than recomputing it, so a stale one
  // blanks the map exactly as a stale artifact does.
  await expect(checkSheds(join(dir, "nyc.bin"), dir)).rejects.toThrow(
    "the deploy would serve a graph it names wrongly",
  );
});
