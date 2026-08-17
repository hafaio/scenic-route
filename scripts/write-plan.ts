// `bun run build-tiles`, second step: writes the plan `tiler build` renders from — .build/plan.json,
// build glue rather than an artifact, handed over fresh on every run. It emits and nothing else. The
// decision to render at all is the tiler's, made from the `stamp` below; the passes themselves, the
// directories they own and the pyramids at public/tiles/canopy/{z}/{x}/{y}.webp and the vector chunks
// at public/streets/{x}/{y}.bin are all its side of the line. See scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
// The graph inputs referenced by convention, `data/<kind>/<id>.bin`: they sit outside the manifest
// because its versioned CityEntry schema would throw for existing cities if bumped, so the plan
// names the ones actually on disk and the tiler resolves the same convention.
const CONVENTION_SOURCES = [
  "sidewalks",
  "ferries",
  "landmarks",
  "art",
  "highways",
  "buildings",
] as const;
type ConventionSource = (typeof CONVENTION_SOURCES)[number];
const MANIFEST_PATH = join(ROOT, "src", "tree-cover", "manifest.json");
const RAMP_PATH = join(ROOT, "src", "tree-cover", "ramp.ts");
// The sun-position grid scripts/shade-schedule.ts synthesises every bin from. It sits in src/ because
// the client inverts the same grid, so the scripts/ glob below does not see it — and a bin boundary
// moving there re-cuts both the shade pyramid and the graph's own per-edge bake.
const SUN_PATH = join(ROOT, "src", "shade", "sun.ts");
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
  stamp: string;
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

// The content hash of every input the tiler reads, carried in the plan so the tiler can compare it
// against what it recorded last time and skip a build whose inputs are all byte-identical. Content,
// NOT mtime — a fresh checkout (CI) or a `touch` rewrites mtimes without changing the bytes, which
// would otherwise force a needless full rebuild and, worse, leave a cache of the derived tiles
// unusable across CI runs.
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
      // The graph's existence gate reads the per-side sidewalk bits, and `scripts/sidewalks.ts`
      // stamps those from the sidewalk extract in the same run that writes it — so a sidewalk
      // re-ingest that does not move a bit must still be seen here, or a later reader of the extract
      // itself would stay falsely fresh.
      ...CONVENTION_SOURCES,
      // The commercial overlay's precomputed signals are snapped from these; a re-ingest of any must
      // refresh the build so the commercial pass re-runs.
      "landuse",
      "dining",
      "openstreets",
    ].map((kind) => sourcePath(kind, `${city.id}.bin`)),
  );
  const present = await Promise.all(
    convention.map(async (path) => ((await fileExists(path)) ? path : null)),
  );
  paths.push(...present.filter((path): path is string => path !== null));

  // Repo-relative path + a separator + the bytes of each input, in a stable order, so the digest is
  // deterministic and location-independent (the same on a laptop and a CI runner).
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    hash.update(relative(ROOT, path));
    hash.update("\0");
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
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
    stamp: await inputsHash(cities),
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
    ramp: rampTable(),
    cities: await Promise.all(cities.map(planCity)),
  };
  await mkdir(join(ROOT, ".build"), { recursive: true });
  await writeFile(PLAN_PATH, JSON.stringify(plan));
}

await writePlan();
