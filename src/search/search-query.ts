// Reading and querying the SRCH index (./search-format.ts): decode a city's file once, then answer
// a keystroke against it.
//
// Nothing here touches the DOM, the network or React. It is the whole search, as a function of bytes
// and a query, so that the worker it will live behind is a message loop around it rather than a
// second implementation of it — and so that a test can build an index of six documents and assert
// what comes back.
//
// The shape of a query is: tokenize what was typed; look each token up in the sorted dictionary,
// where a prefix is a contiguous RUN of entries; union each run's posting lists into a per-document
// accumulator; keep the documents every query token reached; score those by match quality, by how
// prominent the name is, and by how far it is from where the map is pointing. Only the winners have
// their names decoded.

import { type Cursor, readUnsignedVarint, unzigzag } from "../tiles/varint";
import {
  COORD_SCALE,
  formatHouseNumber,
  type HouseNumber,
  unpackExtra,
} from "./address-format";
import {
  type AddressIndex,
  type AddressQuery,
  findNumber,
  parseAddressQuery,
  streetAddresses,
} from "./addresses";
import {
  blockToken,
  dictCursorAt,
  dictToken,
  fuzzyMatches,
  maxEditDistance,
  reachesWithinEdits,
  stepDict,
} from "./dictionary";
import {
  compareBytes,
  type DocKind,
  HAS_NUMBER,
  HAS_STREET,
  MAX_NAME_TOKENS,
  MAX_PLACES,
  RESTART_BYTES,
  SEARCH_FORMAT,
  SEARCH_MAGIC,
  spelledOrdinals,
  tokenize,
  unpackKind,
  unpackTokenInfo,
} from "./search-format";

// One letter of a name matches half a city, exactly as in the street search and the address search.
export const MIN_QUERY_CHARS = 2;

// How many words of a query are looked up. Past this the extra words cost posting walks and change
// nothing: the intersection is already down to a handful of documents. Eight is also the width of
// the per-document bitmask of which words reached it, which is a byte.
const MAX_QUERY_TOKENS = 8;

export const DEFAULT_LIMIT = 20;

// How many candidates survive the first, cheap ordering. What a document's own words say — whether
// two query words landed on the same one, whether the query opened on the first of them, whether it
// named them all — cannot be read off the accumulators, so it is applied after the names are
// decoded, to a pool wide enough that it can still change the order of what is shown.
const POOL_FACTOR = 4;
// And how much wider again once a misspelt word has been corrected. A correction can add hundreds of
// documents that each answer one more word of the query than they would have, and the cheap ordering
// cannot yet see that two of those words landed on the SAME word of the name — so without the room,
// a name that answered the query properly from across town is cut before anything reads it.
const FUZZY_POOL_FACTOR = 4;

// Quality is summed in the accumulator as a fixed-point integer, so the array can be a Uint16Array:
// eight tokens at 1.0 is 8,000, well inside it.
const QUALITY_SCALE = 1000;

const EXACT_QUALITY = 1;
// A prefix of the word being typed is nearly as good as having finished typing it, and the closer it
// is to the whole word the better: "pizz" of "pizza" beats "pizz" of "pizzeria".
const PREFIX_FLOOR = 0.8;
const PREFIX_SPAN = 0.2;
// A prefix of a word that is NOT the last one typed is a word the reader left unfinished on purpose
// or mistyped, so it says less.
const INNER_PREFIX_QUALITY = 0.7;
// What a result keeps when one of the query's words appears nowhere in its name.
const RELAXED_PENALTY = 0.4;
// A word satisfied by the STREET the document sits on rather than by its own name — "Katz's
// Delicatessen E Houston St", where no delicatessen is called "E Houston St" and the one that is
// there is the answer. Below every name match, because a street names hundreds of places and a name
// names one, and well above the relaxation that would otherwise be the only thing catching these.
const STREET_QUALITY = 0.6;

// How much of the name the query accounted for. The exponent is small on purpose: "Joe's Pizza"
// should beat "Joe's Pizza and Pasta Palace" on "joes pizza" without a long name being unfindable.
const COVERAGE_EXPONENT = 0.3;
const FIRST_WORD_BONUS = 1.1;
const WHOLE_NAME_BONUS = 1.15;

// Prominence spans 3.3:1 with a floor, so a subway station outranks a nail salon on an equal match
// and the nail salon is still reachable by its own name. The spread the tiers actually use is what
// decides whether prominence can outweigh being nearer, and it is set in scripts/search-index.ts —
// where the byte lives, and where a rebuild is all it costs to change one.
const PROMINENCE_FLOOR = 0.3;
const PROMINENCE_SPAN = 0.7;
const PROMINENCE_MAX = 255;

// Distance spans 4:1 — deliberately wider than any of the text penalties, because "the Starbucks I
// am looking at" is the answer and "a Starbucks across the city" is not a tiebreak away from it. The
// floor is what still lets a uniquely-named place on the far side of town be found.
const DISTANCE_FLOOR = 0.25;
const DISTANCE_SPAN = 0.75;
const DISTANCE_SCALE_METERS = 1500;

// How much of the distance term something the reader has named EXACTLY pays: a house number, and a
// street or district whose whole name was typed. New York has five Court Streets and each is
// kilometres long, so which of them is nearest ORDERS the several answers, but it must not decide
// whether the far one is shown at all, the way it decides between two Starbucks. So these are
// measured on a flatter curve than a name — 1.6:1 across the city rather than 4:1.
const NAMED_DISTANCE_FLOOR = 0.6;
const NAMED_DISTANCE_SPAN = 0.4;

// The kinds whose one coordinate stands in for ground they cover rather than marking a spot: a
// street is a line kilometres long, filed at the mean of its own addresses, and a neighborhood is a
// district filed at its middle. How far that point is from the map centre is not how far the thing
// is, which is what the flatter curve above is for.
const AREA_KINDS: ReadonlySet<DocKind> = new Set(["street", "neighborhood"]);

