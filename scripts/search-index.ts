// `bun run update-search-index`: the SRCH artifact, one per city — every name a search box gets
// typed at, in a form a device with no network can answer prefix queries against.
//
// Every input is already on disk. `data/places/<city>.jsonl` is the Overture read that
// scripts/places.ts does, 309,968 named places in New York and 49,520 in San Francisco. The ADDR
// file is read back as it shipped, and supplies the other kind of document: a STREET, one per (name,
// place) pair, carrying its ordinal so a house number can be resolved afterwards out of that one
// street's run. Addresses themselves are never tokenized — see src/search/search-format.ts for why
// that is the decision the whole size of this file rests on.
//
// The rest are the names the app already ships and could not search: the routing graph's own street
// names (the alleys, footbridges and park paths ADDR has no addresses on), the subway stations, and
// the curated point sets — landmarks, public art, legacy businesses, outdoor dining. Each of those
// had its own list and its own ranking, or no search at all; here they are documents like any other.
//
// Written to public/search/<city>.bin.gz and committed, like ADDR and the ferry timetable: nothing
// in a build or a deploy writes it. Gzipped on disk because Pages serves .bin uncompressed.
//
// Layout: src/search/search-format.ts, and scripts/README.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { decodeGraph, type GraphIdentity } from "../src/routing/graph";
import { decodePois } from "../src/routing/pois";
import { prettifyStreetName } from "../src/routing/street-names";
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
import {
  decodeSubway,
  mergeStations,
  stationRoutes,
} from "../src/subway/format";
import { writeVarint, zigzag } from "./geometry";
import { fetchNycBoroughs } from "./land";
import { buildLandTest } from "./land-filter";

const ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(ROOT, "data");
const PLACES_DIR = join(DATA_DIR, "places");
const ADDRESS_DIR = join(ROOT, "public", "addresses");
const GRAPH_DIR = join(ROOT, "public", "routing");
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
const STREET_PROMINENCE = 170;

// The curated sets, which have no Overture category to be read off and so carry a tier of their own.
// A station is what the transit tier above is for; a designated landmark sits just under the museums
// because the register holds as many private houses as it does cathedrals; a business a city has
// certified as fifty years old is a destination and a modest one; a sculpture is named, findable and
// small. Dining points are restaurants and rank as the shops do.
const STATION_PROMINENCE = 240;
// A stop named after the corner it stands on rather than after a place: San Francisco files 182 of
// its 217 Muni stops as "Judah St & 40th Ave", which is a kerb with a sign on it and not where a
// journey ends. New York names none of its stations this way. The same lesson as `gas_station` in
// the tiers above — the name is what says which kind of thing this is.
const STOP_PROMINENCE = 150;
const CORNER_NAME = /&/;
const LANDMARK_PROMINENCE = 210;
const LEGACY_PROMINENCE = 180;
const ART_PROMINENCE = 150;
const DINING_PROMINENCE = 120;
// A part of the city rather than a thing in it. Ranked with the sculptures and the schools on
// purpose: "Williamsburg" is what a reader types when nothing more precise will do, and it should
// lead the shops named after it — which its coverage of the query does — without standing over the
// park or the station a reader named exactly.
const NEIGHBORHOOD_PROMINENCE = 150;

// How near two documents of one name have to be to be one place said twice. Overture holds the same
// station, landmark and old shop the curated sets do, under the same name and a doorway or two away,
// and the curated row is the one that keeps its tier. A block is about 80 m in New York, so this is
// "the same place, wherever each source put its point" rather than "the same street".
const SAME_PLACE_METERS = 150;
// How many of the dropped pairs are printed. Every one is counted; the log is a skim for whether the
// rule is catching what it should, and thousands of lines is not a skim.
const LOGGED_DUPLICATES = 25;

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

// One row of data/places/<city>-neighborhoods.jsonl. Spelt out here rather than imported from
// scripts/places.ts for the same reason PlaceRow below is: that module opens DuckDB as it loads, and
// this one only reads what it wrote.
const NEIGHBORHOOD_SUFFIX = "-neighborhoods.jsonl";

