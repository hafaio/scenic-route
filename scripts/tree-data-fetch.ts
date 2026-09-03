// `bun run scripts/tree-data-fetch.ts --city <id>`: the fetching and encoding half of the tree-data
// ingest. It writes data/{ferries,landmarks,art,highways,trees,land,canopy,sidewalks,streets,
// paths}/<id>.bin, then .build/ingest.json (what `tiler ingest` is pointed at) and
// .build/tree-data.json (what the manifest half needs from here), and exits. It spawns nothing:
// package.json sequences this, `cargo run --release --bin tiler -- ingest` and
// scripts/tree-data-manifest.ts. The model, the sources and the binary layouts are all documented
// in scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { EAST_BAY_STREET_ATTRIBUTION, fetchEastBayStreets } from "./alameda";
import {
  ALCC_ATTRIBUTION,
  ALCC_HEIGHT_ATTRIBUTION,
  ALCC_SOURCE_URL,
  eastBayCanopy,
} from "./alcc";
import {
  type CrownAllometry,
  crownDiameterMeters,
  NOCALC_LONDON_PLANE,
  NOEAST_LONDON_PLANE,
} from "./allometry";
import { type ArtSource, ingestArt, NYC_ART, SF_ART } from "./art";
import { type BuildingSource, NYC_BUILDINGS, SF_BUILDINGS } from "./buildings";
import { fetchCanopyPolygons } from "./canopy";
import { CHM_ATTRIBUTION, CHM_SOURCE_URL, fetchChmRaster } from "./chm";
import {
  BERKELEY_TREE_ATTRIBUTION,
  fetchEastBayTrees,
  OAKLAND_TREE_ATTRIBUTION,
} from "./east-bay-trees";
import {
  type ElevationRaster,
  SF_CANOPY_BAND,
  SF_ELEVATION,
} from "./elevation";
import { type FerrySource, ingestFerries } from "./ferries";
import {
  boxOf,
  buildNameTable,
  type CrownedTree,
  densify,
  encodeCanopy,
  encodeNetwork,
  encodePolygons,
  encodeTrees,
  UNNAMED_ID,
} from "./geometry";
import { ingestHighways } from "./highways";
import { fetchBayAreaLand, fetchNycLand, type LandContext } from "./land";
import { buildLandTest } from "./land-filter";
import {
  ingestLandmarks,
  type LandmarkSource,
  NYC_LANDMARKS,
  SF_LANDMARKS,
} from "./landmarks";
import type { Bounds, SourceFile } from "./manifest";
import {
  fetchOsmTrees,
  fetchPaths,
  type OsmTree,
  type PathWay,
  type Polygon,
} from "./overpass";
import {
  fetchSfCanopyPolygons,
  fetchSfStreets,
  fetchSfTrees,
  SF_CANOPY_ATTRIBUTION,
} from "./sf";
import {
  ingestSidewalks,
  NYC_SURVEY,
  SF_SURVEY,
  type Survey,
} from "./sidewalks";
import {
  type Coord,
  DATA_SF,
  fetchNycTrees,
  NYC_OPEN_DATA,
  type Tree,
} from "./socrata";
import {
  FLAG_NON_VEHICULAR,
  FLAG_STRUCTURE,
  FLAG_VEHICULAR_ONLY,
  ROAD_TYPES,
  type RoadType,
  type Segment,
  toInt,
} from "./streets";
import {
  INGEST_PARAMS_PATH,
  PERCENTILES,
  SIDECAR_PATH,
  type TreeDataSidecar,
} from "./tree-data";

// One OSM pedestrian/park way, land-clipped and densified, ready to encode as a PATH record. The
// name is uppercased once here so the client's prettifier renders "BOW BRIDGE" as "Bow Bridge".
interface PathSegment {
  osmId: number; // record offset 0; guarded to fit a u32
  kind: number; // PATH_KIND_PATH or PATH_KIND_STEPS, record byte 20
  structure: boolean; // record byte 23 bit2: a bridge/tunnel deck or a non-zero layer
  name: string; // uppercased, "" when the way carries none
  nameId: number; // index into the PATH name table, UNNAMED_ID when unnamed
  points: Coord[]; // densified, so the field is sampled at least every DENSIFY_METERS
  lengthMeters: number;
}

interface StreetRow {
  the_geom?: { type: string; coordinates: [number, number][][] };
  physicalid?: string;
  rw_type?: string;
  streetwidth?: string;
  posted_speed?: string;
  nonped?: string; // 'V' vehicular-only, 'D' dedicated deck, else null
  trafdir?: string; // 'NV' non-vehicular (a ped/bike deck)
  stname_label?: string; // CSCL's normalized street name, e.g. "W 60 ST"
}

// One survey a region's crown heights are measured from: the rasters, the band of them that carries
// height (null where the file's only band is the height itself), the grid they are published on, and
// the credit the manifest records. `crs` is a name crates/tiler/src/heights.rs resolves to five
// projection numbers, so the two sides cannot disagree about where a cell sits on the ground.
interface HeightRaster {
  paths: string[];
  band: number | null;
  crs: "utm18n" | "utm10n" | "sf-cs13";
  attribution: string;
  sourceUrl: string;
}

// .build/ingest.json: everything `tiler ingest` is pointed at, all paths absolute.
interface IngestParams {
  canopy: string;
  land: string;
  streets: string;
  paths: string;
  // Empty for a city with no canopy height model; then no heights pass runs and every polygon keeps
  // the 0 that reads as unknown. Several where a region's halves were flown by different surveys
  // onto different grids. `band` is null for a single raster and the band index that carries height
  // above ground for a mosaic — several hundred paths ride in this file rather than on a command
  // line, which is why the mosaic needs no list on disk. The credits `HeightRaster` also carries are
  // the manifest's, not the tiler's, and the tiler rejects a field it was not told about.
  chm: { paths: string[]; band: number | null; crs: HeightRaster["crs"] }[];
  sourceBox: Bounds;
  landBox: Bounds;
  fillSigmaMeters: number;
  tightSigmaAlongMeters: number;
  tightSigmaAcrossMeters: number;
  sidewalkInsetMeters: number;
  coverSamples: number;
  coverSeed: number;
  percentiles: number[];
}

const ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(ROOT, "data");

