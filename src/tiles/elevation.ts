import { assemble, cutFor, type Patch } from "./magnify";
import type { ElevationParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { palette } from "./theme";
import { drawRamped } from "./theme-gl";

// The baked elevation pyramid, magnified through src/tiles/magnify.ts rather than by the browser.
//
// An elevation tile carries three fields and no colour: height across the city's range in red, the
// relief shade in green, and how much of the pixel stands on ground in alpha. The hypsometric tint,
// the relief it is multiplied by and the wash's opacity are all the palette's, applied on the way
// onto the tile (./theme-gl.ts).
//
// Magnified here rather than by an <img>, which is what this layer used to be, because what a reader
// notices past the deepest baked level is the COASTLINE: the land mask is a fractional alpha at the
// shore, and each stretched image interpolating on its own leaves a seam at every tile edge.

async function load(
  { url, maxNativeZoom }: ElevationParams,
  coords: TileCoords,
): Promise<Patch | null> {
  const cut = cutFor(maxNativeZoom, coords);
  const { patch, failed } = await assemble(url, cut);
  // Thrown rather than drawn as nothing, so the tile reaches Leaflet as an error and the layers menu
  // can say the terrain is not showing because it could not be fetched. A tile with no ground under
  // it is never written at all, so a 404 comes back with `failed` false and draws nothing, which is
  // what "no terrain here" looks like.
  if (!patch && failed) {
    throw new Error(`${url}: source tiles could not be fetched`);
  }
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

export const elevationRenderer: TileRenderer<ElevationParams, Patch | null> = {
  load,
  draw(context, patch, _coords, _params, ratio) {
    drawRamped(context, patch, palette().elevation, ratio);
  },
};