// What one of those is worth when what was typed IS its name, whole and with nothing else in it. A
// person who types a bare street name wants the street, not the courthouse, the post office and the
// four subway stations named after it, and one who types Williamsburg wants the neighbourhood rather
// than the Montessori school in it — so it is scored the way an exact door is, at the top of the
// scale that a station otherwise leads.
const WHOLE_AREA_PROMINENCE = 255;

const METERS_PER_DEGREE = 111_320;

export function prominenceFactor(prominence: number): number {
  return PROMINENCE_FLOOR + (PROMINENCE_SPAN * prominence) / PROMINENCE_MAX;
}

export function distanceFactor(meters: number): number {
  return (
    DISTANCE_FLOOR + DISTANCE_SPAN * Math.exp(-meters / DISTANCE_SCALE_METERS)
  );
}

// The same curve, flattened onto the narrower range something named exactly pays.
export function namedDistanceFactor(meters: number): number {
  return (
    NAMED_DISTANCE_FLOOR +
    (NAMED_DISTANCE_SPAN * (distanceFactor(meters) - DISTANCE_FLOOR)) /
      DISTANCE_SPAN
  );
}

// Where the results are measured from: what the map is centred on, which exists signed out and
// without a permission prompt, and is what the reader is looking at.
export interface SearchCentre {
  lat: number;
  lng: number;
}

export interface SearchHit {
  doc: number;
  kind: DocKind;
  name: string;
  lat: number;
  lng: number;
  score: number;
  // The match-quality half of the score, before prominence and distance. A house number resolved off
  // a street this query matched is scored from here: the street's words are what was typed, and the
  // door is somewhere else with a tier of its own.
  text: number;
  category: string | null;
  // Into the ADDR place blob, or -1. The label a result is shown with is built from these by the
  // caller, which is the side that holds the address file.
  placeIndex: number;
  streetIndex: number; // into the ADDR street table, or -1
  number: HouseNumber | null;
}

// The reusable arrays a query accumulates into, sized once per index. `touched` is what makes
// clearing them cost the number of documents the query reached rather than the number in the city.
interface Accumulators {
  // Which query words reached the document, one bit each. It is also the per-word dedup mark —
  // several dictionary tokens under one prefix reach one document, and only the first may count —
  // and it is what the street link below needs, since "which words are still missing" cannot be
  // read off a count.
  matched: Uint8Array;
  hitCount: Uint8Array;
  quality: Uint16Array;
  touched: number[];
}

export interface SearchIndex {
  bytes: Uint8Array;
  restarts: DataView; // over the fixed-width restart table, which is the only region read as u32
  categories: string[];
  docCount: number;
  nameOffset: Uint32Array;
  nameLength: Uint16Array; // bytes; the longest name either city has is 306
  kindFlags: Uint8Array;
  tokenInfo: Uint8Array;
  prominence: Uint8Array;
  category: Uint32Array;
  latUnits: Int32Array;
  lngUnits: Int32Array;
  payload: Uint32Array; // where streetIndex and the house number sit, or 0 for neither
  // Where each ADDR place is, as the mean of the documents in it, or null for a place with none.
  // What a query naming a borough at its end is measured from, in place of the map centre.
  placeCentres: (SearchCentre | null)[];
  tokenCount: number;
  restartCount: number;
  restartStart: number;
  dictStart: number;
  postingsStart: number;
  accumulators: Accumulators;
}

function readBlob(bytes: Uint8Array, cursor: Cursor): string[] {
  const length = readUnsignedVarint(bytes, cursor);
  const text = new TextDecoder().decode(
    bytes.subarray(cursor.offset, cursor.offset + length),
  );
  cursor.offset += length;
  return text === "" ? [] : text.split("\n");
}

export function decodeSearchIndex(bytes: Uint8Array): SearchIndex {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== SEARCH_MAGIC || bytes[4] !== SEARCH_FORMAT) {
    throw new Error(`not a v${SEARCH_FORMAT} search index`);
  }
  const cursor: Cursor = { offset: SEARCH_MAGIC.length + 1 };
  const categories = readBlob(bytes, cursor);
  const docCount = readUnsignedVarint(bytes, cursor);

  const nameOffset = new Uint32Array(docCount);
  const nameLength = new Uint16Array(docCount);
  const kindFlags = new Uint8Array(docCount);
  const tokenInfo = new Uint8Array(docCount);
  const prominence = new Uint8Array(docCount);
  const category = new Uint32Array(docCount);
  const latUnits = new Int32Array(docCount);
  const lngUnits = new Int32Array(docCount);
  const payload = new Uint32Array(docCount);

  // Summed per ADDR place as the documents go by, so the centre of a borough costs one addition a
  // document rather than a second pass over the file.
  const placeLat = new Array<number>(MAX_PLACES).fill(0);
  const placeLng = new Array<number>(MAX_PLACES).fill(0);
  const placeCount = new Array<number>(MAX_PLACES).fill(0);

  let lat = 0;
  let lng = 0;
  for (let doc = 0; doc < docCount; doc += 1) {
    const length = readUnsignedVarint(bytes, cursor);
    nameOffset[doc] = cursor.offset;
    nameLength[doc] = length;
    cursor.offset += length;
    const flags = bytes[cursor.offset];
    kindFlags[doc] = flags;
    tokenInfo[doc] = bytes[cursor.offset + 1];
    prominence[doc] = bytes[cursor.offset + 2];
    cursor.offset += 3;
    category[doc] = readUnsignedVarint(bytes, cursor);
    lat += unzigzag(readUnsignedVarint(bytes, cursor));
    lng += unzigzag(readUnsignedVarint(bytes, cursor));
    latUnits[doc] = lat;
    lngUnits[doc] = lng;
    const { placeIndex } = unpackTokenInfo(tokenInfo[doc]);
    if (placeIndex >= 0) {
      placeLat[placeIndex] += lat;
      placeLng[placeIndex] += lng;
      placeCount[placeIndex] += 1;
    }
    if ((flags & (HAS_STREET | HAS_NUMBER)) !== 0) {
      payload[doc] = cursor.offset;
      if ((flags & HAS_STREET) !== 0) {
        readUnsignedVarint(bytes, cursor);
      }
      if ((flags & HAS_NUMBER) !== 0) {
        const packed = readUnsignedVarint(bytes, cursor);
        if (packed % 2 === 1) {
          readUnsignedVarint(bytes, cursor);
        }
      }
    }
  }

  const tokenCount = readUnsignedVarint(bytes, cursor);
  const dictBytes = readUnsignedVarint(bytes, cursor);
  const restartCount = readUnsignedVarint(bytes, cursor);
  const restartStart = cursor.offset;
  const dictStart = restartStart + restartCount * RESTART_BYTES;

  return {
    bytes,
    restarts: new DataView(
      bytes.buffer,
      bytes.byteOffset + restartStart,
      restartCount * RESTART_BYTES,
    ),
    categories,
    docCount,
    nameOffset,
    nameLength,
    kindFlags,
    tokenInfo,
    prominence,
    category,
    latUnits,
    lngUnits,
    payload,
    tokenCount,
    restartCount,
    restartStart,
    dictStart,
    postingsStart: dictStart + dictBytes,
    placeCentres: placeCount.map((count, place) =>
      count === 0
        ? null
        : {
            lat: placeLat[place] / count / COORD_SCALE,
            lng: placeLng[place] / count / COORD_SCALE,
          },
    ),
    accumulators: {
      matched: new Uint8Array(docCount),
      hitCount: new Uint8Array(docCount),
      quality: new Uint16Array(docCount),
      touched: [],
    },
  };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function docName(index: SearchIndex, doc: number): string {
  const start = index.nameOffset[doc];
  return decoder.decode(
    index.bytes.subarray(start, start + index.nameLength[doc]),
  );
}

