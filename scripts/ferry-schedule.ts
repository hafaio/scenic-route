// `bun run update-ferry-schedule`: the ferry timetable the router departs against, as its own small
// artifact rather than a number baked into the graph. Every ferry city on one run, so a city that
// gains ferries is covered without the daily workflow being touched.
//
// data/ferries/<id>.bin (FERR) collapses the whole schedule into one crossing-plus-average-wait
// figure per stop pair, and the graph pass bakes that into the 37 MB routing graph. Nothing in the
// daily path can rebuild that graph, so the timetable lives on its own instead, in
// public/ferry-schedule/<id>.bin — magic FSCH, ~15 KB, fetched by the client the way the shed
// artifact is. A client that cannot read it falls back to the graph's baked figure and routes
// exactly as it did before.
//
// Two files per city. `<id>.bin` is the timetable in effect now; `<id>-past.bin` is every superseded
// one, appended whole and never rewritten — a record carries the day range it was in effect, so a
// route planned on a past day is planned against the timetable that actually ran. Only the feeds
// decide the contents: the record's body is a pure function of the city's zips, so a day that finds
// them unchanged rewrites identical bytes and the daily job's "nothing to commit" path fires.
//
// Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  excludedStopNames,
  FERRY_CITIES,
  FERRY_ROUTE_TYPE,
  type FeedSource,
  feedsOf,
  toSeconds,
} from "./ferries";
import { writeVarint } from "./geometry";
import { fetchGtfsZip, type GtfsFeed, parseGtfs } from "./gtfs";

// NOT public/ferries/ — that is the tile build's own output for the drawn ferry lines, gitignored
// and rebuilt by a deploy. This artifact is committed and rebuilt daily, so it lives beside the shed
// one under its own tracked directory.
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
export const SCHEDULE_DIR = join(PUBLIC_DIR, "ferry-schedule");

export const SCHEDULE_MAGIC = "FSCH";
export const SCHEDULE_FORMAT = 1;
const HEADER_BYTES = 40;
const SERVICE_BYTES = 12;
const EXCEPTION_BYTES = 8;
const LANE_BYTES = 16;
const CURRENT_LAST_DAY = 0; // a record's lastDay while it is the one in effect
const NO_ROUTE_NAME = 0xffff;
// Joins a lane's parts into a map key. NUL because a GTFS stop or route name may contain any
// printable character, spaces and punctuation included, but never this one.
const KEY_SEPARATOR = "\u0000";

// GTFS calendar_dates exception types.
const EXCEPTION_ADDED = 1;
const EXCEPTION_REMOVED = 2;

// One (origin, destination, route, service) departure list. Directional on purpose: a timetable is
// not symmetric, and the reverse leg is what a destination drag re-solves against. Splitting by
// route as well as by stop pair keeps the departure list small enough to leave the route name off
// each departure, and lets the directions name the boat you actually catch.
interface Lane {
  fromName: string;
  toName: string;
  routeName: string;
  serviceKey: string;
  // departure seconds from local midnight of the service day (GTFS allows past 86400), paired with
  // that trip's own crossing time — merged routes cross at different speeds, so it is per departure
  // rather than per lane.
  departures: { at: number; crossing: number }[];
}

// A GTFS service as the client re-derives it: the weekday mask and date range from calendar.txt, and
// the individual days calendar_dates.txt adds or removes.
interface Service {
  key: string; // `${feedId}:${serviceId}`, so the two feeds' service ids cannot collide
  mask: number; // bit 0 Monday .. bit 6 Sunday
  startDay: number; // YYYYMMDD
  endDay: number;
}

interface Exception {
  serviceKey: string;
  day: number; // YYYYMMDD
  type: number;
}

export interface Timetable {
  lanes: Lane[];
  services: Service[];
  exceptions: Exception[];
}

const WEEKDAY_COLUMNS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// A "YYYY-MM-DD" day as the YYYYMMDD integer the artifact stores. Ordered as an integer exactly as
// it is as a date, so a range check is a pair of comparisons.
export function dayNumber(day: string): number {
  return Number(day.replaceAll("-", ""));
}

