"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FiEye, FiEyeOff, FiX } from "react-icons/fi";
import {
  MdConstruction,
  MdDirectionsBoat,
  MdDragIndicator,
} from "react-icons/md";
import type { City } from "../src/cities";
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
} from "../src/overlays/registry";
import type { RouteWeights } from "../src/routing/cost";
import {
  FACTORS,
  type FactorKey,
  FactorSlider,
  factorReading,
} from "../src/routing/factors";
import { COVERAGE, formatBytes } from "../src/settings/offline";
import { mergeLayerOrder, updateSettings } from "../src/settings/store";
import { totals } from "../src/sw/ledger";
import { useCity } from "./city-context";
import { clearOfflineMaps } from "./service-worker";
import { useSettings } from "./use-settings";

// The reader's preferences. Opened at `#settings`, like the About dialog, so it is deep-linkable and
// the back button dismisses it — and so the layers menu and the route panel can link INTO a section
// rather than describing where it is.

// Rows are a fixed height because the drag arithmetic is in rows: how far the finger has travelled,
// divided by this, is how many places the layer has moved. Keep it in step with the row's own class.
const ROW_HEIGHT = 44;

interface Drag {
  from: number; // where the row started
  to: number; // where it would land if the finger lifted now
  offset: number; // pixels the finger has travelled
}

