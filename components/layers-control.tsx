"use client";

import { useEffect, useRef, useState } from "react";
import { FiCheck, FiCloudOff, FiLayers, FiSliders } from "react-icons/fi";
import type { City } from "../src/cities";
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
} from "../src/overlays/registry";
import { useUnreachableLayers } from "../src/overlays/status";
import { orderedOverlays } from "../src/settings/store";
import { useSettings } from "./use-settings";

interface LayersControlProps {
  city: City;
  active: ReadonlySet<OverlayId>;
  onToggle: (id: OverlayId) => void;
  onSettings: (section?: string) => void;
}

const ROW_BASE =
  "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium";
const ROW_ACTIVE = `${ROW_BASE} text-brand-600 dark:text-brand-400`;
const ROW_IDLE = `${ROW_BASE} text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60`;

export default function LayersControl({
  city,
  active,
  onToggle,
  onSettings,
}: LayersControlProps) {
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const unreachable = useUnreachableLayers();
  const settings = useSettings();

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // The button wears the single active layer's own glyph when exactly one is on, so the toolbar hints
  // at what's showing; with none or several on it falls back to the generic layers icon.
  // The city's own layers, in the reader's order and without the ones they have hidden
  // (src/settings/store.ts).
  const offered = orderedOverlays(city.overlays, settings)
    .map((id) => OVERLAYS.find((overlay) => overlay.id === id))
    .filter((overlay) => overlay !== undefined);
  const activeEntries = offered.filter((overlay) => active.has(overlay.id));
  const soleEntry = activeEntries.length === 1 ? activeEntries[0] : null;

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={
          activeEntries.length > 0
            ? `Map layers (${activeEntries.map((entry) => overlayLabel(entry, city)).join(", ")})`
            : "Map layers"
        }
        title="Map layers"
        className={`grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800 ${activeEntries.length > 0 ? "text-brand-600 dark:text-brand-400" : "text-slate-500 dark:text-slate-400"}`}
      >
        {soleEntry ? (
          soleEntry.icon
        ) : (
          <FiLayers className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
      {menuOpen ? (
        <div
          role="menu"
          // The cap is on the menu; the ROWS scroll and the footer stays put, because that footer is
          // how a layer gets hidden and it is wanted most when the list has grown long enough to
          // need scrolling. `overflow-hidden` keeps the rounded corners over the scrolling child.
          className="toolbar-menu-shell absolute right-0 mt-2 flex w-44 origin-top-right flex-col overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
        >
          <div className="toolbar-menu-scroll py-1">
            {offered.map((overlay) => {
              const on = active.has(overlay.id);
              // A layer whose data did not arrive draws nothing, which on a map is indistinguishable
              // from a layer with nothing to draw. The glyph is what tells the two apart, and it
              // replaces the tick rather than crowding it — a layer that is on but showing you
              // nothing is not in the state the tick claims.
              const lost = on && unreachable.has(overlay.id);
              return (
                <button
                  key={overlay.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => onToggle(overlay.id)}
                  className={on ? ROW_ACTIVE : ROW_IDLE}
                  title={
                    lost ? "This layer's data could not be loaded" : undefined
                  }
                >
                  {overlay.icon}
                  {overlayLabel(overlay, city)}
                  {lost ? (
                    <FiCloudOff
                      className="ml-auto h-4 w-4 text-slate-400 dark:text-slate-500"
                      aria-label="data could not be loaded"
                    />
                  ) : on ? (
                    <FiCheck className="ml-auto h-4 w-4" aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onSettings("layers");
            }}
            className={`${ROW_IDLE} shrink-0 border-t border-slate-200/60 text-slate-500 dark:border-slate-700/60 dark:text-slate-400`}
          >
            <FiSliders className="h-4 w-4" aria-hidden="true" />
            Layer settings…
          </button>
        </div>
      ) : null}
    </div>
  );
}
