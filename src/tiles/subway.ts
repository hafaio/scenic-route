import {
  decodeSubway,
  type SubwayRoute,
  type SubwayStation,
} from "../subway/format";
import { resolveUrl } from "./base-url";
import { drawLabels, type PlacedLabels, placeLabels } from "./labels";
import { projectX, projectY, unproject } from "./mercator";
import {
  bucketize,
  laneRibbons,
  laneSpacingPx,
  METERS_PER_DEGREE_LAT,
  metersPerLng,
  type Polyline,
} from "./polylines";
import type { SubwayParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { splinePath } from "./spline";

// The subway overlay: the MTA's 93 drawn shape variants in the colours the feed publishes, and a
// marker at each of the 496 stations. The machinery is the ferry layer's (./polylines, ./spline,
// ./labels), including the per-stretch lanes; what is different is that subway overlap is an order
// heavier — 10 routes share the track through Atlantic Av-Barclays Ctr, 4 the Lexington Av trunk —
// and that the trunks are narrow, so the grid the company is counted over is 40 m and not 60.

const TILE_SIZE = 256;
const CELL_DEG = 0.01; // ~1.1 km buckets; a line is filed under every cell its bounding box spans
const LINE_WIDTH_PX = 2;

// The gap between one lane and the next, in CSS pixels, and the zoom it is held at (below which it
// becomes a ground distance — see laneSpacingPx). Wider than the ferries' 2.5 px because the
// bundles are: a 0.5 px gap between 2 px strokes reads as one fat band once four of them are
// stacked, where 1 px keeps each route's colour its own. At z15 (3.6 m/px at 40.75°) the Lexington
// trunk's three lanes span 9 px, about the 30 m width of Lexington Av itself; the ten-route stack at
// Atlantic Av spans 27 px, about the width of that junction's own street footprint.
const LANE_SPACING_PX = 3;
const LANE_FULL_ZOOM = 15;

// The grid the local route set is counted over. 40 m is wider than the two tracks of one trunk are
// apart and narrower than the ~80 m between the avenues a parallel route would run under, so a cell
// holds a trunk and not its neighbour. Measured over the whole file: 10,763 cells, of which 95% hold
// four routes or fewer and three hold ten.
const TRUNK_CELL_M = 40;
// How far a route takes to slide from one lane to the next where the set around it changes. Under
// the ~700 m between New York's stations, so a fan-out finishes before the next one, and several
// times the 46.6 m mean spacing of the shapes' own vertices, so it is a diagonal and not a step.
const LANE_BLEND_M = 250;

// Two same-named stations linked by a chain of hops shorter than this are one complex under several
// of its lines: Times Sq-42 St is five records spread over 153 m, one per trunk. Every marker is
// drawn, since each sits on a line of its own, but only the first of a chain is named, so a complex
// reads as one place. 200 m is about two Manhattan short blocks, which is where the city stops
// repeating itself and starts genuinely reusing a name — Wall St on the 2/3 and Wall St on the 4/5
// are two unconnected stations 247 m apart, and both deserve their label.
const SAME_COMPLEX_METERS = 200;

const STATION_MIN_ZOOM = 13;
const STATION_LABEL_ZOOM = 15;
const STATION_BASE_RADIUS_PX = 2.5;
const STATION_LABEL_COLOR = "#ffffff"; // over the dark outline ./labels strokes, legible on either theme
// What a station serving routes of more than one colour is ringed in — Times Sq is not any one
// line — and what a line whose route the file does not name falls back to.
const NEUTRAL_COLOR = "#334155"; // slate-700

interface DrawnLine extends Polyline {
  color: string;
  lanes: Float64Array; // per vertex, in lane widths, from laneTracks

  // Unit normals per vertex, in projected space, so the lane is a screen offset at draw time.
  normalX: Float64Array;
  normalY: Float64Array;
}

interface Subway {
  lines: DrawnLine[];
  // Line indices filed by `${cellX},${cellY}`, so a tile draw gathers only the lines whose bounding
  // box reaches it rather than the whole system.
  buckets: Map<string, number[]>;
  stationBuckets: Map<string, number[]>;
  // Per station, the colour of its marker's ring — see stationRing.
  rings: string[];
  names: string[];
  lngs: Float64Array;
  lats: Float64Array;
  // Per zoom, the placed station labels; filled on the first tile that needs one.
  labels: Map<number, PlacedLabels>;
}

// A station's ring takes its routes' colour when they all publish the same one — which is what the
// system's trunks look like, the 4/5/6 all green — and the neutral otherwise, because a station on
// two trunks is not either of their colours. 171 of the 496 are served by one route alone.
function stationRing(
  station: SubwayStation,
  routes: readonly SubwayRoute[],
): string {
  const colors = new Set(
    routes
      .filter((_, index) => (station.routes & (1 << index)) !== 0)
      .map(({ color }) => color),
  );
  return colors.size === 1 ? [...colors][0] : NEUTRAL_COLOR;
}

// The station names to label, with every repeat of a complex blanked — placeLabels skips an empty
// name, so the marker stays and the second "Times Sq-42 St" does not. The comparison is against
// every station seen and not only the named ones, so a complex strung out in a line collapses to one
// name rather than to one per hop.
function complexNames(
  stations: readonly SubwayStation[],
  lngMeters: number,
): string[] {
  const seen: SubwayStation[] = [];
  return stations.map((station) => {
    const repeat = seen.some(
      (other) =>
        other.name === station.name &&
        Math.hypot(
          (other.lng - station.lng) * lngMeters,
          (other.lat - station.lat) * METERS_PER_DEGREE_LAT,
        ) < SAME_COMPLEX_METERS,
    );
    seen.push(station);
    return repeat ? "" : station.name;
  });
}

export function decodeSubwayTiles(buffer: ArrayBuffer): Subway {
  const { routes, lines, stations } = decodeSubway(buffer);
  const midLat = stations.length
    ? stations[Math.floor(stations.length / 2)].lat
    : 0;
  const lngMeters = metersPerLng(midLat);
  const ribbons = laneRibbons(lines, {
    cellMeters: TRUNK_CELL_M,
    blendMeters: LANE_BLEND_M,
    latitude: midLat,
  });

  const drawn = lines.map(({ lngs, lats, route }, index) => ({
    lngs,
    lats,
    color: routes[route]?.color ?? NEUTRAL_COLOR,
    ...ribbons[index],
  }));

  return {
    lines: drawn,
    buckets: bucketize(drawn, CELL_DEG),
    stationBuckets: bucketize(
      stations.map(({ lng, lat }) => ({
        lngs: Float64Array.of(lng),
        lats: Float64Array.of(lat),
      })),
      CELL_DEG,
    ),
    rings: stations.map((station) => stationRing(station, routes)),
    names: complexNames(stations, lngMeters),
    lngs: Float64Array.from(stations, ({ lng }) => lng),
    lats: Float64Array.from(stations, ({ lat }) => lat),
    labels: new Map(),
  };
}

const loaded = new Map<string, Promise<Subway>>();

function loadSubway({ url }: SubwayParams): Promise<Subway> {
  const pending = loaded.get(url);
  if (pending) {
    return pending;
  } else {
    const resolved = resolveUrl(url);
    const request = fetch(resolved)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `${resolved}: ${response.status} ${response.statusText}`,
          );
        }
        return decodeSubwayTiles(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        loaded.delete(url);
        throw error;
      });
    loaded.set(url, request);
    return request;
  }
}

