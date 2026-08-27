// The query side of SRCH, against indexes small enough to reason about — plus one property test
// over a random corpus, which is the only thing that checks the front-coding, the block restarts and
// the delta-varint postings all agree with each other rather than each being plausible alone.

import { expect, test } from "bun:test";
import { encodeAddresses } from "../../scripts/addresses";
import {
  encodeSearch,
  type SearchDoc,
  streetTokens,
} from "../../scripts/search-index";
import { decodeAddresses } from "./addresses";
import { spelledOrdinals, tokenize } from "./search-format";
import {
  decodeSearchIndex,
  distanceFactor,
  prominenceFactor,
  type SearchIndex,
  searchCity,
  searchNames,
  splitTrailingPlace,
} from "./search-query";

// Somewhere for documents whose test is not about where they are. Everything sits on top of the
// centre unless it says otherwise, so distance drops out of the ordering.
const HERE = { lat: 40.73, lng: -73.99 };

const DEFAULT_PROMINENCE = 120;

function place(name: string, overrides: Partial<SearchDoc> = {}): SearchDoc {
  return {
    name,
    kind: "place",
    tokens: [...new Set(tokenize(name))],
    lat: HERE.lat,
    lng: HERE.lng,
    prominence: DEFAULT_PROMINENCE,
    category: null,
    placeIndex: -1,
    streetIndex: -1,
    number: null,
    ...overrides,
  };
}

function build(docs: readonly SearchDoc[]): SearchIndex {
  return decodeSearchIndex(encodeSearch(docs).bytes);
}

function names(
  index: SearchIndex,
  text: string,
  limit = 20,
  centre = HERE,
): string[] {
  return searchNames(index, { text, centre, limit }).map((hit) => hit.name);
}

// Deterministic, so a failing corpus is the same corpus next run.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "joes",
  "pizza",
  "pizzeria",
  "cafe",
  "coffee",
  "bakery",
  "park",
  "playground",
  "bridge",
  "broadway",
  "court",
  "carmine",
  "bryant",
  "williamsburg",
  "atlantic",
  "avenue",
  "street",
  "corner",
  "corp",
  "company",
  "cosmetics",
  "grand",
  "central",
  "terminal",
];

test("every word of every name finds its own document, whole or as a prefix", () => {
  const next = random(20260824);
  const docs = Array.from({ length: 120 }, () => {
    const count = 1 + Math.floor(next() * 4);
    const words = Array.from(
      { length: count },
      () => WORDS[Math.floor(next() * WORDS.length)],
    );
    return place(words.join(" "), {
      lat: HERE.lat + (next() - 0.5) * 0.2,
      lng: HERE.lng + (next() - 0.5) * 0.2,
      prominence: Math.floor(next() * 256),
    });
  });
  const index = build(docs);
  // Wide enough that nothing is cut for want of room: the claim is findability, not ordering.
  const limit = docs.length * 2;
  for (const doc of docs) {
    for (const word of doc.tokens) {
      expect(names(index, word, limit)).toContain(doc.name);
      for (let length = 2; length < word.length; length += 1) {
        expect(names(index, word.slice(0, length), limit)).toContain(doc.name);
      }
    }
    // And by the whole name, which is the query someone who knows what they want types.
    expect(names(index, doc.name, limit)).toContain(doc.name);
  }
});

test("a prefix run spanning several front-coded blocks comes back whole", () => {
  // Forty-one tokens under one prefix, which is three blocks of sixteen and a bit: the run starts
  // inside one block, crosses two boundaries and stops inside another.
  const docs = Array.from({ length: 41 }, (_, index) =>
    place(`alpha${String(index).padStart(3, "0")}`),
  );
  const index = build([...docs, place("beta"), place("zulu")]);
  expect(names(index, "alpha", 100)).toHaveLength(41);
  expect(names(index, "alpha007", 100)).toEqual(["alpha007"]);
});

test("binary search reaches a token in the last block", () => {
  const docs = Array.from({ length: 200 }, (_, index) =>
    place(`token${String(index).padStart(3, "0")}`),
  );
  const index = build(docs);
  expect(names(index, "token199", 10)).toEqual(["token199"]);
  expect(names(index, "token000", 10)).toEqual(["token000"]);
});

test("a token on hundreds of documents decodes as one ascending posting list", () => {
  const docs = Array.from({ length: 300 }, (_, index) =>
    place(`common thing${String(index).padStart(3, "0")}`),
  );
  const index = build(docs);
  const found = names(index, "common", 400);
  expect(new Set(found).size).toBe(300);
});

