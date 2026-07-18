// `bun run scripts/ferries.ts` (and, in the full pipeline, build-tree-data): downloads the two NYC
// ferry GTFS feeds, collapses their whole schedule into one time-independent ferry graph, and
// writes it as data/ferries/nyc.bin (magic FERR). It also freezes the raw feed zips under
// data/ferries/ so a later time-of-day pass can re-derive from the exact feeds this build read.
//
// Time-independence: every trip is cut into consecutive-stop segments; a segment's crossing time is
// the median trip-over-trip of (arrival at the next stop − departure at this one), and its wait is
// half the median departure headway, capped at ten minutes. The two sum to the one rawTimeSeconds
// the artifact carries — the number a later phase's discount multiplies. Nothing here touches the
// routing graph: stops stay in geographic coordinates, unsnapped. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COORD_SCALE, writeVarint, zigzag } from "./geometry";
import { fetchGtfsZip, type GtfsFeed, parseGtfs } from "./gtfs";
import type { Coord } from "./socrata";

interface FeedSource {
  id: string; // namespaces stop ids, so the two feeds' stop ids cannot collide
  name: string;
  zipFile: string; // the frozen raw feed, committed under data/ferries/
  url: string;
  cacheKey: string;
}

// The two feeds, both verified reachable. SI Ferry is NYC DOT's own download (behind an Akamai
// edge that needs a browser User-Agent); NYC Ferry is Hornblower's feed served through Connexionz.
const FEEDS: readonly FeedSource[] = [
  {
    id: "si",
    name: "Staten Island Ferry",
    zipFile: "siferry-gtfs.zip",
    url: "https://www.nyc.gov/html/dot/downloads/misc/siferry-gtfs.zip",
    cacheKey: "gtfs-siferry",
  },
  {
    id: "nyc",
    name: "NYC Ferry",
    zipFile: "nycferry-gtfs.zip",
    url: "https://nycferry.connexionz.net/rtt/public/utility/gtfs.aspx",
    cacheKey: "gtfs-nycferry",
  },
];

const DATA_DIR = join(import.meta.dirname, "..", "data");
const FERRY_DIR = join(DATA_DIR, "ferries");
const FERRY_FORMAT = 2;
const FERRY_MAGIC = "FERR";
const NO_ROUTE_NAME = 0xffff; // a segment's routeNameId when no route name is known (defensive)
const FERRY_HEADER_BYTES = 56;
const FERRY_STOP_BYTES = 12;
const FERRY_SEGMENT_BYTES = 20;
const NO_GEOMETRY = 0xffffffff; // a segment's geometry offset when it is a straight A→B line
const WAIT_CAP_SECONDS = 600; // half a headway is charged as wait, but never more than 10 minutes
const KEY_SEPARATOR = "|"; // joins a stop pair into a segment key; a stop key has no NUL
const FERRY_ROUTE_TYPE = "4"; // GTFS route_type; the NYC Ferry feed also carries shuttle buses (3)

// Stops dropped for now: the Rockaway peninsula is not connected to the rest of the routable
// walking network (its bridges' pedestrian status is unmodeled), so a ferry-only stub there routes
// nowhere. Revisit once that connection exists — Phase 2's snapping should own this once it can see
// graph connectivity.
const EXCLUDED_STOP_NAMES = new Set(["Rockaway"]);

// One consolidated stop, in geographic coordinates with its GTFS name — deliberately NOT snapped
// to the routing graph (that is Phase 2). `key` is `${feed}:${stopId}`, unique across both feeds.
interface Stop extends Coord {
  key: string;
  name: string;
}

// One time-independent ferry segment: an unordered stop pair, the single combined crossing-plus-
// wait time, and the drawing polyline (the shape sub-path between the two stops, else null for a
// straight line). Oriented from `stopA` to `stopB`, the lexicographically smaller stop key first.
interface Segment {
  stopA: string;
  stopB: string;
  rawTimeSeconds: number;
  medianCrossingSeconds: number; // kept for the ingest log, not written to the artifact
  headwaySeconds: number; // Infinity when the segment is served by single trips only
  geometry: Coord[] | null;
  routeName: string | null; // the primary route's display name (most trips on this stop pair)
}

