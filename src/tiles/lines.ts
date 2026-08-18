import { resolveUrl } from "./base-url";
import { routeStyles } from "./ferry-routes";
import { projectX, projectY, unproject } from "./mercator";
import {
  bucketize,
  decodeNames,
  laneRibbons,
  laneSpacingPx,
  type Polyline,
  readPolyline,
} from "./polylines";
import type { LinesParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { splinePath } from "./spline";
import type { Cursor } from "./varint";

// A line overlay: the committed highway/rail nuisance lines (magic HWAY) or the ferry route segments
// (magic FERR), drawn as coloured canvas polylines at every zoom. The ferries additionally take
// their route's colour, a lane of their own over the water they share with another route, and a
// spline through their vertices — see ./ferry-routes, ./polylines and ./spline.

const TILE_SIZE = 256;
const CELL_DEG = 0.01; // ~1.1 km buckets; a line is filed under every cell its bounding box spans
const LINE_WIDTH_PX = 2;

// The grid a crossing's local company is counted over. Ferry routes that share water share it
// almost exactly, because the feeds hand the same track to every route over it: of the 93 km of
// New York route that runs within 300 m of another route, 68% of it runs within 60 m. A cell that
// size takes those and leaves the rest — the Staten Island Ferry and the St. George route cross the
// Upper Bay 100 to 300 m apart for 7 km, two visibly separate lines with no business being stacked.
const LANE_CELL_M = 60;
// How far a crossing takes to slide from one lane to the next where its company changes. Long
// enough that a route joining a bundle crosses to its lane over open water, rather than at
// whichever of the shape's few vertices happens to fall past the junction.
const LANE_BLEND_M = 400;
// The gap between one lane and the next, in CSS pixels, and the zoom it is held at — below which it
// becomes a fixed ground distance, see laneSpacingPx. Two 2 px strokes a lane apart just touch,
// which is as tight as they can be drawn and still read as two.
//
// Pinned at z14 a lane is 18 m of water at every zoom below, which is what the tightest genuine
// bundle affords: the four routes down Buttermilk Channel pass 93 m off the Governors Island shore,
// and the outermost of them is three lanes — 54 m — off its own published path. Of the 204 vertices
// New York's crossings have in open water, that draws none of them onto land between z11 and z14;
// the same lanes assigned once per route instead of per stretch drew 17 of them there.
const LANE_SPACING_PX = 2.5;
const LANE_FULL_ZOOM = 14;

// A ferry crossing's drawing: the route's colour, the lane it takes at each of its vertices, and
// the perpendicular that lane is measured along so the ribbons read as parallel rather than
// repainting each other.
interface Ribbon {
  color: string | null; // null where the route is unknown, so the layer's own colour stands in
  // Per vertex, in lane widths, multiplied by the zoom's lane width at draw time rather than baked
  // in here. Zero where the crossing has the water to itself, which is 60% of New York's vertices.
  lanes: Float64Array;
  // Unit normals per vertex, in projected space, so the offset is applied in screen pixels at draw
  // time rather than in a ground distance that would spread as the map zooms in.
  normalX: Float64Array;
  normalY: Float64Array;
}

interface Lines {
  polylines: Polyline[];
  // Polyline indices filed by `${cellX},${cellY}`, so a tile draw gathers only the lines whose
  // bounding box reaches it rather than the whole city.
  buckets: Map<string, number[]>;
  // Per polyline and index-aligned with it, or null for a source with no route identity (HWAY).
  ribbons: Ribbon[] | null;
}

// HWAY is the shared polygon layout (crates/tiler/src/binfmt.rs read_polygons): a 40-byte header,
// then `count` polygons, each a u16 ring count then per ring a u32 vertex count and varint (lng, lat)
// deltas. Each nuisance line is one open ring of a single-ring polygon, so every ring is a polyline.
function decodeHway(buffer: ArrayBuffer): Polyline[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  const polylines: Polyline[] = [];
  for (let polygon = 0; polygon < count; polygon++) {
    const rings = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    for (let ring = 0; ring < rings; ring++) {
      const vertices = view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      polylines.push(
        readPolyline(bytes, cursor, vertices, originLng, originLat, scale),
      );
    }
  }
  return polylines;
}

// FERR (crates/tiler/src/binfmt.rs read_ferries): a 56-byte header, a stop table (i32 qx, i32 qy,
// u32 nameId — 12 B), a segment table (u32 stopA, u32 stopB, f32 rawTime, u32 geomOffset, u16
// geomCount, u16 routeNameId — 20 B), then a varint geometry blob and the name blob. A segment draws
// its shape when it has one, else a straight line between its two stops.
function decodeFerr(buffer: ArrayBuffer): {
  polylines: Polyline[];
  routes: (string | null)[];
} {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const NO_GEOMETRY = 0xffffffff;
  const NO_ROUTE = 0xffff;
  const STOP_BYTES = 12;
  const SEGMENT_BYTES = 20;
  const headerBytes = view.getUint16(6, true);
  const stopCount = view.getUint32(8, true);
  const segmentCount = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const geometryOffset = view.getUint32(40, true);
  const names = decodeNames(view, bytes, view.getUint32(48, true));

  const stopTable = headerBytes;
  const stopLng = new Float64Array(stopCount);
  const stopLat = new Float64Array(stopCount);
  for (let stop = 0; stop < stopCount; stop++) {
    const record = stopTable + stop * STOP_BYTES;
    stopLng[stop] = originLng + view.getInt32(record, true) * scale;
    stopLat[stop] = originLat + view.getInt32(record + 4, true) * scale;
  }

  const segmentTable = stopTable + stopCount * STOP_BYTES;
  const polylines: Polyline[] = [];
  const routes: (string | null)[] = [];
  for (let segment = 0; segment < segmentCount; segment++) {
    const record = segmentTable + segment * SEGMENT_BYTES;
    const stopA = view.getUint32(record, true);
    const stopB = view.getUint32(record + 4, true);
    const geomOffset = view.getUint32(record + 12, true);
    const geomCount = view.getUint16(record + 16, true);
    const routeName = view.getUint16(record + 18, true);
    routes.push(routeName === NO_ROUTE ? null : (names[routeName] ?? null));
    if (geomOffset === NO_GEOMETRY) {
      polylines.push({
        lngs: Float64Array.of(stopLng[stopA], stopLng[stopB]),
        lats: Float64Array.of(stopLat[stopA], stopLat[stopB]),
      });
    } else {
      const cursor: Cursor = { offset: geometryOffset + geomOffset };
      polylines.push(
        readPolyline(bytes, cursor, geomCount, originLng, originLat, scale),
      );
    }
  }
  return { polylines, routes };
}

// The latitude the lane grid is measured at — see LaneOptions.
function midLatitude(polylines: readonly Polyline[]): number {
  let sum = 0;
  for (const { lats } of polylines) {
    sum += lats[0];
  }
  return polylines.length ? sum / polylines.length : 0;
}

const loaded = new Map<string, Promise<Lines>>();

export function decodeLines(
  buffer: ArrayBuffer,
  format: LinesParams["format"],
): Lines {
  if (format === "hway") {
    const polylines = decodeHway(buffer);
    return {
      polylines,
      buckets: bucketize(polylines, CELL_DEG),
      ribbons: null,
    };
  } else {
    const { polylines, routes } = decodeFerr(buffer);
    const styles = routeStyles(routes);
    const ribbons = laneRibbons(
      polylines.map((polyline, index) => ({
        ...polyline,
        route: styles[index].route,
      })),
      {
        cellMeters: LANE_CELL_M,
        blendMeters: LANE_BLEND_M,
        latitude: midLatitude(polylines),
      },
    ).map((ribbon, index) => ({ color: styles[index].color, ...ribbon }));
    return { polylines, buckets: bucketize(polylines, CELL_DEG), ribbons };
  }
}

function loadLines({ url, format }: LinesParams): Promise<Lines> {
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
        return decodeLines(await response.arrayBuffer(), format);
      })
      .catch((error: unknown) => {
        loaded.delete(url);
        throw error;
      });
    loaded.set(url, request);
    return request;
  }
}

