// San Francisco's half of the ingest: the DataSF datasets that stand in for the NYC ones, and the
// places where the shapes genuinely differ rather than just the column names.
//
// DataSF is a Socrata deployment like NYC Open Data, so the reading is shared (scripts/socrata.ts)
// and most of what is here is a field remap. The ones that are not:
//
//   - **The walkability filter.** CSCL has `rw_type`, one code per kind of way. SF's centreline has
//     `classcode`, which is only a road hierarchy (freeway down to local street) and says nothing
//     about whether a person may walk it. The field that does is `layer`, and it is the more
//     expressive of the two — it separates the Presidio's network, pedestrian streets and
//     unimproved right of way from ordinary streets, and it names the PAPER layers, which are
//     streets that exist on the map and not on the ground.
//
//   - **The sidewalk offset.** NYC publishes a kerb-to-kerb `streetwidth` and the pavement is
//     offset half of it. SF publishes the opposite — the width of the *sidewalk* — so the roadway
//     is derived from the right-of-way polygons instead. See `roadwayFeet`.
//
//   - **Industrial land.** NYC reads one land-use code off a tax lot. SF records no such code, so
//     `fetchSfIndustrial` reconstructs it: parcels whose recorded floor area is mostly production,
//     distribution and repair, plus unbuilt parcels inside industrial zoning, which is the only way
//     a truck yard with no building on it registers at all.

import { densify } from "./geometry";
import { buildLandTest } from "./land-filter";
import type { Polygon } from "./overpass";
import { type Coord, DATA_SF, type Tree } from "./socrata";
import {
  ROAD_PATH,
  ROAD_STEPS,
  ROAD_STREET,
  type RoadType,
  type Segment,
  toInt,
} from "./streets";

// Row-count floors the paged reads are checked against. A little below the live count, so a city
// that keeps mapping does not trip them and a page the server quietly cut short does.
const NEIGHBORHOOD_COUNT = 40;
const STREET_COUNT = 16_000;
// Also read by scripts/sidewalks.ts, which takes the per-side column off the same rows.
export const SIDEWALK_WIDTH_DATASET = "4g86-grxu";
export const SIDEWALK_WIDTH_COUNT = 16_000;
const ROW_POLYGON_COUNT = 22_000;

export const SF_ATTRIBUTION = "SF Public Works via DataSF";
export const SF_STREET_ATTRIBUTION = "SF Basemap Street Centerlines via DataSF";
export const SF_CANOPY_ATTRIBUTION =
  "Urban tree canopy © SF Planning (2013 Urban Forest Plan)";

