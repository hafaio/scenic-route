// `bun run build-tiles`, second step: writes the plan `tiler build` renders from — .build/plan.json,
// build glue rather than an artifact, handed over fresh on every run. It emits and nothing else.
// Which passes run at all is the tiler's decision, made pass by pass from stamps it computes over
// the inputs each one reads; the passes themselves, the directories they own and the pyramids at
// public/tiles/canopy/{z}/{x}/{y}.webp and the vector chunks at public/streets/{x}/{y}.bin are all
// its side of the line. What is left here is what only TypeScript knows: the colour ramp, the sun
// grid, the resolved DEM, which committed sources each city has, and the hash of the tiler's own
// sources below. See scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import manifest from "../src/tree-cover/manifest.json";
import { rampAlpha, rampColor } from "../src/tree-cover/ramp";
import { fetchElevationRaster } from "./elevation";
import {
  computeShadeBuckets,
  SHADE_MAX_SHADOW_METERS,
  SHADE_MAX_ZOOM,
} from "./shade-schedule";
import { tilerSources } from "./tiler";

type City = (typeof manifest.cities)[number];

const ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(ROOT, "data");
const PUBLIC_DIR = join(ROOT, "public");
const TILE_DIR = join(PUBLIC_DIR, "tiles");
// The measured LiDAR canopy pyramid, rendered from data/canopy/*.bin: the map's cover fill, blurred
// and coloured by the shared ramp.
const CANOPY_TILE_DIR = join(TILE_DIR, "canopy");
// The client-shaded genus dominance pyramid, rendered from data/trees/*.bin: four lossless data tiles
// per position, each carrying three genera's local crown density in R/G/B. The WebGL overlay
// (components/genus-gl-layer.tsx) colours them at render time.
const GENUS_FIELD_TILE_DIR = join(TILE_DIR, "genus-field");
const CHUNK_DIR = join(PUBLIC_DIR, "streets");
// The shadow casters the client sweeps for itself past the baked pyramid's deepest level, cut from
// the same footprints and crowns the shade pyramid rasterizes.
const CASTER_DIR = join(PUBLIC_DIR, "casters");
// The commercial overlay's precomputed per-segment signals, one file per STCK chunk. Derived,
// gitignored, like the chunks.
const COMMERCIAL_DIR = join(PUBLIC_DIR, "commercial");
// The qualifying-block centrelines the same pass emits, one file per city (magic CMLN), which the
// graph proximity-bakes into the per-edge commercial discount.
const COMMERCIAL_LINES_DIR = join(PUBLIC_DIR, "commercial-lines");
const ROUTING_DIR = join(PUBLIC_DIR, "routing");
// The graph pass's own cache: one directory of content-keyed entries per city, holding that city's
// finished topology and one file per attribute column baked over it. Gitignored build glue like the
// plan beside it — a build that finds it empty computes everything.
const GRAPH_CACHE_DIR = join(ROOT, ".build", "graph-cache");
// The graph inputs referenced by convention, `data/<kind>/<id>.bin`: they sit outside the manifest
// because its versioned CityEntry schema would throw for existing cities if bumped, so the plan
// names the ones actually on disk and the tiler resolves the same convention.
const CONVENTION_SOURCES = [
  "sidewalks",
  "ferries",
  "landmarks",
  "art",
  "highways",
  "industrial",
  "historic",
  "buildings",
] as const;
type ConventionSource = (typeof CONVENTION_SOURCES)[number];
const MANIFEST_PATH = join(ROOT, "src", "tree-cover", "manifest.json");
// The shed guard's plan (`bun run graph-inputs`): the same decisions, minus the DEM. It runs on
// every push, where resolving San Francisco's mosaic would be a 1.77 GB download to describe a
// block no durable key can depend on — the relief byte is baked over edges that are already final.
// It is written somewhere else so a plan with no elevation can never be mistaken for one a build
// should render from.
const KEY_SPACE = process.argv.includes("--key-space");
// Handed to the tiler by a package.json script, which can name no temporary directory, so the plan
// lands in a gitignored one of our own at the repo root.
const PLAN_PATH = join(
  ROOT,
  ".build",
  KEY_SPACE ? "key-space-plan.json" : "plan.json",
);

interface PlanCity {
  id: string;
  alleys: boolean;
  sources: ConventionSource[];
  shade?: {
    maxZoom: number;
    maxShadowMeters: number;
    buckets: ReturnType<typeof computeShadeBuckets>;
  };
  elevation?: { crs: string; band: number; tiles: string[] };
}

