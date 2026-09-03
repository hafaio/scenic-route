// A link that hands a route to Google Maps for real turn-by-turn navigation. Google's cross-platform
// URL scheme is the whole of what is available: one link opens in a desktop browser and deep-links
// into the Google Maps app on both phones. There is no way to pass it a polyline or import a route —
// the `data=!4m...` blob in a copied Google Maps link is internal, unstable and not synthesizable —
// and the platform-specific schemes (`google.navigation:`, `comgooglemaps://`) take a single
// destination and no waypoints at all. So a route reaches Google as a few waypoints or not at all.

import type { Waypoint } from "./waypoints";

// Google documents "up to three waypoints on mobile browsers, and a maximum of nine waypoints
// otherwise", and quietly ignores the ones it will not take rather than complaining — an over-limit
// link degrades to a plain origin-to-destination walk. Nine regardless: the desktop and app cases get
// the route they asked for, and a mobile browser gets what it would have got anyway.
export const MAX_WAYPOINTS = 9;

// Enough to place a point to about 0.1 m, which is finer than Google's own snapping.
const COORD_DIGITS = 6;

function coordinate({ lat, lng }: Waypoint): string {
  return `${lat.toFixed(COORD_DIGITS)},${lng.toFixed(COORD_DIGITS)}`;
}

// Origin and destination are the reader's OWN requested endpoints rather than the points we snapped
// them to: Google re-snaps whatever it is given to its own network, so handing it our snap only
// moves the walk's ends about for no gain.
export function googleMapsWalkingUrl(
  origin: Waypoint,
  destination: Waypoint,
  waypoints: readonly Waypoint[],
): string {
  const params = new URLSearchParams({
    api: "1",
    origin: coordinate(origin),
    destination: coordinate(destination),
    travelmode: "walking",
  });
  if (waypoints.length > 0) {
    params.set(
      "waypoints",
      waypoints.slice(0, MAX_WAYPOINTS).map(coordinate).join("|"),
    );
  }
  return `https://www.google.com/maps/dir/?${params}`;
}