function toSeconds(clock: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(clock.trim());
  if (!match) {
    return null;
  } else {
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  } else {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
}

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// The service_ids that run a regular week and whose date range covers the reference date. This
// drops an expired or not-yet-started feed, and the all-zero-mask services (SI Ferry's `holiday`
// and `threeboat`) that calendar_dates only substitutes in on specific dates — they are atypical,
// so they do not shape the time-independent graph. calendar_dates is read only to confirm it adds
// no otherwise-inactive regular service, which for both current feeds it does not.
function activeServices(feed: GtfsFeed, referenceDate: number): Set<string> {
  const active = new Set<string>();
  for (const row of feed.calendar) {
    const start = Number(row.start_date);
    const end = Number(row.end_date);
    const runsAWeekday = WEEKDAYS.some((day) => row[day] === "1");
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= referenceDate &&
      referenceDate <= end &&
      runsAWeekday
    ) {
      active.add(row.service_id);
    }
  }
  return active;
}

function groupBy<Row>(
  rows: Row[],
  key: (row: Row) => string,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) {
      group.push(row);
    } else {
      groups.set(key(row), [row]);
    }
  }
  return groups;
}

// The index of the shape vertex nearest each stop, forced non-decreasing along the stop sequence so
// a sub-path never runs backwards up the shape. shape_dist_traveled is empty in both feeds, so the
// stops are projected by nearest vertex — coarse, but it is only for drawing the leg.
function projectStops(stops: Coord[], shape: Coord[]): number[] {
  const indices: number[] = [];
  let floor = 0;
  for (const stop of stops) {
    let best = floor;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let vertex = floor; vertex < shape.length; vertex++) {
      const deltaLat = shape[vertex].lat - stop.lat;
      const deltaLng = shape[vertex].lng - stop.lng;
      const distance = deltaLat * deltaLat + deltaLng * deltaLng;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
    indices.push(best);
    floor = best;
  }
  return indices;
}

function dropRepeats(points: Coord[]): Coord[] {
  const unique: Coord[] = [];
  for (const point of points) {
    const previous = unique[unique.length - 1];
    if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) {
      unique.push(point);
    }
  }
  return unique;
}

// The shared accumulators the two feeds fold into: the stops seen, the segment records, and the raw
// crossing and departure samples each segment's time is later reduced from. departures nest a
// `${fromStop} ${service}` variant per segment, so a headway gap is only ever taken within one
// service and one direction — a weekday gap is never differenced against a weekend one.
interface Accumulator {
  stops: Map<string, Stop>;
  segments: Map<string, Segment>;
  crossings: Map<string, number[]>;
  departures: Map<string, Map<string, number[]>>;
  // Per segment, the trip count each route (namespaced `${feed}:${routeId}`) contributes to it, so
  // the primary route is the one serving the most trips. `routeNames` maps a route key to its
  // display name (`route_long_name`, else `route_short_name`).
  segmentRoutes: Map<string, Map<string, number>>;
  routeNames: Map<string, string>;
}

interface FerryGraph {
  stops: Stop[];
  segments: Segment[];
  activeRoutes: number;
}

