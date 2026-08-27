"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The "commercial" overlay: charming low-rise retail strips, highlighted a whole block at a time.
// The signals, the client-side gate and the drawing live in the tile worker
// (src/tiles/commercial.ts). It rides in a pane of its own, above the washes and below the dots.

const PANE_NAME = "commercial-blocks";
const PANE_Z_INDEX = 280; // above the canopy fill, below the POI dots (300) and scenic lines (290)

// The raster overview keeps the layer legible from z10; below that the whole city is a speck.
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;

export default function DiningLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    // A pane of its own: the tile pane carries one z-index for everything in it, so a layer that
    // has to sit above the washes and below the dots needs its own.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        return new WorkerTileLayer(() => ({ kind: "commercial" }), {
          pane: PANE_NAME,
          bounds: L.latLngBounds([south, west], [north, east]),
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          keepBuffer: KEEP_BUFFER,
        });
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) =>
      watchLayerStatus(layer, "commercial"),
    );
    for (const layer of layers) {
      layer.addTo(map);
    }
    return () => {
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
