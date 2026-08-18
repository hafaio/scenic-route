import { activeCity } from "./cities";
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

export async function searchAddress(
  query: string,
  options: { bias?: SearchBias | null; signal?: AbortSignal } = {},
): Promise<GeocodeResult[]> {
  const { bias, signal } = options;
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  // The bias reorders results and the city bounds them, so both are part of the cache identity; the
  // bias is rounded to ~100 m so GPS jitter doesn't defeat the cache while the ranking stays
  // representative of the user's neighbourhood.
  const scope = activeCity().id;
  const cacheKey = bias
    ? `${scope}|${trimmed}@${bias.lat.toFixed(3)},${bias.lng.toFixed(3)}`
    : `${scope}|${trimmed}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    return cached;
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
  // Local first and unawaited, so the station lookup and the geocoder round trip overlap.
  const stations = searchStations(trimmed);
  const response = await fetch(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`Photon search failed: ${response.status}`);
  }
  const data = (await response.json()) as PhotonResponse;
  const results: GeocodeResult[] = [];
  // Photon can return the same OSM feature more than once (e.g. a way split into segments); dedupe
  // by id so the list has no repeats and no colliding React keys.
  const seen = new Set<string>();
  for (const feature of data.features ?? []) {
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
  const merged = [...leading, ...results, ...trailing].slice(
    0,
    MAX_SEARCH_RESULTS + MAX_LEADING_STATIONS,
  );
  setBounded(searchCache, cacheKey, merged);
  return merged;
}
