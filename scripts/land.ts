// Each city's land polygons and the shoreline test every ingest clips its source with, shared so
// the streets, paths, trees, canopy, and scenic-factor ingests all cut the same coastline.

import { boxOf } from "./geometry";
import { buildLandTest } from "./land-filter";
import type { Bounds } from "./manifest";
import type { Polygon } from "./overpass";
import { fetchSfLand } from "./sf";
import { type Coord, NYC_OPEN_DATA } from "./socrata";

const NYC_BOROUGH_COUNT = 5;

interface BoroughRow {
  the_geom?: { type: string; coordinates: [number, number][][][] };
}

// The five borough boundaries. Clipping to them drops the New Jersey and Westchester spill a city
// bounding box reaches, and keeps the harbour out of any field the sources feed.
export async function fetchNycLand(): Promise<Polygon[]> {
  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query);
  // BoroughRow reads only the_geom.
  const rows = await NYC_OPEN_DATA.dataset<BoroughRow>(
    "gthc-hcne",
    { $select: "*" },
    NYC_BOROUGH_COUNT,
  );
  const polygons: Polygon[] = [];
  for (const row of rows) {
    for (const parts of row.the_geom?.coordinates ?? []) {
      polygons.push(
        parts.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
      );
    }
  }
  return polygons;
}

// Everything an ingest needs to keep to the city: the point-in-land test and the land bounding box
// (for an Overpass bbox query). Built once from the city's land polygons and threaded into each
// source, so every one of them cuts the same coastline.
export interface LandContext {
  onLand: (coord: Coord) => boolean;
  box: Bounds;
}

// A city's land is not optional — every source is clipped to it and the city's own bounds are taken
// over it — so this takes the fetcher rather than looking one up, and a city without one cannot be
// described in the first place.
export async function landContextOf(
  fetchLand: () => Promise<Polygon[]>,
): Promise<LandContext> {
  const land = await fetchLand();
  return { onLand: buildLandTest(land), box: boxOf(land) };
}

// For the standalone ingests, which are handed a city id on the command line and nothing else.
export async function loadLandContext(cityId: string): Promise<LandContext> {
  const fetchLand = cityId === "sf" ? fetchSfLand : fetchNycLand;
  return await landContextOf(fetchLand);
}
