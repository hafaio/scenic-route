"use client";

import { useEffect, useRef, useState } from "react";
import { FiSearch, FiX } from "react-icons/fi";
import { MdDirectionsWalk } from "react-icons/md";
import { type City, cityInSentence, containsPoint } from "../src/cities";
import { type GeocodeResult, searchPlaces } from "../src/geocode";
import { awaitNameIndex } from "../src/search/name-search";
import type { LatLng } from "../src/url-state";
import ResultGlyph from "./result-glyph";

// Finding a place without asking for directions. The route panel's fields reach the same index, but
// they reach it by making you name an endpoint first; this drops a pin and moves the map, and leaves
// whatever route you already had alone.
//
// It opens where the route panel opens and wears the same card, because the two are the same kind of
// thing — a place to type where you want to go — and they share the slot: the app closes one when it
// opens the other (components/map-app.tsx), so the copied classes below never have to stack.
//
// The query itself is `searchAddress`'s pipeline, debounced here the same way the route fields
// debounce it. Everything else is deliberately not shared with them: every commit path closes them,
// and they carry a map-pick crosshair and a "My location" row that a search has no use for.
//
// The open panel is a component of its own, which is what makes closing it mean anything: the words
// typed into it and the answer they got are held there and go with it.

const SEARCH_DEBOUNCE_MS = 300;
// The route panel's own wrapper and card, verbatim: centred on a phone, pinned bottom-right on sm+,
// and capped in `dvh` rather than `vh` because on a phone `100vh` is the viewport with the browser
// chrome retracted. See components/route-panel.tsx for the whole of that reasoning.
const PANEL =
  "fixed bottom-0 left-1/2 z-[1000] w-full max-w-md -translate-x-1/2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:left-auto sm:right-4 sm:translate-x-0 sm:px-0";
const CARD =
  "flex max-h-[calc(100dvh-env(safe-area-inset-top)-4rem-max(0.75rem,env(safe-area-inset-bottom)))] flex-col rounded-2xl bg-white/85 p-4 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";
const ICON_ON = "h-4 w-4 text-brand-600 dark:text-brand-400";
const ICON_OFF = "h-4 w-4 text-slate-500 dark:text-slate-400";
// The floating-control surface every button on the map wears.
const CHROME =
  "bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";
// While the panel is up, so the button reads as the thing holding it open rather than as a pin the
// reader has left somewhere: a lit icon alone cannot say which of the two it means.
const CHROME_OPEN =
  "bg-brand-50/90 shadow-lg ring-1 ring-brand-500/30 backdrop-blur-md dark:bg-brand-500/20 dark:ring-brand-400/30";

// What the index said about one query, kept together so a stale answer can never be read against
// newer words. `results` is null when the city's index has not arrived — which is not the same
// answer as "no such place", and is the whole reason this calls `searchPlaces` rather than
// `searchAddress`.
interface Answer {
  query: string;
  results: GeocodeResult[] | null;
  outside: boolean; // the map centre is off the city the index covers
}

interface SearchControlProps {
  city: City;
  open: boolean; // held by the app, which is what keeps this and the route panel out of one slot
  pinned: boolean; // a result is on the map, so the icon stays lit even with the panel closed
  centre: () => LatLng | null; // read per query: the index ranks from it, and one off the city warns
  onOpenChange: (open: boolean) => void;
  onSelect: (result: GeocodeResult) => void;
  onDirections: () => void; // routes to the pinned place, the same as the directions control does
  onClear: () => void;
}

