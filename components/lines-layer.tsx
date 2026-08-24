"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import type { OverlayId } from "../src/overlays/registry";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// A line overlay: the committed highway/rail nuisance lines (magic HWAY) or the ferry route segments
// (magic FERR), drawn as coloured canvas polylines at every zoom. Like the POI dots they ride in a
// pane of their own, above every areal wash: a line is a thing on the ground rather than the ground.
// The decoding and the drawing live in the tile worker (src/tiles/lines.ts).

const PANE_NAME = "scenic-lines";
const PANE_Z_INDEX = 290; // below the POI dots (300), above the canopy fill
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;

export default function LinesLayer({
  overlay,
  dir,
  format,
  color,
}: {
  overlay: OverlayId; // which menu row this instance is, since two of them share this component
  dir: string; // the served directory, e.g. "highways" — the blob is <dir>/<city>.bin
  format: "hway" | "ferr"; // which binary layout to decode
  color: string; // CSS stroke colour
}) {
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
        const url = `${dir}/${city.id}.bin`;
        return new WorkerTileLayer(
          () => ({ kind: "lines", url, format, color }),
          {
            pane: PANE_NAME,
            bounds: L.latLngBounds([south, west], [north, east]),
            minZoom: MIN_ZOOM,
            maxZoom: MAX_ZOOM,
            keepBuffer: 4,
          },
        );
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) => watchLayerStatus(layer, overlay));
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
  }, [map, overlay, dir, format, color, active.id]);

  return null;
}
