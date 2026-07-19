// `bun run scripts/art.ts`: fetches NYC public art and writes it as data/art/nyc.bin (magic ARTW) —
// the artistic-scenery POIs (murals, sculpture, installations) a later phase fans out over the
// walking graph into a per-edge "passes public art" routing discount. Two sources merged: the NYC
// PDC Outdoor Public Art Inventory (authoritative, but skews monuments/sculpture) and OSM
// tourism=artwork (which carries the murals the PDC set is thin on). Points only; no overlay this
// batch. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePoints, haversineMeters, type NamedPoint } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import { fetchOsmArtwork, type OsmArtwork } from "./overpass";
import type { Coord } from "./socrata";
import { fetchDataset } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const ART_DIR = join(DATA_DIR, "art");
const ART_MAGIC = "ARTW";
const ART_FORMAT = 1;
const ART_DATASET = "2pg3-gcaa"; // PDC Outdoor Public Art Inventory
const ART_COUNT = 700; // a floor; ~780 works at the last refresh
// An OSM artwork this close to a PDC work is the same piece; the PDC record wins (it is curated).
const OSM_ART_DEDUP_METERS = 30;

interface ArtRow {
  latitude?: string;
  longitude?: string;
  title?: string;
}

function toPoints(
  rows: ArtRow[],
  onLand: (coord: Coord) => boolean,
): NamedPoint[] {
  const points: NamedPoint[] = [];
  for (const row of rows) {
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    const point = { lat, lng, name: (row.title ?? "").trim() };
    if (onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

// Keeps the OSM works that are not already a PDC work. Both sets are small (hundreds), so a direct
// radius scan is cheaper than indexing — no grid is worth its bookkeeping here.
function dedupOsm(osm: OsmArtwork[], pdc: NamedPoint[]): NamedPoint[] {
  return osm
    .filter(
      (point) =>
        !pdc.some(
          (curated) => haversineMeters(point, curated) <= OSM_ART_DEDUP_METERS,
        ),
    )
    .map((point) => ({ lat: point.lat, lng: point.lng, name: point.name }));
}

export async function ingestArt(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(ART_DIR, { recursive: true });

  // `*` so a newly-read column is free after one refetch (the disk cache keys on the query).
  const pdcRows = await fetchDataset<ArtRow>(
    ART_DATASET,
    { $select: "*" },
    ART_COUNT,
  );
  const pdc = toPoints(pdcRows, land.onLand);

  const { south, west, north, east } = land.box;
  const osmRaw = await fetchOsmArtwork(south, west, north, east);
  const osmOnLand = osmRaw.filter(land.onLand);
  const osm = dedupOsm(osmOnLand, pdc);
  const points = [...pdc, ...osm];

  const bytes = encodePoints(ART_MAGIC, ART_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(ART_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `art: PDC ${pdc.length} on land, OSM ${osmRaw.length} fetched / ${osmOnLand.length} on land / ${osm.length} kept after dedup, ${points.length} total, ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: ART_FORMAT,
    count: points.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestArt("nyc", await loadLandContext());
}
