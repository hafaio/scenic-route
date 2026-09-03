"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { IconType } from "react-icons";
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
import { useMapTheme } from "../../components/use-map-theme";
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

// A menu glyph in the layer's own colour. Every one of those is a light/dark pair, so the glyph has
// to read the theme the map is drawing in: a Tailwind tint only ever shows one half of the pair, and
// on a night map that left the menu naming a colour the map was no longer painting.
function LayerIcon({
  Icon,
  color,
}: {
  Icon: IconType;
  color: Record<ThemeName, string>;
}) {
  const theme = useMapTheme();
  return (
    <Icon
      className="h-4 w-4"
      style={{ color: color[theme] }}
      aria-hidden="true"
    />
  );
}

// A layer's menu text for the city it is being shown in.
export function overlayLabel(overlay: OverlayDef, city: City): string {
  return typeof overlay.label === "string" ? overlay.label : overlay.label(city);
}

// The one colour this layer's key swatches it with, in the theme the map is drawing in.
export function overlaySwatch(
  overlay: OverlayDef,
  theme: ThemeName,
): string | null {
  return overlay.swatch?.(theme) ?? null;
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
  // The colour the layer key swatches this one with, read off what the layer actually paints
  // with so the two cannot drift. Taken per theme, since every overlay's colour is a light/dark pair.
  // Null for a layer with no single colour to stand for it.
  swatch: ((theme: ThemeName) => string) | null;
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
    icon: <LayerIcon Icon={MdStorefront} color={COMMERCIAL_COLOR} />,
    swatch: (theme) => COMMERCIAL_COLOR[theme],
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
    icon: <LayerIcon Icon={MdMapsHomeWork} color={HISTORIC_COLOR} />,
    swatch: (theme) => HISTORIC_COLOR[theme],
    render: () => <HistoricLayer />,
  },
  {
    id: "legacy",
    // Just "Businesses". Every one of these has been trading fifty years — that is the whole entry
    // condition — so saying so in the label would be labelling the only kind there is.
    label: "Businesses",
    icon: <LayerIcon Icon={MdStorefront} color={LEGACY_COLOR} />,
    swatch: (theme) => LEGACY_COLOR[theme],
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
    icon: <LayerIcon Icon={MdAccountBalance} color={LANDMARK_COLOR} />,
    swatch: (theme) => LANDMARK_COLOR[theme],
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
    icon: <LayerIcon Icon={MdPalette} color={ART_COLOR} />,
    swatch: (theme) => ART_COLOR[theme],
    render: () => (
      <PoiLayer overlay="art" dir="art" magic="ARTW" color={ART_COLOR} labelAnchor="bottom" />
    ),
  },
  {
    id: "ferries",
    label: "Ferry routes",
    icon: <LayerIcon Icon={PiBoatFill} color={FERRY_COLOR} />,
    swatch: (theme) => FERRY_COLOR[theme],
    render: () => <LinesLayer overlay="ferries" dir="ferries" format="ferr" color={FERRY_COLOR} />,
  },
  {
    id: "subway",
    label: (city) => (city.id === "sf" ? "Muni & BART" : "Subway"),
    icon: <LayerIcon Icon={PiTrainSimpleFill} color={SUBWAY_COLOR} />,
    swatch: (theme) => SUBWAY_COLOR[theme],
    render: () => <SubwayLayer />,
  },
  {
    id: "highways",
    label: "Highways",
    icon: <LayerIcon Icon={MdDirectionsCar} color={HIGHWAY_COLOR} />,
    swatch: (theme) => HIGHWAY_COLOR[theme],
    render: () => <LinesLayer overlay="highways" dir="highways" format="hway" color={HIGHWAY_COLOR} />,
  },
  {
    id: "industrial",
    label: "Industrial",
    icon: <LayerIcon Icon={MdFactory} color={INDUSTRIAL_COLOR} />,
    swatch: (theme) => INDUSTRIAL_COLOR[theme],
    render: () => <IndustrialLayer />,
  },
  {
    id: "scaffolding",
    label: "Scaffolding",
    icon: <LayerIcon Icon={MdConstruction} color={SHED_COLOR} />,
    swatch: (theme) => SHED_COLOR[theme],
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
