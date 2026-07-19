// `bun run scripts/highways.ts`: fetches the lines walking near is unpleasant — limited-access
// highways and elevated rail — and writes them as data/highways/nyc.bin (magic HWAY). A later phase
// rasterizes them into an areal proximity field and turns nearness into a per-edge routing PENALTY
// (the mirror of the discount POIs earn). Nuisance is areal, not path-bound — noise and grime carry
// through the air regardless of the street grid — so these ship as raw polylines, not graph edges,
// and are never routed. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePolygons } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import { fetchNuisanceLines, type NuisanceLine } from "./overpass";
import type { Coord } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const HIGHWAY_DIR = join(DATA_DIR, "highways");
const HIGHWAY_MAGIC = "HWAY";
const HIGHWAY_FORMAT = 1;

// A line is kept if its midpoint or either endpoint is on land — enough to drop the New Jersey and
// Westchester spill the city bounding box reaches, without clipping a bridge deck that only grazes
// the shoreline. The same test the path ingest uses.
function onLandLine(
  line: NuisanceLine,
  onLand: (coord: Coord) => boolean,
): boolean {
  const { points } = line;
  const midpoint = points[Math.floor(points.length / 2)];
  return (
    onLand(midpoint) || onLand(points[0]) || onLand(points[points.length - 1])
  );
}

export async function ingestHighways(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(HIGHWAY_DIR, { recursive: true });

  const { south, west, north, east } = land.box;
  const raw = await fetchNuisanceLines(south, west, north, east);
  const kept = raw.filter((line) => onLandLine(line, land.onLand));
  const highways = kept.filter((line) => line.kind === "highway").length;
  const railLines = kept.length - highways;

  // Each line is one open ring of a single-ring polygon record — the polygon blob's exact byte
  // layout, so the shared encoder and the Rust polygon reader carry it with no new format.
  const bytes = encodePolygons(
    HIGHWAY_MAGIC,
    HIGHWAY_FORMAT,
    kept.map((line) => [line.points]),
  );
  const file = `${cityId}.bin`;
  await writeFile(join(HIGHWAY_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `highways: ${raw.length} fetched, ${kept.length} on land (${highways} highway, ${railLines} above-ground rail), ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: HIGHWAY_FORMAT,
    count: kept.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestHighways("nyc", await loadLandContext());
}
