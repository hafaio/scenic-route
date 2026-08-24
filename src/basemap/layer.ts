"use client";

import type L from "leaflet";
import { leafletLayer } from "protomaps-leaflet";
import type { Flavor } from "./flavor";
import { basemapLabelRules, basemapPaintRules } from "./rules";

// The basemap: Protomaps vector tiles, drawn in the browser from the style in this directory.
//
// It replaced CARTO's Voyager raster tiles, which looked right but could not come offline — CARTO's
// terms forbid caching them, and an offline map whose background is missing is not much of a map.
// Protomaps' terms invert that: the whole point of the project is that a map is an asset you may
// keep. So the service worker caches these, bounded to the cities (src/sw/policy.ts).
//
// Drawing the vectors here rather than fetching pictures of them is also what makes the night map a
// real style: it is a second colour dictionary in ./flavor.ts and nothing else, where the raster
// layer this replaced could only be inverted in CSS.

// Free for non-commercial use up to a soft cap, and restricted by the CORS allow-list set on the key
// itself rather than by keeping the key secret — so it is committed deliberately, not leaked. It is
// scoped to the deploy's own origin, which is why local development needs its own key:
// `http://localhost:3000` is not unique to any one machine, so a key that admits it admits everyone's.
// Put that one in `.env.local`, which is gitignored.
const PUBLISHED_KEY = "265db316db1cddf4";
const KEY = process.env.NEXT_PUBLIC_PROTOMAPS_KEY ?? PUBLISHED_KEY;

export const BASEMAP_URL = `https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=${KEY}`;

// The basemap's data stops here; above it the renderer redraws the same vectors larger rather than
// enlarging a picture of them, which is why deep zooms stay sharp.
export const BASEMAP_MAX_DATA_ZOOM = 15;

export const BASEMAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &middot; <a href="https://protomaps.com">Protomaps</a>';

export function basemapLayer(flavor: Flavor): L.Layer {
  return leafletLayer({
    url: BASEMAP_URL,
    maxDataZoom: BASEMAP_MAX_DATA_ZOOM,
    // Both carried over from the raster layer this replaced. `maxZoom` is what the MAP's zoom range
    // is derived from, so dropping it would quietly cap the whole app below the zooms the swept
    // shade and the route detail live at; `keepBuffer` holds a ring of tiles around the viewport so
    // a pan after a zoom does not immediately redraw.
    maxZoom: 20,
    keepBuffer: 4,
    paintRules: basemapPaintRules(flavor),
    labelRules: basemapLabelRules(flavor),
    backgroundColor: flavor.background as string,
    attribution: BASEMAP_ATTRIBUTION,
  }) as unknown as L.Layer;
}
