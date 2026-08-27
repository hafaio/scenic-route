"use client";

import L from "leaflet";
import { currentTheme, subscribeTheme } from "../theme/current";
import type {
  DoneMessage,
  ShadePrefetchMessage,
  TileParams,
  ToWorker,
} from "./protocol";
import { tileRatio } from "./raster";
import type { ShedDecks } from "./shed-decks";

// The main-thread half of the off-thread rasterizer. Every canvas overlay that used to project its
// geometry inside createTile subclasses this instead: the tile canvas is handed to the worker and
// returned to Leaflet immediately, so nothing about drawing it lands in a pan or pinch frame.

const TILE_SIZE = 256;

interface PendingTile {
  tile: HTMLCanvasElement;
  done: L.DoneCallback;
}

// One worker for all of them: the blobs it decodes are shared between overlays, and the scratch
// buffers the draws reuse rely on one tile being rasterized at a time.
let worker: Worker | undefined;
const pending = new Map<number, PendingTile>();
let nextTileKey = 0;

// Every worker-drawn layer on the map. The theme is not a per-layer fact, so the flip is handled
// once here rather than by each of them subscribing: tell the worker, then ask every layer for its
// tiles again. Leaflet keeps a drawn tile forever otherwise — it has no idea the pixels went stale.
const layers = new Set<WorkerTileLayer>();

function repaintForTheme(): void {
  // Told through the existing worker rather than `tileWorker()`, which would START one for a map
  // that has none of these layers on it. A worker that does not exist yet is told the theme as it
  // starts, and this must reach one that does even when nothing is drawn through it right now — the
  // worker outlives the layers, so an overlay switched off across a flip and back on afterwards
  // would otherwise paint in the theme the page loaded in.
  if (worker) {
    const message: ToWorker = { type: "theme", theme: currentTheme() };
    worker.postMessage(message);
  }
  for (const layer of layers) {
    layer.redraw();
  }
}

subscribeTheme(repaintForTheme);

function tileWorker(): Worker {
  if (!worker) {
    const started = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    started.addEventListener(
      "message",
      ({ data }: MessageEvent<DoneMessage>) => {
        const entry = pending.get(data.tileKey);
        pending.delete(data.tileKey);
        entry?.done(data.error ? new Error(data.error) : undefined, entry.tile);
      },
    );
    // Data paths are relative so they pick up the deploy's basePath, and a worker would resolve
    // those against its own chunk URL, so it gets the document's base to resolve them against.
    const init: ToWorker = { type: "init", base: document.baseURI };
    started.postMessage(init);
    // Before any draw, so the first tile is painted in the theme the page loaded in rather than in
    // the light default and then again a moment later.
    const theme: ToWorker = { type: "theme", theme: currentTheme() };
    started.postMessage(theme);
    worker = started;
  }
  return worker;
}

// Warm source tiles a layer will want shortly. No canvas is transferred and nothing is drawn, so
// this rides the same worker without a layer of its own.
export function prefetchShadeTiles(message: ShadePrefetchMessage): void {
  tileWorker().postMessage(message);
}

// The date's shed decks, for the shadows the swept shade tiles cast. Copied rather than transferred:
// the display overlay draws from the same arrays on this side. Messages are delivered in order, so a
// draw posted after this one already sees them.
export function sendShedDecks(decks: ShedDecks): void {
  const message: ToWorker = { type: "shed-decks", decks };
  tileWorker().postMessage(message);
}

export default class WorkerTileLayer extends L.GridLayer {
  // The keys the worker knows its in-flight tiles by, weakly held so a dropped tile stays collectable.
  private readonly tileKeys = new WeakMap<HTMLElement, number>();

  constructor(
    private readonly tileParams: () => TileParams,
    options: L.GridLayerOptions,
  ) {
    super(options);
    this.on({
      tileunload: ({ tile }) => {
        this.discard(tile);
      },
      add: () => {
        layers.add(this);
      },
      remove: () => {
        layers.delete(this);
      },
    });
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = tileRatio();
    tile.width = TILE_SIZE * ratio;
    tile.height = TILE_SIZE * ratio;

    const tileKey = nextTileKey;
    nextTileKey += 1;
    this.tileKeys.set(tile, tileKey);
    pending.set(tileKey, { tile, done });
    // One-way: this canvas can never yield a 2d context on the main thread again.
    const canvas = tile.transferControlToOffscreen();
    const message: ToWorker = {
      type: "draw",
      tileKey,
      coords: { x: coords.x, y: coords.y, z: coords.z },
      ratio, // the worker has no window to read a pixel ratio from
      params: this.tileParams(),
      canvas,
    };
    tileWorker().postMessage(message, [canvas]);
    return tile;
  }

  // Leaflet threw the tile away — off the map, or scrolled out of the buffer — possibly before its
  // data arrived, so tell the worker to skip whatever is left of it.
  private discard(tile: HTMLElement): void {
    const tileKey = this.tileKeys.get(tile);
    if (tileKey !== undefined) {
      this.tileKeys.delete(tile);
      pending.delete(tileKey);
      const message: ToWorker = { type: "cancel", tileKey };
      tileWorker().postMessage(message);
    }
  }
}
