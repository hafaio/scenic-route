"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import WorkerTileLayer from "../src/tiles/layer";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The subway overlay: the MTA's route geometry in its published colours, with a marker at every
// station. Like the ferry lines and the POI dots it rides in a dedicated pane so the dark-mode
// tile-pane invert leaves the route colours — and the white station discs — true. The decoding and
// the drawing live in the tile worker (src/tiles/subway.ts).

const PANE_NAME = "scenic-subway";
const PANE_Z_INDEX = 295; // above the ferry/highway lines (290), below the POI dots (300)
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;

export default function SubwayLayer() {
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
        const url = `subway/${city.id}.bin`;
        return new WorkerTileLayer(() => ({ kind: "subway", url }), {
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
