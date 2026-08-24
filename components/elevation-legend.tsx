"use client";

import { useEffect, useState } from "react";
import { PALETTES, type ThemeName } from "../src/theme/palette";
import { useCity } from "./city-context";
import { useMapTheme } from "./use-map-theme";

// The key for the elevation overlay. The tint is stretched over each city's own height range, so a
// reader looking at the map alone can see which streets are higher and not by how much — the range
// travels with the pyramid in range.json for exactly that reason. The colours do not: the tiles
// carry height rather than a tint, and the ramp they are read through is the palette's.

interface Range {
  lowMeters: number;
  highMeters: number;
}

function bar(theme: ThemeName): string {
  const ramp = PALETTES[theme].elevation.stops;
  return ramp
    .map(
      ({ red, green, blue }, index) =>
        `rgb(${red} ${green} ${blue}) ${(100 * index) / (ramp.length - 1)}%`,
    )
    .join(", ");
}

const BARS: Record<ThemeName, string> = {
  light: bar("light"),
  dark: bar("dark"),
};

const ranges = new Map<string, Promise<Range | null>>();

function loadRange(cityId: string): Promise<Range | null> {
  const cached = ranges.get(cityId);
  if (cached) {
    return cached;
  }
  const promise: Promise<Range | null> = fetch(
    `tiles/elevation/${cityId}/range.json`,
  )
    .then((response) =>
      response.ok ? (response.json() as Promise<Range>) : null,
    )
    .catch(() => null);
  ranges.set(cityId, promise);
  return promise;
}

const feet = (meters: number): number => Math.round(meters / 0.3048);

export default function ElevationLegend(): React.ReactElement | null {
  const active = useCity();
  const theme = useMapTheme();
  const [range, setRange] = useState<Range | null>(null);

  useEffect(() => {
    let live = true;
    setRange(null);
    loadRange(active.id).then((loaded) => {
      if (live) {
        setRange(loaded);
      }
    });
    return () => {
      live = false;
    };
  }, [active.id]);

  if (!range) {
    return null;
  }
  return (
    <div className="rounded-2xl bg-white/90 px-3 py-2 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/90 dark:ring-white/10">
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">
        Elevation
      </div>
      <div
        className="h-2 w-40 rounded-full"
        style={{ background: `linear-gradient(to right, ${BARS[theme]})` }}
      />
      <div className="mt-1 flex justify-between font-medium text-[11px] text-slate-600 tabular-nums dark:text-slate-300">
        <span>{feet(range.lowMeters)} ft</span>
        <span>{feet(range.highMeters)} ft</span>
      </div>
    </div>
  );
}
