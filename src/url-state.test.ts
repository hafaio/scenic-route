import { expect, test } from "bun:test";
import { DEFAULT_TREE_WEIGHT, type RouteWeights } from "./routing/cost";
import {
  DEFAULT_ROUTE_STATE,
  DEFAULT_WEIGHTS,
  decodeRoute,
  decodeView,
  encodeRoute,
  encodeView,
  formatHash,
  hashParams,
  type RouteUrlState,
  replaceOwnKeys,
} from "./url-state";

const roundTrip = (state: RouteUrlState): RouteUrlState =>
  decodeRoute(hashParams(formatHash(encodeRoute(state))));

test("a fresh session writes no keys at all", () => {
  expect(formatHash(encodeRoute(DEFAULT_ROUTE_STATE))).toBe("");
});

test("every route field survives a round trip", () => {
  const weights: RouteWeights = {
    tree: 0.42,
    ferry: 0.9,
    landmark: 0.75,
    art: 0.3,
    highway: 0.05,
    commercial: 0.6,
    shade: -0.85,
    shelter: 0.25,
    allowFerries: false,
    allowSheds: false,
  };
  const state: RouteUrlState = {
    start: { lat: 40.712776, lng: -74.005974 },
    dest: { lat: 40.785091, lng: -73.968285 },
    weights,
    customHour: 14.25,
    customDay: "2026-12-21",
  };
  expect(roundTrip(state)).toEqual(state);
});

test("only the fields off their defaults are written", () => {
  const hash = formatHash(
    encodeRoute({
      ...DEFAULT_ROUTE_STATE,
      weights: { ...DEFAULT_WEIGHTS, shade: -0.5 },
    }),
  );
  expect(hash).toBe("#shade=-0.5");
});

test("coordinates keep 6 decimals and weights 2", () => {
  const hash = formatHash(
    encodeRoute({
      ...DEFAULT_ROUTE_STATE,
      dest: { lat: 40.7127763456, lng: -74.0059731111 },
      weights: { ...DEFAULT_WEIGHTS, tree: 0.123456 },
    }),
  );
  expect(hash).toBe("#to=40.712776,-74.005973&tree=0.12");
});

test("a missing key takes the caller's default, an unknown key is ignored", () => {
  const stored: RouteUrlState = {
    ...DEFAULT_ROUTE_STATE,
    weights: { ...DEFAULT_WEIGHTS, tree: 0.25 },
  };
  const decoded = decodeRoute(hashParams("#ninth=0.5&art=0.9"), stored);
  expect(decoded.weights.tree).toBe(0.25); // the persisted value, untouched by the link
  expect(decoded.weights.art).toBe(0.9);
  expect(decoded.dest).toBeNull();
});

test("a malformed value falls back rather than poisoning the state", () => {
  const decoded = decodeRoute(hashParams("#to=nowhere&tree=lots&time=x"));
  expect(decoded.dest).toBeNull();
  expect(decoded.weights.tree).toBe(DEFAULT_TREE_WEIGHT);
  expect(decoded.customHour).toBe(12); // "time" was present, so an hour is pinned
});

test("out-of-range weights clamp instead of breaking the search", () => {
  const decoded = decodeRoute(hashParams("#tree=9&shade=-4"));
  expect(decoded.weights.tree).toBe(1);
  expect(decoded.weights.shade).toBe(-1);
});

test("no view keys leaves both halves of the view alone", () => {
  expect(decodeView(hashParams("#tree=0.5"))).toEqual({
    camera: null,
    overlays: null,
  });
});

test("the view round trips, and an empty layer list stays distinct from none", () => {
  const camera = { center: { lat: 40.7128, lng: -74.006 }, zoom: 15.5 };
  const full = decodeView(
    hashParams(formatHash(encodeView(camera, ["shade"]))),
  );
  expect(full).toEqual({ camera, overlays: ["shade"] });
  const bare = decodeView(hashParams(formatHash(encodeView(camera, []))));
  expect(bare.overlays).toEqual([]);
});

test("rewriting the route keeps foreign keys, including the About flag", () => {
  const hash = replaceOwnKeys(
    "#about&tree=0.5&at=40.7,-74,15&ninth=1",
    encodeRoute({ ...DEFAULT_ROUTE_STATE, weights: DEFAULT_WEIGHTS }),
  );
  expect(hash).toBe("#about&ninth=1");
  expect(hashParams(hash).has("about")).toBe(true);
});
