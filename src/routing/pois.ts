// The scenic POI sets (landmarks, public art) as points with names, and the test for which ones a
// route passes. Shares the LMRK/ARTW point layout the map overlay reads, but keeps only the flat
// arrays the directions need — no spatial buckets. Pure data + geometry; no React or Leaflet.

import type { RoutingGraph } from "./graph";
import { edgePath } from "./graph";
import type { RouteResult } from "./search";

export type PoiKind = "landmark" | "art";

export interface PoiSet {
  lngs: Float64Array;
  lats: Float64Array;
  names: string[]; // per point, its label ("" when the source named none)
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

// Decode the shared point layout (magic LMRK / ARTW): a 40-byte header, per-point zigzag-varint
// (lng, lat) deltas, then the trailing name blob (u16 length + UTF-8 per point). Mirrors
// crates/tiler/src/binfmt.rs read_points plus the client-only name blob.
export function decodePois(buffer: ArrayBuffer, magic: string): PoiSet {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const found = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (found !== magic) {
    throw new Error(`not a ${magic} point blob`);
  }
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let point = 0; point < count; point++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lngs[point] = originLng + quantizedX * scale;
    lats[point] = originLat + quantizedY * scale;
  }
  const decoder = new TextDecoder();
  const names: string[] = new Array(count);
  for (let point = 0; point < count; point++) {
    const length = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    names[point] = decoder.decode(
      bytes.subarray(cursor.offset, cursor.offset + length),
    );
    cursor.offset += length;
  }
  return { lngs, lats, names };
}

const cache = new Map<string, Promise<PoiSet>>();

export function loadPois(url: string, magic: string): Promise<PoiSet> {
  const pending = cache.get(url);
  if (pending) {
    return pending;
  }
  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return decodePois(await response.arrayBuffer(), magic);
    })
    .catch((error: unknown) => {
      cache.delete(url);
      throw error;
    });
  cache.set(url, request);
  return request;
}

// One POI the route passes: which step it is nearest (so it slots under the right maneuver) and how
// far along the whole route the nearest point is (so a cluster lists in the order you reach them).
export interface PassedPoi {
  name: string;
  kind: PoiKind;
  stepIndex: number;
  alongMeters: number;
  at: { lat: number; lng: number };
}

const METERS_PER_DEGREE_LAT = 111_320;

// Metres from a point to a segment, in a local flat approximation (the legs are short and the whole
// thing is a proximity test, so the equirectangular error is negligible). Also returns the clamped
// projection parameter `t` in [0, 1], so the caller can place the nearest point along the polyline.
function pointSegmentMeters(
  lat: number,
  lng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
  metersPerLng: number,
): { distance: number; t: number } {
  const px = (lng - aLng) * metersPerLng;
  const py = (lat - aLat) * METERS_PER_DEGREE_LAT;
  const dx = (bLng - aLng) * metersPerLng;
  const dy = (bLat - aLat) * METERS_PER_DEGREE_LAT;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared > 0
      ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared))
      : 0;
  return { distance: Math.hypot(px - t * dx, py - t * dy), t };
}

