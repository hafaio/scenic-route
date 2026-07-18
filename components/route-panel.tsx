"use client";

import { useEffect, useRef } from "react";
import {
  FiChevronDown,
  FiChevronUp,
  FiCrosshair,
  FiLoader,
  FiNavigation,
  FiSearch,
  FiX,
} from "react-icons/fi";
import {
  MdArrowUpward,
  MdDirectionsBoat,
  MdFlag,
  MdOutlineDirectionsWalk,
  MdSwapHoriz,
  MdTurnLeft,
  MdTurnRight,
  MdTurnSlightLeft,
  MdTurnSlightRight,
  MdUTurnLeft,
} from "react-icons/md";
import { PiBoatFill, PiTreeEvergreenFill } from "react-icons/pi";
import type { GeocodeResult } from "../src/geocode";
import { MAX_FERRY_WEIGHT, MAX_TREE_WEIGHT } from "../src/routing/cost";
import {
  formatDistance,
  formatDuration,
  type Maneuver,
} from "../src/routing/directions";
import type { NavProgress } from "../src/routing/nav-progress";
import LocationField from "./location-field";

interface RoutePanelProps {
  startLabel: string | null; // null leaves the start empty (routing falls back to the live location)
  destLabel: string | null;
  startSet: boolean; // a manual start is set (so it can be reset)
  destSet: boolean;
  needsStart: boolean; // no location and no manual start yet
  hasLiveLocation: boolean; // a live fix exists, so the "My location" row can be offered
  pickTarget: "start" | "dest" | null;
  status: "idle" | "loading" | "ready" | "error";
  errorMessage: string | null;
  summary: {
    walkMeters: number; // walking-only distance; the mileage shown excludes any ferry crossing
    travelSeconds: number;
    coverFraction: number;
  } | null;
  treeWeight: number;
  ferryWeight: number;
  allowFerries: boolean;
  directions: Maneuver[] | null;
  progress: NavProgress | null; // live position along the route, or null when off-route/unlocated
  directionsOpen: boolean;
  minimized: boolean; // shrunk to the slim peek bar
  onTreeWeight: (weight: number) => void;
  onFerryWeight: (weight: number) => void;
  onAllowFerries: (allow: boolean) => void;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  onStartClear: () => void;
  onDestClear: () => void;
  onUseCurrentLocation: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  onToggleDirections: () => void;
  onToggleMinimize: () => void;
  onClose: () => void;
}

const METERS_PER_MILE = 1609.344;

function summarize(
  summary: {
    walkMeters: number;
    travelSeconds: number;
    coverFraction: number;
  },
  hasFerry: boolean,
): string {
  const miles = summary.walkMeters / METERS_PER_MILE;
  const minutes = Math.max(1, Math.round(summary.travelSeconds / 60));
  const shaded = Math.round(summary.coverFraction * 100);
  const base = `${miles.toFixed(1)} mi · ${minutes} min · ${shaded}% shaded`;
  return hasFerry ? `${base} · ferry` : base;
}

function maneuverIcon(maneuver: Maneuver) {
  const props = { className: "h-4 w-4", "aria-hidden": true } as const;
  if (maneuver.kind === "cross") {
    return <MdSwapHoriz {...props} />;
  }
  if (maneuver.kind === "arrive") {
    return <MdFlag {...props} />;
  }
  if (maneuver.kind === "ferry") {
    return <MdDirectionsBoat {...props} />;
  }
  if (maneuver.kind === "continue") {
    return <MdArrowUpward {...props} />;
  }
  if (maneuver.kind === "turn") {
    switch (maneuver.turn) {
      case "left":
        return <MdTurnLeft {...props} />;
      case "right":
        return <MdTurnRight {...props} />;
      case "slight left":
        return <MdTurnSlightLeft {...props} />;
      case "slight right":
        return <MdTurnSlightRight {...props} />;
      case "around":
        return <MdUTurnLeft {...props} />;
      default:
        return <MdOutlineDirectionsWalk {...props} />;
    }
  }
  return <MdOutlineDirectionsWalk {...props} />;
}