export function dayString(day: number): string {
  const text = String(day);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

// The day before `day`, so a superseded record's range can be closed the day the new one opens.
function previousDay(day: number): number {
  const date = new Date(
    Date.UTC(
      Math.floor(day / 10000),
      (Math.floor(day / 100) % 100) - 1,
      day % 100,
    ),
  );
  date.setUTCDate(date.getUTCDate() - 1);
  return dayNumber(date.toISOString().slice(0, 10));
}

// One feed's ferry trips, cut into consecutive-stop departures and folded into the shared lanes.
// Only route_type 4 is kept (the NYC Ferry feed also carries its shuttle buses), and the same
// out-of-city stop names the FERR ingest drops are dropped here, so the two artifacts describe the
// same network. The names are all this job knows: it runs daily in CI and must not depend on the two
// GIS services the ingest's land check reads.
function consolidate(
  feed: GtfsFeed,
  feedId: string,
  excluded: ReadonlySet<string>,
  lanes: Map<string, Lane>,
  usedServices: Set<string>,
  stopOfName: Map<string, string>,
): void {
  const routeTypeOf = new Map(
    feed.routes.map((route) => [route.route_id, route.route_type]),
  );
  const routeDisplayOf = new Map(
    feed.routes.map((route) => [
      route.route_id,
      route.route_long_name?.trim() || route.route_short_name?.trim() || "",
    ]),
  );
  const tripRoute = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.route_id]),
  );
  const tripService = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.service_id]),
  );

  const nameOf = new Map<string, string>();
  for (const stop of feed.stops) {
    nameOf.set(stop.stop_id, stop.stop_name);
  }

  const byTrip = new Map<string, GtfsFeed["stopTimes"]>();
  for (const row of feed.stopTimes) {
    const rows = byTrip.get(row.trip_id);
    if (rows) {
      rows.push(row);
    } else {
      byTrip.set(row.trip_id, [row]);
    }
  }

  for (const [tripId, rows] of byTrip) {
    const routeId = tripRoute.get(tripId);
    const serviceId = tripService.get(tripId);
    if (
      routeId === undefined ||
      serviceId === undefined ||
      routeTypeOf.get(routeId) !== FERRY_ROUTE_TYPE
    ) {
      continue;
    }
    const routeName = routeDisplayOf.get(routeId) ?? "";
    const serviceKey = `${feedId}:${serviceId}`;
    const ordered = [...rows].sort(
      (left, right) => Number(left.stop_sequence) - Number(right.stop_sequence),
    );

    for (let index = 0; index + 1 < ordered.length; index++) {
      const from = ordered[index];
      const to = ordered[index + 1];
      const at = toSeconds(from.departure_time);
      const arrival = toSeconds(to.arrival_time);
      const fromName = nameOf.get(from.stop_id);
      const toName = nameOf.get(to.stop_id);
      if (
        at === null ||
        arrival === null ||
        fromName === undefined ||
        toName === undefined ||
        fromName === toName ||
        excluded.has(fromName) ||
        excluded.has(toName)
      ) {
        continue;
      }
      const crossing = arrival - at;
      if (crossing < 0) {
        continue;
      }
      // The join onto the routing graph is by stop NAME — each ferry edge records its two terminal
      // names and nothing else that survives a rebuild — so two ferry stops sharing a name would
      // make a lane ambiguous. The NYC Ferry feed does repeat names, but only across its shuttle-BUS
      // stops, which the route-type filter drops before this sees them.
      for (const [stopId, name] of [
        [`${feedId}:${from.stop_id}`, fromName],
        [`${feedId}:${to.stop_id}`, toName],
      ] as const) {
        const seen = stopOfName.get(name);
        if (seen !== undefined && seen !== stopId) {
          throw new Error(
            `ferry stops ${seen} and ${stopId} share the name "${name}" — the graph joins ` +
              "the timetable by name, so it cannot tell them apart",
          );
        }
        stopOfName.set(name, stopId);
      }

      usedServices.add(serviceKey);
      const key = [fromName, toName, routeName, serviceKey].join(KEY_SEPARATOR);
      const lane = lanes.get(key);
      if (lane) {
        lane.departures.push({ at, crossing });
      } else {
        lanes.set(key, {
          fromName,
          toName,
          routeName,
          serviceKey,
          departures: [{ at, crossing }],
        });
      }
    }
  }
}