test("two words find a document in either order, and one that matches nothing does not", () => {
  const index = build([
    place("Joes Pizza"),
    place("Pizza Palace"),
    place("Joes Bakery"),
  ]);
  expect(names(index, "joes pizza")[0]).toBe("Joes Pizza");
  expect(names(index, "pizza joes")[0]).toBe("Joes Pizza");
  // Every word has to be matched before a relaxed result is considered, so the full-AND hit leads.
  expect(names(index, "joes pizza broadway")[0]).toBe("Joes Pizza");
});

test("a word the name does not contain still answers, below anything that matched them all", () => {
  const index = build([place("Joes Pizza"), place("Pizza Corner Cafe")]);
  const hits = searchNames(index, {
    text: "pizza corner",
    centre: HERE,
    limit: 20,
  });
  expect(hits[0].name).toBe("Pizza Corner Cafe");
  expect(hits.map((hit) => hit.name)).toContain("Joes Pizza");
  expect(hits[0].score).toBeGreaterThan(hits[1].score);
});

test("two words of a query cannot both be answered by one word of a name", () => {
  // "shake sh" at the real corpus: both words reach the single word of "Shake Top DeLite", which
  // used to count as a name that answered the whole query, while Shake Shack — which answers a word
  // with each of its own — counted the same and lost the tie on distance.
  const index = build([
    place("Shake Top DeLite", { lat: HERE.lat, lng: HERE.lng }),
    place("Shake Shack", { lat: HERE.lat + 0.02, lng: HERE.lng }),
  ]);
  expect(names(index, "shake sh")[0]).toBe("Shake Shack");
  // One of the two is still a match, so the doubled-up name is offered rather than dropped.
  expect(names(index, "shake sh")).toContain("Shake Top DeLite");
  expect(names(index, "shake")[0]).toBe("Shake Top DeLite");
});

test("a word may take a name word from an earlier one that has another", () => {
  // "sh shake": the first word could take "Shake", which would leave the second with nothing. The
  // pairing has to be the best one available, not the first one found.
  const index = build([place("Shake Shack")]);
  const hits = searchNames(index, { text: "sh shake", centre: HERE, limit: 5 });
  const whole = searchNames(index, {
    text: "shake shack",
    centre: HERE,
    limit: 5,
  });
  expect(hits[0].score).toBeGreaterThan(0.5 * whole[0].score);
});

test("the shorter name wins on the same words", () => {
  const index = build([
    place("Joes Pizza and Pasta Palace"),
    place("Joes Pizza"),
  ]);
  expect(names(index, "joes pizza")[0]).toBe("Joes Pizza");
});

test("a prefix scores by how much of the word it is", () => {
  const index = build([place("Pizzeria Uno"), place("Pizza")]);
  expect(names(index, "pizz")).toEqual(["Pizza", "Pizzeria Uno"]);
});

test("distance outranks prominence, and prominence breaks an equal match", () => {
  const far = { lat: HERE.lat + 0.05, lng: HERE.lng };
  const index = build([
    place("Starbucks", { lat: far.lat, lng: far.lng, prominence: 240 }),
    place("Starbucks"),
  ]);
  const hits = searchNames(index, {
    text: "starbucks",
    centre: HERE,
    limit: 5,
  });
  expect(hits[0].lat).toBe(HERE.lat);

  const tie = build([
    place("Chambers Street", { prominence: 240 }),
    place("Chambers Street", { prominence: 80 }),
  ]);
  const ordered = searchNames(tie, {
    text: "chambers street",
    centre: HERE,
    limit: 5,
  });
  expect(ordered[0].score).toBeGreaterThan(ordered[1].score);
});

test("the two ranking factors are monotone over their whole range", () => {
  expect(prominenceFactor(0)).toBeCloseTo(0.3, 6);
  expect(prominenceFactor(255)).toBeCloseTo(1, 6);
  expect(prominenceFactor(240)).toBeGreaterThan(prominenceFactor(120));
  expect(distanceFactor(0)).toBeCloseTo(1, 6);
  expect(distanceFactor(0)).toBeGreaterThan(distanceFactor(500));
  expect(distanceFactor(500)).toBeGreaterThan(distanceFactor(5000));
  // The floor is what keeps a uniquely-named place on the far side of the city reachable.
  expect(distanceFactor(1e6)).toBeCloseTo(0.25, 6);
});

