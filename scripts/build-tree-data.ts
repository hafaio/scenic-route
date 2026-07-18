// `bun run build-tree-data`: writes data/{trees,land,canopy,streets,paths}/<id>.bin and
// src/tree-cover/manifest.json. Fetching, encoding and the manifest are here; the estimator that
// fills the streets file's density blob and reports the cover distribution is crates/tiler. The
// model, the sources and the binary layouts are all documented in scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCanopyPolygons } from "./canopy";
import {
  boxOf,
  COORD_SCALE,
  type CrownedTree,
  encodePolygons,
  encodeTrees,
  writeVarint,
  zigzag,
} from "./geometry";
import { buildLandTest } from "./land-filter";
import {
  type Bounds,
  type CanopyLayer,
  type CityEntry,
  type Distribution,
  type FieldLayer,
  type PathLayer,
  type Percentile,
  readManifest,
  type SourceFile,
  type StreetLayer,
  writeManifest,
} from "./manifest";
import {
  fetchOsmTrees,
  fetchPaths,
  type OsmTree,
  type PathWay,
  type Polygon,
} from "./overpass";
import { type Coord, fetchDataset, fetchNycTrees, type Tree } from "./socrata";
import { runTiler } from "./tiler";

// The CSCL road-way types that carry pedestrians: street, bridge, tunnel, boardwalk, path,
// step street, alley. Bridges (3) and tunnels (4) are walkable only when not vehicular-only
// (nonped != 'V'); the $where excludes those. Highways, ramps, driveways and ferry routes are
// never walkable.
type RoadType = 1 | 3 | 4 | 5 | 6 | 7 | 10;

// STRT record byte 23. A router reads these; the overlay ignores them.
const FLAG_VEHICULAR_ONLY = 1 << 0; // nonped === "V" — drawn, never routed
const FLAG_NON_VEHICULAR = 1 << 1; // trafdir === "NV" — a dedicated ped/bike deck, offset 0
const FLAG_STRUCTURE = 1 << 2; // rw_type 3 or 4 — a bridge or tunnel deck

interface Segment {
  physicalId: number;
  roadType: RoadType;
  streetWidth: number; // feet, 0 unknown
  postedSpeed: number; // mph, 0 unknown
  flags: number; // FLAG_* bits, from the row's nonped/trafdir/rw_type
  name: string; // the trimmed stname_label, "" when the row carries none
  nameId: number; // index into the name table, UNNAMED_ID when the row carries no label
  points: Coord[]; // densified, so the field is sampled at least every DENSIFY_METERS
  lengthMeters: number;
}

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

interface BoroughRow {
  the_geom?: { type: string; coordinates: [number, number][][][] };
}

// What `tiler densities` reports back, once it has filled the streets file's density blob. The
// cuts come back as a map, because the labels they are reported at are passed to it.
interface RawDistribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  percentiles: Record<string, number>;
}

interface Estimate {
  bounds: Bounds; // the sources, grown by the kernel's reach: what the pyramid covers
  draws: number;
  landDensity: RawDistribution; // the cover over land: its mean is the sanity-check figure
  streetDensity: RawDistribution;
  pathDensity?: RawDistribution; // present only when a paths file was passed
}

const DATA_DIR = join(import.meta.dirname, "..", "data");
const PARAMS_PATH = join(tmpdir(), "scenic-route-densities.json");

const STREET_FORMAT = 5;
const PATH_FORMAT = 1; // OSM pedestrian/park ways, STRT v5's byte layout with the PATH reinterpretations
const PATH_KIND_PATH = 6; // record byte 20: an ordinary path, sampled and offset like rw_type 6
const PATH_KIND_STEPS = 7; // record byte 20: a step street (highway=steps), like rw_type 7
const STREET_HEADER_BYTES = 64;
const STREET_RECORD_BYTES = 24;
const STREET_SIDES = 2; // the density blob carries both sidewalks of every vertex, left then right
const UNNAMED_ID = 0xffff; // the segment's name id when CSCL carries no label — measured zero for NYC
const TREE_FORMAT = 3; // v3 adds a genus byte per tree; v2 added the crown byte, v1 was points only
const LAND_FORMAT = 1;
const CANOPY_FORMAT = 1; // the measured 2017 LiDAR canopy, the shared polygon layout under magic CNPY