// The calendars behind the services the lanes actually use. A service named only by calendar_dates
// (no calendar.txt row) still needs a row to be indexable, and gets a zero mask — which never matches
// a weekday, so only its exception days ever turn it on. That is what an exceptions-only service is.
function collectServices(
  feeds: { source: FeedSource; feed: GtfsFeed }[],
  usedServices: Set<string>,
): { services: Service[]; exceptions: Exception[] } {
  const services = new Map<string, Service>();
  const exceptions: Exception[] = [];

  for (const { source, feed } of feeds) {
    for (const row of feed.calendar) {
      const key = `${source.id}:${row.service_id}`;
      if (!usedServices.has(key)) {
        continue;
      }
      let mask = 0;
      WEEKDAY_COLUMNS.forEach((column, bit) => {
        if (row[column] === "1") {
          mask |= 1 << bit;
        }
      });
      services.set(key, {
        key,
        mask,
        startDay: Number(row.start_date),
        endDay: Number(row.end_date),
      });
    }
    for (const row of feed.calendarDates) {
      const key = `${source.id}:${row.service_id}`;
      const day = Number(row.date);
      const type = Number(row.exception_type);
      if (
        !usedServices.has(key) ||
        !Number.isFinite(day) ||
        (type !== EXCEPTION_ADDED && type !== EXCEPTION_REMOVED)
      ) {
        continue;
      }
      exceptions.push({ serviceKey: key, day, type });
      // An exception applies whatever the calendar range says, so a service named only here needs a
      // row only to exist and be indexable — a zero mask never matches a weekday, which is exactly
      // what an exceptions-only service is.
      if (!services.has(key)) {
        services.set(key, { key, mask: 0, startDay: 0, endDay: 0 });
      }
    }
  }

  return {
    services: [...services.values()].sort((left, right) =>
      left.key < right.key ? -1 : 1,
    ),
    exceptions,
  };
}

// `excluded` defaults to nothing so a caller building a timetable out of feeds it wrote itself — the
// tests do — need not name a city's exclusions to say it has none.
export function buildTimetable(
  feeds: { source: FeedSource; feed: GtfsFeed }[],
  excluded: ReadonlySet<string> = new Set<string>(),
): Timetable {
  const lanes = new Map<string, Lane>();
  const usedServices = new Set<string>();
  const stopOfName = new Map<string, string>();
  for (const { source, feed } of feeds) {
    consolidate(feed, source.id, excluded, lanes, usedServices, stopOfName);
  }
  const { services, exceptions } = collectServices(feeds, usedServices);

  // Everything is ordered before it is written: the record's bytes have to be a pure function of the
  // feeds, or an unchanged day would look like a schedule change to the daily job.
  for (const lane of lanes.values()) {
    // Two trips of one route leaving one stop at the same second are the same sailing listed twice;
    // sorting the crossing time second keeps the quicker of them, deterministically.
    const sorted = [...lane.departures].sort(
      (left, right) => left.at - right.at || left.crossing - right.crossing,
    );
    lane.departures = sorted.filter(
      (departure, index) => departure.at !== sorted[index - 1]?.at,
    );
  }
  const ordered = [...lanes.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, lane]) => lane);
  exceptions.sort(
    (left, right) =>
      left.day - right.day ||
      (left.serviceKey < right.serviceKey ? -1 : 1) ||
      left.type - right.type,
  );

  return { lanes: ordered, services, exceptions };
}

