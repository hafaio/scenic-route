// The map's time of day, a module singleton shared by the clock control and every time-dependent
// overlay — building shade now, ferry schedules later — without threading React state through the map.
// Two modes: "now" tracks the wall clock live (a ticker nudges subscribers as real time passes); "custom"
// holds a specific time today the user scrubbed to. Date is always TODAY (we don't pick dates), so a
// resolved time is a Date the overlays hand to suncalc / a schedule. Framework-agnostic (no React), the
// idiom the layer files use for their own shared state.

export type TimeMode = "now" | "custom";

let mode: TimeMode = "now";
let customHour = 12; // local clock hour (float) used in "custom" mode
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

// The resolved instant: right now while tracking, else today at the custom hour.
export function getResolvedDate(): Date {
  const now = new Date();
  if (mode === "now") {
    return now;
  }
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    Math.round(customHour * 60),
  );
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