const TOP_GENUS_COUNT = 11; // the genera given their own id 0..10; the rest share id 11 ("Other")
const OTHER_GENUS_ID = TOP_GENUS_COUNT; // 12: tail genera, unknown genus, and every OSM tree
// The legend's common names for the expected top-12 genera; a selected genus not here falls back
// to its own name, so a shift in the ranks stays legible rather than blank.
const GENUS_COMMON_NAMES: Record<string, string> = {
  Quercus: "Oak",
  Acer: "Maple",
  Platanus: "London planetree",
  Gleditsia: "Honeylocust",
  Pyrus: "Callery pear",
  Tilia: "Linden",
  Prunus: "Cherry",
  Zelkova: "Zelkova",
  Fraxinus: "Ash",
  Ginkgo: "Ginkgo",
  Ulmus: "Elm",
  Styphnolobium: "Pagoda tree",
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

// The crown each tree shades the ground with, from its trunk diameter. Published relation, not
// invented: McPherson, van Doorn & Peper 2016, "Urban Tree Database and Allometric Equations"
// (USDA Forest Service GTR-PSW-253, archive RDS-2016-0005). The "NoEast" reference city is
// Queens, so this is literally NYC street-tree data; the London planetree log-log curve (the
// city's most abundant street species, R^2 0.94) stands in for every species, since ForMS
// carries no species here. crownDiameter[m] = exp(a + b*ln(ln(dbh_cm + 1)) + correction).
const CROWN_ALLOMETRY = {
  source:
    "McPherson, van Doorn & Peper 2016 (USDA GTR-PSW-253), NoEast London planetree",
  form: "crownDiameterMeters = exp(a + b*ln(ln(dbhInches*2.54 + 1)) + logBiasCorrection)",
  a: -0.752,
  b: 2.414,
  logBiasCorrection: 0.00988,
} as const;
const CM_PER_INCH = 2.54;
// max(dbh) is 2427 in, nonsense; a 60 in trunk is already a very large street tree, so anything
// past it is clamped there. dbh = 0 (missing) is given the median rather than a zero crown.
const MAX_DBH_INCHES = 60;
const MEDIAN_DBH_INCHES = 9; // the ForMS median over standing trees, imputed for missing dbh

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
const PERCENTILES: readonly Percentile[] = [
  "p1",
  "p5",
  "p10",
  "p20",
  "p30",
  "p40",
  "p50",
  "p60",
  "p70",
  "p80",
  "p90",
  "p95",
  "p97",
  "p99",
];

const ROAD_TYPES: readonly RoadType[] = [1, 3, 4, 5, 6, 7, 10];
// The walkable-row total the paged fetch is checked against — a floor, so it sits a little below
// the current Socrata count (111,675 rows for the $where below: 99,361 street + 2,205 bridge +
// 7 tunnel + 101 boardwalk + 5,918 path + 248 step + 3,835 alley) rather than tracking it exactly.
const NYC_SEGMENT_COUNT = 111_000;
const NYC_BOROUGH_COUNT = 5;

function toInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// The crown radius the allometry predicts for one trunk, in metres. dbh is capped and a missing
// dbh imputed *before* this, so the log-log curve is only ever asked about a plausible trunk.
function crownRadiusMeters(dbhInches: number): number {
  const dbhCm = dbhInches * CM_PER_INCH;
  const diameter = Math.exp(
    CROWN_ALLOMETRY.a +
      CROWN_ALLOMETRY.b * Math.log(Math.log(dbhCm + 1)) +
      CROWN_ALLOMETRY.logBiasCorrection,
  );
  return diameter / 2;
}

// Sizes every tree's crown from its dbh, clamping the nonsense outliers and imputing the median
// for the trees that carry no dbh — reporting how many of each so the model's inputs are not
// silent. The crown then rides with the point through the encoder.
function crownTrees(
  trees: readonly Tree[],
  genusId: ReadonlyMap<string, number>,
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
      dbh = MEDIAN_DBH_INCHES;
      imputed += 1;
    } else if (dbh > MAX_DBH_INCHES) {
      dbh = MAX_DBH_INCHES;
      clamped += 1;
    }
    return {
      lat,
      lng,
      crownRadiusM: crownRadiusMeters(dbh),
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

  const imputedCrownRadiusM = crownRadiusMeters(MEDIAN_DBH_INCHES);
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

// Splits every piece longer than DENSIFY_METERS, so the field is sampled often enough
// along a road for its colour to vary rather than come out in one flat block.
function densify(points: Coord[]): { points: Coord[]; lengthMeters: number } {
  const dense: Coord[] = [points[0]];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const meters = haversineMeters(from, to);
    total += meters;
    const steps = Math.max(1, Math.ceil(meters / DENSIFY_METERS));
    for (let step = 1; step <= steps; step++) {
      const along = step / steps;
      dense.push({
        lat: from.lat + (to.lat - from.lat) * along,
        lng: from.lng + (to.lng - from.lng) * along,
      });
    }
  }
  return { points: dense, lengthMeters: total };
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
      const dense = densify(points);
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

// Anything the encoder names: a street segment or a path way. Its `nameId` is stamped in place
// by buildNameTable from its (already trimmed and, for paths, uppercased) `name`.
interface Named {
  name: string;
  nameId: number;
}

// Collects the distinct names, sorts them, and stamps each record with its index into that
// sorted table; a record with no label keeps UNNAMED_ID. Returns the table, which the encoder
// writes once as the trailing name blob. Streets and paths each build their own.
function buildNameTable(records: Named[]): string[] {
  const distinct = new Set<string>();
  for (const record of records) {
    if (record.name) {
      distinct.add(record.name);
    }
  }
  const names = [...distinct].sort();
  const idOf = new Map(names.map((name, index) => [name, index]));
  for (const record of records) {
    record.nameId = record.name
      ? (idOf.get(record.name) ?? UNNAMED_ID)
      : UNNAMED_ID;
  }
  return names;
}

async function fetchNycStreets(): Promise<Segment[]> {
  // `*` so a newly-read column is free after one refetch: the disk cache keys on the query, so
  // narrowing $select would force a full re-page whenever a new column is wanted. StreetRow names
  // only the columns toSegments reads.
  const rows = await fetchDataset<StreetRow>(
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
    const dense = densify(way.points);
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

// Shoreline-clipped, so the harbour is not part of the distribution the ramp normalizes
// against, and so the OSM trees and paths the city's bounding box also catches in New Jersey
// and Westchester are cut away.
async function fetchNycLand(): Promise<Polygon[]> {
  // `*` so a newly-read column is free after one refetch (see fetchNycStreets); BoroughRow reads
  // only the_geom.
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

// Land-clips the measured canopy polygons the same ring-midpoint way the paths and OSM trees are
// clipped: a polygon is kept if the midpoint vertex of its outer ring is on land. The ArcGIS
// service is NYC Parks' own LiDAR and carries essentially no New Jersey / Westchester spill, but
// the clip is applied for parity with the other polygon sources and to guard a future re-extent.
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

// The manifest's key order is the ingest's, not whatever a map iterated in.
function distributionOf(raw: RawDistribution): Distribution {
  const percentiles = {} as Record<Percentile, number>;
  for (const percentile of PERCENTILES) {
    percentiles[percentile] = raw.percentiles[percentile];
  }
  return {
    min: raw.min,
    max: raw.max,
    mean: raw.mean,
    median: raw.median,
    percentiles,
  };
}

// One record of either network, mapped to the shared byte layout: the id at offset 0, the kind
// at 20, and the width/speed/flags bytes. STRT fills all three; PATH leaves width and speed 0 and
// uses only the structure flag.
interface NetworkRecord {
  id: number; // record offset 0 (u32): CSCL physicalid, or an OSM way id
  nameId: number; // record offset 10
  lengthMeters: number; // record offset 12 (f32)
  kind: number; // record byte 20: rw_type, or the PATH kind
  width: number; // record byte 21
  speed: number; // record byte 22
  flags: number; // record byte 23
  points: Coord[];
}

// The one encoder both networks share: STRT v5's layout, parameterized by magic and format. The
// density blob is written zeroed — two bytes a vertex, one sidewalk each — and filled in place by
// `tiler densities`, so the coordinates it offsets the sidewalks from are the ones that ship
// rather than a parallel copy. layout: scripts/README.md
function encodeNetwork(
  magic: string,
  format: number,
  records: NetworkRecord[],
  names: string[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  let vertices = 0;
  for (const record of records) {
    vertices += record.points.length;
    for (const { lat, lng } of record.points) {
      originLng = Math.min(originLng, lng);
      originLat = Math.min(originLat, lat);
    }
  }

  const table = new Uint8Array(
    STREET_HEADER_BYTES + records.length * STREET_RECORD_BYTES,
  );
  const view = new DataView(table.buffer);
  // Two varints of at most five bytes each per vertex.
  const blob = new Uint8Array(vertices * 10);
  let blobEnd = 0;
  let vertex = 0;

  for (let index = 0; index < records.length; index++) {
    const entry = records[index];
    const start = blobEnd;
    let previousX = 0;
    let previousY = 0;
    for (const { lat, lng } of entry.points) {
      const quantizedX = Math.round((lng - originLng) / COORD_SCALE);
      const quantizedY = Math.round((lat - originLat) / COORD_SCALE);
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedX - previousX));
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedY - previousY));
      previousX = quantizedX;
      previousY = quantizedY;
    }

    const record = STREET_HEADER_BYTES + index * STREET_RECORD_BYTES;
    view.setUint32(record, entry.id, true);
    view.setUint32(record + 4, start, true);
    view.setUint16(record + 8, entry.points.length, true);
    view.setUint16(record + 10, entry.nameId, true);
    view.setFloat32(record + 12, entry.lengthMeters, true);
    view.setUint32(record + 16, vertex, true);
    table[record + 20] = entry.kind;
    table[record + 21] = entry.width;
    table[record + 22] = entry.speed;
    table[record + 23] = entry.flags;
    vertex += entry.points.length;
  }

  for (let index = 0; index < 4; index++) {
    table[index] = magic.charCodeAt(index);
  }
  view.setUint16(4, format, true);
  view.setUint16(6, STREET_HEADER_BYTES, true);
  view.setUint16(8, STREET_RECORD_BYTES, true);
  view.setUint32(12, records.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  // The name blob is the file's final region: a u32 count, then each name as a u16 byte length
  // and its UTF-8 bytes, back to back. Read once, sequentially, by the one Rust reader.
  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  let nameBlobLength = 4;
  for (const bytes of nameBytes) {
    nameBlobLength += 2 + bytes.length;
  }
  const nameBlob = new Uint8Array(nameBlobLength);
  const nameView = new DataView(nameBlob.buffer);
  nameView.setUint32(0, names.length, true);
  let nameCursor = 4;
  for (const bytes of nameBytes) {
    nameView.setUint16(nameCursor, bytes.length, true);
    nameCursor += 2;
    nameBlob.set(bytes, nameCursor);
    nameCursor += bytes.length;
  }

  const densityBytes = STREET_SIDES * vertices;
  const nameBlobOffset = table.length + blobEnd + densityBytes;
  view.setUint32(40, table.length, true);
  view.setUint32(44, blobEnd, true);
  view.setUint32(48, table.length + blobEnd, true);
  view.setUint32(52, densityBytes, true);
  view.setUint32(56, nameBlobOffset, true);
  view.setUint32(60, nameBlobLength, true);

  const encoded = new Uint8Array(nameBlobOffset + nameBlobLength);
  encoded.set(table);
  encoded.set(blob.subarray(0, blobEnd), table.length);
  encoded.set(nameBlob, nameBlobOffset);
  return encoded;
}

// STRT v5: the CSCL street network. The record id is the physicalid; kind is rw_type; the
// width/speed/flags bytes are all populated.
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

const CITY = {
  id: "nyc",
  name: "New York City",
  attribution: "NYC Parks Forestry (ForMS) via NYC Open Data",
  sourceUrl: "https://data.cityofnewyork.us/d/hn5i-inap",
  streetAttribution: "NYC DoITT Street Centerline (CSCL) via NYC Open Data",
  streetSourceUrl: "https://data.cityofnewyork.us/d/inkn-q76z",
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
} as const;

async function ingest(): Promise<void> {
  const started = performance.now();
  console.error(`${CITY.id}: fetching borough boundaries`);
  const land = await fetchNycLand();
  const landBox = boxOf(land);

  // The land test is built once from the borough polygons and reused: the paths ask it up to
  // three times each, the OSM trees once each, and the canopy polygons once each.
  const onLand = buildLandTest(land);

  // The measured 2017 LiDAR canopy: NYC Parks' polygon feature service, ~1M polygons paged and
  // disk-cached, then land-clipped. It is the cover source — `tiler canopy` rasterizes it for the
  // fill pyramid and `tiler densities` samples it at every sidewalk for the routing density.
  console.error(`${CITY.id}: fetching 2017 LiDAR tree canopy polygons`);
  const canopy = await fetchCanopyPolygons();
  const canopyOnLand = clipCanopyToLand(canopy.polygons, onLand);
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
    `${CITY.id}: canopy ${canopy.fetched} polygons fetched, ${canopyOnLand.length} on land, ${canopyVertices} vertices, ${canopySquareKilometers.toFixed(1)} km² (${canopy.dropped} degenerate dropped)`,
  );

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
  const segments = await fetchNycStreets();
  const names = buildNameTable(segments);
  const unnamed = segments.filter(
    (segment) => segment.nameId === UNNAMED_ID,
  ).length;
  console.error(
    `${CITY.id}: ${names.length} distinct street names, ${unnamed} unnamed segments`,
  );
  console.error(`${CITY.id}: fetching trees`);
  const trees = await fetchNycTrees();

  // The genus legend: tally the ForMS genera, take the 12 most abundant, and give each an id 0..11
  // in descending-count order. Everything else — tail genera, unknown genus, and every OSM tree —
  // maps to id 12 ("Other"). The map is threaded into crownTrees so each tree gets its genus byte.
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

  const { crowned, clamped, imputed } = crownTrees(trees, genusId);
  console.error(
    `${CITY.id}: sized ${crowned.length} crowns (clamped ${clamped} trunks past ${MAX_DBH_INCHES} in, imputed ${imputed} missing dbh at ${MEDIAN_DBH_INCHES} in)`,
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
  // masquerading as another polygon source; the tiler reads it with the same generic decoder.
  const canopyFile = await writeSource(
    "canopy",
    file,
    CANOPY_FORMAT,
    canopyOnLand.length,
    encodePolygons("CNPY", CANOPY_FORMAT, canopyOnLand),
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
  // The density estimator now reads the measured canopy, blurred: the isotropic fill kernel for
  // the reported land distribution, the oriented along/across kernel at each sidewalk offset. The
  // trees are still fetched and encoded above (the genus overlay draws them), but the street/path
  // density blobs no longer consume them.
  await writeFile(
    PARAMS_PATH,
    JSON.stringify({
      canopy: join(DATA_DIR, "canopy", file),
      land: join(DATA_DIR, "land", file),
      streets: streetPath,
      paths: pathPath,
      sourceBox: sourceBoxOf(segments, trees),
      landBox,
      fillSigmaMeters: FILL_SIGMA_METERS,
      tightSigmaAlongMeters: TIGHT_SIGMA_ALONG_METERS,
      tightSigmaAcrossMeters: TIGHT_SIGMA_ACROSS_METERS,
      sidewalkInsetMeters: SIDEWALK_INSET_METERS,
      coverSamples: COVER_SAMPLES,
      coverSeed: COVER_SEED,
      percentiles: PERCENTILES.map((percentile) => Number(percentile.slice(1))),
    }),
  );
  const estimate: Estimate = JSON.parse(
    runTiler(["densities", "--params", PARAMS_PATH], true),
  );
  // Rust filled the density blob in place, so the files on disk are no longer the ones encoded.
  const streetBytes = new Uint8Array(await readFile(streetPath));
  const pathBytes = new Uint8Array(await readFile(pathPath));
  if (!estimate.pathDensity) {
    throw new Error(
      "tiler densities was passed paths but reported no pathDensity",
    );
  }

  const updated = new Date().toISOString().slice(0, 10);
  const canopyLayer: CanopyLayer = {
    file: canopyFile.file,
    format: canopyFile.format,
    polygons: canopyFile.count,
    vertices: canopyVertices,
    bytes: canopyFile.bytes,
    sha256: canopyFile.sha256,
    squareKm: Math.round(canopySquareKilometers * 10) / 10,
    updated,
    attribution: CITY.canopyAttribution,
    sourceUrl: CITY.canopySourceUrl,
  };
  const field: FieldLayer = {
    trees: treeFile,
    land: landFile,
    canopy: canopyLayer,
    fillSigmaMeters: FILL_SIGMA_METERS,
    tightSigmaAlongMeters: TIGHT_SIGMA_ALONG_METERS,
    tightSigmaAcrossMeters: TIGHT_SIGMA_ACROSS_METERS,
    crownAllometry: CROWN_ALLOMETRY,
    maxDbhInches: MAX_DBH_INCHES,
    imputedDbhInches: MEDIAN_DBH_INCHES,
    clampedTrees: clamped,
    imputedTrees: imputed,
    osmTrees: osm.crowned.length,
    osmTreeDedup: osm.deduped,
    osmImputedCrowns: osm.imputedCrowns,
    meanCoverOverLand: estimate.landDensity.mean,
    coverSamples: COVER_SAMPLES,
    coverSeed: COVER_SEED,
    genus: {
      table: genusTable,
      // The ForMS tail and unknowns, plus every OSM tree — all the "Other" (id 11) points.
      otherCount: trees.length - topGenusTotal + osm.crowned.length,
    },
    density: distributionOf(estimate.landDensity),
    updated,
    attribution: CITY.fieldAttribution,
    sourceUrl: CITY.fieldSourceUrl,
  };
  const streets: StreetLayer = {
    file,
    format: STREET_FORMAT,
    segments: segments.length,
    vertices,
    bytes: streetBytes.length,
    sha256: createHash("sha256").update(streetBytes).digest("hex"),
    densifyMeters: DENSIFY_METERS,
    sidewalkInsetMeters: SIDEWALK_INSET_METERS,
    density: distributionOf(estimate.streetDensity),
    updated,
    attribution: CITY.streetAttribution,
    sourceUrl: CITY.streetSourceUrl,
  };
  const paths: PathLayer = {
    file,
    format: PATH_FORMAT,
    ways: pathSegments.length,
    segments: pathSegments.length,
    vertices: pathVertices,
    bytes: pathBytes.length,
    sha256: createHash("sha256").update(pathBytes).digest("hex"),
    km: Math.round(pathKm * 10) / 10,
    density: distributionOf(estimate.pathDensity),
    updated,
    attribution: CITY.pathAttribution,
    sourceUrl: CITY.pathSourceUrl,
  };
  const entry: CityEntry = {
    id: CITY.id,
    name: CITY.name,
    bounds: estimate.bounds,
    trees: trees.length,
    updated,
    attribution: CITY.attribution,
    sourceUrl: CITY.sourceUrl,
    field,
    streets,
    paths,
  };

  const manifest = await readManifest();
  const existing = manifest.cities.findIndex((other) => other.id === CITY.id);
  if (existing === -1) {
    manifest.cities.push(entry);
  } else {
    manifest.cities[existing] = entry;
  }
  await writeManifest(manifest);

  const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `${CITY.id}: wrote trees (${megabytes(treeFile.bytes)} MiB), canopy (${canopyOnLand.length} polygons, ${megabytes(canopyFile.bytes)} MiB), land (${megabytes(landFile.bytes)} MiB), streets (${segments.length} segments, ${vertices} vertices, ${megabytes(streetBytes.length)} MiB) and paths (${pathSegments.length} ways, ${pathVertices} vertices, ${megabytes(pathBytes.length)} MiB) in ${seconds}s`,
  );
}

await ingest();
