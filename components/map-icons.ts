"use client";

// The map's divIcons, shared by the map view and the route layer. Kept in their own module so
// the two components can reuse the exact same markers without importing across each other.

import L from "leaflet";
import { SEARCH_PIN_COLOR } from "../src/overlays/colors";
import type { ThemeName } from "../src/theme/palette";

// The teardrop both dropped pins are cut from. The gradient id has to differ between them: the two
// SVGs sit in one document, and a repeated id paints whichever was defined first.
function teardropSvg(gradientId: string, from: string, to: string): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">
  <defs>
    <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <path d="M15 1C7.82 1 2 6.82 2 14c0 9.5 13 24 13 24s13-14.5 13-24C28 6.82 22.18 1 15 1z"
        fill="url(#${gradientId})" stroke="#ffffff" stroke-width="2"/>
  <circle cx="15" cy="14" r="4.5" fill="#ffffff"/>
</svg>`.trim();
}

export const savedIcon = L.divIcon({
  className: "scenic-saved-pin",
  html: teardropSvg("scenicPinGrad", "#34d399", "#059669"),
  iconSize: [30, 40],
  iconAnchor: [15, 39],
  popupAnchor: [0, -34],
  tooltipAnchor: [0, -34],
});

// The same hue at a lower lightness, keeping the saturation, so one themed colour draws the whole
// teardrop: the gradient reads as the pin lit from above rather than as two authored colours, which
// mixing toward black does not — that drains the colour to grey.
function shaded(hex: string, scale: number): string {
  const channels = [1, 3, 5].map(
    (at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
  );
  const lightness = (Math.max(...channels) + Math.min(...channels)) / 2;
  const darker = lightness * scale;
  // How far each channel sits from the midpoint is rescaled by the room the darker midpoint leaves
  // for it, which is what holds the saturation as the lightness drops.
  const room =
    (1 - Math.abs(2 * darker - 1)) / (1 - Math.abs(2 * lightness - 1));
  const hexOf = (channel: number): string =>
    Math.round(
      Math.min(1, Math.max(0, darker + (channel - lightness) * room)) * 255,
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channels.map(hexOf).join("")}`;
}

// A place the reader looked up, in the app's own green. That green also means the route destination
// and an admin's saved note, so a search result and a destination read alike — the two are never far
// apart in practice, since the directions control is what turns one into the other.
//
// Built per theme rather than once at import, because the green is a light/dark pair like every
// other colour on this map (src/overlays/colors.ts) and the marker is handed a fresh icon when the
// theme flips.
export function searchIcon(theme: ThemeName): L.DivIcon {
  const green = SEARCH_PIN_COLOR[theme];
  return L.divIcon({
    className: "scenic-search-pin",
    html: teardropSvg("scenicSearchPinGrad", green, shaded(green, 0.8)),
    iconSize: [30, 40],
    iconAnchor: [15, 39],
  });
}

// The route start: a static dot (no pulse ring — it's a fixed endpoint, not the live location).
export const startIcon = L.divIcon({
  className: "",
  html: '<div class="scenic-draft-pin"><div class="scenic-draft-pin-dot"></div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

export const userIcon = L.divIcon({
  className: "",
  html: '<div class="scenic-user-pin"><div class="scenic-user-pin-ring"></div><div class="scenic-user-pin-dot"></div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});
