// The shape of src/tree-cover/manifest.json, the committed index that
// scripts/tree-data-manifest.ts writes and the tile builder and client read.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type Percentile =
  | "p1"
  | "p5"
  | "p10"
  | "p20"
  | "p30"
  | "p40"
  | "p50"
  | "p60"
  | "p70"
  | "p80"
  | "p90"
  | "p95"
  | "p97"
  | "p99";

export interface Distribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  percentiles: Record<Percentile, number>;
}

// One committed input the field is estimated from. layout: scripts/README.md
export interface SourceFile {
  file: string;
  format: number;
  count: number; // points, or polygons
  bytes: number;
  sha256: string;
}

// How a tree's trunk diameter becomes the crown disc the model shades the ground with. A published
// relation, recorded so the model is legible from the manifest alone — including WHICH relation,
// since the equation form differs between climate regions and not only its coefficients.
// scripts/allometry.ts is the type this mirrors and the place the curves are chosen.
export type CrownAllometry =
  | {
      source: string;
      form: "loglog";
      a: number;
      b: number;
      logBiasCorrection: number;
    }
  | { source: string; form: "quad"; a: number; b: number; c: number };

// data/canopy/<id>.bin: NYC's 2017 LiDAR tree-canopy polygons, magic `CNPY`, the shared polygon
// byte layout (a header, then per-polygon varint-delta rings) plus a trailing crown height in
// decimetres per polygon. This is the *measured* canopy footprint — the cover field itself:
// the canopy pass rasterizes it for the fill pyramid and the density pass samples it at each
// sidewalk to fill the routing density blobs. layout: scripts/README.md
export interface CanopyLayer {
  file: string;
  format: number;
  polygons: number;
  vertices: number;
  bytes: number;
  sha256: string;
  squareKm: number; // canopy area on land, ~a fifth of the city's land — a coverage sanity check
  measuredHeights: number; // polygons the height model had a cell for; the rest read 0, unknown
  updated: string;
  attribution: string; // NYC OTI / NYC Parks (2017 LiDAR)
  sourceUrl: string;
  // The separate height model the crown heights are sampled from. Absent for a city with none —
  // then every polygon's height is the 0 that reads as unknown and no tree shade is baked.
  heightAttribution?: string;
  heightSourceUrl?: string;
}

// The genus legend the genus overlay reads: the 11 most abundant genera by tree count, in id
// order (id = array index), plus the tail. Every tree carries a genus byte 0..11 in the TREE
// file — an id 0..10 into `table`, or 11 for the tail/unknown/OSM trees counted in `otherCount`.
export interface GenusTable {
  table: { genus: string; common: string; count: number }[]; // top 11, id order
  otherCount: number; // trees that fell to id 11: tail genera, unknown genus, and all OSM trees
}

// The canopy-cover field: the measured LiDAR canopy the cover is blurred from, plus the tree
// points the genus overlay draws and the constants that size them. The covered fraction is in
// [0, 1) by construction — a normalized Gaussian over a 0/1 canopy indicator — so there is no
// saturation constant to fit.
export interface FieldLayer {
  trees: SourceFile; // data/trees/<id>.bin, the points and crowns the genus overlay draws
  land: SourceFile; // data/land/<id>.bin, the population and the clip
  canopy: CanopyLayer; // data/canopy/<id>.bin, the measured 2017 LiDAR canopy: the cover source
  fillSigmaMeters: number; // the isotropic blur the canopy fill and the land mean read
  tightSigmaAlongMeters: number; // the street kernel, down the road: the colour stays smooth
  tightSigmaAcrossMeters: number; // and tight across it, so the two sidewalks stay distinct
  crownAllometry: CrownAllometry; // dbh -> crown radius, the size each genus dot draws at
  maxDbhInches: number; // trunks past this are clamped: the source has nonsense outliers
  imputedDbhInches: number; // the median, given to the trees carrying no dbh
  clampedTrees: number; // how many trunks the clamp caught
  imputedTrees: number; // how many trees had their dbh imputed
  osmTrees: number; // OSM natural=tree points kept, supplementing ForMS where it is a hole
  osmTreeDedup: number; // OSM trees dropped as within 5 m of a ForMS trunk (ForMS wins on dbh)
  osmImputedCrowns: number; // kept OSM trees with no diameter_crown, given the imputed crown
  meanCoverOverLand: number; // the mean covered fraction; sanity-checked against ~22% all-sources
  coverSamples: number; // land points the cover distribution was estimated from
  coverSeed: number; // and the seed they were drawn with, so the mean is reproducible
  genus: GenusTable; // the top-11 genus legend the genus overlay renders from
  density: Distribution; // the covered fraction over the land points; its mean is the check
  updated: string;
  attribution: string; // the OSM paths and trees the field mixes in; ForMS is credited on the city
  sourceUrl: string;
}

