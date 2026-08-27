import {
  forget,
  overflowing,
  readConfig,
  record,
  touch,
  wipe,
  writeConfig,
} from "./ledger";
import {
  type Filed,
  fileRequest,
  isGraph,
  type Store,
  shadeKey,
} from "./policy";

// The service worker. It owns storage policy — what may enter a cache, what evicts what, and when a
// deploy destroys the lot — and nothing else. It never decides what to fetch: the page asks for
// exactly what it asks for today, and learns about failures the same way it would with no worker
// installed, because a cache miss while offline rejects rather than answering with a 404.
//
// Built by scripts/build-sw.ts into out/sw.js, which is what the deploy serves. The committed
// public/sw.js is a stub with no caching at all, and is what a dev server serves.

// Replaced at build time. The version is the deploy's git sha, so any deploy at all is a new set of
// cache names and the old ones go on activate; the precache list is the exported shell.
declare const SW_VERSION: string;
declare const SW_PRECACHE: readonly string[];
// The cities' extents, so the basemap is kept only over ground this app can route across.
declare const SW_CITIES: readonly {
  west: number;
  south: number;
  east: number;
  north: number;
}[];

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface MessageEventLike extends ExtendableEventLike {
  data: unknown;
}

// `self` types as a Window under the app's dom lib, so the worker scope is named through globalThis
// instead of pulling the conflicting webworker lib into the build — the same dodge src/tiles/worker.ts
// uses.
const scope = globalThis as unknown as {
  addEventListener(
    type: "install" | "activate",
    handler: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(
    type: "fetch",
    handler: (event: FetchEventLike) => void,
  ): void;
  addEventListener(
    type: "message",
    handler: (event: MessageEventLike) => void,
  ): void;
  registration: { scope: string };
  clients: { claim(): Promise<void> };
};

// What each store may grow to. The shell has no cap — it is precached, bounded by the export, and
// losing a piece of it is the one thing that would stop the app opening at all.
//
// Neither number is a quota: the quota is a large fraction of the disk and both are well under it.
// They are sized so ONE city fits comfortably and a second city's residue is what gets pushed out —
// New York walked over at every zoom comes to roughly 400 MB of overlay, so a gigabyte leaves room
// to wander without ever evicting ground the reader is still using. Routing is generous for the same
// reason from the other end: it holds one graph per city plus one day of bins and the two files the
// search box answers from, about 71 MB for both cities together, and evicting any of it mid-walk is
// exactly what the split exists to prevent.
// The overlay figure here is only the starting point: the reader's own, once they have chosen one,
// is in the book (OVERLAY_CAP). Routing's is not offered as a setting at all.
const CAPS: Partial<Record<Store, number>> = {
  routing: 128 * 1024 * 1024,
  overlay: 1024 * 1024 * 1024,
};

// The reader's overlay cap, read from the book once and then held: it is asked for on the way into
// every cache write, and the worker is stopped and restarted often enough that re-reading it each
// time would put an IndexedDB round trip on that path.
//
// Three states, and they have to stay three: `undefined` is "not read yet", which is the only one
// the built-in figure covers; `null` is the reader choosing NO cap, which the built-in figure would
// silently override; and a number is theirs. Collapsing the first two makes "everything I look at"
// mean "one gigabyte, permanently".
const OVERLAY_CAP = "overlay-cap";
let overlayCap: number | null | undefined;
// The page's message is what STARTS a stopped worker, so it routinely arrives before this read
// comes back — and the value it comes back with is then the one from before that message. Once a
// message has set the cap, the read has nothing left to say.
let capFromPage = false;
const capLoaded = readConfig(OVERLAY_CAP)
  .then((stored) => {
    // Nothing written down at all leaves it `undefined`, which is the built-in figure. A stored
    // `null` is the reader's "no cap" and is not the same answer.
    if (!capFromPage && stored !== undefined) {
      overlayCap = typeof stored === "number" ? stored : null;
    }
  })
  .catch(() => undefined);

function capFor(which: Store): number {
  if (which === "overlay" && overlayCap !== undefined) {
    return overlayCap ?? Number.POSITIVE_INFINITY;
  } else {
    return CAPS[which] ?? Number.POSITIVE_INFINITY;
  }
}

// How stale an entry's read time may be before a hit is worth writing down. A pan asks for dozens of
// tiles at once and every one of them is a hit; recording each would put the eviction order's own
// bookkeeping on the critical path of every draw.
const TOUCH_AFTER_MS = 10 * 60 * 1000;

const STORES: Record<Store, string> = {
  shell: `shell-${SW_VERSION}`,
  routing: `routing-${SW_VERSION}`,
  overlay: `overlay-${SW_VERSION}`,
};
const CURRENT = new Set(Object.values(STORES));

// Where a city's kept shade season is written down, so the rule survives the browser stopping the
// worker between requests. Under the scope and inside a real cache, because that is the only storage
// a worker has that a deploy's purge already knows how to destroy.
const seasonMarker = (city: string): string =>
  `${scope.registration.scope}__sw/shade-season/${city}`;

scope.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STORES.shell);
      await cache.addAll(
        SW_PRECACHE.map((file) => new URL(file, scope.registration.scope).href),
      );
    })(),
  );
});

