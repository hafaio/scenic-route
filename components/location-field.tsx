"use client";

import { useEffect, useState } from "react";
import { FiCrosshair, FiNavigation, FiX } from "react-icons/fi";
import { type GeocodeResult, searchAddress } from "../src/geocode";

const SEARCH_DEBOUNCE_MS = 300;
const BLUR_CLOSE_MS = 120; // let a result click land before the blur closes the list

interface LocationFieldProps {
  label: string | null; // committed selection text; null shows the placeholder
  placeholder: string;
  leadingIcon: React.ReactNode;
  armed: boolean; // this field owns map-pick mode
  canClear: boolean;
  clearLabel: string;
  pickLabel: string;
  onSelect: (result: GeocodeResult) => void;
  onClear: () => void;
  onArmPick: () => void;
  // When both are set, a "My location" row is prepended and the list opens on focus even when empty.
  currentLocationLabel?: string | null;
  onUseCurrentLocation?: () => void;
}

export default function LocationField({
  label,
  placeholder,
  leadingIcon,
  armed,
  canClear,
  clearLabel,
  pickLabel,
  onSelect,
  onClear,
  onArmPick,
  currentLocationLabel,
  onUseCurrentLocation,
}: LocationFieldProps) {
  // The in-progress typing; null means "not editing", so the box mirrors the committed label instead.
  const [draft, setDraft] = useState<string | null>(null);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [open, setOpen] = useState<boolean>(false);

  const value = draft ?? label ?? "";
  const showCurrentRow = Boolean(currentLocationLabel && onUseCurrentLocation);
  const dropdownOpen = open && (showCurrentRow || results.length > 0);

  // Debounced forward geocode driven off the draft only; the in-flight request is aborted when the
  // draft changes so a slow response can't overwrite a newer one. A null/empty draft searches nothing.
  useEffect(() => {
    const trimmed = draft?.trim() ?? "";
    if (!trimmed) {
      setResults([]);
      setActiveIndex(-1);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchAddress(trimmed, controller.signal)
        .then((hits) => {
          setResults(hits);
          setActiveIndex(-1);
          setOpen(true);
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft]);

  // Every commit path snaps the draft back to null so the box shows the freshly committed label.
  const commit = (): void => {
    setDraft(null);
    setResults([]);
    setActiveIndex(-1);
    setOpen(false);
  };

  const select = (result: GeocodeResult): void => {
    commit();
    onSelect(result);
  };

  const useCurrentLocation = (): void => {
    commit();
    onUseCurrentLocation?.();
  };

  const clear = (): void => {
    commit();
    onClear();
  };

  // Arming a map pick abandons any in-progress typing so the picked point's label fills the box.
  const armPick = (): void => {
    commit();
    onArmPick();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (!open || results.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = results[activeIndex] ?? results[0];
      if (chosen) {
        select(chosen);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-slate-400">
        {leadingIcon}
      </span>
      <input
        type="text"
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), BLUR_CLOSE_MS)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-16 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
      />
      <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
        {canClear ? (
          <button
            type="button"
            onClick={clear}
            aria-label={clearLabel}
            className="grid h-7 w-7 place-items-center rounded-full text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
          >
            <FiX className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={armPick}
          aria-label={pickLabel}
          aria-pressed={armed}
          className={`grid h-7 w-7 place-items-center rounded-full transition ${
            armed
              ? "bg-brand-100 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300"
              : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          }`}
        >
          <FiCrosshair className="h-4 w-4" />
        </button>
      </div>
      {dropdownOpen ? (
        <ul className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full overflow-y-auto rounded-xl bg-white shadow-xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10">
          {showCurrentRow ? (
            <li>
              <button
                type="button"
                // Keep focus on the input so the click always lands; a blur here would race the
                // close timer and swallow the selection.
                onMouseDown={(event) => event.preventDefault()}
                onClick={useCurrentLocation}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-brand-700 hover:bg-slate-50 dark:text-brand-300 dark:hover:bg-slate-700/60"
              >
                <FiNavigation className="h-4 w-4 shrink-0" aria-hidden="true" />
                {currentLocationLabel}
              </button>
            </li>
          ) : null}
          {results.map((result, index) => (
            <li key={result.placeId}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(result)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`block w-full truncate px-3 py-2 text-left text-sm ${
                  index === activeIndex
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                    : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60"
                }`}
              >
                {result.displayName}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
