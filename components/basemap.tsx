"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { FLAVORS } from "../src/basemap/flavor";
import { basemapLayer } from "../src/basemap/layer";
import { useMapTheme } from "./use-map-theme";

// The Protomaps basemap, mounted imperatively because `leafletLayer` builds a configured GridLayer
// rather than exposing a react-leaflet component. It goes in Leaflet's own default tile pane, under
// every overlay's pane, which is where the raster layer it replaced sat.

// One tile fetch, as the layer's own source performs it.
type Fetcher = (coords: unknown, tileSize: number) => Promise<unknown>;

// Watch the layer's tile fetches and report whether they are arriving.
//
// This reaches into `layer.views`, which is not part of protomaps-leaflet's typed surface, and the
// reason is that the library offers no other way to learn that a tile failed: `createTile` calls
// Leaflet's callback as `done(undefined, tile)` unconditionally, so `tileerror` NEVER fires, and
// `renderTile` catches a rejected source and only `console.error`s it. Without this the basemap is
// the one layer that can vanish in total silence — and the one whose absence leaves the map
// unreadable rather than merely emptier, since the overlays are then floating on blank ground with
// no streets to place them against.
//
// Everything is optional-chained, so a library version that moves `views` costs the warning, not the
// map.
function watchTiles(layer: unknown, onLost: (lost: boolean) => void): void {
  const { views } = layer as {
    views?: Map<string, { tileCache?: { source?: { get?: Fetcher } } }>;
  };
  for (const view of views?.values() ?? []) {
    const source = view.tileCache?.source;
    const original = source?.get;
    if (!source || !original) {
      continue;
    }
    const fetchTile = original.bind(source);
    source.get = async (coords: unknown, tileSize: number) => {
      try {
        const tile = await fetchTile(coords, tileSize);
        onLost(false);
        return tile;
      } catch (error) {
        // A pan aborts the tiles it has left behind; that is the app changing its mind, not a
        // failure to reach anything.
        if ((error as { name?: string })?.name !== "AbortError") {
          onLost(true);
        }
        throw error;
      }
    };
  }
}

export default function Basemap({
  onLost,
}: {
  onLost: (lost: boolean) => void;
}) {
  const map = useMap();
  const theme = useMapTheme();

  useEffect(() => {
    // Rebuilt rather than restyled: protomaps-leaflet resolves its paint rules once, when the layer
    // is constructed, so a flavor swap is a new layer. It costs a redraw of what is on screen, which
    // is what a theme change is.
    const layer = basemapLayer(FLAVORS[theme]);
    watchTiles(layer, onLost);
    layer.addTo(map);
    return () => {
      onLost(false);
      layer.remove();
    };
  }, [map, onLost, theme]);

  return null;
}
