// `bun run build-subway`: downloads the MTA's subway GTFS feed and writes the system's route
// geometry and its stations as data/subway/nyc.bin (magic SBWY) — every route's polylines together
// with the colour and the names the MTA publishes for it, and every station with the set of routes
// that genuinely serve it, so a renderer can draw one route at a time, and one marker per station,
// and know what to paint them without a second file. Display only: this is a walking router, nothing
// here enters the routing graph or any of its inputs. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COORD_SCALE, writeVarint, zigzag } from "./geometry";
import { fetchGtfsZipFile, type GtfsFeed, parseGtfs } from "./gtfs";
import type { SourceFile } from "./manifest";
import type { Coord } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const SUBWAY_DIR = join(DATA_DIR, "subway");
const SUBWAY_MAGIC = "SBWY";
const SUBWAY_FORMAT = 2;
const SUBWAY_HEADER_BYTES = 60;
const SUBWAY_ROUTE_BYTES = 16;
const SUBWAY_LINE_BYTES = 8;
const SUBWAY_STATION_BYTES = 16;
// A station names the routes calling there as one u32 bit per route index. 29 routes fit with room
// to spare and the whole set reads in a single word; a 30th line would be a format change, so the
// encoder refuses rather than dropping the routes that no longer fit.
const MAX_ROUTES = 32;

// The MTA's own subway feed, one zip carrying every service. 5.3 MiB at the last read.
const FEED_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";
const FEED_CACHE_KEY = "gtfs-subway";

// GTFS route_type 1 is the subway proper (28 routes). 2 is heavy rail, which in this feed is the
// Staten Island Railway alone — kept: it is drawn on the MTA's own subway map, it is inside the
// fare system, and the map this feeds covers Staten Island, so dropping it would leave the whole
// borough blank while every other borough draws its lines.
const KEPT_ROUTE_TYPES = new Set(["1", "2"]);

// GTFS direction_id for the forward direction, which every route in this feed runs shapes for.
const FORWARD_DIRECTION = "0";
// How much track a reverse-direction shape has to add to earn a place. A route's direction_id 1
// shapes normally retrace its direction_id 0 shapes down the same rails, and a line drawn on top of
// itself adds nothing — but a pattern that runs southbound ONLY (the R and W down the West End
// line) is track the map would otherwise be missing entirely. So a reverse shape is kept when it
// covers at least this many grid cells no kept shape of the route covers, about 600 m of track:
// above the few metres the two directions wobble apart at terminals and relay tracks, and far below
// a branch. Anything from 5 to 30 cells picks the same two shapes out of the 2026-05-26 feed, so
// this sits in the middle of a wide plateau rather than on an edge that decides anything.
const NEW_TRACK_CELLS = 20;
// The coverage grid's cell, ~39 m of latitude and ~29 m of longitude at New York. Deliberately
// coarser than the tracks are apart, so a shape running the opposite rail of one already drawn
// reads as track already covered rather than as new.
const COVERAGE_CELL_DEGREES = 0.00035;
// Packs a (row, column) cell into one number. Columns run to about -2.1e5 here, nowhere near it.
const CELL_STRIDE = 10_000_000;

// A station lists a route only when that route's schedule really serves it, measured as the share of
// the route's trips that stop there. Rush-hour put-ins sit an order of magnitude below regular
// service and the 2026-05-26 feed leaves the two cleanly apart: 956 of the 1,028 station-route pairs
// stand at 10.09% of the route's trips or more, the other 72 at 3.38% or less, and nothing at all
// falls between. Any floor from 0.034 to 0.10 therefore removes exactly the same 72 pairs, and this
// is the geometric middle of that empty band. Without it 96 St-2 Av claims the N (12 trips) and the
// R (one trip in the entire schedule) beside the Q's 859. This is a fact about the MASKS only —
// every shape a route runs is still drawn, so a line through a station whose mask no longer names
// that route is correct: the track is there, the service is not.
const MIN_TRIP_SHARE = 0.058;