// The ADDR ordinal and the house number a document sits at, decoded only for a result that is going
// to be shown. Both are absent for most documents, which is why they are a byte offset rather than
// two more arrays.
function docPayload(
  index: SearchIndex,
  doc: number,
): { streetIndex: number; number: HouseNumber | null } {
  const flags = index.kindFlags[doc];
  const offset = index.payload[doc];
  if (offset === 0) {
    return { streetIndex: -1, number: null };
  }
  const cursor: Cursor = { offset };
  const streetIndex =
    (flags & HAS_STREET) === 0 ? -1 : readUnsignedVarint(index.bytes, cursor);
  if ((flags & HAS_NUMBER) === 0) {
    return { streetIndex, number: null };
  } else {
    const packed = readUnsignedVarint(index.bytes, cursor);
    const extra =
      packed % 2 === 1 ? readUnsignedVarint(index.bytes, cursor) : 0;
    return {
      streetIndex,
      number: { major: Math.floor(packed / 2), ...unpackExtra(extra) },
    };
  }
}

// The ADDR street ordinal alone, which is the first thing in the payload and the only part the
// street link reads. Separate from docPayload because the link asks it of every document a query
// reached and wants no house number decoded for the ones it then discards.
function docStreetIndex(index: SearchIndex, doc: number): number {
  const offset = index.payload[doc];
  if (offset === 0 || (index.kindFlags[doc] & HAS_STREET) === 0) {
    return -1;
  } else {
    return readUnsignedVarint(index.bytes, { offset });
  }
}

function compareToPrefix(
  token: Uint8Array,
  length: number,
  prefix: Uint8Array,
): number {
  const shared = Math.min(length, prefix.length);
  for (let at = 0; at < shared; at += 1) {
    if (token[at] !== prefix[at]) {
      return token[at] - prefix[at];
    }
  }
  // A token shorter than the prefix sorts before it; one that carries it whole is a match, which is
  // the zero every prefix hit reports.
  return length < prefix.length ? -1 : 0;
}

// One dictionary token a query token reached, and how well.
interface Match {
  postings: number;
  postingCount: number;
  quality: number;
}

// One word of the query: what was typed, the bytes the dictionary is searched with, whether it is
// the word still being typed, how wrong it was allowed to be spelt — zero until the fuzzy pass runs,
// and zero for every word too short for it — and the dictionary tokens it reached.
interface QueryWord {
  text: string;
  bytes: Uint8Array;
  // Which bit of the per-document mask is this word's, which is where it sits in the query — fixed,
  // so that the corrections a second pass adds land on the same bit the first pass used.
  mark: number;
  last: boolean;
  edits: number;
  matches: Match[];
}

