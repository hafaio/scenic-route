// The East Bay's half of the Bay Area ingest: Alameda County's own layers, plus Oakland's own and —
// in one place where the county's roll cannot answer — MTC's regional one, standing in for the
// DataSF layers San Francisco is read from (scripts/sf.ts).
//
// This city is San Francisco AND the East Bay under one id, connected across the water by the ferry
// edges scripts/ferries.ts builds, so everything here has to compose with the San Francisco sources
// rather than replace them. What is genuinely different from that side:
//
//   - **There is no shoreline-clipped boundary to read.** San Francisco publishes analysis
//     neighbourhoods already cut at the water. Alameda County publishes city limits that are LEGAL
//     limits: Oakland's, Berkeley's and Alameda's run out into the bay over their tidelands, and the
//     union of the seven reaches -122.347, most of the way to Yerba Buena Island. So the shoreline
//     is subtracted rather than read — see `fetchEastBayLand`.
//
//   - **The centreline carries no width.** New York publishes a kerb-to-kerb `streetwidth` and San
//     Francisco publishes the sidewalk width its roadway is derived from. Alameda County publishes
//     neither, and OSM fills the gap for four ways in the whole of Oakland, so every segment here
//     takes one stated figure — see `EAST_BAY_ROADWAY_FEET`.
//
//   - **There is no sidewalk survey at all.** Neither the county nor Oakland's or Berkeley's own
//     portals publish one, so the per-side existence bits here rest on OSM alone, where San
//     Francisco has the 2014 Sidewalk Widths study behind them. scripts/README.md has the measured
//     coverage; it is materially thinner than either existing city's and it is meant to be read.

import { readFile } from "node:fs/promises";
import { cached, cachedFile } from "./cache";
import { parseCsv } from "./csv";
import { densify, type NamedPoint } from "./geometry";
import type { LandContext } from "./land";
import type { Polygon } from "./overpass";
import type { Coord } from "./socrata";
import {
  ROAD_PATH,
  ROAD_STREET,
  type RoadType,
  type Segment,
  toInt,
} from "./streets";

const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";
const REQUEST_TIMEOUT_MS = 120_000;

export const EAST_BAY_ATTRIBUTION = "Alameda County GIS";
export const EAST_BAY_STREET_ATTRIBUTION =
  "Alameda County Street Centerlines via Alameda County GIS";
export const EAST_BAY_LAND_ATTRIBUTION =
  "City limits © Alameda County GIS, shoreline from US Census TIGER hydrography, " +
  "parkland from the California Protected Areas Database (CPAD - www.calands.org). June 2024.";
export const EAST_BAY_STREET_SOURCE_URL =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Street_Centerlines/FeatureServer/0";

// The seven municipalities this city takes in, as the county's `DIST_NAME` spells them. They are the
// contiguous incorporated run along the Alameda County bayshore, from the Contra Costa line at
// Albany to San Leandro's southern boundary, and they are chosen as a set for three reasons: one
// county centreline and one county address file cover exactly them, so this is one ingest the way
// New York's five boroughs are; they form a single urban fabric with no municipality left out of the
// middle of it (Piedmont is an enclave entirely surrounded by Oakland, and omitting it would put a
// hole in the land mask); and stopping at San Leandro keeps the bounding box on the built-up
// bayshore rather than carrying it over the hills to Livermore or down the plain to Fremont, when
// that box is what every Overpass query and the whole tile plan are cut from.
//
// Everything else in the county — Hayward, Union City, Newark, Fremont, and the Livermore Valley
// cities beyond the ridge — is deliberately out, as are the unincorporated pockets south of San
// Leandro. They are a later decision, not an oversight.
//
// The mask is NOT these seven, though: the line is drawn round the area rather than round the
// cities, and `EAST_BAY_PARKLANDS` adds the ridge parkland above Oakland that no municipality
// contains. Nothing else in this file changes — the centreline, the addresses and the landmarks are
// all read over `boxOf(land)` and kept by `onLand`, so they follow the mask out there by themselves.
const EAST_BAY_CITY_LIMITS: readonly string[] = [
  "CITY OF ALBANY",
  "CITY OF BERKELEY",
  "CITY OF EMERYVILLE",
  "CITY OF OAKLAND",
  "CITY OF PIEDMONT",
  "CITY OF ALAMEDA",
  "CITY OF SAN LEANDRO",
];

// The county writes a municipality as a two-letter code, and the name a reader would say is what the
// search box has to show. Its own `CITY` column is not that name: two Oakland-coded rows carry "San
// Leandro", so the code is the jurisdiction and the column is a guess at the postal town.
//
// The seven above, under the spellings src/search/address-format.ts's borough names are spelt in —
// what a person would type and what a result has to read as. Read by scripts/addresses.ts, which
// walks the county's address points, and inverted below to place the state inventory's landmarks
// against the same layer. One map because two disagreed: Albany is `AB`, and a private second copy
// here spelt it `AL`, which matches no row and silently placed nothing.
export const ALAMEDA_PLACES: Readonly<Record<string, string>> = {
  AA: "Alameda",
  AB: "Albany",
  BE: "Berkeley",
  EM: "Emeryville",
  OA: "Oakland",
  PI: "Piedmont",
  SL: "San Leandro",
};

const CITY_LIMITS_SERVICE =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Administrative_Boundaries/FeatureServer/2/query";

// The parkland the mask reaches past the city limits for, and where its outline is read from. CPAD
// is the state's protected-areas register, published by GreenInfo Network; a "holding" is one parcel
// and a park is several, so the query returns dozens of polygons per unit and they are unioned with
// the city limits before the water is cut. Its own terms are that it "is generally available to any
// user" once the data disclaimer has been read, and the credit line is the publisher's own wording,
// carried in EAST_BAY_LAND_ATTRIBUTION above.
const PARKLAND_SERVICE =
  "https://services1.arcgis.com/4ZKi1B1zTblbwgWB/arcgis/rest/services/cpad_2024a_holdingsgdb/FeatureServer/0/query";

// The hills the seven city limits cut off, as CPAD's `UNIT_NAME` spells them — Redwood carries its
// full name, Reinhardt, in the register. They are the ridge parkland above Oakland: the shadiest
// ground in the region, unincorporated, and so outside every boundary the county publishes.
//
// A park is admitted on the same condition the rest of the region is: every layer this region offers
// has to reach it. Canopy does — the ALCC height model is Alameda AND Contra Costa, and it reads 95
// to 100% covered cells across these two, with crowns up to 226 ft. The county centreline runs well
// past its own county line (287 segments over Redwood alone, most of them unincorporated), OSM has
// the trail network (407 foot ways), and the county's address points here already all carry one of
// the seven municipal codes, so the address filter drops nothing and search gains no hole.
//
// What decides it is the GROUND. The 2021 Alameda County lidar the terrain is read from stops at
// about the county line, and nothing else stages a 1 m mosaic over these hills, so a park the flight
// missed would route as flat with a blank terrain overlay and nothing in the build would say so —
// the missing-square guard in scripts/elevation.ts cannot catch it, because the squares ARE staged
// and merely hold nodata inside. Sampled 400 interior points per park, 2026-08-30:
//
//   Reinhardt Redwood 99.5%, Roberts 100% — in.
//   Tilden Regional Park 50.0%, Tilden Nature Area 18.5%, Sibley Volcanic 14.5%,
//   Huckleberry Botanic 16.0% — out. Half of Tilden and five sixths of Sibley have no ground at all.
//
// Anthony Chabot (88.2%) and Lake Chabot (83.8%) are out for the same reason and one more: they are
// the first ground east of `boxOf(land)`, and taking them would carry the whole tile plan over the
// ridge. Claremont Canyon, Leona Heights and Temescal measure 100% and are named nowhere here
// because they are already inside Oakland's and Berkeley's limits — the mask has them.
//
// Roberts is here for the reason Piedmont is in the list above: it sits in the middle of Redwood,
// and leaving it out would put a hole in the park rather than a boundary around it.
const EAST_BAY_PARKLANDS: readonly string[] = [
  "Reinhardt Redwood Regional Park",
  "Roberts Regional Recreation Area",
];

