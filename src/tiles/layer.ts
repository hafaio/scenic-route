"use client";

import L from "leaflet";
import type {
  DoneMessage,
  ShadePrefetchMessage,
  TileParams,
  ToWorker,
} from "./protocol";

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
    worker = started;
  }
  return worker;
}

// Warm source tiles a layer will want shortly. No canvas is transferred and nothing is drawn, so
// this rides the same worker without a layer of its own.
export function prefetchShadeTiles(message: ShadePrefetchMessage): void {
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
    });
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = window.devicePixelRatio || 1;
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
      ratio, // devicePixelRatio does not exist in a worker
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
