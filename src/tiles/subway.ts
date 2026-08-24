import {
  decodeSubway,
  mergeStations,
  type SubwayRoute,
  type SubwayStation,
  stationRouteIndices,
} from "../subway/format";
import { resolveUrl } from "./base-url";
import { drawLabels, type PlacedLabels, placeLabels } from "./labels";
import { projectX, projectY, unproject } from "./mercator";
import {
  bucketize,
  laneRibbons,
  laneSpacingPx,
  type Polyline,
} from "./polylines";
import type { SubwayParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { splinePath } from "./spline";

// The subway overlay: the MTA's 93 drawn shape variants in the colours the feed publishes, and a
// marker at each place they stop — 444 of them in New York, 217 in San Francisco, after the records
// naming one place twice are merged (../subway/format). From z15 the marker is the bullets of the
// routes calling there rather than a dot. The machinery is the ferry layer's (./polylines, ./spline,
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

const STATION_MIN_ZOOM = 13;
const STATION_LABEL_ZOOM = 15;
const STATION_BASE_RADIUS_PX = 2.5;
const STATION_LABEL_COLOR = "#ffffff"; // over the dark outline ./labels strokes, legible on either theme
// What a station serving routes of more than one colour is ringed in — Times Sq is not any one
// line — and what a line whose route the file does not name falls back to.
const NEUTRAL_COLOR = "#334155"; // slate-700

// The zoom the dot gives way to the routes' bullets. A bullet block is far more ink than a dot, and
// the budget is what pays for it: counting how many markers' blocks overlap another's, z13 is 14%
// in New York and 50% in San Francisco, z14 is 5% and 16%, and z15 is 1.7% and 4.1% — the first
// zoom where under one marker in twenty collides. It is also where the names appear, so nothing new
// is asked of a zoom that was previously quiet.
const BULLET_ZOOM = 15;
// Bullets past this many wrap onto another row, so the block stays about as wide as it is tall
// instead of running along the street. Times Sq-42 St serves 10 routes and Powell 12, which is
// three rows; both cities' next busiest are 9 and 10.
const BULLETS_PER_ROW = 4;
const BULLET_GAP_PX = 1.5;
const BULLET_OUTLINE = "#ffffff"; // parts touching bullets, and lifts a dark one off a dark map
// A bullet at BULLET_ZOOM, growing 2 px a zoom. 12 px is the smallest a two-letter name still reads
// in, which is what San Francisco's cable cars need: CA, PH and PM publish the same colour as the F,
// so a plain disc would leave four routes looking alike.
const BULLET_BASE_DIAMETER_PX = 12;
const BULLET_MAX_DIAMETER_PX = 16;
// The name sits inside a box this fraction of the bullet across, at the size that fraction of it —
// the proportions the MTA sets its own bullets at. A two-character name is set smaller so it has a
// chance of fitting, and squeezed horizontally the rest of the way, which is what a real bullet does
// with a two-character legend.
const BULLET_TEXT_WIDTH = 0.82;
const BULLET_TEXT_SIZE = 0.78;
const BULLET_PAIR_TEXT_SIZE = 0.6;
// A diamond is a narrower box than a circle of the same width, so its name gets less room.
const DIAMOND_TEXT_WIDTH = 0.58;
// Longer than this and the short name is a word rather than a legend, so the bullet is left plain
// and its colour carries the route. That is what BART wants: its four routes are *named* "Yellow",
// "Green", "Red" and "Blue" and published in exactly those colours, so the disc is the name. It also
// leaves the Staten Island Railway ("SIR") a plain navy disc, the only route on the island. Every
// other route in either city is one or two characters once the express diamonds are folded in.
const BULLET_MAX_TEXT_CHARS = 2;

interface DrawnLine extends Polyline {
  color: string;
  lanes: Float64Array; // per vertex, in lane widths, from laneTracks

  // Unit normals per vertex, in projected space, so the lane is a screen offset at draw time.
  normalX: Float64Array;
  normalY: Float64Array;
}

// What one route's bullet says and what shape says it.
interface RouteBullet {
  color: string;
  textColor: string;
  text: string;
  diamond: boolean;
}

interface Subway {
  lines: DrawnLine[];
  // Line indices filed by `${cellX},${cellY}`, so a tile draw gathers only the lines whose bounding
  // box reaches it rather than the whole system.
  buckets: Map<string, number[]>;
  stationBuckets: Map<string, number[]>;
  bullets: RouteBullet[];
  // Per marker, the routes calling there, in the feed's own route order.
  stationRoutes: number[][];
  // Per marker, the colour of its dot's ring below BULLET_ZOOM — see stationRing.
  rings: string[];
  names: string[];
  lngs: Float64Array;
  lats: Float64Array;
  // Per zoom, the placed station labels; filled on the first tile that needs one.
  labels: Map<number, PlacedLabels>;
}

// The MTA files the express variant of a service as its own route, named for the local plus an X:
// FX is the Brooklyn F express, 6X the Pelham Bay Park express, 7X the Flushing express. No sign in
// the system says "6X" — the MTA draws those three in a diamond around the plain number, which is
// what a rider is looking for, so that is what the bullet shows. A route is an express variant only
// when the file also holds the route it is named after, which is what keeps a name that merely ends
// in X from being mistaken for one. San Francisco has none.
// At a station where both a service and its express variant call, the two bullets say one thing
// twice — every express stop in the system is also a local stop, checked against the feed: of the 29
// stations the 6X serves, the 39 the FX serves and the 18 the 7X serves, not one lacks the plain
// route. So the diamond alone carries it: a diamond means the express stops here as well, a circle
// means the local only, and nothing is lost by dropping the circle beside a diamond.
function foldExpressPairs(
  indices: readonly number[],
  routes: readonly SubwayRoute[],
): number[] {
  const expressed = new Set(
    indices
      .map((index) => routes[index]?.shortName)
      .filter((name): name is string => name?.endsWith("X") ?? false)
      .map((name) => name.slice(0, -1)),
  );
  return indices.filter((index) => {
    const name = routes[index]?.shortName;
    return name === undefined || !expressed.has(name);
  });
}

function routeBullets(routes: readonly SubwayRoute[]): RouteBullet[] {
  const names = new Set(routes.map(({ shortName }) => shortName));
  return routes.map(({ color, textColor, shortName }) => {
    const diamond =
      shortName.endsWith("X") && names.has(shortName.slice(0, -1));
    return {
      color,
      textColor,
      text: diamond ? shortName.slice(0, -1) : shortName,
      diamond,
    };
  });
}

// A station's ring takes its routes' colour when they all publish the same one — which is what the
// system's trunks look like, the 4/5/6 all green — and the neutral otherwise, because a station on
// two trunks is not either of their colours. 179 of New York's 444 markers serve one route alone.
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

export function decodeSubwayTiles(buffer: ArrayBuffer): Subway {
  const { routes, lines, stations: records } = decodeSubway(buffer);
  // One marker per place, not per record: New York spreads a complex over several records, and San
  // Francisco's feeds file a stop once per kerb. Which records are one place is the MTA's own answer
  // where the feed gives one and a geometric guess where it does not — see ../subway/format.
  const stations = mergeStations(records);
  const midLat = stations.length
    ? stations[Math.floor(stations.length / 2)].lat
    : 0;
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
    bullets: routeBullets(routes),
    stationRoutes: stations.map((station) =>
      foldExpressPairs(stationRouteIndices(station), routes),
    ),
    rings: stations.map((station) => stationRing(station, routes)),
    names: stations.map(({ name }) => name),
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

function bulletDiameter(zoom: number): number {
  return Math.min(
    BULLET_MAX_DIAMETER_PX,
    BULLET_BASE_DIAMETER_PX + (zoom - BULLET_ZOOM) * 2,
  );
}

interface BulletBlock {
  diameter: number;
  pitch: number; // one bullet's centre to the next
  rows: number;
  halfWidth: number;
  halfHeight: number;
}

function bulletBlock(count: number, zoom: number): BulletBlock {
  const diameter = bulletDiameter(zoom);
  const pitch = diameter + BULLET_GAP_PX;
  const rows = Math.ceil(count / BULLETS_PER_ROW);
  return {
    diameter,
    pitch,
    rows,
    halfWidth: (Math.min(count, BULLETS_PER_ROW) * pitch - BULLET_GAP_PX) / 2,
    halfHeight: (rows * pitch - BULLET_GAP_PX) / 2,
  };
}

// Half the marker's size, whichever marker this zoom draws — what the tile cull tests against and
// what ./labels sets the name beside.
function markerExtent(
  subway: Subway,
  station: number,
  zoom: number,
): { halfWidth: number; halfHeight: number } {
  if (zoom < BULLET_ZOOM) {
    const radius = stationRadius(zoom);
    return { halfWidth: radius, halfHeight: radius };
  } else {
    return bulletBlock(subway.stationRoutes[station].length, zoom);
  }
}

const BULLET_FONT_FAMILY = "system-ui, sans-serif";
const BULLET_REFERENCE_PX = 10;
// A name's width scales with the font size, so one measurement per route solves for the size that
// fits every bullet it is ever drawn in. Shared across tiles because the font is.
const referenceWidths = new Map<string, number>();

// How to set the route's name inside its bullet — the font size and how far it has to be squeezed
// across to fit — or null for a bullet that carries no name.
function bulletText(
  context: OffscreenCanvasRenderingContext2D,
  { text, diamond }: RouteBullet,
  diameter: number,
): { size: number; squeeze: number } | null {
  if (!text || text.length > BULLET_MAX_TEXT_CHARS) {
    return null;
  }
  let reference = referenceWidths.get(text);
  if (reference === undefined) {
    context.font = `700 ${BULLET_REFERENCE_PX}px ${BULLET_FONT_FAMILY}`;
    reference = context.measureText(text).width;
    referenceWidths.set(text, reference);
  }
  const size =
    diameter * (text.length > 1 ? BULLET_PAIR_TEXT_SIZE : BULLET_TEXT_SIZE);
  const room = diameter * (diamond ? DIAMOND_TEXT_WIDTH : BULLET_TEXT_WIDTH);
  const width = (reference * size) / BULLET_REFERENCE_PX;
  return { size, squeeze: Math.min(1, room / width) };
}

function bulletPath(
  context: OffscreenCanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  diamond: boolean,
): void {
  context.beginPath();
  if (diamond) {
    context.moveTo(centerX, centerY - radius);
    context.lineTo(centerX + radius, centerY);
    context.lineTo(centerX, centerY + radius);
    context.lineTo(centerX - radius, centerY);
    context.closePath();
  } else {
    context.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  }
}

// The routes calling at one marker, as a block of bullets centred on it: the coloured disc with the
// route's own name inside in its own text colour, which is what route_text_color is published for.
function drawBullets(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  station: number,
  markerX: number,
  markerY: number,
  zoom: number,
): void {
  const indices = subway.stationRoutes[station];
  const { diameter, pitch, rows, halfHeight } = bulletBlock(
    indices.length,
    zoom,
  );
  const radius = diameter / 2;
  context.lineWidth = 1;
  context.strokeStyle = BULLET_OUTLINE;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let row = 0; row < rows; row++) {
    const inRow = indices.slice(
      row * BULLETS_PER_ROW,
      (row + 1) * BULLETS_PER_ROW,
    );
    // Each row is centred in its own right, so a last row of one or two sits under the middle of
    // the ones above rather than hanging off the left of the block.
    const left = markerX - (inRow.length * pitch - BULLET_GAP_PX) / 2 + radius;
    const centerY = markerY - halfHeight + radius + row * pitch;
    for (const [column, index] of inRow.entries()) {
      const bullet = subway.bullets[index];
      const centerX = left + column * pitch;
      context.fillStyle = bullet?.color ?? NEUTRAL_COLOR;
      bulletPath(context, centerX, centerY, radius, bullet?.diamond ?? false);
      context.fill();
      context.stroke();
      const legend = bullet && bulletText(context, bullet, diameter);
      if (bullet && legend) {
        context.font = `700 ${legend.size}px ${BULLET_FONT_FAMILY}`;
        context.fillStyle = bullet.textColor;
        context.save();
        context.translate(centerX, centerY);
        context.scale(legend.squeeze, 1);
        context.fillText(bullet.text, 0, 0);
        context.restore();
      }
    }
  }
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

// Below BULLET_ZOOM a station is a white disc ringed in its routes' colour, the symbol the MTA's own
// map uses; from BULLET_ZOOM it is the routes themselves. Either way it is the one thing on the
// layer whose colours are the MTA's rather than the theme's, so it has to read over a dark map and a
// light one alike. Below STATION_MIN_ZOOM there is no marker at all: at z12 91 of New York's
// markers sit within 6 px of another and at z11 156 do, so they stop being stations and become a
// smear over the lines that already say where the system runs. At z13 that is down to 4.
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
  for (let cellX = cellX0; cellX <= cellX1; cellX++) {
    for (let cellY = cellY0; cellY <= cellY1; cellY++) {
      for (const station of subway.stationBuckets.get(`${cellX},${cellY}`) ??
        []) {
        const markerX = projectX(subway.lngs[station], zoom) - originX;
        const markerY = projectY(subway.lats[station], zoom) - originY;
        const { halfWidth, halfHeight } = markerExtent(subway, station, zoom);
        if (
          markerX < -halfWidth ||
          markerX > TILE_SIZE + halfWidth ||
          markerY < -halfHeight ||
          markerY > TILE_SIZE + halfHeight
        ) {
          continue;
        }
        if (zoom >= BULLET_ZOOM) {
          drawBullets(context, subway, station, markerX, markerY, zoom);
        } else {
          context.lineWidth = 1.5;
          context.fillStyle = "#ffffff";
          context.beginPath();
          context.arc(markerX, markerY, halfWidth, 0, 2 * Math.PI);
          context.fill();
          context.strokeStyle = subway.rings[station];
          context.stroke();
        }
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
    // Busiest first, because placement is greedy and the markers now take real room: whoever is
    // offered a spot first keeps it, and at z15 in Midtown that decides between naming Times Sq-42
    // St and naming a one-line stop two blocks away. Ties keep the file's order.
    const order = subway.names
      .map((_, station) => station)
      .sort(
        (left, right) =>
          subway.stationRoutes[right].length -
          subway.stationRoutes[left].length,
      );
    const extents = order.map((station) => markerExtent(subway, station, zoom));
    const placed = placeLabels(
      context,
      {
        lngs: order.map((station) => subway.lngs[station]),
        lats: order.map((station) => subway.lats[station]),
        names: order.map((station) => subway.names[station]),
        halfWidths: extents.map(({ halfWidth }) => halfWidth),
        halfHeights: extents.map(({ halfHeight }) => halfHeight),
      },
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
    // One cell wider than the tile, because a marker centred just outside it still reaches in: a
    // twelve-route block is 47 px, 170 m at z15, where a cell is 1.1 km. Both halves of a block
    // straddling a seam are then drawn at the same world position by each side and line up.
    drawStations(
      context,
      subway,
      coords,
      cellX0 - 1,
      cellX1 + 1,
      cellY0 - 1,
      cellY1 + 1,
    );
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
