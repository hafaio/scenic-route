"use client";

import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  Marker,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import { OVERLAYS, type OverlayId } from "../src/overlays/registry";
import type { Pin, PinDraft } from "../src/pin";
import type { RouteResult } from "../src/routing/search";
import { savedIcon, userIcon } from "./map-icons";
import RouteLayer from "./route-layer";

export interface MapTarget {
  lat: number;
  lng: number;
  zoom?: number;
}

interface MapViewProps {
  pins: Pin[];
  draft: PinDraft | null;
  target: MapTarget | null;
  userLocation: { lat: number; lng: number } | null;
  following: boolean;
  activeOverlay: OverlayId | null;
  routeResult: RouteResult | null;
  routeDest: { lat: number; lng: number } | null;
  routeStart: { lat: number; lng: number } | null;
  picking: boolean;
  onMapPick: (lat: number, lng: number) => void;
  onDisengageFollow: () => void;
  onEndpointDragMove: (
    which: "start" | "dest",
    lat: number,
    lng: number,
  ) => void;
  onEndpointDrag: (which: "start" | "dest", lat: number, lng: number) => void;
  onPinSelect: (pin: Pin) => void;
}

const DEFAULT_CENTER: [number, number] = [40.7128, -74.006];
const DEFAULT_ZOOM = 13;

