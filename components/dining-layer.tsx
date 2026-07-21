"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { decodeStreetChunk } from "../src/streets/chunk";
import manifest from "../src/tree-cover/manifest.json";

// The "commercial" overlay. It highlights whole blocks, not points. The heavy work — snapping ~800k
// PLUTO land-use lots and ~1M building footprints onto every street segment — is done at BUILD TIME by
// scripts/build-commercial.ts, which writes per-segment SIGNALS to public/commercial/{x}/{y}.bin
// (magic CMRC), one file per STCK street chunk, aligned by segment index. Each segment carries three
// bytes: commercialFrac (commercial lots / all fronting lots, 0..255), medianHeightMeters (median
// snapped roof height, 255 when none), and flags (bit0 an Open Street, bit1 outdoor seating).
//
// The overlay just reads those signals and applies the GATE client-side, so the thresholds stay
// tunable without a rebuild. A block lights when it is commercial (>50% commercial frontage) AND
// low-rise AND (on an Open Street OR has outdoor seating) — i.e. a charming low-rise retail strip, not
// a Midtown office canyon. A qualifying block is drawn as one wide violet band over the street, whole
// length — a block is on or off, never a spot, never a fade. Two render modes: a vector band at
// z>=13, and a coarse smoothed raster at z10..12 so the city overview reads. It rides in a dedicated
// pane so the dark-mode tile-pane invert leaves the violet true (as the POI dots do).

const TILE_SIZE = 256;
const PANE_NAME = "commercial-blocks";
const PANE_Z_INDEX = 280; // above the canopy fill, below the POI dots (300) and scenic lines (290)

// The raster overview keeps the layer legible from z10; below that the whole city is a speck. The
// vector band takes over at VECTOR_MIN_ZOOM, from where the bands are wide enough to read crisply.
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;
const VECTOR_MIN_ZOOM = 13;

// The z12 STCK street chunks (geometry) and their CMRC signal siblings, fetched lazily per chunk as
// the display tiles over them are drawn. Relative, so they pick up the deploy's basePath.
const CHUNK_URL = "streets/{x}/{y}.bin";
const CHUNK_ZOOM = 12;

const COMMERCIAL_URL = "commercial/{x}/{y}.bin";
const COMMERCIAL_MAGIC = "CMRC";
const COMMERCIAL_FORMAT = 1;
const COMMERCIAL_BYTES_PER_SEGMENT = 3; // [commercialFrac, medianHeightMeters, flags]
const FLAG_OPEN_STREET = 1; // bit0: an Open Street sample snapped to the segment
const FLAG_SEATING = 2; // bit1: a dining / outdoor-seating point snapped to the segment

// The knobs below are the client-side gate, tuned by eye against the running map (no rebuild needed).
// Stage 1: the share of fronting lots that must be commercial for the block to qualify. Over half.
const COMMERCIAL_FRACTION = 0.5;
// Stage 2: the block must be low-rise — median snapped roof height at or below this. Drops Midtown /
// big-box canyons, keeps brownstone-height retail strips. (255 m "no buildings" also fails this.)
const LOW_RISE_METERS = 25;

// Violet-700 (#6d28d9), distinct from the green canopy and the scenic overlays. A qualifying block is
// this one uniform violet — the overlay is binary on/off (no intensity grading yet). Lower opacity
// than a thin line would take: the band is fat and neighbouring bands overlap at corners, so it stays
// airy, and the whole (opaque) band composite is applied at this single opacity.
const VIOLET_RGB = "109, 40, 217";
const BAND_OPACITY = 0.45;

// The vector band's ground width: the roadway plus the frontage lots on both sides, so it reads as the
// commercial BLOCK strip rather than a centreline over the street. A NYC lot is ~30 m deep, the road
// ~12 m, so ~50 m covers the street and most of the frontage each side. Floored to a visible px width.
const BAND_METERS = 50;
const MIN_BAND_PX = 4;

// Feathered band edges. The band is drawn onto an offscreen padded by BLUR_PAD (~3× the blur, so a
// band near the tile edge still has pixels for the blur to pull from), blurred by BAND_BLUR_PX, then
// only the centre TILE_SIZE region is composited — so a blurred edge lines up with the neighbouring
// tile's. Both are tunable by eye.
const BAND_BLUR_PX = 5;
const BLUR_PAD = 15;

