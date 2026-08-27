// The SHDE data: per edge and per sun-position bin, how much of the edge a building shadow covers and
// how much a crown shadow does, so the router can bias toward sun or shade for the resolved time of
// day. A given day's sun only sweeps a handful of the (declination, hourAngle) bins, so the fractions
// ship as one small file PER BIN, fetched lazily on demand, alongside a manifest of the bins.
//
// The bake is pure geometry. The bin's solar intensity is derived here from its elevation, and how
// much light a crown actually stops is SEASONAL — only the client knows the date — so the two
// occlusions are composited here into the signed attribute the cost model wants, the same
// `1 - (1 - buildings)(1 - tau*trees)` the shade overlay composites its two pyramids with.
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
import { activeCity, type City } from "../cities";
import { canopyTau } from "../shade/phenology";
import { declinationOf, hourAngleOf, seasonBand } from "../shade/sun";
import type { RoutingGraph } from "./graph";

const MAGIC = "SHDB";
const FORMAT_VERSION = 2;
const HEADER_BYTES = 12; // magic(4) + u16 version + u16 pad + u32 edgeCount
// Relative, so they pick up the deploy basePath. Per city because a bin index only means a sun
// position alongside the latitude it was synthesised at (scripts/shade-schedule.ts).
const binsUrl = (cityId: string): string => `routing/shade/${cityId}/bins.json`;
const HORIZON_DEG = 0.5; // at or below this the sun is down and there is no shade to bias

// The elapsed-time schedule: sun positions are sampled every SCHEDULE_STEP_SECONDS (the sun moves
// ~1.25° across one step, well under a bin's span) out to SCHEDULE_HORIZON_SECONDS — a walk longer than
// this (~20 km at 1.4 m/s) freezes the sun at the horizon, a negligible tail.
export const SCHEDULE_STEP_SECONDS = 300;
const SCHEDULE_HORIZON_SECONDS = 4 * 3600;
export const SCHEDULE_BUCKETS =
  Math.floor(SCHEDULE_HORIZON_SECONDS / SCHEDULE_STEP_SECONDS) + 1;

// The bucket an elapsed walking time falls in, clamped at the horizon. Shared with the scaffolding
// field (src/routing/sheds.ts), which samples the sun on this same schedule so the two terms cannot
// disagree about where it is at a point in the walk.
export function scheduleBucket(elapsedSeconds: number): number {
  const clamped = elapsedSeconds > 0 ? elapsedSeconds : 0;
  const bucket = Math.round(clamped / SCHEDULE_STEP_SECONDS);
  return bucket < SCHEDULE_BUCKETS ? bucket : SCHEDULE_BUCKETS - 1;
}

const binUrl = (cityId: string, index: number): string =>
  `routing/shade/${cityId}/${index}.bin`;

// suncalc@2.0.1, as the shade overlay consumes it: altitude/azimuth as the layer's currentSun reads
// them, azimuth a compass bearing normalised to [0, 360).
const sun = SunCalc as unknown as {
  getPosition: (
    date: Date,
    lat: number,
    lng: number,
  ) => { altitude: number; azimuth: number };
};

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

// One bin's baked occlusion, `fraction = byte / 255`: per edge, the share of its polyline the bin's
// building shadows cover and the share its crown shadows do.
export interface BinFractions {
  buildings: Uint8Array;
  trees: Uint8Array;
}

// A bin's solar intensity, the same `max(0, sin(elevation))` the tile bake folds into its alpha —
// derived rather than shipped, since bins.json already carries the elevation.
function intensityOf(bin: ShadeBin): number {
  return Math.max(0, Math.sin((bin.elevation * Math.PI) / 180));
}

// The i8 a composited row stores, read back as `attr = byte / 128`. The magnitude is capped at 127
// (never -128), so `|attr| <= 127/128 < 1` keeps the cost model's `1 - w*attr` strictly positive for
// `|w| <= 1`.
function encodeAttr(attr: number): number {
  return Math.max(-127, Math.min(127, Math.round(attr * 128)));
}