// CPAD records a park as the dozens of parcels it was assembled from — 61 for these two — and
// records their edges to a looser precision than the edges actually meet at. Unioned raw, the two
// parks arrive as one body pitted with fourteen holes and trailed by two detached specks: six of the
// holes are under 20 m² and are simply where two neighbouring parcels fail to touch, three are real
// private in-holdings inside Redwood, and the specks are 1,600 and 1,376 m².
//
// None of that is a statement about ground. A hole here would clip the trails that cross it and read
// as bare canopy in the middle of a forest, which is the same reason the water subtraction leaves
// Lake Merritt in the land: punching out something you can't walk on only adds rings. So the parkland
// is unioned on its own, its interior rings are dropped, and a piece too small to hold a walk is
// dropped whole rather than shipped as an island nothing reaches.
const MIN_PARKLAND_PIECE_SQUARE_METERS = 10_000;
const METERS_PER_DEGREE_LAT = 111_320;

// CPAD's park edge and the county's city edge are the same line surveyed by two people, and they do
// not agree on it: unioned, they leave a row of gaps along the shared boundary — eleven of them, the
// largest 25,491 m². They are not places, and a hole in the mask cuts the trails that cross it and
// reads as bare canopy in the middle of a forest.
//
// They can be filled without touching anything real, because the ONLY hole this mask is meant to
// have is water, and water never makes one: the seven city limits less the tidal polygons come out
// as four pieces with zero interior rings between them, measured. So an enclosed gap here is two
// sources disagreeing, up to the point where it is too big to be a seam and is left alone to be
// looked at.
const MAX_SEAM_HOLE_SQUARE_METERS = 100_000;

// Shoelace on the ring, with longitude scaled at the ring's own latitude. Only ever compared against
// the floor above, so the flat-earth approximation over a few hundred metres costs nothing.
function ringAreaSquareMeters(ring: Ring): number {
  let doubled = 0;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    doubled +=
      ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
  }
  const latitude =
    ring.reduce((sum, [, lat]) => sum + lat, 0) / Math.max(ring.length, 1);
  return (
    (Math.abs(doubled) / 2) *
    METERS_PER_DEGREE_LAT *
    METERS_PER_DEGREE_LAT *
    Math.cos((latitude * Math.PI) / 180)
  );
}

// TIGERweb's areal hydrography, the Census Bureau's own water polygons, queried over the East Bay.
// `H2051` is its code for a bay, estuary, gulf or sound and `H2053` for an ocean — between them San
// Francisco Bay, the Oakland Estuary (which is what separates Alameda island from Oakland), San
// Leandro Bay and Seaplane Harbour. Lakes and reservoirs are their own codes and are deliberately
// left in the land: they carry no streets, and punching them out would only add rings.
const HYDRO_SERVICE =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Hydro/MapServer/1/query";
const TIDAL_WATER_CODES = "('H2051','H2053')";
// The margin the water query reaches past the city limits, so a bay polygon that starts outside the
// box still trims the shore inside it. A tenth of a degree is about 11 km.
const WATER_MARGIN_DEGREES = 0.1;

type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

interface GeoJsonFeature<Properties> {
  geometry?: GeoJsonGeometry | null;
  properties?: Properties;
}

interface GeoJsonPage<Properties> {
  features?: GeoJsonFeature<Properties>[];
  error?: { code: number; message: string };
}

async function fetchGeoJson<Properties>(
  url: string,
): Promise<GeoJsonFeature<Properties>[]> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as GeoJsonPage<Properties>;
  if (body.error) {
    throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
  } else if (!Array.isArray(body.features)) {
    throw new Error("no features in the response");
  }
  return body.features;
}

// Both a Polygon and a MultiPolygon as the one ring-of-rings list the rest of the pipeline uses.
function ringsOf(geometry: GeoJsonGeometry | null | undefined): Ring[][] {
  if (!geometry) {
    return [];
  } else if (geometry.type === "Polygon") {
    return [geometry.coordinates];
  } else {
    return geometry.coordinates;
  }
}

// polygon-clipping's own vocabulary: a ring is a closed list of [lng, lat] pairs, a polygon is an
// outer ring followed by its holes, and a multipolygon is a list of those. It is the same shape as
// `Polygon` from scripts/overpass.ts with the coordinates the other way round, which is why the two
// conversions below are the whole of the interop.
type Ring = [number, number][];

function toPolygons(multi: Ring[][]): Polygon[] {
  return multi.map((polygon) =>
    polygon.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
  );
}

// The same four numbers scripts/manifest.ts calls `Bounds`, spelled locally so the land helpers here
// do not have to import the manifest schema to describe a rectangle.
interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

function boxOfRings(multi: Ring[][]): Box {
  const box: Box = {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  };
  for (const polygon of multi) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        box.west = Math.min(box.west, lng);
        box.east = Math.max(box.east, lng);
        box.south = Math.min(box.south, lat);
        box.north = Math.max(box.north, lat);
      }
    }
  }
  return box;
}

async function fetchCityLimits(): Promise<Ring[][]> {
  const url = new URL(CITY_LIMITS_SERVICE);
  const names = EAST_BAY_CITY_LIMITS.map((name) => `'${name}'`).join(",");
  url.searchParams.set("where", `DIST_NAME IN (${names})`);
  url.searchParams.set("outFields", "DIST_NAME");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  const features = await cached("alameda-city-limits", url.toString(), () =>
    fetchGeoJson<{ DIST_NAME?: string }>(url.toString()),
  );
  const named = new Set(
    features.map((feature) => feature.properties?.DIST_NAME ?? ""),
  );
  const missing = EAST_BAY_CITY_LIMITS.filter((name) => !named.has(name));
  if (missing.length > 0) {
    // A renamed or withdrawn row would otherwise leave a city-sized hole in the land mask, and
    // everything downstream — the streets, the paths, the trees — would simply be clipped away
    // without anything saying so.
    throw new Error(
      `Alameda County's City_Limits has no row for ${missing.join(", ")}`,
    );
  }
  return features.flatMap((feature) => ringsOf(feature.geometry));
}

