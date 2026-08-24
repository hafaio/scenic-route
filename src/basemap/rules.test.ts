import { expect, test } from "bun:test";
import { paintRules } from "protomaps-leaflet";
import { VOYAGER } from "./flavor";
import { basemapPaintRules } from "./rules";

// The borough lines that used to run through the middle of New York came from Protomaps' own
// boundary rules. This pins the outcome rather than the mechanism — that the library still HAS such
// rules, and that none of them survives here — so a release that renames the layer fails on this
// line rather than on someone's map.

const boundaries = (rules: readonly { dataLayer: string }[]) =>
  rules.filter((rule) => rule.dataLayer === "boundaries");

test("the library draws boundaries and we draw none of them", () => {
  expect(boundaries(paintRules(VOYAGER as never)).length).toBeGreaterThan(0);
  expect(boundaries(basemapPaintRules(VOYAGER))).toEqual([]);
});
