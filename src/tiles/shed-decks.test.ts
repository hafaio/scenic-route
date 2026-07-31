import { beforeEach, expect, test } from "bun:test";
import {
  clearEdgePathCache,
  NO_GEOMETRY,
  type RoutingGraph,
} from "../routing/graph";
import {
  MIN_DECK_DEPTH_METERS,
  type Shed,
  type ShedSpan,
} from "../routing/sheds";
import { projectX, projectY } from "./mercator";
import {
  type DeckRun,
  deckRing,
  forEachDeckIn,
  NO_DECKS,
  packDecks,
  packRuns,
  pixelsPerMeter,
  shedRuns,
  traceDeck,
} from "./shed-decks";

// The grid is a pure filter: it has to hand a tile exactly the decks a scan over every box would, and
// hand each of them over once. A deck wider than a cell sits in several of them, which is where a
// naive walk would draw it twice.

// A deterministic spread of boxes over roughly the city's extent in zoom-0 world pixels, sized from a
// few metres to several cells across.
function boxesOf(count: number): Float64Array {
  const boxes = new Float64Array(count * 4);
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let deck = 0; deck < count; deck++) {
    const x = 74.5 + next() * 0.4;
    const y = 96.2 + next() * 0.35;
    const width = next() ** 3 * 0.02;
    const height = next() ** 3 * 0.02;
    boxes.set([x, y, x + width, y + height], deck * 4);
  }
  return boxes;
}

function visited(
  decks: ReturnType<typeof packDecks>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[] {
  const seen: number[] = [];
  forEachDeckIn(decks, minX, minY, maxX, maxY, (deck) => seen.push(deck));
  return seen;
}

function scanned(
  boxes: Float64Array,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[] {
  const seen: number[] = [];
  for (let deck = 0; deck * 4 < boxes.length; deck++) {
    if (
      boxes[deck * 4 + 2] >= minX &&
      boxes[deck * 4] <= maxX &&
      boxes[deck * 4 + 3] >= minY &&
      boxes[deck * 4 + 1] <= maxY
    ) {
      seen.push(deck);
    }
  }
  return seen;
}

test("a window gets every deck a full scan would, exactly once", () => {
  const boxes = boxesOf(4000);
  const decks = packDecks(new Float64Array(0), new Uint32Array(0), boxes);
  for (const size of [0.001, 0.01, 0.1, 1]) {
    for (let step = 0; step < 12; step++) {
      const minX = 74.4 + (step % 4) * 0.12;
      const minY = 96.1 + Math.floor(step / 4) * 0.12;
      const seen = visited(decks, minX, minY, minX + size, minY + size);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort((a, b) => a - b)).toEqual(
        scanned(boxes, minX, minY, minX + size, minY + size),
      );
    }
  }
});

test("a window off the grid, and a day with no decks at all, visit nothing", () => {
  const decks = packDecks(
    new Float64Array(0),
    new Uint32Array(0),
    boxesOf(100),
  );
  expect(visited(decks, 0, 0, 1, 1)).toEqual([]);
  expect(visited(NO_DECKS, 0, 0, 200, 200)).toEqual([]);
});

// A shed that wraps a corner is several spans meeting at the node the wrap walked through, and they
// have to come back out as ONE deck or the two bands leave a notch between them. The artifact stores
// them longest first, so nothing about the order can be assumed.

const SCALE = 1e-6;
const CORNER = 0.001; // a block, in degrees, which is plenty for whether the runs join

// A square block: node n at corner n, edge e from node e to node (e + 1) % 4.
const BLOCK_NODES = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: CORNER },
  { lat: -CORNER, lng: CORNER },
  { lat: -CORNER, lng: 0 },
];

// The edge-path cache is keyed on edge id alone, so a fixture's geometry would otherwise leak.
beforeEach(clearEdgePathCache);