const draftIcon = L.divIcon({
  className: "",
  html: '<div class="scenic-draft-pin"><div class="scenic-draft-pin-ring"></div><div class="scenic-draft-pin-dot"></div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

// A map click sets the armed field's location. Mounted only while a field has armed pick mode, so
// ordinary browsing never intercepts clicks; pin markers stop propagation, so they still select.
function PickCatcher({
  onMapPick,
}: {
  onMapPick: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click: (event) => {
      onMapPick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

// Leaflet 1.9 dropped its touch `tap` handler, so double-tap no longer reaches doubleClickZoom on
// mobile. This adds it back: two single-finger taps in the same spot within DOUBLE_TAP_MS zoom in
// one level toward the tap (or the centre while following, matching the scroll/pinch anchor). The
// second tap's preventDefault both blocks the browser's own double-tap zoom and suppresses the
// synthesised dblclick, so the desktop doubleClickZoom below never fires twice.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 40; // px between the two taps
const TAP_MOVE_SLOP = 12; // px a single tap may drift before it counts as a drag

function DoubleTapZoom({
  following,
  picking,
}: {
  following: boolean;
  picking: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    let lastTime = 0;
    let lastX = 0;
    let lastY = 0;
    let startX = 0;
    let startY = 0;
    let fingers = 0;

    const onStart = (event: TouchEvent) => {
      fingers = event.touches.length;
      if (fingers === 1) {
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
      }
    };
    const onEnd = (event: TouchEvent) => {
      // only a clean single-finger tap counts — not the lift-off of a pinch or a drag
      if (fingers > 1 || event.changedTouches.length !== 1) {
        lastTime = 0;
        return;
      }
      const touch = event.changedTouches[0];
      if (
        Math.hypot(touch.clientX - startX, touch.clientY - startY) >
        TAP_MOVE_SLOP
      ) {
        lastTime = 0;
        return;
      }
      const elapsed = event.timeStamp - lastTime;
      const near =
        Math.hypot(touch.clientX - lastX, touch.clientY - lastY) <
        DOUBLE_TAP_SLOP;
      if (lastTime > 0 && elapsed < DOUBLE_TAP_MS && near) {
        lastTime = 0;
        event.preventDefault();
        if (picking) {
          return;
        }
        const rect = container.getBoundingClientRect();
        const point = L.point(
          touch.clientX - rect.left,
          touch.clientY - rect.top,
        );
        const anchor = following
          ? map.getCenter()
          : map.containerPointToLatLng(point);
        map.setZoomAround(anchor, map.getZoom() + 1, { animate: true });
      } else {
        lastTime = event.timeStamp;
        lastX = touch.clientX;
        lastY = touch.clientY;
      }
    };
    container.addEventListener("touchstart", onStart, { passive: true });
    container.addEventListener("touchend", onEnd, { passive: false });
    return () => {
      container.removeEventListener("touchstart", onStart);
      container.removeEventListener("touchend", onEnd);
    };
  }, [map, following, picking]);
  return null;
}

interface MapControllerProps {
  target: MapTarget | null;
  following: boolean;
  userLocation: { lat: number; lng: number } | null;
  onDisengageFollow: () => void;
}

function MapController({
  target,
  following,
  userLocation,
  onDisengageFollow,
}: MapControllerProps) {
  const map = useMap();
  const lastTargetKey = useRef<string>("");
  const hasZoomedRef = useRef<boolean>(false);
  const wasFollowingRef = useRef<boolean>(following);

  // fly to an explicit target (e.g. a selected saved pin)
  useEffect(() => {
    if (!target) {
      // clear the key so re-selecting the same target (e.g. after closing the editor) still flies
      lastTargetKey.current = "";
      return;
    }
    const key = `${target.lat},${target.lng},${target.zoom ?? ""}`;
    if (key === lastTargetKey.current) {
      return;
    }
    lastTargetKey.current = key;
    map.flyTo([target.lat, target.lng], target.zoom ?? map.getZoom(), {
      duration: 0.8,
    });
  }, [target, map]);

  // follow camera: recenter on the user while engaged
  useEffect(() => {
    const justEngaged = following && !wasFollowingRef.current;
    wasFollowingRef.current = following;
    if (!following || !userLocation) {
      return;
    }
    const { lat, lng } = userLocation;
    if (!hasZoomedRef.current) {
      // first fix: zoom in to street level
      hasZoomedRef.current = true;
      map.flyTo([lat, lng], 16, { duration: 0.8 });
    } else if (justEngaged) {
      // re-engaged: snap back at the current zoom
      map.flyTo([lat, lng], map.getZoom(), { duration: 0.8 });
    } else {
      // steady state: pan to the user, keeping their zoom
      map.setView([lat, lng], map.getZoom(), { animate: true });
    }
  }, [following, userLocation, map]);

  // while following, anchor zoom on the map center (the user) not the cursor, so it doesn't drift off them
  useEffect(() => {
    const zoomAnchor = following ? "center" : true;
    map.options.scrollWheelZoom = zoomAnchor;
    map.options.doubleClickZoom = zoomAnchor;
    map.options.touchZoom = zoomAnchor;
  }, [following, map]);

  // only a pan (dragstart) releases follow; programmatic flyTo/setView don't fire dragstart, so any dragstart is a real user grab
  useEffect(() => {
    const handleDragStart = () => {
      onDisengageFollow();
    };
    map.on("dragstart", handleDragStart);
    return () => {
      map.off("dragstart", handleDragStart);
    };
  }, [map, onDisengageFollow]);

  return null;
}

function summarizePin(pin: Pin): string {
  const note = pin.text.trim();
  if (note) {
    return note;
  }
  return pin.address;
}

export default function MapView({
  pins,
  draft,
  target,
  userLocation,
  following,
  activeOverlay,
  routeResult,
  routeDest,
  routeStart,
  picking,
  onMapPick,
  onDisengageFollow,
  onEndpointDragMove,
  onEndpointDrag,
  onPinSelect,
}: MapViewProps) {
  const markers = useMemo(
    () =>
      pins.map((pin) => (
        <Marker
          key={pin.id}
          position={[pin.lat, pin.lng]}
          icon={savedIcon}
          eventHandlers={{
            click: () => onPinSelect(pin),
          }}
        >
          <Tooltip
            direction="top"
            offset={[0, -8]}
            opacity={1}
            className="scenic-tooltip"
          >
            {summarizePin(pin)}
          </Tooltip>
        </Marker>
      )),
    [pins, onPinSelect],
  );

  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      className={picking ? "h-dvh w-full scenic-picking" : "h-dvh w-full"}
      zoomControl={false}
      bounceAtZoomLimits={false}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={20}
        updateWhenZooming={false}
        keepBuffer={4}
      />
      {/* the active overlay's Leaflet layers, from the registry; nothing when Off */}
      {OVERLAYS.find((overlay) => overlay.id === activeOverlay)?.render() ??
        null}
      <MapController
        target={target}
        following={following}
        userLocation={userLocation}
        onDisengageFollow={onDisengageFollow}
      />
      <RouteLayer
        result={routeResult}
        dest={routeDest}
        start={routeStart}
        onDisengageFollow={onDisengageFollow}
        onEndpointDragMove={onEndpointDragMove}
        onEndpointDrag={onEndpointDrag}
      />
      {picking ? <PickCatcher onMapPick={onMapPick} /> : null}
      <DoubleTapZoom following={following} picking={picking} />
      {markers}
      {userLocation ? (
        <Marker
          position={[userLocation.lat, userLocation.lng]}
          icon={userIcon}
        />
      ) : null}
      {draft ? (
        <Marker position={[draft.lat, draft.lng]} icon={draftIcon} />
      ) : null}
    </MapContainer>
  );
}
