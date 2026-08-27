"use client";

import { OVERLAYS, type OverlayId } from "../overlays/registry";
import {
  FACTORS,
  type FactorKey,
  GATES,
  type GateKey,
} from "../routing/factors";
import { COVERAGE, DEFAULT_COVERAGE } from "./offline";

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
  allowCrossings: boolean;
  // The scenic factors in the order the route panel lists them. Empty is the table's own order, in
  // src/routing/factors.tsx.
  factorOrder: readonly FactorKey[];
  // Factors the reader has taken out of the route panel: no slider and no summary chip. Their
  // weights still price the route, so the panel counts the non-zero ones and says so.
  hiddenFactors: readonly FactorKey[];
  // The gates taken out of the panel's header. Same bargain as a hidden factor: the gate keeps
  // gating, so a hidden one that is CLOSED is counted alongside them.
  hiddenGates: readonly GateKey[];
  // How much of the map to keep for offline use, as one of the coverage options in ./offline.ts. The
  // service worker is the one that enforces it and holds its own copy, since it runs when no page
  // does; this is the reader's side of that, and components/service-worker.tsx carries it across.
  coverage: string;
  // When each field was last changed on some device, keyed by path — the field's own name, or
  // `weights.<factor>` for one slider. Not a preference itself: it is what lets two signed-in
  // devices merge rather than one of them winning wholesale. See ./sync.ts.
  updatedAt: Readonly<Record<string, number>>;
}

export const DEFAULT_SETTINGS: Settings = {
  layerOrder: [],
  hiddenLayers: [],
  weights: {},
  allowFerries: true,
  allowSheds: true,
  allowCrossings: false,
  factorOrder: [],
  hiddenFactors: [],
  hiddenGates: [],
  coverage: DEFAULT_COVERAGE,
  updatedAt: {},
};

const REGISTRY_ORDER: readonly OverlayId[] = OVERLAYS.map(({ id }) => id);

// Where each weight lived before this document existed, and where the two gates did. Folded in on
// the first read that finds no weights in the document, then left alone rather than deleted —
// removing them would be a destructive write on behalf of a reader who has not asked for anything,
// and they cost a few dozen bytes. They are a snapshot of migration day, not a live mirror: nothing
// writes them any more.
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

// Every list and map read back out of the document is filtered PER ENTRY rather than accepted or
// rejected whole. An id this build does not know is the ordinary consequence of the reader having
// arranged their settings on a newer one — a release adds an overlay, they open a tab still running
// the old build — and throwing the whole field away over one of them would undo everything they set.
const OVERLAY_IDS = new Set<string>(REGISTRY_ORDER);
const FACTOR_KEYS = new Set<string>(FACTORS.map(({ key }) => key));

function overlayIds(value: unknown): OverlayId[] {
  return Array.isArray(value)
    ? (value.filter(
        (id) => typeof id === "string" && OVERLAY_IDS.has(id),
      ) as OverlayId[])
    : [];
}

function factorKeys(value: unknown): FactorKey[] {
  return Array.isArray(value)
    ? (value.filter(
        (key) => typeof key === "string" && FACTOR_KEYS.has(key),
      ) as FactorKey[])
    : [];
}

const GATE_KEYS = new Set<string>(GATES.map(({ key }) => key));

// What the crossings gate was called before the flag was inverted. A reader who hid it back then
// stored that spelling, and filtering against the current names alone would drop it — putting a gate
// they had deliberately hidden back in the panel, on upgrade, with nothing said. The weight beside it
// already gets this treatment; the list of hidden ones needs it for the same rename.
const RENAMED_GATES: Readonly<Record<string, GateKey>> = {
  fewerCrossings: "allowCrossings",
};

function gateKeys(value: unknown): GateKey[] {
  if (!Array.isArray(value)) {
    return [];
  } else {
    const keys: GateKey[] = [];
    for (const key of value) {
      if (typeof key !== "string") {
        continue;
      }
      const current = RENAMED_GATES[key];
      if (current !== undefined && !keys.includes(current)) {
        keys.push(current);
      } else if (GATE_KEYS.has(key) && !keys.includes(key as GateKey)) {
        keys.push(key as GateKey);
      }
    }
    return keys;
  }
}

// What this device last chose about crossings, under either spelling. `fewerCrossings: false` was
// how "crossings are free" was written before the flag was inverted.
function allowCrossingsIn(stored: Partial<Settings>): boolean {
  const legacy = (stored as { fewerCrossings?: unknown }).fewerCrossings;
  if (stored.allowCrossings === undefined && typeof legacy === "boolean") {
    return !legacy;
  } else {
    return stored.allowCrossings === true;
  }
}

function stamps(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  } else {
    return Object.fromEntries(
      Object.entries(value).filter(([, at]) => Number.isFinite(at)),
    );
  }
}

