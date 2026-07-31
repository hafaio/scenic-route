import { expect, test } from "bun:test";
import { encodeSheds, graphHashOf } from "../../scripts/shed-encode";
import { NO_GEOMETRY, NO_SOURCE_ID, type RoutingGraph } from "./graph";
import {
  decodeSheds,
  type Shed,
  type ShedHistory,
  shedDay,
  shedsOn,
} from "./sheds";
import {
  CLOSED_BASE64,
  COVERAGE,
  FIXTURE_EDGES,
  type FixtureShed,
  fixtureDepth,
  fixtureDurable,
  fixtureJob,
  GRAPH_HASH,
  INDEX_BASE64,
  LAST_DAY,
  OPEN_BASE64,
  SHEDS,
} from "./sheds.fixture";

// The reader against a slice of the real shed history (sheds.fixture.ts). The expected records and
// coverage there come from the Python prototype's CSV rows and a naive day-by-day scan, so nothing
// about the byte layout is asserted by the thing that produced it.
//
// What the fixture does not carry is the prototype's own BYTES: the three blobs are this encoder's
// output, a regression pin rather than a foreign witness (sheds.fixture.ts says why). The records
// above them are still foreign.

function buffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

const history = decodeSheds(
  buffer(OPEN_BASE64),
  buffer(CLOSED_BASE64),
  buffer(INDEX_BASE64),
);

// The fixture's records with every span named the way the artifact names it, and every record named
// by the job number `open.bin` carries for it.
const DURABLE_SHEDS = SHEDS.map((shed, order) => ({
  job: fixtureJob(order),
  first: shed.first,
  close: shed.close,
  confidence: shed.confidence,
  spans: shed.spans.map((span) => ({
    ...fixtureDurable(span.edge),
    t0: span.t0,
    t1: span.t1,
    depth: fixtureDepth(span.edge),
  })),
}));

const DEGREES = Math.PI / 180;
const MIDTOWN = { lat: 40.75, lng: -73.98 };
const QUANTUM = 1e-6;
const SIDE_SHIFT = 3; // the graph's kind-and-side byte, bits 3-5

// A graph of straight edges out of one node, edge `i` running at `bearings[i]` (degrees) for ~110 m.
// Geometry-less, so edgePath reads the node coordinates — which is all the shed field needs of a graph.
function straightGraph(edgeCount: number, ...bearings: number[]): RoutingGraph {
  const nodeQx = new Int32Array(edgeCount + 1);
  const nodeQy = new Int32Array(edgeCount + 1);
  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const span = 0.001; // degrees of latitude
  for (let edge = 0; edge < edgeCount; edge++) {
    const bearing = bearings[edge % bearings.length] * DEGREES;
    nodeQx[edge + 1] = Math.round(
      (span * Math.sin(bearing)) / Math.cos(MIDTOWN.lat * DEGREES) / QUANTUM,
    );
    nodeQy[edge + 1] = Math.round((span * Math.cos(bearing)) / QUANTUM);
    edgeNodeA[edge] = 0;
    edgeNodeB[edge] = edge + 1;
  }
  return {
    edgeCount,
    nodeCount: edgeCount + 1,
    originLat: MIDTOWN.lat,
    originLng: MIDTOWN.lng,
    scale: QUANTUM,
    nodeQx,
    nodeQy,
    edgeNodeA,
    edgeNodeB,
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
  } as unknown as RoutingGraph;
}

// A graph of `edgeCount` straight edges carrying the fixture's durable key column, with the key of
// fixture edge `e` sitting at `place(e)`. A key placed outside the graph is simply not in it, which
// is how a span this graph has no edge for gets exercised.
function movedGraph(
  edgeCount: number,
  place: (edge: number) => number,
): RoutingGraph {
  const graph = straightGraph(edgeCount, 0);
  graph.edgeSourceId = new Uint32Array(edgeCount).fill(NO_SOURCE_ID);
  graph.edgeOrdinal = new Uint8Array(edgeCount);
  graph.edgeKindSide = new Uint8Array(edgeCount);
  for (const edge of FIXTURE_EDGES) {
    const at = place(edge);
    if (at >= 0 && at < edgeCount) {
      const { sourceId, side, ordinal } = fixtureDurable(edge);
      graph.edgeSourceId[at] = sourceId;
      graph.edgeOrdinal[at] = ordinal;
      graph.edgeKindSide[at] = side << SIDE_SHIFT;
    }
  }
  return graph;
}

