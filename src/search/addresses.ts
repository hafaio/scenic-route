// The city's own address file (ADDR, ./address-format.ts), read: the street table, and one street's
// run of house numbers decoded on demand.
//
// "123 Broadway" answered from data that already shipped, with no network at all. WHICH street a
// query names is the search index's job (./search-query.ts): a street is a document there, so a
// house number is a name match followed by the one run decode below.
//
// Only the streets a query names are ever decoded. New York is ~6 MB of address runs; turning all of
// them into objects or typed arrays up front would cost several times the file itself, for streets
// nobody will type.

import { prettifyStreetName } from "../routing/street-names";
import {
  type Cursor,
  readUnsignedVarint,
  readVarint,
  unzigzag,
} from "../tiles/varint";
import {
  ADDRESS_FORMAT,
  ADDRESS_MAGIC,
  COORD_SCALE,
  compareHouseNumbers,
  type HouseNumber,
  parseHouseNumber,
  unpackExtra,
} from "./address-format";

export interface Address {
  number: HouseNumber;
  lat: number;
  lng: number;
}

// The corners of what a street covers, in the same hundred-thousandths of a degree the addresses are
// delta-encoded in. A street with no addresses at all reports the origin, which is an ocean away from
// either city and so never a candidate for anything.
export interface StreetBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// The file as it is held for the session: the decompressed bytes, the two string blobs, and per
// street its name, its place and where its run of addresses begins. The last entry of `starts` is
// the end of the last run.
//
// A street is a name AND a place, so several entries share one name — New York has five Court
// Streets. Matching is on the name alone and the place only labels the answer, which is what makes
// "312 Court St" five streets to look in rather than one to guess between.
export interface AddressIndex {
  names: string[]; // prettified, which is what the search box shows
  sourceNames: string[]; // as the city publishes them, which is also how "5 Av" gets typed
  places: string[]; // empty for a city that is one place, and then no street carries one
  streetName: Uint32Array;
  streetPlace: Uint32Array;
  starts: Uint32Array;
  // Per street, the box its addresses fall in. Free to record — the load pass already steps over
  // every address to find where the next street starts — and it is what lets a point be turned back
  // into an address without decoding the whole file: a street whose box is 300 m away has no address
  // nearer than that, so its run is never read. Four bytes a street: 150 KB in New York.
  minLatUnits: Int32Array;
  maxLatUnits: Int32Array;
  minLngUnits: Int32Array;
  maxLngUnits: Int32Array;
  bytes: Uint8Array;
}

// Walk one street's run. The addresses are collected when the caller wants them and only stepped
// over when it does not, which is what the load pass does for every street in the file.
function readRun(
  bytes: Uint8Array,
  cursor: Cursor,
  into: Address[] | null,
): StreetBounds {
  const count = readUnsignedVarint(bytes, cursor);
  let major = 0;
  let latUnits = 0;
  let lngUnits = 0;
  const bounds: StreetBounds = { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  for (let index = 0; index < count; index += 1) {
    const packed = readUnsignedVarint(bytes, cursor);
    // The low bit says a minor number or a letter suffix rides in the next varint.
    const extra = packed % 2 === 1 ? readUnsignedVarint(bytes, cursor) : 0;
    major += unzigzag(Math.floor(packed / 2));
    latUnits += readVarint(bytes, cursor);
    lngUnits += readVarint(bytes, cursor);
    if (index === 0) {
      bounds.minLat = latUnits;
      bounds.maxLat = latUnits;
      bounds.minLng = lngUnits;
      bounds.maxLng = lngUnits;
    } else {
      bounds.minLat = Math.min(bounds.minLat, latUnits);
      bounds.maxLat = Math.max(bounds.maxLat, latUnits);
      bounds.minLng = Math.min(bounds.minLng, lngUnits);
      bounds.maxLng = Math.max(bounds.maxLng, lngUnits);
    }
    into?.push({
      number: { major, ...unpackExtra(extra) },
      lat: latUnits / COORD_SCALE,
      lng: lngUnits / COORD_SCALE,
    });
  }
  return bounds;
}

// One "\n"-joined blob. Empty is no entries at all rather than one empty string, which is what a
// city that is a single place writes for its places.
function readBlob(bytes: Uint8Array, cursor: Cursor): string[] {
  const length = readUnsignedVarint(bytes, cursor);
  const text = new TextDecoder().decode(
    bytes.subarray(cursor.offset, cursor.offset + length),
  );
  cursor.offset += length;
  return text === "" ? [] : text.split("\n");
}

export function decodeAddresses(bytes: Uint8Array): AddressIndex {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== ADDRESS_MAGIC || bytes[4] !== ADDRESS_FORMAT) {
    throw new Error(`not a v${ADDRESS_FORMAT} address file`);
  }
  const cursor: Cursor = { offset: ADDRESS_MAGIC.length + 1 };
  const sourceNames = readBlob(bytes, cursor);
  const names = sourceNames.map(prettifyStreetName);
  const places = readBlob(bytes, cursor);
  const streetCount = readUnsignedVarint(bytes, cursor);
  const streetName = new Uint32Array(streetCount);
  const streetPlace = new Uint32Array(streetCount);
  const starts = new Uint32Array(streetCount + 1);
  const minLatUnits = new Int32Array(streetCount);
  const maxLatUnits = new Int32Array(streetCount);
  const minLngUnits = new Int32Array(streetCount);
  const maxLngUnits = new Int32Array(streetCount);
  for (let street = 0; street < streetCount; street += 1) {
    streetName[street] = readUnsignedVarint(bytes, cursor);
    streetPlace[street] = readUnsignedVarint(bytes, cursor);
    starts[street] = cursor.offset;
    const bounds = readRun(bytes, cursor, null);
    minLatUnits[street] = bounds.minLat;
    maxLatUnits[street] = bounds.maxLat;
    minLngUnits[street] = bounds.minLng;
    maxLngUnits[street] = bounds.maxLng;
  }
  starts[streetCount] = cursor.offset;
  return {
    names,
    sourceNames,
    places,
    streetName,
    streetPlace,
    starts,
    minLatUnits,
    maxLatUnits,
    minLngUnits,
    maxLngUnits,
    bytes,
  };
}