// The per-edge signed shade attribute a route is costed against, as a function of how long into the
// walk the edge is reached. `attrAt` returns a value in (-1, 1) — positive net sunlit, negative net
// shaded; `maxAbs` bounds |attr| over every edge and elapsed time the field can return, the input to
// the cost model's admissible clip floor. `intensityAt` is the sun's strength at that point in the
// walk — what a fully sunlit edge reads and, negated, what a fully shaded one does — so a caller with
// its own opaque cover (a scaffolding deck) can composite it into the attribute.
export interface ShadeField {
  attrAt(edge: number, elapsedSeconds: number): number;
  intensityAt(elapsedSeconds: number): number;
  readonly maxAbs: number;
}

// The route-time field: a blend of two hour-angle-nearest bins per elapsed-time bucket. Holds only the
// referenced bins' fractions and the bucket tables it needs — not the graph — so it doesn't pin a
// large scope.
class ScheduledShadeField implements ShadeField {
  // Each referenced bin's composited signed row, built on first use and kept: A* reads an edge's
  // attribute in its innermost loop, so the composite cannot live in `attrAt`. Tau ties a row to the
  // departure date, so the field computeEdgeShade builds for a new date is what retires them.
  private readonly rows: (Int8Array | null)[];

  constructor(
    private readonly fractions: BinFractions[], // the referenced bins, in bucket-reference order
    private readonly intensities: Float64Array, // per referenced bin, its solar intensity
    private readonly tau: number, // the share of direct light a crown stops on the departure date
    private readonly binA: Int32Array, // per bucket: index into `fractions`, or -1 for a night bucket
    private readonly binB: Int32Array, // per bucket: the second blended bin's index into `fractions`
    private readonly weightA: Float64Array, // per bucket: bin A's blend weight, already divided by 128
    private readonly weightB: Float64Array, // per bucket: bin B's blend weight, already divided by 128
    private readonly blended: Float64Array, // per bucket: the blended solar intensity, 0 at night
    readonly maxAbs: number,
  ) {
    this.rows = fractions.map(() => null);
  }

  intensityAt(elapsedSeconds: number): number {
    return this.blended[scheduleBucket(elapsedSeconds)];
  }

  attrAt(edge: number, elapsedSeconds: number): number {
    const bucket = scheduleBucket(elapsedSeconds);
    const indexA = this.binA[bucket];
    if (indexA < 0) {
      return 0; // the sun is down at this point in the walk
    }
    const indexB = this.binB[bucket];
    const rowA = this.rows[indexA] ?? this.composite(indexA);
    const rowB = this.rows[indexB] ?? this.composite(indexB);
    return (
      rowA[edge] * this.weightA[bucket] + rowB[edge] * this.weightB[bucket]
    );
  }

