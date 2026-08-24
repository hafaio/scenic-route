"use client";

// How much of the map to keep for offline use, offered as what the size GETS you rather than as a
// number of bytes — a reader choosing this is deciding how far they can walk without signal, not
// budgeting storage. The figures are measured: New York walked over at every zoom comes to roughly
// 400 MB of overlay tiles and San Francisco to far less, so one city fits inside 500 MB with room to
// wander and both fit inside a gigabyte.
//
// The routing graphs are not covered by any of this and are not offered as a choice; the reason is
// in CAPS in src/sw/worker.ts.

export interface CoverageOption {
  id: string;
  label: string;
  detail: string;
  bytes: number | null; // null is "no cap"
}

const MB = 1024 * 1024;

export const COVERAGE: readonly CoverageOption[] = [
  {
    id: "recent",
    label: "Recent areas only",
    detail: "about 250 MB",
    bytes: 250 * MB,
  },
  {
    id: "city",
    label: "One city",
    detail: "about 500 MB",
    bytes: 500 * MB,
  },
  {
    id: "both",
    label: "Both cities",
    detail: "about 1 GB",
    bytes: 1024 * MB,
  },
  {
    id: "unlimited",
    label: "Everything I look at",
    detail: "as much as your device allows",
    bytes: null,
  },
];

// What ships when the reader has never chosen: the cap the worker was written with.
export const DEFAULT_COVERAGE = "both";

export function coverageBytes(id: string): number | null {
  return (COVERAGE.find((option) => option.id === id) ?? COVERAGE[2]).bytes;
}

// Bytes as a reader reads them. Deliberately coarse: this is a rough sense of how much is kept, and
// a figure to the megabyte would invite comparing it against a cap that is itself approximate.
// Nothing kept says so in words — "0 MB kept" reads as a failure where "nothing kept yet" reads as
// the fact that they have not been anywhere.
export function formatBytes(bytes: number): string {
  if (bytes >= 0.95 * 1024 * MB) {
    return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  } else if (bytes >= MB) {
    return `${Math.round(bytes / MB)} MB`;
  } else if (bytes > 0) {
    return "under 1 MB";
  } else {
    return "";
  }
}
