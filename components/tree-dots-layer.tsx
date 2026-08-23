"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import {
  getEnabledGenera,
  subscribeGenusFilter,
} from "../src/tree-cover/genus-filter";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The crisp half of the genus overlay. Below MIN_ZOOM the pre-rendered raster tiles carry it —
// far too many trees to draw live across a zoomed-out screen. At and above MIN_ZOOM those tiles
// would upscale and blur, so each tree is instead drawn as a canvas disc at the tile's own zoom.
// The decoding and the drawing live in the tile worker (src/tiles/tree-dots.ts).

const MIN_ZOOM = 15; // the handoff: raster tiles below, live dots at and above
const MAX_ZOOM = 20;
const PANE_NAME = "genus"; // shares the raster layer's non-inverted pane, so dark mode leaves it true-coloured
const PANE_Z_INDEX = 250;

export default function TreeDotsLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    // Share the raster layer's dedicated pane so the categorical dots escape the dark-mode
    // tile-pane invert exactly as the raster tiles do; create it if the raster layer has not.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      .filter((city) => city.field.genus)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        const file = city.field.trees.file;
        return new WorkerTileLayer(
          // The legend's selection travels with each tile request, so a toggle's redraw carries the
          // new one.
          () => ({ kind: "tree-dots", file, enabled: [...getEnabledGenera()] }),
          {
            pane: PANE_NAME,
            bounds: L.latLngBounds([south, west], [north, east]),
            minZoom: MIN_ZOOM,
            maxZoom: MAX_ZOOM,
            // a wider ring, so panning after a zoom doesn't immediately re-draw
            keepBuffer: 4,
          },
        );
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) => watchLayerStatus(layer, "genus"));
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
      for (const detach of watching) {
        detach();
      }
      for (const layer of layers) {
        layer.remove();
      }
    };
  }, [map, active.id]);

  return null;
}
