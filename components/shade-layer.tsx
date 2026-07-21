"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import * as SunCalc from "suncalc";
import { getResolvedDate, subscribeRouteTime } from "../src/route-time/store";
import manifest from "../src/tree-cover/manifest.json";

// The "Shade" overlay: building-shadow tiles for the sun's actual position, drawn as a smooth cool wash
// over all ground. The heavy work — casting ~1M building footprints with a physically-modelled penumbra
// (area-light sampling of the sun disk) — is baked by `tiler shade` into one WebP pyramid per SUN-POSITION
// bin: the sun's (azimuth, elevation) envelope over the whole year, gridded, at public/tiles/shade/<bin>/
// {z}/{x}/{y}.webp, with public/tiles/shade/buckets.json listing each bin's position. This layer maps the
// picked time on TODAY'S date to a sun position, shows the nearest bin, and CROSSFADES between bins as the
// sun moves — no per-frame redraw, no flicker. Below the horizon it shows nothing.

const PANE_NAME = "shade-field";
const PANE_Z_INDEX = 275; // just under the commercial band (280), above the canopy fill

const MIN_ZOOM = 10;
const MAX_ZOOM = 20;
// The finest level `tiler shade` bakes; above it Leaflet upscales the native tile. Keep in sync with
// SHADE_MAX_ZOOM in scripts/shade-schedule.ts.
const MAX_NATIVE_ZOOM = 16;

const SCHEDULE_URL = "tiles/shade/buckets.json";
const TILE_URL = "tiles/shade/{bin}/{z}/{x}/{y}.webp";
const FADE_MS = 300;
const HORIZON_DEG = 0.5; // at or below this the sun is down and there is no shade to show

// suncalc@2.0.1 returns altitude/azimuth in DEGREES; azimuth is a compass bearing clockwise from north.
const sun = SunCalc as unknown as {
  getPosition: (
    date: Date,
    lat: number,
    lng: number,
  ) => { altitude: number; azimuth: number };
};

const [city] = manifest.cities;
const CENTRE_LAT = (city.bounds.north + city.bounds.south) / 2;
const CENTRE_LNG = (city.bounds.east + city.bounds.west) / 2;

// One baked sun-position bin: its tile-pyramid index and the sun position (degrees) it stands for.
interface Bin {
  index: number;
  elevation: number;
  azimuth: number;
}

// One shared fetch of the bin schedule, so every ShadeLayer mount reuses it.
let schedule: Promise<Bin[]> | null = null;

function loadSchedule(): Promise<Bin[]> {
  if (!schedule) {
    schedule = fetch(SCHEDULE_URL)
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => []);
  }
  return schedule;
}

// The sun's position over the city at the route-time store's resolved instant (now, or a picked time).
function currentSun(): { elevation: number; azimuth: number } {
  const position = sun.getPosition(getResolvedDate(), CENTRE_LAT, CENTRE_LNG);
  return {
    elevation: position.altitude,
    azimuth: ((position.azimuth % 360) + 360) % 360,
  };
}

// The bin nearest a sun position, by angular distance on the sky. Azimuth differences are scaled by
// cos(elevation) so they count for less when the sun is high (where azimuth means little).
function nearestBin(bins: Bin[], elevation: number, azimuth: number): Bin {
  let best = bins[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const bin of bins) {
    let deltaAzimuth = Math.abs(bin.azimuth - azimuth);
    if (deltaAzimuth > 180) {
      deltaAzimuth = 360 - deltaAzimuth;
    }
    const scaled =
      deltaAzimuth *
      Math.cos((((elevation + bin.elevation) / 2) * Math.PI) / 180);
    const deltaElevation = bin.elevation - elevation;
    const distance = deltaElevation * deltaElevation + scaled * scaled;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = bin;
    }
  }
  return best;
}

export default function ShadeLayer() {
  const map = useMap();

  useEffect(() => {
    // A dedicated pane, so the dark-mode tile-pane invert leaves the slate tint true.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    let cancelled = false;
    let bins: Bin[] = [];
    let activeIndex = -1;
    const layers = new Map<number, L.TileLayer>();

    // The tile layer for a bin, created (hidden) on first use and kept so returning to it is instant.
    // A CSS opacity transition on its container turns setOpacity into a crossfade.
    const layerFor = (index: number): L.TileLayer => {
      const existing = layers.get(index);
      if (existing) {
        return existing;
      }
      const layer = L.tileLayer(TILE_URL.replace("{bin}", String(index)), {
        pane: PANE_NAME,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        maxNativeZoom: MAX_NATIVE_ZOOM,
        opacity: 0,
        updateWhenZooming: false,
        keepBuffer: 4,
      });
      layer.addTo(map);
      const container = layer.getContainer();
      if (container) {
        container.style.transition = `opacity ${FADE_MS}ms ease`;
      }
      layers.set(index, layer);
      return layer;
    };

    // Map the picked time to today's sun position, show the nearest bin (or nothing when the sun is
    // down), and crossfade from the previous.
    const apply = (): void => {
      if (bins.length === 0) {
        return;
      }
      const { elevation, azimuth } = currentSun();
      const target =
        elevation > HORIZON_DEG
          ? nearestBin(bins, elevation, azimuth).index
          : -1;
      if (target === activeIndex) {
        return;
      }
      const previousIndex = activeIndex;
      const previous = layers.get(previousIndex);
      if (target >= 0) {
        layerFor(target).setOpacity(1);
      }
      activeIndex = target;
      if (previous) {
        previous.setOpacity(0);
        // Drop the faded-out bin once its crossfade is done, so scrubbing the clock doesn't leave a
        // hidden TileLayer (and its tiles) alive per bin visited. Keep it if it became active again
        // mid-fade (a quick scrub back), and skip after unmount (the cleanup already removed it).
        window.setTimeout(() => {
          if (!cancelled && activeIndex !== previousIndex) {
            previous.remove();
            layers.delete(previousIndex);
          }
        }, FADE_MS);
      }
    };

    loadSchedule().then((loaded) => {
      if (!cancelled) {
        bins = loaded;
        apply();
      }
    });
    const unsubscribe = subscribeRouteTime(apply);

    return () => {
      cancelled = true;
      unsubscribe();
      for (const layer of layers.values()) {
        layer.remove();
      }
    };
  }, [map]);

  return null;
}
