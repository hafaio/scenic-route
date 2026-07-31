// The parcels a sidewalk-shed permit stands on: for every permit's BIN and BBL, the building
// footprint and — the one that matters — the tax lot. A shed is built on the pavement at the
// property line, so the lot boundary is what a shed runs along; the footprint only says which part
// of a multi-part lot is in use. Three NYC Open Data sets: the building footprints (5zhs-2jue), the
// DOF digital tax map (i38t-6if2), and the condominium table (p8u6-a6it), which is what a billing
// BBL (lot 7501+) needs — it carries no polygon of its own, only the base lot it sits on.
//
// A key's parts are dissolved with polygon-clipping's union, but only when it has more than one:
// the tax map and the footprint feed each give a key a single part almost always (39,830 of 39,905
// lots, and every one of the 40,206 BINs, over the 8.5-year shed history), so the union is not a
// shortcut past the common case — it is the 75-key tail where a lot's parts touch and their shared
// edge would otherwise show up as a boundary a shed could be mapped onto.

import { union } from "polygon-clipping";
import { COORD_SCALE } from "./geometry";
import { fetchKeyed } from "./socrata";

const FOOTPRINT_DATASET = "5zhs-2jue"; // NYC Building Footprints
const FOOTPRINT_SELECT = "bin,the_geom,base_bbl,mappluto_bbl";
const LOT_DATASET = "i38t-6if2"; // DOF digital tax map
const LOT_SELECT = "bbl,the_geom";
const CONDO_DATASET = "p8u6-a6it"; // condominium billing lot -> the base lot it occupies
const CONDO_SELECT = "condo_billing_bbl,condo_base_bbl";
const BLOCK_DIGITS = 5;
const LOT_DIGITS = 4;

// A polygon boundary in lng/lat, counter-clockwise, first vertex repeated last. Holes are dropped:
// a shed runs along the outside of a lot.
export type Ring = Float64Array; // [lng0, lat0, lng1, lat1, ...]

// Every coordinate onto the 1e-6 degree grid (~0.11 m) every other blob in this repo uses. Applied
// where the geometry is resolved rather than where it is drawn on, so the placement never sees a
// coordinate finer than the pipeline's own grid and two runs over the same source agree exactly.
export function quantizeRing(ring: Ring): Ring {
  const snapped = new Float64Array(ring.length);
  for (let at = 0; at < ring.length; at++) {
    snapped[at] = Math.round(ring[at] / COORD_SCALE) * COORD_SCALE;
  }
  return snapped;
}

// Every lot and footprint the permits touch, keyed the way the permits name them.
export interface ShedParcels {
  footprints: Map<string, Ring[]>; // BIN -> the building's parts
  lots: Map<string, Ring[]>; // BBL -> the tax lot's parts
  lotOfBin: Map<string, string>; // BIN -> the BBL the footprint feed reports, when the permit's own BBL has no polygon
}

// One part's boundary as Socrata hands it over: [lng, lat] pairs, closed.
type Boundary = [number, number][];

type Geometry =
  | { type: "Polygon"; coordinates: Boundary[] }
  | { type: "MultiPolygon"; coordinates: Boundary[][] };

interface FootprintRow {
  bin?: string;
  the_geom?: Geometry;
  base_bbl?: string;
  mappluto_bbl?: string;
}

interface LotRow {
  bbl?: string;
  the_geom?: Geometry;
}

interface CondoRow {
  condo_billing_bbl?: string;
  condo_base_bbl?: string;
}

function toInteger(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  } else {
    return null;
  }
}

export function bblOf(
  boroughDigit: string,
  block: string,
  lot: string,
): string | null {
  const borough = toInteger(boroughDigit);
  const blockNumber = toInteger(block);
  const lotNumber = toInteger(lot);
  if (borough === null || blockNumber === null || lotNumber === null) {
    return null;
  } else {
    const blockDigits = String(blockNumber).padStart(BLOCK_DIGITS, "0");
    const lotDigits = String(lotNumber).padStart(LOT_DIGITS, "0");
    return `${borough}${blockDigits}${lotDigits}`;
  }
}

