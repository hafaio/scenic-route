// `bun run scripts/openstreets.ts`: fetches NYC Open Streets and writes them as data/openstreets/
// nyc.bin (magic OSTR) — the pedestrianized/limited-traffic corridors that REINFORCE the commercial
// overlay. Open Streets are not commercial on their own (many are residential blocks or 34th Ave-style
// linear parks), so the overlay never lights a block from these alone: it uses them only to extend a
// block that already carries café/dining presence. Each corridor's GeoJSON MultiLineString is sampled
// densely along the ground so the points snap onto the corridor's own CSCL block segments. Points
// only. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePoints, haversineMeters, type NamedPoint } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Coord } from "./socrata";
import { fetchDataset } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const OPEN_STREETS_DIR = join(DATA_DIR, "openstreets");
const OPEN_STREETS_MAGIC = "OSTR";
const OPEN_STREETS_FORMAT = 1;
const OPEN_STREETS_DATASET = "uiay-nctu"; // NYC Open Streets: pedestrianized/limited-traffic corridors
const OPEN_STREETS_COUNT = 391; // a floor; ~391 rows at the last refresh
// School-hour street closures, not corridors — dropped so they cannot reinforce a quiet block.
const OPEN_STREETS_SCHOOLS_STATUS = "approvedFullSchools";
// Spacing of the points dropped along each corridor. Open Streets ARE streets, so a dense trail of
// samples snaps onto the corridor's own CSCL block segments, marking each block the corridor covers.
const OPEN_STREET_SAMPLE_METERS = 10;

interface OpenStreetRow {
  // GeoJSON MultiLineString: an array of lines, each an array of [lng, lat] pairs.
  the_geom?: { type?: string; coordinates?: [number, number][][] };
  reviewstat?: string; // the approval status; approvedFullSchools marks a school-hour closure
  orgname?: string; // the sponsoring organization, used as the sample's (client-only) label
}

// Walks one polyline and drops a point every OPEN_STREET_SAMPLE_METERS, interpolating between
// vertices by ground distance, so a dense trail of points follows the corridor's own centreline.
function sampleLine(line: [number, number][], name: string): NamedPoint[] {
  const points: NamedPoint[] = [];
  if (line.length === 0) {
    return points;
  }
  let [previousLng, previousLat] = line[0];
  points.push({ lat: previousLat, lng: previousLng, name }); // always sample the corridor's start
  let sinceSample = 0; // metres walked past the last emitted sample, at the previous vertex
  for (let index = 1; index < line.length; index++) {
    const [lng, lat] = line[index];
    const span = haversineMeters(
      { lat: previousLat, lng: previousLng },
      { lat, lng },
    );
    // The next sample sits this far into the current piece; step by the spacing until past its end.
    for (
      let along = OPEN_STREET_SAMPLE_METERS - sinceSample;
      along < span;
      along += OPEN_STREET_SAMPLE_METERS
    ) {
      const fraction = along / span;
      points.push({
        lat: previousLat + (lat - previousLat) * fraction,
        lng: previousLng + (lng - previousLng) * fraction,
        name,
      });
    }
    // Carry the leftover past the last sample into the next piece; a zero-length piece leaves it be.
    sinceSample =
      span > 0 ? (sinceSample + span) % OPEN_STREET_SAMPLE_METERS : sinceSample;
    previousLng = lng;
    previousLat = lat;
  }
  return points;
}

// The corridors as dense samples, dropping school-hour closures and clipping to land. Returns the
// samples plus how many corridor rows survived the school-status filter, for the log.
function toSamples(
  rows: OpenStreetRow[],
  onLand: (coord: Coord) => boolean,
): { samples: NamedPoint[]; corridors: number } {
  const samples: NamedPoint[] = [];
  let corridors = 0;
  for (const row of rows) {
    if (row.reviewstat === OPEN_STREETS_SCHOOLS_STATUS) {
      continue;
    }
    const lines = row.the_geom?.coordinates ?? [];
    if (lines.length === 0) {
      continue;
    }
    corridors += 1;
    const name = row.orgname?.trim() ?? "";
    for (const line of lines) {
      for (const sample of sampleLine(line, name)) {
        if (onLand(sample)) {
          samples.push(sample);
        }
      }
    }
  }
  return { samples, corridors };
}

export async function ingestOpenStreets(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(OPEN_STREETS_DIR, { recursive: true });

  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query).
  const rows = await fetchDataset<OpenStreetRow>(
    OPEN_STREETS_DATASET,
    { $select: "*" },
    OPEN_STREETS_COUNT,
  );
  const { samples, corridors } = toSamples(rows, land.onLand);

  const bytes = encodePoints(OPEN_STREETS_MAGIC, OPEN_STREETS_FORMAT, samples);
  const file = `${cityId}.bin`;
  await writeFile(join(OPEN_STREETS_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `openstreets: ${rows.length} rows fetched, ${corridors} corridors kept, ${samples.length} samples on land, ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: OPEN_STREETS_FORMAT,
    count: samples.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestOpenStreets("nyc", await loadLandContext());
}
