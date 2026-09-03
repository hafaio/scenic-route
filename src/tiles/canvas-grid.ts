"use client";

import L from "leaflet";
import { subscribeTheme } from "../theme/current";
import { repaintOnRestore } from "./repaint";

// A grid layer that draws its own tiles here rather than in the worker, and survives having their
// pixels reclaimed (./repaint). Subclasses paint through `watch`.

// Every one of these on the map, so a theme flip can hand them all back their tiles: what they draw
// in is a colour per theme, and Leaflet keeps a drawn tile forever otherwise. The same repaint
// ./layer.ts does for the worker's layers.
const grids = new Set<CanvasGrid>();

subscribeTheme(() => {
  for (const grid of grids) {
    grid.redraw();
  }
});

export default class CanvasGrid extends L.GridLayer {
  private readonly watchers = new WeakMap<HTMLElement, () => void>();

  constructor(options?: L.GridLayerOptions) {
    super(options);
    this.on({
      tileunload: ({ tile }) => {
        this.watchers.get(tile)?.();
        this.watchers.delete(tile);
      },
      add: () => {
        grids.add(this);
      },
      remove: () => {
        grids.delete(this);
      },
    });
  }

  protected watch(tile: HTMLCanvasElement, paint: () => void): void {
    this.watchers.set(tile, repaintOnRestore(tile, paint));
    paint();
  }
}
