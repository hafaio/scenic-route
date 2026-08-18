import { resolveUrl } from "./base-url";
import { drawLabels, type PlacedLabels, placeLabels } from "./labels";
import { projectX, projectY, unproject } from "./mercator";
import type { PoiParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { type Cursor, readVarint } from "./varint";

// A point-of-interest overlay: the committed POI points (landmarks, public art) drawn as coloured
// canvas dots at every zoom. Unlike the tree dots there is no raster pyramid below — a few thousand
// points draw live cheaply — so one canvas GridLayer covers the whole zoom range.

const TILE_SIZE = 256;
const BASE_RADIUS_PX = 3.5;
const CELL_DEG = 0.004; // ~440 m spatial buckets, so a tile query scans only nearby points
const LABEL_MIN_ZOOM = 16; // labels only when zoomed in enough to be sparse and readable

interface Points {
  lngs: Float64Array;
  lats: Float64Array;
  names: string[]; // per point, its label ("" when the source named none)
  // Point indices bucketed by `${floor(lng/CELL_DEG)},${floor(lat/CELL_DEG)}`, so a tile draw touches
  // only the cells it overlaps rather than the whole city.
  buckets: Map<string, number[]>;
  // Per zoom, the placed labels; filled on the first tile that needs it. Only the five label zooms
  // can ever be in here, so nothing is evicted.
  labels: Map<number, PlacedLabels>;
}

// Decode the shared point layout (magic LMRK / ARTW): the 40-byte header, then per-point
// zigzag-varint (lng, lat) deltas in sorted order. Mirrors crates/tiler/src/binfmt.rs read_points.
export function decodePoints(buffer: ArrayBuffer, magic: string): Points {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const found = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (found !== magic) {
    throw new Error(`not a ${magic} point blob`);
  }
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  let quantizedX = 0;
  let quantizedY = 0;
  const buckets = new Map<string, number[]>();
  for (let point = 0; point < count; point++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    const lng = originLng + quantizedX * scale;
    const lat = originLat + quantizedY * scale;
    lngs[point] = lng;
    lats[point] = lat;
    const key = `${Math.floor(lng / CELL_DEG)},${Math.floor(lat / CELL_DEG)}`;
    const cell = buckets.get(key);
    if (cell) {
      cell.push(point);
    } else {
      buckets.set(key, [point]);
    }
  }
  // The trailing name blob: per point (in the same sorted order) a u16 UTF-8 length and its bytes.
  const decoder = new TextDecoder();
  const names: string[] = new Array(count);
  for (let point = 0; point < count; point++) {
    const length = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    names[point] = decoder.decode(
      bytes.subarray(cursor.offset, cursor.offset + length),
    );
    cursor.offset += length;
  }
  return { lngs, lats, names, buckets, labels: new Map() };
}

// One in-flight fetch per served blob, shared by every tile that needs it and cached once decoded.
const loaded = new Map<string, Promise<Points>>();

function loadPoints({ url, magic }: PoiParams): Promise<Points> {
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
        return decodePoints(await response.arrayBuffer(), magic);
      })
      .catch((error: unknown) => {
        loaded.delete(url);
        throw error;
      });
    loaded.set(url, request);
    return request;
  }
}

function dotRadius(zoom: number): number {
  return Math.min(7, BASE_RADIUS_PX + Math.max(0, zoom - 14) * 0.6);
}

// Not keyed on `above`: a blob is served to one layer, so its anchor never varies.
function labelsAt(
  context: OffscreenCanvasRenderingContext2D,
  points: Points,
  zoom: number,
  above: boolean,
): PlacedLabels {
  const cached = points.labels.get(zoom);
  if (cached) {
    return cached;
  } else {
    const placed = placeLabels(context, points, zoom, dotRadius(zoom), above);
    points.labels.set(zoom, placed);
    return placed;
  }
}

// Landmarks anchor above their dot and art below, so a co-located pair never collides.
function drawTileLabels(
  context: OffscreenCanvasRenderingContext2D,
  points: Points,
  coords: TileCoords,
  { color, labelAnchor }: PoiParams,
): void {
  const above = labelAnchor === "top";
  drawLabels(
    context,
    labelsAt(context, points, coords.z, above),
    coords,
    color,
    above,
  );
}

// Every point the tile overlaps, projected at the tile's own zoom and filled as a coloured disc
// with a faint dark outline so it reads on any background. The dot grows a little as the map zooms
// in. The spatial buckets keep this to the points actually near the tile.
function draw(
  context: OffscreenCanvasRenderingContext2D,
  points: Points,
  coords: TileCoords,
  params: PoiParams,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const radius = dotRadius(zoom);

  const northWest = unproject(originX, originY, zoom);
  const southEast = unproject(originX + TILE_SIZE, originY + TILE_SIZE, zoom);
  const margin = radius / TILE_SIZE / 2 ** zoom + CELL_DEG;
  const cellX0 = Math.floor((northWest.lng - margin) / CELL_DEG);
  const cellX1 = Math.floor((southEast.lng + margin) / CELL_DEG);
  const cellY0 = Math.floor((southEast.lat - margin) / CELL_DEG);
  const cellY1 = Math.floor((northWest.lat + margin) / CELL_DEG);

  context.lineWidth = 1;
  context.strokeStyle = "rgba(20, 20, 20, 0.4)";
  context.fillStyle = params.color;
  for (let cellX = cellX0; cellX <= cellX1; cellX++) {
    for (let cellY = cellY0; cellY <= cellY1; cellY++) {
      const cell = points.buckets.get(`${cellX},${cellY}`);
      if (!cell) {
        continue;
      }
      for (const point of cell) {
        const px = projectX(points.lngs[point], zoom) - originX;
        const py = projectY(points.lats[point], zoom) - originY;
        if (
          px < -radius ||
          px > TILE_SIZE + radius ||
          py < -radius ||
          py > TILE_SIZE + radius
        ) {
          continue;
        }
        context.beginPath();
        context.arc(px, py, radius, 0, 2 * Math.PI);
        context.fill();
        context.stroke();
      }
    }
  }

  if (zoom >= LABEL_MIN_ZOOM) {
    drawTileLabels(context, points, coords, params);
  }
}

export const poiRenderer: TileRenderer<PoiParams, Points> = {
  load: loadPoints,
  draw,
};
