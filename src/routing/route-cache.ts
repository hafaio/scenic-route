// The optimal route is piecewise-constant in a single weight: each candidate path's cost is linear
// in that weight, so the cheapest path changes only at discrete breakpoints, and any weight bracketed
// by two samples that share a path provably yields that path — no recompute. That interval argument
// is strictly one-dimensional, so with two weights (tree and ferry) plus the allow-ferries gate the
// cache brackets only the *active* slider: whichever one moved since the last call. Moving the other
// slider or toggling the gate changes the fixed context the range was built against, so the old range
// is dropped and a fresh one is started around the current slider — seeded with the just-computed
// point, which is still valid because only the active slider moved. It reports whether the path
// changed so the caller can skip redrawing an identical route.

import type { RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import type { Snap } from "./snap";

// Weights are quantized to this many decimals before caching, so slider values equal in intent match
// despite float drift (0.01 has no exact binary form).
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

type Axis = "tree" | "ferry";

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
  private lastTree = Number.NaN;
  private lastFerry = Number.NaN;
  private lastAllow = false;
  private lastResult: RouteResult | null = null;
  private lastSignature: string | null = null;
  private seen = false; // a previous call exists, so a slider delta can be read

  route(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    treeWeight: number,
    ferryWeight: number,
    allowFerries: boolean,
  ): CachedRoute {
    const tree = quantize(treeWeight);
    const ferry = quantize(ferryWeight);
    const endpointsKey = `${start.edge}:${start.metersFromA.toFixed(2)}|${dest.edge}:${dest.metersFromA.toFixed(2)}`;
    if (endpointsKey !== this.endpointsKey) {
      this.endpointsKey = endpointsKey;
      this.axis = null;
      this.samples = [];
      this.seen = false;
      this.lastSignature = null;
    }

    // Identical inputs re-render to the identical route: return it without touching the search.
    if (
      this.seen &&
      tree === this.lastTree &&
      ferry === this.lastFerry &&
      allowFerries === this.lastAllow
    ) {
      return { result: this.lastResult, changed: false };
    }

    // The active slider is whichever weight moved since the last call, with the gate unchanged. A
    // first call, a toggled gate, or both weights moving at once has no single bracketable axis.
    let active: Axis | null = null;
    if (this.seen && allowFerries === this.lastAllow) {
      const treeMoved = tree !== this.lastTree;
      const ferryMoved = ferry !== this.lastFerry;
      if (treeMoved && !ferryMoved) {
        active = "tree";
      } else if (ferryMoved && !treeMoved) {
        active = "ferry";
      }
    }

    if (active === null) {
      // No bracketable axis: drop the range and compute this point on its own.
      this.axis = null;
      this.samples = [];
    } else if (active !== this.axis) {
      // Switched slider (or established the first axis): the old range brackets the other slider, so
      // drop it and seed the new one with the just-computed point. That point is still valid — only
      // the active slider moved, so the context the new range brackets against is unchanged.
      this.axis = active;
      this.samples =
        this.seen && this.lastSignature !== null
          ? [
              {
                value: active === "tree" ? this.lastTree : this.lastFerry,
                signature: this.lastSignature,
                result: this.lastResult,
              },
            ]
          : [];
    }

    let sample: Sample;
    if (this.axis === null) {
      const result = findRoute(graph, start, dest, tree, ferry, allowFerries);
      sample = { value: tree, signature: pathSignature(result), result };
    } else {
      sample = this.sampleFor(
        graph,
        start,
        dest,
        this.axis === "tree" ? tree : ferry,
        tree,
        ferry,
        allowFerries,
      );
    }

    const changed = sample.signature !== this.lastSignature;
    this.lastTree = tree;
    this.lastFerry = ferry;
    this.lastAllow = allowFerries;
    this.lastResult = sample.result;
    this.lastSignature = sample.signature;
    this.seen = true;
    return { result: sample.result, changed };
  }

  // The route at the active axis's `axisValue`, reusing a settled interval or computing and inserting
  // a new sample. `tree`/`ferry`/`allowFerries` are the full current inputs the search runs on; only
  // the active axis varies across the samples, so an interval bracketed by one path stays that path.
  private sampleFor(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    axisValue: number,
    tree: number,
    ferry: number,
    allowFerries: boolean,
  ): Sample {
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
    const result = findRoute(graph, start, dest, tree, ferry, allowFerries);
    const sample: Sample = {
      value: axisValue,
      signature: pathSignature(result),
      result,
    };
    this.samples.splice(insertAt, 0, sample);
    return sample;
  }
}
