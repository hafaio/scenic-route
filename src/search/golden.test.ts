// The queries the search is not allowed to get wrong, asked of the artifacts the app actually ships
// rather than of a corpus built for the occasion.
//
// Every case here is something that was once wrong: the subway station that outranked Fifth Avenue,
// the storefront filed as a park that outranked Prospect Park, the shop called Shake Top DeLite that
// outranked Shake Shack. `search-query.test.ts` is where a RULE is stated against a handful of
// documents; this is where the rules are checked against 380,000 real ones, because a weight moved by
// a tenth changes nothing there and everything here. A ranking change that breaks one of these fails
// a test rather than being noticed in a browser three weeks later.
//
// Both files are read off disk and decoded in about 150 ms, and the whole set answers in well under a
// second, so this needs no browser, no worker and no network.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import manifest from "../tree-cover/manifest.json";
import { type AddressIndex, decodeAddresses } from "./addresses";
import { type DocKind, tokenize } from "./search-format";
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
  centre: Point;
}

function artifact(name: string): Uint8Array {
  return new Uint8Array(
    gunzipSync(readFileSync(new URL(`../../public/${name}`, import.meta.url))),
  );
}

// The centre a city opens on when nothing has said otherwise, derived the way src/cities.ts derives
// it, so a bounds change moves both together.
function load(cityId: string): City {
  const bounds = manifest.cities.find(({ id }) => id === cityId)?.bounds;
  if (bounds === undefined) {
    throw new Error(`no city ${cityId} in the manifest`);
  }
  return {
    index: decodeSearchIndex(artifact(`search/${cityId}.bin.gz`)),
    addresses: decodeAddresses(artifact(`addresses/${cityId}.bin.gz`)),
    centre: {
      lat: (bounds.north + bounds.south) / 2,
      lng: (bounds.east + bounds.west) / 2,
    },
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

// Where the map is when the query is typed. It is part of the case, not scenery: the same words at
// two ends of the city are two different questions, and half of these answers move with it.
const BRYANT_PARK: Point = { lat: 40.7536, lng: -73.9832 };
const UNION_SQUARE: Point = { lat: 40.73, lng: -73.99 };
const UPPER_EAST_SIDE: Point = { lat: 40.773, lng: -73.963 };
const DUMBO: Point = { lat: 40.7033, lng: -73.9938 };
const MISSION: Point = { lat: 37.7599, lng: -122.4148 };

// How many answers the search box asks the worker for — MAX_LOCAL_RESULTS in src/geocode.ts. It is
// part of the question, not a display cap: the correction pass only runs when the first pass came
// back thinner than this, so asking for a different number is asking something else.
const ASKED = 8;

interface Golden {
  query: string;
  from: Point;
  // The name the leading row must carry, spelt exactly as the artifact spells it.
  name: string;
  // Where that answer really is, and how far the row may be from it. A street is one point standing
  // for its whole length, so its tolerance is loose where a shop's is a block.
  at: Point;
  within: number;
  kind: DocKind;
  // Whether the house number asked for is the one found. Only the address cases ask a number.
  exact?: boolean;
  why: string;
}

const NYC_GOLDEN: readonly Golden[] = [
  {
    query: "5 Av",
    from: UPPER_EAST_SIDE,
    name: "5th Avenue",
    at: { lat: 40.77037, lng: -73.96849 },
    within: 1500,
    kind: "street",
    why: "the avenue, not the station of the same name and not 57th Avenue",
  },
  {
    query: "5 Av",
    from: UNION_SQUARE,
    name: "5th Avenue",
    at: { lat: 40.77037, lng: -73.96849 },
    within: 6000,
    kind: "street",
    why: "the avenue, not the doorway numbered 5 on Avenue A a few blocks east",
  },
  {
    query: "shake sh",
    from: BRYANT_PARK,
    name: "Shake Shack",
    at: { lat: 40.75486, lng: -73.98534 },
    within: 400,
    kind: "place",
    why: "the chain, not Shake Top DeLite, and the branch you are standing by",
  },
  {
    query: "shake shak",
    from: BRYANT_PARK,
    name: "Shake Shack",
    at: { lat: 40.75486, lng: -73.98534 },
    within: 400,
    kind: "place",
    why: "one letter short of the name still finds it",
  },
  {
    query: "Prospect Park",
    from: nyc.centre,
    name: "Prospect Park",
    at: { lat: 40.6602, lng: -73.96895 },
    within: 2000,
    kind: "place",
    why: "the park, not the storefront on Meeker Avenue that is filed as one",
  },
  {
    query: "prosepct park",
    from: nyc.centre,
    name: "Prospect Park",
    at: { lat: 40.6602, lng: -73.96895 },
    within: 2000,
    kind: "place",
    why: "two letters swapped still finds the park",
  },
  {
    query: "Williamsburg",
    from: nyc.centre,
    name: "Williamsburg",
    at: { lat: 40.71462, lng: -73.95345 },
    within: 1000,
    kind: "neighborhood",
    why: "the neighbourhood, which is the hole that made the geocoder look necessary",
  },
  {
    query: "312 Court St",
    from: nyc.centre,
    name: "312 Court Street",
    at: { lat: 40.68351, lng: -73.99551 },
    within: 150,
    kind: "street",
    exact: true,
    why: "the door, out of the address file, and the number the file holds",
  },
  {
    query: "312 corut st",
    from: nyc.centre,
    name: "312 Court Street",
    at: { lat: 40.68351, lng: -73.99551 },
    within: 150,
    kind: "street",
    exact: true,
    why: "a street spelt wrongly still opens its doors",
  },
  {
    query: "Katz's Delicatessen E Houston St",
    from: nyc.centre,
    name: "Katz's Delicatessen",
    at: { lat: 40.72227, lng: -73.98741 },
    within: 150,
    kind: "place",
    why: "the street a place sits on answers for it, though its name never says so",
  },
  {
    query: "bryant park",
    from: BRYANT_PARK,
    name: "Bryant Park",
    at: { lat: 40.7536, lng: -73.9832 },
    within: 400,
    kind: "street",
    why: "the park underfoot, not Bryant Park 42street in Brooklyn",
  },
  {
    query: "katzs delicatesen e houston st",
    from: nyc.centre,
    name: "Katz's Delicatessen",
    at: { lat: 40.72227, lng: -73.98741 },
    within: 150,
    kind: "place",
    why: "and it survives the apostrophe dropped and the letter missed on the way",
  },
  {
    query: "Peter Luger",
    from: nyc.centre,
    name: "Peter Luger Steak House",
    at: { lat: 40.70984, lng: -73.96256 },
    within: 150,
    kind: "place",
    why: "half a name beats every St Peter in Brooklyn",
  },
  {
    query: "peter lugar",
    from: nyc.centre,
    name: "Peter Luger Steak House",
    at: { lat: 40.70984, lng: -73.96256 },
    within: 150,
    kind: "place",
    why: "and so does half a name spelt as it sounds",
  },
];

const SF_GOLDEN: readonly Golden[] = [
  {
    query: "Ferry Building",
    from: sf.centre,
    name: "Ferry Building",
    at: { lat: 37.79576, lng: -122.39352 },
    within: 200,
    kind: "landmark",
    why: "the landmark, not the four shops and the stop named after it",
  },
  {
    query: "992 Valencia St",
    from: MISSION,
    name: "992 Valencia Street",
    at: { lat: 37.75704, lng: -122.42143 },
    within: 150,
    kind: "street",
    exact: true,
    why: "the address file answers the other city too",
  },
  {
    query: "tartine bakery",
    from: MISSION,
    name: "Tartine Bakery",
    at: { lat: 37.76143, lng: -122.42409 },
    within: 150,
    kind: "place",
    why: "the bakery, not the manufactory, the bar or the holding company",
  },
  {
    query: "tartine bakry",
    from: MISSION,
    name: "Tartine Bakery",
    at: { lat: 37.76143, lng: -122.42409 },
    within: 150,
    kind: "place",
    why: "and it survives a missing letter",
  },
];

function check(city: City, golden: Golden): void {
  const { query, from, name, at, within, kind, exact, why } = golden;
  const [top] = searchCity(city.index, city.addresses, {
    text: query,
    centre: from,
    limit: ASKED,
  });
  expect(top, `"${query}" answered nothing — ${why}`).toBeDefined();
  const said = `"${query}" led with ${top.kind} "${top.name}" at ${top.lat.toFixed(5)},${top.lng.toFixed(5)} — ${why}`;
  expect(top.name, said).toBe(name);
  expect(top.kind, said).toBe(kind);
  expect(metersApart(top, at), said).toBeLessThanOrEqual(within);
  expect(top.exact, said).toBe(exact ?? null);
}

for (const golden of NYC_GOLDEN) {
  test(`nyc: "${golden.query}" — ${golden.why}`, () => {
    check(nyc, golden);
  });
}

for (const golden of SF_GOLDEN) {
  test(`sf: "${golden.query}" — ${golden.why}`, () => {
    check(sf, golden);
  });
}

// The other direction: a point, not a name. A document the index cannot be searched for must not be
// what a dropped pin is called either — San Francisco shipped a place named for Apple's private-use
// glyph, sitting on this corner, and it beat the door seven metres further away.
test("the map centre picks the branch, not the city", () => {
  const branch = (from: Point): Point => {
    const [top] = searchCity(nyc.index, nyc.addresses, {
      text: "shake sh",
      centre: from,
      limit: ASKED,
    });
    expect(top.name).toBe("Shake Shack");
    return top;
  };
  // The same chain, the same query, two ends of the same city: what changes the answer is the only
  // spatial input the search has. Nothing here knows where the device is, and nothing needs to.
  expect(metersApart(branch(BRYANT_PARK), BRYANT_PARK)).toBeLessThan(500);
  expect(metersApart(branch(DUMBO), DUMBO)).toBeLessThan(500);
});
