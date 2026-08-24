// The map's colour, in one place.
//
// The raster overlays ship VALUES rather than pictures: a canopy tile carries the covered fraction
// of ground under trees, an elevation tile carries height, relief and land cover, a shade tile
// carries the fraction of light a pixel has lost. None of them carries a colour. What those values
// look like is decided here and applied by one shader (src/tiles/theme-gl.ts) as the tile is drawn,
// which is what makes a palette a value rather than a rebuild.

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

// Which channel of a value tile a field is read out of. What a channel means is per layer, so the
// shader is told rather than knowing.
export type Channel = "red" | "green" | "alpha";

// How one overlay's values are coloured. Everything the shader needs and nothing about how the tile
// was made: a colour ramp the value picks a point on, an opacity curve, and optionally a second
// channel that shades the colour it picked.
export interface Ramp {
  // Low to high, at most STOPS_LIMIT of them. A single stop is a flat colour the value only sets the
  // opacity of.
  stops: readonly Rgb[];
  value: Channel; // picks the colour
  // The value the ramp saturates at, on the channel's own 0..1 — the ramp is spread over the part of
  // the range the city occupies rather than the whole of it.
  valueFull: number;
  alpha: Channel; // sets the opacity, often the same channel as the colour
  alphaFull: number;
  // Exponent on the normalised value. Below 1 it is concave, which spends the opacity budget on the
  // low end — where a faint signal still means something and would otherwise be crushed.
  alphaCurve: number;
  maxAlpha: number; // 0..1, the opacity a saturated value reaches
  relief: Channel | null; // multiplies the colour, for a layer that carries its own shading
  reliefScale: number; // what that channel is multiplied back out by
}

// The most stops the shader's uniform array holds. Raising it is a shader edit as well as this one.
export const STOPS_LIMIT = 8;

function stops(...hexes: string[]): readonly Rgb[] {
  return hexes.map((hex) => ({
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  }));
}

// A single-hue sequential teal/mint ramp, light to dark and strictly monotonic in lightness, so more
// green always reads as more trees. Deliberately mintier (bluer) than the brand emerald the route
// line draws in, so a route over canopy reads apart from the greenery under it.
const CANOPY_STOPS = stops(
  "#ccfbf1",
  "#99f6e4",
  "#5eead4",
  "#2dd4bf",
  "#14b8a6",
  "#0d9488",
  "#0f766e",
);

// The hypsometric ramp a paper topographic map tints its contour bands with, low to high.
// Interpolated rather than banded, so a city with 100 m of range does not come out as three flat
// steps.
const ELEVATION_STOPS = stops(
  "#568460", // valley green
  "#8ca870", // low slope
  "#c4be82", // tan
  "#d6b07a", // ochre
  "#ba8a68", // brown
  "#966c5c", // summit
);

// Cover is a fraction and most of the city lands low — mean cover over land is single digits, leafy
// streets 30-60% — so the ramp is stretched over the part of [0, 1] the city actually occupies.
// Cover past this is already a spectacular street, and pinning full green there keeps the gradient
// among leafy streets visible instead of spending it on cover nobody reaches.
const COVER_FULL = 0.55;

export interface Palette {
  canopy: Ramp;
  elevation: Ramp;
  shade: Ramp;
}

export const PALETTE: Palette = {
  // Cover in alpha, nothing in RGB (crates/tiler/src/canopy.rs). The alpha curve is concave because
  // the useful signal IS the low end: a block that shades 15% of its ground reads as tree-lined, and
  // telling that from bare ground is most of what the map is for. Exactly-zero cover stays fully
  // transparent, so "no trees" is blank and any real canopy lifts clear of it.
  canopy: {
    stops: CANOPY_STOPS,
    value: "alpha",
    valueFull: COVER_FULL,
    alpha: "alpha",
    alphaFull: COVER_FULL,
    alphaCurve: 0.5,
    maxAlpha: 0.62,
    relief: null,
    reliefScale: 1,
  },
  // Height in red, the relief shade in green, how much of the pixel stands on ground in alpha
  // (crates/tiler/src/elevation.rs). The relief is what makes the form read at a glance; without it
  // a smooth hypsometric ramp looks like fog. Its scale is the most the shade can reach, which is
  // over 1 because a lit face is brightened rather than only darkened, and it matches HILLSHADE_MAX
  // in the pass. The opacity is low enough that the basemap under it stays legible — street names,
  // park fills, the water — since the terrain covers every pixel of the city and anything it buries
  // is buried everywhere.
  elevation: {
    stops: ELEVATION_STOPS,
    value: "red",
    valueFull: 1,
    alpha: "alpha",
    alphaFull: 1,
    alphaCurve: 1,
    maxAlpha: 170 / 255,
    relief: "green",
    reliefScale: 1.15,
  },
  // The fraction of light lost in alpha, already scaled by the sun's intensity when the pyramid was
  // baked (crates/tiler/src/shade.rs). One colour, so the value only sets how much of it there is.
  shade: {
    stops: stops("#334155"), // slate-700, a cool shadow
    value: "alpha",
    valueFull: 1,
    alpha: "alpha",
    alphaFull: 1,
    alphaCurve: 1,
    maxAlpha: 1,
    relief: null,
    reliefScale: 1,
  },
};

// Same colour, same quantity — but a 2 px line has far less area to make its colour with than the
// field under it, so it takes a little more opacity to hold its own against it.
export const ROAD_OPACITY = 1.2;

// One point on a ramp: the colour a value picks, and how much of it there is. The shader computes
// exactly this per pixel; this is for the parts of the app that draw a ramp in CSS rather than in a
// tile — the canopy street lines and the elevation key.
export function rampAt(
  ramp: Ramp,
  value: number,
): { color: Rgb; alpha: number } {
  const { stops: points } = ramp;
  const position =
    Math.min(1, Math.max(0, value / ramp.valueFull)) * (points.length - 1);
  const low = Math.max(0, Math.min(points.length - 2, Math.floor(position)));
  const blend = position - low;
  const from = points[low];
  const to = points[Math.min(points.length - 1, low + 1)];
  return {
    color: {
      red: from.red + (to.red - from.red) * blend,
      green: from.green + (to.green - from.green) * blend,
      blue: from.blue + (to.blue - from.blue) * blend,
    },
    alpha:
      ramp.maxAlpha *
      Math.min(1, Math.max(0, value / ramp.alphaFull)) ** ramp.alphaCurve,
  };
}

// One point on a ramp as CSS, for the overlays drawn with a 2D context rather than through the
// shader.
export function rampCss(ramp: Ramp, value: number, opacity = 1): string {
  const { color, alpha } = rampAt(ramp, value);
  const painted = Math.min(1, alpha * opacity);
  return `rgba(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}, ${painted.toFixed(3)})`;
}
