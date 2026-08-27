"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The manufacturing and industrial tax lots (magic INDL), filled. Like the lines it rides in a pane
// of its own, and under them: it is an areal wash, and a highway or a ferry line drawn beneath it
// would be lost. The decoding and the drawing live in the tile worker (src/tiles/industrial.ts).

const PANE_NAME = "scenic-industrial";
const PANE_Z_INDEX = 270; // its own rung, under the shade wash (275) and the commercial band (280)
const MIN_ZOOM = 11;
const MAX_ZOOM = 20;

export default function IndustrialLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }
    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        // Relative, so it picks up the basePath the deploy injects.
        const url = `industrial/${city.id}.bin`;
        return new WorkerTileLayer(() => ({ kind: "industrial", url }), {
          pane: PANE_NAME,
          bounds: L.latLngBounds([south, west], [north, east]),
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          keepBuffer: KEEP_BUFFER,
        });
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) =>
      watchLayerStatus(layer, "industrial"),
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
