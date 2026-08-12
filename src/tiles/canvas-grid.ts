"use client";

import L from "leaflet";
import { repaintOnRestore } from "./repaint";

// A grid layer that draws its own tiles here rather than in the worker, and survives having their
// pixels reclaimed (./repaint). Subclasses paint through `watch`.
export default class CanvasGrid extends L.GridLayer {
  private readonly watchers = new WeakMap<HTMLElement, () => void>();

  constructor(options?: L.GridLayerOptions) {
    super(options);
    this.on({
      tileunload: ({ tile }) => {
        this.watchers.get(tile)?.();
        this.watchers.delete(tile);
      },
    });
  }

  protected watch(tile: HTMLCanvasElement, paint: () => void): void {
    this.watchers.set(tile, repaintOnRestore(tile, paint));
    paint();
  }
}
