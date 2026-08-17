// `bun run build-tiles`, first step: puts the committed sources the client reads verbatim where it
// can fetch them — data/<kind>/<id>.bin -> public/<kind>/<id>.bin for the point and line overlays,
// plus the TREE blob the genus dots are drawn live from. Nothing here is rendered, so it is
// independent of whether the tiler has any work to do and runs on every build. See scripts/README.md.

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import manifest from "../src/tree-cover/manifest.json";

type City = (typeof manifest.cities)[number];

// The genus overlay is a later manifest addition, so a city read from the committed JSON may not
// carry it yet; test for it structurally so this compiles against either shape.
function hasGenusLayer(city: City): boolean {
  return (city.field as { genus?: unknown }).genus != null;
}

const DATA_DIR = join(import.meta.dirname, "..", "data");
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
// The tree points themselves, served so the client can draw the crisp genus dots live from z15 up
// where the raster pyramid stops. Copied verbatim from data/trees/*.bin (the TREE v3 blob).
const TREE_DIR = join(PUBLIC_DIR, "trees");
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Every directory this serves is emptied and recreated first, not written over: a city dropped from
// the manifest or a source that stops being ingested would otherwise keep serving the file its last
// build left, and the client would draw an overlay nothing else in the build still knows about.
async function serve(dir: string, files: [string, string][]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [source, name] of files) {
    await copyFile(source, join(dir, name));
  }
}

async function serveSources(): Promise<void> {
  const cities: City[] = manifest.cities;
  for (const kind of SERVED_SOURCES) {
    const present: [string, string][] = [];
    for (const city of cities) {
      const source = join(DATA_DIR, kind, `${city.id}.bin`);
      if (await fileExists(source)) {
        present.push([source, `${city.id}.bin`]);
      }
    }
    await serve(join(PUBLIC_DIR, kind), present);
  }
  await serve(
    TREE_DIR,
    cities
      .filter(hasGenusLayer)
      .map((city) => [
        join(DATA_DIR, "trees", city.field.trees.file),
        city.field.trees.file,
      ]),
  );
}

await serveSources();
