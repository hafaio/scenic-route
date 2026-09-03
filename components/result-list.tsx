"use client";

import type {
  CSSProperties,
  Dispatch,
  KeyboardEvent,
  ReactNode,
  Ref,
  SetStateAction,
} from "react";
import type { GeocodeResult } from "../src/geocode";
import ResultGlyph from "./result-glyph";

// The list of places, shared by the route panel's endpoint fields and the search panel so the same
// index reads the same way whichever box asked it. Rows, their styling, the one row that stands in
// for them and the combobox ids live here; where the list hangs, what opens and closes it, and who
// asks the index stay with each caller, because those are the two surfaces' real differences — the
// route fields open upward out of a panel whose own controls sit below them and close on every
// commit, the search list is the body of its card and outlives a pick.

// How long the typing has to stop before either box asks the index.
export const SEARCH_DEBOUNCE_MS = 300;

const ROW =
  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm";
const IDLE =
  "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60";
const ACTIVE =
  "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300";
const BRAND =
  "font-medium text-brand-700 hover:bg-slate-50 dark:text-brand-300 dark:hover:bg-slate-700/60";

// One action offered above the results — the route fields' "My location". Outside the option ids and
// the keyboard cycle: it is not something the index found, and putting it in the cycle would either
// break Enter picking the first match or need semantics of its own.
export interface LeadingAction {
  icon: ReactNode;
  label: string;
  onPick: () => void;
  tone?: "brand";
}

interface ResultListProps {
  listId: string;
  results: readonly GeocodeResult[];
  activeIndex: number; // -1 = none
  onHover: (index: number) => void;
  onPick: (result: GeocodeResult) => void;
  notice?: string | null; // rendered instead of the rows when set
  leadingAction?: LeadingAction | null;
  className: string; // positioning and skin, which are the caller's business
  style?: CSSProperties;
  listRef?: Ref<HTMLUListElement>;
}

export default function ResultList({
  listId,
  results,
  activeIndex,
  onHover,
  onPick,
  notice,
  leadingAction,
  className,
  style,
  listRef,
}: ResultListProps) {
  return (
    <ul
      ref={listRef}
      id={listId}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML allows it
      role="listbox"
      style={style}
      className={`space-y-0.5 overflow-y-auto overscroll-contain ${className}`}
    >
      {leadingAction ? (
        // The rows are `li` for the markup a list wants, but a listbox owns its options directly, so
        // each wrapper hands its own semantics through to what it holds.
        <li role="none">
          <button
            type="button"
            // Keep the focus on the input so the click always lands; a blur here would race the
            // route field's close timer and swallow the selection.
            onMouseDown={(event) => event.preventDefault()}
            onClick={leadingAction.onPick}
            className={`${ROW} ${leadingAction.tone === "brand" ? BRAND : IDLE}`}
          >
            {leadingAction.icon}
            {leadingAction.label}
          </button>
        </li>
      ) : null}
      {notice ? (
        <li
          role="none"
          className="px-2 py-2 text-sm text-slate-500 dark:text-slate-400"
        >
          {notice}
        </li>
      ) : (
        results.map((result, index) => (
          <li key={result.placeId} role="none">
            <button
              type="button"
              role="option"
              id={`${listId}-${index}`}
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(result)}
              onMouseEnter={() => onHover(index)}
              className={`${ROW} ${index === activeIndex ? ACTIVE : IDLE}`}
            >
              <ResultGlyph type={result.type} />
              <span className="truncate">{result.displayName}</span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

// The arrows and Enter both boxes answer to: the arrows wrap, and Enter takes the row under them or
// else the first. Returns whether the key was one of them, so a caller can go on to handle Escape
// its own way — which is the one key the two disagree about.
export function resultListKeyDown(
  event: KeyboardEvent<HTMLElement>,
  results: readonly GeocodeResult[],
  activeIndex: number,
  setActive: Dispatch<SetStateAction<number>>,
  pick: (result: GeocodeResult) => void,
): boolean {
  if (results.length === 0) {
    return false;
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    setActive((index) => (index + 1) % results.length);
    return true;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActive((index) => (index - 1 + results.length) % results.length);
    return true;
  } else if (event.key === "Enter") {
    const chosen = results[activeIndex] ?? results[0];
    if (chosen) {
      event.preventDefault();
      pick(chosen);
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}
