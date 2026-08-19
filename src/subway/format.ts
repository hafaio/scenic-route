import { decodeNames, type Polyline, readPolyline } from "../tiles/polylines";
import type { Cursor } from "../tiles/varint";

// The SBWY layout (scripts/README.md, "the subway route lines and stations"): the MTA's 29 routes,
// their 93 drawn shape variants and the 496 stations, with the colours and names the feed publishes.
// Display only — nothing here reaches the routing graph, because nobody walks the subway.
//
// Decoded here rather than in the tile worker because the station list has a second reader: address
// search offers stations alongside the geocoder's results (../subway/stations), and both would
// otherwise carry their own copy of the byte offsets.

const MAGIC = "SBWY";
const FORMAT = 3;
const ROUTE_BYTES = 16;
const LINE_BYTES = 8;
const STATION_BYTES = 20;

export interface SubwayRoute {
  color: string; // route_color, the hex the MTA publishes for the line
  textColor: string; // route_text_color, the letter inside the bullet
  shortName: string; // the "1", "A", "SIR" a rider says
  longName: string; // the corridor; the only thing telling the three `S` shuttles apart
}

export interface SubwayLine extends Polyline {
  route: number; // index into `routes`
}

export interface SubwayStation {
  lng: number;
  lat: number;
  name: string;
  routes: number; // bitmask: bit i set means route i of `routes` calls here
  // The complex the agency's own transfers.txt puts this station in, or 0 where the feed publishes
  // no transfers at all. What `mergeStations` joins on; see it for the rule.
  complex: number;
}

export interface Subway {
  routes: SubwayRoute[];
  lines: SubwayLine[];
  stations: SubwayStation[];
}

function hex(bytes: Uint8Array, offset: number): string {
  const channel = (at: number) => bytes[at].toString(16).padStart(2, "0");
  return `#${channel(offset)}${channel(offset + 1)}${channel(offset + 2)}`;
}

export function decodeSubway(buffer: ArrayBuffer): Subway {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const found = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (found !== MAGIC) {
    throw new Error(`not a ${MAGIC} blob`);
  }
  const format = view.getUint16(4, true);
  if (format !== FORMAT) {
    throw new Error(`${MAGIC} v${format}, expected v${FORMAT}`);
  }
  const headerBytes = view.getUint16(6, true);
  const routeCount = view.getUint32(8, true);
  const lineCount = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const stationCount = view.getUint32(40, true);
  const geometryOffset = view.getUint32(44, true);
  const names = decodeNames(view, bytes, view.getUint32(52, true));

  const routes: SubwayRoute[] = [];
  for (let route = 0; route < routeCount; route++) {
    const record = headerBytes + route * ROUTE_BYTES;
    routes.push({
      color: hex(bytes, record),
      textColor: hex(bytes, record + 3),
      shortName: names[view.getUint16(record + 6, true)] ?? "",
      longName: names[view.getUint16(record + 8, true)] ?? "",
    });
  }

  const lineTable = headerBytes + routeCount * ROUTE_BYTES;
  const lines: SubwayLine[] = [];
  for (let line = 0; line < lineCount; line++) {
    const record = lineTable + line * LINE_BYTES;
    const cursor: Cursor = {
      offset: geometryOffset + view.getUint32(record, true),
    };
    lines.push({
      ...readPolyline(
        bytes,
        cursor,
        view.getUint16(record + 4, true),
        originLng,
        originLat,
        scale,
      ),
      route: view.getUint16(record + 6, true),
    });
  }

  const stationTable = lineTable + lineCount * LINE_BYTES;
  const stations: SubwayStation[] = [];
  for (let station = 0; station < stationCount; station++) {
    const record = stationTable + station * STATION_BYTES;
    stations.push({
      lng: originLng + view.getInt32(record, true) * scale,
      lat: originLat + view.getInt32(record + 4, true) * scale,
      name: names[view.getUint32(record + 8, true)] ?? "",
      routes: view.getUint32(record + 12, true),
      complex: view.getUint32(record + 16, true),
    });
  }

  return { routes, lines, stations };
}

