// What the caches hold, and in what order it may go.
//
// The Cache API will not say how big a cache is, and finding out means reading every entry back out
// of it. So the worker keeps its own book: a row per cached response with its size and when it was
// last read, plus a running total per store, updated in the same transaction as the rows so the
// total cannot drift from what it claims to sum.
//
// Kept apart from worker.ts because it is the one part of the worker with durable state of its own,
// and because everything here is ordinary IndexedDB rather than anything service-worker-shaped.
//
// Every operation issues its follow-up request from inside the previous one's `onsuccess` rather
// than `await`ing between them. An IndexedDB transaction commits as soon as its requests settle with
// nothing new queued, so an `await` in the middle of one is a transaction that has already closed by
// the time the next line runs.

const DB_NAME = "scenic-route-sw";
const DB_VERSION = 2;
const ENTRIES = "entries";
const TOTALS = "totals";
// The worker's own settings, as against its accounting. Kept here rather than in a cache because it
// has to outlive a deploy: `wipe()` empties the two stores above by name and leaves this one, which
// is the point — the reader's cap is not something a release gets to forget.
const CONFIG = "config";
// Oldest-read first within one store, which is the order an eviction walks.
const BY_AGE = "by-age";

interface Row {
  store: string;
  url: string;
  bytes: number;
  at: number;
}

interface Total {
  store: string;
  bytes: number;
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // Additive: a version bump creates what is missing and leaves what is there. Dropping the
    // stores and rebuilding them would throw away the accounting for caches that survived the
    // upgrade, and an unaccounted cache is one nothing can evict from until it has been refilled.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES)) {
        db.createObjectStore(ENTRIES, {
          keyPath: ["store", "url"],
        }).createIndex(BY_AGE, ["store", "at"]);
      }
      if (!db.objectStoreNames.contains(TOTALS)) {
        db.createObjectStore(TOTALS, { keyPath: "store" });
      }
      if (!db.objectStoreNames.contains(CONFIG)) {
        db.createObjectStore(CONFIG, { keyPath: "key" });
      }
    };
    // The page reads this book too (the settings page's "kept" figure), so two agents now hold
    // connections to it. Same version, they coexist; a version bump does not — an open connection
    // blocks the upgrade, and without these two the pending open would simply never settle and the
    // holder would never let go.
    request.onblocked = () => {
      reject(new Error("the ledger is open elsewhere at an older version"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      reject(request.error);
    };
  }).catch((error: unknown) => {
    // A browser with storage switched off, or a private window that refuses. Retried next time; the
    // callers all treat a failure here as "no accounting", not as a failure to cache.
    opening = null;
    throw error;
  });
  return opening;
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error);
    };
    transaction.onabort = () => {
      reject(transaction.error);
    };
  });
}

function addTotal(totals: IDBObjectStore, store: string, delta: number): void {
  const current = totals.get(store);
  current.onsuccess = () => {
    const total = current.result as Total | undefined;
    totals.put({
      store,
      bytes: Math.max(0, (total?.bytes ?? 0) + delta),
    } satisfies Total);
  };
}

// Write one entry down. An entry that was already there is REPLACED rather than added, so a re-fetch
// of the same tile does not count twice — which is the whole reason the total is kept beside the
// rows rather than added up from puts.
export async function record(
  store: string,
  url: string,
  bytes: number,
  now: number,
): Promise<void> {
  const db = await open();
  const transaction = db.transaction([ENTRIES, TOTALS], "readwrite");
  const entries = transaction.objectStore(ENTRIES);
  const totals = transaction.objectStore(TOTALS);
  const previous = entries.get([store, url]);
  previous.onsuccess = () => {
    const row = previous.result as Row | undefined;
    entries.put({ store, url, bytes, at: now } satisfies Row);
    addTotal(totals, store, bytes - (row?.bytes ?? 0));
  };
  await finished(transaction);
}

