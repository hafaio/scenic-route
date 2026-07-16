"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { type GeocodeResult, reverseGeocode } from "../src/geocode";
import type { Pin, PinDraft } from "../src/pin";
import { DEFAULT_TREE_WEIGHT, MAX_TREE_WEIGHT } from "../src/routing/cost";
import { loadGraph, type RoutingGraph } from "../src/routing/graph";
import { RouteCache } from "../src/routing/route-cache";
import type { RouteResult } from "../src/routing/search";
import { buildSnapIndex, type SnapIndex, snapPair } from "../src/routing/snap";
import FollowToggle from "./follow-toggle";
import LogHereButton from "./log-here-button";
import type { MapTarget } from "./map";
import PinEditor from "./pin-editor";
import RoutePanel from "./route-panel";
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

type RouteState =
  | { kind: "idle" }
  | { kind: "loading" } // graph fetch or search in flight
  | { kind: "ready"; result: RouteResult }
  | { kind: "error"; message: string };

const TREE_WEIGHT_KEY = "scenic-route:tree-weight";
const RESNAP_METERS = 25; // a followed location must drift this far before the route recomputes

// The graph and its snap index are fetched and built once, on first Directions use, and shared by
// every recompute and the route layer's geometry lookups.
let routingPromise: Promise<{ graph: RoutingGraph; index: SnapIndex }> | null =
  null;
function loadRouting(): Promise<{ graph: RoutingGraph; index: SnapIndex }> {
  if (!routingPromise) {
    routingPromise = loadGraph()
      .then((graph) => ({ graph, index: buildSnapIndex(graph) }))
      .catch((error: unknown) => {
        routingPromise = null; // a failed load must not be memoized
        throw error;
      });
  }
  return routingPromise;
}

function metersBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const deltaLat = (b.lat - a.lat) * toRad;
  const deltaLng = (b.lng - a.lng) * toRad;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const inner =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(inner)));
}