// Exterior rings only, one per part.
function boundariesOf(geometry: Geometry | undefined): Boundary[] {
  if (geometry === undefined) {
    return [];
  } else {
    const parts =
      geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [geometry.coordinates];
    return parts
      .map((rings) => rings[0])
      .filter(
        (ring): ring is Boundary => ring !== undefined && ring.length > 2,
      );
  }
}

function addBoundary(
  parts: Map<string, Boundary[]>,
  key: string,
  boundary: Boundary,
): void {
  const existing = parts.get(key);
  if (existing === undefined) {
    parts.set(key, [boundary]);
  } else {
    existing.push(boundary);
  }
}

function signedArea(ring: Ring): number {
  let twiceArea = 0;
  for (let offset = 0; offset + 3 < ring.length; offset += 2) {
    twiceArea +=
      ring[offset] * ring[offset + 3] - ring[offset + 2] * ring[offset + 1];
  }
  return twiceArea / 2;
}

function reverse(ring: Ring): void {
  for (
    let head = 0, tail = ring.length - 2;
    head < tail;
    head += 2, tail -= 2
  ) {
    const lng = ring[head];
    const lat = ring[head + 1];
    ring[head] = ring[tail];
    ring[head + 1] = ring[tail + 1];
    ring[tail] = lng;
    ring[tail + 1] = lat;
  }
}

// GeoJSON boundaries arrive closed and the union's do too, but a source ring that is not is cheap
// to close and expensive to debug downstream.
function toRing(boundary: Boundary): Ring {
  const [firstLng, firstLat] = boundary[0];
  const [lastLng, lastLat] = boundary[boundary.length - 1];
  const closed = firstLng === lastLng && firstLat === lastLat;
  const vertices = closed ? boundary.length : boundary.length + 1;
  const ring = new Float64Array(vertices * 2);
  for (let index = 0; index < boundary.length; index++) {
    const [lng, lat] = boundary[index];
    ring[index * 2] = lng;
    ring[index * 2 + 1] = lat;
  }
  if (!closed) {
    ring[(vertices - 1) * 2] = firstLng;
    ring[(vertices - 1) * 2 + 1] = firstLat;
  }
  if (signedArea(ring) < 0) {
    reverse(ring);
  }
  return ring;
}

// Two parts of one key in a fixed order. Socrata does not promise a row order and does not keep one:
// a key's parts come back in a different order depending on which other keys shared its batch, and
// the union's output ring then starts at a different vertex, which moves the frontage arc and the
// placement with it. Sorting the parts is what makes the same permit place the same way whatever else
// was being read alongside it.
function compareBoundaries(left: Boundary, right: Boundary): number {
  for (let vertex = 0; vertex < Math.min(left.length, right.length); vertex++) {
    for (const axis of [0, 1] as const) {
      if (left[vertex][axis] !== right[vertex][axis]) {
        return left[vertex][axis] - right[vertex][axis];
      }
    }
  }
  return left.length - right.length;
}

// The parts dissolved into as few boundaries as they touch down to, or null when the clipper
// rejects the input — the parts are degenerate often enough that a throw is not a reason to lose a
// lot, only to keep its parts apart.
function dissolve(boundaries: Boundary[]): Ring[] | null {
  try {
    const [first, ...rest] = [...boundaries]
      .sort(compareBoundaries)
      .map((boundary) => [boundary]);
    return union(first, ...rest).map((polygon) => toRing(polygon[0]));
  } catch {
    return null;
  }
}

function toRings(
  parts: Map<string, Boundary[]>,
  label: string,
): Map<string, Ring[]> {
  const rings = new Map<string, Ring[]>();
  let multiPart = 0;
  let unionFailures = 0;
  for (const [key, boundaries] of parts) {
    if (boundaries.length === 1) {
      rings.set(key, [toRing(boundaries[0])]);
    } else {
      multiPart += 1;
      const merged = dissolve(boundaries);
      if (merged === null) {
        unionFailures += 1;
        rings.set(key, [...boundaries].sort(compareBoundaries).map(toRing));
      } else {
        rings.set(key, merged);
      }
    }
  }
  console.error(
    `  ${label}: ${rings.size} keys, ${multiPart} multi-part, ${unionFailures} union failures`,
  );
  return rings;
}

