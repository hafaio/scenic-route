// The token dictionary of a SRCH index (./search-format.ts): how it is read, and how a word that was
// typed wrong is found in it.
//
// The dictionary is a bytewise-sorted list of every word in the city, front-coded — each entry
// stores only what it does NOT share with the one before it, plus the length of what it does. That
// is a trie written down: the shared-prefix length says how many levels the walk just popped, and a
// whole subtree is "the run of entries whose shared prefix stays at least this long".
//
// Which is exactly what a misspelling needs. Finding every word within one or two edits of "theatr"
// means running the edit-distance table against every word in the city, and the table's rows for a
// shared prefix are the same rows — so a walk down the sorted list computes each row once and reuses
// it for every word underneath, and when a prefix is already too far wrong it skips the entire
// subtree by reading shared-prefix bytes without decoding a single word. Nothing is shipped for any
// of this: it is a walk over the dictionary the file already carries.
//
// The alternative would be a compiled Levenshtein automaton, which is what Lucene does; it pays off
// against dictionaries of millions of words intersected with an FST, and this one is 98,000 words in
// under half a megabyte.

import { type Cursor, readUnsignedVarint } from "../tiles/varint";
import { DICT_BLOCK, RESTART_BYTES } from "./search-format";

// What the walk needs of a decoded index, which is where its regions are. Named separately from the
// index itself so this module does not depend on the query that uses it.
export interface TokenDictionary {
  bytes: Uint8Array;
  restarts: DataView; // the fixed-width restart table, the only region read as u32
  restartCount: number;
  tokenCount: number;
  dictStart: number;
  postingsStart: number;
}

// Where a walk over the dictionary is: the token it has just read, spelt out from the front-coded
// tail, and where that token's postings start. `index` is the dictionary position, so that a caller
// can tell a run's extent; `lcp` is what the entry shares with the one before it, which is what the
// fuzzy walk pops its rows by.
export interface DictCursor {
  token: Uint8Array;
  length: number;
  lcp: number;
  tailStart: number; // where the bytes this entry does not share with the one before it are
  entry: number;
  posting: number;
  index: number;
  postingCount: number;
  postingBytes: number;
}

export function dictCursorAt(
  dictionary: TokenDictionary,
  block: number,
): DictCursor {
  const restart = block * RESTART_BYTES;
  return {
    token: new Uint8Array(64),
    length: 0,
    lcp: 0,
    tailStart: 0,
    entry: dictionary.dictStart + dictionary.restarts.getUint32(restart, true),
    posting:
      dictionary.postingsStart +
      dictionary.restarts.getUint32(restart + 4, true),
    index: block * DICT_BLOCK,
    postingCount: 0,
    postingBytes: 0,
  };
}

// One shared reader, because the walk that uses it steps a hundred thousand entries and a cursor
// object per entry is a hundred thousand allocations. It never outlives the call it is used in.
const reading: Cursor = { offset: 0 };

// Reads the next entry's numbers into the cursor. False at the end of the dictionary; the previous
// entry's postings are stepped over on the way, which is what `postingBytes` is stored for. The
// token's own bytes are NOT assembled — `dictToken` does that, and a walk that is skipping this
// entry never asks.
export function stepDict(
  dictionary: TokenDictionary,
  cursor: DictCursor,
): boolean {
  if (cursor.index >= dictionary.tokenCount) {
    return false;
  }
  cursor.posting += cursor.postingBytes;
  reading.offset = cursor.entry;
  const lcp = readUnsignedVarint(dictionary.bytes, reading);
  const tail = readUnsignedVarint(dictionary.bytes, reading);
  cursor.lcp = lcp;
  cursor.length = lcp + tail;
  cursor.tailStart = reading.offset;
  reading.offset += tail;
  cursor.postingCount = readUnsignedVarint(dictionary.bytes, reading);
  cursor.postingBytes = readUnsignedVarint(dictionary.bytes, reading);
  cursor.entry = reading.offset;
  cursor.index += 1;
  return true;
}

// Spells the current entry out into `cursor.token`, which is only ever the tail: what the entry
// shares with its predecessor is already in the buffer, and stays right even across entries the walk
// skipped, since a skipped entry shares those bytes with the last one spelt out or it would not have
// been skipped.
export function dictToken(
  dictionary: TokenDictionary,
  cursor: DictCursor,
): void {
  if (cursor.length > cursor.token.length) {
    const grown = new Uint8Array(cursor.length + 64);
    grown.set(cursor.token);
    cursor.token = grown;
  }
  for (let at = cursor.lcp; at < cursor.length; at += 1) {
    cursor.token[at] = dictionary.bytes[cursor.tailStart + at - cursor.lcp];
  }
}

