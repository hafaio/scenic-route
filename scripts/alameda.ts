// The East Bay's half of the Bay Area ingest: Alameda County's own layers, standing in for the
// DataSF ones San Francisco is read from (scripts/sf.ts).
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

import { cached } from "./cache";
import { densify } from "./geometry";
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
  "City limits © Alameda County GIS, shoreline from US Census TIGER hydrography";
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
const EAST_BAY_CITY_LIMITS: readonly string[] = [
  "CITY OF ALBANY",
  "CITY OF BERKELEY",
  "CITY OF EMERYVILLE",
  "CITY OF OAKLAND",
  "CITY OF PIEDMONT",
  "CITY OF ALAMEDA",
  "CITY OF SAN LEANDRO",
];

const CITY_LIMITS_SERVICE =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Administrative_Boundaries/FeatureServer/2/query";

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
  const water = await fetchTidalWater(boxOfRings(limits));
  // Imported here rather than at the top: polygon-clipping is a devDependency this one function
  // needs, and every other consumer of this module pays its load otherwise.
  const { difference } = await import("polygon-clipping");
  const land = difference(
    limits as Parameters<typeof difference>[0],
    water as Parameters<typeof difference>[0],
  ) as Ring[][];
  console.error(
    `  east bay: ${EAST_BAY_CITY_LIMITS.length} city limits less ${water.length} water polygons` +
      ` = ${land.length} land polygons`,
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
