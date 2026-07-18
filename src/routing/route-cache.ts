// The optimal route is piecewise-constant in the tree weight: each candidate path's cost is linear
// in w (length + w * sun-exposure), so the cheapest path changes only at discrete breakpoints. Two
// weights that yield the same path bracket an interval where every weight yields it — a line below
// all others at both ends of an interval stays below across it — so dragging the slider inside one
// interval needs no recompute. This caches sampled weights per endpoint pair, reuses a result for any
// weight proven to fall in a settled interval, and reports whether the path changed so the caller can
// skip redrawing an identical route.

import type { RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import type { Snap } from "./snap";

// Weights are quantized to this many decimals before caching, so slider values that are equal in
// intent match despite float drift (0.01 has no exact binary form).
const WEIGHT_DECIMALS = 3;

function quantize(weight: number): number {
  const scale = 10 ** WEIGHT_DECIMALS;
  return Math.round(weight * scale) / scale;
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
  weight: number;
  signature: string;
  result: RouteResult | null;
}

export interface CachedRoute {
  result: RouteResult | null;
  // false when the path is identical to the one the previous call returned, so the caller can leave
  // the drawn route untouched.
  changed: boolean;
}

// One per live routing session. It keys itself on the endpoints and clears when they change, so the
// caller does not have to manage its lifetime beyond holding a stable instance.
export class RouteCache {
  private key = "";
  private samples: Sample[] = []; // ascending by weight
  private lastSignature: string | null = null;

  route(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    weight: number,
    ferryWeight: number,
    allowFerries: boolean,
  ): CachedRoute {
    // The endpoints and both ferry parameters fix the key; the tree weight varies within it, where
    // the path stays piecewise-linear so the interval bracketing below still holds. Changing a ferry
    // parameter is a new key and clears the samples, which is the exact-hit memo the triple needs.
    const key = `${start.edge}:${start.metersFromA.toFixed(2)}|${dest.edge}:${dest.metersFromA.toFixed(2)}|${quantize(ferryWeight)}|${allowFerries ? 1 : 0}`;
    if (key !== this.key) {
      this.key = key;
      this.samples = [];
      this.lastSignature = null;
    }
    const sample = this.sampleFor(
      graph,
      start,
      dest,
      quantize(weight),
      ferryWeight,
      allowFerries,
    );
    const changed = sample.signature !== this.lastSignature;
    this.lastSignature = sample.signature;
    return { result: sample.result, changed };
  }

  private sampleFor(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    weight: number,
    ferryWeight: number,
    allowFerries: boolean,
  ): Sample {
    let below: Sample | null = null;
    let above: Sample | null = null;
    let insertAt = this.samples.length;
    for (let index = 0; index < this.samples.length; index++) {
      const sample = this.samples[index];
      if (sample.weight === weight) {
        return sample;
      } else if (sample.weight < weight) {
        below = sample;
      } else {
        above = sample;
        insertAt = index;
        break; // ascending, so the first sample above the weight is the nearest one
      }
    }
    if (below && above && below.signature === above.signature) {
      return below; // the same path is optimal across the whole [below, above] interval
    }
    const result = findRoute(
      graph,
      start,
      dest,
      weight,
      ferryWeight,
      allowFerries,
    );
    const sample: Sample = {
      weight,
      signature: pathSignature(result),
      result,
    };
    this.samples.splice(insertAt, 0, sample);
    return sample;
  }
}