// Deliberately no skipWaiting: a new deploy takes over when the last tab closes, or on the installed
// app's next launch. The cost is running one deploy behind for a session; the alternative is a
// just-activated worker purging chunks a still-open page is about to lazily import.
scope.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (!CURRENT.has(name)) {
          await caches.delete(name);
        }
      }
      // The book is about caches that no longer exist.
      await wipe().catch(() => {});
      // Not the same thing as skipWaiting: this only takes clients an older worker has already let
      // go of, and on a first-ever visit it is what puts the page under the worker without a reload.
      await scope.clients.claim();
    })(),
  );
});

// The page's half of the two settings the worker owns. It is told rather than asked: the worker is
// stopped between requests, so anything it had to be woken to answer would be a round trip on the
// settings page's first paint. See components/service-worker.tsx.
scope.addEventListener("message", (event) => {
  const message = event.data as
    | { type: "overlay-cap"; bytes: number | null }
    | { type: "clear-overlays" }
    | undefined;
  if (message?.type === "overlay-cap") {
    event.waitUntil(setOverlayCap(message.bytes));
  } else if (message?.type === "clear-overlays") {
    event.waitUntil(clearOverlays());
  }
});

// A cap the reader lowered takes effect now rather than at the next tile: the point of choosing a
// smaller one is usually to get the space back. `null` is "no cap", which is stored as such so it
// survives a restart — falling back to the built-in figure would silently re-impose one.
async function setOverlayCap(bytes: number | null): Promise<void> {
  capFromPage = true;
  overlayCap = bytes;
  await writeConfig(OVERLAY_CAP, bytes).catch(() => {});
  await evict("overlay", capFor("overlay"));
}

// Only the worker can do this: the cache carries the deploy's own sha in its name, which the page
// has no way to know.
async function clearOverlays(): Promise<void> {
  const cache = await caches.open(STORES.overlay);
  const keys = await cache.keys();
  for (const request of keys) {
    await cache.delete(request);
  }
  await forget(
    "overlay",
    keys.map(({ url }) => url),
  ).catch(() => {});
}

scope.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  if (request.destination === "worker") {
    event.respondWith(serveWorkerScript(event));
    return;
  }
  const filed = fileRequest(request.url, scope.registration.scope, SW_CITIES);
  if (filed) {
    event.respondWith(serve(event, filed));
  }
  // Everything else — the basemap, Firestore, auth — goes without `respondWith`, which leaves it
  // behaving exactly as it would with no worker installed.
});

