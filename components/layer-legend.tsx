"use client";

import type { City } from "../src/cities";
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
  overlaySwatch,
} from "../src/overlays/registry";
import { useMapTheme } from "./use-map-theme";

// The key for a map carrying overlays: which added colour is which layer. One colour per row, taken
// from what that layer actually paints with, so the key cannot come to disagree with the map under
// it. Deliberately inert — the layers menu is where a layer is turned off, and a key that also
// toggled would be a second, half-hidden copy of it.
//
// It says nothing about the genus overlay, which goes solo and has a key of its own.
export default function LayerLegend({
  active,
  city,
}: {
  active: ReadonlySet<OverlayId>;
  city: City;
}) {
  const theme = useMapTheme();
  const rows = OVERLAYS.filter((overlay) => active.has(overlay.id)).flatMap(
    (overlay) => {
      const swatch = overlaySwatch(overlay, theme);
      return swatch
        ? [{ id: overlay.id, label: overlayLabel(overlay, city), swatch }]
        : [];
    },
  );
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="rounded-2xl bg-white/85 px-3 py-2.5 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Layers
      </p>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center gap-2 px-1 py-0.5 text-xs"
          >
            <span
              className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/10 dark:ring-white/10"
              style={{ backgroundColor: row.swatch }}
              aria-hidden="true"
            />
            <span className="truncate text-slate-700 dark:text-slate-200">
              {row.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
