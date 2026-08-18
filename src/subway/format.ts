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
const ROUTE_BYTES = 16;
const LINE_BYTES = 8;
const STATION_BYTES = 16;

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
    });
  }

  return { routes, lines, stations };
}

// The short names of the routes a station's mask names, in the file's route order — which is the
// MTA's own `route_sort_order`, so a station reads "A, C, E" the way the signs at it do.
export function stationRoutes(
  station: SubwayStation,
  routes: readonly SubwayRoute[],
): string[] {
  return routes
    .filter((_, index) => (station.routes & (1 << index)) !== 0)
    .map(({ shortName }) => shortName);
}