// Writes one FSCH record: the header, the service and exception tables, the lane table, the varint
// departure blob and the name table. Little-endian throughout, and every section a multiple of 4 so
// that records concatenated into the history file stay aligned.
export function encodeTimetable(
  timetable: Timetable,
  firstDay: number,
  lastDay: number,
): Uint8Array {
  const { lanes, services, exceptions } = timetable;
  const serviceIndex = new Map(
    services.map((service, index) => [service.key, index]),
  );

  const names = [
    ...new Set(
      lanes.flatMap((lane) =>
        lane.routeName === ""
          ? [lane.fromName, lane.toName]
          : [lane.fromName, lane.toName, lane.routeName],
      ),
    ),
  ].sort();
  const nameIndex = new Map(names.map((name, index) => [name, index]));

  // The departure blob: per lane, the first departure absolute and the rest as gaps, each followed by
  // that sailing's crossing time. All non-negative (the list is sorted and a crossing cannot run
  // backwards), so plain LEB128 rather than zigzag.
  const departureBytes: number[] = [];
  const laneOffsets: number[] = [];
  const scratch = new Uint8Array(10);
  const push = (value: number): void => {
    const end = writeVarint(scratch, 0, value);
    for (let byte = 0; byte < end; byte++) {
      departureBytes.push(scratch[byte]);
    }
  };
  for (const lane of lanes) {
    laneOffsets.push(departureBytes.length);
    let previous = 0;
    for (const departure of lane.departures) {
      push(departure.at - previous);
      push(departure.crossing);
      previous = departure.at;
    }
  }
  while (departureBytes.length % 4 !== 0) {
    departureBytes.push(0);
  }
  const departureBlob = Uint8Array.from(departureBytes);

  const serviceTable = new Uint8Array(services.length * SERVICE_BYTES);
  const serviceView = new DataView(serviceTable.buffer);
  services.forEach((service, index) => {
    const record = index * SERVICE_BYTES;
    serviceView.setUint32(record, service.startDay, true);
    serviceView.setUint32(record + 4, service.endDay, true);
    serviceView.setUint8(record + 8, service.mask);
  });

  const exceptionTable = new Uint8Array(exceptions.length * EXCEPTION_BYTES);
  const exceptionView = new DataView(exceptionTable.buffer);
  exceptions.forEach((exception, index) => {
    const record = index * EXCEPTION_BYTES;
    exceptionView.setUint32(record, exception.day, true);
    exceptionView.setUint16(
      record + 4,
      serviceIndex.get(exception.serviceKey) ?? 0,
      true,
    );
    exceptionView.setUint8(record + 6, exception.type);
  });

  const laneTable = new Uint8Array(lanes.length * LANE_BYTES);
  const laneView = new DataView(laneTable.buffer);
  lanes.forEach((lane, index) => {
    const record = index * LANE_BYTES;
    laneView.setUint16(record, nameIndex.get(lane.fromName) ?? 0, true);
    laneView.setUint16(record + 2, nameIndex.get(lane.toName) ?? 0, true);
    laneView.setUint16(
      record + 4,
      lane.routeName === ""
        ? NO_ROUTE_NAME
        : (nameIndex.get(lane.routeName) ?? NO_ROUTE_NAME),
      true,
    );
    laneView.setUint16(
      record + 6,
      serviceIndex.get(lane.serviceKey) ?? 0,
      true,
    );
    laneView.setUint16(record + 8, lane.departures.length, true);
    laneView.setUint32(record + 12, laneOffsets[index], true);
  });

  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  const nameOffsets = new Uint32Array(names.length + 1);
  let nameCursor = 0;
  nameBytes.forEach((bytes, index) => {
    nameOffsets[index] = nameCursor;
    nameCursor += bytes.length;
  });
  nameOffsets[names.length] = nameCursor;
  const nameTable = new Uint8Array(4 + nameOffsets.byteLength + nameCursor);
  new DataView(nameTable.buffer).setUint32(0, names.length, true);
  nameTable.set(new Uint8Array(nameOffsets.buffer), 4);
  nameBytes.forEach((bytes, index) => {
    nameTable.set(bytes, 4 + nameOffsets.byteLength + nameOffsets[index]);
  });

  const serviceOffset = HEADER_BYTES;
  const exceptionOffset = serviceOffset + serviceTable.length;
  const laneOffset = exceptionOffset + exceptionTable.length;
  const departureOffset = laneOffset + laneTable.length;
  const nameOffset = departureOffset + departureBlob.length;
  // Padded to 4 so the next record in the history file starts aligned, and counted in `total` so
  // walking that file by record length lands on the padding rather than in it.
  const total = (nameOffset + nameTable.length + 3) & ~3;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = SCHEDULE_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, SCHEDULE_FORMAT, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, firstDay, true);
  view.setUint32(12, lastDay, true);
  view.setUint32(16, services.length, true);
  view.setUint32(20, exceptions.length, true);
  view.setUint32(24, lanes.length, true);
  view.setUint32(28, departureBlob.length, true);
  view.setUint32(32, nameOffset, true);
  view.setUint32(36, total, true);
  bytes.set(serviceTable, serviceOffset);
  bytes.set(exceptionTable, exceptionOffset);
  bytes.set(laneTable, laneOffset);
  bytes.set(departureBlob, departureOffset);
  bytes.set(nameTable, nameOffset);
  return bytes;
}

// Everything past the header — the part that depends only on the feeds. Comparing this is what tells
// a schedule change from a run on another day: the header carries the day range, which moves on its
// own whenever a change is recorded.
function bodyOf(record: Uint8Array): Uint8Array {
  return record.subarray(HEADER_BYTES);
}

