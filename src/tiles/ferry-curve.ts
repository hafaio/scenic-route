// Rounding the corners of a ferry route, which is a different problem from curving a subway line and
// so is deliberately not the same code.
//
// A ferry shape is a handful of vertices over kilometres: a crossing, a turn at a pier, a run down
// the river. Its corners are real corners with long straights between them, so a fillet — walk back
// along the way in, forward along the way out, join the two — leaves every straight exactly on the
// published line and bends only at the corner. That is what ../tiles/spline does NOT do: it fits a
// curve through every vertex and moves the whole path, which bowed a route's out-and-back legs to a
// pier apart into a lens and made routes sharing water appear to twist around each other.
//
// The subway keeps the spline, and must: its lines are 54,906 vertices metres apart, where a curve is
// a bend spread over many of them rather than a corner between two straights. Clamping a fillet to
// segments that short rounds nothing and leaves the map angular — which is exactly what happened when
// this was tried in the shared module.

// Rounded corners on a polyline, emitted as line segments and cubic beziers.
// Ferry geometry is coarse — a GTFS crossing is 4 to 12 vertices for a kilometre of water — so
// stroked as chords it reads as a polygon rather than a boat's path. Softening it is a corner
// problem, not a curve-fitting one: what looks wrong is the angle at each vertex, not the straight
// run between two of them.

const RADIUS_PX = 14;
// A corner may eat no more than half of either segment it sits on, so two corners sharing a short
// segment meet at its midpoint at worst — they can never overshoot each other and fold the line back
// on itself.
const MAX_SEGMENT_FRACTION = 0.5;
// Vertices this close to their predecessor are dropped. A GTFS crossing repeats its terminal as both
// the stop and the shape's first point, metres apart or less, and a pair that close is a direction
// read off nothing but rounding error.
const MIN_GAP_PX = 0.25;
// Corners whose fillet would pull the line less than this off the vertex are drawn as a plain
// segment: below a twentieth of a pixel there is nothing to see, and it keeps a straight run a
// single `lineTo`.
const MIN_CUT_PX = 0.05;
// A quadratic bezier's control points as a cubic's: both controls two thirds of the way from their
// own end to the quadratic's single control point. Exact, not an approximation — it is the same
// curve, written in the form the sink takes.
const QUADRATIC_AS_CUBIC = 2 / 3;

// The subset of the canvas path API the rounding issues, so a test can record the path rather than
// rasterize it.
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    controlX1: number,
    controlY1: number,
    controlX2: number,
    controlY2: number,
    x: number,
    y: number,
  ): void;
}

// Appends the rounded path through (xs, ys) to `sink`, without beginning or stroking it. The caller
// passes the whole polyline: a corner is rounded using the segments either side of it, so a tile
// that clipped first would round the seam vertices against a direction the line does not have.
export function roundedPath(
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
    for (let vertex = 1; vertex + 1 < keptX.length; vertex++) {
      const inX = keptX[vertex] - keptX[vertex - 1];
      const inY = keptY[vertex] - keptY[vertex - 1];
      const outX = keptX[vertex + 1] - keptX[vertex];
      const outY = keptY[vertex + 1] - keptY[vertex];
      const inLength = Math.hypot(inX, inY);
      const outLength = Math.hypot(outX, outY);
      const trim = Math.min(
        RADIUS_PX,
        inLength * MAX_SEGMENT_FRACTION,
        outLength * MAX_SEGMENT_FRACTION,
      );
      const enterX = keptX[vertex] - (inX / inLength) * trim;
      const enterY = keptY[vertex] - (inY / inLength) * trim;
      const leaveX = keptX[vertex] + (outX / outLength) * trim;
      const leaveY = keptY[vertex] + (outY / outLength) * trim;
      // How far the curve's midpoint falls short of the vertex, which is how much of the corner the
      // rounding actually takes off: nothing on a straight, trim/2 on a full reversal. It is why a
      // hairpin needs no special case — the same fillet on a 170° turn is simply a tight one, and it
      // stays inside the corner rather than looping past it, which is what the old fit did over the
      // slips the ferry shapes back into.
      const cut =
        Math.hypot(
          enterX + leaveX - 2 * keptX[vertex],
          enterY + leaveY - 2 * keptY[vertex],
        ) / 4;
      if (cut >= MIN_CUT_PX) {
        sink.lineTo(enterX, enterY);
        sink.bezierCurveTo(
          enterX + (keptX[vertex] - enterX) * QUADRATIC_AS_CUBIC,
          enterY + (keptY[vertex] - enterY) * QUADRATIC_AS_CUBIC,
          leaveX + (keptX[vertex] - leaveX) * QUADRATIC_AS_CUBIC,
          leaveY + (keptY[vertex] - leaveY) * QUADRATIC_AS_CUBIC,
          leaveX,
          leaveY,
        );
      }
    }
    sink.lineTo(keptX[keptX.length - 1], keptY[keptY.length - 1]);
  }
}

// The most the drawn path can sit off the polyline it was given, in pixels: a fillet's furthest point
// from its own two segments is trim·sin(turn)/4, worst at a right angle — a sharper corner cuts more
// off the vertex but hugs the segments closer on the way past — plus the near-duplicate drop, since a
// vertex left out is up to that far off the line drawn past it. 3.75 px at the radius above, and a
// random-walk sweep of 500 polylines reaches 3.56 of it.
//
// Exported for the test that pins it, and for a caller weighing the rounding against the 2 px it
// strokes.
export const MAX_ROUNDING_PX = RADIUS_PX / 4 + MIN_GAP_PX;
