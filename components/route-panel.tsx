"use client";

import {
  type ComponentType,
  type CSSProperties,
  useEffect,
  useRef,
  useState,
} from "react";
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
  MdAccountBalance,
  MdArrowUpward,
  MdDirectionsBoat,
  MdDirectionsCar,
  MdFlag,
  MdOutlineDirectionsWalk,
  MdPalette,
  MdStorefront,
  MdSwapHoriz,
  MdTurnLeft,
  MdTurnRight,
  MdTurnSlightLeft,
  MdTurnSlightRight,
  MdUTurnLeft,
  MdWbSunny,
} from "react-icons/md";
import { PiBoatFill, PiTreeEvergreenFill } from "react-icons/pi";
import type { GeocodeResult, SearchBias } from "../src/geocode";
import {
  MAX_ART_WEIGHT,
  MAX_COMMERCIAL_WEIGHT,
  MAX_FERRY_WEIGHT,
  MAX_HIGHWAY_WEIGHT,
  MAX_LANDMARK_WEIGHT,
  MAX_SHADE_WEIGHT,
  MAX_TREE_WEIGHT,
} from "../src/routing/cost";
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
  searchBias: SearchBias | null; // ranks search results near the user, or null when not shared
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
  landmarkWeight: number;
  artWeight: number;
  highwayWeight: number;
  commercialWeight: number;
  shadeWeight: number; // signed: −1 = prefer shade, +1 = prefer sun, 0 = off
  directions: Maneuver[] | null;
  progress: NavProgress | null; // live position along the route, or null when off-route/unlocated
  directionsOpen: boolean;
  minimized: boolean; // shrunk to the slim peek bar
  onTreeWeight: (weight: number) => void;
  onFerryWeight: (weight: number) => void;
  onAllowFerries: (allow: boolean) => void;
  onLandmarkWeight: (weight: number) => void;
  onArtWeight: (weight: number) => void;
  onHighwayWeight: (weight: number) => void;
  onCommercialWeight: (weight: number) => void;
  onShadeWeight: (weight: number) => void;
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

// One scenic routing factor as the panel renders it: a chip when collapsed, a full slider when open.
interface Factor {
  key: string;
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  weight: number;
  max: number;
  onChange: (weight: number) => void;
  tint: string; // text colour for the icon and chip
  color: string; // the slider's fill/thumb colour (a CSS hex; matches the map overlay)
  disabled?: boolean;
  signed?: boolean; // a bipolar −max..max slider (sun ↔ shade) rather than one-sided 0..max
}

const percent = (factor: Factor): number =>
  Math.round((factor.weight / factor.max) * 100);

