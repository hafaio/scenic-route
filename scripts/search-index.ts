// `bun run update-search-index`: the SRCH artifact, one per city — every name a search box gets
// typed at, in a form a device with no network can answer prefix queries against.
//
// Two inputs, both already on disk. `data/places/<city>.jsonl` is the Overture read that
// scripts/places.ts does, 309,968 named places in New York and 49,520 in San Francisco. The ADDR
// file is read back as it shipped, and supplies the other kind of document: a STREET, one per (name,
// place) pair, carrying its ordinal so a house number can be resolved afterwards out of that one
// street's run. Addresses themselves are never tokenized — see src/search/search-format.ts for why
// that is the decision the whole size of this file rests on.
//
// Written to public/search/<city>.bin.gz and committed, like ADDR and the ferry timetable: nothing
// in a build or a deploy writes it. Gzipped on disk because Pages serves .bin uncompressed.
//
// Layout: src/search/search-format.ts, and scripts/README.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import {
  COORD_SCALE,
  type HouseNumber,
  packExtra,
} from "../src/search/address-format";
import {
  type AddressIndex,
  decodeAddresses,
  streetAddresses,
} from "../src/search/addresses";
import {
  DICT_BLOCK,
  type DocKind,
  MAX_NAME_TOKENS,
  ordinalValue,
  ordinalWords,
  packKindFlags,
  packTokenInfo,
  RESTART_BYTES,
  SEARCH_FORMAT,
  SEARCH_MAGIC,
  tokenize,
} from "../src/search/search-format";
import { writeVarint, zigzag } from "./geometry";
import { fetchNycBoroughs } from "./land";
import { buildLandTest } from "./land-filter";

const ROOT = join(import.meta.dirname, "..");
const PLACES_DIR = join(ROOT, "data", "places");
const ADDRESS_DIR = join(ROOT, "public", "addresses");
const SEARCH_DIR = join(ROOT, "public", "search");

const CITIES = ["nyc", "sf"] as const;

// No value in the file needs more than five varint bytes.
const MAX_VARINT_BYTES = 5;

// The Hilbert grid the documents are ordered on: 2^16 cells across the city's own box, so a cell is
// a few metres and the curve orders documents that share a doorway arbitrarily but adjacently.
const HILBERT_SIZE = 1 << 16;

// A slug carrying any of these as a WHOLE WORD. Overture writes a category as underscore-joined
// words, and a substring test over them is how `gas_station` came to be ranked with Penn Station and
// `marketing_agency` with the greengrocers: the words have to be matched as words.
function slugWords(...words: readonly string[]): RegExp {
  return new RegExp(`(^|_)(${words.join("|")})(_|$)`);
}

// Exactly one of these slugs, for the tiers where a word is not specific enough to be safe: every
// third slug in the corpus ends in `_station`, and one of them is a subway entrance.
function slugs(...names: readonly string[]): RegExp {
  return new RegExp(`^(${names.join("|")})$`);
}

