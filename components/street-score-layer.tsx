"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The canopy score along every street, one line per sidewalk. The decoding and the drawing live in
// the tile worker (src/tiles/street-score.ts).

// Below this the lines would be hairlines, and a screen of them would pull in every chunk
// in the city; the fill carries the map on its own.
const MIN_ZOOM = 13;
const MAX_ZOOM = 20;

// Above the fill (zIndex 2) and still in the tile pane: the lines read the same canopy ramp the
// fill does, so they belong with it rather than in a pane of their own.
const Z_INDEX = 3;

export default function StreetScoreLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        return new WorkerTileLayer(() => ({ kind: "street-score" }), {
          bounds: L.latLngBounds([south, west], [north, east]),
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          zIndex: Z_INDEX,
          // a wider ring, so panning after a zoom doesn't immediately re-draw
          keepBuffer: 4,
        });
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) => watchLayerStatus(layer, "canopy"));
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
