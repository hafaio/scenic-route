// The half of a transit-lines ingest that is not the feed: which of a route's shape variants are
// worth drawing, and the SBWY blob they are written as — a route table carrying the agency's own
// colours and names, one polyline per drawn variant, and a station table naming the routes calling
// there as a bitmask. Layout: scripts/README.md.
//
// Both cities' ingests write through this: New York's (scripts/subway.ts) reads one feed, San
// Francisco's (scripts/subway-sf.ts) two, and what they share is everything downstream of the feed.

import { COORD_SCALE, writeVarint, zigzag } from "./geometry";
import type { GtfsFeed } from "./gtfs";
import type { Coord } from "./socrata";

export const SUBWAY_MAGIC = "SBWY";
export const SUBWAY_FORMAT = 3;
const SUBWAY_HEADER_BYTES = 60;
const SUBWAY_ROUTE_BYTES = 16;
const SUBWAY_LINE_BYTES = 8;
const SUBWAY_STATION_BYTES = 20;
// A station names the routes calling there as one u32 bit per route index, so a 33rd route would be
// a format change; the encoder refuses rather than dropping the routes that no longer fit.
const MAX_ROUTES = 32;

// How much track a non-primary shape has to add to earn a place. A route's reverse-direction shapes
// normally retrace its forward ones down the same rails, and a line drawn on top of itself adds
// nothing — but a pattern that runs one way ONLY (a cable car's one-way street couplet, New York's
// southbound-only West End patterns) is track the map would otherwise be missing entirely. So a
// non-primary shape is kept when it covers at least this many grid cells no kept shape of the route
// covers, about 150 m of track: above the few metres the two directions wobble apart at terminals
// and relay tracks, and far below a block of one-way street.
//
// San Francisco's 28 non-primary shapes measure 0-4 fresh cells each except three — the F's Jefferson
// Street loop at Fisherman's Wharf (7) and the Powell-Hyde cable car's Washington Street leg (8 and
// 10), the two places a Muni line genuinely runs back a different street. Anything from 5 to 7 picks
// exactly those three, and drawing them cuts the stations sitting more than 100 m from a line of a
// route they are on from 12 of 367 to 5. New York's feed is coarser and its own plateau runs 5 to 30.
const NEW_TRACK_CELLS = 5;
// The coverage grid's cell, ~39 m of latitude and ~30 m of longitude at these latitudes.
// Deliberately coarser than the tracks are apart, so a shape running the opposite rail of one
// already drawn reads as track already covered rather than as new.
const COVERAGE_CELL_DEGREES = 0.00035;
// Packs a (row, column) cell into one number. Columns run to about -3.5e5 here, nowhere near it.
const CELL_STRIDE = 10_000_000;

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

// One route as it is drawn: the agency's colours and names, and the polylines the variant selection
// kept. `shortName` is what a rider says ("N", "Yellow"), `longName` the corridor ("JUDAH").
export interface TransitRoute {
  id: string;
  shortName: string;
  longName: string;
  color: Rgb;
  textColor: Rgb;
  sortOrder: number;
  lines: Coord[][];
}

// One station marker: where it is, what it is called, which routes call there as a bit per index
// into the route table, and which complex the agency puts it in.
export interface TransitStation extends Coord {
  name: string;
  routeMask: number;
  // The connected component of the feed's own transfers.txt this station falls in, from 1, or 0
  // when the feed publishes no transfer between two different stations at all. Two stations sharing
  // a non-zero id are one complex however far apart they are; two carrying 0 are a question the
  // agency did not answer, and the client falls back to distance and name (../src/subway/format).
  complex: number;
}

// One shape variant a route runs, as drawn: several polylines rather than one because clipping a
// shape to the city can cut it into pieces. A variant is accepted or rejected whole — the pieces are
// one run of track that happens to leave the map and come back.
export interface ShapeVariant {
  shapeId: string;
  // A forward-direction shape, kept unless it duplicates one already taken. Everything else has to
  // reach track the route does not already cover.
  primary: boolean;
  trips: number;
  lines: Coord[][];
}

// GTFS transfer_type 3: the agency saying a rider CANNOT cross between this pair. Neither feed here
// publishes one, but joining on it would read a row as the opposite of what it says.
const NO_TRANSFER = "3";

