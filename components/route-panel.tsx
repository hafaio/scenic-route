"use client";

import { useEffect, useRef, useState } from "react";
import {
  FiChevronDown,
  FiChevronUp,
  FiCloudOff,
  FiCrosshair,
  FiLoader,
  FiNavigation,
  FiSearch,
  FiSettings,
  FiX,
} from "react-icons/fi";
import {
  MdAccountBalance,
  MdArrowUpward,
  MdConstruction,
  MdDirectionsBoat,
  MdFlag,
  MdOutlineDirectionsWalk,
  MdPalette,
  MdSwapHoriz,
  MdTurnLeft,
  MdTurnRight,
  MdTurnSlightLeft,
  MdTurnSlightRight,
  MdUTurnLeft,
} from "react-icons/md";
import type { GeocodeResult, SearchBias } from "../src/geocode";
import {
  formatDistance,
  formatDuration,
  type Maneuver,
} from "../src/routing/directions";
import {
  FACTORS,
  type Factor,
  type FactorKey,
  FactorSlider,
  factorPercent,
  factorReading,
} from "../src/routing/factors";
import type { NavProgress } from "../src/routing/nav-progress";
import type { RouteFactors } from "../src/routing/search";
import LocationField from "./location-field";
import { useSettings } from "./use-settings";

interface RoutePanelProps {
  startLabel: string | null; // null leaves the start empty (routing falls back to the live location)
  destLabel: string | null;
  startSet: boolean; // a manual start is set (so it can be reset)
  destSet: boolean;
  needsStart: boolean; // no location and no manual start yet
  // A live fix this city could route from, so the "My location" row can be offered. A fix in
  // another city is not one: routing stays within one city, so the placeholder would name a start
  // that cannot be used.
  hasLiveLocation: boolean;
  searchBias: SearchBias | null; // ranks search results near the user, or null when not shared
  pickTarget: "start" | "dest" | null;
  status: "idle" | "loading" | "ready" | "error";
  errorMessage: string | null;
  summary: {
    walkMeters: number; // walking-only distance; the mileage shown excludes any ferry crossing
    travelSeconds: number;
    factors: RouteFactors; // per-factor mean intensities, rendered as chips for the active sliders
  } | null;
  treeWeight: number;
  ferryWeight: number;
  allowFerries: boolean;
  landmarkWeight: number;
  artWeight: number;
  highwayWeight: number;
  hillWeight: number;
  // What the active city's own graph actually carries. Read off the artifact rather than authored
  // per city, so a layer that is missing shows as missing instead of as a control that moves
  // nothing: every one of these was a live slider in San Francisco costing an attribute that is 0
  // on all 102,659 of its edges.
  //
  // A slider whose data is absent greys out rather than disappearing, which is what the hill slider
  // already did — "not here" reads as a fact about the city, where a control that vanishes reads as
  // a bug. The two gates are hidden instead: a toggle is a claim that both of its states are
  // reachable, and in a city with no ferries at all it has nothing to say.
  capabilities: {
    relief: boolean; // an elevation source, so "avoid hills" can move something
    ferries: boolean; // ferry edges in the graph, so the slider and its gate mean something
    commercial: boolean;
    industrial: boolean; // industrial land in this city's graph, so "avoid" has something to avoid
    historic: boolean; // designated districts in this city's graph, so "prefer" has somewhere to go
    landmarks: boolean;
    art: boolean;
    sheds: boolean; // a sidewalk-shed feed, so the scaffolding gate means something
  };
  commercialWeight: number;
  industrialWeight: number;
  historicWeight: number;
  shadeWeight: number; // signed: −1 = prefer shade, +1 = prefer sun, 0 = off
  // The per-edge sun/shade fractions did not load. Not a capability: every city bakes them, and the
  // artifact is refetched on every clock tick, so this says the network dropped one — not that the
  // city has nothing to say about shade.
  shadeDataLost: boolean;
  shelterWeight: number;
  allowSheds: boolean;
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
  onHillWeight: (weight: number) => void;
  onCommercialWeight: (weight: number) => void;
  onIndustrialWeight: (weight: number) => void;
  onHistoricWeight: (weight: number) => void;
  onShadeWeight: (weight: number) => void;
  onShelterWeight: (weight: number) => void;
  onAllowSheds: (allow: boolean) => void;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  onStartClear: () => void;
  onDestClear: () => void;
  onUseCurrentLocation: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  onToggleDirections: () => void;
  onToggleMinimize: () => void;
  onSettings: () => void; // opens the settings page, where a hidden factor's slider still lives
  onClose: () => void;
}

