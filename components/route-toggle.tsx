"use client";

import { MdDirectionsWalk } from "react-icons/md";

interface RouteToggleProps {
  active: boolean;
  onToggle: () => void;
}

export default function RouteToggle({ active, onToggle }: RouteToggleProps) {
  const label = active ? "Close directions" : "Get walking directions";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className="grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800"
    >
      <MdDirectionsWalk
        className={
          active
            ? "h-5 w-5 text-brand-600 dark:text-brand-400"
            : "h-5 w-5 text-slate-500 dark:text-slate-400"
        }
        aria-hidden="true"
      />
    </button>
  );
}
