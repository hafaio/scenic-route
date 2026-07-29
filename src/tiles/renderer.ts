import type { TileCoords } from "./protocol";

// One canvas overlay's tile rasterization, split so the worker can drop a tile Leaflet discarded
// while its data was in flight: `load` is the shared, cached fetch+decode, `draw` is the per-tile
// projection and canvas work.
export interface TileRenderer<Params, Data> {
  load(params: Params, coords: TileCoords): Promise<Data>;
  draw(
    context: OffscreenCanvasRenderingContext2D,
    data: Data,
    coords: TileCoords,
    params: Params,
    ratio: number,
  ): void;
}
