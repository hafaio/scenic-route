import { expect, test } from "bun:test";
import { coversACity, fileRequest, isGraph, shadeKey } from "./policy";

// A deploy under a basePath, which is the only shape that ever runs in production — the worker's
// scope is its own directory and every path it files is relative to that.
const SCOPE = "https://hafaio.github.io/scenic-route/";

test("the exported app goes in the shell store", () => {
  for (const path of [
    "",
    "index.html",
    "manifest.webmanifest",
    "_next/static/chunks/main-abc123.js",
    "icons/icon-512.png",
  ]) {
    expect(fileRequest(`${SCOPE}${path}`, SCOPE)).toEqual({
      path,
      store: "shell",
      fresh: false,
    });
  }
});

test("routing is its own store, so a shade binge cannot evict the graph", () => {
  expect(fileRequest(`${SCOPE}routing/nyc.bin`, SCOPE)?.store).toBe("routing");
  expect(fileRequest(`${SCOPE}routing/shade/nyc/12.bin`, SCOPE)?.store).toBe(
    "routing",
  );
});

// The rule that keeps a new layer from being silently left out of the offline story.
test("data the worker has never heard of still lands in the overlay store", () => {
  expect(fileRequest(`${SCOPE}some-future-layer/nyc.bin`, SCOPE)).toEqual({
    path: "some-future-layer/nyc.bin",
    store: "overlay",
    fresh: false,
  });
});

test("the worker never serves itself", () => {
  expect(fileRequest(`${SCOPE}sw.js`, SCOPE)).toBeNull();
});

test("another origin is left alone entirely", () => {
  for (const url of [
    "https://basemaps.cartocdn.com/light_all/14/4825/6162.png",
    "https://firestore.googleapis.com/v1/projects/scenic/databases",
    "https://hafaio.github.io/other-app/index.html",
  ]) {
    expect(fileRequest(url, SCOPE)).toBeNull();
  }
});

test("the daily feeds are cached, but network first", () => {
  const base = "https://raw.githubusercontent.com/hafaio/scenic-route/main";
  expect(fileRequest(`${base}/public/sheds/nyc.bin`, SCOPE)).toEqual({
    path: "sheds/nyc.bin",
    store: "routing",
    fresh: true,
  });
  expect(
    fileRequest(`${base}/public/ferry-schedule/nyc.bin`, SCOPE)?.fresh,
  ).toBe(true);
  // Anything else on that host is somebody else's file.
  expect(fileRequest(`${base}/README.md`, SCOPE)).toBeNull();
});

test("a query string does not become part of the path", () => {
  expect(fileRequest(`${SCOPE}trees/nyc.bin?v=3`, SCOPE)?.path).toBe(
    "trees/nyc.bin",
  );
});

test("the three shade shapes give up their city and bin", () => {
  expect(shadeKey("tiles/shade/nyc/12/16/19301/24650.webp")).toEqual({
    city: "nyc",
    bin: 12,
  });
  expect(shadeKey("tiles/tree-shade/sf/7/14/2620/6333.webp")).toEqual({
    city: "sf",
    bin: 7,
  });
  expect(shadeKey("routing/shade/nyc/57.bin")).toEqual({
    city: "nyc",
    bin: 57,
  });
});

// buckets.json sits exactly where a bin directory would, and it is what the season lookup reads —
// filing it under a bin would make the purge able to delete the map it purges by.
test("the bin manifests are not themselves bins", () => {
  expect(shadeKey("tiles/shade/nyc/buckets.json")).toBeNull();
  expect(shadeKey("routing/shade/nyc/bins.json")).toBeNull();
});

test("nothing else claims to be shade", () => {
  for (const path of [
    "tiles/canopy/14/4825/6162.webp",
    "routing/nyc.bin",
    "casters/5232/6162.bin",
  ]) {
    expect(shadeKey(path)).toBeNull();
  }
});

// A share link's fragment rides along on the navigation's request URL in the worker, and filing by
// the whole href would give the one exported page a cache entry per link ever opened.
test("a fragment does not become part of the path either", () => {
  expect(
    fileRequest(`${SCOPE}#at=40.7484,-73.9857,17&layers=shade`, SCOPE),
  ).toEqual({ path: "", store: "shell", fresh: false });
});

