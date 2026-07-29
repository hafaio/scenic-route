import { expect, test } from "bun:test";
import { compositeAlpha } from "./shade";

// The composite is the whole reason the tree pyramid is a second source read by this renderer rather
// than a second Leaflet layer, so these pin it to the shade physics it stands for.

const MAX_SHADE_ALPHA = 190;

// The alphas as `tiler shade` bakes them: MAX_SHADE_ALPHA * intensity * fraction.
function baked(fraction: number, intensity: number): number {
  return Math.round(MAX_SHADE_ALPHA * intensity * fraction);
}

test("is the light that gets past a building and past a crown", () => {
  const intensity = 0.7;
  const tau = 0.814;
  for (const building of [0, 0.25, 0.6, 1]) {
    for (const tree of [0, 0.3, 1]) {
      const expected =
        MAX_SHADE_ALPHA * intensity * (1 - (1 - building) * (1 - tau * tree));
      const alpha = compositeAlpha(
        baked(building, intensity),
        baked(tree, intensity),
        tau,
        intensity,
      );
      // Both inputs and the result are whole alpha steps, so the agreement is to within their rounding.
      expect(Math.abs(alpha - expected)).toBeLessThanOrEqual(1.5);
    }
  }
});

test("passes either source through alone", () => {
  expect(compositeAlpha(96, 0, 0.814, 0.7)).toBe(96);
  expect(compositeAlpha(0, 100, 0.814, 0.7)).toBe(81);
});

test("never comes out lighter than either source alone", () => {
  const tau = 0.814;
  for (const intensity of [0.05, 0.49, 0.93]) {
    // The whole 8-step lattice, including the step past MAX_SHADE_ALPHA * intensity a full shadow
    // quantises up to.
    for (let buildings = 0; buildings <= 255; buildings += 8) {
      for (let trees = 0; trees <= 255; trees += 8) {
        const alpha = compositeAlpha(buildings, trees, tau, intensity);
        expect(alpha).toBeGreaterThanOrEqual(buildings);
        expect(alpha).toBeGreaterThanOrEqual(Math.round(tau * trees));
      }
    }
  }
});

test("stays under source-over, which double-scales the overlap", () => {
  const [full, tau, intensity] = [baked(1, 1), 1, 1];
  expect(compositeAlpha(full, full, tau, intensity)).toBe(MAX_SHADE_ALPHA);
  // Two stacked layers would instead reach 255 - (255 - 190)² / 255 ≈ 238.
  expect(compositeAlpha(full, full, tau, intensity)).toBeLessThan(238);
});
