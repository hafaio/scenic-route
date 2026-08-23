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
  const { patch, failed } = await assemble(url, cut);
  // Thrown rather than drawn as nothing, so the tile reaches Leaflet as an error and the layers menu
  // can say the canopy is not showing because it could not be fetched. Only when there is nothing to
  // draw at all: a magnified tile also asks for its eight neighbours, and one of those failing costs
  // the resample a little context at the edge, not the tile. A pyramid that is merely sparse over
  // this ground comes back with `failed` false and draws nothing, as it should.
  if (!patch && failed) {
    throw new Error(`${url}: source tiles could not be fetched`);
  }
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

export const canopyRenderer: TileRenderer<CanopyParams, Patch | null> = {
  load,
  draw,
};
