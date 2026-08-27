import { activeCity } from "./cities";
import { searchCentre, searchNameIndex } from "./search/name-search";
import type { IndexHit } from "./search/protocol";
import { tokenize } from "./search/search-format";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT_NOTE = "scenic-route (https://github.com/hafaio/scenic-route)";
const MAX_CACHE_ENTRIES = 200;

// Forward search runs against Photon (komoot's OSM geocoder), not Nominatim: Photon is built for
// as-you-type autocomplete (Nominatim's usage policy forbids it and its public server is slow),
// is CORS-enabled and keyless. Reverse geocoding stays on Nominatim — those are single calls.
const PHOTON_BASE = "https://photon.komoot.io";
// Clamps results to the active city's bounds so a bare street name resolves to the local one.
function photonBbox(): string {
  const { west, south, east, north } = activeCity().bounds;
  return `${west},${south},${east},${north}`;
}
const MAX_SEARCH_RESULTS = 5;
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

// Photon returns GeoJSON; each feature carries a point geometry and OSM address properties, from
// which a single display line is assembled (Photon has no display_name field of its own).
interface PhotonProperties {
  osm_id?: number;
  osm_type?: string;
  osm_value?: string;
  type?: string;
  name?: string;
  housenumber?: string;
  street?: string;
  locality?: string;
  city?: string;
  district?: string;
  county?: string;
  state?: string;
  postcode?: string;
}

