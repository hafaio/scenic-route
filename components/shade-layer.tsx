"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import * as SunCalc from "suncalc";
import { activeCity } from "../src/cities";
import {
  getResolvedDate,
  isPickerOpen,
  subscribeRouteTime,
} from "../src/route-time/store";
import { loadGraph } from "../src/routing/graph";
import { loadSheds, shedDay } from "../src/routing/sheds";
import { canopyTau } from "../src/shade/phenology";
import { declinationOf, hourAngleOf, seasonBand } from "../src/shade/sun";
import WorkerTileLayer, {
  prefetchShadeTiles,
  sendShedDecks,
} from "../src/tiles/layer";
import type { TileCoords } from "../src/tiles/protocol";
import { shedDecks } from "../src/tiles/shed-decks";
import { useCity } from "./city-context";

// The "Shade" overlay: shadow tiles for the sun's actual position, drawn as a smooth cool wash over all
// ground. The heavy work — casting ~1M building footprints with a physically-modelled penumbra
// (area-light sampling of the sun disk) — is baked by `tiler shade` into one WebP pyramid per SUN-POSITION
// bin: the sun's (azimuth, elevation) envelope over the whole year, gridded, at public/tiles/shade/<bin>/
// {z}/{x}/{y}.webp, with public/tiles/shade/buckets.json listing each bin's position. This layer maps the
// picked date and time to a sun position, shows the nearest bin, and CROSSFADES between bins as the sun
// moves — no per-frame redraw, no flicker. Below the horizon it shows nothing.
//
// The tree canopy is baked as a second pyramid, public/tiles/tree-shade/<bin>/, and belongs to this same
// overlay: crowns are shade. It is left as bare geometry, because what a crown actually stops depends on
// the date — so the two pyramids are composited per pixel in the worker, with the canopy's seasonal
// opacity (src/shade/phenology.ts) and the bin's solar intensity handed over as params.
//
// The pyramid stops at VECTOR_ZOOM. From there the worker GENERATES the shadows instead, sweeping the
// baked caster chunks (src/tiles/sweep.ts) at the tile's own resolution — so the shadow edges stay
// crisp however far the map goes in, and the seasonal canopy is one composite rather than a pyramid.
//
// The tiles are drawn by the tile worker (src/tiles/shade.ts) rather than fetched into <img>s, so that
// past the baked pyramid's finest level the magnification resamples across tile boundaries instead of
// leaving a seam at every one — and so the compositing happens once, at source resolution. Only the bin
// on screen has a layer — a second one exists just for the length of a crossfade. While the clock popover
// is open the worker is instead asked to decode the SOURCE tiles of the date's other bins into its cache, so
// scrubbing to one draws without a fetch; those are bitmaps in one cache with a cap, not a tile layer's
// worth of device-resolution canvases each.

const PANE_NAME = "shade-field";
const PANE_Z_INDEX = 275; // just under the commercial band (280), above the canopy fill

const MIN_ZOOM = 10;
const MAX_ZOOM = 20;
// The finest level `tiler shade` bakes. Keep in sync with SHADE_MAX_ZOOM in
// scripts/shade-schedule.ts.
const MAX_NATIVE_ZOOM = 14;
// Where the worker stops reading the pyramid and starts sweeping the casters itself. One past the
// deepest baked level, so neither path is redundant: every baked level is read, and nothing deeper
// is baked. Deeper would waste the pyramid's costliest levels; shallower would pull caster chunks
// over four times the ground per level, which no amount of clock scrubbing pays back.
const VECTOR_ZOOM = MAX_NATIVE_ZOOM + 1;

// Per city: a bin index is only a sun position alongside the latitude it was synthesised at, so two
// cities share neither the schedule nor the pyramid (scripts/shade-schedule.ts).
const scheduleUrl = (cityId: string): string =>
  `tiles/shade/${cityId}/buckets.json`;
const tileUrl = (cityId: string): string =>
  `tiles/shade/${cityId}/{bin}/{z}/{x}/{y}.webp`;
const treeTileUrl = (cityId: string): string =>
  `tiles/tree-shade/${cityId}/{bin}/{z}/{x}/{y}.webp`;
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

