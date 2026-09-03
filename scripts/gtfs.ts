// A minimal GTFS reader for the ferry and subway ingests: it downloads a feed zip (through the disk
// cache), unzips it in memory and parses the handful of CSV tables they read. It leans on
// node:zlib for the one deflate step and parses the central directory by hand, so it pulls in no
// zip dependency; the CSV reader it parses the tables with is scripts/csv.ts. See scripts/README.md.

import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import pRetry from "p-retry";
import { cached, cachedFile } from "./cache";
import { type CsvRow, parseCsv } from "./csv";

// A browser-ish User-Agent: NYC DOT's Akamai edge answers the plain download with a 403 unless the
// request looks like a browser. The NYC Ferry endpoint does not care, but the header is harmless
// there, so both feeds send it.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

// One parsed GTFS table: the header row keys each record, so a column is read by its name and a
// column a feed omits simply comes back undefined rather than shifting every field.
export type GtfsRow = CsvRow;

// The tables the ferry consolidation reads. calendar_dates and frequencies are often empty (a
// header only) or absent; either way they parse to an empty array.
export interface GtfsFeed {
  routes: GtfsRow[];
  trips: GtfsRow[];
  stops: GtfsRow[];
  stopTimes: GtfsRow[];
  calendar: GtfsRow[];
  calendarDates: GtfsRow[];
  shapes: GtfsRow[];
  frequencies: GtfsRow[];
  // The agency's own transfer table: which stops it says a rider can walk between. Absent from
  // Muni's feed, which is why the station merge keeps a geometric fallback (../src/subway/format).
  transfers: GtfsRow[];
}

async function download(url: string): Promise<Uint8Array> {
  try {
    return await pRetry(
      async () => {
        const response = await fetch(url, {
          headers: { "user-agent": BROWSER_USER_AGENT, accept: "*/*" },
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      {
        retries: MAX_ATTEMPTS - 1,
        minTimeout: RETRY_BASE_MS,
        maxTimeout: RETRY_CAP_MS,
        randomize: true,
        onFailedAttempt: ({ error, attemptNumber }) => {
          console.error(
            `  attempt ${attemptNumber}/${MAX_ATTEMPTS} failed: ${error}`,
          );
        },
      },
    );
  } catch (error) {
    throw new Error(`failed to fetch ${url}: ${error}`);
  }
}

// Downloads a feed zip once and keeps it in .cache/ as base64 (the cache stores JSON, so the raw
// bytes ride as a string). The ingest also freezes the returned bytes under data/ferries/, so a
// later time-of-day pass can re-derive from the exact feeds this build read.
export async function fetchGtfsZip(
  name: string,
  url: string,
): Promise<Uint8Array> {
  const base64 = await cached(name, url, async () => {
    console.error(`  ${name}: downloading ${url}`);
    return Buffer.from(await download(url)).toString("base64");
  });
  return new Uint8Array(Buffer.from(base64, "base64"));
}

// The same download for a feed that is only read, never frozen under data/: the raw-bytes cache
// entry rather than fetchGtfsZip's base64-inside-JSON one, which costs a third more disk and a
// parse of the whole string on every hit. The subway feed is 5.3 MiB of zip.
export async function fetchGtfsZipFile(
  name: string,
  url: string,
): Promise<Uint8Array> {
  const path = await cachedFile(name, url, async () => {
    console.error(`  ${name}: downloading ${url}`);
    return await download(url);
  });
  return new Uint8Array(await readFile(path));
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_BYTES = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// The offset of the End Of Central Directory record: it is at the tail, before an optional
// comment, so the last 64 KiB are scanned back for its signature.
function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const earliest = Math.max(0, bytes.length - 0x10000 - 22);
  for (let offset = bytes.length - 22; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("not a zip: no end-of-central-directory record");
}

// The entries a zip's central directory names, each mapped to the bytes of its file. Only the
// central directory is trusted for sizes and the compression method — a local header may defer
// them to a trailing data descriptor — so every entry is read through its central record.
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes, view);
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);

  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let entry = 0; entry < entryCount; entry++) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${entry}`);
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart =
      localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let contents: Uint8Array;
    if (method === METHOD_STORED) {
      contents = compressed;
    } else if (method === METHOD_DEFLATE) {
      contents = new Uint8Array(inflateRawSync(compressed));
    } else {
      throw new Error(`${name}: unsupported zip compression method ${method}`);
    }
    files.set(name, contents);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// The name of a table within the zip, matched by basename so a feed that nests its files under a
// folder (the SI Ferry zip is a `siferry-gtfs_2026.1/` directory) is read the same as a flat one.
function readTable(files: Map<string, Uint8Array>, table: string): GtfsRow[] {
  const decoder = new TextDecoder();
  for (const [name, contents] of files) {
    if (name === `${table}.txt` || name.endsWith(`/${table}.txt`)) {
      return parseCsv(decoder.decode(contents));
    }
  }
  return [];
}

// Unzips a feed and parses the tables the ferry consolidation reads. A table the feed omits comes
// back as an empty array, which is what the consolidation expects for calendar_dates/frequencies.
export function parseGtfs(zip: Uint8Array): GtfsFeed {
  const files = unzip(zip);
  return {
    routes: readTable(files, "routes"),
    trips: readTable(files, "trips"),
    stops: readTable(files, "stops"),
    stopTimes: readTable(files, "stop_times"),
    calendar: readTable(files, "calendar"),
    calendarDates: readTable(files, "calendar_dates"),
    shapes: readTable(files, "shapes"),
    frequencies: readTable(files, "frequencies"),
    transfers: readTable(files, "transfers"),
  };
}
