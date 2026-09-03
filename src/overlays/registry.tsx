"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { City } from "../cities";
import {
  MdAccountBalance,
  MdConstruction,
  MdDirectionsCar,
  MdFactory,
  MdMapsHomeWork,
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
import { PALETTES, rgbCss, type ThemeName } from "../theme/palette";
import {
  ART_COLOR,
  COMMERCIAL_COLOR,
  FERRY_COLOR,
  HIGHWAY_COLOR,
  HISTORIC_COLOR,
  INDUSTRIAL_COLOR,
  LANDMARK_COLOR,
  LEGACY_COLOR,
  SHED_COLOR,
  SUBWAY_COLOR,
} from "./colors";

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
const HistoricLayer = dynamic(() => import("../../components/historic-layer"), {
  ssr: false,
});
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
  | "historic"
  | "legacy"
  | "shade"
  | "scaffolding"
  | "elevation";

// A layer's menu text for the city it is being shown in.
export function overlayLabel(overlay: OverlayDef, city: City): string {
  return typeof overlay.label === "string" ? overlay.label : overlay.label(city);
}

// The one colour this layer's key swatches it with, for the city's theme. A function where the
// layer draws through a ramp rather than in a flat colour, since a ramp has a light and a dark set.
export function overlaySwatch(
  overlay: OverlayDef,
  theme: ThemeName,
): string | null {
  return typeof overlay.swatch === "function"
    ? overlay.swatch(theme)
    : overlay.swatch;
}

// Genus recolours every tree rather than adding a colour to the map, so it goes solo. The toggle
// handler holds to that a click at a time; a whole set arriving at once — a link's `layers`, or the
// remembered one — has to be held to it here, or a hand-written `#layers=genus,canopy` draws both.
// Naming an exclusive layer at all is asking for that layer, so it is the one that survives.
export function applyExclusivity(ids: readonly OverlayId[]): OverlayId[] {
  const solo = ids.find(
    (id) => OVERLAYS.find((overlay) => overlay.id === id)?.exclusive,
  );
  return solo ? [solo] : [...ids];
}

export interface OverlayDef {
  id: OverlayId;
  // Menu text. A function where the layer is the same artifact in every city but goes by a different
  // name in each — New York rides the subway, San Francisco rides Muni and BART.
  label: string | ((city: City) => string);
  icon: ReactNode; // menu glyph; a tinted one shows the layer's colour code
  render: () => ReactNode; // the Leaflet layer(s) this overlay mounts on the map
  // The colour the multi-layer key swatches this one with, read off what the layer actually paints
  // with so the two cannot drift. Null for a layer with no single colour to stand for it.
  swatch: string | ((theme: ThemeName) => string) | null;
  legend?: ReactNode; // floating key shown while this overlay is active
  // When on, no other overlay is, and turning on any other turns this off. Tree genus recolours
  // every tree, so it does not compose with the additive dot/line layers.
  exclusive?: boolean;
}

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
    // The stop a leafy street lands on, rather than either end: the faint end is bare ground and the
    // full end is cover almost nowhere reaches.
    swatch: (theme) => rgbCss(PALETTES[theme].canopy.stops[4]),
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
    swatch: COMMERCIAL_COLOR,
    render: () => <DiningLayer />,
  },
  {
    id: "shade",
    label: "Shade",
    icon: <MdWbShade className="h-4 w-4 text-slate-500" aria-hidden="true" />,
    // Shade is one colour at varying strength, so the ramp has a single stop to take.
    swatch: (theme) => rgbCss(PALETTES[theme].shade.stops[0]),
    render: () => <ShadeLayer />,
  },
  {
    id: "elevation",
    label: "Elevation",
    icon: <MdTerrain className="h-4 w-4 text-amber-700" aria-hidden="true" />,
    // The summit end of the hypsometric ramp — the brown the layer reads as, where the valley green
    // it starts at would be mistaken for the canopy.
    swatch: (theme) => {
      const { stops } = PALETTES[theme].elevation;
      return rgbCss(stops[stops.length - 1]);
    },
    render: () => <ElevationLayer />,
    legend: <ElevationLegend />,
  },
  {
    id: "historic",
    // Whole landmarked neighbourhoods, not the individually landmarked buildings the "Landmarks"
    // overlay dots.
    label: "Historic",
    icon: (
      <MdMapsHomeWork className="h-4 w-4 text-indigo-700" aria-hidden="true" />
    ),
    swatch: HISTORIC_COLOR,
    render: () => <HistoricLayer />,
  },
  {
    id: "legacy",
    // Just "Businesses". Every one of these has been trading fifty years — that is the whole entry
    // condition — so saying so in the label would be labelling the only kind there is.
    label: "Businesses",
    icon: (
      <MdStorefront className="h-4 w-4 text-yellow-600" aria-hidden="true" />
    ),
    swatch: LEGACY_COLOR,
    render: () => (
      <PoiLayer
        overlay="legacy"
        dir="legacy"
        magic="LGCY"
        color={LEGACY_COLOR}
        labelAnchor="top"
      />
    ),
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
    swatch: LANDMARK_COLOR,
    render: () => (
      <PoiLayer
        overlay="landmarks"
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
    swatch: ART_COLOR,
    render: () => (
      <PoiLayer overlay="art" dir="art" magic="ARTW" color={ART_COLOR} labelAnchor="bottom" />
    ),
  },
  {
    id: "ferries",
    label: "Ferry routes",
    icon: <PiBoatFill className="h-4 w-4 text-blue-600" aria-hidden="true" />,
    swatch: FERRY_COLOR,
    render: () => <LinesLayer overlay="ferries" dir="ferries" format="ferr" color={FERRY_COLOR} />,
  },
  {
    id: "subway",
    label: (city) => (city.id === "sf" ? "Muni & BART" : "Subway"),
    icon: (
      <PiTrainSimpleFill
        className="h-4 w-4"
        style={{ color: SUBWAY_COLOR }}
        aria-hidden="true"
      />
    ),
    swatch: SUBWAY_COLOR,
    render: () => <SubwayLayer />,
  },
  {
    id: "highways",
    label: "Highways",
    icon: <MdDirectionsCar className="h-4 w-4 text-red-500" aria-hidden="true" />,
    swatch: HIGHWAY_COLOR,
    render: () => <LinesLayer overlay="highways" dir="highways" format="hway" color={HIGHWAY_COLOR} />,
  },
  {
    id: "industrial",
    label: "Industrial",
    icon: <MdFactory className="h-4 w-4 text-pink-600" aria-hidden="true" />,
    swatch: INDUSTRIAL_COLOR,
    render: () => <IndustrialLayer />,
  },
  {
    id: "scaffolding",
    label: "Scaffolding",
    icon: (
      <MdConstruction className="h-4 w-4 text-orange-600" aria-hidden="true" />
    ),
    swatch: SHED_COLOR,
    render: () => <ShedLayer />,
  },
  // Tree genus recolours every tree, so it sits last and is exclusive — it does not compose with the
  // additive dot/line layers.
  {
    id: "genus",
    label: "Tree genus",
    icon: <PiTreeStructureFill className="h-4 w-4" aria-hidden="true" />,
    swatch: null, // a colour per genus, and its own key to spend them in
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