function stationRadius(zoom: number): number {
  return Math.min(5, STATION_BASE_RADIUS_PX + Math.max(0, zoom - 13) * 0.4);
}

function drawLines(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  coords: TileCoords,
  cellX0: number,
  cellX1: number,
  cellY0: number,
  cellY1: number,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const spacing = laneSpacingPx(zoom, LANE_SPACING_PX, LANE_FULL_ZOOM);
  context.lineWidth = LINE_WIDTH_PX;
  context.lineJoin = "round";
  context.lineCap = "round";
  const drawn = new Set<number>();
  for (let cellX = cellX0; cellX <= cellX1; cellX++) {
    for (let cellY = cellY0; cellY <= cellY1; cellY++) {
      for (const index of subway.buckets.get(`${cellX},${cellY}`) ?? []) {
        if (drawn.has(index)) {
          continue;
        }
        drawn.add(index);
        const { lngs, lats, lanes, normalX, normalY, color } =
          subway.lines[index];
        // The whole line is projected, not the part inside the tile: the lane offset, the lane
        // blend and the spline's control points all read vertices the tile does not contain, so a
        // tile that clipped first would step and kink along its own edges. The canvas clips instead.
        const pixelX: number[] = [];
        const pixelY: number[] = [];
        for (let vertex = 0; vertex < lngs.length; vertex++) {
          const offset = lanes[vertex] * spacing;
          pixelX.push(
            projectX(lngs[vertex], zoom) - originX + offset * normalX[vertex],
          );
          pixelY.push(
            projectY(lats[vertex], zoom) - originY + offset * normalY[vertex],
          );
        }
        context.strokeStyle = color;
        context.beginPath();
        splinePath(context, pixelX, pixelY);
        context.stroke();
      }
    }
  }
}

