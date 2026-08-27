import { expect, test } from "bun:test";
import type { RoutingGraph } from "./graph";
import { rankName, searchStreets } from "./street-search";

// The graph's own name table is the only street index the app has offline, so what these pin is that
// a name in it is findable and that a common word cannot flood the list.

function graphOf(names: string[]): RoutingGraph {
  const edgeNameId = new Uint16Array(names.length);
  const edgeNodeA = new Uint32Array(names.length);
  const nodeQx = new Int32Array(names.length);
  const nodeQy = new Int32Array(names.length);
  for (let edge = 0; edge < names.length; edge += 1) {
    edgeNameId[edge] = edge;
    edgeNodeA[edge] = edge;
    nodeQx[edge] = edge * 1000;
    nodeQy[edge] = edge * 2000;
  }
  return {
    edgeCount: names.length,
    names,
    edgeNameId,
    edgeNodeA,
    nodeQx,
    nodeQy,
    originLat: 40,
    originLng: -74,
    scale: 0.000001,
  } as unknown as RoutingGraph;
}

// Upper case, as the graph actually stores them, so the prettifying is part of what is pinned.
const GRAPH = graphOf([
  "BEDFORD AVENUE",
  "GRAND ARMY PLAZA",
  "GRAND STREET",
  "SIXTH GRAND COURT",
  "ATLANTIC AVENUE",
  "5 AVE",
  "W  239 ST", // two spaces, as the source writes it
]);

test("a name that starts with the query outranks one that merely contains it", () => {
  expect(rankName("Grand Street", "grand")).toBe(2);
  expect(rankName("Sixth Grand Court", "grand")).toBe(1);
  expect(rankName("Atlantic Avenue", "grand")).toBe(0);
});

test("streets are found by prefix and ranked, best first", () => {
  const hits = searchStreets(GRAPH, "grand", 10);
  expect(hits.map((hit) => hit.place.name)).toEqual([
    "Grand Army Plaza",
    "Grand Street",
    "Sixth Grand Court",
  ]);
});

// The prettified name is what the list shows, and comparing against only that quietly lost every
// numbered street in New York: "5 Av" is on the sign, "5th Avenue" is this app's own spelling, and
// neither starts with the other.
test("a numbered street is found the way it is signposted, and the way we print it", () => {
  for (const query of ["5 Av", "5 AVE", "5th Ave", "5th Avenue"]) {
    expect(searchStreets(GRAPH, query, 5).map((hit) => hit.place.name)).toEqual(
      ["5th Avenue"],
    );
  }
});

// The source writes two spaces between the tokens; nobody types it that way.
test("a run of whitespace in the source name is one space to a search", () => {
  expect(
    searchStreets(GRAPH, "W 239 St", 5).map((hit) => hit.place.name),
  ).toEqual(["West 239th Street"]);
});

test("one letter matches half a city, so it matches nothing", () => {
  expect(searchStreets(GRAPH, "g", 10)).toEqual([]);
});

test("the limit holds, so a common word cannot bury the rest of the list", () => {
  expect(searchStreets(GRAPH, "grand", 2)).toHaveLength(2);
});

test("a street carries the coordinates of the first edge that named it", () => {
  const [hit] = searchStreets(GRAPH, "bedford", 1);
  expect(hit.place.lat).toBeCloseTo(40, 6);
  expect(hit.place.lng).toBeCloseTo(-74, 6);
});
