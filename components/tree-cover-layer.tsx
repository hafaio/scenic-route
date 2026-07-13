"use client";

import L from "leaflet";
import { TileLayer } from "react-leaflet";
import manifest from "../src/tree-cover/manifest.json";

// Pre-rendered by scripts/build-street-tiles.ts: tree density per unit area, blurred at
// the scale of a neighbourhood, so this shades whole blocks rather than streets. It has
// no detail past that blur, so the pyramid stops at z15 and Leaflet upscales beyond it;
// the crisp per-street detail is drawn on top by components/street-score-layer.tsx.
// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const TILE_URL = "tiles/tree-cover/{z}/{x}/{y}.png";
const MIN_NATIVE_ZOOM = 9;
const MAX_NATIVE_ZOOM = 15;

// Sits in the shared tile pane above the basemap, so the dark-mode pane filter in
// globals.css inverts the overlay along with the map underneath it.
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