// The first token of a block, read without decoding anything: a block's first entry has a shared
// prefix of zero, so its tail IS the token.
export function blockToken(
  dictionary: TokenDictionary,
  block: number,
): Uint8Array {
  const entry: Cursor = {
    offset:
      dictionary.dictStart +
      dictionary.restarts.getUint32(block * RESTART_BYTES, true),
  };
  readUnsignedVarint(dictionary.bytes, entry);
  const tail = readUnsignedVarint(dictionary.bytes, entry);
  return dictionary.bytes.subarray(entry.offset, entry.offset + tail);
}

// Words this short are not worth correcting: at three letters nearly every word in the city is one
// edit from nearly every other, so "the" would answer with "she", "tea" and "th", and every one of
// them drags its own thousands of documents in.
export const FUZZY_MIN_LENGTH = 4;
// And this long is where a second edit is affordable: two edits of a five-letter word is most of it,
// while two of "delicatessen" is still unmistakably that word.
export const FUZZY_FAR_LENGTH = 7;

// How wrong a word of this length may be spelt and still be looked for. Zero is "do not look".
export function maxEditDistance(length: number): number {
  if (length < FUZZY_MIN_LENGTH) {
    return 0;
  } else if (length < FUZZY_FAR_LENGTH) {
    return 1;
  } else {
    return 2;
  }
}

// One dictionary token the misspelt word reached.
export interface FuzzyMatch {
  postings: number;
  postingCount: number;
  // Edits between the word and `matchedLength` bytes of the token. Zero where the token simply
  // carries the word as a prefix, which is the ordinary prefix match arrived at by another road.
  distance: number;
  // How many leading bytes of the token the query was measured against, never fewer than one.
  matchedLength: number;
  tokenLength: number;
}

// Every dictionary token whose start is within `maxDistance` edits of `query`, with the fewest bytes
// of it that get there. An edit is an inserted, deleted or substituted byte, or a swap of two
// adjacent ones — "tehater" is one mistake, not two, because it is one slip of the fingers.
//
// The distance is measured against a PREFIX of each token rather than the whole of it, because the
// word being typed is usually unfinished: "delicatesen" has to reach "delicatessens" as well as
// "delicatessen". A token accepted at some prefix length takes every token underneath it with it —
// they share those bytes, so they match at the same distance, and they are the contiguous run of
// entries whose shared prefix does not drop below it.
//
// Distances are counted in UTF-8 bytes, which is characters for everything either city writes in the
// Latin alphabet and is stricter than characters for the few hundred names that are not: a CJK name
// is two or three bytes a character, so it is effectively held to exact spelling. That is the right
// way round — a substitution inside a multi-byte character is not a typo anyone makes.
//
// Nothing here is pinned to the first character, so a word whose FIRST letter is wrong is still
// found, and so is one with a letter missing off the front: "izza" reaches "pizza".
export function fuzzyMatches(
  dictionary: TokenDictionary,
  query: Uint8Array,
  maxDistance: number,
): FuzzyMatch[] {
  const queryLength = query.length;
  // Anything at this distance or beyond is out of reach, so distances are clamped here rather than
  // being allowed to grow: the whole table only has to tell "within" from "not".
  const unreachable = maxDistance + 1;

  // One row of the edit-distance table per byte of the token consumed so far, row `depth` holding
  // the distances between the whole query and the token's first `depth` bytes. Kept as a stack
  // because that is what makes the front-coding pay: moving to the next token pops to the bytes the
  // two share and extends from there, so a shared prefix is measured once however many words carry
  // it.
  const rows: Int32Array[] = [new Int32Array(queryLength + 1)];
  for (let cell = 0; cell <= queryLength; cell += 1) {
    rows[0][cell] = Math.min(cell, unreachable);
  }

  const matches: FuzzyMatch[] = [];
  const cursor = dictCursorAt(dictionary, 0);
  // How many of the current token's bytes the rows above are valid for.
  let depth = 0;
  // The prefix length at which the walk gave up, so every entry still carrying that many bytes is
  // skipped unread, and the prefix length at which it succeeded, so every entry still carrying THAT
  // many bytes is taken unread. At most one of the two is set.
  let doomed = -1;
  let accepted = -1;
  let acceptedDistance = 0;

  while (stepDict(dictionary, cursor)) {
    if (accepted >= 0) {
      if (cursor.lcp >= accepted) {
        matches.push({
          postings: cursor.posting,
          postingCount: cursor.postingCount,
          distance: acceptedDistance,
          matchedLength: accepted,
          tokenLength: cursor.length,
        });
        continue;
      }
      accepted = -1;
    } else if (doomed >= 0) {
      if (cursor.lcp >= doomed) {
        continue;
      }
      doomed = -1;
    }
    // A run ends at a block start whatever the two tokens share, since the format stores a shared
    // prefix of zero there so that a block decodes on its own. The rows are simply rebuilt, which
    // costs at most one token in sixteen and needs no special case.
    depth = Math.min(depth, cursor.lcp);
    dictToken(dictionary, cursor);

    let distance = -1;
    let hopeless = false;
    while (depth < cursor.length) {
      const previous = rows[depth];
      const swapped = depth >= 1 ? rows[depth - 1] : null;
      const tokenByte = cursor.token[depth];
      const beforeByte = depth >= 1 ? cursor.token[depth - 1] : -1;
      depth += 1;
      if (rows.length === depth) {
        rows.push(new Int32Array(queryLength + 1));
      }
      const row = rows[depth];
      // Only the cells within `maxDistance` of the diagonal can hold a distance worth having: cell
      // `j` of row `i` is at least |i − j|, since that many bytes have to be added or dropped.
      const low = Math.max(1, depth - maxDistance);
      const high = Math.min(queryLength, depth + maxDistance);
      // Deleting every byte of the token consumed so far, which is what an empty query costs.
      row[0] = Math.min(depth, unreachable);
      // The cells on either side of the band, which the row itself and the two rows after it read
      // over their shoulder, and which otherwise hold whatever an earlier token left there.
      if (low >= 2) {
        row[low - 1] = unreachable;
      }
      if (high < queryLength) {
        row[high + 1] = unreachable;
      }
      let best = row[0];
      for (let cell = low; cell <= high; cell += 1) {
        let value = Math.min(
          previous[cell] + 1, // a byte of the token the query does not have
          row[cell - 1] + 1, // a byte of the query the token does not have
          previous[cell - 1] + (query[cell - 1] === tokenByte ? 0 : 1), // the same byte, or one for the other
        );
        if (
          swapped !== null &&
          cell >= 2 &&
          query[cell - 1] === beforeByte &&
          query[cell - 2] === tokenByte
        ) {
          value = Math.min(value, swapped[cell - 2] + 1); // the two bytes the other way round
        }
        row[cell] = Math.min(value, unreachable);
        if (row[cell] < best) {
          best = row[cell];
        }
      }
      // The query is spent against this much of the token, so the token and everything under it
      // matches and none of it needs measuring further.
      if (
        low <= queryLength &&
        high === queryLength &&
        row[queryLength] <= maxDistance
      ) {
        distance = row[queryLength];
        break;
      }
      // Every cell of the row is already too far, and rows only ever grow: nothing carrying these
      // bytes can come back.
      if (best > maxDistance) {
        hopeless = true;
        break;
      }
    }

    if (distance >= 0) {
      accepted = depth;
      acceptedDistance = distance;
      matches.push({
        postings: cursor.posting,
        postingCount: cursor.postingCount,
        distance,
        matchedLength: depth,
        tokenLength: cursor.length,
      });
    } else if (hopeless) {
      doomed = depth;
    }
  }
  return matches;
}

