"use client";

import type { ComponentType, CSSProperties } from "react";
import {
  MdAccountBalance,
  MdConstruction,
  MdDirectionsBoat,
  MdDirectionsCar,
  MdFactory,
  MdMapsHomeWork,
  MdPalette,
  MdStorefront,
  MdTerrain,
  MdTraffic,
  MdWaterDrop,
  MdWbSunny,
} from "react-icons/md";
import { PiBoatFill, PiTreeEvergreenFill } from "react-icons/pi";
import type { OverlayId } from "../overlays/registry";
import {
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
  type GateKey,
  type RouteWeights,
} from "./cost";

// What each scenic factor is called, looks like and moves on. The route panel and the settings page
// both draw the same eleven sliders, so the metadata lives here rather than in either of them: two
// tables would be two chances for a label, a colour or a scale to drift.

// Everything else in the cost context: one slider each. The switches are in ./cost.ts, with the type
// they are excluded by, so the two lists cannot drift apart.
export type { GateKey };
export type FactorKey = Exclude<keyof RouteWeights, GateKey>;

export interface Factor {
  key: FactorKey;
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  max: number;
  tint: string; // text colour for the icon and chip
  color: string; // the slider's fill/thumb colour (a CSS hex; matches the map overlay)
  signed?: boolean; // a bipolar −max..max slider (sun ↔ shade) rather than one-sided 0..max
  // The layer a city omits when it has no data for this factor. The route panel reads the loaded
  // graph instead, which is exact — but the settings page opens with no graph and must still say
  // which factors this city can answer, and a city's layer list is the same fact authored ahead of
  // time. Absent means every city has it.
  overlay?: OverlayId;
}

export interface Gate {
  key: GateKey;
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  // The layer a city without this gate's data omits. Absent where the gate needs no data of its own,
  // so every city offers it.
  overlay?: OverlayId;
  // What the switch means when it is ON, for the panel's tooltip and the settings row.
  on: string;
  off: string;
}

export const GATES: readonly Gate[] = [
  {
    key: "allowFerries",
    label: "Allow ferries",
    Icon: MdDirectionsBoat,
    overlay: "ferries",
    on: "Ferries allowed — click to route without them",
    off: "Ferries barred — click to allow ferry crossings",
  },
  {
    key: "allowSheds",
    label: "Allow scaffolding",
    Icon: MdConstruction,
    overlay: "scaffolding",
    on: "Scaffolding allowed — click to route around sidewalk sheds",
    off: "Scaffolding avoided — click to walk under sidewalk sheds again",
  },
  {
    key: "allowCrossings",
    label: "Allow crossings",
    Icon: MdTraffic,
    on: "Crossings are free — click to stop the route crossing and crossing back",
    off: "Crossings are priced — click to let the route spend them to reach what it is after",
  },
];

