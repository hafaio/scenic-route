// The East Bay's buildings: Overture's footprints carrying heights measured off the 2021 county
// LiDAR rather than the ones Overture publishes.
//
// None of these cities publishes a height. Overture has one for two thirds of the footprints, and
// where it came from a machine-learning model rather than an OSM tag it caps out at 32.5 m — every
// mid-rise flattened, Berkeley's Evans Hall given 25.5 m against a real 40. So the heights are
// measured: scripts/lidar.ts fetches the point cloud, `tiler ndsm` bins it into a surface model and
// takes the 75th percentile of the cells under each footprint, and this joins that reading back to
// the footprint it was taken under and merges it with what Overture published.
//
// The footprints themselves are still Overture's — ODbL, the same licence as the OSM footways
// already shipped — read out of its GeoParquet the way scripts/places.ts reads the places theme:
// every row carries its own bounding box, so naming the city's box reads only the byte ranges that
// hold it. They are clipped to the same seven municipalities scripts/alameda.ts builds the rest of
// this half of the city from, by Overture's own outlines for them rather than by the land mask,
// because the mask is the ingest's and this runs before it.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { cached } from "./cache";
import type { HeightedBuilding } from "./geometry";
import { EAST_BAY_WINDOW } from "./lidar";
import type { Polygon } from "./overpass";