// The indices of the routes a station's mask names, in the file's route order — which is each
// agency's own `route_sort_order`, so a station reads "A, C, E" the way the signs at it do.
export function stationRouteIndices(station: SubwayStation): number[] {
  const indices: number[] = [];
  for (let route = 0; route < 32; route++) {
    if ((station.routes & (1 << route)) !== 0) {
      indices.push(route);
    }
  }
  return indices;
}

export function stationRoutes(
  station: SubwayStation,
  routes: readonly SubwayRoute[],
): string[] {
  return stationRouteIndices(station).map(
    (index) => routes[index]?.shortName ?? "",
  );
}

const METERS_PER_DEGREE_LAT = 111_320;

// Two records this close are one place whatever they are called. This and the rule below are the
// fallback for a feed that publishes no transfers, which today is San Francisco's two and no others:
// Muni files the same street corner twice, once per direction ("Metro Powell Station/Downtown" and
// ".../Outbound") and once per side of the street it stops on ("Market St & 4th St" and "Market St &
// Stockton St" are the two ends of one crossing), and it never puts two genuinely separate stops
// this close — its tightest stop spacing is a few hundred metres. 60 m closes all 63 near pairs in
// the file, Balboa Park's Muni platform and BART's mezzanine 7.5 m away among them.
const SAME_PLACE_METERS = 60;
// How far apart two records sharing a name may be and still be one place. Muni's two Metro platforms
// at Powell, Montgomery and Civic Center are 76, 83 and 93 m apart under one name, and those three
// pairs are everything this adds to the rule above; the next same-named pair in the file is 19th Ave
// & Randolph St at 220 m, which is two genuinely different stops. Anything from 94 to 219 m
// therefore does the same work, and 160 m is near the middle of that empty band.
const SAME_NAME_METERS = 160;

// A direction the agency appends to a stop's name, as a trailing word after a slash or a space.
// Only trailing, so a station actually called "Downtown Berkeley" would keep its name.
const DIRECTION_SUFFIX =
  /[\s/]+(?:downtown|downtn|outbound|outbd|inbound|inbd|northbound|southbound|eastbound|westbound)$/i;

// The name with the direction and any doubled spaces taken out, so the two halves of a Muni stop
// agree — the artifact really does hold both "Market St & 5th St" and "Market St & 5th  St".
function canonicalName(name: string): string {
  return name.replace(DIRECTION_SUFFIX, "").replace(/\s+/g, " ").trim();
}

function metersApart(
  from: SubwayStation,
  to: SubwayStation,
  lngMeters: number,
) {
  return Math.hypot(
    (from.lng - to.lng) * lngMeters,
    (from.lat - to.lat) * METERS_PER_DEGREE_LAT,
  );
}

