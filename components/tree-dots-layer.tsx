"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { genusColor } from "../src/tree-cover/genus";
import {
  getEnabledGenera,
  subscribeGenusFilter,
} from "../src/tree-cover/genus-filter";
import manifest from "../src/tree-cover/manifest.json";

// The crisp half of the genus overlay. Below MIN_ZOOM the pre-rendered raster tiles carry it —
// far too many trees to draw live across a zoomed-out screen. At and above MIN_ZOOM those tiles
// would upscale and blur, so each tree is instead drawn as a canvas disc at the tile's own zoom,
// sharp however far the map goes in. Sizing and opacity mirror the raster tiler
// (crates/tiler/src/genus.rs) so a dot does not jump as the map crosses the handoff.
const TREE_URL = "trees/{file}"; // relative, picks up the deploy basePath; layout: scripts/README.md
const TREE_FORMAT = 3;

const TILE_SIZE = 256;
const EQUATOR_METERS_PER_PIXEL = 156_543.033_92;
const METERS_PER_DEGREE_LAT = 111_320;
const DECIMETERS_PER_METER = 10;

const MIN_ZOOM = 15; // the handoff: raster tiles below, live dots at and above
const MAX_ZOOM = 20;
const PANE_NAME = "genus"; // shares the raster layer's non-inverted pane, so dark mode leaves it true-coloured
const PANE_Z_INDEX = 250;

const MIN_DOT_PX = 1.5; // a visibility floor at the low end; above it the dot is the crown's true size
const MAX_CROWN_METERS = 25.5; // the crown byte's ceiling (255 dm), so the largest dot a tree can reach
const DOT_ALPHA = 0.85;

const CELL_DEG = 0.004; // ~440 m spatial buckets, so a tile query scans only nearby trees

// The genus colours as CSS, one per id (0..12), precomputed so the draw loop is a lookup.
const GENUS_CSS: readonly string[] = Array.from({ length: 13 }, (_, id) => {
  const { red, green, blue } = genusColor(id);
  return `rgb(${red}, ${green}, ${blue})`;
});

interface Trees {
  lngs: Float64Array;
  lats: Float64Array;
  crownM: Float32Array; // crown radius in metres, the dot's size
  genus: Uint8Array; // 0..12, the dot's colour
  // Tree indices bucketed by `${floor(lng/CELL_DEG)},${floor(lat/CELL_DEG)}`, so a tile draw
  // touches only the handful of cells it overlaps rather than the whole city.
  buckets: Map<string, number[]>;
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

// Decode a TREE v3 blob: the shared 40-byte header, then per-tree zigzag-varint coordinate deltas
// (sorted, so a delta is a step not a jump), then a crown byte per tree, then a genus byte per
// tree — the three regions parallel, index i one tree. Mirrors crates/tiler/src/binfmt.rs.
function decodeTrees(buffer: ArrayBuffer): Trees {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== "TREE" || version !== TREE_FORMAT) {
    throw new Error(`not a v${TREE_FORMAT} tree blob`);
  }

  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let tree = 0; tree < count; tree++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lngs[tree] = originLng + quantizedX * scale;
    lats[tree] = originLat + quantizedY * scale;
  }
  const crownM = new Float32Array(count);
  for (let tree = 0; tree < count; tree++) {
    crownM[tree] = bytes[cursor.offset] / DECIMETERS_PER_METER;
    cursor.offset += 1;
  }
  const genus = bytes.slice(cursor.offset, cursor.offset + count);

  const buckets = new Map<string, number[]>();
  for (let tree = 0; tree < count; tree++) {
    const key = `${Math.floor(lngs[tree] / CELL_DEG)},${Math.floor(lats[tree] / CELL_DEG)}`;
    const cell = buckets.get(key);
    if (cell) {
      cell.push(tree);
    } else {
      buckets.set(key, [tree]);
    }
  }
  return { lngs, lats, crownM, genus, buckets };
}

// One in-flight fetch per city blob, shared by every tile that needs it and cached once decoded.
const loaded = new Map<string, Promise<Trees>>();

function loadTrees(file: string): Promise<Trees> {
  const pending = loaded.get(file);
  if (pending) {
    return pending;
  }
  const url = TREE_URL.replace("{file}", file);
  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return decodeTrees(await response.arrayBuffer());
    })
    .catch((error: unknown) => {
      loaded.delete(file);
      throw error;
    });
  loaded.set(file, request);
  return request;
}

class TreeDotsGrid extends L.GridLayer {
  private onMap = false;
  private readonly discarded = new WeakSet<HTMLElement>();