// How close a station has to be to one of its route's drawn lines to count as sitting on it. Nothing
// rides on the exact value: at the 2026-05-26 feed every pair but one is within 4.3 m of its line
// and the one is 103 m out, so any threshold in between finds the same gap.
const STATION_LINE_METERS = 25;
// How far a line may run past its last vertex to reach a platform its shape stops short of, and how
// far off that extension's axis the platform may sit. Both bound the one honest repair: the MTA's Q
// shapes all end 103 m short of the 96 St terminal platform, straight up Second Avenue on a heading
// 4.6° off the bearing to it, so running the line on to the platform's foot lays no track that is
// not there. A platform further out, or off to one side, is a different problem — the ingest reports
// it and leaves it rather than bending track towards it.
const MAX_TERMINAL_EXTENSION_METERS = 250;
const MAX_TERMINAL_OFFSET_METERS = 25;
// The flat metre frame the two constants above are measured in: over a few hundred metres, scaling
// longitude by the local cosine is exact to millimetres.
const METERS_PER_DEGREE_LAT = 111_320;

// The GTFS defaults for a route that publishes no colour. Every route in this feed publishes both;
// the spec's white-on-black beats inventing one.
const DEFAULT_ROUTE_COLOR = "FFFFFF";
const DEFAULT_TEXT_COLOR = "000000";
// A route the feed gives no route_sort_order sorts after every route that has one.
const NO_SORT_ORDER = 0xffff;

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

// One route as it is drawn: the MTA's colours and names, and the representative polylines the
// variant selection kept. `shortName` is what a rider says ("1", "A", "S"), `longName` the corridor
// ("Broadway - 7 Avenue Local") — three different shuttles all call themselves "S", so the long
// name is the only thing that tells them apart.
interface SubwayRoute {
  id: string;
  shortName: string;
  longName: string;
  color: Rgb;
  textColor: Rgb;
  sortOrder: number;
  lines: Coord[][];
}

// One station marker: where it is, what it is called, and which routes call there as a bit per
// index into the route table.
interface SubwayStation extends Coord {
  name: string;
  routeMask: number;
}

function cellKey(row: number, column: number): number {
  return row * CELL_STRIDE + column;
}

function addTrack(points: readonly Coord[], covered: Set<number>): void {
  for (const { lat, lng } of points) {
    covered.add(
      cellKey(
        Math.round(lat / COVERAGE_CELL_DEGREES),
        Math.round(lng / COVERAGE_CELL_DEGREES),
      ),
    );
  }
}

// How many distinct cells of a shape no cell of `covered` touches — its own cell or any of the eight
// around it, so a shape on the opposite rail of one already drawn counts as covered.
function newTrackCells(points: readonly Coord[], covered: Set<number>): number {
  const seen = new Set<number>();
  let fresh = 0;
  for (const { lat, lng } of points) {
    const row = Math.round(lat / COVERAGE_CELL_DEGREES);
    const column = Math.round(lng / COVERAGE_CELL_DEGREES);
    const key = cellKey(row, column);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    let touches = false;
    for (let deltaRow = -1; deltaRow <= 1 && !touches; deltaRow++) {
      for (let deltaColumn = -1; deltaColumn <= 1; deltaColumn++) {
        if (covered.has(cellKey(row + deltaRow, column + deltaColumn))) {
          touches = true;
          break;
        }
      }
    }
    if (!touches) {
      fresh += 1;
    }
  }
  return fresh;
}

function parseColor(hex: string, fallback: string): Rgb {
  const clean = /^[0-9a-fA-F]{6}$/.test(hex.trim()) ? hex.trim() : fallback;
  return {
    red: Number.parseInt(clean.slice(0, 2), 16),
    green: Number.parseInt(clean.slice(2, 4), 16),
    blue: Number.parseInt(clean.slice(4, 6), 16),
  };
}

