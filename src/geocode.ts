const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT_NOTE = "scenic-route (https://github.com/hafaio/scenic-route)";
const MAX_CACHE_ENTRIES = 200;

// Forward search runs against Photon (komoot's OSM geocoder), not Nominatim: Photon is built for
// as-you-type autocomplete (Nominatim's usage policy forbids it and its public server is slow),
// is CORS-enabled and keyless. Reverse geocoding stays on Nominatim — those are single calls.
const PHOTON_BASE = "https://photon.komoot.io";
// Clamps results to the manifest city bounds so a bare street name resolves to the local one.
const PHOTON_BBOX =
  "-74.25744633653791,40.49535834077158,-73.6955944236991,40.91699792884648";
const MAX_SEARCH_RESULTS = 5;

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

export async function searchAddress(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const cached = searchCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const url = new URL("/api", PHOTON_BASE);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", String(MAX_SEARCH_RESULTS));
  url.searchParams.set("lang", "en");
  url.searchParams.set("bbox", PHOTON_BBOX);
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
  setBounded(searchCache, trimmed, results);
  return results;
}
