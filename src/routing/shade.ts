// The SHDE data: a per-edge signed sun/shade attribute baked for a grid of sun positions, so the
// router can bias toward sun or shade for the resolved time of day. A given day's sun only sweeps a
// handful of the (declination, hourAngle) bins, so the attributes ship as one small file PER BIN,
// fetched lazily on demand, alongside a manifest of the bins. `computeEdgeShade` resolves a Date to a
// sun position, loads and blends the two hour-angle-nearest bins in its season band, and writes the
// per-edge attribute onto the graph; below the horizon there is no shade to bias, so it clears the
// field. The bin selection mirrors components/shade-layer.tsx (both via src/shade/sun.ts), so the
// router agrees with the shade overlay.

import * as SunCalc from "suncalc";
import { declinationOf, hourAngleOf, seasonBand } from "../shade/sun";
import manifest from "../tree-cover/manifest.json";
import type { RoutingGraph } from "./graph";

const MAGIC = "SHDB";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 12; // magic(4) + u16 version + u16 pad + u32 edgeCount
const BINS_URL = "routing/shade/bins.json"; // relative, so it picks up the deploy basePath
const HORIZON_DEG = 0.5; // at or below this the sun is down and there is no shade to bias

const binUrl = (index: number): string => `routing/shade/${index}.bin`;

// suncalc@2.0.1, as the shade overlay consumes it: altitude/azimuth as the layer's currentSun reads
// them, azimuth a compass bearing normalised to [0, 360).
const sun = SunCalc as unknown as {
  getPosition: (
    date: Date,
    lat: number,
    lng: number,
  ) => { altitude: number; azimuth: number };
};

const [city] = manifest.cities;
const CENTRE_LAT = (city.bounds.north + city.bounds.south) / 2;
const CENTRE_LNG = (city.bounds.east + city.bounds.west) / 2;

// One baked bin: its file index, its (declination, hourAngle) grid cell (what a time is mapped on),
// and the sun position (degrees) it stands for.
export interface ShadeBin {
  index: number;
  season: number;
  hourAngle: number;
  elevation: number;
  azimuth: number;
}

export interface ShadeBins {
  edgeCount: number; // must equal the routing graph's edge count
  bins: ShadeBin[];
}

let binsPromise: Promise<ShadeBins> | null = null;

export function loadShadeBins(): Promise<ShadeBins> {
  if (!binsPromise) {
    binsPromise = fetch(BINS_URL)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `${BINS_URL}: ${response.status} ${response.statusText}`,
          );
        }
        return (await response.json()) as ShadeBins;
      })
      .catch((error: unknown) => {
        binsPromise = null; // a failed load must not be memoized
        throw error;
      });
  }
  return binsPromise;
}

// Decode one bin file to its per-edge signed attributes, viewed in place after the 12-byte header
// (Int8Array has no alignment requirement). The header's edge count must match the payload length.
export function decodeShadeBin(buffer: ArrayBuffer): Int8Array {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} shade bin`);
  }
  const edgeCount = view.getUint32(8, true);
  if (HEADER_BYTES + edgeCount !== buffer.byteLength) {
    throw new Error(
      `shade bin edge count ${edgeCount} does not match its ${buffer.byteLength}-byte payload`,
    );
  }
  return new Int8Array(buffer, HEADER_BYTES, edgeCount);
}

const binCache = new Map<number, Promise<Int8Array>>();

export function loadShadeBin(index: number): Promise<Int8Array> {
  const cached = binCache.get(index);
  if (cached) {
    return cached;
  }
  const promise = fetch(binUrl(index))
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `${binUrl(index)}: ${response.status} ${response.statusText}`,
        );
      }
      return decodeShadeBin(await response.arrayBuffer());
    })
    .catch((error: unknown) => {
      binCache.delete(index); // a failed load must not be memoized
      throw error;
    });
  binCache.set(index, promise);
  return promise;
}

// The sun over the city centroid at a given instant, in the same convention shade-layer's currentSun
// uses so both agree on which bin a time maps to.
function sunAt(date: Date): { elevation: number; azimuth: number } {
  const position = sun.getPosition(date, CENTRE_LAT, CENTRE_LNG);
  return {
    elevation: position.altitude,
    azimuth: ((position.azimuth % 360) + 360) % 360,
  };
}

// Resolve `date` to a sun position and write the per-edge signed shade attribute onto the graph. Below
// the horizon there is no shade to bias, so the field is cleared to null / 0. Otherwise the two nearest
// bins are loaded and blended inversely by angular distance (the closer bin weighs more); a convex
// blend of two i8/128 rows keeps |attr| < 1, preserving the cost model's admissibility. Asserts the
// bin manifest's edge count matches the graph's.
export async function computeEdgeShade(
  graph: RoutingGraph,
  date: Date,
): Promise<void> {
  const { edgeCount, bins } = await loadShadeBins();
  if (edgeCount !== graph.edgeCount) {
    throw new Error(
      `shade edge count ${edgeCount} != graph ${graph.edgeCount}`,
    );
  }

  const { elevation, azimuth } = sunAt(date);
  if (elevation <= HORIZON_DEG || bins.length === 0) {
    graph.edgeShadeNow = null;
    graph.maxAbsShadeNow = 0;
    return;
  }

  // Map "now" to the sun's (declination, hourAngle) and blend the two bins straddling that hour angle
  // within the season band, so scrubbing time slides smoothly and monotonically between them. Falls
  // back to the whole set only if the band has no baked bin (it always does while the sun is up).
  const declination = declinationOf(elevation, azimuth, CENTRE_LAT);
  const hourAngle = hourAngleOf(elevation, azimuth, CENTRE_LAT, declination);
  const season = seasonBand(declination);
  const inBand = bins.filter((bin) => bin.season === season);
  const candidates = inBand.length > 0 ? inBand : bins;

  // The two nearest bins by hour-angle distance.
  let nearest = candidates[0];
  let second: ShadeBin | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let secondDistance = Number.POSITIVE_INFINITY;
  for (const bin of candidates) {
    const distance = Math.abs(bin.hourAngle - hourAngle);
    if (distance < nearestDistance) {
      secondDistance = nearestDistance;
      second = nearest;
      nearestDistance = distance;
      nearest = bin;
    } else if (distance < secondDistance) {
      secondDistance = distance;
      second = bin;
    }
  }

  // Inverse-distance blend: each bin's weight is proportional to the OTHER's distance, so the closer
  // bin dominates. A single bin (secondDistance never leaves Infinity), two bins coincident with the
  // sun (total 0), or a missing second all collapse to the nearest — a finite, nonzero total is what
  // keeps the weights from going NaN.
  let nearestWeight: number;
  let secondWeight: number;
  const total = nearestDistance + secondDistance;
  if (second === null || total === 0 || !Number.isFinite(total)) {
    nearestWeight = 1;
    secondWeight = 0;
    second = nearest;
  } else {
    nearestWeight = secondDistance / total;
    secondWeight = nearestDistance / total;
  }

  const [nearestAttr, secondAttr] = await Promise.all([
    loadShadeBin(nearest.index),
    loadShadeBin(second.index),
  ]);

  const shade = new Float32Array(edgeCount);
  let maxAbs = 0;
  for (let edge = 0; edge < edgeCount; edge++) {
    const value =
      (nearestAttr[edge] * nearestWeight + secondAttr[edge] * secondWeight) /
      128;
    shade[edge] = value;
    const magnitude = Math.abs(value);
    if (magnitude > maxAbs) {
      maxAbs = magnitude;
    }
  }
  graph.edgeShadeNow = shade;
  graph.maxAbsShadeNow = maxAbs;
}