async function fetchLotParts(
  bbls: Iterable<string>,
): Promise<Map<string, Boundary[]>> {
  const rows = await fetchKeyed<LotRow>(LOT_DATASET, LOT_SELECT, "bbl", bbls);
  const parts = new Map<string, Boundary[]>();
  for (const row of rows) {
    if (row.bbl) {
      for (const boundary of boundariesOf(row.the_geom)) {
        addBoundary(parts, row.bbl, boundary);
      }
    }
  }
  return parts;
}

// The lot a permit sits on: its own BBL when the tax map has it, else the one its BIN reports.
export function lotFor(
  parcels: ShedParcels,
  bbl: string | null,
  bin: string,
): Ring[] | null {
  const direct = bbl === null ? undefined : parcels.lots.get(bbl);
  if (direct !== undefined && direct.length > 0) {
    return direct;
  } else {
    const reported = parcels.lotOfBin.get(bin);
    if (reported === undefined) {
      return null;
    } else {
      return parcels.lots.get(reported) ?? null;
    }
  }
}

export async function fetchShedParcels(
  keys: { bin: string; bbl: string | null }[],
): Promise<ShedParcels> {
  const bins = new Set<string>();
  const bbls = new Set<string>();
  for (const { bin, bbl } of keys) {
    if (bin) {
      bins.add(bin);
    }
    if (bbl) {
      bbls.add(bbl);
    }
  }

  const footprintRows = await fetchKeyed<FootprintRow>(
    FOOTPRINT_DATASET,
    FOOTPRINT_SELECT,
    "bin",
    bins,
  );
  const footprintParts = new Map<string, Boundary[]>();
  const lotOfBin = new Map<string, string>();
  for (const row of footprintRows) {
    if (row.bin) {
      for (const boundary of boundariesOf(row.the_geom)) {
        addBoundary(footprintParts, row.bin, boundary);
      }
      // PLUTO's lot where the feed has one, else the base lot it maps the building to; some come
      // back with a decimal tail ("1000160001.00000000").
      const reported = row.mappluto_bbl || row.base_bbl;
      if (reported && !lotOfBin.has(row.bin)) {
        lotOfBin.set(row.bin, reported.split(".")[0]);
      }
    }
  }

  // Every lot the placement could read: the ones the permits name, and the ones their BINs report,
  // which is what `lotFor` falls back to when the tax map has no polygon for a permit's own BBL.
  // Both go through the same resolution below, because a reported lot is a condominium billing lot
  // as often as a permit's own is — and resolving only the latter made a permit's fallback depend on
  // whether some OTHER permit in the same run happened to name the same BBL.
  const wanted = new Set([...bbls, ...lotOfBin.values()]);
  const lotParts = await fetchLotParts(wanted);
  const direct = lotParts.size;

  // A BBL with no polygon in the tax map is usually a condominium billing lot, which is a billing
  // fiction: the condo table names the tax lots it physically occupies, and the billing lot takes
  // the union of their geometry.
  const missing = [...wanted].filter((bbl) => !lotParts.has(bbl));
  const condoRows = await fetchKeyed<CondoRow>(
    CONDO_DATASET,
    CONDO_SELECT,
    "condo_billing_bbl",
    missing,
  );
  const basesOfBilling = new Map<string, Set<string>>();
  for (const row of condoRows) {
    const billing = row.condo_billing_bbl;
    const base = row.condo_base_bbl;
    if (billing && base) {
      const bases = basesOfBilling.get(billing);
      if (bases === undefined) {
        basesOfBilling.set(billing, new Set([base]));
      } else {
        bases.add(base);
      }
    }
  }
  const baseParts = await fetchLotParts(
    [...basesOfBilling.values()].flatMap((bases) => [...bases]),
  );
  let viaCondo = 0;
  for (const [billing, bases] of basesOfBilling) {
    const boundaries = [...bases]
      .sort()
      .flatMap((base) => baseParts.get(base) ?? []);
    if (boundaries.length > 0) {
      lotParts.set(billing, boundaries);
      viaCondo += 1;
    }
  }

  const resolved = [...bbls].filter((bbl) => lotParts.has(bbl)).length;
  console.error(
    `  lots: ${direct} direct, +${viaCondo} via condo, ${resolved}/${bbls.size} of the permits' own BBLs`,
  );

  return {
    footprints: toRings(footprintParts, "footprints"),
    lots: toRings(lotParts, "lots"),
    lotOfBin,
  };
}
