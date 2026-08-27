import { expect, test } from "bun:test";
import type { OverlayId } from "../overlays/registry";
import { GATE_KEYS } from "../routing/cost";
import { DEFAULT_SETTINGS, type Settings } from "./store";
import { mergeSettings } from "./sync";

// Two devices, one reader. What each of these pins is that signing in MERGES rather than picking a
// winner: the point of syncing settings is not to have one device's copy, it is to stop retuning.

const settings = (patch: Partial<Settings>): Settings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
});

test("each side keeps the field it changed last", () => {
  const local = settings({
    coverage: "city",
    hiddenLayers: ["highways"] as OverlayId[],
    updatedAt: { coverage: 200, hiddenLayers: 100 },
  });
  const remote = settings({
    coverage: "recent",
    hiddenLayers: ["subway"] as OverlayId[],
    updatedAt: { coverage: 150, hiddenLayers: 300 },
  });
  const merged = mergeSettings(local, remote);
  expect(merged.coverage).toBe("city"); // local changed it later
  expect(merged.hiddenLayers).toEqual(["subway"] as OverlayId[]); // the other device did
});

test("two devices tuning two different sliders both keep theirs", () => {
  const local = settings({
    weights: { tree: 0.9, shade: 0.1 },
    updatedAt: { "weights.tree": 500 },
  });
  const remote = settings({
    weights: { tree: 0.2, shade: 0.8 },
    updatedAt: { "weights.shade": 700 },
  });
  expect(mergeSettings(local, remote).weights).toEqual({
    tree: 0.9,
    shade: 0.8,
  });
});

test("a field neither device has ever touched is left alone", () => {
  const local = settings({ coverage: "both" });
  const remote = settings({ coverage: "recent" });
  expect(mergeSettings(local, remote).coverage).toBe("both");
});

test("settings made before signing in are not overwritten by an older cloud copy", () => {
  const local = settings({
    layerOrder: ["genus"] as OverlayId[],
    updatedAt: { layerOrder: 900 },
  });
  const remote = settings({
    layerOrder: ["canopy"] as OverlayId[],
    updatedAt: { layerOrder: 100 },
  });
  expect(mergeSettings(local, remote).layerOrder).toEqual([
    "genus",
  ] as OverlayId[]);
});

test("the merged stamps carry whichever side won, so the next merge agrees", () => {
  const local = settings({ coverage: "city", updatedAt: { coverage: 100 } });
  const remote = settings({ coverage: "recent", updatedAt: { coverage: 400 } });
  const merged = mergeSettings(local, remote);
  expect(merged.updatedAt.coverage).toBe(400);
  expect(mergeSettings(merged, remote)).toEqual(merged);
});

// The gates are spread from GATE_KEYS, so this walks that list rather than naming gates: a gate
// added later is synced by construction, and a test that named them would pass while the code it
// guards forgot one.
test("every gate reaches the other device, not just the two the list was born with", () => {
  for (const gate of GATE_KEYS) {
    const local = {
      ...DEFAULT_SETTINGS,
      [gate]: false,
      updatedAt: { [gate]: 1 },
    };
    const remote = {
      ...DEFAULT_SETTINGS,
      [gate]: true,
      updatedAt: { [gate]: 2 },
    };
    expect(mergeSettings(local, remote)[gate], `${gate} did not sync`).toBe(
      true,
    );
  }
});
