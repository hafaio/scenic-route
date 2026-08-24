"use client";

import { OVERLAYS, type OverlayId } from "../overlays/registry";
import { FACTORS, type FactorKey } from "../routing/factors";

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
  // One weight per scenic factor — the same value the route panel's slider and the settings page's
  // slider both move. There is deliberately no default beside it: a "default" the reader could set
  // without it taking effect would be a second thing to keep in step with the first. A factor
  // missing here has never been moved and takes the built-in default.
  weights: Partial<Record<FactorKey, number>>;
  allowFerries: boolean;
  allowSheds: boolean;
  // Factors the reader has taken out of the route panel: no slider and no summary chip. Their
  // weights still price the route, so the panel counts the non-zero ones and says so.
  hiddenFactors: readonly FactorKey[];
}

export const DEFAULT_SETTINGS: Settings = {
  layerOrder: [],
  hiddenLayers: [],
  weights: {},
  allowFerries: true,
  allowSheds: true,
  hiddenFactors: [],
};

const REGISTRY_ORDER: readonly OverlayId[] = OVERLAYS.map(({ id }) => id);

// Where each weight lived before this document existed, and where the two gates did. Folded in on
// the first read that finds no weights in the document, then left alone rather than deleted: a
// reader who goes back to a build that only knows these keys still finds their settings in them.
const LEGACY_WEIGHT_KEYS: Record<FactorKey, string> = {
  tree: "scenic-route:tree-weight",
  ferry: "scenic-route:ferry-weight",
  landmark: "scenic-route:landmark-weight",
  art: "scenic-route:art-weight",
  highway: "scenic-route:highway-weight",
  hill: "scenic-route:hill-weight",
  commercial: "scenic-route:commercial-weight",
  industrial: "scenic-route:industrial-weight",
  historic: "scenic-route:historic-weight",
  shade: "scenic-route:shade-weight",
  shelter: "scenic-route:shelter-weight",
};
const LEGACY_FERRY_GATE = "scenic-route:allow-ferries";
const LEGACY_SHED_GATE = "scenic-route:allow-sheds";

function isOverlayIds(value: unknown): value is OverlayId[] {
  const known = new Set<string>(REGISTRY_ORDER);
  return Array.isArray(value) && value.every((id) => known.has(id as string));
}

const FACTOR_KEYS = new Set<string>(FACTORS.map(({ key }) => key));

function isFactorKeys(value: unknown): value is FactorKey[] {
  return Array.isArray(value) && value.every((key) => FACTOR_KEYS.has(key));
}

function isWeights(
  value: unknown,
): value is Partial<Record<FactorKey, number>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, weight]) => FACTOR_KEYS.has(key) && Number.isFinite(weight),
    )
  );
}

interface LegacyPrefs {
  weights: Partial<Record<FactorKey, number>>;
  allowFerries: boolean;
  allowSheds: boolean;
  found: boolean; // whether any of the old keys was there at all, so the fold is worth writing back
}

function legacyPrefs(legacy: (key: string) => string | null): LegacyPrefs {
  const weights: Partial<Record<FactorKey, number>> = {};
  for (const [key, storageKey] of Object.entries(LEGACY_WEIGHT_KEYS)) {
    const stored = legacy(storageKey);
    const parsed = stored === null ? Number.NaN : Number.parseFloat(stored);
    if (Number.isFinite(parsed)) {
      weights[key as FactorKey] = parsed;
    }
  }
  const ferryGate = legacy(LEGACY_FERRY_GATE);
  const shedGate = legacy(LEGACY_SHED_GATE);
  return {
    weights,
    allowFerries: ferryGate !== "false",
    allowSheds: shedGate !== "false",
    found:
      Object.keys(weights).length > 0 ||
      ferryGate !== null ||
      shedGate !== null,
  };
}

// The settings a stored document and the pre-document keys add up to, and whether the document is
// now behind what was read. Separate from `read` so the migration can be exercised without a
// browser: `legacy` is `localStorage.getItem`.
export function settingsFrom(
  stored: Partial<Settings>,
  legacy: (key: string) => string | null,
): { settings: Settings; migrated: boolean } {
  const { layerOrder, hiddenLayers, weights, hiddenFactors } = stored;
  // No weights in the document is what says it predates route preferences, and only then do the old
  // keys get a say — once the document carries weights it is the only thing that does.
  const folded = isWeights(weights) ? null : legacyPrefs(legacy);
  return {
    settings: {
      layerOrder: isOverlayIds(layerOrder) ? layerOrder : [],
      hiddenLayers: isOverlayIds(hiddenLayers) ? hiddenLayers : [],
      weights: folded ? folded.weights : (weights ?? {}),
      allowFerries: folded
        ? folded.allowFerries
        : stored.allowFerries !== false,
      allowSheds: folded ? folded.allowSheds : stored.allowSheds !== false,
      hiddenFactors: isFactorKeys(hiddenFactors) ? hiddenFactors : [],
    },
    migrated: folded?.found ?? false,
  };
}

// Anything unreadable reads as the defaults rather than throwing: a preference is not worth a blank
// map, and a document written by a newer version of the app has to degrade rather than break.
function read(): Settings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }
  let stored: Partial<Settings> = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "");
    stored = (parsed ?? {}) as Partial<Settings>;
  } catch {
    stored = {};
  }
  const { settings, migrated } = settingsFrom(stored, (key) =>
    window.localStorage.getItem(key),
  );
  if (migrated) {
    write(settings);
  }
  return settings;
}

function write(next: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store costs the preference its persistence, not the session.
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
  write(current);
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
  { layerOrder, hiddenLayers }: Pick<Settings, "layerOrder" | "hiddenLayers">,
): OverlayId[] {
  const hidden = new Set(hiddenLayers);
  const wanted = new Set(offered);
  return mergeLayerOrder(layerOrder).filter(
    (id) => wanted.has(id) && !hidden.has(id),
  );
}