export default function SearchControl({
  city,
  open,
  pinned,
  centre,
  onOpenChange,
  onSelect,
  onDirections,
  onClear,
}: SearchControlProps) {
  // The one thing that outlives the panel. The same split the route fields use: `draft`, down in the
  // panel, is the in-progress typing and `label` the committed pick, so selecting a result can put
  // its name in the box without the debounced search reading it back as a fresh query — and it is
  // still there to read when the panel is opened again.
  const [label, setLabel] = useState<string | null>(null);

  return (
    <>
      {/* left-[3.75rem] is beside the follow toggle: the 12px inset, its 40px, and an 8px gap. The
          panel it opens is at the other end of the map, so the button stays visible under it and
          goes on saying which state the search is in. */}
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label="Search for a place"
        title="Search for a place"
        className={`absolute top-3 left-[3.75rem] z-[1000] grid h-10 w-10 place-items-center rounded-full transition ${
          open
            ? CHROME_OPEN
            : `hover:bg-white dark:hover:bg-slate-800 ${CHROME}`
        }`}
      >
        <FiSearch
          className={open || pinned ? ICON_ON : ICON_OFF}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className={PANEL}>
          <div className={CARD}>
            <SearchPanel
              city={city}
              pinned={pinned}
              centre={centre}
              label={label}
              onLabelChange={setLabel}
              onOpenChange={onOpenChange}
              onSelect={onSelect}
              onDirections={onDirections}
              onClear={onClear}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

interface SearchPanelProps {
  city: City;
  pinned: boolean;
  centre: () => LatLng | null;
  label: string | null; // the last pick's name, kept above so it survives a close
  onLabelChange: (label: string | null) => void;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: GeocodeResult) => void;
  onDirections: () => void;
  onClear: () => void;
}

// What is up while the panel is open, and only then: the words in the box, the answer they got, and
// which row the arrows are standing on. None of it is any use to a closed panel — words left behind
// would fire a debounced search off the next thing to move the map, pulling the index back in after
// the app has released it, and an answer left behind would reopen on "Still loading" for a query
// nobody is typing any more — so it is held where closing the panel takes it away.
function SearchPanel({
  city,
  pinned,
  centre,
  label,
  onLabelChange,
  onOpenChange,
  onSelect,
  onDirections,
  onClear,
}: SearchPanelProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [listOpen, setListOpen] = useState<boolean>(false);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Escape closes the panel wherever the focus sits, matching the toolbar's menus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  // Debounced off the draft alone; an answer to words that have since been typed over is dropped, so
  // a slow one can never overwrite a newer one. An index that has not arrived answers null, which is
  // shown as such rather than waited on — and then asked again once it lands, because a reader who
  // finishes typing before the file does would otherwise sit on "still loading" until they pressed
  // another key.
  useEffect(() => {
    const query = draft?.trim() ?? "";
    if (!query) {
      setAnswer(null);
      setActiveIndex(-1);
      return;
    }
    let stale = false;
    const show = (results: GeocodeResult[] | null, outside: boolean): void => {
      if (!stale) {
        setAnswer({ query, results, outside });
        setActiveIndex(-1);
        setListOpen(true);
      }
    };
    const timer = window.setTimeout(() => {
      const at = centre();
      const outside = at !== null && !containsPoint(city, at);
      searchPlaces(query)
        .then(async (results) => {
          show(results, outside);
          if (results === null) {
            await awaitNameIndex(city.id);
            if (!stale) {
              show(await searchPlaces(query), outside);
            }
          }
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [draft, city, centre]);

  const value = draft ?? label ?? "";
  const results = answer?.results ?? null;

  // Unlike the route fields, picking a result leaves the panel standing: the map has just moved, and
  // the reader may well want to look up the next place. The blur is what drops the phone keyboard so
  // they can see where they landed.
  const select = (result: GeocodeResult): void => {
    setDraft(null);
    onLabelChange(result.displayName);
    setListOpen(false);
    setActiveIndex(-1);
    input.current?.blur();
    onSelect(result);
  };

  // The X in the box means "get rid of this": the words and the pin both. The pin has no handle of
  // its own on the map, so this and the next search replacing it are the two ways it goes.
  const clear = (): void => {
    onClear();
    setDraft(null);
    onLabelChange(null);
    setAnswer(null);
    setActiveIndex(-1);
    setListOpen(false);
    input.current?.focus();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (!listOpen || results === null || results.length === 0) {
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
    }
  };

  // Nothing to show yet is nothing drawn; once an answer lands there is either a list or the one row
  // that stands in for it. Never both: a coverage warning printed over a list of matches contradicts
  // itself, and where the map holds no data a list of places 150 km away is not the answer either.
  const notice =
    answer === null
      ? null
      : answer.outside
        ? `Search covers ${cityInSentence(city)} — the map has no data here.`
        : results === null
          ? "Still loading this region's places…"
          : results.length === 0
            ? `No matches in ${cityInSentence(city)}.`
            : null;

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
          Find a place
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {/* The same handoff the directions control performs, offered where the reader already
            is. Disabled until something is pinned, rather than hidden, so the close button
            does not move under a finger already going for it. */}
          <button
            type="button"
            onClick={onDirections}
            disabled={!pinned}
            aria-label="Walking directions to this place"
            title="Walking directions to this place"
            className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700"
          >
            <MdDirectionsWalk className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close search"
            className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <FiX />
          </button>
        </div>
      </div>

      <div className="relative mt-3 shrink-0">
        <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center">
          <FiSearch className={ICON_ON} aria-hidden="true" />
        </span>
        <input
          ref={input}
          type="text"
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          // Selects all rather than placing a caret: the box is holding the last thing found, and
          // the next thing to type is a new search, not an edit of that name.
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleKeyDown}
          placeholder="Search for a place"
          aria-label="Search for a place"
          autoComplete="off"
          className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-10 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
        />
        {value ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear the search"
            className="absolute inset-y-0 right-1.5 my-auto grid h-7 w-7 place-items-center rounded-full text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
          >
            <FiX className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {notice ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {notice}
        </p>
      ) : listOpen && results !== null && results.length > 0 ? (
        // Scrolls inside the card rather than lengthening it, the way the panel's own tall
        // sections do — the cap above is what the reader's screen can hold.
        <ul className="mt-2 min-h-0 shrink space-y-0.5 overflow-y-auto overscroll-contain">
          {results.map((result, index) => (
            <li key={result.placeId}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(result)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                  index === activeIndex
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                    : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60"
                }`}
              >
                <ResultGlyph type={result.type} />
                <span className="truncate">{result.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
