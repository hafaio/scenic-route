// House-number search, answered from the city's own address file (ADDR, ./address-format.ts).
//
// The street index off the routing graph answers "Broadway" and stops there; the geocoder answers
// "123 Broadway" and needs a network to do it. This is that same question answered from data that
// already shipped — and answered better even with signal, because Photon's reply to a house number
// on a long street is regularly a point at the wrong end of it.
//
// The file is fetched the first time someone types something that could be an address, and only the
// streets a query names are ever decoded. New York is ~6 MB of address runs; turning all of them
// into objects or typed arrays up front would cost several times the file itself, for streets nobody
// will type.

import { prettifyStreetName } from "../routing/street-names";
import { rankStreetName } from "../routing/street-search";
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
  formatHouseNumber,
  type HouseNumber,
  parseHouseNumber,
  unpackExtra,
} from "./address-format";

export interface Address {
  number: HouseNumber;
  lat: number;
  lng: number;
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
  bytes: Uint8Array;
}

// Where a house number puts a pin, and what it is called there.
export interface AddressPlace {
  name: string;
  lat: number;
  lng: number;
}

// Where the reader is, when they have shared it (SearchBias in src/geocode.ts). Declared here rather
// than imported, since the geocoder imports this module and not the other way about.
export interface AddressBias {
  lat: number;
  lng: number;
}

export interface AddressHit {
  place: AddressPlace;
  rank: number; // 2 the street name starts with what was typed, 1 a word inside it does
  exact: boolean; // false is the nearest address to a number the street does not have
}

// Walk one street's run. The addresses are collected when the caller wants them and only stepped
// over when it does not, which is what the load pass does for every street in the file.
function readRun(
  bytes: Uint8Array,
  cursor: Cursor,
  into: Address[] | null,
): void {
  const count = readUnsignedVarint(bytes, cursor);
  let major = 0;
  let latUnits = 0;
  let lngUnits = 0;
  for (let index = 0; index < count; index += 1) {
    const packed = readUnsignedVarint(bytes, cursor);
    // The low bit says a minor number or a letter suffix rides in the next varint.
    const extra = packed % 2 === 1 ? readUnsignedVarint(bytes, cursor) : 0;
    major += unzigzag(Math.floor(packed / 2));
    latUnits += readVarint(bytes, cursor);
    lngUnits += readVarint(bytes, cursor);
    into?.push({
      number: { major, ...unpackExtra(extra) },
      lat: latUnits / COORD_SCALE,
      lng: lngUnits / COORD_SCALE,
    });
  }
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
  for (let street = 0; street < streetCount; street += 1) {
    streetName[street] = readUnsignedVarint(bytes, cursor);
    streetPlace[street] = readUnsignedVarint(bytes, cursor);
    starts[street] = cursor.offset;
    readRun(bytes, cursor, null);
  }
  starts[streetCount] = cursor.offset;
  return {
    names,
    sourceNames,
    places,
    streetName,
    streetPlace,
    starts,
    bytes,
  };
}

