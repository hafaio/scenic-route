import { activeCity } from "./cities";
import { searchCentre, searchNameIndex } from "./search/name-search";
import type { IndexHit } from "./search/protocol";

// What the app calls a place: what was typed into the search box, and what a point picked off the
// map is called. The search box needs no network — it is answered from the city's own index and
// address file, which ship with the map. Naming a point is still a round trip to Nominatim.

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT_NOTE = "scenic-route (https://github.com/hafaio/scenic-route)";
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
}

interface NominatimReverseResponse {
  place_id?: number | string;
  lat?: string;
  lon?: string;
  display_name?: string;
  type?: string;
  class?: string;
  error?: string;
}

const reverseCache = new Map<string, GeocodeResult | null>();
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

function reverseKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

export async function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<GeocodeResult | null> {
  const key = reverseKey(lat, lng);
  if (reverseCache.has(key)) {
    return reverseCache.get(key) ?? null;
  }
  const url = new URL("/reverse", NOMINATIM_BASE);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "0");
  const response = await fetch(url.toString(), {
    signal,
    headers: { "Accept-Language": "en", "X-Client": USER_AGENT_NOTE },
  });
  if (!response.ok) {
    throw new Error(`Nominatim reverse failed: ${response.status}`);
  }
  const data = (await response.json()) as NominatimReverseResponse;
  if (data.error || !data.display_name || !data.lat || !data.lon) {
    setBounded(reverseCache, key, null);
    return null;
  }
  const result: GeocodeResult = {
    placeId: String(data.place_id ?? key),
    lat: Number.parseFloat(data.lat),
    lng: Number.parseFloat(data.lon),
    displayName: data.display_name,
    type: data.type ?? data.class ?? "place",
  };
  setBounded(reverseCache, key, result);
  return result;
}

// A street, which is the coarsest answer there is: one point stands for the whole of it. The search
// box draws it with its own glyph, so that reads at a glance.
export const STREET_RESULT_TYPE = "scenic:street";

// A place out of the city's own name index (src/search/search-format.ts) — a business, a park, a
// campus — which is the one source here that answers "Peter Luger" with no network at all. Its own
// type, so the box draws it as a place rather than as an address.
export const INDEX_RESULT_TYPE = "scenic:index";

// A house number found in the city's own address file. Its own glyph in the search box, and its own
// type here, because it is the most precise answer the box can give.
export const ADDRESS_RESULT_TYPE = "scenic:address";

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

export async function searchAddress(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const scope = activeCity().id;
  // The map centre is part of the answer, not just of its order: the name index ranks by distance
  // from it, so the same query at two ends of the city is two different lists. Rounded to ~1 km, the
  // scale the distance term works at, so panning a block does not throw the cache away.
  const centre = searchCentre(scope) ?? activeCity().center;
  const near = `${centre.lat.toFixed(2)},${centre.lng.toFixed(2)}`;
  const cacheKey = `${scope}|${trimmed}@${near}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  // Ranked from the map centre: it is what the reader is looking at, and it needs no permission.
  const indexHits = await searchNameIndex({
    cityId: scope,
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
      placeId: `local:${scope}:${hit.kind}:${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}:${displayName}`,
      lat: hit.lat,
      lng: hit.lng,
      displayName,
      type: localResultType(hit),
    });
  }
  // Only a real answer is remembered: an index this device has not managed to fetch yet answers
  // nothing, and caching that would keep answering nothing once it arrived.
  if (indexHits !== null) {
    setBounded(searchCache, cacheKey, results);
  }
  return results;
}