function blockGraph(): RoutingGraph {
  const edgeCount = BLOCK_NODES.length;
  return {
    nodeCount: BLOCK_NODES.length,
    edgeCount,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx: Int32Array.from(BLOCK_NODES, (node) =>
      Math.round(node.lng / SCALE),
    ),
    nodeQy: Int32Array.from(BLOCK_NODES, (node) =>
      Math.round(node.lat / SCALE),
    ),
    edgeNodeA: Uint32Array.from(BLOCK_NODES, (_, edge) => edge),
    edgeNodeB: Uint32Array.from(BLOCK_NODES, (_, edge) => (edge + 1) % 4),
    edgeLength: new Float32Array(edgeCount).fill(100),
    edgeFlags: new Uint8Array(edgeCount), // every sidewalk baked to its geometry-left
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

const shedOf = (spans: ShedSpan[]): Shed => ({
  first: 0,
  close: null,
  confidence: 1,
  spans,
});

const span = (edge: number, t0 = 0, t1 = 1, depth = 0): ShedSpan => ({
  edge,
  t0,
  t1,
  depth,
});

// A deck stands between the building line and the kerb, not on the sidewalk's own line, so a vertex
// lands a metre or two off the node it belongs to and a corner comes back as TWO vertices a step
// apart. Both are matched within a few metres and consecutive repeats collapse, so what these assert
// is the walk order rather than the offset — which has its own test below.
const NEAR_METERS = 5;

function runNodes(graph: RoutingGraph, shed: Shed): number[][] {
  const xs = BLOCK_NODES.map((node) => projectX(node.lng, 0));
  const ys = BLOCK_NODES.map((node) => projectY(node.lat, 0));
  const near = NEAR_METERS * pixelsPerMeter(0);
  return shedRuns(graph, shed).map((run) => {
    const nodes: number[] = [];
    for (let vertex = 0; vertex < run.xs.length; vertex++) {
      const node = xs.findIndex(
        (x, at) =>
          Math.abs(run.xs[vertex] - x) < near &&
          Math.abs(run.ys[vertex] - ys[at]) < near,
      );
      if (nodes[nodes.length - 1] !== node) {
        nodes.push(node);
      }
    }
    return nodes;
  });
}

test("a wrap around two corners comes out as one deck in walk order", () => {
  // Longest first, as the artifact stores them: the middle span, then an end, then the other end.
  const shed = shedOf([span(1), span(2), span(0)]);
  expect(runNodes(blockGraph(), shed)).toEqual([[0, 1, 2, 3]]);
});

test("a wrap that closes on itself is one deck, not a repeated one", () => {
  const graph = blockGraph();
  const shed = shedOf([0, 1, 2, 3].map((edge) => span(edge)));
  const [loop, ...rest] = runNodes(graph, shed);
  expect(rest).toEqual([]);
  // Four corners, each once: the walk closing is the run's own flag rather than a repeated vertex
  // or a second deck starting where it closed.
  expect(loop).toEqual([1, 2, 3, 0]);
  expect(shedRuns(graph, shed)[0].closed).toBe(true);
});

test("spans that only abut mid-edge, and a span pinched to nothing, stay apart", () => {
  const graph = blockGraph();
  // Edge 0 stops halfway, so nothing meets it there; the pinched span decks no length at all.
  const shed = shedOf([span(0, 0, 0.5), span(1), span(2, 0.3, 0.3)]);
  expect(shedRuns(graph, shed).length).toBe(2);
});

test("two sheds meeting at the same corner stay two decks", () => {
  const graph = blockGraph();
  expect(shedRuns(graph, shedOf([span(0)])).length).toBe(1);
  expect(shedRuns(graph, shedOf([span(1)])).length).toBe(1);
});

// The acceptance test the flat 4 m band failed: a deck has to meet the building it stands against.
// Edge 0 runs east along the bottom of the block, geometry-left of its own direction is north, and
// the sidewalk's baked line sits one `sidewalkInsetMeters` out from the kerb — so the deck's far
// edge has to land on the building line whatever the pavement measures, and its near edge a hand's
// breadth off the kerb.

const INSET_METERS = 2; // the manifest's streets.sidewalkInsetMeters, which the graph bakes at
const KERB_MARGIN_METERS = 0.3;
const FALLBACK_METERS = 4; // what a span with no measured depth falls back to

// One straight deck's two long edges, as metres north of the sidewalk's own line — the building side
// being north here, since the edge runs east. Measured off the RING rather than off the run, since
// the ring is what both readers draw.
function bandEdges(depth: number): { kerb: number; building: number } {
  const graph = blockGraph();
  const [run] = shedRuns(graph, shedOf([span(0, 0, 1, depth)]));
  const ring = deckRing(run);
  const line = projectY(BLOCK_NODES[0].lat, 0);
  const ys: number[] = [];
  for (let vertex = 0; vertex * 2 < ring.length; vertex++) {
    ys.push((line - ring[vertex * 2 + 1]) / pixelsPerMeter(0));
  }
  // y runs south in world pixels, so the building edge is the northernmost of the two.
  return { kerb: Math.min(...ys), building: Math.max(...ys) };
}

test("the band runs from just off the kerb out to the building line", () => {
  for (const depth of [2.5, 4, 6, 8]) {
    const { kerb, building } = bandEdges(depth);
    expect(kerb).toBeCloseTo(KERB_MARGIN_METERS - INSET_METERS, 6);
    expect(building).toBeCloseTo(depth - INSET_METERS + KERB_MARGIN_METERS, 6);
  }
});

test("a deck measured narrower than one can be built reaches over the roadway", () => {
  // The building line is where the measurement put it; the width missing from what DOB's rules
  // allow to be built comes off the kerb side, which is the estimate rather than the evidence.
  const measured = 1.2;
  const { kerb, building } = bandEdges(measured);
  expect(building).toBeCloseTo(measured - INSET_METERS + KERB_MARGIN_METERS, 6);
  expect(building - kerb).toBeCloseTo(MIN_DECK_DEPTH_METERS, 6);
  expect(kerb).toBeLessThan(-INSET_METERS); // out past the kerb itself
});

test("a span with no measured depth falls back rather than collapsing", () => {
  const { kerb, building } = bandEdges(0);
  expect(kerb).toBeCloseTo(KERB_MARGIN_METERS - INSET_METERS, 6);
  expect(building).toBeCloseTo(
    FALLBACK_METERS - INSET_METERS + KERB_MARGIN_METERS,
    6,
  );
});

// The depth each of a run's segments carries, in metres.
function runDepths(run: DeckRun): number[] {
  return [...run.building].map(
    (edge, segment) => Math.abs(edge - run.kerb[segment]) / pixelsPerMeter(0),
  );
}

test("a corner onto a pavement of another width stays one deck", () => {
  // The ring states a width per segment, so a shed turning off a wide street onto a narrow one is
  // one deck that steps at the corner — which is exactly where a stroke had to break.
  const graph = blockGraph();
  const [wrapped, ...rest] = shedRuns(
    graph,
    shedOf([span(0, 0, 1, 6), span(1, 0, 1, 2.5)]),
  );
  expect(rest).toEqual([]);
  expect(
    runDepths(wrapped).map((depth) => Math.round(depth * 10) / 10),
  ).toEqual([6, 2.5]);
});

// The ring is the deck's own polygon: out along the building edge and back along the kerb, so its
// vertices come in pairs straddling the run and it winds positively however the sidewalk it stands
// on was baked. Both readers depend on all three.

// Twice the area a ring encloses, positive for the winding a nonzero fill has to see.
function signedDoubleArea(ring: Float64Array): number {
  let sum = 0;
  const count = ring.length / 2;
  for (let vertex = 0; vertex < count; vertex++) {
    const next = (vertex + 1) % count;
    sum +=
      ring[vertex * 2] * ring[next * 2 + 1] -
      ring[next * 2] * ring[vertex * 2 + 1];
  }
  return sum;
}

// The width the ring carries at each pair, in metres.
function ringWidths(ring: Float64Array): number[] {
  const widths: number[] = [];
  const count = ring.length / 4;
  for (let vertex = 0; vertex < count; vertex++) {
    const mirror = count * 2 - 1 - vertex;
    widths.push(
      Math.hypot(
        ring[vertex * 2] - ring[mirror * 2],
        ring[vertex * 2 + 1] - ring[mirror * 2 + 1],
      ) / pixelsPerMeter(0),
    );
  }
  return widths;
}

// Every ring vertex as metres east and north of a block node.
function ringAround(ring: Float64Array, node: number): [number, number][] {
  const scale = pixelsPerMeter(0);
  const originX = projectX(BLOCK_NODES[node].lng, 0);
  const originY = projectY(BLOCK_NODES[node].lat, 0);
  const around: [number, number][] = [];
  for (let vertex = 0; vertex * 2 < ring.length; vertex++) {
    around.push([
      (ring[vertex * 2] - originX) / scale,
      (originY - ring[vertex * 2 + 1]) / scale,
    ]);
  }
  return around;
}

test("a ring is a strip of paired vertices, positively wound", () => {
  const graph = blockGraph();
  // Edge 0 runs east along the top of the block and edge 2 west along the bottom, so between them
  // the walk leaves along the building edge on one and along the kerb edge on the other.
  for (const edge of [0, 2]) {
    for (const depth of [2.5, 6]) {
      const [run] = shedRuns(graph, shedOf([span(edge, 0, 1, depth)]));
      const ring = deckRing(run);
      expect(ring.length).toBe(run.xs.length * 4);
      expect(signedDoubleArea(ring)).toBeGreaterThan(0);
      for (const width of ringWidths(ring)) {
        expect(width).toBeCloseTo(depth, 6);
      }
    }
  }
});

test("a corner turns where the two offset lines meet", () => {
  const graph = blockGraph();
  const [run] = shedRuns(graph, shedOf([span(0, 0, 1, 6), span(1, 0, 1, 2.5)]));
  const ring = deckRing(run);
  expect(signedDoubleArea(ring)).toBeGreaterThan(0);
  // Node 1 is the block's north-east corner: the 6 m deck runs east to it with its building line
  // 4.3 m north, the 2.5 m deck runs south from it with its own 0.8 m east, and the corner of the
  // band is where those two lines cross. Both kerb edges sit 1.7 m the other side of their line.
  const near = (east: number, north: number): boolean =>
    ringAround(ring, 1).some(
      ([atEast, atNorth]) =>
        Math.abs(atEast - east) < 0.01 && Math.abs(atNorth - north) < 0.01,
    );
  expect(near(6 - INSET_METERS + KERB_MARGIN_METERS, 0)).toBe(false);
  expect(near(2.5 - INSET_METERS + KERB_MARGIN_METERS, 4.3)).toBe(true);
  expect(near(KERB_MARGIN_METERS - INSET_METERS, -1.7)).toBe(true);
});

test("a wrap that closes on itself rings as an annulus", () => {
  const graph = blockGraph();
  const [run] = shedRuns(
    graph,
    shedOf([0, 1, 2, 3].map((edge) => span(edge, 0, 1, 4))),
  );
  expect(run.closed).toBe(true);
  const ring = deckRing(run);
  // The repeat of the first vertex closes the loop, and its pair lands back on the first pair — the
  // slit that joins the two loops, which is what leaves the annulus with no notch in it.
  expect(ring.length).toBe((run.xs.length + 1) * 4);
  const count = ring.length / 2;
  expect(ring[0]).toBeCloseTo(ring[(count / 2 - 1) * 2], 9);
  expect(ring[1]).toBeCloseTo(ring[(count / 2 - 1) * 2 + 1], 9);
  expect(signedDoubleArea(ring)).toBeGreaterThan(0);
  // The annulus is the two loops' difference rather than the whole block, so it comes out at the
  // perimeter times the depth rather than at a hundred times that.
  const area = signedDoubleArea(ring) / 2 / pixelsPerMeter(0) ** 2;
  expect(area).toBeGreaterThan(1000);
  expect(area).toBeLessThan(2500);
});

test("a band under the minimum width opens out about its own middle", () => {
  const graph = blockGraph();
  const decks = packRuns(shedRuns(graph, shedOf([span(0, 0, 1, 4)])));
  const traced = (minWidth: number): { x: number; y: number }[] => {
    const points: { x: number; y: number }[] = [];
    traceDeck(
      {
        moveTo: (x, y) => points.push({ x, y }),
        lineTo: (x, y) => points.push({ x, y }),
        closePath: () => {},
      },
      decks,
      0,
      1,
      0,
      0,
      minWidth,
    );
    return points;
  };
  const spread = (points: { x: number; y: number }[]): number =>
    Math.max(...points.map(({ y }) => y)) -
    Math.min(...points.map(({ y }) => y));
  const asDrawn = traced(0);
  expect(spread(asDrawn)).toBeCloseTo(4 * pixelsPerMeter(0), 9);
  const opened = traced(8 * pixelsPerMeter(0));
  expect(spread(opened)).toBeCloseTo(8 * pixelsPerMeter(0), 9);
  // Opened about the middle: the band's own centre has not moved.
  const middle = (points: { x: number; y: number }[]): number =>
    (Math.max(...points.map(({ y }) => y)) +
      Math.min(...points.map(({ y }) => y))) /
    2;
  expect(middle(opened)).toBeCloseTo(middle(asDrawn), 9);
  // A band already wider than the floor is left exactly as it stands.
  expect(spread(traced(pixelsPerMeter(0)))).toBeCloseTo(
    4 * pixelsPerMeter(0),
    9,
  );
});