// What a street is called in the list. New York's names do not say which borough they are in, so the
// place is what tells three Court Streets apart; a city that is one place has none and reads without.
function streetLabel(index: AddressIndex, street: number): string {
  const name = index.names[index.streetName[street]];
  const place = index.places[index.streetPlace[street]];
  return place === undefined ? name : `${name}, ${place}`;
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

// One letter of street name matches half a city, exactly as in the street search.
const MIN_STREET_QUERY = 2;
// How many streets one query may decode. "100 av" names every Avenue in Brooklyn, and each of those
// names is now several streets rather than one; a run is cheap to walk but there is no reason to
// walk hundreds of them for a list that shows a handful.
const MAX_SCANNED_STREETS = 24;
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
function findNumber(
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

// How far a hit is from where the reader is. Squared and in degrees with the longitude narrowed for
// the latitude: this only ever orders hits against each other, so metres would be a conversion
// nobody reads.
function biasDistance(place: AddressPlace, bias: AddressBias): number {
  const north = place.lat - bias.lat;
  const east = (place.lng - bias.lng) * Math.cos((bias.lat * Math.PI) / 180);
  return north * north + east * east;
}

// A place named at the end of the street text, and what is left of the text without it. New York's
// unqualified names are exactly what makes "312 Court St Brooklyn" a natural thing to type, and the
// reader who already knows which of the five they want should not have to pick it out of a list. The
// longest place wins, so a city with both "Island" and "Staten Island" strips the one that was meant.
function splitPlace(
  index: AddressIndex,
  street: string,
): { street: string; place: number | null } {
  const lowered = street.toLowerCase();
  let best = { street, place: null as number | null, length: 0 };
  for (let place = 0; place < index.places.length; place += 1) {
    const name = index.places[place];
    const at = lowered.length - name.length;
    // On a word boundary, or a city with an "Island" would read "Court St Islander" as one.
    if (
      at <= 0 ||
      !lowered.endsWith(name.toLowerCase()) ||
      !/[\s,]/.test(lowered[at - 1])
    ) {
      continue;
    }
    const rest = street.slice(0, at).replace(/[\s,]+$/, "");
    // "Brooklyn" on its own is a place, not a street in one: what is left still has to name a street.
    if (rest.length >= MIN_STREET_QUERY && name.length > best.length) {
      best = { street: rest, place, length: name.length };
    }
  }
  return { street: best.street, place: best.place };
}

export function matchAddresses(
  index: AddressIndex,
  query: string,
  limit: number,
  bias?: AddressBias | null,
): AddressHit[] {
  const parsed = parseAddressQuery(query);
  if (parsed === null || parsed.street.length < MIN_STREET_QUERY) {
    return [];
  }
  const wanted = splitPlace(index, parsed.street);
  const needle = wanted.street.toLowerCase();
  const candidates: { street: number; rank: number }[] = [];
  for (let street = 0; street < index.starts.length - 1; street += 1) {
    // A place the query named is a requirement, not a preference: someone who typed Brooklyn has
    // said which Court Street they mean, and the other four are no longer answers.
    if (wanted.place !== null && index.streetPlace[street] !== wanted.place) {
      continue;
    }
    // The name alone otherwise, in both its spellings — "350 5 Av" has to reach 5 AVE. The place is
    // what the answer is labelled with, not part of the name: most readers do not type a borough,
    // and requiring one would undo the point of this.
    const nameId = index.streetName[street];
    const rank = rankStreetName(
      index.names[nameId],
      index.sourceNames[nameId],
      needle,
    );
    if (rank > 0) {
      candidates.push({ street, rank });
    }
  }
  // Stable, so streets of equal rank keep the file's own (name, place) order.
  candidates.sort((left, right) => right.rank - left.rank);
  const hits: AddressHit[] = [];
  for (const { street, rank } of candidates.slice(0, MAX_SCANNED_STREETS)) {
    const found = findNumber(streetAddresses(index, street), parsed.number);
    if (found) {
      hits.push({
        place: {
          // The number the FILE has, never the one that was typed. A pin labelled 121 when the file
          // knows only 119 and 123 is a wrong answer wearing a right one's clothes.
          name: `${formatHouseNumber(found.address.number)} ${streetLabel(index, street)}`,
          lat: found.address.lat,
          lng: found.address.lng,
        },
        rank,
        exact: found.exact,
      });
    }
  }
  // Several streets of one name all having the number is a PLURAL answer, and every one of them is
  // kept: the reader is the only one who knows which borough they meant, and a labelled list of
  // three is honest where a silent pick is not. Where they stand in it is the one thing that can be
  // guessed at, so a shared location orders them and nothing else re-orders what the file already
  // ordered by name and place.
  hits.sort(
    (left, right) =>
      Number(right.exact) - Number(left.exact) ||
      right.rank - left.rank ||
      (bias
        ? biasDistance(left.place, bias) - biasDistance(right.place, bias)
        : 0),
  );
  return hits.slice(0, limit);
}

// One fetch per city, held for the session. A failed one is dropped rather than remembered, so a
// device with no signal when the first address was typed still gets the file once it has one.
const files = new Map<string, Promise<AddressIndex>>();

// One file, fetched and decoded. Named separately from the per-city cache below because the search
// worker holds its own copy of the same file and has to name it absolutely — a relative URL inside a
// worker resolves against the worker's own chunk rather than against the document.
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

export function loadAddresses(cityId: string): Promise<AddressIndex> {
  const pending = files.get(cityId);
  if (pending) {
    return pending;
  } else {
    // Relative, so it picks up the basePath the deploy injects.
    const request = fetchAddresses(`addresses/${cityId}.bin.gz`).catch(
      (error: unknown) => {
        files.delete(cityId);
        throw error;
      },
    );
    files.set(cityId, request);
    return request;
  }
}

// The hits, or null where the query was address-shaped and the file could not be read. Null rather
// than an empty list because the caller caches complete answers: "no address by that name" and "this
// device has never managed to fetch the addresses" have to be told apart, or the second gets
// remembered as the first and the query stays address-less for the rest of the session.
export async function searchAddresses(
  cityId: string,
  query: string,
  limit: number,
  bias?: AddressBias | null,
): Promise<AddressHit[] | null> {
  if (parseAddressQuery(query) === null) {
    return []; // nothing that could be a house number, so nothing worth fetching a file for
  }
  // A file this device could not fetch is a search with no addresses in it rather than a failed
  // search: the geocoder, the stations and the street names all still have their own answers. Null
  // rather than an empty list is what tells the caller apart from a search that found nothing.
  const index = await loadAddresses(cityId).catch(() => null);
  // A location the reader has actually shared beats where the map happens to be pointing; the map's
  // centre is what stands in for it when they have not, and the file's own order when there is
  // neither.
  const near = bias ?? searchCentre(cityId);
  return index === null ? null : matchAddresses(index, query, limit, near);
}

// Where the map is, for the search box — which runs long before anything asks for a route and cannot
// take the camera as a prop. Set from the map's settled camera, and kept WITH the city it belongs
// to: a centre in Brooklyn says nothing about which of San Francisco's streets was meant, so after a
// switch it is ignored until the map settles over the new city. Null until then, which is simply a
// search with nothing to rank plural answers by.
let mapCentre: { cityId: string; at: AddressBias } | null = null;

export function setSearchCentre(cityId: string, at: AddressBias): void {
  mapCentre = { cityId, at };
}

// Where the map is pointing, for a search over this city — null until it has settled over one. Read
// by the name index too, which ranks every result by how far it is from here.
export function searchCentre(cityId: string): AddressBias | null {
  return mapCentre !== null && mapCentre.cityId === cityId
    ? mapCentre.at
    : null;
}

// Fetches a city's addresses before anything asks for them, so the file is on the device while there
// is still signal to fetch it with. Offline search that only works for addresses you happened to
// look up while online is most of the way to no offline search at all. Failure is silent — this is a
// warm-up, and every path that needs the file already handles not having it.
export function warmAddresses(cityId: string): void {
  loadAddresses(cityId).catch(() => undefined);
}
