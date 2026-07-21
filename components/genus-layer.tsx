"use client";

import L from "leaflet";
import { useState, useSyncExternalStore } from "react";
import { Pane, TileLayer, useMap, useMapEvents } from "react-leaflet";
import {
  getEnabledGenera,
  subscribeGenusFilter,
} from "../src/tree-cover/genus-filter";
import manifest from "../src/tree-cover/manifest.json";
import TreeDotsLayer from "./tree-dots-layer";

// Pre-rendered by scripts/build-street-tiles.ts (`tiler genus`): each street tree drawn as a
// crown-sized disc coloured by its genus (src/tree-cover/genus.ts). This raster half carries the
// zoomed-out view, where a screen holds far too many trees to draw live; from z15 up TreeDotsLayer
// takes over with live canvas discs, which stay crisp where an upscaled raster tile would blur.
// The pyramid is split by genus: each id holds only its own trees, so we stack one transparent
// layer per enabled genus and toggling one adds or removes a single layer (the others keep their
// loaded tiles, so nothing else flickers). Relative URLs, so they pick up the basePath the deploy
// injects; the app is a single-route SPA.
const TILE_URL = "tiles/genus/{genus}/{z}/{x}/{y}.webp";
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
  // The enabled-genus selection. useSyncExternalStore keeps this component in step with the legend
  // and the live-dot half, which read the same store. Each layer is keyed by its genus id, so a
  // toggle mounts or unmounts only that one layer and leaves the rest (and their tiles) in place.
  const enabled = useSyncExternalStore(
    subscribeGenusFilter,
    getEnabledGenera,
    getEnabledGenera,
  );
  const genera = [...enabled].sort((first, second) => first - second);

  // The current zoom, tracked so the per-layer opacity can follow it (below).
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());
  useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });

  // At low zoom a genus's dots overlap so heavily its tile saturates to a solid colour, so stacking
  // the enabled layers at full opacity would just show the top one. So each layer's opacity ramps
  // with zoom: an even 1/N blend at MIN_NATIVE_ZOOM (the genera mix instead of the topmost winning,
  // totalling ~0.65 with all twelve on) up to full at MAX_NATIVE_ZOOM, where the tiles are sparse
  // enough to read crisply and to meet the live dots that take over just above. Per-layer, not baked
  // into the tiles, so an isolated genus always reads at full strength; toggling one only nudges the
  // survivors' opacity — no refetch.
  const share = 1 / genera.length;
  const zoomFraction = Math.min(
    1,
    Math.max(0, (zoom - MIN_NATIVE_ZOOM) / (MAX_NATIVE_ZOOM - MIN_NATIVE_ZOOM)),
  );
  const layerOpacity = share + (1 - share) * zoomFraction;

  // one layer per city that has a genus source × enabled genus, each clipped to its own bbox
  const layers = manifest.cities
    .filter((city) => city.field.genus)
    .flatMap((city) => {
      const { south, west, north, east } = city.bounds;
      return genera.map((id) => (
        <TileLayer
          key={`${city.id}-${id}`}
          url={TILE_URL.replace("{genus}", String(id))}
          pane={PANE_NAME}
          bounds={L.latLngBounds([south, west], [north, east])}
          opacity={layerOpacity}
          minNativeZoom={MIN_NATIVE_ZOOM}
          maxNativeZoom={MAX_NATIVE_ZOOM}
          maxZoom={MAX_NATIVE_ZOOM}
          updateWhenZooming={false}
          keepBuffer={4}
          attribution={GENUS_ATTRIBUTION}
        />
      ));
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