// One feed's contribution to the graph: its active trips cut into consecutive-stop segments, each
// segment's crossing and departure samples accumulated, and one representative shape sub-path kept
// per segment for drawing. Feeds are kept separate — a stop is `${feed}:${id}`, so the two
// St. George berths are not fused here; that conflation is Phase 2's job. Returns the active-route
// count so the ingest can log it.
function consolidate(
  feed: GtfsFeed,
  feedId: string,
  referenceDate: number,
  accumulator: Accumulator,
): number {
  const { stops, segments, crossings, departures, segmentRoutes, routeNames } =
    accumulator;
  const services = activeServices(feed, referenceDate);
  const serviceOf = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.service_id]),
  );
  const shapeOf = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.shape_id]),
  );
  const routeOf = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.route_id]),
  );
  const routeTypeOf = new Map(
    feed.routes.map((route) => [route.route_id, route.route_type]),
  );
  // `route_long_name` reads as a real name in both feeds ("Staten Island Ferry", "East River");
  // `route_short_name` is the bare code ("AS", "ER") or empty, so it is only a fallback.
  const routeDisplayOf = new Map(
    feed.routes.map((route) => [
      route.route_id,
      route.route_long_name?.trim() || route.route_short_name?.trim() || "",
    ]),
  );
  const stopRow = new Map(feed.stops.map((stop) => [stop.stop_id, stop]));

  const shapes = new Map<string, Coord[]>();
  for (const [shapeId, points] of groupBy(feed.shapes, (row) => row.shape_id)) {
    const ordered = points
      .map((row) => ({
        sequence: Number(row.shape_pt_sequence),
        lat: Number(row.shape_pt_lat),
        lng: Number(row.shape_pt_lon),
      }))
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ lat, lng }) => ({ lat, lng }));
    shapes.set(shapeId, ordered);
  }

  const activeRoutes = new Set<string>();
  for (const [tripId, times] of groupBy(feed.stopTimes, (row) => row.trip_id)) {
    const service = serviceOf.get(tripId);
    if (service === undefined || !services.has(service)) {
      continue;
    }
    const route = routeOf.get(tripId);
    if (route === undefined || routeTypeOf.get(route) !== FERRY_ROUTE_TYPE) {
      continue; // skip the feed's shuttle-bus routes; only ferries belong in the ferry graph
    }
    activeRoutes.add(route);
    const ordered = [...times].sort(
      (left, right) => Number(left.stop_sequence) - Number(right.stop_sequence),
    );
    const shape = shapes.get(shapeOf.get(tripId) ?? "");
    const shapeStops = shape
      ? ordered.map((time) => {
          const row = stopRow.get(time.stop_id);
          return { lat: Number(row?.stop_lat), lng: Number(row?.stop_lon) };
        })
      : null;
    const projected =
      shape && shapeStops ? projectStops(shapeStops, shape) : null;

    for (let index = 0; index + 1 < ordered.length; index++) {
      const from = ordered[index];
      const to = ordered[index + 1];
      const departure = toSeconds(from.departure_time);
      const arrival = toSeconds(to.arrival_time);
      if (departure === null || arrival === null) {
        continue;
      }
      const crossing = arrival - departure;
      const fromKey = `${feedId}:${from.stop_id}`;
      const toKey = `${feedId}:${to.stop_id}`;
      if (crossing < 0 || fromKey === toKey) {
        continue;
      }
      const fromName = stopRow.get(from.stop_id)?.stop_name;
      const toName = stopRow.get(to.stop_id)?.stop_name;
      if (
        (fromName !== undefined && EXCLUDED_STOP_NAMES.has(fromName)) ||
        (toName !== undefined && EXCLUDED_STOP_NAMES.has(toName))
      ) {
        continue;
      }
      for (const [key, stopId] of [
        [fromKey, from.stop_id],
        [toKey, to.stop_id],
      ] as const) {
        if (!stops.has(key)) {
          const row = stopRow.get(stopId);
          if (row) {
            stops.set(key, {
              key,
              name: row.stop_name,
              lat: Number(row.stop_lat),
              lng: Number(row.stop_lon),
            });
          }
        }
      }

      const [stopA, stopB] =
        fromKey < toKey ? [fromKey, toKey] : [toKey, fromKey];
      const segmentKey = `${stopA}${KEY_SEPARATOR}${stopB}`;

      // Tally this trip against the segment's route, so the segment can later pick the route that
      // serves the most of its trips as its display name.
      const routeKey = `${feedId}:${route}`;
      routeNames.set(routeKey, routeDisplayOf.get(route) ?? "");
      let routeCounts = segmentRoutes.get(segmentKey);
      if (!routeCounts) {
        routeCounts = new Map<string, number>();
        segmentRoutes.set(segmentKey, routeCounts);
      }
      routeCounts.set(routeKey, (routeCounts.get(routeKey) ?? 0) + 1);

      const crossingList = crossings.get(segmentKey);
      if (crossingList) {
        crossingList.push(crossing);
      } else {
        crossings.set(segmentKey, [crossing]);
      }

      let variants = departures.get(segmentKey);
      if (!variants) {
        variants = new Map<string, number[]>();
        departures.set(segmentKey, variants);
      }
      const variantKey = `${fromKey} ${service}`;
      const departureList = variants.get(variantKey);
      if (departureList) {
        departureList.push(departure);
      } else {
        variants.set(variantKey, [departure]);
      }

      // The first trip to reach a segment with a usable shape sub-path fixes its drawing geometry;
      // a straight leg (no shape) leaves it null until a later trip supplies one.
      const existing = segments.get(segmentKey);
      if (!existing?.geometry) {
        let geometry: Coord[] | null = null;
        if (shape && projected) {
          const lower = Math.min(projected[index], projected[index + 1]);
          const upper = Math.max(projected[index], projected[index + 1]);
          const between = shape.slice(lower, upper + 1);
          const fromCoord = stops.get(fromKey);
          const toCoord = stops.get(toKey);
          if (fromCoord && toCoord) {
            const walk = [fromCoord, ...between, toCoord];
            const oriented = fromKey === stopA ? walk : [...walk].reverse();
            geometry = dropRepeats(oriented);
            if (geometry.length < 2) {
              geometry = null;
            }
          }
        }
        if (existing) {
          existing.geometry = geometry;
        } else {
          segments.set(segmentKey, {
            stopA,
            stopB,
            rawTimeSeconds: 0,
            medianCrossingSeconds: 0,
            headwaySeconds: Number.POSITIVE_INFINITY,
            geometry,
            routeName: null,
          });
        }
      }
    }
  }

  return activeRoutes.size;
}

