// The NYC borough land polygons and the shoreline test every ingest clips its source with, shared
// so the streets, paths, trees, canopy, and scenic-factor ingests all cut the same coastline.

import { boxOf } from "./geometry";
import { buildLandTest } from "./land-filter";
import type { Bounds } from "./manifest";
import type { Polygon } from "./overpass";
import { type Coord, fetchDataset } from "./socrata";

const NYC_BOROUGH_COUNT = 5;

interface BoroughRow {
  the_geom?: { type: string; coordinates: [number, number][][][] };
}

// The five borough boundaries. Clipping to them drops the New Jersey and Westchester spill a city
// bounding box reaches, and keeps the harbour out of any field the sources feed.
export async function fetchNycLand(): Promise<Polygon[]> {
  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query);
  // BoroughRow reads only the_geom.
  const rows = await fetchDataset<BoroughRow>(
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
// (for an Overpass bbox query). Built once from the borough polygons and threaded into each source.
export interface LandContext {
  onLand: (coord: Coord) => boolean;
  box: Bounds;
}

export async function loadLandContext(): Promise<LandContext> {
  const land = await fetchNycLand();
  return { onLand: buildLandTest(land), box: boxOf(land) };
}
