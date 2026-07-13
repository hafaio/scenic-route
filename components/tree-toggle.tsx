"use client";

import { PiTreeEvergreenFill } from "react-icons/pi";

interface TreeToggleProps {
  active: boolean;
  onToggle: () => void;
}

export default function TreeToggle({ active, onToggle }: TreeToggleProps) {
  const label = active ? "Hide tree cover" : "Show tree cover";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className="grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800"
    >
      <PiTreeEvergreenFill
        className={
          active
            ? "h-4 w-4 text-brand-600 dark:text-brand-400"
            : "h-4 w-4 text-slate-500 dark:text-slate-400"
        }
        aria-hidden="true"
      />
    </button>
  );
}