function buildGraph(
  feeds: { source: FeedSource; feed: GtfsFeed }[],
): FerryGraph {
  const referenceDate = Number(
    new Date().toISOString().slice(0, 10).replace(/-/g, ""),
  );
  const accumulator: Accumulator = {
    stops: new Map<string, Stop>(),
    segments: new Map<string, Segment>(),
    crossings: new Map<string, number[]>(),
    departures: new Map<string, Map<string, number[]>>(),
    segmentRoutes: new Map<string, Map<string, number>>(),
    routeNames: new Map<string, string>(),
  };

  let activeRoutes = 0;
  for (const { source, feed } of feeds) {
    activeRoutes += consolidate(feed, source.id, referenceDate, accumulator);
  }

  for (const [segmentKey, segment] of accumulator.segments) {
    const medianCrossing = median(accumulator.crossings.get(segmentKey) ?? [0]);
    // Pool every service's and direction's consecutive-departure gaps; their median is the
    // segment's combined headway. A segment only ever served by single trips has no gap, so its
    // wait falls back to the cap.
    const gaps: number[] = [];
    for (const times of accumulator.departures.get(segmentKey)?.values() ??
      []) {
      const sorted = [...times].sort((left, right) => left - right);
      for (let index = 1; index < sorted.length; index++) {
        gaps.push(sorted[index] - sorted[index - 1]);
      }
    }
    const headway = gaps.length > 0 ? median(gaps) : Number.POSITIVE_INFINITY;
    segment.medianCrossingSeconds = medianCrossing;
    segment.headwaySeconds = headway;
    segment.rawTimeSeconds =
      medianCrossing + Math.min(headway / 2, WAIT_CAP_SECONDS);

    // The primary route: the one serving the most of this segment's trips, ties broken by the
    // smaller route key so the choice is deterministic across runs.
    const routeCounts = accumulator.segmentRoutes.get(segmentKey);
    let bestRouteKey: string | null = null;
    let bestCount = -1;
    for (const [routeKey, count] of routeCounts ?? []) {
      const better =
        count > bestCount ||
        (count === bestCount &&
          bestRouteKey !== null &&
          routeKey < bestRouteKey);
      if (better) {
        bestRouteKey = routeKey;
        bestCount = count;
      }
    }
    const routeName = bestRouteKey
      ? (accumulator.routeNames.get(bestRouteKey) ?? "")
      : "";
    segment.routeName = routeName === "" ? null : routeName;
  }

  return {
    stops: [...accumulator.stops.values()].sort((left, right) =>
      left.key < right.key ? -1 : 1,
    ),
    segments: [...accumulator.segments.values()],
    activeRoutes,
  };
}