function factorWeights(value: unknown): Partial<Record<FactorKey, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  } else {
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, weight]) => FACTOR_KEYS.has(key) && Number.isFinite(weight),
      ),
    );
  }
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
  // The ABSENCE of a weights field is what says the document predates route preferences, and only
  // then do the old keys get a say. Not "the field failed to validate": a document that carries
  // weights this build cannot read is a NEWER one, and folding a snapshot of the pre-document keys
  // over it — then writing that back — would replace what the reader set with what they set before
  // any of this existed.
  const folded = weights === undefined ? legacyPrefs(legacy) : null;
  return {
    settings: {
      layerOrder: overlayIds(layerOrder),
      hiddenLayers: overlayIds(hiddenLayers),
      weights: folded ? folded.weights : factorWeights(weights),
      allowFerries: folded
        ? folded.allowFerries
        : stored.allowFerries !== false,
      allowSheds: folded ? folded.allowSheds : stored.allowSheds !== false,
      // Absent reads as OFF, unlike the two gates above it — see DEFAULT_WEIGHTS. A document saved
      // before the flag was inverted spells it `fewerCrossings` and means the opposite, so it is
      // read once and turned round rather than being silently dropped.
      allowCrossings: allowCrossingsIn(stored),
      factorOrder: factorKeys(stored.factorOrder),
      hiddenFactors: factorKeys(hiddenFactors),
      hiddenGates: gateKeys(stored.hiddenGates),
      coverage: COVERAGE.some(({ id }) => id === stored.coverage)
        ? (stored.coverage as string)
        : DEFAULT_COVERAGE,
      updatedAt: stamps(stored.updatedAt),
    },
    migrated: folded?.found ?? false,
  };
}

// The store, or null where there is not one. Tested for by REACHING for it rather than by asking
// whether a `window` exists: the server render has no window, a private window can have one whose
// storage throws on access, and a test runner can define a window with no `localStorage` on it at
// all — which a `typeof window` guard sails straight past, throwing at module load.
function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// What was stored, or an empty document. Absent and unreadable give the same answer deliberately:
// either way there is nothing to go on, which is exactly the state that makes the pre-document keys
// worth reading. Letting `JSON.parse(null)` throw instead would skip the migration for every reader
// it exists for.
function document(raw: string | null): Partial<Settings> {
  try {
    return raw === null ? {} : ((JSON.parse(raw) ?? {}) as Partial<Settings>);
  } catch {
    return {};
  }
}

// A document from somewhere other than this device's localStorage — Firestore — validated by exactly
// the same rules. `legacy` answers nothing: the pre-document keys are this device's history and have
// no business in what another one sent.
export function settingsFromDocument(stored: Partial<Settings>): Settings {
  return settingsFrom(stored, () => null).settings;
}

// Anything unreadable reads as the defaults rather than throwing: a preference is not worth a blank
// map, and a document written by a newer version of the app has to degrade rather than break.
function read(): Settings {
  const held = store();
  if (held === null) {
    return DEFAULT_SETTINGS;
  }
  // The whole read is guarded, not just the parse: reaching `localStorage` can succeed on a browser
  // where storage is blocked and then throw on the first `getItem`, and the pre-document keys are
  // read one call at a time well past where a parse guard would reach.
  try {
    const { settings, migrated } = settingsFrom(
      document(held.getItem(KEY)),
      (key) => held.getItem(key),
    );
    if (migrated) {
      write(settings);
    }
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function write(next: Settings): void {
  try {
    store()?.setItem(KEY, JSON.stringify(next));
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
if (typeof addEventListener === "function") {
  addEventListener("storage", (event) => {
    if (event.key === KEY) {
      current = read();
      announce();
    }
  });
}

export function settings(): Settings {
  return current;
}

// Every change is stamped, so a device that has been offline can be merged rather than overwritten.
// Weights are stamped per factor: two devices tuning two different sliders is the ordinary case, and
// stamping the whole map would make one of them lose the other's.
function stamped(patch: Partial<Settings>, at: number): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (field === "updatedAt") {
    } else if (field === "weights") {
      for (const [key, weight] of Object.entries(value as object)) {
        if (weight !== current.weights[key as FactorKey]) {
          marks[`weights.${key}`] = at;
        }
      }
    } else {
      marks[field] = at;
    }
  }
  return marks;
}

export function updateSettings(
  patch: Partial<Settings>,
  at = Date.now(),
): void {
  current = {
    ...current,
    ...patch,
    updatedAt: { ...current.updatedAt, ...stamped(patch, at) },
  };
  write(current);
  announce();
}

// A merged document arriving from another device. Already stamped, so it replaces rather than being
// stamped again — restamping would make every sign-in look like a fresh edit to every other device.
export function adoptSettings(next: Settings): void {
  current = next;
  write(current);
  announce();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A stored order reconciled with the built-in one, which is what changes under it. Ids the build has
// dropped go; ids it has gained are inserted where IT puts them relative to the neighbours that
// survived, so a new overlay or a new factor lands somewhere sensible rather than at the end of a
// list the reader arranged.
export function mergeOrder<Key extends string>(
  stored: readonly Key[],
  registry: readonly Key[],
): Key[] {
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
  return layerMenuOrder(layerOrder).filter(
    (id) => wanted.has(id) && !hidden.has(id),
  );
}

export function layerMenuOrder(stored: readonly OverlayId[]): OverlayId[] {
  return mergeOrder(stored, REGISTRY_ORDER);
}

// The scenic factors in the reader's order. Hiding is NOT applied here: the route panel drops the
// hidden ones and the settings page shows them greyed, so the two want the same list.
export function factorRunOrder(stored: readonly FactorKey[]): FactorKey[] {
  return mergeOrder(
    stored,
    FACTORS.map(({ key }) => key),
  );
}