// A white disc ringed in its routes' colour, the symbol the MTA's own map uses — and the one thing
// on the layer that has to read the same over a dark map as a light one, since the pane escapes the
// dark-mode invert. Below STATION_MIN_ZOOM there are no markers at all: at z12 91 of the 496
// stations sit within 6 px of another and at z11 156 do, so the markers stop being 496 stations and
// become a smear over the lines that already say where the system runs. At z13 that is down to 41,
// all of them in Midtown and Downtown.
function drawStations(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  coords: TileCoords,
  cellX0: number,
  cellX1: number,
  cellY0: number,
  cellY1: number,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const radius = stationRadius(zoom);
  context.lineWidth = 1.5;
  context.fillStyle = "#ffffff";
  for (let cellX = cellX0; cellX <= cellX1; cellX++) {
    for (let cellY = cellY0; cellY <= cellY1; cellY++) {
      for (const station of subway.stationBuckets.get(`${cellX},${cellY}`) ??
        []) {
        const markerX = projectX(subway.lngs[station], zoom) - originX;
        const markerY = projectY(subway.lats[station], zoom) - originY;
        if (
          markerX < -radius ||
          markerX > TILE_SIZE + radius ||
          markerY < -radius ||
          markerY > TILE_SIZE + radius
        ) {
          continue;
        }
        context.beginPath();
        context.arc(markerX, markerY, radius, 0, 2 * Math.PI);
        context.fill();
        context.strokeStyle = subway.rings[station];
        context.stroke();
      }
    }
  }
}

function labelsAt(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  zoom: number,
): PlacedLabels {
  const cached = subway.labels.get(zoom);
  if (cached) {
    return cached;
  } else {
    const placed = placeLabels(
      context,
      subway,
      zoom,
      stationRadius(zoom),
      false,
    );
    subway.labels.set(zoom, placed);
    return placed;
  }
}

function draw(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  coords: TileCoords,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const northWest = unproject(originX, originY, zoom);
  const southEast = unproject(originX + TILE_SIZE, originY + TILE_SIZE, zoom);
  const cellX0 = Math.floor(northWest.lng / CELL_DEG);
  const cellX1 = Math.floor(southEast.lng / CELL_DEG);
  const cellY0 = Math.floor(southEast.lat / CELL_DEG);
  const cellY1 = Math.floor(northWest.lat / CELL_DEG);

  drawLines(context, subway, coords, cellX0, cellX1, cellY0, cellY1);
  if (zoom >= STATION_MIN_ZOOM) {
    drawStations(context, subway, coords, cellX0, cellX1, cellY0, cellY1);
  }
  if (zoom >= STATION_LABEL_ZOOM) {
    drawLabels(
      context,
      labelsAt(context, subway, zoom),
      coords,
      STATION_LABEL_COLOR,
      false,
    );
  }
}

export const subwayRenderer: TileRenderer<SubwayParams, Subway> = {
  load: loadSubway,
  draw,
};
