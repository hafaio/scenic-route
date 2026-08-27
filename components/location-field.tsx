"use client";

import { useEffect, useRef, useState } from "react";
import { FiCrosshair, FiNavigation, FiX } from "react-icons/fi";
import { MdOutlineHome, MdOutlinePlace, MdSignpost } from "react-icons/md";
import { PiTrainSimpleFill } from "react-icons/pi";
import {
  ADDRESS_RESULT_TYPE,
  type GeocodeResult,
  INDEX_RESULT_TYPE,
  STREET_RESULT_TYPE,
  SUBWAY_RESULT_TYPE,
  searchAddress,
} from "../src/geocode";

const SEARCH_DEBOUNCE_MS = 300;
// The tallest the suggestions may ever be, before the room above the field is taken into account.
const MAX_SUGGESTION_HEIGHT = 256;
// Clearance kept above the list so it never sits flush against the top of the screen.
const SUGGESTION_MARGIN = 8;
const BLUR_CLOSE_MS = 120; // let a result click land before the blur closes the list

// Words the app put in a box, with whatever the index has already said about them.
export interface DestPrefill {
  text: string;
  results: GeocodeResult[];
}

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
  // Words the app has typed into the box on the reader's behalf — a shared link's destination that
  // resolved to nothing certain — together with the answers it already found for them. It arrives
  // after mount, so it is applied whenever it changes rather than as an initial value. The answers
  // are handed over rather than searched for again because this arrives on a cold load, when the
  // box's own debounced search would ask an index that has not finished loading, get an empty list,
  // and never be asked again — the draft it keys off never changes after the prefill sets it. The
  // focus is deliberately left alone: the list opens upward out of the panel, and a keyboard would
  // cover the answers the reader is here to pick from.
  prefill?: DestPrefill | null;
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
  prefill,
}: LocationFieldProps) {
  // The in-progress typing; null means "not editing", so the box mirrors the committed label instead.
  const [draft, setDraft] = useState<string | null>(null);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const list = useRef<HTMLUListElement | null>(null);
  const [roomAbove, setRoomAbove] = useState<number>(MAX_SUGGESTION_HEIGHT);

  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [open, setOpen] = useState<boolean>(false);

  // Retiring a prefill takes its words back out of the box, which is what lets the committed label
  // show through: the app retires one only once the destination question has been answered — by the
  // link resolving to a door, or by the reader picking, clearing or tapping one out.
  useEffect(() => {
    if (prefill) {
      setDraft(prefill.text);
      setResults(prefill.results);
      setActiveIndex(-1);
      setOpen(true);
    } else {
      setDraft(null);
      setResults([]);
      setActiveIndex(-1);
      setOpen(false);
    }
  }, [prefill]);

  const value = draft ?? label ?? "";
  const showCurrentRow = Boolean(currentLocationLabel && onUseCurrentLocation);
  const dropdownOpen = open && (showCurrentRow || results.length > 0);

  // Remeasured whenever the list opens or its contents change, because the field it hangs from moves
  // as the panel above it grows and shrinks. The deps are those changes, not anything the body
  // reads — measuring the DOM is exactly the case the exhaustive-deps rule cannot see.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are what moves the anchor
  useEffect(() => {
    const anchor = list.current?.parentElement;
    if (!anchor) {
      return;
    }
    const above = anchor.getBoundingClientRect().top - SUGGESTION_MARGIN;
    setRoomAbove(Math.max(0, Math.min(MAX_SUGGESTION_HEIGHT, above)));
  }, [dropdownOpen, results.length]);

  // Debounced search driven off the draft only; an answer to a draft that has since been typed over
  // is dropped rather than shown, so a slow one can't overwrite a newer one. A null/empty draft
  // searches nothing.
  useEffect(() => {
    const trimmed = draft?.trim() ?? "";
    if (!trimmed) {
      setResults([]);
      setActiveIndex(-1);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      searchAddress(trimmed)
        .then((hits) => {
          if (!stale) {
            setResults(hits);
            setActiveIndex(-1);
            setOpen(true);
          }
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
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
        // Opens UPWARD out of the route panel, which is why that panel takes no overflow of its own.
        // That leaves this list the one surface whose room cannot be written down: it is anchored to
        // a field that moves as the panel grows, so the cap is measured rather than declared — the
        // same invariant as every other menu, arrived at the only way this one can.
        <ul
          ref={list}
          style={{ maxHeight: roomAbove }}
          className="absolute bottom-full left-0 z-10 mb-1 w-full overflow-y-auto overscroll-contain rounded-xl bg-white shadow-xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10"
        >
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
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  index === activeIndex
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                    : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60"
                }`}
              >
                {result.type === ADDRESS_RESULT_TYPE ? (
                  // A house number out of the city's own address file, which is a door rather than
                  // the whole street the signpost below stands for.
                  <MdOutlineHome
                    className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
                    aria-hidden="true"
                  />
                ) : result.type === SUBWAY_RESULT_TYPE ? (
                  <PiTrainSimpleFill
                    className="h-4 w-4 shrink-0 text-[#0062cf]"
                    aria-hidden="true"
                  />
                ) : result.type === STREET_RESULT_TYPE ? (
                  // A street is one point on the whole of it, which is a coarser answer than the
                  // rest of the list gives. Its own glyph is what says so at a glance.
                  <MdSignpost
                    className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
                    aria-hidden="true"
                  />
                ) : result.type === INDEX_RESULT_TYPE ? (
                  // A named place off the city's own index. One pin for all of them: the row carries
                  // a category, but a glyph per category is 1,639 of them, and what the pin has to
                  // say here is that this is a place rather than a door or a street.
                  <MdOutlinePlace
                    className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
                    aria-hidden="true"
                  />
                ) : null}
                <span className="truncate">{result.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
