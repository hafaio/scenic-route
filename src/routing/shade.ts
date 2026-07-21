// The SHDE data: a per-edge signed sun/shade attribute baked for a grid of sun positions, so the
// router can bias toward sun or shade for the resolved time of day. A given day's sun only sweeps a
// handful of the (declination, hourAngle) bins, so the attributes ship as one small file PER BIN,
// fetched lazily on demand, alongside a manifest of the bins.
//
// A route is not walked at a single instant: the sun keeps moving as you go, and on a long walk the
// shadows at the far end differ from those at the start. So `computeEdgeShade` does not resolve one sun
// position — it builds a `ShadeField`, a schedule of blended bins across ELAPSED WALKING TIME from the
// departure instant. The router asks the field for an edge's attribute at the elapsed time it reaches
// that edge, so a metre walked an hour in is costed against the sun an hour later. Below the horizon at
// some elapsed time there is no shade to bias, so the field returns 0 there; a departure already past
// sunset yields no field at all. The bin selection mirrors components/shade-layer.tsx (both via
// src/shade/sun.ts), so the router agrees with the shade overlay at the departure instant.

import * as SunCalc from "suncalc";
import { declinationOf, hourAngleOf, seasonBand } from "../shade/sun";
import manifest from "../tree-cover/manifest.json";
import type { RoutingGraph } from "./graph";

const MAGIC = "SHDB";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 12; // magic(4) + u16 version + u16 pad + u32 edgeCount
const BINS_URL = "routing/shade/bins.json"; // relative, so it picks up the deploy basePath
const HORIZON_DEG = 0.5; // at or below this the sun is down and there is no shade to bias

// The elapsed-time schedule: sun positions are sampled every SCHEDULE_STEP_SECONDS (the sun moves
// ~1.25° across one step, well under a bin's span) out to SCHEDULE_HORIZON_SECONDS — a walk longer than
// this (~20 km at 1.4 m/s) freezes the sun at the horizon, a negligible tail.
const SCHEDULE_STEP_SECONDS = 300;
const SCHEDULE_HORIZON_SECONDS = 4 * 3600;

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

// The per-edge signed shade attribute a route is costed against, as a function of how long into the
// walk the edge is reached. `attrAt` returns a value in (-1, 1) — positive net sunlit, negative net
// shaded; `maxAbs` bounds |attr| over every edge and elapsed time the field can return, the input to
// the cost model's admissible clip floor.
export interface ShadeField {
  attrAt(edge: number, elapsedSeconds: number): number;
  readonly maxAbs: number;
}

// The route-time field: a blend of two hour-angle-nearest bins per elapsed-time bucket. Holds only the
// referenced bin rows and the bucket tables it needs — not the graph — so it doesn't pin a large scope.
class ScheduledShadeField implements ShadeField {
  constructor(
    private readonly attrs: Int8Array[], // the referenced bin rows, in bucket-reference order
    private readonly binA: Int32Array, // per bucket: index into `attrs`, or -1 for a night bucket
    private readonly binB: Int32Array, // per bucket: the second blended bin's index into `attrs`
    private readonly weightA: Float64Array, // per bucket: bin A's blend weight, already divided by 128
    private readonly weightB: Float64Array, // per bucket: bin B's blend weight, already divided by 128
    private readonly lastBucket: number, // clamp elapsed time to this bucket (the schedule horizon)
    readonly maxAbs: number,
  ) {}

  attrAt(edge: number, elapsedSeconds: number): number {
    const clamped = elapsedSeconds > 0 ? elapsedSeconds : 0;
    let bucket = Math.round(clamped / SCHEDULE_STEP_SECONDS);
    if (bucket > this.lastBucket) {
      bucket = this.lastBucket;
    }
    const indexA = this.binA[bucket];
    if (indexA < 0) {
      return 0; // the sun is down at this point in the walk
    }
    return (
      this.attrs[indexA][edge] * this.weightA[bucket] +
      this.attrs[this.binB[bucket]][edge] * this.weightB[bucket]
    );
  }
}

// A time-invariant field over already-decoded signed floats in (-1, 1), for tests and any caller that
// wants a fixed sun position rather than a walk-length schedule.
class ConstantShadeField implements ShadeField {
  constructor(
    private readonly attrs: Float32Array,
    readonly maxAbs: number,
  ) {}

  attrAt(edge: number): number {
    return this.attrs[edge];
  }
}

