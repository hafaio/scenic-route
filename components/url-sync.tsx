"use client";

import { useEffect, useState } from "react";
import { getPinnedTime, subscribeRouteTime } from "../src/route-time/store";
import type { RouteWeights } from "../src/routing/cost";
import { encodeRoute, type LatLng, replaceOwnKeys } from "../src/url-state";

interface UrlSyncProps {
  start: LatLng | null;
  dest: LatLng | null;
  weights: RouteWeights;
  // Held off until the hash at load has been applied, so the first render can't overwrite the link
  // being opened with the app's defaults.
  enabled: boolean;
}

// Mirrors the route into the URL hash, live. Its own component so the once-a-minute clock tick it
// subscribes to re-renders nothing but this. Always replaceState — a slider drag or an endpoint drag
// would otherwise bury the back button under a hundred entries. The pushStates in the app are the
// dialogs — About and the settings page — which Back should close.
export default function UrlSync({
  start,
  dest,
  weights,
  enabled,
}: UrlSyncProps) {
  const [, bump] = useState(0);
  useEffect(() => subscribeRouteTime(() => bump((value) => value + 1)), []);

  const { hour, day } = getPinnedTime();
  // No dep list: the write is a string compare against the live hash, so running it on every render is
  // cheaper than tracking a dozen dependencies, two of which live outside React.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    // Nothing to share until a route exists. The weights alone are a local preference, already
    // persisted, so writing them would put a line of sliders in the address bar of a session that
    // has not asked for anything — and would strip the keys of a settings-only link on arrival.
    // Once `from`/`to` have been written, keep going, so clearing the route clears them too.
    const routed = start !== null || dest !== null;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (!routed && !params.has("from") && !params.has("to")) {
      return;
    }
    const next = encodeRoute({
      start,
      dest,
      weights,
      customHour: hour,
      customDay: day,
    });
    const hash = replaceOwnKeys(window.location.hash, next);
    if (hash !== window.location.hash) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search + hash,
      );
    }
  });

  return null;
}
