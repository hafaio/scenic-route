import { activeCity } from "./cities";
import { searchLoadedStreets } from "./routing/street-search";
import { searchAddresses, searchCentre } from "./search/addresses";
import { searchNameIndex } from "./search/name-search";
import { tokenize } from "./search/search-format";
import { searchStations, stationLabel } from "./subway/stations";

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
// How many subway stations may sit above the geocoder's own results. A station whose name starts
// with what was typed is a hit off an authoritative 496-row list, where Photon's answer to a bare
// street name is one arbitrary point on a street kilometres long — so those lead. Weaker station
// matches (the query starting a word inside the name) follow the addresses instead: "Union Sq"
// should still reach 14 St-Union Sq, but not ahead of a place actually called that. Three is enough
// for every station a prefix can name at once and short of crowding a five-row list.
const MAX_LEADING_STATIONS = 3;
// The `type` a station result carries, which the search box renders with a train glyph rather than
// leaving it to read as an address.
export const SUBWAY_RESULT_TYPE = "subway-station";

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

// A street the routing graph named, as against a place the geocoder found. The search box draws it
// with its own glyph, so a coarse answer looks like one.
export const STREET_RESULT_TYPE = "scenic:street";

// At most this many streets, so a common word ("Park") cannot bury everything else in the list.
const MAX_LOCAL_STREETS = 4;

// A place out of the city's own name index (src/search/search-format.ts) — a business, a park, a
// campus — which is the one source here that answers "Peter Luger" with no network at all. Its own
// type, so the box draws it as a place rather than as an address.
export const INDEX_RESULT_TYPE = "scenic:index";

// How many of the index's answers may lead the list. Enough that the several branches of one chain
// are all offered, and short of the whole list being one source: the geocoder still knows names this
// index does not, and a reader who typed one of them has to be able to see it.
const MAX_INDEX_PLACES = 4;

// A house number found in the city's own address file. Its own glyph in the search box, and its own
// type here, because it is the one local answer as precise as anything the geocoder returns.
export const ADDRESS_RESULT_TYPE = "scenic:address";