const STREET_FORMAT = 6; // v6 adds the per-side sidewalk bits (flags bits 3-6) scripts/sidewalks.ts writes
const PATH_FORMAT = 1; // OSM pedestrian/park ways, STRT's byte layout with the PATH reinterpretations
const PATH_KIND_PATH = 6; // record byte 20: an ordinary path, sampled and offset like rw_type 6
const PATH_KIND_STEPS = 7; // record byte 20: a step street (highway=steps), like rw_type 7
const TREE_FORMAT = 3; // v3 adds a genus byte per tree; v2 added the crown byte, v1 was points only
const LAND_FORMAT = 1;
const CANOPY_FORMAT = 2; // the measured 2017 LiDAR canopy under magic CNPY; v2 adds a crown height per polygon

const TOP_GENUS_COUNT = 11; // the genera given their own id 0..10; the rest share id 11 ("Other")
const OTHER_GENUS_ID = TOP_GENUS_COUNT; // 11: tail genera, unknown genus, and every OSM tree
// The legend's common names, covering both cities' top genera; one not here falls back to its own
// name, so a shift in the ranks stays legible rather than blank. That fallback is meant to fire on
// the odd genus, not on most of a legend — with New York's list alone, eight of San Francisco's
// eleven read in Latin, and a default firing that often reads as a defect rather than a graceful
// degradation.
//
// San Francisco's names are its own register's, not mine: `qspecies` is "Lophostemon confertus ::
// Brisbane Box", so each genus takes the common name of its most planted species.
const GENUS_COMMON_NAMES: Record<string, string> = {
  // New York's ranks
  Quercus: "Oak",
  Acer: "Maple",
  Platanus: "London planetree",
  Gleditsia: "Honeylocust",
  Pyrus: "Pear",
  Tilia: "Linden",
  Prunus: "Cherry",
  Zelkova: "Zelkova",
  Fraxinus: "Ash",
  Ginkgo: "Ginkgo",
  Ulmus: "Elm",
  Styphnolobium: "Pagoda tree",
  // San Francisco's
  Lophostemon: "Brisbane box",
  Ficus: "Fig",
  Pittosporum: "Victorian box",
  Tristaniopsis: "Swamp myrtle",
  Magnolia: "Magnolia",
  Metrosideros: "New Zealand Christmas tree",
  Arbutus: "Strawberry tree",
  Acacia: "Acacia",
  Olea: "Olive",
  Maytenus: "Mayten",
  Corymbia: "Flowering gum",
  Eucalyptus: "Eucalyptus",
  // The East Bay's, which are a different planting palette again — Oakland and Berkeley lead on
  // street trees San Francisco barely plants. None of these is in the region's top eleven today;
  // they are here because several sit just outside it, and a genus crossing that line should change
  // the legend's order rather than its language.
  Liquidambar: "Sweetgum",
  Lagerstroemia: "Crape myrtle",
  Pistacia: "Chinese pistache",
  Sequoia: "Coast redwood",
  Cinnamomum: "Camphor",
  Robinia: "Black locust",
  Pinus: "Pine",
  Betula: "Birch",
};
// The isotropic blur the canopy field is rendered and reported through: closed woods stay dark,
// lawns stay blank, and a park edge feathers over ~2σ ≈ 30 m. The land cover distribution reads
// this kernel, so meanCoverOverLand is the map's own mean.
const FILL_SIGMA_METERS = 15;
// The oriented blur that colours the two sidewalks: broad along the road so the line runs smooth,
// tight across it so a one-sided street — a park-bounding avenue — keeps its dark park side and
// pale building side distinct rather than blurring to their mean.
const TIGHT_SIGMA_ALONG_METERS = 15;
const TIGHT_SIGMA_ACROSS_METERS = 4;
const SIDEWALK_INSET_METERS = 2; // curb to the centre of the sidewalk

// max(dbh) is 2427 in in New York and 9999 in San Francisco, both nonsense; a 60 in trunk is
// already a very large street tree, so anything past it is clamped there. Keeping a quadratic
// allometry on the arm it was fitted on is a separate job and belongs to the curve, not to this
// clamp — San Francisco's turns over at 40 in, well inside this one; `crownDiameterMeters` holds it
// at its vertex. dbh = 0 (missing) is given the city's own median rather than a zero crown.
const MAX_DBH_INCHES = 60;

// An OSM natural=tree point this close to a ForMS trunk is the same tree; ForMS wins the duplicate
// because it carries a dbh the crown is sized from, where OSM usually carries none.
const OSM_TREE_DEDUP_METERS = 5;
// The crown byte is a decimetre of radius, 0..255, so radius saturates at 25.5 m; a recorded
// diameter_crown/2 is clamped here so the count of clamps is honest rather than silent in the byte.
const CROWN_RADIUS_CEILING_METERS = 25.5;

const COVER_SAMPLES = 1_000_000;
const COVER_SEED = 42; // fixed, so the reported mean cover does not churn between runs

const DENSIFY_METERS = 25; // road sampling step, below the tight sigma so the colour varies
const DROP_LENGTH_METERS = 1; // shorter than this the geometry is degenerate
const EARTH_RADIUS_METERS = 6_371_008.8;

// The walkable-row total the paged fetch is checked against — a floor, so it sits a little below
// the current Socrata count (111,675 rows for the $where below: 99,361 street + 2,205 bridge +
// 7 tunnel + 101 boardwalk + 5,918 path + 248 step + 3,835 alley) rather than tracking it exactly.
const NYC_SEGMENT_COUNT = 111_000;

// The crown radius the allometry predicts for one trunk, in metres. dbh is capped and a missing
// dbh imputed *before* this, so the log-log curve is only ever asked about a plausible trunk.
function crownRadiusMeters(
  allometry: CrownAllometry,
  dbhInches: number,
): number {
  return crownDiameterMeters(allometry, dbhInches) / 2;
}

// Sizes every tree's crown from its dbh, clamping the nonsense outliers and imputing the median
// for the trees that carry no dbh — reporting how many of each so the model's inputs are not
// silent. The crown then rides with the point through the encoder.
function crownTrees(
  trees: readonly Tree[],
  genusId: ReadonlyMap<string, number>,
  allometry: CrownAllometry,
  medianDbhInches: number,
): {
  crowned: CrownedTree[];
  clamped: number;
  imputed: number;
} {
  let clamped = 0;
  let imputed = 0;
  const crowned = trees.map(({ lat, lng, dbhInches, genus }) => {
    let dbh = dbhInches;
    if (dbh <= 0) {
      dbh = medianDbhInches;
      imputed += 1;
    } else if (dbh > MAX_DBH_INCHES) {
      dbh = MAX_DBH_INCHES;
      clamped += 1;
    }
    return {
      lat,
      lng,
      crownRadiusM: crownRadiusMeters(allometry, dbh),
      genusId: genusId.get(genus) ?? OTHER_GENUS_ID,
    };
  });
  return { crowned, clamped, imputed };
}

