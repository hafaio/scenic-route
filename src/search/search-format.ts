// SRCH: every name in a city, indexed for a search box that has no network.
//
// The geocoder answers "Joe's Pizza" and needs a round trip to do it, and the three searches that
// already ship offline — street names off the routing graph, stations, house numbers out of ADDR —
// each scan their own list with their own ranking. This is one index over all of it: a sorted token
// dictionary, a posting list per token, and a document table of names and coordinates.
//
// ADDRESSES ARE NOT IN IT, and that is the whole reason it is small. Tokenizing New York's 967,230
// addresses would put `street` and `avenue` into a million documents each, and every way of coping
// with a posting list that size — stop words, caps, tiered lists — degrades exactly the queries
// addresses exist to answer. Instead a STREET is one document (9,387 of them in New York, one per
// ADDR (name, place) pair) carrying its ADDR street ordinal, and a house number is resolved after
// the match by decoding that one street's run, which is what src/search/addresses.ts already does.
// With addresses out, no posting list in New York exceeds ~14k entries, so nothing in the query path
// needs a cap.
//
// Written by scripts/search-index.ts to public/search/<city>.bin.gz, read by
// src/search/search-query.ts. Gzipped for the same two reasons ADDR is: Pages serves .bin
// uncompressed, and the file is half the size this way both in the repo and against the Pages cap.
//
// Layout, all integers LEB128 varints unless stated:
//
//   "SRCH"                      magic, 4 bytes
//   format                      1 byte
//   categoryBytes               length of the category blob
//   <categories>                Overture category slugs, "\n"-joined, UTF-8; the client maps these
//                               to glyphs
//   docCount
//   per doc, in Hilbert order over its quantized coordinates:
//     nameLen                   the display name, UTF-8, original case and punctuation
//     <name>
//     kindFlags                 1 byte: kind (low 4 bits) | hasStreet (0x10) | hasNumber (0x20)
//     tokenInfo                 1 byte: name token count capped at 15 (high 4 bits)
//                               | ADDR place index plus one (low 4 bits), 0 where the doc has no
//                               place — an unjoined place, or a city that is one place
//     prominence                1 byte, how much a name outranks another on an equal match
//     category                  index into <categories> plus one; 0 where the doc has no category
//     latDelta, lngDelta        zigzag, units of 1e-5°, from the previous doc
//     streetIndex               only when hasStreet: ordinal into the ADDR street table
//     number                    only when hasNumber: major * 2 + hasExtra
//     extra                     only when the low bit of `number` is set: minor * 32 + suffix,
//                               exactly as ADDR packs one
//   tokenCount
//   dictBytes                   length of the token-entry region, which is what locates the
//                               postings region behind it
//   restartCount                ceil(tokenCount / 16)
//   per restart, fixed width, u32 LE x 2:
//     dictOffset                the block's first entry, from the start of the token entries
//     postingsOffset            that entry's posting list, from the start of the postings region
//   per token, sorted bytewise, front-coded in blocks of 16:
//     lcp                       bytes shared with the predecessor; 0 at a block start, so a block
//                               decodes without its neighbours
//     tailLen
//     <tail>                    UTF-8 bytes after the shared prefix
//     postingCount              documents carrying the token
//     postingBytes              the posting list's length, so a run's cost can be summed and a
//                               list skipped without decoding it
//   per token, concatenated in dictionary order:
//     <postings>                ascending doc ids, delta varints, the first absolute
//
// The document order is a Hilbert curve over the quantized coordinates, purely so the coordinate
// deltas are small: spatially adjacent documents are metres apart, so a delta pair costs about four
// bytes instead of eight, and the posting lists pick up spatial coherence that gzip likes. Nothing
// at query time depends on the order.
//
// The dictionary is front-coded in blocks of 16 with a fixed-width restart table, so a query token
// is found by binary search over block-first tokens — which are stored whole, at lcp 0 — comparing
// raw bytes with no decoding, and only the ≤ 16 entries of the block it lands in are ever expanded.
// A prefix match is then a contiguous run of the dictionary, which is why prefix search costs the
// same as exact search plus the run.
//
// There are no positions, no fields and no per-posting payload, which is what keeps a posting at
// about two bytes. Match quality is a property of WHICH dictionary token matched — exact, a prefix,
// or (later) an edit away — and that is known on the dictionary side before a posting is read;
// coverage needs only the name's token count, which rides in the document table.

export const SEARCH_MAGIC = "SRCH";
export const SEARCH_FORMAT = 1;

// The same hundred-thousandths of a degree ADDR stores an address at, imported rather than restated
// so a pin from this file and a pin from that one land on the same grid.
export { COORD_SCALE } from "./address-format";

// Front-coding restarts. Sixteen is the trade between the restart table (eight bytes a block) and
// the decode a hit costs (at most sixteen entries): at New York's ~98k tokens it is ~49 KB of table
// against tails that are otherwise ~438 KB.
export const DICT_BLOCK = 16;
export const RESTART_BYTES = 8;

// The document table's four bits of token count. A name with more words than this counts as this
// many, which only affects the coverage term in ranking — and a sixteen-word name has no coverage
// worth measuring anyway.
export const MAX_NAME_TOKENS = 15;

