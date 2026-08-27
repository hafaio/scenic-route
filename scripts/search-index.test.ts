// The builder's own decisions: which street a place is filed under when several share a name, how a
// street's spellings become tokens, and what a category is worth. The encode/decode round trip and
// the query itself are src/search/search-query.test.ts.

import { expect, test } from "bun:test";
import { parseHouseNumber } from "../src/search/address-format";
import { type AddressIndex, decodeAddresses } from "../src/search/addresses";
import { unpackTokenInfo } from "../src/search/search-format";
import { decodeSearchIndex, searchNames } from "../src/search/search-query";
import { type AddressRow, encodeAddresses } from "./addresses";
import {
  buildDocs,
  encodeSearch,
  type PlaceArea,
  type PlaceRow,
  prominenceOf,
  streetTokens,
} from "./search-index";

const BROOKLYN = { lat: 40.686, lng: -73.995 };
const QUEENS = { lat: 40.75, lng: -73.87 };

function address(
  street: string,
  place: string,
  number: string,
  at: { lat: number; lng: number },
): AddressRow {
  const parsed = parseHouseNumber(number);
  if (parsed === null) {
    throw new Error(`${number} is not a house number`);
  }
  return { street, place, number: parsed, ...at };
}

function addressFile(rows: readonly AddressRow[]): AddressIndex {
  return decodeAddresses(encodeAddresses(rows).bytes);
}

function placeRow(overrides: Partial<PlaceRow> = {}): PlaceRow {
  return {
    name: "Somewhere",
    category: null,
    ...BROOKLYN,
    street: null,
    houseNumber: null,
    ...overrides,
  };
}

test("a place on a name two boroughs share is filed under the nearer one", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
    address("COURT ST", "Brooklyn", "320", BROOKLYN),
    address("COURT ST", "Queens", "312", QUEENS),
    address("COURT ST", "Queens", "320", QUEENS),
  ]);
  const { docs } = buildDocs(
    [
      placeRow({
        name: "Brooklyn Bagel",
        street: "COURT ST",
        houseNumber: parseHouseNumber("312"),
        ...BROOKLYN,
      }),
      placeRow({
        name: "Queens Bagel",
        street: "COURT ST",
        houseNumber: parseHouseNumber("312"),
        ...QUEENS,
      }),
    ],
    addresses,
  );
  const brooklyn = docs.find((doc) => doc.name === "Brooklyn Bagel");
  const queens = docs.find((doc) => doc.name === "Queens Bagel");
  // The places blob is ascending, so Brooklyn is 0 and Queens is 1.
  expect(brooklyn?.placeIndex).toBe(0);
  expect(queens?.placeIndex).toBe(1);
  expect(brooklyn?.streetIndex).not.toBe(queens?.streetIndex);
});

test("a place that never joined carries no street, and no borough where nothing places it", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const { docs, summary } = buildDocs(
    [placeRow({ name: "Prospect Park" })],
    addresses,
  );
  const park = docs.find((doc) => doc.name === "Prospect Park");
  expect(park?.placeIndex).toBe(-1);
  expect(park?.streetIndex).toBe(-1);
  expect(park?.number).toBeNull();
  expect(summary.joined).toBe(0);
  expect(summary.homeless).toBe(1);
});

// The 53,507 New York places with a name and no front door — the parks, the campuses, the beaches.
// Nothing in the Overture row says which borough one is in, so the city's own boundaries do.
test("a place with no address takes its borough from the boundary it is inside", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
    address("MAIN ST", "Queens", "40", QUEENS),
  ]);
  const areas: PlaceArea[] = [
    { placeIndex: 0, contains: ({ lng }) => lng < -73.9 },
    { placeIndex: 1, contains: ({ lng }) => lng >= -73.9 },
  ];
  const { docs, summary } = buildDocs(
    [
      placeRow({ name: "Prospect Park" }),
      placeRow({ name: "Flushing Meadows", ...QUEENS }),
      // Still the street's answer where there is one, which is the address's own and not a guess.
      placeRow({
        name: "Brooklyn Bagel",
        street: "COURT ST",
        houseNumber: parseHouseNumber("312"),
      }),
    ],
    addresses,
    areas,
  );
  const borough = (name: string) =>
    docs.find((doc) => doc.name === name)?.placeIndex;
  expect(borough("Prospect Park")).toBe(0);
  expect(borough("Flushing Meadows")).toBe(1);
  expect(borough("Brooklyn Bagel")).toBe(0);
  expect(summary.bounded).toBe(2);
  expect(summary.homeless).toBe(0);
});

test("a street is one document per (name, place), placed among its own addresses", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
    address("COURT ST", "Queens", "312", QUEENS),
  ]);
  const { docs, summary } = buildDocs([], addresses);
  expect(summary.streets).toBe(2);
  expect(docs.map((doc) => doc.kind)).toEqual(["street", "street"]);
  expect(docs[0].lat).toBeCloseTo(BROOKLYN.lat, 4);
  expect(docs[1].lat).toBeCloseTo(QUEENS.lat, 4);
});

