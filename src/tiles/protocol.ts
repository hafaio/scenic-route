// The messages between the map's tile layers and the rasterizing worker. Every canvas overlay that
// projects geometry per tile hands the drawing off across this boundary, so a pan or a pinch never
// waits on it.

export interface TileCoords {
  x: number;
  y: number;
  z: number;
}

// A tile's drawing inputs, per layer kind. Everything the draw reads that is not a module constant
// travels here: the worker has no map, no DOM and no access to the app's stores.
export interface StreetScoreParams {
  kind: "street-score";
}

export interface CommercialParams {
  kind: "commercial";
}

export interface LinesParams {
  kind: "lines";
  url: string;
  format: "hway" | "ferr";
  color: string;
}

export interface PoiParams {
  kind: "poi";
  url: string;
  magic: string;
  color: string;
  labelAnchor: "top" | "bottom";
}

export interface TreeDotsParams {
  kind: "tree-dots";
  file: string;
  // the legend's current selection, snapshotted when the tile is requested
  enabled: number[];
}

export interface ShadeParams {
  kind: "shade";
  url: string; // a {bin}/{z}/{x}/{y} template
  treeUrl: string; // the same template over the tree-shade pyramid, composited into the same layer
  bin: number; // which baked sun-position pyramid to read
  maxNativeZoom: number; // the finest baked level; past it a tile is magnified from that level
  tau: number; // fraction of light the canopy blocks on the picked date; see src/shade/phenology.ts
  intensity: number; // the bin's solar intensity, max(0, sin(elevation)) — what its alphas are scaled by
}

export type TileParams =
  | StreetScoreParams
  | CommercialParams
  | LinesParams
  | PoiParams
  | TreeDotsParams
  | ShadeParams;

// Sent once per worker, before any draw. Data URLs in the layers are relative so they pick up the
// basePath the deploy injects, but a relative URL inside a worker resolves against the worker
// script (under /_next/static/chunks/), so the document's base has to be handed over explicitly.
export interface InitMessage {
  type: "init";
  base: string;
}

export interface DrawMessage {
  type: "draw";
  tileKey: number;
  coords: TileCoords;
  ratio: number; // devicePixelRatio, which does not exist in a worker
  params: TileParams;
  canvas: OffscreenCanvas;
}

// Leaflet dropped the tile before its data arrived; skip the draw rather than paying for a tile
// nobody will see.
export interface CancelMessage {
  type: "cancel";
  tileKey: number;
}

// Decode source tiles into the worker's cache without drawing anything, so a bin the clock is about
// to reach paints straight away. Only the shade pyramid caches source tiles, so this names it rather
// than pretending to be generic.
export interface ShadePrefetchMessage {
  type: "shade-prefetch";
  url: string; // the same {bin}/{z}/{x}/{y} template a draw uses
  treeUrl: string; // and the tree pyramid's, warmed alongside so a scrub composites without a fetch
  bins: number[]; // nearest the picked time first; the tail is dropped if the set will not fit
  coords: TileCoords[]; // the source tiles covering the view, at their baked zoom
}

export type ToWorker =
  | InitMessage
  | DrawMessage
  | CancelMessage
  | ShadePrefetchMessage;

export interface DoneMessage {
  type: "done";
  tileKey: number;
  error?: string;
}
