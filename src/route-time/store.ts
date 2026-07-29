// The map's date and time of day, a module singleton shared by the clock control and every
// time-dependent overlay — building shade now, ferry schedules later — without threading React state
// through the map. Two INDEPENDENT axes: time is "now" (tracking the wall clock live, a ticker nudging
// subscribers as real time passes) or a scrubbed hour, and the day is today or one the user pinned, so
// midwinter at the live time of day is expressible. They compose into the resolved instant the overlays
// hand to suncalc / the canopy's phenology. Framework-agnostic (no React), the idiom the layer files
// use for their own shared state.

export type TimeMode = "now" | "custom";
export type DateMode = "today" | "custom";

let mode: TimeMode = "now";
let customHour = 12; // local clock hour (float) used in "custom" mode
let dateMode: DateMode = "today";
let customDay = formatDay(new Date()); // local calendar day used in "custom" date mode
let pickerOpen = false; // the clock popover is open — the user may be scrubbing time
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// While tracking "now" with someone listening, tick each minute so overlays follow the wall clock (the
// sun moves ~0.25°/min). Otherwise the interval is idle.
function updateTicker(): void {
  const shouldRun = mode === "now" && listeners.size > 0;
  if (shouldRun && ticker === null) {
    ticker = setInterval(notify, 60_000);
  } else if (!shouldRun && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function getTimeMode(): TimeMode {
  return mode;
}

export function setTimeMode(next: TimeMode): void {
  if (next === mode) {
    return;
  }
  mode = next;
  updateTicker();
  notify();
}

export function getCustomHour(): number {
  return customHour;
}

// Scrubbing a specific time implies leaving "now".
export function setCustomHour(hour: number): void {
  if (mode === "custom" && hour === customHour) {
    return;
  }
  customHour = hour;
  mode = "custom";
  updateTicker();
  notify();
}

// A local calendar day as "YYYY-MM-DD", the form <input type="date"> reads and writes.
export function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Local midnight on a "YYYY-MM-DD" day. `new Date(day)` would read the string as UTC instead.
export function parseDay(day: string): Date {
  return new Date(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
}

export function getDateMode(): DateMode {
  return dateMode;
}

export function setDateMode(next: DateMode): void {
  if (next === dateMode) {
    return;
  }
  dateMode = next;
  notify();
}

// The resolved day, for the date input's value.
export function getResolvedDay(): string {
  return dateMode === "custom" ? customDay : formatDay(new Date());
}

// Pinning a day implies leaving "today".
export function setCustomDay(day: string): void {
  if (dateMode === "custom" && day === customDay) {
    return;
  }
  customDay = day;
  dateMode = "custom";
  notify();
}

// The two axes as the URL carries them: null on each while it tracks (the live clock, today), so a
// tracking axis is simply absent from a link.
export function getPinnedTime(): { hour: number | null; day: string | null } {
  return {
    hour: mode === "custom" ? customHour : null,
    day: dateMode === "custom" ? customDay : null,
  };
}

// The resolved instant: the pinned day (else today) at the scrubbed hour (else the live wall clock).
export function getResolvedDate(): Date {
  const now = new Date();
  if (mode === "now" && dateMode === "today") {
    return now;
  }
  const day = dateMode === "custom" ? parseDay(customDay) : now;
  const minutes =
    mode === "custom"
      ? Math.round(customHour * 60)
      : now.getHours() * 60 + now.getMinutes();
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

// The resolved local hour (float), for the clock label and the slider position.
export function getResolvedHour(): number {
  if (mode === "custom") {
    return customHour;
  }
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

// Whether the clock popover is open. Time-dependent overlays watch this to prefetch the day's tiles
// while the user is scrubbing, then drop them when it closes; it rides the same listener set, so a
// subscriber sees open/close alongside the time changes it already reacts to.
export function isPickerOpen(): boolean {
  return pickerOpen;
}

export function setPickerOpen(open: boolean): void {
  if (open === pickerOpen) {
    return;
  }
  pickerOpen = open;
  notify();
}

export function subscribeRouteTime(listener: () => void): () => void {
  listeners.add(listener);
  updateTicker();
  return () => {
    listeners.delete(listener);
    updateTicker();
  };
}
