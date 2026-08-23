import { expect, test } from "bun:test";
import { fileRequest, shadeKey } from "./policy";

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