// Every dictionary token carrying `prefix`, which is a contiguous run: the block-first tokens are
// binary searched in the raw bytes, and only the block the search lands in is ever decoded.
function expand(
  index: SearchIndex,
  prefix: Uint8Array,
  last: boolean,
): Match[] {
  let block = 0;
  let low = 0;
  let high = index.restartCount - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    // Strictly less: a block whose first token already CARRIES the prefix may not hold the run's
    // first entry, since the entry before it can carry the prefix too.
    if (compareBytes(blockToken(index, middle), prefix) < 0) {
      block = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const matches: Match[] = [];
  const cursor = dictCursorAt(index, block);
  while (stepDict(index, cursor)) {
    dictToken(index, cursor);
    const order = compareToPrefix(cursor.token, cursor.length, prefix);
    if (order > 0) {
      break;
    } else if (order === 0) {
      const exact = cursor.length === prefix.length;
      matches.push({
        postings: cursor.posting,
        postingCount: cursor.postingCount,
        quality: exact
          ? EXACT_QUALITY
          : last
            ? PREFIX_FLOOR + (PREFIX_SPAN * prefix.length) / cursor.length
            : INNER_PREFIX_QUALITY,
      });
    }
  }
  // Descending, so the first posting to reach a document is the best one it will get from this query
  // token and every later touch can be skipped.
  return matches.sort((left, right) => right.quality - left.quality);
}

export interface SearchRequest {
  text: string;
  centre: SearchCentre;
  limit?: number;
  // Which kinds of document may be ANSWERED with. Every kind is still matched whatever this says —
  // a street a query names is what the street link below reads, whether or not the street itself is
  // an answer — so this is what a caller whose street rows come from somewhere else asks for.
  kinds?: readonly DocKind[];
}

// A document with a score against it: what the pool is ordered on before its name is read, and what
// the finalists are ordered on after.
interface Ranked {
  doc: number;
  score: number;
}

interface Candidate extends Ranked {
  // What the accumulators held for this document, which they no longer hold once the query has
  // cleared them and the pool is rescored against the decoded names.
  quality: number;
  named: number;
  linked: number;
  // How far the document is from where the query is measured, which the rescore needs rather than
  // the factor built from it: a street the decoded name turns out NOT to be wholly named is measured
  // on the ordinary curve after the pool measured it on the flatter one.
  meters: number;
}

function metersBetween(at: SearchCentre, centre: SearchCentre): number {
  const north = at.lat - centre.lat;
  const east = (at.lng - centre.lng) * Math.cos((centre.lat * Math.PI) / 180);
  return Math.sqrt(north * north + east * east) * METERS_PER_DEGREE;
}

function metersFrom(
  index: SearchIndex,
  doc: number,
  centre: SearchCentre,
): number {
  return metersBetween(
    {
      lat: index.latUnits[doc] / COORD_SCALE,
      lng: index.lngUnits[doc] / COORD_SCALE,
    },
    centre,
  );
}

// Score first, then the three deterministic tiebreaks the street search's comment asks for: a more
// prominent name, then a shorter one, then the file's own order.
function betterThan(index: SearchIndex, left: Ranked, right: Ranked): number {
  return (
    right.score - left.score ||
    index.prominence[right.doc] - index.prominence[left.doc] ||
    index.nameLength[left.doc] - index.nameLength[right.doc] ||
    left.doc - right.doc
  );
}

// The words a query is looked up as. Past the cap the longest words are kept, and the LAST word
// always is: it is the one being typed, and dropping it would answer a prefix nobody asked for.
function queryTokens(text: string): string[] {
  const tokens = tokenize(text);
  if (tokens.length <= MAX_QUERY_TOKENS) {
    return tokens;
  }
  const last = tokens[tokens.length - 1];
  const rest = tokens
    .slice(0, -1)
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_QUERY_TOKENS - 1);
  return [...rest, last];
}

// The documents whose query words are completed by the STREET they sit on: for each, how many words
// that took. Typing a place and the street it is on is a query no name in the index carries whole —
// "Katz's Delicatessen E Houston St" has three words no delicatessen is called — and it was, before
// this, an EMPTY list rather than a wrong answer. The index already knows which ADDR street each
// place joined to, and a street is itself a document, so the words the street's own document matched
// are words the places on it have answered too.
//
// Both passes walk the documents the query reached, which is why they are here rather than folded
// into the posting walk: what the street matched is only known once every posting has been read.
function streetLinked(
  index: SearchIndex,
  tokenCount: number,
  everyToken: number,
): Map<number, number> {
  const linked = new Map<number, number>();
  if (tokenCount < 2) {
    return linked; // one word cannot be split between a name and a street
  }
  const { matched, touched } = index.accumulators;
  const streets = new Map<number, number>();
  for (const doc of touched) {
    if (unpackKind(index.kindFlags[doc]) === "street") {
      if (matched[doc] === everyToken) {
        // A STREET answered the whole query on its own, so the query was a street name — "Bedford
        // Av" — and lending its words to every shop with that address would bury it under them.
        return linked;
      }
      const street = docStreetIndex(index, doc);
      if (street >= 0) {
        // What the street itself matched is what every place on it may borrow.
        streets.set(street, (streets.get(street) ?? 0) | matched[doc]);
      }
    }
  }
  if (streets.size === 0) {
    return linked;
  }
  for (const doc of touched) {
    if (matched[doc] === everyToken) {
      continue; // the name answered the whole query on its own
    }
    const street = streets.get(docStreetIndex(index, doc));
    if (street !== undefined && (matched[doc] | street) === everyToken) {
      let words = 0;
      for (let rest = everyToken & ~matched[doc]; rest !== 0; rest >>= 1) {
        words += rest & 1;
      }
      linked.set(doc, words);
    }
  }
  return linked;
}

// How much of what was typed the document answered: the mean quality of the words it matched, docked
// for the words of the NAME the query never named, and docked again where a word of the query went
// unanswered altogether.
function textScore(
  quality: number, // summed over the query's words, each at the best it matched
  named: number, // query words the name answered
  linked: number, // query words the street the document sits on answered
  queryWords: number,
  nameWords: number,
): number {
  const coverage = Math.min(1, named / Math.max(nameWords, 1));
  return (
    ((quality + linked * STREET_QUALITY) / queryWords) *
    coverage ** COVERAGE_EXPONENT *
    (named + linked === queryWords ? 1 : RELAXED_PENALTY)
  );
}

// Whether what was typed is one of those names and nothing besides. Three things have to hold, and
// each of them rules out a different street the same words also reach: every word of the query
// landed on a distinct word of the name with none of the name left unnamed, so "Court St" is not
// Court Street Bagels; the query starts where the name starts, so it is not Stable Court; and
// nothing but the word still being typed is an unfinished prefix, which is what tells 5th Avenue
// from 57th.
//
// It is asked twice. The pool asks it before any name is decoded, where `named` counts two query
// words that landed on ONE name word as two and `leads` is not yet known — both of which can only
// overstate the answer, which is the direction the pool has to err in. The finalists ask it again
// with what the decoded name settled.
function namedWholeArea(
  kind: DocKind,
  named: number,
  quality: number, // summed over the query's words, each at the best it matched
  leads: boolean,
  queryWords: number,
  nameWords: number,
): boolean {
  return (
    AREA_KINDS.has(kind) &&
    named === queryWords &&
    named === nameWords &&
    leads &&
    quality >= (queryWords - 1) * EXACT_QUALITY + PREFIX_FLOOR
  );
}

