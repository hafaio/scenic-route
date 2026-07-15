"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import manifest from "../src/tree-cover/manifest.json";
import { ROAD_OPACITY, rampCss } from "../src/tree-cover/ramp";

interface Segment {
  lngs: Float64Array;
  lats: Float64Array;
  // The canopy cover at each vertex, 0..255 for a covered fraction of 0..1: both sidewalks,
  // left then right, interleaved. A segment with no offset carries the same value in both.
  densities: Uint8Array;
  // Half the distance between the two sidewalks, in metres. Zero for a path or a boardwalk,
  // which *is* the walking surface and is drawn as a single line on its centreline.
  offsetMeters: number;
}

// One chunk per z12 tile, fetched lazily. layout: scripts/README.md
// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const CHUNK_URL = "streets/{x}/{y}.bin";
const CHUNK_FORMAT = 3;
const CHUNK_ZOOM = 12;
const SIDES = 2;
const METERS_PER_DECIMETER = 0.1;

const TILE_SIZE = 256;
const EQUATOR_METERS_PER_PIXEL = 156_543.033_92; // web mercator, at the equator, at z0
// Below this the lines would be hairlines, and a screen of them would pull in every chunk
// in the city; the fill carries the map on its own.
const MIN_ZOOM = 13;
const MAX_ZOOM = 20;

// Above the fill (zIndex 2) but still in the tile pane, so the dark-mode pane filter in
// globals.css inverts the lines along with everything under them.
const Z_INDEX = 3;

// Lines read as street width, so they grow with zoom: about 1.5 px at z13, 5 px at z17.
const BASE_WIDTH = 1.5;
const WIDTH_PER_ZOOM = 1.32;

// Density is quantized into levels so the pieces of a road that share one can be stroked as
// a single path. 32 levels is finer than the alpha curve resolves on a 2 px line, so the
// gradient along a road still reads as continuous.
const LEVEL_BITS = 3;
const LEVELS = 256 >> LEVEL_BITS;
const COLORS: readonly string[] = Array.from({ length: LEVELS }, (_, level) =>
  rampCss(
    ((level << LEVEL_BITS) + (1 << (LEVEL_BITS - 1))) / 255,
    ROAD_OPACITY,
  ),
);

const chunks = new Map<string, Promise<Segment[]>>();

// The unit normal at each projected vertex, pointing at the *left* sidewalk. Left is 90 degrees
// counter-clockwise of the direction of travel — CSCL's own l_/r_ convention, and the side the
// first of a vertex's two density bytes carries — and canvas y runs south, so on screen that is
// (ty, -tx): the left of an eastbound street points up. The tangent is the central difference of
// the nearest *distinct* neighbours, one-sided at the ends, since two vertices of the source
// geometry can sit closer together than the 0.1 m the coordinates are quantized to.
function leftNormals(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
  normalXs: Float64Array,
  normalYs: Float64Array,
): void {
  const same = (left: number, right: number): boolean =>
    xs[left] === xs[right] && ys[left] === ys[right];
  for (let vertex = 0; vertex < count; vertex++) {
    let back = vertex;
    while (back > 0 && same(back, vertex)) {
      back -= 1;
    }
    let ahead = vertex;
    while (ahead + 1 < count && same(ahead, vertex)) {
      ahead += 1;
    }
    const tangentX = xs[ahead] - xs[back];
    const tangentY = ys[ahead] - ys[back];
    // A vertex every neighbour has collapsed onto has no side to take: its two lines meet on the
    // centreline, rather than carrying a NaN into the path.
    const length = Math.hypot(tangentX, tangentY) || 1;
    normalXs[vertex] = tangentY / length;
    normalYs[vertex] = -tangentX / length;
  }
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

function decodeChunk(buffer: ArrayBuffer): Segment[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== "STCK" || version !== CHUNK_FORMAT) {
    throw new Error(`not a v${CHUNK_FORMAT} street chunk`);
  }

  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const segments: Segment[] = [];
  for (let segment = 0; segment < count; segment++) {
    const vertices = view.getUint16(cursor.offset, true);
    const offsetMeters = bytes[cursor.offset + 2] * METERS_PER_DECIMETER;
    cursor.offset += 3;
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
    const densities = bytes.slice(
      cursor.offset,
      cursor.offset + SIDES * vertices,
    );
    cursor.offset += SIDES * vertices;
    segments.push({ lngs, lats, densities, offsetMeters });
  }
  return segments;
}

