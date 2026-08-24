// The cities the app covers, and which of them a point belongs to. Exactly one city is active at a
// time: it owns the routing graph, the tile pyramids and the overlay set, so switching city swaps all
// three and two cities' data are never on screen together.

import type { OverlayId } from "./overlays/registry";
import manifest from "./tree-cover/manifest.json";
import type { LatLng } from "./url-state";

export interface CityBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface City {
  id: string;
  name: string;
  bounds: CityBounds;
  center: LatLng;
  // The overlays this city offers, in switcher order. A city without a pyramid simply omits it, so a
  // shared link naming an overlay the active city lacks drops that one rather than breaking.
  overlays: readonly OverlayId[];
  // Kerb to the baked sidewalk line, the offset the graph pass lays this city's sidewalks at.
  sidewalkInsetMeters: number;
}

// Authored per city rather than derived from the artifacts on disk: a city may have the data for a
// layer and still not want it in the switcher.
const OVERLAYS_BY_CITY: Record<string, readonly OverlayId[]> = {
  nyc: [
    "canopy",
    "genus",
    "landmarks",
    "art",
    "ferries",
    "subway",
    "highways",
    "industrial",
    "historic",
    "legacy",
    "commercial",
    "shade",
    "scaffolding",
  ],
  // San Francisco has no scaffolding feed to build a shed layer from, and its ferries are behind a
  // 511.org key this pipeline does not hold. Commercial waits on its own signals being wired up.
  // Its rail is Muni's and BART's rather than a subway, but it is the same artifact and the same
  // layer, so it rides under the same id.
  sf: [
    "canopy",
    "genus",
    "elevation",
    "landmarks",
    "art",
    "subway",
    "highways",
    "industrial",
    "historic",
    "legacy",
    "shade",
  ],
};

const METERS_PER_DEGREE_LAT = 111_320;

// What a city is framed at when the app opens on it with no camera of its own to restore.
export const CITY_ZOOM = 13;

// Past this the camera cuts rather than flies. Well beyond any pan inside one city — New York's own
// diagonal is about 50 km — and far below the distance to another city, so the only thing it catches
// is a move that was never a pan. Everything keyed on the viewport renders against each frame of an
// animated crossing and reports what it finds over the ocean in between, which is nothing.
export const CROSS_CITY_METERS = 120_000;

export const CITIES: readonly City[] = manifest.cities.map((city) => ({
  id: city.id,
  name: city.name,
  bounds: city.bounds,
  center: {
    lat: (city.bounds.north + city.bounds.south) / 2,
    lng: (city.bounds.east + city.bounds.west) / 2,
  },
  overlays: OVERLAYS_BY_CITY[city.id] ?? [],
  sidewalkInsetMeters: city.streets.sidewalkInsetMeters,
}));

export const DEFAULT_CITY: City = CITIES[0];

// Metres from a point to a city's bounds, 0 anywhere inside them. Longitude is scaled by the point's
// latitude, so an east-west gap counts for what it is on the ground rather than in degrees.
export function metersFromCity(city: City, point: LatLng): number {
  const { bounds } = city;
  const north = Math.max(0, bounds.south - point.lat, point.lat - bounds.north);
  const east = Math.max(0, bounds.west - point.lng, point.lng - bounds.east);
  const northMeters = north * METERS_PER_DEGREE_LAT;
  const eastMeters =
    east * METERS_PER_DEGREE_LAT * Math.cos((point.lat * Math.PI) / 180);
  return Math.hypot(northMeters, eastMeters);
}

export function cityById(id: string | null): City | null {
  return CITIES.find((city) => city.id === id) ?? null;
}

// Read by the modules that are not React and so cannot be handed the city as a prop: the sun's
// position for the shade model, and the sidewalk offset the shed decks are measured against. Exactly
// one city is live at a time by design, so these read it rather than threading a parameter down
// through the tile pipeline for a value that cannot differ within one render. It starts at the
// default so it is never unset, and the app assigns it wherever it assigns the city.
let active: City = DEFAULT_CITY;

export function setActiveCity(city: City): void {
  active = city;
}

export function activeCity(): City {
  return active;
}

export function containsPoint(city: City, point: LatLng): boolean {
  return metersFromCity(city, point) === 0;
}

// The cities any part of which is on screen. Overlap, not containment: a city half off the edge is
// still one you are looking at.
export function citiesInView(view: CityBounds): City[] {
  return CITIES.filter(
    ({ bounds }) =>
      bounds.south <= view.north &&
      bounds.north >= view.south &&
      bounds.west <= view.east &&
      bounds.east >= view.west,
  );
}

// The city a point belongs to, or the closest one when it is outside every city. Never null: an
// out-of-coverage visitor is taken to the nearest city rather than left on an empty map.
export function nearestCity(point: LatLng): City {
  return CITIES.reduce((best, city) =>
    metersFromCity(city, point) < metersFromCity(best, point) ? city : best,
  );
}
