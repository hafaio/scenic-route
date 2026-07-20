// `bun run scripts/buildings.ts`: fetches NYC building footprints with roof heights and writes them
// as data/buildings/nyc.bin (magic BLDG) — the source data a later "building shade" routing factor
// will raise into walls to shade the walking graph. From the NYC Building Footprints dataset
// (5zhs-2jue): a GeoJSON MultiPolygon per building, its `height_roof` (feet), and its
// `ground_elevation` (feet AMSL, for terrain-aware shade). Kept to real buildings (feature_code
// 2100) with a positive finite height, clipped to the shoreline, and converted to metres. Polygons
// only this batch; the shade computation lives in a later phase.
// Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeBuildings, type HeightedBuilding } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Polygon } from "./overpass";
import type { Coord } from "./socrata";
import { fetchDataset } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const BUILDINGS_DIR = join(DATA_DIR, "buildings");
const BUILDINGS_FORMAT = 1;
const BUILDINGS_DATASET = "5zhs-2jue"; // NYC Building Footprints
const BUILDINGS_COUNT = 1_082_974; // a floor; every feature, not just the ones we keep
const BUILDING_FEATURE_CODE = "2100"; // a real building; 5110/2110/... are garages, skybridges, etc.
const FEET_TO_METERS = 0.3048;

interface BuildingRow {
  the_geom?: { type: string; coordinates: [number, number][][][] };
  height_roof?: string;
  ground_elevation?: string;
  feature_code?: string;
}

// Splits a GeoJSON MultiPolygon into its disjoint parts, each an outer ring then holes, in the
// same [lng, lat] -> {lat, lng} shape land.ts reads borough boundaries with.
function toParts(geom: BuildingRow["the_geom"]): Polygon[] {
  const parts: Polygon[] = [];
  for (const rings of geom?.coordinates ?? []) {
    parts.push(rings.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))));
  }
  return parts;
}

function toBuildings(
  rows: BuildingRow[],
  onLand: (coord: Coord) => boolean,
): HeightedBuilding[] {
  const buildings: HeightedBuilding[] = [];
  for (const row of rows) {
    if (row.feature_code !== BUILDING_FEATURE_CODE) {
      continue;
    }
    const heightFeet = Number.parseFloat(row.height_roof ?? "");
    if (!Number.isFinite(heightFeet) || heightFeet <= 0) {
      continue;
    }
    const heightMeters = heightFeet * FEET_TO_METERS;
    // A missing or unparseable ground elevation falls back to sea level rather than dropping the
    // building; height_roof stays the only filter.
    const elevationFeet = Number.parseFloat(row.ground_elevation ?? "");
    const baseElevationMeters = Number.isFinite(elevationFeet)
      ? elevationFeet * FEET_TO_METERS
      : 0;
    for (const polygon of toParts(row.the_geom)) {
      // Keep the part if any outer-ring vertex is on land, so a building on the shoreline is not
      // dropped for the few vertices its footprint pokes past the coastline.
      const outerRing = polygon[0] ?? [];
      if (outerRing.some(onLand)) {
        buildings.push({ polygon, heightMeters, baseElevationMeters });
      }
    }
  }
  return buildings;
}

export async function ingestBuildings(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(BUILDINGS_DIR, { recursive: true });

  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query).
  const rows = await fetchDataset<BuildingRow>(
    BUILDINGS_DATASET,
    { $select: "*" },
    BUILDINGS_COUNT,
  );
  const buildings = toBuildings(rows, land.onLand);

  const bytes = encodeBuildings(BUILDINGS_FORMAT, buildings);
  const file = `${cityId}.bin`;
  await writeFile(join(BUILDINGS_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const mib = (bytes.length / (1024 * 1024)).toFixed(1);
  console.error(
    `buildings: ${rows.length} fetched / ${buildings.length} polygons on land, ${mib} MiB in ${seconds}s`,
  );
  return {
    file,
    format: BUILDINGS_FORMAT,
    count: buildings.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestBuildings("nyc", await loadLandContext());
}
