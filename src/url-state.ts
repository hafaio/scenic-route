// The shareable state, carried as query parameters inside the URL hash. The route — endpoints, scenic
// weights, the scrubbed time and pinned day — is always there and rewritten live; the view — camera and
// overlays — is added only to a link the user shares. Query parameters rather than a packed blob
// because this app keeps gaining scenic factors: a key sitting at its default is omitted, an unknown key
// is left alone, and a missing key falls back to its default, so a link made today still opens once the
// ninth factor lands.

import {
  DEFAULT_ART_WEIGHT,
  DEFAULT_COMMERCIAL_WEIGHT,
  DEFAULT_FERRY_WEIGHT,
  DEFAULT_HIGHWAY_WEIGHT,
  DEFAULT_HILL_WEIGHT,
  DEFAULT_HISTORIC_WEIGHT,
  DEFAULT_INDUSTRIAL_WEIGHT,
  DEFAULT_LANDMARK_WEIGHT,
  DEFAULT_SHADE_WEIGHT,
  DEFAULT_SHELTER_WEIGHT,
  DEFAULT_TREE_WEIGHT,
  MAX_ART_WEIGHT,
  MAX_COMMERCIAL_WEIGHT,
  MAX_FERRY_WEIGHT,
  MAX_HIGHWAY_WEIGHT,
  MAX_HILL_WEIGHT,
  MAX_HISTORIC_WEIGHT,
  MAX_INDUSTRIAL_WEIGHT,
  MAX_LANDMARK_WEIGHT,
  MAX_SHADE_WEIGHT,
  MAX_SHELTER_WEIGHT,
  MAX_TREE_WEIGHT,
  type RouteWeights,
} from "./routing/cost";
import type { FactorKey } from "./routing/factors";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteUrlState {
  start: LatLng | null; // a manually set start; null means the live location
  dest: LatLng | null;
  weights: RouteWeights;
  customHour: number | null; // null tracks the wall clock
  customDay: string | null; // "YYYY-MM-DD"; null is today
}

export interface Camera {
  center: LatLng;
  zoom: number;
}

// Every field is null when the link doesn't carry it, which must leave that part of the app alone.
export interface ViewUrlState {
  camera: Camera | null;
  overlays: readonly string[] | null; // overlay ids; the caller validates them against the registry
  // The city id, carried explicitly rather than inferred from the camera: a link's `layers` may name
  // an overlay only some cities offer, and inferring would silently drop it. The caller validates it.
  city: string | null;
}

export const DEFAULT_WEIGHTS: RouteWeights = {
  tree: DEFAULT_TREE_WEIGHT,
  ferry: DEFAULT_FERRY_WEIGHT,
  landmark: DEFAULT_LANDMARK_WEIGHT,
  art: DEFAULT_ART_WEIGHT,
  highway: DEFAULT_HIGHWAY_WEIGHT,
  hill: DEFAULT_HILL_WEIGHT,
  commercial: DEFAULT_COMMERCIAL_WEIGHT,
  industrial: DEFAULT_INDUSTRIAL_WEIGHT,
  historic: DEFAULT_HISTORIC_WEIGHT,
  shade: DEFAULT_SHADE_WEIGHT,
  shelter: DEFAULT_SHELTER_WEIGHT,
  allowFerries: true,
  allowSheds: true,
  // Off: a route that spends crossings freely zigzags across a street to chase the shady side, which
  // is the cost model buying something nobody asked for rather than a taste anyone holds.
  allowCrossings: false,
};

export const DEFAULT_ROUTE_STATE: RouteUrlState = {
  start: null,
  dest: null,
  weights: DEFAULT_WEIGHTS,
  customHour: null,
  customDay: null,
};

// A destination named in words — "205 East Houston" — instead of as a point. It sits in the hash
// beside `from` and `to` because it says the same thing they do, in the one scheme this app writes
// links in, and the reader can read it. Unlike them it is an instruction rather than state: nothing
// in the app ever writes it, and on arrival it is resolved against the city's own index and taken
// out of the URL (`withoutDestQuery`), so a link that has been acted on cannot fire again on reload
// or travel on to the next person carrying a stale query. Taking it out is its own step rather than
// the hash writer's business: that writer has nothing to say until a route exists, which is exactly
// the state a bare `#q=` link arrives in.
const DEST_QUERY_KEY = "q";

