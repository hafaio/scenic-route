"use client";

import { useSyncExternalStore } from "react";
import { genusCss, OTHER_GENUS_ID } from "../src/tree-cover/genus";
import {
  getEnabledGenera,
  setAllGenera,
  subscribeGenusFilter,
  toggleGenus,
} from "../src/tree-cover/genus-filter";
import manifest from "../src/tree-cover/manifest.json";

// The genus overlay's key: the 12 ranked genera (in id order) plus the "Other" bucket, each a
// true-colour swatch beside its common name. Swatches use the same palette the tiles draw with
// and sit in a non-inverted pane, so they read as true colour in both light and dark mode. Each
// row is a toggle: clicking it hides or shows that genus across both halves of the overlay (the
// raster tiles and the live dots), which read the same selection store.
export default function TreeLegend() {
  const genus = manifest.cities[0]?.field.genus;
  const enabled = useSyncExternalStore(
    subscribeGenusFilter,
    getEnabledGenera,
    getEnabledGenera,
  );
  if (!genus) {
    return null; // older manifest without the genus source
  }

  const rows = genus.table.map((entry, id) => ({ id, common: entry.common }));
  rows.push({ id: OTHER_GENUS_ID, common: "Other" });

  // One button flips the whole selection: with any genus on it clears them, with none on it
  // restores the full set — a fast way back from a single-genus view to the all-genera texture.
  const anyOn = enabled.size > 0;

  return (
    <div className="rounded-2xl bg-white/85 px-3 py-2.5 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Tree genus
        </p>
        <button
          type="button"
          onClick={() => setAllGenera(!anyOn)}
          className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
        >
          {anyOn ? "None" : "All"}
        </button>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {rows.map((row) => {
          const on = enabled.has(row.id);
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => toggleGenus(row.id)}
                aria-pressed={on}
                className={`flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10 ${
                  on ? "" : "opacity-40"
                }`}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/10 dark:ring-white/10"
                  style={{ backgroundColor: genusCss(row.id) }}
                  aria-hidden="true"
                />
                <span className="truncate text-slate-700 dark:text-slate-200">
                  {row.common}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
