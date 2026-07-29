import { resolveUrl } from "./base-url";
import type { ShadeParams, ShadePrefetchMessage, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";

// The baked shade pyramids, magnified here rather than by the browser and composited here rather than
// stacked. `tiler shade` stops at maxNativeZoom; past it Leaflet would hand the native tile to an <img>
// and stretch it, and each image is interpolated on its own — at its border there is no neighbour to
// sample, so the browser clamps to the edge texel and two stretched neighbours disagree along their
// shared edge, which reads as hard seams across the wash. Here the source tile is assembled with its
// eight neighbours first, so the resample has real pixels past every edge, and it runs at "high"
// quality rather than bilinear.
//
// Building shadows and tree shadows are baked as two pyramids over the same ground, and both are read
// here so the one shade layer can composite them per pixel. Two Leaflet layers would source-over
// instead, which is the wrong arithmetic on baked alphas (see `compositeAlpha`).

const TILE_SIZE = 256;

// Keep in sync with MAX_SHADE_ALPHA in crates/tiler/src/shade.rs. Both pyramids bake alpha as
// MAX_SHADE_ALPHA * intensity * fraction; undoing that scale is what recovers the shaded fractions the
// composite multiplies.
const MAX_SHADE_ALPHA = 190;

// Source pixels of context carried around the piece being magnified: wide enough for a cubic kernel,
// and off-tile, so a resample that clamps at the cut's own edge clamps outside what the tile shows.
const MARGIN_PX = 4;

// Decoded source tiles held between draws, from both pyramids. Sixteen magnified tiles share one
// source tile and their neighbourhoods overlap heavily, so this cache is what keeps the magnified path
// to roughly one fetch per source tile; the cap is generous because it also holds the clock's
// prefetched bins. Each entry is a 256² bitmap, so the cap is ~64 MB — a fraction of what one drawn
// tile layer per bin cost.
const CACHE_LIMIT = 256;

// The most source tiles one prefetch may warm, leaving the rest of the cache to the bins actually
// being drawn — a prefetch that evicted those would cost more than it saves. A bin's ground costs two
// of them once the tree pyramid is there, since a draw needs both to composite.
const PREFETCH_LIMIT = 192;

// A cached source tile. `users` counts the draws still assembling from it, so an entry evicted while
// one is mid-flight is closed only once that draw has let go of it.
interface CacheEntry {
  bitmap: Promise<ImageBitmap | null>;
  users: number;
  evicted: boolean;
}

const cache = new Map<string, CacheEntry>();

function tileUrl(
  template: string,
  bin: number,
  zoom: number,
  x: number,
  y: number,
): string {
  return resolveUrl(
    template
      .replace("{bin}", String(bin))
      .replace("{z}", String(zoom))
      .replace("{x}", String(x))
      .replace("{y}", String(y)),
  );
}

async function fetchBitmap(url: string): Promise<ImageBitmap | null> {
  const response = await fetch(url);
  // `tiler shade` skips tiles with no shadow in them — and skips the tree pyramid entirely when no
  // canopy heights were baked — so a 404 means "nothing here", not a failure.
  if (!response.ok) {
    return null;
  } else {
    return createImageBitmap(await response.blob());
  }
}

function dispose(entry: CacheEntry): void {
  if (entry.evicted && entry.users === 0) {
    void entry.bitmap.then((bitmap) => bitmap?.close());
  }
}

function release(entry: CacheEntry): void {
  entry.users -= 1;
  dispose(entry);
}

function prune(): void {
  while (cache.size > CACHE_LIMIT) {
    const [oldest] = cache.keys();
    const entry = cache.get(oldest);
    cache.delete(oldest);
    if (entry) {
      entry.evicted = true;
      dispose(entry);
    }
  }
}

function acquire(url: string): CacheEntry {
  const cached = cache.get(url);
  if (cached) {
    // Map iterates in insertion order, so re-inserting is what makes the eviction above an LRU.
    cache.delete(url);
    cache.set(url, cached);
    cached.users += 1;
    return cached;
  } else {
    const entry: CacheEntry = {
      users: 1,
      evicted: false,
      // A transient fetch failure draws as nothing but is dropped rather than cached, so the next
      // tile over the same ground tries again.
      bitmap: fetchBitmap(url).catch(() => {
        cache.delete(url);
        return null;
      }),
    };
    cache.set(url, entry);
    prune();
    return entry;
  }
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
      release(acquire(tileUrl(template, bin, z, x, y)));
    }
  }
}