function sameBody(left: Uint8Array, right: Uint8Array): boolean {
  const leftBody = bodyOf(left);
  const rightBody = bodyOf(right);
  return (
    leftBody.length === rightBody.length &&
    leftBody.every((byte, index) => byte === rightBody[index])
  );
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

export interface ScheduleUpdate {
  changed: boolean;
  firstDay: number;
  lanes: number;
  services: number;
  bytes: number;
  sha256: string;
}

// Fetches the city's feeds, builds its timetable and — only if it differs from the one in effect —
// closes the standing record into `<id>-past.bin` and opens a new one. `today` is the day the new
// record takes effect from; the superseded one is closed the day before, so the two ranges meet
// without overlapping and no day is left without a timetable.
export async function updateFerrySchedule(
  cityId: string,
  today: string,
): Promise<ScheduleUpdate> {
  await mkdir(SCHEDULE_DIR, { recursive: true });
  const loaded: { source: FeedSource; feed: GtfsFeed }[] = [];
  for (const source of feedsOf(cityId)) {
    console.error(`ferry-schedule: fetching ${source.name}`);
    const zip = await fetchGtfsZip(source.cacheKey, source.url);
    loaded.push({ source, feed: parseGtfs(zip) });
  }

  const timetable = buildTimetable(loaded, excludedStopNames(cityId));
  const day = dayNumber(today);
  const currentPath = join(SCHEDULE_DIR, `${cityId}.bin`);
  const pastPath = join(SCHEDULE_DIR, `${cityId}-past.bin`);
  const standing = await readIfPresent(currentPath);
  const candidate = encodeTimetable(timetable, day, CURRENT_LAST_DAY);

  let record = candidate;
  let changed = true;
  if (standing && sameBody(standing, candidate)) {
    // Unchanged: keep the standing record exactly as it is, first day and all. Rewriting it with
    // today's date would make every run a commit.
    record = standing;
    changed = false;
  } else if (standing) {
    const standingFirst = new DataView(
      standing.buffer,
      standing.byteOffset,
      standing.byteLength,
    ).getUint32(8, true);
    const closesOn = previousDay(day);
    if (standingFirst > closesOn) {
      // The standing record took effect today and is already being replaced — the feed moved twice in
      // one day, or a run is being redone. It covered no completed day, so there is nothing to keep:
      // closing it would append a record whose range runs backwards and which no day can ever match.
      console.error(
        `ferry-schedule: replacing today's timetable in place (took effect ${dayString(standingFirst)})`,
      );
    } else {
      const closed = new Uint8Array(standing);
      new DataView(closed.buffer).setUint32(12, closesOn, true);
      const past = (await readIfPresent(pastPath)) ?? new Uint8Array(0);
      const appended = new Uint8Array(past.length + closed.length);
      appended.set(past, 0);
      appended.set(closed, past.length);
      await writeFile(pastPath, appended);
      console.error(
        `ferry-schedule: retired the timetable of ${dayString(standingFirst)}` +
          `..${dayString(closesOn)}`,
      );
    }
  }

  await writeFile(currentPath, record);
  const firstDay = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  ).getUint32(8, true);
  const departures = timetable.lanes.reduce(
    (sum, lane) => sum + lane.departures.length,
    0,
  );
  console.error(
    `ferry-schedule: ${cityId} ${timetable.lanes.length} lanes, ${departures} departures, ` +
      `${timetable.services.length} services, in effect from ${dayString(firstDay)} ` +
      `(${changed ? "changed" : "unchanged"}, ${record.length} bytes)`,
  );

  return {
    changed,
    firstDay,
    lanes: timetable.lanes.length,
    services: timetable.services.length,
    bytes: record.length,
    sha256: createHash("sha256").update(record).digest("hex"),
  };
}

// The LOCAL day, not `toISOString()`'s UTC one: a run after 8pm ET would otherwise open the new
// timetable on tomorrow's date and leave today with no record covering it.
function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// One city with `--city`, otherwise every city that has ferries — which is what the daily job runs,
// so adding a ferry city needs no change to the workflow. One `today` for the whole run, so two
// cities whose feeds both moved open their new records on the same day even across midnight.
if (import.meta.main) {
  const { values } = parseArgs({ options: { city: { type: "string" } } });
  const cities = values.city === undefined ? FERRY_CITIES : [values.city];
  const today = localDay(new Date());
  for (const cityId of cities) {
    await updateFerrySchedule(cityId, today);
  }
}
