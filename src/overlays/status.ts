"use client";

import type L from "leaflet";
import { useSyncExternalStore } from "react";
import type { OverlayId } from "./registry";

// Which overlays are failing to load their data, so the layers menu can say so.
//
// The distinction this rests on is drawn in the tile renderers, not here: a 404 is a fact about the
// deploy — the pyramids are sparse, a chunk over water was never written — and those come back as an
// empty tile, while anything else throws. So a tile error means the data could not be REACHED, and
// the map showing nothing is the app's ignorance rather than the city's emptiness. Left unsaid, the
// two look identical to a reader: a blank overlay reads as "there is nothing here", which is the one
// thing it must not say.
//
// A module store rather than context: the reporters are Leaflet layers mounted deep inside the map
// and the reader is the toolbar's menu outside it, and threading state between those two is what
// context would be for if they shared an ancestor worth the prop.

const EMPTY: ReadonlySet<OverlayId> = new Set();

// The FAILING LAYERS, not the failing overlays. Several map layers can stand behind one menu row —
// "Tree canopy" is a raster pyramid plus a line layer, "Tree genus" is a WebGL field plus dots — and
// they load independently. Keyed per layer so the one that succeeded cannot report the row healthy
// while the one beside it is failing; the row is unreachable while any of its layers is.
const failing = new Map<OverlayId, Set<symbol>>();

let unreachable: ReadonlySet<OverlayId> = EMPTY;
const listeners = new Set<() => void>();

function republish(): void {
  const next = new Set(failing.keys());
  if (
    next.size === unreachable.size &&
    [...next].every((id) => unreachable.has(id))
  ) {
    return;
  }
  unreachable = next;
  for (const listener of listeners) {
    listener();
  }
}

// One layer's verdict. A layer that recovers has to be able to say so, which is what clears the
// badge when the network comes back.
function reportLayerStatus(
  overlay: OverlayId,
  layer: symbol,
  reachable: boolean,
): void {
  const layers = failing.get(overlay);
  if (reachable) {
    layers?.delete(layer);
    if (layers?.size === 0) {
      failing.delete(overlay);
    }
  } else if (layers) {
    layers.add(layer);
  } else {
    failing.set(overlay, new Set([layer]));
  }
  republish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A failure that never reaches a tile. Most of an overlay's data arrives as tiles, and a tile that
// errors is what `watchLayerStatus` counts — but a layer whose own MANIFEST fails never mounts a tile
// at all, so it draws nothing and the tile path has nothing to report. The shade schedule is the case
// that showed this up: block `buckets.json` and the whole layer goes quiet with a tick beside it.
//
// Reported per layer like the tile path, so a manifest failure and a tile failure on the same overlay
// cannot clear each other.
export function reportLayerData(
  overlay: OverlayId,
  token: symbol,
  reachable: boolean,
): void {
  reportLayerStatus(overlay, token, reachable);
}

// The current verdict, outside React. The hook below is the app's reader; this is what a test — or
// anything else without a component around it — asks.
export function unreachableLayers(): ReadonlySet<OverlayId> {
  return unreachable;
}

export function useUnreachableLayers(): ReadonlySet<OverlayId> {
  return useSyncExternalStore(subscribe, unreachableLayers, () => EMPTY);
}

// Wire one grid layer's tiles into the store, and hand back the detach.
//
// The verdict is per LOAD CYCLE, not per tile: a viewport where one chunk fails and eleven succeed
// would otherwise flap the badge on and off as the successes came in. Leaflet brackets each round of
// tile requests with `loading` and `load`, so the errors inside one round are counted and the layer
// is judged once at the end of it — and judged again on the next pan, which is what lets it clear
// itself when the network comes back.
export function watchLayerStatus(
  layer: L.GridLayer,
  overlay: OverlayId,
): () => void {
  const token = Symbol(overlay);
  let errors = 0;
  const started = (): void => {
    errors = 0;
  };
  const failed = (): void => {
    errors += 1;
  };
  const finished = (): void => {
    reportLayerStatus(overlay, token, errors === 0);
  };
  layer.on("loading", started);
  layer.on("tileerror", failed);
  layer.on("load", finished);
  return () => {
    layer.off("loading", started);
    layer.off("tileerror", failed);
    layer.off("load", finished);
    // A layer coming off the map has no verdict to report: it was switched off, or the city changed,
    // and neither says anything about whether the data is reachable now.
    reportLayerStatus(overlay, token, true);
  };
}
