// The shape of src/tree-cover/manifest.json, the committed index that
// scripts/build-tree-data.ts writes and the tile builder and client read.

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

// How a tree's trunk diameter becomes the crown disc the model shades the ground with. A
// published relation, recorded so the model is legible from the manifest alone.
export interface CrownAllometry {
  source: string;
  form: string;
  a: number;
  b: number;
  logBiasCorrection: number;
}

// The canopy-cover field: not a raster, but the points and masks it is computed from, plus the
// constants that turn a crown-weighted kernel density estimate into the covered fraction in
// [0, 1) the ramp reads. There is no saturation constant — cover is bounded by construction.
export interface FieldLayer {
  trees: SourceFile; // data/trees/<id>.bin, the points and crowns the estimate sums over
  woodland: SourceFile; // data/woodland/<id>.bin, the canopy the inventory does not carry
  land: SourceFile; // data/land/<id>.bin, the population and the clip
  broadSigmaMeters: number; // kernel behind the background fill
  tightSigmaAlongMeters: number; // the street kernel, down the road: the colour stays smooth
  tightSigmaAcrossMeters: number; // and over it, loosely: a big tree opposite reaches over
  crownAllometry: CrownAllometry; // dbh -> crown radius, the weight each tree carries
  maxDbhInches: number; // trunks past this are clamped: the source has nonsense outliers
  imputedDbhInches: number; // the median, given to the trees carrying no dbh
  clampedTrees: number; // how many trunks the clamp caught
  imputedTrees: number; // how many trees had their dbh imputed
  meanCoverOverLand: number; // the mean covered fraction; sanity-checked against ~22% all-sources
  coverSamples: number; // land points the cover distribution was estimated from
  coverSeed: number; // and the seed they were drawn with, so the mean is reproducible
  woodlandSquareKm: number; // woodland inside the city, after clipping to land
  woodlandFloor: number; // the cover a wood is treated as: a forest is ~90% canopy
  woodlandFeatherMeters: number; // soft park edge, rather than a hard cut
  woodlandPlateau: number; // coverage the feather is called complete at
  density: Distribution; // the covered fraction over the land points; its mean is the check
  updated: string;
  attribution: string; // the woodland source; trees are credited on the city
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
  density: Distribution; // the normalized tight field, over both sidewalks of every vertex
  updated: string;
  attribution: string;
  sourceUrl: string;
}

// data/paths/<id>.bin: the OSM pedestrian/park network, magic `PATH`. STRT v5's byte layout,
// reinterpreted per record (offset 0 = OSM way id, 20 = kind 6 path / 7 steps); it carries the
// same tree density at every vertex, filled by `tiler densities`. layout: scripts/README.md
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

export async function writeManifest(manifest: Manifest): Promise<void> {
  const versioned: Manifest = { ...manifest, version: MANIFEST_VERSION };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(versioned, null, 2)}\n`);
}
