"use client";

import type {
  FromSearchWorker,
  IndexHit,
  InitMessage,
  QueryMessage,
  ReverseHit,
  ReverseMessage,
} from "./protocol";

// The page's half of the search worker (./worker.ts), following the tile layer's pattern: one worker
// for the whole app, started on first use, told which city it is answering for and then asked one
// question at a time.
//
// A keystroke asked before the city's index has loaded is answered with null rather than waited on.
// The index is seven megabytes on a first visit, and blocking the box on it would make every early
// keystroke feel broken; null is "this source has nothing to say yet", which is exactly how the
// search box already treats an address file that has not arrived. Naming a dropped pin
// (`reverseNameIndex`) is the one thing here that does wait, because the pin has something to show
// in the meantime.

let worker: Worker | undefined;
// The city the worker was last told to load, and the one it has finished loading. They differ while
// a load is in flight, and after a failure the first goes back to null so the next ask retries.
let requested: string | null = null;
let ready: string | null = null;

let nextQuery = 1;
// The one question outstanding. A newer one supersedes it — the box has moved on, and its own
// request was aborted — so the older promise is answered with null rather than left to hang.
let asked: {
  id: number;
  resolve: (hits: IndexHit[] | null) => void;
} | null = null;

// And the one point waiting to be named, superseded the same way: a dragged endpoint asks what it is
// called several times a second, and an answer for a point it has already left is not an answer.
let named: {
  id: number;
  resolve: (hit: ReverseHit | null) => void;
} | null = null;

// Who is waiting for the files to finish loading. The search box never waits — an unanswered
// keystroke is worse than an empty list — but a pin does: it reads "Dropped pin" until the label
// arrives, and a label a second late is still the right label.
let waiting: (() => void)[] = [];

// How many pins are waiting to be named, and whether it was one of them that pulled the index in.
// The routing panel keeps the index for as long as it is open; a pin dropped while it is shut would
// otherwise leave twenty megabytes of decoded tables behind to name one point, so that copy is
// dropped again as soon as the label is built.
let naming = 0;
let heldForNaming = false;

function settle(hits: IndexHit[] | null): void {
  asked?.resolve(hits);
  asked = null;
}

function settleName(hit: ReverseHit | null): void {
  named?.resolve(hit);
  named = null;
}

function stopWaiting(): void {
  const waited = waiting;
  waiting = [];
  for (const resume of waited) {
    resume();
  }
}

function searchWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener(
      "message",
      ({ data }: MessageEvent<FromSearchWorker>) => {
        if (data.type === "ready") {
          ready = data.city;
          stopWaiting();
        } else if (data.type === "error") {
          if (requested === data.city) {
            requested = null; // a file this device could not fetch is retried, not remembered
          }
          console.error(`search index for ${data.city}:`, data.message);
          stopWaiting();
        } else if (data.type === "reverse") {
          if (named?.id === data.id) {
            settleName(data.hit);
          }
        } else if (asked?.id === data.id) {
          settle(data.hits);
        }
      },
    );
  }
  return worker;
}

function indexUrls(cityId: string): { searchUrl: string; addressUrl: string } {
  // Resolved against the document, since these paths pick up the basePath the deploy injects and a
  // relative URL inside a worker would resolve against its own chunk instead.
  return {
    searchUrl: new URL(`search/${cityId}.bin.gz`, document.baseURI).href,
    addressUrl: new URL(`addresses/${cityId}.bin.gz`, document.baseURI).href,
  };
}

// Pulls the two files onto the device without decoding either of them. An offline search that only
// answers for the city you happened to search while you still had signal is most of the way to no
// offline search at all — so the bytes are fetched for every visitor, since it is the network that
// goes away, not the memory. Only the reader who opens the search box pays for the index itself
// (`warmNameIndex`), which costs forty megabytes of decoded tables on a phone that is already
// carrying the routing graph.
//
// The bodies are read a chunk at a time and dropped: what this is for is the service worker's copy
// (src/sw/policy keeps both directories), and holding the whole download to throw it away would be
// most of the cost it exists to avoid.
export async function prefetchNameIndex(cityId: string): Promise<void> {
  if (requested === cityId) {
    return; // the worker is already reading them; a second fetch would only race its own cache
  }
  const { searchUrl, addressUrl } = indexUrls(cityId);
  await Promise.all(
    [searchUrl, addressUrl].map(async (url) => {
      try {
        const response = await fetch(url);
        const reader = response.body?.getReader();
        while (reader) {
          const { done } = await reader.read();
          if (done) {
            break;
          }
        }
      } catch {
        // No signal, or a file this deploy does not carry. The worker fetches them again when
        // someone actually searches, and reports its own failure then.
      }
    }),
  );
}

