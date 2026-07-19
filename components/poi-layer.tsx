"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import manifest from "../src/tree-cover/manifest.json";

// A point-of-interest overlay: the committed POI points (landmarks, public art) drawn as coloured
// canvas dots at every zoom. Unlike the tree dots there is no raster pyramid below — a few thousand
// points draw live cheaply — so one canvas GridLayer covers the whole zoom range. The dots ride in a
// dedicated pane so the dark-mode tile-pane invert leaves their colour true (as the genus dots do).

const TILE_SIZE = 256;
const PANE_NAME = "poi";
const PANE_Z_INDEX = 300; // above the canopy/genus fills, so the dots sit on top

const MIN_ZOOM = 11; // below this the city is a speck; the dots would just be noise
const MAX_ZOOM = 20;
const BASE_RADIUS_PX = 3.5;
const CELL_DEG = 0.004; // ~440 m spatial buckets, so a tile query scans only nearby points
const LABEL_MIN_ZOOM = 16; // labels only when zoomed in enough to be sparse and readable
const LABEL_FONT = "600 11px system-ui, sans-serif";
const LABEL_MAX_CHARS = 26; // long names truncate with an ellipsis so a box stays bounded

interface Points {
  lngs: Float64Array;
  lats: Float64Array;
  names: string[]; // per point, its label ("" when the source named none)
  // Point indices bucketed by `${floor(lng/CELL_DEG)},${floor(lat/CELL_DEG)}`, so a tile draw touches
  // only the cells it overlaps rather than the whole city.
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

// Decode the shared point layout (magic LMRK / ARTW): the 40-byte header, then per-point
// zigzag-varint (lng, lat) deltas in sorted order. Mirrors crates/tiler/src/binfmt.rs read_points.
function decodePoints(buffer: ArrayBuffer, magic: string): Points {
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
  const cursor = { offset: view.getUint16(6, true) };

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
  return { lngs, lats, names, buckets };
}

// One in-flight fetch per served blob, shared by every tile that needs it and cached once decoded.
const loaded = new Map<string, Promise<Points>>();

function loadPoints(url: string, magic: string): Promise<Points> {
  const pending = loaded.get(url);
  if (pending) {
    return pending;
  }
  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
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

class PoiDotsGrid extends L.GridLayer {
  private onMap = false;
  private readonly discarded = new WeakSet<HTMLElement>();

  constructor(
    private readonly url: string,
    private readonly magic: string,
    private readonly color: string,
    private readonly labelAnchor: "top" | "bottom",
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

    loadPoints(this.url, this.magic).then(
      (points) => {
        if (!this.stillDrawable(tile)) {
          return;
        }
        const context = tile.getContext("2d");
        if (context) {
          context.scale(ratio, ratio);
          this.draw(context, points, coords);
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

  // Every point the tile overlaps, projected at the tile's own zoom and filled as a coloured disc
  // with a faint dark outline so it reads on any background. The dot grows a little as the map zooms
  // in. The spatial buckets keep this to the points actually near the tile.
  private draw(
    context: CanvasRenderingContext2D,
    points: Points,
    coords: L.Coords,
  ): void {
    const map = this._map;
    const zoom = coords.z;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;
    const radius = Math.min(7, BASE_RADIUS_PX + Math.max(0, zoom - 14) * 0.6);

    const northWest = map.unproject(L.point(originX, originY), zoom);
    const southEast = map.unproject(
      L.point(originX + TILE_SIZE, originY + TILE_SIZE),
      zoom,
    );
    // A label extends to the right of its dot, so at label zooms a dot up to a label-width left of the
    // tile still writes text into it: the cell scan reaches that far left (and a line up/down), and
    // each tile a label spans draws its own portion, so the clipped halves rejoin across the seam.
    const dotMargin = radius / TILE_SIZE / 2 ** zoom + CELL_DEG;
    const labeling = zoom >= LABEL_MIN_ZOOM;
    const labelMargin = labeling ? dotMargin + 2 * CELL_DEG : dotMargin;
    const cellX0 = Math.floor((northWest.lng - labelMargin) / CELL_DEG);
    const cellX1 = Math.floor((southEast.lng + dotMargin) / CELL_DEG);
    const verticalMargin = labeling ? dotMargin + CELL_DEG : dotMargin;
    const cellY0 = Math.floor((southEast.lat - verticalMargin) / CELL_DEG);
    const cellY1 = Math.floor((northWest.lat + verticalMargin) / CELL_DEG);

    // Gather the candidate points once — a wider set than the tile when labeling — then draw the dots
    // (culled to the tile) and, zoomed in, the labels (any whose text box reaches into the tile).
    const candidates: { px: number; py: number; index: number }[] = [];
    for (let cellX = cellX0; cellX <= cellX1; cellX++) {
      for (let cellY = cellY0; cellY <= cellY1; cellY++) {
        const cell = points.buckets.get(`${cellX},${cellY}`);
        if (!cell) {
          continue;
        }
        for (const point of cell) {
          const projected = map.project(
            L.latLng(points.lats[point], points.lngs[point]),
            zoom,
          );
          candidates.push({
            px: projected.x - originX,
            py: projected.y - originY,
            index: point,
          });
        }
      }
    }

    context.lineWidth = 1;
    context.strokeStyle = "rgba(20, 20, 20, 0.4)";
    context.fillStyle = this.color;
    for (const { px, py } of candidates) {
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

    if (!labeling) {
      return;
    }
    // Labels: a dark-outlined name in the layer's colour, greedily placed so none overlaps another in
    // this tile. Landmarks anchor above their dot and art below, so a co-located pair never collides.
    context.font = LABEL_FONT;
    context.textAlign = "left";
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.strokeStyle = "rgba(0, 0, 0, 0.75)";
    context.fillStyle = this.color;
    const above = this.labelAnchor === "top";
    context.textBaseline = above ? "bottom" : "top";
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const lineHeight = 12;
    for (const { px, py, index } of candidates) {
      const raw = points.names[index];
      if (!raw) {
        continue;
      }
      const name =
        raw.length > LABEL_MAX_CHARS
          ? `${raw.slice(0, LABEL_MAX_CHARS - 1)}…`
          : raw;
      const tx = px + radius + 3;
      const ty = above ? py - radius : py + radius;
      const width = context.measureText(name).width;
      const box = {
        x0: tx,
        y0: above ? ty - lineHeight : ty,
        x1: tx + width,
        y1: above ? ty : ty + lineHeight,
      };
      // Skip labels whose box lies entirely outside this tile; the tile that owns each still draws it.
      if (
        box.x1 < 0 ||
        box.x0 > TILE_SIZE ||
        box.y1 < 0 ||
        box.y0 > TILE_SIZE
      ) {
        continue;
      }
      const clashes = placed.some(
        (other) =>
          box.x0 < other.x1 &&
          box.x1 > other.x0 &&
          box.y0 < other.y1 &&
          box.y1 > other.y0,
      );
      if (clashes) {
        continue;
      }
      placed.push(box);
      context.strokeText(name, tx, ty);
      context.fillText(name, tx, ty);
    }
  }
}

export default function PoiLayer({
  dir,
  magic,
  color,
  labelAnchor,
}: {
  dir: string; // the served directory, e.g. "landmarks" — the blob is <dir>/<city>.bin
  magic: string; // the expected 4-byte magic, e.g. "LMRK"
  color: string; // CSS fill colour for the dots
  labelAnchor: "top" | "bottom"; // which side of the dot the label sits, to deconflict two POI layers
}) {
  const map = useMap();

  useEffect(() => {
    // A dedicated pane, so the dark-mode tile-pane invert leaves the dot colours true.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    const layers = manifest.cities.map((city) => {
      const { south, west, north, east } = city.bounds;
      return new PoiDotsGrid(
        `${dir}/${city.id}.bin`,
        magic,
        color,
        labelAnchor,
        {
          pane: PANE_NAME,
          bounds: L.latLngBounds([south, west], [north, east]),
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          updateWhenZooming: false,
          keepBuffer: 4,
        },
      );
    });
    for (const layer of layers) {
      layer.addTo(map);
    }
    return () => {
      for (const layer of layers) {
        layer.remove();
      }
    };
  }, [map, dir, magic, color, labelAnchor]);

  return null;
}