// shapes.txt as polylines, each ordered by shape_pt_sequence.
function readShapes(feed: GtfsFeed): Map<string, Coord[]> {
  const ordered = new Map<string, { sequence: number; point: Coord }[]>();
  for (const row of feed.shapes) {
    const entry = {
      sequence: Number(row.shape_pt_sequence),
      point: { lat: Number(row.shape_pt_lat), lng: Number(row.shape_pt_lon) },
    };
    const existing = ordered.get(row.shape_id);
    if (existing) {
      existing.push(entry);
    } else {
      ordered.set(row.shape_id, [entry]);
    }
  }
  const shapes = new Map<string, Coord[]>();
  for (const [shapeId, entries] of ordered) {
    entries.sort((left, right) => left.sequence - right.sequence);
    shapes.set(
      shapeId,
      entries.map((entry) => entry.point),
    );
  }
  return shapes;
}

// One shape variant a route runs: enough to rank the variants by how much service is on them and to
// tell the forward direction from the reverse.
interface ShapeVariant {
  shapeId: string;
  direction: string;
  trips: number;
}

// Every shape variant each route runs, forward direction first and within a direction the busiest
// shape first, ties broken by shape id so the order is the same across runs. The forward-first order
// is what makes the reverse direction earn its place against everything already drawn.
function shapeVariants(feed: GtfsFeed): Map<string, ShapeVariant[]> {
  const counts = new Map<string, Map<string, ShapeVariant>>();
  for (const trip of feed.trips) {
    if (trip.shape_id === "") {
      continue;
    }
    let perShape = counts.get(trip.route_id);
    if (!perShape) {
      perShape = new Map<string, ShapeVariant>();
      counts.set(trip.route_id, perShape);
    }
    const seen = perShape.get(trip.shape_id);
    if (seen) {
      seen.trips += 1;
    } else {
      perShape.set(trip.shape_id, {
        shapeId: trip.shape_id,
        direction: trip.direction_id,
        trips: 1,
      });
    }
  }

  const reverse = (variant: ShapeVariant): number =>
    variant.direction === FORWARD_DIRECTION ? 0 : 1;
  const ranked = new Map<string, ShapeVariant[]>();
  for (const [routeId, perShape] of counts) {
    ranked.set(
      routeId,
      [...perShape.values()].sort(
        (left, right) =>
          reverse(left) - reverse(right) ||
          right.trips - left.trips ||
          (left.shapeId < right.shapeId ? -1 : 1),
      ),
    );
  }
  return ranked;
}

function buildRoutes(feed: GtfsFeed): SubwayRoute[] {
  const shapes = readShapes(feed);
  const ranked = shapeVariants(feed);
  const routes: SubwayRoute[] = [];

  for (const row of feed.routes) {
    if (!KEPT_ROUTE_TYPES.has(row.route_type)) {
      continue;
    }
    // Every forward variant of the route is drawn, busiest first — express patterns, branches,
    // rush-hour put-ins, the lot. Variants that merely SHARE track are all kept: separating them
    // where they overlap is the renderer's job, with an offset, and it cannot do it with data the
    // ingest threw away. Only track drawn twice with nothing added is dropped, on two tests of the
    // same idea — a shape whose vertices are identical to one already taken, and a reverse-direction
    // shape that reaches no track the route already covers.
    const lines: Coord[][] = [];
    const drawn = new Set<string>();
    const covered = new Set<number>();
    for (const variant of ranked.get(row.route_id) ?? []) {
      const points = shapes.get(variant.shapeId);
      if (!points || points.length < 2) {
        continue;
      }
      const signature = points.map(({ lat, lng }) => `${lat},${lng}`).join(" ");
      const retraces =
        variant.direction !== FORWARD_DIRECTION &&
        newTrackCells(points, covered) < NEW_TRACK_CELLS;
      if (drawn.has(signature) || retraces) {
        continue;
      }
      drawn.add(signature);
      lines.push(points);
      addTrack(points, covered);
    }
    if (lines.length === 0) {
      console.error(`  ${row.route_id}: no usable shape, dropped`);
      continue;
    }
    const sortOrder = Number(row.route_sort_order);
    routes.push({
      id: row.route_id,
      shortName: row.route_short_name?.trim() ?? "",
      longName: row.route_long_name?.trim() ?? "",
      color: parseColor(row.route_color ?? "", DEFAULT_ROUTE_COLOR),
      textColor: parseColor(row.route_text_color ?? "", DEFAULT_TEXT_COLOR),
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : NO_SORT_ORDER,
      lines,
    });
  }

  // The MTA's own display order (route_sort_order: 8 Avenue first, the shuttles in the middle, the
  // numbered lines last), so a legend built by walking the route table comes out in map order.
  return routes.sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || (left.id < right.id ? -1 : 1),
  );
}

