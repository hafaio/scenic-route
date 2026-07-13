// A disk cache for the raw source reads, so that iterating on the model does not mean
// re-downloading it. The city's ~900k trees and ~120k street segments are a few minutes
// of paging over the network and are the whole cost of a re-run; everything downstream of
// them is seconds. Entries live in .cache/ (gitignored) and never expire on their own —
// pass --refresh to go back to the network and overwrite them.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR = join(import.meta.dirname, "..", ".cache");

// The sources are refreshed on the order of once a year, so what a re-run wants is
// whatever it read last time, not a fresher copy it did not ask for.
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

// The key is the request itself — dataset plus query, or the Overpass QL — so changing
// what is asked for lands on a different entry rather than silently reusing the old one.
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
  // Written aside and renamed on, so an entry is either the whole value or absent: these
  // are tens of megabytes, and an interrupted write would otherwise leave a torn one.
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
  return value;
}