export default function RoutePanel({
  startLabel,
  destLabel,
  startSet,
  destSet,
  needsStart,
  hasLiveLocation,
  pickTarget,
  status,
  errorMessage,
  summary,
  treeWeight,
  ferryWeight,
  allowFerries,
  directions,
  progress,
  directionsOpen,
  minimized,
  onTreeWeight,
  onFerryWeight,
  onAllowFerries,
  onStartSelect,
  onDestSelect,
  onStartClear,
  onDestClear,
  onUseCurrentLocation,
  onArmStart,
  onArmDest,
  onToggleDirections,
  onToggleMinimize,
  onClose,
}: RoutePanelProps) {
  // The highlighted maneuver row is scrolled into view whenever the next maneuver advances.
  const highlightRef = useRef<HTMLLIElement | null>(null);
  const nextIndex = progress ? progress.nextManeuver : null;
  useEffect(() => {
    if (nextIndex !== null) {
      highlightRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [nextIndex]);

  // Each slider is a 0..100 track over its [0, MAX_*_WEIGHT] weight range.
  const slider = Math.round((treeWeight / MAX_TREE_WEIGHT) * 100);
  const ferrySlider = Math.round((ferryWeight / MAX_FERRY_WEIGHT) * 100);
  const hasFerry =
    directions?.some((maneuver) => maneuver.kind === "ferry") ?? false;
  const pickHint =
    pickTarget === "start"
      ? "Tap the map to set your start"
      : pickTarget === "dest"
        ? "Tap the map to set your destination"
        : null;

  const wrapper =
    "fixed bottom-0 left-1/2 z-[1000] w-full max-w-md -translate-x-1/2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]";

  // Minimized: a slim peek bar. While navigating (progress on a ready route) it shows the next
  // maneuver and the distance to it; otherwise it falls back to the route summary.
  if (minimized) {
    const peekNext =
      status === "ready" && progress && directions
        ? {
            maneuver: directions[progress.nextManeuver],
            distanceMeters: progress.distanceToNextMeters,
          }
        : null;
    return (
      <div className={wrapper}>
        <button
          type="button"
          onClick={onToggleMinimize}
          aria-label="Expand directions"
          className="flex w-full items-center justify-between gap-2 rounded-2xl bg-white/85 px-4 py-3 text-left shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10"
        >
          {peekNext ? (
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                {maneuverIcon(peekNext.maneuver)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {peekNext.maneuver.text}
                </span>
                <span className="block text-xs font-medium text-slate-400 dark:text-slate-500">
                  in {formatDistance(peekNext.distanceMeters)}
                </span>
              </span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
              {status === "ready" && summary
                ? summarize(summary, hasFerry)
                : "Walking directions"}
            </span>
          )}
          <FiChevronUp
            className="h-5 w-5 shrink-0 text-slate-400"
            aria-hidden="true"
          />
        </button>
      </div>
    );
  }

  return (
    <div className={wrapper}>
      <div className="rounded-2xl bg-white/85 p-4 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
            Walking directions
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onAllowFerries(!allowFerries)}
              aria-label="Allow ferries"
              aria-pressed={allowFerries}
              className={`-m-1 grid h-8 w-8 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 ${
                allowFerries
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-slate-400"
              }`}
            >
              <MdDirectionsBoat />
            </button>
            <button
              type="button"
              onClick={onToggleMinimize}
              aria-label="Minimize directions"
              className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <FiChevronDown />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close directions"
              className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <FiX />
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <LocationField
            label={startLabel}
            placeholder="My location"
            leadingIcon={
              <FiNavigation className="h-4 w-4" aria-hidden="true" />
            }
            armed={pickTarget === "start"}
            canClear={startSet}
            clearLabel="Reset start to your location"
            pickLabel="Pick start on the map"
            onSelect={onStartSelect}
            onClear={onStartClear}
            onArmPick={onArmStart}
            currentLocationLabel={hasLiveLocation ? "My location" : null}
            onUseCurrentLocation={onUseCurrentLocation}
          />
          <LocationField
            label={destLabel}
            placeholder="Where to?"
            leadingIcon={<FiSearch className="h-4 w-4" aria-hidden="true" />}
            armed={pickTarget === "dest"}
            canClear={destSet}
            clearLabel="Clear destination"
            pickLabel="Pick destination on the map"
            onSelect={onDestSelect}
            onClear={onDestClear}
            onArmPick={onArmDest}
          />
        </div>

        {pickHint ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400">
            <FiCrosshair className="h-3.5 w-3.5" aria-hidden="true" />
            {pickHint}
          </p>
        ) : null}

        <label className="mt-4 block">
          <span className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            Prefer tree cover
            <PiTreeEvergreenFill
              className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400"
              aria-hidden="true"
            />
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={slider}
            onChange={(event) =>
              onTreeWeight(
                (Number.parseInt(event.target.value, 10) / 100) *
                  MAX_TREE_WEIGHT,
              )
            }
            aria-label="Prefer tree cover"
            className="mt-1.5 w-full accent-brand-600"
          />
        </label>

        <div className="mt-4">
          {/* Ferries are toggled from the header boat icon; this slider only matters when they are
              allowed, so it greys out and stops responding when the toggle is off. */}
          <label
            className={`block ${allowFerries ? "" : "pointer-events-none opacity-40"}`}
          >
            <span className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
              Prefer ferries
              <PiBoatFill
                className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400"
                aria-hidden="true"
              />
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={ferrySlider}
              disabled={!allowFerries}
              onChange={(event) =>
                onFerryWeight(
                  (Number.parseInt(event.target.value, 10) / 100) *
                    MAX_FERRY_WEIGHT,
                )
              }
              aria-label="Prefer ferries"
              className="mt-1.5 w-full accent-blue-600"
            />
          </label>
        </div>

        {needsStart ? (
          <p className="mt-3 text-center text-xs text-slate-400 dark:text-slate-500">
            Set a start point or wait for your location to load
          </p>
        ) : null}

        {status === "loading" ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
            Finding a route…
          </p>
        ) : null}
        {status === "ready" && summary ? (
          <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
            {summarize(summary, hasFerry)}
          </p>
        ) : null}
        {status === "error" && errorMessage ? (
          <p className="mt-3 text-sm font-medium text-rose-600 dark:text-rose-400">
            {errorMessage}
          </p>
        ) : null}

        {status === "ready" && directions && directions.length > 0 ? (
          <>
            <button
              type="button"
              onClick={onToggleDirections}
              aria-expanded={directionsOpen}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800"
            >
              <MdOutlineDirectionsWalk className="h-4 w-4" aria-hidden="true" />
              {directionsOpen ? "Hide directions" : "Get directions"}
            </button>
            {directionsOpen ? (
              <ol className="mt-2 max-h-[45vh] space-y-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                {directions.map((maneuver, index) => {
                  const isNext =
                    progress !== null && index === progress.nextManeuver;
                  const isPassed =
                    progress !== null && index < progress.currentManeuver;
                  return (
                    <li
                      key={`${maneuver.kind}-${maneuver.stepRange[0]}-${maneuver.stepRange[1]}`}
                      ref={isNext ? highlightRef : null}
                      className={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${
                        isNext
                          ? "bg-brand-100 font-medium dark:bg-brand-500/25"
                          : ""
                      } ${isPassed ? "opacity-50" : ""}`}
                    >
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                        {maneuverIcon(maneuver)}
                      </span>
                      <span className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">
                        {maneuver.text}
                      </span>
                      {maneuver.kind === "ferry" ? (
                        <span className="shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500">
                          {formatDuration(maneuver.durationSeconds ?? 0)}
                        </span>
                      ) : maneuver.lengthMeters > 0 ? (
                        <span className="shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500">
                          {formatDistance(maneuver.lengthMeters)}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
