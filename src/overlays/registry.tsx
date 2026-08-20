"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { City } from "../cities";
import {
  MdAccountBalance,
  MdConstruction,
  MdDirectionsCar,
  MdFactory,
  MdPalette,
  MdTerrain,
  MdStorefront,
  MdWbShade,
} from "react-icons/md";
import {
  PiBoatFill,
  PiTrainSimpleFill,
  PiTreeFill,
  PiTreeStructureFill,
} from "react-icons/pi";
import ElevationLegend from "../../components/elevation-legend";
import TreeLegend from "../../components/tree-legend";

// The Leaflet layer components touch `window` at import, so they load only in the browser —
// the same ssr:false isolation the map itself uses. That also lets the layers control import
// this registry for its menu without pulling Leaflet into the server bundle.
const StreetScoreLayer = dynamic(
  () => import("../../components/street-score-layer"),
  { ssr: false },
);
const CanopyLayer = dynamic(() => import("../../components/canopy-layer"), {
  ssr: false,
});
const GenusLayer = dynamic(() => import("../../components/genus-gl-layer"), {
  ssr: false,
});
const DiningLayer = dynamic(() => import("../../components/dining-layer"), {
  ssr: false,
});
const ShadeLayer = dynamic(() => import("../../components/shade-layer"), {
  ssr: false,
});
const PoiLayer = dynamic(() => import("../../components/poi-layer"), {
  ssr: false,
});
const LinesLayer = dynamic(() => import("../../components/lines-layer"), {
  ssr: false,
});
const SubwayLayer = dynamic(() => import("../../components/subway-layer"), {
  ssr: false,
});
const ShedLayer = dynamic(() => import("../../components/shed-layer"), {
  ssr: false,
});
const IndustrialLayer = dynamic(
  () => import("../../components/industrial-layer"),
  { ssr: false },
);
const ElevationLayer = dynamic(
  () => import("../../components/elevation-layer"),
  { ssr: false },
);

export type OverlayId =
  | "canopy"
  | "genus"
  | "landmarks"
  | "art"
  | "ferries"
  | "subway"
  | "highways"
  | "commercial"
  | "industrial"
  | "shade"
  | "scaffolding"
  | "elevation";

// A layer's menu text for the city it is being shown in.
export function overlayLabel(overlay: OverlayDef, city: City): string {
  return typeof overlay.label === "string" ? overlay.label : overlay.label(city);
}

export interface OverlayDef {
  id: OverlayId;
  // Menu text. A function where the layer is the same artifact in every city but goes by a different
  // name in each — New York rides the subway, San Francisco rides Muni and BART.
  label: string | ((city: City) => string);
  icon: ReactNode; // menu glyph; a tinted one shows the layer's colour code
  render: () => ReactNode; // the Leaflet layer(s) this overlay mounts on the map
  legend?: ReactNode; // floating key shown while this overlay is active
  // When on, no other overlay is, and turning on any other turns this off. Tree genus recolours
  // every tree, so it does not compose with the additive dot/line layers.
  exclusive?: boolean;
}

// The dot colours match the route panel's scenery sliders (landmark amber, art fuchsia), so the map
// and the controls read as one palette.
const LANDMARK_COLOR = "#f59e0b"; // amber-500
const ART_COLOR = "#d946ef"; // fuchsia-500
const FERRY_COLOR = "#2563eb"; // blue-600, the route layer's ferry-leg colour
// The subway draws each route in the MTA's own published colour (in subway.ts); only its menu glyph
// is tinted here, to the A/C/E blue the feed publishes, so the switcher still reads as a colour code.
const HIGHWAY_COLOR = "#ef4444"; // red-500
// The industrial overlay fills its lots in pink-600 (in src/tiles/industrial.ts, at the alpha the
// wash needs); only its menu glyph is tinted here, so the switcher still reads as the layer's
// colour code.
// Scaffolding draws its own orange-600 bands (in shed-layer.tsx); only its menu glyph is tinted
// here, so the switcher still reads as the layer's colour code.
// The "cute commercial" overlay is a heat field with its own violet ramp (in dining-layer.tsx); only
// its menu glyph is tinted here, to violet-600, so the switcher still reads as the layer's colour code.

