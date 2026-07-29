"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import * as SunCalc from "suncalc";
import {
  getResolvedDate,
  isPickerOpen,
  subscribeRouteTime,
} from "../src/route-time/store";
import { canopyTau } from "../src/shade/phenology";
import { declinationOf, hourAngleOf, seasonBand } from "../src/shade/sun";
import WorkerTileLayer, { prefetchShadeTiles } from "../src/tiles/layer";
import type { TileCoords } from "../src/tiles/protocol";
import manifest from "../src/tree-cover/manifest.json";

// The "Shade" overlay: shadow tiles for the sun's actual position, drawn as a smooth cool wash over all
// ground. The heavy work — casting ~1M building footprints with a physically-modelled penumbra
// (area-light sampling of the sun disk) — is baked by `tiler shade` into one WebP pyramid per SUN-POSITION
// bin: the sun's (azimuth, elevation) envelope over the whole year, gridded, at public/tiles/shade/<bin>/
// {z}/{x}/{y}.webp, with public/tiles/shade/buckets.json listing each bin's position. This layer maps the
// picked time on TODAY'S date to a sun position, shows the nearest bin, and CROSSFADES between bins as the
// sun moves — no per-frame redraw, no flicker. Below the horizon it shows nothing.
//
// The tree canopy is baked as a second pyramid, public/tiles/tree-shade/<bin>/, and belongs to this same
// overlay: crowns are shade. It is left as bare geometry, because what a crown actually stops depends on
// the date — so the two pyramids are composited per pixel in the worker, with the canopy's seasonal
// opacity (src/shade/phenology.ts) and the bin's solar intensity handed over as params.
//
// The tiles are drawn by the tile worker (src/tiles/shade.ts) rather than fetched into <img>s, so that
// past the baked pyramid's finest level the magnification resamples across tile boundaries instead of
// leaving a seam at every one — and so the compositing happens once, at source resolution. Only the bin
// on screen has a layer — a second one exists just for the length of a crossfade. While the clock popover
// is open the worker is instead asked to decode the SOURCE tiles of today's other bins into its cache, so
// scrubbing to one draws without a fetch; those are bitmaps in one cache with a cap, not a tile layer's
// worth of device-resolution canvases each.

const PANE_NAME = "shade-field";
const PANE_Z_INDEX = 275; // just under the commercial band (280), above the canopy fill

const MIN_ZOOM = 10;
const MAX_ZOOM = 20;
// The finest level `tiler shade` bakes; above it the worker magnifies from this level. Keep in sync
// with SHADE_MAX_ZOOM in scripts/shade-schedule.ts.
const MAX_NATIVE_ZOOM = 15;

const SCHEDULE_URL = "tiles/shade/buckets.json";
const TILE_URL = "tiles/shade/{bin}/{z}/{x}/{y}.webp";
const TREE_TILE_URL = "tiles/tree-shade/{bin}/{z}/{x}/{y}.webp";
const TILE_SIZE = 256;
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

