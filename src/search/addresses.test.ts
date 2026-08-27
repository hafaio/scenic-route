import { expect, test } from "bun:test";
import { buildDocs, encodeSearch } from "../../scripts/search-index";
import {
  ADDRESS_FORMAT,
  ADDRESS_MAGIC,
  COORD_SCALE,
  type HouseNumber,
  packExtra,
  parseHouseNumber,
} from "./address-format";
import { type AddressIndex, decodeAddresses } from "./addresses";
import { type CityHit, decodeSearchIndex, searchCity } from "./search-query";

// The decoder against raw ADDR bytes, written here rather than by the builder so these hold whatever
// the pipeline does. What they pin is the half of the format a reader sees: which number comes back
// for what was typed, that it is always a number the file actually has, and that a name several
// streets share answers with all of them rather than with a silent pick.
//
// Which street a query names is the search index's answer now, so these run the whole house-number
// path — a street is a document there, matched by name, and its run decoded for the number.

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

// Everything an address query needs: the file, and an index over its streets.
function cityOf(addresses: AddressIndex): {
  addresses: AddressIndex;
  index: ReturnType<typeof decodeSearchIndex>;
} {
  return {
    addresses,
    index: decodeSearchIndex(encodeSearch(buildDocs([], addresses).docs).bytes),
  };
}

const NYC_CITY = cityOf(NYC);
const SF_CITY = cityOf(SF);

// Lower Manhattan, which is where the map is pointing unless a test says otherwise.
const DOWNTOWN = { lat: 40.71, lng: -74.01 };

// The row as the box shows it: the name and the line under it.
function line(hit: CityHit): string {
  return [hit.name, hit.label].filter(Boolean).join(", ");
}

function answers(
  city: {
    addresses: AddressIndex;
    index: ReturnType<typeof decodeSearchIndex>;
  },
  text: string,
  centre = DOWNTOWN,
): CityHit[] {
  return searchCity(city.index, city.addresses, { text, centre, limit: 5 });
}

// A house number and nothing else: the street rows the same query matches are not addresses.
function doors(
  city: {
    addresses: AddressIndex;
    index: ReturnType<typeof decodeSearchIndex>;
  },
  text: string,
  centre = DOWNTOWN,
): CityHit[] {
  return answers(city, text, centre).filter((hit) => hit.exact !== null);
}

test("a house number the file has is the answer, at its own coordinates", () => {
  const [hit] = doors(NYC_CITY, "123 Broadway");
  expect(line(hit)).toBe("123 Broadway, Manhattan");
  expect(hit.exact).toBe(true);
  expect(hit.lat).toBeCloseTo(40.7102, 5);
  expect(hit.lng).toBeCloseTo(-74.0102, 5);
});

// The pin must never claim to be an address the file does not have.
test("a number the street lacks comes back as the nearest one, under its real number", () => {
  const [hit] = doors(NYC_CITY, "121 Broadway");
  expect(line(hit)).toBe("119 Broadway, Manhattan");
  expect(hit.exact).toBe(false);
  expect(hit.lat).toBeCloseTo(40.7101, 5);
});

test("a number past the end of the street is not answered at all", () => {
  expect(doors(NYC_CITY, "9999 Broadway")).toEqual([]);
});

// The whole reason a street is a name and a place: one of these is in Brooklyn and one is not, and
// picking either on the reader's behalf would be picking wrong half the time with no sign of it.
test("a name several streets share answers with every one of them, each labelled", () => {
  const hits = doors(NYC_CITY, "312 Court St");
  expect(hits.map(line).sort()).toEqual([
    "312 Court Street, Brooklyn",
    "312 Court Street, Staten Island",
  ]);
  expect(hits.every((hit) => hit.exact)).toBe(true);
});