async function fetchParkland(): Promise<Ring[][]> {
  const url = new URL(PARKLAND_SERVICE);
  const names = EAST_BAY_PARKLANDS.map((name) => `'${name}'`).join(",");
  url.searchParams.set("where", `UNIT_NAME IN (${names})`);
  url.searchParams.set("outFields", "UNIT_NAME");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  const features = await cached("cpad-east-bay-parkland", url.toString(), () =>
    fetchGeoJson<{ UNIT_NAME?: string }>(url.toString()),
  );
  const named = new Set(
    features.map((feature) => feature.properties?.UNIT_NAME ?? ""),
  );
  const missing = EAST_BAY_PARKLANDS.filter((name) => !named.has(name));
  if (missing.length > 0) {
    // CPAD renames units between releases — Redwood became Reinhardt Redwood in one — and a rename
    // here would quietly put the hills back outside the mask with nothing but a smaller number in
    // the log to show for it.
    throw new Error(`CPAD has no holding named ${missing.join(", ")}`);
  }
  const { union } = await import("polygon-clipping");
  const holdings = features.flatMap((feature) => ringsOf(feature.geometry));
  const merged = union(holdings as Parameters<typeof union>[0]) as Ring[][];
  const solid = merged
    .map((polygon): Ring[] => [polygon[0]])
    .filter(
      ([outer]) =>
        ringAreaSquareMeters(outer) >= MIN_PARKLAND_PIECE_SQUARE_METERS,
    );
  console.error(
    `  east bay parkland: ${features.length} CPAD holdings across` +
      ` ${EAST_BAY_PARKLANDS.length} parks = ${solid.length} pieces` +
      ` (${merged.length - solid.length} under ${MIN_PARKLAND_PIECE_SQUARE_METERS} m² dropped)`,
  );
  return solid;
}

async function fetchTidalWater(box: Box): Promise<Ring[][]> {
  const url = new URL(HYDRO_SERVICE);
  url.searchParams.set("where", `MTFCC IN ${TIDAL_WATER_CODES}`);
  url.searchParams.set(
    "geometry",
    JSON.stringify({
      xmin: box.west - WATER_MARGIN_DEGREES,
      ymin: box.south - WATER_MARGIN_DEGREES,
      xmax: box.east + WATER_MARGIN_DEGREES,
      ymax: box.north + WATER_MARGIN_DEGREES,
      spatialReference: { wkid: 4326 },
    }),
  );
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "NAME");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  const features = await cached("tigerweb-east-bay-water", url.toString(), () =>
    fetchGeoJson<{ NAME?: string }>(url.toString()),
  );
  if (features.length === 0) {
    throw new Error("TIGERweb returned no water over the East Bay");
  }
  return features.flatMap((feature) => ringsOf(feature.geometry));
}

// The land the seven cities actually occupy: their legal limits with the tidal water cut out of
// them. This is the East Bay's answer to `fetchSfLand`, and it is a subtraction rather than a read
// because nobody publishes the answer directly.
//
// The clip is what keeps San Francisco Bay out of a city whose two halves face each other across it
// — and, exactly as scripts/land.ts's New Jersey note describes, it is also what keeps southern
// Marin out. Marin is never entered: it is in no city limit read here, so it is simply absent, and
// the bounding rectangle reaching over Sausalito costs nothing.
export async function fetchEastBayLand(): Promise<Polygon[]> {
  const limits = await fetchCityLimits();
  const parks = await fetchParkland();
  const ground = [...limits, ...parks];
  const water = await fetchTidalWater(boxOfRings(ground));
  // Imported here rather than at the top: polygon-clipping is a devDependency this one function
  // needs, and every other consumer of this module pays its load otherwise.
  const { difference } = await import("polygon-clipping");
  const cut = difference(
    ground as Parameters<typeof difference>[0],
    water as Parameters<typeof difference>[0],
  ) as Ring[][];
  let seams = 0;
  const land = cut.map(([outer, ...holes]) => [
    outer,
    ...holes.filter((hole) => {
      const seam = ringAreaSquareMeters(hole) < MAX_SEAM_HOLE_SQUARE_METERS;
      seams += seam ? 1 : 0;
      return !seam;
    }),
  ]);
  console.error(
    `  east bay: ${EAST_BAY_CITY_LIMITS.length} city limits and ${parks.length} parkland pieces` +
      ` less ${water.length} water polygons = ${land.length} land polygons` +
      ` (${seams} boundary seams filled)`,
  );
  return toPolygons(land);
}

interface StreetRow {
  CLASS?: string | null;
  SFEATYP?: string | null;
  STREET?: string | null;
  SEGID?: number | null;
}

// The county's road hierarchy. Everything a person may walk beside is here; what is left out is
// left out because it is a motorway — `Interstate`, `Freeway or Expressway` and the `Ramp` class
// that feeds them. Those come back through scripts/highways.ts as the HWAY nuisance source, which
// is a penalty to walk near and is never routed, exactly as San Francisco's FREEWAYS layer is.
const WALKABLE_CLASSES = new Set([
  "Local",
  "Principal Arterial",
  "Minor Arterial",
  "Major Collector",
  "Minor Collector",
]);

// `SFEATYP` is the county's street-type abbreviation, and three of its values name a walking surface
// rather than a roadway: a walk, a path and a plaza. They are 100 rows out of 85,134 — this
// centreline is a road file and the pedestrian network comes from OSM — but a plaza offset two
// sidewalks off its middle would be two walking lines through a square that is itself the surface.
//
// There is no step-street type at all: San Francisco's `STPS`/`STWY` have no counterpart here, so
// every stair in the East Bay reaches the graph as an OSM `highway=steps` way and none of them as a
// street. Nothing is lost by that — it is where New York's step streets would come from too if CSCL
// did not classify them — but it is why nothing below ever produces ROAD_STEPS.
const PEDESTRIAN_TYPES = new Set(["WK", "PA", "PZ"]);
// The types that name a motorway even where `CLASS` does not: a ramp, a freeway connector, a
// freeway and a highway. `CLASS` catches nearly all of these already; this is the second reading, so
// a row misfiled under `Local` does not put a walking edge on the 580.
const MOTORWAY_TYPES = new Set(["RAMP", "CONN", "FW", "HW"]);

function roadTypeOf(row: StreetRow): RoadType | null {
  const type = (row.SFEATYP ?? "").trim().toUpperCase();
  if (MOTORWAY_TYPES.has(type) || !WALKABLE_CLASSES.has(row.CLASS ?? "")) {
    return null;
  } else {
    return PEDESTRIAN_TYPES.has(type) ? ROAD_PATH : ROAD_STREET;
  }
}

// The roadway width every East Bay street is offset by, in the feet a STRT record stores. The county
// centreline has no width column, its rows carry no right-of-way geometry to derive one from the way
// San Francisco's do, and OSM tags a `width` on four ways in the whole of Oakland — so there is no
// measurement to be had, and this is a stated assumption rather than a fallback.
//
// It is San Francisco's own median derived roadway, taken because it is the figure this city already
// uses for every segment whose inputs are missing and because the alternative is New York's 30 ft,
// measured on a different continent's street grid. What it buys is a uniform sidewalk offset of
// about 6 m from the centreline; what it costs is that a genuinely wide East Bay arterial —
// Telegraph, San Pablo, International — has its pavement drawn nearer the traffic than it is.
export const EAST_BAY_ROADWAY_FEET = 26;

