// The tree-density colour scale, shared by the tile builder and the street overlay so both
// read as one ramp. Its input is the normalized density: 0 for no trees, 1 at the
// saturation point the manifest records. Only the light ramp exists — dark mode inverts the
// whole tile pane in CSS. See scripts/README.md.

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

const MAX_ALPHA = 0.62;
// Transparency, not lightness, carries the low end. Half the city's land sits below 0.4 of
// saturation, so a linear alpha would tint everything and wash the map out; cubing holds
// that crowded middle down to a haze (0.4 -> alpha 0.04).
const ALPHA_CURVE = 3;

// Same colour, same quantity — but a 2 px line has far less area to make its colour with
// than the field under it, so it takes a little more opacity to hold its own against it.
export const ROAD_OPACITY = 1.2;

function clamp(density: number): number {
  return Math.min(1, Math.max(0, density));
}

export function rampColor(density: number): Rgb {
  const position = clamp(density) * (STOPS.length - 1);
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

export function rampAlpha(density: number): number {
  return MAX_ALPHA * clamp(density) ** ALPHA_CURVE;
}

export function rampCss(density: number, opacity = 1): string {
  const { red, green, blue } = rampColor(density);
  const alpha = Math.min(1, rampAlpha(density) * opacity);
  return `rgba(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)}, ${alpha.toFixed(3)})`;
}
