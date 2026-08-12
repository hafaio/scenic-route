"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import WorkerTileLayer from "../src/tiles/layer";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// Pre-rendered by scripts/build-street-tiles.ts (`tiler canopy`): the measured 2017 LiDAR tree
// canopy, rasterized to a per-pixel covered fraction, blurred, and coloured by the emerald ramp.
// This is the map's cover fill; its street-line companion (StreetScoreLayer) samples the same
// canopy at each sidewalk, so the block fill and the lines speak of one measured field.
//
// The tiles are drawn by the tile worker (src/tiles/canopy.ts) rather than fetched into <img>s, so
// that past the pyramid's finest level the magnification resamples across tile boundaries instead of
// leaving a seam at every one.

// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const TILE_URL = "tiles/canopy/{z}/{x}/{y}.webp";
const MIN_NATIVE_ZOOM = 9; // the pyramid's coarsest zoom; below it Leaflet shrinks that level
const MAX_NATIVE_ZOOM = 15; // the finest; above it the worker magnifies from this level
const MAX_ZOOM = 20;

// In the shared tile pane, so the dark-mode pane filter in globals.css inverts the overlay
// along with the map under it.
const Z_INDEX = 2;

export default function CanopyLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    // one layer per city that has a canopy source, each clipped to its own bbox
    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      .filter((city) => city.field.canopy)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        return new WorkerTileLayer(
          () => ({
            kind: "canopy",
            url: TILE_URL,
            maxNativeZoom: MAX_NATIVE_ZOOM,
          }),
          {
            bounds: L.latLngBounds([south, west], [north, east]),
            // Deliberately no maxNativeZoom: it would clamp the tile grid to the baked levels,
            // leaving Leaflet to stretch the tile again and the worker nothing to magnify. The floor
            // stays Leaflet's, since shrinking one baked level is all a zoom below the pyramid needs.
            minNativeZoom: MIN_NATIVE_ZOOM,
            maxZoom: MAX_ZOOM,
            zIndex: Z_INDEX,
            // a wider ring, so panning after a zoom doesn't immediately re-draw
            keepBuffer: 4,
          },
        );
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