// The one request that cannot be answered with a cached Response object. Turbopack hands a worker
// its bootstrap config in the script URL's FRAGMENT, and a fragment is not part of a request's URL
// as far as fetch is concerned — so a worker whose script came back as a stored Response takes that
// Response's fragment-less URL as its own `location`, finds no config, and throws before it starts.
// A network response, or a fresh Response built from a stored body, leaves the fragment alone.
async function serveWorkerScript(event: FetchEventLike): Promise<Response> {
  const { request } = event;
  const cache = await caches.open(STORES.shell);
  try {
    const response = await fetch(request);
    if (response.ok) {
      event.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  } catch (error) {
    const stored = await cache.match(request);
    if (!stored) {
      throw error;
    }
    return new Response(await stored.blob(), {
      headers: stored.headers,
    });
  }
}

async function serve(event: FetchEventLike, filed: Filed): Promise<Response> {
  const { request } = event;
  if (filed.store === "shell" && request.mode === "navigate") {
    return await servePage(request);
  }
  const cache = await caches.open(STORES[filed.store]);
  if (filed.fresh) {
    // The daily feeds. A stale shed permit or ferry timetable is worse than a slow one, so the
    // network wins whenever there is one; the cache is only what an offline walk falls back to.
    try {
      const response = await fetch(request);
      if (response.ok) {
        event.waitUntil(store(filed.store, request.url, response.clone()));
      }
      return response;
    } catch (error) {
      const stale = await cache.match(request);
      if (stale) {
        return stale;
      }
      throw error;
    }
  }
  const key = filed.cacheKey ?? request.url;
  const hit = await cache.match(key);
  if (hit) {
    event.waitUntil(read(filed.store, key));
    return hit;
  }
  const response = await fetch(request);
  // Only 200s. A 404 is a fact about the deploy — the shade pyramids are sparse on purpose, and a
  // caster chunk over water was never written — and storing one would freeze that fact past the
  // deploy that changes it. Leaving it uncached also keeps the page's own distinction intact: a 404
  // is "nothing here", a rejected fetch is "could not reach", and the two must not converge.
  if (response.ok) {
    event.waitUntil(store(filed.store, key, response.clone()));
    event.waitUntil(keepOneSeason(filed.path));
  }
  return response;
}

// Everything that writes to a cache goes through here, so nothing can land in one without also
// landing in the book that bounds it.
async function store(
  which: Store,
  key: string,
  response: Response,
): Promise<void> {
  const cache = await caches.open(STORES[which]);
  // Read out as a blob first, so a retry has something to build a second Response from: a Response
  // whose body a failed `put` already touched cannot be cloned.
  const body = await response.blob();
  await capLoaded;
  const cap = capFor(which);
  const copy = (): Response =>
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  let stored = await put(cache, key, copy());
  if (!stored) {
    // Out of quota, whatever this store's own cap says — the browser's is origin-wide and something
    // else may have filled it. Nothing here is irreplaceable, so free half of this store and take
    // one more run at it. If that fails too, the response has already gone to the page and the only
    // thing lost is having kept it.
    await evict(which, cap === Number.POSITIVE_INFINITY ? 0 : cap / 2);
    stored = await put(cache, key, copy());
  }
  if (stored) {
    await record(which, key, body.size, Date.now()).catch(() => {});
    await evict(which, cap);
  }
}

// Whether it went in. A cache write can fail for one reason worth acting on — the quota — and the
// book must not claim bytes the cache does not hold.
async function put(
  cache: Cache,
  key: string,
  response: Response,
): Promise<boolean> {
  try {
    await cache.put(key, response);
    return true;
  } catch {
    return false;
  }
}

// A hit, written down only when the entry's recorded read time has gone stale — see TOUCH_AFTER_MS.
const lastRead = new Map<string, number>();

async function read(which: Store, url: string): Promise<void> {
  const now = Date.now();
  if (now - (lastRead.get(url) ?? 0) < TOUCH_AFTER_MS) {
    return;
  }
  lastRead.set(url, now);
  await touch(which, url, now).catch(() => {});
}

// Drop the least recently read entries until the store fits.
async function evict(which: Store, cap: number): Promise<void> {
  if (cap === Number.POSITIVE_INFINITY) {
    return;
  }
  const over = await overflowing(which, cap).catch(() => [] as string[]);
  const doomed = over.filter((url) => {
    const filed = fileRequest(url, scope.registration.scope, SW_CITIES);
    return !filed || !isGraph(filed.path);
  });
  if (doomed.length === 0) {
    return;
  }
  const cache = await caches.open(STORES[which]);
  for (const url of doomed) {
    await cache.delete(url);
  }
  await forget(which, doomed).catch(() => {});
}

// A navigation, answered by the one page the export has. The precache holds it as `index.html`,
// while the address bar asks for the directory and a share link asks for it with a `#at=...` on the
// end; all three are the same page. Nothing here is written back — the precache owns the shell, and
// caching navigations would file one copy of it per share link.
async function servePage(request: Request): Promise<Response> {
  const cache = await caches.open(STORES.shell);
  const page = await cache.match(
    new URL("index.html", scope.registration.scope).href,
  );
  return page ?? (await fetch(request));
}

// One day of shade, which is one SEASON of the baked pyramids: a season is sunrise to sunset for one
// day, seven to eleven bins of it. The worker does not know which day the reader picked and does not
// need to — the page only ever asks for the picked day's bins, so keeping the season of the last one
// asked for keeps exactly that day.
//
// Reconciled by season rather than by bin index because the two display pyramids and the routing
// fractions all number their bins the same way, so one lookup covers all three.
const kept = new Map<string, number>();
const purging = new Set<string>();

async function keepOneSeason(path: string): Promise<void> {
  const key = shadeKey(path);
  if (!key) {
    return;
  }
  const table = await seasonsFor(key.city);
  const season = table?.get(key.bin);
  if (!table || season === undefined) {
    return; // no season map to reconcile against; better to keep everything than to guess
  }
  const marked = kept.get(key.city) ?? (await markedSeason(key.city));
  if (marked === season || purging.has(key.city)) {
    return;
  }
  // Written before the sweep, not after: the next request must not start a second one.
  kept.set(key.city, season);
  purging.add(key.city);
  try {
    const cache = await caches.open(STORES.overlay);
    await cache.put(seasonMarker(key.city), new Response(String(season)));
    await purgeOtherSeasons(key.city, season, table);
  } finally {
    purging.delete(key.city);
  }
}

async function markedSeason(city: string): Promise<number | null> {
  const cache = await caches.open(STORES.overlay);
  const marker = await cache.match(seasonMarker(city));
  if (!marker) {
    return null;
  }
  const season = Number(await marker.text());
  kept.set(city, season);
  return season;
}

async function purgeOtherSeasons(
  city: string,
  season: number,
  table: ReadonlyMap<number, number>,
): Promise<void> {
  for (const which of ["overlay", "routing"] as const) {
    const cache = await caches.open(STORES[which]);
    const doomed: string[] = [];
    for (const request of await cache.keys()) {
      const filed = fileRequest(
        request.url,
        scope.registration.scope,
        SW_CITIES,
      );
      const key = filed && shadeKey(filed.path);
      if (key && key.city === city && table.get(key.bin) !== season) {
        doomed.push(request.url);
      }
    }
    for (const url of doomed) {
      await cache.delete(url);
    }
    await forget(which, doomed).catch(() => {});
  }
}

// Bin index to season, from the display pyramid's own manifest. Fetched through the worker's cache
// like anything else, so the rule still applies on a walk with no network — and memoised, since the
// browser keeps the worker alive across a burst of tile requests and this is read on every one.
const tables = new Map<string, Promise<ReadonlyMap<number, number> | null>>();

function seasonsFor(city: string): Promise<ReadonlyMap<number, number> | null> {
  const pending = tables.get(city);
  if (pending) {
    return pending;
  }
  const url = new URL(
    `tiles/shade/${city}/buckets.json`,
    scope.registration.scope,
  ).href;
  const request = (async () => {
    const cache = await caches.open(STORES.overlay);
    const response = (await cache.match(url)) ?? (await fetch(url));
    if (!response.ok) {
      throw new Error(`${url}: ${response.status}`);
    }
    const buckets = (await response.json()) as {
      index: number;
      season: number;
    }[];
    return new Map(buckets.map(({ index, season }) => [index, season]));
  })().catch(() => {
    tables.delete(city); // a lookup that could not be reached is retried, not remembered as absent
    return null;
  });
  tables.set(city, request);
  return request;
}