test("a name is found the way it would be typed rather than the way it is spelt", () => {
  const index = build([place("Café Grumpy"), place("Joe's Coffee")]);
  expect(names(index, "cafe")).toContain("Café Grumpy");
  expect(names(index, "joes")).toContain("Joe's Coffee");
  expect(names(index, "grumpy")[0]).toBe("Café Grumpy");
});

test("one character answers nothing", () => {
  const index = build([place("Pizza")]);
  expect(names(index, "p")).toEqual([]);
  expect(names(index, " ")).toEqual([]);
});

test("the address a place sits at survives the round trip", () => {
  const index = build([
    place("Joes Pizza", {
      streetIndex: 4211,
      number: { major: 7, minor: 0, suffix: 0 },
      placeIndex: 0,
    }),
    place("Bridge Cafe", {
      streetIndex: 12,
      number: { major: 126, minor: 10, suffix: 2 },
      placeIndex: 3,
    }),
    place("Prospect Park", { kind: "street", streetIndex: 9 }),
  ]);
  const [pizza] = searchNames(index, {
    text: "joes pizza",
    centre: HERE,
    limit: 1,
  });
  expect(pizza.streetIndex).toBe(4211);
  expect(pizza.number).toEqual({ major: 7, minor: 0, suffix: 0 });
  expect(pizza.placeIndex).toBe(0);

  const [bridge] = searchNames(index, {
    text: "bridge cafe",
    centre: HERE,
    limit: 1,
  });
  expect(bridge.number).toEqual({ major: 126, minor: 10, suffix: 2 });
  expect(bridge.placeIndex).toBe(3);

  const [park] = searchNames(index, {
    text: "prospect",
    centre: HERE,
    limit: 1,
  });
  expect(park.kind).toBe("street");
  expect(park.streetIndex).toBe(9);
  expect(park.number).toBeNull();
  expect(park.placeIndex).toBe(-1);
});

test("a category comes back as the slug it was baked from", () => {
  const index = build([
    place("Joes Pizza", { category: "pizza_restaurant" }),
    place("Washington Square Park", { category: "park" }),
    place("Bow Bridge", { kind: "street" }),
  ]);
  const hits = searchNames(index, {
    text: "bow",
    centre: HERE,
    limit: 5,
  });
  expect(hits[0].category).toBeNull();
  expect(
    searchNames(index, { text: "joes", centre: HERE, limit: 5 })[0].category,
  ).toBe("pizza_restaurant");
});

test("coordinates come back where the documents were, whatever order they were written in", () => {
  const docs = Array.from({ length: 60 }, (_, at) =>
    place(`spot${String(at).padStart(2, "0")}`, {
      lat: 40.5 + at * 0.007,
      lng: -74.2 + ((at * 37) % 60) * 0.008,
    }),
  );
  const index = build(docs);
  for (const doc of docs) {
    const [hit] = searchNames(index, {
      text: doc.name,
      centre: HERE,
      limit: 1,
    });
    expect(hit.lat).toBeCloseTo(doc.lat, 4);
    expect(hit.lng).toBeCloseTo(doc.lng, 4);
  }
});

// A street of the ADDR file as this index holds one: its name, and the ordinal a place on it carries.
function street(name: string, streetIndex: number): SearchDoc {
  return place(name, { kind: "street", streetIndex, prominence: 110 });
}

test("a place is found by its name and the street it is on, which its name never says", () => {
  const index = build([
    place("Katz's Delicatessen", {
      streetIndex: 7,
      number: { major: 205, minor: 0, suffix: 0 },
    }),
    place("Houston Street Cleaners", { streetIndex: 12 }),
    street("E Houston St", 7),
    street("Grand St", 12),
  ]);
  // Three of the five words are the street's rather than the deli's, and before the link this was an
  // empty list — not a wrong answer, no answer.
  expect(names(index, "Katz's Delicatessen E Houston St")).toEqual([
    "Katz's Delicatessen",
  ]);
  // The link is to the street the place actually sits on, so naming another street's does not
  // answer: the deli is not on Grand Street.
  expect(names(index, "Katz's Delicatessen Grand St")).toEqual([]);
});

test("the street link needs the street, not merely the words the street is made of", () => {
  const index = build([
    place("Joes Pizza", { streetIndex: 3 }),
    street("Carmine St", 3),
    street("Bleecker St", 4),
  ]);
  expect(names(index, "joes pizza carmine st")).toEqual(["Joes Pizza"]);
  expect(names(index, "joes pizza bleecker st")).toEqual([]);
});