// The low-zoom raster: qualifying segments are marked into this coarse grid per tile, then blitted up
// smoothed, so the overview is a soft violet wash rather than invisible hairlines.
const RASTER_GRID = 128;
const RASTER_CELL_PX = TILE_SIZE / RASTER_GRID;
const RASTER_OPACITY = 0.5;

const EQUATOR_METERS_PER_PIXEL = 156_543.033_92; // web mercator, at the equator, at z0

// One block-length CSCL centreline: just the geometry, the unit the overlay highlights. The chunk's
// per-vertex density bytes are consumed to advance the cursor but not kept — this overlay is on/off.
interface Segment {
  lngs: Float64Array;
  lats: Float64Array;
}

// One z12 chunk's model, built lazily the first time a display tile needs that chunk: the chunk's
// segments, whether each passes the client gate (aligned by index), and the longest segment (to size
// the draw's scratch arrays). No snapping happens here — the signals are precomputed — so building a
// chunk is cheap and there is no on-toggle stall.
interface ChunkModel {
  segments: Segment[];
  qualifies: Uint8Array;
  longest: number;
}

// The precomputed per-segment signals from one CMRC chunk, parallel to its STCK sibling's segments.
interface Signals {
  commercialFrac: Uint8Array;
  medianHeight: Uint8Array;
  flags: Uint8Array;
}

// One tile's geometry and its aligned signals.
interface TileData {
  segments: Segment[];
  signals: Signals;
}

// Decode one CMRC signal chunk: the 12-byte header, then 3 bytes per segment in STCK order. Returns
// three parallel byte arrays, index-aligned with the sibling STCK chunk's segments.
function decodeCommercial(buffer: ArrayBuffer): Signals {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== COMMERCIAL_MAGIC || version !== COMMERCIAL_FORMAT) {
    throw new Error(`not a v${COMMERCIAL_FORMAT} commercial chunk`);
  }
  const count = view.getUint32(8, true);
  const commercialFrac = new Uint8Array(count);
  const medianHeight = new Uint8Array(count);
  const flags = new Uint8Array(count);
  let offset = view.getUint16(6, true);
  // The fixed count * 3-byte body must fit, or the reads below would run off the end and pull
  // `undefined` (coerced to 0) into the signals instead of failing loudly on a truncated chunk.
  if (offset + count * COMMERCIAL_BYTES_PER_SEGMENT > bytes.length) {
    throw new Error("commercial chunk truncated");
  }
  for (let segment = 0; segment < count; segment++) {
    commercialFrac[segment] = bytes[offset];
    medianHeight[segment] = bytes[offset + 1];
    flags[segment] = bytes[offset + 2];
    offset += COMMERCIAL_BYTES_PER_SEGMENT;
  }
  return { commercialFrac, medianHeight, flags };
}

const chunks = new Map<string, Promise<Segment[]>>();
const signalChunks = new Map<string, Promise<Signals | null>>();

