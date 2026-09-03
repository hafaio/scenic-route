"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FiCrosshair, FiNavigation, FiX } from "react-icons/fi";
import { type City, cityInSentence } from "../src/cities";
import { type GeocodeResult, searchPlaces } from "../src/geocode";
import { awaitNameIndex } from "../src/search/name-search";
import ResultList, {
  resultListKeyDown,
  SEARCH_DEBOUNCE_MS,
} from "./result-list";

// The tallest the suggestions may ever be, before the room above the field is taken into account.
const MAX_SUGGESTION_HEIGHT = 256;
// Clearance kept above the list so it never sits flush against the top of the screen.
const SUGGESTION_MARGIN = 8;
const BLUR_CLOSE_MS = 120; // let a result click land before the blur closes the list

// What the index has said about whatever is in the box. "Loading" is its own state rather than an
// empty list, because a field that shows nothing while the city's places are still being fetched
// tells a reader who typed early that their place does not exist.
type Suggestions =
  | { kind: "idle" } // nothing typed, so nothing asked
  | { kind: "loading" } // asked, but this city's index has not arrived
  | { kind: "answered"; results: GeocodeResult[] };

const IDLE: Suggestions = { kind: "idle" };
const NONE: readonly GeocodeResult[] = [];

// Words the app put in a box, with whatever the index has already said about them.
export interface DestPrefill {
  text: string;
  results: GeocodeResult[];
}

interface LocationFieldProps {
  city: City; // named in the no-match row, so it says where the search looked
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
  city,
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
  const [suggestions, setSuggestions] = useState<Suggestions>(IDLE);
  const list = useRef<HTMLUListElement | null>(null);
  const [roomAbove, setRoomAbove] = useState<number>(MAX_SUGGESTION_HEIGHT);
  const listId = useId();

  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [open, setOpen] = useState<boolean>(false);

  // Retiring a prefill takes its words back out of the box, which is what lets the committed label
  // show through: the app retires one only once the destination question has been answered — by the
  // link resolving to a door, or by the reader picking, clearing or tapping one out.
  useEffect(() => {
    if (prefill) {
      setDraft(prefill.text);
      setSuggestions({ kind: "answered", results: prefill.results });
      setActiveIndex(-1);
      setOpen(true);
    } else {
      setDraft(null);
      setSuggestions(IDLE);
      setActiveIndex(-1);
      setOpen(false);
    }
  }, [prefill]);

  const value = draft ?? label ?? "";
  const results: readonly GeocodeResult[] =
    suggestions.kind === "answered" ? suggestions.results : NONE;
  const showCurrentRow = Boolean(currentLocationLabel && onUseCurrentLocation);

  // The one row that stands in for a list there is not: never both, since a bar saying nothing
  // matched printed over matches contradicts itself. The search panel's warning about a map centre
  // off the city has no twin here — a route endpoint is in the city by construction.
  const notice =
    suggestions.kind === "idle"
      ? null
      : suggestions.kind === "loading"
        ? "Still loading this region's places…"
        : results.length === 0
          ? `No matches in ${cityInSentence(city)}.`
          : null;

  const dropdownOpen =
    open && (showCurrentRow || notice !== null || results.length > 0);

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
  }, [dropdownOpen, results.length, notice]);

  // Debounced search driven off the draft only; an answer to a draft that has since been typed over
  // is dropped rather than shown, so a slow one can't overwrite a newer one. A null/empty draft
  // searches nothing. An index that has not arrived answers null, which is shown as such rather than
  // waited on — and then asked again once it lands, because a reader who finishes typing before the
  // file does would otherwise sit on "still loading" until they pressed another key.
  useEffect(() => {
    const trimmed = draft?.trim() ?? "";
    if (!trimmed) {
      setSuggestions(IDLE);
      setActiveIndex(-1);
      return;
    }
    let stale = false;
    const show = (hits: GeocodeResult[] | null): void => {
      if (!stale) {
        setSuggestions(
          hits === null
            ? { kind: "loading" }
            : { kind: "answered", results: hits },
        );
        setActiveIndex(-1);
        setOpen(true);
      }
    };
    const timer = window.setTimeout(() => {
      searchPlaces(trimmed)
        .then(async (hits) => {
          show(hits);
          if (hits === null) {
            await awaitNameIndex(city.id);
            if (!stale) {
              show(await searchPlaces(trimmed));
            }
          }
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [draft, city]);

  // Every commit path snaps the draft back to null so the box shows the freshly committed label.
  const commit = (): void => {
    setDraft(null);
    setSuggestions(IDLE);
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
    const handled =
      open &&
      resultListKeyDown(event, results, activeIndex, setActiveIndex, select);
    if (!handled && event.key === "Escape") {
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
        role="combobox"
        aria-expanded={dropdownOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
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
        // same invariant as every other menu, arrived at the only way this one can. Opaque and
        // padded because it hangs over the map: the rows are pills, and a pill against the edge of a
        // menu with a skin of its own reads as a mistake.
        <ResultList
          listId={listId}
          listRef={list}
          results={results}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={select}
          notice={notice}
          leadingAction={
            showCurrentRow && currentLocationLabel
              ? {
                  icon: (
                    <FiNavigation
                      className="h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                  ),
                  label: currentLocationLabel,
                  onPick: useCurrentLocation,
                  tone: "brand",
                }
              : null
          }
          style={{ maxHeight: roomAbove }}
          className="absolute bottom-full left-0 z-10 mb-1 w-full rounded-xl bg-white p-1 shadow-xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10"
        />
      ) : null}
    </div>
  );
}