// How prominent a name is before anything about the query is known — what lets a subway station beat
// a nail salon on an equal match, and the floor in the ranking is what still keeps the nail salon
// findable by name. The first rule a category matches sets the byte; the tiers are
// src/search/search-query.ts's §8 table, and they are judgment rather than measurement, which is
// what makes them a byte in the file instead of a constant in the client.
//
// The tiers are spread further apart than they were, and the reason is the distance term they
// multiply against: it swings four to one across a city, so a park a byte or two above a shop is a
// park that whatever is nearest beats. A park now stands 1.8 to 1 over a place with no category,
// which is more than distance can make of a kilometre and a half — enough that Prospect Park
// outranks the storefront named after it, and short of a shop across town outranking the same shop
// up the road, which is what distance is in the score for.
const PROMINENCE_RULES: readonly { prominence: number; slug: RegExp }[] = [
  // Where a journey ends. Named individually because `station` is also gas, radio, television,
  // EV-charging and (through `stationery`) greeting cards — 1,711 of the 3,309 rows this tier used
  // to hold.
  {
    prominence: 240,
    slug: slugs(
      "train_station",
      "metro_station",
      "bus_station",
      "light_rail_and_subway_stations",
      "airport",
      "airport_terminal",
      "heliports",
      "ferry_service",
      "public_transportation",
    ),
  },
  // Open space, which is the thing a walking map is for. Named individually because `^park` is also
  // `parking` (1,675 rows) and `^garden` is also `gardener`.
  {
    prominence: 235,
    slug: slugs(
      "park",
      "national_park",
      "state_park",
      "beach",
      "public_plaza",
      "forest",
      "nature_reserve",
      "botanical_garden",
      "community_gardens",
      "memorial_park",
      "pier",
    ),
  },
  // Somewhere people set out to see.
  {
    prominence: 220,
    slug: slugWords(
      "museum",
      "zoo",
      "aquarium",
      "stadium",
      "arena",
      "monument",
    ),
  },
  {
    prominence: 195,
    slug: slugs(
      "theatre",
      "theaters_and_performance_venues",
      "playground",
      "dog_park",
      "skate_park",
      "water_park",
      "amusement_park",
      "campground",
      "hiking_trail",
      "mountain_bike_trails",
    ),
  },
  // Civic buildings, and only the real ones: `school` as a word is also the dance, driving, cooking
  // and bartending schools, and `medical_center` is a walk-in clinic.
  {
    prominence: 170,
    slug: slugs(
      "hospital",
      "childrens_hospital",
      "library",
      "post_office",
      "police_department",
      "fire_department",
      "college_university",
      "university",
      "school",
      "elementary_school",
      "middle_school",
      "high_school",
      "public_school",
      "private_school",
      "charter_school",
      "montessori_school",
      "religious_school",
      "courthouse",
      "city_hall",
      "community_center",
    ),
  },
  // A place of worship, which every denomination spells into its own slug.
  {
    prominence: 170,
    slug: slugWords("church", "cathedral", "synagogue", "mosque", "temple"),
  },
  // The incorporated tier — an office that answers the phone, not a place anyone walks to. Ahead of
  // the shops because a `wholesale_store` is one of these and reads as the other.
  {
    prominence: 40,
    slug: slugWords(
      "professional",
      "contractor",
      "contractors",
      "lawyer",
      "lawyers",
      "attorney",
      "attorneys",
      "accountant",
      "accountants",
      "financial",
      "insurance",
      "advertising",
      "trusts",
      "consulting",
      "notary",
      "staffing",
      "wholesale",
      "wholesaler",
      "wholesalers",
      "estate",
      "corporate",
      "courier",
      "transfer",
    ),
  },
  // Shops, restaurants and the rest of a high street.
  {
    prominence: 120,
    slug: slugWords(
      "restaurant",
      "restaurants",
      "food",
      "cafe",
      "coffee",
      "bar",
      "bars",
      "bakery",
      "delicatessen",
      "pub",
      "brewery",
      "nightlife",
      "club",
      "store",
      "stores",
      "shop",
      "shopping",
      "market",
      "grocery",
      "pharmacy",
      "hotel",
      "hotels",
      "salon",
      "barber",
      "gym",
      "spa",
      "spas",
    ),
  },
];

// The open space whose prominence a house number takes away, below. Not the museums and stadiums of
// the tiers around it: those have a front door, and Overture gives them the right one.
const AREA_PROMINENCE: readonly number[] = [235, 195];

// Everything the rules do not name: the named building, the gallery, the clinic — neither prominent
// nor junk. `landmark_and_historical_building` lands here too, and is the reason this comment exists:
// Overture files 3,688 New York rows under it, and a read of them is apartment blocks — "Thessalonia
// Manor Apartments", "215 East Eighty One Street Condo" — not landmarks. It used to be the second
// highest tier in the file.
const DEFAULT_PROMINENCE = 80;
const STREET_PROMINENCE = 110;

// `hasNumber` is the only thing in the place file that speaks to how big a place is, and it speaks
// by its absence: Overture takes an address from a business listing, so a park with a house number
// on it is the shop that listed itself as one — which is exactly how a storefront called "prospect
// park" on Meeker Avenue came to be ranked as though it were the 213 hectares in Brooklyn. It says
// nothing about a museum or a station, so it is only read for the open-space tiers.
export function prominenceOf(
  category: string | null,
  hasNumber: boolean,
): number {
  if (category === null) {
    return DEFAULT_PROMINENCE;
  }
  const rule = PROMINENCE_RULES.find(({ slug }) => slug.test(category));
  if (rule === undefined) {
    return DEFAULT_PROMINENCE;
  } else if (hasNumber && AREA_PROMINENCE.includes(rule.prominence)) {
    return DEFAULT_PROMINENCE;
  } else {
    return rule.prominence;
  }
}

