// `bun run build-tree-data`: writes data/{trees,woodland,land,streets}/<id>.bin and
// src/tree-cover/manifest.json. Fetching, encoding and the manifest are here; the estimator that
// fills the streets file's density blob and finds the saturation is crates/tiler. The model, the
// sources and the binary layouts are all documented in scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boxOf,
  COORD_SCALE,
  encodePoints,
  encodePolygons,
  writeVarint,
  zigzag,
} from "./geometry";
import {
  type Bounds,
  type CityEntry,
  type Distribution,
  type FieldLayer,
  type Percentile,
  readManifest,
  type SourceFile,
  type StreetLayer,
  writeManifest,
} from "./manifest";
import { fetchWoodland, type Polygon } from "./overpass";
import { type Coord, fetchDataset, fetchNycTrees } from "./socrata";
import { runTiler } from "./tiler";

// The CSCL road-way types that carry pedestrians: street, boardwalk, path, step street,
// alley. Highways, ramps, tunnels, driveways and ferry routes are not walkable.
type RoadType = 1 | 5 | 6 | 7 | 10;

interface Segment {
  physicalId: number;
  roadType: RoadType;
  streetWidth: number; // feet, 0 unknown
  postedSpeed: number; // mph, 0 unknown
  points: Coord[]; // densified, so the field is sampled at least every DENSIFY_METERS
  lengthMeters: number;
}

interface StreetRow {
  the_geom?: { type: string; coordinates: [number, number][][] };
  physicalid?: string;
  rw_type?: string;
  streetwidth?: string;
  posted_speed?: string;
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
  saturationTreesPerHectare: number;
  woodlandSquareKm: number;
  draws: number;
  landDensity: RawDistribution;
  streetDensity: RawDistribution;
}

const DATA_DIR = join(import.meta.dirname, "..", "data");
const PARAMS_PATH = join(tmpdir(), "scenic-route-densities.json");

const STREET_FORMAT = 2;
const STREET_HEADER_BYTES = 56;
const STREET_RECORD_BYTES = 24;
const TREE_FORMAT = 1;
const WOODLAND_FORMAT = 1;
const LAND_FORMAT = 1;

const BROAD_SIGMA_METERS = 70; // neighbourhood leafiness
const TIGHT_SIGMA_METERS = 20; // what this street is lined with
const WOODLAND_FLOOR = 0.85; // normalized value the canopy mask raises both fields to
const WOODLAND_FEATHER_METERS = 30; // soft park edge, rather than a hard cut
// The feather is divided by this and clamped, so a cell it calls half covered is fully
// wooded: a blurred mask otherwise sags in the middle of anything narrower than the blur,
// and OSM maps a wood like the Ramble as a scatter of polygons around its clearings.
const WOODLAND_PLATEAU = 0.5;

const SATURATION: Percentile = "p97"; // of the broad field over land; both fields divide by it
const SATURATION_SAMPLES = 1_000_000;
const SATURATION_SEED = 42; // fixed, so the constant the whole ramp hangs on does not churn

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

const ROAD_TYPES: readonly RoadType[] = [1, 5, 6, 7, 10];
const NYC_SEGMENT_COUNT = 109_463;
const NYC_BOROUGH_COUNT = 5;

function toInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const rows = await fetchDataset<StreetRow>(
    "inkn-q76z",
    {
      $select: "the_geom,physicalid,rw_type,streetwidth,posted_speed",
      $where: `rw_type in (${ROAD_TYPES.map((type) => `'${type}'`).join(",")})`,
    },
    NYC_SEGMENT_COUNT,
  );
  return toSegments(rows);
}

