import { expect, test } from "bun:test";
import {
  edgeGrade,
  edgeMultiplier,
  effSeconds,
  gradeSpeedFactor,
  hillFractionOf,
  maxSpeedFactor,
  type RouteWeights,
  rawSeconds,
  WALK_METERS_PER_SECOND,
  walkSecondsCoeff,
  walkSpeedOn,
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

// A chain of equal-length edges, each given how much of its length it climbs and how much it drops,
// wired a -> b in order so node `edge` is the a end of edge `edge`.
function chain(
  slopes: readonly (readonly [number, number])[],
  meters: number,
): RoutingGraph {
  return {
    edgeLength: Float32Array.from(slopes, () => meters),
    edgeNodeA: Uint32Array.from(slopes, (_, edge) => edge),
    edgeNodeB: Uint32Array.from(slopes, (_, edge) => edge + 1),
    edgeAscent: Uint8Array.from(slopes, ([ascent]) => reliefByte(ascent)),
    edgeDescent: Uint8Array.from(slopes, ([, descent]) => reliefByte(descent)),
    edgeKindSide: new Uint8Array(slopes.length),
    edgeCover: new Uint8Array(slopes.length),
    edgeLandmark: new Uint8Array(slopes.length),
    edgeArt: new Uint8Array(slopes.length),
    edgeHighway: new Uint8Array(slopes.length),
    edgeCommercial: new Uint8Array(slopes.length),
    edgeIndustrial: new Uint8Array(slopes.length),
    edgeHistoric: new Uint8Array(slopes.length),
    maxCover: 0,
    maxLandmark: 0,
    maxArt: 0,
    maxCommercial: 0,
    maxIndustrial: 0,
    maxHistoric: 0,
    shade: null,
    sheds: null,
    ferries: null,
  } as unknown as RoutingGraph;
}

// Edges that only climb, which is what the penalty tests are about: it reads the two bytes' sum.
function stretch(grades: readonly number[], meters: number): RoutingGraph {
  return chain(
    grades.map((grade) => [grade, 0] as const),
    meters,
  );
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
    industrial: 0,
    historic: 0,
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

test("the penalty reads a hill the same in both directions", () => {
  const graph = chain([[0.2, 0]], BLOCK_METERS);
  // Walked b -> a the climb becomes a drop, and the two bytes swap; their sum, which is all the
  // penalty sees, does not move.
  expect(edgeGrade(graph, 0)).toBeCloseTo(0.2, 2);
  expect(edgeMultiplier(graph, 0, weights(1))).toBeCloseTo(
    1 + (0.2 / REFERENCE_GRADE) ** 2,
    1,
  );
});

test("a descent is walked faster than the climb back up it", () => {
  const graph = chain([[0.08, 0]], BLOCK_METERS);
  const up = rawSeconds(graph, 0, 0); // entered at node a: the stored a -> b climb
  const down = rawSeconds(graph, 0, 1); // entered at node b: the same block downhill
  expect(down).toBeLessThan(up);
  // An 8% descent is quicker than flat, which is the half of Tobler an absolute grade cannot
  // express: 100 m of it takes 71.6 s down, 101.6 s up, and 76.9 s on the level.
  expect(down).toBeLessThan(BLOCK_METERS / WALK_METERS_PER_SECOND);
});

test("Tobler peaks at a gentle descent, not at flat", () => {
  expect(gradeSpeedFactor(0)).toBe(1);
  expect(gradeSpeedFactor(-0.05)).toBeCloseTo(1.1912, 4);
  // Ten percent down is where the descent stops paying and a walker is back to level speed.
  expect(gradeSpeedFactor(-0.1)).toBeCloseTo(1, 6);
  expect(gradeSpeedFactor(-0.3)).toBeLessThan(1);
  for (const grade of [0.02, 0.12, 0.3, 0.5]) {
    expect(gradeSpeedFactor(grade)).toBeLessThan(1);
    expect(gradeSpeedFactor(grade) * WALK_METERS_PER_SECOND).toBeGreaterThan(0);
  }
});

test("an edge that crests is slower than a steady climb of the same total grade", () => {
  const meters = 200;
  // Both carry 20% of grade over the same length; one climbs it, the other climbs half and drops
  // half. The crest walks its drop faster, so it costs less time — and exactly the same penalty.
  const steady = chain([[0.2, 0]], meters);
  const crest = chain([[0.1, 0.1]], meters);
  expect(edgeGrade(steady, 0)).toBeCloseTo(edgeGrade(crest, 0), 2);
  expect(rawSeconds(crest, 0, -1)).toBeLessThan(rawSeconds(steady, 0, -1));
  // A crest reads the same both ways: it climbs and drops as much either direction.
  expect(rawSeconds(crest, 0, 0)).toBeCloseTo(rawSeconds(crest, 0, 1), 6);
});

test("the A* per-metre floor never exceeds what a metre actually costs", () => {
  // Every mix of climb and drop the bytes can carry, including the gentle descents that walk faster
  // than flat — the case that makes the flat speed an invalid divisor.
  const slopes: [number, number][] = [];
  for (const ascent of [0, 0.01, 0.03, 0.05, 0.1, 0.2, 0.35]) {
    for (const descent of [0, 0.01, 0.03, 0.05, 0.1, 0.2, 0.35]) {
      slopes.push([ascent, descent]);
    }
  }
  const graph = chain(slopes, BLOCK_METERS);
  for (const hill of [0, 1, 5]) {
    const coeff = walkSecondsCoeff(graph, weights(hill));
    for (let edge = 0; edge < slopes.length; edge++) {
      for (const fromNode of [edge, edge + 1]) {
        const actual = effSeconds(graph, edge, weights(hill), 0, fromNode);
        expect(coeff * BLOCK_METERS).toBeLessThanOrEqual(actual);
      }
    }
  }
  // And the bound is the fastest edge in the graph, not a blanket constant: the 5% descent is where
  // Tobler peaks, at 1.1912 times the flat speed — 1.1888 here, since 5% round-trips through a byte
  // as 4.97%.
  expect(maxSpeedFactor(graph)).toBeCloseTo(1.1888, 4);
  const gentleDrop = slopes.findIndex(
    ([up, down]) => up === 0 && down === 0.05,
  );
  expect(walkSpeedOn(graph, gentleDrop, true)).toBeCloseTo(
    WALK_METERS_PER_SECOND * 1.1888,
    4,
  );
});

test("a graph with no elevation keeps the flat bound exactly", () => {
  const graph = stretch([0, 0, 0], BLOCK_METERS);
  expect(maxSpeedFactor(graph)).toBe(1);
  expect(walkSecondsCoeff(graph, weights(0))).toBeCloseTo(
    1 / WALK_METERS_PER_SECOND,
    12,
  );
});
