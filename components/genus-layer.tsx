"use client";

import L from "leaflet";
import { Pane, TileLayer } from "react-leaflet";
import manifest from "../src/tree-cover/manifest.json";
import TreeDotsLayer from "./tree-dots-layer";

// Pre-rendered by scripts/build-street-tiles.ts (`tiler genus`): each street tree drawn as a
// crown-sized disc coloured by its genus (src/tree-cover/genus.ts). This raster half carries the
// zoomed-out view, where a screen holds far too many trees to draw live; from z15 up TreeDotsLayer
// takes over with live canvas discs, which stay crisp where an upscaled raster tile would blur.
// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const TILE_URL = "tiles/genus/{z}/{x}/{y}.webp";
const MIN_NATIVE_ZOOM = 9;
const MAX_NATIVE_ZOOM = 14; // the raster pyramid's finest zoom; from z15 TreeDotsLayer draws instead
const GENUS_ATTRIBUTION = "NYC Parks Forestry (ForMS) via NYC Open Data";

// The genus colours are categorical, not a sequential ramp, so they must NOT be dark-mode
// inverted the way the canopy overlay (which shares the basemap's tile pane) is. This dedicated
// pane is a sibling of `.leaflet-tile-pane`, so the invert filter scoped to that pane in
// globals.css never touches it. zIndex 250 sits above the basemap tilePane (~200) and below the
// overlayPane (400)/markers, so genus draws over the dark-inverted basemap in true colour while
// routes and pins stay on top.
const PANE_NAME = "genus";
const PANE_Z_INDEX = 250;

export default function GenusLayer() {
  // one layer per city that has a genus source, each clipped to its own bbox
  const layers = manifest.cities
    .filter((city) => city.field.genus)
    .map((city) => {
      const { south, west, north, east } = city.bounds;
      return (
        <TileLayer
          key={city.id}
          url={TILE_URL}
          pane={PANE_NAME}
          bounds={L.latLngBounds([south, west], [north, east])}
          minNativeZoom={MIN_NATIVE_ZOOM}
          maxNativeZoom={MAX_NATIVE_ZOOM}
          maxZoom={MAX_NATIVE_ZOOM}
          updateWhenZooming={false}
          keepBuffer={4}
          attribution={GENUS_ATTRIBUTION}
        />
      );
    });

  return (
    <>
      <Pane name={PANE_NAME} style={{ zIndex: PANE_Z_INDEX }}>
        {layers}
      </Pane>
      <TreeDotsLayer />
    </>
  );
}
