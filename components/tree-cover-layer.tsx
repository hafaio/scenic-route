"use client";

import L from "leaflet";
import { TileLayer } from "react-leaflet";
import manifest from "../src/tree-cover/manifest.json";

// Pre-rendered by scripts/build-street-tiles.ts: density blurred at the scale of a
// neighbourhood, so this shades whole blocks. The per-street detail is drawn on top by
// components/street-score-layer.tsx.
// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const TILE_URL = "tiles/tree-cover/{z}/{x}/{y}.png";
const MIN_NATIVE_ZOOM = 9;
const MAX_NATIVE_ZOOM = 15; // no detail past the blur; Leaflet upscales beyond it

// In the shared tile pane, so the dark-mode pane filter in globals.css inverts the overlay
// along with the map under it.
const Z_INDEX = 2;

export default function TreeCoverLayer() {
  // one layer per city, each clipped to its own bbox: the pyramid only has tiles there
  return manifest.cities.map((city) => {
    const { south, west, north, east } = city.bounds;
    return (
      <TileLayer
        key={city.id}
        url={TILE_URL}
        bounds={L.latLngBounds([south, west], [north, east])}
        minNativeZoom={MIN_NATIVE_ZOOM}
        maxNativeZoom={MAX_NATIVE_ZOOM}
        maxZoom={20}
        zIndex={Z_INDEX}
        attribution={`<a href="${city.sourceUrl}" target="_blank" rel="noreferrer">${city.attribution}</a>`}
      />
    );
  });
}
