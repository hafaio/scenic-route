// The colour each single-hued overlay is drawn in, in one place, because two things read it: the
// renderer that paints the layer and the key that names it. Kept apart from the layers themselves so
// a swatch cannot quietly stop matching the map.
//
// The three ramped overlays are not here — canopy, shade and elevation are whole ramps, and theirs
// live with the rest of the palette in src/theme/palette.ts.

// The dot colours match the route panel's scenery sliders (landmark amber, art fuchsia), so the map
// and the controls read as one palette.
export const LANDMARK_COLOR = "#f59e0b"; // amber-500

// A mustard gold, distinct from the landmark amber because the two sit near each other on the map
// and price different things: a landmark is a designated BUILDING, these are businesses still
// trading in one. Distinct from the commercial overlay's violet for the same reason — that is where
// the shops are, this is which of them have been there fifty years.
//
// A step lighter than the yellow-700 it started as, and the reason is the LABEL rather than the
// dot: names are drawn in the dot's own colour over a black halo (src/tiles/labels.ts), and a dark
// fill on a dark halo comes out as mud. The other POI colours are already light enough to carry
// that; this one was not.
export const LEGACY_COLOR = "#ca8a04"; // yellow-600

export const ART_COLOR = "#d946ef"; // fuchsia-500
export const FERRY_COLOR = "#2563eb"; // blue-600, the route layer's ferry-leg colour
export const HIGHWAY_COLOR = "#ef4444"; // red-500

// Violet-700, distinct from the green canopy and the scenic overlays. A qualifying block is this one
// uniform violet — the overlay is binary on/off, with no intensity grading yet.
export const COMMERCIAL_COLOR = "#6d28d9";

// Indigo-700, far enough from the pink industrial lots, the violet commercial field and the amber
// landmark dots to tell apart as a wash.
export const HISTORIC_COLOR = "#4338ca";

// Pink-600, far enough from the red highway lines and the violet commercial field to tell apart as
// a wash.
export const INDUSTRIAL_COLOR = "#db2777";

export const SHED_COLOR = "#ea580c"; // orange-600, construction against the map's greens and blues

// The subway draws each route in the transit agency's own published colour (src/tiles/subway.ts), so
// it is the one overlay with no single true colour. This is the A/C/E blue the feed publishes, which
// the layer's menu glyph and its key both stand in with.
export const SUBWAY_COLOR = "#0062cf";
