"use client";

import { useEffect, useRef, useState } from "react";
import { MdAccessTime } from "react-icons/md";
import {
  getResolvedHour,
  getTimeMode,
  setCustomHour,
  setTimeMode,
  subscribeRouteTime,
} from "../src/route-time/store";

// The map's global time-of-day control, a toolbar icon like the others. Time is a global property, not
// tied to any one overlay — the shade layer follows it now, ferry schedules will later. Clicking the
// clock opens a popover with a "Now" button (track the live wall clock) and a slider to scrub any time
// today; the icon lights when a non-now time is set. All state lives in the shared route-time store.

const STEP_HOUR = 0.25;
// A fixed 1 AM–11 PM span, the same year-round: the clock drives more than shade, so the scrubber
// always covers the same wide day rather than tracking the season's daylight.
const MIN_HOUR = 1;
const MAX_HOUR = 23;

// Format a float hour as a 12-hour clock label like "3:00 PM".
function formatHour(hour: number): string {
  const totalMinutes = Math.round(hour * 60);
  const clockHour = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const period = clockHour >= 12 ? "PM" : "AM";
  const displayHour = clockHour % 12 === 0 ? 12 : clockHour % 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${period}`;
}

export default function ClockControl() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Re-render on any store change (mode, custom time, or the once-a-minute "now" tick).
  const [, bump] = useState(0);
  useEffect(() => subscribeRouteTime(() => bump((value) => value + 1)), []);

  // Close the popover on an outside click or Escape, mirroring the toolbar menu.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocClick = (event: MouseEvent): void => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const custom = getTimeMode() === "custom";
  const hour = getResolvedHour();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Time of day"
        title="Time of day"
        className="grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800"
      >
        <MdAccessTime
          className={
            custom
              ? "h-4 w-4 text-brand-600 dark:text-brand-400"
              : "h-4 w-4 text-slate-500 dark:text-slate-400"
          }
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="absolute right-0 mt-2 w-64 origin-top-right rounded-2xl bg-white/95 p-3 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Time of day
            </span>
            <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200">
              {formatHour(hour)}
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setTimeMode("now")}
              aria-pressed={!custom}
              className={
                custom
                  ? "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                  : "rounded-full bg-brand-500 px-2.5 py-1 text-xs font-medium text-white"
              }
            >
              Now
            </button>
            <input
              type="range"
              min={MIN_HOUR}
              max={MAX_HOUR}
              step={STEP_HOUR}
              value={hour}
              onChange={(event) =>
                setCustomHour(Number.parseFloat(event.target.value))
              }
              aria-label="Time of day"
              className="flex-1 accent-slate-600 dark:accent-slate-400"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
