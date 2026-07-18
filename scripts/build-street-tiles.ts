// `bun run build-tiles`: renders data/{canopy,land,streets,paths}/<id>.bin into what the client
// draws — the blurred canopy raster pyramid at public/tiles/canopy/{z}/{x}/{y}.webp and the vector
// chunks at public/streets/{x}/{y}.bin. Both are gitignored build output, rebuilt by `bun dev`
// and `bun export`. The rendering itself is crates/tiler; this decides whether it needs to run
// and hands it the colour ramp. See scripts/README.md.

import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENUS_COLORS, GENUS_COUNT } from "../src/tree-cover/genus";
import manifest from "../src/tree-cover/manifest.json";
import { rampAlpha, rampColor } from "../src/tree-cover/ramp";
import { runTiler, tilerSources } from "./tiler";

type City = (typeof manifest.cities)[number];

// The genus overlay is a later manifest addition, so a city read from the committed JSON may not
// carry it yet; test for it structurally so this compiles against either shape.
function hasGenusLayer(city: City): boolean {
  return (city.field as { genus?: unknown }).genus != null;
}

const DATA_DIR = join(import.meta.dirname, "..", "data");
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
// The measured LiDAR canopy pyramid, rendered by `tiler canopy` from data/canopy/*.bin: the
// map's cover fill, blurred and coloured by the shared ramp.
const CANOPY_TILE_DIR = join(PUBLIC_DIR, "tiles", "canopy");
// The per-genus blend pyramid, rendered by `tiler genus` from data/trees/*.bin: a proportional
// mix of genus colours at each pixel, faded by the same cover curve as the canopy fill.
const GENUS_TILE_DIR = join(PUBLIC_DIR, "tiles", "genus");
// The tree points themselves, served so the client can draw the crisp genus dots live from z15 up
// where the raster pyramid stops. Copied verbatim from data/trees/*.bin (the TREE v3 blob).
const TREE_DIR = join(PUBLIC_DIR, "trees");
const CHUNK_DIR = join(PUBLIC_DIR, "streets");
const ROUTING_DIR = join(PUBLIC_DIR, "routing");
const STAMP_PATH = join(CANOPY_TILE_DIR, ".stamp");
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
const GENUS_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "genus.ts",
);
// Build glue, not an artifact: the tiler is handed fresh ones on every run.
const RAMP_LUT_PATH = join(tmpdir(), "scenic-route-ramp.bin");
const GENUS_PALETTE_LUT_PATH = join(tmpdir(), "scenic-route-genus-palette.bin");

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

// The genus palette, one opaque RGBA entry per genus id, in the same order the TREE genus bytes
// index. It is a TypeScript module for the same reason the ramp is: the legend swatches the client
// draws read the very same GENUS_COLORS, so a blended tile and its key cannot drift.
async function writeGenusPalette(): Promise<void> {
  const table = new Uint8ClampedArray(GENUS_COUNT * 4);
  for (let id = 0; id < GENUS_COUNT; id++) {
    const { red, green, blue } = GENUS_COLORS[id];
    const offset = id * 4;
    table[offset] = red;
    table[offset + 1] = green;
    table[offset + 2] = blue;
    table[offset + 3] = 255;
  }
  await writeFile(GENUS_PALETTE_LUT_PATH, table);
}

function sourcePath(directory: string, file: string): string {
  return join(DATA_DIR, directory, file);
}

async function newestInputMtime(cities: City[]): Promise<number> {
  const paths = [
    MANIFEST_PATH,
    RAMP_PATH,
    GENUS_PATH,
    import.meta.filename,
    ...(await tilerSources()),
    ...cities.flatMap((city) => [
      sourcePath("streets", city.streets.file),
      sourcePath("land", city.field.land.file),
      sourcePath("trees", city.field.trees.file),
      ...(city.field.canopy
        ? [sourcePath("canopy", city.field.canopy.file)]
        : []),
      ...(city.paths ? [sourcePath("paths", city.paths.file)] : []),
    ]),
  ];
  const stats = await Promise.all(paths.map((path) => stat(path)));
  return Math.max(...stats.map((entry) => entry.mtimeMs));
}

async function isFresh(cities: City[]): Promise<boolean> {
  try {
    const stamp = await stat(STAMP_PATH);
    await stat(GENUS_TILE_DIR);
    await stat(TREE_DIR);
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

  await rm(CANOPY_TILE_DIR, { recursive: true, force: true });
  await rm(GENUS_TILE_DIR, { recursive: true, force: true });
  await rm(TREE_DIR, { recursive: true, force: true });
  await rm(CHUNK_DIR, { recursive: true, force: true });
  await rm(ROUTING_DIR, { recursive: true, force: true });
  await mkdir(CANOPY_TILE_DIR, { recursive: true });
  await mkdir(GENUS_TILE_DIR, { recursive: true });
  await mkdir(TREE_DIR, { recursive: true });
  await mkdir(CHUNK_DIR, { recursive: true });
  await mkdir(ROUTING_DIR, { recursive: true });
  await writeRamp();
  await writeGenusPalette();

  // The tree points, served for the client's live genus dots: the TREE v3 blob copied verbatim,
  // one per city that carries a genus layer.
  for (const city of cities) {
    if (hasGenusLayer(city)) {
      await copyFile(
        sourcePath("trees", city.field.trees.file),
        join(TREE_DIR, city.field.trees.file),
      );
    }
  }

  const chunksArgs = [
    "chunks",
    "--manifest",
    MANIFEST_PATH,
    "--data",
    DATA_DIR,
    "--chunks",
    CHUNK_DIR,
  ];
  // The OSM paths are drawn into the same z12 street chunks; the single-city manifest carries one
  // paths layer, so it rides along here as it does for the graph.
  const withPaths = cities.find((city) => city.paths);
  if (withPaths?.paths) {
    chunksArgs.push("--paths", sourcePath("paths", withPaths.paths.file));
  }
  runTiler(chunksArgs, false);

  // The blurred LiDAR canopy pyramid, coloured by the shared ramp LUT: the map's cover fill. The
  // subcommand renders every manifest city that carries a canopy layer, so it runs once when any
  // city does.
  if (cities.some((city) => city.field.canopy)) {
    runTiler(
      [
        "canopy",
        "--manifest",
        MANIFEST_PATH,
        "--ramp",
        RAMP_LUT_PATH,
        "--data",
        DATA_DIR,
        "--tiles",
        CANOPY_TILE_DIR,
      ],
      false,
    );
  }

  // The per-tree genus map: each tree a crown-sized, genus-coloured disc, drawn with the shared
  // palette. The subcommand renders every manifest city that carries a genus layer.
  if (cities.some(hasGenusLayer)) {
    runTiler(
      [
        "genus",
        "--manifest",
        MANIFEST_PATH,
        "--palette",
        GENUS_PALETTE_LUT_PATH,
        "--data",
        DATA_DIR,
        "--tiles",
        GENUS_TILE_DIR,
      ],
      false,
    );
  }

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
