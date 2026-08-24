import {
  type LabelRule,
  labelRules,
  type PaintRule,
  paintRules,
} from "protomaps-leaflet";
import { type Flavor, VOYAGER } from "./flavor";

// How the basemap is DRAWN, as against what colour it is drawn in (./flavor.ts). Protomaps' defaults
// are a sober cartographic style; Voyager is not, and two of its habits are what make it recognisable
// at the zooms this app is used at.
//
// Both adjustments are applied on top of Protomaps' own rules rather than replacing them, so the
// hundred-odd decisions in those rules that are already right keep working, and an upgrade to the
// library brings its improvements with it.

// Voyager's street ribbons are visibly fatter than Protomaps'. Widening them is most of what makes a
// side-by-side read as the same map: at z17 Protomaps draws a minor street about two thirds the width
// Voyager does, and a grid of thin white lines on cream looks nothing like a grid of fat ones.
const ROAD_WIDTH = 1.45;

// Voyager labels far more streets than Protomaps does — at z15 over midtown it names roughly twice as
// many. Its rules gate street names on zoom, so dropping that gate two levels is what closes the gap.
// This can only reach as far as the DATA does: a street with no name in the tile cannot be labelled,
// however early the rule fires.
const LABEL_ZOOM_SHIFT = 2;

// Protomaps' width values are either a plain number or a function of zoom, and there is no exported
// type for the symbolizer's fields, so the shape is narrowed here rather than asserted.
type Width = number | ((zoom: number) => number);

function scaled(width: unknown, factor: number): Width | undefined {
  if (typeof width === "number") {
    return width * factor;
  }
  if (typeof width === "function") {
    const original = width as (zoom: number) => number;
    return (zoom: number) => original(zoom) * factor;
  }
  return undefined; // not a width this rule uses; leave it alone
}

// Administrative boundaries, dropped whole. Protomaps draws them through two rules split on
// `kind_detail`, and in this app's zoom range the only one with anything to draw is the finer of the
// two — the county lines, which in New York are the borough lines, running straight through the
// middle of the city and saying nothing to someone deciding which street to walk down. (Measured:
// with boundaries coloured red and nothing filtered, no line appears over the Hudson at z11 or z13,
// so the New York / New Jersey line is not in these tiles at these zooms either way.) A walking map
// of one city has no use for either, so neither is drawn.
export function basemapPaintRules(flavor: Flavor = VOYAGER): PaintRule[] {
  return paintRules(flavor as never)
    .filter((rule) => rule.dataLayer !== "boundaries")
    .map((rule) => {
      if (rule.dataLayer !== "roads") {
        return rule;
      }
      const symbolizer = rule.symbolizer as unknown as { width?: unknown };
      const width = scaled(symbolizer.width, ROAD_WIDTH);
      if (width === undefined) {
        return rule;
      }
      // The symbolizer is mutated through a copy rather than in place: `paintRules` builds fresh
      // objects per call, but a caller that reused one would otherwise get it widened twice.
      return {
        ...rule,
        symbolizer: Object.assign(
          Object.create(Object.getPrototypeOf(rule.symbolizer)),
          rule.symbolizer,
          { width },
        ),
      };
    });
}

export function basemapLabelRules(
  flavor: Flavor = VOYAGER,
  lang = "en",
): LabelRule[] {
  return labelRules(flavor as never, lang).map((rule) =>
    rule.dataLayer === "roads" && rule.minzoom !== undefined
      ? { ...rule, minzoom: Math.max(0, rule.minzoom - LABEL_ZOOM_SHIFT) }
      : rule,
  );
}