// Shoreline-clipped, so the harbour is not part of the distribution the ramp normalizes
// against, and so the OSM woodland the city's bounding box also catches in New Jersey and
// Westchester is cut away.
async function fetchNycLand(): Promise<Polygon[]> {
  const rows = await fetchDataset<BoroughRow>(
    "gthc-hcne",
    { $select: "the_geom" },
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

// The raw extent of the sources. The tiler grows it by the widest kernel's reach — it owns the
// truncation radius — and hands back the bounds the pyramid is planned over.
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

// The density blob is written zeroed and filled in place by `tiler densities`, so the
// coordinates it samples the field at are the ones that ship rather than a parallel copy.
// layout: scripts/README.md
function encodeStreets(segments: Segment[]): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  let vertices = 0;
  for (const segment of segments) {
    vertices += segment.points.length;
    for (const { lat, lng } of segment.points) {
      originLng = Math.min(originLng, lng);
      originLat = Math.min(originLat, lat);
    }
  }

  const records = new Uint8Array(
    STREET_HEADER_BYTES + segments.length * STREET_RECORD_BYTES,
  );
  const view = new DataView(records.buffer);
  // Two varints of at most five bytes each per vertex.
  const blob = new Uint8Array(vertices * 10);
  let blobEnd = 0;
  let vertex = 0;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const start = blobEnd;
    let previousX = 0;
    let previousY = 0;
    for (const { lat, lng } of segment.points) {
      const quantizedX = Math.round((lng - originLng) / COORD_SCALE);
      const quantizedY = Math.round((lat - originLat) / COORD_SCALE);
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedX - previousX));
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedY - previousY));
      previousX = quantizedX;
      previousY = quantizedY;
    }

    const record = STREET_HEADER_BYTES + index * STREET_RECORD_BYTES;
    view.setUint32(record, segment.physicalId, true);
    view.setUint32(record + 4, start, true);
    view.setUint16(record + 8, segment.points.length, true);
    view.setFloat32(record + 12, segment.lengthMeters, true);
    view.setUint32(record + 16, vertex, true);
    records[record + 20] = segment.roadType;
    records[record + 21] = segment.streetWidth;
    records[record + 22] = segment.postedSpeed;
    vertex += segment.points.length;
  }

  records[0] = "S".charCodeAt(0);
  records[1] = "T".charCodeAt(0);
  records[2] = "R".charCodeAt(0);
  records[3] = "T".charCodeAt(0);
  view.setUint16(4, STREET_FORMAT, true);
  view.setUint16(6, STREET_HEADER_BYTES, true);
  view.setUint16(8, STREET_RECORD_BYTES, true);
  view.setUint32(12, segments.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  view.setUint32(40, records.length, true);
  view.setUint32(44, blobEnd, true);
  view.setUint32(48, records.length + blobEnd, true);
  view.setUint32(52, vertices, true);

  const encoded = new Uint8Array(records.length + blobEnd + vertices);
  encoded.set(records);
  encoded.set(blob.subarray(0, blobEnd), records.length);
  return encoded;
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
  woodlandAttribution: "OpenStreetMap contributors",
  woodlandSourceUrl: "https://www.openstreetmap.org/copyright",
} as const;

