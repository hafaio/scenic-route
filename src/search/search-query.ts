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
import { COORD_SCALE, type HouseNumber, unpackExtra } from "./address-format";
import {
  compareBytes,
  DICT_BLOCK,
  type DocKind,
  HAS_NUMBER,
  HAS_STREET,
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

const METERS_PER_DEGREE = 111_320;

export function prominenceFactor(prominence: number): number {
  return PROMINENCE_FLOOR + (PROMINENCE_SPAN * prominence) / PROMINENCE_MAX;
}

export function distanceFactor(meters: number): number {
  return (
    DISTANCE_FLOOR + DISTANCE_SPAN * Math.exp(-meters / DISTANCE_SCALE_METERS)
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
    accumulators: {
      matched: new Uint8Array(docCount),
      hitCount: new Uint8Array(docCount),
      quality: new Uint16Array(docCount),
      touched: [],
    },
  };
}

const decoder = new TextDecoder();

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

// Where the walk over the dictionary is: the token it has just read, spelt out from the front-coded
// tail, and where that token's postings start. `index` is the dictionary position, so that a caller
// can tell a run's extent.
interface DictCursor {
  token: Uint8Array;
  length: number;
  entry: number;
  posting: number;
  index: number;
  postingCount: number;
  postingBytes: number;
}

function dictCursorAt(index: SearchIndex, block: number): DictCursor {
  const restart = block * RESTART_BYTES;
  return {
    token: new Uint8Array(64),
    length: 0,
    entry: index.dictStart + index.restarts.getUint32(restart, true),
    posting: index.postingsStart + index.restarts.getUint32(restart + 4, true),
    index: block * DICT_BLOCK,
    postingCount: 0,
    postingBytes: 0,
  };
}

// Reads the next entry into the cursor. False at the end of the dictionary; the token itself is
// `cursor.token` for `cursor.length` bytes, and the previous entry's postings are stepped over on
// the way, which is what `postingBytes` is stored for.
function stepDict(index: SearchIndex, cursor: DictCursor): boolean {
  if (cursor.index >= index.tokenCount) {
    return false;
  }
  cursor.posting += cursor.postingBytes;
  const entry: Cursor = { offset: cursor.entry };
  const lcp = readUnsignedVarint(index.bytes, entry);
  const tail = readUnsignedVarint(index.bytes, entry);
  if (lcp + tail > cursor.token.length) {
    const grown = new Uint8Array(lcp + tail + 64);
    grown.set(cursor.token);
    cursor.token = grown;
  }
  cursor.token.set(
    index.bytes.subarray(entry.offset, entry.offset + tail),
    lcp,
  );
  cursor.length = lcp + tail;
  entry.offset += tail;
  cursor.postingCount = readUnsignedVarint(index.bytes, entry);
  cursor.postingBytes = readUnsignedVarint(index.bytes, entry);
  cursor.entry = entry.offset;
  cursor.index += 1;
  return true;
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

// The first token of a block, read without decoding anything: a block's first entry has an lcp of
// zero, so its tail IS the token.
function blockToken(index: SearchIndex, block: number): Uint8Array {
  const entry: Cursor = {
    offset:
      index.dictStart + index.restarts.getUint32(block * RESTART_BYTES, true),
  };
  readUnsignedVarint(index.bytes, entry);
  const tail = readUnsignedVarint(index.bytes, entry);
  return index.bytes.subarray(entry.offset, entry.offset + tail);
}

// One dictionary token a query token reached, and how well.
interface Match {
  postings: number;
  postingCount: number;
  quality: number;
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
  // Prominence times distance: the half of the score the name has no part in, so the rescore pays
  // for neither again.
  place: number;
}

function metersFrom(
  index: SearchIndex,
  doc: number,
  centre: SearchCentre,
): number {
  const north = index.latUnits[doc] / COORD_SCALE - centre.lat;
  const east =
    (index.lngUnits[doc] / COORD_SCALE - centre.lng) *
    Math.cos((centre.lat * Math.PI) / 180);
  return Math.sqrt(north * north + east * east) * METERS_PER_DEGREE;
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
  queryWords: readonly string[],
  nameWords: readonly string[],
): number {
  const takenBy = new Array<number>(nameWords.length).fill(-1);
  const walked = new Array<boolean>(nameWords.length).fill(false);
  const claim = (word: number): boolean => {
    for (let name = 0; name < nameWords.length; name += 1) {
      if (walked[name] || !nameWords[name].startsWith(queryWords[word])) {
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
    if (!nameWords.some((name) => name.startsWith(queryWords[word]))) {
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

export function searchNames(
  index: SearchIndex,
  { text, centre, limit = DEFAULT_LIMIT, kinds }: SearchRequest,
): SearchHit[] {
  const tokens = queryTokens(text);
  if (tokens.join("").length < MIN_QUERY_CHARS) {
    return [];
  }
  const wanted = kinds === undefined ? null : new Set(kinds);
  const encoder = new TextEncoder();
  const expansions = tokens
    .map((token, position) =>
      expand(index, encoder.encode(token), position === tokens.length - 1),
    )
    // Cheapest first, so the expensive token walks a list that most documents have already failed
    // out of, and the last walk is the one that collects the survivors.
    .sort(
      (left, right) =>
        left.reduce((sum, match) => sum + match.postingCount, 0) -
        right.reduce((sum, match) => sum + match.postingCount, 0),
    );

  const { matched, hitCount, quality, touched } = index.accumulators;
  const everyToken = (1 << expansions.length) - 1;
  const candidates: number[] = [];
  for (let position = 0; position < expansions.length; position += 1) {
    const mark = 1 << position;
    const final = position === expansions.length - 1;
    for (const match of expansions[position]) {
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
        if (final && hitCount[doc] === tokens.length) {
          candidates.push(doc);
        }
      }
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
  const poolSize = limit * POOL_FACTOR;
  for (const doc of candidates) {
    if (wanted !== null && !wanted.has(unpackKind(index.kindFlags[doc]))) {
      continue;
    }
    const named = hitCount[doc];
    const linked = viaStreet.get(doc) ?? 0;
    const points = quality[doc] / QUALITY_SCALE;
    const { tokenCount } = unpackTokenInfo(index.tokenInfo[doc]);
    const place =
      prominenceFactor(index.prominence[doc]) *
      distanceFactor(metersFrom(index, doc, centre));
    // Scored here as though every word the document matched was a word of its own, which is the most
    // it can be worth; the pool is cut on that and the rescore below can only lower it, so nothing
    // that deserves a place in the answer is dropped here for a reason the name has not been read
    // for yet.
    const candidate = {
      doc,
      quality: points,
      named,
      linked,
      place,
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
  const finalists = pool.map(({ doc, quality, named, linked, place }) => {
    const name = docName(index, doc);
    const words = tokenize(name);
    const answered = named - doubledWords(tokens, words);
    const { tokenCount } = unpackTokenInfo(index.tokenInfo[doc]);
    const leads = words.length > 0 && words[0] === tokens[0];
    const whole = words.length > 0 && words.every((word) => typed.has(word));
    return {
      doc,
      name,
      score:
        // A word that only doubled up on another's takes its share of the quality with it: the
        // accumulator holds one sum for the document, not a figure per word.
        textScore(
          (quality * answered) / named,
          answered,
          linked,
          tokens.length,
          tokenCount,
        ) *
        place *
        (leads ? FIRST_WORD_BONUS : 1) *
        (whole ? WHOLE_NAME_BONUS : 1),
    };
  });
  finalists.sort((left, right) => betterThan(index, left, right));

  return finalists.slice(0, limit).map(({ doc, name, score }) => {
    const { placeIndex } = unpackTokenInfo(index.tokenInfo[doc]);
    return {
      doc,
      kind: unpackKind(index.kindFlags[doc]),
      name,
      lat: index.latUnits[doc] / COORD_SCALE,
      lng: index.lngUnits[doc] / COORD_SCALE,
      score,
      category:
        index.category[doc] === 0
          ? null
          : index.categories[index.category[doc] - 1],
      placeIndex,
      ...docPayload(index, doc),
    };
  });
}