// The half of the score the query's words are not in: how prominent the document is and how far away.
function placeFactor(
  index: SearchIndex,
  doc: number,
  meters: number,
  wholeArea: boolean,
): number {
  return wholeArea
    ? prominenceFactor(WHOLE_AREA_PROMINENCE) * namedDistanceFactor(meters)
    : prominenceFactor(index.prominence[doc]) * distanceFactor(meters);
}

// The word sequences a document may be read as. Everything is its own name; a STREET is also its
// name with the numbers spelt out, since that is what the index files it under — and reading "fifth
// avenue" against ["fifth", "avenue"] rather than against ["5th", "avenue"] is the whole difference
// between 5th Avenue, which the query names entirely, and 55th Avenue, which carries the word
// `fifth` just as genuinely and is ["fifty", "fifth", "avenue"].
//
// A document is then scored under whichever of its spellings answers the query best, never under a
// mix of two: one that answers it under neither gains nothing from being read twice.
function spellingsOf(kind: DocKind, name: string): string[][] {
  const words = tokenize(name);
  const spelt = kind === "street" ? spelledOrdinals(words) : null;
  return spelt === null ? [words] : [words, spelt];
}

// How many words of the query reached only a word of the name that another word of the query has a
// better claim on. Typing "shake sh" at "Shake Top DeLite" matches both words against "Shake", and
// counting that as two words answered puts it above the Shake Shack that answers one word each — so
// the second word here is answered by nothing, and the document is a partial match.
//
// It is the largest pairing of query words with name words that gives each name word to at most one
// query word, which is Kuhn's augmenting walk: offer a word every name word it prefixes, and let it
// take one from an earlier word that still has somewhere else to go. The index carries no positions,
// so this is asked of the decoded name — affordable only because the pool's names are decoded for
// the order bonuses anyway.
function doubledWords(
  queryWords: readonly QueryWord[],
  nameWords: readonly string[],
): number {
  const encoded = new Array<Uint8Array | null>(nameWords.length).fill(null);
  // Whether the word the reader typed is a word of this name, by the same rule the dictionary was
  // searched under: it starts one, or — where it was looked for misspelt — it is within the same
  // number of edits of the start of one. Without the second half a word that only matched through a
  // correction claims nothing, and the name word it corrected to is left free for the next query
  // word to claim as well, which is the doubling this whole function exists to stop.
  const reaches = (word: number, name: number): boolean => {
    if (nameWords[name].startsWith(queryWords[word].text)) {
      return true;
    } else if (queryWords[word].edits === 0) {
      return false;
    } else {
      encoded[name] ??= encoder.encode(nameWords[name]);
      return reachesWithinEdits(
        queryWords[word].bytes,
        encoded[name] as Uint8Array,
        queryWords[word].edits,
      );
    }
  };
  const takenBy = new Array<number>(nameWords.length).fill(-1);
  const walked = new Array<boolean>(nameWords.length).fill(false);
  const claim = (word: number): boolean => {
    for (let name = 0; name < nameWords.length; name += 1) {
      if (walked[name] || !reaches(word, name)) {
        continue;
      }
      walked[name] = true;
      if (takenBy[name] === -1 || claim(takenBy[name])) {
        takenBy[name] = word;
        return true;
      }
    }
    return false;
  };

  let reached = 0;
  let paired = 0;
  for (let word = 0; word < queryWords.length; word += 1) {
    if (!nameWords.some((_, name) => reaches(word, name))) {
      continue; // this word is answered by something other than the name, or by nothing
    }
    reached += 1;
    walked.fill(false);
    if (claim(word)) {
      paired += 1;
    }
  }
  return reached - paired;
}

// A word one edit from what the dictionary holds is scored well below the same word spelt right, and
// a word two edits away well below that: what these multiply is the prefix quality the same match
// would have earned had it been typed correctly, so a misspelling can only ever ADD an answer under
// the ones that match properly, never displace them.
const EDIT_PENALTY = [1, 0.55, 0.3];

// Every dictionary token within an edit or two of a word, as matches to be unioned exactly like a
// prefix run. The tokens the walk reaches at no edits at all are the ones that simply carry the word
// as a prefix, which `expand` has already returned, so they are dropped here rather than having the
// largest posting lists of the query read a second time.
function fuzzyExpand(
  index: SearchIndex,
  token: Uint8Array,
  last: boolean,
  distance: number,
): Match[] {
  const matches: Match[] = [];
  for (const near of fuzzyMatches(index, token, distance)) {
    if (near.distance === 0) {
      continue;
    }
    matches.push({
      postings: near.postings,
      postingCount: near.postingCount,
      quality:
        (last
          ? PREFIX_FLOOR + (PREFIX_SPAN * near.matchedLength) / near.tokenLength
          : INNER_PREFIX_QUALITY) * EDIT_PENALTY[near.distance],
    });
  }
  return matches;
}

// Cheapest first, so the expensive word walks a list that most documents have already failed out of.
function byMass(words: readonly QueryWord[]): readonly QueryWord[] {
  return [...words].sort(
    (left, right) => postingMass(left) - postingMass(right),
  );
}

function postingMass(word: QueryWord): number {
  return word.matches.reduce((sum, match) => sum + match.postingCount, 0);
}