// Writes the graph as FERR v2: a header, a stop table (quantized lng/lat + a name-table index), a
// segment table (two stop indices, the raw time, a geometry pointer, and the primary route's name
// id), a varint geometry blob, and a trailing name blob (stop names and route names together). All
// little-endian, coordinates quantized to COORD_SCALE about the south-west origin, exactly as the
// sibling sources. Layout: scripts/README.md.
function encodeFerries(graph: FerryGraph): Uint8Array {
  const { stops, segments } = graph;
  const stopIndex = new Map(stops.map((stop, index) => [stop.key, index]));

  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  const swallow = ({ lat, lng }: Coord): void => {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  };
  for (const stop of stops) {
    swallow(stop);
  }
  for (const segment of segments) {
    for (const point of segment.geometry ?? []) {
      swallow(point);
    }
  }
  const quantize = ({ lat, lng }: Coord): { x: number; y: number } => ({
    x: Math.round((lng - originLng) / COORD_SCALE),
    y: Math.round((lat - originLat) / COORD_SCALE),
  });

  // The name blob holds the stop names and the route display names, deduped together and sorted, so
  // a segment's routeNameId and a stop's name id both index one table.
  const routeNames = segments
    .map((segment) => segment.routeName)
    .filter((name): name is string => name !== null);
  const names = [
    ...new Set([...stops.map((stop) => stop.name), ...routeNames]),
  ].sort();
  const nameIndex = new Map(names.map((name, index) => [name, index]));

  const stopTable = new Uint8Array(stops.length * FERRY_STOP_BYTES);
  const stopView = new DataView(stopTable.buffer);
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index];
    const { x, y } = quantize(stop);
    const record = index * FERRY_STOP_BYTES;
    stopView.setInt32(record, x, true);
    stopView.setInt32(record + 4, y, true);
    stopView.setUint32(record + 8, nameIndex.get(stop.name) ?? 0, true);
  }

  // The geometry blob: per segment that has a polyline, its vertices as zigzag-LEB128 varint
  // deltas, the first pair absolute (from the origin) and the rest from the previous vertex.
  const geometryBytes: number[] = [];
  const geometryOffsets: number[] = [];
  const geometryCounts: number[] = [];
  const scratch = new Uint8Array(10);
  for (const segment of segments) {
    if (!segment.geometry) {
      geometryOffsets.push(NO_GEOMETRY);
      geometryCounts.push(0);
      continue;
    }
    geometryOffsets.push(geometryBytes.length);
    geometryCounts.push(segment.geometry.length);
    let previousX = 0;
    let previousY = 0;
    for (const point of segment.geometry) {
      const { x, y } = quantize(point);
      for (const delta of [x - previousX, y - previousY]) {
        const end = writeVarint(scratch, 0, zigzag(delta));
        for (let byte = 0; byte < end; byte++) {
          geometryBytes.push(scratch[byte]);
        }
      }
      previousX = x;
      previousY = y;
    }
  }
  while (geometryBytes.length % 4 !== 0) {
    geometryBytes.push(0); // pad so the name blob starts 4-byte aligned
  }
  const geometryBlob = Uint8Array.from(geometryBytes);

  const segmentTable = new Uint8Array(segments.length * FERRY_SEGMENT_BYTES);
  const segmentView = new DataView(segmentTable.buffer);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const record = index * FERRY_SEGMENT_BYTES;
    segmentView.setUint32(record, stopIndex.get(segment.stopA) ?? 0, true);
    segmentView.setUint32(record + 4, stopIndex.get(segment.stopB) ?? 0, true);
    segmentView.setFloat32(record + 8, segment.rawTimeSeconds, true);
    segmentView.setUint32(record + 12, geometryOffsets[index], true);
    segmentView.setUint16(record + 16, geometryCounts[index], true);
    const routeNameId =
      segment.routeName !== null
        ? (nameIndex.get(segment.routeName) ?? NO_ROUTE_NAME)
        : NO_ROUTE_NAME;
    segmentView.setUint16(record + 18, routeNameId, true);
  }

  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  let nameBlobLength = 4;
  for (const bytes of nameBytes) {
    nameBlobLength += 2 + bytes.length;
  }
  const nameBlob = new Uint8Array(nameBlobLength);
  const nameView = new DataView(nameBlob.buffer);
  nameView.setUint32(0, names.length, true);
  let nameCursor = 4;
  for (const bytes of nameBytes) {
    nameView.setUint16(nameCursor, bytes.length, true);
    nameCursor += 2;
    nameBlob.set(bytes, nameCursor);
    nameCursor += bytes.length;
  }

  const geometryOffset =
    FERRY_HEADER_BYTES + stopTable.length + segmentTable.length;
  const nameBlobOffset = geometryOffset + geometryBlob.length;
  const bytes = new Uint8Array(nameBlobOffset + nameBlob.length);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = FERRY_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, FERRY_FORMAT, true);
  view.setUint16(6, FERRY_HEADER_BYTES, true);
  view.setUint32(8, stops.length, true);
  view.setUint32(12, segments.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  view.setUint32(40, geometryOffset, true);
  view.setUint32(44, geometryBlob.length, true);
  view.setUint32(48, nameBlobOffset, true);
  view.setUint32(52, nameBlob.length, true);
  bytes.set(stopTable, FERRY_HEADER_BYTES);
  bytes.set(segmentTable, FERRY_HEADER_BYTES + stopTable.length);
  bytes.set(geometryBlob, geometryOffset);
  bytes.set(nameBlob, nameBlobOffset);
  return bytes;
}

