"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The subway overlay: the agency's route geometry in its published colours, with a marker at every
// station. Like the ferry lines and the POI dots it rides in a pane of its own, above every areal
// wash. The decoding and the drawing live in the tile worker (src/tiles/subway.ts).
//
// The one overlay with no `bounds`, where every other one is cut to the active city's rectangle.
// Rail is drawn and never walked, so its artifact is the whole of each agency's network rather than
// the part of it standing on the region's ground (scripts/subway-sf.ts): BART crosses the bay and
// runs out to Antioch and Berryessa, and the region rectangle stops at Berkeley and South San
// Francisco. Bounding this layer by it cut the Transbay Tube in the middle of the water and ended
// four lines on an invisible straight edge. Nothing in the manifest describes the rail extent, so
// the layer states none and lets the network's own reach be it — the worker's spatial index holds
// only the lines and stations in the file, so a tile beyond them draws nothing.

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
        // Relative, so it picks up the basePath the deploy injects.
        const url = `subway/${city.id}.bin`;
        return new WorkerTileLayer(() => ({ kind: "subway", url }), {
          pane: PANE_NAME,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          keepBuffer: KEEP_BUFFER,
        });
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) => watchLayerStatus(layer, "subway"));
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