// Reads each word's matches into the accumulators, appending to `candidates` every document as it
// completes the last word of the query it was missing — which is what saves a sweep over the city
// afterwards to find them.
//
// It is called twice for a query that had to be corrected, the second time with the corrections
// ALONE: what a word already reached it keeps, at the quality it first arrived with, and since every
// correction scores below every properly spelt match, first is also best. So the second pass reads
// only the posting lists the first one did not, which is what keeps a corrected query from costing
// twice a plain one — and matters most where one word of the query is a single letter carrying tens
// of thousands of documents.
function accumulate(
  index: SearchIndex,
  words: readonly QueryWord[],
  queryWords: number,
  candidates: number[],
): void {
  const { matched, hitCount, quality, touched } = index.accumulators;
  for (const word of words) {
    const mark = 1 << word.mark;
    for (const match of word.matches) {
      const cursor: Cursor = { offset: match.postings };
      const points = Math.round(match.quality * QUALITY_SCALE);
      let doc = 0;
      for (let read = 0; read < match.postingCount; read += 1) {
        doc += readUnsignedVarint(index.bytes, cursor);
        if ((matched[doc] & mark) !== 0) {
          continue;
        }
        if (matched[doc] === 0) {
          touched.push(doc);
        }
        matched[doc] |= mark;
        hitCount[doc] += 1;
        quality[doc] += points;
        if (hitCount[doc] === queryWords) {
          candidates.push(doc);
        }
      }
    }
  }
}

export function searchNames(
  index: SearchIndex,
  { text, centre, limit = DEFAULT_LIMIT, kinds }: SearchRequest,
): SearchHit[] {
  const tokens = queryTokens(text);
  if (tokens.join("").length < MIN_QUERY_CHARS) {
    return [];
  }
  const wanted = kinds === undefined ? null : new Set(kinds);
  const queryWords: QueryWord[] = tokens.map((token, position) => {
    const bytes = encoder.encode(token);
    const last = position === tokens.length - 1;
    return {
      text: token,
      bytes,
      mark: position,
      last,
      edits: 0,
      matches: expand(index, bytes, last),
    };
  });

  const { matched, hitCount, quality, touched } = index.accumulators;
  const everyToken = (1 << queryWords.length) - 1;
  const candidates: number[] = [];
  accumulate(index, byMass(queryWords), tokens.length, candidates);
  // What was typed reaches almost nothing, so it is worth asking whether it was typed wrong. A query
  // spelt right never pays for this, and one that is not pays for one walk over the dictionary per
  // word — after which the walk above runs again over the corrections, because a word one edit away
  // can complete a document that only one of the properly spelt words reached.
  let corrected = false;
  if (candidates.length < limit) {
    for (const word of queryWords) {
      const edits = maxEditDistance(word.bytes.length);
      // Descending, since a document keeps the first quality to reach it and the best has to be
      // first — one edit before two.
      word.matches =
        edits === 0
          ? []
          : fuzzyExpand(index, word.bytes, word.last, edits).sort(
              (left, right) => right.quality - left.quality,
            );
      if (word.matches.length > 0) {
        word.edits = edits;
        corrected = true;
      }
    }
    if (corrected) {
      accumulate(index, byMass(queryWords), tokens.length, candidates);
    }
  }
  // How many of the query's words the street a document sits on accounted for, for the documents
  // where that is what completes the query. Empty for every query that named no street.
  const viaStreet = streetLinked(index, tokens.length, everyToken);
  for (const doc of viaStreet.keys()) {
    candidates.push(doc);
  }
  // The word the reader typed that this name does not contain. It costs nothing to allow — the
  // counts are already in the accumulator — and it is what keeps "joes pizza brooklyn" answering.
  if (candidates.length < limit && tokens.length >= 2) {
    for (const doc of touched) {
      if (hitCount[doc] === tokens.length - 1 && !viaStreet.has(doc)) {
        candidates.push(doc);
      }
    }
  }

  const pool: Candidate[] = [];
  const poolSize = limit * POOL_FACTOR * (corrected ? FUZZY_POOL_FACTOR : 1);
  for (const doc of candidates) {
    if (wanted !== null && !wanted.has(unpackKind(index.kindFlags[doc]))) {
      continue;
    }
    const named = hitCount[doc];
    const linked = viaStreet.get(doc) ?? 0;
    const points = quality[doc] / QUALITY_SCALE;
    const { tokenCount } = unpackTokenInfo(index.tokenInfo[doc]);
    const meters = metersFrom(index, doc, centre);
    // Scored here as though every word the document matched was a word of its own, which is the most
    // it can be worth; the pool is cut on that and the rescore below can only lower it, so nothing
    // that deserves a place in the answer is dropped here for a reason the name has not been read
    // for yet.
    const place = placeFactor(
      index,
      doc,
      meters,
      namedWholeArea(
        unpackKind(index.kindFlags[doc]),
        named,
        points,
        true,
        tokens.length,
        // The document table holds the DISPLAY name's word count, and a street spelt out is longer
        // than that — so a query that named every word of "twenty first street" reached more words
        // than the count admits to. Erring towards the longer reading keeps the pool the upper bound
        // it has to be.
        Math.max(tokenCount, named),
      ),
    );
    const candidate = {
      doc,
      quality: points,
      named,
      linked,
      meters,
      score:
        textScore(points, named, linked, tokens.length, tokenCount) * place,
    };
    // Bounded insertion rather than a heap: the pool is eighty entries, and all but a handful of
    // candidates fail the one comparison against its worst member and stop there.
    if (pool.length < poolSize) {
      pool.push(candidate);
    } else if (betterThan(index, candidate, pool[poolSize - 1]) < 0) {
      pool[poolSize - 1] = candidate;
    } else {
      continue;
    }
    let at = pool.length - 1;
    while (at > 0 && betterThan(index, candidate, pool[at - 1]) < 0) {
      pool[at] = pool[at - 1];
      at -= 1;
    }
    pool[at] = candidate;
  }

  for (const doc of touched) {
    matched[doc] = 0;
    hitCount[doc] = 0;
    quality[doc] = 0;
  }
  touched.length = 0;

  // The three things the accumulators cannot answer, all of which need the document's own words:
  // whether two query words shared one of them, whether the query opened on the first of them, and
  // whether it named every one of them. Applied here, to a pool four times the length of the answer,
  // so they can still reorder what is shown.
  const typed = new Set(tokens);
  const finalists = pool.map(({ doc, quality, named, linked, meters }) => {
    const name = docName(index, doc);
    const kind = unpackKind(index.kindFlags[doc]);
    let best = { text: 0, score: 0 };
    for (const nameWords of spellingsOf(kind, name)) {
      const answered = named - doubledWords(queryWords, nameWords);
      const leads = nameWords.length > 0 && nameWords[0].startsWith(tokens[0]);
      const whole =
        nameWords.length > 0 && nameWords.every((word) => typed.has(word));
      const place = placeFactor(
        index,
        doc,
        meters,
        namedWholeArea(
          kind,
          answered,
          (quality * answered) / named,
          leads,
          tokens.length,
          nameWords.length,
        ),
      );
      // A word that only doubled up on another's takes its share of the quality with it: the
      // accumulator holds one sum for the document, not a figure per word.
      const text =
        textScore(
          (quality * answered) / named,
          answered,
          linked,
          tokens.length,
          Math.min(nameWords.length, MAX_NAME_TOKENS),
        ) *
        (leads ? FIRST_WORD_BONUS : 1) *
        (whole ? WHOLE_NAME_BONUS : 1);
      if (text * place > best.score) {
        best = { text, score: text * place };
      }
    }
    return { doc, name, text: best.text, score: best.score };
  });
  finalists.sort((left, right) => betterThan(index, left, right));

  return finalists.slice(0, limit).map(({ doc, name, text, score }) => {
    const { placeIndex } = unpackTokenInfo(index.tokenInfo[doc]);
    return {
      doc,
      kind: unpackKind(index.kindFlags[doc]),
      name,
      lat: index.latUnits[doc] / COORD_SCALE,
      lng: index.lngUnits[doc] / COORD_SCALE,
      score,
      text,
      category:
        index.category[doc] === 0
          ? null
          : index.categories[index.category[doc] - 1],
      placeIndex,
      ...docPayload(index, doc),
    };
  });
}

