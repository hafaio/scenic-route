import { expect, test } from "bun:test";
import {
  edgeGrade,
  edgeMultiplier,
  gradeSpeedFactor,
  hillFractionOf,
  type RouteWeights,
  rawSeconds,
  WALK_METERS_PER_SECOND,
} from "./cost";
import type { RoutingGraph } from "./graph";

// Two ways of climbing the same hill over the same distance: all of it in one steep block, or the
// same rise spread evenly. Total height climbed is identical, so anything proportional to height
// scores them the same — which is what the hill penalty used to do.
const REFERENCE_GRADE = 0.12;
const MAX_GRADE = 0.35;

function reliefByte(grade: number): number {
  return Math.round(Math.min(1, grade / MAX_GRADE) * 254);
}

// Four equal-length edges, given per-edge grades.
function stretch(grades: readonly number[], meters: number): RoutingGraph {
  return {
    edgeLength: Float32Array.from(grades, () => meters),
    edgeRelief: Uint8Array.from(grades, reliefByte),
    edgeKindSide: new Uint8Array(grades.length),
    edgeCover: new Uint8Array(grades.length),
    edgeLandmark: new Uint8Array(grades.length),
    edgeArt: new Uint8Array(grades.length),
    edgeHighway: new Uint8Array(grades.length),
    edgeCommercial: new Uint8Array(grades.length),
    shade: null,
    sheds: null,
    ferries: null,
  } as unknown as RoutingGraph;
}

const weights = (hill: number): RouteWeights =>
  ({
    tree: 0,
    ferry: 0,
    landmark: 0,
    art: 0,
    highway: 0,
    hill,
    commercial: 0,
    shade: 0,
    shelter: 0,
    allowFerries: true,
    allowSheds: true,
  }) as RouteWeights;

const BLOCK_METERS = 100;
// Same total rise (0.24 * 100 m = 24 m) over the same 400 m.
const CONCENTRATED = [0, 0, 0, 0.24];
const GRADUAL = [0.06, 0.06, 0.06, 0.06];

function penalty(grades: readonly number[], hill: number): number {
  const graph = stretch(grades, BLOCK_METERS);
  let total = 0;
  for (let edge = 0; edge < grades.length; edge++) {
    total += BLOCK_METERS * edgeMultiplier(graph, edge, weights(hill));
  }
  return total;
}

test("the same climb costs more concentrated into one steep block than spread out", () => {
  expect(penalty(CONCENTRATED, 1)).toBeGreaterThan(penalty(GRADUAL, 1));
  // And it is the shape, not the strength: the gap widens with the weight rather than appearing at
  // some threshold.
  const atOne = penalty(CONCENTRATED, 1) - penalty(GRADUAL, 1);
  const atFour = penalty(CONCENTRATED, 4) - penalty(GRADUAL, 4);
  expect(atFour).toBeGreaterThan(atOne * 3);
});

test("with the hill weight at zero the steep route still takes longer to walk", () => {
  const steep = stretch(CONCENTRATED, BLOCK_METERS);
  const gentle = stretch(GRADUAL, BLOCK_METERS);
  const secondsOf = (graph: RoutingGraph): number => {
    let total = 0;
    for (let edge = 0; edge < 4; edge++) {
      total += rawSeconds(graph, edge, -1);
    }
    return total;
  };
  expect(secondsOf(steep)).toBeGreaterThan(secondsOf(gentle));
});

test("the penalty is the weight itself at the reference grade, and grows quadratically", () => {
  // To one decimal: a grade makes the round trip through a byte, so 12% comes back as 11.94%.
  const graph = stretch([REFERENCE_GRADE, 2 * REFERENCE_GRADE], BLOCK_METERS);
  expect(edgeMultiplier(graph, 0, weights(1))).toBeCloseTo(2, 1); // 1 + 1 * 1^2
  expect(edgeMultiplier(graph, 1, weights(1))).toBeCloseTo(5, 1); // 1 + 1 * 2^2
});

test("a 30% street is told apart from a 12% one rather than both saturating", () => {
  const graph = stretch([0.12, 0.3], BLOCK_METERS);
  expect(edgeGrade(graph, 0)).toBeCloseTo(0.12, 2);
  expect(edgeGrade(graph, 1)).toBeCloseTo(0.3, 2);
  expect(hillFractionOf(graph, 0)).toBeCloseTo(1, 2);
});

test("grade never makes walking faster, which is what keeps the A* bound a bound", () => {
  for (const grade of [0, 0.02, 0.12, 0.3, 0.5]) {
    expect(gradeSpeedFactor(grade)).toBeLessThanOrEqual(1);
    expect(gradeSpeedFactor(grade) * WALK_METERS_PER_SECOND).toBeGreaterThan(0);
  }
  expect(gradeSpeedFactor(0)).toBe(1);
});