// The source pixels one tile needs, cut out at their own zoom: `margin` of them on each side lie
// outside the tile, and each covers `scale` tile pixels.
interface ShadePatch {
  patch: OffscreenCanvas;
  margin: number;
  scale: number;
}

// Which source pixels a tile is cut from: the source tile it falls in, the ring of neighbours around
// that when the tile is finer than anything baked, and where inside them its own pixels start. One cut
// serves both pyramids, since they share a plan.
interface Cut {
  sourceZoom: number;
  sourceX: number;
  sourceY: number;
  originX: number;
  originY: number;
  size: number;
  ring: number;
  margin: number;
  scale: number;
}

function cutFor({ maxNativeZoom }: ShadeParams, { x, y, z }: TileCoords): Cut {
  const magnified = z > maxNativeZoom;
  const sourceZoom = magnified ? maxNativeZoom : z;
  const scale = 2 ** (z - sourceZoom);
  const margin = magnified ? MARGIN_PX : 0;
  const sourceX = Math.floor(x / scale);
  const sourceY = Math.floor(y / scale);
  const span = TILE_SIZE / scale;
  return {
    sourceZoom,
    sourceX,
    sourceY,
    // Where the tile lands inside its source tile, grown by the margin.
    originX: (x - sourceX * scale) * span - margin,
    originY: (y - sourceY * scale) * span - margin,
    size: span + 2 * margin,
    ring: magnified ? 1 : 0,
    margin,
    scale,
  };
}

// Cut the tile's ground out of one baked pyramid, blitted 1:1 into a patch. Null when every source
// tile it wants is a 404 — that pyramid has nothing over this ground.
async function assemble(
  template: string,
  bin: number,
  cut: Cut,
): Promise<OffscreenCanvas | null> {
  const { sourceZoom, sourceX, sourceY, originX, originY, size, ring } = cut;
  const entries: CacheEntry[] = [];
  for (let row = -ring; row <= ring; row++) {
    for (let column = -ring; column <= ring; column++) {
      entries.push(
        acquire(
          tileUrl(template, bin, sourceZoom, sourceX + column, sourceY + row),
        ),
      );
    }
  }

  try {
    const bitmaps = await Promise.all(entries.map((entry) => entry.bitmap));
    const patch = new OffscreenCanvas(size, size);
    const context = patch.getContext("2d");
    if (!context || bitmaps.every((bitmap) => bitmap === null)) {
      return null;
    } else {
      context.imageSmoothingEnabled = false; // integer 1:1 blits, nothing to interpolate
      for (const [index, bitmap] of bitmaps.entries()) {
        if (bitmap) {
          const column = (index % (2 * ring + 1)) - ring;
          const row = Math.floor(index / (2 * ring + 1)) - ring;
          context.drawImage(
            bitmap,
            column * TILE_SIZE - originX,
            row * TILE_SIZE - originY,
          );
        }
      }
      return patch;
    }
  } finally {
    for (const entry of entries) {
      release(entry);
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

// The tile's source pixels: both pyramids cut out of the same ground and composited into one patch.
async function load(
  params: ShadeParams,
  coords: TileCoords,
): Promise<ShadePatch | null> {
  const cut = cutFor(params, coords);
  const [buildings, trees] = await Promise.all([
    assemble(params.url, params.bin, cut),
    assemble(params.treeUrl, params.bin, cut),
  ]);
  const patch = merge(buildings, trees, cut, params);
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

// One resample, from the assembled patch straight to the tile's device pixels. The margin is drawn
// too — off the tile, where it only feeds the filter.
function draw(
  context: OffscreenCanvasRenderingContext2D,
  source: ShadePatch | null,
): void {
  if (source) {
    const { patch, margin, scale } = source;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const offset = -margin * scale;
    context.drawImage(
      patch,
      offset,
      offset,
      patch.width * scale,
      patch.height * scale,
    );
  }
}

export const shadeRenderer: TileRenderer<ShadeParams, ShadePatch | null> = {
  load,
  draw,
};
