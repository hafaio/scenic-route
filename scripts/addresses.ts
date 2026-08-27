// `bun run update-addresses`: every street address in both cities, as the ADDR artifact the offline
// search box geocodes against.
//
// The routing graph already carries street names, so the only part of "312 Court St" that is not
// already on the device is the house number. Each city publishes its own address file — NYC
// AddressPoint (uf93-f8nk) and SF EAS (ramy-di5m) — and both are read here through their CSV export,
// which answers the whole dataset in one request where the JSON API would page it.
//
// A street here is a name AND a place: New York does not qualify its street names and has five Court
// Streets, so the borough rides with the name and the search box can say which one it found.
//
// Written to public/addresses/<city>.bin.gz and committed, like the ferry timetable: no deploy step
// rebuilds it, and at ~3 bytes an address both cities together are smaller than one zoom level of
// any pyramid. Gzipped on disk because Pages serves .bin uncompressed; the client inflates it with
// DecompressionStream.
//
// Layout: src/search/address-format.ts, and scripts/README.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants, gzipSync } from "node:zlib";
import {
  ADDRESS_FORMAT,
  ADDRESS_MAGIC,
  COORD_SCALE,
  compareHouseNumbers,
  type HouseNumber,
  NYC_BOROUGHS,
  packExtra,
  parseHouseNumber,
} from "../src/search/address-format";
import { cachedFile } from "./cache";
import { writeVarint, zigzag } from "./geometry";
import { parseWktPoint } from "./socrata";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const ADDRESS_DIR = join(PUBLIC_DIR, "addresses");

// What the write buffer is sized against: no value here needs more than five varint bytes, and an
// address is four of them — number, extra, latitude, longitude.
const MAX_VARINT_BYTES = 5;
const MAX_ADDRESS_BYTES = 4 * MAX_VARINT_BYTES;
const REQUEST_TIMEOUT_MS = 300_000;

export interface AddressRow {
  street: string; // as the source writes it, upper case; the client prettifies
  place: string; // the borough or town the street is in; "" for a city that is one place
  number: HouseNumber;
  lat: number;
  lng: number;
}

// One address at the grid the artifact stores it on. Quantizing before the sort is what makes two
// rows for the same doorway identical rather than merely close.
interface Placed {
  number: HouseNumber;
  latUnits: number;
  lngUnits: number;
}

// One run of the body: the addresses of one name in one place. New York has five Court Streets, and
// they are five of these.
interface Street {
  name: string;
  place: string;
  addresses: Placed[];
}

export interface EncodedAddresses {
  bytes: Uint8Array;
  names: number; // distinct street names
  streets: number; // (name, place) pairs, which is what the body holds
  addresses: number; // after the dedupe, so this is what is in the file
}

// Joins a street's name and place into a map key. NUL because a street name may contain any
// printable character — spaces, digits, apostrophes, "W  239 ST" — but never this one.
const KEY_SEPARATOR = "\u0000";

// Ascending by code unit: the order the two blobs are written in, and so the order a client that
// binary-searches them has to use.
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  } else {
    return left < right ? -1 : 1;
  }
}

function samePlace(left: Placed, right: Placed | undefined): boolean {
  return (
    right !== undefined &&
    compareHouseNumbers(left.number, right.number) === 0 &&
    left.latUnits === right.latUnits &&
    left.lngUnits === right.lngUnits
  );
}

