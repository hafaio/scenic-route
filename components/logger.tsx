"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { FiLogOut, FiMapPin, FiRefreshCw } from "react-icons/fi";
import {
  type AuthInfo,
  createPin,
  deletePin,
  isFirebaseConfigured,
  refreshClaims,
  signOutUser,
  updatePin,
  watchAuth,
  watchPins,
} from "../src/firebase";
import { reverseGeocode } from "../src/geocode";
import type { Pin, PinDraft } from "../src/pin";
import FollowToggle from "./follow-toggle";
import LogHereButton from "./log-here-button";
import type { MapTarget } from "./logger-map";
import LoggerToolbar from "./logger-toolbar";
import Login from "./login";
import PinEditor from "./pin-editor";
import ThemeToggle from "./theme-toggle";

// Leaflet touches `window` at module load, so the map must be client-only.
const LoggerMap = dynamic(() => import("./logger-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center text-sm text-slate-400">
      Loading map…
    </div>
  ),
});

type AuthState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "signedIn"; info: AuthInfo };

type Editing =
  | { mode: "create"; draft: PinDraft }
  | { mode: "edit"; pin: Pin }
  | null;

function BrandLogo({ size = 28 }: { size?: number }) {
  return (
    <span
      className="scenic-logo-pin grid place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg"
      style={{ width: size * 1.4, height: size * 1.4 }}
      aria-hidden="true"
    >
      <FiMapPin style={{ width: size * 0.7, height: size * 0.7 }} />
    </span>
  );
}