// One row of data/places/<city>.jsonl.
export interface PlaceRow {
  name: string;
  category: string | null;
  lat: number;
  lng: number;
  street: string | null; // the ADDR file's spelling, or null where the place did not join
  houseNumber: HouseNumber | null;
}

// A document as the builder assembles it, before quantization and ordering. `tokens` is already
// deduplicated, which is what makes one posting per (token, doc).
export interface SearchDoc {
  name: string;
  kind: DocKind;
  tokens: readonly string[];
  lat: number;
  lng: number;
  prominence: number; // how much the name is worth before the query is known
  category: string | null; // the Overture slug, or the routes a station serves
  placeIndex: number; // into the ADDR place blob; -1 where the document has none
  streetIndex: number; // into the ADDR street table; -1 where it names no street
  number: HouseNumber | null;
}

export interface EncodedSearch {
  bytes: Uint8Array;
  docCount: number;
  tokenCount: number;
  postingCount: number;
  largestList: { token: string; postings: number };
  nameBytes: number;
  dictBytes: number;
  postingBytes: number;
}

// The standard xy2d walk: at each level the quadrant contributes its share of the distance and the
// remaining square is reflected so the curve stays continuous across it. Multiplied rather than
// shifted, because a 16-level curve runs past 2^31.
function hilbertIndex(cellX: number, cellY: number): number {
  let column = cellX;
  let row = cellY;
  let distance = 0;
  for (let step = HILBERT_SIZE / 2; step >= 1; step /= 2) {
    const right = (column & step) > 0 ? 1 : 0;
    const up = (row & step) > 0 ? 1 : 0;
    distance += step * step * ((3 * right) ^ up);
    if (up === 0) {
      if (right === 1) {
        column = step - 1 - column;
        row = step - 1 - row;
      }
      const swap = column;
      column = row;
      row = swap;
    }
  }
  return distance;
}

interface Quantized {
  doc: SearchDoc;
  latUnits: number;
  lngUnits: number;
  order: number;
}

function quantize(docs: readonly SearchDoc[]): Quantized[] {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const { lat, lng } of docs) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  }
  // A city with no extent in one direction would divide by zero; a span of one grid cell is the same
  // answer without the special case.
  const latSpan = Math.max(north - south, 1e-9);
  const lngSpan = Math.max(east - west, 1e-9);
  const cell = HILBERT_SIZE - 1;
  return docs.map((doc) => {
    const column = Math.round(((doc.lng - west) / lngSpan) * cell);
    const row = Math.round(((doc.lat - south) / latSpan) * cell);
    return {
      doc,
      latUnits: Math.round(doc.lat * COORD_SCALE),
      lngUnits: Math.round(doc.lng * COORD_SCALE),
      order: hilbertIndex(column, row),
    };
  });
}

