"use client";

import { useEffect, useRef, useState } from "react";
import { FiCheck, FiLayers } from "react-icons/fi";
import { OVERLAYS, type OverlayId } from "../src/overlays/registry";

interface LayersControlProps {
  active: ReadonlySet<OverlayId>;
  onToggle: (id: OverlayId) => void;
}

const ROW_BASE =
  "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium";
const ROW_ACTIVE = `${ROW_BASE} text-brand-600 dark:text-brand-400`;
const ROW_IDLE = `${ROW_BASE} text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60`;

export default function LayersControl({
  active,
  onToggle,
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

  // The button wears the single active layer's own glyph when exactly one is on, so the toolbar hints
  // at what's showing; with none or several on it falls back to the generic layers icon.
  const activeEntries = OVERLAYS.filter((overlay) => active.has(overlay.id));
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
            ? `Map layers (${activeEntries.map((entry) => entry.label).join(", ")})`
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
          className="absolute right-0 mt-2 w-44 origin-top-right overflow-hidden rounded-2xl bg-white/95 py-1 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
        >
          {OVERLAYS.map((overlay) => {
            const on = active.has(overlay.id);
            return (
              <button
                key={overlay.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => onToggle(overlay.id)}
                className={on ? ROW_ACTIVE : ROW_IDLE}
              >
                {overlay.icon}
                {overlay.label}
                {on ? (
                  <FiCheck className="ml-auto h-4 w-4" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
