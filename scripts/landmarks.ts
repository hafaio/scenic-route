// `bun run scripts/landmarks.ts [city]`: fetches a city's designated landmarks and writes them as
// data/landmarks/<id>.bin (magic LMRK) — the historic/touristy POIs a later phase fans out over the
// walking graph into a per-edge "passes a landmark" routing discount. Points, where the historic
// districts beside them are areas. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchEastBayLandmarks } from "./alameda";
import { encodePoints, type NamedPoint } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import { fetchSfLandmarks } from "./sf";
import type { Coord } from "./socrata";
import { NYC_OPEN_DATA } from "./socrata";

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

async function nycLandmarks(land: LandContext): Promise<NamedPoint[]> {
  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query).
  const rows = await NYC_OPEN_DATA.dataset<LandmarkRow>(
    LANDMARK_DATASET,
    { $select: "*" },
    LANDMARK_COUNT,
  );
  return toPoints(rows, land.onLand);
}

// The city's own register of designated sites. A city with none passes null and simply has no
// landmark discount, which is a decision its descriptor states rather than one this module infers
// from a missing map entry.
export type LandmarkSource = (land: LandContext) => Promise<NamedPoint[]>;

export const NYC_LANDMARKS: LandmarkSource = nycLandmarks;
// Two halves, and they are not the same kind of register: San Francisco's is its own Article 10
// list, the East Bay's is the state inventory's federal and state designations, because neither
// Oakland's local register nor Berkeley's is published as data at all. `scripts/alameda.ts` has what
// that costs; the difference is visible on the map and is worth knowing about before reading it.
export const SF_LANDMARKS: LandmarkSource = async (land) => {
  const [city, eastBay] = await Promise.all([
    fetchSfLandmarks(land.onLand),
    fetchEastBayLandmarks(land),
  ]);
  return [...city, ...eastBay];
};

export async function ingestLandmarks(
  cityId: string,
  source: LandmarkSource | null,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(LANDMARK_DIR, { recursive: true });
  const points = source ? await source(land) : [];
  const bytes = encodePoints(LANDMARK_MAGIC, LANDMARK_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(LANDMARK_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `landmarks: ${points.length} on land, ${kib} KiB in ${seconds}s`,
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
  const cityId = process.argv[2] ?? "nyc";
  await ingestLandmarks(
    cityId,
    cityId === "sf" ? SF_LANDMARKS : NYC_LANDMARKS,
    await loadLandContext(cityId),
  );
}