// How prominent a door is. A house number the city's own file has, on a street whose WHOLE name was
// typed, is the most precise answer anything here can give — a network geocoder answers the same
// query with a point at an arbitrary end of a street kilometres long more often than not — so it is
// baked at the top of the scale, where nothing that is merely a name can reach it.
//
// Both halves have to be the reader's. A near miss on the number is not what was asked for, and
// neither is a real number on a street the query only prefix-matched: "5 Av" reaches every avenue in
// the city, and answering it from the top of the scale puts a doorway on Avenue A above Fifth
// Avenue. Either way the door is offered under its own real number, from near the bottom.
const EXACT_ADDRESS_PROMINENCE = 255;
const NEAREST_ADDRESS_PROMINENCE = 60;

// How many streets one query may decode the addresses of. "100 av" names every Avenue in Brooklyn,
// and each of those names is several streets rather than one; a run is cheap to walk but there is no
// reason to walk hundreds of them for a list that shows a handful.
const MAX_SCANNED_STREETS = 24;

// One answer, with the line under it already built: nothing outside this module has to hold the
// address file to say which door and which borough a result is at.
export interface CityHit {
  kind: DocKind;
  name: string;
  label: string; // "205 E Houston St, Manhattan", or "" where nothing places it
  lat: number;
  lng: number;
  score: number;
  category: string | null; // the Overture slug, or a station's routes
  // Whether the number asked for is the number found. Null for every answer that was not asked a
  // number, which is all of them but the house-number path's.
  exact: boolean | null;
}

export interface CityRequest {
  text: string;
  centre: SearchCentre;
  limit?: number;
}

// The line under a result's name: the door it sits at and the borough it is in, from the address
// file the ordinals in the index point into. A place that never joined an address still names its
// borough — the builder takes that from the city's own boundaries — and a city that is one place
// names nothing.
function labelOf(
  addresses: AddressIndex,
  hit: Pick<SearchHit, "placeIndex" | "streetIndex" | "number">,
): string {
  const parts: string[] = [];
  if (hit.streetIndex >= 0 && hit.number !== null) {
    const name = addresses.names[addresses.streetName[hit.streetIndex]];
    parts.push(`${formatHouseNumber(hit.number)} ${name}`);
  }
  const place = addresses.places[hit.placeIndex];
  if (place !== undefined) {
    parts.push(place);
  }
  return parts.join(", ");
}

// The same line, for a caller holding a document rather than a search hit: ./reverse.ts names the
// point a pin was dropped on, and a pin has to read exactly as the same place would if it had been
// typed into the box.
export function docLabel(
  index: SearchIndex,
  addresses: AddressIndex,
  doc: number,
): string {
  const { placeIndex } = unpackTokenInfo(index.tokenInfo[doc]);
  return labelOf(addresses, { ...docPayload(index, doc), placeIndex });
}