function haversineMeters(from: Coord, to: Coord): number {
  const fromLat = from.lat * (Math.PI / 180);
  const toLat = to.lat * (Math.PI / 180);
  const deltaLat = toLat - fromLat;
  const deltaLng = (to.lng - from.lng) * (Math.PI / 180);
  const chord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

const METERS_PER_DEGREE_LAT = (EARTH_RADIUS_METERS * Math.PI) / 180;

interface OsmCrowns {
  crowned: CrownedTree[]; // the survivors, sized and ready to append to the ForMS crowns
  onLandCount: number; // OSM trees inside a borough polygon
  deduped: number; // OSM trees dropped as within OSM_TREE_DEDUP_METERS of a ForMS trunk
  imputedCrowns: number; // survivors with no diameter_crown, given the imputed-median crown
}

// Supplements the ForMS census with the OSM natural=tree points: clips them to land, drops any
// within OSM_TREE_DEDUP_METERS of a ForMS trunk (ForMS carries dbh, so it wins the duplicate), and
// sizes each survivor's crown — from a recorded diameter_crown when present (clamped to the byte
// ceiling), else the imputed-median crown, exactly as a ForMS tree with no dbh. The ForMS trunks
// are bucketed into a grid whose cell spans the dedup radius in each axis, so a 3x3 sweep around an
// OSM tree sees every trunk that could be within it. Reports the counts the ingest logs.
function crownOsmTrees(
  osmTrees: readonly OsmTree[],
  forms: readonly Coord[],
  onLand: (coord: Coord) => boolean,
  centerLat: number,
  allometry: CrownAllometry,
  medianDbhInches: number,
): OsmCrowns {
  const cellLat = OSM_TREE_DEDUP_METERS / METERS_PER_DEGREE_LAT;
  const cellLng =
    OSM_TREE_DEDUP_METERS /
    (METERS_PER_DEGREE_LAT * Math.cos(centerLat * (Math.PI / 180)));
  const cellOf = (lat: number, lng: number): [number, number] => [
    Math.floor(lat / cellLat),
    Math.floor(lng / cellLng),
  ];
  const buckets = new Map<string, Coord[]>();
  for (const trunk of forms) {
    const [cellY, cellX] = cellOf(trunk.lat, trunk.lng);
    const key = `${cellY},${cellX}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(trunk);
    } else {
      buckets.set(key, [trunk]);
    }
  }

  const imputedCrownRadiusM = crownRadiusMeters(allometry, medianDbhInches);
  const crowned: CrownedTree[] = [];
  let onLandCount = 0;
  let deduped = 0;
  let imputedCrowns = 0;
  for (const tree of osmTrees) {
    if (!onLand(tree)) {
      continue;
    }
    onLandCount += 1;
    const [cellY, cellX] = cellOf(tree.lat, tree.lng);
    let duplicate = false;
    for (let dy = -1; dy <= 1 && !duplicate; dy++) {
      for (let dx = -1; dx <= 1 && !duplicate; dx++) {
        for (const trunk of buckets.get(`${cellY + dy},${cellX + dx}`) ?? []) {
          if (haversineMeters(tree, trunk) <= OSM_TREE_DEDUP_METERS) {
            duplicate = true;
            break;
          }
        }
      }
    }
    if (duplicate) {
      deduped += 1;
      continue;
    }
    let crownRadiusM: number;
    if (tree.crownDiameterMeters !== undefined) {
      crownRadiusM = Math.min(
        CROWN_RADIUS_CEILING_METERS,
        tree.crownDiameterMeters / 2,
      );
    } else {
      crownRadiusM = imputedCrownRadiusM;
      imputedCrowns += 1;
    }
    crowned.push({
      lat: tree.lat,
      lng: tree.lng,
      crownRadiusM,
      genusId: OTHER_GENUS_ID, // OSM trees carry no genus; they all fall to Other
    });
  }
  return { crowned, onLandCount, deduped, imputedCrowns };
}

// A CSCL row is a MultiLineString, virtually always with a single part; a row with
// several parts becomes several records sharing one physicalid.
function toSegments(rows: StreetRow[]): Segment[] {
  const segments: Segment[] = [];
  let degenerate = 0;
  for (const row of rows) {
    const roadType = toInt(row.rw_type) as RoadType;
    if (!row.the_geom || !ROAD_TYPES.includes(roadType)) {
      continue;
    }
    let flags = 0;
    if (row.nonped === "V") {
      flags |= FLAG_VEHICULAR_ONLY;
    }
    if (row.trafdir === "NV") {
      flags |= FLAG_NON_VEHICULAR;
    }
    if (roadType === 3 || roadType === 4) {
      flags |= FLAG_STRUCTURE;
    }
    const name = (row.stname_label ?? "").trim();
    for (const part of row.the_geom.coordinates) {
      const points: Coord[] = [];
      for (const [lng, lat] of part) {
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
      segments.push({
        physicalId: toInt(row.physicalid),
        roadType,
        streetWidth: Math.min(255, toInt(row.streetwidth)),
        postedSpeed: Math.min(255, toInt(row.posted_speed)),
        flags,
        name,
        nameId: UNNAMED_ID, // assigned once the whole distinct set is known, in buildNameTable
        points: dense.points,
        lengthMeters: dense.lengthMeters,
      });
    }
  }
  if (degenerate > 0) {
    console.error(`  dropped ${degenerate} degenerate segments`);
  }
  return segments;
}

async function fetchNycStreets(): Promise<Segment[]> {
  // `*` so a newly-read column is free after one refetch: the disk cache keys on the query, so
  // narrowing $select would force a full re-page whenever a new column is wanted. StreetRow names
  // only the columns toSegments reads.
  const rows = await NYC_OPEN_DATA.dataset<StreetRow>(
    "inkn-q76z",
    {
      $select: "*",
      $where:
        "rw_type in ('1','5','6','7','10') OR (rw_type in ('3','4') AND (nonped IS NULL OR nonped != 'V'))",
    },
    NYC_SEGMENT_COUNT,
  );
  return toSegments(rows);
}

const U32_MAX = 0xffffffff; // record offset 0 is a u32; an OSM id past this cannot be stored

// Land-clips, densifies and uppercases the OSM ways. A way is kept if its midpoint or either
// endpoint is on land — enough to drop the New Jersey and Westchester spill the city bounding box
// reaches, without clipping a way that only grazes the shoreline. Reports the counts the ingest
// logs (fetched / on land / encoded).
function toPathSegments(
  ways: PathWay[],
  onLand: (coord: Coord) => boolean,
): { segments: PathSegment[]; onLandCount: number } {
  const segments: PathSegment[] = [];
  let onLandCount = 0;
  let overflow = 0;
  let degenerate = 0;
  for (const way of ways) {
    const midpoint = way.points[Math.floor(way.points.length / 2)];
    const first = way.points[0];
    const last = way.points[way.points.length - 1];
    if (!onLand(midpoint) && !onLand(first) && !onLand(last)) {
      continue;
    }
    onLandCount += 1;
    if (way.id > U32_MAX) {
      overflow += 1;
      continue;
    }
    const dense = densify(way.points, DENSIFY_METERS);
    if (dense.lengthMeters < DROP_LENGTH_METERS) {
      degenerate += 1;
      continue;
    }
    segments.push({
      osmId: way.id,
      kind: way.steps ? PATH_KIND_STEPS : PATH_KIND_PATH,
      structure: way.structure,
      name: (way.name ?? "").trim().toUpperCase(),
      nameId: UNNAMED_ID,
      points: dense.points,
      lengthMeters: dense.lengthMeters,
    });
  }
  if (overflow > 0) {
    console.error(`  dropped ${overflow} paths whose OSM id exceeds u32`);
  }
  if (degenerate > 0) {
    console.error(`  dropped ${degenerate} degenerate paths`);
  }
  return { segments, onLandCount };
}

// Land-clips the measured canopy CROWNS the same ring-midpoint way the paths and OSM trees are
// clipped: a polygon is kept if the midpoint vertex of its outer ring is on land. The ArcGIS
// service is NYC Parks' own LiDAR and carries essentially no New Jersey / Westchester spill, but
// the clip is applied for parity with the other polygon sources and to guard a future re-extent.
//
// One vertex decides the whole polygon, which is the whole answer for a crown — a few metres across,
// and the coastline either holds it or does not. It is no answer at all for a polygon the mask runs
// through the middle of, so a source with those cuts its own and arrives as `landCut`.
function clipCanopyToLand(
  polygons: Polygon[],
  onLand: (coord: Coord) => boolean,
): Polygon[] {
  const kept: Polygon[] = [];
  for (const polygon of polygons) {
    const outer = polygon[0];
    const midpoint = outer[Math.floor(outer.length / 2)];
    if (onLand(midpoint)) {
      kept.push(polygon);
    }
  }
  return kept;
}

// The area of one ring in square metres, in a local equirectangular metre space about `refLat`
// (the shoelace, signed by the ring's winding). Esri gives outer rings and their holes opposite
// windings, so summing the signed ring areas of a polygon and taking the magnitude nets the holes
// out. Good to a fraction of a percent over a single crown-sized polygon, which is all a coverage
// sanity figure needs.
function ringSignedAreaSquareMeters(ring: Coord[], refLat: number): number {
  const metersPerLng =
    METERS_PER_DEGREE_LAT * Math.cos(refLat * (Math.PI / 180));
  let twiceArea = 0;
  for (
    let point = 0, previous = ring.length - 1;
    point < ring.length;
    point++
  ) {
    const currentX = ring[point].lng * metersPerLng;
    const currentY = ring[point].lat * METERS_PER_DEGREE_LAT;
    const previousX = ring[previous].lng * metersPerLng;
    const previousY = ring[previous].lat * METERS_PER_DEGREE_LAT;
    twiceArea += previousX * currentY - currentX * previousY;
    previous = point;
  }
  return twiceArea / 2;
}

function canopySquareKm(polygons: Polygon[], refLat: number): number {
  let squareMeters = 0;
  for (const polygon of polygons) {
    let net = 0;
    for (const ring of polygon) {
      net += ringSignedAreaSquareMeters(ring, refLat);
    }
    squareMeters += Math.abs(net);
  }
  return squareMeters / 1e6;
}

// The raw extent of the sources. The tiler grows it by the kernel's reach — it owns the
// truncation radius — and hands back the bounds the pyramid is planned over.
// The path vertices are deliberately NOT swallowed here: the box is grown by the fill kernel's
// 3σ reach (reach_bounds), ~45 m, and every land-clipped path vertex sits within that margin of
// the street/canopy extent — so the canopy field already covers them, and the street projection,
// tiles and graph stay byte-identical to the streets-only build. Widening the box to the paths
// would shift the projection reference and perturb every street cover byte for no gain.
function sourceBoxOf(segments: Segment[], trees: Coord[]): Bounds {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  const swallow = ({ lat, lng }: Coord): void => {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  };
  for (const segment of segments) {
    for (const point of segment.points) {
      swallow(point);
    }
  }
  for (const tree of trees) {
    swallow(tree);
  }
  return { south, west, north, east };
}

// STRT v6: the CSCL street network. The record id is the physicalid; kind is rw_type; the
// width/speed/flags bytes are all populated, the flags' per-side sidewalk bits by ingestSidewalks.
function encodeStreets(segments: Segment[], names: string[]): Uint8Array {
  return encodeNetwork(
    "STRT",
    STREET_FORMAT,
    segments.map((segment) => ({
      id: segment.physicalId,
      nameId: segment.nameId,
      lengthMeters: segment.lengthMeters,
      kind: segment.roadType,
      width: segment.streetWidth,
      speed: segment.postedSpeed,
      flags: segment.flags,
      points: segment.points,
    })),
    names,
  );
}

// PATH v1: the OSM pedestrian/park network. The record id is the OSM way id; kind is 6 (path) or
// 7 (steps); a path has no roadway, so width and speed are 0 and byte 23 carries only the
// structure flag. layout: scripts/README.md
function encodePaths(segments: PathSegment[], names: string[]): Uint8Array {
  return encodeNetwork(
    "PATH",
    PATH_FORMAT,
    segments.map((segment) => ({
      id: segment.osmId,
      nameId: segment.nameId,
      lengthMeters: segment.lengthMeters,
      kind: segment.kind,
      width: 0,
      speed: 0,
      flags: segment.structure ? FLAG_STRUCTURE : 0,
      points: segment.points,
    })),
    names,
  );
}

async function writeSource(
  directory: string,
  file: string,
  format: number,
  count: number,
  bytes: Uint8Array,
): Promise<SourceFile> {
  const path = join(DATA_DIR, directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, file), bytes);
  return {
    file,
    format,
    count,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// One city's sources, so the fetch below reads a city rather than being one. Everything that
// differs between two cities is either a fetcher here or a credit line; the estimator, the
// encoders, the crowning and the tiler are all city-agnostic already.
interface CitySources {
  id: string;
  name: string;
  attribution: string;
  sourceUrl: string;
  streetAttribution: string;
  streetSourceUrl: string;
  fieldAttribution: string;
  fieldSourceUrl: string;
  pathAttribution: string;
  pathSourceUrl: string;
  canopyAttribution: string;
  canopySourceUrl: string;
  // The polygons the whole ingest is clipped to, and whose box every Overpass query is cut from.
  land: () => Promise<Polygon[]>;
  // Handed the finished land context because a city may read a centreline that is not its own: the
  // Bay Area's East Bay half comes from a COUNTY layer covering three times the city, and only the
  // land test decides which of its rows are in. San Francisco's and New York's ignore it.
  streets: (land: LandContext) => Promise<Segment[]>;
  trees: () => Promise<Tree[]>;
  canopy: () => Promise<{
    // Crowns, to be kept or dropped whole against the land here.
    polygons: Polygon[];
    // Polygons the source has already cut on the land itself, which are taken as they stand. A
    // source whose polygons are bigger than the coastline's own detail has to do its own clipping,
    // because `clipCanopyToLand` decides a whole polygon on one vertex of it: the East Bay's canopy
    // is traced in 256 m blocks and the mask runs through the middle of the boundary ones
    // (scripts/alcc.ts). Empty for a city whose canopy is crowns.
    landCut: Polygon[];
    fetched: number;
    dropped: number;
  }>;
  // Where crown heights are measured. Empty for a city with none — then every polygon keeps the 0
  // that reads as an unknown height, and the tree-shade pyramid is simply not produced; several
  // where a region spans two surveys, and each polygon keeps the reading of whichever one covered
  // it. A survey states either one raster or a mosaic of them with the band that carries height
  // above ground; that band may measure buildings too, which is safe only because the polygons it is
  // read through are measured canopy.
  chm: () => Promise<HeightRaster[]>;
  // The city's ferry network, consolidated from its GTFS feeds, or null where it has none — a
  // fetcher rather than a flag, because a third city's feeds are its own and a boolean can only ever
  // mean "the ones scripts/ferries.ts already hardcodes".
  ferries: (() => Promise<FerrySource>) | null;
  // Whether its centreline classifies a service way with no pavement. New York's does; San
  // Francisco's "alleys" are narrow streets with sidewalks, which is a different thing.
  alleys: boolean;
  // The city's own registers, or null where it has none. Null is a decision the descriptor states,
  // where a missing entry in a per-module lookup was a decision nobody made: a city absent from
  // buildings' map got no footprints, so no building shade at all, and the build said nothing.
  landmarks: LandmarkSource | null;
  art: ArtSource | null;
  buildings: BuildingSource | null;
  // Which side of a street the city's own survey says carries pavement. Not optional: the existence
  // gate needs an authoritative answer, because OSM's silence is ambiguous between a mapping gap and
  // genuinely bare kerb.
  survey: () => Promise<Survey>;
  // The DEM the terrain overlay and the relief byte are read off, or null for a flat model.
  elevation: (() => Promise<ElevationRaster>) | null;
  // The crown curve fitted nearest this city, and the trunk to stand in for a row that carries none.
  // Both are per city because both are measured FROM a city: the curve from its climate region's
  // reference town, the median from its own register.
  crownAllometry: CrownAllometry;
  medianDbhInches: number;
}

const NYC: CitySources = {
  id: "nyc",
  name: "New York City",
  attribution: "NYC Parks Forestry (ForMS) via NYC Open Data",
  sourceUrl: NYC_OPEN_DATA.page("hn5i-inap"),
  streetAttribution: "NYC DoITT Street Centerline (CSCL) via NYC Open Data",
  streetSourceUrl: NYC_OPEN_DATA.page("inkn-q76z"),
  // The field's ODbL credit: it mixes OSM natural=tree points (which the genus overlay draws) and
  // the OSM path network the canopy field is sampled along. ForMS is credited on the city.
  fieldAttribution: "path & tree data © OpenStreetMap contributors",
  fieldSourceUrl: "https://www.openstreetmap.org/copyright",
  pathAttribution: "OpenStreetMap contributors",
  pathSourceUrl: "https://www.openstreetmap.org/copyright",
  // The measured 2017 LiDAR canopy: NYC-public (no ODbL entanglement), NYC Parks' own polygons.
  canopyAttribution: "Tree canopy © NYC OTI / NYC Parks (2017 LiDAR)",
  canopySourceUrl:
    "https://services3.arcgis.com/xJHn8F2NTtwCMFtX/arcgis/rest/services/TreeCanopy2017_Simplified_1ft/FeatureServer/0",
  land: fetchNycLand,
  streets: fetchNycStreets,
  trees: fetchNycTrees,
  // Every one of these polygons is a crown, so none arrives pre-cut and the land clip below decides
  // all of them.
  canopy: async () => ({ ...(await fetchCanopyPolygons()), landCut: [] }),
  chm: async () => [
    {
      paths: [await fetchChmRaster()],
      band: null,
      crs: "utm18n",
      attribution: CHM_ATTRIBUTION,
      sourceUrl: CHM_SOURCE_URL,
    },
  ],
  ferries: () => ingestFerries("nyc"),
  alleys: true,
  landmarks: NYC_LANDMARKS,
  art: NYC_ART,
  buildings: NYC_BUILDINGS,
  survey: NYC_SURVEY,
  elevation: null,
  crownAllometry: NOEAST_LONDON_PLANE,
  medianDbhInches: 9, // the ForMS median over standing trees
};

// San Francisco and the East Bay under one id. The id stays `sf` — it names every artifact on disk,
// every service-worker cache key and every link anyone has already shared — while the NAME is the
// region, because the region is what this is growing into and the two halves it holds today are
// where it starts rather than what it is.
const SF: CitySources = {
  id: "sf",
  name: "Bay Area",
  // Three registers, one per city that keeps one. The five East Bay cities that publish none thin
  // out the genus overlay and nothing else: cover and shade come from the canopy polygons.
  attribution: `SF Public Works street trees via DataSF; ${OAKLAND_TREE_ATTRIBUTION}; ${BERKELEY_TREE_ATTRIBUTION}`,
  sourceUrl: DATA_SF.page("tkzw-k3nq"),
  // Two centrelines, one per half of the region. The manifest schema has one source URL, so it
  // stays San Francisco's.
  streetAttribution: `SF basemap street centrelines via DataSF; ${EAST_BAY_STREET_ATTRIBUTION}`,
  streetSourceUrl: DATA_SF.page("3psu-pn9h"),
  fieldAttribution: "path & tree data © OpenStreetMap contributors",
  fieldSourceUrl: "https://www.openstreetmap.org/copyright",
  pathAttribution: "OpenStreetMap contributors",
  pathSourceUrl: "https://www.openstreetmap.org/copyright",
  // Two canopy measurements of different kinds: San Francisco's 2013 imagery has no height floor and
  // the East Bay's 2019-21 lidar is cut at 15 feet, so a young street tree counts as canopy on one
  // side of the bay and not on the other.
  canopyAttribution: `${SF_CANOPY_ATTRIBUTION}; ${ALCC_ATTRIBUTION}`,
  canopySourceUrl: DATA_SF.page("ni2e-vpbg"),
  land: fetchBayAreaLand,
  // Their durable ids cannot collide — DataSF's `cnn` runs in the low millions and the county's
  // `SEGID` starts at 181,000,001 — which is what lets one STRT file hold both halves.
  streets: async (land) => [
    ...(await fetchSfStreets()),
    ...(await fetchEastBayStreets(land)),
  ],
  trees: async () => [
    ...(await fetchSfTrees()),
    ...(await fetchEastBayTrees()),
  ],
  // Apart only because the East Bay's are traced blocks already cut on the land and the city's are
  // crowns that are not; past the clip nothing downstream reads which half a polygon came from.
  canopy: async () => {
    const city = await fetchSfCanopyPolygons();
    const eastBay = await eastBayCanopy();
    return {
      polygons: city.polygons,
      landCut: eastBay.polygons,
      fetched: city.fetched + eastBay.fetched,
      dropped: city.dropped + eastBay.dropped,
    };
  },
  // San Francisco's is the terrain overlay's own 3DEP tiles at the band that differences the surface
  // against the ground — height above ground for everything standing, downtown towers included — so
  // it is only ever sampled through the measured-canopy polygons. The East Bay's is a purpose-built
  // lidar canopy model with every building and water body already zeroed, cut from the same raster
  // scripts/alcc.ts traced its cover from.
  chm: async () => {
    const raster = await SF_ELEVATION();
    const eastBay = await eastBayCanopy();
    return [
      {
        paths: raster.paths,
        band: SF_CANOPY_BAND,
        crs: "sf-cs13",
        attribution: raster.attribution,
        sourceUrl: raster.sourceUrl,
      },
      {
        paths: eastBay.heightTiles,
        band: 0,
        crs: "utm10n",
        attribution: ALCC_HEIGHT_ATTRIBUTION,
        sourceUrl: ALCC_SOURCE_URL,
      },
    ];
  },
  // The ferry is not one scenic option among several here: it is the only way across the bay on
  // foot, so the two halves of this city are one connected walking network only because of it.
  ferries: () => ingestFerries("sf"),
  alleys: false,
  landmarks: SF_LANDMARKS,
  art: SF_ART,
  buildings: SF_BUILDINGS,
  survey: SF_SURVEY,
  elevation: SF_ELEVATION,
  crownAllometry: NOCALC_LONDON_PLANE,
  // San Francisco's own 7 in unchanged: Oakland's 68,281 rows at a median of 8 and Berkeley's
  // 34,767 at 6.5 move the combined median by less than the inch it is recorded in.
  medianDbhInches: 7,
};

const CITIES: Record<string, CitySources> = { nyc: NYC, sf: SF };

async function fetchCity(CITY: CitySources): Promise<void> {
  const started = performance.now();

  // The ferry network is OSM- and canopy-independent: it is consolidated from the two NYC ferry
  // GTFS feeds into data/ferries/<id>.bin (magic FERR), a committed build input a later phase reads
  // into the routing graph. It does not enter the tree-cover manifest, so it is produced up front,
  // apart from the cover pipeline below.
  if (CITY.ferries) {
    const ferries = await CITY.ferries();
    console.error(
      `${CITY.id}: ferries ${ferries.stops} stops, ${ferries.segments} segments (${ferries.bytes} bytes)`,
    );
  }

  console.error(`${CITY.id}: fetching the land polygons`);
  const land = await CITY.land();
  const landBox = boxOf(land);

  // The land test is built once from the borough polygons and reused: the paths ask it up to
  // three times each, the OSM trees once each, and the canopy polygons once each.
  const onLand = buildLandTest(land);

  // The scenic-factor sources: landmarks and public art (POI points, discounts) and the highway /
  // elevated-rail lines (a proximity penalty). Each is a committed build input a later phase reads
  // into the routing graph — none enters the tree-cover manifest, so they are produced here, apart
  // from the cover pipeline, exactly as the ferries are.
  const landContext: LandContext = { onLand, box: landBox };
  const landmarks = await ingestLandmarks(CITY.id, CITY.landmarks, landContext);
  const art = await ingestArt(CITY.id, CITY.art, landContext);
  const highways = await ingestHighways(CITY.id, landContext);
  console.error(
    `${CITY.id}: landmarks ${landmarks.count}, art ${art.count}, highways ${highways.count} lines`,
  );

  // The measured 2017 LiDAR canopy: NYC Parks' polygon feature service, ~1M polygons paged and
  // disk-cached, then land-clipped. It is the cover source — `tiler build` rasterizes it for the
  // fill pyramid and `tiler ingest` samples it at every sidewalk for the routing density.
  console.error(`${CITY.id}: fetching tree canopy polygons`);
  const canopy = await CITY.canopy();
  const canopyOnLand = [
    ...clipCanopyToLand(canopy.polygons, onLand),
    ...canopy.landCut,
  ];
  const canopyReferenceLat = (landBox.south + landBox.north) / 2;
  const canopySquareKilometers = canopySquareKm(
    canopyOnLand,
    canopyReferenceLat,
  );
  let canopyVertices = 0;
  for (const polygon of canopyOnLand) {
    for (const ring of polygon) {
      canopyVertices += ring.length;
    }
  }
  console.error(
    `${CITY.id}: canopy ${canopy.fetched} polygons fetched, ${canopyOnLand.length} on land, ${canopyVertices} vertices, ${canopySquareKilometers.toFixed(1)} km² (${canopy.dropped} dropped as degenerate or too small)`,
  );

  // The LiDAR canopy height models each polygon's crown height is measured from, read off disk by
  // the ingest's heights pass and never committed.
  console.error(`${CITY.id}: fetching the canopy height model`);
  const chm = await CITY.chm();
  for (const raster of chm) {
    console.error(
      `${CITY.id}: heights from ${raster.paths.length} ${raster.crs} raster${raster.paths.length === 1 ? "" : "s"}`,
    );
  }

  // Paths are the other Overpass query, so they are fetched next while a mirror is warm — and
  // land-clipped here, against the borough polygons, to drop the New Jersey and Westchester
  // spill the city bounding box reaches.
  console.error(`${CITY.id}: fetching pedestrian and park paths`);
  const pathWays = await fetchPaths(
    landBox.south,
    landBox.west,
    landBox.north,
    landBox.east,
  );
  const { segments: pathSegments, onLandCount } = toPathSegments(
    pathWays,
    onLand,
  );
  const pathNames = buildNameTable(pathSegments);
  let pathVertices = 0;
  let pathKm = 0;
  for (const path of pathSegments) {
    pathVertices += path.points.length;
    pathKm += path.lengthMeters;
  }
  pathKm /= 1000;
  console.error(
    `${CITY.id}: paths ${pathWays.length} fetched, ${onLandCount} on land, ${pathSegments.length} encoded (${pathKm.toFixed(1)} km, ${pathNames.length} distinct names)`,
  );

  // The third Overpass query, fetched while a mirror is still warm: the natural=tree points that
  // supplement the ForMS census. They are deduped and crowned below, once the ForMS trunks the
  // dedup needs are in hand.
  console.error(`${CITY.id}: fetching OSM trees`);
  const osmTreesRaw = await fetchOsmTrees(
    landBox.south,
    landBox.west,
    landBox.north,
    landBox.east,
  );

  console.error(`${CITY.id}: fetching street segments`);
  const segments = await CITY.streets(landContext);
  const names = buildNameTable(segments);
  const unnamed = segments.filter(
    (segment) => segment.nameId === UNNAMED_ID,
  ).length;
  console.error(
    `${CITY.id}: ${names.length} distinct street names, ${unnamed} unnamed segments`,
  );
  console.error(`${CITY.id}: fetching trees`);
  const allTrees = await CITY.trees();
  // Land-clipped, because a register's coordinates are only as good as its geocoder: 55 of San
  // Francisco's street trees carry a placeholder at 47.27 N, 138.28 W — a real tree on Octavia
  // Street, filed in the north Pacific. Nothing downstream would notice a tree in the wrong place,
  // but the city's BOUNDS are taken over these points, and they set the Overpass boxes and the whole
  // tile plan. So the check belongs here, where the land test already is.
  const trees = allTrees.filter((tree) => onLand(tree));
  if (trees.length !== allTrees.length) {
    console.error(
      `${CITY.id}: dropped ${allTrees.length - trees.length} trees off the city's land`,
    );
  }

  // The genus legend: tally the ForMS genera, take the 11 most abundant, and give each an id 0..10
  // in descending-count order. Everything else — tail genera, unknown genus, and every OSM tree —
  // maps to id 11 ("Other"). The map is threaded into crownTrees so each tree gets its genus byte.
  const genusCounts = new Map<string, number>();
  for (const tree of trees) {
    if (tree.genus !== "") {
      genusCounts.set(tree.genus, (genusCounts.get(tree.genus) ?? 0) + 1);
    }
  }
  const topGenera = [...genusCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, TOP_GENUS_COUNT);
  const genusId = new Map(topGenera.map(([genus], index) => [genus, index]));
  const genusTable = topGenera.map(([genus, count]) => ({
    genus,
    common: GENUS_COMMON_NAMES[genus] ?? genus,
    count,
  }));
  const topGenusTotal = topGenera.reduce((sum, [, count]) => sum + count, 0);

  const { crowned, clamped, imputed } = crownTrees(
    trees,
    genusId,
    CITY.crownAllometry,
    CITY.medianDbhInches,
  );
  console.error(
    `${CITY.id}: sized ${crowned.length} crowns (clamped ${clamped} trunks past ${MAX_DBH_INCHES} in, imputed ${imputed} missing dbh at ${CITY.medianDbhInches} in)`,
  );
  console.error(
    `${CITY.id}: top ${genusTable.length} genera ${genusTable.map((entry) => `${entry.genus}:${entry.count}`).join(", ")}`,
  );

  // Supplement the ForMS census with the OSM trees: land-clipped, deduped against ForMS, crowned,
  // and appended to the crowned list before encoding, so TREE v2 is unchanged — just more points,
  // still sorted by quantized (lat, lng) inside encodeTrees.
  const osm = crownOsmTrees(
    osmTreesRaw,
    trees,
    onLand,
    (landBox.south + landBox.north) / 2,
    CITY.crownAllometry,
    CITY.medianDbhInches,
  );
  console.error(
    `${CITY.id}: OSM trees ${osmTreesRaw.length} fetched, ${osm.onLandCount} on land, ${osm.deduped} deduped against ForMS, ${osm.crowned.length} kept (${osm.imputedCrowns} imputed crown)`,
  );
  const allCrowned = [...crowned, ...osm.crowned];

  const file = `${CITY.id}.bin`;
  const treeFile = await writeSource(
    "trees",
    file,
    TREE_FORMAT,
    allCrowned.length,
    encodeTrees(TREE_FORMAT, allCrowned),
  );
  const landFile = await writeSource(
    "land",
    file,
    LAND_FORMAT,
    land.length,
    encodePolygons("LAND", LAND_FORMAT, land),
  );
  // The canopy is a polygon blob under its own magic (CNPY) so it self-identifies rather than
  // masquerading as another polygon source; the tiler reads it with the same generic decoder. Its
  // height region is written zeroed for `tiler ingest` to fill in place, so the file on disk will no
  // longer be the one encoded here — the manifest half reads its bytes back off disk.
  const canopyPath = join(DATA_DIR, "canopy", file);
  const canopyFile = await writeSource(
    "canopy",
    file,
    CANOPY_FORMAT,
    canopyOnLand.length,
    encodeCanopy(CANOPY_FORMAT, canopyOnLand),
  );

  // OSM's own sidewalk/crossing/island ways, written as their own committed source, and the
  // planimetric ROW-sidewalk polygons, which are only probed. Between them they settle the four
  // per-side bits of every offsetted STRT record's flags byte, so this runs before the streets are
  // encoded.
  console.error(`${CITY.id}: fetching sidewalks`);
  const sidewalks = await ingestSidewalks(
    CITY.id,
    segments,
    landContext,
    CITY.survey,
  );

  const streetPath = join(DATA_DIR, "streets", file);
  await mkdir(join(DATA_DIR, "streets"), { recursive: true });
  await writeFile(streetPath, encodeStreets(segments, names));

  const pathPath = join(DATA_DIR, "paths", file);
  await mkdir(join(DATA_DIR, "paths"), { recursive: true });
  await writeFile(pathPath, encodePaths(pathSegments, pathNames));

  let vertices = 0;
  for (const segment of segments) {
    vertices += segment.points.length;
  }

  // The density estimator reads the measured canopy, blurred: the isotropic fill kernel for the
  // reported land distribution, the oriented along/across kernel at each sidewalk offset. The trees
  // are still fetched and encoded above (the genus overlay draws them), but the street/path density
  // blobs no longer consume them.
  const params: IngestParams = {
    canopy: canopyPath,
    land: join(DATA_DIR, "land", file),
    streets: streetPath,
    paths: pathPath,
    chm: chm.map(({ paths, band, crs }) => ({ paths, band, crs })),
    sourceBox: sourceBoxOf(segments, trees),
    landBox,
    fillSigmaMeters: FILL_SIGMA_METERS,
    tightSigmaAlongMeters: TIGHT_SIGMA_ALONG_METERS,
    tightSigmaAcrossMeters: TIGHT_SIGMA_ACROSS_METERS,
    sidewalkInsetMeters: SIDEWALK_INSET_METERS,
    coverSamples: COVER_SAMPLES,
    coverSeed: COVER_SEED,
    percentiles: PERCENTILES.map((percentile) => Number(percentile.slice(1))),
  };
  const sidecar: TreeDataSidecar = {
    city: {
      id: CITY.id,
      name: CITY.name,
      attribution: CITY.attribution,
      sourceUrl: CITY.sourceUrl,
      streetAttribution: CITY.streetAttribution,
      streetSourceUrl: CITY.streetSourceUrl,
      fieldAttribution: CITY.fieldAttribution,
      fieldSourceUrl: CITY.fieldSourceUrl,
      pathAttribution: CITY.pathAttribution,
      pathSourceUrl: CITY.pathSourceUrl,
      canopyAttribution: CITY.canopyAttribution,
      canopySourceUrl: CITY.canopySourceUrl,
      alleys: CITY.alleys,
    },
    // Every survey's credit, joined the way the two centrelines' is; the source URL is one field in
    // the manifest schema and names the first, with the rest in scripts/README.md.
    heightSource:
      chm.length > 0
        ? {
            attribution: chm.map((raster) => raster.attribution).join("; "),
            sourceUrl: chm[0].sourceUrl,
          }
        : null,
    trees: treeFile,
    land: landFile,
    canopy: {
      file: canopyFile.file,
      format: canopyFile.format,
      polygons: canopyFile.count,
      vertices: canopyVertices,
      squareKm: Math.round(canopySquareKilometers * 10) / 10,
    },
    streets: {
      file,
      format: STREET_FORMAT,
      segments: segments.length,
      vertices,
      densifyMeters: DENSIFY_METERS,
    },
    paths: {
      file,
      format: PATH_FORMAT,
      ways: pathSegments.length,
      vertices: pathVertices,
      km: Math.round(pathKm * 10) / 10,
    },
    field: {
      fillSigmaMeters: FILL_SIGMA_METERS,
      tightSigmaAlongMeters: TIGHT_SIGMA_ALONG_METERS,
      tightSigmaAcrossMeters: TIGHT_SIGMA_ACROSS_METERS,
      sidewalkInsetMeters: SIDEWALK_INSET_METERS,
      crownAllometry: CITY.crownAllometry,
      maxDbhInches: MAX_DBH_INCHES,
      imputedDbhInches: CITY.medianDbhInches,
      clampedTrees: clamped,
      imputedTrees: imputed,
      osmTrees: osm.crowned.length,
      osmTreeDedup: osm.deduped,
      osmImputedCrowns: osm.imputedCrowns,
      coverSamples: COVER_SAMPLES,
      coverSeed: COVER_SEED,
      genus: {
        table: genusTable,
        // The ForMS tail and unknowns, plus every OSM tree — all the "Other" (id 11) points.
        otherCount: trees.length - topGenusTotal + osm.crowned.length,
      },
    },
    cityTrees: trees.length,
    sidewalks,
  };

  await mkdir(dirname(INGEST_PARAMS_PATH), { recursive: true });
  await writeFile(INGEST_PARAMS_PATH, JSON.stringify(params));
  await writeFile(SIDECAR_PATH, JSON.stringify(sidecar));

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(`${CITY.id}: fetched and encoded in ${seconds}s`);
}

// `bun run scripts/tree-data-fetch.ts --city <id>`, one city a run: the two JSON files it leaves
// behind name one city's blobs, and the tiler pass between the halves reads exactly one of them.
// `--refresh` belongs to scripts/cache.ts, which reads process.argv for itself; it is named here so
// parseArgs does not reject it.
const { values } = parseArgs({
  options: {
    city: { type: "string" },
    refresh: { type: "boolean" },
  },
});
const known = Object.keys(CITIES).join(", ");
if (values.city === undefined) {
  throw new Error(`--city is required, one of: ${known}`);
}
const city = CITIES[values.city];
if (!city) {
  throw new Error(`no city ${values.city}; known: ${known}`);
}
await fetchCity(city);
