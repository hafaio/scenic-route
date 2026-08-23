import { expect, test } from "bun:test";
import type L from "leaflet";
import type { OverlayId } from "./registry";
import { unreachableLayers, watchLayerStatus } from "./status";

// The store's whole job is to keep one flapping viewport from flapping the badge, so that is what
// these pin: a load cycle is judged once, at its end, over the errors inside it.

type Handler = () => void;

// Enough of a GridLayer to fire the three events the watcher listens for.
function fakeLayer(): L.GridLayer & { fire: (event: string) => void } {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return this;
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    fire(event: string) {
      for (const handler of handlers.get(event) ?? []) {
        handler();
      }
    },
  } as unknown as L.GridLayer & { fire: (event: string) => void };
}

const reachable = (overlay: OverlayId): boolean =>
  !unreachableLayers().has(overlay);

test("one failed tile among many condemns the whole load cycle", () => {
  const layer = fakeLayer();
  const detach = watchLayerStatus(layer, "historic");

  layer.fire("loading");
  layer.fire("tileload");
  layer.fire("tileerror");
  layer.fire("tileload");
  layer.fire("load");
  expect(reachable("historic")).toBe(false);

  detach();
});

test("the next clean load cycle clears the layer", () => {
  const layer = fakeLayer();
  const detach = watchLayerStatus(layer, "industrial");

  layer.fire("loading");
  layer.fire("tileerror");
  layer.fire("load");
  expect(reachable("industrial")).toBe(false);

  // A pan after the network came back: the error count resets with the cycle, not with the layer.
  layer.fire("loading");
  layer.fire("tileload");
  layer.fire("load");
  expect(reachable("industrial")).toBe(true);

  detach();
});

test("a layer taken off the map reports nothing", () => {
  const layer = fakeLayer();
  const detach = watchLayerStatus(layer, "subway");

  layer.fire("loading");
  layer.fire("tileerror");
  layer.fire("load");
  expect(reachable("subway")).toBe(false);

  // Switched off, or the city changed: neither says the data is still unreachable.
  detach();
  expect(reachable("subway")).toBe(true);
});

// The failure this cost a screenshot to find: "Tree canopy" is a raster pyramid AND a line layer,
// "Tree genus" a WebGL field AND the dots over it. Keyed per overlay, whichever finished last won —
// so a healthy line layer reported the row fine while the raster beside it was failing, and the badge
// never appeared.
test("one failing layer badges the row its healthy sibling shares", () => {
  const raster = fakeLayer();
  const lines = fakeLayer();
  const detachRaster = watchLayerStatus(raster, "canopy");
  const detachLines = watchLayerStatus(lines, "canopy");

  raster.fire("loading");
  raster.fire("tileerror");
  raster.fire("load");
  lines.fire("loading");
  lines.fire("tileload");
  lines.fire("load");
  expect(reachable("canopy")).toBe(false);

  // And clears only once the failing one recovers too.
  raster.fire("loading");
  raster.fire("tileload");
  raster.fire("load");
  expect(reachable("canopy")).toBe(true);

  detachRaster();
  detachLines();
});