// Hands the files to the worker, which decodes them and holds them for the rest of the session.
function warm(cityId: string, forNaming: boolean): void {
  if (!forNaming) {
    heldForNaming = false; // the panel is open, and it keeps the index for as long as it is
  }
  if (requested === cityId) {
    return;
  }
  heldForNaming = forNaming;
  requested = cityId;
  ready = null;
  settle(null); // whatever was outstanding belonged to the city being left
  settleName(null);
  const message: InitMessage = {
    type: "init",
    city: cityId,
    ...indexUrls(cityId),
  };
  searchWorker().postMessage(message);
}

export function warmNameIndex(cityId: string): void {
  warm(cityId, false);
}

// Gives the decoded index back. Once the box is gone its tables are forty megabytes held against the
// next search that may never come; the files themselves stay on the device, so warming it again
// reads from disk rather than the network. A pin still waiting to be named is answered with null and
// keeps whatever label it already has.
export function releaseNameIndex(): void {
  if (!worker) {
    return;
  }
  worker.terminate();
  worker = undefined;
  requested = null;
  ready = null;
  heldForNaming = false;
  settle(null);
  settleName(null);
  stopWaiting();
}

// Where the map is, for the search box — which runs long before anything asks for a route and cannot
// take the camera as a prop. Set from the map's settled camera, and kept WITH the city it belongs
// to: a centre in Brooklyn says nothing about which of San Francisco's streets was meant, so after a
// switch it is ignored until the map settles over the new city.
let mapCentre: { cityId: string; at: { lat: number; lng: number } } | null =
  null;

export function setSearchCentre(
  cityId: string,
  at: { lat: number; lng: number },
): void {
  mapCentre = { cityId, at };
}

// Where the map is pointing, for a search over this city — null until it has settled over one, which
// is when the city's own centre stands in for it. Every result the index gives is ranked by how far
// it is from here.
export function searchCentre(
  cityId: string,
): { lat: number; lng: number } | null {
  return mapCentre !== null && mapCentre.cityId === cityId
    ? mapCentre.at
    : null;
}

export interface NameSearch {
  cityId: string;
  text: string;
  centre: { lat: number; lng: number };
  limit: number;
}

// The index's answers, or null where it has none to give yet — a city still loading, or one whose
// file this device has never managed to fetch.
export function searchNameIndex({
  cityId,
  text,
  centre,
  limit,
}: NameSearch): Promise<IndexHit[] | null> {
  warmNameIndex(cityId);
  if (ready !== cityId) {
    return Promise.resolve(null);
  }
  settle(null);
  const id = nextQuery;
  nextQuery += 1;
  const message: QueryMessage = {
    type: "query",
    id,
    text,
    centre,
    limit,
  };
  searchWorker().postMessage(message);
  return new Promise((resolve) => {
    asked = { id, resolve };
  });
}

// What a point on the map is called, out of the same two files the box searches: the nearest house
// number, or the name of whatever the point is standing on. Null where the city has nothing near
// enough — a pin in the middle of the harbour keeps whatever the caller already put on it.
//
// This one waits for the index rather than answering without it, because a pin has something to show
// in the meantime and nothing to lose by being labelled a second late.
export async function reverseNameIndex(
  cityId: string,
  at: { lat: number; lng: number },
): Promise<ReverseHit | null> {
  naming += 1;
  try {
    warm(cityId, true);
    if (ready !== cityId) {
      await new Promise<void>((resume) => waiting.push(resume));
    }
    if (ready !== cityId) {
      return null; // the files never arrived, or the reader left for another city
    }
    settleName(null); // an older pin has been superseded by this one
    const id = nextQuery;
    nextQuery += 1;
    const message: ReverseMessage = { type: "reverse", id, at };
    searchWorker().postMessage(message);
    return await new Promise<ReverseHit | null>((resolve) => {
      named = { id, resolve };
    });
  } finally {
    naming -= 1;
    if (naming === 0 && heldForNaming) {
      releaseNameIndex();
    }
  }
}
