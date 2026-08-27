import { expect, test } from "bun:test";
import {
  ADDRESS_FORMAT,
  ADDRESS_MAGIC,
  COORD_SCALE,
  type HouseNumber,
  packExtra,
  parseHouseNumber,
} from "./address-format";
import {
  decodeAddresses,
  matchAddresses,
  searchAddresses,
  setSearchCentre,
} from "./addresses";

// The decoder against raw ADDR bytes, written here rather than by the builder so these hold whatever
// the pipeline does. What they pin is the half of the format a reader sees: which number comes back
// for what was typed, that it is always a number the file actually has, and that a name several
// streets share answers with all of them rather than with a silent pick.

function varint(value: number, into: number[]): void {
  let rest = value;
  while (rest >= 0x80) {
    into.push((rest % 128) + 0x80);
    rest = Math.floor(rest / 128);
  }
  into.push(rest);
}

function zigzag(value: number): number {
  return value < 0 ? -2 * value - 1 : 2 * value;
}

function numberOf(written: string): HouseNumber {
  const parsed = parseHouseNumber(written);
  if (parsed === null) {
    throw new Error(`${written} is not a house number`);
  }
  return parsed;
}

interface Street {
  name: string; // as the source publishes it, which is upper case
  place: string; // "" for a city that is one place
  addresses: [written: string, lat: number, lng: number][];
}

// The streets in the order the format asks for, by (name, place).
function fileOf(streets: Street[]): Uint8Array {
  const names = [...new Set(streets.map((street) => street.name))];
  const places = [
    ...new Set(streets.map((street) => street.place).filter(Boolean)),
  ];
  const bytes: number[] = [];
  for (const character of ADDRESS_MAGIC) {
    bytes.push(character.charCodeAt(0));
  }
  bytes.push(ADDRESS_FORMAT);
  for (const blob of [names, places]) {
    const encoded = new TextEncoder().encode(blob.join("\n"));
    varint(encoded.length, bytes);
    bytes.push(...encoded);
  }
  varint(streets.length, bytes);
  for (const street of streets) {
    varint(names.indexOf(street.name), bytes);
    varint(Math.max(places.indexOf(street.place), 0), bytes);
    varint(street.addresses.length, bytes);
    let major = 0;
    let latUnits = 0;
    let lngUnits = 0;
    for (const [written, lat, lng] of street.addresses) {
      const number = numberOf(written);
      const extra = packExtra(number);
      varint(zigzag(number.major - major) * 2 + (extra === 0 ? 0 : 1), bytes);
      if (extra !== 0) {
        varint(extra, bytes);
      }
      const nextLat = Math.round(lat * COORD_SCALE);
      const nextLng = Math.round(lng * COORD_SCALE);
      varint(zigzag(nextLat - latUnits), bytes);
      varint(zigzag(nextLng - lngUnits), bytes);
      major = number.major;
      latUnits = nextLat;
      lngUnits = nextLng;
    }
  }
  return Uint8Array.from(bytes);
}

// New York, where a street name is not a street: two of these Court Streets are two boroughs apart.
const NYC_FILE = fileOf([
  {
    name: "31 AVE",
    place: "Queens",
    addresses: [
      ["12-34", 40.7601, -73.9101],
      ["12-40", 40.7602, -73.9102],
    ],
  },
  {
    name: "5 AVE",
    place: "Manhattan",
    addresses: [
      ["350", 40.7484, -73.9857],
      ["360", 40.7488, -73.9855],
    ],
  },
  {
    name: "BROADWAY",
    place: "Manhattan",
    addresses: [
      ["119", 40.7101, -74.0101],
      ["123", 40.7102, -74.0102],
      ["131", 40.7103, -74.0103],
    ],
  },
  {
    name: "COURT ST",
    place: "Brooklyn",
    addresses: [
      ["300", 40.6881, -73.9931],
      ["312", 40.6882, -73.9932],
    ],
  },
  {
    name: "COURT ST",
    place: "Staten Island",
    addresses: [
      ["308", 40.6401, -74.0761],
      ["312", 40.6402, -74.0762],
    ],
  },
  { name: "LONE PL", place: "Manhattan", addresses: [["7", 40.72, -74.02]] },
  {
    name: "W  239 ST", // two internal spaces, as the source writes it
    place: "Bronx",
    addresses: [["200", 40.8891, -73.9051]],
  },
]);

const NYC = decodeAddresses(NYC_FILE);

// San Francisco is one place and ships an empty place blob.
const SF = decodeAddresses(
  fileOf([
    {
      name: "AVILA ST",
      place: "",
      addresses: [
        ["269", 37.8001, -122.4401],
        ["269B", 37.8002, -122.4402],
      ],
    },
  ]),
);

test("a house number the file has is the answer, at its own coordinates", () => {
  const [hit] = matchAddresses(NYC, "123 Broadway", 5);
  expect(hit.place.name).toBe("123 Broadway, Manhattan");
  expect(hit.exact).toBe(true);
  expect(hit.rank).toBe(2);
  expect(hit.place.lat).toBeCloseTo(40.7102, 5);
  expect(hit.place.lng).toBeCloseTo(-74.0102, 5);
});

// The pin must never claim to be an address the file does not have.
test("a number the street lacks comes back as the nearest one, under its real number", () => {
  const [hit] = matchAddresses(NYC, "121 Broadway", 5);
  expect(hit.place.name).toBe("119 Broadway, Manhattan");
  expect(hit.exact).toBe(false);
  expect(hit.place.lat).toBeCloseTo(40.7101, 5);
});

