"use client";

import type {
  FromSearchWorker,
  IndexHit,
  InitMessage,
  QueryMessage,
} from "./protocol";

// The page's half of the search worker (./worker.ts), following the tile layer's pattern: one worker
// for the whole app, started on first use, told which city it is answering for and then asked one
// question at a time.
//
// A question asked before the city's index has loaded is answered with null rather than waited on.
// The index is seven megabytes on a first visit, and blocking the box on it would make every early
// keystroke feel broken; null is "this source has nothing to say yet", which is exactly how the
// search box already treats an address file that has not arrived.

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

function settle(hits: IndexHit[] | null): void {
  asked?.resolve(hits);
  asked = null;
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
        } else if (data.type === "error") {
          if (requested === data.city) {
            requested = null; // a file this device could not fetch is retried, not remembered
          }
          console.error(`search index for ${data.city}:`, data.message);
        } else if (asked?.id === data.id) {
          settle(data.hits);
        }
      },
    );
  }
  return worker;
}

// Fetches a city's index before anything is typed at it, the way the address file is warmed and for
// the same reason: an offline search that only answers for the city you happened to search while you
// still had signal is most of the way to no offline search at all.
export function warmNameIndex(cityId: string): void {
  if (requested === cityId) {
    return;
  }
  requested = cityId;
  ready = null;
  settle(null); // whatever was outstanding belonged to the city being left
  // Resolved against the document, since these paths pick up the basePath the deploy injects and a
  // relative URL inside a worker would resolve against its own chunk instead.
  const message: InitMessage = {
    type: "init",
    city: cityId,
    searchUrl: new URL(`search/${cityId}.bin.gz`, document.baseURI).href,
    addressUrl: new URL(`addresses/${cityId}.bin.gz`, document.baseURI).href,
  };
  searchWorker().postMessage(message);
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