const PAGE_SIZE = 2_000;
const DENSIFY_METERS = 25;
const DROP_LENGTH_METERS = 0.5;
const UNNAMED_ID = 0xffff;
// 85,134 segments county-wide at the last read (2026-08-27); the seven cities' own share of them by
// `MUNL` is 22,292, and the box takes in a few thousand more of the hills and the neighbouring
// cities before the land test cuts them. A floor on what the paged read returns, so a service that
// answered a truncated layer fails here rather than shipping a city with half its streets.
const EAST_BAY_SEGMENT_FLOOR = 20_000;

function streetPageUrl(offset: number, box: Box): string {
  const url = new URL(`${EAST_BAY_STREET_SOURCE_URL}/query`);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "CLASS,SFEATYP,STREET,SEGID");
  url.searchParams.set(
    "geometry",
    JSON.stringify({
      xmin: box.west,
      ymin: box.south,
      xmax: box.east,
      ymax: box.north,
      spatialReference: { wkid: 4326 },
    }),
  );
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  // Without an order, an ArcGIS layer may repeat or skip rows between `resultOffset` pages.
  url.searchParams.set("orderByFields", "SEGID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

// Every centreline segment whose box reaches the city, walkable or not, paged and cached. The
// envelope is the land's own box, so the read is a fifth of the county rather than all of it, and
// the land test below is what actually decides.
async function fetchCountyStreets(
  box: Box,
): Promise<GeoJsonFeature<StreetRow>[]> {
  const features: GeoJsonFeature<StreetRow>[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = streetPageUrl(offset, box);
    const page = await cached(
      `alameda-streets-${offset}`,
      url,
      () => fetchGeoJson<StreetRow>(url),
      true,
    );
    features.push(...page);
    if (page.length < PAGE_SIZE) {
      break;
    }
  }
  return features;
}

// The county centreline as STRT segments, clipped to the city's land. A segment is kept when either
// end or its middle is on land — the same three-point rule the OSM paths are clipped by, and the
// reason the Park Street, Fruitvale and High Street bridges survive at all: their whole span is over
// the estuary, which the land mask has cut away, and only their ends are on the ground.
export async function fetchEastBayStreets(
  land: LandContext,
): Promise<Segment[]> {
  const { onLand, box } = land;
  const features = await fetchCountyStreets(box);
  if (features.length < EAST_BAY_SEGMENT_FLOOR) {
    throw new Error(
      `Alameda County's centreline answered ${features.length} segments over the city's box, too few to be the whole of it`,
    );
  }

  const segments: Segment[] = [];
  let offLand = 0;
  let unwalkable = 0;
  let degenerate = 0;
  for (const feature of features) {
    const row = feature.properties ?? {};
    for (const part of lineStringsOf(feature.geometry)) {
      const points: Coord[] = [];
      for (const [lng, lat] of part) {
        const previous = points[points.length - 1];
        if (!previous || previous.lng !== lng || previous.lat !== lat) {
          points.push({ lat, lng });
        }
      }
      if (points.length < 2) {
        degenerate += 1;
        continue;
      }
      const middle = points[Math.floor(points.length / 2)];
      if (
        !onLand(points[0]) &&
        !onLand(points[points.length - 1]) &&
        !onLand(middle)
      ) {
        offLand += 1;
        continue;
      }
      const roadType = roadTypeOf(row);
      if (roadType === null) {
        unwalkable += 1;
        continue;
      }
      const dense = densify(points, DENSIFY_METERS);
      if (dense.lengthMeters < DROP_LENGTH_METERS) {
        degenerate += 1;
        continue;
      }
      segments.push({
        physicalId: toInt(String(row.SEGID ?? "")),
        roadType,
        streetWidth: roadType === ROAD_STREET ? EAST_BAY_ROADWAY_FEET : 0,
        // The county publishes no speed limit and no non-walkable flag; the motorways the second
        // would have marked are dropped by class above instead.
        postedSpeed: 0,
        flags: 0,
        name: (row.STREET ?? "").trim(),
        nameId: UNNAMED_ID,
        points: dense.points,
        lengthMeters: dense.lengthMeters,
      });
    }
  }
  console.error(
    `  east bay streets: ${segments.length} walkable of ${features.length} in the box` +
      ` (${offLand} off land, ${unwalkable} motorway or unclassified, ${degenerate} degenerate)`,
  );
  return segments;
}

// The county's layer is a polyline layer, so a feature is a LineString or — where one segment was
// digitized in several pieces — a MultiLineString. Each piece becomes its own STRT record, which is
// what the encoders already expect of a divided street.
function lineStringsOf(
  geometry: GeoJsonGeometry | null | undefined,
): [number, number][][] {
  if (!geometry) {
    return [];
  }
  const shape = geometry as unknown as {
    type: string;
    coordinates: [number, number][] | [number, number][][];
  };
  if (shape.type === "LineString") {
    return [shape.coordinates as [number, number][]];
  } else if (shape.type === "MultiLineString") {
    return shape.coordinates as [number, number][][];
  } else {
    return [];
  }
}

// Alameda County's assessor parcel layer: 489,784 polygons, each carrying the assessor's own
// `UseCode` on the geometry, refreshed monthly. This is the East Bay's answer to the DataSF land-use
// table `fetchSfIndustrial` reads, and like it — and unlike a zoning map — it records what a parcel
// IS rather than what it may become, which is the distinction this project's M-zoning lesson turns
// on.
//
// The regional alternative, SFEI Existing Land Use 2020 (MTC's nine-county layer, 465,381
// polygons), is not used and does not need to be: its `elu_use_code` IS this same assessor code,
// frozen at the 2020 roll and generalized onto coarser geometry. Its one advantage is reaching the
// other eight counties, and the whole East Bay half of this region sits in this one.
const PARCEL_SERVICE =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Parcels/FeatureServer/0/query";

// The assessor's industrial band, read off its published 198-row use-code table
// (`Assessor_Office_Use_Codes` in the same org): 4000 vacant industrial land, 4100-4103 warehouse
// and its self-storage and cold-storage kinds, 4200-4205 light manufacturing through flex/R&D and
// data centres, 4300 heavy industrial, 4400 miscellaneous improved industrial, 4600/4601 quarries
// and landfill, 4700 salt ponds, 4800 trucking and distribution terminals, 4900 wrecking yards,
// plus the condominium-industrial forms 4101/4191.
//
// **4000, vacant industrial land, is in on purpose.** It is the assessor's own reading that this
// land is industrial while nothing stands on it, which is the same thing San Francisco's rule keeps
// through its "unbuilt and zoned industrial" branch — the truck yard with no building on it, which
// would otherwise not register at all.
const INDUSTRIAL_USE_CODES = "UseCode LIKE '4%'";
// The two rows inside the band that are not industrial land. 4240 is a live-work condominium, which
// is housing that happens to be filed against industrial stock; 4500 is a plant nursery, which is
// horticulture — SFEI's own crosswalk files florists, nurseries and greenhouses under commercial.
const NON_INDUSTRIAL_USE_CODES: ReadonlySet<string> = new Set(["4240", "4500"]);
// 3,454 parcels answered the band over the city's box at the last read (2026-08-29), of which the
// land test and the two exclusions above keep 3,400. A floor on the paged read, so a service that
// returned a truncated layer fails here rather than writing a half-empty artifact.
const EAST_BAY_INDUSTRIAL_FLOOR = 3_000;

interface ParcelRow {
  UseCode?: string | null;
}

// A feature's parts as lon/lat rings, a MultiPolygon's disjoint parts one polygon each. A ring of
// fewer than four vertices is degenerate and dropped, and a part left with none is dropped with it.
function polygonPartsOf(
  geometry: GeoJsonGeometry | null | undefined,
): Polygon[] {
  return ringsOf(geometry)
    .map((part) =>
      part
        .map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))
        .filter((ring) => ring.length >= 4),
    )
    .filter((part) => part.length > 0);
}