function LayerRows() {
  const city = useCity();
  const { layerOrder, hiddenLayers } = useSettings();
  const order = mergeLayerOrder(layerOrder);
  const hidden = new Set(hiddenLayers);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Read inside the pointer handlers, which are registered once and must not close over a stale one.
  const live = useRef(order);
  live.current = order;

  const move = (from: number, to: number): void => {
    const next = [...live.current];
    next.splice(to, 0, ...next.splice(from, 1));
    updateSettings({ layerOrder: next });
  };

  const toggle = (id: OverlayId): void => {
    const next = new Set(hidden);
    if (!next.delete(id)) {
      next.add(id);
    }
    updateSettings({ hiddenLayers: [...next] });
  };

  const startDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    from: number,
  ): void => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const originY = event.clientY;
    const last = live.current.length - 1;
    let landing = from;

    const onMove = (moved: PointerEvent): void => {
      const offset = moved.clientY - originY;
      landing = Math.min(
        last,
        Math.max(0, from + Math.round(offset / ROW_HEIGHT)),
      );
      setDrag({ from, to: landing, offset });
    };
    const onEnd = (): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      setDrag(null);
      if (landing !== from) {
        move(from, landing);
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  // Where a row sits while another is being dragged over it: the dragged one follows the finger, and
  // the rows it has passed step out of its way by exactly one place.
  const shiftOf = (index: number): number => {
    if (!drag) {
      return 0;
    } else if (index === drag.from) {
      return drag.offset;
    } else if (drag.to > drag.from && index > drag.from && index <= drag.to) {
      return -ROW_HEIGHT;
    } else if (drag.to < drag.from && index >= drag.to && index < drag.from) {
      return ROW_HEIGHT;
    } else {
      return 0;
    }
  };

  return (
    <ul className="mt-3">
      {order.map((id, index) => {
        const overlay = OVERLAYS.find((entry) => entry.id === id);
        if (!overlay) {
          return null;
        }
        const off = hidden.has(id);
        const dragging = drag?.from === index;
        return (
          <li
            key={id}
            style={{
              height: ROW_HEIGHT,
              transform: `translateY(${shiftOf(index)}px)`,
              transition: drag
                ? dragging
                  ? "none"
                  : "transform 120ms"
                : "none",
              zIndex: dragging ? 1 : 0,
            }}
            className={`relative flex items-center gap-3 rounded-xl px-2 ${
              dragging
                ? "bg-white shadow-lg ring-1 ring-black/5 dark:bg-slate-700 dark:ring-white/10"
                : ""
            }`}
          >
            <span className={off ? "opacity-40" : undefined}>
              {overlay.icon}
            </span>
            <span
              className={`flex min-w-0 flex-1 items-baseline gap-2 text-sm ${
                off
                  ? "text-slate-400 dark:text-slate-500"
                  : "text-slate-700 dark:text-slate-200"
              }`}
            >
              <span className="truncate">{overlayLabel(overlay, city)}</span>
              <MissingHere city={city} overlay={id} />
            </span>
            <button
              type="button"
              onClick={() => toggle(id)}
              aria-pressed={!off}
              aria-label={
                off
                  ? `Show ${overlayLabel(overlay, city)} in the layers menu`
                  : `Hide ${overlayLabel(overlay, city)} from the layers menu`
              }
              className="grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              {off ? <FiEyeOff /> : <FiEye />}
            </button>
            {/* `touch-none` only here, so a finger anywhere else on the row still scrolls the sheet. */}
            <button
              type="button"
              onPointerDown={(event) => startDrag(event, index)}
              onKeyDown={(event) => {
                const step =
                  event.key === "ArrowUp"
                    ? -1
                    : event.key === "ArrowDown"
                      ? 1
                      : 0;
                const to = index + step;
                if (step !== 0 && to >= 0 && to < order.length) {
                  event.preventDefault();
                  move(index, to);
                }
              }}
              aria-label={`Reorder ${overlayLabel(overlay, city)}, ${index + 1} of ${order.length}`}
              className="grid h-8 w-8 cursor-grab touch-none place-items-center rounded-full text-slate-300 hover:bg-slate-100 active:cursor-grabbing dark:text-slate-500 dark:hover:bg-slate-700"
            >
              <MdDragIndicator />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// A preference this city has no data for, tagged the way the layers rows tag a layer it lacks. The
// row stays live either way: one weight covers every city, and it prices the route in the ones that
// do have the data.
function MissingHere({ city, overlay }: { city: City; overlay?: OverlayId }) {
  if (overlay === undefined || city.overlays.includes(overlay)) {
    return null;
  } else {
    return (
      <span className="shrink-0 text-[11px] text-slate-400 dark:text-slate-500">
        not in {city.name}
      </span>
    );
  }
}

// One of the two gates, editing the same state as the route panel's header toggles — which are only
// there in a city that has the thing, so this is where a reader in the other city can still set it.
function GateRow({
  icon,
  label,
  overlay,
  on,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  overlay: OverlayId;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const city = useCity();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/60"
    >
      <span
        className={on ? "text-slate-500 dark:text-slate-400" : "opacity-40"}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm text-slate-700 dark:text-slate-200">
        <span className="truncate">{label}</span>
        <MissingHere city={city} overlay={overlay} />
      </span>
      <span
        aria-hidden="true"
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
          on ? "bg-brand-500" : "bg-slate-300 dark:bg-slate-600"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white transition ${
            on ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function FactorRows({
  weights,
  onWeight,
}: {
  weights: RouteWeights;
  onWeight: (key: FactorKey, weight: number) => void;
}) {
  const city = useCity();
  const { hiddenFactors } = useSettings();
  const hidden = new Set(hiddenFactors);

  const toggle = (key: FactorKey): void => {
    const next = new Set(hidden);
    if (!next.delete(key)) {
      next.add(key);
    }
    updateSettings({ hiddenFactors: [...next] });
  };

  return (
    <ul className="mt-3">
      {FACTORS.map((factor) => {
        const off = hidden.has(factor.key);
        const weight = weights[factor.key];
        return (
          <li key={factor.key} className="px-2 py-1.5">
            <div className="flex items-center gap-3">
              <span className={off ? "opacity-40" : factor.tint}>
                <factor.Icon className="h-4 w-4" aria-hidden={true} />
              </span>
              <span
                className={`flex min-w-0 flex-1 items-baseline gap-2 text-sm ${
                  off
                    ? "text-slate-400 dark:text-slate-500"
                    : "text-slate-700 dark:text-slate-200"
                }`}
              >
                <span className="truncate">{factor.label}</span>
                <MissingHere city={city} overlay={factor.overlay} />
              </span>
              <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                {factorReading(factor, weight)}
              </span>
              <button
                type="button"
                onClick={() => toggle(factor.key)}
                aria-pressed={!off}
                aria-label={
                  off
                    ? `Show ${factor.label} in the route panel`
                    : `Hide ${factor.label} from the route panel`
                }
                className="grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                {off ? <FiEyeOff /> : <FiEye />}
              </button>
            </div>
            <FactorSlider
              factor={factor}
              weight={weight}
              onChange={(next) => onWeight(factor.key, next)}
              className="mt-1 w-full"
            />
          </li>
        );
      })}
    </ul>
  );
}

// How much of the map to keep, and how much is kept. The figure comes from the worker's own book
// (src/sw/ledger.ts) rather than from the worker, which is stopped between requests: the book is
// ordinary same-origin IndexedDB, so the page can read it without waking anything.
function OfflineSection() {
  const { coverage } = useSettings();
  const [held, setHeld] = useState<number | null>(null);

  const measure = useCallback(() => {
    void totals()
      .then((stores) => {
        // The overlay store only. The routing graphs are held under their own cap, none of these
        // options touch them and Clear does not either, so counting them here would answer a
        // question this section says it is not asking.
        setHeld(stores.overlay ?? 0);
      })
      .catch(() => {
        setHeld(null);
      });
  }, []);

  useEffect(measure, [measure]);

  // Empty either way: nothing cached yet, or the book could not be read. The reader can act on
  // neither, and "nothing kept yet" is true of both.
  const kept = held === null ? "" : formatBytes(held);

  return (
    <div className="mt-7">
      <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Offline maps
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Ground you have looked at is kept, so a walk works with no signal. The
        routes themselves are always kept and are not part of this.
      </p>
      <ul className="mt-3">
        {COVERAGE.map((option) => (
          <li key={option.id}>
            <label className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/60">
              {/* The dot beside it is the one that shows; a native radio cannot be styled to match
                  the rest of the page, and swapping it for a button loses the arrow-key group. */}
              <input
                type="radio"
                name="offline-coverage"
                value={option.id}
                checked={option.id === coverage}
                onChange={() => updateSettings({ coverage: option.id })}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                  option.id === coverage
                    ? "border-brand-500"
                    : "border-slate-300 dark:border-slate-600"
                } peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500`}
              >
                {option.id === coverage ? (
                  <span className="h-2 w-2 rounded-full bg-brand-500" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                {option.label}
              </span>
              <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                {option.detail}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between px-2 text-xs text-slate-500 dark:text-slate-400">
        <span>{kept === "" ? "Nothing kept yet" : `${kept} kept`}</span>
        <button
          type="button"
          onClick={() => {
            clearOfflineMaps();
            // The worker deletes in the background and the book is what this reads, so the figure is
            // taken again a moment later rather than assumed to be zero.
            window.setTimeout(measure, 600);
          }}
          className="font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          Clear stored maps
        </button>
      </div>
    </div>
  );
}

export default function SettingsDialog({
  weights,
  onWeight,
  onAllowFerries,
  onAllowSheds,
  onClose,
}: {
  weights: RouteWeights;
  onWeight: (key: FactorKey, weight: number) => void;
  onAllowFerries: (allow: boolean) => void;
  onAllowSheds: (allow: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-md md:rounded-3xl md:p-7"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700 md:hidden" />
        <div className="flex items-start gap-3">
          <h2
            id="settings-title"
            className="min-w-0 flex-1 text-lg font-semibold tracking-tight"
          >
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <FiX />
          </button>
        </div>

        <div className="mt-5">
          <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Map layers
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            The order of the layers menu, and which layers it offers. One order
            for every city — each shows the layers it has data for.
          </p>
          <LayerRows />
        </div>

        <div className="mt-6">
          <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Route preferences
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            One value per preference — these are the route panel's own sliders.
            Hiding one takes it out of the panel; it still prices the route.
          </p>
          <FactorRows weights={weights} onWeight={onWeight} />
          <div className="mt-2">
            <GateRow
              icon={<MdDirectionsBoat className="h-4 w-4" aria-hidden={true} />}
              label="Allow ferries"
              overlay="ferries"
              on={weights.allowFerries}
              onChange={onAllowFerries}
            />
            <GateRow
              icon={<MdConstruction className="h-4 w-4" aria-hidden={true} />}
              label="Allow scaffolding"
              overlay="scaffolding"
              on={weights.allowSheds}
              onChange={onAllowSheds}
            />
          </div>
        </div>

        <OfflineSection />
      </div>
    </div>
  );
}