// What a document is. The number is what the low nibble of `kindFlags` holds, so the order is
// frozen; adding a kind appends.
export const DOC_KINDS = [
  "place",
  "street",
  "station",
  "landmark",
  "art",
  "historic-district",
  "legacy-business",
  "neighborhood",
] as const;

export type DocKind = (typeof DOC_KINDS)[number];

export const KIND_MASK = 0x0f;
// The document names a street of the ADDR file, and `streetIndex` follows.
export const HAS_STREET = 0x10;
// The document sits at a house number, and the ADDR number pair follows. Two bits rather than one
// because a street document has an ordinal and no number, a place that joined has both, and a street
// the graph names but ADDR does not has neither.
export const HAS_NUMBER = 0x20;

export function packKindFlags(
  kind: DocKind,
  hasStreet: boolean,
  hasNumber: boolean,
): number {
  return (
    DOC_KINDS.indexOf(kind) |
    (hasStreet ? HAS_STREET : 0) |
    (hasNumber ? HAS_NUMBER : 0)
  );
}

export function unpackKind(kindFlags: number): DocKind {
  return DOC_KINDS[kindFlags & KIND_MASK];
}

// `placeIndex` is the ADDR place index plus one, so that zero can mean "no place": San Francisco is
// one place and labels nothing, and a New York place that never joined to an address has no borough
// to name until something geographic gives it one.
export function packTokenInfo(tokenCount: number, placeIndex: number): number {
  return Math.min(tokenCount, MAX_NAME_TOKENS) * 16 + (placeIndex + 1);
}

export function unpackTokenInfo(tokenInfo: number): {
  tokenCount: number;
  placeIndex: number; // -1 where the document has none
} {
  return {
    tokenCount: Math.floor(tokenInfo / 16),
    placeIndex: (tokenInfo % 16) - 1,
  };
}

// Apostrophes go before the split rather than becoming separators: "Joe's" is one word, and letting
// it break in two makes `s` the corpus's largest posting list at 15,354 entries — larger than any
// real token. The curly ones are here because the sources use both.
const APOSTROPHES = /['‘’ʼ`]/gu;
const COMBINING_MARKS = /\p{M}/gu;
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

// Shared by the builder and the client, and the two must never diverge: a name tokenized one way and
// a query the other is a name that cannot be found. Decomposing first is what folds Café onto Cafe;
// splitting on Unicode classes rather than on spaces is what keeps a CJK name a run of its own
// characters instead of nothing at all.
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(APOSTROPHES, "")
    .toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(SEPARATORS)
    .filter((token) => token !== "");
}

const CARDINALS = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const ORDINALS = [
  "",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
];

const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

const TEN_ORDINALS = [
  "",
  "",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth",
];

// The highest numbered street either city has, plus room: New York files a West 271st.
export const MAX_ORDINAL = 999;

// "fifth avenue" spelt out, as the tokens it would be typed as. Streets index these alongside their
// digits, because the two cities write a numbered street four ways — "5 AV", "5th Avenue", "Fifth
// Avenue" — and only the first two fall out of the name itself. A compound spells as its words, so
// "twenty first street" matches the same way "21st" does. Empty outside the range.
export function ordinalWords(value: number): string[] {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ORDINAL) {
    return [];
  }
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const words: string[] = [];
  if (hundreds > 0) {
    words.push(CARDINALS[hundreds], rest === 0 ? "hundredth" : "hundred");
  }
  if (rest > 0 && rest < 20) {
    words.push(ORDINALS[rest]);
  } else if (rest >= 20) {
    const tens = Math.floor(rest / 10);
    const unit = rest % 10;
    if (unit === 0) {
      words.push(TEN_ORDINALS[tens]);
    } else {
      words.push(TENS[tens], ORDINALS[unit]);
    }
  }
  return words;
}

// With the ordinal suffix or without, which is the two ways the sources write one: the address file
// has "5 AV" and the display name "5th Avenue".
const NUMBERED_WORD = /^([0-9]+)(?:st|nd|rd|th)?$/u;

// What a word of a street name counts off — 5 for both "5" and "5th" — or null where it counts
// nothing.
export function ordinalValue(word: string): number | null {
  const digits = NUMBERED_WORD.exec(word);
  return digits === null ? null : Number(digits[1]);
}

// A name with each of its numbers spelt out — ["5th", "avenue"] to ["fifth", "avenue"], ["21st",
// "street"] to ["twenty", "first", "street"] — or null where it has no number to spell.
//
// A street is indexed under these words as well as its own, and the query side rebuilds them to tell
// WHICH words of the name a query that spelt one out named: "fifth avenue" is both words of 5th
// Avenue and two of the three of 55th Avenue, which carries the word `fifth` just as genuinely.
export function spelledOrdinals(words: readonly string[]): string[] | null {
  const spelt: string[] = [];
  let numbered = false;
  for (const word of words) {
    const value = ordinalValue(word);
    const asWords = value === null ? [] : ordinalWords(value);
    if (asWords.length === 0) {
      spelt.push(word);
    } else {
      spelt.push(...asWords);
      numbered = true;
    }
  }
  return numbered ? spelt : null;
}

// Bytewise, which is the order the dictionary is written in and so the order a client binary
// searching it has to compare with. UTF-8 sorts the same as code points, so this is a comparison of
// the encoded bytes even though it reads the string.
export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}
