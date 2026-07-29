import { setBaseUrl } from "./base-url";
import { commercialRenderer } from "./commercial";
import { linesRenderer } from "./lines";
import { poiRenderer } from "./poi";
import type { DoneMessage, DrawMessage, ToWorker } from "./protocol";
import type { TileRenderer } from "./renderer";
import { shadeRenderer, warm as warmShade } from "./shade";
import { streetScoreRenderer } from "./street-score";
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
    context.scale(ratio, ratio);
    renderer.draw(context, data, coords, params, ratio);
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
    case "poi":
      return run(poiRenderer, params, message);
    case "tree-dots":
      return run(treeDotsRenderer, params, message);
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
  } else if (message.type === "cancel") {
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
