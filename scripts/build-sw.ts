// `bun run export`, last step: bundles src/sw/ into out/sw.js, the service worker the deploy serves.
// It runs after `next build` because two of the things it bakes in only exist once the export does —
// the hashed chunk filenames of the app shell, and nothing else in the tree to precache.
//
// The committed public/sw.js is a stub that caches nothing, and `next build` copies it into out/;
// this overwrites it. Keeping the stub committed is what lets a dev server register a worker (which
// is what makes the browser offer to install the app) without a cache that could serve a stale shell
// against the hashed chunks a static export names.

import { execFileSync } from "node:child_process";
import { access, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "out");

// The app itself, as against the data it reads: what has to be on disk for the map to open at all
// with no network. Everything else is fetched on use and cached as it arrives.
//
// `_next/static/` is taken whole rather than filtered. It is the export's own output, already
// content-hashed and already minimal, and picking through it by extension is how a precache ends up
// missing the one chunk that a cold offline start needs.
const SHELL_FILES = ["index.html", "404.html", "manifest.webmanifest"];
const SHELL_DIRS = ["_next/static", "icons"];

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// Every named file has to be there, and every named directory has to hold something. A precache
// listing a file the export did not emit makes `cache.addAll` reject on install, which does not fail
// loudly — it means the worker never installs at all, and nothing downstream of here would notice.
async function precacheList(): Promise<string[]> {
  const found: string[] = [];
  for (const file of SHELL_FILES) {
    const path = join(OUT, file);
    if (!(await exists(path))) {
      throw new Error(`out/${file} is missing — did \`next build\` finish?`);
    }
    found.push(path);
  }
  for (const dir of SHELL_DIRS) {
    const under = await filesUnder(join(OUT, dir));
    if (under.length === 0) {
      throw new Error(`out/${dir} is empty — did \`next build\` finish?`);
    }
    found.push(...under);
  }
  // Relative to the worker's scope, which is its own directory — the site root under whatever
  // basePath the deploy injected. Resolved against `registration.scope` in the worker, so nothing
  // here has to know what that basePath turned out to be.
  return found.map((file) => relative(OUT, file).split("\\").join("/")).sort();
}

// The deploy's identity. Any change at all gives the worker new cache names, and the old ones are
// deleted on activate — which is what makes a deploy a clean slate rather than a merge.
function version(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi) {
    return fromCi;
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

const precache = await precacheList();

// Bun's bundler API. Declared locally rather than through @types/bun, whose globals disagree with
// the DOM lib this tsconfig builds against — and the CLI has no `--define`, which is the whole point
// of using it here.
declare const Bun: {
  build(options: {
    entrypoints: string[];
    target: "browser";
    format: "iife";
    minify: boolean;
    define: Record<string, string>;
  }): Promise<{
    success: boolean;
    logs: unknown[];
    outputs: { text(): Promise<string> }[];
  }>;
};

const stamp = version();
const built = await Bun.build({
  entrypoints: [join(ROOT, "src/sw/worker.ts")],
  target: "browser",
  // A classic script, not a module: `navigator.serviceWorker.register` is called without
  // `{ type: "module" }`, and module workers are still not everywhere.
  format: "iife",
  minify: true,
  define: {
    SW_VERSION: JSON.stringify(stamp),
    SW_PRECACHE: JSON.stringify(precache),
  },
});
if (!built.success) {
  throw new AggregateError(built.logs, "could not bundle the service worker");
}

await writeFile(join(OUT, "sw.js"), await built.outputs[0].text());
console.log(`sw.js: ${precache.length} shell files precached at ${stamp}`);