export const FACTORS: readonly Factor[] = [
  {
    key: "tree",
    label: "Prefer tree cover",
    Icon: PiTreeEvergreenFill,
    max: MAX_TREE_WEIGHT,
    tint: "text-brand-600 dark:text-brand-400",
    color: "#059669",
  },
  {
    key: "shade",
    label: "Prefer sun or shade",
    Icon: MdWbSunny,
    max: MAX_SHADE_WEIGHT,
    signed: true,
    tint: "text-amber-600 dark:text-amber-400",
    color: "#f59e0b",
  },
  {
    key: "shelter",
    label: "Prefer shelter",
    Icon: MdWaterDrop,
    max: MAX_SHELTER_WEIGHT,
    // Shelter is priced from the sidewalk-shed decks and the canopy over what they do not cover, so
    // a city with no shed feed has nothing to shelter under: `shelterAttrOf` returns 0 for every
    // edge of it (src/routing/cost.ts).
    overlay: "scaffolding",
    tint: "text-sky-600 dark:text-sky-400",
    color: "#0284c7",
  },
  {
    key: "landmark",
    label: "Pass landmarks",
    Icon: MdAccountBalance,
    max: MAX_LANDMARK_WEIGHT,
    tint: "text-amber-600 dark:text-amber-400",
    color: "#f59e0b",
    overlay: "landmarks",
  },
  {
    key: "art",
    label: "Pass public art",
    Icon: MdPalette,
    max: MAX_ART_WEIGHT,
    tint: "text-fuchsia-600 dark:text-fuchsia-400",
    color: "#d946ef",
    overlay: "art",
  },
  {
    key: "historic",
    label: "Prefer historic areas",
    // The overlay's own glyph and indigo — deliberately not the landmarks amber, which prices a
    // different thing: passing one designated building, rather than walking inside a designated
    // neighbourhood.
    Icon: MdMapsHomeWork,
    max: MAX_HISTORIC_WEIGHT,
    tint: "text-indigo-600 dark:text-indigo-400",
    color: "#4338ca",
    overlay: "historic",
  },
  {
    key: "highway",
    label: "Avoid highways",
    Icon: MdDirectionsCar,
    max: MAX_HIGHWAY_WEIGHT,
    tint: "text-rose-600 dark:text-rose-400",
    color: "#ef4444",
  },
  {
    key: "industrial",
    label: "Avoid industrial areas",
    Icon: MdFactory,
    max: MAX_INDUSTRIAL_WEIGHT,
    tint: "text-pink-600 dark:text-pink-400",
    color: "#db2777",
    overlay: "industrial",
  },
  {
    key: "hill",
    label: "Avoid hills",
    Icon: MdTerrain,
    max: MAX_HILL_WEIGHT,
    tint: "text-amber-700 dark:text-amber-500",
    color: "#b45309",
    overlay: "elevation",
  },
  {
    key: "commercial",
    label: "Prefer commercial streets",
    Icon: MdStorefront,
    max: MAX_COMMERCIAL_WEIGHT,
    tint: "text-violet-600 dark:text-violet-400",
    color: "#6d28d9",
    overlay: "commercial",
  },
  {
    key: "ferry",
    label: "Prefer ferries",
    Icon: PiBoatFill,
    max: MAX_FERRY_WEIGHT,
    tint: "text-blue-600 dark:text-blue-400",
    color: "#2563eb",
    overlay: "ferries",
  },
];

export const factorPercent = (factor: Factor, weight: number): number =>
  Math.round((weight / factor.max) * 100);

// The reading beside a factor's slider. No per cent sign anywhere: every number on this map is one
// of these, they are all read against each other rather than against a quantity of anything, and
// eleven of them in a row with a sign each is a lot of punctuation for no information. The signed
// factor keeps its direction, which is the one thing its number does not say on its own.
export function factorReading(factor: Factor, weight: number): string {
  const value = factorPercent(factor, weight);
  if (!factor.signed) {
    return `${value}`;
  } else if (value === 0) {
    return "off";
  } else {
    return value > 0 ? `${value} sun` : `${-value} shade`;
  }
}

// A factor's slider, tracked in its own colour. The two pages show the same weight, so they show it
// through the same control rather than through two that have to be kept in step.
// The steps a slider moves in, as percentages. Twenty positions either way rather than a hundred:
// nobody is choosing between 63% and 64% tree cover, and a coarse step is what makes the same drag
// land on the same number twice. The signed one is coarser still because it spends its travel on two
// directions, so 10% keeps its two halves the same twenty steps the others get.
const STEP = 5;
const SIGNED_STEP = 10;

export function stepFor(factor: Factor): number {
  return factor.signed ? SIGNED_STEP : STEP;
}

export function FactorSlider({
  id,
  factor,
  weight,
  disabled,
  className,
  onChange,
}: {
  id?: string;
  factor: Factor;
  weight: number;
  disabled?: boolean;
  className?: string;
  onChange: (weight: number) => void;
}) {
  const value = factorPercent(factor, weight);
  return (
    <input
      id={id}
      type="range"
      min={factor.signed ? -100 : 0}
      max={100}
      step={stepFor(factor)}
      value={value}
      disabled={disabled}
      onChange={(event) =>
        onChange(
          (Number.parseInt(event.target.value, 10) / 100) * factor.max,
        )
      }
      aria-label={factor.label}
      className={`scenery-slider ${className ?? ""}`}
      style={
        {
          "--fill": factor.color,
          // A signed slider fills from the centre, so map −100..100 to a 0..100 track.
          "--pct": factor.signed ? `${(value + 100) / 2}%` : `${value}%`,
        } as CSSProperties
      }
    />
  );
}
