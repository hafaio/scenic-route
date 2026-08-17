// `bun run build-tiles`: renders data/{canopy,land,streets,paths}/<id>.bin into what the client
// draws — the blurred canopy raster pyramid at public/tiles/canopy/{z}/{x}/{y}.webp and the vector
// chunks at public/streets/{x}/{y}.bin. Both are gitignored build output, rebuilt by `bun dev`
// and `bun export`. The rendering itself is crates/tiler; this decides whether it needs to run
// and hands it the colour ramp. See scripts/README.md.

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import manifest from "../src/tree-cover/manifest.json";
import { rampAlpha, rampColor } from "../src/tree-cover/ramp";
import { fetchElevationRaster } from "./elevation";
import {
  computeShadeBuckets,
  SHADE_MAX_SHADOW_METERS,
  SHADE_MAX_ZOOM,
} from "./shade-schedule";
import { runTiler, tilerSources, writeList } from "./tiler";

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
// The client-shaded genus dominance pyramid, rendered by `tiler genus-field` from data/trees/*.bin:
// four lossless data tiles per position, each carrying three genera's local crown density in R/G/B.
// The WebGL overlay (components/genus-gl-layer.tsx) colours them at render time.
const GENUS_FIELD_TILE_DIR = join(PUBLIC_DIR, "tiles", "genus-field");
// The tree points themselves, served so the client can draw the crisp genus dots live from z15 up
// where the raster pyramid stops. Copied verbatim from data/trees/*.bin (the TREE v3 blob).
const TREE_DIR = join(PUBLIC_DIR, "trees");
const CHUNK_DIR = join(PUBLIC_DIR, "streets");
// The shadow casters the client sweeps for itself past the baked pyramid's deepest level, written
// by `tiler caster-chunks` from the same footprints and crowns `tiler shade` rasterizes.
const CASTER_DIR = join(PUBLIC_DIR, "casters");
// The commercial overlay's precomputed per-segment signals, one file per STCK chunk, written by
// `tiler commercial` after the chunks exist. Derived, gitignored, like the chunks.
const COMMERCIAL_DIR = join(PUBLIC_DIR, "commercial");
// The qualifying-block centrelines the same pass emits, one file per city (magic CMLN), which
// `tiler graph --commercial` proximity-bakes into the per-edge commercial discount.
const COMMERCIAL_LINES_DIR = join(PUBLIC_DIR, "commercial-lines");
const commercialLinesPath = (cityId: string): string =>
  join(COMMERCIAL_LINES_DIR, `${cityId}.bin`);
const ROUTING_DIR = join(PUBLIC_DIR, "routing");
// The graph's list of the OSM paths its island drop stranded, which the second chunk pass reads back.
// Per city, beside its graph: the ids are OSM's and cannot collide, but one file would be
// written by each city's graph pass and only the last would survive.
const strandedPath = (cityId: string): string =>
  join(ROUTING_DIR, `${cityId}.stranded.bin`);