test("a number past the end of the street is not answered at all", () => {
  expect(matchAddresses(NYC, "9999 Broadway", 5)).toEqual([]);
});

// The whole reason a street is a name and a place: one of these is in Brooklyn and one is not, and
// picking either on the reader's behalf would be picking wrong half the time with no sign of it.
test("a name several streets share answers with every one of them, each labelled", () => {
  const hits = matchAddresses(NYC, "312 Court St", 5);
  expect(hits.map((hit) => hit.place.name)).toEqual([
    "312 Court Street, Brooklyn",
    "312 Court Street, Staten Island",
  ]);
  expect(hits.every((hit) => hit.exact)).toBe(true);
});

test("naming the borough picks that one street and drops the others", () => {
  const hits = matchAddresses(NYC, "312 Court St Brooklyn", 5);
  expect(hits.map((hit) => hit.place.name)).toEqual([
    "312 Court Street, Brooklyn",
  ]);
  // The way the list itself writes it, which is the form a reader is most likely to type back.
  expect(
    matchAddresses(NYC, "312 Court Street, Staten Island", 5).map(
      (hit) => hit.place.name,
    ),
  ).toEqual(["312 Court Street, Staten Island"]);
});

// Stripping it would leave nothing to search for, so it is not a place here — it is the street text.
test("a place name on its own is not stripped", () => {
  expect(matchAddresses(NYC, "312 Brooklyn", 5)).toEqual([]);
});

test("a shared location decides which of them comes first", () => {
  const hits = matchAddresses(NYC, "312 Court St", 5, {
    lat: 40.64,
    lng: -74.08,
  });
  expect(hits.map((hit) => hit.place.name)).toEqual([
    "312 Court Street, Staten Island",
    "312 Court Street, Brooklyn",
  ]);
});

test("a city that is one place says nothing about which place it is", () => {
  const [hit] = matchAddresses(SF, "269 Avila St", 5);
  expect(hit.place.name).toBe("269 Avila Street");
});

// The list prints "5th Avenue" and the sign says "5 AV"; a search that only knew the first found no
// numbered street in New York at all.
test("a numbered street answers to the sign as well as to what we print", () => {
  for (const query of ["350 5 Av", "350 5 AVE", "350 5th Ave"]) {
    const [hit] = matchAddresses(NYC, query, 5);
    expect(hit.place.name).toBe("350 5th Avenue, Manhattan");
    expect(hit.exact).toBe(true);
  }
});

test("a run of whitespace in the source name is one space to a search", () => {
  const [hit] = matchAddresses(NYC, "200 W 239 St", 5);
  expect(hit.place.name).toBe("200 West 239th Street, Bronx");
  expect(hit.exact).toBe(true);
});

test("a Queens hyphenated number is one number, not two", () => {
  const [hit] = matchAddresses(NYC, "12-34 31st Av", 5);
  expect(hit.place.name).toBe("12-34 31st Avenue, Queens");
  expect(hit.exact).toBe(true);
  expect(hit.place.lng).toBeCloseTo(-73.9101, 5);
});

test("the block number decides which neighbour is nearest, not the digits after it", () => {
  const [hit] = matchAddresses(NYC, "12-38 31st Av", 5);
  expect(hit.place.name).toBe("12-40 31st Avenue, Queens");
  expect(hit.exact).toBe(false);
});

test("a letter suffix is part of the number", () => {
  const [hit] = matchAddresses(SF, "269B Avila St", 5);
  expect(hit.place.name).toBe("269B Avila Street");
  expect(hit.exact).toBe(true);
  expect(hit.place.lat).toBeCloseTo(37.8002, 5);
});

test("a street with one address answers for it and for nothing else", () => {
  const [hit] = matchAddresses(NYC, "7 Lone Pl", 5);
  expect(hit.place.name).toBe("7 Lone Place, Manhattan");
  expect(hit.exact).toBe(true);
  expect(matchAddresses(NYC, "9 Lone Pl", 5)).toEqual([]);
});

test("a street the file has never heard of has no addresses on it", () => {
  expect(matchAddresses(NYC, "123 Nowhere Ave", 5)).toEqual([]);
});

// The map is the only thing that knows which borough the reader is looking at when they have shared
// no location of their own, and it must not answer for a city they have left. Driven through the
// fetch, since that is the only path the centre is read on — and it takes the gzip with it.
test("the map centre orders plural hits, and only for the city it is in", async () => {
  const packed = await new Response(
    new Blob([NYC_FILE as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  const served = globalThis.fetch;
  globalThis.fetch = (async () => new Response(packed)) as typeof fetch;
  const near = async (): Promise<string[]> => {
    const hits = await searchAddresses("nyc", "312 Court St", 5);
    return (hits ?? []).map((hit) => hit.place.name);
  };
  setSearchCentre("nyc", { lat: 40.64, lng: -74.08 });
  expect(await near()).toEqual([
    "312 Court Street, Staten Island",
    "312 Court Street, Brooklyn",
  ]);
  // A centre left over from the other city says nothing about this one, so the file's order stands.
  setSearchCentre("sf", { lat: 37.77, lng: -122.42 });
  expect(await near()).toEqual([
    "312 Court Street, Brooklyn",
    "312 Court Street, Staten Island",
  ]);
  globalThis.fetch = served;
});

// The street search already answers a bare name, and better: this one would have to guess a number.
test("a query with no house number is not an address query", () => {
  expect(matchAddresses(NYC, "Broadway", 5)).toEqual([]);
});
