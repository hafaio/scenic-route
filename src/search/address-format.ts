// ADDR: every street address in a city, small enough to ship.
//
// The geocoder answers "123 Broadway" and the routing graph's names answer "Broadway", so the gap
// offline is exactly the house number. Both cities publish their own address file — NYC AddressPoint
// (uf93-f8nk) and SF EAS (ramy-di5m) — and at ~3 bytes an address the whole of both fits in a few
// megabytes, which is cheaper than one zoom level of any tile pyramid.
//
// Written by scripts/addresses.ts to public/addresses/<city>.bin.gz, read by src/search/addresses.ts.
// Shipped gzipped and decompressed in the browser rather than served raw: Pages does not compress
// .bin, and the file is half the size this way both in the repo and against the Pages size cap.
//
// Layout, all integers LEB128 varints unless stated:
//
//   "ADDR"                      magic, 4 bytes
//   format                      1 byte
//   nameBytes                   length of the name blob
//   <names>                     street names, "\n"-joined, UTF-8, ascending
//   placeBytes                  length of the place blob
//   <places>                    the places a street can be in, "\n"-joined; empty for a city that is
//                               one place, and then every street's placeIndex is 0
//   streetCount
//   per street, ordered by (name, place):
//     nameIndex                 into <names>
//     placeIndex                into <places>
//     count                     addresses on the street
//     per address, ascending by house number:
//       number                  (zigzag(majorDelta) << 1) | hasExtra
//       extra                   only when hasExtra: minor * 32 + suffix
//       latDelta                zigzag, units of 1e-5 degrees
//       lngDelta                zigzag
//
// The deltas run within a street and reset at each one, so a street is decodable without touching
// any other. That is why the body is grouped this way rather than sorted globally: a query names a
// street first, and only that street's few hundred addresses are ever decoded.
//
// A street is a NAME AND A PLACE, not a name. New York does not qualify its street names and has
// five Court Streets, one of them in Staten Island and one in Brooklyn; merged into a single run,
// "312 Court St" resolves to whichever the sort happened to put first and shows no sign that it
// chose. Splitting by place makes the answer either right or visibly plural, and costs almost
// nothing — each run is now geographically tight, so the coordinate deltas get SMALLER. San
// Francisco is one place and leaves the blob empty.
//
// A house number is three parts because two cities disagree about what one is. `major` is the number
// everyone has. `minor` is Queens' hyphen ("12-34" is house 34 on block 12, and sorts by both).
// `suffix` is San Francisco's trailing letter ("269B"), 1-26 for A-Z. Both are zero for most
// addresses in both cities, so they cost one bit each rather than a field: only the addresses that
// have one pay the extra byte.

export const ADDRESS_MAGIC = "ADDR";
export const ADDRESS_FORMAT = 1;

// Coordinates are hundred-thousandths of a degree: 1.1 m north-south, 0.85 m across at these
// latitudes. A pin lands on the right building, and a finer grid would spend a byte an address
// recording noise the source does not have.
export const COORD_SCALE = 1e5;

// How a minor number and a letter suffix share the one extra varint.
export const MINOR_SCALE = 32;

export interface HouseNumber {
  major: number;
  minor: number; // 0 where the address has no hyphen
  suffix: number; // 0 none, 1-26 for A-Z
}

// The number as it is written down, which is what a search result has to show: "12-34", "269B", "7".
export function formatHouseNumber({
  major,
  minor,
  suffix,
}: HouseNumber): string {
  const digits = minor > 0 ? `${major}-${minor}` : String(major);
  return suffix > 0 ? `${digits}${String.fromCharCode(64 + suffix)}` : digits;
}

// The reverse, for the builders and for parsing what was typed into the search box. Null where the
// text is not a house number at all.
export function parseHouseNumber(text: string): HouseNumber | null {
  const match = /^([0-9]{1,7})(?:\s*-\s*([0-9]{1,4}))?\s*([A-Za-z])?$/.exec(
    text.trim(),
  );
  if (match === null) {
    return null;
  } else {
    return {
      major: Number(match[1]),
      minor: match[2] === undefined ? 0 : Number(match[2]),
      suffix:
        match[3] === undefined ? 0 : match[3].toUpperCase().charCodeAt(0) - 64,
    };
  }
}

// Addresses are ordered by all three parts, but only `major` is delta-encoded — the other two ride
// in the extra byte, so 12-34 and 12-36 differ by a byte rather than by a large key delta.
export function compareHouseNumbers(
  left: HouseNumber,
  right: HouseNumber,
): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.suffix - right.suffix
  );
}

export function packExtra({ minor, suffix }: HouseNumber): number {
  return minor * MINOR_SCALE + suffix;
}

export function unpackExtra(extra: number): { minor: number; suffix: number } {
  return {
    minor: Math.floor(extra / MINOR_SCALE),
    suffix: extra % MINOR_SCALE,
  };
}

// New York's five boroughs, by the `boroughcode` its address file writes. The names are the ones a
// reader would say and a postal address would carry, which is what a search result has to show.
export const NYC_BOROUGHS: Readonly<Record<string, string>> = {
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island",
};