export function streetAddresses(
  index: AddressIndex,
  street: number,
): Address[] {
  const addresses: Address[] = [];
  readRun(index.bytes, { offset: index.starts[street] }, addresses);
  return addresses;
}

export interface AddressQuery {
  number: HouseNumber;
  street: string;
}

// A query is an address when it opens with a house number and names a street after it. The number
// has to be one unbroken token — "123", "12-34", "269B" — because a space before the letter is how
// "269 B Street" is written, and reading that as house 269B on "Street" is a different place.
const ADDRESS_QUERY = /^([0-9]{1,7}(?:-[0-9]{1,4})?[A-Za-z]?)\s+(.+)$/;

export function parseAddressQuery(query: string): AddressQuery | null {
  const match = ADDRESS_QUERY.exec(query.trim());
  if (match === null) {
    return null;
  }
  const number = parseHouseNumber(match[1]);
  return number === null ? null : { number, street: match[2].trim() };
}

// How far apart two house numbers are, for choosing between the pair a missing number sits between.
// Queens' block number dominates: 12-34 and 12-36 are neighbours, 12-34 and 13-02 are not.
const BLOCK_SPAN = 10000;

function numberKey({ major, minor }: HouseNumber): number {
  return major * BLOCK_SPAN + minor;
}

function numberDistance(left: HouseNumber, right: HouseNumber): number {
  return Math.abs(numberKey(left) - numberKey(right));
}

// The address answering a number: the one written down, or the nearer of the two it falls between.
// A number past either end of the street is not answered at all — 9999 Broadway is not at the top of
// Broadway, and a pin there is a confident wrong answer where none is simply a missing one.
export function findNumber(
  addresses: readonly Address[],
  wanted: HouseNumber,
): { address: Address; exact: boolean } | null {
  let below: Address | null = null;
  let above: Address | null = null;
  for (const address of addresses) {
    const order = compareHouseNumbers(address.number, wanted);
    if (order === 0) {
      return { address, exact: true };
    } else if (order < 0) {
      below = address;
    } else {
      // The run ascends, so the first address past the number is the one above it.
      above = address;
      break;
    }
  }
  if (below === null || above === null) {
    return null;
  } else {
    const nearer =
      numberDistance(below.number, wanted) <=
      numberDistance(above.number, wanted)
        ? below
        : above;
    return { address: nearer, exact: false };
  }
}

// The file, fetched and decoded. Named absolutely because the only thing that fetches it is the
// search worker, and a relative URL inside a worker resolves against the worker's own chunk rather
// than against the document.
export async function fetchAddresses(url: string): Promise<AddressIndex> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  // Shipped gzipped and unpacked here: Pages does not compress .bin, so the alternative is twice the
  // bytes over the wire, twice the cache and twice the repo.
  const unpacked = response.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = await new Response(unpacked).arrayBuffer();
  return decodeAddresses(new Uint8Array(bytes));
}