// The reading beside a factor's slider: a plain "%" for one-sided factors, a bipolar "sun / shade"
// for the signed shade factor (0 reads as off).
function factorReading(factor: Factor): string {
  const value = percent(factor);
  if (!factor.signed) {
    return `${value}%`;
  }
  if (value === 0) {
    return "off";
  }
  return value > 0 ? `${value}% sun` : `${-value}% shade`;
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
  if (maneuver.kind === "landmark") {
    return <MdAccountBalance {...props} />;
  }
  if (maneuver.kind === "art") {
    return <MdPalette {...props} />;
  }
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
  searchBias,
  pickTarget,
  status,
  errorMessage,
  summary,
  treeWeight,
  ferryWeight,
  allowFerries,
  landmarkWeight,
  artWeight,
  highwayWeight,
  commercialWeight,
  shadeWeight,
  directions,
  progress,
  directionsOpen,
  minimized,
  onTreeWeight,
  onFerryWeight,
  onAllowFerries,
  onLandmarkWeight,
  onArtWeight,
  onHighwayWeight,
  onCommercialWeight,
  onShadeWeight,
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

  // The five scenic factors collapse to a row of value chips and expand to full sliders on demand —
  // too many to keep all open at once. Ferries stay gated by the header boat toggle.
  const [sceneryOpen, setSceneryOpen] = useState(false);
  // The scenery sliders and the directions list are each tall, so only one opens at a time — opening
  // one closes the other, or the panel runs off the top of the screen.
  useEffect(() => {
    if (directionsOpen) {
      setSceneryOpen(false);
    }
  }, [directionsOpen]);
  const toggleScenery = () => {
    const opening = !sceneryOpen;
    setSceneryOpen(opening);
    if (opening && directionsOpen) {
      onToggleDirections();
    }
  };
  const factors: Factor[] = [
    {
      key: "tree",
      label: "Prefer tree cover",
      Icon: PiTreeEvergreenFill,
      weight: treeWeight,
      max: MAX_TREE_WEIGHT,
      onChange: onTreeWeight,
      tint: "text-brand-600 dark:text-brand-400",
      color: "#059669",
    },
    {
      key: "shade",
      label: "Prefer sun or shade",
      Icon: MdWbSunny,
      weight: shadeWeight,
      max: MAX_SHADE_WEIGHT,
      onChange: onShadeWeight,
      signed: true,
      tint: "text-amber-600 dark:text-amber-400",
      color: "#f59e0b",
    },
    {
      key: "landmark",
      label: "Pass landmarks",
      Icon: MdAccountBalance,
      weight: landmarkWeight,
      max: MAX_LANDMARK_WEIGHT,
      onChange: onLandmarkWeight,
      tint: "text-amber-600 dark:text-amber-400",
      color: "#f59e0b",
    },
    {
      key: "art",
      label: "Pass public art",
      Icon: MdPalette,
      weight: artWeight,
      max: MAX_ART_WEIGHT,
      onChange: onArtWeight,
      tint: "text-fuchsia-600 dark:text-fuchsia-400",
      color: "#d946ef",
    },
    {
      key: "highway",
      label: "Avoid highways",
      Icon: MdDirectionsCar,
      weight: highwayWeight,
      max: MAX_HIGHWAY_WEIGHT,
      onChange: onHighwayWeight,
      tint: "text-rose-600 dark:text-rose-400",
      color: "#ef4444",
    },
    {
      key: "commercial",
      label: "Prefer commercial streets",
      Icon: MdStorefront,
      weight: commercialWeight,
      max: MAX_COMMERCIAL_WEIGHT,
      onChange: onCommercialWeight,
      tint: "text-violet-600 dark:text-violet-400",
      color: "#6d28d9",
    },
    {
      key: "ferry",
      label: "Prefer ferries",
      Icon: PiBoatFill,
      weight: ferryWeight,
      max: MAX_FERRY_WEIGHT,
      onChange: onFerryWeight,
      tint: "text-blue-600 dark:text-blue-400",
      color: "#2563eb",
      // The ferry slider only matters when the gate is on, so it greys out and stops responding.
      disabled: !allowFerries,
    },
  ];
  const hasFerry =
    directions?.some((maneuver) => maneuver.kind === "ferry") ?? false;
  const pickHint =
    pickTarget === "start"
      ? "Tap the map to set your start"
      : pickTarget === "dest"
        ? "Tap the map to set your destination"
        : null;

  // Full-width and centred on small screens; on sm+ it is a tall panel, so it right-aligns rather
  // than covering the middle of the map.
  const wrapper =
    "fixed bottom-0 left-1/2 z-[1000] w-full max-w-md -translate-x-1/2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:left-auto sm:right-4 sm:translate-x-0 sm:px-0";

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
            searchBias={searchBias}
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
            searchBias={searchBias}
          />
        </div>

        {pickHint ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400">
            <FiCrosshair className="h-3.5 w-3.5" aria-hidden="true" />
            {pickHint}
          </p>
        ) : null}

        <div className="mt-4">
          <button
            type="button"
            onClick={toggleScenery}
            aria-expanded={sceneryOpen}
            aria-label={sceneryOpen ? "Hide scenery sliders" : "Adjust scenery"}
            className="flex w-full items-center justify-between gap-2"
          >
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Scenery
            </span>
            {sceneryOpen ? (
              <FiChevronUp
                className="h-4 w-4 text-slate-400"
                aria-hidden="true"
              />
            ) : (
              <span className="flex items-center gap-2">
                {factors.map((factor) => (
                  <span
                    key={factor.key}
                    className={`flex items-center gap-0.5 text-[11px] font-semibold tabular-nums ${
                      factor.disabled ? "opacity-40" : factor.tint
                    }`}
                  >
                    <factor.Icon className="h-3.5 w-3.5" aria-hidden={true} />
                    {percent(factor)}
                  </span>
                ))}
                <FiChevronDown
                  className="ml-0.5 h-4 w-4 text-slate-400"
                  aria-hidden="true"
                />
              </span>
            )}
          </button>

          {sceneryOpen ? (
            <div className="mt-2 space-y-3">
              {factors.map((factor) => (
                <label
                  key={factor.key}
                  className={`block ${
                    factor.disabled ? "pointer-events-none opacity-40" : ""
                  }`}
                >
                  <span className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                    <span className="flex items-center gap-1.5">
                      <factor.Icon
                        className={`h-3.5 w-3.5 ${factor.tint}`}
                        aria-hidden={true}
                      />
                      {factor.label}
                    </span>
                    <span className="tabular-nums">
                      {factorReading(factor)}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={factor.signed ? -100 : 0}
                    max={100}
                    value={percent(factor)}
                    disabled={factor.disabled}
                    onChange={(event) =>
                      factor.onChange(
                        (Number.parseInt(event.target.value, 10) / 100) *
                          factor.max,
                      )
                    }
                    aria-label={factor.label}
                    className="scenery-slider mt-1.5 w-full"
                    style={
                      {
                        "--fill": factor.color,
                        // A signed slider fills from the centre, so map −100..100 to a 0..100 track.
                        "--pct": factor.signed
                          ? `${(percent(factor) + 100) / 2}%`
                          : `${percent(factor)}%`,
                      } as CSSProperties
                    }
                  />
                </label>
              ))}
            </div>
          ) : null}
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
                  // Passed landmarks and artwork wear their overlay colour, so the turn-by-turn reads
                  // as the same palette as the map.
                  const bubbleClass =
                    maneuver.kind === "landmark"
                      ? "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300"
                      : maneuver.kind === "art"
                        ? "bg-fuchsia-50 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300"
                        : "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300";
                  const textClass =
                    maneuver.kind === "landmark"
                      ? "text-amber-700 dark:text-amber-300"
                      : maneuver.kind === "art"
                        ? "text-fuchsia-700 dark:text-fuchsia-300"
                        : "text-slate-700 dark:text-slate-200";
                  return (
                    <li
                      key={`${maneuver.kind}-${maneuver.stepRange[0]}-${maneuver.stepRange[1]}-${maneuver.text}`}
                      ref={isNext ? highlightRef : null}
                      className={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${
                        isNext
                          ? "bg-brand-100 font-medium dark:bg-brand-500/25"
                          : ""
                      } ${isPassed ? "opacity-50" : ""}`}
                    >
                      <span
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${bubbleClass}`}
                      >
                        {maneuverIcon(maneuver)}
                      </span>
                      <span className={`min-w-0 flex-1 text-sm ${textClass}`}>
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