  constructor(
    private readonly file: string,
    options: L.GridLayerOptions,
  ) {
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

    loadTrees(this.file).then(
      (trees) => {
        // The tile is handed back before its blob arrives, so by now the layer can be off the
        // map and the tile dropped: nothing to draw into, no Leaflet to report to.
        if (!this.stillDrawable(tile)) {
          return;
        }
        const context = tile.getContext("2d");
        if (context) {
          context.scale(ratio, ratio);
          this.draw(context, trees, coords);
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

  // Every tree the tile overlaps, projected at the tile's own zoom and filled as a disc sized to
  // its crown's true radius in pixels (floored so it stays visible), so a big tree stays visibly
  // bigger than a small one at every zoom. The spatial buckets keep this to the trees actually
  // near the tile, not the whole city.
  private draw(
    context: CanvasRenderingContext2D,
    trees: Trees,
    coords: L.Coords,
  ): void {
    const map = this._map;
    const zoom = coords.z;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;
    // The legend's current selection; a tree of a disabled genus is skipped so the live dots match
    // the raster half. Read once per tile, not per tree.
    const enabled = getEnabledGenera();
    const centre = map.unproject(
      L.point(originX + TILE_SIZE / 2, originY + TILE_SIZE / 2),
      zoom,
    );
    const cosLat = Math.cos((centre.lat * Math.PI) / 180);
    const metersPerPixel = (EQUATOR_METERS_PER_PIXEL * cosLat) / 2 ** zoom;

    const northWest = map.unproject(L.point(originX, originY), zoom);
    const southEast = map.unproject(
      L.point(originX + TILE_SIZE, originY + TILE_SIZE),
      zoom,
    );
    // A dot reaches its crown radius in metres (or the min-visibility floor, whichever is larger),
    // so the query grows the tile box by the largest that can be — no dot spilling in is missed.
    const marginMeters = Math.max(
      MAX_CROWN_METERS,
      MIN_DOT_PX * metersPerPixel,
    );
    const marginLat = marginMeters / METERS_PER_DEGREE_LAT;
    const marginLng = marginMeters / (METERS_PER_DEGREE_LAT * cosLat);
    const cellX0 = Math.floor((northWest.lng - marginLng) / CELL_DEG);
    const cellX1 = Math.floor((southEast.lng + marginLng) / CELL_DEG);
    const cellY0 = Math.floor((southEast.lat - marginLat) / CELL_DEG);
    const cellY1 = Math.floor((northWest.lat + marginLat) / CELL_DEG);

    context.globalAlpha = DOT_ALPHA;
    for (let cellX = cellX0; cellX <= cellX1; cellX++) {
      for (let cellY = cellY0; cellY <= cellY1; cellY++) {
        const cell = trees.buckets.get(`${cellX},${cellY}`);
        if (!cell) {
          continue;
        }
        for (const tree of cell) {
          if (!enabled.has(trees.genus[tree])) {
            continue;
          }
          const point = map.project(
            L.latLng(trees.lats[tree], trees.lngs[tree]),
            zoom,
          );
          const px = point.x - originX;
          const py = point.y - originY;
          const radius = Math.max(
            MIN_DOT_PX,
            trees.crownM[tree] / metersPerPixel,
          );
          if (
            px < -radius ||
            px > TILE_SIZE + radius ||
            py < -radius ||
            py > TILE_SIZE + radius
          ) {
            continue;
          }
          context.fillStyle = GENUS_CSS[trees.genus[tree]];
          context.beginPath();
          context.arc(px, py, radius, 0, 2 * Math.PI);
          context.fill();
        }
      }
    }
    context.globalAlpha = 1;
  }
}

export default function TreeDotsLayer() {
  const map = useMap();

  useEffect(() => {
    // Share the raster layer's dedicated pane so the categorical dots escape the dark-mode
    // tile-pane invert exactly as the raster tiles do; create it if the raster layer has not.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    const layers = manifest.cities
      .filter((city) => city.field.genus)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        return new TreeDotsGrid(city.field.trees.file, {
          pane: PANE_NAME,
          bounds: L.latLngBounds([south, west], [north, east]),
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          // Each tile projects and fills a few hundred discs — light, but not worth redoing as a
          // pinch crosses tile boundaries; defer to when the gesture settles, keep a wider ring.
          updateWhenZooming: false,
          keepBuffer: 4,
        });
      });
    for (const layer of layers) {
      layer.addTo(map);
    }

    // Redraw every loaded tile when the legend toggles a genus, so the dots follow the selection.
    const unsubscribe = subscribeGenusFilter(() => {
      for (const layer of layers) {
        layer.redraw();
      }
    });

    return () => {
      unsubscribe();
      for (const layer of layers) {
        layer.remove();
      }
    };
  }, [map]);

  return null;
}
