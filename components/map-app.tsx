"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  isOverlayId,
  OVERLAYS,
  type OverlayId,
} from "../src/overlays/registry";
import type { Pin, PinDraft } from "../src/pin";
import { getResolvedDate, subscribeRouteTime } from "../src/route-time/store";
import {
  DEFAULT_ART_WEIGHT,
  DEFAULT_FERRY_WEIGHT,
  DEFAULT_HIGHWAY_WEIGHT,
  DEFAULT_LANDMARK_WEIGHT,
  DEFAULT_SHADE_WEIGHT,
  DEFAULT_TREE_WEIGHT,
  MAX_FERRY_WEIGHT,
  MAX_SHADE_WEIGHT,
  MAX_TREE_WEIGHT,
  type RouteWeights,
} from "../src/routing/cost";
import { buildDirections } from "../src/routing/directions";
import { loadGraph, type RoutingGraph } from "../src/routing/graph";
import { navProgress } from "../src/routing/nav-progress";
import { loadPois, type PoiSet, passedPois } from "../src/routing/pois";
import { RouteCache } from "../src/routing/route-cache";
import {
  type RouteResult,
  RouteSolver,
  reverseResult,
} from "../src/routing/search";
import { computeEdgeShade } from "../src/routing/shade";
import { buildSnapIndex, type SnapIndex, snapPair } from "../src/routing/snap";
import AboutDialog from "./about-dialog";
import FollowToggle from "./follow-toggle";
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
const FERRY_WEIGHT_KEY = "scenic-route:ferry-weight";
const SHADE_WEIGHT_KEY = "scenic-route:shade-weight";
const FERRY_ALLOW_KEY = "scenic-route:allow-ferries";
const LANDMARK_WEIGHT_KEY = "scenic-route:landmark-weight";
const ART_WEIGHT_KEY = "scenic-route:art-weight";
const HIGHWAY_WEIGHT_KEY = "scenic-route:highway-weight";
const OVERLAY_KEY = "scenic-route:overlay";
const RESNAP_METERS = 25; // a followed location must drift this far before the route recomputes
// How close to the route a POI must be to count as passed.
const LANDMARK_PASS_METERS = 40;
const ART_PASS_METERS = 40;

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
  // The overlays drawn over the basemap, a freely-combinable set (tree genus is the one exception —
  // it goes solo). The canopy cover is the only content a signed-out visitor has, so it starts on.
  // Hydrated from localStorage below; an empty set hides every overlay.
  const [activeOverlays, setActiveOverlays] = useState<ReadonlySet<OverlayId>>(
    () => new Set<OverlayId>(["canopy"]),
  );
  const [signingIn, setSigningIn] = useState<boolean>(false);
  const [aboutOpen, setAboutOpen] = useState<boolean>(false);
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
  // Ferry preference and gate, driven by the route panel's slider and toggle. Both restore from
  // localStorage below so a reload keeps the setting.
  const [ferryWeight, setFerryWeight] = useState<number>(DEFAULT_FERRY_WEIGHT);
  const [allowFerries, setAllowFerries] = useState<boolean>(true);
  // The other scenic factors: landmark and public-art discounts and the highway/rail penalty. Held
  // here at their defaults (their sliders land in a later pass), restored from localStorage below.
  const [landmarkWeight, setLandmarkWeight] = useState<number>(
    DEFAULT_LANDMARK_WEIGHT,
  );
  const [artWeight, setArtWeight] = useState<number>(DEFAULT_ART_WEIGHT);
  const [highwayWeight, setHighwayWeight] = useState<number>(
    DEFAULT_HIGHWAY_WEIGHT,
  );
  // The signed sun/shade preference (−1 = prefer shade, +1 = prefer sun, 0 = off). `shadeTick` fires
  // as the resolved time (the global clock) moves, so the route re-costs against the sun's new
  // position; `shadeContextRef` records which tick the route cache was built against.
  const [shadeWeight, setShadeWeight] = useState<number>(DEFAULT_SHADE_WEIGHT);
  const [shadeTick, setShadeTick] = useState<number>(0);
  const shadeContextRef = useRef<number>(-1);
  // The decoded graph, kept so directions can be rebuilt from a route without a re-fetch.
  const [routingGraph, setRoutingGraph] = useState<RoutingGraph | null>(null);
  // The landmark and public-art points, loaded once directions are in use, so the turn-by-turn can
  // name the ones the route passes.
  const [poiSets, setPoiSets] = useState<{
    landmarks: PoiSet;
    art: PoiSet;
  } | null>(null);
  // The maneuver list toggles open below the summary; it collapses whenever the destination changes.
  const [directionsOpen, setDirectionsOpen] = useState<boolean>(false);
  // The panel can shrink to a slim peek bar so the map stays usable while navigating.
  const [panelMinimized, setPanelMinimized] = useState<boolean>(false);
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
  // True while an endpoint marker is mid-drag, so the live recompute holds the drawn route instead of
  // flashing a loading state on every frame.
  const draggingRef = useRef<boolean>(false);
  const dragWhichRef = useRef<"start" | "dest">("dest"); // which endpoint the active drag moves
  // The per-gesture incremental solver, rooted at the held endpoint and reused across a drag's frames.
  const dragSolverRef = useRef<RouteSolver | null>(null);
  // Reactive mirror of draggingRef, so the map's reframe can switch to zoom-out-only during a drag.
  const [dragging, setDragging] = useState<boolean>(false);
  // Bumped on drop to re-run the route effect for the exact recompute, since a start drop leaves the
  // resolved endpoints unchanged and nothing else would re-trigger it.
  const [routeRefreshNonce, setRouteRefreshNonce] = useState<number>(0);
  // Mirrors routeState.kind === "ready", so a recompute can still apply an unchanged cache result when
  // nothing is drawn yet (else the loading state would strand); kept in sync by the effect below.
  const hasReadyRouteRef = useRef<boolean>(false);
  // The nonce the route effect last acted on, so a recompute can tell a drop (nonce bumped, lands
  // silently) from a fresh target (a new destination or start, which flashes the loading spinner).
  const lastAppliedNonceRef = useRef<number>(0);

  // Defaults to destination-pick when the routing panel is open with no destination; arming a field
  // from the panel overrides which end the next tap sets.
  const effectivePickTarget: "start" | "dest" | null =
    pickTarget ?? (routingOpen && dest === null ? "dest" : null);

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
    const storedWeight = window.localStorage.getItem(FERRY_WEIGHT_KEY);
    if (storedWeight !== null) {
      const parsed = Number.parseFloat(storedWeight);
      if (Number.isFinite(parsed)) {
        setFerryWeight(Math.min(MAX_FERRY_WEIGHT, Math.max(0, parsed)));
      }
    }
    const storedAllow = window.localStorage.getItem(FERRY_ALLOW_KEY);
    if (storedAllow !== null) {
      setAllowFerries(storedAllow === "true");
    }
  }, []);

  useEffect(() => {
    for (const [key, apply] of [
      [LANDMARK_WEIGHT_KEY, setLandmarkWeight],
      [ART_WEIGHT_KEY, setArtWeight],
      [HIGHWAY_WEIGHT_KEY, setHighwayWeight],
    ] as const) {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) {
        const parsed = Number.parseFloat(stored);
        if (Number.isFinite(parsed)) {
          apply(Math.min(1, Math.max(0, parsed)));
        }
      }
    }
  }, []);

  // The signed shade preference restores separately (its range is −1..1, not 0..1).
  useEffect(() => {
    const stored = window.localStorage.getItem(SHADE_WEIGHT_KEY);
    if (stored !== null) {
      const parsed = Number.parseFloat(stored);
      if (Number.isFinite(parsed)) {
        setShadeWeight(
          Math.min(MAX_SHADE_WEIGHT, Math.max(-MAX_SHADE_WEIGHT, parsed)),
        );
      }
    }
  }, []);

  // While a shade preference is active, follow the global clock: each tick re-costs the route against
  // the sun's new position. The store only ticks in "now" mode or on a scrub, and only with a listener.
  useEffect(() => {
    if (shadeWeight === 0) {
      return;
    }
    return subscribeRouteTime(() => setShadeTick((tick) => tick + 1));
  }, [shadeWeight]);

  // Restore the persisted overlays from the comma-separated id list; unknown ids (a stale "trees"
  // from before the canopy switch) are dropped. A missing value leaves the canopy default; an empty
  // string is a deliberate "all off".
  useEffect(() => {
    const stored = window.localStorage.getItem(OVERLAY_KEY);
    if (stored !== null) {
      setActiveOverlays(new Set(stored.split(",").filter(isOverlayId)));
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

  const locationHint =
    locationError === "denied"
      ? "Location access is blocked — enable it in your browser settings."
      : locationError === "unavailable"
        ? "Couldn't get your location. Make sure location services are on."
        : null;

  // Mirror any location error into the dismissible banner so every visitor sees it, not just admins.
  useEffect(() => {
    if (locationHint) {
      setBanner(locationHint);
    }
  }, [locationHint]);

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

  // Toggle one overlay. Tree genus is exclusive: turning it on clears the rest, and turning on any
  // normal layer clears it — so the dense per-genus recolouring never fights the other overlays.
  const handleToggleOverlay = useCallback((id: OverlayId) => {
    setActiveOverlays((current) => {
      const next = new Set(current);
      const isExclusive = (candidate: OverlayId): boolean =>
        OVERLAYS.find((overlay) => overlay.id === candidate)?.exclusive ??
        false;
      if (next.has(id)) {
        next.delete(id);
      } else if (isExclusive(id)) {
        next.clear();
        next.add(id);
      } else {
        next.add(id);
        for (const other of next) {
          if (isExclusive(other)) {
            next.delete(other);
          }
        }
      }
      window.localStorage.setItem(OVERLAY_KEY, [...next].join(","));
      return next;
    });
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

  useEffect(() => {
    hasReadyRouteRef.current = routeState.kind === "ready";
  }, [routeState]);

  // Live recompute: whenever a resolvable start and a destination both exist, (re)find the route,
  // keyed on the endpoints and the tree weight and rAF-coalesced so a slider drag computes at most
  // once per frame. The loading flash shows for a fresh endpoint pair unless the recompute came from
  // an endpoint drop (which holds the drawn route until the exact one lands); a slider move re-costs in
  // place. Writes only routeState/routedForRef (neither a dep).
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
      // A drop bumps routeRefreshNonce; that recompute lands silently so the drawn route holds until
      // the exact one is ready. Any other trigger (a new destination or start) shows the spinner.
      const isDropRefresh = routeRefreshNonce !== lastAppliedNonceRef.current;
      lastAppliedNonceRef.current = routeRefreshNonce;
      if (isNewTarget && !draggingRef.current && !isDropRefresh) {
        setRouteState({ kind: "loading" });
      }
      loadRouting().then(
        async ({ graph, index }) => {
          if (cancelled) {
            return;
          }
          setRoutingGraph((current) => current ?? graph);
          routedForRef.current = request;
          // Keep the shade routing context current. loadRouting hands back one stable graph, so the
          // per-edge attrs are recomputed only when the sun position (a clock tick) moves — a start/dest
          // change alone reuses the attrs already on it. A tick drops both the weight-bracket cache and
          // any in-flight drag solver they were built against. A missing or mismatched SHDE artifact is
          // not fatal: routing drops the sun/shade bias for this time rather than failing. When shade is
          // off, clear the field and the context so it costs nothing.
          if (shadeWeight !== 0) {
            if (shadeContextRef.current !== shadeTick) {
              routeCacheRef.current = null;
              dragSolverRef.current = null;
              shadeContextRef.current = shadeTick;
              try {
                await computeEdgeShade(graph, getResolvedDate());
              } catch {
                graph.edgeShadeNow = null;
                graph.maxAbsShadeNow = 0;
              }
              if (cancelled) {
                return;
              }
            }
          } else {
            graph.edgeShadeNow = null;
            graph.maxAbsShadeNow = 0;
            shadeContextRef.current = -1;
          }
          const pair = snapPair(graph, index, request.start, request.dest);
          const weights: RouteWeights = {
            tree: treeWeight,
            ferry: ferryWeight,
            landmark: landmarkWeight,
            art: artWeight,
            highway: highwayWeight,
            shade: shadeWeight,
            allowFerries,
          };
          if (!pair.ok) {
            setRouteState({ kind: "error", message: messageFor(pair.reason) });
          } else if (draggingRef.current) {
            // Mid-drag: reuse a per-gesture solver rooted at the held endpoint for an approximate
            // route each frame; the drop recomputes exactly. Start-drags solve from the dest and flip.
            const which = dragWhichRef.current;
            const solver = (dragSolverRef.current ??= new RouteSolver(
              graph,
              which === "dest" ? pair.start : pair.dest,
              weights,
            ));
            const moving = which === "dest" ? pair.dest : pair.start;
            const solved = solver.solveApprox(moving);
            const result =
              which === "start" && solved ? reverseResult(solved) : solved;
            if (result) {
              setRouteState({ kind: "ready", result });
            } else {
              setRouteState({
                kind: "error",
                message: messageFor("disconnected"),
              });
            }
          } else {
            const cache = (routeCacheRef.current ??= new RouteCache());
            const { result, changed } = cache.route(
              graph,
              pair.start,
              pair.dest,
              weights,
            );
            // Identical to the drawn route (a slider move that didn't cross a breakpoint): leave it —
            // but always apply when nothing is drawn yet, or an unchanged result would strand the
            // loading state. A drop resets the cache first, so its exact route reads as changed anyway.
            if (changed || !hasReadyRouteRef.current) {
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
  }, [
    resolvedStart,
    dest,
    treeWeight,
    ferryWeight,
    landmarkWeight,
    artWeight,
    highwayWeight,
    shadeWeight,
    shadeTick,
    allowFerries,
    routeRefreshNonce,
  ]);

  // A new destination collapses any open maneuver list; keyed on the coordinates so a reverse-geocode
  // label patch (same point, new object identity) doesn't snap it shut.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the destination point, not the object identity
  useEffect(() => {
    setDirectionsOpen(false);
  }, [dest?.lat, dest?.lng]);

  const handleToggleDirections = useCallback(() => {
    setDirectionsOpen((open) => !open);
  }, []);

  const handleToggleMinimize = useCallback(() => {
    setPanelMinimized((on) => !on);
  }, []);

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

  const handleFerryWeight = useCallback((weight: number) => {
    setFerryWeight(weight);
    window.localStorage.setItem(FERRY_WEIGHT_KEY, String(weight));
  }, []);

  const handleAllowFerries = useCallback((allow: boolean) => {
    setAllowFerries(allow);
    window.localStorage.setItem(FERRY_ALLOW_KEY, String(allow));
  }, []);

  const handleLandmarkWeight = useCallback((weight: number) => {
    setLandmarkWeight(weight);
    window.localStorage.setItem(LANDMARK_WEIGHT_KEY, String(weight));
  }, []);

  const handleArtWeight = useCallback((weight: number) => {
    setArtWeight(weight);
    window.localStorage.setItem(ART_WEIGHT_KEY, String(weight));
  }, []);

  const handleHighwayWeight = useCallback((weight: number) => {
    setHighwayWeight(weight);
    window.localStorage.setItem(HIGHWAY_WEIGHT_KEY, String(weight));
  }, []);

  const handleShadeWeight = useCallback((weight: number) => {
    setShadeWeight(weight);
    window.localStorage.setItem(SHADE_WEIGHT_KEY, String(weight));
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

  // Each frame of an endpoint drag: move that end's coordinate so the route recomputes live, keeping
  // the prior label (a reverse geocode would spam the network) until the drag settles.
  const handleEndpointDragMove = useCallback(
    (which: "start" | "dest", lat: number, lng: number) => {
      draggingRef.current = true;
      dragWhichRef.current = which;
      setDragging(true);
      handleDisengageFollow();
      if (which === "start") {
        setManualStart((previous) => ({
          lat,
          lng,
          label: previous?.label ?? null,
        }));
      } else {
        setDest((previous) => ({ lat, lng, label: previous?.label ?? null }));
      }
    },
    [handleDisengageFollow],
  );

  // Drop of a dragged endpoint: settle that end, discard the approximate solver, and reverse-geocode
  // its label. The drag bypassed the route cache, so reset it (its stale baseline would otherwise read
  // the exact drop route as unchanged) and bump the nonce to re-run the exact recompute.
  const handleEndpointDrag = useCallback(
    (which: "start" | "dest", lat: number, lng: number) => {
      draggingRef.current = false;
      dragSolverRef.current = null;
      setDragging(false);
      handleDisengageFollow();
      applyPick(which, lat, lng);
      routeCacheRef.current = new RouteCache();
      setRouteRefreshNonce((nonce) => nonce + 1);
    },
    [applyPick, handleDisengageFollow],
  );

  // A map tap sets the effective pick target's location; with nothing armed and a destination already
  // set, it does nothing.
  const handleMapPick = useCallback(
    (lat: number, lng: number) => {
      if (!effectivePickTarget) {
        return;
      }
      applyPick(effectivePickTarget, lat, lng);
      setPickTarget(null);
    },
    [effectivePickTarget, applyPick],
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

  const draft = editing?.mode === "create" ? editing.draft : null;

  // Load the landmark and art points once the routing panel is in use, so directions can name the
  // POIs the route passes. A failed load just omits the names — they are a nice-to-have.
  useEffect(() => {
    if (!routingOpen || poiSets) {
      return;
    }
    let cancelled = false;
    Promise.all([
      loadPois("landmarks/nyc.bin", "LMRK"),
      loadPois("art/nyc.bin", "ARTW"),
    ]).then(
      ([landmarks, art]) => {
        if (!cancelled) {
          setPoiSets({ landmarks, art });
        }
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [routingOpen, poiSets]);

  const routeResult = routeState.kind === "ready" ? routeState.result : null;
  const directions = useMemo(() => {
    if (!routingGraph || !routeResult) {
      return null;
    }
    const passed = poiSets
      ? passedPois(routingGraph, routeResult, [
          {
            kind: "landmark",
            set: poiSets.landmarks,
            thresholdMeters: LANDMARK_PASS_METERS,
          },
          { kind: "art", set: poiSets.art, thresholdMeters: ART_PASS_METERS },
        ])
      : [];
    return buildDirections(routingGraph, routeResult, {
      collapseLinearCrossings: true,
      passed,
    });
  }, [routingGraph, routeResult, poiSets]);
  // Live progress along the ready route from the current fix; null when off-route or unlocated, which
  // makes the panel fall back to the route summary. Recomputes as watchPosition updates userLocation.
  const progress = useMemo(
    () =>
      routeResult && directions && userLocation
        ? navProgress(routeResult, directions, userLocation)
        : null,
    [routeResult, directions, userLocation],
  );
  // Start marker position: the snapped route start, else the manual start, else — while the routing
  // panel is open — the live location, so the start sits pre-dropped and draggable atop the location
  // dot before any destination is picked (drag it to set a manual start; it tracks the fix until then).
  // WHILE the start is being dragged it must follow the cursor (manualStart), not the snapped route
  // point — writing the snapped point back onto the marker mid-drag fights Leaflet's drag and strands it.
  const draggingStart = dragging && dragWhichRef.current === "start";
  const routeStart =
    !draggingStart && routeResult
      ? routeResult.start.point
      : manualStart
        ? { lat: manualStart.lat, lng: manualStart.lng }
        : routingOpen && userLocation
          ? { lat: userLocation.lat, lng: userLocation.lng }
          : null;
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
        activeOverlays={activeOverlays}
        routeResult={routeResult}
        routeDest={routeDest}
        routeStart={routeStart}
        picking={effectivePickTarget !== null}
        onMapPick={handleMapPick}
        dragging={dragging}
        onDisengageFollow={handleDisengageFollow}
        onEndpointDragMove={handleEndpointDragMove}
        onEndpointDrag={handleEndpointDrag}
        onPinSelect={handlePinSelect}
      />
      <Toolbar
        auth={auth}
        pinCount={pins.length}
        activeOverlays={activeOverlays}
        routing={routingOpen}
        refreshingClaims={refreshing}
        onToggleOverlay={handleToggleOverlay}
        onToggleRouting={handleToggleRouting}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
        onRefreshClaims={handleRefreshClaims}
        onAbout={() => setAboutOpen(true)}
        onLogHere={handleLogHere}
        logHereDisabled={userLocation === null}
        logHereBusy={logging}
        logHereHint={locationHint}
      />
      <FollowToggle active={following} onToggle={handleToggleFollow} />
      {/* the active overlays' floating keys (genus only today); bottom-left keeps them clear of the
          toolbar, follow toggle, attribution, and the centered route panel */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-[1000] max-w-[70vw]">
        <div className="pointer-events-auto space-y-2">
          {OVERLAYS.filter((overlay) => activeOverlays.has(overlay.id)).map(
            (overlay) =>
              overlay.legend ? (
                <div key={overlay.id}>{overlay.legend}</div>
              ) : null,
          )}
        </div>
      </div>
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
          pickTarget={effectivePickTarget}
          status={routeState.kind}
          errorMessage={routeState.kind === "error" ? routeState.message : null}
          summary={
            routeState.kind === "ready"
              ? {
                  walkMeters: routeState.result.walkMeters,
                  travelSeconds: routeState.result.travelSeconds,
                  coverFraction: routeState.result.coverFraction,
                }
              : null
          }
          treeWeight={treeWeight}
          ferryWeight={ferryWeight}
          allowFerries={allowFerries}
          landmarkWeight={landmarkWeight}
          artWeight={artWeight}
          highwayWeight={highwayWeight}
          shadeWeight={shadeWeight}
          directions={directions}
          progress={progress}
          directionsOpen={directionsOpen}
          minimized={panelMinimized}
          onTreeWeight={handleTreeWeight}
          onFerryWeight={handleFerryWeight}
          onAllowFerries={handleAllowFerries}
          onLandmarkWeight={handleLandmarkWeight}
          onArtWeight={handleArtWeight}
          onHighwayWeight={handleHighwayWeight}
          onShadeWeight={handleShadeWeight}
          onStartSelect={handleStartSelect}
          onDestSelect={handleDestSelect}
          onStartClear={handleClearStart}
          onDestClear={handleClearDest}
          onUseCurrentLocation={handleClearStart}
          onArmStart={handleArmStart}
          onArmDest={handleArmDest}
          onToggleDirections={handleToggleDirections}
          onToggleMinimize={handleToggleMinimize}
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
      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
    </main>
  );
}
