// crates/tiler is where the model math lives: the blurred measured-canopy cover field, the
// Monte-Carlo cover distribution, the tile pyramids, the street chunks and the routing graph.
//
// No TypeScript spawns it. package.json sequences every cargo run there is — the tile build, the
// ingest and the key-space probe — and the scripts on either side hand their work over as files.
// What is left here is the one thing the tiler is an INPUT to rather than the runner of.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CRATE = join(ROOT, "crates", "tiler");

// The crate is an input to the tile build like any other: an edit to the kernel has to
// invalidate the pyramid the old one rendered. Cargo.lock rides along because a dependency the
// geometry goes through can move the bytes without a line of this crate changing, and
// rust-toolchain.toml because a compiler bump can move a low bit of `sin` and with it a shadow.
// What the tiler does with these is not quite a hash of the bytes: it rehashes each .rs file over
// its token stream, so a comment invalidates nothing.
export async function tilerSources(): Promise<string[]> {
  const sources: string[] = [];
  const pending = [join(CRATE, "src")];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else {
        sources.push(path);
      }
    }
  }
  return [
    join(ROOT, "Cargo.toml"),
    join(ROOT, "Cargo.lock"),
    join(ROOT, "rust-toolchain.toml"),
    join(CRATE, "Cargo.toml"),
    ...sources,
  ];
}
