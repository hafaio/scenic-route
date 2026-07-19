// `bun run scripts/landmarks.ts`: fetches the NYC LPC individual-landmark sites and writes them as
// data/landmarks/nyc.bin (magic LMRK) — the historic/touristy POIs a later phase fans out over the
// walking graph into a per-edge "passes a landmark" routing discount. Points only; no overlay ships
// this batch. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePoints, type NamedPoint } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Coord } from "./socrata";
import { fetchDataset } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const LANDMARK_DIR = join(DATA_DIR, "landmarks");
const LANDMARK_MAGIC = "LMRK";
const LANDMARK_FORMAT = 1;
const LANDMARK_DATASET = "buis-pvji"; // LPC Individual Landmark Sites
const LANDMARK_COUNT = 1_400; // a floor; ~1,532 designated sites at the last refresh

// The WGS84 latitude/longitude columns are the representative point; `lpc_name` is the designated
// name the overlay labels the dot with. The lot polygon (the_geom, in state-plane feet) is not read.
interface LandmarkRow {
  latitude?: string;
  longitude?: string;
  lpc_name?: string;
}

function toPoints(
  rows: LandmarkRow[],
  onLand: (coord: Coord) => boolean,
): NamedPoint[] {
  const points: NamedPoint[] = [];
  for (const row of rows) {
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    const point = { lat, lng, name: (row.lpc_name ?? "").trim() };
    if (onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

export async function ingestLandmarks(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(LANDMARK_DIR, { recursive: true });
  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query).
  const rows = await fetchDataset<LandmarkRow>(
    LANDMARK_DATASET,
    { $select: "*" },
    LANDMARK_COUNT,
  );
  const points = toPoints(rows, land.onLand);
  const bytes = encodePoints(LANDMARK_MAGIC, LANDMARK_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(LANDMARK_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `landmarks: ${rows.length} sites, ${points.length} on land, ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: LANDMARK_FORMAT,
    count: points.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestLandmarks("nyc", await loadLandContext());
}