const STAMP_PATH = join(CANOPY_TILE_DIR, ".stamp");
// Committed point/line sources served to the client verbatim for the map overlays (dots and lines).
// Not rendered by the tiler, so they are copied straight across whenever their file is present.
const SERVED_SOURCES = [
  "landmarks",
  "art",
  "ferries",
  "highways",
  "dining",
  "openstreets",
  "landuse",
] as const;
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
// The sun-position grid scripts/shade-schedule.ts synthesises every bin from. It sits in src/ because
// the client inverts the same grid, so the scripts/ glob below does not see it — and a bin boundary
// moving there re-cuts both the shade pyramid and the graph's own per-edge bake.
const SUN_PATH = join(import.meta.dirname, "..", "src", "shade", "sun.ts");
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The content hash of every input the tiler reads: a rebuild is skipped only when they are all
// byte-identical to the last run. Content, NOT mtime — a fresh checkout (CI) or a `touch` rewrites
// mtimes without changing the bytes, which would otherwise force a needless full rebuild and, worse,
// leave a cache of the derived tiles unusable across CI runs. The stamp file stores this hash.
async function inputsHash(cities: City[]): Promise<string> {
  // Every build script, not just this one and the ones it imports: the ingests share helpers
  // (geometry.ts, land.ts, …) whose output the tiles depend on, so hashing the whole scripts/ dir
  // is what actually closes the "edit a helper, stay falsely fresh" hole. Over-inclusive (an
  // unrelated script forces a rebuild) but never false-fresh, and it matches the CI cache key's
  // `scripts/*.ts` glob.
  const scripts = (await readdir(import.meta.dirname))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(import.meta.dirname, file));
  const paths = [
    MANIFEST_PATH,
    RAMP_PATH,
    SUN_PATH,
    ...scripts,
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
  // The by-convention graph inputs (ferries + the scenic factors) are not in the manifest, so a
  // change to one must still refresh the build: include each that exists on disk.
  const convention = cities.flatMap((city) =>
    [
      "ferries",
      "landmarks",
      "art",
      "highways",
      // The commercial overlay's precomputed signals are snapped from these; a re-ingest of any must
      // refresh the build so `tiler commercial` re-runs.
      "landuse",
      "dining",
      "openstreets",
      "buildings",
      // The graph's existence gate reads the per-side sidewalk bits, and `scripts/sidewalks.ts`
      // stamps those from this extract in the same run that writes it — so a sidewalk re-ingest that
      // does not move a bit must still be seen here, or a later reader of the extract itself would
      // stay falsely fresh.
      "sidewalks",
    ].map((kind) => sourcePath(kind, `${city.id}.bin`)),
  );
  const present = await Promise.all(
    convention.map(async (path) => ((await fileExists(path)) ? path : null)),
  );
  paths.push(...present.filter((path): path is string => path !== null));

  // Repo-relative path + a separator + the bytes of each input, in a stable order, so the digest is
  // deterministic and location-independent (the same on a laptop and a CI runner).
  const root = join(import.meta.dirname, "..");
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

async function isFresh(hash: string): Promise<boolean> {
  try {
    const [stamp] = await Promise.all([
      readFile(STAMP_PATH, "utf8"),
      stat(GENUS_FIELD_TILE_DIR),
      stat(TREE_DIR),
      stat(CHUNK_DIR),
      stat(CASTER_DIR),
      stat(COMMERCIAL_DIR),
      stat(ROUTING_DIR),
    ]);
    return stamp.trim() === hash;
  } catch {
    return false;
  }
}

// Copies the served point/line sources (data/<kind>/<id>.bin -> public/<kind>/<id>.bin) verbatim for
// the overlay layers. Independent of the tiler, so it runs even when the tile pyramids are fresh.
async function serveSources(cities: City[]): Promise<void> {
  for (const kind of SERVED_SOURCES) {
    for (const city of cities) {
      const source = sourcePath(kind, `${city.id}.bin`);
      if (await fileExists(source)) {
        const dir = join(PUBLIC_DIR, kind);
        await mkdir(dir, { recursive: true });
        await copyFile(source, join(dir, `${city.id}.bin`));
      }
    }
  }
}

async function build(): Promise<void> {
  const cities: City[] = manifest.cities;
  await serveSources(cities);
  const hash = await inputsHash(cities);
  if (await isFresh(hash)) {
    console.error("street overlays are up to date");
    return;
  }

  await rm(CANOPY_TILE_DIR, { recursive: true, force: true });
  await rm(GENUS_FIELD_TILE_DIR, { recursive: true, force: true });
  await rm(TREE_DIR, { recursive: true, force: true });
  await rm(CHUNK_DIR, { recursive: true, force: true });
  await rm(CASTER_DIR, { recursive: true, force: true });
  await rm(ROUTING_DIR, { recursive: true, force: true });
  await mkdir(CANOPY_TILE_DIR, { recursive: true });
  await mkdir(GENUS_FIELD_TILE_DIR, { recursive: true });
  await mkdir(TREE_DIR, { recursive: true });
  await mkdir(CHUNK_DIR, { recursive: true });
  await mkdir(CASTER_DIR, { recursive: true });
  await mkdir(ROUTING_DIR, { recursive: true });
  await writeRamp();

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
  // The OSM paths are drawn into the same z12 street chunks. `tiler chunks` reads each city's own
  // paths layer out of the manifest, so there is nothing to pass here.
  runTiler(chunksArgs, false);

  // The commercial overlay's per-segment signals: snapped from the committed sources onto the STCK
  // chunks the tiler just wrote, so this must run after them. Own rm/mkdir of both directories.
  runTiler(
    [
      "commercial",
      "--manifest",
      MANIFEST_PATH,
      "--data",
      DATA_DIR,
      "--chunks",
      CHUNK_DIR,
      "--signals",
      COMMERCIAL_DIR,
      "--lines",
      COMMERCIAL_LINES_DIR,
    ],
    false,
  );

  // The shade overlay's shadow-tile pyramids, one per time-of-day bucket, cast from the building
  // footprints and from the canopy's crown heights by `tiler shade` — the tree one only when a city
  // carries measured heights. The sun schedule (suncalc) is computed here and passed as params;
  // stale tiles are cleared first so a shrunk schedule leaves nothing behind.
  // The sun-position params drive both the shade tile pyramid and the per-edge SHDE routing bake, so
  // they are written once here and shared; null when the year yields no above-horizon bin.
  // One set of params per city: a bin's sun position is synthesised at the city's own latitude, so
  // the grids differ in what each index means and in how many indices there are at all.
  const shadeParams = new Map<string, string>();
  for (const city of cities) {
    const buckets = computeShadeBuckets(city.id);
    if (buckets.length === 0) {
      continue;
    }
    const path = join(tmpdir(), `scenic-shade-params.${city.id}.json`);
    await writeFile(
      path,
      JSON.stringify({
        maxZoom: SHADE_MAX_ZOOM,
        maxShadowMeters: SHADE_MAX_SHADOW_METERS,
        buckets,
      }),
    );
    shadeParams.set(city.id, path);
  }
  // The caster chunks are geometry on a shared x/y grid and carry no sun position, so they are cut
  // once over every city; any city's params carry the halo they are gathered over.
  const anyShadeParams = shadeParams.values().next().value ?? null;
  const anyBuildings = (
    await Promise.all(
      cities.map((city) =>
        fileExists(sourcePath("buildings", `${city.id}.bin`)),
      ),
    )
  ).some(Boolean);
  // The same casters as vectors, one chunk per z15 tile, for the shadows the client generates itself
  // past the pyramid's deepest baked level. Either source alone is worth chunking, and the halo the
  // client gathers them over comes from the shared params' maxShadowMeters.
  if (
    anyShadeParams &&
    (anyBuildings || cities.some((city) => city.field.canopy))
  ) {
    runTiler(
      [
        "caster-chunks",
        "--manifest",
        MANIFEST_PATH,
        "--data",
        DATA_DIR,
        "--chunks",
        CASTER_DIR,
        "--params",
        anyShadeParams,
      ],
      false,
    );
  }
  if (anyBuildings) {
    for (const pyramid of ["shade", "tree-shade"]) {
      await rm(join(PUBLIC_DIR, "tiles", pyramid), {
        recursive: true,
        force: true,
      });
    }
    for (const city of cities) {
      const params = shadeParams.get(city.id);
      if (
        params &&
        (await fileExists(sourcePath("buildings", `${city.id}.bin`)))
      ) {
        runTiler(
          [
            "shade",
            "--manifest",
            MANIFEST_PATH,
            "--data",
            DATA_DIR,
            "--tiles",
            join(PUBLIC_DIR, "tiles"),
            "--params",
            params,
            "--city",
            city.id,
          ],
          false,
        );
      }
    }
  }

  // The terrain overlay, one city at a time because the DEM tiles are per city and on the city's own
  // projected grid. A city with no elevation source is skipped rather than rendered empty. The tile
  // list is kept for the graph's relief bake below, which reads the same mosaic.
  const elevationByCity = new Map<
    string,
    { listPath: string; crs: string; band: number }
  >();
  await rm(join(PUBLIC_DIR, "tiles", "elevation"), {
    recursive: true,
    force: true,
  });
  for (const city of cities) {
    const raster = await fetchElevationRaster(city.id);
    if (!raster) {
      continue;
    }
    const listPath = await writeList(`dem-${city.id}`, raster.paths);
    elevationByCity.set(city.id, {
      listPath,
      crs: raster.crs,
      band: raster.band,
    });
    runTiler(
      [
        "elevation",
        "--manifest",
        MANIFEST_PATH,
        "--tiles",
        join(PUBLIC_DIR, "tiles"),
        "--city",
        city.id,
        "--dem",
        listPath,
        "--band",
        String(raster.band),
        "--elevation-crs",
        raster.crs,
        // The DEM answers over water too, so the overlay is clipped to the city's own land.
        "--land",
        join(DATA_DIR, "land", `${city.id}.bin`),
      ],
      false,
    );
  }

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

  // The client-shaded genus dominance data pyramid, rendered from the trees. Lossless RGB density
  // tiles the WebGL overlay colours live; no palette, since the client owns the colours.
  if (cities.some(hasGenusLayer)) {
    runTiler(
      [
        "genus-field",
        "--manifest",
        MANIFEST_PATH,
        "--data",
        DATA_DIR,
        "--tiles",
        GENUS_FIELD_TILE_DIR,
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
    // The ferry graph and the scenic-factor sources are referenced by convention
    // (data/<kind>/<id>.bin), not the manifest — its versioned CityEntry schema would throw for
    // existing cities if bumped — so each is passed only when its committed file is present.
    for (const [flag, kind] of [
      ["--sidewalks", "sidewalks"],
      ["--ferries", "ferries"],
      ["--landmarks", "landmarks"],
      ["--art", "art"],
      ["--highways", "highways"],
    ] as const) {
      const file = sourcePath(kind, `${city.id}.bin`);
      if (await fileExists(file)) {
        graphArgs.push(flag, file);
      }
    }
    // The qualifying commercial-block lines are derived by buildCommercial (above), not a committed
    // source, so they come from public/commercial-lines rather than sourcePath.
    const commercialFile = commercialLinesPath(city.id);
    if (await fileExists(commercialFile)) {
      graphArgs.push("--commercial", commercialFile);
    }
    // The measured canopy does two jobs on this invocation: its polygons are integrated along every
    // sidewalk into the per-edge direct-canopy byte, and its crowns occlude the edges alongside the
    // buildings in the shade bake below.
    if (city.field.canopy) {
      graphArgs.push("--canopy", sourcePath("canopy", city.field.canopy.file));
    }
    // The per-edge shade bake rides on the same graph invocation: it needs the city's building
    // footprints and the shared sun-position params, and writes one file per sun-position bin into
    // public/routing/shade (cleared by the ROUTING_DIR rm above) plus a bins.json manifest.
    const buildingsFile = sourcePath("buildings", `${city.id}.bin`);
    const cityShadeParams = shadeParams.get(city.id);
    if (cityShadeParams && (await fileExists(buildingsFile))) {
      graphArgs.push(
        "--buildings",
        buildingsFile,
        "--shade-params",
        cityShadeParams,
        "--shade-dir",
        join(ROUTING_DIR, "shade", city.id),
      );
    }
    // The relief byte: how much height each edge climbs and drops, off the same DEM the terrain
    // overlay is drawn from. A city with no elevation source leaves every edge flat.
    const elevation = elevationByCity.get(city.id);
    if (elevation) {
      graphArgs.push(
        "--elevation",
        elevation.listPath,
        "--elevation-crs",
        elevation.crs,
        "--elevation-band",
        String(elevation.band),
        "--elevation-bounds",
        JSON.stringify(city.bounds),
      );
    }
    // The alley invariants assert New York's meaning of an alley; a city whose centreline has no
    // such class says so rather than being asked about it.
    graphArgs.push("--alleys", String(city.streets.alleys ?? true));
    graphArgs.push("--stranded-out", strandedPath(city.id));
    runTiler(graphArgs, false);
  }

  // The chunks above were written before the graph existed, so they still offer every OSM path the
  // source network carries — including the ones the island drop took away, which the overlay would
  // draw as a tree-lined walk no route can follow. Re-run over the same inputs with the graph's
  // answer: only the trailing stranded bitmap changes, so the commercial signals keyed on the
  // segment index stay aligned and need no rebuild.
  if (cities.some((city) => city.paths)) {
    runTiler([...chunksArgs, "--stranded-dir", ROUTING_DIR], false);
  }
  await writeFile(STAMP_PATH, hash);
}

await build();