// One in-flight fetch per chunk, shared and cached. A 404 is a water tile: it stands as empty. Any
// other failure drops the entry so a later request goes back for it.
function loadChunk(tileX: number, tileY: number): Promise<Segment[]> {
  const key = `${tileX}/${tileY}`;
  const pending = chunks.get(key);
  if (pending) {
    return pending;
  }
  const url = CHUNK_URL.replace("{x}", String(tileX)).replace(
    "{y}",
    String(tileY),
  );
  const request = fetch(url)
    .then(async (response) => {
      if (response.ok) {
        // Decode the full STCK segments, then keep only the geometry — the transient densities /
        // offset are collected, since this overlay caches its segments and highlights whole blocks.
        const buffer = await response.arrayBuffer();
        return decodeStreetChunk(buffer).map((segment) => ({
          lngs: segment.lngs,
          lats: segment.lats,
        }));
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

// The CMRC signal sibling of a chunk. A 404 is a tile with no precomputed signals (water, or not yet
// built): null, and the tile draws nothing.
function loadSignals(tileX: number, tileY: number): Promise<Signals | null> {
  const key = `${tileX}/${tileY}`;
  const pending = signalChunks.get(key);
  if (pending) {
    return pending;
  }
  const url = COMMERCIAL_URL.replace("{x}", String(tileX)).replace(
    "{y}",
    String(tileY),
  );
  const request = fetch(url)
    .then(async (response) => {
      if (response.ok) {
        return decodeCommercial(await response.arrayBuffer());
      } else if (response.status === 404) {
        return null;
      } else {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
    })
    .catch((error: unknown) => {
      signalChunks.delete(key);
      throw error;
    });
  signalChunks.set(key, request);
  return request;
}

// A tile's geometry and its aligned signals, fetched together. If the signals are missing or their
// count disagrees with the geometry, the segments get all-zero signals (so nothing qualifies) rather
// than reading past the end.
async function loadTile(tileX: number, tileY: number): Promise<TileData> {
  const [segments, signals] = await Promise.all([
    loadChunk(tileX, tileY),
    loadSignals(tileX, tileY),
  ]);
  if (signals && signals.commercialFrac.length === segments.length) {
    return { segments, signals };
  }
  const count = segments.length;
  return {
    segments,
    signals: {
      commercialFrac: new Uint8Array(count),
      medianHeight: new Uint8Array(count),
      flags: new Uint8Array(count),
    },
  };
}

// The z12 chunks a display tile covers. At z>=12 a tile sits inside a single chunk (its ancestor at
// CHUNK_ZOOM). Below z12 one tile spans a 2^(12-z) square of chunks — 4 at z11, 16 at z10 — so the
// raster overview pulls in only the handful under it, not the whole city.
function coveringChunks(coords: L.Coords): { x: number; y: number }[] {
  if (coords.z >= CHUNK_ZOOM) {
    const shift = coords.z - CHUNK_ZOOM;
    return [{ x: coords.x >> shift, y: coords.y >> shift }];
  }
  const span = 1 << (CHUNK_ZOOM - coords.z);
  const baseX = coords.x << (CHUNK_ZOOM - coords.z);
  const baseY = coords.y << (CHUNK_ZOOM - coords.z);
  const chunkList: { x: number; y: number }[] = [];
  for (let offsetX = 0; offsetX < span; offsetX++) {
    for (let offsetY = 0; offsetY < span; offsetY++) {
      chunkList.push({ x: baseX + offsetX, y: baseY + offsetY });
    }
  }
  return chunkList;
}

// One in-flight model per z12 chunk, keyed by its tile coords, shared by every display tile over it.
const chunkModels = new Map<string, Promise<ChunkModel>>();

// Load one chunk's geometry and signals and reduce to its model: the segment array plus a per-segment
// `qualifies` byte from the CLIENT gate (commercial >50% AND low-rise AND open-street | seating). No
// snapping — the signals are precomputed — so this is cheap and does not stall on toggle.
function loadChunkModel(tileX: number, tileY: number): Promise<ChunkModel> {
  const key = `${tileX}/${tileY}`;
  const pending = chunkModels.get(key);
  if (pending) {
    return pending;
  }
  const request = loadTile(tileX, tileY)
    .then(({ segments, signals }) => {
      const qualifies = new Uint8Array(segments.length);
      let longest = 0;
      for (let index = 0; index < segments.length; index++) {
        longest = Math.max(longest, segments[index].lngs.length);
        const commercial = signals.commercialFrac[index] / 255;
        const flagged =
          (signals.flags[index] & (FLAG_OPEN_STREET | FLAG_SEATING)) !== 0;
        if (
          commercial >= COMMERCIAL_FRACTION &&
          signals.medianHeight[index] <= LOW_RISE_METERS &&
          flagged
        ) {
          qualifies[index] = 1;
        }
      }
      return { segments, qualifies, longest };
    })
    .catch((error: unknown) => {
      chunkModels.delete(key);
      throw error;
    });
  chunkModels.set(key, request);
  return request;
}

class CommercialGrid extends L.GridLayer {
  private onMap = false;
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

    const requests = coveringChunks(coords).map(({ x, y }) =>
      loadChunkModel(x, y),
    );
    Promise.all(requests).then(
      (models) => {
        // The tile is handed back before its chunks arrive, so by now the layer can be off the map
        // and the tile dropped: nothing to draw into, no Leaflet to report to.
        if (!this.stillDrawable(tile)) {
          return;
        }
        const context = tile.getContext("2d");
        if (context) {
          context.scale(ratio, ratio);
          if (coords.z >= VECTOR_MIN_ZOOM) {
            this.drawVector(context, models, coords, ratio);
          } else {
            this.drawRaster(context, models, coords);
          }
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

  // The metres a screen pixel spans at this tile's centre, for sizing the ground-width band.
  private metersPerPixel(coords: L.Coords): number {
    const map = this._map;
    const center = map.unproject(
      L.point(
        coords.x * TILE_SIZE + TILE_SIZE / 2,
        coords.y * TILE_SIZE + TILE_SIZE / 2,
      ),
      coords.z,
    );
    return (
      (EQUATOR_METERS_PER_PIXEL * Math.cos((center.lat * Math.PI) / 180)) /
      2 ** coords.z
    );
  }

  // Stroke the whole unioned band path opaque onto a padded offscreen, blur it to feather the edges,
  // then composite the centre region onto the tile at BAND_OPACITY. Stroking the union at alpha 1
  // paints overlapping and abutting bands as one solid shape (no darker patches where blocks cross);
  // one uniform opacity at composite keeps it flat. Square caps let a block ending at a T/L fill the
  // corner flush; miter joins keep a within-street bend continuous. The offscreen is padded by
  // BLUR_PAD so a band near the tile edge has pixels for the blur to draw from, and only the centre
  // TILE_SIZE region is copied out, so a feathered edge lines up with the neighbouring tile's.
  private compositeBand(
    context: CanvasRenderingContext2D,
    path: Path2D,
    width: number,
    ratio: number,
  ): void {
    const padded = TILE_SIZE + 2 * BLUR_PAD;
    const offscreen = document.createElement("canvas");
    offscreen.width = padded * ratio;
    offscreen.height = padded * ratio;
    const offContext = offscreen.getContext("2d");
    if (!offContext) {
      return;
    }
    offContext.scale(ratio, ratio);
    offContext.translate(BLUR_PAD, BLUR_PAD);
    offContext.filter = `blur(${BAND_BLUR_PX}px)`;
    offContext.lineCap = "square";
    offContext.lineJoin = "miter";
    offContext.lineWidth = width;
    offContext.strokeStyle = `rgba(${VIOLET_RGB}, 1)`;
    offContext.stroke(path);
    context.globalAlpha = BAND_OPACITY;
    context.drawImage(
      offscreen,
      BLUR_PAD * ratio,
      BLUR_PAD * ratio,
      TILE_SIZE * ratio,
      TILE_SIZE * ratio,
      0,
      0,
      TILE_SIZE,
      TILE_SIZE,
    );
    context.globalAlpha = 1;
  }

  // z>=13: draw each qualifying block as one WIDE violet band over the street — a rectangle that reads
  // as the whole block, not a centreline. Projected at the tile's own zoom, so the band stays crisp
  // however far in the map goes. Every qualifying block goes into ONE unioned path, composited (and
  // feathered) once.
  private drawVector(
    context: CanvasRenderingContext2D,
    models: ChunkModel[],
    coords: L.Coords,
    ratio: number,
  ): void {
    const map = this._map;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;
    const width = Math.max(
      MIN_BAND_PX,
      BAND_METERS / this.metersPerPixel(coords),
    );
    const margin = width + BLUR_PAD;

    const band = new Path2D();
    let hasBand = false;
    const longest = models.reduce(
      (most, model) => Math.max(most, model.longest),
      0,
    );
    const xs = new Float64Array(longest);
    const ys = new Float64Array(longest);

    for (const { segments, qualifies } of models) {
      for (let index = 0; index < segments.length; index++) {
        if (qualifies[index] === 0) {
          continue;
        }
        const { lngs, lats } = segments[index];
        let left = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
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
        // A chunk covers a whole z12 tile, so most of its segments miss this display tile. A segment
        // can cross the tile between two vertices both outside it, so the test is on its box, not its
        // vertices.
        const overlaps =
          right >= -margin &&
          left <= TILE_SIZE + margin &&
          high >= -margin &&
          low <= TILE_SIZE + margin;
        if (!overlaps) {
          continue;
        }
        band.moveTo(xs[0], ys[0]);
        for (let vertex = 1; vertex < lngs.length; vertex++) {
          band.lineTo(xs[vertex], ys[vertex]);
        }
        hasBand = true;
      }
    }

    if (hasBand) {
      this.compositeBand(context, band, width, ratio);
    }
  }

  // z10..12: too far out for crisp bands, so mark each qualifying block into a coarse grid and blit it
  // up smoothed — a soft violet wash that carries the city overview. Binary on/off, like the band.
  private drawRaster(
    context: CanvasRenderingContext2D,
    models: ChunkModel[],
    coords: L.Coords,
  ): void {
    const map = this._map;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;
    const grid = new Uint8Array(RASTER_GRID * RASTER_GRID);
    const margin = RASTER_CELL_PX;

    const mark = (pixelX: number, pixelY: number): void => {
      const cellX = Math.floor(pixelX / RASTER_CELL_PX);
      const cellY = Math.floor(pixelY / RASTER_CELL_PX);
      if (
        cellX >= 0 &&
        cellX < RASTER_GRID &&
        cellY >= 0 &&
        cellY < RASTER_GRID
      ) {
        grid[cellY * RASTER_GRID + cellX] = 1;
      }
    };

    for (const { segments, qualifies } of models) {
      for (let index = 0; index < segments.length; index++) {
        if (qualifies[index] === 0) {
          continue;
        }
        const { lngs, lats } = segments[index];
        let previousX = 0;
        let previousY = 0;
        for (let vertex = 0; vertex < lngs.length; vertex++) {
          const point = map.project(
            L.latLng(lats[vertex], lngs[vertex]),
            coords.z,
          );
          const pixelX = point.x - originX;
          const pixelY = point.y - originY;
          if (vertex === 0) {
            previousX = pixelX;
            previousY = pixelY;
            mark(pixelX, pixelY);
            continue;
          }
          // Walk the piece in half-cell steps so every cell it crosses is marked, including off-tile
          // ones within the margin (a block on the seam should tint both tiles). Cheap: cells are
          // small.
          const spanX = pixelX - previousX;
          const spanY = pixelY - previousY;
          const length = Math.hypot(spanX, spanY);
          const steps = Math.max(1, Math.ceil(length / (RASTER_CELL_PX / 2)));
          for (let step = 1; step <= steps; step++) {
            const walkX = previousX + (spanX * step) / steps;
            const walkY = previousY + (spanY * step) / steps;
            if (
              walkX >= -margin &&
              walkX <= TILE_SIZE + margin &&
              walkY >= -margin &&
              walkY <= TILE_SIZE + margin
            ) {
              mark(walkX, walkY);
            }
          }
          previousX = pixelX;
          previousY = pixelY;
        }
      }
    }

    const image = new ImageData(RASTER_GRID, RASTER_GRID);
    const [red, green, blue] = VIOLET_RGB.split(",").map((part) =>
      Number.parseInt(part, 10),
    );
    const alpha = Math.round(255 * RASTER_OPACITY);
    for (let cell = 0; cell < grid.length; cell++) {
      if (grid[cell] === 0) {
        continue;
      }
      const offset = cell * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = alpha;
    }
    const scratch = document.createElement("canvas");
    scratch.width = RASTER_GRID;
    scratch.height = RASTER_GRID;
    scratch.getContext("2d")?.putImageData(image, 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(scratch, 0, 0, TILE_SIZE, TILE_SIZE);
  }
}

export default function DiningLayer() {
  const map = useMap();

  useEffect(() => {
    // A dedicated pane, so the dark-mode tile-pane invert leaves the violet true.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    const layers = manifest.cities.map((city) => {
      const { south, west, north, east } = city.bounds;
      return new CommercialGrid({
        pane: PANE_NAME,
        bounds: L.latLngBounds([south, west], [north, east]),
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        // Each tile projects every qualifying segment in its covering chunk(s) — too heavy to redo
        // mid-pinch. Defer tile creation until the gesture settles, and keep a wider ring so a pan
        // after a zoom doesn't immediately re-draw.
        updateWhenZooming: false,
        keepBuffer: 4,
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
