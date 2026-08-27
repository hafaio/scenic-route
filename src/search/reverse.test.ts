// What a point picked off the map is called, asked of the artifacts the app actually ships.
//
// The same standard as ./golden.test.ts and for the same reason: the rules are stated against a
// handful of documents elsewhere, and only the real files can say whether a tap on the Empire State
// Building names the tower or the valuation firm on its fourth floor. Every case here is a point
// with a known truth — a building, the middle of a park, open water — and the last two tests are the
// two promises the module makes: that an address it gives is one the city published, and that
// answering costs a few milliseconds rather than a network round trip.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { formatHouseNumber } from "./address-format";
import {
  type AddressIndex,
  decodeAddresses,
  streetAddresses,
} from "./addresses";
import { type ReverseHit, reverseCity } from "./reverse";
import {
  decodeSearchIndex,
  type SearchIndex,
  searchCity,
} from "./search-query";

interface Point {
  lat: number;
  lng: number;
}

interface City {
  index: SearchIndex;
  addresses: AddressIndex;
}

function artifact(name: string): Uint8Array {
  return new Uint8Array(
    gunzipSync(readFileSync(new URL(`../../public/${name}`, import.meta.url))),
  );
}

function load(cityId: string): City {
  return {
    index: decodeSearchIndex(artifact(`search/${cityId}.bin.gz`)),
    addresses: decodeAddresses(artifact(`addresses/${cityId}.bin.gz`)),
  };
}

const nyc = load("nyc");
const sf = load("sf");

function metersApart(left: Point, right: Point): number {
  const north = (left.lat - right.lat) * 111_320;
  const east =
    (left.lng - right.lng) * 111_320 * Math.cos((left.lat * Math.PI) / 180);
  return Math.hypot(north, east);
}

interface Named {
  // Where the reader tapped, and what is there.
  at: Point;
  what: string;
  // The name the answer must carry, spelt as the artifact spells it. Null with no `kind` beside it is
  // the case where the honest answer is nothing at all; null WITH one asks only that something real
  // was found, for a spot where which of several tenants Overture filed is not a promise worth
  // freezing into a test.
  name: string | null;
  kind?: ReverseHit["kind"];
  // Whether the point is AT what it was named after, rather than merely beside it.
  standing?: boolean;
  why: string;
}

const NYC_NAMED: readonly Named[] = [
  {
    at: { lat: 40.72226, lng: -73.98741 },
    what: "the door of Katz's Delicatessen",
    name: "Katz's Delicatessen",
    kind: "place",
    why: "a tap on a shop is the shop, not the number over the door",
  },
  {
    at: { lat: 40.74844, lng: -73.98566 },
    what: "the Empire State Building",
    name: "Empire State Building",
    kind: "landmark",
    why: "the tower, not the valuation firm filed at the same point",
  },
  {
    at: { lat: 40.7812, lng: -73.9665 },
    what: "the Great Lawn, in the middle of Central Park",
    name: "Great Lawn",
    kind: "place",
    why: "the lawn you are standing on, not a house number on Fifth Avenue",
  },
  {
    at: { lat: 40.6602, lng: -73.969 },
    what: "the middle of Prospect Park",
    name: "Prospect Park",
    kind: "place",
    why: "and the park itself where nothing smaller is nearer",
  },
  {
    at: { lat: 40.742, lng: -73.9585 },
    what: "a building on the Long Island City waterfront",
    name: "2-16 Borden Avenue",
    kind: "address",
    why: "Queens' hyphenated numbers come back written the way they are written",
  },
  {
    at: { lat: 40.615, lng: -73.825 },
    what: "the marsh in Jamaica Bay",
    name: "Jamaica Bay Wildlife Refuge",
    standing: false,
    why: "nothing owns a marsh, so the refuge is offered as somewhere NEAR",
  },
  {
    at: { lat: 40.66, lng: -74.05 },
    what: "open water in the Upper Bay",
    name: null,
    why: "the honest answer in the middle of the harbour is nothing at all",
  },
  {
    at: { lat: 40.4, lng: -73.8 },
    what: "the Atlantic, twenty kilometres out",
    name: null,
    why: "and off the map entirely it is still nothing, never a distant door",
  },
];

const SF_NAMED: readonly Named[] = [
  {
    at: { lat: 37.7594, lng: -122.5107 },
    what: "the sand at Ocean Beach",
    name: "Ocean Beach",
    kind: "place",
    why: "the beach covers the ground it is filed at the middle of",
  },
  {
    at: { lat: 37.7544, lng: -122.4477 },
    what: "the slope of Twin Peaks",
    name: "Marview Way",
    kind: "street",
    standing: false,
    why: "no number is close enough on a hillside, so the street is what is left",
  },
  {
    at: { lat: 37.7955, lng: -122.3937 },
    what: "the Ferry Building",
    name: null,
    kind: "place",
    standing: true,
    why: "something real is there; which tenant Overture filed is not a promise",
  },
  {
    at: { lat: 37.76, lng: -122.53 },
    what: "the Pacific, off Ocean Beach",
    name: null,
    why: "water is nothing in either city",
  },
];

