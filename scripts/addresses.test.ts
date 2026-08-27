import { expect, test } from "bun:test";

// The client reads ADDR with a decoder of its own, written from the doc comment in
// src/search/address-format. This is a second one, written here rather than imported from the
// encoder's own module, so a mistake mirrored into an encoder/decoder pair cannot pass by
// round-tripping (DESIGN.md, "Repository traps").
import {
  ADDRESS_FORMAT,
  ADDRESS_MAGIC,
  COORD_SCALE,
  formatHouseNumber,
  type HouseNumber,
  parseHouseNumber,
  unpackExtra,
} from "../src/search/address-format";
import { type AddressRow, encodeAddresses } from "./addresses";

interface DecodedAddress {
  number: string; // as written, e.g. "25-7" or "269B"
  lat: number;
  lng: number;
}

interface DecodedStreet {
  name: string;
  place: string;
  nameIndex: number;
  placeIndex: number;
  addresses: DecodedAddress[];
}

interface Decoded {
  placeBytes: number;
  streets: DecodedStreet[];
}

function unzigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

function decode(bytes: Uint8Array): Decoded {
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
    }
  };
  const blob = (): { text: string; length: number } => {
    const length = varint();
    const text = new TextDecoder().decode(
      bytes.subarray(offset, offset + length),
    );
    offset += length;
    return { text, length };
  };

  for (const character of ADDRESS_MAGIC) {
    expect(bytes[offset]).toBe(character.charCodeAt(0));
    offset += 1;
  }
  expect(bytes[offset]).toBe(ADDRESS_FORMAT);
  offset += 1;

  const names = blob().text.split("\n");
  const { text: placeText, length: placeBytes } = blob();
  const places = placeText.split("\n");

  const streets: DecodedStreet[] = [];
  const streetCount = varint();
  for (let street = 0; street < streetCount; street++) {
    const nameIndex = varint();
    const placeIndex = varint();
    const count = varint();
    const addresses: DecodedAddress[] = [];
    let major = 0;
    let latUnits = 0;
    let lngUnits = 0;
    for (let index = 0; index < count; index++) {
      const packed = varint();
      major += unzigzag((packed - (packed % 2)) / 2);
      const { minor, suffix } =
        packed % 2 === 0 ? { minor: 0, suffix: 0 } : unpackExtra(varint());
      latUnits += unzigzag(varint());
      lngUnits += unzigzag(varint());
      addresses.push({
        number: formatHouseNumber({ major, minor, suffix }),
        lat: latUnits / COORD_SCALE,
        lng: lngUnits / COORD_SCALE,
      });
    }
    streets.push({
      name: names[nameIndex],
      place: places[placeIndex],
      nameIndex,
      placeIndex,
      addresses,
    });
  }
  expect(offset).toBe(bytes.length);
  return { placeBytes, streets };
}

function houseNumber(text: string): HouseNumber {
  const parsed = parseHouseNumber(text);
  if (parsed === null) {
    throw new Error(`${text} is not a house number`);
  }
  return parsed;
}

function row(
  street: string,
  place: string,
  number: string,
  lat: number,
  lng: number,
): AddressRow {
  return { street, place, number: houseNumber(number), lat, lng };
}

function streetOf({ streets }: Decoded, name: string, place: string) {
  return streets.find(
    (street) => street.name === name && street.place === place,
  );
}

// Two Queens addresses on one block, a Brooklyn number and a Staten Island one on streets that share
// a name — New York has five Court Streets — with the streets and the numbers both out of order on
// the way in.
const NYC: readonly AddressRow[] = [
  row("COURT ST", "Brooklyn", "312", 40.68562, -73.99444),
  row("93 ST", "Queens", "25-11", 40.76415, -73.87622),
  row("COURT ST", "Staten Island", "3", 40.62637, -74.08046),
  row("93 ST", "Queens", "25-07", 40.76383, -73.87631),
  row("COURT ST", "Brooklyn", "8", 40.69236, -73.99184),
];

// San Francisco is one place, and a number there may carry a letter.
const SF: readonly AddressRow[] = [
  row("IRVING ST", "", "269B", 37.7634, -122.4712),
  row("IRVING ST", "", "269", 37.7634, -122.4712),
];

