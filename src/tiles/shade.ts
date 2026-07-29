import {
  acquire,
  assemble,
  type Cut,
  cutFor,
  draw,
  type Patch,
  release,
  tileUrl,
} from "./magnify";
import type { ShadeParams, ShadePrefetchMessage, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { drawSweep, type SweptGround, sweptGround } from "./sweep";
import { drawSweepGl } from "./sweep-gl";

// The baked shade pyramids, magnified through src/tiles/magnify.ts rather than by the browser and
// composited here rather than stacked.
//
// Building shadows and tree shadows are baked as two pyramids over the same ground, and both are read
// here so the one shade layer can composite them per pixel. Two Leaflet layers would source-over
// instead, which is the wrong arithmetic on baked alphas (see `compositeAlpha`).
//
// From `vectorZoom` the tile is instead SWEPT from the caster chunks (src/tiles/sweep.ts): the same
// shadows at the tile's own resolution, rather than a raster that stopped resolving being enlarged.
// A deploy with no caster chunks falls back here at every zoom.

// Keep in sync with MAX_SHADE_ALPHA in crates/tiler/src/shade.rs. Both pyramids bake alpha as
// MAX_SHADE_ALPHA * intensity * fraction; undoing that scale is what recovers the shaded fractions the
// composite multiplies.
const MAX_SHADE_ALPHA = 190;

// The most source tiles one prefetch may warm, leaving the rest of the cache to the bins actually
// being drawn — a prefetch that evicted those would cost more than it saves. A bin's ground costs two
// of them once the tree pyramid is there, since a draw needs both to composite.
const PREFETCH_LIMIT = 192;

// One bin's pyramid, as a {z}/{x}/{y} template the shared magnifier can read.
function binTemplate(template: string, bin: number): string {
  return template.replace("{bin}", String(bin));
}

// Fetch and decode source tiles ahead of any draw. The entries land with no users, so they stay as
// evictable as any other and the cap still bounds the total; warming stops at the budget, so the
// bins past it are never fetched only to be thrown away.
export function warm({
  url,
  treeUrl,
  bins,
  coords,
}: ShadePrefetchMessage): void {
  const wanted = bins.flatMap((bin) => coords.map((coord) => ({ bin, coord })));
  for (const { bin, coord } of wanted.slice(0, PREFETCH_LIMIT / 2)) {
    const { x, y, z } = coord;
    for (const template of [url, treeUrl]) {
      release(acquire(tileUrl(binTemplate(template, bin), z, x, y)));
    }
  }
}

// One pixel of the two pyramids composited, in their baked alphas: what is left of the light after a
// building AND a crown have had a go at it, `MAX * intensity * (1 - (1 - b)(1 - tau*t))` with the
// baked scale `MAX * intensity` divided back out. Drawing the two as stacked layers would source-over
// them instead, which double-scales the cross term — ~25% too dark where both fall.
export function compositeAlpha(
  buildings: number,
  trees: number,
  tau: number,
  intensity: number,
): number {
  const baked = MAX_SHADE_ALPHA * intensity;
  // A full shadow quantises UP to the alpha lattice, so a baked alpha can land a step above the scale
  // it was baked at; the cross term reads both capped there, or it would over-subtract and leave the
  // composite lighter than the source it started from.
  const both =
    baked > 0
      ? (tau * Math.min(buildings, baked) * Math.min(trees, baked)) / baked
      : 0;
  return Math.min(255, Math.round(buildings + tau * trees - both));
}

// The two patches merged into the one the tile is drawn from. Only alpha carries a shade tile, and
// both pyramids paint the same slate, so the colour is taken from whichever of them painted the pixel.
function merge(
  buildings: OffscreenCanvas | null,
  trees: OffscreenCanvas | null,
  { size }: Cut,
  { tau, intensity }: ShadeParams,
): OffscreenCanvas | null {
  const treeContext = trees?.getContext("2d");
  if (!treeContext) {
    return buildings; // no canopy over this ground: the building patch already is the composite
  }
  const target = buildings ?? new OffscreenCanvas(size, size);
  const context = target.getContext("2d");
  if (!context) {
    return buildings;
  }
  const merged = context.getImageData(0, 0, size, size);
  const canopy = treeContext.getImageData(0, 0, size, size);
  for (let pixel = 0; pixel < merged.data.length; pixel += 4) {
    if (merged.data[pixel + 3] === 0) {
      merged.data[pixel] = canopy.data[pixel];
      merged.data[pixel + 1] = canopy.data[pixel + 1];
      merged.data[pixel + 2] = canopy.data[pixel + 2];
    }
    merged.data[pixel + 3] = compositeAlpha(
      merged.data[pixel + 3],
      canopy.data[pixel + 3],
      tau,
      intensity,
    );
  }
  context.putImageData(merged, 0, 0);
  return target;
}

// Where a tile's shade comes from: the casters it is swept from, or the baked pixels it is cut out of.
type ShadeSource = { swept: SweptGround } | { baked: Patch | null };

// The tile's source pixels: both pyramids cut out of the same ground and composited into one patch.
async function bakedPatch(
  params: ShadeParams,
  coords: TileCoords,
): Promise<Patch | null> {
  const cut = cutFor(params.maxNativeZoom, coords);
  const [buildings, trees] = await Promise.all([
    assemble(binTemplate(params.url, params.bin), cut),
    assemble(binTemplate(params.treeUrl, params.bin), cut),
  ]);
  const patch = merge(buildings, trees, cut, params);
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

async function load(
  params: ShadeParams,
  coords: TileCoords,
): Promise<ShadeSource> {
  if (coords.z >= params.vectorZoom) {
    const swept = await sweptGround(params, coords);
    if (swept) {
      return { swept };
    }
  }
  return { baked: await bakedPatch(params, coords) };
}

export const shadeRenderer: TileRenderer<ShadeParams, ShadeSource> = {
  load,
  draw(context, source, coords, params, ratio) {
    if ("swept" in source) {
      // On the GPU where there is one (src/tiles/sweep-gl.ts), which is an order of magnitude cheaper
      // per tile; the Canvas2D sweep is both the fallback and the reference the GPU path is held to.
      if (!drawSweepGl(context, source.swept, coords, params, ratio)) {
        drawSweep(context, source.swept, coords, params, ratio);
      }
    } else {
      draw(context, source.baked);
    }
  },
};