function parcelPageUrl(offset: number, box: Box, where: string): string {
  const url = new URL(PARCEL_SERVICE);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", "UseCode");
  url.searchParams.set(
    "geometry",
    JSON.stringify({
      xmin: box.west,
      ymin: box.south,
      xmax: box.east,
      ymax: box.north,
      spatialReference: { wkid: 4326 },
    }),
  );
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  // Without an order, an ArcGIS layer may repeat or skip rows between `resultOffset` pages.
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

// MTC's regional Existing Land Use 2020, compiled by SFEI: 465,381 polygons over the nine counties,
// recording observed existing use. It is read here for ONE thing the assessor's roll structurally
// cannot answer — **publicly owned industrial land**. The Oakland Army Base, the rail yards along
// Maritime Street and the industrial half of Alameda Point are tax-exempt, so they carry no
// assessor use code at all and the parcel layer above passes straight over them; they are the most
// industrial ground in the region.
//
// The read is narrowed to `Ownership='Public'` for that reason and no other: the private parcels
// this layer holds are the same roll, four years staler, on coarser geometry, and taking them would
// only redraw what the assessor already draws.
//
// `county='Alameda'` is not decoration. This layer covers all nine counties, and the region's
// bounding box takes in San Francisco, so an envelope query alone would hand back San Francisco's
// parcels for a second reading of land scripts/sf.ts has already read from the city's own table.
const REGIONAL_LAND_USE_SERVICE =
  "https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/sfei_elu_2020_rel1/FeatureServer/0/query";
// This layer's own use-code scheme, which is NOT the assessor's — 5000 here is Industrial (General)
// where 5000 on a parcel is a rural homesite. Its industrial classes: 5000-5003 general, light
// manufacturing, light industrial and warehouse; 6000 and 6004 heavy industrial and salvage yards;
// 6508 truck terminals; 8003 industrial vacant land.
//
// **6510, Harbour & Marine Transportation, is left out**, and it is the class that sounds most like
// the port. In the East Bay it does not name the port: it names marinas. Its two publicly-owned
// polygons here are the Berkeley Marina headland — Cesar Chavez Park, the fishing pier and the
// Adventure Playground, 0.64 km² of waterfront parkland — which drawn as industrial would both look
// wrong and price one of the best walks in Berkeley as a nuisance to be routed around.
const REGIONAL_INDUSTRIAL_USE_CODES =
  "elu_use_code IN (5000,5001,5002,5003,6000,6004,6508,8003)";
const REGIONAL_PUBLIC_INDUSTRIAL = `county='Alameda' AND Ownership='Public' AND ${REGIONAL_INDUSTRIAL_USE_CODES}`;
// 318 polygons over the seven cities at the last read (2026-08-29). A floor, as the parcel read has.
const EAST_BAY_PUBLIC_INDUSTRIAL_FLOOR = 250;

export interface EastBayIndustrial {
  polygons: Polygon[];
  parcels: number; // features kept, as against the polygon parts they expand to
  publicParcels: number; // of those, the tax-exempt ones only the regional layer sees
  offLand: number; // features every part of which missed the coastline
}

// The county's industrial parcels, clipped to the city's land. The envelope is the land's own box,
// so the read is the bayshore rather than the whole county — Hayward's and Fremont's industrial
// flats are outside it — and the land test below is what actually decides. A parcel is kept if any
// vertex of it is on land, not if its centroid is: this is the waterfront, and the yards along the
// estuary and the Oakland Army Base reach past the shoreline the city limits are cut at.
export async function fetchEastBayIndustrial(
  land: LandContext,
): Promise<EastBayIndustrial> {
  const { onLand, box } = land;
  const features: GeoJsonFeature<ParcelRow>[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = parcelPageUrl(offset, box, INDUSTRIAL_USE_CODES);
    const page = await cached(
      `alameda-industrial-${offset}`,
      url,
      () => fetchGeoJson<ParcelRow>(url),
      true,
    );
    features.push(...page);
    if (page.length < PAGE_SIZE) {
      break;
    }
  }
  if (features.length < EAST_BAY_INDUSTRIAL_FLOOR) {
    throw new Error(
      `Alameda County's parcels answered ${features.length} industrial parcels over the city's box, too few to be the whole of it`,
    );
  }

  const polygons: Polygon[] = [];
  let parcels = 0;
  let offLand = 0;
  let excluded = 0;
  for (const feature of features) {
    const useCode = (feature.properties?.UseCode ?? "").trim();
    if (NON_INDUSTRIAL_USE_CODES.has(useCode)) {
      excluded += 1;
      continue;
    }
    const parts = polygonPartsOf(feature.geometry).filter((part) =>
      part.some((ring) => ring.some(onLand)),
    );
    if (parts.length === 0) {
      offLand += 1;
      continue;
    }
    parcels += 1;
    polygons.push(...parts);
  }

  const publicLand = await fetchPublicIndustrial(box);
  let publicParcels = 0;
  for (const feature of publicLand) {
    const parts = polygonPartsOf(feature.geometry).filter((part) =>
      part.some((ring) => ring.some(onLand)),
    );
    if (parts.length === 0) {
      offLand += 1;
      continue;
    }
    publicParcels += 1;
    polygons.push(...parts);
  }

  console.error(
    `  east bay industrial: ${parcels} assessed parcels of ${features.length} in the box` +
      ` plus ${publicParcels} tax-exempt of ${publicLand.length}` +
      ` (${offLand} off land, ${excluded} live-work or nursery)`,
  );
  return { polygons, parcels: parcels + publicParcels, publicParcels, offLand };
}

// The regional layer's publicly-owned industrial polygons over the city's box, paged and cached the
// same way. Its native CRS is UTM 10N, so the query asks for `outSR=4326` like every other here.
async function fetchPublicIndustrial(
  box: Box,
): Promise<GeoJsonFeature<unknown>[]> {
  const features: GeoJsonFeature<unknown>[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(REGIONAL_LAND_USE_SERVICE);
    url.searchParams.set("where", REGIONAL_PUBLIC_INDUSTRIAL);
    url.searchParams.set("outFields", "elu_use_code");
    url.searchParams.set(
      "geometry",
      JSON.stringify({
        xmin: box.west,
        ymin: box.south,
        xmax: box.east,
        ymax: box.north,
        spatialReference: { wkid: 4326 },
      }),
    );
    url.searchParams.set("geometryType", "esriGeometryEnvelope");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("orderByFields", "OBJECTID");
    url.searchParams.set("f", "geojson");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
    const page = await cached(
      `sfei-public-industrial-${offset}`,
      url.toString(),
      () => fetchGeoJson<unknown>(url.toString()),
      true,
    );
    features.push(...page);
    if (page.length < PAGE_SIZE) {
      break;
    }
  }
  if (features.length < EAST_BAY_PUBLIC_INDUSTRIAL_FLOOR) {
    throw new Error(
      `MTC's land use answered ${features.length} publicly-owned industrial polygons over the city's box, too few to be the whole of it`,
    );
  }
  return features;
}

// Oakland's historic areas, and the one place in the East Bay any exist as geometry. Berkeley is a
// verified absence: 346 designated landmarks and its historic districts are published as a PDF list
// of addresses and nothing else — no ArcGIS service in its 466, no Socrata dataset in its 66.
//
// Two layers, because Oakland designates in two registers that mean different things:
//
//   - **HistoricDistrict_API**, 58 Areas of Primary Importance — the top rating of the Oakland
//     Cultural Heritage Survey, and the city's own named districts: Preservation Park, Old Oakland,
//     the Lake Merritt shore, Mountain View Cemetery, the 7th Street groups. This is the closest
//     analogue to an LPC district, and 7.9 km² of it.
//   - **Combining_Zone_Set_4**, the 8 S-7 Preservation and S-20 Historic Preservation District
//     combining zones — the ones actually written into the zoning map, so the strict legal
//     designation. 1.1 km², four fifths of it outside any API area, which is why both are read
//     rather than one.
//
// **The 341 Areas of Secondary Importance are deliberately not read.** They are the survey's second
// rating, they are 15.1 km² — more historic ground than New York's 159 LPC districts cover, in a
// city a fraction of the size — and their median piece is a few adjacent buildings rather than a
// neighbourhood, which is what `data/landmarks` is for. Drawn, they would read as speckle over half
// of Oakland and would discount most of its streets.
//
// The Socrata copies on data.oaklandca.gov are the decoy this layer has: 2013 snapshots of both.
const OAKLAND_SERVICES =
  "https://services.arcgis.com/9tC74aDHuml0x5Yz/arcgis/rest/services";
// The preservation combining zones, out of a layer that holds every combining zone in set 4.
const PRESERVATION_ZONES = "CZ_label IN ('S-7', 'S-20')";
// 58 API areas and 8 preservation zones at the last read (2026-08-29). Floors rather than exact
// counts, and set below the count on both sides: what they are for is a service that answers an
// empty or truncated layer, not Oakland adding a district or lifting one.
const OAKLAND_API_FLOOR = 50;
const OAKLAND_PRESERVATION_ZONE_FLOOR = 6;

export interface EastBayHistoric {
  polygons: Polygon[];
  districts: number; // features kept, as against the polygon parts they expand to
  offLand: number; // features every part of which missed the coastline
}

async function fetchOaklandLayer(
  service: string,
  where: string,
  cacheName: string,
): Promise<GeoJsonFeature<unknown>[]> {
  const url = new URL(`${service}/query`);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", "FID");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "FID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return await cached(cacheName, url.toString(), () =>
    fetchGeoJson<unknown>(url.toString()),
  );
}

// Oakland's historic areas, clipped to the city's land. A district is kept if any vertex of it is on
// land, as the industrial parcels are: the Jack London and Estuary districts run out over the water
// the city limits are cut at.
export async function fetchEastBayHistoric(
  land: LandContext,
): Promise<EastBayHistoric> {
  const [areas, zones] = await Promise.all([
    fetchOaklandLayer(
      `${OAKLAND_SERVICES}/HistoricDistrict_API_shp/FeatureServer/0`,
      "1=1",
      "oakland-historic-api",
    ),
    fetchOaklandLayer(
      `${OAKLAND_SERVICES}/Combining_Zone_Set_4/FeatureServer/0`,
      PRESERVATION_ZONES,
      "oakland-preservation-zones",
    ),
  ]);
  if (
    areas.length < OAKLAND_API_FLOOR ||
    zones.length < OAKLAND_PRESERVATION_ZONE_FLOOR
  ) {
    throw new Error(
      `Oakland answered ${areas.length} primary-importance areas and ${zones.length} preservation zones, too few to be the whole of either`,
    );
  }

  const polygons: Polygon[] = [];
  let districts = 0;
  let offLand = 0;
  for (const feature of [...areas, ...zones]) {
    const parts = polygonPartsOf(feature.geometry).filter((part) =>
      part.some((ring) => ring.some(land.onLand)),
    );
    if (parts.length === 0) {
      offLand += 1;
      continue;
    }
    districts += 1;
    polygons.push(...parts);
  }
  console.error(
    `  east bay historic: ${areas.length} primary-importance areas and ${zones.length} preservation zones,` +
      ` ${districts} on land`,
  );
  return { polygons, districts, offLand };
}

// The East Bay's designated landmarks, and the one thing here that is different in KIND from the
// other two cities rather than only in source.
//
// New York's are the LPC's individual landmark sites and San Francisco's are its Article 10
// landmarks: both are LOCAL registers, the city's own list of its own buildings. **The East Bay has
// no local register to read.** Oakland's designated landmarks are on no service in its 1,349 and in
// no dataset in its 313; Berkeley's 346 are a PDF list of addresses. What does exist is the state's
// Built Environment Resource Directory, the OHP's per-county inventory of every evaluation anyone
// has filed — and what it carries for these cities is overwhelmingly FEDERAL and STATE designation.
//
// So this layer is the National Register, the California Historical Landmarks and the handful of
// locally-registered properties the state happened to ingest. Two things follow, and both are
// visible on the map: a building everyone in Oakland knows is a landmark may be missing because the
// city's own register never reached the state, and a nationally-listed one nobody thinks of that way
// is present. The survey that scoped this expected the local codes to carry it; they do not — the
// Paramount Theatre, of all buildings, is filed 1S and 1CL and not 5S1 at all.
//
// The codes read, from the OHP's own status scheme, are the ones that mean **listed, individually**:
//
//   - `1S`   listed in the National Register by the Keeper, as an individual property
//   - `1CL`  listed in the California Register as a California Historical Landmark
//   - `1CP`  listed in the California Register as a California Point of Historical Interest
//   - `1CS`  listed in the California Register by the State Historical Resources Commission
//   - `5S1`  listed in a LOCAL register
//
// Everything else in the scheme is a different claim and is left out: `1D` and `2D2` are
// *contributors to a district*, which is thousands of ordinary houses and is what `data/historic`
// draws as an area; the whole of category 2 is "determined eligible" and category 3 "appears
// eligible", which are opinions rather than designations; `5S2` and `5S3` are the local halves of
// those two. Reading 5S2 would roughly quadruple the count and would say "someone thinks this could
// be designated" on a map that promises "this is".
const BERD_URL = "https://ohp.parks.ca.gov/pages/1068/files/Alameda.csv";
const DESIGNATED_STATUS_CODES: ReadonlySet<string> = new Set([
  "1S",
  "1CL",
  "1CP",
  "1CS",
  "5S1",
]);
// `Evaluation Info` is one cell holding every evaluation ever filed against the resource, pipe
// separated, each "<status code>, <date>, <reference>". This reads the status code off the front of
// each, which is why it anchors on a pipe or the start of the cell rather than matching anywhere:
// a reference number can begin with a digit too.
const STATUS_CODE = /(?:^|\|)\s*([0-9][A-Z0-9]{0,3})\s*,/g;
// `ALAMEDA_PLACES` the other way round, keyed by the city name the state inventory spells out and
// uppercases, so the two-letter code the county's geocoding layers key on comes from the one map
// rather than a second copy of it.
const BERD_MUNICIPALITIES: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(ALAMEDA_PLACES).map(([code, name]) => [
      name.toUpperCase(),
      code,
    ]),
  );
