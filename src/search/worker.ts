import { formatHouseNumber } from "./address-format";
import { type AddressIndex, fetchAddresses } from "./addresses";
import type {
  FromSearchWorker,
  IndexHit,
  InitMessage,
  ToSearchWorker,
} from "./protocol";
import {
  decodeSearchIndex,
  type SearchHit,
  type SearchIndex,
  type SearchRequest,
  searchNames,
} from "./search-query";

// The search box's own thread. It owns one city's SRCH index (./search-format.ts) and the address
// file the labels come out of, and answers a keystroke against them.
//
// Off the main thread because of what a keystroke costs here: New York's index is twelve megabytes
// that have to be gunzipped and walked once before anything can be answered, and the answer itself
// reads posting lists that can run to tens of thousands of entries. None of that may land in the
// frame a map pan is drawing — and the load in particular would otherwise freeze the app for the
// half second it takes.
//
// The query itself is ./search-query.ts, which knows nothing about workers: this is a message loop
// around it, so a test can ask the same question of the same code without one.

// `self` types as a Window under the app's dom lib, so the worker scope is named through globalThis
// instead of pulling the conflicting webworker lib into the build — the same dodge src/tiles/worker.ts
// uses.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToSearchWorker>) => void) | null;
  postMessage(message: FromSearchWorker): void;
};

interface Loaded {
  city: string;
  index: SearchIndex;
  addresses: AddressIndex;
}

let loaded: Loaded | null = null;
// The city a load is running for, so a second init for the same one does not start a second fetch
// and a switch away from it makes its answer stale on arrival.
let wanted: string | null = null;

async function load({
  city,
  searchUrl,
  addressUrl,
}: InitMessage): Promise<void> {
  if (wanted === city) {
    return;
  }
  wanted = city;
  loaded = null;
  try {
    // Together, because neither is any use without the other: an index whose labels cannot be built
    // would list "Katz's Delicatessen" five times with nothing to tell the branches apart.
    const [index, addresses] = await Promise.all([
      fetchIndex(searchUrl),
      fetchAddresses(addressUrl),
    ]);
    if (wanted !== city) {
      return; // the reader moved to another city while this was in flight
    }
    loaded = { city, index, addresses };
    scope.postMessage({ type: "ready", city });
  } catch (error) {
    if (wanted === city) {
      wanted = null; // a failed load is retried, not remembered
      scope.postMessage({ type: "error", city, message: String(error) });
    }
  }
}

async function fetchIndex(url: string): Promise<SearchIndex> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  // Shipped gzipped and unpacked here, as the address file is: Pages serves .bin uncompressed.
  const unpacked = response.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = await new Response(unpacked).arrayBuffer();
  return decodeSearchIndex(new Uint8Array(bytes));
}

// The line under a result's name: the door it sits at and the borough it is in, from the address
// file the ordinals in the index point into. A place that never joined an address still names its
// borough — the builder takes that from the city's own boundaries — and a city that is one place
// names nothing.
function labelOf(addresses: AddressIndex, hit: SearchHit): string {
  const parts: string[] = [];
  if (hit.streetIndex >= 0 && hit.number !== null) {
    const name = addresses.names[addresses.streetName[hit.streetIndex]];
    parts.push(`${formatHouseNumber(hit.number)} ${name}`);
  }
  const place = addresses.places[hit.placeIndex];
  if (place !== undefined) {
    parts.push(place);
  }
  return parts.join(", ");
}

// An unloaded index answers nothing rather than not answering: the page holds its questions until
// `ready`, so an empty list here is only reachable in the moment after a city switch, and a silence
// would leave the asking side waiting forever.
function look(city: Loaded | null, request: SearchRequest): IndexHit[] {
  if (city === null) {
    return [];
  } else {
    return searchNames(city.index, request).map((hit) => ({
      kind: hit.kind,
      name: hit.name,
      label: labelOf(city.addresses, hit),
      lat: hit.lat,
      lng: hit.lng,
      score: hit.score,
      category: hit.category,
    }));
  }
}

scope.onmessage = ({ data }: MessageEvent<ToSearchWorker>) => {
  if (data.type === "init") {
    void load(data);
  } else {
    const { id, text, centre, limit, kinds } = data;
    scope.postMessage({
      type: "results",
      id,
      hits: look(loaded, { text, centre, limit, kinds }),
    });
  }
};