export interface FerrySource {
  file: string;
  format: number;
  stops: number;
  segments: number;
  bytes: number;
  sha256: string;
}

// Fetches both feeds (cached), freezes their raw zips under data/ferries/, consolidates them into
// the time-independent graph and writes data/ferries/nyc.bin. Returns the file's stats. Callable on
// its own (`bun run scripts/ferries.ts`) and from the build-tree-data ingest.
export async function ingestFerries(cityId: string): Promise<FerrySource> {
  const started = performance.now();
  await mkdir(FERRY_DIR, { recursive: true });

  const loaded: { source: FeedSource; feed: GtfsFeed }[] = [];
  for (const source of FEEDS) {
    console.error(`ferries: fetching ${source.name}`);
    const zip = await fetchGtfsZip(source.cacheKey, source.url);
    await writeFile(join(FERRY_DIR, source.zipFile), zip);
    loaded.push({ source, feed: parseGtfs(zip) });
  }

  const graph = buildGraph(loaded);
  const bytes = encodeFerries(graph);
  const file = `${cityId}.bin`;
  await writeFile(join(FERRY_DIR, file), bytes);

  const nameOf = new Map(graph.stops.map((stop) => [stop.key, stop.name]));
  const minutes = (seconds: number): string => (seconds / 60).toFixed(1);
  console.error(
    `ferries: ${graph.activeRoutes} active routes, ${graph.stops.length} stops, ${graph.segments.length} segments`,
  );
  for (const segment of graph.segments) {
    const headway =
      segment.headwaySeconds === Number.POSITIVE_INFINITY
        ? "n/a"
        : `${minutes(segment.headwaySeconds)}m`;
    const shape = segment.geometry
      ? `${segment.geometry.length}-pt shape`
      : "straight";
    const route = segment.routeName ?? "?";
    console.error(
      `  [${route}] ${nameOf.get(segment.stopA)} <-> ${nameOf.get(segment.stopB)}: ` +
        `${minutes(segment.rawTimeSeconds)}m (cross ${minutes(segment.medianCrossingSeconds)}m, ` +
        `headway ${headway}, ${shape})`,
    );
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const megabytes = (bytes.length / 1024 / 1024).toFixed(3);
  console.error(`ferries: wrote ${file} (${megabytes} MiB) in ${seconds}s`);

  return {
    file,
    format: FERRY_FORMAT,
    stops: graph.stops.length,
    segments: graph.segments.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestFerries("nyc");
}