function namedGraph(edgeCount: number): RoutingGraph {
  return movedGraph(edgeCount, (edge) => edge);
}

const EDGE_COUNT = Math.max(...FIXTURE_EDGES) + 1;
const graph = namedGraph(EDGE_COUNT);

// Every shed the fixture says stood on `day`, by the definition the format is meant to encode. This
// is the oracle the seek-and-suffix decode is checked against.
function standingOn(day: number): FixtureShed[] {
  return SHEDS.filter(
    (shed) => shed.first <= day && (shed.close === null || shed.close >= day),
  );
}

// Both sides flattened to one comparable shape: the fixture holds the quantized bytes the format
// stores, the reader hands back the fractions they stand for. Spans go into edge order on both sides
// — the format stores them in durable-key order, which is its own business and not an assertion.
function normalize(sheds: readonly Shed[]): string {
  return JSON.stringify(
    sheds
      .map((shed) => ({
        ...shed,
        spans: [...shed.spans].sort((left, right) => left.edge - right.edge),
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
}

function fromFixture(sheds: FixtureShed[]): string {
  return normalize(
    sheds.map((shed) => ({
      first: shed.first,
      close: shed.close,
      confidence: shed.confidence / 255,
      spans: shed.spans.map(({ edge, t0, t1 }) => ({
        edge,
        t0: t0 / 255,
        t1: t1 / 255,
        depth: fixtureDepth(edge) / 10,
      })),
    })),
  );
}

function fromReader(sheds: Shed[]): string {
  return normalize(sheds);
}

test("the header describes the two halves it was written with", () => {
  expect(history.graphHash).toBe(GRAPH_HASH);
  const open = SHEDS.filter((shed) => shed.close === null);
  const closed = SHEDS.filter((shed) => shed.close !== null);
  expect(history.open.count).toBe(open.length);
  expect(history.closed.count).toBe(closed.length);
  expect(history.open.spanCount).toBe(
    open.reduce((total, shed) => total + shed.spans.length, 0),
  );
  expect(history.closed.spanCount).toBe(
    closed.reduce((total, shed) => total + shed.spans.length, 0),
  );
});

test("the encoder writes the bytes checked in beside the records", () => {
  // Fed the fixture's declared records — which came from the prototype's CSV rows, not from any
  // encoder — our writer has to land on the three blobs checked in beside them, byte for byte.
  const rebuilt = encodeSheds(DURABLE_SHEDS, GRAPH_HASH, LAST_DAY);
  expect(rebuilt.open).toEqual(new Uint8Array(buffer(OPEN_BASE64)));
  expect(rebuilt.closed).toEqual(new Uint8Array(buffer(CLOSED_BASE64)));
  expect(rebuilt.index).toEqual(new Uint8Array(buffer(INDEX_BASE64)));
});

test("the daily job's window in the header moves the records, not the answers", () => {
  // `closed.bin` ends its header with the truncation window `update-sheds` picks the feed back up
  // with, which is 60 bytes the client walks straight past — and 60 bytes every offset in `index.bin`
  // has to have moved by. Same records, same days, from a file the reader has to measure rather than
  // assume the shape of.
  const counts = Array.from({ length: 30 }, (_, order) => 8_900 + order);
  const withWindow = encodeSheds(DURABLE_SHEDS, GRAPH_HASH, LAST_DAY, counts);
  const bare = encodeSheds(DURABLE_SHEDS, GRAPH_HASH, LAST_DAY);

  expect(withWindow.closed.length).toBe(bare.closed.length + 2 * counts.length);
  expect(withWindow.open).toEqual(bare.open);
  const offsetsOf = (index: Uint8Array): number[] => {
    const view = new DataView(index.buffer as ArrayBuffer);
    return Array.from({ length: index.length / 8 }, (_, entry) =>
      view.getUint32(entry * 8 + 2, true),
    );
  };
  expect(offsetsOf(withWindow.index)).toEqual(
    offsetsOf(bare.index).map((offset) => offset + 2 * counts.length),
  );
  const shifted = decodeSheds(
    withWindow.open.buffer as ArrayBuffer,
    withWindow.closed.buffer as ArrayBuffer,
    withWindow.index.buffer as ArrayBuffer,
  );
  for (const day of COVERAGE.map((entry) => entry.day)) {
    expect(fromReader(shedsOn(graph, shifted, day))).toBe(
      fromFixture(standingOn(day)),
    );
  }
});

test("the two halves are rejected in the wrong order", () => {
  expect(() =>
    decodeSheds(
      buffer(CLOSED_BASE64),
      buffer(OPEN_BASE64),
      buffer(INDEX_BASE64),
    ),
  ).toThrow();
});

test("a shed decodes on the first and last day it stood, and not around them", () => {
  for (const shed of SHEDS) {
    for (const day of [shed.first, shed.close ?? shed.first + 1]) {
      expect(fromReader(shedsOn(graph, history, day))).toBe(
        fromFixture(standingOn(day)),
      );
    }
    expect(
      shedsOn(graph, history, shed.first - 1).map((decoded) => decoded.first),
    ).not.toContain(shed.first);
  }
});

// Every day any record touches, and every month boundary the index carries.
function probeDays(): Set<number> {
  const days = new Set<number>();
  for (const shed of SHEDS) {
    for (const day of [shed.first - 1, shed.first, shed.first + 1]) {
      days.add(day);
    }
    if (shed.close !== null) {
      for (const day of [shed.close - 1, shed.close, shed.close + 1]) {
        days.add(day);
      }
    }
  }
  for (const month of history.months) {
    days.add(month);
    days.add(month - 1);
  }
  return days;
}

// The suffix read is where a subtle bug would live: seeking past the head of closed.bin means the
// close-day chain has to re-base from the index rather than replay it, and a record's edge deltas
// have to restart rather than carry the previous record's last edge.
test("seeking to a past day decodes the records the file was built from", () => {
  expect(history.months.length).toBeGreaterThan(1); // or the seek is never exercised
  for (const day of probeDays()) {
    expect(fromReader(shedsOn(graph, history, day))).toBe(
      fromFixture(standingOn(day)),
    );
  }
});

// The whole point of the durable key. A rebuilt graph renumbers every edge, and an artifact keyed on
// positions would silently move scaffolding onto other streets; keyed on (source id, side, ordinal)
// it lands back where it was. The "rebuild" here reverses the edge order, which is as thorough a
// renumbering as there is.
test("a shed lands on the same street after a rebuild renumbers every edge", () => {
  const rebuilt = movedGraph(EDGE_COUNT, (edge) => EDGE_COUNT - 1 - edge);
  let moved = 0;
  for (const day of probeDays()) {
    const before = shedsOn(graph, history, day);
    const after = shedsOn(rebuilt, history, day);
    expect(after.length).toBe(before.length);
    for (let record = 0; record < before.length; record++) {
      const positions = after[record].spans.map((span) => span.edge);
      expect(positions).toEqual(
        before[record].spans.map((span) => {
          moved += 1;
          return EDGE_COUNT - 1 - span.edge;
        }),
      );
      expect(positions).not.toContain(-1);
    }
  }
  expect(moved).toBeGreaterThan(0); // or the renumbering was never exercised
});

test("the index seek agrees with a full linear scan", () => {
  // The same history with no index: every seek falls back to the head of closed.bin, so the walk is
  // the whole file. Only the seek differs between the two, so a disagreement is the seek's.
  const scanned: ShedHistory = {
    ...history,
    months: new Uint16Array(0),
    offsets: new Uint32Array(0),
    closeDays: new Uint16Array(0),
  };
  for (const day of probeDays()) {
    expect(fromReader(shedsOn(graph, history, day))).toBe(
      fromReader(shedsOn(graph, scanned, day)),
    );
  }
});

test("a Date maps to its own local calendar day", () => {
  expect(shedDay(new Date(2017, 11, 28, 23, 59))).toBe(0);
  expect(shedDay(new Date(2018, 0, 1, 0, 0))).toBe(4);
  expect(shedDay(new Date(2026, 6, 29, 12, 0))).toBe(3135);
});

// The graph hash the artifact's header carries. Recomputed from the graph's own bytes rather than
// read out of routing/version.json, because the daily job snaps against whatever graph the live site
// is serving and that deploy can predate the version file. Pinned against the FNV-1a 64 reference
// vectors, not against `tiler graph`'s output, so the two implementations stay independent.
test("the graph hash is FNV-1a 64", () => {
  const of = (text: string): string =>
    graphHashOf(new TextEncoder().encode(text));
  expect(of("")).toBe("cbf29ce484222325");
  expect(of("a")).toBe("af63dc4c8601ec8c");
  expect(of("foobar")).toBe("85944171f73967e8");
});
