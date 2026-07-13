"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { FiX } from "react-icons/fi";
import {
  type AuthInfo,
  createPin,
  deletePin,
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
import type { MapTarget } from "./map";
import PinEditor from "./pin-editor";
import SignInDialog from "./sign-in-dialog";
import Toolbar from "./toolbar";

// leaflet touches `window` at module load, so the map must be client-only
const MapView = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center text-sm text-slate-400">
      Loading map…
    </div>
  ),
});

export type AuthState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "signedIn"; info: AuthInfo };

type Editing =
  | { mode: "create"; draft: PinDraft }
  | { mode: "edit"; pin: Pin }
  | null;

export default function MapApp() {
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
  const [signingIn, setSigningIn] = useState<boolean>(false);
  const [locationError, setLocationError] = useState<
    "denied" | "unavailable" | null
  >(null);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = watchAuth((info) => {
      // onIdTokenChanged re-fires with a fresh AuthInfo each refresh; keep the old ref when uid+admin match to avoid a re-render
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
  }, []);

  const uid = auth.kind === "signedIn" ? auth.info.user.uid : null;
  const isAdmin = auth.kind === "signedIn" && auth.info.admin;

  useEffect(() => {
    if (!isAdmin) {
      setPins([]);
      return;
    }
    const unsubscribe = watchPins(setPins, () => {
      setBanner("Live updates stopped. Reload the page to reconnect.");
    });
    return unsubscribe;
  }, [isAdmin]);

  // follow centering lives in the map-side controller (reacts to userLocation + following)
  useEffect(() => {
    if (!isAdmin) {
      setUserLocation(null);
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
        setLocationError(null);
      },
      (error) => {
        setLocationError(
          error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
        );
      },
      { enableHighAccuracy: false, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [isAdmin]);

  const handleToggleFollow = useCallback(() => {
    setFollowing((on) => !on);
  }, []);

  // stable identity for a long-lived map listener; functional updater keeps disengage idempotent
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
      async (error) => {
        try {
          // high-accuracy fix failed; fall back to the last watched position
          if (userLocation) {
            await openEditorAt(userLocation.lat, userLocation.lng);
          } else {
            setLocationError(
              error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
            );
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
    // selecting a pin flies away from the user, so release follow rather than fight the watcher
    setFollowing(false);
  }, []);

  const handleCancel = useCallback(() => {
    setEditing(null);
    setTarget(null);
  }, []);

  const handleSave = useCallback(
    async (text: string) => {
      if (!uid || !editing) {
        return;
      }
      const write =
        editing.mode === "create"
          ? createPin(uid, { ...editing.draft, text })
          : updatePin(uid, editing.pin.id, { text });
      // optimistic close
      setEditing(null);
      setTarget(null);
      try {
        await write;
      } catch {
        setBanner(
          "Couldn't save your pin. Check your connection and try again.",
        );
      }
    },
    [uid, editing],
  );

  const handleDelete = useCallback(async () => {
    if (editing?.mode !== "edit") {
      return;
    }
    const write = deletePin(editing.pin.id);
    setEditing(null);
    setTarget(null);
    try {
      await write;
    } catch {
      setBanner(
        "Couldn't delete your pin. Check your connection and try again.",
      );
    }
  }, [editing]);

  const handleSignIn = useCallback(() => {
    setSigningIn(true);
  }, []);

  const handleCloseSignIn = useCallback(() => {
    setSigningIn(false);
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOutUser();
    setEditing(null);
    setTarget(null);
  }, []);

  const handleRefreshClaims = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshClaims();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const locationHint =
    locationError === "denied"
      ? "Location access is blocked — enable it in your browser settings."
      : locationError === "unavailable"
        ? "Couldn't get your location. Make sure location services are on."
        : null;

  const draft = editing?.mode === "create" ? editing.draft : null;

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      <MapView
        pins={pins}
        draft={draft}
        target={target}
        userLocation={userLocation}
        following={isAdmin && following}
        onDisengageFollow={handleDisengageFollow}
        onPinSelect={handlePinSelect}
      />
      <Toolbar
        auth={auth}
        pinCount={pins.length}
        refreshingClaims={refreshing}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
        onRefreshClaims={handleRefreshClaims}
      />
      {isAdmin ? (
        <FollowToggle active={following} onToggle={handleToggleFollow} />
      ) : null}
      {banner ? (
        <div className="absolute top-16 left-1/2 z-[1200] flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-2xl bg-slate-900/90 px-4 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900">
          <span>{banner}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="Dismiss"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white dark:text-slate-500 dark:hover:bg-slate-900/10 dark:hover:text-slate-900"
          >
            <FiX />
          </button>
        </div>
      ) : null}
      {isAdmin && !editing ? (
        <LogHereButton
          onClick={handleLogHere}
          disabled={userLocation === null}
          busy={logging}
          hint={locationHint}
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
      {signingIn ? <SignInDialog onClose={handleCloseSignIn} /> : null}
    </main>
  );
}
