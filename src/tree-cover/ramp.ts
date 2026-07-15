// The canopy-cover colour scale, shared by the tile builder and the street overlay so both
// read as one ramp. Its input is the covered fraction of ground under canopy, in [0, 1). Only
// the light ramp exists — dark mode inverts the whole tile pane in CSS. See scripts/README.md.

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

// A single-hue sequential emerald ramp, light to dark and strictly monotonic in
// lightness, so more green always reads as more trees.
const RAMP: readonly string[] = [
  "#d1fae5",
  "#a7f3d0",
  "#6ee7b7",
  "#34d399",
  "#10b981",
  "#059669",
  "#047857",
];

const STOPS: readonly Rgb[] = RAMP.map((hex) => ({
  red: Number.parseInt(hex.slice(1, 3), 16),
  green: Number.parseInt(hex.slice(3, 5), 16),
  blue: Number.parseInt(hex.slice(5, 7), 16),
}));

// Cover is a fraction, and most of the city lands low — mean cover over land is single digits,
// leafy streets ~30-60% — so the ramp is stretched over the part of [0, 1] the city actually
// occupies rather than the whole of it: at and above this cover the green is fully saturated.
// Cover past ~55% is already a spectacular street, so pinning full green there keeps the
// gradient among leafy streets visible instead of spending it on cover nobody reaches.
const COVER_FULL = 0.55;

const MAX_ALPHA = 0.62;
// Transparency, not lightness, carries the low end — but the useful signal *is* the low end:
// a block that shades 15% of its ground reads as tree-lined, and telling that from bare ground
// is most of what the map is for. So the curve is concave (a square root), spending the opacity
// budget on the 0-30% range the city actually occupies rather than crushing it. Exactly-zero
// cover stays fully transparent, so "no trees" is blank and any real canopy lifts clear of it.
const ALPHA_CURVE = 0.5;

// Same colour, same quantity — but a 2 px line has far less area to make its colour with
// than the field under it, so it takes a little more opacity to hold its own against it.
export const ROAD_OPACITY = 1.2;

// The covered fraction, stretched onto the [0, 1] the ramp is defined over: full green at
// COVER_FULL, and everything the colour and alpha curves read is this stretched value.
function normalize(cover: number): number {
  return Math.min(1, Math.max(0, cover / COVER_FULL));
}

export function rampColor(cover: number): Rgb {
  const position = normalize(cover) * (STOPS.length - 1);
  const low = Math.min(STOPS.length - 2, Math.floor(position));
  const fraction = position - low;
  const from = STOPS[low];
  const to = STOPS[low + 1];
  return {
    red: from.red + (to.red - from.red) * fraction,
    green: from.green + (to.green - from.green) * fraction,
    blue: from.blue + (to.blue - from.blue) * fraction,
  };
}

export function rampAlpha(cover: number): number {
  return MAX_ALPHA * normalize(cover) ** ALPHA_CURVE;
}

export function rampCss(cover: number, opacity = 1): string {
  const { red, green, blue } = rampColor(cover);
  const alpha = Math.min(1, rampAlpha(cover) * opacity);
  return `rgba(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)}, ${alpha.toFixed(3)})`;
}
