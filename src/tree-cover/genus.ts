// The genus overlay's colour key, shared by the tile builder and the legend so a tree on the map
// and its swatch read as one palette. Each tree is drawn as a disc in its genus's colour. This
// module is purely positional: ids 0..10 are the 11 commonest genera, ranked by count in the
// pipeline, and id 11 is "Other". Only the light palette exists — dark mode leaves the genus pane
// un-inverted, so these are the colours the map and the legend both show.

import type { Rgb } from "./ramp";

export const OTHER_GENUS_ID = 11;

// Eleven mid-saturation, mid-lightness hues spaced around the wheel so any proportional blend
// of a few stays legible instead of collapsing into mud, plus a neutral grey for "Other". Order
// is genus rank and carries no meaning; what matters is that adjacent hues on the wheel differ
// enough that no pair averages back onto a third.
const PALETTE: readonly string[] = [
  "#e15759", // red
  "#f28e2b", // orange
  "#edc948", // yellow
  "#8cb43a", // lime
  "#4e9f50", // green
  "#3fb0a0", // teal
  "#4b8fc9", // blue
  "#6a5bd0", // indigo
  "#9b57c4", // violet
  "#c353b0", // magenta
  "#db5478", // rose
  "#9ca3af", // Other — neutral medium grey
];

export const GENUS_COLORS: readonly Rgb[] = PALETTE.map((hex) => ({
  red: Number.parseInt(hex.slice(1, 3), 16),
  green: Number.parseInt(hex.slice(3, 5), 16),
  blue: Number.parseInt(hex.slice(5, 7), 16),
}));

export const GENUS_COUNT = GENUS_COLORS.length;

// Anything outside the 12 ranked genera falls to the "Other" grey, so a stray id never throws
// and never borrows another genus's hue.
export function genusColor(id: number): Rgb {
  if (id < 0 || id >= OTHER_GENUS_ID || !Number.isInteger(id)) {
    return GENUS_COLORS[OTHER_GENUS_ID];
  }
  return GENUS_COLORS[id];
}

export function genusCss(id: number, alpha = 1): string {
  const { red, green, blue } = genusColor(id);
  const bounded = Math.min(1, Math.max(0, alpha));
  return `rgba(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)}, ${bounded.toFixed(3)})`;
}
