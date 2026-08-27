"use client";

// How much canvas the map is allowed to hold. Every layer keeps its own grid of tile canvases, so
// the map's largest resident cost is not the data behind it but the pixels: a route plus five
// overlays at a phone's pixel ratio held a quarter of a gigabyte of canvas standing still, and six
// pans took it past half a gigabyte — enough for iOS to kill the tab, which is what walking with
// directions open does, since every fix recentres the map and sweeps fresh tiles into every layer.

// A pixel ratio of 3 costs nine device pixels per CSS pixel; capping at 2 gives back 56 % of the
// bytes for a raster whose labels are still drawn above the display resolution of the text.
const MAX_RATIO = 2;

export function tileRatio(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_RATIO);
}

// Rings of tiles held outside the viewport so a pan redraws less. Four rings — what every layer here
// asked for — is up to ~140 tiles per layer, and a dozen layers draw at once; two costs no more than
// one on a phone, where a pan sweeps past the ring either way, and is what keeps a fast drag on a
// wide screen from showing a strip of empty ground at its leading edge.
export const KEEP_BUFFER = 2;
