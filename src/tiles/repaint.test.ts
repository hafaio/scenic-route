import { expect, test } from "bun:test";
import { repaintOnRestore, repeatable } from "./repaint";

// bun's test environment has neither HTMLCanvasElement nor OffscreenCanvas, and the contract under
// test is entirely the event pair, so an EventTarget stands in for both.
class FakeCanvas extends EventTarget {}

function lose(canvas: FakeCanvas): Event {
  const event = new Event("contextlost", { cancelable: true });
  canvas.dispatchEvent(event);
  return event;
}

function restore(canvas: FakeCanvas): void {
  canvas.dispatchEvent(new Event("contextrestored"));
}

test("a restored context paints the tile again", () => {
  const canvas = new FakeCanvas();
  let paints = 0;
  repaintOnRestore(canvas as never, () => {
    paints += 1;
  });

  expect(paints).toBe(0);
  restore(canvas);
  expect(paints).toBe(1);
  restore(canvas);
  expect(paints).toBe(2);
});

// An uncancelled loss is permanent — the restore never comes and the tile stays blank. This is the
// only reason the loss is listened for at all.
test("the loss is cancelled, so the pixels can come back", () => {
  const canvas = new FakeCanvas();
  repaintOnRestore(canvas as never, () => undefined);

  expect(lose(canvas).defaultPrevented).toBe(true);
});

// The listener holds the canvas and the tile's decoded data, so a watcher that outlived its tile
// would be a leak that grows with every pan.
test("detaching stops the watch", () => {
  const canvas = new FakeCanvas();
  let paints = 0;
  const detach = repaintOnRestore(canvas as never, () => {
    paints += 1;
  });

  restore(canvas);
  detach();
  restore(canvas);

  expect(paints).toBe(1);
  expect(lose(canvas).defaultPrevented).toBe(false);
});

// A repaint runs against the context the previous draw left behind: the scale would otherwise
// compound, and every state a renderer set would still be in force.
test("a repeatable paint starts from the same state every time", () => {
  const calls: string[] = [];
  let scale = 1;
  let alpha = 1;
  const context = {
    reset() {
      calls.push("reset");
      scale = 1;
      alpha = 1;
    },
    scale(x: number) {
      calls.push(`scale ${x}`);
      scale *= x;
    },
  };
  const paint = repeatable(context as never, 2, (target) => {
    calls.push(`draw at ${scale}, alpha ${alpha}`);
    // A renderer is free to leave state behind; the next paint must not inherit it.
    (target as unknown as { scale(x: number): void }).scale(3);
    alpha = 0.5;
  });

  paint();
  paint();

  expect(calls).toEqual([
    "reset",
    "scale 2",
    "draw at 2, alpha 1",
    "scale 3",
    "reset",
    "scale 2",
    "draw at 2, alpha 1",
    "scale 3",
  ]);
});