function draw(
  context: OffscreenCanvasRenderingContext2D,
  lines: Lines,
  coords: TileCoords,
  { color }: LinesParams,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const northWest = unproject(originX, originY, zoom);
  const southEast = unproject(originX + TILE_SIZE, originY + TILE_SIZE, zoom);

  context.lineWidth = LINE_WIDTH_PX;
  context.lineJoin = "round";
  context.lineCap = "round";
  const spacing = laneSpacingPx(zoom, LANE_SPACING_PX, LANE_FULL_ZOOM);
  const drawn = new Set<number>();
  for (
    let cellX = Math.floor(northWest.lng / CELL_DEG);
    cellX <= Math.floor(southEast.lng / CELL_DEG);
    cellX++
  ) {
    for (
      let cellY = Math.floor(southEast.lat / CELL_DEG);
      cellY <= Math.floor(northWest.lat / CELL_DEG);
      cellY++
    ) {
      const cell = lines.buckets.get(`${cellX},${cellY}`);
      if (!cell) {
        continue;
      }
      for (const index of cell) {
        if (drawn.has(index)) {
          continue;
        }
        drawn.add(index);
        const { lngs, lats } = lines.polylines[index];
        const ribbon = lines.ribbons?.[index];
        // The whole polyline is projected, not the part inside the tile: both the lane offset and
        // the spline's control points read the vertices either side of a seam, so a tile that
        // clipped first would step and kink along its own edges. The canvas clips instead.
        const pixelX: number[] = [];
        const pixelY: number[] = [];
        for (let vertex = 0; vertex < lngs.length; vertex++) {
          const offset = (ribbon?.lanes[vertex] ?? 0) * spacing;
          pixelX.push(
            projectX(lngs[vertex], zoom) -
              originX +
              offset * (ribbon?.normalX[vertex] ?? 0),
          );
          pixelY.push(
            projectY(lats[vertex], zoom) -
              originY +
              offset * (ribbon?.normalY[vertex] ?? 0),
          );
        }
        context.strokeStyle = ribbon?.color ?? color;
        context.beginPath();
        if (ribbon) {
          splinePath(context, pixelX, pixelY);
        } else {
          for (let vertex = 0; vertex < pixelX.length; vertex++) {
            if (vertex === 0) {
              context.moveTo(pixelX[vertex], pixelY[vertex]);
            } else {
              context.lineTo(pixelX[vertex], pixelY[vertex]);
            }
          }
        }
        context.stroke();
      }
    }
  }
}

export const linesRenderer: TileRenderer<LinesParams, Lines> = {
  load: loadLines,
  draw,
};