// At most this many addresses, since one house number can sit on several streets whose names all
// answer what was typed ("123 Grand" is on Grand Street, Grand Avenue and Grand Concourse).
const MAX_LOCAL_ADDRESSES = 3;

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
  // Local first and unawaited, so the local lookups and the geocoder round trip overlap.
  const stations = searchStations(trimmed);
  const addresses = searchAddresses(scope, trimmed, MAX_LOCAL_ADDRESSES, bias);
  // The name index, in its own worker. Ranked from the map centre rather than from the shared
  // location: it is what the reader is looking at, it needs no permission, and unlike the geocoder's
  // bias it is there in every session.
  const places = searchNameIndex({
    cityId: scope,
    text: trimmed,
    centre,
    limit: MAX_INDEX_PLACES,
    // Streets ride their own path into this list, off the routing graph, and would otherwise be
    // listed twice; the index still MATCHES them, which is what answers "Katz's Delicatessen E
    // Houston St".
    kinds: ["place"],
  });
  // A geocoder this device cannot reach is not a failed search: everything below it is answered from
  // data that already shipped, and throwing here used to take those answers down with it — with no
  // signal the box returned nothing at all, stations included, which is the one case it was most
  // able to answer. An aborted request is different and is rethrown: that is the app changing its
  // mind about the query, not the network refusing it.
  const data = await fetchPhoton(url, signal);
  const results: GeocodeResult[] = [];
  // Photon can return the same OSM feature more than once (e.g. a way split into segments); dedupe
  // by id so the list has no repeats and no colliding React keys.
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
    if (seen.has(placeId)) {
      continue;
    }
    seen.add(placeId);
    results.push({
      placeId,
      lat,
      lng,
      displayName,
      type: props.osm_value ?? props.type ?? "place",
    });
  }
  const leading: GeocodeResult[] = [];
  const trailing: GeocodeResult[] = [];
  // Where the address file put an exact hit, for dropping the geocoder's own copy of the same door.
  const atExactAddress: GeocodeResult[] = [];
  // A house number the city's own file has, on a street whose name matches, is the most precise
  // answer anything here can give, so it leads — including the geocoder, which answers this exact
  // query with a point at an arbitrary end of a street kilometres long more often than not. A number
  // the street does not have is a different thing: the nearest neighbour is offered under its own
  // real number, and it trails, because a near miss is not what was asked for.
  //
  // The display name carries the place ("312 Court Street, Brooklyn") where the city has places, so
  // the several streets of one name are told apart in the list and by their ids.
  const addressHits = await addresses;
  for (const { place, exact } of addressHits ?? []) {
    const result: GeocodeResult = {
      placeId: `address:${scope}:${place.name}`,
      lat: place.lat,
      lng: place.lng,
      displayName: place.name,
      type: ADDRESS_RESULT_TYPE,
    };
    if (exact) {
      leading.push(result);
      atExactAddress.push(result);
    } else {
      trailing.push(result);
    }
  }
  // The name index's places, which are what answer a business or a park with no network. Every row
  // carries its own address and borough, from the same file the address rows above come from.
  const indexHits = await places;
  const indexRows: { result: GeocodeResult; words: string[] }[] = [];
  const listed = new Set<string>();
  for (const hit of indexHits ?? []) {
    // The place file holds one place several times over — six rows called "Empire State Building",
    // three called "Prospect Park" — so rows that read identically are cut to the best-ranked one.
    // The name is likewise not repeated when the address already opens with it, the way the
    // geocoder's own display line does not repeat a street that is its own name.
    const displayName = hit.label.startsWith(hit.name)
      ? hit.label
      : [hit.name, hit.label].filter(Boolean).join(", ");
    if (listed.has(displayName)) {
      continue;
    }
    listed.add(displayName);
    indexRows.push({
      result: {
        placeId: `place:${scope}:${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}:${hit.name}`,
        lat: hit.lat,
        lng: hit.lng,
        displayName,
        type: INDEX_RESULT_TYPE,
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
  // NAME the place: every word of the index's name in the row it would be listed under.
  const geocoded = results.filter((result) => {
    const said = new Set(tokenize(result.displayName));
    return (
      !atExactAddress.some(
        (hit) => metersApart(hit, result) <= SAME_BUILDING_METERS,
      ) &&
      // A row that reads exactly like one already listed is the same answer whatever the two
      // sources put its point at — Photon's "Prospect Park, Brooklyn" under ours, both true, and a
      // park is far larger than any distance rule that is safe for two shops sharing a doorway.
      !listed.has(result.displayName) &&
      !indexRows.some(
        (row) =>
          metersApart(row.result, result) <= SAME_BUILDING_METERS &&
          row.words.every((word) => said.has(word)),
      )
    );
  });
  for (const { station, rank } of await stations) {
    const result: GeocodeResult = {
      placeId: `subway:${scope}:${station.index}`,
      lat: station.lat,
      lng: station.lng,
      displayName: stationLabel(station),
      type: SUBWAY_RESULT_TYPE,
    };
    if (rank === 2 && leading.length < MAX_LEADING_STATIONS) {
      leading.push(result);
    } else {
      trailing.push(result);
    }
  }
  // The index's places lead the geocoder and follow the two sources that are more precise than a
  // name: a house number the reader typed, and a station named off an authoritative list.
  for (const { result } of indexRows) {
    leading.push(result);
  }
  // Street names off the routing graph, which is already on the device and already cached for
  // offline use. They trail the geocoder, which answers the same question with house numbers, and
  // lead it only when nothing else did — a street is the coarsest answer there is, so it is what you
  // get when there is nothing better rather than what you get first.
  for (const { place, rank } of searchLoadedStreets(
    trimmed,
    MAX_LOCAL_STREETS,
  )) {
    const result: GeocodeResult = {
      placeId: `street:${scope}:${place.name}`,
      lat: place.lat,
      lng: place.lng,
      displayName: place.name,
      type: STREET_RESULT_TYPE,
    };
    if (results.length === 0 && rank === 2) {
      leading.push(result);
    } else {
      trailing.push(result);
    }
  }
  const merged = [...leading, ...geocoded, ...trailing].slice(
    0,
    MAX_SEARCH_RESULTS + MAX_LEADING_STATIONS,
  );
  // Only a real answer is remembered. A list assembled while the geocoder was unreachable is a
  // partial one, and caching it would keep serving that partial list after the signal came back —
  // and the same goes for an address file this device has not managed to fetch yet, which is the
  // one source that can be missing while the network is otherwise fine.
  if (data !== null && addressHits !== null && indexHits !== null) {
    setBounded(searchCache, cacheKey, merged);
  }
  return { results: merged, reachedGeocoder: data !== null };
}
