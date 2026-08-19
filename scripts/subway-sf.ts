// `bun run build-subway:sf`: downloads SFMTA's and BART's GTFS feeds and writes San Francisco's
// rail as data/subway/sf.bin — the same SBWY blob New York's subway ships as (scripts/subway.ts),
// so one client format covers both cities. Two feeds rather than one: Muni and BART are separate
// agencies, and 511.org's regional feed, which would carry both, needs an API key this pipeline does
// not hold. Display only: this is a walking router, nothing here enters the routing graph or any of
// its inputs. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { haversineMeters } from "./geometry";
import {
  fetchGtfsZipFile,
  type GtfsFeed,
  type GtfsRow,
  parseGtfs,
} from "./gtfs";
import { type LandContext, loadLandContext } from "./land";
import type { Coord } from "./socrata";
import {
  chooseLines,
  encodeSubway,
  nextComplexId,
  parseColor,
  type Rgb,
  type ShapeVariant,
  type TransitRoute,
  type TransitStation,
  transferComplexes,
} from "./subway-format";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const SUBWAY_DIR = join(DATA_DIR, "subway");

// SFMTA's own feed, published without a key from the page that documents it
// (https://www.sfmta.com/reports/gtfs-transit-data). 10.0 MiB of zip, all 68 Muni routes.
const MUNI_FEED_URL =
  "https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip";
const MUNI_CACHE_KEY = "gtfs-muni";
// BART's own feed, also keyless. This URL redirects to whichever dated zip is current
// (google_transit_20260810-20270108_v02.zip at the last read), so the cache key stays put across
// schedule changes — the same reason every other source here is cached by its request, not its
// answer. bart.gov's OTHER endpoint, api.bart.gov/gtfs/google_transit.zip, still serves a 2013 feed.
const BART_FEED_URL = "https://www.bart.gov/dev/schedules/google_transit.zip";
const BART_CACHE_KEY = "gtfs-bart";

// What Muni draws. route_type 0 is its rail: the six Metro lines (J/K/L/M/N/T) and the F historic
// streetcar, which runs the same rails down Market and is on Muni's own system map. 5 is the three
// cable car lines, kept for the same reason — they are scheduled rail service with published
// colours and shapes, and a San Francisco transit map without the cable cars is not one. The other
// 58 routes are buses (route_type 3): New York's ingest draws no buses either, and Muni's bus
// network alone would not fit the station mask's 32 routes.
const MUNI_ROUTE_TYPES = new Set(["0", "5"]);
// BART is one route_type, 1. Its two `BB-*` bus bridges are route_type 3 and carry no shapes.
const BART_ROUTE_TYPE = "1";

// The GTFS defaults for a route publishing no colour. Both feeds publish both for every route drawn
// here; the spec's white-on-black beats inventing one.
const DEFAULT_ROUTE_COLOR = "FFFFFF";
const DEFAULT_TEXT_COLOR = "000000";

// How close two same-named stops have to be to be one station marker. Muni's feed carries no
// `parent_station` column at all — the column New York's ingest collapses a station's platforms
// with — and it publishes one stop per kerb, so an intersection served both ways is two stops of the
// same name a median apart: 149 of the 152 same-named rail pairs are within 100 m and 76 of them
// within 25 m. The three left out are genuinely different stops sharing a name (19th Ave & Randolph
// St is three stops over 245 m), which is exactly what this must not merge.
const STATION_MERGE_METERS = 100;

// Refining a boundary crossing by bisection: 16 halvings put the cut within 5 cm of the boundary
// even on the longest shape segment in either feed, Muni's 2.8 km one.
const BOUNDARY_BISECTIONS = 16;
// A clipped piece shorter than this is a shape grazing the city on its way past — a few metres of
// line that reads as a speck, not as service. Half a short block.
const MIN_PIECE_METERS = 50;

