"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiX } from "react-icons/fi";
import {
  activeCity,
  CITY_ZOOM,
  type City,
  type CityBounds,
  citiesInView,
  cityById,
  cityInSentence,
  containsPoint,
  DEFAULT_CITY,
  nearestCity,
  setActiveCity,
} from "../src/cities";
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
import {
  type GeocodeResult,
  resolveSharedQuery,
  reverseGeocode,
  searchAddress,
} from "../src/geocode";
import {
  applyExclusivity,
  isOverlayId,
  OVERLAYS,
  type OverlayId,
} from "../src/overlays/registry";
import type { Pin, PinDraft } from "../src/pin";
import {
  getPinnedTime,
  getResolvedDate,
  setCustomDay,
  setCustomHour,
  subscribeRouteTime,
} from "../src/route-time/store";
import {
  DEFAULT_ART_WEIGHT,
  DEFAULT_COMMERCIAL_WEIGHT,
  DEFAULT_FERRY_WEIGHT,
  DEFAULT_HIGHWAY_WEIGHT,
  DEFAULT_HILL_WEIGHT,
  DEFAULT_HISTORIC_WEIGHT,
  DEFAULT_INDUSTRIAL_WEIGHT,
  DEFAULT_LANDMARK_WEIGHT,
  DEFAULT_SHADE_WEIGHT,
  DEFAULT_SHELTER_WEIGHT,
  DEFAULT_TREE_WEIGHT,
  MAX_FERRY_WEIGHT,
  MAX_HILL_WEIGHT,
  MAX_INDUSTRIAL_WEIGHT,
  MAX_SHADE_WEIGHT,
  MAX_SHELTER_WEIGHT,
  MAX_TREE_WEIGHT,
  type RouteWeights,
} from "../src/routing/cost";
import { buildDirections } from "../src/routing/directions";
import type { FactorKey, GateKey } from "../src/routing/factors";
import { computeFerrySchedule } from "../src/routing/ferry-schedule";
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
import { computeEdgeSheds, setShedSun, shedDay } from "../src/routing/sheds";
import { buildSnapIndex, type SnapIndex, snapPair } from "../src/routing/snap";
import {
  awaitNameIndex,
  prefetchNameIndex,
  releaseNameIndex,
  setSearchCentre,
  warmNameIndex,
} from "../src/search/name-search";
import {
  settings as storedSettings,
  updateSettings,
} from "../src/settings/store";
import {
  startSettingsSync,
  stopSettingsSync,
} from "../src/settings/sync-session";
import { sharedDestinationText, withoutShareParams } from "../src/share-target";
import {
  type Camera,
  decodeDestQuery,
  decodeRoute,
  decodeView,
  encodeRoute,
  encodeView,
  formatHash,
  hashParams,
  type LatLng,
  type RouteUrlState,
  withoutDestQuery,
} from "../src/url-state";
import AboutDialog from "./about-dialog";
import { CityProvider } from "./city-context";
import FollowToggle from "./follow-toggle";
import type { DestPrefill } from "./location-field";
import type { MapTarget, PickMode } from "./map";
import PinEditor from "./pin-editor";
import RoutePanel from "./route-panel";
import SettingsDialog from "./settings-dialog";
import SignInDialog from "./sign-in-dialog";
import Toolbar from "./toolbar";
import UrlSync from "./url-sync";
import { useHashFlag, useHashSection } from "./use-hash-flag";
import { useStandalone } from "./use-install";
import { useSettings } from "./use-settings";

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
  // The graph travels WITH the result. Directions are built by indexing a result's edge numbers into
  // a graph's arrays, so the two have to be the same city's — and they were separate pieces of state,
  // written by separate updates, with nothing to say so. Mid-switch that indexed one city's route
  // into another city's edges. Carrying it here makes the mismatch unrepresentable.
  | { kind: "ready"; result: RouteResult; graph: RoutingGraph }
  | { kind: "error"; message: string };

const OVERLAY_KEY = "scenic-route:overlay";
const RESNAP_METERS = 25; // a followed location must drift this far before the route recomputes
// Street level, where the first fix frames you. Matches what the map's own follow camera zooms to.
const LOCATED_ZOOM = 16;
// How close to the route a POI must be to count as passed.
const LANDMARK_PASS_METERS = 40;
const ART_PASS_METERS = 40;

// A city's graph and snap index are fetched and built once, on first Directions use, and shared by
// every recompute and the route layer's geometry lookups. Keyed by city so switching and coming back
// does not rebuild an index over 600k edges.
const routingPromises = new Map<
  string,
  Promise<{ graph: RoutingGraph; index: SnapIndex }>
>();
function loadRouting(
  cityId: string,
): Promise<{ graph: RoutingGraph; index: SnapIndex }> {
  const pending = routingPromises.get(cityId);
  if (pending) {
    return pending;
  }
  const request = loadGraph(cityId)
    .then((graph) => ({ graph, index: buildSnapIndex(graph) }))
    .catch((error: unknown) => {
      routingPromises.delete(cityId); // a failed load must not be memoized
      throw error;
    });
  routingPromises.set(cityId, request);
  return request;
}

// The weights the settings document holds, each falling back to its default. These are what a URL key
// overrides and what a missing one leaves in place.
function storedWeights(): RouteWeights {
  const { weights, allowFerries, allowSheds, allowCrossings } =
    storedSettings();
  const read = (key: FactorKey, fallback: number, min: number, max: number) => {
    const stored = weights[key];
    return stored === undefined
      ? fallback
      : Math.min(max, Math.max(min, stored));
  };
  return {
    tree: read("tree", DEFAULT_TREE_WEIGHT, 0, MAX_TREE_WEIGHT),
    ferry: read("ferry", DEFAULT_FERRY_WEIGHT, 0, MAX_FERRY_WEIGHT),
    landmark: read("landmark", DEFAULT_LANDMARK_WEIGHT, 0, 1),
    art: read("art", DEFAULT_ART_WEIGHT, 0, 1),
    highway: read("highway", DEFAULT_HIGHWAY_WEIGHT, 0, 1),
    hill: read("hill", DEFAULT_HILL_WEIGHT, 0, MAX_HILL_WEIGHT),
    commercial: read("commercial", DEFAULT_COMMERCIAL_WEIGHT, 0, 1),
    industrial: read(
      "industrial",
      DEFAULT_INDUSTRIAL_WEIGHT,
      0,
      MAX_INDUSTRIAL_WEIGHT,
    ),
    historic: read("historic", DEFAULT_HISTORIC_WEIGHT, 0, 1),
    shade: read(
      "shade",
      DEFAULT_SHADE_WEIGHT,
      -MAX_SHADE_WEIGHT,
      MAX_SHADE_WEIGHT,
    ),
    shelter: read("shelter", DEFAULT_SHELTER_WEIGHT, 0, MAX_SHELTER_WEIGHT),
    allowFerries,
    allowSheds,
    allowCrossings,
  };
}

// The panel's slider and the settings page's move the same value, so both persist through here. A
// weight nobody has moved stays out of the document and keeps its built-in default.
function persistWeight(key: FactorKey, weight: number): void {
  updateSettings({ weights: { ...storedSettings().weights, [key]: weight } });
}