// One in-flight fetch per chunk, shared by every tile that needs it. A 404 is an answer —
// the tile is all water, and caches as empty — but any other failure drops the entry, so
// the next tile over this chunk goes back for it.
function loadChunk(tileX: number, tileY: number): Promise<Segment[]> {
  const key = `${tileX}/${tileY}`;
  const pending = chunks.get(key);
  if (pending) {
    return pending;
  } else {
    const url = CHUNK_URL.replace("{x}", String(tileX)).replace(
      "{y}",
      String(tileY),
    );
    const request = fetch(url)
      .then(async (response) => {
        if (response.ok) {
          return decodeChunk(await response.arrayBuffer());
        } else if (response.status === 404) {
          return [];
        } else {
          throw new Error(`${url}: ${response.status} ${response.statusText}`);
        }
      })
      .catch((error: unknown) => {
        chunks.delete(key);
        throw error;
      });
    chunks.set(key, request);
    return request;
  }
}

class StreetScoreGrid extends L.GridLayer {
  // whether the layer is still on a map; Leaflet drops its `_map` when it isn't
  private onMap = false;
  // tiles Leaflet has thrown away, weakly held so they stay collectable
  private readonly discarded = new WeakSet<HTMLElement>();

  constructor(options: L.GridLayerOptions) {
    super(options);
    this.on({
      add: () => {
        this.onMap = true;
      },
      remove: () => {
        this.onMap = false;
      },
      tileunload: ({ tile }) => {
        this.discarded.add(tile);
      },
    });
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = window.devicePixelRatio || 1;
    tile.width = TILE_SIZE * ratio;
    tile.height = TILE_SIZE * ratio;

    const shift = coords.z - CHUNK_ZOOM;
    const chunkX = coords.x >> shift;
    const chunkY = coords.y >> shift;
    loadChunk(chunkX, chunkY).then(
      (segments) => {
        // The tile is handed back before its chunk arrives, so by now the layer can be off
        // the map and the tile dropped: nothing to draw into, no Leaflet to report to.
        if (!this.stillDrawable(tile)) {
          return;
        }
        const context = tile.getContext("2d");
        if (context) {
          context.scale(ratio, ratio);
          this.draw(context, segments, coords);
        }
        done(undefined, tile);
      },
      (error: Error) => {
        if (this.stillDrawable(tile)) {
          done(error, tile);
        }
      },
    );
    return tile;
  }

  private stillDrawable(tile: HTMLElement): boolean {
    return this.onMap && !this.discarded.has(tile);
  }