// One baked bin: its tile-pyramid index, its (declination, hourAngle) grid cell (what the client
// selects on), and the sun position (degrees) it stands for.
interface Bin {
  index: number;
  season: number;
  hourAngle: number;
  elevation: number;
  azimuth: number;
}

// One shared fetch of each city's bin schedule, so every ShadeLayer mount reuses it.
const schedules = new Map<string, Promise<Bin[]>>();

function loadSchedule(cityId: string): Promise<Bin[]> {
  const cached = schedules.get(cityId);
  if (cached) {
    return cached;
  }
  const promise: Promise<Bin[]> = fetch(scheduleUrl(cityId))
    .then((response) => (response.ok ? response.json() : []))
    .catch(() => []);
  schedules.set(cityId, promise);
  return promise;
}

// The sun's position over the city at the route-time store's resolved instant (now, or a picked time).
function currentSun(): { elevation: number; azimuth: number } {
  const position = sun.getPosition(
    getResolvedDate(),
    activeCity().center.lat,
    activeCity().center.lng,
  );
  return {
    elevation: position.altitude,
    azimuth: ((position.azimuth % 360) + 360) % 360,
  };
}

// How far today has run, the axis the bins step along. Defined below the horizon too, so the
// prefetch can still order the day's bins around a night-time pick.
function currentHourAngle(): number {
  const { elevation, azimuth } = currentSun();
  const declination = declinationOf(
    elevation,
    azimuth,
    activeCity().center.lat,
  );
  return hourAngleOf(elevation, azimuth, activeCity().center.lat, declination);
}