// The persisted overlay ids, or null when nothing was ever stored (which keeps the canopy default).
// An empty stored string is a deliberate "all off".
function storedOverlays(): string[] | null {
  const stored = window.localStorage.getItem(OVERLAY_KEY);
  return stored === null ? null : stored.split(",");
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

// A point outside the city is a different failure from a point inside it with no pavement nearby, and
// saying "300 m from a walkable street" about somewhere the app has never held data for reads as a gap
// in the map rather than as the edge of what is covered.
function messageFor(
  reason: "startTooFar" | "destTooFar" | "disconnected",
  city: City,
  point: LatLng | null,
): string {
  if (reason === "disconnected") {
    return "No walkable connection in the street data — likely separated by water.";
  } else if (point && !containsPoint(city, point)) {
    return `That point is outside ${cityInSentence(city)}, and a route cannot leave it.`;
  } else {
    return "That point is more than 300 m from a walkable street.";
  }
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
  // The one city whose graph, tiles and overlays are live. It follows the map centre, so panning to
  // another city switches to it rather than leaving the previous city's data drawn under a view it
  // does not cover.
  const [city, setCity] = useState<City>(DEFAULT_CITY);
  // The overlays drawn over the basemap, a freely-combinable set (tree genus is the one exception —
  // it goes solo). The canopy cover is the only content a signed-out visitor has, so it starts on.
  // Hydrated from the URL hash or localStorage below; an empty set hides every overlay.
  const [activeOverlays, setActiveOverlays] = useState<ReadonlySet<OverlayId>>(
    () => new Set<OverlayId>(["canopy"]),
  );
  const [signingIn, setSigningIn] = useState<boolean>(false);
  // Bound to the URL hash so About is deep-linkable (#about) and the back button closes it.
  const settings = useSettings();
  const [aboutOpen, setAboutOpen] = useHashFlag("about");
  // Carries WHICH group was asked for, so the layers menu can land the reader on the layers.
  const [settingsSection, setSettingsSection] = useHashSection("settings");
  const settingsOpen = settingsSection !== null;
  const [locationError, setLocationError] = useState<
    "denied" | "unavailable" | null
  >(null);
  // Bumped to ask for location again: the watch below is registered once per value of it. Without a
  // retry a reader who allows location in Settings after refusing it gets nothing until the app is
  // relaunched, and iOS keeps a home-screen app alive for days — which is most of what "Safari finds
  // me but the installed app cannot" is.
  const [locationAttempt, setLocationAttempt] = useState<number>(0);
  const standalone = useStandalone();
  const [banner, setBanner] = useState<string | null>(null);
  // The basemap is the one layer with no menu row to badge, and the one whose absence leaves the map
  // unreadable rather than just emptier — overlays floating on blank ground with no streets to place
  // them against. It gets the banner.
  const handleBasemapLost = useCallback((lost: boolean) => {
    if (lost) {
      setBanner("Map background unavailable — check your connection.");
    }
  }, []);
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
  // A destination carried as words rather than as a point — a `#q=` link, or an Android share. Held
  // until it has been resolved into a place rather than read from the URL where it is wanted, since
  // the URL is stripped the moment it is read and the city it must be resolved against can still
  // change afterwards; cleared once it resolves, and when the reader answers the box themselves.
  const [destQuery, setDestQuery] = useState<string | null>(null);
  // What that query resolved to when it resolved to nothing certain: the words go into the
  // destination box with their candidates under them, and the reader picks.
  const [destPrefill, setDestPrefill] = useState<DestPrefill | null>(null);
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
  const [hillWeight, setHillWeight] = useState<number>(DEFAULT_HILL_WEIGHT);
  const [commercialWeight, setCommercialWeight] = useState<number>(
    DEFAULT_COMMERCIAL_WEIGHT,
  );
  const [industrialWeight, setIndustrialWeight] = useState<number>(
    DEFAULT_INDUSTRIAL_WEIGHT,
  );
  const [historicWeight, setHistoricWeight] = useState<number>(
    DEFAULT_HISTORIC_WEIGHT,
  );
  // The signed sun/shade preference (−1 = prefer shade, +1 = prefer sun, 0 = off). `routeTimeTick` fires
  // as the resolved time (the global clock) moves, so the route re-costs against the sun's new
  // position; `shadeContextRef` records which tick the route cache was built against.
  const [shadeWeight, setShadeWeight] = useState<number>(DEFAULT_SHADE_WEIGHT);
  // Whether the last attempt to build the sun/shade field failed. The graph is fetched once and its
  // own maxima gate the other sliders (`capabilities`); this artifact is refetched every time the
  // clock moves, so it can go missing with the graph perfectly healthy — and then the slider sits
  // there moving nothing, which is what this is for.
  const [shadeDataLost, setShadeDataLost] = useState<boolean>(false);
  const [routeTimeTick, setRouteTimeTick] = useState<number>(0);
  const shadeContextRef = useRef<string>("");
  // Rain shelter (decks plus canopy) and the scaffolding gate. Both read the same per-edge shed
  // coverage, which only changes with the picked DAY — `shedDayRef` records the day the graph's field
  // was built for, so a clock tick re-aims its sun rather than rebuilding it.
  const [shelterWeight, setShelterWeight] = useState<number>(
    DEFAULT_SHELTER_WEIGHT,
  );
  const [allowSheds, setAllowSheds] = useState<boolean>(true);
  const [allowCrossings, setAllowCrossings] = useState<boolean>(false);
  const shedDayRef = useRef<string>("");
  // Which (city, clock tick) the graph's ferry timetable was resolved for. The DAY picks the services
  // that run, but the sailing you catch moves with the clock inside that day, so this rebuilds on
  // every tick rather than only when the date changes.
  const ferryContextRef = useRef<string>("");
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
  // The drawn route's trip seconds, kept in sync below. A start-drag solves backward from the dest, so
  // it anchors the sun at this arrival time; null (nothing drawn yet) falls back to the departure sun.
  const lastTravelSecondsRef = useRef<number | null>(null);
  // The nonce the route effect last acted on, so a recompute can tell a drop (nonce bumped, lands
  // silently) from a fresh target (a new destination or start, which flashes the loading spinner).
  const lastAppliedNonceRef = useRef<number>(0);
  // The URL hash at load has been applied, so the live hash writer may start. Mirrored into a ref for
  // the camera callback, which is held by a long-lived map listener and must keep its identity.
  const [hashApplied, setHashApplied] = useState<boolean>(false);
  const hashAppliedRef = useRef<boolean>(false);
  // Whether the link itself named a city. A stored city does not count: it is where the visitor was
  // last time, and their live position is the better answer to "which city am I in".
  const linkedCityRef = useRef<boolean>(false);
  // The city the endpoints on screen were picked in, so a switch can tell a route it has outlived
  // from one that arrived with the city. Null while there are no endpoints.
  const endpointCityRef = useRef<string | null>(null);
  // Whether the first location fix has been tested against the covered cities; only that one decides.
  const coverageChecked = useRef<boolean>(false);
  // A shared link's camera, applied once by the map, and the destination it was framed around; null
  // leaves the map where it is and lets a fresh route frame itself.
  const [initialCamera, setInitialCamera] = useState<Camera | null>(null);
  const [preframedDest, setPreframedDest] = useState<LatLng | null>(null);
  // The live camera, tracked for the share link without re-rendering on every pan.
  const cameraRef = useRef<Camera | null>(null);

  // Defaults to destination-pick when the routing panel is open with no destination; arming a field
  // from the panel overrides which end the next tap sets.
  const effectivePickTarget: "start" | "dest" | null =
    pickTarget ?? (routingOpen && dest === null ? "dest" : null);
  // Only a field armed from the panel commits on the tap itself; the default is deferred, so opening
  // the panel never costs the user a double-tap zoom.
  const pickMode: PickMode =
    pickTarget !== null
      ? "immediate"
      : effectivePickTarget !== null
        ? "deferred"
        : "off";

  // While anything the route reads moves with the clock, follow it: each tick re-costs the route
  // against the sun's new position and against the sailing a ferry terminal is next offering, and a
  // tick that lands on a new day also restands the scaffolding. The store only ticks in "now" mode or
  // on a scrub, and only with a listener.
  //
  // Ferries are on by default, so this normally subscribes from the outset — which is the point: an
  // ETA built on "the 6:20 boat" has to stop saying so once 6:20 has gone.
  useEffect(() => {
    if (
      shadeWeight === 0 &&
      shelterWeight === 0 &&
      allowSheds &&
      !allowFerries
    ) {
      return;
    }
    return subscribeRouteTime(() => setRouteTimeTick((tick) => tick + 1));
  }, [shadeWeight, shelterWeight, allowSheds, allowFerries]);

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

  // Settings follow the reader between their devices for as long as they are signed in. Keyed on the
  // uid alone, not on the auth object, which is replaced on every token refresh and would otherwise
  // tear the subscription down and build it up again each time.
  const syncingUid = auth.kind === "signedIn" ? auth.info.user.uid : null;
  useEffect(() => {
    if (syncingUid === null) {
      stopSettingsSync();
      return undefined;
    } else {
      startSettingsSync(syncingUid);
      return stopSettingsSync;
    }
  }, [syncingUid]);

  // The installed app is its own permission container: iOS copies cookies from Safari at install
  // time and nothing else, so a site allowed in Safari is a fresh ask here and browser settings do
  // not govern it. Sending an installed reader to the wrong Settings screen is worse than saying
  // nothing, and the app's own Location entry only exists once a request has run — which the retry
  // below is what re-runs.
  const locationHint =
    locationError === "denied"
      ? standalone
        ? "Location is blocked for this app — allow it in iOS Settings › Privacy & Security › Location Services › Scenic Route, then tap the location button. If Scenic Route is not listed, remove it from the Home Screen and add it again."
        : "Location access is blocked — enable it in your browser settings."
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the attempt count is not read here, it is what re-issues the watch
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
        // The first fix is what opens the app on the city you are standing in. Nothing else can do
        // it: the URL named no city, the stored one is only where you were last time, and the camera
        // cannot pick a city it was never pointed at. A visitor outside every city gets the nearest
        // one and a banner saying so, since centring on ground the app has no data for is a blank
        // basemap that reads as a broken page.
        //
        // Only the FIRST fix decides, and only when the link named no city of its own — a link that
        // names one is a request to look there, which the visitor's own position does not override.
        if (!coverageChecked.current) {
          coverageChecked.current = true;
          const nearest = nearestCity({ lat, lng });
          if (!containsPoint(nearest, { lat, lng })) {
            setFollowing(false);
            setCity(nearest);
            setTarget({ ...nearest.center, zoom: CITY_ZOOM });
          } else if (!linkedCityRef.current) {
            // The camera moves with the city, not after it: the map is still framed wherever it
            // opened, and the camera reports what it can see, so leaving it there let it report the
            // old city back and undo this the moment it settled.
            //
            // This target and the link's own initial camera can never both be set — a link with a
            // camera has a city, and a city here means `linkedCityRef` and no adoption. Keep it that
            // way: were both live in one commit, which of them framed the map would come down to
            // which component React happened to run first.
            setCity(nearest);
            setTarget({ lat, lng, zoom: LOCATED_ZOOM });
          }
        }
      },
      (error) => {
        setLocationError(
          error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
        );
      },
      { enableHighAccuracy: false, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [locationAttempt]);

  // The live fix, but only while the active city could do anything with it. Routing stays within one
  // city, so a fix outside the one on screen is not a start, is not somewhere to centre, and is not a
  // "My location" the panel can offer. Everything that reads the fix as an input to this city reads
  // this instead, so the panel, the camera and the search cannot disagree about whether it counts.
  const routableLocation =
    userLocation && containsPoint(city, userLocation) ? userLocation : null;

  // A visitor in New York opening San Francisco would otherwise have the first fix drag the camera
  // back across the country — and since the camera is what picks the city, that drag flipped the city
  // out from under the link, mid-route. Derived rather than an effect that clears `following`, because
  // the map's own follow effect runs on the same render as the fix that triggers it and would have
  // started the flight before any effect of this component could fire.
  const followLive =
    following && (userLocation === null || routableLocation !== null);

  // A route belongs to the city it was found in, so leaving that city ends it: its endpoints are
  // points the new city's graph cannot reach, and keeping them only turns the panel into an error
  // about a destination nobody is still asking for. The panel stays open, asking for a new one.
  //
  // Stated once here rather than called from each of the four places that change city, because those
  // callers cannot tell a switch apart from the city simply arriving: the link's own city lands in
  // the same commit as the endpoints it carried, and a camera that reports twice inside one tick
  // reports a stale city first. As a rule about what may coexist, both are answered by construction —
  // the endpoints record which city they were picked in, and only a change away from THAT clears
  // them. Ordered before the search effect so it never runs a pass on endpoints from another city.
  useEffect(() => {
    if (!dest && !manualStart) {
      endpointCityRef.current = null;
      return;
    }
    if (endpointCityRef.current === null) {
      endpointCityRef.current = city.id;
    } else if (endpointCityRef.current !== city.id) {
      endpointCityRef.current = null;
      setDest(null);
      setManualStart(null);
      setPickTarget(null);
      setRouteState({ kind: "idle" });
      routedForRef.current = null;
      routeCacheRef.current = null;
      dragSolverRef.current = null;
    }
  }, [city, dest, manualStart]);

  // Asking again, from a control the reader pressed — which is both what picks up a permission they
  // have just granted in Settings and, on iOS, the gesture WebKit would rather see a prompt come
  // from. Clearing the error first is what lets a second refusal re-raise a banner already dismissed.
  const retryLocation = useCallback(() => {
    if (userLocation === null) {
      setLocationError(null);
      setLocationAttempt((attempt) => attempt + 1);
    }
  }, [userLocation]);

  // The toggle reads and writes the derived state, so pressing it always does what the button says.
  // Engaging it from a city you are not in means "take me to me", which moves the active city with
  // the camera rather than lighting a control that centres nothing.
  const handleToggleFollow = useCallback(() => {
    if (followLive) {
      setFollowing(false);
    } else {
      setFollowing(true);
      if (userLocation === null) {
        retryLocation();
      } else if (!routableLocation) {
        setCity(nearestCity(userLocation));
      }
    }
  }, [followLive, userLocation, routableLocation, retryLocation]);

  // Picking a city frames it and stops following, since the visitor has just said they want to look
  // somewhere other than where they are.
  const handleSelectCity = useCallback((picked: City) => {
    setFollowing(false);
    setCity(picked);
    setTarget({ ...picked.center, zoom: CITY_ZOOM });
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

  // Assigned during render, not in an effect: the layers below read it while their own effects run,
  // which is before any effect of this component would have fired. Idempotent, so a repeated render
  // cannot leave it wrong.
  setActiveCity(city);

  // Switching city swaps the whole layer set, so anything the new city does not offer goes off rather
  // than staying lit with no data behind it, and the landmark and art points are dropped so the new
  // city's are fetched instead of the old city's names surviving the move.
  useEffect(() => {
    setActiveOverlays((current) => {
      const kept = new Set(
        [...current].filter((id) => city.overlays.includes(id)),
      );
      return kept.size === current.size ? current : kept;
    });
    setPoiSets(null);
    // The graph says which controls this city can answer, so holding the old one leaves sliders lit
    // for data the new city does not have — the hill slider stayed enabled in New York after San
    // Francisco. Null is the honest answer until this city's own graph lands.
    setRoutingGraph(null);
    // The two files the search box answers from with no signal — every name in the city, and the
    // house numbers its worker resolves them against — pulled onto the device now rather than when
    // someone types at it, because a file only fetched once you have already searched offline is a
    // file you never have when you need it. Ten megabytes against the graph's thirty-nine, and on
    // an idle callback so they queue behind the first paint. Reading them into the index is a
    // separate, later decision (below) — this only puts them within reach.
    const prefetch = () => {
      void prefetchNameIndex(city.id);
    };
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(prefetch, { timeout: 5000 });
      return () => cancelIdleCallback(handle);
    } else {
      const handle = window.setTimeout(prefetch, 2000);
      return () => window.clearTimeout(handle);
    }
  }, [city]);

  // The decoded index is forty megabytes and the search box is the only thing that reads it, so it
  // is loaded when the panel that holds the box opens and dropped when it closes. Opening the panel
  // is early enough that the tables are ready before anything is typed, and it spares every visitor
  // who only ever looks at the map — on a phone already holding the graph and a screenful of tile
  // canvases, that is the difference between a session iOS tolerates and one it kills.
  useEffect(() => {
    if (routingOpen) {
      warmNameIndex(city.id);
    } else {
      releaseNameIndex();
    }
  }, [routingOpen, city]);

  // Taking a layer out of the menu turns it off, the same way switching city does: a layer drawn on
  // the map with no row to turn it off by is a state the reader cannot get out of. Putting it back in
  // the menu leaves it off rather than lighting it again — hiding is a decision about the menu, and
  // guessing that it was also a decision to look at the layer again would be putting something on the
  // map nobody asked for.
  useEffect(() => {
    const hidden = new Set(settings.hiddenLayers);
    setActiveOverlays((current) => {
      const kept = new Set([...current].filter((id) => !hidden.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [settings.hiddenLayers]);

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
    } else if (!routableLocation) {
      // A live fix outside the active city is not a start: adopting it guarantees the search fails on
      // a point it was never going to reach. Dropping it leaves the panel asking for a start, which is
      // the honest state.
      startBasisRef.current = null;
      setResolvedStart(null);
    } else {
      const basis = startBasisRef.current;
      if (!basis || metersBetween(basis, routableLocation) > RESNAP_METERS) {
        startBasisRef.current = {
          lat: routableLocation.lat,
          lng: routableLocation.lng,
        };
        setResolvedStart({
          lat: routableLocation.lat,
          lng: routableLocation.lng,
        });
      }
    }
  }, [manualStart, routableLocation]);

  useEffect(() => {
    hasReadyRouteRef.current = routeState.kind === "ready";
    lastTravelSecondsRef.current =
      routeState.kind === "ready" ? routeState.result.travelSeconds : null;
  }, [routeState]);

  // The city a route belongs to. Captured as a value and threaded through the whole search rather
  // than read from the `activeCity()` global at each step, because that global moves under the
  // search: a first location fix or a camera settle can reselect the city while a graph fetch is in
  // flight, and the effect would then load one city's graph and report the result against another's
  // name and bounds. With a visitor located in New York opening directions in San Francisco, that
  // race left the route computed and never drawn. It is a dependency of the search for the same
  // reason — changing city has to recompute the route, not silently repoint the labels.
  const routeCity = city;

  // Which controls this city can actually answer, read off its own loaded graph rather than
  // authored per city — the graph is the thing the sliders cost against, so it is the only source
  // that cannot drift from them. Everything reads false until the graph lands, which is the honest
  // answer while nothing is known; the panel is not routing yet either.
  //
  // The scaffolding gate is the exception: sheds are fetched separately from the graph, so it asks
  // the city's overlay list, where a city with no shed feed omits the layer.
  const capabilities = useMemo(
    () => ({
      relief: (routingGraph?.maxRelief ?? 0) > 0,
      ferries: (routingGraph?.ferryEdges.length ?? 0) > 0,
      commercial: (routingGraph?.maxCommercial ?? 0) > 0,
      // Gated like relief above, and for the same reason: a city with no industrial source bakes
      // every edge 0, and the slider would sit there moving nothing. The max is computed for this
      // and nothing else — a penalty's minimum factor is 1, so it never enters the A* lower bound.
      industrial: (routingGraph?.maxIndustrial ?? 0) > 0,
      // A city with no designated districts bakes every edge 0, exactly as above — the difference is
      // that this max is a discount's, so it also sets that factor's term in the A* lower bound.
      historic: (routingGraph?.maxHistoric ?? 0) > 0,
      landmarks: (routingGraph?.maxLandmark ?? 0) > 0,
      art: (routingGraph?.maxArt ?? 0) > 0,
      sheds: city.overlays.includes("scaffolding"),
    }),
    [routingGraph, city],
  );

  // The cost context every search runs against, and what the URL and the share link carry.
  const weights: RouteWeights = useMemo(
    () => ({
      tree: treeWeight,
      ferry: ferryWeight,
      landmark: landmarkWeight,
      art: artWeight,
      highway: highwayWeight,
      hill: hillWeight,
      commercial: commercialWeight,
      industrial: industrialWeight,
      historic: historicWeight,
      shade: shadeWeight,
      shelter: shelterWeight,
      allowFerries,
      allowSheds,
      allowCrossings,
    }),
    [
      allowCrossings,
      treeWeight,
      ferryWeight,
      landmarkWeight,
      artWeight,
      highwayWeight,
      hillWeight,
      commercialWeight,
      industrialWeight,
      historicWeight,
      shadeWeight,
      shelterWeight,
      allowFerries,
      allowSheds,
    ],
  );

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
      loadRouting(routeCity.id).then(
        async ({ graph, index }) => {
          if (cancelled) {
            return;
          }
          // Replaced whenever the identity changes, not kept forever once set. `loadRouting` hands
          // back one stable graph PER CITY, so `current ?? graph` held New York's for the whole
          // session: switching to San Francisco left the hill slider greyed out (this graph is what
          // says which layers a city has) and built San Francisco's turn-by-turn directions against
          // New York's edges. The identity check keeps the re-render, which is what `??` was for.
          setRoutingGraph((current) => (current === graph ? current : graph));
          routedForRef.current = request;
          // Keep the shade routing context current. loadRouting hands back one stable graph, so the
          // per-edge attrs are recomputed only when the sun position (a clock tick) moves — a start/dest
          // change alone reuses the attrs already on it. A tick drops both the weight-bracket cache and
          // any in-flight drag solver they were built against. A missing or mismatched SHDE artifact is
          // not fatal: routing drops the sun/shade bias for this time rather than failing. When shade is
          // off, clear the field and the context so it costs nothing.
          if (weights.shade !== 0) {
            // Keyed by city as well as by tick: the field is built onto ONE city's graph, so a
            // switch with the clock stopped left the guard saying "already built" about the other
            // city's graph and the new one's shade silently dead. Same reason the ferry context is.
            const context = `${routeCity.id}:${routeTimeTick}`;
            if (shadeContextRef.current !== context) {
              routeCacheRef.current = null;
              dragSolverRef.current = null;
              shadeContextRef.current = context;
              let lost = false;
              try {
                await computeEdgeShade(graph, getResolvedDate(), routeCity);
              } catch (error) {
                // A missing or malformed SHDE artifact is not fatal — routing just drops the sun/shade
                // bias for this time. Surface it so a stale local bake (the usual cause) is visible in
                // the console, and grey the slider so the reader is not left adjusting a control that
                // moves nothing.
                console.error("shade routing disabled:", error);
                graph.shade = null;
                lost = true;
              }
              if (cancelled) {
                return;
              }
              // Below the guard, not inside the try: a clock scrub starts a fetch per tick, and a
              // slow failure landing after a later tick has already succeeded would otherwise grey
              // out a slider whose data is loaded and being used.
              setShadeDataLost(lost);
            }
          } else {
            graph.shade = null;
            shadeContextRef.current = "";
          }
          // The standing sheds, whose set moves only with the picked DAY. They feed the shade composite
          // as well as the shelter factor and the scaffolding gate, so the field is kept current while any of
          // the three is live. A failed fetch is not fatal either: computeEdgeSheds seeds the canopy half
          // of shelter first, so the slider keeps working on trees alone.
          if (
            weights.shade !== 0 ||
            weights.shelter !== 0 ||
            !weights.allowSheds
          ) {
            const day = shedDay(getResolvedDate());
            const context = `${routeCity.id}:${day}`;
            if (shedDayRef.current !== context) {
              routeCacheRef.current = null;
              dragSolverRef.current = null;
              shedDayRef.current = context;
              try {
                await computeEdgeSheds(graph, getResolvedDate());
              } catch (error) {
                console.error("scaffolding routing disabled:", error);
              }
              if (cancelled) {
                return;
              }
            }
            // The standing set moves with the day but the sun moves with the clock, so the field's
            // schedule is re-aimed on every tick rather than rebuilt; setShedSun carries why.
            if (graph.sheds) {
              setShedSun(graph.sheds, getResolvedDate());
            }
          } else {
            graph.sheds = null;
            shedDayRef.current = "";
          }
          // The ferry timetable for the departure instant. Only worth fetching while ferries are
          // allowed and this city has any to sail; barred, every ferry edge is skipped before its cost
          // is ever asked for, and a city with no ferry edges has no timetable to fetch. A failed
          // fetch is not fatal — the graph's baked crossing-plus-average-wait figure is what routing
          // used before this artifact existed, so it simply falls back to that.
          if (weights.allowFerries && graph.ferryEdges.length > 0) {
            const context = `${routeCity.id}:${routeTimeTick}`;
            if (ferryContextRef.current !== context) {
              routeCacheRef.current = null;
              dragSolverRef.current = null;
              ferryContextRef.current = context;
              try {
                await computeFerrySchedule(
                  graph,
                  routeCity.id,
                  getResolvedDate(),
                );
              } catch (error) {
                console.error("ferry timetable unavailable:", error);
                graph.ferries = null;
              }
              if (cancelled) {
                return;
              }
            }
          } else {
            graph.ferries = null;
            ferryContextRef.current = "";
          }
          const pair = snapPair(graph, index, request.start, request.dest);
          if (!pair.ok) {
            const offending =
              pair.reason === "startTooFar"
                ? request.start
                : pair.reason === "destTooFar"
                  ? request.dest
                  : null;
            setRouteState({
              kind: "error",
              message: messageFor(pair.reason, routeCity, offending),
            });
          } else if (draggingRef.current) {
            // Mid-drag: reuse a per-gesture solver rooted at the held endpoint for an approximate
            // route each frame; the drop recomputes exactly. Start-drags solve from the dest and flip.
            const which = dragWhichRef.current;
            // A start-drag solves backward from the dest, so it anchors the sun at the drawn route's
            // arrival time and counts it backward; a dest-drag solves forward from the true start.
            const solver = (dragSolverRef.current ??=
              which === "dest"
                ? new RouteSolver(graph, pair.start, weights)
                : new RouteSolver(
                    graph,
                    pair.dest,
                    weights,
                    lastTravelSecondsRef.current ?? 0,
                    -1,
                  ));
            const moving = which === "dest" ? pair.dest : pair.start;
            const solved = solver.solveApprox(moving);
            const result =
              which === "start" && solved
                ? reverseResult(graph, solved)
                : solved;
            if (result) {
              setRouteState({ kind: "ready", result, graph });
            } else {
              setRouteState({
                kind: "error",
                message: messageFor("disconnected", routeCity, null),
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
                setRouteState({ kind: "ready", result, graph });
              } else {
                setRouteState({
                  kind: "error",
                  message: messageFor("disconnected", routeCity, null),
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
    weights,
    routeTimeTick,
    routeRefreshNonce,
    routeCity,
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

  // Reads the current value rather than toggling inside an updater: an updater must be pure, and
  // both branches here are side effects. React invokes updaters twice in development to find exactly
  // this, and the next effect added inside one would not be as forgiving as these are.
  const handleToggleRouting = useCallback(() => {
    if (routingOpen) {
      // closing clears everything but keeps the slider value
      setDest(null);
      setManualStart(null);
      setPickTarget(null);
      setRouteState({ kind: "idle" });
      routedForRef.current = null;
      // The peek bar is a way of getting a computed route out of the way, so it has no meaning over
      // an empty panel: without this, closing directions while minimized and opening them again
      // brings back a slim bar with nothing in it and no obvious way to see the fields.
      setPanelMinimized(false);
    } else {
      // warm the graph so the first route lands without a fetch stall
      void loadRouting(city.id);
    }
    setRoutingOpen(!routingOpen);
  }, [routingOpen, city.id]);

  const handleTreeWeight = useCallback((weight: number) => {
    setTreeWeight(weight);
    persistWeight("tree", weight);
  }, []);

  const handleFerryWeight = useCallback((weight: number) => {
    setFerryWeight(weight);
    persistWeight("ferry", weight);
  }, []);

  const handleLandmarkWeight = useCallback((weight: number) => {
    setLandmarkWeight(weight);
    persistWeight("landmark", weight);
  }, []);

  const handleArtWeight = useCallback((weight: number) => {
    setArtWeight(weight);
    persistWeight("art", weight);
  }, []);

  const handleHillWeight = useCallback((weight: number) => {
    setHillWeight(weight);
    persistWeight("hill", weight);
  }, []);

  const handleHighwayWeight = useCallback((weight: number) => {
    setHighwayWeight(weight);
    persistWeight("highway", weight);
  }, []);

  const handleCommercialWeight = useCallback((weight: number) => {
    setCommercialWeight(weight);
    persistWeight("commercial", weight);
  }, []);

  const handleIndustrialWeight = useCallback((weight: number) => {
    setIndustrialWeight(weight);
    persistWeight("industrial", weight);
  }, []);

  const handleHistoricWeight = useCallback((weight: number) => {
    setHistoricWeight(weight);
    persistWeight("historic", weight);
  }, []);

  const handleShadeWeight = useCallback((weight: number) => {
    setShadeWeight(weight);
    persistWeight("shade", weight);
  }, []);

  const handleShelterWeight = useCallback((weight: number) => {
    setShelterWeight(weight);
    persistWeight("shelter", weight);
  }, []);

  // The three switches, by key rather than a callback each: they are a table now (src/routing/
  // factors.tsx), and a callback each would be a fourth place to add a line every time one is added.
  const handleGate = useCallback((key: GateKey, on: boolean) => {
    const setters: Record<GateKey, (on: boolean) => void> = {
      allowFerries: setAllowFerries,
      allowSheds: setAllowSheds,
      allowCrossings: setAllowCrossings,
    };
    setters[key](on);
    updateSettings({ [key]: on });
  }, []);

  // The settings page edits the same weights the panel does, and sends a key and a value rather than
  // carrying a callback per factor.
  const handleWeight = useCallback(
    (key: FactorKey, weight: number) => {
      const setters: Record<FactorKey, (weight: number) => void> = {
        tree: handleTreeWeight,
        ferry: handleFerryWeight,
        landmark: handleLandmarkWeight,
        art: handleArtWeight,
        highway: handleHighwayWeight,
        hill: handleHillWeight,
        commercial: handleCommercialWeight,
        industrial: handleIndustrialWeight,
        historic: handleHistoricWeight,
        shade: handleShadeWeight,
        shelter: handleShelterWeight,
      };
      setters[key](weight);
    },
    [
      handleTreeWeight,
      handleFerryWeight,
      handleLandmarkWeight,
      handleArtWeight,
      handleHighwayWeight,
      handleHillWeight,
      handleCommercialWeight,
      handleIndustrialWeight,
      handleHistoricWeight,
      handleShadeWeight,
      handleShelterWeight,
    ],
  );

  // Answering the destination box — by picking a row, by clearing it, or by tapping the map — retires
  // any query a link arrived with: the reader has said what they want, and a lookup still running for
  // words they have moved past must not overwrite it.
  const forgetDestQuery = useCallback(() => {
    setDestQuery(null);
    setDestPrefill(null);
  }, []);

  const handleDestSelect = useCallback(
    (result: GeocodeResult) => {
      setDest({ lat: result.lat, lng: result.lng, label: result.displayName });
      setPickTarget(null);
      forgetDestQuery();
    },
    [forgetDestQuery],
  );

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
    forgetDestQuery();
  }, [forgetDestQuery]);

  // Clearing the start — via the X or the dropdown's "My location" row — resets it to the live position.
  // Both clearing the start and asking for "my location" mean the same thing here: route from the
  // live fix. So they are also the two places worth asking for one again when there is none.
  const handleClearStart = useCallback(() => {
    setManualStart(null);
    setPickTarget((target) => (target === "start" ? null : target));
    retryLocation();
  }, [retryLocation]);

  // Exchange the two ends. Nothing is re-geocoded — the labels travel with their points — and the
  // solve effect re-fires on the new pair and searches again from scratch. Deliberately NOT the
  // reverse solver the drags use: that re-times the path it already has, and the costs are
  // directional (hills, ferries, sun), so the way back is a different route, not this one read
  // backwards.
  //
  // A start reading "My location" cannot reach here with a destination set — the promotion effect
  // below has already pinned it to a point by then. Without a destination the swap moves the start
  // into the empty destination box and lets the start fall back to the live fix; with only a
  // destination it does the same in reverse, which is the way out of typing a start into the wrong
  // box.
  const handleSwapEndpoints = useCallback(() => {
    setManualStart(dest);
    setDest(manualStart);
    setPickTarget(null);
    forgetDestQuery();
  }, [dest, manualStart, forgetDestQuery]);

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
        forgetDestQuery();
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
    [forgetDestQuery],
  );

  // Asking for directions pins where you are. Until a destination exists the start tracks the live
  // position and reads "My location", which is right for a start you have not committed to — but once
  // it is one end of a route, following would move it under you as you walk, and it would go into a
  // shared link as nothing at all, leaving whoever opened it routing from THEIR position. So the live
  // position is promoted to a real point, reverse-geocoded like any picked one. Clearing the start
  // afterwards re-pins it to wherever you are then.
  //
  // Only a fix this city can route from is promoted, for the reason the start resolver gives: pinning
  // one from another city turns a link someone opened into an immediate routing error against a start
  // they never chose.
  useEffect(() => {
    if (!dest || manualStart || !routableLocation) {
      return;
    }
    applyPick("start", routableLocation.lat, routableLocation.lng);
  }, [dest, manualStart, routableLocation, applyPick]);

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

  // One-shot init from the URL hash, layered over the persisted preferences: a key in the link wins, a
  // missing one keeps what the sliders were last left at, and a link with no view keys leaves the
  // camera and overlays alone. Enables the hash writer only once done, so opening a link never
  // rewrites it out from under itself.
  useEffect(() => {
    const params = hashParams(window.location.hash);
    const stored: RouteUrlState = {
      start: null,
      dest: null,
      weights: storedWeights(),
      customHour: null,
      customDay: null,
    };
    const route = decodeRoute(params, stored);
    setTreeWeight(route.weights.tree);
    setFerryWeight(route.weights.ferry);
    setLandmarkWeight(route.weights.landmark);
    setArtWeight(route.weights.art);
    setHighwayWeight(route.weights.highway);
    setHillWeight(route.weights.hill);
    setCommercialWeight(route.weights.commercial);
    setIndustrialWeight(route.weights.industrial);
    setHistoricWeight(route.weights.historic);
    setShadeWeight(route.weights.shade);
    setShelterWeight(route.weights.shelter);
    setAllowFerries(route.weights.allowFerries);
    setAllowSheds(route.weights.allowSheds);
    setAllowCrossings(route.weights.allowCrossings);
    if (route.customHour !== null) {
      setCustomHour(route.customHour);
    }
    if (route.customDay !== null) {
      setCustomDay(route.customDay);
    }
    if (route.start) {
      applyPick("start", route.start.lat, route.start.lng);
    }
    if (route.dest) {
      applyPick("dest", route.dest.lat, route.dest.lng);
      setRoutingOpen(true);
      // A link that names a route is a request to look at that route, so the first location fix does
      // not get to centre the map on the visitor instead — even when they are in the same city as it.
      setFollowing(false);
      void loadRouting(activeCity().id); // warm the graph, as opening the panel by hand does
    }
    const view = decodeView(params);
    // Three sources, in this order and no other: the link, then where you are, then the default. The
    // last city you looked at is deliberately NOT one of them — it was remembered in localStorage and
    // beat the live fix, so a visitor in San Francisco who had once opened New York kept being shown
    // New York. Nobody asked to be taken back to where they were last time.
    // A destination names a city as surely as the city key does: it is a point in exactly one of
    // them, and it is what the visitor opened the link to see.
    const linked =
      cityById(view.city) ?? (route.dest ? nearestCity(route.dest) : null);
    linkedCityRef.current = linked !== null;
    if (linked) {
      setCity(linked);
    }
    const overlays = view.overlays ?? storedOverlays();
    if (overlays) {
      // unknown ids (a stale "trees" from before the canopy switch) are dropped, and a set that
      // names an exclusive layer alongside others is cut back to it — the invariant the toggle
      // handler keeps has to hold however the set arrives
      setActiveOverlays(
        new Set(applyExclusivity(overlays.filter(isOverlayId))),
      );
    }
    if (view.camera) {
      setInitialCamera(view.camera);
      setPreframedDest(route.dest);
      setFollowing(false); // else the first location fix yanks the shared camera away
    } else if (linked) {
      // A chosen city with no camera to go with it still has to frame that city before the map
      // settles: the camera is what decides which city is active, so opening on the default one and
      // correcting afterwards would just switch straight back.
      setInitialCamera({ center: linked.center, zoom: CITY_ZOOM });
    }
    hashAppliedRef.current = true;
    setHashApplied(true);
  }, [applyPick]);

  // A destination named in words rather than as a point: the `q` key of a shared link, or the text
  // Android's share sheet hands the installed app. Both land here because both say the same thing,
  // and the city's own index resolves them without a network — which is the only reason this can be
  // acted on at all. Read once and taken straight back out of the URL, so a link cannot fire twice
  // on reload or travel on to the next person carrying a destination they never asked for; the words
  // themselves live in `destQuery` from then on. The box opens with them in it immediately, before
  // anything is known about what they mean.
  useEffect(() => {
    if (!hashApplied || destQuery !== null) {
      return;
    }
    const asked =
      decodeDestQuery(hashParams(window.location.hash)) ??
      sharedDestinationText(new URLSearchParams(window.location.search));
    if (asked === null) {
      return;
    }
    setRoutingOpen(true);
    setDestQuery(asked);
    setDestPrefill({ text: asked, results: [] });
    window.history.replaceState(
      null,
      "",
      window.location.pathname +
        withoutShareParams(window.location.search) +
        withoutDestQuery(window.location.hash),
    );
  }, [hashApplied, destQuery]);

  // Resolving those words against a city. An exact house number is routed to; anything vaguer fills
  // the box with the words and the answers found for them and lets the reader choose, because a
  // shared "Joe's" that silently routes to one of eleven is worse than a list of eleven. The answers
  // are handed to the box rather than left for it to search again: it searches on a timer after the
  // words land, which on the cold load this feature exists for asks an index that has not arrived
  // and gets nothing, with no second keystroke coming to ask again.
  //
  // Threaded a captured `city` rather than letting `searchAddress` read the live one, for the reason
  // spelled out at `routeCity` above: a first location fix can reselect the city while the index is
  // still loading, and answering about the wrong city's streets is worse than answering late.
  //
  // That fix is also why the words are held in state rather than consumed where the URL is read. A
  // `q` link names words, not a place, so unlike one carrying coordinates it cannot say which city
  // it means — it must not be treated as having chosen one, or a visitor standing in San Francisco
  // would be answered out of New York's streets. So the fix is left free to move the city, and this
  // resolves again in the new one instead of dropping the destination. Waiting for the index is what
  // makes that window wide enough to matter: on a cold load the fix lands long before the tables do.
  useEffect(() => {
    if (destQuery === null) {
      return;
    }
    let cancelled = false;
    const cityId = city.id;
    // Waits for the index rather than searching without it. A shared link is opened cold, so the
    // files are usually still arriving, and asking early would answer "nothing found" about an
    // address the city certainly has.
    awaitNameIndex(cityId)
      .then(() =>
        resolveSharedQuery(destQuery, cityId, searchAddress, () => cancelled),
      )
      .then((found) => {
        if (cancelled || found === null) {
          return;
        }
        setDestQuery(null);
        if (found.exact === null) {
          setDestPrefill({ text: found.query, results: found.results });
        } else {
          const { lat, lng, displayName } = found.exact;
          setDest({ lat, lng, label: displayName });
          setDestPrefill(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [destQuery, city]);

  const handleCamera = useCallback((camera: Camera, view: CityBounds) => {
    cameraRef.current = camera;
    // Where the map is decides which city is active — but not yet. The first report comes from the
    // container's default centre, which is the default city rather than anything anyone chose, and it
    // lands before the hash effect has read the link. Answering it would set the city from the default
    // and leave the link to correct it afterwards, which is the race this ordering removes.
    if (!hashAppliedRef.current) {
      return;
    }
    // Settled moves only, and this bails when the id is unchanged, so it costs one lookup per gesture
    // rather than one per frame. Read against the active city rather than through a functional update
    // because leaving a city has to clear its route too, which a state updater may not do.
    //
    // One city on screen and no other is the whole test. Where the centre happens to sit does not
    // enter into it: a view wide enough to hold two cities is not a view that has chosen between
    // them, however the centre falls, and switching there would throw away the route of whichever
    // one you actually had. So a city takes over only once it is alone in frame — which for
    // neighbours like Oakland and San Francisco means zooming in far enough to leave the other
    // behind, and that is the same gesture as saying which one you mean.
    // Proposed through the updater rather than compared against the city read from the last
    // render. A settled camera fires several times inside one tick — a synchronous setView reports
    // synchronously — so a comparison outside the updater reads a value the previous report has
    // already queued a change to, and the stale one wins. The updater always sees the latest.
    const inView = citiesInView(view);
    if (inView.length === 1) {
      const [next] = inView;
      // The same one-city-in-frame test the switch uses, because it is the same question: this
      // centre only says anything about a city when it is the only one on screen. The address search
      // ranks the several streets of one name — New York has five Court Streets — by how near they
      // are to it, when the reader has not shared a location of their own.
      setSearchCentre(next.id, camera.center);
      setCity((current) => (next.id === current.id ? current : next));
    }
  }, []);

  // The link the share button copies: the route the hash already carries, plus the camera and overlay
  // set, which live in a URL only here.
  const composeShareUrl = useCallback((): string => {
    const { hour, day } = getPinnedTime();
    const params = encodeRoute({
      start: manualStart,
      dest,
      weights,
      customHour: hour,
      customDay: day,
    });
    if (cameraRef.current) {
      for (const [key, value] of encodeView(
        cameraRef.current,
        [...activeOverlays],
        city.id,
      )) {
        params.append(key, value);
      }
    }
    const { origin, pathname, search } = window.location;
    return `${origin}${pathname}${search}${formatHash(params)}`;
  }, [manualStart, dest, weights, activeOverlays, city]);

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
      loadPois(`landmarks/${city.id}.bin`, "LMRK"),
      loadPois(`art/${city.id}.bin`, "ARTW"),
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
  }, [routingOpen, poiSets, city.id]);

  const routeResult = routeState.kind === "ready" ? routeState.result : null;
  // The graph the result was actually computed against, not whichever one state last landed on.
  const resultGraph = routeState.kind === "ready" ? routeState.graph : null;
  const directions = useMemo(() => {
    if (!resultGraph || !routeResult) {
      return null;
    }
    const passed = poiSets
      ? passedPois(resultGraph, routeResult, [
          {
            kind: "landmark",
            set: poiSets.landmarks,
            thresholdMeters: LANDMARK_PASS_METERS,
          },
          { kind: "art", set: poiSets.art, thresholdMeters: ART_PASS_METERS },
        ])
      : [];
    return buildDirections(resultGraph, routeResult, {
      collapseLinearCrossings: true,
      passed,
    });
  }, [resultGraph, routeResult, poiSets]);
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
        : routingOpen && routableLocation
          ? { lat: routableLocation.lat, lng: routableLocation.lng }
          : null;
  // The destination marker appears the moment a destination exists; the line follows live once both
  // endpoints resolve and the search lands.
  const routeDest = dest ? { lat: dest.lat, lng: dest.lng } : null;

  return (
    <CityProvider value={city}>
      <main className="relative h-dvh w-full overflow-hidden">
        <MapView
          city={city}
          pins={pins}
          draft={draft}
          target={target}
          userLocation={userLocation}
          following={followLive}
          activeOverlays={activeOverlays}
          routeResult={routeResult}
          routeGraph={resultGraph}
          routeDest={routeDest}
          routeStart={routeStart}
          pickMode={pickMode}
          onMapPick={handleMapPick}
          dragging={dragging}
          initialCamera={initialCamera}
          preframedDest={preframedDest}
          onCamera={handleCamera}
          onBasemapLost={handleBasemapLost}
          onDisengageFollow={handleDisengageFollow}
          onEndpointDragMove={handleEndpointDragMove}
          onEndpointDrag={handleEndpointDrag}
          onPinSelect={handlePinSelect}
        />
        <Toolbar
          auth={auth}
          pinCount={pins.length}
          city={city}
          activeOverlays={activeOverlays}
          routing={routingOpen}
          refreshingClaims={refreshing}
          onToggleOverlay={handleToggleOverlay}
          onToggleRouting={handleToggleRouting}
          onSignIn={handleSignIn}
          onSignOut={handleSignOut}
          onRefreshClaims={handleRefreshClaims}
          onAbout={() => setAboutOpen(true)}
          onSettings={(section) => setSettingsSection(section ?? "")}
          onLogHere={handleLogHere}
          logHereDisabled={userLocation === null}
          logHereBusy={logging}
          logHereHint={locationHint}
          onSelectCity={handleSelectCity}
          composeShareUrl={composeShareUrl}
        />
        <UrlSync
          start={manualStart}
          dest={dest}
          weights={weights}
          enabled={hashApplied}
        />
        <FollowToggle active={followLive} onToggle={handleToggleFollow} />
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
        {/* under the dialogs' 1100, whose titles it used to cover, and over the map's own chrome */}
        {banner ? (
          <div className="absolute inset-x-3 top-16 z-[1050] mx-auto flex w-fit items-center gap-3 rounded-2xl bg-slate-900/90 px-4 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900">
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
            destPrefill={destPrefill}
            startLabel={
              manualStart
                ? manualStart.label
                : routableLocation
                  ? "My location"
                  : null
            }
            destLabel={dest?.label ?? null}
            startSet={manualStart !== null}
            destSet={dest !== null}
            needsStart={(manualStart ?? routableLocation) === null}
            hasLiveLocation={routableLocation !== null}
            pickTarget={effectivePickTarget}
            status={routeState.kind}
            errorMessage={
              routeState.kind === "error" ? routeState.message : null
            }
            summary={
              routeState.kind === "ready"
                ? {
                    walkMeters: routeState.result.walkMeters,
                    travelSeconds: routeState.result.travelSeconds,
                    factors: routeState.result.factors,
                  }
                : null
            }
            treeWeight={treeWeight}
            ferryWeight={ferryWeight}
            allowFerries={allowFerries}
            landmarkWeight={landmarkWeight}
            artWeight={artWeight}
            highwayWeight={highwayWeight}
            hillWeight={hillWeight}
            capabilities={capabilities}
            commercialWeight={commercialWeight}
            industrialWeight={industrialWeight}
            historicWeight={historicWeight}
            shadeWeight={shadeWeight}
            shadeDataLost={shadeDataLost}
            shelterWeight={shelterWeight}
            allowSheds={allowSheds}
            allowCrossings={allowCrossings}
            directions={directions}
            progress={progress}
            directionsOpen={directionsOpen}
            minimized={panelMinimized}
            onTreeWeight={handleTreeWeight}
            onFerryWeight={handleFerryWeight}
            onLandmarkWeight={handleLandmarkWeight}
            onArtWeight={handleArtWeight}
            onHighwayWeight={handleHighwayWeight}
            onHillWeight={handleHillWeight}
            onCommercialWeight={handleCommercialWeight}
            onIndustrialWeight={handleIndustrialWeight}
            onHistoricWeight={handleHistoricWeight}
            onShadeWeight={handleShadeWeight}
            onShelterWeight={handleShelterWeight}
            onGate={handleGate}
            onStartSelect={handleStartSelect}
            onDestSelect={handleDestSelect}
            onStartClear={handleClearStart}
            onDestClear={handleClearDest}
            onSwap={handleSwapEndpoints}
            onUseCurrentLocation={handleClearStart}
            onArmStart={handleArmStart}
            onArmDest={handleArmDest}
            onToggleDirections={handleToggleDirections}
            onToggleMinimize={handleToggleMinimize}
            onSettings={(section) => setSettingsSection(section ?? "")}
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
        {settingsOpen ? (
          <SettingsDialog
            weights={weights}
            onWeight={handleWeight}
            onGate={handleGate}
            syncingAs={auth.kind === "signedIn" ? auth.info.user.email : null}
            section={settingsSection}
            onClose={() => setSettingsSection(null)}
          />
        ) : null}
      </main>
    </CityProvider>
  );
}
