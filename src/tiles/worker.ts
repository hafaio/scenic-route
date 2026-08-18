import { setBaseUrl } from "./base-url";
import { canopyRenderer } from "./canopy";
import { commercialRenderer } from "./commercial";
import { linesRenderer } from "./lines";
import { poiRenderer } from "./poi";
import type { DoneMessage, DrawMessage, ToWorker } from "./protocol";
import type { TileRenderer } from "./renderer";
import { repaintOnRestore, repeatable } from "./repaint";
import { shadeRenderer, warm as warmShade } from "./shade";
import { streetScoreRenderer } from "./street-score";
import { subwayRenderer } from "./subway";
import { setShedDecks } from "./sweep";
import { treeDotsRenderer } from "./tree-dots";

// The tile rasterizer. Projecting every street vertex, tree or POI in a tile and issuing the canvas
// ops for it is the single heaviest thing the map does, and on the main thread it lands squarely in
// the frames a pan or a pinch needs. Here it runs off-thread against an OffscreenCanvas the layer
// transferred over, so the compositor keeps the transferred canvas up to date on its own.
//
// Everything the draws need beyond their own binary data arrives in the messages: there is no map,
// no DOM, and no access to the app's stores from in here.

// `self` types as a Window under the app's dom lib, so the worker scope is named through globalThis
// instead of pulling the conflicting webworker lib into the build.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: DoneMessage): void;
};

// Tiles whose data is still loading, and of those the ones Leaflet has since dropped.
const inFlight = new Set<number>();
const cancelled = new Set<number>();
// Painted tiles still on the map, by the detach that stops watching them for a lost context. The
// canvas is the only copy of its pixels and only this side can reach it, so only this side can put
// them back — see ./repaint.
const live = new Map<number, () => void>();

function forget(tileKey: number): void {
  live.get(tileKey)?.();
  live.delete(tileKey);
}

async function run<Params, Data>(
  renderer: TileRenderer<Params, Data>,
  params: Params,
  { tileKey, coords, ratio, canvas }: DrawMessage,
): Promise<void> {
  const data = await renderer.load(params, coords);
  if (cancelled.has(tileKey)) {
    return;
  }
  const context = canvas.getContext("2d");
  if (context) {
    const paint = repeatable(context, ratio, (target) => {
      renderer.draw(target, data, coords, params, ratio);
    });
    // Registered before the first paint, not after: the context can already be lost by the time the
    // data lands, and then this paint draws nothing and the restore is the one that shows the tile.
    live.set(tileKey, repaintOnRestore(canvas, paint));
    paint();
  }
}

function rasterize(message: DrawMessage): Promise<void> {
  const { params } = message;
  switch (params.kind) {
    case "street-score":
      return run(streetScoreRenderer, params, message);
    case "commercial":
      return run(commercialRenderer, params, message);
    case "lines":
      return run(linesRenderer, params, message);
    case "subway":
      return run(subwayRenderer, params, message);
    case "poi":
      return run(poiRenderer, params, message);
    case "tree-dots":
      return run(treeDotsRenderer, params, message);
    case "canopy":
      return run(canopyRenderer, params, message);
    case "shade":
      return run(shadeRenderer, params, message);
  }
}

function finish(tileKey: number, error?: string): void {
  inFlight.delete(tileKey);
  // A dropped tile's canvas is detached and Leaflet has forgotten it, so there is nothing to report.
  if (!cancelled.delete(tileKey)) {
    scope.postMessage({ type: "done", tileKey, error });
  }
}

scope.onmessage = ({ data: message }) => {
  if (message.type === "init") {
    setBaseUrl(message.base);
  } else if (message.type === "shade-prefetch") {
    warmShade(message);
  } else if (message.type === "shed-decks") {
    setShedDecks(message.decks);
  } else if (message.type === "cancel") {
    // Also where a painted tile is released: its watcher holds the canvas and the decoded data, and
    // Leaflet unloads tiles on every pan.
    forget(message.tileKey);
    if (inFlight.has(message.tileKey)) {
      cancelled.add(message.tileKey);
    }
  } else {
    const { tileKey } = message;
    inFlight.add(tileKey);
    rasterize(message).then(
      () => {
        finish(tileKey);
      },
      (error: Error) => {
        finish(tileKey, error.message);
      },
    );
  }
};
