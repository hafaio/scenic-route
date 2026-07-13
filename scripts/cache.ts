// A disk cache for the raw source reads: the network paging is the whole cost of a re-run,
// everything downstream of it is seconds. Entries live in .cache/ (gitignored) and never
// expire on their own — the sources move about once a year, so a re-run wants whatever it
// read last time, not a fresher copy it did not ask for.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR = join(import.meta.dirname, "..", ".cache");

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

// The key is the request itself — dataset plus query, or the Overpass QL — so changing what
// is asked for lands on a different entry rather than silently reusing the old one.
export async function cached<Value>(
  name: string,
  key: string,
  read: () => Promise<Value>,
): Promise<Value> {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const path = join(CACHE_DIR, `${name}.${digest}.json`);

  if (!REFRESH) {
    const hit = await readFile(path, "utf-8").catch(() => null);
    const entry = hit === null ? null : parse<Value>(hit);
    if (entry !== null) {
      console.error(`  ${name}: from .cache`);
      return entry.value;
    }
  }

  const value = await read();
  await mkdir(CACHE_DIR, { recursive: true });
  // Renamed on, so an entry is either the whole value or absent: these run to tens of
  // megabytes, and an interrupted write would otherwise leave a torn one behind.
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
  return value;
}
