import type { ThemeName } from "../theme/palette";

// The colour each single-hued overlay is drawn in, in one place, because two things read it: the
// renderer that paints the layer and the key that names it. Kept apart from the layers themselves so
// a swatch cannot quietly stop matching the map.
//
// Each is a pair, picked for the ground it is drawn on the same way the ramps in
// src/theme/palette.ts are. These are washes and dots over the map, and a 600/700-weight hue that
// reads as solid on paper white nearly disappears on the night ground, so the dark half lifts to
// keep the same contrast against its own ground.
//
// For the small figures that is a step to the 400 weights and no more. The three area washes are
// mixed by hand instead: they paint at 0.45, so more than half of what reaches the eye is the
// ground itself, and a uniform step left two of them compositing to the same colour. What a pair
// has to stay apart in is what it looks like AFTER that mixing, not on the swatch.
//
// The three ramped overlays are not here — canopy, shade and elevation are whole ramps, and theirs
// live with the rest of the palette in src/theme/palette.ts.

// The dot colours match the route panel's scenery sliders (landmark amber, art fuchsia), so the map
// and the controls read as one palette.
export const LANDMARK_COLOR: Record<ThemeName, string> = {
  light: "#f59e0b", // amber-500
  dark: "#fbbf24", // amber-400
};

// A mustard gold, distinct from the landmark amber because the two sit near each other on the map
// and price different things: a landmark is a designated BUILDING, these are businesses still
// trading in one. Distinct from the commercial overlay's violet for the same reason — that is where
// the shops are, this is which of them have been there fifty years.
//
// A step lighter than the yellow-700 it started as, and the reason is the LABEL rather than the
// dot: names are drawn in the dot's own colour over a black halo (src/tiles/labels.ts), and a dark
// fill on a dark halo comes out as mud. The other POI colours are already light enough to carry
// that; this one was not.
//
// By day this is the DARKER half of the amber pair, which is what tells it from a landmark. The
// halo forbids that at night, so the pair swaps roles rather than losing its separation: legacy
// becomes the paler lemon and the landmark keeps the saturated gold. Stepped to the same weight it
// would sit five degrees of hue from the landmark amber at the same lightness, which is no
// separation at all.
export const LEGACY_COLOR: Record<ThemeName, string> = {
  light: "#ca8a04", // yellow-600
  dark: "#fde047", // yellow-300
};

export const ART_COLOR: Record<ThemeName, string> = {
  light: "#d946ef", // fuchsia-500
  dark: "#e879f9", // fuchsia-400
};

// The route layer's ferry-leg colour as well as the ferry overlay's.
export const FERRY_COLOR: Record<ThemeName, string> = {
  light: "#2563eb", // blue-600
  dark: "#60a5fa", // blue-400
};

export const HIGHWAY_COLOR: Record<ThemeName, string> = {
  light: "#ef4444", // red-500
  dark: "#f87171", // red-400
};

// Violet, distinct from the green canopy and the scenic overlays. A qualifying block is this one
// uniform colour — the overlay is binary on/off, with no intensity grading yet.
//
// The night violet is hand-mixed rather than stepped, and the reason is the layer below it. These
// two wash at 0.45, so what a reader sees is 55% night ground; at the same Tailwind weight the two
// composite to within a few counts of each other and stop being two layers. This one goes purpler
// and calmer, historic goes bluer and deeper, and the gap survives the mixing.
export const COMMERCIAL_COLOR: Record<ThemeName, string> = {
  light: "#6d28d9", // violet-700
  dark: "#ac89e6",
};

// Indigo, far enough from the pink industrial lots, the violet commercial field and the amber
// landmark dots to tell apart as a wash. It is the deepest of the three washes by day and stays the
// deepest at night, which is the half of its separation from commercial that survives compositing.
export const HISTORIC_COLOR: Record<ThemeName, string> = {
  light: "#4338ca", // indigo-700
  dark: "#6c7eda",
};

// Pink, far enough from the red highway lines and the violet commercial field to tell apart as a
// wash. Dusted down at night to the same muted register as the other two: the swatch in the key
// shows the raw colour at full strength, where a saturated pink beside two washed fields is the one
// thing on the panel that shouts.
export const INDUSTRIAL_COLOR: Record<ThemeName, string> = {
  light: "#db2777", // pink-600
  dark: "#e085b3",
};

// Orange, construction against the map's greens and blues.
export const SHED_COLOR: Record<ThemeName, string> = {
  light: "#ea580c", // orange-600
  dark: "#fb923c", // orange-400
};

// The subway draws each route in the transit agency's own published colour (src/tiles/subway.ts), so
// it is the one overlay with no single true colour. This is the A/C/E blue the feed publishes, which
// the layer's menu glyph and its key both stand in with, lightened for the night ground.
export const SUBWAY_COLOR: Record<ThemeName, string> = {
  light: "#0062cf",
  dark: "#4d94ff",
};

// The teardrop the search drops on a place it found, in the app's own green. That green already
// means a route destination and an admin's saved note, so a found place and a destination read
// alike — which is close to true of them: the directions control turns one into the other. A step
// lighter at night for the same reason the dot colours are, the saturated green being read against
// paper white and going heavy on the night ground for a figure this small.
export const SEARCH_PIN_COLOR: Record<ThemeName, string> = {
  light: "#34d399", // emerald-400
  dark: "#6ee7b7", // emerald-300
};