// The stations a marker is drawn at. GTFS models a station as a parent stop (location_type 1) with
// one child platform per direction at the same coordinate, so the parents are what a marker wants:
// the platforms would put two markers a few metres apart at every station. A platform with no
// parent stands in for itself — defensive, this feed gives all 992 of its platforms one.
//
// A station's routes come from the trips of a kept route that stop there, both directions and every
// shape variant — which routes call at a station is a fact about the schedule, not about what got
// drawn — thinned by MIN_TRIP_SHARE, so a route that puts one rush-hour train through a station does
// not label it as if it served the place.
function buildStations(
  feed: GtfsFeed,
  routeIndex: ReadonlyMap<string, number>,
): SubwayStation[] {
  const stopRow = new Map(feed.stops.map((stop) => [stop.stop_id, stop]));
  const routeOf = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.route_id]),
  );
  const routeTrips = new Map<string, number>();
  for (const trip of feed.trips) {
    routeTrips.set(trip.route_id, (routeTrips.get(trip.route_id) ?? 0) + 1);
  }

  // Per station, per route, the distinct trips calling there. Distinct rather than a count of
  // stop_times rows so that a pattern touching one station twice cannot count itself twice against
  // the route's trip total.
  const calls = new Map<string, Map<string, Set<string>>>();
  for (const time of feed.stopTimes) {
    const routeId = routeOf.get(time.trip_id);
    const stop = stopRow.get(time.stop_id);
    if (
      routeId === undefined ||
      stop === undefined ||
      !routeIndex.has(routeId)
    ) {
      continue;
    }
    const stationId = stop.parent_station?.trim() || stop.stop_id;
    let perRoute = calls.get(stationId);
    if (!perRoute) {
      perRoute = new Map<string, Set<string>>();
      calls.set(stationId, perRoute);
    }
    const trips = perRoute.get(routeId);
    if (trips) {
      trips.add(time.trip_id);
    } else {
      perRoute.set(routeId, new Set([time.trip_id]));
    }
  }

  const stations: SubwayStation[] = [];
  let thinned = 0;
  for (const [stationId, perRoute] of calls) {
    let routeMask = 0;
    for (const [routeId, trips] of perRoute) {
      const bit = routeIndex.get(routeId);
      if (bit === undefined) {
        continue;
      }
      if (trips.size / (routeTrips.get(routeId) ?? 1) < MIN_TRIP_SHARE) {
        thinned += 1;
        continue;
      }
      routeMask |= 1 << bit;
    }
    const row = stopRow.get(stationId);
    const lat = Number(row?.stop_lat);
    const lng = Number(row?.stop_lon);
    if (row === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error(`  station ${stationId}: no coordinate, dropped`);
      continue;
    }
    if (routeMask === 0) {
      console.error(
        `  station ${stationId}: no route clears the service floor, dropped`,
      );
      continue;
    }
    stations.push({ lat, lng, name: row.stop_name?.trim() ?? "", routeMask });
  }
  console.error(
    `  masks: ${thinned} station-route pairs below ${(MIN_TRIP_SHARE * 100).toFixed(1)}% of the` +
      " route's trips dropped",
  );

  // Sorted south to north, then west to east, then by name — the order the point sources are
  // written in, and one a renderer can index into.
  return stations.sort(
    (left, right) =>
      left.lat - right.lat ||
      left.lng - right.lng ||
      (left.name < right.name ? -1 : 1),
  );
}

