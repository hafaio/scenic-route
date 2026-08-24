"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FiEye, FiEyeOff, FiX } from "react-icons/fi";
import { MdDragIndicator } from "react-icons/md";
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
  GATES,
  type Gate,
  type GateKey,
} from "../src/routing/factors";
import { COVERAGE, formatBytes } from "../src/settings/offline";
import {
  factorRunOrder,
  layerMenuOrder,
  updateSettings,
} from "../src/settings/store";
import { totals } from "../src/sw/ledger";
import { useCity } from "./city-context";
import { clearOfflineMaps } from "./service-worker";
import { type RowDrag, useRowDrag } from "./use-row-drag";
import { useSettings } from "./use-settings";

// The reader's preferences. Opened at `#settings`, like the About dialog, so it is deep-linkable and
// the back button dismisses it — and so the layers menu and the route panel can link INTO a section
// rather than describing where it is.

// The handle a row is dragged by, and the arrow keys that do the same thing without a pointer.
// `touch-none` is on the handle alone, so a finger anywhere else on the row still scrolls the sheet.
function DragHandle({
  label,
  index,
  count,
  drag,
  move,
}: {
  label: string;
  index: number;
  count: number;
  drag: RowDrag;
  move: (from: number, to: number) => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={(event) => drag.start(event, index)}
      onKeyDown={(event) => {
        const step =
          event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        const to = index + step;
        if (step !== 0 && to >= 0 && to < count) {
          event.preventDefault();
          move(index, to);
        }
      }}
      aria-label={`Reorder ${label}, ${index + 1} of ${count}`}
      className="grid h-8 w-8 shrink-0 cursor-grab touch-none place-items-center rounded-full text-slate-300 hover:bg-slate-100 active:cursor-grabbing dark:text-slate-500 dark:hover:bg-slate-700"
    >
      <MdDragIndicator />
    </button>
  );
}

// What a row wears while its list is being dragged in: the dragged one lifts and follows the finger,
// the rest slide out of its way.
function draggingRow(index: number, drag: RowDrag): CSSProperties {
  const lifted = drag.isDragging(index);
  return {
    transform: `translateY(${drag.shiftOf(index)}px)`,
    transition: drag.active && !lifted ? "transform 120ms" : "none",
    zIndex: lifted ? 1 : 0,
  };
}

const LIFTED =
  "bg-white shadow-lg ring-1 ring-black/5 dark:bg-slate-700 dark:ring-white/10";