// A route as its feed describes it, before the variant selection decides what is drawn. `routeIds`
// is plural because BART splits each line into a northbound and a southbound route_id.
interface FeedRoute {
  id: string;
  shortName: string;
  longName: string;
  color: Rgb;
  textColor: Rgb;
  routeIds: string[];
  variants: ShapeVariant[];
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

// The point on the segment where it crosses the city boundary, to within BOUNDARY_BISECTIONS
// halvings, returned on the inside so the drawn line never steps out.
function boundaryPoint(
  inside: Coord,
  outside: Coord,
  onLand: (coord: Coord) => boolean,
): Coord {
  let near = inside;
  let far = outside;
  for (let step = 0; step < BOUNDARY_BISECTIONS; step++) {
    const middle = {
      lat: (near.lat + far.lat) / 2,
      lng: (near.lng + far.lng) / 2,
    };
    if (onLand(middle)) {
      near = middle;
    } else {
      far = middle;
    }
  }
  return near;
}

function lengthMeters(line: readonly Coord[]): number {
  let total = 0;
  for (let index = 1; index < line.length; index++) {
    total += haversineMeters(line[index - 1], line[index]);
  }
  return total;
}

// The parts of a shape that are in the city, cut at the shoreline and the county line — the same
// land polygons every other source here is clipped with, so the transit lines stop where the streets
// and the canopy do. A shape that leaves and comes back (none in these feeds, but BART's tube and
// Muni's Presidio edges are one bad polygon away from it) comes back as several pieces.
function clipToCity(
  points: readonly Coord[],
  onLand: (coord: Coord) => boolean,
): Coord[][] {
  const pieces: Coord[][] = [];
  let piece: Coord[] = [];
  let previous: Coord | null = null;
  let previousInside = false;
  const flush = (): void => {
    if (piece.length >= 2 && lengthMeters(piece) >= MIN_PIECE_METERS) {
      pieces.push(piece);
    }
    piece = [];
  };
  for (const point of points) {
    const inside = onLand(point);
    if (inside) {
      if (!previousInside && previous !== null) {
        piece.push(boundaryPoint(point, previous, onLand));
      }
      piece.push(point);
    } else if (previousInside && previous !== null) {
      piece.push(boundaryPoint(previous, point, onLand));
      flush();
    }
    previous = point;
    previousInside = inside;
  }
  flush();
  return pieces;
}

// Every shape the given route_ids run, as drawn: the trips on it (what ranks the variants), whether
// it is a primary shape, and its geometry clipped to the city. A shape used by trips in both
// directions counts as primary — it is track the route runs, whichever way round it was recorded.
function shapeVariants(
  feed: GtfsFeed,
  shapes: ReadonlyMap<string, Coord[]>,
  routeIds: readonly string[],
  isPrimary: (trip: GtfsRow) => boolean,
  onLand: (coord: Coord) => boolean,
): ShapeVariant[] {
  const wanted = new Set(routeIds);
  const counted = new Map<string, { primary: boolean; trips: number }>();
  for (const trip of feed.trips) {
    if (!wanted.has(trip.route_id) || trip.shape_id === "") {
      continue;
    }
    const seen = counted.get(trip.shape_id);
    if (seen) {
      seen.trips += 1;
      seen.primary ||= isPrimary(trip);
    } else {
      counted.set(trip.shape_id, { primary: isPrimary(trip), trips: 1 });
    }
  }

  const variants: ShapeVariant[] = [];
  for (const [shapeId, { primary, trips }] of counted) {
    const points = shapes.get(shapeId);
    if (!points || points.length < 2) {
      continue;
    }
    variants.push({
      shapeId,
      primary,
      trips,
      lines: clipToCity(points, onLand),
    });
  }
  return variants;
}

// Muni's rail, in the order a legend reads: the Metro lines and the F first (route_type 0), then the
// cable cars, alphabetically within each — the feed publishes no route_sort_order to defer to.
function muniRoutes(feed: GtfsFeed, land: LandContext): FeedRoute[] {
  const shapes = readShapes(feed);
  const rows = feed.routes
    .filter((row) => MUNI_ROUTE_TYPES.has(row.route_type))
    .sort(
      (left, right) =>
        Number(left.route_type) - Number(right.route_type) ||
        (left.route_short_name < right.route_short_name ? -1 : 1),
    );
  return rows.map((row) => ({
    id: `muni:${row.route_id}`,
    shortName: row.route_short_name?.trim() ?? "",
    longName: row.route_long_name?.trim() ?? "",
    color: parseColor(row.route_color ?? "", DEFAULT_ROUTE_COLOR),
    textColor: parseColor(row.route_text_color ?? "", DEFAULT_TEXT_COLOR),
    routeIds: [row.route_id],
    variants: shapeVariants(
      feed,
      shapes,
      [row.route_id],
      (trip) => trip.direction_id === "0",
      land.onLand,
    ),
  }));
}

// BART's lines, one per colour. The feed splits each line into two route_ids — "Yellow-S" (route 1)
// and "Yellow-N" (route 2) — which are the two directions of one line down one pair of rails, so
// they are folded together here exactly as direction_id 0 and 1 are folded within a Muni route: the
// lower-numbered route_id's shapes are the primary ones, the other's have to reach track they do not
// already cover. Drawing them apart would put every BART line on the map twice, in one colour, under
// two names no station sign uses.
//
// A line with nothing left after the clip is dropped — Orange (Richmond to Berryessa) and Grey (the
// Oakland airport connector) never enter San Francisco, and a line the city does not see is not part
// of its map.
function bartRoutes(feed: GtfsFeed, land: LandContext): FeedRoute[] {
  const shapes = readShapes(feed);
  const byColor = new Map<string, GtfsRow[]>();
  for (const row of feed.routes) {
    if (row.route_type !== BART_ROUTE_TYPE) {
      continue;
    }
    const color = (row.route_short_name ?? "").split("-")[0].trim();
    const group = byColor.get(color);
    if (group) {
      group.push(row);
    } else {
      byColor.set(color, [row]);
    }
  }

  const routes: FeedRoute[] = [];
  for (const [color, group] of byColor) {
    const ordered = [...group].sort(
      (left, right) => Number(left.route_id) - Number(right.route_id),
    );
    const [primary] = ordered;
    routes.push({
      id: `bart:${color}`,
      shortName: color,
      longName: primary.route_long_name?.trim() ?? "",
      color: parseColor(primary.route_color ?? "", DEFAULT_ROUTE_COLOR),
      textColor: parseColor(primary.route_text_color ?? "", DEFAULT_TEXT_COLOR),
      routeIds: ordered.map((row) => row.route_id),
      variants: shapeVariants(
        feed,
        shapes,
        ordered.map((row) => row.route_id),
        (trip) => trip.route_id === primary.route_id,
        land.onLand,
      ),
    });
  }
  // The feed's own order, which is BART's: Yellow, Orange, Green, Red, Blue, then the connector.
  return routes.sort(
    (left, right) => Number(left.routeIds[0]) - Number(right.routeIds[0]),
  );
}

// The station markers one feed contributes: where they are, what they are called, and which routes
// call there as a bit per index into the route table. A station's routes come from every trip of a
// drawn route that stops there, both directions and every shape variant — which routes call at a
// station is a fact about the schedule, not about which shapes got drawn.
//
// GTFS models a station as a parent stop with one child platform per direction at the same
// coordinate, so the parents are what a marker wants; BART publishes them (and its entrances, as
// location_type 2, which never appear in stop_times and so never reach this). Muni publishes no
// parent_station at all, which the same code path handles by a stop standing in for itself — the
// kerb-to-kerb pairs it leaves behind are what the name merge below folds.
function feedStations(
  feed: GtfsFeed,
  routeOfTrip: ReadonlyMap<string, number>,
  complexes: ReadonlyMap<string, number>,
  onLand: (coord: Coord) => boolean,
): TransitStation[] {
  const stopRow = new Map(feed.stops.map((stop) => [stop.stop_id, stop]));
  const masks = new Map<string, number>();
  for (const time of feed.stopTimes) {
    const route = routeOfTrip.get(time.trip_id);
    const stop = stopRow.get(time.stop_id);
    if (route === undefined || stop === undefined) {
      continue;
    }
    const stationId = stop.parent_station?.trim() || stop.stop_id;
    masks.set(stationId, (masks.get(stationId) ?? 0) | (1 << route));
  }

  const stations: TransitStation[] = [];
  for (const [stationId, routeMask] of masks) {
    const row = stopRow.get(stationId);
    const lat = Number(row?.stop_lat);
    const lng = Number(row?.stop_lon);
    if (row === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error(`  station ${stationId}: no coordinate, dropped`);
      continue;
    }
    if (onLand({ lat, lng })) {
      stations.push({
        lat,
        lng,
        name: row.stop_name?.trim() ?? "",
        routeMask,
        complex: complexes.get(stationId) ?? 0,
      });
    }
  }
  return stations;
}

// One marker per station rather than one per kerb: stops sharing a name and lying within
// STATION_MERGE_METERS of one another become a single marker at their centroid, carrying every route
// that calls at any of them. Single-link, so the three stops of a rail terminal chain into one
// marker; run over both agencies together, so a Muni stop and a BART entrance of the same name at the
// same corner are one station on the map, which is what a rider sees.
function mergeStations(stations: readonly TransitStation[]): TransitStation[] {
  const byName = new Map<string, TransitStation[]>();
  for (const station of stations) {
    const group = byName.get(station.name);
    if (group) {
      group.push(station);
    } else {
      byName.set(station.name, [station]);
    }
  }

  const merged: TransitStation[] = [];
  for (const group of byName.values()) {
    const taken = new Array<boolean>(group.length).fill(false);
    for (let seed = 0; seed < group.length; seed++) {
      if (taken[seed]) {
        continue;
      }
      taken[seed] = true;
      const cluster = [group[seed]];
      for (let member = 0; member < cluster.length; member++) {
        for (let other = 0; other < group.length; other++) {
          if (
            !taken[other] &&
            haversineMeters(cluster[member], group[other]) <=
              STATION_MERGE_METERS
          ) {
            taken[other] = true;
            cluster.push(group[other]);
          }
        }
      }
      // The lowest complex any member is in, or 0 when none of them is in one — which is every
      // marker in this city today, since neither feed names a transfer between two stations.
      const ids = cluster
        .map(({ complex }) => complex)
        .filter((complex) => complex !== 0);
      merged.push({
        lat: cluster.reduce((sum, one) => sum + one.lat, 0) / cluster.length,
        lng: cluster.reduce((sum, one) => sum + one.lng, 0) / cluster.length,
        name: group[seed].name,
        routeMask: cluster.reduce((mask, one) => mask | one.routeMask, 0),
        complex: ids.length === 0 ? 0 : Math.min(...ids),
      });
    }
  }

  // Sorted south to north, then west to east, then by name — the order the point sources are written
  // in, and one a renderer can index into.
  return merged.sort(
    (left, right) =>
      left.lat - right.lat ||
      left.lng - right.lng ||
      (left.name < right.name ? -1 : 1),
  );
}

// Which route index each trip of a feed belongs to, for the station masks. `routes` must be that
// feed's own routes and no other's: route_id is unique within a feed and nowhere else, and Muni's
// bus routes 1, 2, 5, 6, 7, 8 and 12 are named exactly as BART's route_ids for Yellow, Green, Red
// and Blue. Handed both feeds' routes, this hangs a BART bit on every stop of seven bus lines.
function tripRouteIndex(
  feed: GtfsFeed,
  routes: readonly FeedRoute[],
  indexOf: ReadonlyMap<string, number>,
): Map<string, number> {
  const byFeedRoute = new Map<string, number>();
  for (const route of routes) {
    const index = indexOf.get(route.id);
    if (index === undefined) {
      continue;
    }
    for (const feedRouteId of route.routeIds) {
      byFeedRoute.set(feedRouteId, index);
    }
  }
  const trips = new Map<string, number>();
  for (const trip of feed.trips) {
    const index = byFeedRoute.get(trip.route_id);
    if (index !== undefined) {
      trips.set(trip.trip_id, index);
    }
  }
  return trips;
}

async function ingestSubwaySf(cityId: string): Promise<void> {
  const started = performance.now();
  await mkdir(SUBWAY_DIR, { recursive: true });

  const land = await loadLandContext(cityId);
  const muni = parseGtfs(await fetchGtfsZipFile(MUNI_CACHE_KEY, MUNI_FEED_URL));
  const bart = parseGtfs(await fetchGtfsZipFile(BART_CACHE_KEY, BART_FEED_URL));

  const muniFeedRoutes = muniRoutes(muni, land);
  const bartFeedRoutes = bartRoutes(bart, land);
  const routes: TransitRoute[] = [];
  for (const route of [...muniFeedRoutes, ...bartFeedRoutes]) {
    const lines = chooseLines(route.variants);
    if (lines.length === 0) {
      console.error(`  ${route.shortName}: nothing inside the city, dropped`);
      continue;
    }
    // No route_sort_order in either feed, so the display order is the one built above and the field
    // records it: Muni's rail, then the cable cars, then BART's lines in BART's own order.
    routes.push({
      id: route.id,
      shortName: route.shortName,
      longName: route.longName,
      color: route.color,
      textColor: route.textColor,
      sortOrder: routes.length,
      lines,
    });
  }

  const indexOf = new Map(routes.map((route, index) => [route.id, index]));
  // Two feeds in one file, so the second agency's complex ids start past the first's: a complex id
  // means one place only within the feed that numbered it. Both maps are empty at these feeds.
  const muniComplexes = transferComplexes(muni, 1);
  const bartComplexes = transferComplexes(bart, nextComplexId(muniComplexes));
  const stations = mergeStations([
    ...feedStations(
      muni,
      tripRouteIndex(muni, muniFeedRoutes, indexOf),
      muniComplexes,
      land.onLand,
    ),
    ...feedStations(
      bart,
      tripRouteIndex(bart, bartFeedRoutes, indexOf),
      bartComplexes,
      land.onLand,
    ),
  ]);

  const bytes = encodeSubway(routes, stations);
  const file = `${cityId}.bin`;
  await writeFile(join(SUBWAY_DIR, file), bytes);

  let lines = 0;
  let vertices = 0;
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    lines += route.lines.length;
    const counts = route.lines.map((line) => line.length);
    vertices += counts.reduce((total, count) => total + count, 0);
    const hex = (color: Rgb): string =>
      [color.red, color.green, color.blue]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("");
    const called = stations.filter(
      (station) => (station.routeMask & (1 << index)) !== 0,
    ).length;
    console.error(
      `  ${route.shortName} (${route.id}) #${hex(route.color)} ${route.longName}: ` +
        `${counts.length} line(s), ${counts.join("+")} vertices, ${called} stations`,
    );
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `subway: ${routes.length} routes, ${lines} lines, ${vertices} vertices, ` +
      `${stations.length} stations, ${kib} KiB in ${seconds}s, sha256 ` +
      `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`,
  );
}

if (import.meta.main) {
  await ingestSubwaySf(process.argv[2] ?? "sf");
}