// The records that are one place, folded into one marker each: the union of their routes at the
// centre of the records it merged, under the name of the record serving the most routes.
//
// What counts as one place has two answers, and each record says which of them applies to it.
//
// **A record carrying a complex id** was put in that complex by its own agency, in the feed's
// transfers.txt, and joins the records sharing the id and no others — whatever they are called and
// however far apart they are. That is New York's every record. It is the only thing that tells
// Rector St, where the 1 and the N/R/W stand 49.5 m apart with no passage between them, from the
// complexes it looks exactly like; and it is what finally joins the ones the geometry could not,
// Cortlandt St to Chambers St across 435 m of the World Trade Center, Bleecker St to
// Broadway-Lafayette St, Lexington Av/63 St to 59 St.
//
// **A record carrying 0** comes from a feed that publishes no transfer between two stations at all —
// Muni files no transfers.txt and BART's rows are all platform-to-platform inside one station, so
// that is every San Francisco record — and there the geometry below is all there is: single-link
// grouping, every record within SAME_PLACE_METERS of another joining it, as does every record within
// SAME_NAME_METERS carrying the same canonical name, so a station strung out in a line collapses
// whole rather than pair by pair. A pair with one of each falls back to the same rule: an agency
// that has said nothing about a record has not said it is separate.
//
// Measured against the geometry alone, the transfers move 17 places in New York and none in San
// Francisco: they split Rector St, and they join sixteen complexes no distance could have reached —
// the World Trade Center's four records over 435 m, Times Sq to 42 St-Port Authority, 59 St to
// Lexington Av/59 St to Lexington Av/63 St. New York's 496 records come out as 444 markers where the
// old geometric rule made 463, and San Francisco's 268 as 217 under either.
//
// The surviving name is the record serving the most routes because that is the record the agency
// treats as the station rather than the kerb beside it: it picks "Metro Civic Center Station" over
// "Market St & Hyde St", and "Jackson Hts-Roosevelt Av" (5 routes) over "74 St-Broadway" (2). Ties
// go to the shorter name — "Van Ness Station" over "Metro Van Ness Station" — and then to the file's
// own order, which is south to north.
export function mergeStations(
  stations: readonly SubwayStation[],
): SubwayStation[] {
  const midLat = stations.length
    ? stations[Math.floor(stations.length / 2)].lat
    : 0;
  const lngMeters = METERS_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180);
  const canonical = stations.map(({ name }) => canonicalName(name));

  const parent = stations.map((_, index) => index);
  const find = (index: number): number =>
    parent[index] === index ? index : (parent[index] = find(parent[index]));
  for (let left = 0; left < stations.length; left++) {
    for (let right = left + 1; right < stations.length; right++) {
      const apart = metersApart(stations[left], stations[right], lngMeters);
      // Two records are one marker when they look like one place AND the agency does not say
      // otherwise. Looking like one place is the distance-and-name test; the transfer data is a
      // VETO on it, not a trigger. Read the other way round it merges stations that are genuinely
      // distinct: Times Sq and 42 St-Port Authority are one complex in transfers.txt, 386 m apart
      // and signed as two stations, and a rider told to walk to "Times Sq" does not mean Eighth
      // Avenue. What the veto is for is the opposite case — Rector St's two stations sit 49.5 m
      // apart under one name with no passage between them, and only the feed knows that.
      const sameName =
        apart < SAME_PLACE_METERS ||
        (apart < SAME_NAME_METERS && canonical[left] === canonical[right]);
      const answered =
        stations[left].complex !== 0 && stations[right].complex !== 0;
      const together =
        sameName &&
        (!answered || stations[left].complex === stations[right].complex);
      if (together) {
        // The lower index always wins the root, so a group's root is its earliest member however
        // the links came in — which is what makes the marker order below the file's own.
        const roots = [find(left), find(right)];
        parent[Math.max(...roots)] = Math.min(...roots);
      }
    }
  }

  // Keyed on the group's root, its earliest member, so the markers come out in the file's order and
  // an index into them is stable.
  const groups = new Map<number, number[]>();
  for (let station = 0; station < stations.length; station++) {
    const root = find(station);
    const members = groups.get(root);
    if (members) {
      members.push(station);
    } else {
      groups.set(root, [station]);
    }
  }

  return [...groups.values()].map((members) => {
    let routes = 0;
    let lng = 0;
    let lat = 0;
    for (const member of members) {
      routes |= stations[member].routes;
      lng += stations[member].lng;
      lat += stations[member].lat;
    }
    const best = members.reduce((chosen, member) => {
      const gained =
        stationRouteIndices(stations[member]).length -
        stationRouteIndices(stations[chosen]).length;
      const shorter = canonical[member].length - canonical[chosen].length;
      return gained > 0 || (gained === 0 && shorter < 0) ? member : chosen;
    });
    return {
      lng: lng / members.length,
      lat: lat / members.length,
      name: canonical[best],
      routes,
      complex: stations[members[0]].complex,
    };
  });
}
