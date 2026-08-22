"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import WorkerTileLayer from "../src/tiles/layer";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The LPC's designated historic districts (magic HDST), filled. Like the industrial lots it rides in
// a dedicated pane so the dark-mode tile-pane invert leaves the fill's colour true, and it sits under
// them: it is the broadest areal wash the map draws — whole neighbourhoods — so anything finer put
// beneath it would be lost. The decoding and the drawing live in the tile worker
// (src/tiles/historic.ts).

const PANE_NAME = "scenic-historic";
const PANE_Z_INDEX = 265; // its own rung, under the industrial lots (270) and over the tree fills (250)
const MIN_ZOOM = 11;
const MAX_ZOOM = 20;

export default function HistoricLayer() {
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
        const url = `historic/${city.id}.bin`;
        return new WorkerTileLayer(() => ({ kind: "historic", url }), {
          pane: PANE_NAME,
          bounds: L.latLngBounds([south, west], [north, east]),
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
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