export default function Logger() {
  const configured = isFirebaseConfigured();
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [pins, setPins] = useState<Pin[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [target, setTarget] = useState<MapTarget | null>(null);
  const [userLocation, setUserLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [logging, setLogging] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [following, setFollowing] = useState<boolean>(true);

  useEffect(() => {
    if (!configured) {
      return;
    }
    const unsubscribe = watchAuth((info) => {
      // Token refreshes re-fire onIdTokenChanged with a fresh AuthInfo even
      // when uid+admin haven't changed. Returning the previous reference
      // when the relevant fields match keeps React from re-rendering.
      setAuth((prev) => {
        if (!info) {
          return prev.kind === "signedOut" ? prev : { kind: "signedOut" };
        }
        if (
          prev.kind === "signedIn" &&
          prev.info.user.uid === info.user.uid &&
          prev.info.admin === info.admin
        ) {
          return prev;
        }
        return { kind: "signedIn", info };
      });
    });
    return unsubscribe;
  }, [configured]);

  const uid = auth.kind === "signedIn" ? auth.info.user.uid : null;
  const email = auth.kind === "signedIn" ? auth.info.user.email : null;
  const isAdmin = auth.kind === "signedIn" && auth.info.admin;

  useEffect(() => {
    if (!isAdmin) {
      setPins([]);
      return;
    }
    const unsubscribe = watchPins(setPins);
    return unsubscribe;
  }, [isAdmin]);

  // Live geolocation: keep the user marker in sync. Follow centering is owned
  // by the map-side controller, which reacts to userLocation + following.
  useEffect(() => {
    if (!isAdmin) {
      return;
    }
    if (!("geolocation" in navigator)) {
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setUserLocation({ lat, lng });
      },
      () => {},
      { enableHighAccuracy: false, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [isAdmin]);

  const handleToggleFollow = useCallback(() => {
    setFollowing((on) => !on);
  }, []);

  // Released whenever the user pans/zooms the map themselves. Stable so the
  // map-side controller can keep it as a long-lived listener; the functional
  // updater makes flipping to false idempotent.
  const handleDisengageFollow = useCallback(() => {
    setFollowing(() => false);
  }, []);

  const handleLogHere = useCallback(async () => {
    const openEditorAt = async (lat: number, lng: number) => {
      let address = "Unknown location";
      try {
        const result = await reverseGeocode(lat, lng);
        if (result) {
          address = result.displayName;
        }
      } catch {}
      setEditing({ mode: "create", draft: { lat, lng, address, text: "" } });
    };
    if (!("geolocation" in navigator)) {
      return;
    }
    setLogging(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          await openEditorAt(
            position.coords.latitude,
            position.coords.longitude,
          );
        } finally {
          setLogging(false);
        }
      },
      async () => {
        try {
          // High-accuracy fix failed; fall back to the last watched position.
          if (userLocation) {
            await openEditorAt(userLocation.lat, userLocation.lng);
          }
        } finally {
          setLogging(false);
        }
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, [userLocation]);

  const handlePinSelect = useCallback((pin: Pin) => {
    setEditing({ mode: "edit", pin });
    setTarget({ lat: pin.lat, lng: pin.lng, zoom: 16 });
    // Flying to a saved pin moves the camera away from the user, so release
    // follow mode rather than fighting the geolocation watcher.
    setFollowing(false);
  }, []);

  const handleCancel = useCallback(() => {
    setEditing(null);
  }, []);

  const handleSave = useCallback(
    async (text: string) => {
      if (!uid || !editing) {
        return;
      }
      if (editing.mode === "create") {
        await createPin(uid, { ...editing.draft, text });
      } else {
        await updatePin(uid, editing.pin.id, { text });
      }
      setEditing(null);
    },
    [uid, editing],
  );

  const handleDelete = useCallback(async () => {
    if (editing?.mode !== "edit") {
      return;
    }
    await deletePin(editing.pin.id);
    setEditing(null);
  }, [editing]);

  const handleSignOut = useCallback(async () => {
    await signOutUser();
    setEditing(null);
  }, []);

  const handleRefreshClaims = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshClaims();
    } finally {
      setRefreshing(false);
    }
  }, []);

  if (!configured) {
    return (
      <main className="scenic-aurora flex h-dvh w-full items-center justify-center p-6">
        <div className="max-w-md rounded-3xl bg-white/90 p-8 text-center shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/90 dark:ring-white/10">
          <div className="mb-4 flex justify-center">
            <BrandLogo size={28} />
          </div>
          <h1 className="text-lg font-semibold">Firebase isn't configured</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Edit <code>src/firebase.ts</code> and replace the
            <code> firebaseConfig</code> placeholder values with the ones from
            your Firebase project.
          </p>
        </div>
      </main>
    );
  }

  if (auth.kind === "loading") {
    return (
      <main className="scenic-aurora flex h-dvh w-full flex-col items-center justify-center gap-4">
        <BrandLogo size={32} />
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
          Loading…
        </p>
      </main>
    );
  }

  if (auth.kind === "signedOut") {
    return <Login />;
  }

  if (!isAdmin) {
    return (
      <main className="scenic-aurora relative flex h-dvh w-full items-center justify-center p-6">
        <div className="absolute top-3 right-3">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-sm rounded-3xl bg-white/90 p-8 text-center shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/90 dark:ring-white/10">
          <div className="mb-4 flex justify-center">
            <BrandLogo size={28} />
          </div>
          <h1 className="text-lg font-semibold">Access pending</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            You're signed in, but your account doesn't have admin access yet.
            Ask an admin to grant you the <code>admin</code> claim.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={handleRefreshClaims}
              disabled={refreshing}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-500 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 disabled:opacity-50"
            >
              <FiRefreshCw
                className={refreshing ? "animate-spin" : undefined}
              />
              Check again
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <FiLogOut />
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }

  const draft = editing?.mode === "create" ? editing.draft : null;

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      <LoggerMap
        pins={pins}
        draft={draft}
        target={target}
        userLocation={userLocation}
        following={following}
        onDisengageFollow={handleDisengageFollow}
        onPinSelect={handlePinSelect}
      />
      <LoggerToolbar
        email={email}
        pinCount={pins.length}
        onSignOut={handleSignOut}
      />
      <FollowToggle active={following} onToggle={handleToggleFollow} />
      {!editing ? (
        <LogHereButton
          onClick={handleLogHere}
          disabled={userLocation === null}
          busy={logging}
        />
      ) : null}
      {editing ? (
        <PinEditor
          target={editing.mode === "create" ? editing.draft : editing.pin}
          mode={editing.mode}
          onSave={handleSave}
          onDelete={editing.mode === "edit" ? handleDelete : undefined}
          onCancel={handleCancel}
        />
      ) : null}
    </main>
  );
}