function messageFor(
  reason: "startTooFar" | "destTooFar" | "disconnected",
): string {
  if (reason === "disconnected") {
    return "No walkable connection in the street data — likely separated by water.";
  }
  return "That point is more than 300 m from a walkable street.";
}

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
  // the only content a signed-out visitor has, so it starts on
  const [treeCover, setTreeCover] = useState<boolean>(true);
  const [signingIn, setSigningIn] = useState<boolean>(false);
  const [locationError, setLocationError] = useState<
    "denied" | "unavailable" | null
  >(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [routingOpen, setRoutingOpen] = useState<boolean>(false);
  const [manualStart, setManualStart] = useState<{
    lat: number;
    lng: number;
    label: string | null;
  } | null>(null);
  const [dest, setDest] = useState<{
    lat: number;
    lng: number;
    label: string | null;
  } | null>(null);
  // which field, if any, has armed a map tap to set its location
  const [pickTarget, setPickTarget] = useState<"start" | "dest" | null>(null);
  const [treeWeight, setTreeWeight] = useState<number>(DEFAULT_TREE_WEIGHT);
  // The start point routing actually uses: the manual start when set, else the live location snapped
  // through the resnap threshold so a followed GPS stream doesn't rerun the search on every fix.
  const [resolvedStart, setResolvedStart] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  // the live fix resolvedStart is pinned to, so drift is measured against it, not every raw tick
  const startBasisRef = useRef<{ lat: number; lng: number } | null>(null);
  const [routeState, setRouteState] = useState<RouteState>({ kind: "idle" });
  // the endpoints a route was last computed for, so a slider move recomputes without a loading flash
  const routedForRef = useRef<{
    start: { lat: number; lng: number };
    dest: { lat: number; lng: number };
  } | null>(null);
  // Caches routes across slider weights for the current endpoints, so most drags reuse a computed
  // path and identical paths never redraw the map.
  const routeCacheRef = useRef<RouteCache | null>(null);
  routeCacheRef.current ??= new RouteCache();

  useEffect(() => {
    const stored = window.localStorage.getItem(TREE_WEIGHT_KEY);
    if (stored !== null) {
      const parsed = Number.parseFloat(stored);
      if (Number.isFinite(parsed)) {
        setTreeWeight(Math.min(MAX_TREE_WEIGHT, Math.max(0, parsed)));
      }
    }
  }, []);

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
  }, []);

  const handleToggleFollow = useCallback(() => {
    setFollowing((on) => !on);
  }, []);

  const handleToggleTreeCover = useCallback(() => {
    setTreeCover((on) => !on);
  }, []);

  // stable identity for a long-lived map listener; functional updater keeps disengage idempotent
  const handleDisengageFollow = useCallback(() => {
    setFollowing(() => false);
  }, []);

  // Resolve the routing start: a manual start is used verbatim; otherwise the live location, adopted
  // on the first fix and thereafter chased only when it drifts past the resnap threshold, so a
  // followed GPS stream doesn't churn the search. Clearing the manual start snaps to live at once.
  useEffect(() => {
    if (manualStart) {
      startBasisRef.current = null;
      setResolvedStart((previous) =>
        previous &&
        previous.lat === manualStart.lat &&
        previous.lng === manualStart.lng
          ? previous
          : { lat: manualStart.lat, lng: manualStart.lng },
      );
    } else if (!userLocation) {
      startBasisRef.current = null;
      setResolvedStart(null);
    } else {
      const basis = startBasisRef.current;
      if (!basis || metersBetween(basis, userLocation) > RESNAP_METERS) {
        startBasisRef.current = {
          lat: userLocation.lat,
          lng: userLocation.lng,
        };
        setResolvedStart({ lat: userLocation.lat, lng: userLocation.lng });
      }
    }
  }, [manualStart, userLocation]);

  // Live recompute: whenever a resolvable start and a destination both exist, (re)find the route,
  // keyed on the endpoints and the tree weight and rAF-coalesced so a slider drag computes at most
  // once per frame. The loading flash shows only for a new endpoint pair; a slider move re-costs in
  // place. Writes only routeState/routedForRef (neither a dep), so it can't re-trigger itself.
  useEffect(() => {
    if (!resolvedStart || !dest) {
      setRouteState({ kind: "idle" });
      routedForRef.current = null;
      return;
    }
    const request = {
      start: { lat: resolvedStart.lat, lng: resolvedStart.lng },
      dest: { lat: dest.lat, lng: dest.lng },
    };
    const previous = routedForRef.current;
    const isNewTarget =
      !previous ||
      previous.dest.lat !== request.dest.lat ||
      previous.dest.lng !== request.dest.lng ||
      previous.start.lat !== request.start.lat ||
      previous.start.lng !== request.start.lng;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (isNewTarget) {
        setRouteState({ kind: "loading" });
      }
      loadRouting().then(
        ({ graph, index }) => {
          if (cancelled) {
            return;
          }
          routedForRef.current = request;
          const pair = snapPair(graph, index, request.start, request.dest);
          if (!pair.ok) {
            setRouteState({ kind: "error", message: messageFor(pair.reason) });
          } else {
            const cache = (routeCacheRef.current ??= new RouteCache());
            const { result, changed } = cache.route(
              graph,
              pair.start,
              pair.dest,
              treeWeight,
            );
            // Identical to the drawn route (a slider move that didn't cross a breakpoint): leave it.
            if (changed) {
              if (result) {
                setRouteState({ kind: "ready", result });
              } else {
                setRouteState({
                  kind: "error",
                  message: messageFor("disconnected"),
                });
              }
            }
          }
        },
        () => {
          if (!cancelled) {
            setRouteState({
              kind: "error",
              message: "Couldn't load the routing data. Check your connection.",
            });
          }
        },
      );
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [resolvedStart, dest, treeWeight]);

  const handleToggleRouting = useCallback(() => {
    setRoutingOpen((open) => {
      if (open) {
        // closing clears everything but keeps the slider value
        setDest(null);
        setManualStart(null);
        setPickTarget(null);
        setRouteState({ kind: "idle" });
        routedForRef.current = null;
      } else {
        // warm the graph so the first route lands without a fetch stall
        void loadRouting();
      }
      return !open;
    });
  }, []);

  const handleTreeWeight = useCallback((weight: number) => {
    setTreeWeight(weight);
    window.localStorage.setItem(TREE_WEIGHT_KEY, String(weight));
  }, []);

  const handleDestSelect = useCallback((result: GeocodeResult) => {
    setDest({ lat: result.lat, lng: result.lng, label: result.displayName });
    setPickTarget(null);
  }, []);

  const handleStartSelect = useCallback((result: GeocodeResult) => {
    setManualStart({
      lat: result.lat,
      lng: result.lng,
      label: result.displayName,
    });
    setPickTarget(null);
  }, []);

  const handleClearDest = useCallback(() => {
    setDest(null);
    setPickTarget((target) => (target === "dest" ? null : target));
  }, []);

  // Clearing the start — via the X or the dropdown's "My location" row — resets it to the live position.
  const handleClearStart = useCallback(() => {
    setManualStart(null);
    setPickTarget((target) => (target === "start" ? null : target));
  }, []);

  const handleArmStart = useCallback(() => {
    setPickTarget((target) => (target === "start" ? null : "start"));
  }, []);

  const handleArmDest = useCallback(() => {
    setPickTarget((target) => (target === "dest" ? null : "dest"));
  }, []);

  const applyPick = useCallback(
    (target: "start" | "dest", lat: number, lng: number) => {
      // "Dropped pin" is immediate feedback; the reverse geocode replaces it when it lands.
      const pinned = { lat, lng, label: "Dropped pin" };
      if (target === "start") {
        setManualStart(pinned);
      } else {
        setDest(pinned);
      }
      reverseGeocode(lat, lng)
        .then((place) => {
          if (!place) {
            return;
          }
          const patch = (
            current: { lat: number; lng: number; label: string | null } | null,
          ) =>
            current && current.lat === lat && current.lng === lng
              ? { ...current, label: place.displayName }
              : current;
          if (target === "start") {
            setManualStart(patch);
          } else {
            setDest(patch);
          }
        })
        .catch(() => {});
    },
    [],
  );

  // A bare map tap sets the armed field's location; with nothing armed it does nothing.
  const handleMapPick = useCallback(
    (lat: number, lng: number) => {
      if (!pickTarget) {
        return;
      }
      applyPick(pickTarget, lat, lng);
      setPickTarget(null);
    },
    [pickTarget, applyPick],
  );

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

  const routeResult = routeState.kind === "ready" ? routeState.result : null;
  const routeStart = routeResult ? routeResult.start.point : null;
  // The destination marker appears the moment a destination exists; the line follows live once both
  // endpoints resolve and the search lands.
  const routeDest = dest ? { lat: dest.lat, lng: dest.lng } : null;

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      <MapView
        pins={pins}
        draft={draft}
        target={target}
        userLocation={userLocation}
        following={following}
        treeCover={treeCover}
        routeResult={routeResult}
        routeDest={routeDest}
        routeStart={routeStart}
        picking={pickTarget !== null}
        onMapPick={handleMapPick}
        onDisengageFollow={handleDisengageFollow}
        onPinSelect={handlePinSelect}
      />
      <Toolbar
        auth={auth}
        pinCount={pins.length}
        treeCover={treeCover}
        routing={routingOpen}
        refreshingClaims={refreshing}
        onToggleTreeCover={handleToggleTreeCover}
        onToggleRouting={handleToggleRouting}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
        onRefreshClaims={handleRefreshClaims}
      />
      <FollowToggle active={following} onToggle={handleToggleFollow} />
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
      {isAdmin && !editing && !routingOpen ? (
        <LogHereButton
          onClick={handleLogHere}
          disabled={userLocation === null}
          busy={logging}
          hint={locationHint}
        />
      ) : null}
      {routingOpen ? (
        <RoutePanel
          startLabel={
            manualStart
              ? manualStart.label
              : userLocation
                ? "My location"
                : null
          }
          destLabel={dest?.label ?? null}
          startSet={manualStart !== null}
          destSet={dest !== null}
          needsStart={(manualStart ?? userLocation) === null}
          hasLiveLocation={userLocation !== null}
          pickTarget={pickTarget}
          status={routeState.kind}
          errorMessage={routeState.kind === "error" ? routeState.message : null}
          summary={
            routeState.kind === "ready"
              ? {
                  lengthMeters: routeState.result.lengthMeters,
                  walkSeconds: routeState.result.walkSeconds,
                  coverFraction: routeState.result.coverFraction,
                }
              : null
          }
          treeWeight={treeWeight}
          onTreeWeight={handleTreeWeight}
          onStartSelect={handleStartSelect}
          onDestSelect={handleDestSelect}
          onStartClear={handleClearStart}
          onDestClear={handleClearDest}
          onUseCurrentLocation={handleClearStart}
          onArmStart={handleArmStart}
          onArmDest={handleArmDest}
          onClose={handleToggleRouting}
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
