"use client";

import { FcGoogle } from "react-icons/fc";
import type { RouteWeights } from "../src/routing/cost";
import {
  googleMapsWalkingUrl,
  MAX_WAYPOINTS,
} from "../src/routing/google-maps";
import type { RoutingGraph } from "../src/routing/graph";
import type { RouteResult } from "../src/routing/search";
import { planWaypoints } from "../src/routing/waypoints";
import type { LatLng } from "../src/url-state";

interface GoogleMapsButtonProps {
  graph: RoutingGraph;
  route: RouteResult;
  weights: RouteWeights; // the reader's own sliders: what the approximation is scored against
  start: LatLng; // the requested endpoints rather than the snapped ones — Google re-snaps anyway
  dest: LatLng;
}

// Hands the route to Google Maps for turn-by-turn navigation, approximated by the nine waypoints its
// URL will take. Google's own multicoloured mark rather than the Maps pin: a pin among this app's own
// pins reads as one more piece of the map, where the brand mark says plainly that the tap leaves.
//
// The pins are worked out in the click handler rather than ahead of time, and it is not cheap: over
// New York at the app's default weights it takes 20 ms on a 2.6 km walk, 110 ms on a 5 km one and
// 750 ms on a 15 km one, all of it synchronous. Once per tap is still far less than once per slider
// nudge, and computing inside the gesture is what keeps the popup blocker off the new tab.
export default function GoogleMapsButton({
  graph,
  route,
  weights,
  start,
  dest,
}: GoogleMapsButtonProps) {
  const open = (): void => {
    const plan = planWaypoints(graph, route, weights, MAX_WAYPOINTS);
    window.open(
      googleMapsWalkingUrl(start, dest, plan.waypoints),
      "_blank",
      "noopener,noreferrer",
    );
  };

  return (
    <button
      type="button"
      onClick={open}
      aria-label="Navigate this route in Google Maps"
      title="Navigate this route in Google Maps"
      className="grid h-10 w-10 place-items-center rounded-full bg-white/85 text-slate-500 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:text-slate-400 dark:ring-white/10 dark:hover:bg-slate-800"
    >
      <FcGoogle className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
