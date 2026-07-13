"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import manifest from "../src/tree-cover/manifest.json";
import { ROAD_OPACITY, rampCss } from "../src/tree-cover/ramp";

interface Segment {
  lngs: Float64Array;
  lats: Float64Array;
  densities: Uint8Array; // the tree density at each vertex, 0..255 on the field's scale
}

// Written by scripts/build-street-tiles.ts, which documents the layout; one chunk per
// z12 tile, fetched lazily as tiles need it.
// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const CHUNK_URL = "streets/{x}/{y}.bin";
const CHUNK_FORMAT = 2;
const CHUNK_ZOOM = 12;

const TILE_SIZE = 256;
// Below this the fill carries the map on its own: the lines would be hairlines, and a
// whole screen of them would pull in every chunk in the city.
const MIN_ZOOM = 13;
const MAX_ZOOM = 20;

// Above the smooth fill (zIndex 2) but still in the tile pane, so the dark-mode pane
// filter in globals.css inverts the lines along with everything under them.
const Z_INDEX = 3;

// Lines read as street width, so they grow with zoom: about 1.5 px at z13, 5 px at z17.
const BASE_WIDTH = 1.5;
const WIDTH_PER_ZOOM = 1.32;

// A vertex's density is drawn from the level it quantizes into, so the pieces of a road
// that share a level can be stroked as one path instead of one call each. 32 levels is
// finer than the alpha curve can resolve on a two-pixel line, so the gradient along a
// road still looks continuous.
const LEVEL_BITS = 3;
const LEVELS = 256 >> LEVEL_BITS;
const COLORS: readonly string[] = Array.from({ length: LEVELS }, (_, level) =>
  rampCss(
    ((level << LEVEL_BITS) + (1 << (LEVEL_BITS - 1))) / 255,
    ROAD_OPACITY,
  ),
);

const chunks = new Map<string, Promise<Segment[]>>();

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
    cursor.offset += 2;
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
    const densities = bytes.slice(cursor.offset, cursor.offset + vertices);
    cursor.offset += vertices;
    segments.push({ lngs, lats, densities });
  }
  return segments;
}

// One in-flight fetch per chunk, shared by every tile that needs it. A 404 is an answer —
// the tile is all water, and it caches as empty — but anything else is a failure, and the
// entry is dropped so the next tile over this chunk goes back for it.
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
        // the map (tree cover switched off, or React rebuilding it) and the tile dropped.
        // Either way there is nothing left to draw into, and no Leaflet to report to.
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

  // Projected at the tile's own zoom, so the lines are drawn at the resolution they are
  // shown at and stay crisp however far in the map goes. A road is a gradient, not a flat
  // colour: each piece takes the level its two ends average to, and the pieces are
  // gathered into one path per level so a tile costs a stroke per level rather than a
  // stroke per piece. Runs meet butt to butt, so nowhere do two translucent strokes
  // overlap and bead.
  private draw(
    context: CanvasRenderingContext2D,
    segments: Segment[],
    coords: L.Coords,
  ): void {
    const map = this._map;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;
    const width = BASE_WIDTH * WIDTH_PER_ZOOM ** (coords.z - MIN_ZOOM);
    const margin = width;

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

    for (const { lngs, lats, densities } of segments) {
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
      // The chunk covers a whole z12 tile, so most of its segments miss this one; a
      // segment can still cross the tile between two vertices outside it, so the test is
      // on the segment's box rather than on its vertices.
      const overlaps =
        right >= -margin &&
        left <= TILE_SIZE + margin &&
        high >= -margin &&
        low <= TILE_SIZE + margin;
      if (!overlaps) {
        continue;
      }

      let run = -1;
      for (let piece = 0; piece + 1 < lngs.length; piece++) {
        const level =
          (densities[piece] + densities[piece + 1]) >> (LEVEL_BITS + 1);
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
          path.moveTo(xs[piece], ys[piece]);
        }
        path.lineTo(xs[piece + 1], ys[piece + 1]);
        run = level;
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
