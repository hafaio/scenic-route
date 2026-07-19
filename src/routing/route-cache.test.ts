import { afterAll, expect, mock, test } from "bun:test";
import type { RouteWeights } from "./cost";
import type { RoutingGraph } from "./graph";
import type { Snap } from "./snap";

const weights = (
  tree: number,
  ferry: number,
  allowFerries: boolean,
): RouteWeights => ({
  tree,
  ferry,
  landmark: 0,
  art: 0,
  highway: 0,
  allowFerries,
});

// The cache is a memoization layer over findRoute, so the search is stubbed with a deterministic
// rule: the chosen path is piecewise-constant in each weight (thresholds at 0.5) and depends on the
// gate — exactly the shape of a real route's dependence on the sliders. The stub counts its calls so
// bracketing (a reused interval skips the search) is observable.
let calls = 0;
function chosenPath(tree: number, ferry: number, allow: boolean): number {
  if (!allow) {
    return 0; // ferries barred: the walking route, whatever the weights
  } else if (ferry > 0.5) {
    return 2; // ferry
  } else if (tree > 0.5) {
    return 1; // a shaded detour
  } else {
    return 0; // the direct walk
  }
}
mock.module("./search", () => ({
  findRoute: (
    _graph: RoutingGraph,
    _start: Snap,
    _dest: Snap,
    routeWeights: RouteWeights,
  ) => {
    calls += 1;
    return {
      steps: [
        {
          edge: chosenPath(
            routeWeights.tree,
            routeWeights.ferry,
            routeWeights.allowFerries,
          ),
          forward: true,
        },
      ],
    };
  },
}));

const { RouteCache } = await import("./route-cache");

afterAll(() => {
  mock.restore();
});

const GRAPH = {} as RoutingGraph;
const START = { edge: 0, metersFromA: 0 } as Snap;
const DEST = { edge: 1, metersFromA: 5 } as Snap;

function signature(
  result: { steps: { edge: number; forward: boolean }[] } | null,
): string {
  return result
    ? result.steps
        .map((step) => `${step.edge}${step.forward ? "f" : "b"}`)
        .join(",")
    : "∅";
}

test("the cache never returns a route that differs from a fresh search", () => {
  const cache = new RouteCache();
  // Drag tree up, switch to the ferry slider and up, switch back to tree and down, toggle the gate
  // off then repeat it, back on with a repeat, then two-axis jumps — every transition the cache must
  // survive without a stale range.
  const sequence: [number, number, boolean][] = [
    [0, 0.1, true],
    [0.2, 0.1, true],
    [0.6, 0.1, true],
    [1, 0.1, true],
    [1, 0.4, true],
    [1, 0.8, true],
    [0.6, 0.8, true],
    [0, 0.8, true],
    [0, 0.8, false],
    [0, 0.8, false],
    [0.6, 0.1, true],
    [0.6, 0.1, true],
    [1, 0.8, true],
    [0, 0.1, true],
  ];
  let previous: string | null = null;
  for (const [tree, ferry, allow] of sequence) {
    const cached = cache.route(GRAPH, START, DEST, weights(tree, ferry, allow));
    const expected = `${chosenPath(tree, ferry, allow)}f`;
    expect(signature(cached.result)).toBe(expected);
    if (previous !== null) {
      expect(cached.changed).toBe(expected !== previous);
    }
    previous = expected;
  }
});

test("bracketing the active slider skips the search on a settled interval", () => {
  calls = 0;
  const cache = new RouteCache();
  // Three tree weights on the same side of the threshold: the same path is optimal across the whole
  // range, so the middle value, bracketed by the two ends, must not run the search.
  cache.route(GRAPH, START, DEST, weights(0.6, 0.1, true));
  cache.route(GRAPH, START, DEST, weights(1, 0.1, true));
  cache.route(GRAPH, START, DEST, weights(0.8, 0.1, true));
  expect(calls).toBe(2);
});

test("switching sliders drops the old range and rebrackets the new one", () => {
  calls = 0;
  const cache = new RouteCache();
  cache.route(GRAPH, START, DEST, weights(0.6, 0.1, true)); // tree axis
  cache.route(GRAPH, START, DEST, weights(1, 0.1, true)); // tree axis, two samples
  cache.route(GRAPH, START, DEST, weights(1, 0.8, true)); // switch to ferry: seed + compute
  cache.route(GRAPH, START, DEST, weights(1, 0.8, true)); // exact repeat: no search
  expect(calls).toBe(3);
  // Back to a tree weight already sampled on the dropped tree range — the range is gone, so it runs.
  cache.route(GRAPH, START, DEST, weights(0.6, 0.8, true));
  expect(calls).toBe(4);
});