// The bin for a sun position: its season band, then the nearest hour-angle step within that band.
// Hour angle advances monotonically with the clock, so scrubbing time walks the bins in order — no
// nearest-centroid flip. Bins outside the sun's band are skipped; the fallback across all bins only
// bites if a band has no baked bin (it always does while the sun is up).
function pickBin(bins: Bin[], elevation: number, azimuth: number): Bin | null {
  const declination = declinationOf(
    elevation,
    azimuth,
    activeCity().center.lat,
  );
  const hourAngle = hourAngleOf(
    elevation,
    azimuth,
    activeCity().center.lat,
    declination,
  );
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
  const city = useCity();

  useEffect(() => {
    // A dedicated pane, so the dark-mode tile-pane invert leaves the slate tint true.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    let cancelled = false;
    let bins: Bin[] = [];
    let activeIndex = -1;
    // The sun the swept tiles are cast from, held still until the bin changes: within one bin every
    // tile has to sweep from the SAME position, or a tile drawn after a scrub would not line up with
    // the neighbours drawn before it.
    let sweepSun = currentSun();
    let drawnTau = canopyTau(getResolvedDate()); // the canopy transmittance the live tiles were drawn with
    // Only the visible bin, plus the outgoing one until its fade ends.
    const layers = new Map<number, WorkerTileLayer>();
    const ready = new Set<number>(); // bins whose tiles have finished painting at least once

    // The tile layer for a bin, created hidden. A CSS opacity transition on its container turns
    // setOpacity into a crossfade; the `load` event marks the bin ready, so a switch can wait for the
    // target to paint before revealing it.
    const layerFor = ({ index, elevation, azimuth }: Bin): WorkerTileLayer => {
      const existing = layers.get(index);
      if (existing) {
        return existing;
      }
      // Captured, not read from the shared `sweepSun` at draw time. A bin scrubbed away from and back
      // to within the fade window is the SAME layer, so a live read would let it paint later tiles
      // from a sun up to a bin's width — 72 minutes — from the one its existing tiles used.
      const castFrom = sweepSun;
      const layer = new WorkerTileLayer(
        () => ({
          kind: "shade",
          // The city this effect was built for, not whichever one is active when Leaflet next asks
          // for a tile. This factory is called synchronously on every tile request for as long as
          // the layer is attached, and a switch flips the global during the parent's render —
          // before this effect's cleanup detaches the layer. In that window a tile request would
          // fetch the new city's file for a layer whose bin index belongs to the old one.
          url: tileUrl(city.id),
          treeUrl: treeTileUrl(city.id),
          bin: index,
          maxNativeZoom: MAX_NATIVE_ZOOM,
          tau: canopyTau(getResolvedDate()),
          intensity: Math.max(0, Math.sin((elevation * Math.PI) / 180)),
          vectorZoom: VECTOR_ZOOM,
          binElevation: elevation,
          binAzimuth: azimuth,
          sunElevation: castFrom.elevation,
          sunAzimuth: castFrom.azimuth,
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

    // One date has one declination, so the slider only ever visits one season band's bins — the picked
    // DATE is what chooses which band that is. Read at noon, where the band is unambiguous.
    const pickedBand = (): number => {
      const noon = getResolvedDate();
      noon.setHours(12, 0, 0, 0);
      const position = sun.getPosition(
        noon,
        activeCity().center.lat,
        activeCity().center.lng,
      );
      const azimuth = ((position.azimuth % 360) + 360) % 360;
      return seasonBand(
        declinationOf(position.altitude, azimuth, activeCity().center.lat),
      );
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
    // the picked date's band, nearest the picked time first, so the slider lands on bins whose pixels
    // are already in hand. Nothing is drawn and no layer is created; on close the bitmaps just age out
    // of the cache.
    const syncPrefetch = (): void => {
      // Above the handoff the pyramid is not read at all — the sweep works from caster chunks, which
      // are sun-independent and already in the worker's cache — so there is nothing to warm.
      if (
        isPickerOpen() &&
        bins.length > 0 &&
        Math.round(map.getZoom()) < VECTOR_ZOOM
      ) {
        const band = pickedBand();
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
          url: tileUrl(city.id),
          treeUrl: treeTileUrl(city.id),
          bins: ordered.map(({ index }) => index),
          coords: viewSources(),
        });
      }
    };

    // The sidewalk sheds standing on the picked DATE, whose decks throw shadows in the swept half of
    // the layer. Their geometry hangs off the routing graph, which lives on this side, so it is built
    // here and handed over rather than loaded again in the worker — and only past the handoff, where
    // the tiles are swept at all and a 4 m deck is more than a pixel deep. The tiles already drawn
    // are redrawn once the decks land, since the first of them cannot wait on the graph's fetch.
    let deckDay = Number.NaN;
    const syncSheds = (): void => {
      const day = shedDay(getResolvedDate());
      if (Math.round(map.getZoom()) < VECTOR_ZOOM || day === deckDay) {
        return;
      }
      deckDay = day;
      Promise.all([loadGraph(city.id), loadSheds()]).then(
        ([graph, history]) => {
          if (!cancelled && deckDay === day) {
            sendShedDecks(shedDecks(graph, history, day));
            for (const layer of layers.values()) {
              layer.redraw();
            }
          }
        },
        () => {},
      );
    };

    // Map the picked time to today's sun position and switch to its bin (or none, sun down). The
    // previous layer stays fully visible until the target has painted, then they crossfade — so a
    // not-yet-loaded target never flashes a blank gap.
    const apply = (): void => {
      syncPrefetch();
      syncSheds();
      if (bins.length === 0) {
        return;
      }
      const { elevation, azimuth } = currentSun();
      const bin =
        elevation > HORIZON_DEG ? pickBin(bins, elevation, azimuth) : null;
      const target = bin ? bin.index : -1;
      const tau = canopyTau(getResolvedDate());
      if (target === activeIndex) {
        // Tau is composited into the drawn pixels, and a band is wide enough that a date can cross
        // half of leaf-fall — or six months, to the same sun — without moving the bin.
        if (tau !== drawnTau) {
          drawnTau = tau;
          layers.get(target)?.redraw();
        }
        return;
      }
      activeIndex = target;
      drawnTau = tau;
      sweepSun = { elevation, azimuth };
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

    loadSchedule(city.id).then((loaded) => {
      if (!cancelled) {
        bins = loaded;
        apply();
      }
    });
    const unsubscribe = subscribeRouteTime(apply);
    // A pan or zoom moves the prefetch onto different source tiles, and a zoom past the handoff is
    // what first asks for the sheds.
    const moved = (): void => {
      syncPrefetch();
      syncSheds();
    };
    map.on("moveend", moved);

    return () => {
      cancelled = true;
      unsubscribe();
      map.off("moveend", moved);
      for (const layer of layers.values()) {
        layer.remove();
      }
    };
  }, [map, city.id]);

  return null;
}