// A place named at the end of what was typed, and what is left of the text without it. New York's
// street names do not say which borough they are in, which is exactly what makes "312 Court St
// Brooklyn" a natural thing to type — and "joes pizza brooklyn" too, though no pizzeria's own name
// contains the word. The longest place wins, so a city with both "Island" and "Staten Island" strips
// the one that was meant.
export function splitTrailingPlace(
  places: readonly string[],
  text: string,
): { text: string; placeIndex: number } | null {
  let best: { text: string; placeIndex: number; length: number } | null = null;
  for (let place = 0; place < places.length; place += 1) {
    const name = places[place];
    // Measured in the ORIGINAL text, whose length is not always its lowercase's: Turkish İ
    // lowercases to two code points, and an offset taken from the lowered text would then cut the
    // rest of the query a character short.
    const at = text.length - name.length;
    // On a word boundary, or a city with an "Island" would read "Court St Islander" as one.
    if (
      at <= 0 ||
      text.slice(at).toLowerCase() !== name.toLowerCase() ||
      !/[\s,]/.test(text[at - 1])
    ) {
      continue;
    }
    const rest = text.slice(0, at).replace(/[\s,]+$/, "");
    // "Brooklyn" on its own is a place, not something in one: what is left still has to name
    // something, or the whole query would be answered from a borough centre with no words in it.
    if (
      rest.length >= MIN_QUERY_CHARS &&
      (best === null || name.length > best.length)
    ) {
      best = { text: rest, placeIndex: place, length: name.length };
    }
  }
  return best === null
    ? null
    : { text: best.text, placeIndex: best.placeIndex };
}

// Whether what was typed reaches every word of the street's name, rather than one word of it.
function namesWholeStreet(asked: readonly string[], street: string): boolean {
  return tokenize(street).every((word) =>
    asked.some((token) => word.startsWith(token)),
  );
}

// The doors a house number opens: the streets whose names answer what was typed after the number,
// each asked for that number out of its own ADDR run. The number the FILE has is what comes back,
// never the one that was typed — a pin labelled 121 when the file knows only 119 and 123 is a wrong
// answer wearing a right one's clothes — and a number past either end of a street is not answered at
// all, since 9999 Broadway is not at the top of Broadway.
function addressAnswers(
  index: SearchIndex,
  addresses: AddressIndex,
  { number, street }: AddressQuery,
  centre: SearchCentre,
  limit: number,
): CityHit[] {
  const named = splitTrailingPlace(addresses.places, street);
  const text = named === null ? street : named.text;
  if (text.length < MIN_QUERY_CHARS) {
    return [];
  }
  const from =
    named === null ? centre : (index.placeCentres[named.placeIndex] ?? centre);
  const streets = searchNames(index, {
    text,
    centre: from,
    limit: MAX_SCANNED_STREETS,
    kinds: ["street"],
  });
  const asked = tokenize(text);
  const hits: CityHit[] = [];
  for (const match of streets) {
    // A street the routing graph names has no run to look a number up in, and a place the reader
    // named is a requirement rather than a preference: someone who typed Brooklyn has said which
    // Court Street they mean, and the other four are no longer answers.
    if (
      match.streetIndex < 0 ||
      (named !== null && match.placeIndex !== named.placeIndex)
    ) {
      continue;
    }
    const found = findNumber(
      streetAddresses(addresses, match.streetIndex),
      number,
    );
    // A number the street does not have is a guess, and a guess is only worth making when the reader
    // named the whole street: "121 Broadway" is worth answering with 119, while "5 Av" — which
    // prefix-matches the second word of every avenue in the city — is not worth answering with the
    // first house number on Hudson Avenue. A number the street DOES have is still answered however
    // little of the name was typed, but only the whole name earns the top of the scale.
    const wholeStreet = namesWholeStreet(asked, match.name);
    if (found === null || (!found.exact && !wholeStreet)) {
      continue;
    }
    const { address, exact } = found;
    hits.push({
      kind: "street",
      name: `${formatHouseNumber(address.number)} ${match.name}`,
      label: addresses.places[match.placeIndex] ?? "",
      lat: address.lat,
      lng: address.lng,
      score:
        match.text *
        prominenceFactor(
          exact && wholeStreet
            ? EXACT_ADDRESS_PROMINENCE
            : NEAREST_ADDRESS_PROMINENCE,
        ) *
        namedDistanceFactor(metersBetween(address, from)),
      category: null,
      exact,
    });
    if (hits.length >= limit) {
      break;
    }
  }
  return hits;
}

// The general path, run twice where the query ends in a borough: once as typed, once without it and
// measured from that borough instead of from the map centre. Both are kept, because "5 Av Brooklyn"
// is a street in Brooklyn and "Brooklyn Bridge" is a name that ends in one, and only the scores can
// tell which was meant.
function nameAnswers(
  index: SearchIndex,
  addresses: AddressIndex,
  text: string,
  centre: SearchCentre,
  limit: number,
): SearchHit[] {
  const direct = searchNames(index, { text, centre, limit });
  const named = splitTrailingPlace(addresses.places, text);
  if (named === null) {
    return direct;
  } else {
    const nearby = searchNames(index, {
      text: named.text,
      centre: index.placeCentres[named.placeIndex] ?? centre,
      limit,
    });
    const best = new Map<number, SearchHit>();
    for (const hit of [...direct, ...nearby]) {
      const seen = best.get(hit.doc);
      if (seen === undefined || hit.score > seen.score) {
        best.set(hit.doc, hit);
      }
    }
    return [...best.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

// The city's whole answer to what was typed: house numbers out of the address file and names out of
// the index, ranked against each other by the one score. This is the search — the worker around it
// is a message loop, and a test can ask it the same question with no worker at all.
export function searchCity(
  index: SearchIndex,
  addresses: AddressIndex,
  { text, centre, limit = DEFAULT_LIMIT }: CityRequest,
): CityHit[] {
  const parsed = parseAddressQuery(text);
  const doors =
    parsed === null
      ? []
      : addressAnswers(index, addresses, parsed, centre, limit);
  // The general path runs on the whole text even when a number opened it: "5 Guys" is a name, not an
  // address, and the two paths' answers are told apart by their scores rather than by the parse.
  const named = nameAnswers(index, addresses, text, centre, limit).map(
    (hit) => ({
      kind: hit.kind,
      name: hit.name,
      label: labelOf(addresses, hit),
      lat: hit.lat,
      lng: hit.lng,
      score: hit.score,
      category: hit.category,
      exact: null,
    }),
  );
  return [...doors, ...named]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
