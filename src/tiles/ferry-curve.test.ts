import { expect, test } from "bun:test";
import { MAX_ROUNDING_PX, type PathSink, roundedPath } from "./ferry-curve";

// Rounding's contract is what a fit could not give: the drawn line is the published line except
// within a corner's own neighbourhood, it never reaches past a vertex, and it only ever cuts a
// corner short — so it cannot bow a leg out over the water it shares or onto the bank beside it.

interface Point {
  x: number;
  y: number;
}

// The path the sink was handed, flattened to points: a `lineTo` as its endpoint, a curve as 64
// samples along it, which is dense enough that a fillet's furthest point is measured to well under a
// hundredth of a pixel.
function drawn(xs: readonly number[], ys: readonly number[]): Point[] {
  const points: Point[] = [];
  let atX = 0;
  let atY = 0;
  const sink: PathSink = {
    moveTo(x, y) {
      atX = x;
      atY = y;
      points.push({ x, y });
    },
    lineTo(x, y) {
      atX = x;
      atY = y;
      points.push({ x, y });
    },
    bezierCurveTo(controlX1, controlY1, controlX2, controlY2, x, y) {
      const fromX = atX;
      const fromY = atY;
      for (let step = 1; step <= 64; step++) {
        const at = step / 64;
        const rest = 1 - at;
        points.push({
          x:
            rest ** 3 * fromX +
            3 * rest * rest * at * controlX1 +
            3 * rest * at * at * controlX2 +
            at ** 3 * x,
          y:
            rest ** 3 * fromY +
            3 * rest * rest * at * controlY1 +
            3 * rest * at * at * controlY2 +
            at ** 3 * y,
        });
      }
      atX = x;
      atY = y;
    },
  };
  roundedPath(sink, xs, ys);
  return points;
}

function toSegment(
  { x, y }: Point,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  const alongX = toX - fromX;
  const alongY = toY - fromY;
  const square = alongX * alongX + alongY * alongY;
  const along =
    square === 0
      ? 0
      : Math.min(
          1,
          Math.max(0, ((x - fromX) * alongX + (y - fromY) * alongY) / square),
        );
  return Math.hypot(x - (fromX + alongX * along), y - (fromY + alongY * along));
}

function toPolyline(
  point: Point,
  xs: readonly number[],
  ys: readonly number[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let segment = 0; segment + 1 < xs.length; segment++) {
    nearest = Math.min(
      nearest,
      toSegment(
        point,
        xs[segment],
        ys[segment],
        xs[segment + 1],
        ys[segment + 1],
      ),
    );
  }
  return nearest;
}

function length(points: readonly Point[]): number {
  let total = 0;
  for (let step = 1; step < points.length; step++) {
    total += Math.hypot(
      points[step].x - points[step - 1].x,
      points[step].y - points[step - 1].y,
    );
  }
  return total;
}

// A deterministic pseudo-random walk, so a failure is reproducible.
function walk(count: number, seed: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  let x = 0;
  let y = 0;
  for (let step = 0; step < count; step++) {
    // Wildly uneven spans, and short ones a corner could overrun: a tenth of the turns in New York's
    // ferry file have a segment under a pixel beside them even at z15.
    const span = step % 3 === 0 ? 6 : 300;
    x += next() * span - span / 3;
    y += next() * span - span / 3;
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

test("the drawn path stays within a corner's rounding of the published line", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { xs, ys } = walk(12, seed);
    for (const point of drawn(xs, ys)) {
      expect(toPolyline(point, xs, ys)).toBeLessThanOrEqual(
        MAX_ROUNDING_PX + 1e-9,
      );
    }
  }
});

test("rounding a corner only ever shortens the line", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { xs, ys } = walk(12, seed);
    let published = 0;
    for (let segment = 0; segment + 1 < xs.length; segment++) {
      published += Math.hypot(
        xs[segment + 1] - xs[segment],
        ys[segment + 1] - ys[segment],
      );
    }
    // A fillet is inside the triangle it cuts off, so it is shorter than the two sides it replaces.
    // Anything longer would be a corner overrunning its segment and folding the line back.
    expect(length(drawn(xs, ys))).toBeLessThanOrEqual(published + 1e-9);
  }
});

test("both ends are drawn exactly where the source put them", () => {
  const { xs, ys } = walk(9, 7);
  const points = drawn(xs, ys);
  expect(points[0].x).toBeCloseTo(xs[0], 9);
  expect(points[0].y).toBeCloseTo(ys[0], 9);
  expect(points[points.length - 1].x).toBeCloseTo(xs[xs.length - 1], 9);
  expect(points[points.length - 1].y).toBeCloseTo(ys[ys.length - 1], 9);
});

test("a straight run is drawn as one straight segment", () => {
  const points = drawn([0, 10, 20, 30], [0, 0, 0, 0]);
  expect(points).toEqual([
    { x: 0, y: 0 },
    { x: 30, y: 0 },
  ]);
});

test("a reversal into a slip is rounded, not looped past", () => {
  // 175° back on itself, which is what a ferry shape does backing out of its berth: fitted through,
  // the old spline drew a loop over the pier.
  const turn = (175 * Math.PI) / 180;
  const xs = [0, 400, 400 + 400 * Math.cos(turn)];
  const ys = [0, 0, 400 * Math.sin(turn)];
  for (const point of drawn(xs, ys)) {
    expect(point.x).toBeLessThanOrEqual(400 + 1e-9);
  }
});
