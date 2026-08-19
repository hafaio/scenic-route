// What a ferry route is drawn as: its operator's own colour, and which route of the file it is —
// the identity ./polylines stacks the lanes by where routes share a stretch of water.
//
// The colours are the `route_color` each feed publishes for the route, read straight off
// `routes.txt` in the two frozen GTFS zips under `data/ferries/` — NYC Ferry (Hornblower, via
// Connexionz) for the seven NYC Ferry routes, NYC DOT for the Staten Island Ferry. That is the
// operator's real branding: East River is NYC Ferry's teal, the Staten Island Ferry its orange.
//
// The key is the route's display name, which is what a FERR segment carries (record byte 18, an
// index into the file's name blob) — `route_long_name` in both feeds. This is a display table and
// not an artifact field on purpose: a colour is a rendering choice over a handful of stable names,
// so changing one should not cost a re-ingest of the network.
const ROUTE_COLORS: Record<string, string> = {
  Astoria: "#ff6b00",
  "East River": "#00839c",
  "Governors Island Shuttle": "#9795a0",
  "Rockaway Rocket": "#ff8672",
  "Rockaway-Soundview": "#4e008e",
  "South Brooklyn": "#ffd100",
  "St. George": "#d0006f",
  "Staten Island Ferry": "#ff8330",
};

export interface RouteStyle {
  color: string | null; // null where the route is unknown, so the layer's own colour stands in
  route: number; // which route of the file this segment belongs to, in name order
}

// The colour and route index of every segment in the file, index-aligned with it.
//
// The index is the route names sorted, so a route is the same route whatever order the segments
// happen to be decoded in, at every zoom and in every tile — which lane of a bundle that route takes
// is settled from the geometry, in laneOrder. Segments the feed does not name share one index at the
// end: they are one route as far as a lane stack is concerned, which is as much as the file says
// about them.
export function routeStyles(routes: readonly (string | null)[]): RouteStyle[] {
  const named = [...new Set(routes.filter((route) => route !== null))].sort();
  const indices = new Map(named.map((route, index) => [route, index]));
  return routes.map((route) => ({
    color: route === null ? null : (ROUTE_COLORS[route] ?? null),
    route: route === null ? named.length : (indices.get(route) ?? named.length),
  }));
}
