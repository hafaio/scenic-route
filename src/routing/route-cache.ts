// The optimal route is piecewise-constant in a single weight: each candidate path's cost is linear
// in that weight, so the cheapest path changes only at discrete breakpoints, and any weight bracketed
// by two samples that share a path provably yields that path — no recompute. That interval argument
// is strictly one-dimensional, so with several scenic weights plus the allow-ferries gate the cache
// brackets only the *active* slider: whichever single one moved since the last call. Moving another
// slider or toggling the gate changes the fixed context the range was built against, so the old range
// is dropped and a fresh one is started around the current slider — seeded with the just-computed
// point, which is still valid because only the active slider moved. It reports whether the path
// changed so the caller can skip redrawing an identical route.

import type { RouteWeights } from "./cost";
import type { RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import type { Snap } from "./snap";

// The numeric weights that a slider can move; the allow-ferries gate is a discrete context, not an axis.
const AXES = ["tree", "ferry", "landmark", "art", "highway"] as const;
type Axis = (typeof AXES)[number];

// Weights are quantized to this many decimals before caching, so slider values equal in intent match
// despite float drift (0.01 has no exact binary form).
const WEIGHT_DECIMALS = 3;

function quantize(weight: number): number {
  const scale = 10 ** WEIGHT_DECIMALS;
  return Math.round(weight * scale) / scale;
}

function quantizeWeights(weights: RouteWeights): RouteWeights {
  return {
    tree: quantize(weights.tree),
    ferry: quantize(weights.ferry),
    landmark: quantize(weights.landmark),
    art: quantize(weights.art),
    highway: quantize(weights.highway),
    allowFerries: weights.allowFerries,
  };
}

function sameWeights(left: RouteWeights, right: RouteWeights): boolean {
  return (
    left.allowFerries === right.allowFerries &&
    AXES.every((axis) => left[axis] === right[axis])
  );
}

function pathSignature(result: RouteResult | null): string {
  if (!result) {
    return "∅"; // no route — a distinct, stable signature
  }
  let signature = "";
  for (const step of result.steps) {
    signature += `${step.edge}${step.forward ? "f" : "b"};`;
  }
  return signature;
}

interface Sample {
  value: number; // the active axis's weight
  signature: string;
  result: RouteResult | null;
}

export interface CachedRoute {
  result: RouteResult | null;
  // false when the path is identical to the one the previous call returned, so the caller can leave
  // the drawn route untouched.
  changed: boolean;
}

// One per live routing session. It keys off the endpoints and clears when they change, so the caller
// only has to hold a stable instance.
export class RouteCache {
  private endpointsKey = "";
  private axis: Axis | null = null; // the slider the samples bracket; null when none is established
  private samples: Sample[] = []; // ascending by the active axis's weight, all at one fixed context
  private last: RouteWeights | null = null; // the previous call's quantized weights
  private lastResult: RouteResult | null = null;
  private lastSignature: string | null = null;

  route(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    weights: RouteWeights,
  ): CachedRoute {
    const current = quantizeWeights(weights);
    const endpointsKey = `${start.edge}:${start.metersFromA.toFixed(2)}|${dest.edge}:${dest.metersFromA.toFixed(2)}`;
    if (endpointsKey !== this.endpointsKey) {
      this.endpointsKey = endpointsKey;
      this.axis = null;
      this.samples = [];
      this.last = null;
      this.lastSignature = null;
    }

    // Identical inputs re-render to the identical route: return it without touching the search.
    if (this.last !== null && sameWeights(current, this.last)) {
      return { result: this.lastResult, changed: false };
    }

    // The active slider is whichever single weight moved since the last call, with the gate unchanged.
    // A first call, a toggled gate, or two weights moving at once has no single bracketable axis.
    let active: Axis | null = null;
    if (this.last !== null && current.allowFerries === this.last.allowFerries) {
      const moved = AXES.filter((axis) => current[axis] !== this.last?.[axis]);
      if (moved.length === 1) {
        active = moved[0];
      }
    }

    if (active === null) {
      // No bracketable axis: drop the range and compute this point on its own.
      this.axis = null;
      this.samples = [];
    } else if (active !== this.axis) {
      // Switched slider (or established the first axis): the old range brackets another slider, so
      // drop it and seed the new one with the just-computed point. That point is still valid — only
      // the active slider moved, so the context the new range brackets against is unchanged.
      this.axis = active;
      this.samples =
        this.last !== null && this.lastSignature !== null
          ? [
              {
                value: this.last[active],
                signature: this.lastSignature,
                result: this.lastResult,
              },
            ]
          : [];
    }

    let sample: Sample;
    if (this.axis === null) {
      const result = findRoute(graph, start, dest, current);
      sample = {
        value: current.tree,
        signature: pathSignature(result),
        result,
      };
    } else {
      sample = this.sampleFor(graph, start, dest, current, this.axis);
    }

    const changed = sample.signature !== this.lastSignature;
    this.last = current;
    this.lastResult = sample.result;
    this.lastSignature = sample.signature;
    return { result: sample.result, changed };
  }

  // The route at the active axis's current weight, reusing a settled interval or computing and
  // inserting a new sample. `weights` is the full current context the search runs on; only the active
  // axis varies across the samples, so an interval bracketed by one path stays that path.
  private sampleFor(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    weights: RouteWeights,
    axis: Axis,
  ): Sample {
    const axisValue = weights[axis];
    let below: Sample | null = null;
    let above: Sample | null = null;
    let insertAt = this.samples.length;
    for (let index = 0; index < this.samples.length; index++) {
      const sample = this.samples[index];
      if (sample.value === axisValue) {
        return sample;
      } else if (sample.value < axisValue) {
        below = sample;
      } else {
        above = sample;
        insertAt = index;
        break; // ascending, so the first sample above the value is the nearest one
      }
    }
    if (below && above && below.signature === above.signature) {
      return below; // the same path is optimal across the whole [below, above] interval
    }
    const result = findRoute(graph, start, dest, weights);
    const sample: Sample = {
      value: axisValue,
      signature: pathSignature(result),
      result,
    };
    this.samples.splice(insertAt, 0, sample);
    return sample;
  }
}
