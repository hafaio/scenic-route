"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import * as SunCalc from "suncalc";
import {
  getResolvedDate,
  isPickerOpen,
  subscribeRouteTime,
} from "../src/route-time/store";
import { declinationOf, hourAngleOf, seasonBand } from "../src/shade/sun";
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
const MAX_NATIVE_ZOOM = 15;

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

// One baked bin: its tile-pyramid index, its (declination, hourAngle) grid cell (what the client
// selects on), and the sun position (degrees) it stands for.
interface Bin {
  index: number;
  season: number;
  hourAngle: number;
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

// The bin for a sun position: its season band, then the nearest hour-angle step within that band.
// Hour angle advances monotonically with the clock, so scrubbing time walks the bins in order — no
// nearest-centroid flip. Bins outside the sun's band are skipped; the fallback across all bins only
// bites if a band has no baked bin (it always does while the sun is up).
function pickBin(bins: Bin[], elevation: number, azimuth: number): Bin | null {
  const declination = declinationOf(elevation, azimuth, CENTRE_LAT);
  const hourAngle = hourAngleOf(elevation, azimuth, CENTRE_LAT, declination);
  const season = seasonBand(declination);
  let best: Bin | null = null;
  let bestKey = Number.POSITIVE_INFINITY;
  for (const bin of bins) {
    // The matching band wins outright (the penalty dwarfs any hour-angle span); within it the
    // nearest hour step is chosen.
    const penalty = bin.season === season ? 0 : 1e6;
    const key = penalty + Math.abs(bin.hourAngle - hourAngle);
    if (key < bestKey) {
      bestKey = key;
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
    let precached = false; // today's bins are prefetched (the clock popover is open)
    const layers = new Map<number, L.TileLayer>();
    const ready = new Set<number>(); // bins whose tiles have finished painting at least once

    // The tile layer for a bin, created hidden on first use and kept so returning to it is instant. A
    // CSS opacity transition on its container turns setOpacity into a crossfade; the `load` event marks
    // the bin ready, so a switch can wait for the target to paint before revealing it.
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
      layer.on("load", () => ready.add(index));
      layer.addTo(map);
      const container = layer.getContainer();
      if (container) {
        container.style.transition = `opacity ${FADE_MS}ms ease`;
      }
      layers.set(index, layer);
      return layer;
    };

    const evict = (index: number): void => {
      const layer = layers.get(index);
      if (layer) {
        layer.remove();
        layers.delete(index);
        ready.delete(index);
      }
    };

    // Fade a bin out; drop it after the fade — unless the day is prefetched (then it stays cached) or
    // it became active again mid-fade.
    const retire = (index: number): void => {
      const layer = layers.get(index);
      if (index < 0 || !layer) {
        return;
      }
      layer.setOpacity(0);
      if (!precached) {
        window.setTimeout(() => {
          if (!cancelled && activeIndex !== index) {
            evict(index);
          }
        }, FADE_MS);
      }
    };

    // Today's declination is fixed, so the slider only ever visits one season band's bins — that band
    // IS the day's set to prefetch. Read at noon, where the band is unambiguous.
    const todayBand = (): number => {
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      const position = sun.getPosition(noon, CENTRE_LAT, CENTRE_LNG);
      const azimuth = ((position.azimuth % 360) + 360) % 360;
      return seasonBand(declinationOf(position.altitude, azimuth, CENTRE_LAT));
    };

    // Match the prefetch to the popover: while it is open, create every hidden layer of today's band so
    // their tiles are already in flight when the slider reaches them; on close, drop all but the visible.
    const syncPrefetch = (): void => {
      if (isPickerOpen()) {
        if (precached || bins.length === 0) {
          return;
        }
        precached = true;
        const band = todayBand();
        for (const bin of bins) {
          if (bin.season === band) {
            layerFor(bin.index);
          }
        }
      } else if (precached) {
        precached = false;
        for (const index of [...layers.keys()]) {
          if (index !== activeIndex) {
            evict(index);
          }
        }
      }
    };

    // Map the picked time to today's sun position and switch to its bin (or none, sun down). The
    // previous layer stays fully visible until the target has painted, then they crossfade — so a
    // not-yet-loaded target never flashes a blank gap.
    const apply = (): void => {
      syncPrefetch();
      if (bins.length === 0) {
        return;
      }
      const { elevation, azimuth } = currentSun();
      const bin =
        elevation > HORIZON_DEG ? pickBin(bins, elevation, azimuth) : null;
      const target = bin ? bin.index : -1;
      if (target === activeIndex) {
        return;
      }
      const previousIndex = activeIndex;
      activeIndex = target;
      if (target < 0) {
        retire(previousIndex);
        return;
      }
      const layer = layerFor(target);
      const crossfade = (): void => {
        if (cancelled || activeIndex !== target) {
          return; // a newer scrub already moved on
        }
        layer.setOpacity(1);
        retire(previousIndex);
      };
      if (ready.has(target)) {
        crossfade();
      } else {
        layer.once("load", crossfade);
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
