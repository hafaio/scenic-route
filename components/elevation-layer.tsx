"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The elevation overlay: the city's ground, tinted by height and relief-shaded. The elevation pass
// bakes the three fields behind that into public/tiles/elevation/<city>/{z}/{x}/{y}.webp — height,
// relief and land cover, no colour — and the tile worker (src/tiles/elevation.ts) colours them
// through the palette as it draws.

// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const TILE_URL = "tiles/elevation/{city}/{z}/{x}/{y}.webp";
// Under the canopy fill (z 2) and over the basemap: the terrain is the thing the rest of the map
// sits on, and at 67% opacity it buries anything it is put on top of.
const Z_INDEX = 1;
const MIN_ZOOM = 9;
const MAX_ZOOM = 20;
// The finest level the elevation pass bakes. Keep in sync with ELEVATION_MAX_ZOOM in
// crates/tiler/src/elevation.rs. Past it the worker magnifies from this level: the tint survives
// that happily, being smooth, but the COASTLINE is the thing a reader notices, and the land mask is
// a fractional alpha at the shore that has to be resampled across tile edges to avoid a seam.
const MAX_NATIVE_ZOOM = 16;
// Degrees of slack on the city's box, comfortably over the 300 m the elevation pass widens by. Erring
// wide costs nothing: a tile that was never baked 404s, which this layer already reads as no terrain.
const BAKED_MARGIN = 0.01;

export default function ElevationLayer(): null {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    const city = manifest.cities.find((entry) => entry.id === active.id);
    if (!city) {
      return;
    }
    const { south, west, north, east } = city.bounds;
    const layer = new WorkerTileLayer(
      () => ({
        kind: "elevation",
        url: TILE_URL.replace("{city}", active.id),
        maxNativeZoom: MAX_NATIVE_ZOOM,
      }),
      {
        // Clipped to the city, so panning away does not ask for tiles of ground that was never baked
        // — but with a margin, because the pyramid deliberately runs past the city's box. The box is
        // drawn around the same shoreline polygons the land mask uses, and the piers and port fill
        // stand outside both; the elevation pass widens by SHORE_REACH_METERS to reach them, and
        // asking only within the box would leave the tiles it baked out there unrequested.
        bounds: L.latLngBounds(
          [south - BAKED_MARGIN, west - BAKED_MARGIN],
          [north + BAKED_MARGIN, east + BAKED_MARGIN],
        ),
        // Deliberately no maxNativeZoom: it would clamp the tile grid to the baked levels, leaving
        // Leaflet to stretch the tile again and the worker nothing to magnify.
        minNativeZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        zIndex: Z_INDEX,
        keepBuffer: 4,
      },
    );
    // Attached before the layer goes on the map, or the first load cycle's `loading` is missed.
    const detach = watchLayerStatus(layer, "elevation");
    layer.addTo(map);
    return () => {
      detach();
      layer.remove();
    };
  }, [map, active.id]);

  return null;
}
