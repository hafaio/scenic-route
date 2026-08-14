// crates/tiler is where the model math lives: the blurred measured-canopy cover field, the
// Monte-Carlo cover distribution, the tile pyramids and the street chunks. These two scripts
// fetch, encode and orchestrate; they call it for everything numeric.

import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CRATE = join(ROOT, "crates", "tiler");

// cargo no-ops when the binary is already built, so `bun dev` and `bun export` still take no
// extra step. Its own progress goes to stderr; only the tiler's report comes back on stdout.
//
// `debug` is for `key-probe` alone (scripts/graph-inputs.ts), which runs on every push and pull
// request rather than on the deploy: the release profile is lto + one codegen unit and takes minutes
// to link, while the probe reads a 268 KB fixture and finishes in under a tenth of a second, so the
// optimizer buys it nothing. Both profiles give that fixture the same key hash — nothing on the key
// path is float-derived in a way rustc is free to reassociate — and the recorded stamp and the
// checked one are computed the same way regardless.
export function runTiler(
  args: string[],
  capture: boolean,
  debug = false,
): string {
  const result = spawnSync(
    "cargo",
    ["run", ...(debug ? [] : ["--release"]), "--bin", "tiler", "--", ...args],
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
// invalidate the pyramid the old one rendered. Cargo.lock rides along because a dependency the
// geometry goes through can move the bytes without a line of this crate changing.
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
    join(CRATE, "Cargo.toml"),
    ...sources,
  ];
}

// A mosaic's tiles, handed over as a file. Several hundred paths is more than a command line should
// carry, so every flag that takes one of these — `--dem`, `--chm-mosaic` — takes a list instead.
export async function writeList(
  name: string,
  paths: string[],
): Promise<string> {
  const path = join(tmpdir(), `scenic-${name}.txt`);
  await writeFile(path, `${paths.join("\n")}\n`);
  return path;
}
