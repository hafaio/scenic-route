"use client";

import { useEffect, useRef, useState } from "react";
import { FiLogOut } from "react-icons/fi";
import ThemeToggle from "./theme-toggle";

interface LoggerToolbarProps {
  email: string | null;
  pinCount: number;
  onSignOut: () => void | Promise<void>;
}

function initialFor(email: string | null): string {
  if (!email) {
    return "?";
  }
  const first = email.trim().charAt(0).toUpperCase();
  return first || "?";
}

export default function LoggerToolbar({
  email,
  pinCount,
  onSignOut,
}: LoggerToolbarProps) {
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const pinLabel = pinCount === 1 ? "1 pin" : `${pinCount} pins`;

  return (
    <div className="absolute top-3 right-3 z-[1000] flex items-center gap-2">
      <ThemeToggle />
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Account menu"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/85 text-sm font-semibold text-slate-700 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-slate-800"
        >
          <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white">
            {initialFor(email)}
          </span>
        </button>
        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-60 origin-top-right overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
          >
            <div className="border-b border-slate-200/60 px-4 py-3 dark:border-slate-700/60">
              <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Signed in as
              </p>
              <p className="mt-0.5 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                {email ?? "Unknown"}
              </p>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {pinLabel} logged
              </p>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void onSignOut();
              }}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60"
            >
              <FiLogOut />
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