  // Projected at the tile's own zoom, so the lines stay crisp however far in the map goes.
  // A street is two lines, one per sidewalk, each quantized into its own level; each piece
  // takes the level its two ends average to, and the pieces are gathered into one path per
  // level, so a tile costs a stroke per level rather than per piece. Runs meet butt to butt:
  // two translucent strokes overlapping would bead.
  private draw(
    context: CanvasRenderingContext2D,
    segments: Segment[],
    coords: L.Coords,
  ): void {
    const map = this._map;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;
    const width = BASE_WIDTH * WIDTH_PER_ZOOM ** (coords.z - MIN_ZOOM);
    const center = map.unproject(
      L.point(originX + TILE_SIZE / 2, originY + TILE_SIZE / 2),
      coords.z,
    );
    const metersPerPixel =
      (EQUATOR_METERS_PER_PIXEL * Math.cos((center.lat * Math.PI) / 180)) /
      2 ** coords.z;

    context.lineCap = "butt";
    context.lineJoin = "round";
    context.lineWidth = width;

    const paths: (Path2D | undefined)[] = new Array(LEVELS);
    const longest = segments.reduce(
      (most, segment) => Math.max(most, segment.lngs.length),
      0,
    );
    const xs = new Float64Array(longest);
    const ys = new Float64Array(longest);
    const normalXs = new Float64Array(longest);
    const normalYs = new Float64Array(longest);

    for (const { lngs, lats, densities, offsetMeters } of segments) {
      // The two sidewalks of a street are ~14 m apart, which at z13 is one pixel: drawn true to
      // the ground they would merge into the single line this layer exists to take apart. So the
      // separation is a screen-space decision, never baked into the data — floored at a stroke
      // width, which the true offset overtakes around z16, from where the exaggeration dissolves
      // on its own as the map zooms in.
      const offsetPx =
        offsetMeters > 0 ? Math.max(offsetMeters / metersPerPixel, width) : 0;
      const margin = width + offsetPx;
      let low = Number.POSITIVE_INFINITY;
      let left = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      for (let vertex = 0; vertex < lngs.length; vertex++) {
        const point = map.project(
          L.latLng(lats[vertex], lngs[vertex]),
          coords.z,
        );
        xs[vertex] = point.x - originX;
        ys[vertex] = point.y - originY;
        left = Math.min(left, xs[vertex]);
        right = Math.max(right, xs[vertex]);
        low = Math.min(low, ys[vertex]);
        high = Math.max(high, ys[vertex]);
      }
      // The chunk covers a whole z12 tile, so most of its segments miss this one. A segment
      // can cross the tile between two vertices that are both outside it, so the test is on
      // its box rather than on its vertices.
      const overlaps =
        right >= -margin &&
        left <= TILE_SIZE + margin &&
        high >= -margin &&
        low <= TILE_SIZE + margin;
      if (!overlaps) {
        continue;
      }
      leftNormals(xs, ys, lngs.length, normalXs, normalYs);

      // A path or a boardwalk has no offset: it is drawn as the one line it is, and its two
      // densities are the same sample anyway.
      const sides = offsetMeters > 0 ? SIDES : 1;
      for (let side = 0; side < sides; side++) {
        const away = side === 0 ? offsetPx : -offsetPx;
        let run = -1;
        for (let piece = 0; piece + 1 < lngs.length; piece++) {
          const level =
            (densities[SIDES * piece + side] +
              densities[SIDES * (piece + 1) + side]) >>
            (LEVEL_BITS + 1);
          if (level === 0) {
            run = -1;
            continue;
          }
          let path = paths[level];
          if (!path) {
            path = new Path2D();
            paths[level] = path;
          }
          if (level !== run) {
            path.moveTo(
              xs[piece] + away * normalXs[piece],
              ys[piece] + away * normalYs[piece],
            );
          }
          path.lineTo(
            xs[piece + 1] + away * normalXs[piece + 1],
            ys[piece + 1] + away * normalYs[piece + 1],
          );
          run = level;
        }
      }
    }

    for (let level = 1; level < LEVELS; level++) {
      const path = paths[level];
      if (path) {
        context.strokeStyle = COLORS[level];
        context.stroke(path);
      }
    }
  }
}

export default function StreetScoreLayer() {
  const map = useMap();

  useEffect(() => {
    const layers = manifest.cities.map((city) => {
      const { south, west, north, east } = city.bounds;
      return new StreetScoreGrid({
        bounds: L.latLngBounds([south, west], [north, east]),
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        zIndex: Z_INDEX,
        attribution: `<a href="${city.streets.sourceUrl}" target="_blank" rel="noreferrer">${city.streets.attribution}</a>`,
      });
    });
    for (const layer of layers) {
      layer.addTo(map);
    }
    return () => {
      for (const layer of layers) {
        layer.remove();
      }
    };
  }, [map]);

  return null;
}
