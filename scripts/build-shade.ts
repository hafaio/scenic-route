// `bun run build-shade` (also called from build-street-tiles): rasterizes building shadows into a
// city-wide SHADED-FRACTION field, sampled at several daytime hours of a representative day, and
// writes it as public/shade/nyc.bin (magic SHDF). The overlay draws it as a smooth heatmap and scrubs
// an hour slider, interpolating between the two bracketing hour planes.
//
// This is the inspection stepping stone to the eventual signed per-edge SHDE routing artifact: it
// validates the shadow geometry — do shadows land in the right places, the right lengths, and rotate
// correctly through the day — before that model is ported to Rust and baked per graph edge.
//
// Method (scatter, not per-point ray-march): each building is a vertical prism from its base (ground)
// elevation to base+roof height. Its shadow on the ground is the footprint smeared along the
// anti-sun direction by height * cot(elevation). So every grid cell the footprint covers is marched
// forward along that direction, marking each cell it crosses as shaded. This is fast (work scales with
// footprint area x shadow length, not the whole grid), covers all ground, and a tall tower naturally
// throws a long plume. The receiving ground is taken flat at each building's own base, so terrain
// falls out without a bare-earth DEM. Sun positions come from suncalc.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as SunCalc from "suncalc";
import manifest from "../src/tree-cover/manifest.json";
import type { Bounds } from "./manifest";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const SHADE_DIR = join(import.meta.dirname, "..", "public", "shade");

const SHADE_MAGIC = "SHDF";
const SHADE_VERSION = 1;

// suncalc@2.0.1 returns altitude/azimuth already in DEGREES; azimuth is a compass bearing measured
// clockwise from north. (The classic suncalc API returns radians from south — this fork does not.)
const sun = SunCalc as unknown as {
  getPosition: (
    date: Date,
    lat: number,
    lng: number,
  ) => { altitude: number; azimuth: number };
};

// The representative day and the daytime hours it is sampled at, in NYC LOCAL clock time. Fall equinox
// gives mid-range shadows (between the winter-long and summer-short extremes); the spread of hours
// shows the shadow sweeping from west (morning) through short (noon) to east (evening). tzOffset is
// hours to add to local to reach UTC (EDT = 4). This is a build-time inspection schedule, not the
// final SHDE bucketing (which will be declination x non-uniform sun position, baked in Rust).
const SAMPLE_DATE = { year: 2026, month: 8, day: 22, tzOffsetHours: 4 }; // month is 0-based (September)
const SAMPLE_HOURS = [8, 10, 12, 14, 16, 18];

// The field's ground resolution. Coarse enough to ship the whole city as one blob and to keep the
// scatter cheap; the client bilinear-samples and smooths it into a soft heatmap, so cell edges never
// show. Shadows past this length are faint (low sun => low intensity) and unbounded to trace, so the
// smear stops there — long enough to still show a tall tower's plume.
const CELL_METERS = 15;
const MAX_SHADOW_METERS = 500;
const METERS_PER_DEGREE_LAT = 111_320;

// The sun is a disk ~0.53° across (angular radius ~0.265°), not a point, so its shadow carries a
// penumbra that widens with distance from the occluding edge. We model it directly by AREA-LIGHT
// sampling: cast the shadow from DISK_SAMPLES sun positions spread over the disk and average. Near a
// building's base every sample agrees (a sharp umbra); at the far tip of a long shadow they fan apart
// (a soft penumbra) — so a taller building, whose tip is farther, grows a wider penumbra for free.
const SUN_ANGULAR_RADIUS_DEG = 0.265;
const DISK_SAMPLES = 6; // <= 8, so the per-cell coverage mask fits one byte

// popcount of a byte, so a coverage mask reduces to how many of the DISK_SAMPLES shaded the cell.
const POPCOUNT = new Uint8Array(256);
for (let value = 1; value < 256; value++) {
  POPCOUNT[value] = POPCOUNT[value >> 1] + (value & 1);
}

