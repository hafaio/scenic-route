import { type Filed, fileRequest, type Store, shadeKey } from "./policy";

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

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
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
  registration: { scope: string };
  clients: { claim(): Promise<void> };
};

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
      // Not the same thing as skipWaiting: this only takes clients an older worker has already let
      // go of, and on a first-ever visit it is what puts the page under the worker without a reload.
      await scope.clients.claim();
    })(),
  );
});

scope.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  if (request.destination === "worker") {
    event.respondWith(serveWorkerScript(event));
    return;
  }
  const filed = fileRequest(request.url, scope.registration.scope);
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
        event.waitUntil(cache.put(request, response.clone()));
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
  const hit = await cache.match(request);
  if (hit) {
    return hit;
  }
  const response = await fetch(request);
  // Only 200s. A 404 is a fact about the deploy — the shade pyramids are sparse on purpose, and a
  // caster chunk over water was never written — and storing one would freeze that fact past the
  // deploy that changes it. Leaving it uncached also keeps the page's own distinction intact: a 404
  // is "nothing here", a rejected fetch is "could not reach", and the two must not converge.
  if (response.ok) {
    event.waitUntil(cache.put(request, response.clone()));
    event.waitUntil(keepOneSeason(filed.path));
  }
  return response;
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
  for (const store of ["overlay", "routing"] as const) {
    const cache = await caches.open(STORES[store]);
    for (const request of await cache.keys()) {
      const filed = fileRequest(request.url, scope.registration.scope);
      const key = filed && shadeKey(filed.path);
      if (key && key.city === city && table.get(key.bin) !== season) {
        await cache.delete(request);
      }
    }
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