// What the nine argv lists carried, in one document. Its schema is documented in scripts/README.md
// and deserialized by crates/tiler/src/build.rs, which rejects unknown keys at every level.
interface Plan {
  code: Record<string, string>;
  manifest: string;
  data: string;
  chunks: string;
  casters: string;
  commercialSignals: string;
  commercialLines: string;
  tiles: string;
  canopyTiles: string;
  genusFieldTiles: string;
  routing: string;
  graphCache: string;
  ramp: number[];
  cities: PlanCity[];
}

// RGBA for every density a field byte can hold. The ramp is a *TypeScript* module because the
// client's street layer imports the very same one, which is what makes the block fill and the
// street lines one colour function; the tiler is handed the 256 steps of it rather than a
// second definition to drift from.
function rampTable(): number[] {
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
  return Array.from(table);
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

// The tiler crate file by file: repo-relative path -> the sha256 of its bytes. The tiler folds the
// whole map into every pass's stamp bar one, so an edit to the kernel invalidates the pyramid the
// old one rendered — including an output whose FORMAT changed, which no input file would have moved.
// Content, NOT mtime: a fresh checkout (CI) rewrites mtimes without changing a byte, which would
// otherwise force a needless twenty-minute render and leave CI's cache of the tiles unusable. The
// path is repo-relative and the map is keyed on it, so the hashes are the same on a laptop and on a
// CI runner.
//
// A MAP rather than the one digest this used to be, because the shade pass names the modules it is
// a function of — the pyramid is most of the build, and an edit to the graph is no reason to render
// it again — and it can only hash those if the plan carries them apart.
//
// The `data/**` bytes used to be hashed here too, into one whole-build stamp. They are not any
// more: the tiler hashes the inputs of each pass for itself, which is what lets one changed source
// rerun one pass, and it does not read 168 MB through bun to find out.
async function codeFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await tilerSources()) {
    files[relative(ROOT, path)] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return files;
}

// The two things the tiler cannot work out for itself, plus which committed sources this city has.
// The sun grid is computed here because the client inverts the same module, and the DEM is resolved
// here because fetching the mosaic is TypeScript's job.
async function planCity(city: City): Promise<PlanCity> {
  const present = await Promise.all(
    CONVENTION_SOURCES.map(async (kind) =>
      (await fileExists(sourcePath(kind, `${city.id}.bin`))) ? kind : null,
    ),
  );
  // One grid per city: a bin's sun position is synthesised at the city's own latitude, so two cities
  // share neither what an index means nor how many indices exist. Empty when the year yields no
  // above-horizon bin, and then the city gets no shade pyramid and no per-edge bake.
  const buckets = computeShadeBuckets(city.id);
  const raster = KEY_SPACE ? null : await fetchElevationRaster(city.id);
  return {
    id: city.id,
    // The alley invariants assert New York's meaning of an alley; a city whose centreline has no such
    // class says so rather than being asked about it.
    alleys: city.streets.alleys ?? true,
    sources: present.filter((kind): kind is ConventionSource => kind !== null),
    ...(buckets.length > 0
      ? {
          shade: {
            maxZoom: SHADE_MAX_ZOOM,
            maxShadowMeters: SHADE_MAX_SHADOW_METERS,
            buckets,
          },
        }
      : {}),
    ...(raster
      ? {
          elevation: {
            crs: raster.crs,
            band: raster.band,
            tiles: raster.paths,
          },
        }
      : {}),
  };
}

async function writePlan(): Promise<void> {
  const cities: City[] = manifest.cities;
  const plan: Plan = {
    code: await codeFiles(),
    manifest: MANIFEST_PATH,
    data: DATA_DIR,
    chunks: CHUNK_DIR,
    casters: CASTER_DIR,
    commercialSignals: COMMERCIAL_DIR,
    commercialLines: COMMERCIAL_LINES_DIR,
    tiles: TILE_DIR,
    canopyTiles: CANOPY_TILE_DIR,
    genusFieldTiles: GENUS_FIELD_TILE_DIR,
    routing: ROUTING_DIR,
    graphCache: GRAPH_CACHE_DIR,
    ramp: rampTable(),
    cities: await Promise.all(cities.map(planCity)),
  };
  await mkdir(join(ROOT, ".build"), { recursive: true });
  await writeFile(PLAN_PATH, JSON.stringify(plan));
}

await writePlan();
