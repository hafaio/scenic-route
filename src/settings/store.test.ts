import { expect, test } from "bun:test";
import type { OverlayId } from "../overlays/registry";
import { mergeLayerOrder, orderedOverlays } from "./store";

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
