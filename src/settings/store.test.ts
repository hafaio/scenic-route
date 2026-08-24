import { expect, test } from "bun:test";
import type { OverlayId } from "../overlays/registry";
import { mergeOrder, orderedOverlays, settingsFrom } from "./store";

// The registry is what changes under a stored order — a release adds a layer, a release removes one —
// so these pin what happens to an order the reader arranged when it does.

const registry = ["canopy", "shade", "historic", "genus"] as OverlayId[];

test("an order the reader arranged is kept", () => {
  const stored = ["genus", "canopy", "shade", "historic"] as OverlayId[];
  expect(mergeOrder(stored, registry)).toEqual(stored);
});

test("a layer the registry has dropped goes", () => {
  const stored = [
    "genus",
    "ferries",
    "canopy",
    "shade",
    "historic",
  ] as OverlayId[];
  expect(mergeOrder(stored, registry)).toEqual([
    "genus",
    "canopy",
    "shade",
    "historic",
  ]);
});

test("a new layer lands where the registry puts it, not at the end", () => {
  // The reader never saw `historic`; the registry lists it after `shade`, so that is where it goes.
  const stored = ["genus", "canopy", "shade"] as OverlayId[];
  expect(mergeOrder(stored, registry)).toEqual([
    "genus",
    "canopy",
    "shade",
    "historic",
  ]);
});

test("new layers at the front of the registry stay at the front", () => {
  const stored = ["historic", "genus"] as OverlayId[];
  expect(mergeOrder(stored, registry)).toEqual([
    "canopy",
    "shade",
    "historic",
    "genus",
  ]);
});

test("nothing stored is the registry's own order", () => {
  expect(mergeOrder([], registry)).toEqual(registry);
});

test("a city shows its own subset, in the reader's order, minus what they hid", () => {
  expect(
    orderedOverlays(["canopy", "genus", "shade"] as OverlayId[], {
      layerOrder: ["genus", "canopy", "shade", "historic"] as OverlayId[],
      hiddenLayers: ["shade"] as OverlayId[],
    }),
  ).toEqual(["genus", "canopy"]);
});

// The per-factor localStorage keys every slider used to write. They are read once, folded into the
// document and then left alone, so what matters is that the fold happens exactly when the document
// has nothing to say and never again.

const legacy: Record<string, string> = {
  "scenic-route:tree-weight": "0.6",
  "scenic-route:shade-weight": "-0.4",
  "scenic-route:allow-ferries": "false",
};
const fromLegacy = (key: string): string | null => legacy[key] ?? null;
const fromNothing = (): string | null => null;

test("weights the old keys hold are folded in, and written back", () => {
  const { settings, migrated } = settingsFrom({}, fromLegacy);
  expect(settings.weights).toEqual({ tree: 0.6, shade: -0.4 });
  expect(settings.allowFerries).toBe(false);
  expect(settings.allowSheds).toBe(true); // never written, so it keeps the default
  expect(migrated).toBe(true);
});

test("a document that carries weights ignores the old keys", () => {
  const { settings, migrated } = settingsFrom(
    { weights: { tree: 0.2 }, allowFerries: true },
    fromLegacy,
  );
  expect(settings.weights).toEqual({ tree: 0.2 });
  expect(settings.allowFerries).toBe(true);
  expect(migrated).toBe(false);
});

test("a reader with neither gets the defaults, and nothing is written", () => {
  const { settings, migrated } = settingsFrom({}, fromNothing);
  expect(settings.weights).toEqual({});
  expect(settings.allowFerries).toBe(true);
  expect(settings.allowSheds).toBe(true);
  expect(settings.hiddenFactors).toEqual([]);
  expect(migrated).toBe(false);
});

// A document written by a NEWER build is the case these two guard: the reader arranges their
// settings on a release that has one more overlay or one more factor, then opens a tab still running
// this one. Rejecting a whole field over the one entry this build cannot name would undo everything
// they set, and folding the pre-document keys back over their weights — then writing that — would
// replace what they chose with a snapshot of what they chose before any of it existed.

test("an id this build does not know costs its own place, not the whole order", () => {
  const { settings } = settingsFrom(
    {
      layerOrder: ["genus", "moonlight", "canopy"] as OverlayId[],
      hiddenLayers: ["moonlight", "shade"] as OverlayId[],
    },
    () => null,
  );
  expect(settings.layerOrder).toEqual(["genus", "canopy"] as OverlayId[]);
  expect(settings.hiddenLayers).toEqual(["shade"] as OverlayId[]);
});

test("weights a newer build wrote survive a factor this one cannot name", () => {
  const legacy = (key: string): string | null =>
    key === "scenic-route:tree-weight" ? "0.05" : null;
  const { settings, migrated } = settingsFrom(
    { weights: { tree: 0.9, moonlight: 0.5 } as Record<string, number> },
    legacy,
  );
  expect(settings.weights).toEqual({ tree: 0.9 });
  expect(migrated).toBe(false); // nothing folded, so nothing is written back over them
});

test("the pre-document keys are folded in exactly once", () => {
  const legacy = (key: string): string | null =>
    ({
      "scenic-route:tree-weight": "0.4",
      "scenic-route:allow-sheds": "false",
    })[key] ?? null;

  const first = settingsFrom({}, legacy);
  expect(first.migrated).toBe(true);
  expect(first.settings.weights).toEqual({ tree: 0.4 });
  expect(first.settings.allowSheds).toBe(false);

  // The old keys are never deleted, so the only thing that stops a second fold is the document now
  // carrying weights — including a document whose weights are all at their defaults, `{}`.
  const second = settingsFrom({ weights: {}, allowSheds: true }, legacy);
  expect(second.migrated).toBe(false);
  expect(second.settings.weights).toEqual({});
  expect(second.settings.allowSheds).toBe(true);
});