// Groups the rows by (name, place), orders every level and writes the ADDR body. Pure, so the
// artifact is a function of the rows and a test can build a handful by hand and read them back.
export function encodeAddresses(rows: readonly AddressRow[]): EncodedAddresses {
  const byStreet = new Map<string, Street>();
  for (const { street, place, number, lat, lng } of rows) {
    const placed = {
      number,
      latUnits: Math.round(lat * COORD_SCALE),
      lngUnits: Math.round(lng * COORD_SCALE),
    };
    const key = [street, place].join(KEY_SEPARATOR);
    const existing = byStreet.get(key);
    if (existing === undefined) {
      byStreet.set(key, { name: street, place, addresses: [placed] });
    } else {
      existing.addresses.push(placed);
    }
  }

  const streets = [...byStreet.values()].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.place, right.place),
  );
  for (const street of streets) {
    street.addresses.sort(
      (left, right) =>
        compareHouseNumbers(left.number, right.number) ||
        left.latUnits - right.latUnits ||
        left.lngUnits - right.lngUnits,
    );
    // San Francisco's file is per unit, so a six-flat is six rows of one address; New York's has its
    // own repeats. Identical rows are adjacent once sorted, which is all the dedupe needs.
    street.addresses = street.addresses.filter(
      (address, index) => !samePlace(address, street.addresses[index - 1]),
    );
  }
  const addresses = streets.reduce(
    (sum, street) => sum + street.addresses.length,
    0,
  );

  const names = [...new Set(streets.map((street) => street.name))].sort();
  const nameIndex = new Map(names.map((name, index) => [name, index]));
  // A city that is one place has the single place "", whose blob is zero bytes and whose index is 0
  // — which is what the format asks for, without a case for it here.
  const places = [...new Set(streets.map((street) => street.place))].sort();
  const placeIndex = new Map(places.map((place, index) => [place, index]));

  const encoder = new TextEncoder();
  const nameBlob = encoder.encode(names.join("\n"));
  const placeBlob = encoder.encode(places.join("\n"));
  const bytes = new Uint8Array(
    ADDRESS_MAGIC.length +
      1 +
      3 * MAX_VARINT_BYTES +
      nameBlob.length +
      placeBlob.length +
      streets.length * 3 * MAX_VARINT_BYTES +
      addresses * MAX_ADDRESS_BYTES,
  );

  let offset = 0;
  for (const character of ADDRESS_MAGIC) {
    bytes[offset] = character.charCodeAt(0);
    offset += 1;
  }
  bytes[offset] = ADDRESS_FORMAT;
  offset += 1;
  for (const blob of [nameBlob, placeBlob]) {
    offset = writeVarint(bytes, offset, blob.length);
    bytes.set(blob, offset);
    offset += blob.length;
  }
  offset = writeVarint(bytes, offset, streets.length);

  for (const street of streets) {
    offset = writeVarint(bytes, offset, nameIndex.get(street.name) ?? 0);
    offset = writeVarint(bytes, offset, placeIndex.get(street.place) ?? 0);
    offset = writeVarint(bytes, offset, street.addresses.length);
    let previousMajor = 0;
    let previousLat = 0;
    let previousLng = 0;
    for (const { number, latUnits, lngUnits } of street.addresses) {
      const extra = packExtra(number);
      offset = writeVarint(
        bytes,
        offset,
        zigzag(number.major - previousMajor) * 2 + (extra === 0 ? 0 : 1),
      );
      if (extra !== 0) {
        offset = writeVarint(bytes, offset, extra);
      }
      offset = writeVarint(bytes, offset, zigzag(latUnits - previousLat));
      offset = writeVarint(bytes, offset, zigzag(lngUnits - previousLng));
      previousMajor = number.major;
      previousLat = latUnits;
      previousLng = lngUnits;
    }
  }

  return {
    bytes: bytes.subarray(0, offset),
    names: names.length,
    streets: streets.length,
    addresses,
  };
}

// RFC 4180 with the header row read as column names: the export quotes every field, and a street
// name is free to contain a comma. Yielded a record at a time rather than collected, because the
// text these walk is already tens of megabytes.
function* csvRecords(
  text: string,
  columns: readonly string[],
): Generator<string[]> {
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let indices: number[] | null = null;

  const endRecord = (): string[] | null => {
    record.push(field);
    field = "";
    const finished = record;
    record = [];
    if (finished.length === 1 && finished[0] === "") {
      return null;
    } else if (indices === null) {
      indices = columns.map((column) => {
        const index = finished.indexOf(column);
        if (index < 0) {
          throw new Error(`the export has no ${column} column`);
        }
        return index;
      });
      return null;
    } else {
      return indices.map((index) => finished[index] ?? "");
    }
  };

  for (let cursor = 0; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[cursor + 1] === '"') {
        field += '"';
        cursor += 1;
      } else {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[cursor + 1] === "\n") {
        cursor += 1;
      }
      const fields = endRecord();
      if (fields !== null) {
        yield fields;
      }
    } else {
      field += character;
    }
  }
  if (record.length > 0 || field !== "") {
    const fields = endRecord();
    if (fields !== null) {
      yield fields;
    }
  }
}

// One city's address file: where it is, what it is called, and how one of its rows becomes an
// address. `read` answers null for a row the artifact cannot carry, which the caller counts.
interface Source {
  id: string;
  name: string;
  url: string;
  limit: number;
  columns: readonly string[];
  read(fields: string[]): AddressRow | null;
}

// A latitude or longitude column. Null rather than 0 where it is blank: an address at the origin is
// a thousand kilometres off the coast of Africa, not a missing coordinate.
function coordinate(text: string): number | null {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) {
    return null;
  } else {
    return value;
  }
}