const COORD_DIGITS = 6; // ~0.1 m
const WEIGHT_DIGITS = 2;
const ZOOM_DIGITS = 2;
const MAX_ZOOM = 22;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface WeightParam {
  key: string;
  field: FactorKey;
  min: number;
  max: number;
}

const WEIGHT_PARAMS: readonly WeightParam[] = [
  { key: "tree", field: "tree", min: 0, max: MAX_TREE_WEIGHT },
  { key: "ferry", field: "ferry", min: 0, max: MAX_FERRY_WEIGHT },
  { key: "landmark", field: "landmark", min: 0, max: MAX_LANDMARK_WEIGHT },
  { key: "art", field: "art", min: 0, max: MAX_ART_WEIGHT },
  { key: "highway", field: "highway", min: 0, max: MAX_HIGHWAY_WEIGHT },
  { key: "hill", field: "hill", min: 0, max: MAX_HILL_WEIGHT },
  {
    key: "commercial",
    field: "commercial",
    min: 0,
    max: MAX_COMMERCIAL_WEIGHT,
  },
  {
    key: "industrial",
    field: "industrial",
    min: 0,
    max: MAX_INDUSTRIAL_WEIGHT,
  },
  { key: "historic", field: "historic", min: 0, max: MAX_HISTORIC_WEIGHT },
  {
    key: "shade",
    field: "shade",
    min: -MAX_SHADE_WEIGHT,
    max: MAX_SHADE_WEIGHT,
  },
  { key: "shelter", field: "shelter", min: 0, max: MAX_SHELTER_WEIGHT },
];

// Every key this module owns, so a rewrite can clear its own and leave the rest (the About flag today,
// a future version's keys) untouched.
const ROUTE_KEYS: readonly string[] = [
  "from",
  "to",
  DEST_QUERY_KEY,
  ...WEIGHT_PARAMS.map((param) => param.key),
  "ferries",
  "sheds",
  "crossings",
  "time",
  "date",
];
const VIEW_KEYS: readonly string[] = ["at", "layers", "city"];

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatPoint({ lat, lng }: LatLng): string {
  return `${round(lat, COORD_DIGITS)},${round(lng, COORD_DIGITS)}`;
}

// A "lat,lng" pair, or null when it is absent, malformed, or off the globe.
function parsePoint(text: string | null): LatLng | null {
  if (text === null) {
    return null;
  }
  const [latText, lngText, ...rest] = text.split(",");
  if (rest.length > 0) {
    return null;
  }
  const lat = Number(latText);
  const lng = Number(lngText);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return null;
  }
  return { lat, lng };
}

