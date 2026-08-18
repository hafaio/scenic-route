// A Catmull-Rom spline through a polyline's own vertices, emitted as cubic beziers.
//
// Ferry geometry is coarse — a GTFS crossing is 4 to 12 vertices for a kilometre of water — so
// stroked as chords it reads as a polygon rather than a boat's path. A spline that interpolates
// the vertices (rather than approximating them, as a B-spline would) keeps the drawn line on the
// piers and the shape points the feed actually published.
//
// The parameterization is centripetal (alpha = 1/2, Yuksel et al. 2011): ferry vertices are spaced
// wildly unevenly — a stop, then a shape point a kilometre on — and the uniform variant loops and
// cusps exactly there, while centripetal is proven not to self-intersect within a span.
//
// Centripetal keeps the curve from looping but not from *bulging*: it interpolates the vertices and
// is free to leave the box they bound in between, which on a route hugging a shoreline is a bulge
// onto land. Over New York's ferry geometry the unlimited fit left its span's own box by up to 72 m,
// with 2.5% of the curve more than 20 m outside — enough to beach the East River route on the
// Brooklyn bank between two shape points. So each span's tangents are limited (see `monotone`) until
// the curve cannot leave that box at all.

const ALPHA = 0.5;
// A knot spacing floor, so a repeated vertex cannot divide by zero. Well under a pixel at any zoom
// the layer draws, so it never moves a curve that is not already degenerate.
const MIN_KNOT = 1e-6;
// Vertices this close to their predecessor are dropped before fitting. A GTFS crossing repeats its
// terminal as both the stop and the shape's first point, metres apart or less, and a pair that
// close carries no shape but does swing the tangent that runs through it.
const MIN_GAP_PX = 0.25;
// Past this much course change a vertex is drawn as a corner, not smoothed through. Ferry shapes
// are not all gentle: 28 of the 127 turns in New York's ferry geometry exceed 90°, six of them
// within 20° of a full reversal, because the shape follows the boat backing out of its slip. Fitted
// through, a reversal like that becomes a wide loop over the pier it is supposed to end at.
const MIN_SMOOTH_COSINE = Math.cos((90 * Math.PI) / 180);

// The subset of the canvas path API the fit issues, so a test can record the curve rather than
// rasterize it.
export interface PathSink {
  moveTo(x: number, y: number): void;
  bezierCurveTo(
    controlX1: number,
    controlY1: number,
    controlX2: number,
    controlY2: number,
    x: number,
    y: number,
  ): void;
}

function knot(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.max(Math.hypot(toX - fromX, toY - fromY) ** ALPHA, MIN_KNOT);
}

// The Fritsch–Carlson limit (1980) on one axis of one span: the largest pair of end tangents that
// still leaves the cubic Hermite monotone across it. Applied to both axes, the curve is monotone in
// x and in y, so it stays inside the rectangle its two endpoints bound — it can bow, but only within
// the span it belongs to, and it still passes through both published vertices.
//
// A tangent pointing back across the secant is zeroed (it would leave the interval immediately);
// past the circle of radius 3 in secants both are scaled down together. Only where a span reverses
// in one axis does that shorten the tangent enough to turn it, which is exactly the local extremum
// the bulge sat on; elsewhere nothing binds and the fit is the plain centripetal one.
//
// This is the limiter rather than densifying with extra control points because the bulge is not a
// missing-detail problem: more points would each need the same guarantee, and every one of them
// would be a position the feed never published sitting on a map that is otherwise only measurements.
function monotone(
  secant: number,
  startTangent: number,
  endTangent: number,
): [number, number] {
  if (secant === 0) {
    return [0, 0];
  } else {
    const start = Math.max(startTangent / secant, 0);
    const end = Math.max(endTangent / secant, 0);
    const reach = Math.hypot(start, end);
    const shrink = reach > 3 ? 3 / reach : 1;
    return [start * shrink * secant, end * shrink * secant];
  }
}