// Bytewise, which is the order the dictionary has to be written in: UTF-8 sorts as its code points
// do, and JavaScript's own string comparison sorts as UTF-16 code UNITS, which puts the astral
// planes before U+E000 and would leave a binary search unable to find them.
function compareTokens(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

function sharedPrefix(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  let length = 0;
  while (length < shared && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

// Groups the documents on the Hilbert curve, inverts them into posting lists and writes the whole
// file. Pure, so a test builds a handful of documents by hand and reads them back.
export function encodeSearch(docs: readonly SearchDoc[]): EncodedSearch {
  const ordered = quantize(docs).sort(
    (left, right) => left.order - right.order,
  );

  const encoder = new TextEncoder();
  const names = ordered.map(({ doc }) => encoder.encode(doc.name));
  const nameBytes = names.reduce((sum, name) => sum + name.length, 0);

  const categories = [
    ...new Set(
      ordered
        .map(({ doc }) => doc.category)
        .filter((category): category is string => category !== null),
    ),
  ].sort();
  const categoryIndex = new Map(
    categories.map((category, index) => [category, index]),
  );
  const categoryBlob = encoder.encode(categories.join("\n"));

  const postings = new Map<string, number[]>();
  ordered.forEach(({ doc }, id) => {
    for (const token of doc.tokens) {
      const list = postings.get(token);
      if (list === undefined) {
        postings.set(token, [id]);
      } else {
        list.push(id);
      }
    }
  });
  const tokens = [...postings.keys()]
    .map((token) => ({ token, bytes: encoder.encode(token) }))
    .sort((left, right) => compareTokens(left.bytes, right.bytes));
  const postingCount = [...postings.values()].reduce(
    (sum, list) => sum + list.length,
    0,
  );
  const tailBytes = tokens.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const restartCount = Math.ceil(tokens.length / DICT_BLOCK);

  const bytes = new Uint8Array(
    SEARCH_MAGIC.length +
      1 +
      MAX_VARINT_BYTES +
      categoryBlob.length +
      MAX_VARINT_BYTES +
      nameBytes +
      ordered.length * (3 + 6 * MAX_VARINT_BYTES) +
      3 * MAX_VARINT_BYTES +
      restartCount * RESTART_BYTES +
      tokens.length * 4 * MAX_VARINT_BYTES +
      tailBytes +
      postingCount * MAX_VARINT_BYTES,
  );

  let offset = 0;
  for (const character of SEARCH_MAGIC) {
    bytes[offset] = character.charCodeAt(0);
    offset += 1;
  }
  bytes[offset] = SEARCH_FORMAT;
  offset += 1;
  offset = writeVarint(bytes, offset, categoryBlob.length);
  bytes.set(categoryBlob, offset);
  offset += categoryBlob.length;
  offset = writeVarint(bytes, offset, ordered.length);

  let previousLat = 0;
  let previousLng = 0;
  ordered.forEach(({ doc, latUnits, lngUnits }, id) => {
    const name = names[id];
    offset = writeVarint(bytes, offset, name.length);
    bytes.set(name, offset);
    offset += name.length;
    bytes[offset] = packKindFlags(
      doc.kind,
      doc.streetIndex >= 0,
      doc.number !== null,
    );
    offset += 1;
    bytes[offset] = packTokenInfo(doc.tokens.length, doc.placeIndex);
    offset += 1;
    bytes[offset] = doc.prominence;
    offset += 1;
    offset = writeVarint(
      bytes,
      offset,
      doc.category === null ? 0 : (categoryIndex.get(doc.category) ?? -1) + 1,
    );
    offset = writeVarint(bytes, offset, zigzag(latUnits - previousLat));
    offset = writeVarint(bytes, offset, zigzag(lngUnits - previousLng));
    previousLat = latUnits;
    previousLng = lngUnits;
    if (doc.streetIndex >= 0) {
      offset = writeVarint(bytes, offset, doc.streetIndex);
    }
    if (doc.number !== null) {
      const extra = packExtra(doc.number);
      offset = writeVarint(
        bytes,
        offset,
        doc.number.major * 2 + (extra === 0 ? 0 : 1),
      );
      if (extra !== 0) {
        offset = writeVarint(bytes, offset, extra);
      }
    }
  });

  // The token entries and the postings are written into scratch buffers first, because the restart
  // table sits in front of both and holds offsets into them.
  const entries = new Uint8Array(
    tokens.length * 4 * MAX_VARINT_BYTES + tailBytes,
  );
  const lists = new Uint8Array(postingCount * MAX_VARINT_BYTES);
  const restarts = new Uint8Array(restartCount * RESTART_BYTES);
  const restartView = new DataView(restarts.buffer);
  let entryOffset = 0;
  let listOffset = 0;
  let largest = { token: "", postings: 0 };
  tokens.forEach(({ token, bytes: tokenBytes }, index) => {
    const list = postings.get(token) ?? [];
    if (list.length > largest.postings) {
      largest = { token, postings: list.length };
    }
    const block = index % DICT_BLOCK;
    if (block === 0) {
      const restart = (index / DICT_BLOCK) * RESTART_BYTES;
      restartView.setUint32(restart, entryOffset, true);
      restartView.setUint32(restart + 4, listOffset, true);
    }
    const previous = block === 0 ? new Uint8Array(0) : tokens[index - 1].bytes;
    const lcp = sharedPrefix(previous, tokenBytes);
    const listStart = listOffset;
    let previousId = 0;
    for (const id of list) {
      listOffset = writeVarint(lists, listOffset, id - previousId);
      previousId = id;
    }
    entryOffset = writeVarint(entries, entryOffset, lcp);
    entryOffset = writeVarint(entries, entryOffset, tokenBytes.length - lcp);
    entries.set(tokenBytes.subarray(lcp), entryOffset);
    entryOffset += tokenBytes.length - lcp;
    entryOffset = writeVarint(entries, entryOffset, list.length);
    entryOffset = writeVarint(entries, entryOffset, listOffset - listStart);
  });

  offset = writeVarint(bytes, offset, tokens.length);
  offset = writeVarint(bytes, offset, entryOffset);
  offset = writeVarint(bytes, offset, restartCount);
  bytes.set(restarts, offset);
  offset += restarts.length;
  bytes.set(entries.subarray(0, entryOffset), offset);
  offset += entryOffset;
  bytes.set(lists.subarray(0, listOffset), offset);
  offset += listOffset;

  return {
    bytes: bytes.subarray(0, offset),
    docCount: ordered.length,
    tokenCount: tokens.length,
    postingCount,
    largestList: largest,
    nameBytes,
    dictBytes: entryOffset + restarts.length,
    postingBytes: listOffset,
  };
}

// A street of the ADDR file, ready to be a document: where its addresses average out to, and every
// spelling of its name a reader might type.
interface StreetDoc {
  street: number; // the ordinal, which is the payload that reaches an address run later
  name: string;
  tokens: string[];
  lat: number;
  lng: number;
  placeIndex: number;
}

// Both spellings are indexed because the two cities write a numbered street four ways and only one
// of them is stored: "5 AV" is what the file has, "5th Avenue" is what the client shows, and neither
// contains "fifth". The lesson is the one rankStreetName already paid for.
export function streetTokens(source: string, pretty: string): string[] {
  const tokens = new Set([...tokenize(source), ...tokenize(pretty)]);
  for (const token of [...tokens]) {
    // The suffixed spelling too, and not only the bare digits: a street the routing graph names has
    // no other, and the query side rebuilds these words from the DISPLAY name to tell which of them
    // a query spelt out — so a name that shows an ordinal has to be findable under one.
    const value = ordinalValue(token);
    if (value !== null) {
      for (const word of ordinalWords(value)) {
        tokens.add(word);
      }
    }
  }
  return [...tokens];
}

// One document per (name, place) pair, positioned at the mean of its own addresses — the only
// coordinate the file has for a street, and near enough for a distance term whose scale is
// kilometres. A street with no addresses at all cannot be placed and is skipped.
function streetDocs(addresses: AddressIndex): StreetDoc[] {
  const docs: StreetDoc[] = [];
  const streetCount = addresses.starts.length - 1;
  for (let street = 0; street < streetCount; street += 1) {
    const houses = streetAddresses(addresses, street);
    if (houses.length === 0) {
      continue;
    }
    const nameId = addresses.streetName[street];
    const pretty = addresses.names[nameId];
    docs.push({
      street,
      name: pretty,
      tokens: streetTokens(addresses.sourceNames[nameId], pretty),
      lat: houses.reduce((sum, house) => sum + house.lat, 0) / houses.length,
      lng: houses.reduce((sum, house) => sum + house.lng, 0) / houses.length,
      placeIndex:
        addresses.places.length === 0 ? -1 : addresses.streetPlace[street],
    });
  }
  return docs;
}

function numberKey({ major, minor, suffix }: HouseNumber): string {
  return `${major}/${minor}/${suffix}`;
}

// Which of the streets of one name a joined place is on. scripts/places.ts merges New York's five
// Court Streets to look a house number up, so what it writes down is a NAME and a number, and the
// borough the place is labelled with is only recoverable by asking which of them has that house
// nearest to the place. One name is the common case and answers without decoding anything.
class StreetLookup {
  private readonly byName = new Map<string, number[]>();
  private readonly houses = new Map<
    string,
    Map<string, { street: number; lat: number; lng: number }[]>
  >();

  constructor(private readonly addresses: AddressIndex) {
    const streetCount = addresses.starts.length - 1;
    for (let street = 0; street < streetCount; street += 1) {
      const name = addresses.sourceNames[addresses.streetName[street]];
      const existing = this.byName.get(name);
      if (existing === undefined) {
        this.byName.set(name, [street]);
      } else {
        existing.push(street);
      }
    }
  }

  private houseIndex(
    name: string,
    streets: readonly number[],
  ): Map<string, { street: number; lat: number; lng: number }[]> {
    const cached = this.houses.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const index = new Map<
      string,
      { street: number; lat: number; lng: number }[]
    >();
    for (const street of streets) {
      for (const { number, lat, lng } of streetAddresses(
        this.addresses,
        street,
      )) {
        const key = numberKey(number);
        const entry = { street, lat, lng };
        const existing = index.get(key);
        if (existing === undefined) {
          index.set(key, [entry]);
        } else {
          existing.push(entry);
        }
      }
    }
    this.houses.set(name, index);
    return index;
  }

  find(
    name: string,
    number: HouseNumber,
    at: { lat: number; lng: number },
  ): number | null {
    const streets = this.byName.get(name);
    if (streets === undefined) {
      return null;
    } else if (streets.length === 1) {
      return streets[0];
    }
    const houses = this.houseIndex(name, streets).get(numberKey(number));
    if (houses === undefined || houses.length === 0) {
      return null;
    }
    let nearest = houses[0];
    let best = Infinity;
    for (const house of houses) {
      const north = house.lat - at.lat;
      const east = house.lng - at.lng;
      const distance = north * north + east * east;
      if (distance < best) {
        best = distance;
        nearest = house;
      }
    }
    return nearest.street;
  }
}

export interface Summary {
  places: number;
  streets: number;
  joined: number; // places that carry a street ordinal, so a result can be labelled with its address
  unplaced: number; // joined places whose street could not be told from its namesakes
  bounded: number; // places whose borough came from the boundaries rather than from an address
  homeless: number; // places no address and no boundary could place, so they read with no borough
  untokenized: number; // names that are nothing but punctuation, so nothing can find them
  longNames: number; // more words than the four bits of token count can hold
}

// One of the city's own named parts — a New York borough — as the ADDR place it labels a result
// with, and the test for whether a point is inside it.
export interface PlaceArea {
  placeIndex: number;
  contains: (at: { lat: number; lng: number }) => boolean;
}

// The boroughs, as the places the address file names, for the 53,507 New York places that never
// joined an address: parks, campuses, beaches — everything with a name and no front door. Nothing in
// the Overture row says which borough one is in, so it comes from the city's own boundaries, which
// is the same dataset (Socrata `gthc-hcne`) the land mask every ingest clips to is built from. A
// city whose address file names no places (San Francisco is one place) gets none, and nothing
// spatial runs for it.
export async function placeAreas(
  cityId: string,
  addresses: AddressIndex,
): Promise<PlaceArea[]> {
  if (addresses.places.length === 0 || cityId !== "nyc") {
    return [];
  }
  const boroughs = await fetchNycBoroughs();
  const areas: PlaceArea[] = [];
  for (const borough of boroughs) {
    const placeIndex = addresses.places.indexOf(borough.name);
    if (placeIndex < 0) {
      throw new Error(
        `${borough.name} is not a place of the ${cityId} addresses`,
      );
    }
    areas.push({ placeIndex, contains: buildLandTest(borough.polygons) });
  }
  return areas;
}

async function readPlaces(cityId: string): Promise<PlaceRow[]> {
  const text = await readFile(join(PLACES_DIR, `${cityId}.jsonl`), "utf-8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as PlaceRow);
}

async function readAddresses(cityId: string): Promise<AddressIndex> {
  const gzipped = await readFile(join(ADDRESS_DIR, `${cityId}.bin.gz`));
  return decodeAddresses(gunzipSync(gzipped));
}

// The documents of one city: every place, then every street. Pure, so a test stands up a handful of
// addresses and a couple of Overture rows and checks which street a place was filed under.
export function buildDocs(
  rows: readonly PlaceRow[],
  addresses: AddressIndex,
  areas: readonly PlaceArea[] = [],
): { docs: SearchDoc[]; summary: Summary } {
  const lookup = new StreetLookup(addresses);
  const docs: SearchDoc[] = [];
  const summary: Summary = {
    places: 0,
    streets: 0,
    joined: 0,
    unplaced: 0,
    bounded: 0,
    homeless: 0,
    untokenized: 0,
    longNames: 0,
  };

  for (const row of rows) {
    const street =
      row.street === null || row.houseNumber === null
        ? null
        : lookup.find(row.street, row.houseNumber, row);
    if (row.street !== null && street === null) {
      summary.unplaced += 1;
    }
    summary.places += 1;
    const tokens = [...new Set(tokenize(row.name))];
    // A name with no word in it is in no posting list, so nothing can search for it — and San
    // Francisco files two, a bare "?" and Apple's private-use glyph, which reverse geocoding was
    // then free to answer a dropped pin with. A document nothing can find is not a document.
    if (tokens.length === 0) {
      summary.untokenized += 1;
      continue;
    }
    if (tokens.length > MAX_NAME_TOKENS) {
      summary.longNames += 1;
    }
    if (street !== null) {
      summary.joined += 1;
    }
    // The borough is the street's where the place joined one, since that is the address's own
    // answer, and the city's own boundaries where it did not.
    let placeIndex = -1;
    if (addresses.places.length > 0) {
      if (street !== null) {
        placeIndex = addresses.streetPlace[street];
      } else {
        const area = areas.find(({ contains }) => contains(row));
        if (area !== undefined) {
          placeIndex = area.placeIndex;
          summary.bounded += 1;
        } else {
          summary.homeless += 1;
        }
      }
    }
    docs.push({
      name: row.name,
      kind: "place",
      tokens,
      lat: row.lat,
      lng: row.lng,
      prominence: prominenceOf(row.category, row.houseNumber !== null),
      category: row.category,
      placeIndex,
      streetIndex: street ?? -1,
      number: street === null ? null : row.houseNumber,
    });
  }

  for (const street of streetDocs(addresses)) {
    summary.streets += 1;
    docs.push({
      name: street.name,
      kind: "street",
      tokens: street.tokens,
      lat: street.lat,
      lng: street.lng,
      prominence: STREET_PROMINENCE,
      category: null,
      placeIndex: street.placeIndex,
      streetIndex: street.street,
      number: null,
    });
  }

  return { docs, summary };
}

async function buildCity(
  cityId: string,
): Promise<{ docs: SearchDoc[]; summary: Summary }> {
  const [rows, addresses] = await Promise.all([
    readPlaces(cityId),
    readAddresses(cityId),
  ]);
  return buildDocs(rows, addresses, await placeAreas(cityId, addresses));
}

export async function updateSearchIndex(): Promise<void> {
  await mkdir(SEARCH_DIR, { recursive: true });
  for (const cityId of CITIES) {
    console.error(`search-index: reading ${cityId}`);
    const { docs, summary } = await buildCity(cityId);
    const encoded = encodeSearch(docs);
    const gzipped = gzipSync(encoded.bytes, {
      level: constants.Z_BEST_COMPRESSION,
    });
    await writeFile(join(SEARCH_DIR, `${cityId}.bin.gz`), gzipped);
    const megabytes = (value: number) => (value / 1e6).toFixed(2);
    console.error(
      `search-index: ${cityId}: ${encoded.docCount} docs ` +
        `(${summary.places} places, ${summary.streets} streets, ${summary.joined} at an address), ` +
        `${encoded.tokenCount} tokens, ${encoded.postingCount} postings, ` +
        `largest list ${encoded.largestList.token} ${encoded.largestList.postings}, ` +
        `${summary.unplaced} places whose street was ambiguous, ` +
        `${summary.bounded} placed by the city's boundaries, ` +
        `${summary.homeless} with no place at all, ` +
        `${summary.untokenized} names with no searchable word, ` +
        `${summary.longNames} names past ${MAX_NAME_TOKENS} words`,
    );
    console.error(
      `search-index: ${cityId}: ${megabytes(encoded.bytes.length)} MB raw ` +
        `(names ${megabytes(encoded.nameBytes)}, dictionary ${megabytes(encoded.dictBytes)}, ` +
        `postings ${megabytes(encoded.postingBytes)}), ` +
        `${megabytes(gzipped.length)} MB gzipped ` +
        `(${(gzipped.length / encoded.docCount).toFixed(1)} B/doc)`,
    );
  }
}

if (import.meta.main) {
  await updateSearchIndex();
}
