"use client";

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
  MdFlag,
  MdOutlineDirectionsWalk,
  MdSwapHoriz,
  MdTurnLeft,
  MdTurnRight,
  MdTurnSlightLeft,
  MdTurnSlightRight,
  MdUTurnLeft,
} from "react-icons/md";
import { PiTreeEvergreenFill } from "react-icons/pi";
import type { GeocodeResult } from "../src/geocode";
import { MAX_TREE_WEIGHT } from "../src/routing/cost";
import { formatDistance, type Maneuver } from "../src/routing/directions";
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
    lengthMeters: number;
    walkSeconds: number;
    coverFraction: number;
  } | null;
  treeWeight: number;
  directions: Maneuver[] | null;
  directionsOpen: boolean;
  collapseCrossings: boolean; // hide linear street crossings in the maneuver list
  minimized: boolean; // shrunk to the slim peek bar
  onTreeWeight: (weight: number) => void;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  onStartClear: () => void;
  onDestClear: () => void;
  onUseCurrentLocation: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  onToggleDirections: () => void;
  onToggleCollapse: () => void;
  onToggleMinimize: () => void;
  onClose: () => void;
}

const METERS_PER_MILE = 1609.344;

function summarize(summary: {
  lengthMeters: number;
  walkSeconds: number;
  coverFraction: number;
}): string {
  const miles = summary.lengthMeters / METERS_PER_MILE;
  const minutes = Math.max(1, Math.round(summary.walkSeconds / 60));
  const shaded = Math.round(summary.coverFraction * 100);
  return `${miles.toFixed(1)} mi · ${minutes} min · ${shaded}% shaded`;
}

function maneuverIcon(maneuver: Maneuver) {
  const props = { className: "h-4 w-4", "aria-hidden": true } as const;
  if (maneuver.kind === "cross") {
    return <MdSwapHoriz {...props} />;
  }
  if (maneuver.kind === "arrive") {
    return <MdFlag {...props} />;
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
  directions,
  directionsOpen,
  collapseCrossings,
  minimized,
  onTreeWeight,
  onStartSelect,
  onDestSelect,
  onStartClear,
  onDestClear,
  onUseCurrentLocation,
  onArmStart,
  onArmDest,
  onToggleDirections,
  onToggleCollapse,
  onToggleMinimize,
  onClose,
}: RoutePanelProps) {
  // The slider is a 0..100 track over the [0, MAX_TREE_WEIGHT] weight range.
  const slider = Math.round((treeWeight / MAX_TREE_WEIGHT) * 100);
  const pickHint =
    pickTarget === "start"
      ? "Tap the map to set your start"
      : pickTarget === "dest"
        ? "Tap the map to set your destination"
        : null;

  const wrapper =
    "fixed bottom-0 left-1/2 z-[1000] w-full max-w-md -translate-x-1/2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]";

  // Minimized: a slim peek bar that keeps the route summary visible while freeing the map.
  if (minimized) {
    const peekLabel =
      status === "ready" && summary ? summarize(summary) : "Walking directions";
    return (
      <div className={wrapper}>
        <button
          type="button"
          onClick={onToggleMinimize}
          aria-label="Expand directions"
          className="flex w-full items-center justify-between gap-2 rounded-2xl bg-white/85 px-4 py-3 text-left shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
            {peekLabel}
          </span>
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
            {summarize(summary)}
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
              <>
                <button
                  type="button"
                  onClick={onToggleCollapse}
                  aria-pressed={!collapseCrossings}
                  className="mt-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  {collapseCrossings
                    ? "Show every crossing"
                    : "Hide street crossings"}
                </button>
                <ol className="mt-2 max-h-[45vh] space-y-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                  {directions.map((maneuver) => (
                    <li
                      key={`${maneuver.kind}-${maneuver.stepRange[0]}-${maneuver.stepRange[1]}`}
                      className="flex items-start gap-3 rounded-lg px-2 py-1.5"
                    >
                      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
                        {maneuverIcon(maneuver)}
                      </span>
                      <span className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">
                        {maneuver.text}
                      </span>
                      {maneuver.lengthMeters > 0 ? (
                        <span className="mt-0.5 shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500">
                          {formatDistance(maneuver.lengthMeters)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
