"use client";

import { FiCrosshair, FiLoader } from "react-icons/fi";

interface LogHereButtonProps {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  hint?: string | null;
}

export default function LogHereButton({
  onClick,
  disabled,
  busy,
  hint,
}: LogHereButtonProps) {
  return (
    <div className="fixed bottom-0 left-1/2 z-[1000] flex -translate-x-1/2 flex-col items-center gap-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {hint ? (
        <p className="max-w-xs rounded-full bg-slate-900/85 px-3 py-1.5 text-center text-xs font-medium text-white shadow-lg backdrop-blur-md dark:bg-slate-100/90 dark:text-slate-900">
          {hint}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        aria-label="Log current location"
        className="inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-brand-500 to-brand-600 px-6 py-3.5 text-base font-semibold text-white shadow-xl ring-1 ring-black/5 transition hover:from-brand-600 hover:to-brand-700 disabled:opacity-50"
      >
        {busy ? (
          <FiLoader className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <FiCrosshair className="h-5 w-5" aria-hidden="true" />
        )}
        {busy ? "Locating…" : "Log here"}
      </button>
    </div>
  );
}