// `to` seen from `from`, in metres east and north.
function offsetMeters(from: Coord, to: Coord): { east: number; north: number } {
  return {
    east:
      (to.lng - from.lng) *
      METERS_PER_DEGREE_LAT *
      Math.cos((from.lat * Math.PI) / 180),
    north: (to.lat - from.lat) * METERS_PER_DEGREE_LAT,
  };
}

// The distance from a point to the nearest point of any of these polylines, the segments taken as
// segments rather than as their vertices — a station sits mid-block between two shape points as
// often as not.
function lineMeters(point: Coord, lines: readonly Coord[][]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (let index = 1; index < line.length; index++) {
      const toPoint = offsetMeters(line[index - 1], point);
      const toEnd = offsetMeters(line[index - 1], line[index]);
      const length2 = toEnd.east ** 2 + toEnd.north ** 2;
      const fraction =
        length2 === 0
          ? 0
          : Math.min(
              1,
              Math.max(
                0,
                (toPoint.east * toEnd.east + toPoint.north * toEnd.north) /
                  length2,
              ),
            );
      nearest = Math.min(
        nearest,
        Math.hypot(
          toPoint.east - fraction * toEnd.east,
          toPoint.north - fraction * toEnd.north,
        ),
      );
    }
  }
  return nearest;
}

// Runs a route's lines on to the stations that list it but sit off the end of every one of them. The
// only repair made is the honest one: where a station lies straight ahead of a line's last vertex,
// on the heading that vertex arrived on, the line is extended along that heading to the station's
// own foot — which is a published shape stopping short of its terminal platform, the MTA's Q up
// Second Avenue being the case in this feed. A station beside a line, or far past its end, is
// reported and left alone: track that bends towards a marker is invented track.
function reachTerminals(
  routes: readonly SubwayRoute[],
  stations: readonly SubwayStation[],
): void {
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    for (const station of stations) {
      if ((station.routeMask & (1 << index)) === 0) {
        continue;
      }
      const before = lineMeters(station, route.lines);
      if (before <= STATION_LINE_METERS) {
        continue;
      }
      let extended = 0;
      for (let line = 0; line < route.lines.length; line++) {
        for (const atStart of [true, false]) {
          const points = route.lines[line];
          const tip = atStart ? points[0] : points[points.length - 1];
          const behind = atStart ? points[1] : points[points.length - 2];
          const heading = offsetMeters(behind, tip);
          const length = Math.hypot(heading.east, heading.north);
          if (length === 0) {
            continue;
          }
          const away = offsetMeters(tip, station);
          const along =
            (away.east * heading.east + away.north * heading.north) / length;
          const across =
            Math.abs(away.east * heading.north - away.north * heading.east) /
            length;
          if (
            along <= 0 ||
            along > MAX_TERMINAL_EXTENSION_METERS ||
            across > MAX_TERMINAL_OFFSET_METERS
          ) {
            continue;
          }
          const foot = {
            lat:
              tip.lat +
              (along * heading.north) / length / METERS_PER_DEGREE_LAT,
            lng:
              tip.lng +
              (along * heading.east) /
                length /
                (METERS_PER_DEGREE_LAT * Math.cos(tip.lat * (Math.PI / 180))),
          };
          route.lines[line] = atStart ? [foot, ...points] : [...points, foot];
          extended += 1;
        }
      }
      if (extended === 0) {
        console.error(
          `  ${route.shortName} (${route.id}): ${station.name} is ${before.toFixed(0)} m off` +
            " every line of the route and not ahead of any of their ends, left as it is",
        );
      } else {
        console.error(
          `  ${route.shortName} (${route.id}): ran ${extended} line(s) on to ${station.name},` +
            ` ${before.toFixed(0)} m past where the feed's shape ends, now` +
            ` ${lineMeters(station, route.lines).toFixed(0)} m off the line`,
        );
      }
    }
  }
}

