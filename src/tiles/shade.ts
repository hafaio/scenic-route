import { resolveUrl } from "./base-url";
import type { ShadeParams, ShadePrefetchMessage, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";

// The baked building-shadow pyramid, magnified here rather than by the browser. `tiler shade` stops at
// maxNativeZoom; past it Leaflet would hand the native tile to an <img> and stretch it, and each image
// is interpolated on its own — at its border there is no neighbour to sample, so the browser clamps to
// the edge texel and two stretched neighbours disagree along their shared edge, which reads as hard
// seams across the wash. Here the source tile is assembled with its eight neighbours first, so the
// resample has real pixels past every edge, and it runs at "high" quality rather than bilinear.

const TILE_SIZE = 256;

// Source pixels of context carried around the piece being magnified: wide enough for a cubic kernel,
// and off-tile, so a resample that clamps at the cut's own edge clamps outside what the tile shows.
const MARGIN_PX = 4;

// Decoded source tiles held between draws. Sixteen magnified tiles share one source tile and their
// neighbourhoods overlap heavily, so this cache is what keeps the magnified path to roughly one fetch
// per source tile; the cap is generous because it also holds the clock's prefetched bins. Each entry
// is a 256² bitmap, so the cap is ~64 MB — a fraction of what one drawn tile layer per bin cost.
const CACHE_LIMIT = 256;

// The most source tiles one prefetch may warm, leaving the rest of the cache to the bins actually
// being drawn — a prefetch that evicted those would cost more than it saves.
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
  { url, bin }: Pick<ShadeParams, "url" | "bin">,
  zoom: number,
  x: number,
  y: number,
): string {
  return resolveUrl(
    url
      .replace("{bin}", String(bin))
      .replace("{z}", String(zoom))
      .replace("{x}", String(x))
      .replace("{y}", String(y)),
  );
}

async function fetchBitmap(url: string): Promise<ImageBitmap | null> {
  const response = await fetch(url);
  // `tiler shade` skips tiles with no shadow in them, so a 404 means "nothing here", not a failure.
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
export function warm({ url, bins, coords }: ShadePrefetchMessage): void {
  const wanted = bins.flatMap((bin) => coords.map((coord) => ({ bin, coord })));
  for (const { bin, coord } of wanted.slice(0, PREFETCH_LIMIT)) {
    const { x, y, z } = coord;
    release(acquire(tileUrl({ url, bin }, z, x, y)));
  }
}

// The source pixels one tile needs, cut out at their own zoom: `margin` of them on each side lie
// outside the tile, and each covers `scale` tile pixels.
interface ShadePatch {
  patch: OffscreenCanvas;
  margin: number;
  scale: number;
}

// Cut the tile's ground out of the baked pyramid: the source tile it falls in, plus — when the tile
// is finer than anything baked — the ring of neighbours around it, blitted 1:1 into a patch.
async function load(
  params: ShadeParams,
  { x, y, z }: TileCoords,
): Promise<ShadePatch | null> {
  const { maxNativeZoom } = params;
  const magnified = z > maxNativeZoom;
  const sourceZoom = magnified ? maxNativeZoom : z;
  const scale = 2 ** (z - sourceZoom);
  const margin = magnified ? MARGIN_PX : 0;
  const sourceX = Math.floor(x / scale);
  const sourceY = Math.floor(y / scale);

  // Where the tile lands inside its source tile, grown by the margin.
  const span = TILE_SIZE / scale;
  const originX = (x - sourceX * scale) * span - margin;
  const originY = (y - sourceY * scale) * span - margin;
  const size = span + 2 * margin;

  const ring = magnified ? 1 : 0;
  const entries: CacheEntry[] = [];
  for (let row = -ring; row <= ring; row++) {
    for (let column = -ring; column <= ring; column++) {
      entries.push(
        acquire(tileUrl(params, sourceZoom, sourceX + column, sourceY + row)),
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
      return { patch, margin, scale };
    }
  } finally {
    for (const entry of entries) {
      release(entry);
    }
  }
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
