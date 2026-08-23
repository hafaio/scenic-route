"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import type { OverlayId } from "../src/overlays/registry";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// A point-of-interest overlay: the committed POI points (landmarks, public art) drawn as coloured
// canvas dots at every zoom. Unlike the tree dots there is no raster pyramid below — a few thousand
// points draw live cheaply — so one canvas GridLayer covers the whole zoom range. The dots ride in a
// dedicated pane so the dark-mode tile-pane invert leaves their colour true (as the genus dots do).
// The decoding and the drawing live in the tile worker (src/tiles/poi.ts).

const PANE_NAME = "poi";
const PANE_Z_INDEX = 300; // above the canopy/genus fills, so the dots sit on top

const MIN_ZOOM = 11; // below this the city is a speck; the dots would just be noise
const MAX_ZOOM = 20;

export default function PoiLayer({
  overlay,
  dir,
  magic,
  color,
  labelAnchor,
}: {
  overlay: OverlayId; // which menu row this instance is, since two of them share this component
  dir: string; // the served directory, e.g. "landmarks" — the blob is <dir>/<city>.bin
  magic: string; // the expected 4-byte magic, e.g. "LMRK"
  color: string; // CSS fill colour for the dots
  labelAnchor: "top" | "bottom"; // which side of the dot the label sits, to deconflict two POI layers
}) {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    // A dedicated pane, so the dark-mode tile-pane invert leaves the dot colours true.
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
          () => ({ kind: "poi", url, magic, color, labelAnchor }),
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
  }, [map, overlay, dir, magic, color, labelAnchor, active.id]);

  return null;
}
