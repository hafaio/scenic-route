// crates/tiler is where the model math lives: the crown-weighted kernel density estimate, the
// cover transform, the Monte-Carlo cover distribution, the woodland mask, the tile pyramid and
// the street chunks. These two scripts fetch, encode and orchestrate; they call it for
// everything numeric.

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CRATE = join(ROOT, "crates", "tiler");

// cargo no-ops when the binary is already built, so `bun dev` and `bun export` still take no
// extra step. Its own progress goes to stderr; only the tiler's report comes back on stdout.
export function runTiler(args: string[], capture: boolean): string {
  const result = spawnSync(
    "cargo",
    ["run", "--release", "--bin", "tiler", "--", ...args],
    {
      cwd: ROOT,
      stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"],
      encoding: "utf-8",
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tiler ${args[0]} exited with ${result.status}`);
  }
  return result.stdout ?? "";
}

// The crate is an input to the tile build like any other: an edit to the kernel has to
// invalidate the pyramid the old one rendered.
export async function tilerSources(): Promise<string[]> {
  const sources = await readdir(join(CRATE, "src"));
  return [
    join(ROOT, "Cargo.toml"),
    join(CRATE, "Cargo.toml"),
    ...sources.map((file) => join(CRATE, "src", file)),
  ];
}
