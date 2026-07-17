// `bun run build-tiles`: renders data/{trees,woodland,land,streets}/<id>.bin into the two
// overlays the client draws — raster tiles at public/tiles/tree-cover/{z}/{x}/{y}.png and vector
// chunks at public/streets/{x}/{y}.bin. Both are gitignored build output, rebuilt by `bun dev`
// and `bun export`. The rendering itself is crates/tiler; this decides whether it needs to run
// and hands it the colour ramp. See scripts/README.md.

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../src/tree-cover/manifest.json";
import { rampAlpha, rampColor } from "../src/tree-cover/ramp";
import { runTiler, tilerSources } from "./tiler";

type City = (typeof manifest.cities)[number];

const DATA_DIR = join(import.meta.dirname, "..", "data");
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const TILE_DIR = join(PUBLIC_DIR, "tiles", "tree-cover");
const CHUNK_DIR = join(PUBLIC_DIR, "streets");
const ROUTING_DIR = join(PUBLIC_DIR, "routing");
const STAMP_PATH = join(TILE_DIR, ".stamp");
const MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "manifest.json",
);
const RAMP_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "ramp.ts",
);
// Build glue, not an artifact: the tiler is handed a fresh one on every run.
const RAMP_LUT_PATH = join(tmpdir(), "scenic-route-ramp.bin");

// RGBA for every density a field byte can hold. The ramp is a *TypeScript* module because the
// client's street layer imports the very same one, which is what makes the block fill and the
// street lines one colour function; the tiler is handed the 256 steps of it rather than a
// second definition to drift from.
async function writeRamp(): Promise<void> {
  const table = new Uint8ClampedArray(256 * 4);
  for (let step = 0; step < 256; step++) {
    const density = step / 255;
    const { red, green, blue } = rampColor(density);
    const offset = step * 4;
    table[offset] = red;
    table[offset + 1] = green;
    table[offset + 2] = blue;
    table[offset + 3] = 255 * rampAlpha(density);
  }
  await writeFile(RAMP_LUT_PATH, table);
}

function sourcePath(directory: string, file: string): string {
  return join(DATA_DIR, directory, file);
}

async function newestInputMtime(cities: City[]): Promise<number> {
  const paths = [
    MANIFEST_PATH,
    RAMP_PATH,
    import.meta.filename,
    ...(await tilerSources()),
    ...cities.flatMap((city) => [
      sourcePath("streets", city.streets.file),
      sourcePath("trees", city.field.trees.file),
      sourcePath("woodland", city.field.woodland.file),
      sourcePath("land", city.field.land.file),
      ...(city.paths ? [sourcePath("paths", city.paths.file)] : []),
    ]),
  ];
  const stats = await Promise.all(paths.map((path) => stat(path)));
  return Math.max(...stats.map((entry) => entry.mtimeMs));
}

async function isFresh(cities: City[]): Promise<boolean> {
  try {
    const stamp = await stat(STAMP_PATH);
    await stat(CHUNK_DIR);
    await stat(ROUTING_DIR);
    return stamp.mtimeMs >= (await newestInputMtime(cities));
  } catch {
    return false;
  }
}

async function build(): Promise<void> {
  const cities: City[] = manifest.cities;
  if (await isFresh(cities)) {
    console.error("street overlays are up to date");
    return;
  }

  await rm(TILE_DIR, { recursive: true, force: true });
  await rm(CHUNK_DIR, { recursive: true, force: true });
  await rm(ROUTING_DIR, { recursive: true, force: true });
  await mkdir(TILE_DIR, { recursive: true });
  await mkdir(CHUNK_DIR, { recursive: true });
  await mkdir(ROUTING_DIR, { recursive: true });
  await writeRamp();

  const tilesArgs = [
    "tiles",
    "--manifest",
    MANIFEST_PATH,
    "--ramp",
    RAMP_LUT_PATH,
    "--data",
    DATA_DIR,
    "--tiles",
    TILE_DIR,
    "--chunks",
    CHUNK_DIR,
  ];
  // The OSM paths are drawn into the same z12 street chunks, coloured by their own cover; the
  // single-city manifest carries one paths layer, so it rides along here as it does for the graph.
  const withPaths = cities.find((city) => city.paths);
  if (withPaths?.paths) {
    tilesArgs.push("--paths", sourcePath("paths", withPaths.paths.file));
  }
  runTiler(tilesArgs, false);

  // The routing graph is derived from the same STRT the chunks are, one artifact per city; its
  // one-line JSON stats go to stdout and land in the build log.
  for (const city of cities) {
    const graphArgs = [
      "graph",
      "--streets",
      sourcePath("streets", city.streets.file),
      "--out",
      join(ROUTING_DIR, `${city.id}.bin`),
    ];
    if (city.paths) {
      graphArgs.push("--paths", sourcePath("paths", city.paths.file));
    }
    runTiler(graphArgs, false);
  }
  await writeFile(STAMP_PATH, "");
}

await build();
