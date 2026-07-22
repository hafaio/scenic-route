// Which genera the genus overlay is currently showing — a module singleton shared by the legend
// (which toggles a genus when its swatch is clicked) and the two map halves that draw the trees
// (the raster tile layer and the live-dot layer), without threading React state through the map.
// Every genus is on by default, so the overlay opens as the "standard" all-genera view; clicking a
// legend row hides or shows that one genus. Framework-agnostic (no React), the same idiom the
// route-time store uses, so the imperative Leaflet layers can subscribe to it directly.

import { GENUS_COUNT } from "./genus";

// Every genus id, the default "show everything" selection. A stable reference, so re-selecting all
// hands useSyncExternalStore the same snapshot it started with.
const ALL_GENERA: ReadonlySet<number> = new Set(
  Array.from({ length: GENUS_COUNT }, (_, id) => id),
);

// The enabled ids as an immutable snapshot: a toggle swaps in a NEW Set rather than mutating this
// one, so useSyncExternalStore sees a fresh reference exactly when the selection changes.
let enabled: ReadonlySet<number> = ALL_GENERA;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// The current selection. Stable between toggles, so it doubles as the useSyncExternalStore snapshot.
export function getEnabledGenera(): ReadonlySet<number> {
  return enabled;
}

export function toggleGenus(id: number): void {
  const next = new Set(enabled);
  if (!next.delete(id)) {
    next.add(id);
  }
  enabled = next;
  notify();
}

// Show every genus at once or hide them all — the legend header's single button, which turns
// everything off while any genus is on and back on once none are.
export function setAllGenera(on: boolean): void {
  enabled = on ? ALL_GENERA : new Set();
  notify();
}

export function subscribeGenusFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