// The single source of truth for the overlay switcher: this ordered array drives both the layers
// control menu and what the map mounts. Adding a layer (highways, ferries, building-shade) is one
// appended entry plus its layer component — no other file changes.
export const OVERLAYS: readonly OverlayDef[] = [
  {
    id: "canopy",
    label: "Tree canopy",
    // teal-600, the ramp's own mid stop — the icon says what the layer paints rather than
    // inheriting the menu's text colour, as every other overlay's does.
    icon: <PiTreeFill className="h-4 w-4 text-teal-600" aria-hidden="true" />,
    render: () => (
      <>
        <CanopyLayer />
        <StreetScoreLayer />
      </>
    ),
  },
  {
    id: "commercial",
    label: "Commercial",
    icon: (
      <MdStorefront className="h-4 w-4 text-violet-600" aria-hidden="true" />
    ),
    render: () => <DiningLayer />,
  },
  {
    id: "shade",
    label: "Shade",
    icon: <MdWbShade className="h-4 w-4 text-slate-500" aria-hidden="true" />,
    render: () => <ShadeLayer />,
  },
  {
    id: "elevation",
    label: "Elevation",
    icon: <MdTerrain className="h-4 w-4 text-amber-700" aria-hidden="true" />,
    render: () => <ElevationLayer />,
    legend: <ElevationLegend />,
  },
  {
    id: "scaffolding",
    label: "Scaffolding",
    icon: (
      <MdConstruction className="h-4 w-4 text-orange-600" aria-hidden="true" />
    ),
    render: () => <ShedLayer />,
  },
  {
    id: "landmarks",
    label: "Landmarks",
    icon: (
      <MdAccountBalance
        className="h-4 w-4 text-amber-500"
        aria-hidden="true"
      />
    ),
    render: () => (
      <PoiLayer
        dir="landmarks"
        magic="LMRK"
        color={LANDMARK_COLOR}
        labelAnchor="top"
      />
    ),
  },
  {
    id: "art",
    label: "Public art",
    icon: <MdPalette className="h-4 w-4 text-fuchsia-500" aria-hidden="true" />,
    render: () => (
      <PoiLayer dir="art" magic="ARTW" color={ART_COLOR} labelAnchor="bottom" />
    ),
  },
  {
    id: "ferries",
    label: "Ferry routes",
    icon: <PiBoatFill className="h-4 w-4 text-blue-600" aria-hidden="true" />,
    render: () => <LinesLayer dir="ferries" format="ferr" color={FERRY_COLOR} />,
  },
  {
    id: "subway",
    label: (city) => (city.id === "sf" ? "Muni & BART" : "Subway"),
    icon: (
      <PiTrainSimpleFill
        className="h-4 w-4 text-[#0062cf]"
        aria-hidden="true"
      />
    ),
    render: () => <SubwayLayer />,
  },
  {
    id: "highways",
    label: "Highways",
    icon: <MdDirectionsCar className="h-4 w-4 text-red-500" aria-hidden="true" />,
    render: () => <LinesLayer dir="highways" format="hway" color={HIGHWAY_COLOR} />,
  },
  {
    id: "industrial",
    label: "Industrial",
    icon: <MdFactory className="h-4 w-4 text-pink-600" aria-hidden="true" />,
    render: () => <IndustrialLayer />,
  },
  // Tree genus recolours every tree, so it sits last and is exclusive — it does not compose with the
  // additive dot/line layers.
  {
    id: "genus",
    label: "Tree genus",
    icon: <PiTreeStructureFill className="h-4 w-4" aria-hidden="true" />,
    render: () => <GenusLayer />,
    legend: <TreeLegend />,
    exclusive: true,
  },
];

// Validates a persisted overlay id against the registry so a stale localStorage value can be
// discarded rather than trusted.
export function isOverlayId(value: string): value is OverlayId {
  return OVERLAYS.some((overlay) => overlay.id === value);
}
