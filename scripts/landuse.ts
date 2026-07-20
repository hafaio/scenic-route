// `bun run scripts/landuse.ts`: fetches NYC PLUTO land use and writes it as data/landuse/nyc.bin
// (magic PLUT) — the tax-lot points, each tagged with its land-use class, that the commercial overlay
// gates blocks on. A block reads as commercial when more than half the lots fronting it are commercial
// land use (validated: Vanderbilt Ave ~77%, Prospect Place ~4%). Only the residential/commercial
// classes 1..5 are kept — the classes that make up a storefront-vs-brownstone frontage; the mixed,
// industrial, transport, institutional, open-space, parking, and vacant classes (6..11) do not. Points
// only, one class byte each. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ClassifiedPoint, encodeClassifiedPoints } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Coord } from "./socrata";
import { fetchDataset } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const LANDUSE_DIR = join(DATA_DIR, "landuse");
const LANDUSE_MAGIC = "PLUT";
const LANDUSE_FORMAT = 1;
const LANDUSE_DATASET = "64uk-42ks"; // PLUTO Primary Land Use Tax Lot Output
const LANDUSE_COUNT = 860_000; // ~860k tax lots at the last refresh; a floor, not a number
// The land-use digit kept: 1 one/two-family, 2 walk-up, 3 elevator (residential), 4 mixed
// residential/commercial, 5 commercial/office. Classes 6..11 (industrial, transport, institutional,
// open space, parking, vacant) never front a commercial block, so they are dropped here.
const MIN_CLASS = 1;
const MAX_CLASS = 5;

interface LandUseRow {
  landuse?: string; // the PLUTO land-use code "01".."11"; the overlay reads the digit 1..5
  latitude?: string;
  longitude?: string;
}

function toPoints(
  rows: LandUseRow[],
  onLand: (coord: Coord) => boolean,
): ClassifiedPoint[] {
  const points: ClassifiedPoint[] = [];
  for (const row of rows) {
    const klass = Number.parseInt(row.landuse ?? "", 10);
    if (!Number.isInteger(klass) || klass < MIN_CLASS || klass > MAX_CLASS) {
      continue;
    }
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    // Some lots carry blank or 0/0 coordinates; NYC never sits on the null island, so drop those.
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat === 0 ||
      lng === 0
    ) {
      continue;
    }
    const point = { lat, lng, klass };
    if (onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

export async function ingestLandUse(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(LANDUSE_DIR, { recursive: true });

  // A narrowed $select: 860k lots carry dozens of columns each, so pulling only the three the
  // overlay reads keeps the paged payload (and the disk cache entry) an order of magnitude smaller.
  const rows = await fetchDataset<LandUseRow>(
    LANDUSE_DATASET,
    { $select: "landuse, latitude, longitude" },
    LANDUSE_COUNT,
  );
  const points = toPoints(rows, land.onLand);

  const bytes = encodeClassifiedPoints(LANDUSE_MAGIC, LANDUSE_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(LANDUSE_DIR, file), bytes);

  let commercial = 0;
  for (const { klass } of points) {
    if (klass >= 4) {
      commercial += 1;
    }
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `landuse: ${rows.length} lots fetched, ${points.length} kept on land (1..5), ${commercial} commercial (4..5), ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: LANDUSE_FORMAT,
    count: points.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestLandUse("nyc", await loadLandContext());
}