// Mark an entry read, so an eviction takes what nobody has looked at in a while. Callers throttle
// this: a pan asks for dozens of tiles and every one of them is a hit.
export async function touch(
  store: string,
  url: string,
  now: number,
): Promise<void> {
  const db = await open();
  const transaction = db.transaction(ENTRIES, "readwrite");
  const entries = transaction.objectStore(ENTRIES);
  const existing = entries.get([store, url]);
  existing.onsuccess = () => {
    const row = existing.result as Row | undefined;
    if (row) {
      entries.put({ ...row, at: now } satisfies Row);
    }
  };
  await finished(transaction);
}

export async function forget(store: string, urls: string[]): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  const db = await open();
  const transaction = db.transaction([ENTRIES, TOTALS], "readwrite");
  const entries = transaction.objectStore(ENTRIES);
  const totals = transaction.objectStore(TOTALS);
  let freed = 0;
  let outstanding = urls.length;
  for (const url of urls) {
    const existing = entries.get([store, url]);
    existing.onsuccess = () => {
      const row = existing.result as Row | undefined;
      if (row) {
        freed += row.bytes;
        entries.delete([store, url]);
      }
      outstanding -= 1;
      if (outstanding === 0) {
        addTotal(totals, store, -freed);
      }
    };
  }
  await finished(transaction);
}

// Which entries have to go for this store to fit under its cap, oldest read first. Returned rather
// than deleted here because the cache and the book have to change together, and only the caller
// holds the cache.
export async function overflowing(
  store: string,
  cap: number,
): Promise<string[]> {
  const db = await open();
  const transaction = db.transaction([ENTRIES, TOTALS], "readonly");
  const doomed: string[] = [];
  const total = transaction.objectStore(TOTALS).get(store);
  total.onsuccess = () => {
    let over = ((total.result as Total | undefined)?.bytes ?? 0) - cap;
    if (over <= 0) {
      return;
    }
    const walk = transaction
      .objectStore(ENTRIES)
      .index(BY_AGE)
      .openCursor(
        IDBKeyRange.bound(
          [store, Number.NEGATIVE_INFINITY],
          [store, Number.POSITIVE_INFINITY],
        ),
      );
    walk.onsuccess = () => {
      const cursor = walk.result;
      if (!cursor || over <= 0) {
        return;
      }
      const row = cursor.value as Row;
      doomed.push(row.url);
      over -= row.bytes;
      cursor.continue();
    };
  };
  await finished(transaction);
  return doomed;
}

// What each store is holding, for the page to report. Read straight out of the book rather than
// asked of the worker, because it is ordinary same-origin IndexedDB and a worker that has been
// stopped between requests would have to be woken to answer.
export async function totals(): Promise<Record<string, number>> {
  const db = await open();
  const transaction = db.transaction(TOTALS, "readonly");
  const all = transaction.objectStore(TOTALS).getAll();
  const held: Record<string, number> = {};
  all.onsuccess = () => {
    for (const { store, bytes } of all.result as Total[]) {
      held[store] = bytes;
    }
  };
  await finished(transaction);
  return held;
}

// One of the worker's own settings, which survive a deploy where the accounting does not.
export async function readConfig(key: string): Promise<unknown> {
  const db = await open();
  const transaction = db.transaction(CONFIG, "readonly");
  const request = transaction.objectStore(CONFIG).get(key);
  let value: unknown;
  request.onsuccess = () => {
    value = (request.result as { value?: unknown } | undefined)?.value;
  };
  await finished(transaction);
  return value;
}

export async function writeConfig(key: string, value: unknown): Promise<void> {
  const db = await open();
  const transaction = db.transaction(CONFIG, "readwrite");
  transaction.objectStore(CONFIG).put({ key, value });
  await finished(transaction);
}

// The accounting only, for a deploy: activate deletes every cache not carrying the new version, and
// the book is then about caches that no longer exist. The config store is deliberately not touched.
export async function wipe(): Promise<void> {
  const db = await open();
  const transaction = db.transaction([ENTRIES, TOTALS], "readwrite");
  transaction.objectStore(ENTRIES).clear();
  transaction.objectStore(TOTALS).clear();
  await finished(transaction);
}