  // One bin's signed attributes. A crown stops only tau of the light a building stops outright, and
  // what reaches the edge is what gets past BOTH, so the two occlusions compose as
  // `1 - (1 - buildings)(1 - tau*trees)`; the bin's intensity then scales the sunlit-positive,
  // shaded-negative attribute.
  private composite(index: number): Int8Array {
    const { buildings, trees } = this.fractions[index];
    const intensity = this.intensities[index];
    const row = new Int8Array(buildings.length);
    for (let edge = 0; edge < row.length; edge++) {
      const shaded =
        1 - (1 - buildings[edge] / 255) * (1 - (this.tau * trees[edge]) / 255);
      row[edge] = encodeAttr(intensity * (1 - 2 * shaded));
    }
    this.rows[index] = row;
    return row;
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

  // A fully sunlit edge is what the field's peak magnitude stands for, so that is its sun strength —
  // and taking it from maxAbs keeps a composited attribute inside the bound the clip floor uses.
  intensityAt(): number {
    return this.maxAbs;
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

const binsPromises = new Map<string, Promise<ShadeBins>>();

export function loadShadeBins(
  cityId: string = activeCity().id,
): Promise<ShadeBins> {
  const cached = binsPromises.get(cityId);
  if (cached) {
    return cached;
  }
  const url = binsUrl(cityId);
  const promise = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as ShadeBins;
    })
    .catch((error: unknown) => {
      binsPromises.delete(cityId); // a failed load must not be memoized
      throw error;
    });
  binsPromises.set(cityId, promise);
  return promise;
}

// Decode one bin file to its two per-edge fraction rows, buildings then trees, viewed in place after
// the 12-byte header (Uint8Array has no alignment requirement). The header's edge count must match
// the payload length.
export function decodeShadeBin(buffer: ArrayBuffer): BinFractions {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} shade bin`);
  }
  const edgeCount = view.getUint32(8, true);
  if (HEADER_BYTES + 2 * edgeCount !== buffer.byteLength) {
    throw new Error(
      `shade bin edge count ${edgeCount} does not match its ${buffer.byteLength}-byte payload`,
    );
  }
  return {
    buildings: new Uint8Array(buffer, HEADER_BYTES, edgeCount),
    trees: new Uint8Array(buffer, HEADER_BYTES + edgeCount, edgeCount),
  };
}

// Keyed by city as well as index: the same index is a different sun position in another city.
const binCache = new Map<string, Promise<BinFractions>>();

// A bin is 1.2 MB in New York and a city has around sixty of them, so remembering every bin the clock
// has ever crossed is seventy megabytes on a device that is already carrying the graph.
//
// EIGHT is what one schedule takes at its worst, not a bin more: replaying `selectBlend` over every
// bucket of the four-hour schedule for a departure every five minutes through a year, against both
// cities' baked bins.json, the referenced set reaches 8 on 19 departures in New York (worst
// 2026-04-09 15:25 UTC) and 42 in San Francisco (2026-02-05 20:20 UTC), where the declination crosses
// a season-band boundary mid-walk and the schedule straddles two bands' worth of bins.
//
// So eight held ONE schedule and evicted the previous one entirely, which is the wrong thing to
// forget: scrubbing the clock between two times of day is the gesture this cache exists for, and at
// eight, three round trips between 10:00 and 15:45 cost 27 fetches against the 9 an unbounded cache
// pays. Sixteen is two whole schedules — about 20 MB of New York, 3 MB of San Francisco — so a scrub
// back to where the reader just was refetches nothing.
const CACHE_BINS = 16;

export function loadShadeBin(
  index: number,
  cityId: string = activeCity().id,
): Promise<BinFractions> {
  const key = `${cityId}:${index}`;
  const cached = binCache.get(key);
  if (cached) {
    // Map iterates in insertion order, so re-inserting is what makes the eviction below an LRU.
    binCache.delete(key);
    binCache.set(key, cached);
    return cached;
  }
  const url = binUrl(cityId, index);
  const promise = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return decodeShadeBin(await response.arrayBuffer());
    })
    .catch((error: unknown) => {
      // A failed load must not be memoized — but only THIS one. The LRU can have evicted a stalled
      // fetch and a second fetch of the same bin have succeeded in the meantime, and deleting by key
      // alone would then throw away the good entry.
      if (binCache.get(key) === promise) {
        binCache.delete(key);
      }
      throw error;
    });
  binCache.set(key, promise);
  for (const oldest of binCache.keys()) {
    if (binCache.size <= CACHE_BINS) {
      break;
    }
    binCache.delete(oldest);
  }
  return promise;
}

// The sun over the city centroid at a given instant, in the same convention shade-layer's currentSun
// uses so both agree on which bin a time maps to. Degrees; azimuth a compass bearing in [0, 360).
export function sunAt(
  date: Date,
  centre: { lat: number; lng: number } = activeCity().center,
): { elevation: number; azimuth: number } {
  const { lat, lng } = centre;
  const position = sun.getPosition(date, lat, lng);
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
  centreLat: number,
): ShadeBlend | null {
  if (elevation <= HORIZON_DEG) {
    return null;
  }
  const declination = declinationOf(elevation, azimuth, centreLat);
  const hourAngle = hourAngleOf(elevation, azimuth, centreLat, declination);
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

// Intern a bin into the referenced-bins order, returning its position; used so the schedule stores
// small positional indices and only the referenced bins are fetched.
function intern(
  positions: Map<number, number>,
  order: ShadeBin[],
  bin: ShadeBin,
): number {
  const existing = positions.get(bin.index);
  if (existing !== undefined) {
    return existing;
  }
  const position = order.length;
  positions.set(bin.index, position);
  order.push(bin);
  return position;
}

// Build the graph's route-time shade field for a departure instant. Samples the sun across elapsed
// walking time, blending the two hour-angle-nearest bins per bucket, and fetches only the bins any
// bucket references. Clears the field when the departure and the whole horizon are below the horizon
// (nothing to bias) or no bins are baked. Asserts the bin manifest's edge count matches the graph's.
export async function computeEdgeShade(
  graph: RoutingGraph,
  date: Date,
  forCity: City = activeCity(),
): Promise<void> {
  // The city is read ONCE, here, and threaded through every step below. Read per step it would be
  // read after an await: switching city mid-fetch then pulls the new city's bins and blends them into
  // the graph this call was handed, and `loadRouting` memoizes that graph for the session, so nothing
  // ever rebuilds it. The same reasoning the route search states for `routeCity`.
  const { edgeCount, bins } = await loadShadeBins(forCity.id);
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

  const binA = new Int32Array(SCHEDULE_BUCKETS).fill(-1); // -1 marks a night bucket
  const binB = new Int32Array(SCHEDULE_BUCKETS);
  const weightA = new Float64Array(SCHEDULE_BUCKETS);
  const weightB = new Float64Array(SCHEDULE_BUCKETS);
  // The bucket's own sun strength, 0 through the night.
  const blended = new Float64Array(SCHEDULE_BUCKETS);
  const positions = new Map<number, number>();
  const order: ShadeBin[] = []; // the referenced bins, the axis of the field's rows
  let anyDay = false;
  for (let bucket = 0; bucket < SCHEDULE_BUCKETS; bucket++) {
    const when = new Date(
      date.getTime() + bucket * SCHEDULE_STEP_SECONDS * 1000,
    );
    const { elevation, azimuth } = sunAt(when, forCity.center);
    const blend = selectBlend(bins, elevation, azimuth, forCity.center.lat);
    if (!blend) {
      continue; // night bucket: binA stays -1, attrAt returns 0
    }
    anyDay = true;
    binA[bucket] = intern(positions, order, blend.nearest);
    binB[bucket] = intern(positions, order, blend.second);
    weightA[bucket] = blend.nearestWeight / 128;
    weightB[bucket] = blend.secondWeight / 128;
    // Quantized exactly as a row's fully-sunlit entry is, so a composited attribute can never leave
    // the [-maxAbs, maxAbs] the clip floor is computed from.
    blended[bucket] =
      (blend.nearestWeight * encodeAttr(intensityOf(blend.nearest)) +
        blend.secondWeight * encodeAttr(intensityOf(blend.second))) /
      128;
  }
  if (!anyDay) {
    graph.shade = null;
    return;
  }

  const fractions = await Promise.all(
    order.map((bin) => loadShadeBin(bin.index, forCity.id)),
  );
  const intensities = Float64Array.from(order, intensityOf);
  // |1 - 2*shaded| <= 1, so a bin's attributes cannot exceed its intensity in magnitude, and the
  // encoding caps that below 1. A bound is all the admissible heuristic needs, and this one is all but
  // exact: some edge in a city is fully sunlit in every bin.
  let maxAbs = 0;
  for (const [position, row] of fractions.entries()) {
    if (row.buildings.length !== edgeCount) {
      throw new Error(
        `shade bin edge count ${row.buildings.length} != graph ${edgeCount}`,
      );
    }
    maxAbs = Math.max(maxAbs, encodeAttr(intensities[position]) / 128);
  }
  graph.shade = new ScheduledShadeField(
    fractions,
    intensities,
    canopyTau(date),
    binA,
    binB,
    weightA,
    weightB,
    blended,
    maxAbs,
  );
}
