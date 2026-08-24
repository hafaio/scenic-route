import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CITIES } from "../cities";
import { OVERLAYS, type OverlayId } from "./registry";

// A city's overlay list (OVERLAYS_BY_CITY in src/cities.ts) is authored, not derived, so the two
// ways it can drift are both silent: data built for a layer with no menu row is invisible, and a
// menu row with no data behind it is a layer that mounts and 404s. These pin both directions
// against the committed sources the build reads.
//
// Sources only, never public/ — the tile pyramids are gitignored build output, so a check over them
// would pass vacuously in CI, which is the one place it needs to hold.

const ROOT = join(import.meta.dirname, "..", "..");

// The committed source each overlay is built from, as `data/<dir>/<city>.bin`. `null` means the
// source is not a per-city file in the repo and so cannot be checked this way — elevation resolves a
// DEM over the network (scripts/elevation.ts, San Francisco only), and scaffolding is New York's DOB
// feed, rebuilt daily into public/sheds by its own job rather than by a deploy.
const SOURCE_DIR: Record<OverlayId, string | null> = {
  canopy: "canopy",
  genus: "trees",
  landmarks: "landmarks",
  art: "art",
  ferries: "ferries",
  subway: "subway",
  highways: "highways",
  commercial: "dining",
  industrial: "industrial",
  historic: "historic",
  legacy: "legacy",
  shade: "buildings",
  elevation: null,
  scaffolding: null,
};

// Layers a city has the data for and deliberately does not offer, with the reason. An entry here is
// a decision on the record; an omission without one is the drift this file exists to catch.
const WITHHELD: Record<string, Partial<Record<OverlayId, string>>> = {};

const hasSource = (overlay: OverlayId, city: string): boolean => {
  const dir = SOURCE_DIR[overlay];
  return dir !== null && existsSync(join(ROOT, "data", dir, `${city}.bin`));
};

test("every overlay declares where its source lives", () => {
  const declared = new Set(Object.keys(SOURCE_DIR));
  expect(
    OVERLAYS.map((overlay) => overlay.id).filter((id) => !declared.has(id)),
  ).toEqual([]);
});

describe.each(CITIES.map((city) => city.id))("%s", (city) => {
  const offered = new Set(CITIES.find(({ id }) => id === city)?.overlays ?? []);

  test("offers every layer it has the data for", () => {
    const missing = OVERLAYS.map(({ id }) => id).filter(
      (id) => hasSource(id, city) && !offered.has(id) && !WITHHELD[city]?.[id],
    );
    expect(missing).toEqual([]);
  });

  test("has the data for every layer it offers", () => {
    const empty = [...offered].filter(
      (id) => SOURCE_DIR[id] !== null && !hasSource(id, city),
    );
    expect(empty).toEqual([]);
  });

  test("withholds nothing it has no data for", () => {
    const stale = Object.keys(WITHHELD[city] ?? {}).filter(
      (id) => !hasSource(id as OverlayId, city),
    );
    expect(stale).toEqual([]);
  });
});
