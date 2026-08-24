"use client";

import { OVERLAYS, type OverlayId } from "../overlays/registry";

// The reader's own preferences, as one versioned document rather than the scatter of keys the app
// grew — every slider and toggle wrote its own. One document is what makes the settings page
// possible, and it is also the unit a future sync would send.
//
// Deliberately NOT in the URL: the hash carries a VIEW, which is a thing you share, and a preference
// is a thing about you. A shared link must not re-order the recipient's menu.

const KEY = "scenic-route:settings.v1";

export interface Settings {
  // The overlay ids in the order the layers menu lists them. Empty means "however the registry lists
  // them", which is what a reader who has never reordered anything gets.
  layerOrder: readonly OverlayId[];
  // Overlays the reader has taken out of the menu. They are not offered and not drawn; a city that
  // never had one is unaffected either way.
  hiddenLayers: readonly OverlayId[];
}

export const DEFAULT_SETTINGS: Settings = { layerOrder: [], hiddenLayers: [] };

const REGISTRY_ORDER: readonly OverlayId[] = OVERLAYS.map(({ id }) => id);

function isOverlayIds(value: unknown): value is OverlayId[] {
  const known = new Set<string>(REGISTRY_ORDER);
  return Array.isArray(value) && value.every((id) => known.has(id as string));
}

// Anything unreadable reads as the defaults rather than throwing: a preference is not worth a blank
// map, and a document written by a newer version of the app has to degrade rather than break.
function read(): Settings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "");
    const { layerOrder, hiddenLayers } = (stored ?? {}) as Partial<Settings>;
    return {
      layerOrder: isOverlayIds(layerOrder) ? layerOrder : [],
      hiddenLayers: isOverlayIds(hiddenLayers) ? hiddenLayers : [],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current: Settings = read();
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) {
    listener();
  }
}

// Another tab of the same app is the same reader, so its edits are this one's too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) {
      current = read();
      announce();
    }
  });
}

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // A full or blocked store costs the preference its persistence, not the session.
  }
  announce();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The stored order reconciled with the registry, which is the one that changes under it. Ids the
// registry has dropped go; ids it has gained are inserted where IT puts them relative to the
// neighbours that survived, so a new overlay lands somewhere sensible rather than at the end of a
// list the reader arranged.
export function mergeLayerOrder(
  stored: readonly OverlayId[],
  registry: readonly OverlayId[] = REGISTRY_ORDER,
): OverlayId[] {
  const known = new Set(registry);
  const merged = stored.filter((id) => known.has(id));
  const placed = new Set(merged);
  let anchor = -1;
  for (const id of registry) {
    if (placed.has(id)) {
      anchor = merged.indexOf(id);
    } else {
      anchor += 1;
      merged.splice(anchor, 0, id);
      placed.add(id);
    }
  }
  return merged;
}

// The overlays a city offers, in the reader's order and without the ones they have hidden.
export function orderedOverlays(
  offered: readonly OverlayId[],
  { layerOrder, hiddenLayers }: Settings,
): OverlayId[] {
  const hidden = new Set(hiddenLayers);
  const wanted = new Set(offered);
  return mergeLayerOrder(layerOrder).filter(
    (id) => wanted.has(id) && !hidden.has(id),
  );
}
