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

// The tree-density field: not a raster, but the points and masks it is computed from, plus
// the constants that turn a kernel density estimate into the 0..1 the ramp reads.
export interface FieldLayer {
  trees: SourceFile; // data/trees/<id>.bin, the points the estimate sums over
  woodland: SourceFile; // data/woodland/<id>.bin, the canopy the inventory does not carry
  land: SourceFile; // data/land/<id>.bin, the population and the clip
  broadSigmaMeters: number; // kernel behind the background fill
  tightSigmaMeters: number; // kernel the roads are sampled from
  saturationTreesPerHectare: number; // the density both fields divide by; 1.0 here
  saturationSamples: number; // land points the percentile was estimated from
  saturationSeed: number; // and the seed they were drawn with, so it is reproducible
  woodlandSquareKm: number; // woodland inside the city, after clipping to land
  woodlandFloor: number; // normalized value the canopy mask raises both fields to
  woodlandFeatherMeters: number; // soft park edge, rather than a hard cut
  woodlandPlateau: number; // coverage the feather is called complete at
  density: Distribution; // the normalized broad field, over those same land points
  updated: string;
  attribution: string; // the woodland source; trees are credited on the city
  sourceUrl: string;
}

// data/streets/<id>.bin: the street geometry, carrying the tight field sampled at every
// vertex. layout: scripts/README.md
export interface StreetLayer {
  file: string;
  format: number;
  segments: number;
  vertices: number;
  bytes: number;
  sha256: string;
  densifyMeters: number; // longest gap between two sampled vertices
  density: Distribution; // the normalized tight field, over street vertices
  updated: string;
  attribution: string;
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
}

export interface Manifest {
  version: 3;
  cities: CityEntry[];
}

const MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "manifest.json",
);
const MANIFEST_VERSION = 3;

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
