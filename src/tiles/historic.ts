import { resolveUrl } from "./base-url";
import { projectX, projectY, unproject } from "./mercator";
import { bucketize, type Polyline, readPolyline } from "./polylines";
import type { HistoricParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import type { Cursor } from "./varint";

// A city's designated historic districts (magic HDST), drawn as filled polygons — an inspection
// layer for seeing which neighbourhoods the city has landmarked whole, as against the individual
// buildings the landmarks overlay dots. The decoding and the drawing both live here in the tile
// worker.

const TILE_SIZE = 256;
const CELL_DEG = 0.005; // ~550 m buckets; a district is filed under every cell its bounding box spans
// Indigo-700, at the industrial wash's alpha so the streets and the buildings under a district read
// through. Far enough from the pink industrial lots, the violet commercial field and the amber
// landmark dots to tell apart as a wash.
const FILL_COLOR = "#4338ca";
const FILL_ALPHA = 0.45;
// A district smaller than this on screen is drawn as a square of it instead. Five of them are a
// single building — St. Mark's Extension is 278 m² — and at the citywide zooms antialiasing fades a
// fraction of a pixel to nothing, which would drop them from the view the layer's extent is read at.
const MIN_DISTRICT_PX = 1.5;

interface Districts {
  districts: Polyline[][]; // per district its rings, filled even-odd so an inner ring punches a hole
  // District indices filed by `${cellX},${cellY}`, so a tile draw gathers only the districts whose
  // bounding box reaches it rather than all 187 of them.
  buckets: Map<string, number[]>;
}

// HDST is the shared polygon layout (scripts/geometry.ts encodePolygons): a 40-byte header, then
// `count` polygons, each a u16 ring count then per ring a u32 vertex count and varint (lng, lat)
// deltas. Nothing in the tiler reads it — this overlay is the only reader.
export function decodeHistoric(buffer: ArrayBuffer): Districts {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  const districts: Polyline[][] = [];
  for (let polygon = 0; polygon < count; polygon++) {
    const ringCount = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    const rings: Polyline[] = [];
    for (let ring = 0; ring < ringCount; ring++) {
      const vertices = view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      rings.push(
        readPolyline(bytes, cursor, vertices, originLng, originLat, scale),
      );
    }
    districts.push(rings);
  }

  // One two-point line per district — its bounding box's corners — so the shared bucketing files each
  // district under the cells its box spans, exactly as it files a polyline under the cells its box
  // spans.
  const boxes = districts.map((rings) => {
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (const { lngs, lats } of rings) {
      for (let vertex = 0; vertex < lngs.length; vertex++) {
        minLng = Math.min(minLng, lngs[vertex]);
        maxLng = Math.max(maxLng, lngs[vertex]);
        minLat = Math.min(minLat, lats[vertex]);
        maxLat = Math.max(maxLat, lats[vertex]);
      }
    }
    return {
      lngs: Float64Array.of(minLng, maxLng),
      lats: Float64Array.of(minLat, maxLat),
    };
  });
  return { districts, buckets: bucketize(boxes, CELL_DEG) };
}

const loaded = new Map<string, Promise<Districts>>();

function loadDistricts({ url }: HistoricParams): Promise<Districts> {
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
        return decodeHistoric(await response.arrayBuffer());
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
  { districts, buckets }: Districts,
  coords: TileCoords,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const northWest = unproject(originX, originY, zoom);
  const southEast = unproject(originX + TILE_SIZE, originY + TILE_SIZE, zoom);

  context.globalAlpha = FILL_ALPHA;
  context.fillStyle = FILL_COLOR;
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
      const cell = buckets.get(`${cellX},${cellY}`);
      if (!cell) {
        continue;
      }
      for (const index of cell) {
        if (drawn.has(index)) {
          continue;
        }
        drawn.add(index);
        context.beginPath();
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const { lngs, lats } of districts[index]) {
          for (let vertex = 0; vertex < lngs.length; vertex++) {
            const x = projectX(lngs[vertex], zoom) - originX;
            const y = projectY(lats[vertex], zoom) - originY;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            if (vertex === 0) {
              context.moveTo(x, y);
            } else {
              context.lineTo(x, y);
            }
          }
          context.closePath();
        }
        if (maxX - minX < MIN_DISTRICT_PX && maxY - minY < MIN_DISTRICT_PX) {
          context.fillRect(
            (minX + maxX - MIN_DISTRICT_PX) / 2,
            (minY + maxY - MIN_DISTRICT_PX) / 2,
            MIN_DISTRICT_PX,
            MIN_DISTRICT_PX,
          );
        } else {
          context.fill("evenodd");
        }
      }
    }
  }
  context.globalAlpha = 1;
}

export const historicRenderer: TileRenderer<HistoricParams, Districts> = {
  load: loadDistricts,
  draw,
};
