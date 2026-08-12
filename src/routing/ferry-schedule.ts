// The ferry timetable the router departs against (magic FSCH, written by scripts/ferry-schedule.ts).
//
// The graph bakes one crossing-plus-average-wait figure into each ferry edge, which is all a
// time-independent cost can use. This reads the real timetable instead: for the day being routed, the
// sailings out of each terminal IN EACH DIRECTION, so the wait is the wait for the next boat rather
// than half a headway, and the last boat of the night is the last boat.
//
// The timetable is a DIFFERENT artifact for a different day: the daily job records the day range each
// one was in effect for, so routing on a past day resolves to the timetable that actually ran. Days
// before the first recorded one — and any day at all when the fetch fails — fall back to the graph's
// baked figure, so a ferry is never unroutable for want of this file.
//
// Layout: scripts/README.md.

import { type Cursor, readUnsignedVarint } from "../tiles/varint";
import type { RoutingGraph } from "./graph";

const MAGIC = "FSCH";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 40;
const SERVICE_BYTES = 12;
const EXCEPTION_BYTES = 8;
const LANE_BYTES = 16;
const NO_ROUTE_NAME = 0xffff;
const SECONDS_PER_DAY = 86_400;
const EXCEPTION_ADDED = 1;

// Where the timetable comes from: `public/ferry-schedule/` on `main`, which the daily job commits to,
// read over raw.githubusercontent.com rather than out of the deploy — the same reasoning as the shed
// artifact (DESIGN.md, "Sidewalk sheds"), since a schedule change must reach the client without one.
// In development it stays on the local `public/ferry-schedule/`, which is also the only way to see a
// pipeline change before it is pushed.
const SCHEDULE_MAIN_URL =
  "https://raw.githubusercontent.com/hafaio/scenic-route/main/public/ferry-schedule";
const SCHEDULE_BASE =
  process.env.NEXT_PUBLIC_FERRY_SCHEDULE_BASE ??
  (process.env.NODE_ENV === "development"
    ? "ferry-schedule"
    : SCHEDULE_MAIN_URL);

// One sailing out of a terminal: when it leaves (seconds from midnight of the day being routed, so a
// boat on the next day reads past 86400), how long the crossing takes, and how long the walker who
// asked stands on the pier first. `route` names the boat, for the directions to quote.
export interface Sailing {
  departure: number;
  wait: number;
  crossing: number;
  route: string | null;
}

// What the cost model asks of a timetable. Both take the node the walker boards at, because a
// timetable is directional — the 8:15 out of St. George is not the 8:15 out of Whitehall.
export interface FerryTimetable {
  // Whether this edge is in the timetable at all. An edge whose terminal names match no lane — a
  // stop the feed renamed, say — is not scheduled but is not cancelled either, so it keeps the
  // graph's baked figure rather than reading as a missed boat.
  covers(edge: number): boolean;
  // The next sailing at or after `elapsedSeconds` into the walk, or null once the day's last boat has
  // gone. Null is what makes a missed ferry cost Infinity and drop out of the search.
  board(edge: number, fromNode: number, elapsedSeconds: number): Sailing | null;
  // The least this edge can cost anyone: its quickest crossing with no wait at all. The A* ferry
  // credit is built from this, so it has to be a true lower bound over every departure time.
  minRideSeconds(edge: number): number;
}

interface Sailings {
  departures: Float64Array;
  crossings: Float64Array;
  routes: (string | null)[];
}

interface EdgeSailings {
  nodeA: number; // boarding here sails forward, toward node b
  nodeB: number;
  forward: Sailings | null;
  backward: Sailings | null;
}

interface Lane {
  fromName: string;
  toName: string;
  route: string | null;
  service: number;
  sailings: { at: number; crossing: number }[];
}

interface Service {
  mask: number; // bit 0 Monday .. bit 6 Sunday
  startDay: number; // YYYYMMDD
  endDay: number;
}

// One decoded FSCH record: the timetable plus the day range it was in effect for.
export interface ScheduleRecord {
  firstDay: number;
  lastDay: number; // 0 while this is the timetable in effect
  services: Service[];
  exceptions: { day: number; service: number; type: number }[];
  lanes: Lane[];
}

