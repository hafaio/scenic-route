import { beforeEach, expect, test } from "bun:test";
import { rainTau } from "../shade/phenology";
import {
  edgeMultiplier,
  edgeShed,
  effSeconds,
  maxShelter,
  minMultiplier,
  type RouteWeights,
  SHED_AVOID_PENALTY,
  WALK_METERS_PER_SECOND,
} from "./cost";
import { clearEdgePathCache, NO_GEOMETRY, type RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import { constantShadeField } from "./shade";
import { DEFAULT_DECK_DEPTH_METERS, type EdgeDeck, shedField } from "./sheds";
import { haversineMeters, type Snap } from "./snap";

// The three scaffolding cost terms: a deck folded into the shade attribute, the shelter factor it
// shares with the canopy, and the avoid penalty. The routes are checked on a diamond whose two halves
// are a short shedded way and a longer bare detour, which is the choice the toggle actually faces.

const SCALE = 1e-6;
const NAME_NONE = 0xffff;
const KIND_SIDEWALK = 0;
const JULY = new Date(2026, 6, 15);
const JANUARY = new Date(2026, 0, 15);
// How far the lower half of the diamond has to bow out to be four times the upper half's walk — the
// scale of detour avoiding scaffolding is meant to be worth.
const FOUR_TIMES = 0.006;

// Each case builds its own graph reusing the same edge ids, so the edge-path cache cannot carry one
// diamond's geometry into the next one's bearings.
beforeEach(clearEdgePathCache);

const noPref = (over: Partial<RouteWeights> = {}): RouteWeights => ({
  tree: 0,
  ferry: 0,
  landmark: 0,
  art: 0,
  highway: 0,
  hill: 0,
  commercial: 0,
  industrial: 0,
  historic: 0,
  shade: 0,
  shelter: 0,
  allowFerries: false,
  allowSheds: true,
  ...over,
});

interface NodeSpec {
  lat: number;
  lng: number;
}

// A walking edge and the fractions (0..1) the cost model reads off it. `shed` is the share standing
// under a deck; `canopy` is the unsmoothed share with a crown directly overhead; `highway` is the one
// nuisance attribute, the only factor that can push a metre's multiplier above 1.
interface EdgeSpec {
  a: number;
  b: number;
  cover?: number;
  canopy?: number;
  shed?: number;
  highway?: number;
}

const byte = (fraction: number | undefined): number =>
  Math.min(254, Math.round((fraction ?? 0) * 255));

function buildGraph(
  nodes: NodeSpec[],
  edges: EdgeSpec[],
  date = JULY,
): RoutingGraph {
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const nodeQx = Int32Array.from(nodes, (node) => Math.round(node.lng / SCALE));
  const nodeQy = Int32Array.from(nodes, (node) => Math.round(node.lat / SCALE));
  const nodeLat = (node: number): number => nodeQy[node] * SCALE;
  const nodeLng = (node: number): number => nodeQx[node] * SCALE;

  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeCover = new Uint8Array(edgeCount);
  const edgeDirectCanopy = new Uint8Array(edgeCount);
  const edgeHighway = new Uint8Array(edgeCount);
  const decks = new Map<number, EdgeDeck>();
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  let maxCover = 0;
  let maxDirectCanopy = 0;
  for (let edge = 0; edge < edgeCount; edge++) {
    const spec = edges[edge];
    edgeNodeA[edge] = spec.a;
    edgeNodeB[edge] = spec.b;
    edgeLength[edge] = haversineMeters(
      nodeLat(spec.a),
      nodeLng(spec.a),
      nodeLat(spec.b),
      nodeLng(spec.b),
    );
    edgeCover[edge] = byte(spec.cover);
    edgeDirectCanopy[edge] = byte(spec.canopy);
    edgeHighway[edge] = byte(spec.highway);
    if (spec.shed) {
      decks.set(edge, { covered: spec.shed, depth: DEFAULT_DECK_DEPTH_METERS });
    }
    maxCover = Math.max(maxCover, edgeCover[edge]);
    maxDirectCanopy = Math.max(maxDirectCanopy, edgeDirectCanopy[edge]);
    adjacency[spec.a].push(edge);
    adjacency[spec.b].push(edge);
  }

  const csr = new Uint32Array(nodeCount + 1);
  const flatAdjacency = new Uint32Array(2 * edgeCount);
  let cursor = 0;
  for (let node = 0; node < nodeCount; node++) {
    csr[node] = cursor;
    for (const edge of adjacency[node]) {
      flatAdjacency[cursor] = edge;
      cursor += 1;
    }
  }
  csr[nodeCount] = cursor;

  const graph = {
    nodeCount,
    edgeCount,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx,
    nodeQy,
    csr,
    adjacency: flatAdjacency,
    edgeNodeA,
    edgeNodeB,
    edgeLength,
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
    edgeCover,
    edgeNameId: new Uint16Array(edgeCount).fill(NAME_NONE),
    edgeKindSide: new Uint8Array(edgeCount).fill(KIND_SIDEWALK),
    maxCover: maxCover / 255,
    edgeLandmark: new Uint8Array(edgeCount),
    edgeArt: new Uint8Array(edgeCount),
    edgeHighway,
    edgeCommercial: new Uint8Array(edgeCount),
    edgeIndustrial: new Uint8Array(edgeCount),
    edgeHistoric: new Uint8Array(edgeCount),
    maxLandmark: 0,
    maxArt: 0,
    maxCommercial: 0,
    maxIndustrial: 0,
    maxHistoric: 0,
    edgeDirectCanopy,
    maxDirectCanopy: maxDirectCanopy / 255,
    edgeAscent: new Uint8Array(edgeCount),
    edgeDescent: new Uint8Array(edgeCount),
    maxRelief: 0,
    shade: null,
    edgeDurationSeconds: new Float32Array(edgeCount),
    ferryEdges: new Uint32Array(0),
    names: [],
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
  // The real field, then its sun nailed straight overhead so a deck shades everything it covers. What
  // an oblique sun takes back off it is sheds.test.ts's subject; these cases are about how the shade,
  // shelter and penalty terms compose once a share is decided.
  graph.sheds = shedField(graph, decks, date);
  graph.sheds.translate.fill(0);
  return graph;
}

function snapAtNode(graph: RoutingGraph, node: number, walkEdge: number): Snap {
  const atA = graph.edgeNodeA[walkEdge] === node;
  return {
    edge: walkEdge,
    metersFromA: atA ? 0 : graph.edgeLength[walkEdge],
    point: {
      lat: graph.nodeQy[node] * graph.scale,
      lng: graph.nodeQx[node] * graph.scale,
    },
    distanceMeters: 0,
    component: 0,
  };
}

// A diamond: from 0 to 3 by the upper path (node 1, edges 1 and 2) or the lower one (node 2, edges 3
// and 4), plus a snap stub at each end. `upperLat`/`lowerLat` set how far each bows out, so one side
// can be made a genuine detour of the other — the corner-cross-back a shed forces on a real block.
function diamond(
  upper: EdgeSpec,
  lower: EdgeSpec,
  upperLat = 0.001,
  lowerLat = 0.001,
  date = JULY,
): { graph: RoutingGraph; start: Snap; dest: Snap } {
  const nodes: NodeSpec[] = [
    { lat: 0, lng: 0 },
    { lat: upperLat, lng: 0.0015 },
    { lat: -lowerLat, lng: 0.0015 },
    { lat: 0, lng: 0.003 },
    { lat: 0, lng: -0.0005 },
    { lat: 0, lng: 0.0035 },
  ];
  const edges: EdgeSpec[] = [
    { a: 4, b: 0 },
    { a: 0, b: 1, ...upper },
    { a: 1, b: 3, ...upper },
    { a: 0, b: 2, ...lower },
    { a: 2, b: 3, ...lower },
    { a: 3, b: 5 },
  ];
  const graph = buildGraph(nodes, edges, date);
  return {
    graph,
    start: snapAtNode(graph, 0, 0),
    dest: snapAtNode(graph, 3, 5),
  };
}

// The share of an edge under a deck, as the quantized byte the cost model actually reads.
function shedOf(graph: RoutingGraph, edge: number): number {
  return (
    (graph.sheds as NonNullable<RoutingGraph["sheds"]>).coverage[edge] / 255
  );
}

function upperTaken(result: RouteResult | null): boolean {
  return (result?.steps ?? []).some(
    (step) => step.edge === 1 || step.edge === 2,
  );
}

// The walked length of a route, so a forced detour can be measured rather than only detected.
function walkMeters(result: RouteResult | null): number {
  return result ? result.walkMeters : Number.NaN;
}

test("a deck shades its share of an edge whatever the sun is doing", () => {
  const { graph } = diamond({ shed: 0.5 }, {});
  // A field where every edge is fully sunlit, so the only shade on the route is the scaffolding's.
  const sunlit = Math.fround(0.8); // as the field's Float32 row stores it
  graph.shade = constantShadeField(
    new Float32Array(graph.edgeCount).fill(sunlit),
  );
  const preferShade = noPref({ shade: -1 });
  const half = shedOf(graph, 1);
  // Half decked: that share reads a fully shaded -0.8 and the rest its baked +0.8, so the two cancel.
  expect(edgeMultiplier(graph, 1, preferShade)).toBeCloseTo(
    1 + sunlit * (1 - 2 * half),
    12,
  );
  // Bare: the baked sunlit attribute, which a shade preference charges for.
  expect(edgeMultiplier(graph, 3, preferShade)).toBeCloseTo(1 + sunlit, 12);
  // Composited, not summed: a deck over an already shaded edge bottoms out at fully shaded, not past
  // it, where summing the two would take the attribute below -1 and the multiplier with it.
  const covered = diamond({ shed: 1 }, {}).graph;
  covered.shade = constantShadeField(
    new Float32Array(covered.edgeCount).fill(-sunlit),
  );
  expect(edgeMultiplier(covered, 1, preferShade)).toBeCloseTo(1 - sunlit, 12);
});

test("a sun preference walks around scaffolding, a shade preference under it", () => {
  // The upper path is decked; the lower bows out slightly further, so it wins only when the deck's
  // shade is worth something (or costs something).
  const { graph, start, dest } = diamond({ shed: 1 }, {}, 0.001, 0.0013);
  graph.shade = constantShadeField(new Float32Array(graph.edgeCount).fill(0.8));
  expect(upperTaken(findRoute(graph, start, dest, noPref()))).toBe(true);
  expect(upperTaken(findRoute(graph, start, dest, noPref({ shade: -1 })))).toBe(
    true,
  );
  expect(upperTaken(findRoute(graph, start, dest, noPref({ shade: 1 })))).toBe(
    false,
  );
});

test("shelter is the deck plus the canopy over what the deck does not cover", () => {
  const { graph } = diamond({ shed: 0.4, canopy: 0.5 }, { canopy: 1 });
  const tau = rainTau(JULY);
  const shed = shedOf(graph, 1);
  const canopy = graph.edgeDirectCanopy[1] / 255;
  const expected = shed + tau * canopy * (1 - shed);
  expect(edgeMultiplier(graph, 1, noPref({ shelter: 1 }))).toBeCloseTo(
    1 - expected,
    12,
  );
  // Canopy alone, at the same weight, is worth only its tau — the deck is worth all of it.
  expect(edgeMultiplier(graph, 3, noPref({ shelter: 1 }))).toBeCloseTo(
    1 - tau * (graph.edgeDirectCanopy[3] / 255),
    12,
  );
});

test("the canopy half of shelter is seasonal and the deck half is not", () => {
  const summer = diamond({ canopy: 1 }, { shed: 1 }, 0.001, 0.001, JULY).graph;
  const winter = diamond(
    { canopy: 1 },
    { shed: 1 },
    0.001,
    0.001,
    JANUARY,
  ).graph;
  const shelter = noPref({ shelter: 1 });
  expect(rainTau(JULY)).toBeGreaterThan(rainTau(JANUARY));
  // A leafless crown keeps off far less rain, so the discount shrinks with the season.
  expect(edgeMultiplier(winter, 1, shelter)).toBeGreaterThan(
    edgeMultiplier(summer, 1, shelter),
  );
  // The deck does not care what month it is.
  expect(edgeMultiplier(winter, 3, shelter)).toBeCloseTo(
    edgeMultiplier(summer, 3, shelter),
    12,
  );
});

test("a shelter preference walks the sheltered way in either season", () => {
  for (const date of [JULY, JANUARY]) {
    // The decked path bows out further, so it is chosen only for the shelter.
    const { graph, start, dest } = diamond(
      { shed: 1 },
      {},
      0.0016,
      0.001,
      date,
    );
    const label = date.toDateString();
    expect(upperTaken(findRoute(graph, start, dest, noPref())), label).toBe(
      false,
    );
    expect(
      upperTaken(findRoute(graph, start, dest, noPref({ shelter: 1 }))),
      label,
    ).toBe(true);
  }
});

test("the avoid penalty is charged per metre of deck, not per edge", () => {
  const { graph } = diamond({ shed: 0.1 }, { shed: 1 });
  const avoiding = noPref({ allowSheds: false });
  // A tenth of the edge decked: nine tenths cost a plain metre, the tenth costs one plus the penalty.
  expect(edgeMultiplier(graph, 1, avoiding)).toBeCloseTo(
    1 + SHED_AVOID_PENALTY * shedOf(graph, 1),
    12,
  );
  expect(edgeMultiplier(graph, 3, avoiding)).toBeCloseTo(
    1 + SHED_AVOID_PENALTY * shedOf(graph, 3),
    12,
  );
});

test("a barred deck still shades and shelters what it stands over", () => {
  // Half decked, with everything that would make the edge cheap: cover, canopy, and the deck's shade.
  const { graph } = diamond(
    { shed: 0.5, cover: 1, canopy: 1 },
    { cover: 1, canopy: 1 },
  );
  graph.shade = constantShadeField(new Float32Array(graph.edgeCount).fill(0.8));
  const tempting = { tree: 1, shelter: 1, shade: -1 };
  const allowed = edgeMultiplier(graph, 1, noPref(tempting));
  const avoiding = noPref({ ...tempting, allowSheds: false });
  const shed = shedOf(graph, 1);
  // The scenic factors read the deck exactly as they do when it is allowed — a deck someone asked not
  // to walk under is still overhead — and only the decked share is repriced, at an undiscounted metre
  // plus the whole penalty.
  expect(edgeMultiplier(graph, 1, avoiding)).toBeCloseTo(
    allowed * (1 - shed) + shed + SHED_AVOID_PENALTY * shed,
    12,
  );
  // Which the identical bare edge beside it does not pay.
  expect(edgeMultiplier(graph, 1, avoiding)).toBeGreaterThan(
    edgeMultiplier(graph, 3, avoiding),
  );
});

test("avoiding buys a detour well past breaking even, and gives up beyond the penalty", () => {
  // The shedded way is the short one; the bare alternative bows out four times as far, which is more
  // than the corner-cross-back a real block face costs.
  const { graph, start, dest } = diamond({ shed: 1 }, {}, 0.0002, FOUR_TIMES);
  const direct = findRoute(graph, start, dest, noPref());
  expect(upperTaken(direct)).toBe(true);
  const avoided = findRoute(graph, start, dest, noPref({ allowSheds: false }));
  expect(upperTaken(avoided)).toBe(false);
  // What the toggle actually bought, in metres — the ratio the constant has to be sized past.
  expect(walkMeters(avoided) / walkMeters(direct)).toBeGreaterThan(4);

  // Past the penalty's own worth of extra walking the shed is simply cheaper, and the route says so
  // rather than failing: it is soft-infinite on purpose.
  const hopeless = diamond({ shed: 1 }, {}, 0.0002, 0.04);
  const conceded = findRoute(
    hopeless.graph,
    hopeless.start,
    hopeless.dest,
    noPref({ allowSheds: false }),
  );
  expect(upperTaken(conceded)).toBe(true);
  expect(Number.isFinite(walkMeters(conceded))).toBe(true);
});

test("a decked edge never costs less than the same edge bare, at any weights", () => {
  // What makes the toggle sound: nothing the deck earns can leave it cheaper than the bare edge beside
  // it. The pricing charges the decked share a flat undiscounted metre, which is only a penalty while
  // the multiplier is under 1 — and the signed shade axis and the highway penalty both push it over 1
  // — so the avoid penalty is what has to dominate, and it is charged on the whole decked share.
  for (const shed of [0.05, 0.3, 0.6, 1]) {
    const bare = { cover: 1, canopy: 1, highway: 1 };
    const { graph } = diamond({ ...bare, shed }, bare);
    for (const attr of [-0.99, 0, 0.99]) {
      graph.shade = constantShadeField(
        new Float32Array(graph.edgeCount).fill(attr),
      );
      for (const shade of [-1, 0, 1]) {
        for (const shelter of [0, 1]) {
          for (const highway of [0, 1]) {
            const weights = noPref({
              tree: 1,
              shade,
              shelter,
              highway,
              allowSheds: false,
            });
            const label = `shed ${shed} attr ${attr} shade ${shade} shelter ${shelter} highway ${highway}`;
            expect(
              edgeMultiplier(graph, 1, weights) -
                edgeMultiplier(graph, 3, weights),
              label,
            ).toBeGreaterThan(0);
          }
        }
      }
    }
  }
});

test("an endpoint under scaffolding still routes while avoiding", () => {
  // Every way out of the start is decked, which is what a door under a shed looks like.
  const { graph, start, dest } = diamond({ shed: 1 }, { shed: 1 });
  const avoiding = noPref({ allowSheds: false });
  const result = findRoute(graph, start, dest, avoiding);
  expect(result).not.toBeNull();
  expect(Number.isFinite(walkMeters(result))).toBe(true);
  for (const step of result?.steps ?? []) {
    expect(effSeconds(graph, step.edge, avoiding)).toBeLessThan(
      Number.POSITIVE_INFINITY,
    );
  }
});

test("no scaffolding attribute reaches 1, so every discount floor stays positive", () => {
  const { graph } = diamond({ shed: 1, canopy: 1 }, { shed: 1, canopy: 1 });
  const sheds = graph.sheds as NonNullable<RoutingGraph["sheds"]>;
  expect(sheds.maxCoverage).toBeLessThan(1);
  expect(graph.maxDirectCanopy).toBeLessThan(1);
  expect(maxShelter(graph)).toBeLessThan(1);
  graph.shade = constantShadeField(
    new Float32Array(graph.edgeCount).fill(127 / 128),
  );
  // Every weight at its extreme at once, with scaffolding allowed and barred: the floor is positive and no
  // edge's multiplier can dip under it, which is what keeps the A* heuristic admissible.
  for (const allowSheds of [true, false]) {
    for (const shade of [-1, 1]) {
      const weights = noPref({
        tree: 1,
        landmark: 1,
        art: 1,
        commercial: 1,
        shelter: 1,
        shade,
        allowSheds,
      });
      const floor = minMultiplier(graph, weights);
      expect(floor).toBeGreaterThan(0);
      for (let edge = 0; edge < graph.edgeCount; edge++) {
        expect(edgeMultiplier(graph, edge, weights)).toBeGreaterThanOrEqual(
          floor,
        );
        expect(effSeconds(graph, edge, weights)).toBeGreaterThanOrEqual(
          (graph.edgeLength[edge] / WALK_METERS_PER_SECOND) * floor - 1e-9,
        );
      }
    }
  }
});

test("an oblique sun takes shade off a deck, but not shelter and not the penalty", () => {
  const { graph } = diamond({ shed: 1 }, {});
  const sheds = graph.sheds as NonNullable<RoutingGraph["sheds"]>;
  graph.shade = constantShadeField(new Float32Array(graph.edgeCount).fill(0.8));
  const preferShade = noPref({ shade: -1 });
  const overhead = edgeMultiplier(graph, 1, preferShade);
  const sheltered = edgeMultiplier(graph, 1, noPref({ shelter: 1 }));
  const avoided = edgeMultiplier(graph, 1, noPref({ allowSheds: false }));

  // The sun square across the street and low enough to have slid the shadow half the deck's depth.
  sheds.sunAzimuth.fill(sheds.bearing[1] + Math.PI / 2);
  sheds.translate.fill(sheds.depth[1] / 2);
  const sunlit = Math.fround(0.8); // as the field's Float32 row stores it
  const shaded = edgeShed(graph, 1) / 2;
  expect(edgeMultiplier(graph, 1, preferShade)).toBeCloseTo(
    1 + sunlit * (1 - 2 * shaded),
    12,
  );
  expect(edgeMultiplier(graph, 1, preferShade)).toBeGreaterThan(overhead);
  // A roof keeps rain off from any angle, and a deck someone asked not to walk under is still there.
  expect(edgeMultiplier(graph, 1, noPref({ shelter: 1 }))).toBe(sheltered);
  expect(edgeMultiplier(graph, 1, noPref({ allowSheds: false }))).toBe(avoided);
});