// How far today has run, the axis the bins step along. Defined below the horizon too, so the
// prefetch can still order the day's bins around a night-time pick.
function currentHourAngle(): number {
  const { elevation, azimuth } = currentSun();
  const declination = declinationOf(elevation, azimuth, CENTRE_LAT);
  return hourAngleOf(elevation, azimuth, CENTRE_LAT, declination);
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
    // Only the visible bin, plus the outgoing one until its fade ends.
    const layers = new Map<number, WorkerTileLayer>();
    const ready = new Set<number>(); // bins whose tiles have finished painting at least once

    // The tile layer for a bin, created hidden. A CSS opacity transition on its container turns
    // setOpacity into a crossfade; the `load` event marks the bin ready, so a switch can wait for the
    // target to paint before revealing it.
    const layerFor = ({ index, elevation }: Bin): WorkerTileLayer => {
      const existing = layers.get(index);
      if (existing) {
        return existing;
      }
      const layer = new WorkerTileLayer(
        () => ({
          kind: "shade",
          url: TILE_URL,
          treeUrl: TREE_TILE_URL,
          bin: index,
          maxNativeZoom: MAX_NATIVE_ZOOM,
          tau: canopyTau(getResolvedDate()),
          intensity: Math.max(0, Math.sin((elevation * Math.PI) / 180)),
        }),
        {
          pane: PANE_NAME,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          // Deliberately no maxNativeZoom: it would clamp the requested coordinates to the baked
          // levels, leaving Leaflet to stretch the tile again and the worker nothing to magnify.
          opacity: 0,
          keepBuffer: 4,
        },
      );
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

    // Fade a bin out, then drop it — unless it became active again mid-fade.
    const retire = (index: number): void => {
      const layer = layers.get(index);
      if (index < 0 || !layer) {
        return;
      }
      layer.setOpacity(0);
      window.setTimeout(() => {
        if (!cancelled && activeIndex !== index) {
          evict(index);
        }
      }, FADE_MS);
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

    // The baked source tiles the view is reading right now, plus — where the tiles are magnified — the
    // ring of neighbours a draw samples for its margin.
    const viewSources = (): TileCoords[] => {
      const view = Math.round(map.getZoom());
      const zoom = Math.min(view, MAX_NATIVE_ZOOM);
      const ring = view > MAX_NATIVE_ZOOM ? 1 : 0;
      const bounds = map.getBounds();
      const topLeft = map
        .project(bounds.getNorthWest(), zoom)
        .divideBy(TILE_SIZE)
        .floor();
      const bottomRight = map
        .project(bounds.getSouthEast(), zoom)
        .divideBy(TILE_SIZE)
        .floor();
      const last = 2 ** zoom - 1;
      const coords: TileCoords[] = [];
      for (
        let y = Math.max(0, topLeft.y - ring);
        y <= Math.min(last, bottomRight.y + ring);
        y++
      ) {
        for (
          let x = Math.max(0, topLeft.x - ring);
          x <= Math.min(last, bottomRight.x + ring);
          x++
        ) {
          coords.push({ x, y, z: zoom });
        }
      }
      return coords;
    };

    // Match the prefetch to the popover: while it is open, have the worker decode the source tiles of
    // today's band, nearest the picked time first, so the slider lands on bins whose pixels are already
    // in hand. Nothing is drawn and no layer is created; on close the bitmaps just age out of the cache.
    const syncPrefetch = (): void => {
      if (isPickerOpen() && bins.length > 0) {
        const band = todayBand();
        const hourAngle = currentHourAngle();
        const ordered = bins
          .filter((bin) => bin.season === band)
          .sort(
            (left, right) =>
              Math.abs(left.hourAngle - hourAngle) -
              Math.abs(right.hourAngle - hourAngle),
          );
        prefetchShadeTiles({
          type: "shade-prefetch",
          url: TILE_URL,
          treeUrl: TREE_TILE_URL,
          bins: ordered.map(({ index }) => index),
          coords: viewSources(),
        });
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
      activeIndex = target;
      // Every bin but the target, not just the one this scrub left: a scrub that passes through a bin
      // faster than its tiles load strands it, because its own crossfade is still waiting on `load`
      // and the next one only ever knew about ITS predecessor. A stranded bin sat at full opacity
      // under the live one for the rest of the session.
      const retireOthers = (): void => {
        for (const index of [...layers.keys()]) {
          if (index !== activeIndex) {
            retire(index);
          }
        }
      };
      if (!bin) {
        retireOthers();
        return;
      }
      const layer = layerFor(bin);
      const crossfade = (): void => {
        if (cancelled || activeIndex !== target) {
          return; // a newer scrub already moved on
        }
        layer.setOpacity(1);
        retireOthers();
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
    // A pan or zoom moves the prefetch onto different source tiles.
    map.on("moveend", syncPrefetch);

    return () => {
      cancelled = true;
      unsubscribe();
      map.off("moveend", syncPrefetch);
      for (const layer of layers.values()) {
        layer.remove();
      }
    };
  }, [map]);

  return null;
}