// 15,134 rows county-wide at the last read (2026-08-29). A floor on the CSV, so a truncated download
// or a moved file fails here rather than writing a nearly-empty artifact.
const BERD_ROW_FLOOR = 12_000;
// The street-type tokens the state writes on the end of a street name and the county's address
// points do not: `FEANME` is the name alone, with the type in `FEATYP`.
const STREET_TYPES: ReadonlySet<string> = new Set([
  "ST",
  "AVE",
  "AV",
  "WY",
  "WAY",
  "BLVD",
  "BL",
  "DR",
  "RD",
  "PL",
  "CT",
  "LN",
  "TER",
  "TERR",
  "CIR",
  "PKWY",
  "SQ",
  "ALY",
  "HWY",
  "PLZ",
  "LOOP",
  "ROW",
  "PATH",
  "WALK",
  "CRES",
  "MALL",
]);
// The one street the two spell differently enough that stripping the type does not reconcile them,
// and it carries Berkeley's City Hall.
const STREET_ALIASES: Record<string, string> = {
  "M L KING JR": "MARTIN LUTHER KING JR",
};
const ADDRESS_POINT_SERVICE =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Address_Points/FeatureServer/0/query";
// How many address or parcel keys are OR'd into one query. The service takes a POST, so the limit is
// its own `where` complexity rather than a URL length.
const GEOCODE_BATCH = 30;

