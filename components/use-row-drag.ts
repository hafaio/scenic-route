"use client";

import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

// Dragging a row of a short list into a new place, on a touch screen as well as with a mouse.
//
// The arithmetic is in ROWS: how far the finger has travelled, divided by the height of one row, is
// how many places the row has moved. The height is measured from the row being dragged rather than
// declared, because the two lists this serves have different row heights — a layer is one line, a
// route preference is a line and a slider — and a number written down here would be wrong for one of
// them the next time either is restyled.

interface Drag {
  from: number; // where the row started
  to: number; // where it would land if the finger lifted now
  offset: number; // pixels the finger has travelled
  height: number; // one row, as measured when the drag began
}

export interface RowDrag {
  // How far this row is displaced right now: the dragged one follows the finger, and the rows it has
  // passed step out of its way by exactly one place.
  shiftOf: (index: number) => number;
  isDragging: (index: number) => boolean;
  active: boolean;
  // For the handle: `onPointerDown`. The handle needs `touch-action: none` so a finger on IT drags
  // rather than scrolling, while a finger anywhere else on the row still scrolls the sheet.
  start: (event: ReactPointerEvent<HTMLElement>, index: number) => void;
}

export function useRowDrag(
  count: number,
  move: (from: number, to: number) => void,
): RowDrag {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Read inside the pointer handlers, which are registered once per drag and must not close over a
  // count from before it.
  const rows = useRef(count);
  rows.current = count;

  const start = (
    event: ReactPointerEvent<HTMLElement>,
    from: number,
  ): void => {
    const handle = event.currentTarget;
    const row = handle.closest("li");
    const height = row?.getBoundingClientRect().height ?? 0;
    if (height === 0) {
      return;
    }
    handle.setPointerCapture(event.pointerId);
    const originY = event.clientY;
    let landing = from;

    const onMove = (moved: globalThis.PointerEvent): void => {
      const offset = moved.clientY - originY;
      landing = Math.min(
        rows.current - 1,
        Math.max(0, from + Math.round(offset / height)),
      );
      setDrag({ from, to: landing, offset, height });
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

  const shiftOf = (index: number): number => {
    if (!drag) {
      return 0;
    } else if (index === drag.from) {
      return drag.offset;
    } else if (drag.to > drag.from && index > drag.from && index <= drag.to) {
      return -drag.height;
    } else if (drag.to < drag.from && index >= drag.to && index < drag.from) {
      return drag.height;
    } else {
      return 0;
    }
  };

  return {
    shiftOf,
    isDragging: (index) => drag?.from === index,
    active: drag !== null,
    start,
  };
}