// Writes the system as SBWY v2: a header, a route table (colours, name ids and the run of lines
// each route owns), a line table (a geometry pointer, a vertex count and the owning route), a
// station table (a position, a name id and the route mask), a varint geometry blob and a trailing
// name blob. All little-endian, coordinates quantized to COORD_SCALE about the south-west origin,
// exactly as the sibling sources. Layout: scripts/README.md.
function encodeSubway(
  routes: readonly SubwayRoute[],
  stations: readonly SubwayStation[],
): Uint8Array {
  if (routes.length > MAX_ROUTES) {
    throw new Error(
      `${routes.length} routes will not fit the u32 station route mask: widen the mask (and the` +
        " format) rather than dropping the routes past the 32nd",
    );
  }

  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  const swallow = ({ lat, lng }: Coord): void => {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  };
  for (const route of routes) {
    for (const line of route.lines) {
      for (const point of line) {
        swallow(point);
      }
    }
  }
  for (const station of stations) {
    swallow(station);
  }

  // Route names and station names share one deduped, sorted table, as FERR pools its stop and route
  // names.
  const names = [
    ...new Set([
      ...routes.flatMap((route) => [route.shortName, route.longName]),
      ...stations.map((station) => station.name),
    ]),
  ].sort();
  const nameIndex = new Map(names.map((name, index) => [name, index]));

  // The geometry blob: per line, its vertices as zigzag-LEB128 varint deltas, the first pair
  // absolute (from the origin) and the rest from the previous vertex.
  const geometryBytes: number[] = [];
  const lineTable = new Uint8Array(
    routes.reduce((total, route) => total + route.lines.length, 0) *
      SUBWAY_LINE_BYTES,
  );
  const lineView = new DataView(lineTable.buffer);
  const scratch = new Uint8Array(10);
  let lineCursor = 0;
  const routeSpans: { first: number; count: number }[] = [];
  for (let index = 0; index < routes.length; index++) {
    const first = lineCursor / SUBWAY_LINE_BYTES;
    for (const line of routes[index].lines) {
      lineView.setUint32(lineCursor, geometryBytes.length, true);
      lineView.setUint16(lineCursor + 4, line.length, true);
      lineView.setUint16(lineCursor + 6, index, true);
      lineCursor += SUBWAY_LINE_BYTES;
      let previousX = 0;
      let previousY = 0;
      for (const { lat, lng } of line) {
        const x = Math.round((lng - originLng) / COORD_SCALE);
        const y = Math.round((lat - originLat) / COORD_SCALE);
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
    routeSpans.push({ first, count: routes[index].lines.length });
  }
  while (geometryBytes.length % 4 !== 0) {
    geometryBytes.push(0); // pad so the name blob starts 4-byte aligned
  }
  const geometryBlob = Uint8Array.from(geometryBytes);

  const routeTable = new Uint8Array(routes.length * SUBWAY_ROUTE_BYTES);
  const routeView = new DataView(routeTable.buffer);
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    const record = index * SUBWAY_ROUTE_BYTES;
    routeTable[record] = route.color.red;
    routeTable[record + 1] = route.color.green;
    routeTable[record + 2] = route.color.blue;
    routeTable[record + 3] = route.textColor.red;
    routeTable[record + 4] = route.textColor.green;
    routeTable[record + 5] = route.textColor.blue;
    routeView.setUint16(record + 6, nameIndex.get(route.shortName) ?? 0, true);
    routeView.setUint16(record + 8, nameIndex.get(route.longName) ?? 0, true);
    routeView.setUint16(record + 10, routeSpans[index].first, true);
    routeView.setUint16(record + 12, routeSpans[index].count, true);
    routeView.setUint16(record + 14, route.sortOrder, true);
  }

  const stationTable = new Uint8Array(stations.length * SUBWAY_STATION_BYTES);
  const stationView = new DataView(stationTable.buffer);
  for (let index = 0; index < stations.length; index++) {
    const station = stations[index];
    const record = index * SUBWAY_STATION_BYTES;
    stationView.setInt32(
      record,
      Math.round((station.lng - originLng) / COORD_SCALE),
      true,
    );
    stationView.setInt32(
      record + 4,
      Math.round((station.lat - originLat) / COORD_SCALE),
      true,
    );
    stationView.setUint32(record + 8, nameIndex.get(station.name) ?? 0, true);
    stationView.setUint32(record + 12, station.routeMask, true);
  }

  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  const nameBlob = new Uint8Array(
    nameBytes.reduce((total, bytes) => total + 2 + bytes.length, 4),
  );
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
    SUBWAY_HEADER_BYTES +
    routeTable.length +
    lineTable.length +
    stationTable.length;
  const nameBlobOffset = geometryOffset + geometryBlob.length;
  const bytes = new Uint8Array(nameBlobOffset + nameBlob.length);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = SUBWAY_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, SUBWAY_FORMAT, true);
  view.setUint16(6, SUBWAY_HEADER_BYTES, true);
  view.setUint32(8, routes.length, true);
  view.setUint32(12, lineTable.length / SUBWAY_LINE_BYTES, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  view.setUint32(40, stations.length, true);
  view.setUint32(44, geometryOffset, true);
  view.setUint32(48, geometryBlob.length, true);
  view.setUint32(52, nameBlobOffset, true);
  view.setUint32(56, nameBlob.length, true);
  bytes.set(routeTable, SUBWAY_HEADER_BYTES);
  bytes.set(lineTable, SUBWAY_HEADER_BYTES + routeTable.length);
  bytes.set(
    stationTable,
    SUBWAY_HEADER_BYTES + routeTable.length + lineTable.length,
  );
  bytes.set(geometryBlob, geometryOffset);
  bytes.set(nameBlob, nameBlobOffset);
  return bytes;
}

export async function ingestSubway(cityId: string): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(SUBWAY_DIR, { recursive: true });

  const feed = parseGtfs(await fetchGtfsZipFile(FEED_CACHE_KEY, FEED_URL));
  const routes = buildRoutes(feed);
  const routeIndex = new Map(routes.map((route, index) => [route.id, index]));
  const stations = buildStations(feed, routeIndex);
  reachTerminals(routes, stations);
  const bytes = encodeSubway(routes, stations);
  const file = `${cityId}.bin`;
  await writeFile(join(SUBWAY_DIR, file), bytes);

  let lines = 0;
  let vertices = 0;
  let pairs = 0;
  let worst = 0;
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    lines += route.lines.length;
    const counts = route.lines.map((line) => line.length);
    vertices += counts.reduce((total, count) => total + count, 0);
    const hex = (color: Rgb): string =>
      [color.red, color.green, color.blue]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("");
    const calling = stations.filter(
      (station) => (station.routeMask & (1 << index)) !== 0,
    );
    pairs += calling.length;
    for (const station of calling) {
      worst = Math.max(worst, lineMeters(station, route.lines));
    }
    console.error(
      `  ${route.shortName} (${route.id}) #${hex(route.color)} ${route.longName}: ` +
        `${counts.length} line(s), ${counts.join("+")} vertices, ${calling.length} stations`,
    );
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `subway: ${routes.length} routes, ${lines} lines, ${vertices} vertices, ` +
      `${stations.length} stations, ${pairs} station-route pairs, the furthest ` +
      `${worst.toFixed(0)} m off its route's lines, ${kib} KiB in ${seconds}s`,
  );

  return {
    file,
    format: SUBWAY_FORMAT,
    count: routes.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  await ingestSubway(process.argv[2] ?? "nyc");
}
