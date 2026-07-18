"use client";

import { genusCss, OTHER_GENUS_ID } from "../src/tree-cover/genus";
import manifest from "../src/tree-cover/manifest.json";

// The genus overlay's key: the 12 ranked genera (in id order) plus the "Other" bucket, each a
// true-colour swatch beside its common name. Swatches use the same palette the tiles draw with
// and sit in a non-inverted pane, so they read as true colour in both light and dark mode.
export default function TreeLegend() {
  const genus = manifest.cities[0]?.field.genus;
  if (!genus) {
    return null; // older manifest without the genus source
  }

  const rows = genus.table.map((entry, id) => ({ id, common: entry.common }));
  rows.push({ id: OTHER_GENUS_ID, common: "Other" });

  return (
    <div className="rounded-2xl bg-white/85 px-3 py-2.5 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Tree genus
      </p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2 text-xs">
            <span
              className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/10 dark:ring-white/10"
              style={{ backgroundColor: genusCss(row.id) }}
              aria-hidden="true"
            />
            <span className="truncate text-slate-700 dark:text-slate-200">
              {row.common}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
