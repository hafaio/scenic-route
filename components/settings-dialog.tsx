"use client";

import { useEffect, useRef, useState } from "react";
import { FiEye, FiEyeOff, FiX } from "react-icons/fi";
import { MdDragIndicator } from "react-icons/md";
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
} from "../src/overlays/registry";
import { mergeLayerOrder, updateSettings } from "../src/settings/store";
import { useCity } from "./city-context";
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
    }
    if (index === drag.from) {
      return drag.offset;
    }
    if (drag.to > drag.from && index > drag.from && index <= drag.to) {
      return -ROW_HEIGHT;
    }
    if (drag.to < drag.from && index >= drag.to && index < drag.from) {
      return ROW_HEIGHT;
    }
    return 0;
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
              className={`min-w-0 flex-1 truncate text-sm ${
                off
                  ? "text-slate-400 dark:text-slate-500"
                  : "text-slate-700 dark:text-slate-200"
              }`}
            >
              {overlayLabel(overlay, city)}
              {city.overlays.includes(id) ? null : (
                <span className="ml-2 text-[11px] text-slate-400 dark:text-slate-500">
                  not in {city.name}
                </span>
              )}
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

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
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
      </div>
    </div>
  );
}