interface NeighborhoodRow {
  name: string;
  lat: number;
  lng: number;
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
  tokens: readonly string[]; // every spelling the document is findable under
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
    // The DISPLAY name's word count, which `tokens` is neither: it carries a street's other
    // spellings, and it is deduplicated, so "Boutique Boutique" would go in as one word the query
    // `boutique` covers whole rather than two it covers half of.
    bytes[offset] = packTokenInfo(tokenize(doc.name).length, doc.placeIndex);
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

// A street the ROUTING GRAPH names and the address file does not: the alleys, the footbridges, the
// paths through a park. 2,551 of them in New York and 701 in San Francisco — no house numbers, so no
// ADDR ordinal and no address to resolve, but they are names the box answered before this index
// existed and it would be a poor unification that lost them.
export interface GraphStreet {
  name: string;
  tokens: string[];
  lat: number;
  lng: number;
}

// Which source keeps a name two of them hold. The curated sets lead because they carry the better
// tier and the city's own spelling of it; dining trails Overture because a dining point is the same
// restaurant with no category, no address and no borough.
const CURATED_PRIORITY = 0;
const OVERTURE_PRIORITY = 1;
const DINING_PRIORITY = 2;

// A named point from one of the sets the app already ships.
export interface NamedPoint {
  name: string;
  lat: number;
  lng: number;
  detail?: string; // rides in the category slot — a station's routes, indexed into the shared table
}

export interface PointSet {
  kind: DocKind;
  source: string; // which file, for the log — two sets are places, so the kind cannot say which lost
  prominence: number; // the tier every point in the set is worth
  priority: number; // which set survives when two of them name one place
  points: readonly NamedPoint[];
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
  streets: number; // ADDR streets, which are the ones a house number can be resolved on
  graphStreets: number; // names the routing graph carries and ADDR does not
  points: number; // documents from the curated sets — stations, landmarks, art, legacy, dining
  duplicates: number; // documents dropped as one place two sources both named
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

// One of the shared point blobs (LMRK, ARTW, LGCY, DINE), or null where this city has none — San
// Francisco publishes no outdoor-dining table.
async function readPoints(
  directory: string,
  cityId: string,
  magic: string,
): Promise<NamedPoint[] | null> {
  const path = join(DATA_DIR, directory, `${cityId}.bin`);
  const file = await readFile(path).catch(() => null);
  if (file === null) {
    return null;
  }
  const { lats, lngs, names } = decodePois(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    magic,
  );
  const points: NamedPoint[] = [];
  for (let point = 0; point < names.length; point += 1) {
    // An unnamed artwork — 410 of New York's 1,498 — is a point on a map and nothing a search can
    // reach, so it is not a document.
    if (names[point] !== "") {
      points.push({ name: names[point], lat: lats[point], lng: lngs[point] });
    }
  }
  return points;
}

// The city's own named parts, out of the file scripts/places.ts writes beside the places: New York's
// 368 and San Francisco's 95, from the divisions theme of the same Overture release the places come
// from. A city whose places have not been read yet has none.
async function neighborhoodPoints(
  cityId: string,
): Promise<NamedPoint[] | null> {
  const path = join(PLACES_DIR, `${cityId}${NEIGHBORHOOD_SUFFIX}`);
  const text = await readFile(path, "utf-8").catch(() => null);
  if (text === null) {
    return null;
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as NeighborhoodRow);
}

// The subway stations, merged into one document per complex the way the overlay and the old station
// search both merged them: a rider searching Times Sq means all ten routes, not the ten records the
// feed files. The routes ride in the category slot, which is what lets a result still read
// "14 St-Union Sq (4/5/6/L…)".
async function stationPoints(cityId: string): Promise<NamedPoint[] | null> {
  const path = join(DATA_DIR, "subway", `${cityId}.bin`);
  const file = await readFile(path).catch(() => null);
  if (file === null) {
    return null;
  }
  const { routes, stations } = decodeSubway(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
  );
  return mergeStations(stations).map((station) => {
    const serving = stationRoutes(station, routes).join("/");
    return {
      name: station.name,
      lat: station.lat,
      lng: station.lng,
      // Absent rather than empty for a station whose feed named no route, so the category slot is
      // "this document has none" instead of a blank string in the shared table.
      detail: serving === "" ? undefined : serving,
    };
  });
}

// Every set of named points the city ships, in the order that settles which of them keeps a name two
// of them hold.
async function citySets(cityId: string): Promise<PointSet[]> {
  const sets: PointSet[] = [];
  const add = (
    kind: DocKind,
    source: string,
    prominence: number,
    priority: number,
    points: NamedPoint[] | null,
  ) => {
    if (points !== null && points.length > 0) {
      sets.push({ kind, source, prominence, priority, points });
    }
  };
  const stations = await stationPoints(cityId);
  add(
    "station",
    "subway",
    STATION_PROMINENCE,
    CURATED_PRIORITY,
    stations?.filter(({ name }) => !CORNER_NAME.test(name)) ?? null,
  );
  add(
    "station",
    "subway stops",
    STOP_PROMINENCE,
    CURATED_PRIORITY,
    stations?.filter(({ name }) => CORNER_NAME.test(name)) ?? null,
  );
  add(
    "landmark",
    "landmarks",
    LANDMARK_PROMINENCE,
    CURATED_PRIORITY,
    await readPoints("landmarks", cityId, "LMRK"),
  );
  add(
    "legacy-business",
    "legacy",
    LEGACY_PROMINENCE,
    CURATED_PRIORITY,
    await readPoints("legacy", cityId, "LGCY"),
  );
  add(
    "art",
    "art",
    ART_PROMINENCE,
    CURATED_PRIORITY,
    await readPoints("art", cityId, "ARTW"),
  );
  add(
    "neighborhood",
    "neighborhoods",
    NEIGHBORHOOD_PROMINENCE,
    CURATED_PRIORITY,
    await neighborhoodPoints(cityId),
  );
  // Outdoor dining is a restaurant like any other, so it is filed as a place — and behind Overture,
  // which holds most of the same restaurants with a category and a front door.
  add(
    "place",
    "dining",
    DINING_PROMINENCE,
    DINING_PRIORITY,
    await readPoints("dining", cityId, "DINE"),
  );
  return sets;
}

// The street names the routing graph carries, minus the ones ADDR already has: what is left is the
// alleys, the footbridges and the park paths that have no addresses on them. The first edge carrying
// a name decides where the name points, which is what the street search did, and walking the edges
// in order makes that deterministic.
async function graphStreets(
  cityId: string,
  addresses: AddressIndex,
): Promise<GraphStreet[]> {
  const path = join(GRAPH_DIR, `${cityId}.bin`);
  const file = await readFile(path).catch(() => null);
  if (file === null) {
    throw new Error(
      `${path} is missing: the graph names are part of the index, so build it first (bun run build-tiles:graph)`,
    );
  }
  const identity = JSON.parse(
    await readFile(join(GRAPH_DIR, `${cityId}.version.json`), "utf-8"),
  ) as GraphIdentity;
  const graph = decodeGraph(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    identity,
  );
  const known = new Set(
    addresses.sourceNames.map((name) => name.toUpperCase()),
  );
  const seen = new Set<number>();
  const streets: GraphStreet[] = [];
  for (let edge = 0; edge < graph.edgeCount; edge += 1) {
    const nameId = graph.edgeNameId[edge];
    const name = graph.names[nameId];
    if (name === undefined || name === "" || seen.has(nameId)) {
      continue;
    }
    seen.add(nameId);
    if (known.has(name.toUpperCase())) {
      continue; // ADDR has this street, with addresses on it and a borough to label it with
    }
    const node = graph.edgeNodeA[edge];
    const pretty = prettifyStreetName(name);
    streets.push({
      name: pretty,
      tokens: streetTokens(name, pretty),
      lat: graph.originLat + graph.nodeQy[node] * graph.scale,
      lng: graph.originLng + graph.nodeQx[node] * graph.scale,
    });
  }
  return streets;
}

const METERS_PER_DEGREE = 111_320;

function metersApart(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const north = from.lat - to.lat;
  const east = (from.lng - to.lng) * Math.cos((from.lat * Math.PI) / 180);
  return Math.sqrt(north * north + east * east) * METERS_PER_DEGREE;
}

// A document and the source that produced it, before the sources are folded into one list.
interface Candidate {
  doc: SearchDoc;
  source: string;
  priority: number;
}

function tokenKey(tokens: readonly string[]): string {
  return [...tokens].sort().join(" ");
}

// Everything the dropped document knew that the surviving one does not.
function inherit(kept: SearchDoc, dropped: SearchDoc): void {
  // Two sources' opinions of how prominent one place is, and each tier is what its own source can
  // vouch for rather than the whole truth: the bank named Bay Ridge stands in the neighbourhood of
  // that name, and the plaza called Nolan Park is a park. The higher of the two is what the one
  // remaining document is worth.
  kept.prominence = Math.max(kept.prominence, dropped.prominence);
  if (kept.placeIndex < 0) {
    kept.placeIndex = dropped.placeIndex;
  }
  // A district is not a bank and has no front door, whatever the shop that shares its name and its
  // corner has: a neighborhood takes the borough it stands in and none of the rest.
  if (kept.kind !== "neighborhood") {
    if (kept.streetIndex < 0 && dropped.streetIndex >= 0) {
      kept.streetIndex = dropped.streetIndex;
      kept.number = dropped.number;
    }
    if (kept.category === null) {
      kept.category = dropped.category;
    }
  }
}

// One place is one document however many sources name it: an Overture row and a curated point that
// share every word of their names and stand within SAME_PLACE_METERS are the same station, landmark
// or fifty-year-old shop, and the one that stays is the one whose source knows more about it.
//
// Only ACROSS sources. Two Overture rows of one name a block apart are two branches of a chain at
// least as often as they are one shop written down twice, and nothing here can tell those apart.
function dedupe(candidates: readonly Candidate[]): {
  docs: SearchDoc[];
  dropped: string[];
} {
  const byName = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = tokenKey(candidate.doc.tokens);
    if (key === "") {
      continue; // a name with no searchable word is nobody's duplicate
    }
    const group = byName.get(key);
    if (group === undefined) {
      byName.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }

  const duplicates = new Set<SearchDoc>();
  const dropped: string[] = [];
  for (const group of byName.values()) {
    if (
      group.length < 2 ||
      group.every((one) => one.priority === group[0].priority)
    ) {
      continue;
    }
    const ordered = [...group].sort(
      (left, right) => left.priority - right.priority,
    );
    const kept: Candidate[] = [];
    for (const candidate of ordered) {
      const winner = kept.find(
        (other) =>
          other.priority < candidate.priority &&
          metersApart(other.doc, candidate.doc) <= SAME_PLACE_METERS,
      );
      if (winner === undefined) {
        kept.push(candidate);
      } else {
        // What the loser knew and the winner does not: an Overture row carries a doorway, a borough
        // and a category, and a curated point carries none of the three, so the survivor takes them.
        // Only the empty fields — a station's routes ride in the category slot and are not an
        // Overture slug to be overwritten by one.
        inherit(winner.doc, candidate.doc);
        duplicates.add(candidate.doc);
        dropped.push(
          `${candidate.doc.name} (${candidate.source}) for ${winner.doc.name} (${winner.source}), ` +
            `${metersApart(winner.doc, candidate.doc).toFixed(0)} m apart`,
        );
      }
    }
  }
  return {
    docs: candidates
      .filter(({ doc }) => !duplicates.has(doc))
      .map(({ doc }) => doc),
    dropped,
  };
}

// Everything the city has to say beyond its Overture places and its address file.
export interface DocSources {
  areas?: readonly PlaceArea[];
  sets?: readonly PointSet[];
  streets?: readonly GraphStreet[];
}

// The documents of one city: every place, every street, and every named point the city ships. Pure,
// so a test stands up a handful of addresses and a couple of Overture rows and checks which street a
// place was filed under.
export function buildDocs(
  rows: readonly PlaceRow[],
  addresses: AddressIndex,
  { areas = [], sets = [], streets = [] }: DocSources = {},
): { docs: SearchDoc[]; summary: Summary; dropped: string[] } {
  const lookup = new StreetLookup(addresses);
  const candidates: Candidate[] = [];
  const summary: Summary = {
    places: 0,
    streets: 0,
    graphStreets: 0,
    points: 0,
    duplicates: 0,
    joined: 0,
    unplaced: 0,
    bounded: 0,
    homeless: 0,
    untokenized: 0,
    longNames: 0,
  };
  // Which borough a point with no address is in, which is all the boundaries are asked for.
  const boroughOf = (at: { lat: number; lng: number }): number =>
    areas.find(({ contains }) => contains(at))?.placeIndex ?? -1;

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
        placeIndex = boroughOf(row);
        if (placeIndex >= 0) {
          summary.bounded += 1;
        } else {
          summary.homeless += 1;
        }
      }
    }
    candidates.push({
      source: "overture",
      priority: OVERTURE_PRIORITY,
      doc: {
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
      },
    });
  }

  for (const set of sets) {
    for (const point of set.points) {
      const tokens = [...new Set(tokenize(point.name))];
      if (tokens.length === 0) {
        continue;
      }
      summary.points += 1;
      candidates.push({
        source: set.source,
        priority: set.priority,
        doc: {
          name: point.name,
          kind: set.kind,
          tokens,
          lat: point.lat,
          lng: point.lng,
          prominence: set.prominence,
          category: point.detail ?? null,
          placeIndex: boroughOf(point),
          streetIndex: -1,
          number: null,
        },
      });
    }
  }

  for (const street of streetDocs(addresses)) {
    summary.streets += 1;
    candidates.push({
      source: "addresses",
      priority: CURATED_PRIORITY,
      doc: {
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
      },
    });
  }

  for (const street of streets) {
    summary.graphStreets += 1;
    candidates.push({
      source: "graph",
      priority: CURATED_PRIORITY,
      doc: {
        name: street.name,
        kind: "street",
        tokens: street.tokens,
        lat: street.lat,
        lng: street.lng,
        prominence: STREET_PROMINENCE,
        category: null,
        placeIndex: boroughOf(street),
        streetIndex: -1,
        number: null,
      },
    });
  }

  const { docs, dropped } = dedupe(candidates);
  summary.duplicates = dropped.length;
  return { docs, summary, dropped };
}

