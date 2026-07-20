"use client";

import { useEffect, useRef, useState } from "react";
import {
  FiCrosshair,
  FiInfo,
  FiLoader,
  FiLogIn,
  FiLogOut,
  FiMapPin,
  FiRefreshCw,
  FiUser,
} from "react-icons/fi";
import type { OverlayId } from "../src/overlays/registry";
import ClockControl from "./clock-control";
import LayersControl from "./layers-control";
import type { AuthState } from "./map-app";
import RouteToggle from "./route-toggle";
import ThemeToggle from "./theme-toggle";

interface ToolbarProps {
  auth: AuthState;
  pinCount: number;
  activeOverlays: ReadonlySet<OverlayId>;
  routing: boolean;
  refreshingClaims: boolean;
  onToggleOverlay: (id: OverlayId) => void;
  onToggleRouting: () => void;
  onSignIn: () => void;
  onSignOut: () => void | Promise<void>;
  onRefreshClaims: () => void | Promise<void>;
  onAbout: () => void;
  onLogHere: () => void;
  logHereDisabled: boolean; // no live location yet, so there's nothing to log
  logHereBusy: boolean; // a high-accuracy fix + geocode is in flight
  logHereHint: string | null; // why the location is unavailable, when it is
  shareLocationForSearch: boolean; // send the live location to the geocoder to rank nearby results
  onToggleSearchBias: () => void;
}

const MENU_ITEM =
  "flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60";
const MENU_DIVIDER = "border-b border-slate-200/60 dark:border-slate-700/60";

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
  activeOverlays,
  routing,
  refreshingClaims,
  onToggleOverlay,
  onToggleRouting,
  onSignIn,
  onSignOut,
  onRefreshClaims,
  onAbout,
  onLogHere,
  logHereDisabled,
  logHereBusy,
  logHereHint,
  shareLocationForSearch,
  onToggleSearchBias,
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
  const signedIn = auth.kind === "signedIn";
  const email = auth.kind === "signedIn" ? auth.info.user.email : null;
  const isAdmin = auth.kind === "signedIn" && auth.info.admin;

  return (
    <div className="absolute top-3 right-3 z-[1000] flex items-center gap-2">
      <RouteToggle active={routing} onToggle={onToggleRouting} />
      <LayersControl active={activeOverlays} onToggle={onToggleOverlay} />
      <ClockControl />
      <ThemeToggle />
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={signedIn ? "Account menu" : "Menu"}
          className="grid h-10 w-10 place-items-center rounded-full bg-white/85 text-sm font-semibold text-slate-700 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-slate-800"
        >
          {signedIn ? (
            <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white">
              {initialFor(email)}
            </span>
          ) : (
            <FiUser className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-72 origin-top-right overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
          >
            {signedIn ? (
              <div className={`px-4 py-3 ${MENU_DIVIDER}`}>
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
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onLogHere();
                }}
                disabled={logHereDisabled || logHereBusy}
                className={`items-start disabled:opacity-50 ${MENU_ITEM} ${MENU_DIVIDER}`}
              >
                {logHereBusy ? (
                  <FiLoader className="mt-0.5 animate-spin" />
                ) : (
                  <FiCrosshair className="mt-0.5" />
                )}
                <span className="flex min-w-0 flex-col">
                  <span>{logHereBusy ? "Locating…" : "Log here"}</span>
                  {!logHereBusy && (logHereHint || logHereDisabled) ? (
                    <span className="mt-0.5 text-xs font-normal text-slate-400 dark:text-slate-500">
                      {logHereHint ?? "Waiting for your location…"}
                    </span>
                  ) : null}
                </span>
              </button>
            ) : null}
            {signedIn && !isAdmin ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void onRefreshClaims();
                }}
                disabled={refreshingClaims}
                className={`disabled:opacity-50 ${MENU_ITEM} ${MENU_DIVIDER}`}
              >
                <FiRefreshCw
                  className={refreshingClaims ? "animate-spin" : undefined}
                />
                Check again
              </button>
            ) : null}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={shareLocationForSearch}
              // A preference toggle, so it leaves the menu open for the next action.
              onClick={onToggleSearchBias}
              className={`justify-between ${MENU_ITEM} ${MENU_DIVIDER}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FiMapPin className="shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span>Search near me</span>
                  <span className="mt-0.5 text-xs font-normal text-slate-400 dark:text-slate-500">
                    Rank nearby results first
                  </span>
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
                  shareLocationForSearch
                    ? "bg-brand-500"
                    : "bg-slate-300 dark:bg-slate-600"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition ${
                    shareLocationForSearch ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onAbout();
              }}
              className={`${MENU_ITEM} ${MENU_DIVIDER}`}
            >
              <FiInfo />
              About
            </button>
            {signedIn ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void onSignOut();
                }}
                className={MENU_ITEM}
              >
                <FiLogOut />
                Sign out
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onSignIn();
                }}
                className={MENU_ITEM}
              >
                <FiLogIn />
                Sign in
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