async function ingest(): Promise<void> {
  const started = performance.now();
  // The woodland is fetched first: it is the only source that can be rate-limited away, and
  // there is no point spending five minutes on the trees to find that out.
  console.error(`${CITY.id}: fetching borough boundaries`);
  const land = await fetchNycLand();
  const landBox = boxOf(land);
  console.error(`${CITY.id}: fetching woodland polygons`);
  const woodland = await fetchWoodland(
    landBox.south,
    landBox.west,
    landBox.north,
    landBox.east,
  );
  console.error(
    `${CITY.id}: ${woodland.polygons.length} woodland polygons (${woodland.ways} ways, ${woodland.relations} relations, ${woodland.unclosed} unclosed rings dropped)`,
  );

  console.error(`${CITY.id}: fetching street segments`);
  const segments = await fetchNycStreets();
  console.error(`${CITY.id}: fetching trees`);
  const trees = await fetchNycTrees();

  const file = `${CITY.id}.bin`;
  const treeFile = await writeSource(
    "trees",
    file,
    TREE_FORMAT,
    trees.length,
    encodePoints("TREE", TREE_FORMAT, trees),
  );
  const woodlandFile = await writeSource(
    "woodland",
    file,
    WOODLAND_FORMAT,
    woodland.polygons.length,
    encodePolygons("WOOD", WOODLAND_FORMAT, woodland.polygons),
  );
  const landFile = await writeSource(
    "land",
    file,
    LAND_FORMAT,
    land.length,
    encodePolygons("LAND", LAND_FORMAT, land),
  );
  const streetPath = join(DATA_DIR, "streets", file);
  await mkdir(join(DATA_DIR, "streets"), { recursive: true });
  await writeFile(streetPath, encodeStreets(segments));

  let vertices = 0;
  for (const segment of segments) {
    vertices += segment.points.length;
  }
  await writeFile(
    PARAMS_PATH,
    JSON.stringify({
      trees: join(DATA_DIR, "trees", file),
      woodland: join(DATA_DIR, "woodland", file),
      land: join(DATA_DIR, "land", file),
      streets: streetPath,
      sourceBox: sourceBoxOf(segments, trees),
      landBox,
      broadSigmaMeters: BROAD_SIGMA_METERS,
      tightSigmaMeters: TIGHT_SIGMA_METERS,
      woodlandFloor: WOODLAND_FLOOR,
      woodlandFeatherMeters: WOODLAND_FEATHER_METERS,
      woodlandPlateau: WOODLAND_PLATEAU,
      saturationPercentile: Number(SATURATION.slice(1)),
      saturationSamples: SATURATION_SAMPLES,
      saturationSeed: SATURATION_SEED,
      percentiles: PERCENTILES.map((percentile) => Number(percentile.slice(1))),
    }),
  );
  const estimate: Estimate = JSON.parse(
    runTiler(["densities", "--params", PARAMS_PATH], true),
  );
  // Rust filled the density blob in place, so the file on disk is no longer the one encoded.
  const streetBytes = new Uint8Array(await readFile(streetPath));

  const updated = new Date().toISOString().slice(0, 10);
  const field: FieldLayer = {
    trees: treeFile,
    woodland: woodlandFile,
    land: landFile,
    broadSigmaMeters: BROAD_SIGMA_METERS,
    tightSigmaMeters: TIGHT_SIGMA_METERS,
    saturationTreesPerHectare: estimate.saturationTreesPerHectare,
    saturationSamples: SATURATION_SAMPLES,
    saturationSeed: SATURATION_SEED,
    woodlandSquareKm: estimate.woodlandSquareKm,
    woodlandFloor: WOODLAND_FLOOR,
    woodlandFeatherMeters: WOODLAND_FEATHER_METERS,
    woodlandPlateau: WOODLAND_PLATEAU,
    density: distributionOf(estimate.landDensity),
    updated,
    attribution: CITY.woodlandAttribution,
    sourceUrl: CITY.woodlandSourceUrl,
  };
  const streets: StreetLayer = {
    file,
    format: STREET_FORMAT,
    segments: segments.length,
    vertices,
    bytes: streetBytes.length,
    sha256: createHash("sha256").update(streetBytes).digest("hex"),
    densifyMeters: DENSIFY_METERS,
    density: distributionOf(estimate.streetDensity),
    updated,
    attribution: CITY.streetAttribution,
    sourceUrl: CITY.streetSourceUrl,
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
    `${CITY.id}: wrote trees (${megabytes(treeFile.bytes)} MiB), woodland (${megabytes(woodlandFile.bytes)} MiB), land (${megabytes(landFile.bytes)} MiB) and streets (${segments.length} segments, ${vertices} vertices, ${megabytes(streetBytes.length)} MiB) in ${seconds}s`,
  );
}

await ingest();