interface BerdRow {
  name: string;
  city: string; // as the inventory spells it, uppercased
  streetNumber: string;
  streetName: string; // the type token already stripped
  situsStreetName: string; // and not stripped, for the parcel roll, which keeps it
  apnSort: string | null;
}

// The county's own APN key: a 3-digit book, a space, then a 4-digit page, a 3-digit parcel and a
// 2-digit sub-parcel. The state inventory writes the same number half a dozen ways — "8 649 5",
// "070-0196-022", "071-0228-001-02" — so the digit groups are read out and re-laid rather than the
// string reformatted. A row whose groups do not fit the widths is not an APN and is dropped; the
// address join is what catches it.
export function apnSortKey(raw: string): string | null {
  const groups = raw.match(/\d+/g) ?? [];
  if (groups.length < 3) {
    return null;
  }
  const [book, page, parcel] = groups as [string, string, string];
  const sub = groups[3] ?? "0";
  if (
    book.length > 3 ||
    page.length > 4 ||
    parcel.length > 3 ||
    sub.length > 2
  ) {
    return null;
  }
  const pad = (value: string, width: number): string =>
    Number.parseInt(value, 10).toString().padStart(width, "0");
  return `${pad(book, 3)} ${pad(page, 4)}${pad(parcel, 3)}${pad(sub, 2)}`;
}

export function featureName(streetName: string): string {
  const tokens = streetName
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 0 && STREET_TYPES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  const name = tokens.join(" ");
  return STREET_ALIASES[name] ?? name;
}

// A name the state inventory shouts, in the case the client draws POI labels in. Three things happen
// to it, and only the third is about case:
//
//   - a `|` separates the resource's name from its aliases ("Thorsen, William R., House|Sigma Phi
//     Place"), so only the first is kept — the label is one line on a map;
//   - the export carries editorial marks on the end of some names (`~`, a stray `<`), which are not
//     part of the name;
//   - a name that already carries a lower-case letter is somebody's considered capitalization and is
//     left entirely alone. Only a shouted one is recased, and a letter RUN at a time rather than a
//     space-separated word, so an initialism keeps its capitals ("U.S. Post Office", not "U.s.").
//     A run after an apostrophe is the tail of the word before it, not a new one — "St Joseph's".
export function prettyLandmarkName(raw: string): string {
  const name = (raw.split("|")[0] ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N})\].]+$/u, "");
  if (/[a-z]/.test(name)) {
    return name;
  }
  return name.replace(/\p{L}+/gu, (run, offset: number) => {
    const before = name[offset - 1];
    if (before === "'" || before === "\u2019") {
      return run.toLowerCase();
    }
    return run.charAt(0) + run.slice(1).toLowerCase();
  });
}