export function dayNumber(day: string): number {
  return Number(day.replaceAll("-", ""));
}

// The local day `offset` days from `date`, as YYYYMMDD.
function shiftedDay(date: Date, offset: number): number {
  const shifted = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + offset,
  );
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return Number(`${shifted.getFullYear()}${month}${day}`);
}

// Monday-first weekday bit of a YYYYMMDD day, matching the mask the artifact writes.
function weekdayBit(day: number): number {
  const date = new Date(
    Math.floor(day / 10000),
    (Math.floor(day / 100) % 100) - 1,
    day % 100,
  );
  return (date.getDay() + 6) % 7;
}

export function decodeSchedule(
  bytes: Uint8Array,
  offset = 0,
): { record: ScheduleRecord; nextOffset: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
  const version = view.getUint16(offset + 4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} ferry schedule`);
  }
  const firstDay = view.getUint32(offset + 8, true);
  const lastDay = view.getUint32(offset + 12, true);
  const serviceCount = view.getUint32(offset + 16, true);
  const exceptionCount = view.getUint32(offset + 20, true);
  const laneCount = view.getUint32(offset + 24, true);
  const departureBytes = view.getUint32(offset + 28, true);
  const nameTableOffset = offset + view.getUint32(offset + 32, true);
  const recordBytes = view.getUint32(offset + 36, true);

  const nameCount = view.getUint32(nameTableOffset, true);
  const nameBlob = nameTableOffset + 4 + (nameCount + 1) * 4;
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let index = 0; index < nameCount; index++) {
    const start = view.getUint32(nameTableOffset + 4 + index * 4, true);
    const end = view.getUint32(nameTableOffset + 8 + index * 4, true);
    names.push(
      decoder.decode(bytes.subarray(nameBlob + start, nameBlob + end)),
    );
  }

  const serviceOffset = offset + HEADER_BYTES;
  const services: Service[] = [];
  for (let index = 0; index < serviceCount; index++) {
    const record = serviceOffset + index * SERVICE_BYTES;
    services.push({
      startDay: view.getUint32(record, true),
      endDay: view.getUint32(record + 4, true),
      mask: view.getUint8(record + 8),
    });
  }

  const exceptionOffset = serviceOffset + serviceCount * SERVICE_BYTES;
  const exceptions: ScheduleRecord["exceptions"] = [];
  for (let index = 0; index < exceptionCount; index++) {
    const record = exceptionOffset + index * EXCEPTION_BYTES;
    exceptions.push({
      day: view.getUint32(record, true),
      service: view.getUint16(record + 4, true),
      type: view.getUint8(record + 6),
    });
  }

  const laneOffset = exceptionOffset + exceptionCount * EXCEPTION_BYTES;
  const departureOffset = laneOffset + laneCount * LANE_BYTES;
  const lanes: Lane[] = [];
  for (let index = 0; index < laneCount; index++) {
    const record = laneOffset + index * LANE_BYTES;
    const routeId = view.getUint16(record + 4, true);
    const count = view.getUint16(record + 8, true);
    const cursor: Cursor = {
      offset: departureOffset + view.getUint32(record + 12, true),
    };
    const sailings: Lane["sailings"] = [];
    let at = 0;
    for (let sailing = 0; sailing < count; sailing++) {
      at += readUnsignedVarint(bytes, cursor);
      sailings.push({ at, crossing: readUnsignedVarint(bytes, cursor) });
    }
    lanes.push({
      fromName: names[view.getUint16(record, true)] ?? "",
      toName: names[view.getUint16(record + 2, true)] ?? "",
      route: routeId === NO_ROUTE_NAME ? null : (names[routeId] ?? null),
      service: view.getUint16(record + 6, true),
      sailings,
    });
  }

  if (departureOffset + departureBytes > nameTableOffset) {
    throw new Error("ferry schedule departure blob overruns the name table");
  }

  return {
    record: { firstDay, lastDay, services, exceptions, lanes },
    nextOffset: offset + recordBytes,
  };
}

// The services running on one day: the calendar's weekday mask inside its date range, then
// calendar_dates' own additions and removals, which apply whatever the range says.
function servicesOn(record: ScheduleRecord, day: number): Set<number> {
  const bit = weekdayBit(day);
  const active = new Set<number>();
  record.services.forEach((service, index) => {
    if (
      service.startDay <= day &&
      day <= service.endDay &&
      (service.mask & (1 << bit)) !== 0
    ) {
      active.add(index);
    }
  });
  for (const exception of record.exceptions) {
    if (exception.day === day) {
      if (exception.type === EXCEPTION_ADDED) {
        active.add(exception.service);
      } else {
        active.delete(exception.service);
      }
    }
  }
  return active;
}

class ResolvedTimetable implements FerryTimetable {
  constructor(
    private readonly departureSecondsOfDay: number,
    private readonly covered: Set<number>,
    private readonly sailings: Map<number, EdgeSailings>,
    private readonly minRide: Map<number, number>,
  ) {}

  // Coverage is over the WHOLE record, not the day being routed. A weekend-only run has lanes but no
  // sailings on a Wednesday, and it has to read as "no boat" rather than fall through to the graph's
  // baked figure — that figure is an average over the whole timetable, so falling back would put a
  // Saturday ferry on a Wednesday route.
  covers(edge: number): boolean {
    return this.covered.has(edge);
  }

  board(
    edge: number,
    fromNode: number,
    elapsedSeconds: number,
  ): Sailing | null {
    const lanes = this.sailings.get(edge);
    if (!lanes) {
      return null;
    }
    // The graph's endpoint names are aligned to node a / node b, so which of them the walker arrives
    // at is the whole of the direction. A node that is neither is a caller that did not say where it
    // boarded; answer nothing rather than quietly hand back the other direction's timetable.
    const side =
      fromNode === lanes.nodeA
        ? lanes.forward
        : fromNode === lanes.nodeB
          ? lanes.backward
          : null;
    if (!side) {
      return null;
    }
    const wall = this.departureSecondsOfDay + elapsedSeconds;
    const { departures, crossings, routes } = side;
    let low = 0;
    let high = departures.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (departures[middle] < wall) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low >= departures.length) {
      return null;
    } else {
      return {
        departure: departures[low],
        wait: departures[low] - wall,
        crossing: crossings[low],
        route: routes[low],
      };
    }
  }

  minRideSeconds(edge: number): number {
    return this.minRide.get(edge) ?? Number.POSITIVE_INFINITY;
  }
}

// Every sailing of one directed stop pair over the three service days around the routed one, as
// seconds from midnight of the routed day. Three days rather than one because a walk can begin near
// midnight and because GTFS writes an after-midnight sailing as the previous day's 25:10 — both put
// the boat you catch on a different service day from the one you set out on.
function sailingsFor(
  record: ScheduleRecord,
  days: { day: number; offset: number; services: Set<number> }[],
  fromName: string,
  toName: string,
): Sailings | null {
  const merged: {
    departure: number;
    crossing: number;
    route: string | null;
  }[] = [];
  for (const { offset, services } of days) {
    for (const lane of record.lanes) {
      if (
        lane.fromName !== fromName ||
        lane.toName !== toName ||
        !services.has(lane.service)
      ) {
        continue;
      }
      for (const sailing of lane.sailings) {
        merged.push({
          departure: sailing.at + offset,
          crossing: sailing.crossing,
          route: lane.route,
        });
      }
    }
  }
  if (merged.length === 0) {
    return null;
  }
  // Routes sharing a stop pair are separate lanes, so the merge is what puts them in one queue: you
  // board whichever boat leaves next, whatever route it belongs to.
  merged.sort((left, right) => left.departure - right.departure);
  return {
    departures: Float64Array.from(merged, (sailing) => sailing.departure),
    crossings: Float64Array.from(merged, (sailing) => sailing.crossing),
    routes: merged.map((sailing) => sailing.route),
  };
}

function leastCrossing(...sides: (Sailings | null)[]): number {
  let least = Number.POSITIVE_INFINITY;
  for (const side of sides) {
    for (const crossing of side?.crossings ?? []) {
      least = Math.min(least, crossing);
    }
  }
  return least;
}

// Resolve a decoded timetable against a graph and a departure instant: which services run on the
// three days around it, and per ferry edge the sailings out of each of its two terminals.
export function resolveTimetable(
  graph: RoutingGraph,
  record: ScheduleRecord,
  date: Date,
): FerryTimetable {
  const days = [-1, 0, 1].map((offset) => {
    const day = shiftedDay(date, offset);
    return {
      day,
      offset: offset * SECONDS_PER_DAY,
      services: servicesOn(record, day),
    };
  });

  // Every directed stop pair the record names, whatever service it runs on.
  const scheduled = new Set(
    record.lanes.map((lane) => `${lane.fromName}\u0000${lane.toName}`),
  );

  const covered = new Set<number>();
  const sailings = new Map<number, EdgeSailings>();
  const minRide = new Map<number, number>();
  for (const edge of graph.ferryEdges) {
    const ends = graph.ferryEndpointNames.get(edge);
    if (
      !ends ||
      !(
        scheduled.has(`${ends.a}\u0000${ends.b}`) ||
        scheduled.has(`${ends.b}\u0000${ends.a}`)
      )
    ) {
      continue; // no lane by these names at all: this edge keeps the graph's baked figure
    }
    covered.add(edge);
    const forward = sailingsFor(record, days, ends.a, ends.b);
    const backward = sailingsFor(record, days, ends.b, ends.a);
    if (!forward && !backward) {
      continue; // scheduled, but not on these days — `board` returning null is the right answer
    }
    sailings.set(edge, {
      nodeA: graph.edgeNodeA[edge],
      nodeB: graph.edgeNodeB[edge],
      forward,
      backward,
    });
    minRide.set(edge, leastCrossing(forward, backward));
  }

  const departureSecondsOfDay =
    date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  return new ResolvedTimetable(
    departureSecondsOfDay,
    covered,
    sailings,
    minRide,
  );
}

// Fetch the timetable that was in effect on the departure date and hang it on the graph. Leaves
// `graph.ferries` null — the graph's baked crossing-plus-average-wait figure — when there is no
// record for that day, which is every day before the first the daily job ever wrote.
export async function computeFerrySchedule(
  graph: RoutingGraph,
  cityId: string,
  date: Date,
): Promise<void> {
  const record = await loadScheduleRecord(cityId, shiftedDay(date, 0));
  graph.ferries = record ? resolveTimetable(graph, record, date) : null;
}

// Both files are fetched once per city and kept. The route re-resolves on every clock tick — once a
// minute while tracking "now" — and the artifact does not change under a session, so without this the
// timetable would be re-downloaded every minute a route is on screen.
const currentRecords = new Map<string, Promise<ScheduleRecord | null>>();
const pastFiles = new Map<string, Promise<Uint8Array | null>>();

function cached<Value>(
  store: Map<string, Promise<Value>>,
  key: string,
  load: () => Promise<Value>,
): Promise<Value> {
  const existing = store.get(key);
  if (existing) {
    return existing;
  }
  // A failed load is dropped rather than remembered, so a network blip does not disable the
  // timetable for the rest of the session.
  const request = load().catch((error: unknown) => {
    store.delete(key);
    throw error;
  });
  store.set(key, request);
  return request;
}

export async function loadScheduleRecord(
  cityId: string,
  day: number,
): Promise<ScheduleRecord | null> {
  const current = await cached(currentRecords, cityId, () =>
    fetchRecord(`${SCHEDULE_BASE}/${cityId}.bin`),
  );
  if (!current) {
    return null;
  } else if (day >= current.firstDay) {
    return current;
  }
  // Only a day before the standing timetable took effect pays for the history file.
  const bytes = await cached(pastFiles, cityId, async () => {
    const response = await fetch(`${SCHEDULE_BASE}/${cityId}-past.bin`);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  });
  if (!bytes) {
    return null;
  }
  let offset = 0;
  while (offset < bytes.length) {
    const { record, nextOffset } = decodeSchedule(bytes, offset);
    if (record.firstDay <= day && day <= record.lastDay) {
      return record;
    }
    offset = nextOffset;
  }
  return null;
}

async function fetchRecord(url: string): Promise<ScheduleRecord | null> {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return decodeSchedule(bytes).record;
}
