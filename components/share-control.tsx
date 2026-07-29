"use client";

import { useEffect, useState } from "react";
import { FiCheck, FiShare2 } from "react-icons/fi";

interface ShareControlProps {
  composeUrl: () => string;
}

const CONFIRM_MS = 2200;

// Copies a link to the current route together with the camera and overlays — the one place the view
// enters a URL. The address bar is left alone, so this pill is the only confirmation there is; it sits
// alongside the button rather than below, where the location banner (a higher stacking context, so it
// cannot simply be out-z-indexed) would hide it.
export default function ShareControl({ composeUrl }: ShareControlProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status === "idle") {
      return;
    }
    const timer = setTimeout(() => setStatus("idle"), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const share = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(composeUrl());
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void share()}
        aria-label="Copy a link to this view"
        title="Copy a link to this view"
        className={`grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800 ${status === "copied" ? "text-brand-600 dark:text-brand-400" : "text-slate-500 dark:text-slate-400"}`}
      >
        {status === "copied" ? (
          <FiCheck className="h-4 w-4" aria-hidden="true" />
        ) : (
          <FiShare2 className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
      {status === "idle" ? null : (
        <span
          role="status"
          className="absolute top-1/2 right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded-full bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900"
        >
          {status === "copied" ? "Link copied" : "Couldn't copy the link"}
        </span>
      )}
    </div>
  );
}
