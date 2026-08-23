// What the service worker is allowed to cache and where it puts it. Pure functions over URLs, kept
// apart from the worker itself so they can be tested without a ServiceWorkerGlobalScope.
//
// The worker owns storage policy and nothing else. It never decides what to FETCH — the page already
// does that, and keeps doing it unchanged — so "cache what was asked for, bounded by the rules here"
// comes out as "the city you are looking at, on the day you picked" without the worker knowing which
// city or which day that is.

// Where a cached response lives. The split is not tidiness: the routing graph is the one artifact a
// walk in progress cannot do without, and a long scrub through the clock filling the overlay store
// must never be able to evict it.
export type Store = "shell" | "routing" | "overlay";

// The two artifacts a daily job rewrites in place on the default branch, read straight from raw
// rather than out of the deploy so a walk today is not costed against last week's timetable.
const FEED_HOST = "raw.githubusercontent.com";
const FEED_PREFIX = "/hafaio/scenic-route/main/public/";
const FEED_DIRS = ["sheds/", "ferry-schedule/"];

// The exported app itself, as against the data it reads.
const SHELL_FILES = ["", "index.html", "404.html", "manifest.webmanifest"];
const SHELL_DIRS = ["_next/", "icons/"];

// One request, as the worker files it: the path relative to the worker's scope, and the store it
// belongs in. Null for anything the worker does not handle, which it then leaves entirely alone —
// no `respondWith`, so the request behaves exactly as it would with no worker installed.
export interface Filed {
  path: string;
  store: Store;
  // Network first, falling back to the cache. Only the two daily feeds: a stale timetable is worse
  // than a slow one, and they are the only things here that change without a deploy.
  fresh: boolean;
}

export function fileRequest(url: string, scope: string): Filed | null {
  const target = new URL(url);
  if (target.host === FEED_HOST) {
    const dir = target.pathname.startsWith(FEED_PREFIX)
      ? target.pathname.slice(FEED_PREFIX.length)
      : null;
    if (dir !== null && FEED_DIRS.some((feed) => dir.startsWith(feed))) {
      return { path: dir, store: "routing", fresh: true };
    }
    return null;
  }
  const root = new URL(scope);
  if (
    target.origin !== root.origin ||
    !target.pathname.startsWith(root.pathname)
  ) {
    return null; // the basemap, Firestore, auth: another origin's business
  }
  // The pathname alone. A share link's `#at=...` rides along on a navigation's request URL, and
  // filing by the whole href would make every distinct link its own cache entry for the same page.
  const path = target.pathname.slice(root.pathname.length);
  if (path === "sw.js") {
    return null; // the worker must never serve itself, or a deploy could never replace it
  }
  if (
    SHELL_FILES.includes(path) ||
    SHELL_DIRS.some((dir) => path.startsWith(dir))
  ) {
    return { path, store: "shell", fresh: false };
  }
  // Everything else under the scope is the deploy's own data. Stated as the default rather than as a
  // list of directories on purpose: a list is one more place to forget a new layer, and forgetting
  // one here would silently leave it out of the offline story with nothing to notice it by.
  return {
    path,
    store: path.startsWith("routing/") ? "routing" : "overlay",
    fresh: false,
  };
}

// The (city, bin) a shade artifact names, or null where the path is not one. Three shapes carry a
// bin: the two display pyramids and the routing fractions.
//
//   tiles/shade/<city>/<bin>/<z>/<x>/<y>.webp
//   tiles/tree-shade/<city>/<bin>/<z>/<x>/<y>.webp
//   routing/shade/<city>/<bin>.bin
export interface ShadeKey {
  city: string;
  bin: number;
}

export function shadeKey(path: string): ShadeKey | null {
  const parts = path.split("/");
  const [head, kind, city, fourth] = parts;
  if (head === "tiles" && (kind === "shade" || kind === "tree-shade")) {
    // Not `buckets.json`, which sits exactly where a bin directory would and is what the season
    // lookup itself reads.
    const bin = binNumber(fourth);
    return bin === null || parts.length < 5 ? null : { city, bin };
  }
  if (head === "routing" && kind === "shade" && parts.length === 4) {
    const bin = fourth?.endsWith(".bin")
      ? binNumber(fourth.slice(0, -".bin".length))
      : null;
    return bin === null ? null : { city, bin };
  }
  return null;
}

// A city's routing graph, which is the one cached thing a walk in progress cannot be without. It is
// fetched once and then read from memory for the rest of the session, so its last-READ time never
// moves — under a least-recently-read eviction it is the first thing out of the routing store, which
// is the exact opposite of what should happen. Nothing evicts it.
export function isGraph(path: string): boolean {
  return /^routing\/[^/]+\.bin$/.test(path);
}

function binNumber(text: string | undefined): number | null {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
}
