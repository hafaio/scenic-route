// `bun run scripts/dining.ts`: fetches NYC outdoor dining and writes it as data/dining/nyc.bin (magic
// DINE) — the sidewalk/roadway café points a future "nice commercial areas" routing factor will read
// as an outdoor-dining density, the signal for a relaxing storefront corridor (as opposed to merely
// dense/city-y). Two sources merged: the NYC Dining Out café-licence inventory (Sidewalk|Roadway
// permits) and OSM outdoor_seating=yes (which carries the cafés the licence set is thin on). Points
// only; the commercial overlay snaps these to street segments and highlights the blocks they cluster
// on. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePoints, haversineMeters, type NamedPoint } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import { fetchOutdoorSeating, type OsmSeating } from "./overpass";
import type { Coord } from "./socrata";
import { fetchDataset } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const DINING_DIR = join(DATA_DIR, "dining");
const DINING_MAGIC = "DINE";
const DINING_FORMAT = 1;
const DINING_DATASET = "fpeh-f7ci"; // Dining Out NYC sidewalk/roadway café licences
const DINING_COUNT = 1500; // a floor; ~1,549 licences at the last refresh
// An OSM café this close to a licensed one is the same establishment; the licence record wins.
const OSM_SEATING_DEDUP_METERS = 30;

interface DiningRow {
  latitude?: string;
  longitude?: string;
  assumed_name_s?: string; // the DBA, the name the client draws
  business_legal_name?: string; // fallback when the DBA is blank
}

function toPoints(
  rows: DiningRow[],
  onLand: (coord: Coord) => boolean,
): NamedPoint[] {
  const points: NamedPoint[] = [];
  for (const row of rows) {
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    // Some rows carry blank or 0/0 coordinates; NYC never sits on the null island, so drop those.
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat === 0 ||
      lng === 0
    ) {
      continue;
    }
    const name =
      row.assumed_name_s?.trim() || row.business_legal_name?.trim() || "";
    const point = { lat, lng, name };
    if (onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

// Keeps the OSM cafés that are not already a licensed one. Both sets are small (thousands), so a
// direct radius scan is cheaper than indexing — no grid is worth its bookkeeping here.
function dedupOsm(osm: OsmSeating[], licensed: NamedPoint[]): NamedPoint[] {
  return osm
    .filter(
      (point) =>
        !licensed.some(
          (existing) =>
            haversineMeters(point, existing) <= OSM_SEATING_DEDUP_METERS,
        ),
    )
    .map((point) => ({ lat: point.lat, lng: point.lng, name: point.name }));
}

export async function ingestDining(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(DINING_DIR, { recursive: true });

  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query).
  const licensedRows = await fetchDataset<DiningRow>(
    DINING_DATASET,
    { $select: "*" },
    DINING_COUNT,
  );
  const licensed = toPoints(licensedRows, land.onLand);

  const { south, west, north, east } = land.box;
  const osmRaw = await fetchOutdoorSeating(south, west, north, east);
  const osmOnLand = osmRaw.filter(land.onLand);
  const osm = dedupOsm(osmOnLand, licensed);
  const points = [...licensed, ...osm];

  const bytes = encodePoints(DINING_MAGIC, DINING_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(DINING_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `dining: licences ${licensed.length} on land, OSM ${osmRaw.length} fetched / ${osmOnLand.length} on land / ${osm.length} kept after dedup, ${points.length} total, ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: DINING_FORMAT,
    count: points.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestDining("nyc", await loadLandContext());
}
