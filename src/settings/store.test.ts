import { expect, test } from "bun:test";
import type { OverlayId } from "../overlays/registry";
import { mergeLayerOrder, orderedOverlays, settingsFrom } from "./store";

// The registry is what changes under a stored order — a release adds a layer, a release removes one —
// so these pin what happens to an order the reader arranged when it does.

const registry = ["canopy", "shade", "historic", "genus"] as OverlayId[];

test("an order the reader arranged is kept", () => {
  const stored = ["genus", "canopy", "shade", "historic"] as OverlayId[];
  expect(mergeLayerOrder(stored, registry)).toEqual(stored);
});

test("a layer the registry has dropped goes", () => {
  const stored = [
    "genus",
    "ferries",
    "canopy",
    "shade",
    "historic",
  ] as OverlayId[];
  expect(mergeLayerOrder(stored, registry)).toEqual([
    "genus",
    "canopy",
    "shade",
    "historic",
  ]);
});

test("a new layer lands where the registry puts it, not at the end", () => {
  // The reader never saw `historic`; the registry lists it after `shade`, so that is where it goes.
  const stored = ["genus", "canopy", "shade"] as OverlayId[];
  expect(mergeLayerOrder(stored, registry)).toEqual([
    "genus",
    "canopy",
    "shade",
    "historic",
  ]);
});

test("new layers at the front of the registry stay at the front", () => {
  const stored = ["historic", "genus"] as OverlayId[];
  expect(mergeLayerOrder(stored, registry)).toEqual([
    "canopy",
    "shade",
    "historic",
    "genus",
  ]);
});

test("nothing stored is the registry's own order", () => {
  expect(mergeLayerOrder([], registry)).toEqual(registry);
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
