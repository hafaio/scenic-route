"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { PiTreeFill } from "react-icons/pi";

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

export type OverlayId = "canopy";

export interface OverlayDef {
  id: OverlayId;
  label: string; // menu text
  icon: ReactNode; // menu glyph; inherits the row's text colour
  render: () => ReactNode; // the Leaflet layer(s) this overlay mounts on the map
}

// The single source of truth for the overlay switcher: this ordered array drives both the
// layers control menu and what the map mounts. Adding a backlog layer (individual trees,
// highways, landmarks, building-shade) is one appended entry plus its layer component — no
// other file changes.
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
];

// Validates a persisted overlay id against the registry so a stale localStorage value can be
// discarded rather than trusted.
export function isOverlayId(value: string): value is OverlayId {
  return OVERLAYS.some((overlay) => overlay.id === value);
}