// The graph is fetched once and then read from memory all session, so its last-read time never
// moves. Under a least-recently-read eviction that makes the one artifact a walk cannot do without
// the FIRST thing out of the store; nothing evicts it.
test("a city graph is recognisable, so eviction can leave it alone", () => {
  expect(isGraph("routing/nyc.bin")).toBe(true);
  expect(isGraph("routing/sf.bin")).toBe(true);
  // Not the things that sit beside it and are meant to rotate.
  expect(isGraph("routing/nyc.stranded.bin")).toBe(true); // shares the graph's fate; it is tiny
  expect(isGraph("routing/shade/nyc/12.bin")).toBe(false);
  expect(isGraph("casters/5232/6162.bin")).toBe(false);
});

// The basemap answers for the whole planet; this app routes across two cities of it. Panning across
// an ocean must not fill the cache with ground nothing else in the app knows anything about.
const CITIES = [
  { west: -74.2555, south: 40.4968, east: -73.6995, north: 40.9155 }, // New York
  { west: -122.5141, south: 37.7068, east: -122.3607, north: 37.8325 }, // San Francisco
];

test("a basemap tile over a city is cached, under a key without its API key", () => {
  // z15 over midtown Manhattan.
  expect(
    fileRequest(
      "https://api.protomaps.com/tiles/v4/15/9649/12315.mvt?key=abc123",
      SCOPE,
      CITIES,
    ),
  ).toEqual({
    path: "tiles/v4/15/9649/12315.mvt",
    store: "overlay",
    fresh: false,
    // The key rides in the query string, so keying by the full URL would orphan every cached tile
    // the moment the key is rotated.
    cacheKey: "https://api.protomaps.com/tiles/v4/15/9649/12315.mvt",
  });
});

test("a basemap tile somewhere else is not cached at all", () => {
  for (const tile of [
    "15/17000/11000", // the Atlantic
    "15/5000/12000", // the Pacific
    "15/9649/12000", // upstate, north of the New York box
  ]) {
    expect(
      fileRequest(
        `https://api.protomaps.com/tiles/v4/${tile}.mvt?key=abc123`,
        SCOPE,
        CITIES,
      ),
    ).toBeNull();
  }
});

// A low-zoom tile is enormous and mostly not the city; keeping it anyway is what lets the reader zoom
// in from a world view rather than starting on a blank one.
test("a low-zoom tile that merely covers a city is kept", () => {
  expect(coversACity("tiles/v4/0/0/0.mvt", CITIES)).toBe(true);
  expect(coversACity("tiles/v4/4/4/6.mvt", CITIES)).toBe(true); // eastern US
  expect(coversACity("tiles/v4/4/8/6.mvt", CITIES)).toBe(false); // north Africa
});

test("nothing else on that host is a tile", () => {
  expect(coversACity("tiles/v4.json", CITIES)).toBe(false);
  expect(coversACity("tiles/v4/15/9649/12315.mvt/extra", CITIES)).toBe(false);
});

// A place already searched for still resolves with no signal. The whole query is the identity, so
// each prefix typed on the way to a name is its own entry — which is what makes retyping a
// destination offline work as you type rather than only on the exact string typed before.
test("the geocoders are cached, network first, as convenience rather than as routing", () => {
  const search = fileRequest(
    "https://photon.komoot.io/api?q=bedford&limit=6&lang=en",
    SCOPE,
  );
  expect(search?.store).toBe("overlay");
  expect(search?.fresh).toBe(true);
  expect(search?.cacheKey).toBe(
    "https://photon.komoot.io/api?q=bedford&limit=6&lang=en",
  );

  // A different query is a different entry, or one search would answer for another.
  const other = fileRequest("https://photon.komoot.io/api?q=bedf", SCOPE);
  expect(other?.cacheKey).not.toBe(search?.cacheKey);

  // Reverse lookups, which name a point picked off the map, are the same bargain.
  expect(
    fileRequest(
      "https://nominatim.openstreetmap.org/reverse?lat=40.7&lon=-74",
      SCOPE,
    )?.store,
  ).toBe("overlay");
});

test("a geocoder answer never lands in the store a walk depends on", () => {
  expect(
    fileRequest("https://photon.komoot.io/api?q=anything", SCOPE)?.store,
  ).not.toBe("routing");
});