// Which complex each of a feed's stations belongs to, from the agency's own transfers.txt: the
// connected components of the stations it says a rider can walk between, numbered from `firstId` so
// two feeds written into one file can be given disjoint ranges. Rows are keyed on stop ids that may
// be platforms rather than stations, so both ends are resolved to their parent the way the station
// table is.
//
// Empty when the feed names no transfer between two DIFFERENT stations — Muni publishes no
// transfers.txt at all and BART's 40 rows are all platform-to-platform inside one station, so
// neither says anything about which of its stations are one place. A feed that says nothing must
// leave every station at 0 rather than claim each is a complex of its own, because 0 is what sends
// the client back to the geometric rule that is all San Francisco has ever had.
export function transferComplexes(
  feed: GtfsFeed,
  firstId: number,
): Map<string, number> {
  const parentOf = new Map(
    feed.stops.map((stop) => [
      stop.stop_id,
      stop.parent_station?.trim() || stop.stop_id,
    ]),
  );
  const parent = new Map<string, string>();
  const find = (station: string): string => {
    const seen = parent.get(station);
    if (seen === undefined || seen === station) {
      return station;
    }
    const root = find(seen);
    parent.set(station, root);
    return root;
  };

  let joins = 0;
  for (const row of feed.transfers) {
    if (row.transfer_type === NO_TRANSFER) {
      continue;
    }
    const from = parentOf.get(row.from_stop_id) ?? row.from_stop_id;
    const to = parentOf.get(row.to_stop_id) ?? row.to_stop_id;
    if (from === to) {
      continue;
    }
    // The lower id always wins the root, so a complex's root is the same whatever order the rows
    // came in and the numbering below is the same across runs.
    const roots = [find(from), find(to)].sort();
    parent.set(roots[1], roots[0]);
    joins += 1;
  }
  if (joins === 0) {
    return new Map();
  }

  const ids = new Map<string, number>();
  const complexes = new Map<string, number>();
  for (const station of [...new Set(parentOf.values())].sort()) {
    const root = find(station);
    let id = ids.get(root);
    if (id === undefined) {
      id = firstId + ids.size;
      ids.set(root, id);
    }
    complexes.set(station, id);
  }
  return complexes;
}

// The first complex id no station in `complexes` uses, so the next feed's ids do not collide with
// this one's.
export function nextComplexId(complexes: ReadonlyMap<string, number>): number {
  return Math.max(0, ...complexes.values()) + 1;
}

export function parseColor(hex: string, fallback: string): Rgb {
  const clean = /^[0-9a-fA-F]{6}$/.test(hex.trim()) ? hex.trim() : fallback;
  return {
    red: Number.parseInt(clean.slice(0, 2), 16),
    green: Number.parseInt(clean.slice(2, 4), 16),
    blue: Number.parseInt(clean.slice(4, 6), 16),
  };
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
function newTrackCells(
  lines: readonly Coord[][],
  covered: Set<number>,
): number {
  const seen = new Set<number>();
  let fresh = 0;
  for (const line of lines) {
    for (const { lat, lng } of line) {
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
  }
  return fresh;
}

// Every variant of a route that draws track, primary shapes first and within those the busiest
// first, ties broken by shape id so the order is the same across runs. Express patterns, branches,
// rush-hour put-ins, the lot: a variant is real service on real track, and thinning them to a
// representative set is a rendering decision an ingest has no business making — variants sharing a
// trunk are separated with an offset, which cannot be done at all with data that was thrown away.
// Two things are dropped, and only two: a variant whose geometry is identical to one already taken,
// and a non-primary variant that reaches no track the route already covers.
export function chooseLines(variants: readonly ShapeVariant[]): Coord[][] {
  const ordered = [...variants].sort(
    (left, right) =>
      Number(right.primary) - Number(left.primary) ||
      right.trips - left.trips ||
      (left.shapeId < right.shapeId ? -1 : 1),
  );

  const lines: Coord[][] = [];
  const drawn = new Set<string>();
  const covered = new Set<number>();
  for (const variant of ordered) {
    if (variant.lines.length === 0) {
      continue;
    }
    const signature = variant.lines
      .map((line) => line.map(({ lat, lng }) => `${lat},${lng}`).join(" "))
      .join("|");
    const retraces =
      !variant.primary &&
      newTrackCells(variant.lines, covered) < NEW_TRACK_CELLS;
    if (drawn.has(signature) || retraces) {
      continue;
    }
    drawn.add(signature);
    for (const line of variant.lines) {
      lines.push(line);
      addTrack(line, covered);
    }
  }
  return lines;
}

// Writes the system as SBWY v3: a header, a route table (colours, name ids and the run of lines each
// route owns), a line table (a geometry pointer, a vertex count and the owning route), a station
// table (a position, a name id, the route mask and the complex id), a varint geometry blob and a
// trailing name blob.
// All little-endian, coordinates quantized to COORD_SCALE about the south-west origin, exactly as
// the sibling sources. Layout: scripts/README.md.
export function encodeSubway(
  routes: readonly TransitRoute[],
  stations: readonly TransitStation[],
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
    stationView.setUint32(record + 16, station.complex, true);
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
