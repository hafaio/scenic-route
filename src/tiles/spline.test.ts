import { expect, test } from "bun:test";
import { type PathSink, splinePath } from "./spline";

// The fit's contract is two things a ferry route depends on and a Catmull-Rom does not give for
// free: it passes through the vertices the feed published, and between two of them it stays inside
// the box they bound. The second is what keeps a route hugging a shoreline off the bank — the
// unlimited fit left that box by up to 72 m over New York's ferry geometry.

interface Span {
  fromX: number;
  fromY: number;
  controlX1: number;
  controlY1: number;
  controlX2: number;
  controlY2: number;
  toX: number;
  toY: number;
}

function fit(xs: readonly number[], ys: readonly number[]): Span[] {
  const spans: Span[] = [];
  let atX = 0;
  let atY = 0;
  const sink: PathSink = {
    moveTo(x, y) {
      atX = x;
      atY = y;
    },
    bezierCurveTo(controlX1, controlY1, controlX2, controlY2, x, y) {
      spans.push({
        fromX: atX,
        fromY: atY,
        controlX1,
        controlY1,
        controlX2,
        controlY2,
        toX: x,
        toY: y,
      });
      atX = x;
      atY = y;
    },
  };
  splinePath(sink, xs, ys);
  return spans;
}

function pointAt(span: Span, at: number): { x: number; y: number } {
  const rest = 1 - at;
  return {
    x:
      rest ** 3 * span.fromX +
      3 * rest * rest * at * span.controlX1 +
      3 * rest * at * at * span.controlX2 +
      at ** 3 * span.toX,
    y:
      rest ** 3 * span.fromY +
      3 * rest * rest * at * span.controlY1 +
      3 * rest * at * at * span.controlY2 +
      at ** 3 * span.toY,
  };
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
    // Wildly uneven spans, which is what a GTFS shape looks like and where a spline misbehaves.
    x += next() * 300 - 100;
    y += next() * 300 - 100;
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

test("no span leaves the box its own endpoints bound", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { xs, ys } = walk(12, seed);
    for (const span of fit(xs, ys)) {
      const minX = Math.min(span.fromX, span.toX);
      const maxX = Math.max(span.fromX, span.toX);
      const minY = Math.min(span.fromY, span.toY);
      const maxY = Math.max(span.fromY, span.toY);
      for (let step = 0; step <= 32; step++) {
        const { x, y } = pointAt(span, step / 32);
        expect(x).toBeGreaterThanOrEqual(minX - 1e-9);
        expect(x).toBeLessThanOrEqual(maxX + 1e-9);
        expect(y).toBeGreaterThanOrEqual(minY - 1e-9);
        expect(y).toBeLessThanOrEqual(maxY + 1e-9);
      }
    }
  }
});

test("the curve still runs through every vertex the source published", () => {
  const { xs, ys } = walk(9, 7);
  const spans = fit(xs, ys);
  expect(spans).toHaveLength(xs.length - 1);
  expect(spans[0].fromX).toBeCloseTo(xs[0], 9);
  expect(spans[0].fromY).toBeCloseTo(ys[0], 9);
  for (const [index, span] of spans.entries()) {
    expect(span.toX).toBeCloseTo(xs[index + 1], 9);
    expect(span.toY).toBeCloseTo(ys[index + 1], 9);
  }
});

test("a straight run is still drawn straight", () => {
  const xs = [0, 10, 20, 30];
  const ys = [0, 0, 0, 0];
  for (const span of fit(xs, ys)) {
    for (let step = 0; step <= 8; step++) {
      expect(pointAt(span, step / 8).y).toBeCloseTo(0, 9);
    }
  }
});
