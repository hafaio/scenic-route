import { resolveUrl } from "./base-url";
import { projectX, projectY, unproject } from "./mercator";
import type { LinesParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { type Cursor, readVarint } from "./varint";

// A line overlay: the committed highway/rail nuisance lines (magic HWAY) or the ferry route segments
// (magic FERR), drawn as coloured canvas polylines at every zoom.

const TILE_SIZE = 256;
const CELL_DEG = 0.01; // ~1.1 km buckets; a line is filed under every cell its bounding box spans
const LINE_WIDTH_PX = 2;

interface Polyline {
  lngs: Float64Array;
  lats: Float64Array;
}

interface Lines {
  polylines: Polyline[];
  // Polyline indices filed by `${cellX},${cellY}`, so a tile draw gathers only the lines whose
  // bounding box reaches it rather than the whole city.
  buckets: Map<string, number[]>;
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
      const lngs = new Float64Array(vertices);
      const lats = new Float64Array(vertices);
      let quantizedX = 0;
      let quantizedY = 0;
      for (let vertex = 0; vertex < vertices; vertex++) {
        quantizedX += readVarint(bytes, cursor);
        quantizedY += readVarint(bytes, cursor);
        lngs[vertex] = originLng + quantizedX * scale;
        lats[vertex] = originLat + quantizedY * scale;
      }
      polylines.push({ lngs, lats });
    }
  }
  return polylines;
}

// FERR (crates/tiler/src/binfmt.rs read_ferries): a 56-byte header, a stop table (i32 qx, i32 qy,
// u32 nameId — 12 B), a segment table (u32 stopA, u32 stopB, f32 rawTime, u32 geomOffset, u16
// geomCount, u16 routeNameId — 20 B), then a varint geometry blob. A segment draws its shape when it
// has one, else a straight line between its two stops.
function decodeFerr(buffer: ArrayBuffer): Polyline[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const NO_GEOMETRY = 0xffffffff;
  const STOP_BYTES = 12;
  const SEGMENT_BYTES = 20;
  const headerBytes = view.getUint16(6, true);
  const stopCount = view.getUint32(8, true);
  const segmentCount = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const geometryOffset = view.getUint32(40, true);

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
  for (let segment = 0; segment < segmentCount; segment++) {
    const record = segmentTable + segment * SEGMENT_BYTES;
    const stopA = view.getUint32(record, true);
    const stopB = view.getUint32(record + 4, true);
    const geomOffset = view.getUint32(record + 12, true);
    const geomCount = view.getUint16(record + 16, true);
    if (geomOffset === NO_GEOMETRY) {
      polylines.push({
        lngs: Float64Array.of(stopLng[stopA], stopLng[stopB]),
        lats: Float64Array.of(stopLat[stopA], stopLat[stopB]),
      });
    } else {
      const lngs = new Float64Array(geomCount);
      const lats = new Float64Array(geomCount);
      const cursor: Cursor = { offset: geometryOffset + geomOffset };
      let quantizedX = 0;
      let quantizedY = 0;
      for (let vertex = 0; vertex < geomCount; vertex++) {
        quantizedX += readVarint(bytes, cursor);
        quantizedY += readVarint(bytes, cursor);
        lngs[vertex] = originLng + quantizedX * scale;
        lats[vertex] = originLat + quantizedY * scale;
      }
      polylines.push({ lngs, lats });
    }
  }
  return polylines;
}

function bucketize(polylines: Polyline[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < polylines.length; index++) {
    const { lngs, lats } = polylines[index];
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      minLng = Math.min(minLng, lngs[vertex]);
      maxLng = Math.max(maxLng, lngs[vertex]);
      minLat = Math.min(minLat, lats[vertex]);
      maxLat = Math.max(maxLat, lats[vertex]);
    }
    for (
      let cellX = Math.floor(minLng / CELL_DEG);
      cellX <= Math.floor(maxLng / CELL_DEG);
      cellX++
    ) {
      for (
        let cellY = Math.floor(minLat / CELL_DEG);
        cellY <= Math.floor(maxLat / CELL_DEG);
        cellY++
      ) {
        const key = `${cellX},${cellY}`;
        const cell = buckets.get(key);
        if (cell) {
          cell.push(index);
        } else {
          buckets.set(key, [index]);
        }
      }
    }
  }
  return buckets;
}

const loaded = new Map<string, Promise<Lines>>();

function loadLines({ url, format }: LinesParams): Promise<Lines> {
  const pending = loaded.get(url);
  if (pending) {
    return pending;
  } else {
    const decode = format === "hway" ? decodeHway : decodeFerr;
    const resolved = resolveUrl(url);
    const request = fetch(resolved)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `${resolved}: ${response.status} ${response.statusText}`,
          );
        }
        const polylines = decode(await response.arrayBuffer());
        return { polylines, buckets: bucketize(polylines) };
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
  context.strokeStyle = color;
  context.lineJoin = "round";
  context.lineCap = "round";
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
        context.beginPath();
        for (let vertex = 0; vertex < lngs.length; vertex++) {
          const pixelX = projectX(lngs[vertex], zoom) - originX;
          const pixelY = projectY(lats[vertex], zoom) - originY;
          if (vertex === 0) {
            context.moveTo(pixelX, pixelY);
          } else {
            context.lineTo(pixelX, pixelY);
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
