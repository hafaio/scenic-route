import { activeCity, cityById } from "./cities";
import {
  reverseNameIndex,
  searchCentre,
  searchNameIndex,
} from "./search/name-search";
import type { IndexHit, ReverseHit } from "./search/protocol";
import { sharedQueries } from "./share-target";

// What the app calls a place, in both directions: what was typed into the search box, and what a
// point picked off the map is called. Neither needs a network — both are answered from the city's
// own index and address file, which ship with the map.

// How many searches are remembered. Only the box's answers are cached; naming a point is arithmetic
// against tables already in memory and is cheaper to redo than to keep.
const MAX_CACHE_ENTRIES = 200;

// The `type` a station result carries, which the search box renders with a train glyph rather than
// leaving it to read as an address.
export const SUBWAY_RESULT_TYPE = "subway-station";
// How many of a station's routes are listed before the rest become an ellipsis. Times Sq serves ten.
const MAX_ROUTE_BULLETS = 4;

export interface GeocodeResult {
  placeId: string;
  lat: number;
  lng: number;
  displayName: string;
  type: string;
  // Whether this is the thing that was asked for rather than the nearest the city could offer: the
  // house number typed, not the door two along from it. What `exactAddressMatch` below reads.
  exact: boolean;
}

const searchCache = new Map<string, GeocodeResult[]>();

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

// A street, which is the coarsest answer there is: one point stands for the whole of it. The search
// box draws it with its own glyph, so that reads at a glance.
export const STREET_RESULT_TYPE = "scenic:street";

// A place out of the city's own name index (src/search/search-format.ts) — a business, a park, a
// campus. Its own type, so the box draws it as a place rather than as an address.
export const INDEX_RESULT_TYPE = "scenic:index";

// A house number found in the city's own address file. Its own glyph in the search box, and its own
// type here, because it is the most precise answer the box can give.
export const ADDRESS_RESULT_TYPE = "scenic:address";

// The `type` a point named off the map carries, mapped from what the index says the thing is, so a
// dropped pin reads with the same glyph the same place would carry in the search box.
function reverseResultType(kind: ReverseHit["kind"]): string {
  if (kind === "address") {
    return ADDRESS_RESULT_TYPE;
  } else if (kind === "station") {
    return SUBWAY_RESULT_TYPE;
  } else if (kind === "street") {
    return STREET_RESULT_TYPE;
  } else {
    return INDEX_RESULT_TYPE;
  }
}

// What a point picked off the map is called: a dropped pin, a dragged route endpoint, "Log here".
// The label is all this is for — a route is computed from the coordinate, and nothing about finding
// or drawing one depends on what the endpoint is called.
//
// Answered from the city's own address file and name index (src/search/reverse.ts), which is to say
// with no network at all: the nearest house number, or the name of whatever the point is standing
// on, or — where the number is too far off to be this point's — the street, the neighbourhood, or
// nothing. A point the city has nothing near enough to name is answered with null, and the caller
// keeps whatever it already put on the pin. Nothing is ever invented: every answer is a row of a
// file, at the coordinates the city published for it.
//
// Not cached. The lookup that used to sit here was a round trip to a public service with a usage
// policy that required caching its answers; this is a few milliseconds of arithmetic against tables
// already in memory, and a cache of two hundred pins would cost more to hold than to recompute.
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<GeocodeResult | null> {
  const cityId = activeCity().id;
  const hit = await reverseNameIndex(cityId, { lat, lng });
  if (hit === null) {
    return null;
  }
  // "near" is the honest half of the answer: the point is not AT this, it is beside it.
  const name = hit.at ? hit.name : `near ${hit.name}`;
  return {
    placeId: `local:${cityId}:${hit.kind}:${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}`,
    lat: hit.lat,
    lng: hit.lng,
    displayName: [name, hit.label].filter(Boolean).join(", "),
    type: reverseResultType(hit.kind),
    exact: hit.at,
  };
}

// How many answers the index is asked for. It ranks a door, a station, a park and a street against
// each other, so what leads is whatever the one ranking put first.
const MAX_LOCAL_RESULTS = 8;

// What the row reads as. A station says so and lists the routes it serves, since "Bedford Av" is a
// street and a station and the difference is the whole reason a rider typed it; everything else is
// its name and the line under it, with the name left off where the line already opens with it.
function localDisplayName(hit: IndexHit): string {
  if (hit.kind === "station") {
    const routes = hit.category === null ? [] : hit.category.split("/");
    const bullets = routes.slice(0, MAX_ROUTE_BULLETS).join("/");
    const shown = routes.length > MAX_ROUTE_BULLETS ? `${bullets}…` : bullets;
    return shown
      ? `${hit.name} (${shown}) — subway station`
      : `${hit.name} — subway station`;
  } else if (hit.label.startsWith(hit.name)) {
    return hit.label;
  } else {
    return [hit.name, hit.label].filter(Boolean).join(", ");
  }
}