test("a numbered street is indexed in every spelling it gets typed as", () => {
  const tokens = streetTokens("W 5 ST", "West 5th Street");
  expect(tokens).toContain("5");
  expect(tokens).toContain("5th");
  expect(tokens).toContain("fifth");
  expect(tokens).toContain("west");
  expect(tokens).toContain("st");
  expect(tokens).toContain("street");
  // A compound spells as its words, which is how the query "two hundred seventy first" reaches it.
  const high = streetTokens("W 271 ST", "West 271st Street");
  expect(high).toContain("two");
  expect(high).toContain("hundred");
  expect(high).toContain("seventy");
  expect(high).toContain("first");
  // A street the routing graph names has only the suffixed spelling to work from, and the query side
  // rebuilds the words from the display name, so a suffix has to spell out just as a bare digit does.
  expect(streetTokens("West 4th Street", "West 4th Street")).toContain(
    "fourth",
  );
});

test("the numbered street a query spells out is the one that comes back", () => {
  const addresses = addressFile([
    address("5 AVE", "Manhattan", "350", { lat: 40.748, lng: -73.985 }),
    address("6 AVE", "Manhattan", "350", { lat: 40.748, lng: -73.988 }),
  ]);
  const { docs } = buildDocs([], addresses);
  const index = decodeSearchIndex(encodeSearch(docs).bytes);
  const found = (text: string) =>
    searchNames(index, {
      text,
      centre: { lat: 40.748, lng: -73.986 },
      limit: 5,
    }).map((hit) => hit.name);
  expect(found("fifth avenue")[0]).toBe("5th Avenue");
  expect(found("5 ave")[0]).toBe("5th Avenue");
  expect(found("5th ave")[0]).toBe("5th Avenue");
});

test("the categories that matter outrank the ones that do not", () => {
  expect(prominenceOf("metro_station", false)).toBeGreaterThan(
    prominenceOf("park", false),
  );
  expect(prominenceOf("park", false)).toBeGreaterThan(
    prominenceOf("art_museum", false),
  );
  expect(prominenceOf("art_museum", false)).toBeGreaterThan(
    prominenceOf("high_school", false),
  );
  expect(prominenceOf("high_school", false)).toBeGreaterThan(
    prominenceOf("pizza_restaurant", false),
  );
  expect(prominenceOf("pizza_restaurant", false)).toBeGreaterThan(
    prominenceOf("health_and_medical", false),
  );
  expect(prominenceOf("health_and_medical", false)).toBeGreaterThan(
    prominenceOf("professional_services", false),
  );
  expect(prominenceOf(null, false)).toBe(
    prominenceOf("health_and_medical", false),
  );
});

test("a category is read as words, not as a substring of one", () => {
  // The four that used to carry whole tiers on an accident of spelling: a filling station is not a
  // subway station, a car park is not a park, an advertising agency is not a greengrocer, and a
  // named apartment block is not a landmark.
  expect(prominenceOf("gas_station", false)).toBeLessThan(
    prominenceOf("train_station", false),
  );
  expect(prominenceOf("parking", false)).toBeLessThan(
    prominenceOf("park", false),
  );
  expect(prominenceOf("marketing_agency", false)).toBeLessThan(
    prominenceOf("grocery_store", false),
  );
  expect(prominenceOf("landmark_and_historical_building", false)).toBe(
    prominenceOf(null, false),
  );
});

test("a park with a house number on it is a business", () => {
  // The Meeker Avenue storefront that Overture files under `park`, against the 213 hectares in
  // Brooklyn. A museum keeps its tier either way: it has a front door.
  expect(prominenceOf("park", true)).toBe(prominenceOf(null, false));
  expect(prominenceOf("park", true)).toBeLessThan(prominenceOf("park", false));
  expect(prominenceOf("art_museum", true)).toBe(
    prominenceOf("art_museum", false),
  );
});

test("the summary counts the names nothing will ever find", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const { summary } = buildDocs(
    [
      placeRow({ name: "!!!" }),
      placeRow({ name: "Joes Pizza" }),
      placeRow({
        name: Array.from({ length: 20 }, (_, at) => `word${at}`).join(" "),
      }),
    ],
    addresses,
  );
  expect(summary.places).toBe(3);
  expect(summary.untokenized).toBe(1);
  expect(summary.longNames).toBe(1);
});

test("the encoder reports the corpus it wrote", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const { docs } = buildDocs(
    [
      placeRow({ name: "Joes Pizza", category: "pizza_restaurant" }),
      placeRow({ name: "Pizza Palace", category: "pizza_restaurant" }),
      placeRow({ name: "Bagel Shop", category: "bakery" }),
    ],
    addresses,
  );
  const encoded = encodeSearch(docs);
  expect(encoded.docCount).toBe(4);
  expect(encoded.largestList).toEqual({ token: "pizza", postings: 2 });
  expect(encoded.postingBytes).toBeGreaterThan(0);
  // The write buffer is sized against an upper bound and handed back trimmed to what was used.
  expect(encoded.bytes.byteLength).toBeLessThan(
    encoded.bytes.buffer.byteLength,
  );
});