// Buildings as vertical prisms in a local metric frame: east metres and SOUTH metres from the field's
// north-west origin (so east -> column, south -> row), outer rings packed flat, plus each prism's roof
// height. The base elevation only matters relative to the ground it shades, which we take flat, so the
// shadow length uses the roof height alone.
interface Buildings {
  ringEast: Float64Array;
  ringSouth: Float64Array;
  ringStart: Uint32Array; // building b owns vertices [ringStart[b], ringStart[b + 1])
  heightMeters: Float64Array;
  count: number;
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

function magicOf(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

// The metric frame the field is built in: metres east and south of the north-west corner of the city
// bounds. A cell is CELL_METERS on a side, so column = east / CELL_METERS and row = south / CELL_METERS.
interface Frame {
  west: number;
  north: number;
  metersPerLng: number;
  metersPerLat: number;
  cols: number;
  rows: number;
}

function frameFor(bounds: Bounds): Frame {
  const metersPerLat = METERS_PER_DEGREE_LAT;
  const metersPerLng =
    METERS_PER_DEGREE_LAT *
    Math.cos(((bounds.north + bounds.south) / 2) * (Math.PI / 180));
  const widthMeters = (bounds.east - bounds.west) * metersPerLng;
  const heightMeters = (bounds.north - bounds.south) * metersPerLat;
  return {
    west: bounds.west,
    north: bounds.north,
    metersPerLng,
    metersPerLat,
    cols: Math.ceil(widthMeters / CELL_METERS),
    rows: Math.ceil(heightMeters / CELL_METERS),
  };
}

// Decode the BLDG building footprints (encodePolygons body + trailing u16 roof heights then u16 base
// elevations) into the prism model. Only each polygon's outer ring is kept; holes do not change the
// cast shadow's outline meaningfully. Base elevations are skipped: the ground is shaded flat.
function decodeBuildings(bytes: Uint8Array, frame: Frame): Buildings {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (magicOf(bytes) !== "BLDG") {
    throw new Error("not a BLDG polygon blob");
  }
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const ringStart = new Uint32Array(count + 1);
  const east: number[] = [];
  const south: number[] = [];
  for (let polygon = 0; polygon < count; polygon++) {
    ringStart[polygon] = east.length;
    const rings = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    for (let ring = 0; ring < rings; ring++) {
      const vertices = view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      let quantizedX = 0;
      let quantizedY = 0;
      for (let vertex = 0; vertex < vertices; vertex++) {
        quantizedX += readVarint(bytes, cursor);
        quantizedY += readVarint(bytes, cursor);
        if (ring === 0) {
          const lng = originLng + quantizedX * scale;
          const lat = originLat + quantizedY * scale;
          east.push((lng - frame.west) * frame.metersPerLng);
          south.push((frame.north - lat) * frame.metersPerLat);
        }
      }
    }
  }
  ringStart[count] = east.length;

  const heightsOffset = cursor.offset;
  const heightMeters = new Float64Array(count);
  for (let polygon = 0; polygon < count; polygon++) {
    heightMeters[polygon] =
      view.getUint16(heightsOffset + polygon * 2, true) / 10;
  }
  return {
    ringEast: Float64Array.from(east),
    ringSouth: Float64Array.from(south),
    ringStart,
    heightMeters,
    count,
  };
}

// Is cell-centre (east, south) inside building b's outer ring? Even-odd ray cast in the metric frame.
function insideRing(
  buildings: Buildings,
  building: number,
  east: number,
  south: number,
): boolean {
  const from = buildings.ringStart[building];
  const to = buildings.ringStart[building + 1];
  let inside = false;
  for (let vertex = from, previous = to - 1; vertex < to; previous = vertex++) {
    const ax = buildings.ringEast[vertex];
    const ay = buildings.ringSouth[vertex];
    const bx = buildings.ringEast[previous];
    const by = buildings.ringSouth[previous];
    if (ay > south !== by > south) {
      const crossEast = ((bx - ax) * (south - ay)) / (by - ay) + ax;
      if (east < crossEast) {
        inside = !inside;
      }
    }
  }
  return inside;
}

// Cast every building's shadow into the field for one sun position: for each cell a footprint covers,
// step forward along the anti-sun direction and mark each crossed cell shaded. Returns null when the
// sun is at or below the horizon (no daytime shade).
function castShade(
  buildings: Buildings,
  frame: Frame,
  hourLocal: number,
): Uint8Array | null {
  const samples = sunDiskSamples(frame, hourLocal);
  if (!samples) {
    return null;
  }

  // Per cell, a bit per disk sample that shaded it; its popcount is the shaded sample count.
  const mask = new Uint8Array(frame.cols * frame.rows);
  const footCols: number[] = [];
  const footRows: number[] = [];
  for (let building = 0; building < buildings.count; building++) {
    const from = buildings.ringStart[building];
    const to = buildings.ringStart[building + 1];
    if (to === from) {
      continue;
    }
    let minEast = Number.POSITIVE_INFINITY;
    let maxEast = Number.NEGATIVE_INFINITY;
    let minSouth = Number.POSITIVE_INFINITY;
    let maxSouth = Number.NEGATIVE_INFINITY;
    for (let vertex = from; vertex < to; vertex++) {
      minEast = Math.min(minEast, buildings.ringEast[vertex]);
      maxEast = Math.max(maxEast, buildings.ringEast[vertex]);
      minSouth = Math.min(minSouth, buildings.ringSouth[vertex]);
      maxSouth = Math.max(maxSouth, buildings.ringSouth[vertex]);
    }
    const colStart = Math.max(0, Math.floor(minEast / CELL_METERS));
    const colEnd = Math.min(frame.cols - 1, Math.floor(maxEast / CELL_METERS));
    const rowStart = Math.max(0, Math.floor(minSouth / CELL_METERS));
    const rowEnd = Math.min(frame.rows - 1, Math.floor(maxSouth / CELL_METERS));
    // The footprint's cells, found once and reused across the sun samples.
    footCols.length = 0;
    footRows.length = 0;
    for (let row = rowStart; row <= rowEnd; row++) {
      const south = (row + 0.5) * CELL_METERS;
      for (let col = colStart; col <= colEnd; col++) {
        const east = (col + 0.5) * CELL_METERS;
        if (insideRing(buildings, building, east, south)) {
          footCols.push(col);
          footRows.push(row);
        }
      }
    }
    if (footCols.length === 0) {
      continue;
    }
    const height = buildings.heightMeters[building];
    for (let sample = 0; sample < samples.length; sample++) {
      const { stepCol, stepRow, shadowPerHeight } = samples[sample];
      const bit = 1 << sample;
      const shadowMeters = Math.min(
        MAX_SHADOW_METERS,
        height * shadowPerHeight,
      );
      const steps = Math.ceil(shadowMeters / CELL_METERS);
      for (let cell = 0; cell < footCols.length; cell++) {
        let traceCol = footCols[cell];
        let traceRow = footRows[cell];
        for (let step = 0; step <= steps; step++) {
          const cellCol = Math.round(traceCol);
          const cellRow = Math.round(traceRow);
          if (
            cellCol >= 0 &&
            cellCol < frame.cols &&
            cellRow >= 0 &&
            cellRow < frame.rows
          ) {
            mask[cellRow * frame.cols + cellCol] |= bit;
          }
          traceCol += stepCol;
          traceRow += stepRow;
        }
      }
    }
  }

  const grid = new Uint8Array(frame.cols * frame.rows);
  for (let cell = 0; cell < mask.length; cell++) {
    if (mask[cell] !== 0) {
      grid[cell] = Math.round((255 * POPCOUNT[mask[cell]]) / DISK_SAMPLES);
    }
  }
  return grid;
}

// One sun-disk sample's ground projection: a unit anti-sun step in cell units (compass azimuth is
// clockwise from north, the shadow runs opposite, and rows increase southward) and the shadow length
// per metre of building height.
interface SunSample {
  stepCol: number;
  stepRow: number;
  shadowPerHeight: number;
}

// DISK_SAMPLES ground projections for a bucket: one at the sun's centre, the rest on a ring across its
// disk, so averaging their shadows yields the distance-widening penumbra. Null when the sun is at or
// below the horizon (no daytime shade). The azimuth spread divides by cos(elevation) so the offsets
// stay a circle on the sky rather than squeezing near the zenith.
function sunDiskSamples(frame: Frame, hourLocal: number): SunSample[] | null {
  const when = new Date(
    Date.UTC(
      SAMPLE_DATE.year,
      SAMPLE_DATE.month,
      SAMPLE_DATE.day,
      hourLocal + SAMPLE_DATE.tzOffsetHours,
      0,
      0,
      0,
    ),
  );
  const middleLat =
    frame.north - (frame.rows * CELL_METERS) / frame.metersPerLat / 2;
  const position = sun.getPosition(when, middleLat, frame.west);
  if (position.altitude <= 0.5) {
    return null;
  }
  const ringRadius = SUN_ANGULAR_RADIUS_DEG * 0.75; // inside the rim, so the ring sits near the disk's mean
  const cosElevation = Math.cos(position.altitude * (Math.PI / 180));
  const samples: SunSample[] = [];
  for (let index = 0; index < DISK_SAMPLES; index++) {
    let deltaElevation = 0;
    let deltaAzimuth = 0;
    if (index > 0) {
      const angle = (2 * Math.PI * (index - 1)) / (DISK_SAMPLES - 1);
      deltaElevation = ringRadius * Math.cos(angle);
      deltaAzimuth = (ringRadius * Math.sin(angle)) / cosElevation;
    }
    const azimuthRad = (position.azimuth + deltaAzimuth) * (Math.PI / 180);
    const elevationRad = (position.altitude + deltaElevation) * (Math.PI / 180);
    samples.push({
      stepCol: -Math.sin(azimuthRad),
      stepRow: Math.cos(azimuthRad),
      shadowPerHeight: 1 / Math.tan(elevationRad),
    });
  }
  return samples;
}

// Serialize the whole field: a header (grid geometry and the bucket hours), then one cols*rows byte
// plane per bucket. A null plane (sun down) is written as all-zero.
function encodeField(
  frame: Frame,
  bucketHours: number[],
  planes: (Uint8Array | null)[],
): Uint8Array {
  const buckets = bucketHours.length;
  const headerBytes = 58 + buckets * 2;
  const plane = frame.cols * frame.rows;
  const bytes = new Uint8Array(headerBytes + buckets * plane);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = SHADE_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, SHADE_VERSION, true);
  view.setUint16(6, headerBytes, true);
  view.setUint32(8, frame.cols, true);
  view.setUint32(12, frame.rows, true);
  view.setFloat64(16, frame.west, true);
  view.setFloat64(24, frame.north, true);
  view.setFloat64(32, frame.metersPerLng, true);
  view.setFloat64(40, frame.metersPerLat, true);
  view.setFloat64(48, CELL_METERS, true);
  view.setUint16(56, buckets, true);
  for (let bucket = 0; bucket < buckets; bucket++) {
    // The bucket's local time in minutes since midnight, so the overlay can label and interpolate.
    view.setUint16(58 + bucket * 2, Math.round(bucketHours[bucket] * 60), true);
  }
  for (let bucket = 0; bucket < buckets; bucket++) {
    const source = planes[bucket];
    if (source) {
      bytes.set(source, headerBytes + bucket * plane);
    }
  }
  return bytes;
}

export async function buildShade(): Promise<void> {
  await rm(SHADE_DIR, { recursive: true, force: true });
  await mkdir(SHADE_DIR, { recursive: true });

  for (const city of manifest.cities) {
    const started = performance.now();
    const buildingBytes = await readBin(
      join(DATA_DIR, "buildings", `${city.id}.bin`),
    );
    if (!buildingBytes) {
      console.error(`shade: ${city.id} has no buildings, skipped`);
      continue;
    }
    const frame = frameFor(city.bounds);
    const buildings = decodeBuildings(buildingBytes, frame);
    const planes = SAMPLE_HOURS.map((hour) =>
      castShade(buildings, frame, hour),
    );

    await writeFile(
      join(SHADE_DIR, `${city.id}.bin`),
      encodeField(frame, SAMPLE_HOURS, planes),
    );

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.error(
      `shade: ${city.id} ${frame.cols}x${frame.rows} field x ${SAMPLE_HOURS.length} buckets from ${buildings.count} buildings, ${seconds}s`,
    );
  }
}

async function readBin(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  await buildShade();
}