test("naming the borough picks that one street and drops the others", () => {
  expect(doors(NYC_CITY, "312 Court St Brooklyn").map(line)).toEqual([
    "312 Court Street, Brooklyn",
  ]);
  // The way the list itself writes it, which is the form a reader is most likely to type back.
  expect(doors(NYC_CITY, "312 Court Street, Staten Island").map(line)).toEqual([
    "312 Court Street, Staten Island",
  ]);
});

// Stripping it would leave nothing to search for, so it is not a place here — it is the street text.
test("a place name on its own is not stripped", () => {
  expect(doors(NYC_CITY, "312 Brooklyn")).toEqual([]);
});

test("the map centre decides which of them comes first", () => {
  expect(
    doors(NYC_CITY, "312 Court St", { lat: 40.64, lng: -74.08 })[0].label,
  ).toBe("Staten Island");
  expect(
    doors(NYC_CITY, "312 Court St", { lat: 40.69, lng: -73.99 })[0].label,
  ).toBe("Brooklyn");
});

test("a city that is one place says nothing about which place it is", () => {
  const [hit] = doors(SF_CITY, "269 Avila St", { lat: 37.8, lng: -122.44 });
  expect(line(hit)).toBe("269 Avila Street");
});

// The list prints "5th Avenue" and the sign says "5 AV"; a search that only knew the first found no
// numbered street in New York at all.
test("a numbered street answers to the sign as well as to what we print", () => {
  for (const query of [
    "350 5 Av",
    "350 5 AVE",
    "350 5th Ave",
    "350 fifth ave",
  ]) {
    const [hit] = doors(NYC_CITY, query);
    expect(line(hit)).toBe("350 5th Avenue, Manhattan");
    expect(hit.exact).toBe(true);
  }
});

test("a run of whitespace in the source name is one space to a search", () => {
  const [hit] = doors(NYC_CITY, "200 W 239 St");
  expect(line(hit)).toBe("200 West 239th Street, Bronx");
  expect(hit.exact).toBe(true);
});

test("a Queens hyphenated number is one number, not two", () => {
  const [hit] = doors(NYC_CITY, "12-34 31st Av");
  expect(line(hit)).toBe("12-34 31st Avenue, Queens");
  expect(hit.exact).toBe(true);
  expect(hit.lng).toBeCloseTo(-73.9101, 5);
});

test("the block number decides which neighbour is nearest, not the digits after it", () => {
  const [hit] = doors(NYC_CITY, "12-38 31st Av");
  expect(line(hit)).toBe("12-40 31st Avenue, Queens");
  expect(hit.exact).toBe(false);
});

test("a letter suffix is part of the number", () => {
  const [hit] = doors(SF_CITY, "269B Avila St", { lat: 37.8, lng: -122.44 });
  expect(line(hit)).toBe("269B Avila Street");
  expect(hit.exact).toBe(true);
  expect(hit.lat).toBeCloseTo(37.8002, 5);
});

test("a street with one address answers for it and for nothing else", () => {
  const [hit] = doors(NYC_CITY, "7 Lone Pl");
  expect(line(hit)).toBe("7 Lone Place, Manhattan");
  expect(hit.exact).toBe(true);
  expect(doors(NYC_CITY, "9 Lone Pl")).toEqual([]);
});

test("a street the file has never heard of has no addresses on it", () => {
  expect(doors(NYC_CITY, "123 Nowhere Ave")).toEqual([]);
});

// A door leads a list, because it is the most precise answer anything here can give and the street
// it is on is the coarsest.
test("the door outranks the street it is on", () => {
  const hits = answers(NYC_CITY, "123 Broadway");
  expect(line(hits[0])).toBe("123 Broadway, Manhattan");
  expect(
    hits.some((hit) => hit.exact === null && hit.name === "Broadway"),
  ).toBe(true);
});

// The street search answers a bare name, and better: this one would have to guess a number.
test("a query with no house number is not an address query", () => {
  const hits = answers(NYC_CITY, "Broadway");
  expect(hits.map((hit) => hit.name)).toEqual(["Broadway"]);
  expect(hits.every((hit) => hit.exact === null)).toBe(true);
});