async function fetchBerdRows(): Promise<BerdRow[]> {
  const path = await cachedFile("ohp-berd-alameda", BERD_URL, async () => {
    const response = await fetch(BERD_URL, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  });
  // The export is windows-1252, not UTF-8: it carries curly apostrophes as 0x92, which a UTF-8 read
  // rejects outright.
  const text = new TextDecoder("windows-1252").decode(await readFile(path));
  const rows = parseCsv(text);
  if (rows.length < BERD_ROW_FLOOR) {
    throw new Error(
      `the OHP's Alameda inventory answered ${rows.length} rows, too few to be the whole of it`,
    );
  }

  const kept: BerdRow[] = [];
  for (const row of rows) {
    const city = (row.City ?? "").trim().toUpperCase();
    if (!(city in BERD_MUNICIPALITIES)) {
      continue;
    }
    const codes = [...(row["Evaluation Info"] ?? "").matchAll(STATUS_CODE)].map(
      (match) => match[1],
    );
    if (!codes.some((code) => DESIGNATED_STATUS_CODES.has(code))) {
      continue;
    }
    const name = prettyLandmarkName(row.Name ?? "");
    // A district row belongs to data/historic, which draws the area; here it would put one dot in
    // the middle of a neighbourhood and label it as a building.
    if (name === "" || /\bdistrict\b/i.test(name)) {
      continue;
    }
    const streetName = (row["St Name"] ?? "").trim();
    kept.push({
      name,
      city,
      streetNumber: (row["St Number"] ?? "").trim().toUpperCase(),
      streetName: featureName(streetName),
      situsStreetName: streetName.toUpperCase(),
      apnSort: apnSortKey(row["Parcel Num"] ?? ""),
    });
  }
  return kept;
}

// One batched `where` against a service that takes a POST, so a hundred keys are a handful of
// requests rather than a hundred. Cached on the clause, like every other read here.
async function geocodeBatches<Key>(
  service: string,
  cacheName: string,
  keys: readonly Key[],
  clauseOf: (key: Key) => string,
  outFields: string,
): Promise<GeoJsonFeature<Record<string, string>>[]> {
  const features: GeoJsonFeature<Record<string, string>>[] = [];
  for (let start = 0; start < keys.length; start += GEOCODE_BATCH) {
    const where = keys
      .slice(start, start + GEOCODE_BATCH)
      .map(clauseOf)
      .join(" OR ");
    const body = new URLSearchParams({
      where,
      outFields,
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson",
      resultRecordCount: String(PAGE_SIZE),
    });
    features.push(
      ...(await cached(
        `${cacheName}-${start}`,
        where,
        async () => {
          const response = await fetch(service, {
            method: "POST",
            headers: {
              "user-agent": USER_AGENT,
              "content-type": "application/x-www-form-urlencoded",
            },
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          const page = (await response.json()) as GeoJsonPage<
            Record<string, string>
          >;
          if (page.error) {
            throw new Error(`ArcGIS ${page.error.code}: ${page.error.message}`);
          } else if (!Array.isArray(page.features)) {
            throw new Error("no features in the response");
          }
          return page.features;
        },
        true,
      )),
    );
  }
  return features;
}

// The centre of a feature's first ring, or its point.
function centroidOf(
  geometry: GeoJsonGeometry | null | undefined,
): Coord | null {
  const point = geometry as unknown as { type: string; coordinates: number[] };
  if (point?.type === "Point") {
    const [lng, lat] = point.coordinates;
    return { lat, lng };
  }
  const rings = ringsOf(geometry);
  const ring = rings[0]?.[0];
  if (!ring || ring.length === 0) {
    return null;
  }
  let lat = 0;
  let lng = 0;
  for (const [pointLng, pointLat] of ring) {
    lng += pointLng;
    lat += pointLat;
  }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

// The designated rows, placed. **The state inventory carries no coordinates at all** — it is a
// table of names, addresses and parcel numbers — so every point here is a join, and a row nothing
// joins is a row that does not ship. Three keys are tried in order, each an exact match:
//
//   1. the county's **address points**, on municipality + house number + street name. The best of
//      the three: they are actual address positions, and they are the same layer the geocoder's
//      house numbers already come from (scripts/addresses.ts).
//   2. the **parcel APN**, which places the row at its parcel's centre.
//   3. the **parcel situs address**, which catches a parcel the address-point file has no point on.
//
// Nothing is placed by proximity or by a neighbouring house number. A landmark dot is tapped for a
// name, so putting one on the building next door is worse than leaving it out.
//
// What is left out by that is mostly one thing: the **UC Berkeley campus**, whose buildings the
// state inventory records with a street name and no number — Sather Tower, Doe Library, the Greek
// Theatre, Wheeler Hall. They are unreachable from any address key, and they are why this set is
// noticeably thinner in Berkeley than the register behind it.
export async function fetchEastBayLandmarks(
  land: LandContext,
): Promise<NamedPoint[]> {
  const rows = await fetchBerdRows();

  const addressKeys = [
    ...new Map(
      rows
        .filter((row) => row.streetNumber !== "" && row.streetName !== "")
        .map((row) => [
          `${BERD_MUNICIPALITIES[row.city]}|${row.streetNumber}|${row.streetName}`,
          row,
        ]),
    ).values(),
  ];
  const apnKeys = [
    ...new Set(rows.map((row) => row.apnSort).filter((key) => key !== null)),
  ];
  const situsKeys = [
    ...new Map(
      rows
        .filter((row) => row.streetNumber !== "" && row.situsStreetName !== "")
        .map((row) => [
          `${row.city}|${row.streetNumber}|${row.situsStreetName}`,
          row,
        ]),
    ).values(),
  ];

  const quote = (value: string): string => value.replace(/'/g, "''");
  const [addressPoints, parcelsByApn, parcelsBySitus] = await Promise.all([
    geocodeBatches(
      ADDRESS_POINT_SERVICE,
      "alameda-landmark-addresses",
      addressKeys,
      (row) =>
        `(MUN='${BERD_MUNICIPALITIES[row.city]}' AND ST_NUM='${quote(row.streetNumber)}' AND FEANME='${quote(row.streetName)}')`,
      "MUN,ST_NUM,FEANME",
    ),
    geocodeBatches(
      PARCEL_SERVICE,
      "alameda-landmark-apns",
      apnKeys,
      (key) => `APN_SORT='${key}'`,
      "APN_SORT",
    ),
    geocodeBatches(
      PARCEL_SERVICE,
      "alameda-landmark-situs",
      situsKeys,
      (row) =>
        `(SitusCity='${quote(row.city)}' AND SitusStreetNumber='${quote(row.streetNumber)}' AND SitusStreetName='${quote(row.situsStreetName)}')`,
      "SitusCity,SitusStreetNumber,SitusStreetName",
    ),
  ]);

  const placed = new Map<string, Coord>();
  const remember = (key: string, feature: GeoJsonFeature<unknown>): void => {
    const centroid = centroidOf(feature.geometry);
    if (centroid !== null && !placed.has(key)) {
      placed.set(key, centroid);
    }
  };
  for (const feature of addressPoints) {
    const row = feature.properties ?? {};
    remember(`address|${row.MUN}|${row.ST_NUM}|${row.FEANME}`, feature);
  }
  for (const feature of parcelsByApn) {
    remember(`apn|${feature.properties?.APN_SORT}`, feature);
  }
  for (const feature of parcelsBySitus) {
    const row = feature.properties ?? {};
    remember(
      `situs|${row.SitusCity}|${row.SitusStreetNumber}|${row.SitusStreetName}`,
      feature,
    );
  }

  const points: NamedPoint[] = [];
  const seen = new Set<string>();
  let offLand = 0;
  let ungeocoded = 0;
  for (const row of rows) {
    const coord =
      placed.get(
        `address|${BERD_MUNICIPALITIES[row.city]}|${row.streetNumber}|${row.streetName}`,
      ) ??
      (row.apnSort === null ? undefined : placed.get(`apn|${row.apnSort}`)) ??
      placed.get(
        `situs|${row.city}|${row.streetNumber}|${row.situsStreetName}`,
      );
    if (coord === undefined) {
      ungeocoded += 1;
      continue;
    }
    if (!land.onLand(coord)) {
      offLand += 1;
      continue;
    }
    // The inventory files a building under every name it has held, so one parcel can carry several
    // rows — the Union Iron Works and its machine shop are one address. The first name wins, which
    // is the alphabetical one the export is ordered by.
    const at = `${coord.lat.toFixed(6)},${coord.lng.toFixed(6)}`;
    if (seen.has(at)) {
      continue;
    }
    seen.add(at);
    points.push({ ...coord, name: row.name });
  }
  console.error(
    `  east bay landmarks: ${rows.length} designated, ${points.length} placed` +
      ` (${ungeocoded} with no address or parcel to place them, ${offLand} off land)`,
  );
  return points;
}
