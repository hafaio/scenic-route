// The seam between the two halves of the tree-data ingest: scripts/tree-data-fetch.ts fetches and
// encodes, `cargo run --release --bin tiler -- ingest` measures the canopy heights and the cover
// densities, and scripts/tree-data-manifest.ts writes src/tree-cover/manifest.json. package.json
// sequences the three; this file is only the JSON they hand each other.

import { join } from "node:path";
import type {
  Bounds,
  CrownAllometry,
  Distribution,
  GenusTable,
  Percentile,
  SourceFile,
} from "./manifest";

const ROOT = join(import.meta.dirname, "..");

// .build/ is gitignored build glue at the repo root, where `bun run build-tiles` also hands
// plan.json over: a package.json script can name no temporary directory of the machine's.
export const INGEST_PARAMS_PATH = join(ROOT, ".build", "ingest.json");
export const INGEST_REPORT_PATH = join(ROOT, ".build", "ingest-report.json");
export const SIDECAR_PATH = join(ROOT, ".build", "tree-data.json");

export const PERCENTILES: readonly Percentile[] = [
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

// What `tiler ingest` reports a distribution as. The cuts come back as a map, because the labels
// they are reported at are passed to it.
export interface RawDistribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  percentiles: Record<string, number>;
}

// .build/ingest-report.json: what `tiler ingest` reports back, once it has filled the canopy file's
// height region from the LiDAR height model and the street and path files' density blobs from the
// blurred canopy.
export interface IngestReport {
  // Absent when the params carried no `chm`; then every polygon keeps the 0 that reads as unknown.
  heights?: {
    polygons: number;
    measured: number; // polygons the model had a cell for
    skippedTiles: number; // CHM tiles whose LZW stream would not decode, all east of the city
  };
  bounds: Bounds; // the sources, grown by the kernel's reach: what the pyramid covers
  draws: number;
  landDensity: RawDistribution; // the cover over land: its mean is the sanity-check figure
  streetDensity: RawDistribution;
  pathDensity?: RawDistribution; // present only when a paths file was passed
}

// .build/tree-data.json: what the manifest half needs from the fetch half, which is everything the
// manifest records that is neither measured by the tiler nor read back off the blobs.
export interface TreeDataSidecar {
  city: {
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
    alleys: boolean;
  };
  // The height model's credit, or null for a city with none.
  heightSource: { attribution: string; sourceUrl: string } | null;
  trees: SourceFile;
  land: SourceFile;
  // The canopy blob's identity; its bytes and sha256 are taken after the ingest fills its heights.
  canopy: {
    file: string;
    format: number;
    polygons: number;
    vertices: number;
    squareKm: number;
  };
  streets: {
    file: string;
    format: number;
    segments: number;
    vertices: number;
    densifyMeters: number;
  };
  paths: {
    file: string;
    format: number;
    ways: number;
    vertices: number;
    km: number;
  };
  field: {
    fillSigmaMeters: number;
    tightSigmaAlongMeters: number;
    tightSigmaAcrossMeters: number;
    sidewalkInsetMeters: number;
    crownAllometry: CrownAllometry;
    maxDbhInches: number;
    imputedDbhInches: number;
    clampedTrees: number;
    imputedTrees: number;
    osmTrees: number;
    osmTreeDedup: number;
    osmImputedCrowns: number;
    coverSamples: number;
    coverSeed: number;
    genus: GenusTable;
  };
  // The register's trees after the land clip: CityEntry.trees.
  cityTrees: number;
  // Only for the summary log line.
  sidewalks: SourceFile;
}

// The manifest's key order is the ingest's, not whatever a map iterated in.
export function distributionOf(raw: RawDistribution): Distribution {
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
