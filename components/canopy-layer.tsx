"use client";

import L from "leaflet";
import { TileLayer } from "react-leaflet";
import manifest from "../src/tree-cover/manifest.json";

// Pre-rendered by scripts/build-street-tiles.ts (`tiler canopy`): the measured 2017 LiDAR tree
// canopy, rasterized to a per-pixel covered fraction, blurred, and coloured by the emerald ramp.
// This is the map's cover fill; its street-line companion (StreetScoreLayer) samples the same
// canopy at each sidewalk, so the block fill and the lines speak of one measured field.
// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const TILE_URL = "tiles/canopy/{z}/{x}/{y}.webp";
const MIN_NATIVE_ZOOM = 9;
const MAX_NATIVE_ZOOM = 15; // the pyramid's finest zoom; Leaflet upscales beyond it

// In the shared tile pane, so the dark-mode pane filter in globals.css inverts the overlay
// along with the map under it.
const Z_INDEX = 2;

export default function CanopyLayer() {
  // one layer per city that has a canopy source, each clipped to its own bbox
  return manifest.cities
    .filter((city) => city.field.canopy)
    .map((city) => {
      const { south, west, north, east } = city.bounds;
      const canopy = city.field.canopy;
      return (
        <TileLayer
          key={city.id}
          url={TILE_URL}
          bounds={L.latLngBounds([south, west], [north, east])}
          minNativeZoom={MIN_NATIVE_ZOOM}
          maxNativeZoom={MAX_NATIVE_ZOOM}
          maxZoom={20}
          zIndex={Z_INDEX}
          attribution={`<a href="${canopy?.sourceUrl}" target="_blank" rel="noreferrer">${canopy?.attribution}</a>`}
        />
      );
    });
}