// A number within bounds, or the default when the key is absent or unreadable.
function parseNumber(
  text: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (text === null) {
    return fallback;
  }
  const value = Number(text);
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

// `defaults` is what a missing key falls back to — the persisted preferences at load, so a link that
// names only a destination leaves the visitor's own slider settings in place.
export function decodeRoute(
  params: URLSearchParams,
  defaults: RouteUrlState = DEFAULT_ROUTE_STATE,
): RouteUrlState {
  const weights: RouteWeights = { ...defaults.weights };
  for (const { key, field, min, max } of WEIGHT_PARAMS) {
    weights[field] = parseNumber(
      params.get(key),
      min,
      max,
      defaults.weights[field],
    );
  }
  weights.allowFerries = params.has("ferries")
    ? params.get("ferries") !== "0"
    : defaults.weights.allowFerries;
  weights.allowSheds = params.has("sheds")
    ? params.get("sheds") !== "0"
    : defaults.weights.allowSheds;
  // Both spellings of this key mean the same thing, because in both schemes it was only ever written
  // when crossings are FREE: `crossings=0` before the flag was inverted (when it was named for the
  // opposite state) and `crossings=1` since. So presence is the signal, and the value is read only
  // to reject a string neither encoder ever wrote. Without this a link shared before the rename
  // would decode to the opposite of the route it described.
  const crossings = params.get("crossings");
  weights.allowCrossings =
    crossings === "0" || crossings === "1"
      ? true
      : defaults.weights.allowCrossings;
  const hour = params.get("time");
  const day = params.get("date");
  return {
    start: parsePoint(params.get("from")) ?? defaults.start,
    dest: parsePoint(params.get("to")) ?? defaults.dest,
    weights,
    customHour:
      hour === null ? defaults.customHour : parseNumber(hour, 0, 24, 12),
    customDay: day !== null && DAY_PATTERN.test(day) ? day : defaults.customDay,
  };
}

export function encodeRoute(state: RouteUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.start) {
    params.set("from", formatPoint(state.start));
  }
  if (state.dest) {
    params.set("to", formatPoint(state.dest));
  }
  for (const { key, field } of WEIGHT_PARAMS) {
    const value = round(state.weights[field], WEIGHT_DIGITS);
    if (value !== round(DEFAULT_WEIGHTS[field], WEIGHT_DIGITS)) {
      params.set(key, String(value));
    }
  }
  if (!state.weights.allowFerries) {
    params.set("ferries", "0");
  }
  if (!state.weights.allowSheds) {
    params.set("sheds", "0");
  }
  if (state.weights.allowCrossings) {
    params.set("crossings", "1");
  }
  if (state.customHour !== null) {
    params.set("time", String(round(state.customHour, WEIGHT_DIGITS)));
  }
  if (state.customDay !== null) {
    params.set("date", state.customDay);
  }
  return params;
}

// An empty `layers` is a deliberate "every overlay off", distinct from an absent one.
export function decodeView(params: URLSearchParams): ViewUrlState {
  const at = params.get("at");
  const layers = params.get("layers");
  const [lat, lng, zoom] = (at ?? "").split(",");
  const center = at === null ? null : parsePoint(`${lat},${lng}`);
  const level = parseNumber(zoom ?? null, 0, MAX_ZOOM, Number.NaN);
  return {
    camera: center && Number.isFinite(level) ? { center, zoom: level } : null,
    overlays: layers === null ? null : layers.split(",").filter(Boolean),
    city: params.get("city"),
  };
}

export function encodeView(
  camera: Camera,
  overlays: readonly string[],
  city: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set(
    "at",
    `${formatPoint(camera.center)},${round(camera.zoom, ZOOM_DIGITS)}`,
  );
  params.set("layers", overlays.join(","));
  params.set("city", city);
  return params;
}

export function decodeDestQuery(params: URLSearchParams): string | null {
  const text = params.get(DEST_QUERY_KEY)?.trim() ?? "";
  return text === "" ? null : text;
}

// `hash` with the destination query taken out and everything else — the route, the view, the About
// flag — left exactly as it was.
export function withoutDestQuery(hash: string): string {
  const params = hashParams(hash);
  params.delete(DEST_QUERY_KEY);
  return formatHash(params);
}

export function hashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ""));
}

// URLSearchParams percent-encodes the commas in a point and a layer list, and spells a valueless key
// `k=`; a fragment allows commas literally, and both forms read back identically, so undo them —
// readability is the whole reason these are query parameters rather than a packed blob.
export function formatHash(params: URLSearchParams): string {
  const text = params
    .toString()
    .replaceAll("%2C", ",")
    .replace(/=(?=&|$)/g, "");
  return text ? `#${text}` : "";
}

// `hash` with this module's keys replaced by `next` and every other key kept, so a rewrite never drops
// the About flag or a key a future version added.
export function replaceOwnKeys(hash: string, next: URLSearchParams): string {
  const params = hashParams(hash);
  for (const key of [...ROUTE_KEYS, ...VIEW_KEYS]) {
    params.delete(key);
  }
  for (const [key, value] of next) {
    params.append(key, value);
  }
  return formatHash(params);
}
