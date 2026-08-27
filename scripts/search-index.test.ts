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
    { areas },
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

// The curated sets: one document each, with the tier their own source earns them rather than an
// Overture category they have none of.
test("a named point is a document of its own kind", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const { docs, summary } = buildDocs([], addresses, {
    sets: [
      {
        kind: "station",
        source: "subway",
        prominence: 240,
        priority: 0,
        points: [
          { name: "Borough Hall", detail: "2/3/4/5/R", ...BROOKLYN },
          { name: "!!!", ...BROOKLYN },
        ],
      },
    ],
  });
  const station = docs.find((doc) => doc.name === "Borough Hall");
  expect(station?.kind).toBe("station");
  expect(station?.prominence).toBe(240);
  // The routes ride in the category slot, which is what a station result reads with.
  expect(station?.category).toBe("2/3/4/5/R");
  // A name with no searchable word is nothing a search can reach, so it is not a document.
  expect(summary.points).toBe(1);
});

test("one place two sources name is one document, and the curated one is what stays", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const nearby = { lat: BROOKLYN.lat + 0.0005, lng: BROOKLYN.lng };
  const { docs, summary } = buildDocs(
    [
      placeRow({
        name: "Borough Hall",
        category: "landmark_and_historical_building",
        street: "COURT ST",
        houseNumber: parseHouseNumber("312"),
      }),
      placeRow({ name: "Borough Hall", ...QUEENS }),
    ],
    addresses,
    {
      sets: [
        {
          kind: "station",
          source: "subway",
          prominence: 240,
          priority: 0,
          points: [{ name: "Borough Hall", detail: "2/3/4/5/R", ...nearby }],
        },
      ],
    },
  );
  const kept = docs.filter((doc) => doc.name === "Borough Hall");
  expect(kept.map((doc) => doc.kind)).toEqual(["place", "station"]);
  expect(summary.duplicates).toBe(1);
  // What the dropped row knew and the station did not: the door it stands at, and the borough.
  const station = kept.find((doc) => doc.kind === "station");
  expect(station?.number).toEqual(parseHouseNumber("312"));
  expect(station?.placeIndex).toBe(0);
  // And what it already knew stays its own: the routes are not overwritten by an Overture slug.
  expect(station?.category).toBe("2/3/4/5/R");
  // The one in Queens is a different place with the same name, and is not a duplicate of anything.
  expect(docs.some((doc) => doc.lat === QUEENS.lat)).toBe(true);
});

test("a dining point behind an Overture row of the same name is the one that goes", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const { docs } = buildDocs(
    [placeRow({ name: "Killmeyer's", category: "bar" })],
    addresses,
    {
      sets: [
        {
          kind: "place",
          source: "dining",
          prominence: 120,
          priority: 2,
          points: [{ name: "Killmeyer's", ...BROOKLYN }],
        },
      ],
    },
  );
  const kept = docs.filter((doc) => doc.name === "Killmeyer's");
  expect(kept).toHaveLength(1);
  expect(kept[0].category).toBe("bar");
});

test("a district takes the borough of the shop on its corner and not the shop's door", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const nearby = { lat: BROOKLYN.lat + 0.0005, lng: BROOKLYN.lng };
  const { docs } = buildDocs(
    [
      placeRow({
        name: "Bay Ridge",
        category: "banks",
        street: "COURT ST",
        houseNumber: parseHouseNumber("312"),
      }),
    ],
    addresses,
    {
      sets: [
        {
          kind: "neighborhood",
          source: "neighborhoods",
          prominence: 150,
          priority: 0,
          points: [{ name: "Bay Ridge", ...nearby }],
        },
      ],
    },
  );
  const kept = docs.filter((doc) => doc.name === "Bay Ridge");
  expect(kept.map((doc) => doc.kind)).toEqual(["neighborhood"]);
  expect(kept[0].placeIndex).toBe(0);
  // A district is not a bank and has no front door, so neither the category nor the number the bank
  // stands at follows the name.
  expect(kept[0].category).toBe(null);
  expect(kept[0].streetIndex).toBe(-1);
  expect(kept[0].number).toBe(null);
});

test("the higher of two sources' tiers is what the one document keeps", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const nearby = { lat: BROOKLYN.lat + 0.0005, lng: BROOKLYN.lng };
  const { docs } = buildDocs(
    [placeRow({ name: "Nolan Park", category: "park" })],
    addresses,
    {
      sets: [
        {
          kind: "neighborhood",
          source: "neighborhoods",
          prominence: 150,
          priority: 0,
          points: [{ name: "Nolan Park", ...nearby }],
        },
      ],
    },
  );
  const kept = docs.filter((doc) => doc.name === "Nolan Park");
  // Each tier is what its own source can vouch for: the district that survived is also the park the
  // row it replaced knew about.
  expect(kept.map((doc) => doc.kind)).toEqual(["neighborhood"]);
  expect(kept[0].prominence).toBe(prominenceOf("park", false));
});

test("a street the graph names and the address file does not is still a document", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const { docs, summary } = buildDocs([], addresses, {
    streets: [{ name: "Bow Bridge", tokens: ["bow", "bridge"], ...BROOKLYN }],
  });
  const bridge = docs.find((doc) => doc.name === "Bow Bridge");
  expect(bridge?.kind).toBe("street");
  // No addresses on it, so no ordinal and no house number to resolve — a name and a point.
  expect(bridge?.streetIndex).toBe(-1);
  expect(summary.graphStreets).toBe(1);
});

test("a document's token count is the words of its name, however often one repeats", () => {
  const addresses = addressFile([
    address("COURT ST", "Brooklyn", "312", BROOKLYN),
  ]);
  const { docs } = buildDocs(
    [placeRow({ name: "Boutique Boutique" }), placeRow({ name: "Boutique" })],
    addresses,
  );
  const index = decodeSearchIndex(encodeSearch(docs).bytes);
  const doc = docs.findIndex(({ name }) => name === "Boutique Boutique");
  expect(unpackTokenInfo(index.tokenInfo[doc]).tokenCount).toBe(2);
  // Which is what keeps the repeated word from reading as a whole name covered: one typed word is
  // half of "Boutique Boutique" and the whole of "Boutique", and the shorter name is the better
  // answer to it.
  const found = searchNames(index, {
    text: "boutique",
    centre: BROOKLYN,
    limit: 5,
  });
  const textOf = (name: string): number =>
    found.find((hit) => hit.name === name)?.text ?? Number.NaN;
  expect(textOf("Boutique Boutique")).toBeLessThan(textOf("Boutique"));
});
