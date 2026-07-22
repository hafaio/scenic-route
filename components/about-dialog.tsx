"use client";

import { useEffect } from "react";
import { FiMapPin, FiX } from "react-icons/fi";

interface AboutDialogProps {
  onClose: () => void;
}

// One row in the data-provenance list: what a layer is, and where it comes from.
function Source({ label, detail }: { label: string; detail: string }) {
  return (
    <li className="flex flex-col">
      <span className="font-medium text-slate-700 dark:text-slate-200">
        {label}
      </span>
      <span className="text-slate-500 dark:text-slate-400">{detail}</span>
    </li>
  );
}

export default function AboutDialog({ onClose }: AboutDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close about"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-md md:rounded-3xl md:p-7"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700 md:hidden" />
        <div className="flex items-start gap-3">
          <span className="scenic-logo-pin grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg">
            <FiMapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="about-title"
              className="text-lg font-semibold tracking-tight"
            >
              Scenic Route
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Nicer ways to walk the city
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <FiX />
          </button>
        </div>

        <div className="mt-5 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          <p>
            Scenic Route finds nicer ways to walk across New York. Use
            Directions to plan a path — weighting it toward tree cover, sun or
            shade, landmarks, public art, nice commercial streets and ferries,
            and away from highways — or switch between the map overlays to
            explore what's around you.
          </p>
          <p>
            To use it, tap the layers button to toggle overlays like tree canopy
            or building shade, and drag the clock to see how shade shifts
            through the day. Open Directions to set a start and destination,
            then open the sliders to bias the route toward what you care about —
            the summary shows how much of each the route picks up. Drag either
            endpoint on the map to nudge the route, and drop it to lock the new
            point in.
          </p>
        </div>

        <div className="mt-6 border-t border-slate-200/60 pt-4 dark:border-slate-700/60">
          <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Data
          </p>
          <ul className="mt-2 space-y-2 text-xs">
            <Source
              label="Tree canopy"
              detail="2017 LiDAR land-cover survey · NYC Open Data"
            />
            <Source
              label="Tree genus"
              detail="NYC Parks Forestry (ForMS) · NYC Open Data"
            />
            <Source
              label="Streets"
              detail="NYC Street Centerline (CSCL) · NYC Open Data"
            />
            <Source
              label="Paths & street trees"
              detail="OpenStreetMap contributors (ODbL)"
            />
            <Source
              label="Ferries"
              detail="Staten Island Ferry (NYC DOT) & NYC Ferry GTFS"
            />
            <Source
              label="Landmarks"
              detail="LPC Individual Landmark Sites · NYC Open Data"
            />
            <Source
              label="Public art"
              detail="PDC Outdoor Public Art · NYC Open Data, and OpenStreetMap"
            />
            <Source
              label="Highways & rail"
              detail="OpenStreetMap contributors (ODbL)"
            />
            <Source
              label="Building shade"
              detail="NYC Building Footprints · NYC Open Data"
            />
            <Source
              label="Commercial streets"
              detail="PLUTO, Dining Out & Open Streets · NYC Open Data, and OpenStreetMap"
            />
            <Source label="Basemap" detail="CARTO · OpenStreetMap" />
          </ul>
        </div>
      </div>
    </div>
  );
}
