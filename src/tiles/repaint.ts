// When the browser reclaims a canvas's backing store the tile keeps its place on the map and its
// loaded flag, so nothing ever asks for it again — and a tile whose control was transferred to the
// worker cannot even be read back to notice. The canvas's own events are the only signal, and
// cancelling the loss is what makes the restore come at all: an uncancelled loss is permanent.
// components/genus-gl-layer.tsx has held the WebGL half of this contract since it was written.

// Returns the detach, which must run when the tile goes away: the listener holds the canvas and the
// tile's decoded data, and Leaflet discards tiles continuously while panning.
export function repaintOnRestore(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  paint: () => void,
): () => void {
  const onLost = (event: Event): void => {
    event.preventDefault();
  };
  canvas.addEventListener("contextlost", onLost);
  canvas.addEventListener("contextrestored", paint);
  return () => {
    canvas.removeEventListener("contextlost", onLost);
    canvas.removeEventListener("contextrestored", paint);
  };
}

// A paint that gives the same picture every time it is run. It cannot just scale and draw the way a
// one-shot paint could: a repaint starts from whatever state the last draw left, so the ratio would
// compound.
export function repeatable<
  Context extends CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
>(
  context: Context,
  ratio: number,
  draw: (context: Context) => void,
): () => void {
  return () => {
    context.reset();
    context.scale(ratio, ratio);
    draw(context);
  };
}