// What this render knows about a factor that its metadata cannot: where its weight stands, what
// moving it does, and whether the control is live at all.
interface FactorState {
  weight: number;
  onChange: (weight: number) => void;
  // Whether the active city has the data at all: false drops the factor from the panel entirely.
  // Distinct from `disabled`, which is a live control the reader has switched off.
  available?: boolean;
  disabled?: boolean;
  // Set when the data this factor prices exists but did not load. The control goes dead like
  // `disabled` does, with the reason said out loud: a slider the reader did not grey themselves is
  // otherwise just a control that has stopped working, and the route beside it is quietly priced
  // without the thing the slider claims to be asking for.
  lost?: string;
}

// One scenic routing factor as the panel renders it: a chip when collapsed, a full slider when open.
type PanelFactor = Factor & FactorState;

const METERS_PER_MILE = 1609.344;

// Distance and time only; the per-factor makeup is shown as chips (factorChips below), no longer folded
// into an ambiguous single "% shaded".
function summarize(
  summary: { walkMeters: number; travelSeconds: number },
  hasFerry: boolean,
): string {
  const miles = summary.walkMeters / METERS_PER_MILE;
  const minutes = Math.max(1, Math.round(summary.travelSeconds / 60));
  const base = `${miles.toFixed(1)} mi · ${minutes} min`;
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
  hillWeight,
  capabilities,
  commercialWeight,
  industrialWeight,
  historicWeight,
  shadeWeight,
  shadeDataLost,
  shelterWeight,
  allowSheds,
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
  onHillWeight,
  onCommercialWeight,
  onIndustrialWeight,
  onHistoricWeight,
  onShadeWeight,
  onShelterWeight,
  onAllowSheds,
  onStartSelect,
  onDestSelect,
  onStartClear,
  onDestClear,
  onUseCurrentLocation,
  onArmStart,
  onArmDest,
  onToggleDirections,
  onToggleMinimize,
  onSettings,
  onClose,
}: RoutePanelProps) {
  const hidden = new Set(useSettings().hiddenFactors);
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
  const factorState: Record<FactorKey, FactorState> = {
    tree: { weight: treeWeight, onChange: onTreeWeight },
    shade: {
      weight: shadeWeight,
      onChange: onShadeWeight,
      // The one factor that can go dark while the graph is perfectly healthy: the sun-position
      // fractions are their own artifact, refetched whenever the clock moves.
      lost: shadeDataLost
        ? "Shade data could not be loaded — this route ignores sun and shade."
        : undefined,
    },
    shelter: {
      weight: shelterWeight,
      onChange: onShelterWeight,
      available: capabilities.sheds,
    },
    landmark: {
      weight: landmarkWeight,
      onChange: onLandmarkWeight,
      available: capabilities.landmarks,
    },
    art: {
      weight: artWeight,
      onChange: onArtWeight,
      available: capabilities.art,
    },
    historic: {
      weight: historicWeight,
      onChange: onHistoricWeight,
      available: capabilities.historic,
    },
    highway: { weight: highwayWeight, onChange: onHighwayWeight },
    industrial: {
      weight: industrialWeight,
      onChange: onIndustrialWeight,
      available: capabilities.industrial,
    },
    hill: {
      weight: hillWeight,
      onChange: onHillWeight,
      available: capabilities.relief,
    },
    commercial: {
      weight: commercialWeight,
      onChange: onCommercialWeight,
      available: capabilities.commercial,
    },
    ferry: {
      weight: ferryWeight,
      onChange: onFerryWeight,
      available: capabilities.ferries,
      // Present but inert while the gate is off — unlike absence, that is a state the reader chose
      // and can undo, so the control stays visible to say so.
      disabled: !allowFerries,
    },
  };
  const allFactors: PanelFactor[] = FACTORS.map((factor) => ({
    ...factor,
    ...factorState[factor.key],
  }));
  // Every scenic factor gets a summary chip — the slider's own icon and tint with the route's mean
  // intensity for it — shown regardless of weight, for reference. Ferry is presence-only (the "· ferry"
  // suffix), so it stays out of the chip row. Shelter stays out too, and deliberately: a percentage
  // beside a raindrop reads as a forecast of how dry you will stay, and the tree half of that number
  // is extrapolated from about four studied trees. It is a preference, not a prediction.
  // A factor the city has no data for is dropped outright rather than greyed. It would cost nothing
  // and mean nothing here, and a disabled control still claims the city has the thing. A factor the
  // reader has hidden in Settings goes the same way, though its weight keeps pricing the route.
  // Filtered once, at the source, so the sliders, the collapsed peek row and the summary chips cannot
  // disagree about which factors this panel offers.
  const offered = allFactors.filter((factor) => factor.available !== false);
  const factors = offered.filter((factor) => !hidden.has(factor.key));
  // Hiding is about the panel, not the route: a hidden factor at a non-zero weight is still bending
  // the line on the map, and nothing else on screen would say so. A factor the panel would have
  // greyed out is not — a closed gate has taken its edges out of the graph, and lost data is priced
  // as nothing — so counting one would name an influence that is not there.
  const hiddenApplying = offered.filter(
    (factor) =>
      hidden.has(factor.key) &&
      factor.weight !== 0 &&
      !factor.disabled &&
      factor.lost === undefined,
  ).length;

  const factorChips = factors.filter(
    (factor) => factor.key !== "ferry" && factor.key !== "shelter",
  );
  // A factor whose data is missing AND which the reader has asked for: the route on screen is not
  // the route they asked for, and the greyed slider saying so is folded away behind "Scenery".
  const ignoredFactors = factors.filter(
    (factor) => factor.lost !== undefined && factor.weight !== 0,
  );
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
            {capabilities.ferries && (
              <button
                type="button"
                onClick={() => onAllowFerries(!allowFerries)}
                aria-label="Allow ferries"
                aria-pressed={allowFerries}
                title={
                  allowFerries
                    ? "Ferries allowed — click to route without them"
                    : "Ferries barred — click to allow ferry crossings"
                }
                className={`-m-1 grid h-8 w-8 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 ${
                  allowFerries
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-slate-400"
                }`}
              >
                <MdDirectionsBoat />
              </button>
            )}
            {capabilities.sheds && (
              <button
                type="button"
                onClick={() => onAllowSheds(!allowSheds)}
                aria-label="Allow scaffolding"
                aria-pressed={allowSheds}
                title={
                  allowSheds
                    ? "Scaffolding allowed — click to route around sidewalk sheds"
                    : "Scaffolding avoided — click to walk under sidewalk sheds again"
                }
                className={`-m-1 grid h-8 w-8 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 ${
                  allowSheds
                    ? "text-orange-600 dark:text-orange-400"
                    : "text-slate-400"
                }`}
              >
                <MdConstruction />
              </button>
            )}
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
            placeholder={
              hasLiveLocation ? "My location" : "Pick a starting point"
            }
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
                      factor.disabled || factor.lost
                        ? "opacity-40"
                        : factor.tint
                    }`}
                  >
                    <factor.Icon className="h-3.5 w-3.5" aria-hidden={true} />
                    {factorPercent(factor, factor.weight)}
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
                  htmlFor={`scenery-${factor.key}`}
                  className={`block ${
                    factor.disabled || factor.lost
                      ? "pointer-events-none opacity-40"
                      : ""
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
                      {factorReading(factor, factor.weight)}
                    </span>
                  </span>
                  <FactorSlider
                    id={`scenery-${factor.key}`}
                    factor={factor}
                    weight={factor.weight}
                    disabled={factor.disabled || factor.lost !== undefined}
                    onChange={factor.onChange}
                    className="mt-1.5 w-full"
                  />
                  {factor.lost ? (
                    <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
                      {factor.lost}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          ) : null}

          {hiddenApplying > 0 ? (
            <button
              type="button"
              onClick={onSettings}
              className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400 underline-offset-2 hover:underline dark:text-slate-500"
            >
              <FiSettings className="h-3 w-3" aria-hidden="true" />
              {hiddenApplying === 1
                ? "1 hidden preference still applies"
                : `${hiddenApplying} hidden preferences still apply`}
            </button>
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
          <div className="mt-3">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {summarize(summary, hasFerry)}
            </p>
            {ignoredFactors.map((factor) => (
              <p
                key={factor.key}
                className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-500"
              >
                <FiCloudOff
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                {factor.lost}
              </p>
            ))}
            {factorChips.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {factorChips.map((factor) => (
                  <span
                    key={factor.key}
                    className={`inline-flex items-center gap-1 text-xs font-semibold ${factor.tint}`}
                  >
                    <factor.Icon className="h-3.5 w-3.5" aria-hidden={true} />
                    {Math.round(
                      summary.factors[factor.key as keyof RouteFactors] * 100,
                    )}
                    %
                  </span>
                ))}
              </div>
            ) : null}
          </div>
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