test("a street's addresses come back in house-number order, whatever order they went in", () => {
  const decoded = decode(encodeAddresses(NYC).bytes);
  expect(decoded.streets.map(({ name, place }) => `${name}, ${place}`)).toEqual(
    ["93 ST, Queens", "COURT ST, Brooklyn", "COURT ST, Staten Island"],
  );
  expect(
    streetOf(decoded, "COURT ST", "Brooklyn")?.addresses.map(
      ({ number }) => number,
    ),
  ).toEqual(["8", "312"]);
});

test("one name in two boroughs is two streets sharing a name and nothing else", () => {
  const encoded = encodeAddresses(NYC);
  expect(encoded.names).toBe(2);
  expect(encoded.streets).toBe(3);
  const decoded = decode(encoded.bytes);
  const brooklyn = streetOf(decoded, "COURT ST", "Brooklyn");
  const statenIsland = streetOf(decoded, "COURT ST", "Staten Island");
  expect(brooklyn?.nameIndex).toBe(statenIsland?.nameIndex ?? -1);
  expect(brooklyn?.placeIndex).not.toBe(statenIsland?.placeIndex ?? -1);
  // Each run is its own: the deltas reset, so Staten Island's 3 is not read as Brooklyn's 8 minus 5.
  expect(statenIsland?.addresses).toEqual([
    { number: "3", lat: 40.62637, lng: -74.08046 },
  ]);
});

test("a hyphenated Queens number survives the round trip", () => {
  // "25-07" comes back as "25-7": the format stores the minor part as a number, so the source's
  // padding is not kept.
  expect(
    streetOf(decode(encodeAddresses(NYC).bytes), "93 ST", "Queens"),
  ).toEqual({
    name: "93 ST",
    place: "Queens",
    nameIndex: 0,
    placeIndex: 1,
    addresses: [
      { number: "25-7", lat: 40.76383, lng: -73.87631 },
      { number: "25-11", lat: 40.76415, lng: -73.87622 },
    ],
  });
});

test("a city that is one place writes no place blob", () => {
  const decoded = decode(encodeAddresses(SF).bytes);
  expect(decoded.placeBytes).toBe(0);
  expect(decoded.streets).toEqual([
    {
      name: "IRVING ST",
      place: "",
      nameIndex: 0,
      placeIndex: 0,
      // A letter suffix sorts after the bare number and keeps its letter.
      addresses: [
        { number: "269", lat: 37.7634, lng: -122.4712 },
        { number: "269B", lat: 37.7634, lng: -122.4712 },
      ],
    },
  ]);
});

test("a row repeated at the same doorway is written once", () => {
  const twice = [
    ...NYC,
    row("COURT ST", "Brooklyn", "312", 40.68562, -73.99444),
  ];
  const encoded = encodeAddresses(twice);
  expect(encoded.addresses).toBe(NYC.length);
  expect(decode(encoded.bytes)).toEqual(decode(encodeAddresses(NYC).bytes));
});

test("the same number at another doorway is kept", () => {
  // A metre apart is a metre apart: two entrances of one building, not one address listed twice.
  const both = [
    ...NYC,
    row("COURT ST", "Brooklyn", "312", 40.68566, -73.99444),
  ];
  const encoded = encodeAddresses(both);
  expect(encoded.addresses).toBe(NYC.length + 1);
  expect(
    streetOf(decode(encoded.bytes), "COURT ST", "Brooklyn")?.addresses.map(
      ({ number }) => number,
    ),
  ).toEqual(["8", "312", "312"]);
});

test("the same number on the same street in another borough is its own address", () => {
  const both = [
    ...NYC,
    row("COURT ST", "Staten Island", "312", 40.62701, -74.08),
  ];
  const decoded = decode(encodeAddresses(both).bytes);
  expect(
    streetOf(decoded, "COURT ST", "Staten Island")?.addresses.map(
      ({ number }) => number,
    ),
  ).toEqual(["3", "312"]);
});

test("coordinates are rounded onto the 1e-5 grid, not truncated onto it", () => {
  const decoded = decode(
    encodeAddresses([row("MAIN ST", "Bronx", "1", 40.123456, -73.987654)])
      .bytes,
  );
  expect(streetOf(decoded, "MAIN ST", "Bronx")?.addresses).toEqual([
    { number: "1", lat: 40.12346, lng: -73.98765 },
  ]);
});
