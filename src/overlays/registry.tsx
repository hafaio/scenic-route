"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { MdAccountBalance, MdDirectionsCar, MdPalette } from "react-icons/md";
import { PiBoatFill, PiTreeFill, PiTreeStructureFill } from "react-icons/pi";
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
const GenusLayer = dynamic(() => import("../../components/genus-layer"), {
  ssr: false,
});
const PoiLayer = dynamic(() => import("../../components/poi-layer"), {
  ssr: false,
});
const LinesLayer = dynamic(() => import("../../components/lines-layer"), {
  ssr: false,
});

export type OverlayId =
  | "canopy"
  | "genus"
  | "landmarks"
  | "art"
  | "ferries"
  | "highways";

export interface OverlayDef {
  id: OverlayId;
  label: string; // menu text
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
const HIGHWAY_COLOR = "#ef4444"; // red-500

// The single source of truth for the overlay switcher: this ordered array drives both the layers
// control menu and what the map mounts. Adding a layer (highways, ferries, building-shade) is one
// appended entry plus its layer component — no other file changes.
export const OVERLAYS: readonly OverlayDef[] = [
  {
    id: "canopy",
    label: "Tree canopy",
    icon: <PiTreeFill className="h-4 w-4" aria-hidden="true" />,
    render: () => (
      <>
        <CanopyLayer />
        <StreetScoreLayer />
      </>
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
    id: "highways",
    label: "Highways",
    icon: <MdDirectionsCar className="h-4 w-4 text-red-500" aria-hidden="true" />,
    render: () => <LinesLayer dir="highways" format="hway" color={HIGHWAY_COLOR} />,
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