// The release a local run reads, pinned rather than "latest" so a rebuild answers with the rows the
// counts in scripts/README.md were measured against. Spelt the way scripts/places.ts spells it,
// including the environment override the monthly refresh job passes.
const PINNED_RELEASE = "2026-08-19.0";
const OVERTURE_RELEASE = process.env.OVERTURE_RELEASE || PINNED_RELEASE;
const OVERTURE_BUCKET = "s3://overturemaps-us-west-2/release";
const BUILDINGS_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=buildings/type=building/*.parquet`;
const DIVISIONS_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=divisions/type=division_area/*.parquet`;

const BUILD_DIR = join(import.meta.dirname, "..", ".build");
// What the tiler is handed to sample under, and what it writes back. Build glue, gitignored: the
// artifact these become is data/buildings/<city>.bin.
export const FOOTPRINTS_FILE = join(BUILD_DIR, "east-bay-footprints.geojson");
export const READINGS_FILE = join(BUILD_DIR, "east-bay-heights.json");

// The municipalities the footprints are clipped to, by the name Overture files them under — the same
// seven scripts/alameda.ts takes the land, the streets and the addresses from. Their outlines are
// unioned, so a building on the line between two of them is one building and not two.
const EAST_BAY_DIVISIONS = [
  "Albany",
  "Berkeley",
  "Emeryville",
  "Oakland",
  "Piedmont",
  "Alameda",
  "San Leandro",
];
const DIVISION_SUBTYPE = "locality";

// How far under a published height a measurement may land before the published one is believed
// instead. The failure this exists for is a building that did not exist when the flight happened:
// 1900 Broadway is an OSM-tagged 120.4 m and measures 10.7, and Forma is a tagged 73 and measures
// 3.0 — both were construction sites in 2021. Real towers measure at 0.93 of their tag and better,
// so nothing between the two populations is at risk. It applies ONLY to an OSM-sourced height: the
// machine-learned ones are the reason to measure in the first place and never override a reading.
const OSM_PATCH_RATIO = 0.7;

// A footprint as Overture hands it over: its rings, whatever height it carries, and whether that
// height is a surveyed tag or a model's guess.
export interface Footprint {
  polygon: Polygon;
  name: string | null;
  heightMeters: number | null;
  surveyed: boolean;
}

// What `tiler ndsm` measured under one footprint. A missing reading is a footprint the surface model
// held no cell for — a shed of a few square metres, or a building the flight did not reach.
export interface Reading {
  feature: number;
  roofMeters?: number;
  baseMeters?: number;
  cells: number;
}

interface GeoJsonPolygon {
  type: string;
  coordinates: number[][][] | number[][][][];
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Prefiltered by intersection with the window rather than containment: a locality's own box can be
// wider than the box asked for, and a containment test would drop it whole.
function outlineSql(): string {
  const names = EAST_BAY_DIVISIONS.map(sqlText).join(", ");
  return `SELECT geometry FROM read_parquet(${sqlText(DIVISIONS_PARQUET)})
    WHERE country = 'US'
      AND class = 'land'
      AND subtype = ${sqlText(DIVISION_SUBTYPE)}
      AND names.primary IN (${names})
      AND bbox.xmin < ${EAST_BAY_WINDOW.east} AND bbox.xmax > ${EAST_BAY_WINDOW.west}
      AND bbox.ymin < ${EAST_BAY_WINDOW.north} AND bbox.ymax > ${EAST_BAY_WINDOW.south}`;
}

// Overture records which source each property came from. A height with a source entry of its own
// naming a dataset other than OpenStreetMap is a model's — that is the whole ML population — and a
// height with no such entry arrived with the OSM feature the building is built on.
function buildingsSql(): string {
  return `WITH outline AS (SELECT ST_Union_Agg(geometry) AS geometry FROM (${outlineSql()}))
    SELECT
      ST_AsGeoJSON(building.geometry) AS geometry,
      building.names.primary AS name,
      building.height AS height,
      len(
        list_filter(
          building.sources,
          source -> source.property = '/properties/height'
            AND source.dataset <> 'OpenStreetMap'
        )
      ) = 0 AS surveyed
    FROM read_parquet(${sqlText(BUILDINGS_PARQUET)}) AS building, outline
    WHERE building.bbox.xmin > ${EAST_BAY_WINDOW.west}
      AND building.bbox.xmax < ${EAST_BAY_WINDOW.east}
      AND building.bbox.ymin > ${EAST_BAY_WINDOW.south}
      AND building.bbox.ymax < ${EAST_BAY_WINDOW.north}
      AND ST_Intersects(outline.geometry, building.geometry)`;
}

async function connect(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';",
  );
  return connection;
}

// A GeoJSON geometry's disjoint parts, each an outer ring then holes, in the {lat, lng} shape the
// rest of the ingest reads polygons in.
function toParts(geometry: GeoJsonPolygon): Polygon[] {
  const parts =
    geometry.type === "MultiPolygon"
      ? (geometry.coordinates as number[][][][])
      : [geometry.coordinates as number[][][]];
  return parts.map((part) =>
    part.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
  );
}

// Every footprint of the seven cities, one per disjoint part, cached against the query itself — so a
// changed release or window lands on a different entry rather than reusing the old one.
export async function fetchFootprints(): Promise<Footprint[]> {
  const sql = buildingsSql();
  return await cached("east-bay-buildings", sql, async () => {
    const connection = await connect();
    try {
      const outlines = await connection.runAndReadAll(
        `SELECT count(*) AS found FROM (${outlineSql()})`,
      );
      const found = Number(outlines.getRowObjects()[0].found);
      if (found !== EAST_BAY_DIVISIONS.length) {
        // Overture renames and re-classes divisions between releases. Silently clipping a whole
        // city's buildings away is the failure this catches.
        throw new Error(
          `${found} outlines found for ${EAST_BAY_DIVISIONS.length} named cities`,
        );
      }
      const reader = await connection.runAndReadAll(sql);
      const footprints: Footprint[] = [];
      for (const row of reader.getRowObjects()) {
        const geometry = JSON.parse(String(row.geometry)) as GeoJsonPolygon;
        const height =
          typeof row.height === "number" && Number.isFinite(row.height)
            ? row.height
            : null;
        for (const polygon of toParts(geometry)) {
          if ((polygon[0]?.length ?? 0) >= 4) {
            footprints.push({
              polygon,
              name: typeof row.name === "string" ? row.name : null,
              heightMeters: height,
              surveyed: row.surveyed === true,
            });
          }
        }
      }
      return footprints;
    } finally {
      connection.closeSync();
    }
  });
}

// The footprints as the tiler reads them: one Polygon feature per part, so a reading comes back on
// the index it was asked for, and only the three properties the measurement pass looks at.
export async function writeFootprints(
  path: string,
  footprints: readonly Footprint[],
): Promise<void> {
  const features = footprints.map((footprint) => ({
    type: "Feature",
    properties: {
      name: footprint.name,
      height: footprint.heightMeters,
      surveyed: footprint.surveyed,
    },
    geometry: {
      type: "Polygon",
      coordinates: footprint.polygon.map((ring) =>
        ring.map(({ lat, lng }) => [lng, lat]),
      ),
    },
  }));
  await writeFile(
    path,
    JSON.stringify({ type: "FeatureCollection", features }),
  );
}

export interface Merged {
  buildings: HeightedBuilding[];
  measured: number; // footprints the surface model answered for
  published: number; // footprints Overture carried any height for
  patched: number; // measurements an OSM tag overrode, the post-flight construction sites
  dropped: number; // footprints with neither, which cast no shade and are not written
}

// The merge rule: the measurement wins, an OSM-sourced height patches it where the measurement is
// under 70% of the tag, and a machine-learned height never overrides. A footprint with neither is
// dropped — it is a shed of a few square metres, which is what the sampler misses.
export function merge(
  footprints: readonly Footprint[],
  readings: readonly Reading[],
): Merged {
  const measured = new Map(
    readings.map((reading) => [reading.feature, reading]),
  );
  const merged: Merged = {
    buildings: [],
    measured: 0,
    published: 0,
    patched: 0,
    dropped: 0,
  };
  for (const [index, footprint] of footprints.entries()) {
    const reading = measured.get(index);
    const roof = reading?.roofMeters ?? 0;
    const published = footprint.heightMeters ?? 0;
    if (roof > 0) {
      merged.measured += 1;
    }
    if (published > 0) {
      merged.published += 1;
    }
    let heightMeters = roof;
    if (roof <= 0) {
      heightMeters = published;
    } else if (
      published > 0 &&
      footprint.surveyed &&
      roof < OSM_PATCH_RATIO * published
    ) {
      heightMeters = published;
      merged.patched += 1;
    }
    if (heightMeters > 0) {
      merged.buildings.push({
        polygon: footprint.polygon,
        heightMeters,
        baseElevationMeters: reading?.baseMeters ?? 0,
      });
    } else {
      merged.dropped += 1;
    }
  }
  return merged;
}

// What `tiler ndsm` measured, off disk: the ingest runs after the measurement, so a missing file is
// a build run out of order rather than a city with no LiDAR, and saying so beats quietly writing
// every footprint at the height Overture guessed for it. Separate from the ingest below so a caller
// can find that out before paying for a footprint fetch.
export async function readEastBayHeights(): Promise<Reading[]> {
  const readings = await readFile(READINGS_FILE, "utf-8").catch(() => {
    throw new Error(
      `${READINGS_FILE} is not there; run \`bun run build-east-bay-heights\` first`,
    );
  });
  return JSON.parse(readings) as Reading[];
}

// The East Bay's buildings, ready to encode.
export async function fetchEastBayBuildings(
  readings: readonly Reading[],
): Promise<HeightedBuilding[]> {
  const footprints = await fetchFootprints();
  const merged = merge(footprints, readings);
  const share = (count: number) =>
    `${((100 * count) / Math.max(1, footprints.length)).toFixed(1)}%`;
  console.error(
    `east bay: ${merged.buildings.length} of ${footprints.length} footprints kept — ${merged.measured} measured (${share(merged.measured)}), ${merged.published} published by Overture (${share(merged.published)}), ${merged.patched} patched by an OSM tag, ${merged.dropped} dropped`,
  );
  return merged.buildings;
}

if (import.meta.main) {
  const footprints = await fetchFootprints();
  await writeFootprints(FOOTPRINTS_FILE, footprints);
  const withHeight = footprints.filter(
    (footprint) => (footprint.heightMeters ?? 0) > 0,
  );
  const surveyed = withHeight.filter((footprint) => footprint.surveyed);
  console.error(
    `east bay: ${footprints.length} footprints, ${withHeight.length} with a published height (${((100 * withHeight.length) / footprints.length).toFixed(1)}%), ${surveyed.length} of those an OSM tag; wrote ${FOOTPRINTS_FILE}`,
  );
}