export function constantShadeField(attrs: Float32Array): ShadeField {
  let maxAbs = 0;
  for (const value of attrs) {
    const magnitude = Math.abs(value);
    if (magnitude > maxAbs) {
      maxAbs = magnitude;
    }
  }
  return new ConstantShadeField(attrs, maxAbs);
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

// The two bins straddling a sun position by hour angle within its season band, and their inverse-
// distance blend weights (each proportional to the OTHER's distance, so the closer bin dominates; they
// sum to 1). A single bin, coincident bins, or a missing second all collapse to the nearest. Falls
// back to the whole set only if the band has no baked bin (it always does while the sun is up). Null
// when the given position is at or below the horizon.
interface ShadeBlend {
  nearest: ShadeBin;
  second: ShadeBin;
  nearestWeight: number;
  secondWeight: number;
}

function selectBlend(
  bins: ShadeBin[],
  elevation: number,
  azimuth: number,
): ShadeBlend | null {
  if (elevation <= HORIZON_DEG) {
    return null;
  }
  const declination = declinationOf(elevation, azimuth, CENTRE_LAT);
  const hourAngle = hourAngleOf(elevation, azimuth, CENTRE_LAT, declination);
  const season = seasonBand(declination);
  const inBand = bins.filter((bin) => bin.season === season);
  const candidates = inBand.length > 0 ? inBand : bins;

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

  const total = nearestDistance + secondDistance;
  if (second === null || total === 0 || !Number.isFinite(total)) {
    return { nearest, second: nearest, nearestWeight: 1, secondWeight: 0 };
  }
  return {
    nearest,
    second,
    nearestWeight: secondDistance / total,
    secondWeight: nearestDistance / total,
  };
}

// Intern a bin index into the referenced-rows order, returning its position; used so the schedule
// stores small positional indices and only the referenced bin rows are fetched.
function intern(
  positions: Map<number, number>,
  order: number[],
  index: number,
): number {
  const existing = positions.get(index);
  if (existing !== undefined) {
    return existing;
  }
  const position = order.length;
  positions.set(index, position);
  order.push(index);
  return position;
}

// Build the graph's route-time shade field for a departure instant. Samples the sun across elapsed
// walking time, blending the two hour-angle-nearest bins per bucket, and fetches only the bins any
// bucket references. Clears the field when the departure and the whole horizon are below the horizon
// (nothing to bias) or no bins are baked. Asserts the bin manifest's edge count matches the graph's.
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
  if (bins.length === 0) {
    graph.shade = null;
    return;
  }
  // A stale or pre-season/hourAngle bake passes the edge-count check but lacks the fields selectBlend
  // keys on: the season filter empties and every hour-angle distance is NaN, so it silently collapses to
  // bins[0] (the faintest near-horizon bin) at every time — the slider goes inert. Fail loudly instead.
  for (const bin of bins) {
    if (!Number.isFinite(bin.hourAngle) || !Number.isInteger(bin.season)) {
      throw new Error(
        "shade bins.json lacks season/hourAngle (stale artifact?) — rebuild public/routing/shade",
      );
    }
  }

  const lastBucket = Math.floor(
    SCHEDULE_HORIZON_SECONDS / SCHEDULE_STEP_SECONDS,
  );
  const bucketCount = lastBucket + 1;
  const binA = new Int32Array(bucketCount).fill(-1); // -1 marks a night bucket
  const binB = new Int32Array(bucketCount);
  const weightA = new Float64Array(bucketCount);
  const weightB = new Float64Array(bucketCount);
  const positions = new Map<number, number>();
  const order: number[] = []; // bin indices in reference order, the axis of `attrs`
  let anyDay = false;
  for (let bucket = 0; bucket <= lastBucket; bucket++) {
    const when = new Date(
      date.getTime() + bucket * SCHEDULE_STEP_SECONDS * 1000,
    );
    const { elevation, azimuth } = sunAt(when);
    const blend = selectBlend(bins, elevation, azimuth);
    if (!blend) {
      continue; // night bucket: binA stays -1, attrAt returns 0
    }
    anyDay = true;
    binA[bucket] = intern(positions, order, blend.nearest.index);
    binB[bucket] = intern(positions, order, blend.second.index);
    weightA[bucket] = blend.nearestWeight / 128;
    weightB[bucket] = blend.secondWeight / 128;
  }
  if (!anyDay) {
    graph.shade = null;
    return;
  }

  const attrs = await Promise.all(order.map(loadShadeBin));
  let maxAbs = 0;
  for (const row of attrs) {
    if (row.length !== edgeCount) {
      throw new Error(
        `shade bin edge count ${row.length} != graph ${edgeCount}`,
      );
    }
    for (let edge = 0; edge < row.length; edge++) {
      const magnitude = Math.abs(row[edge]);
      if (magnitude > maxAbs) {
        maxAbs = magnitude;
      }
    }
  }
  graph.shade = new ScheduledShadeField(
    attrs,
    binA,
    binB,
    weightA,
    weightB,
    lastBucket,
    maxAbs / 128,
  );
}
