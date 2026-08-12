"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import WorkerTileLayer from "../src/tiles/layer";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The "commercial" overlay: charming low-rise retail strips, highlighted a whole block at a time.
// The signals, the client-side gate and the drawing live in the tile worker
// (src/tiles/commercial.ts). It rides in a dedicated pane so the dark-mode tile-pane invert leaves
// the violet true (as the POI dots do).

const PANE_NAME = "commercial-blocks";
const PANE_Z_INDEX = 280; // above the canopy fill, below the POI dots (300) and scenic lines (290)

// The raster overview keeps the layer legible from z10; below that the whole city is a speck.
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;

export default function DiningLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    // A dedicated pane, so the dark-mode tile-pane invert leaves the violet true.
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
          // a wider ring, so a pan after a zoom doesn't immediately re-draw
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
  }, [map, active.id]);

  return null;
}