// Neighborhood-first: Photon's `locality` is the finest-grained place (a neighborhood like
// "Koreatown"), `district` the borough. Community-board boundaries also land in `locality` but
// read badly as a place name, so they fall through to the borough.
function photonLocality(props: PhotonProperties): string | undefined {
  if (props.locality && !/community board/i.test(props.locality)) {
    return props.locality;
  }
  return props.district || props.city || props.county;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: PhotonProperties;
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

function photonDisplayName(props: PhotonProperties): string {
  const street = [props.housenumber, props.street].filter(Boolean).join(" ");
  // A named place keeps its name and, when it also has a street address, that too; a bare address
  // is just the street. The guard drops the redundant second copy when a street's name is itself.
  const head =
    props.name && street && props.name !== street
      ? `${props.name}, ${street}`
      : props.name || street || props.street || "";
  return [head, photonLocality(props)].filter(Boolean).join(", ");
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

// A location to rank nearby results first (Photon's `lat`/`lon` proximity bias), on top of the city
// bbox clamp. Passed only when the user has opted in to sharing their location for search.
export interface SearchBias {
  lat: number;
  lng: number;
}

// The geocoder's answer, or none where it could not be reached. Null rather than an exception, so a
// caller that has local answers can still give them.
async function fetchPhoton(
  url: URL,
  signal: AbortSignal | undefined,
): Promise<PhotonResponse | null> {
  try {
    const response = await fetch(url.toString(), { signal });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as PhotonResponse;
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      throw error;
    }
    return null;
  }
}

// A street, which is the coarsest answer there is: one point stands for the whole of it. The search
// box draws it with its own glyph, so that reads at a glance.
export const STREET_RESULT_TYPE = "scenic:street";

// A place out of the city's own name index (src/search/search-format.ts) — a business, a park, a
// campus — which is the one source here that answers "Peter Luger" with no network at all. Its own
// type, so the box draws it as a place rather than as an address.
export const INDEX_RESULT_TYPE = "scenic:index";

// A house number found in the city's own address file. Its own glyph in the search box, and its own
// type here, because it is the one local answer as precise as anything the geocoder returns.
export const ADDRESS_RESULT_TYPE = "scenic:address";

// How many answers the index is asked for, and how many of them may sit ABOVE the geocoder's. The
// index ranks a door, a station, a park and a street against each other, so what leads is whatever
// the one ranking put first; the cap is what keeps the list from being a single source, since the
// geocoder still knows names this index does not and a reader who typed one has to be able to see it.
const MAX_LOCAL_RESULTS = 8;
const MAX_LEADING_LOCAL = 4;

// How close a geocoder result has to be to an exact local address before it is the same building
// said twice. A New York lot is around 30 m deep, so this is "the same door, give or take which
// corner of the parcel each source put its point on" rather than "next door".
const SAME_BUILDING_METERS = 40;

// Close enough at the scale of one city block, and only ever compared against a threshold.
function metersApart(left: SearchBias, right: SearchBias): number {
  const north = (left.lat - right.lat) * 111_320;
  const east =
    (left.lng - right.lng) * 111_320 * Math.cos((left.lat * Math.PI) / 180);
  return Math.hypot(north, east);
}

// One of the index's answers, on its way to being a row: the hit it came from is what says whether
// the geocoder is about to repeat it.
interface LocalRow {
  hit: IndexHit;
  result: GeocodeResult;
  words: string[]; // the hit's own name, tokenized, for that comparison
}

// What the row reads as. A station says so and lists the routes it serves, since "Bedford Av" is a
// street and a station and the difference is the whole reason a rider typed it; everything else is
// its name and the line under it, with the name left off where the line already opens with it — the
// way the geocoder's own display line does not repeat a street that is its own name.
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

// A search, and whether the geocoder was part of it. The flag is what lets the box say the list is
// PARTIAL: three streets and a station is a perfectly good answer, but shown without a word it reads
// as "there is nothing else by that name", which is the opposite of true.
export interface GeocodeSearch {
  results: GeocodeResult[];
  reachedGeocoder: boolean;
}

export async function searchAddress(
  query: string,
  options: { bias?: SearchBias | null; signal?: AbortSignal } = {},
): Promise<GeocodeSearch> {
  const { bias, signal } = options;
  const trimmed = query.trim();
  if (!trimmed) {
    return { results: [], reachedGeocoder: true };
  }
  // The bias reorders results and the city bounds them, so both are part of the cache identity; the
  // bias is rounded to ~100 m so GPS jitter doesn't defeat the cache while the ranking stays
  // representative of the user's neighbourhood.
  const scope = activeCity().id;
  // The map centre is part of the answer, not just of its order: the name index ranks by distance
  // from it, so the same query at two ends of the city is two different lists. Rounded to ~1 km, the
  // scale the distance term works at, so panning a block does not throw the cache away.
  const centre = searchCentre(scope) ?? activeCity().center;
  const near = `${centre.lat.toFixed(2)},${centre.lng.toFixed(2)}`;
  const cacheKey = bias
    ? `${scope}|${trimmed}@${near}|${bias.lat.toFixed(3)},${bias.lng.toFixed(3)}`
    : `${scope}|${trimmed}@${near}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    // Only complete answers are cached (see below), so a hit is one.
    return { results: cached, reachedGeocoder: true };
  }
  const url = new URL("/api", PHOTON_BASE);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", String(MAX_SEARCH_RESULTS));
  url.searchParams.set("lang", "en");
  url.searchParams.set("bbox", photonBbox());
  if (bias) {
    url.searchParams.set("lat", String(bias.lat));
    url.searchParams.set("lon", String(bias.lng));
  }
  // Asked first and unawaited, so the worker's answer and the geocoder round trip overlap. Ranked
  // from the map centre rather than from the shared location: it is what the reader is looking at, it
  // needs no permission, and unlike the geocoder's bias it is there in every session.
  const local = searchNameIndex({
    cityId: scope,
    text: trimmed,
    centre,
    limit: MAX_LOCAL_RESULTS,
  });
  // A geocoder this device cannot reach is not a failed search: everything below it is answered from
  // data that already shipped, and throwing here used to take those answers down with it — with no
  // signal the box returned nothing at all, stations included, which is the one case it was most
  // able to answer. An aborted request is different and is rethrown: that is the app changing its
  // mind about the query, not the network refusing it.
  const data = await fetchPhoton(url, signal);
  const results: GeocodeResult[] = [];
  // Photon can return the same OSM feature more than once (e.g. a way split into segments); dedupe
  // by id so the list has no colliding React keys, and by the line it reads as, since the several
  // segments of one street come back under different ids and the same words — five rows of "5th
  // Avenue, Manhattan" is one answer taking the whole list.
  const seen = new Set<string>();
  for (const feature of data?.features ?? []) {
    const coordinates = feature.geometry?.coordinates;
    const props = feature.properties;
    if (!coordinates || !props) {
      continue;
    }
    const [lng, lat] = coordinates;
    const displayName = photonDisplayName(props);
    if (!displayName) {
      continue;
    }
    const placeId = String(
      props.osm_type && props.osm_id
        ? `${props.osm_type}${props.osm_id}`
        : `${lat},${lng}`,
    );
    if (seen.has(placeId) || seen.has(displayName)) {
      continue;
    }
    seen.add(placeId);
    seen.add(displayName);
    results.push({
      placeId,
      lat,
      lng,
      displayName,
      type: props.osm_value ?? props.type ?? "place",
    });
  }

  const indexHits = await local;
  const rows: LocalRow[] = [];
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
    rows.push({
      hit,
      result: {
        placeId: `local:${scope}:${hit.kind}:${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}:${displayName}`,
        lat: hit.lat,
        lng: hit.lng,
        displayName,
        type: localResultType(hit),
      },
      words: tokenize(hit.name),
    });
  }
  // Photon answers a house number with the same building we just answered with, under its own idea
  // of the neighbourhood: "312 Court Street, Cobble Hill" directly under our "312 Court Street,
  // Brooklyn". That is two rows of a five-row list spent on one place, and ours is the row that
  // stays — for the reason it leads in the first place. Only an EXACT hit suppresses anything: a
  // nearest-number fallback is a different address, and must not silence a real answer.
  //
  // The same happens to a place the index answered — "Katz's Delicatessen" under "Katz's
  // Delicatessen, 205 East Houston Street" — but a doorway is shared by several businesses, so
  // distance alone would drop the shop next door as a duplicate. The geocoder's row also has to
  // NAME the place: every word of the index's name in the row it would be listed under. A street is
  // the exception to the distance rule, since one point stands for a mile of it: there the names
  // alone decide, and Photon's "Court Street, Cobble Hill" goes.
  const geocoded = results.filter((result) => {
    const said = new Set(tokenize(result.displayName));
    const head = new Set(tokenize(result.displayName.split(",")[0]));
    return (
      !listed.has(result.displayName) &&
      !rows.some(({ hit, result: row, words }) => {
        if (hit.exact === true) {
          return metersApart(row, result) <= SAME_BUILDING_METERS;
        } else if (hit.kind === "street" && hit.exact === null) {
          return (
            words.length === head.size && words.every((word) => head.has(word))
          );
        } else {
          return (
            metersApart(row, result) <= SAME_BUILDING_METERS &&
            words.every((word) => said.has(word))
          );
        }
      })
    );
  });
  // The index's rows lead the geocoder's, up to the cap, and the rest trail them: one ranking put
  // them in this order, and the cap is the only thing here that is a policy rather than a score.
  const localRows = rows.map(({ result }) => result);
  const merged = [
    ...localRows.slice(0, MAX_LEADING_LOCAL),
    ...geocoded,
    ...localRows.slice(MAX_LEADING_LOCAL),
  ].slice(0, MAX_SEARCH_RESULTS + MAX_LEADING_LOCAL);
  // Only a real answer is remembered. A list assembled while the geocoder was unreachable is a
  // partial one, and caching it would keep serving that partial list after the signal came back —
  // and the same goes for an index this device has not managed to fetch yet, which is the one source
  // that can be missing while the network is otherwise fine.
  if (data !== null && indexHits !== null) {
    setBounded(searchCache, cacheKey, merged);
  }
  return { results: merged, reachedGeocoder: data !== null };
}