// The POIs a route passes: those within a set's `thresholdMeters` of any route step's walked polyline
// — "adjacent", the sidewalk the fan-out reached from. The threshold is per set because a landmark's
// point is its lot centroid, which for a big building sits well back from the frontage you walk past,
// while an artwork is a precise point; landmarks want the wider radius. Each POI is tagged with its
// nearest step so the directions insert it in order, kept once, and unnamed points are skipped.
// Route ferry steps are ignored (nobody passes a landmark mid-crossing).
export function passedPois(
  graph: RoutingGraph,
  result: RouteResult,
  sets: readonly { kind: PoiKind; set: PoiSet; thresholdMeters: number }[],
): PassedPoi[] {
  const { lats, lngs } = result.path;
  if (lats.length === 0) {
    return [];
  }
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < lats.length; vertex++) {
    south = Math.min(south, lats[vertex]);
    north = Math.max(north, lats[vertex]);
    west = Math.min(west, lngs[vertex]);
    east = Math.max(east, lngs[vertex]);
  }
  const centreLat = (south + north) / 2;
  const metersPerLng =
    METERS_PER_DEGREE_LAT * Math.cos((centreLat * Math.PI) / 180);
  const maxThreshold = sets.reduce(
    (largest, entry) => Math.max(largest, entry.thresholdMeters),
    0,
  );
  const marginLat = maxThreshold / METERS_PER_DEGREE_LAT;
  const marginLng = maxThreshold / metersPerLng;

  // The walked polyline of each step (ferries skipped) in travel order, with the cumulative metre
  // distance to each vertex, so a POI's nearest point can be placed along the route. Computed once.
  const stepPolys: ({
    lngs: number[];
    lats: number[];
    cum: number[];
    total: number;
  } | null)[] = result.steps.map((step) => {
    if (step.kind === "ferry") {
      return null;
    }
    const { lngs: edgeLngs, lats: edgeLats } = edgePath(graph, step.edge);
    const polyLngs = step.forward
      ? Array.from(edgeLngs)
      : Array.from(edgeLngs).reverse();
    const polyLats = step.forward
      ? Array.from(edgeLats)
      : Array.from(edgeLats).reverse();
    const cum = new Array<number>(polyLngs.length);
    cum[0] = 0;
    for (let vertex = 1; vertex < polyLngs.length; vertex++) {
      const dx = (polyLngs[vertex] - polyLngs[vertex - 1]) * metersPerLng;
      const dy =
        (polyLats[vertex] - polyLats[vertex - 1]) * METERS_PER_DEGREE_LAT;
      cum[vertex] = cum[vertex - 1] + Math.hypot(dx, dy);
    }
    return { lngs: polyLngs, lats: polyLats, cum, total: cum[cum.length - 1] };
  });

  // Cumulative walked length before each step, so a within-step fraction maps to a route distance.
  const stepStart = new Array<number>(result.steps.length);
  let running = 0;
  for (let step = 0; step < result.steps.length; step++) {
    stepStart[step] = running;
    running += result.steps[step].lengthMeters;
  }

  const passed: PassedPoi[] = [];
  for (const { kind, set, thresholdMeters } of sets) {
    for (let point = 0; point < set.names.length; point++) {
      const name = set.names[point];
      if (!name) {
        continue;
      }
      const lat = set.lats[point];
      const lng = set.lngs[point];
      if (
        lat < south - marginLat ||
        lat > north + marginLat ||
        lng < west - marginLng ||
        lng > east + marginLng
      ) {
        continue;
      }
      let best = Number.POSITIVE_INFINITY;
      let bestStep = -1;
      let bestAlong = 0;
      for (let step = 0; step < stepPolys.length; step++) {
        const poly = stepPolys[step];
        if (!poly) {
          continue;
        }
        for (let vertex = 1; vertex < poly.lngs.length; vertex++) {
          const { distance, t } = pointSegmentMeters(
            lat,
            lng,
            poly.lats[vertex - 1],
            poly.lngs[vertex - 1],
            poly.lats[vertex],
            poly.lngs[vertex],
            metersPerLng,
          );
          if (distance < best) {
            best = distance;
            bestStep = step;
            const alongPoly =
              poly.cum[vertex - 1] +
              t * (poly.cum[vertex] - poly.cum[vertex - 1]);
            const fraction = poly.total > 0 ? alongPoly / poly.total : 0;
            bestAlong =
              stepStart[step] + fraction * result.steps[step].lengthMeters;
          }
        }
      }
      if (bestStep >= 0 && best <= thresholdMeters) {
        passed.push({
          name,
          kind,
          stepIndex: bestStep,
          alongMeters: bestAlong,
          at: { lat, lng },
        });
      }
    }
  }
  return passed;
}