// The land the city actually occupies. NOT the county polygon: San Francisco County's legal
// boundary runs out into the bay, out into the ocean, and 45 km offshore to the Farallon Islands,
// which would widen the city's bounding box by half a degree of empty water — and that box is what
// every Overpass query and the whole tile plan are cut from. The analysis neighbourhoods are
// already clipped to the shoreline and are the structural twin of NYC's borough boundaries.
export async function fetchSfLand(): Promise<Polygon[]> {
  const rows = await DATA_SF.dataset<{
    the_geom?: { type: string; coordinates: [number, number][][][] };
  }>("j2bu-swwd", { $select: "*" }, NEIGHBORHOOD_COUNT);
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

interface StreetRow {
  line?: { type: string; coordinates: [number, number][] };
  cnn?: string;
  layer?: string;
  classcode?: string;
  streetname?: string;
  st_type?: string;
  active?: boolean;
}

interface SidewalkWidthRow {
  cnn?: string;
  sidewalk_f?: string; // the ACTUAL sidewalk width in feet; 0 unknown, negative "varies"
}

interface RowPolygonRow {
  cnn?: string;
  shape_area?: string; // square feet — the dataset is in the state plane foot
}

// The layers whose segments a person can walk, and what each is in the tiler's terms. `PAPER`,
// `PAPER_FWYS` and `PAPER_WATER` are platted streets that were never built — `PAPER_WATER` would
// put walking edges out in the bay — and `PSEUDO` is a bookkeeping line. Freeways are dropped here
// and come back as the HWAY nuisance source, which is a penalty to walk near and never routed.
const WALKABLE_LAYERS: Record<string, RoadType> = {
  STREETS: ROAD_STREET,
  STREETS_TI: ROAD_STREET, // Treasure Island
  STREETS_YBI: ROAD_STREET, // Yerba Buena Island
  STREETS_HUNTERSP: ROAD_STREET,
  PRIVATE: ROAD_STREET, // named private streets, walked like any other
  STREETS_PEDESTRI: ROAD_PATH, // the walking surface itself, so no sidewalk is offset off it
  PARKS: ROAD_PATH,
  PARKS_NPS_PRESIDIO: ROAD_PATH,
  PARKS_NPS_FTMASON: ROAD_PATH,
  UPROW: ROAD_PATH, // unimproved right of way: a way on the ground, without a built roadway
};

// `st_type` refines the layer where it names something the tiler treats specially — here, step
// streets, which carry the steps flag through to the route panel.
//
// `ALY` is deliberately NOT mapped to the tiler's alley type. That type carries New York's meaning:
// a service way with no pavement at all, which the existence gate demotes to its centreline (97% of
// New York's alley km). San Francisco's alleys are narrow STREETS — Clara, Minna, Natoma — and OSM
// maps sidewalks along them, so only 6.6% of their km demote. Calling them alleys asserted something
// about them that is not true and failed the build for it.
const TYPE_OVERRIDES: Record<string, RoadType> = {
  STPS: ROAD_STEPS,
  STWY: ROAD_STEPS,
  WALK: ROAD_PATH,
  PATH: ROAD_PATH,
  PSGE: ROAD_PATH,
  PLZ: ROAD_PATH,
};

function roadTypeOf(row: StreetRow): RoadType | null {
  const layer = WALKABLE_LAYERS[row.layer ?? ""];
  if (layer === undefined) {
    return null;
  }
  const override = TYPE_OVERRIDES[(row.st_type ?? "").toUpperCase()];
  // An override only ever refines a street; it never promotes a park path back to a roadway.
  return override !== undefined && layer === ROAD_STREET ? override : layer;
}

// The pavement's distance from the centreline, in the feet a STRT record stores, derived rather
// than published. NYC offsets by half its kerb-to-kerb `streetwidth`; SF publishes no roadway width
// at all. What it does publish is the right-of-way polygon for each segment and, separately, the
// width of the sidewalk — and a right of way is the roadway plus its two pavements, so
//
//     roadway = rightOfWay - 2 * sidewalk
//
// with the right of way measured as the polygon's area over the length of the centreline it belongs
// to. Storing the roadway as a "street width" keeps one meaning downstream: the tiler halves it.
//
// Measured over the 10,028 segments carrying both inputs, that lands at a median of 26 ft (p25 18,
// p75 32, p90 39), against New York's median of 30 — the right shape for a city whose residential
// streets are a little narrower. 2.2% come out negative, where the survey's sidewalk figure cannot
// be squared with the polygon; those fall back to the median with everything else that is missing
// an input.
const SF_MEDIAN_ROADWAY_FEET = 26;

function roadwayFeet(
  rightOfWayFeet: number | undefined,
  sidewalkFeet: number | undefined,
): number {
  if (
    rightOfWayFeet === undefined ||
    sidewalkFeet === undefined ||
    rightOfWayFeet <= 0 ||
    sidewalkFeet <= 0
  ) {
    return SF_MEDIAN_ROADWAY_FEET;
  }
  const roadway = rightOfWayFeet - 2 * sidewalkFeet;
  return roadway > 0
    ? Math.min(255, Math.round(roadway))
    : SF_MEDIAN_ROADWAY_FEET;
}

// Right-of-way area per segment, summed because a divided street is several polygons under one id.
// The width itself is not taken here: it is the area over the *centreline's* own length, and that
// is known only once the geometry has been read.
function rightOfWayAreas(rows: RowPolygonRow[]): Map<string, number> {
  const areas = new Map<string, number>();
  for (const row of rows) {
    const area = Number.parseFloat(row.shape_area ?? "");
    if (row.cnn && Number.isFinite(area) && area > 0) {
      const key = String(toInt(row.cnn));
      areas.set(key, (areas.get(key) ?? 0) + area);
    }
  }
  return areas;
}

function medianOf(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const METERS_PER_FOOT = 0.3048;
const DENSIFY_METERS = 25;
const DROP_LENGTH_METERS = 0.5;
const UNNAMED_ID = 0xffff;

export async function fetchSfStreets(): Promise<Segment[]> {
  const [rows, widthRows, rowRows] = await Promise.all([
    DATA_SF.dataset<StreetRow>(
      "3psu-pn9h",
      { $select: "*", $where: "active = true" },
      STREET_COUNT,
    ),
    DATA_SF.dataset<SidewalkWidthRow>(
      SIDEWALK_WIDTH_DATASET,
      { $select: "cnn,sidewalk_f" },
      SIDEWALK_WIDTH_COUNT,
    ),
    DATA_SF.dataset<RowPolygonRow>(
      "h8n7-e4ns",
      { $select: "cnn,shape_area" },
      ROW_POLYGON_COUNT,
    ),
  ]);

  // Keyed through `toInt`, the same normalisation a segment's own `physicalId` goes through, so the
  // two sides of the join cannot drift on a leading zero or a ".0" the column comes back with.
  const sidewalkFeet = new Map<string, number>();
  const measured: number[] = [];
  for (const row of widthRows) {
    const feet = Number.parseFloat(row.sidewalk_f ?? "");
    if (row.cnn && Number.isFinite(feet) && feet > 0) {
      sidewalkFeet.set(String(toInt(row.cnn)), feet);
      measured.push(feet);
    }
  }
  const areas = rightOfWayAreas(rowRows);
  console.error(
    `  sidewalk widths: ${sidewalkFeet.size} measured (median ${medianOf(measured).toFixed(0)} ft), ${areas.size} right-of-way polygons`,
  );
  const roadways: number[] = [];

  const segments: Segment[] = [];
  let degenerate = 0;
  let offset = 0;
  for (const row of rows) {
    const roadType = roadTypeOf(row);
    if (!row.line || roadType === null) {
      continue;
    }
    const points: Coord[] = [];
    for (const [lng, lat] of row.line.coordinates) {
      const previous = points[points.length - 1];
      if (!previous || previous.lng !== lng || previous.lat !== lat) {
        points.push({ lng, lat });
      }
    }
    if (points.length < 2) {
      degenerate += 1;
      continue;
    }
    const dense = densify(points, DENSIFY_METERS);
    if (dense.lengthMeters < DROP_LENGTH_METERS) {
      degenerate += 1;
      continue;
    }
    // A path is its own walking surface, so it carries no offset — the same rule CSCL's boardwalks
    // and step streets follow.
    const area = areas.get(String(toInt(row.cnn)));
    const lengthFeet = dense.lengthMeters / METERS_PER_FOOT;
    const width =
      roadType === ROAD_STREET
        ? roadwayFeet(
            area !== undefined && lengthFeet > 0
              ? area / lengthFeet
              : undefined,
            sidewalkFeet.get(String(toInt(row.cnn))),
          )
        : 0;
    if (width > 0) {
      offset += 1;
      roadways.push(width);
    }
    segments.push({
      physicalId: toInt(row.cnn),
      roadType,
      streetWidth: width,
      postedSpeed: 0, // SF publishes speed limits as their own dataset, not on the centreline
      // No vehicular-only flag: `classcode = 1` occurs on the FREEWAYS layer and nowhere else, and
      // that layer is already dropped above, so the branch that set it could never fire. If SF ever
      // publishes a field that really marks a roadway closed to walking, it goes here.
      flags: 0,
      name: (row.streetname ?? "").trim(),
      nameId: UNNAMED_ID,
      points: dense.points,
      lengthMeters: dense.lengthMeters,
    });
  }
  console.error(
    `  streets: ${segments.length} walkable of ${rows.length} active, ${offset} offsetted (median roadway ${medianOf(roadways).toFixed(0)} ft, ${degenerate} degenerate dropped)`,
  );
  return segments;
}

interface TreeRow {
  latitude?: string;
  longitude?: string;
  dbh?: string;
  qspecies?: string;
  planttype?: string;
}

// The DPW street-tree register. It feeds the genus overlay and the crown radii, not the cover field
// — that comes from the canopy polygons — so its thinness against New York's forestry census
// (198k rows to 899k) costs the map far less than it looks.
//
// `dbh` is present on 152k of the 198k rows, 76%, where New York's ForMS carries it on all but 734.
// The ingest's existing imputation handles the rest; it is simply doing much more of the work here,
// and the manifest records how many it stood in for.
const SF_TREE_COUNT = 190_000;

// "Fraxinus uhdei :: Shamel Ash: Evergreen Ash" — the scientific name is the part before " :: ",
// and the genus its first token. NYC's ForMS spells the same thing "Acer nigrum - black maple",
// which is why this cannot share the parser.
//
// "Tree(s) ::" is the register's own way of recording a tree whose species nobody identified, and it
// is the second most common value in the file — 11,818 rows. Left alone it becomes a genus called
// "Tree(s)" sitting fourth in the legend, which is exactly the kind of thing an overlay should not
// invite anyone to read a pattern into.
const UNIDENTIFIED = new Set(["", "unknown", "tree(s)", "tree", "trees"]);

function sfGenusOf(species: string | undefined): string {
  const scientific = (species ?? "").split("::")[0].trim();
  const genus = scientific.split(/\s+/)[0] ?? "";
  return UNIDENTIFIED.has(genus.toLowerCase()) ? "" : genus;
}

export async function fetchSfTrees(): Promise<Tree[]> {
  const rows = await DATA_SF.dataset<TreeRow>(
    "tkzw-k3nq",
    { $select: "*", $where: "planttype in ('Tree','tree')" },
    SF_TREE_COUNT,
  );
  const trees: Tree[] = [];
  for (const row of rows) {
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    const dbh = Number.parseFloat(row.dbh ?? "");
    trees.push({
      lat,
      lng,
      dbhInches: Number.isFinite(dbh) && dbh > 0 ? dbh : 0,
      genus: sfGenusOf(row.qspecies),
    });
  }
  return trees;
}

// The canopy footprint the cover field is blurred from. SF's is the 2013 Urban Forest Plan analysis
// — aerial imagery, not LiDAR, and a decade older than New York's 2017 survey — which is the single
// biggest quality gap between the two cities and is recorded in the manifest's attribution so the
// map says where its cover came from.
const SF_CANOPY_COUNT = 285_000;

export async function fetchSfCanopyPolygons(): Promise<{
  polygons: Polygon[];
  fetched: number;
  dropped: number;
}> {
  const rows = await DATA_SF.dataset<{
    the_geom?: { type: string; coordinates: number[][][][] };
  }>("ni2e-vpbg", { $select: "the_geom" }, SF_CANOPY_COUNT);
  const polygons: Polygon[] = [];
  let dropped = 0;
  for (const row of rows) {
    for (const parts of row.the_geom?.coordinates ?? []) {
      const rings = parts
        .map((ring) =>
          ring.map(([lng, lat]) => ({
            lat: lat as number,
            lng: lng as number,
          })),
        )
        .filter((ring) => ring.length >= 4);
      if (rings.length === 0) {
        dropped += 1;
      } else {
        polygons.push(rings);
      }
    }
  }
  return { polygons, fetched: rows.length, dropped };
}

// A polygon dataset read at its centroid, which is how both SF landmark sets and the historic
// districts are published — NYC's LPC set carries a point already, SF's carries the parcel.
function centroidOf(
  geometry: { coordinates: number[][][][] } | undefined,
): Coord | null {
  const ring = geometry?.coordinates?.[0]?.[0];
  if (!ring || ring.length < 3) {
    return null;
  }
  let lat = 0;
  let lng = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

export interface NamedPoint extends Coord {
  name: string;
}

// Article 10 landmarks, the city's own designated historic sites — 362 of them against New York's
// ~1,500, over a sixth of the land, so denser per square kilometre rather than thinner.
export async function fetchSfLandmarks(
  onLand: (coord: Coord) => boolean,
): Promise<NamedPoint[]> {
  const rows = await DATA_SF.dataset<{
    the_geom?: { coordinates: number[][][][] };
    name?: string;
  }>("rzic-39gi", { $select: "*" }, 350);
  const points: NamedPoint[] = [];
  for (const row of rows) {
    const centroid = centroidOf(row.the_geom);
    if (centroid && onLand(centroid)) {
      points.push({ ...centroid, name: (row.name ?? "").trim() });
    }
  }
  return points;
}

// The Civic Art Collection, the 1% Art Program's own inventory, and the StreetSmArts murals. Three
// sources because no one of them is the whole picture, which is the same reason NYC's art reads the
// PDC inventory and OSM together; the ingest dedups them by proximity afterwards.
export async function fetchSfArt(
  onLand: (coord: Coord) => boolean,
): Promise<NamedPoint[]> {
  const [civic, onePercent, murals] = await Promise.all([
    DATA_SF.dataset<{
      latitude?: string;
      longitude?: string;
      display_title?: string;
    }>("r7bn-7v9c", { $select: "*" }, 1_000),
    DATA_SF.dataset<{ the_geom?: { coordinates: number[] }; title?: string }>(
      "cf6e-9e4j",
      { $select: "*" },
      60,
    ),
    DATA_SF.dataset<{ the_geom?: { coordinates: number[] }; title?: string }>(
      "wg8w-68vc",
      { $select: "*" },
      60,
    ),
  ]);
  const points: NamedPoint[] = [];
  for (const row of civic) {
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lng) && onLand({ lat, lng })) {
      points.push({ lat, lng, name: (row.display_title ?? "").trim() });
    }
  }
  for (const rows of [onePercent, murals]) {
    for (const row of rows) {
      const [lng, lat] = row.the_geom?.coordinates ?? [];
      if (
        typeof lat === "number" &&
        typeof lng === "number" &&
        onLand({ lat, lng })
      ) {
        points.push({ lat, lng, name: (row.title ?? "").trim() });
      }
    }
  }
  return points;
}

export interface RawBuilding {
  polygon: Coord[][];
  heightMeters: number;
  baseElevationMeters: number;
}

// The building footprints the shade model raises into walls. SF's carry their own LiDAR-measured
// height on the row (`hgt_median_m`, the median height above ground over the footprint) and their
// ground elevation with it (`gnd_min_m`), so unlike NYC's there is no height join at all.
const SF_BUILDING_COUNT = 170_000;

export async function fetchSfBuildings(
  onLand: (coord: Coord) => boolean,
): Promise<RawBuilding[]> {
  const rows = await DATA_SF.dataset<{
    shape?: { type: string; coordinates: number[][][][] };
    hgt_median_m?: string;
    gnd_min_m?: string;
  }>(
    "ynuv-fyni",
    { $select: "shape,hgt_median_m,gnd_min_m" },
    SF_BUILDING_COUNT,
  );
  const buildings: RawBuilding[] = [];
  for (const row of rows) {
    const height = Number.parseFloat(row.hgt_median_m ?? "");
    if (!Number.isFinite(height) || height <= 0) {
      continue;
    }
    const ground = Number.parseFloat(row.gnd_min_m ?? "");
    for (const parts of row.shape?.coordinates ?? []) {
      const polygon = parts.map((ring) =>
        ring.map(([lng, lat]) => ({ lat: lat as number, lng: lng as number })),
      );
      const outer = polygon[0] ?? [];
      if (outer.length >= 4 && outer.some(onLand)) {
        buildings.push({
          polygon,
          heightMeters: height,
          baseElevationMeters: Number.isFinite(ground) ? ground : 0,
        });
      }
    }
  }
  return buildings;
}

// The industrial land the INDL overlay draws and the graph's frontage byte is baked from. There is
// no San Francisco column matching New York's PLUTO `LandUse = '06'`; what stands in for it is two
// datasets, because neither alone is the city's industry:
//
//   - **Land use (`c5ge-t6pj`)**, one row per parcel, carries floor area per category rather than a
//     class code. PDR — Production, Distribution & Repair — is the city's own name for industry, so
//     a parcel whose PDR floor area beats every other category is industrial by use, which is as
//     close as this city comes to New York's signal. But floor area only sees BUILDINGS: a truck
//     yard, a container lot or a vacant industrial block has none and is invisible here.
//
//   - **Zoning (`3i4a-hu95`)**, `gen = 'Industrial'` (PDR-1-G, PDR-2, M-1, SALI …), which does see
//     those. It is the fallback and not the filter: only about half the PDR-dominant parcels sit
//     inside industrial zoning, so requiring it would discard the other half, and taking zoning
//     alone would draw the housing and offices that fill an up-zoned PDR district.
//
// So: PDR-dominant, OR no recorded use of any kind and inside industrial zoning.
//
// Three rollups in the parcel table defeat that rule and are thrown out by name below.
const SF_PARCEL_COUNT = 8_500;
const SF_INDUSTRIAL_ZONE_COUNT = 370;
// The 62 `analytical` rows are not parcels: they are named analysis districts — the whole Presidio,
// all of Treasure Island, the blocks of Mission Bay South — carrying modelled round-number floor
// areas over polygons up to 2.1 km², six of which read PDR-dominant. The industrial land under them
// is in the table as ordinary parcels anyway (208 inside Hunters Point Shipyard alone). A
// `multiple_parcels` row, by contrast, is real adjacent parcels recorded together, and lists its own
// block-lots, none of which is separately a row, so it neither invents geometry nor double-counts.
const SF_PARCEL_GEOGRAPHIES = "('parcel', 'multiple_parcels')";
// 36.4M sq ft of PDR, 43% of the citywide total, on a 25 m x 19 m rectangle in the Financial
// District. Dominance happens to exclude it — its own biggest category is offices — but a rule that
// only accidentally rejects a number that wrong is not a rule.
const PDR_ROLLUP_PARCEL = "0253021";
// Fort Mason: 66 hectares of federal parkland — the Marina Green, the yacht harbour and the lawns
// above them — recorded as one parcel whose only floor area is the 30k sq ft of pier sheds at Fort
// Mason Center. Those really are warehouses, so the rule reads it correctly and still gets the place
// wrong. Excluded by hand rather than by a threshold: every measure that separates it from a genuine
// yard (barely built, very large, outside the zoning map) is a measure a genuine yard also trips, and
// the yards along Islais Creek and in Hunters Point are the land this feature most wants to keep.
const FORT_MASON_PARCEL = "0900003";
// Six parcels record exactly one square foot of PDR and nothing else, a placeholder rather than a
// use, which wins dominance outright for being the only category on the row. Four are big: Ocean
// Beach and the western end of Golden Gate Park. The next parcel up records 500 sq ft.
const PDR_PLACEHOLDER_SQUARE_FEET = 1;

interface LandUseRow {
  the_geom?: { type: string; coordinates: number[][][][] };
  mapblklot?: string;
  centroid_l?: string; // latitude; `centroid_1` is the longitude, truncated column names
  centroid_1?: string;
  pdr?: string;
  retail?: string;
  mips?: string;
  cie?: string;
  med?: string;
  visitor?: string;
  total_comm?: string; // the published sum of the six categories above
  resunits?: string;
}

const PDR_RIVALS = ["retail", "mips", "cie", "med", "visitor"] as const;

function squareFeet(value: string | undefined): number {
  const feet = Number.parseFloat(value ?? "");
  return Number.isFinite(feet) ? feet : 0;
}

export interface SfIndustrial {
  polygons: Polygon[];
  parcels: number;
  dominant: number; // kept because PDR is the parcel's own biggest use
  zoned: number; // kept because nothing is built on it and it is zoned industrial
  offLand: number;
}

export async function fetchSfIndustrial(
  onLand: (coord: Coord) => boolean,
): Promise<SfIndustrial> {
  // `resunits` counts homes; there is no residential floor area to weigh PDR against, and the
  // `residentia` column names a housing SUBTYPE ("sro", "senior living") rather than an area.
  const unused =
    "(total_comm IS NULL OR total_comm = 0) AND (resunits IS NULL OR resunits = 0)";
  const [rows, zones] = await Promise.all([
    DATA_SF.dataset<LandUseRow>(
      "c5ge-t6pj",
      {
        $select: "*",
        $where: `geography_type in ${SF_PARCEL_GEOGRAPHIES} AND (pdr > 0 OR (${unused}))`,
      },
      SF_PARCEL_COUNT,
    ),
    DATA_SF.dataset<{ the_geom?: { coordinates: number[][][][] } }>(
      "3i4a-hu95",
      { $select: "the_geom", $where: "gen = 'Industrial'" },
      SF_INDUSTRIAL_ZONE_COUNT,
    ),
  ]);

  // The zoning polygons as a point-in-set test — `buildLandTest` is the even-odd bands, indifferent
  // to what the polygons mean.
  const zonePolygons: Polygon[] = [];
  for (const zone of zones) {
    for (const parts of zone.the_geom?.coordinates ?? []) {
      zonePolygons.push(
        parts.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
      );
    }
  }
  const inIndustrialZone = buildLandTest(zonePolygons);

  const polygons: Polygon[] = [];
  let parcels = 0;
  let dominant = 0;
  let zoned = 0;
  let offLand = 0;
  for (const row of rows) {
    if (
      row.mapblklot === PDR_ROLLUP_PARCEL ||
      row.mapblklot === FORT_MASON_PARCEL
    ) {
      continue;
    }
    const pdr = squareFeet(row.pdr);
    const lat = Number.parseFloat(row.centroid_l ?? "");
    const lng = Number.parseFloat(row.centroid_1 ?? "");
    let branch: "dominant" | "zoned" | null = null;
    if (
      pdr > PDR_PLACEHOLDER_SQUARE_FEET &&
      PDR_RIVALS.every((rival) => pdr >= squareFeet(row[rival]))
    ) {
      branch = "dominant";
    } else if (
      squareFeet(row.total_comm) === 0 &&
      squareFeet(row.resunits) === 0 &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      inIndustrialZone({ lat, lng })
    ) {
      branch = "zoned";
    }
    if (branch === null) {
      continue;
    }
    // Any vertex on land, not the centroid: this is the waterfront, and a pier or a bulkhead lot
    // reaching past the shoreline the neighbourhood polygons draw tests as land only where it meets
    // it — the same rule the New York lots are clipped by.
    const parts = (row.the_geom?.coordinates ?? [])
      .map((part) =>
        part
          .map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))
          .filter((ring) => ring.length >= 4),
      )
      .filter(
        (part) => part.length > 0 && part.some((ring) => ring.some(onLand)),
      );
    if (parts.length === 0) {
      offLand += 1;
      continue;
    }
    parcels += 1;
    if (branch === "dominant") {
      dominant += 1;
    } else {
      zoned += 1;
    }
    polygons.push(...parts);
  }
  return { polygons, parcels, dominant, zoned, offLand };
}
