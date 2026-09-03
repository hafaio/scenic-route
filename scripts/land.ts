// Each city's land polygons and the shoreline test every ingest clips its source with, shared so
// the streets, paths, trees, canopy, and scenic-factor ingests all cut the same coastline.

import { fetchEastBayLand } from "./alameda";
import { boxOf } from "./geometry";
import { buildLandTest } from "./land-filter";
import type { Bounds } from "./manifest";
import type { Polygon } from "./overpass";
import { fetchSfLand } from "./sf";
import { type Coord, NYC_OPEN_DATA } from "./socrata";

const NYC_BOROUGH_COUNT = 5;

interface BoroughRow {
  boroname?: string;
  the_geom?: { type: string; coordinates: [number, number][][][] };
}

// A named part of a city, for the ingests that have to say WHICH part a point is in rather than only
// that it is in the city at all. New York's five boroughs are the case: the land mask is their union.
export interface NamedArea {
  name: string;
  polygons: Polygon[];
}

// The five borough boundaries, each under the name a postal address and a reader both use. The same
// spellings src/search/address-format.ts writes, which is what lets a borough found here be matched
// to the one the address file labels a street with.
export async function fetchNycBoroughs(): Promise<NamedArea[]> {
  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query).
  const rows = await NYC_OPEN_DATA.dataset<BoroughRow>(
    "gthc-hcne",
    { $select: "*" },
    NYC_BOROUGH_COUNT,
  );
  return rows.map((row) => ({
    name: row.boroname ?? "",
    polygons: (row.the_geom?.coordinates ?? []).map((parts) =>
      parts.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
    ),
  }));
}

// The city as one shape. Clipping to it drops the New Jersey and Westchester spill a city bounding
// box reaches, and keeps the harbour out of any field the sources feed.
export async function fetchNycLand(): Promise<Polygon[]> {
  const boroughs = await fetchNycBoroughs();
  return boroughs.flatMap((borough) => borough.polygons);
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

// The Bay Area as one shape: San Francisco's analysis neighbourhoods and the seven East Bay cities,
// unioned. The two are separated by twelve kilometres of water and joined only by the ferry edges
// scripts/ferries.ts builds — the same arrangement Staten Island has in New York, and the reason the
// union is a plain concatenation: the parts do not touch, so there is nothing to merge.
//
// Southern Marin lies inside the rectangle this reaches over — Sausalito is nearer the Ferry
// Building than San Leandro is — and is excluded the way New Jersey is excluded from New York, by
// never being entered. No Marin polygon is read here, so every source clipped to this shape simply
// has no Marin in it.
export async function fetchBayAreaLand(): Promise<Polygon[]> {
  const [sanFrancisco, eastBay] = await Promise.all([
    fetchSfLand(),
    fetchEastBayLand(),
  ]);
  return [...sanFrancisco, ...eastBay];
}

// For the standalone ingests, which are handed a city id on the command line and nothing else.
export async function loadLandContext(cityId: string): Promise<LandContext> {
  const fetchLand = cityId === "sf" ? fetchBayAreaLand : fetchNycLand;
  return await landContextOf(fetchLand);
}