function LayerRows() {
  const city = useCity();
  const { layerOrder, hiddenLayers } = useSettings();
  const order = layerMenuOrder(layerOrder);
  const hidden = new Set(hiddenLayers);
  const live = useRef(order);
  live.current = order;

  const move = (from: number, to: number): void => {
    const next = [...live.current];
    next.splice(to, 0, ...next.splice(from, 1));
    updateSettings({ layerOrder: next });
  };
  const drag = useRowDrag(order.length, move);

  const toggle = (id: OverlayId): void => {
    const next = new Set(hidden);
    if (!next.delete(id)) {
      next.add(id);
    }
    updateSettings({ hiddenLayers: [...next] });
  };

  return (
    <ul className="mt-3">
      {order.map((id, index) => {
        const overlay = OVERLAYS.find((entry) => entry.id === id);
        if (!overlay) {
          return null;
        }
        const off = hidden.has(id);
        const label = overlayLabel(overlay, city);
        return (
          <li
            key={id}
            style={{ height: 44, ...draggingRow(index, drag) }}
            className={`relative flex items-center gap-3 rounded-xl px-2 ${
              drag.isDragging(index) ? LIFTED : ""
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
              <span className="truncate">{label}</span>
              <MissingHere city={city} overlay={id} />
            </span>
            <HideToggle
              off={off}
              label={label}
              where="the layers menu"
              onToggle={() => toggle(id)}
            />
            <DragHandle
              label={label}
              index={index}
              count={order.length}
              drag={drag}
              move={move}
            />
          </li>
        );
      })}
    </ul>
  );
}

// The eye every hideable row wears. `where` is what the row is being taken out of, said out loud,
// because "hide" alone leaves a reader guessing whether the thing stops applying.
function HideToggle({
  off,
  label,
  where,
  onToggle,
}: {
  off: boolean;
  label: string;
  where: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={!off}
      aria-label={
        off ? `Show ${label} in ${where}` : `Hide ${label} from ${where}`
      }
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
    >
      {off ? <FiEyeOff /> : <FiEye />}
    </button>
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

// One of the two gates, editing the same state as the route panel's header toggles. Hideable like a
// factor and on the same bargain: the gate keeps gating, so a closed one that has been hidden is
// counted in the panel's "hidden preferences still apply" line.
function GateRow({
  gate,
  on,
  hidden,
  onChange,
  onHide,
}: {
  gate: Gate;
  on: boolean;
  hidden: boolean;
  onChange: (on: boolean) => void;
  onHide: () => void;
}) {
  const city = useCity();
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-2">
      <span
        className={
          hidden
            ? "opacity-40"
            : on
              ? "text-slate-500 dark:text-slate-400"
              : "opacity-40"
        }
      >
        <gate.Icon className="h-4 w-4" aria-hidden={true} />
      </span>
      <span
        className={`flex min-w-0 flex-1 items-baseline gap-2 text-sm ${
          hidden
            ? "text-slate-400 dark:text-slate-500"
            : "text-slate-700 dark:text-slate-200"
        }`}
      >
        <span className="truncate">{gate.label}</span>
        <MissingHere city={city} overlay={gate.overlay} />
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={gate.label}
        onClick={() => onChange(!on)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
          on ? "bg-brand-500" : "bg-slate-300 dark:bg-slate-600"
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-4 w-4 rounded-full bg-white transition ${
            on ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      <HideToggle
        off={hidden}
        label={gate.label}
        where="the route panel"
        onToggle={onHide}
      />
    </li>
  );
}

function GateRows({
  weights,
  onAllowFerries,
  onAllowSheds,
}: {
  weights: RouteWeights;
  onAllowFerries: (on: boolean) => void;
  onAllowSheds: (on: boolean) => void;
}) {
  const { hiddenGates } = useSettings();
  const hidden = new Set(hiddenGates);
  const setters: Record<GateKey, (on: boolean) => void> = {
    allowFerries: onAllowFerries,
    allowSheds: onAllowSheds,
  };
  return (
    <ul className="mt-2">
      {GATES.map((gate) => (
        <GateRow
          key={gate.key}
          gate={gate}
          on={weights[gate.key]}
          hidden={hidden.has(gate.key)}
          onChange={setters[gate.key]}
          onHide={() => {
            const next = new Set(hidden);
            if (!next.delete(gate.key)) {
              next.add(gate.key);
            }
            updateSettings({ hiddenGates: [...next] });
          }}
        />
      ))}
    </ul>
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
  const { factorOrder, hiddenFactors } = useSettings();
  const order = factorRunOrder(factorOrder);
  const hidden = new Set(hiddenFactors);
  const live = useRef(order);
  live.current = order;

  const move = (from: number, to: number): void => {
    const next = [...live.current];
    next.splice(to, 0, ...next.splice(from, 1));
    updateSettings({ factorOrder: next });
  };
  const drag = useRowDrag(order.length, move);

  const toggle = (key: FactorKey): void => {
    const next = new Set(hidden);
    if (!next.delete(key)) {
      next.add(key);
    }
    updateSettings({ hiddenFactors: [...next] });
  };

  return (
    <ul className="mt-3">
      {order.map((key, index) => {
        const factor = FACTORS.find((entry) => entry.key === key);
        if (!factor) {
          return null;
        }
        const off = hidden.has(key);
        const weight = weights[key];
        return (
          <li
            key={key}
            style={draggingRow(index, drag)}
            className={`relative rounded-xl px-2 py-1.5 ${
              drag.isDragging(index) ? LIFTED : ""
            }`}
          >
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
              <HideToggle
                off={off}
                label={factor.label}
                where="the route panel"
                onToggle={() => toggle(key)}
              />
              <DragHandle
                label={factor.label}
                index={index}
                count={order.length}
                drag={drag}
                move={move}
              />
            </div>
            <FactorSlider
              factor={factor}
              weight={weight}
              onChange={(next) => onWeight(key, next)}
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
          <GateRows
            weights={weights}
            onAllowFerries={onAllowFerries}
            onAllowSheds={onAllowSheds}
          />
        </div>

        <OfflineSection />
      </div>
    </div>
  );
}
