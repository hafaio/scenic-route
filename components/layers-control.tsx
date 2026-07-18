"use client";

import { useEffect, useRef, useState } from "react";
import { FiCheck, FiLayers, FiSlash } from "react-icons/fi";
import { OVERLAYS, type OverlayId } from "../src/overlays/registry";

interface LayersControlProps {
  activeOverlay: OverlayId | null;
  onSelect: (id: OverlayId | null) => void;
}

const ROW_BASE =
  "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium";
const ROW_ACTIVE = `${ROW_BASE} text-brand-600 dark:text-brand-400`;
const ROW_IDLE = `${ROW_BASE} text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60`;

export default function LayersControl({
  activeOverlay,
  onSelect,
}: LayersControlProps) {
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  const choose = (id: OverlayId | null) => {
    onSelect(id);
    setMenuOpen(false);
  };

  // When a layer is on, the button wears that layer's own glyph (in brand colour) so the toolbar
  // shows what's active; with nothing on, it falls back to the generic layers icon.
  const activeEntry = OVERLAYS.find((overlay) => overlay.id === activeOverlay);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={
          activeEntry ? `Map layers (${activeEntry.label})` : "Map layers"
        }
        title="Map layers"
        className={`grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800 ${activeEntry ? "text-brand-600 dark:text-brand-400" : "text-slate-500 dark:text-slate-400"}`}
      >
        {activeEntry ? (
          activeEntry.icon
        ) : (
          <FiLayers className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
      {menuOpen ? (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-44 origin-top-right overflow-hidden rounded-2xl bg-white/95 py-1 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
        >
          {OVERLAYS.map((overlay) => {
            const active = overlay.id === activeOverlay;
            return (
              <button
                key={overlay.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => choose(overlay.id)}
                className={active ? ROW_ACTIVE : ROW_IDLE}
              >
                {overlay.icon}
                {overlay.label}
                {active ? (
                  <FiCheck className="ml-auto h-4 w-4" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeOverlay === null}
            onClick={() => choose(null)}
            className={activeOverlay === null ? ROW_ACTIVE : ROW_IDLE}
          >
            <FiSlash className="h-4 w-4" aria-hidden="true" />
            Off
            {activeOverlay === null ? (
              <FiCheck className="ml-auto h-4 w-4" aria-hidden="true" />
            ) : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}
