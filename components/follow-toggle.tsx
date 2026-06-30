"use client";

import { FiNavigation } from "react-icons/fi";

interface FollowToggleProps {
  active: boolean;
  onToggle: () => void;
}

export default function FollowToggle({ active, onToggle }: FollowToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={active ? "Following your location" : "Follow your location"}
      title={active ? "Following your location" : "Follow your location"}
      className="absolute top-3 left-3 z-[1000] grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800"
    >
      <FiNavigation
        className={
          active
            ? "h-4 w-4 fill-current text-brand-600 dark:text-brand-400"
            : "h-4 w-4 text-slate-500 dark:text-slate-400"
        }
        aria-hidden="true"
      />
    </button>
  );
}
