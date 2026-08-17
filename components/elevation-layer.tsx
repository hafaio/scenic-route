"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// The elevation overlay: the city's ground, tinted by height and relief-shaded, baked by
// the elevation pass into public/tiles/elevation/<city>/{z}/{x}/{y}.webp.
//
// A plain raster layer rather than one of the worker-drawn ones. There is nothing to composite and
// nothing that depends on the clock or the date — the ground does not move — so the tiles go
// straight into <img>s and Leaflet's own cache, which is the cheapest thing on the map.

// In the shared tile pane, under the canopy fill (z 2) and over the basemap: the terrain is the
// thing the rest of the map sits on, and at 82% opacity it buries anything it is put on top of. A
// pane of its own would also have missed the dark-mode filter globals.css runs over this pane, and
// come out as the only layer that did not invert.
const Z_INDEX = 1;
const MIN_ZOOM = 9;
const MAX_ZOOM = 20;
// The finest level the elevation pass bakes. Keep in sync with ELEVATION_MAX_ZOOM in
// crates/tiler/src/elevation.rs. Past it Leaflet upscales: the tint survives that happily, being
// smooth, but the COASTLINE does not — the land mask is applied per field cell, so magnifying shows
// its steps as a staircase. Baking to 16 puts a step at about 2.4 m, near the 1 m source.
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
    const layer = L.tileLayer(`tiles/elevation/${active.id}/{z}/{x}/{y}.webp`, {
      zIndex: Z_INDEX,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      // Clipped to the city, so panning away does not ask for tiles of ground that was never baked —
      // but with a margin, because the pyramid deliberately runs past the city's box. The box is
      // drawn around the same shoreline polygons the land mask uses, and the piers and port fill
      // stand outside both; the elevation pass widens by SHORE_REACH_METERS to reach them, and asking
      // only within the box would leave the tiles it baked out there unrequested.
      bounds: L.latLngBounds(
        [city.bounds.south - BAKED_MARGIN, city.bounds.west - BAKED_MARGIN],
        [city.bounds.north + BAKED_MARGIN, city.bounds.east + BAKED_MARGIN],
      ),
      // A tile with no ground under it is not written at all, so a 404 is "no terrain here".
      errorTileUrl:
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      crossOrigin: true,
    });
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map, active.id]);

  return null;
}