// One smooth run, vertices `from` through `to` of (xs, ys). The run's own ends are reflected
// through, which starts and finishes it straight along its first and last chord — so a corner
// between two runs stays a corner.
function runPath(
  sink: PathSink,
  xs: readonly number[],
  ys: readonly number[],
  from: number,
  to: number,
): void {
  for (let span = from; span < to; span++) {
    const beforeX = span > from ? xs[span - 1] : 2 * xs[from] - xs[from + 1];
    const beforeY = span > from ? ys[span - 1] : 2 * ys[from] - ys[from + 1];
    const startX = xs[span];
    const startY = ys[span];
    const endX = xs[span + 1];
    const endY = ys[span + 1];
    const afterX = span + 2 <= to ? xs[span + 2] : 2 * endX - startX;
    const afterY = span + 2 <= to ? ys[span + 2] : 2 * endY - startY;

    const beforeKnot = knot(beforeX, beforeY, startX, startY);
    const spanKnot = knot(startX, startY, endX, endY);
    const afterKnot = knot(endX, endY, afterX, afterY);

    // Barry-Goldman's non-uniform Catmull-Rom tangents, scaled into the span's own parameter range
    // and thirded, which is a cubic Hermite segment's bezier hull.
    const startTangentX =
      ((startX - beforeX) / beforeKnot -
        (endX - beforeX) / (beforeKnot + spanKnot) +
        (endX - startX) / spanKnot) *
      spanKnot;
    const startTangentY =
      ((startY - beforeY) / beforeKnot -
        (endY - beforeY) / (beforeKnot + spanKnot) +
        (endY - startY) / spanKnot) *
      spanKnot;
    const endTangentX =
      ((endX - startX) / spanKnot -
        (afterX - startX) / (spanKnot + afterKnot) +
        (afterX - endX) / afterKnot) *
      spanKnot;
    const endTangentY =
      ((endY - startY) / spanKnot -
        (afterY - startY) / (spanKnot + afterKnot) +
        (afterY - endY) / afterKnot) *
      spanKnot;

    const [limitedStartX, limitedEndX] = monotone(
      endX - startX,
      startTangentX,
      endTangentX,
    );
    const [limitedStartY, limitedEndY] = monotone(
      endY - startY,
      startTangentY,
      endTangentY,
    );
    sink.bezierCurveTo(
      startX + limitedStartX / 3,
      startY + limitedStartY / 3,
      endX - limitedEndX / 3,
      endY - limitedEndY / 3,
      endX,
      endY,
    );
  }
}

// Appends the smoothed path through (xs, ys) to `sink`, without beginning or stroking it. The
// caller passes the whole polyline: every control point is a function of four consecutive
// vertices, so a tile that fitted only its own clipped piece would kink at the seam.
export function splinePath(
  sink: PathSink,
  xs: readonly number[],
  ys: readonly number[],
): void {
  const count = Math.min(xs.length, ys.length);
  const keptX: number[] = [];
  const keptY: number[] = [];
  for (let vertex = 0; vertex < count; vertex++) {
    const last = keptX.length - 1;
    if (
      last < 0 ||
      Math.hypot(xs[vertex] - keptX[last], ys[vertex] - keptY[last]) >
        MIN_GAP_PX
    ) {
      keptX.push(xs[vertex]);
      keptY.push(ys[vertex]);
    }
  }
  if (keptX.length === 0) {
    return;
  } else {
    sink.moveTo(keptX[0], keptY[0]);
    let from = 0;
    for (let vertex = 1; vertex + 1 < keptX.length; vertex++) {
      const inX = keptX[vertex] - keptX[vertex - 1];
      const inY = keptY[vertex] - keptY[vertex - 1];
      const outX = keptX[vertex + 1] - keptX[vertex];
      const outY = keptY[vertex + 1] - keptY[vertex];
      const straightness =
        (inX * outX + inY * outY) /
        (Math.hypot(inX, inY) * Math.hypot(outX, outY));
      if (straightness < MIN_SMOOTH_COSINE) {
        runPath(sink, keptX, keptY, from, vertex);
        from = vertex;
      }
    }
    runPath(sink, keptX, keptY, from, keptX.length - 1);
  }
}
