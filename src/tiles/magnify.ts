import { resolveUrl } from "./base-url";
import type { TileCoords } from "./protocol";

// Magnifying a baked tile pyramid in the worker rather than leaving it to the browser. A pyramid stops
// at its finest baked level; past that Leaflet would hand the native tile to an <img> and stretch it,
// and each image is interpolated on its own — at its border there is no neighbour to sample, so the
// browser clamps to the edge texel and two stretched neighbours disagree along their shared edge, which
// reads as a seam. Here the source tile is assembled with its eight neighbours first, so the resample
// has real pixels past every edge, and it runs at "high" quality rather than bilinear.
//
// Both baked overlays magnify through this: the shade wash (src/tiles/shade.ts), which composites two
// pyramids into the patch before drawing it, and the canopy fill (src/tiles/canopy.ts), which draws one
// straight.

const TILE_SIZE = 256;

// Source pixels of context carried around the piece being magnified: wide enough for a cubic kernel,
// and off-tile, so a resample that clamps at the cut's own edge clamps outside what the tile shows.
const MARGIN_PX = 4;

// Decoded source tiles held between draws, from every pyramid read here. Sixteen magnified tiles share
// one source tile and their neighbourhoods overlap heavily, so this cache is what keeps the magnified
// path to roughly one fetch per source tile; the cap is generous because it also holds the clock's
// prefetched shade bins. Each entry is a 256² bitmap, so the cap is ~64 MB — a fraction of what one
// drawn tile layer per bin cost.
const CACHE_LIMIT = 256;

// A source tile, or why there is not one. The two reasons are not interchangeable: ABSENT is a fact
// about the deploy — the pyramids are sparse, and neither is baked outside its city — while FAILED is
// a fact about the network. Collapsing them, which this used to do, leaves an overlay that drew
// nothing looking exactly like an overlay with nothing to draw.
export type Source =
  | { bitmap: ImageBitmap }
  | { bitmap: null; failed: boolean };

// A cached source tile. `users` counts the draws still assembling from it, so an entry evicted while
// one is mid-flight is closed only once that draw has let go of it.
export interface CacheEntry {
  source: Promise<Source>;
  users: number;
  evicted: boolean;
}

const cache = new Map<string, CacheEntry>();

// One tile of a pyramid, from a {z}/{x}/{y} template.
export function tileUrl(
  template: string,
  zoom: number,
  x: number,
  y: number,
): string {
  return resolveUrl(
    template
      .replace("{z}", String(zoom))
      .replace("{x}", String(x))
      .replace("{y}", String(y)),
  );
}

async function fetchBitmap(url: string): Promise<Source> {
  const response = await fetch(url);
  // The pyramids are sparse — the shade pass skips tiles with no shadow in them, and neither pyramid is
  // baked outside its city — so a 404 means "nothing here", not a failure.
  if (!response.ok) {
    return { bitmap: null, failed: false };
  } else {
    return { bitmap: await createImageBitmap(await response.blob()) };
  }
}

function dispose(entry: CacheEntry): void {
  if (entry.evicted && entry.users === 0) {
    void entry.source.then((source) => source.bitmap?.close());
  }
}

export function release(entry: CacheEntry): void {
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

export function acquire(url: string): CacheEntry {
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
      source: fetchBitmap(url).catch((): Source => {
        cache.delete(url);
        return { bitmap: null, failed: true };
      }),
    };
    cache.set(url, entry);
    prune();
    return entry;
  }
}

// The source pixels one tile needs, cut out at their own zoom: `margin` of them on each side lie
// outside the tile, and each covers `scale` tile pixels.
export interface Patch {
  patch: OffscreenCanvas;
  margin: number;
  scale: number;
}

// Which source pixels a tile is cut from: the source tile it falls in, the ring of neighbours around
// that when the tile is finer than anything baked, and where inside them its own pixels start. One cut
// serves any number of pyramids over the same ground, since they share a plan.
export interface Cut {
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

export function cutFor(maxNativeZoom: number, { x, y, z }: TileCoords): Cut {
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

// The tile's ground cut out of one pyramid, and whether anything it wanted failed to arrive. A null
// patch with `failed` false is a pyramid with nothing over this ground; with `failed` true it is a
// pyramid this device could not reach, which is a different thing to say and is said differently.
export interface Assembled {
  patch: OffscreenCanvas | null;
  failed: boolean;
}

// Cut the tile's ground out of one baked pyramid, blitted 1:1 into a patch.
export async function assemble(template: string, cut: Cut): Promise<Assembled> {
  const { sourceZoom, sourceX, sourceY, originX, originY, size, ring } = cut;
  const entries: CacheEntry[] = [];
  for (let row = -ring; row <= ring; row++) {
    for (let column = -ring; column <= ring; column++) {
      entries.push(
        acquire(tileUrl(template, sourceZoom, sourceX + column, sourceY + row)),
      );
    }
  }

  try {
    const sources = await Promise.all(entries.map((entry) => entry.source));
    const failed = sources.some(
      (source) => source.bitmap === null && source.failed,
    );
    const patch = new OffscreenCanvas(size, size);
    const context = patch.getContext("2d");
    if (!context || sources.every((source) => source.bitmap === null)) {
      return { patch: null, failed };
    } else {
      context.imageSmoothingEnabled = false; // integer 1:1 blits, nothing to interpolate
      for (const [index, { bitmap }] of sources.entries()) {
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
      return { patch, failed };
    }
  } finally {
    for (const entry of entries) {
      release(entry);
    }
  }
}

// One resample, from the assembled patch straight to the tile's device pixels. The margin is drawn
// too — off the tile, where it only feeds the filter.
export function draw(
  context: OffscreenCanvasRenderingContext2D,
  source: Patch | null,
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
