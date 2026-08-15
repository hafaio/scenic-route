"use client";

import { type ComponentType, useEffect, useMemo, useState } from "react";
import { FiCheck, FiMap, FiSearch, FiX } from "react-icons/fi";
import { GiSuspensionBridge, GiTorch } from "react-icons/gi";
import { CITIES, type City } from "../src/cities";

// Something of the place rather than the same pin twice: the torch stands in for the Statue of
// Liberty, which react-icons has no icon of, and the suspension bridge for the Golden Gate. A city
// with none named falls back to a map pin, which is honest — better an obviously generic mark than
// one that gestures at the wrong landmark.
const CITY_ICONS: Record<
  string,
  ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  nyc: GiTorch,
  sf: GiSuspensionBridge,
};

interface CityDialogProps {
  city: City;
  onSelect: (city: City) => void;
  onClose: () => void;
}

// What each city offers, named the way the toolbar's overlay switcher names it, so the list says
// what changes by switching rather than only where. A city carries a handful of these; the ones a
// reader would look for (trees, hills, ferries) are what distinguishes one entry from another.
const OVERLAY_LABELS: Record<string, string> = {
  canopy: "Tree cover",
  genus: "Species",
  elevation: "Elevation",
  landmarks: "Landmarks",
  art: "Public art",
  ferries: "Ferries",
  highways: "Highways",
  commercial: "Shops",
  shade: "Shade",
  scaffolding: "Scaffolding",
};

// The search filter is a plain case-folded substring over the name. Not a fuzzy match: the list is
// short enough to scan, and a fuzzy match on a short list mostly surprises.
function matches(city: City, query: string): boolean {
  return city.name.toLowerCase().includes(query.trim().toLowerCase());
}

export default function CityDialog({
  city,
  onSelect,
  onClose,
}: CityDialogProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(
    () => CITIES.filter((entry) => matches(entry, query)),
    [query],
  );

  // The search box earns its place only once the list is long enough that scanning it is work.
  const searchable = CITIES.length > 8;

  return (
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close city picker"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="city-title"
        className="relative flex max-h-[90dvh] w-full flex-col rounded-t-3xl bg-white p-6 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-md md:rounded-3xl md:p-7"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700 md:hidden" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="city-title"
              className="text-lg font-semibold text-slate-800 dark:text-slate-100"
            >
              Choose a city
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              One city is active at a time — switching swaps the map, the
              overlays and the routing graph.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <FiX />
          </button>
        </div>

        {searchable ? (
          <label className="mt-4 flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm dark:bg-slate-700/60">
            <FiSearch className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search cities"
              aria-label="Search cities"
              className="w-full bg-transparent text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-100"
            />
          </label>
        ) : null}

        <ul className="mt-4 flex flex-col gap-1 overflow-y-auto">
          {shown.map((entry) => {
            const active = entry.id === city.id;
            const Icon = CITY_ICONS[entry.id] ?? FiMap;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => {
                    onSelect(entry);
                    onClose();
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-slate-100 dark:hover:bg-slate-700 ${
                    active ? "bg-slate-100 dark:bg-slate-700/70" : ""
                  }`}
                >
                  <Icon className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {entry.name}
                    </span>
                    <span className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                      {entry.overlays
                        .map((id) => OVERLAY_LABELS[id] ?? id)
                        .join(" · ")}
                    </span>
                  </span>
                  {active ? (
                    <FiCheck className="ml-auto shrink-0 text-brand-600 dark:text-brand-400" />
                  ) : null}
                </button>
              </li>
            );
          })}
          {shown.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              No city matches “{query.trim()}”.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