async function buildCity(
  cityId: string,
): Promise<{ docs: SearchDoc[]; summary: Summary; dropped: string[] }> {
  const [rows, addresses, sets] = await Promise.all([
    readPlaces(cityId),
    readAddresses(cityId),
    citySets(cityId),
  ]);
  return buildDocs(rows, addresses, {
    areas: await placeAreas(cityId, addresses),
    sets,
    streets: await graphStreets(cityId, addresses),
  });
}

export async function updateSearchIndex(): Promise<void> {
  await mkdir(SEARCH_DIR, { recursive: true });
  for (const cityId of CITIES) {
    console.error(`search-index: reading ${cityId}`);
    const { docs, summary, dropped } = await buildCity(cityId);
    const encoded = encodeSearch(docs);
    const gzipped = gzipSync(encoded.bytes, {
      level: constants.Z_BEST_COMPRESSION,
    });
    await writeFile(join(SEARCH_DIR, `${cityId}.bin.gz`), gzipped);
    const megabytes = (value: number) => (value / 1e6).toFixed(2);
    for (const pair of dropped.slice(0, LOGGED_DUPLICATES)) {
      console.error(`search-index: ${cityId}: dropped ${pair}`);
    }
    console.error(
      `search-index: ${cityId}: ${encoded.docCount} docs ` +
        `(${summary.places} places, ${summary.streets} streets, ` +
        `${summary.graphStreets} the graph names and ADDR does not, ` +
        `${summary.points} curated points, ${summary.duplicates} dropped as duplicates, ` +
        `${summary.joined} at an address), ` +
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
