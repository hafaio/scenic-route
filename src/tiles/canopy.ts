import { assemble, cutFor, draw, type Patch } from "./magnify";
import type { CanopyParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";

// The baked canopy pyramid, magnified through src/tiles/magnify.ts rather than by the browser. Every
// channel of a canopy tile carries the emerald ramp, so there is nothing to composite or quantise: the
// tile's ground is assembled out of one pyramid and resampled once.

async function load(
  { url, maxNativeZoom }: CanopyParams,
  coords: TileCoords,
): Promise<Patch | null> {
  const cut = cutFor(maxNativeZoom, coords);
  const patch = await assemble(url, cut);
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

export const canopyRenderer: TileRenderer<CanopyParams, Patch | null> = {
  load,
  draw,
};
