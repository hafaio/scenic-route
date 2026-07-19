"use client";

// The map's divIcons, shared by the map view and the route layer. Kept in their own module so
// the two components can reuse the exact same markers without importing across each other.

import L from "leaflet";

const savedPinSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">
  <defs>
    <linearGradient id="scenicPinGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
  </defs>
  <path d="M15 1C7.82 1 2 6.82 2 14c0 9.5 13 24 13 24s13-14.5 13-24C28 6.82 22.18 1 15 1z"
        fill="url(#scenicPinGrad)" stroke="#ffffff" stroke-width="2"/>
  <circle cx="15" cy="14" r="4.5" fill="#ffffff"/>
</svg>`.trim();

export const savedIcon = L.divIcon({
  className: "scenic-saved-pin",
  html: savedPinSvg,
  iconSize: [30, 40],
  iconAnchor: [15, 39],
  popupAnchor: [0, -34],
  tooltipAnchor: [0, -34],
});

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