test("a street that answers the whole query is not buried under the shops on it", () => {
  const index = build([
    place("Bedford Hall", { streetIndex: 3 }),
    place("Bedford Galleries", { streetIndex: 3 }),
    street("Bedford Avenue", 3),
  ]);
  // Every shop on Bedford Avenue can borrow the word "av" from the street it sits on, which is what
  // answers "Katz's Delicatessen E Houston St" — and what would put a dozen shops above the street
  // itself for someone who typed nothing but its name.
  expect(names(index, "bedford av")[0]).toBe("Bedford Avenue");
});

test("a street the query names in full leads the places that only carry its words", () => {
  const index = build([
    place("Court Street Post Office", { prominence: 200 }),
    place("Kings County Court House", { prominence: 200 }),
    street("Court Street", 3),
    street("Stable Court", 4),
  ]);
  // A bare street name is a query about the street. Stable Court is made of the same two words and
  // is not it: what was typed has to start where the name does.
  expect(names(index, "court st")).toEqual([
    "Court Street",
    "Court Street Post Office",
    "Stable Court",
    "Kings County Court House",
  ]);
});

test("the avenue the query spells in full beats the one it only opens", () => {
  const index = build([
    place("5th Avenue", {
      kind: "street",
      streetIndex: 3,
      prominence: 110,
      tokens: streetTokens("5 AVE", "5th Avenue"),
    }),
    place("57th Avenue", {
      kind: "street",
      streetIndex: 4,
      prominence: 110,
      tokens: streetTokens("57 AVE", "57th Avenue"),
    }),
  ]);
  // Both names start with what was typed. Only one of them is spelt by it — "5" is a word of 5 AVE
  // and merely the first character of 57 AVE — and the whole-name lift is for the one that is.
  expect(names(index, "5 av")).toEqual(["5th Avenue", "57th Avenue"]);
});

test("a name spells out the numbers in it, and only a name that has one", () => {
  expect(spelledOrdinals(["5th", "avenue"])).toEqual(["fifth", "avenue"]);
  expect(spelledOrdinals(["5", "ave"])).toEqual(["fifth", "ave"]);
  expect(spelledOrdinals(["west", "21st", "street"])).toEqual([
    "west",
    "twenty",
    "first",
    "street",
  ]);
  expect(spelledOrdinals(["court", "street"])).toBeNull();
  // Past the streets either city numbers there is no word for it, so the name reads as it is.
  expect(spelledOrdinals(["10000", "street"])).toBeNull();
});

test("the place a query ends in is cut at an offset into the query itself", () => {
  expect(splitTrailingPlace(["Brooklyn"], "312 Court St Brooklyn")).toEqual({
    text: "312 Court St",
    placeIndex: 0,
  });
  // Turkish İ lowercases to two code points, so an offset measured in the lowered text would cut the
  // rest of the query a character short — "İstiklal Cadde" rather than "İstiklal Caddesi".
  expect(splitTrailingPlace(["Brooklyn"], "İstiklal Caddesi Brooklyn")).toEqual(
    {
      text: "İstiklal Caddesi",
      placeIndex: 0,
    },
  );
});

test("a door on a street the query only opened is not the top of the scale", () => {
  // The doorway is underfoot and the avenue is three kilometres north, which is the arrangement that
  // used to decide it: a real house number on a street the query merely opened was scored above
  // everything a name can reach, so "5 Av" answered with a door on Avenue A.
  const AVENUE_A = HERE;
  const FIFTH = { lat: HERE.lat + 0.027, lng: HERE.lng };
  const addresses = decodeAddresses(
    encodeAddresses([
      {
        street: "5 AVE",
        place: "",
        number: { major: 5, minor: 0, suffix: 0 },
        ...FIFTH,
      },
      {
        street: "AVENUE A",
        place: "",
        number: { major: 5, minor: 0, suffix: 0 },
        ...AVENUE_A,
      },
    ]).bytes,
  );
  const ordinalOf = (name: string): number =>
    addresses.streetName.findIndex(
      (nameId) => addresses.names[nameId] === name,
    );
  const index = build([
    place("5th Avenue", {
      kind: "street",
      streetIndex: ordinalOf("5th Avenue"),
      prominence: 110,
      tokens: streetTokens("5 AVE", "5th Avenue"),
      ...FIFTH,
    }),
    place("Avenue A", {
      kind: "street",
      streetIndex: ordinalOf("Avenue A"),
      prominence: 110,
      tokens: streetTokens("AVENUE A", "Avenue A"),
      ...AVENUE_A,
    }),
  ]);
  const answers = (text: string): string[] =>
    searchCity(index, addresses, { text, centre: HERE, limit: 5 }).map(
      (hit) => hit.name,
    );
  expect(answers("5 Av")[0]).toBe("5th Avenue");
  // And a reader who names the whole street still gets the door, wherever it is.
  expect(answers("5 Avenue A")[0]).toBe("5 Avenue A");
});