// data/streets/<id>.bin: the street geometry, carrying the tight field sampled at both
// sidewalks of every vertex. layout: scripts/README.md
export interface StreetLayer {
  file: string;
  format: number;
  segments: number;
  vertices: number;
  bytes: number;
  sha256: string;
  densifyMeters: number; // longest gap between two sampled vertices
  sidewalkInsetMeters: number; // curb to the centre of the sidewalk, either side
  // Whether this city's centreline distinguishes a service way with no pavement — New York's CSCL
  // does and San Francisco's does not, its "alleys" being narrow streets with sidewalks. The graph's
  // alley invariants are held over that population, so a city without one is not asked about it.
  alleys: boolean;
  density: Distribution; // the normalized tight field, over both sidewalks of every vertex
  updated: string;
  attribution: string;
  sourceUrl: string;
}

// data/paths/<id>.bin: the OSM pedestrian/park network, magic `PATH`. STRT's byte layout,
// reinterpreted per record (offset 0 = OSM way id, 20 = kind 6 path / 7 steps); it carries the
// same canopy cover at every vertex, filled by the density pass. layout: scripts/README.md
export interface PathLayer {
  file: string;
  format: number;
  ways: number; // OSM ways encoded, one record each
  segments: number; // records in the file (equal to ways: one way is one polyline)
  vertices: number;
  bytes: number;
  sha256: string;
  km: number; // total densified length on land
  density: Distribution; // the tight field on the path line, one sample standing for both sides
  updated: string;
  attribution: string; // OpenStreetMap contributors (ODbL)
  sourceUrl: string;
}

export interface CityEntry {
  id: string;
  name: string;
  bounds: Bounds; // where the field can be non-zero, which is what the overlays cover
  trees: number; // standing trees in the source inventory, all of which count
  updated: string;
  attribution: string; // the tree inventory
  sourceUrl: string;
  field: FieldLayer;
  streets: StreetLayer;
  paths: PathLayer;
}

export interface Manifest {
  version: 5;
  cities: CityEntry[];
}

const MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "manifest.json",
);
const MANIFEST_VERSION = 5;

export async function readManifest(): Promise<Manifest> {
  const existing = await readFile(MANIFEST_PATH, "utf-8").catch(() => null);
  if (existing === null) {
    return { version: MANIFEST_VERSION, cities: [] };
  } else {
    const parsed = JSON.parse(existing) as Manifest;
    // An ingest writes one city back into whatever it read, so a manifest it cannot read is
    // a stop rather than a fresh start: starting over would drop every other city.
    if (parsed.version !== MANIFEST_VERSION) {
      throw new Error(
        `${MANIFEST_PATH} is v${parsed.version}, not v${MANIFEST_VERSION}: re-ingest every city, or delete it to start over`,
      );
    } else {
      return parsed;
    }
  }
}

// The zoom the street and caster chunks are cut on. Those pyramids are keyed by x/y alone, with no
// city in the path, which works only because two cities never share a tile.
const CHUNK_ZOOM = 12;

// Whether two cities can reach the same chunk. Cities share the street, caster and commercial
// pyramids — they are keyed by x/y with no city segment — and the whole arrangement rests on their
// bounds not overlapping at the chunk grid. That is stated in a comment in
// crates/tiler/src/chunks.rs and checked nowhere, so the day someone adds a city that adjoins
// another (Oakland beside San Francisco, Jersey City inside New York's box) the two would
// interleave in one file with no error at all. Cheaper to assert here, where the bounds are
// written, than to debug there.
function chunkRange(bounds: Bounds): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const scale = 2 ** CHUNK_ZOOM;
  const x = (lng: number): number => Math.floor(((lng + 180) / 360) * scale);
  const y = (lat: number): number => {
    const radians = (lat * Math.PI) / 180;
    const merc =
      (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
    return Math.floor(merc * scale);
  };
  return {
    minX: x(bounds.west),
    maxX: x(bounds.east),
    minY: y(bounds.north),
    maxY: y(bounds.south),
  };
}

export function overlappingCities(
  cities: CityEntry[],
): [string, string] | null {
  for (let first = 0; first < cities.length; first++) {
    for (let second = first + 1; second < cities.length; second++) {
      const one = chunkRange(cities[first].bounds);
      const other = chunkRange(cities[second].bounds);
      if (
        one.minX <= other.maxX &&
        other.minX <= one.maxX &&
        one.minY <= other.maxY &&
        other.minY <= one.maxY
      ) {
        return [cities[first].id, cities[second].id];
      }
    }
  }
  return null;
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  const overlap = overlappingCities(manifest.cities);
  if (overlap) {
    throw new Error(
      `${overlap[0]} and ${overlap[1]} share a z${CHUNK_ZOOM} chunk: the street, caster and ` +
        "commercial pyramids are keyed by x/y with no city in the path, so their segments would " +
        "interleave in one file. Give those pyramids a city segment before adding this city.",
    );
  }
  const versioned: Manifest = { ...manifest, version: MANIFEST_VERSION };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(versioned, null, 2)}\n`);
}
