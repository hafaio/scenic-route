"use client";

import { useEffect, useRef, useState } from "react";
import { FiLogOut, FiRefreshCw, FiUser } from "react-icons/fi";
import type { OverlayId } from "../src/overlays/registry";
import LayersControl from "./layers-control";
import type { AuthState } from "./map-app";
import RouteToggle from "./route-toggle";
import ThemeToggle from "./theme-toggle";

interface ToolbarProps {
  auth: AuthState;
  pinCount: number;
  activeOverlay: OverlayId | null;
  routing: boolean;
  refreshingClaims: boolean;
  onSelectOverlay: (id: OverlayId | null) => void;
  onToggleRouting: () => void;
  onSignIn: () => void;
  onSignOut: () => void | Promise<void>;
  onRefreshClaims: () => void | Promise<void>;
}

function initialFor(email: string | null): string {
  if (!email) {
    return "?";
  }
  const first = email.trim().charAt(0).toUpperCase();
  return first || "?";
}

export default function Toolbar({
  auth,
  pinCount,
  activeOverlay,
  routing,
  refreshingClaims,
  onSelectOverlay,
  onToggleRouting,
  onSignIn,
  onSignOut,
  onRefreshClaims,
}: ToolbarProps) {
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
  const email = auth.kind === "signedIn" ? auth.info.user.email : null;
  const isAdmin = auth.kind === "signedIn" && auth.info.admin;

  return (
    <div className="absolute top-3 right-3 z-[1000] flex items-center gap-2">
      <RouteToggle active={routing} onToggle={onToggleRouting} />
      <LayersControl activeOverlay={activeOverlay} onSelect={onSelectOverlay} />
      <ThemeToggle />
      {auth.kind === "signedOut" ? (
        <button
          type="button"
          onClick={onSignIn}
          aria-label="Sign in"
          title="Sign in"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/85 text-slate-700 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-slate-800"
        >
          <FiUser className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      {auth.kind === "signedIn" ? (
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
              className="absolute right-0 mt-2 w-72 origin-top-right overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
            >
              <div className="border-b border-slate-200/60 px-4 py-3 dark:border-slate-700/60">
                <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  Signed in as
                </p>
                <p className="mt-0.5 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                  {email ?? "Unknown"}
                </p>
                {isAdmin ? (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    {pinLabel} logged
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    You're signed in, but your account doesn't have admin access
                    yet. Ask an admin to grant you the <code>admin</code> claim.
                  </p>
                )}
              </div>
              {isAdmin ? null : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void onRefreshClaims();
                  }}
                  disabled={refreshingClaims}
                  className="flex w-full items-center gap-2 border-b border-slate-200/60 px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700/60 dark:text-slate-200 dark:hover:bg-slate-700/60"
                >
                  <FiRefreshCw
                    className={refreshingClaims ? "animate-spin" : undefined}
                  />
                  Check again
                </button>
              )}
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
      ) : null}
    </div>
  );
}
