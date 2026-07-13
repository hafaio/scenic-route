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

// data/tree-cover/<id>.bin: tree density per unit area on a regular grid, normalized
// to 0..1. Layout documented in scripts/build-tree-data.ts.
export interface FieldLayer {
  file: string;
  format: number;
  cols: number;
  rows: number;
  bytes: number;
  sha256: string;
  cellMeters: number;
  broadSigmaMeters: number; // kernel behind the background fill
  tightSigmaMeters: number; // kernel the roads are sampled from
  saturationTreesPerHectare: number; // the density both fields divide by; 1.0 here
  woodlandPolygons: number;
  woodlandSquareKm: number; // woodland inside the city, after clipping to land
  woodlandFloor: number; // normalized value the canopy mask raises both fields to
  density: Distribution; // the normalized broad field, over land cells
  updated: string;
  attribution: string; // the woodland source; trees are credited on the city
  sourceUrl: string;
}

// data/streets/<id>.bin: the street geometry, carrying the tight field sampled at every
// vertex. Layout documented in scripts/build-tree-data.ts.
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
  bounds: Bounds; // the field grid, which is what the overlays cover
  trees: number; // standing trees in the source inventory, all of which count
  updated: string;
  attribution: string; // the tree inventory
  sourceUrl: string;
  field: FieldLayer;
  streets: StreetLayer;
}

export interface Manifest {
  version: 2;
  cities: CityEntry[];
}

const MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "manifest.json",
);
const MANIFEST_VERSION = 2;

export async function readManifest(): Promise<Manifest> {
  const existing = await readFile(MANIFEST_PATH, "utf-8").catch(() => null);
  if (existing === null) {
    return { version: MANIFEST_VERSION, cities: [] };
  } else {
    const parsed = JSON.parse(existing) as Manifest;
    // An ingest writes one city back into whatever it read, so a manifest it cannot read is
    // a stop rather than a fresh start: the alternative drops every other city from it.
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