function check(city: City, named: Named): void {
  const { at, name, kind, standing, why } = named;
  const hit = reverseCity(city.index, city.addresses, at);
  if (name === null && kind === undefined) {
    expect(hit, `named ${hit?.name} — ${why}`).toBeNull();
    return;
  }
  expect(hit, `answered nothing — ${why}`).not.toBeNull();
  if (hit === null) {
    return;
  }
  const said = `named "${hit.name}" (${hit.kind}, ${hit.meters.toFixed(0)} m${hit.at ? "" : ", near"}) — ${why}`;
  if (name !== null) {
    expect(hit.name, said).toBe(name);
  }
  if (kind !== undefined) {
    expect(hit.kind, said).toBe(kind);
  }
  expect(hit.at, said).toBe(standing ?? true);
}

for (const named of NYC_NAMED) {
  test(`nyc: ${named.what} — ${named.why}`, () => {
    check(nyc, named);
  });
}

for (const named of SF_NAMED) {
  test(`sf: ${named.what} — ${named.why}`, () => {
    check(sf, named);
  });
}

// Every address in the file, asked what it is called from its own doorstep. It has to come back with
// that address or with something real at the same spot — the shop in it, the park it stands in —
// never with a number from another building and never with nothing.
function ownDoorstep(city: City, cityId: string): void {
  const streetCount = city.addresses.streetName.length;
  let named = 0;
  let numbered = 0;
  for (let step = 0; step < 200; step += 1) {
    const street = Math.floor((step * 7919) % streetCount);
    const run = streetAddresses(city.addresses, street);
    const address = run[Math.floor(run.length / 2)];
    const hit = reverseCity(city.index, city.addresses, address);
    expect(
      hit,
      `${cityId}: nothing at ${address.lat},${address.lng}`,
    ).not.toBeNull();
    if (hit === null) {
      continue;
    }
    named += 1;
    expect(
      metersApart(hit, address),
      `${cityId}: "${hit.name}" is ${metersApart(hit, address).toFixed(0)} m from the door it was asked about`,
    ).toBeLessThan(60);
    if (hit.kind === "address") {
      numbered += 1;
      // The street has to be the one stood on, unless the answer is standing on the very same point:
      // both cities file whole blocks of numbers at one coordinate — every address on San
      // Francisco's Bertha Lane shares one — and a corner is filed twice, once per street, so 299
      // Nevada Street and 801 Jarboe Avenue are one doorway written two ways.
      const onStreet = city.addresses.names[city.addresses.streetName[street]];
      const wanted = `${formatHouseNumber(address.number)} ${onStreet}`;
      expect(
        hit.name.endsWith(onStreet) || hit.meters < 5,
        `${cityId}: stood at ${wanted} and was told "${hit.name}", ${hit.meters.toFixed(0)} m off`,
      ).toBe(true);
    }
  }
  expect(named).toBe(200);
  // Most doorsteps have no name of their own, so most of them answer with their own number.
  expect(numbered).toBeGreaterThan(100);
}

test("nyc: a point on a building is that building", () => {
  ownDoorstep(nyc, "nyc");
});

test("sf: a point on a building is that building", () => {
  ownDoorstep(sf, "sf");
});

// The promise the search box already keeps, kept in the other direction: a number that comes back is
// a number the city published, at the coordinates it published for it.
test("no house number is ever invented", () => {
  const checked: string[] = [];
  for (let step = 0; step < 120; step += 1) {
    const lat = 40.62 + ((step * 37) % 200) / 1000;
    const lng = -74.03 + ((step * 53) % 260) / 1000;
    const hit = reverseCity(nyc.index, nyc.addresses, { lat, lng });
    if (hit === null || hit.kind !== "address") {
      continue;
    }
    checked.push(hit.name);
    const [found] = searchCity(nyc.index, nyc.addresses, {
      text: hit.name,
      centre: hit,
      limit: 1,
    });
    expect(found?.exact, `${hit.name} is not a number the file has`).toBe(true);
    expect(metersApart(found, hit), `${hit.name} moved`).toBeLessThan(30);
  }
  expect(checked.length).toBeGreaterThan(20);
});

// Fast enough to relabel a dragged endpoint. The bound is loose because it is a floor under "this is
// not a network round trip", not a benchmark: the measured median is about 2 ms in New York and 1 ms
// in San Francisco, on the whole of both cities' files.
test("naming a point costs milliseconds", () => {
  const times: number[] = [];
  for (let step = 0; step < 200; step += 1) {
    const lat = 40.62 + ((step * 37) % 200) / 1000;
    const lng = -74.03 + ((step * 53) % 260) / 1000;
    const started = performance.now();
    reverseCity(nyc.index, nyc.addresses, { lat, lng });
    times.push(performance.now() - started);
  }
  times.sort((left, right) => left - right);
  expect(times[times.length / 2]).toBeLessThan(25);
});