const NYC_LIMIT = 1_200_000;
const SF_LIMIT = 500_000;

const SOURCES: readonly Source[] = [
  {
    id: "nyc",
    name: "NYC AddressPoint",
    url:
      "https://data.cityofnewyork.us/resource/uf93-f8nk.csv?$select=house_number," +
      `full_street_name,boroughcode,the_geom&$limit=${NYC_LIMIT}`,
    limit: NYC_LIMIT,
    columns: ["house_number", "full_street_name", "boroughcode", "the_geom"],
    // `house_number` is written the way the borough writes it: plain in four boroughs, hyphenated in
    // Queens, where "25-07" is house 7 on block 25. The 191 rows this rejects are all a third shape
    // — a letter inside the hyphen, "2701-B8", the buildings of a complex — which the format's
    // numeric minor part cannot hold. `boroughcode` is "1" to "5" on every row today; one that is
    // not is rejected rather than filed under a street of no place.
    read([houseNumber, street, boroughCode, geometry]) {
      const number = parseHouseNumber(houseNumber);
      const point = parseWktPoint(geometry);
      const borough = boroughCode.trim();
      const place = Object.hasOwn(NYC_BOROUGHS, borough)
        ? NYC_BOROUGHS[borough]
        : null;
      if (
        number === null ||
        point === null ||
        place === null ||
        street.trim() === ""
      ) {
        return null;
      } else {
        return { street: street.trim(), place, number, ...point };
      }
    },
  },
  {
    id: "sf",
    name: "SF EAS",
    url:
      "https://data.sfgov.org/resource/ramy-di5m.csv?$select=address_number," +
      `address_number_suffix,street_full_street_name,latitude,longitude&$limit=${SF_LIMIT}`,
    limit: SF_LIMIT,
    columns: [
      "address_number",
      "address_number_suffix",
      "street_full_street_name",
      "latitude",
      "longitude",
    ],
    // The suffix is its own column here, and the number as written is the two run together: "269"
    // plus "B" is 269B. Every row this rejects — 24 of them — is a half address, whose suffix is "½"
    // rather than a letter.
    read([addressNumber, suffix, street, latitude, longitude]) {
      const number = parseHouseNumber(
        `${addressNumber.trim()}${suffix.trim()}`,
      );
      const lat = coordinate(latitude);
      const lng = coordinate(longitude);
      if (
        number === null ||
        lat === null ||
        lng === null ||
        street.trim() === ""
      ) {
        return null;
      } else {
        // San Francisco is one place, so the place blob stays empty and the client shows nothing
        // beside the street name.
        return { street: street.trim(), place: "", number, lat, lng };
      }
    },
  },
];

async function fetchCsv(source: Source): Promise<string> {
  const path = await cachedFile(
    `addresses.${source.id}`,
    source.url,
    async () => {
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  );
  return await readFile(path, "utf-8");
}

interface Collected {
  rows: AddressRow[];
  unparsed: number;
}

// Every row of one city's export, those that cannot be read counted rather than dropped quietly.
async function collect(source: Source): Promise<Collected> {
  const text = await fetchCsv(source);
  const rows: AddressRow[] = [];
  let total = 0;
  for (const fields of csvRecords(text, source.columns)) {
    total += 1;
    const row = source.read(fields);
    if (row !== null) {
      rows.push(row);
    }
  }
  if (total >= source.limit) {
    // The export is one request, so a dataset that grew past the limit would come back cut off at it
    // and look complete.
    throw new Error(
      `${source.name} returned ${total} rows, its whole $limit: raise it, the export was truncated`,
    );
  }
  return { rows, unparsed: total - rows.length };
}

export async function updateAddresses(): Promise<void> {
  await mkdir(ADDRESS_DIR, { recursive: true });
  for (const source of SOURCES) {
    console.error(`addresses: fetching ${source.name}`);
    const { rows, unparsed } = await collect(source);
    const { bytes, names, streets, addresses } = encodeAddresses(rows);
    const gzipped = gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
    await writeFile(join(ADDRESS_DIR, `${source.id}.bin.gz`), gzipped);
    console.error(
      `addresses: ${source.id}: ${names} names in ${streets} streets, ` +
        `${addresses} addresses, ${unparsed} unparsed, ${bytes.length} bytes raw, ` +
        `${gzipped.length} gzipped (${(gzipped.length / addresses).toFixed(2)} B/address)`,
    );
  }
}

if (import.meta.main) {
  await updateAddresses();
}