// Whether one word reaches another the way the walk above says it does: within `maxDistance` edits
// of some start of it. The walk answers that for every word in the city at once, which is what a
// query needs; this answers it for one pair, which is what a scorer holding two decoded words needs
// — and both have to answer it the same way, or a word the query matched would score as one it did
// not. The table is the same, without the stack the dictionary order pays for.
export function reachesWithinEdits(
  query: Uint8Array,
  token: Uint8Array,
  maxDistance: number,
): boolean {
  const unreachable = maxDistance + 1;
  const rows = [
    new Int32Array(query.length + 1),
    new Int32Array(query.length + 1),
    new Int32Array(query.length + 1),
  ];
  for (let cell = 0; cell <= query.length; cell += 1) {
    rows[0][cell] = Math.min(cell, unreachable);
  }
  if (rows[0][query.length] <= maxDistance) {
    return true;
  }
  for (let depth = 1; depth <= token.length; depth += 1) {
    const row = rows[depth % 3];
    const previous = rows[(depth + 2) % 3];
    const swapped = rows[(depth + 1) % 3];
    row[0] = Math.min(depth, unreachable);
    let best = row[0];
    for (let cell = 1; cell <= query.length; cell += 1) {
      let value = Math.min(
        previous[cell] + 1,
        row[cell - 1] + 1,
        previous[cell - 1] + (query[cell - 1] === token[depth - 1] ? 0 : 1),
      );
      if (
        depth >= 2 &&
        cell >= 2 &&
        query[cell - 1] === token[depth - 2] &&
        query[cell - 2] === token[depth - 1]
      ) {
        value = Math.min(value, swapped[cell - 2] + 1);
      }
      row[cell] = Math.min(value, unreachable);
      if (row[cell] < best) {
        best = row[cell];
      }
    }
    if (row[query.length] <= maxDistance) {
      return true;
    }
    if (best > maxDistance) {
      return false;
    }
  }
  return false;
}
