// A disk cache for the raw source reads: the network paging is the whole cost of a re-run,
// everything downstream of it is seconds. Entries live in .cache/ (gitignored) and never
// expire on their own — the sources move about once a year, so a re-run wants whatever it
// read last time, not a fresher copy it did not ask for.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Also where a build input too big to hold in memory is cut up — see scripts/alcc.ts.
export const CACHE_DIR = join(import.meta.dirname, "..", ".cache");

const REFRESH =
  process.argv.includes("--refresh") || process.env.REFRESH === "1";

// Wrapped, so a cached `null` is still told apart from a body that would not parse.
function parse<Value>(body: string): { value: Value } | null {
  try {
    return { value: JSON.parse(body) as Value };
  } catch {
    return null;
  }
}

function entryPath(name: string, key: string, extension: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(CACHE_DIR, `${name}.${digest}.${extension}`);
}

// Renamed on, so a file is either whole or absent: these run to hundreds of megabytes, and an
// interrupted write would otherwise leave a torn one behind. Exported because the build inputs cut
// up beside the cache (scripts/alcc.ts) want the same guarantee for the same reason — a truncated
// raster is read as a tile that would not decode rather than as an error.
export async function writeAtomic(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

// The key is the request itself — dataset plus query, or the Overpass QL — so changing what
// is asked for lands on a different entry rather than silently reusing the old one. `quiet` is for
// a read split into hundreds of cached batches, which reports its own progress and would otherwise
// bury the build log in hit notices.
export async function cached<Value>(
  name: string,
  key: string,
  read: () => Promise<Value>,
  quiet = false,
): Promise<Value> {
  const path = entryPath(name, key, "json");

  if (!REFRESH) {
    const hit = await readFile(path, "utf-8").catch(() => null);
    const entry = hit === null ? null : parse<Value>(hit);
    if (entry !== null) {
      if (!quiet) {
        console.error(`  ${name}: from .cache`);
      }
      return entry.value;
    }
  }

  const value = await read();
  await writeAtomic(path, JSON.stringify(value));
  return value;
}

// The same cache for a source that is raw bytes rather than JSON — a raster the tiler reads off
// disk itself — so the caller is handed the entry's path instead of its contents.
export async function cachedFile(
  name: string,
  key: string,
  read: () => Promise<Uint8Array>,
): Promise<string> {
  const path = entryPath(name, key, "bin");

  if (!REFRESH && (await stat(path).catch(() => null)) !== null) {
    console.error(`  ${name}: from .cache`);
    return path;
  }

  await writeAtomic(path, await read());
  return path;
}