// Which glyph the box draws beside it: a door, a train, a signpost, or a pin.
function localResultType(hit: IndexHit): string {
  if (hit.exact !== null) {
    return ADDRESS_RESULT_TYPE;
  } else if (hit.kind === "station") {
    return SUBWAY_RESULT_TYPE;
  } else if (hit.kind === "street") {
    return STREET_RESULT_TYPE;
  } else {
    return INDEX_RESULT_TYPE;
  }
}

// The one answer confident enough to route to without asking: the door that was asked for, sitting
// at the top of the list. Everything else is a guess — a near-miss house number, a street standing
// for the whole of itself, a park that happens to share a word — and a guess quietly set as the
// destination is worse than a list to pick from. What a link's textual destination is decided by.
export function exactAddressMatch(
  results: readonly GeocodeResult[],
): GeocodeResult | null {
  const [top] = results;
  if (top?.exact === true && top.type === ADDRESS_RESULT_TYPE) {
    return top;
  } else {
    return null;
  }
}

// `cityId` defaults to whichever city is live, which is what the search box wants — it has no city of
// its own and asks about the one on screen. A caller that captured a city and must keep answering
// about THAT one, however long the index takes to arrive, names it instead.
export async function searchAddress(
  query: string,
  cityId: string = activeCity().id,
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  // The map centre is part of the answer, not just of its order: the name index ranks by distance
  // from it, so the same query at two ends of the city is two different lists. Rounded to ~1 km, the
  // scale the distance term works at, so panning a block does not throw the cache away.
  const centre =
    searchCentre(cityId) ?? (cityById(cityId) ?? activeCity()).center;
  const near = `${centre.lat.toFixed(2)},${centre.lng.toFixed(2)}`;
  const cacheKey = `${cityId}|${trimmed}@${near}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  // Ranked from the map centre: it is what the reader is looking at, and it needs no permission.
  const indexHits = await searchNameIndex({
    cityId,
    text: trimmed,
    centre,
    limit: MAX_LOCAL_RESULTS,
  });
  const results: GeocodeResult[] = [];
  // The city holds one place several times over — six rows called "Empire State Building", three
  // called "Prospect Park" — so rows that read identically are cut to the best-ranked one. A bare
  // street name is cut the same way and for a stronger reason: five Court Streets, one per borough,
  // is the honest answer to "312 Court St" and noise as an answer to "Court St", where the number
  // that would tell them apart has not been typed.
  const listed = new Set<string>();
  const streets = new Set<string>();
  for (const hit of indexHits ?? []) {
    const displayName = localDisplayName(hit);
    const bare = hit.exact === null && hit.kind === "street";
    if (listed.has(displayName) || (bare && streets.has(hit.name))) {
      continue;
    }
    listed.add(displayName);
    if (bare) {
      streets.add(hit.name);
    }
    results.push({
      placeId: `local:${cityId}:${hit.kind}:${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}:${displayName}`,
      lat: hit.lat,
      lng: hit.lng,
      displayName,
      type: localResultType(hit),
      exact: hit.exact === true,
    });
  }
  // Only a real answer is remembered: an index this device has not managed to fetch yet answers
  // nothing, and caching that would keep answering nothing once it arrived.
  if (indexHits !== null) {
    setBounded(searchCache, cacheKey, results);
  }
  return results;
}

// What a shared query resolved to, against the city it was resolved in: the door to route straight
// to when one was named, and always the words that found something and the answers they found, so
// the box can offer them.
export interface SharedDestination {
  query: string;
  results: GeocodeResult[];
  exact: GeocodeResult | null;
}

// What a destination carried as words — a `#q=` link, or the text Android's share sheet hands over —
// actually points at in `cityId`.
//
// Every reading of the share is searched, not just readings until one of them answers. "Katz's
// Delicatessen, 205 E Houston St" is a name and a door in one string: the name matches the index and
// the door matches the address file, and only the door is precise enough to route to without asking.
// Stopping at the first part that found anything would stop at whichever came first and never try
// the other, so a door wins wherever among the parts it sits, and the first part to find anything at
// all is what is offered when no part names one.
//
// `cancelled` is asked between searches because each one warms the worker for its city: a lookup
// left running after the reader has moved to another city would drag the index back to this one.
export async function resolveSharedQuery(
  text: string,
  cityId: string,
  search: (
    query: string,
    cityId: string,
  ) => Promise<GeocodeResult[]> = searchAddress,
  cancelled: () => boolean = () => false,
): Promise<SharedDestination | null> {
  let named: SharedDestination | null = null;
  for (const query of sharedQueries(text)) {
    if (cancelled()) {
      return null;
    }
    const results = await search(query, cityId);
    const exact = exactAddressMatch(results);
    if (exact !== null) {
      return { query, results, exact };
    }
    if (named === null && results.length > 0) {
      named = { query, results, exact: null };
    }
  }
  return cancelled() ? null : named;
}