test("a neighbourhood the query names is not the school named after it", () => {
  const away = { lat: HERE.lat + 0.027, lng: HERE.lng };
  const index = build([
    place("Williamsburg Montessori School", { prominence: 150 }),
    place("Williamsburg", { kind: "neighborhood", prominence: 150, ...away }),
  ]);
  // The district is three kilometres off and the school is underfoot, because a district is filed at
  // its middle and half of it is nowhere near that. Naming the whole of it is what says so.
  expect(names(index, "williamsburg")[0]).toBe("Williamsburg");
});

test("a name that answered on its own outranks one that needed its street", () => {
  const index = build([
    place("Carmine Pizza", { streetIndex: 9 }),
    place("Joes Pizza", { streetIndex: 3 }),
    street("Carmine St", 3),
    street("Bleecker St", 9),
  ]);
  expect(names(index, "carmine pizza")[0]).toBe("Carmine Pizza");
});

test("the kinds a caller asks for are the only ones answered, and every kind still matches", () => {
  const index = build([
    place("Joes Pizza", { streetIndex: 3 }),
    street("Carmine St", 3),
  ]);
  expect(names(index, "carmine")).toEqual(["Carmine St"]);
  const places = searchNames(index, {
    text: "carmine",
    centre: HERE,
    limit: 5,
    kinds: ["place"],
  });
  expect(places).toEqual([]);
  // Still matched, though: it is what answers the place on it.
  const linked = searchNames(index, {
    text: "joes pizza carmine",
    centre: HERE,
    limit: 5,
    kinds: ["place"],
  });
  expect(linked.map((hit) => hit.name)).toEqual(["Joes Pizza"]);
});

// New York's boroughs, as the two places a query can name at its end.
const BOROUGHS = decodeAddresses(
  encodeAddresses([
    {
      street: "COURT ST",
      place: "Brooklyn",
      number: { major: 312, minor: 0, suffix: 0 },
      lat: 40.688,
      lng: -73.993,
    },
    {
      street: "5 AVE",
      place: "Manhattan",
      number: { major: 350, minor: 0, suffix: 0 },
      lat: 40.748,
      lng: -73.985,
    },
  ]).bytes,
);

const BROOKLYN = { lat: 40.688, lng: -73.993 };
const MANHATTAN = { lat: 40.748, lng: -73.985 };

test("a borough named at the end of a query is where the answer is measured from", () => {
  const index = build([
    place("Joes Pizza", { ...BROOKLYN, placeIndex: 0 }),
    place("Joes Pizza", { ...MANHATTAN, placeIndex: 1 }),
  ]);
  const named = (text: string): { lat: number; lng: number } => {
    const [hit] = searchCity(index, BOROUGHS, {
      text,
      centre: MANHATTAN,
      limit: 5,
    });
    return { lat: hit.lat, lng: hit.lng };
  };
  // No pizzeria is called "Brooklyn", and the word is what says which of the two was meant.
  expect(named("joes pizza brooklyn").lat).toBeCloseTo(BROOKLYN.lat, 3);
  expect(named("joes pizza").lat).toBeCloseTo(MANHATTAN.lat, 3);
});

test("a query that only names a borough keeps its words", () => {
  const index = build([
    place("Brooklyn Bagel", { ...MANHATTAN, placeIndex: 1 }),
    place("Bagel Shop", { ...BROOKLYN, placeIndex: 0 }),
  ]);
  // Stripping "Brooklyn" here would answer with every bagel in Brooklyn instead of the shop named
  // after it, so the whole text is searched as well and the name that carries the word wins.
  const [hit] = searchCity(index, BOROUGHS, {
    text: "brooklyn bagel",
    centre: MANHATTAN,
    limit: 5,
  });
  expect(hit.name).toBe("Brooklyn Bagel");
});

test("a station is answered with the routes it serves, out of the category slot", () => {
  const index = build([
    place("14 St-Union Sq", {
      kind: "station",
      category: "4/5/6/L/N/Q/R/W",
      prominence: 240,
    }),
  ]);
  const [hit] = searchCity(index, BOROUGHS, {
    text: "union sq",
    centre: HERE,
    limit: 5,
  });
  expect(hit.kind).toBe("station");
  expect(hit.category).toBe("4/5/6/L/N/Q/R/W");
  expect(hit.exact).toBeNull();
});
