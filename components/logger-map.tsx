"use client";

import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  Marker,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import type { Pin, PinDraft } from "../src/pin";

export interface MapTarget {
  lat: number;
  lng: number;
  zoom?: number;
}

interface LoggerMapProps {
  pins: Pin[];
  draft: PinDraft | null;
  target: MapTarget | null;
  userLocation: { lat: number; lng: number } | null;
  following: boolean;
  onDisengageFollow: () => void;
  onPinSelect: (pin: Pin) => void;
}

const DEFAULT_CENTER: [number, number] = [37.7749, -122.4194];
const DEFAULT_ZOOM = 13;

const savedPinSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">
  <defs>
    <linearGradient id="scenicPinGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
  </defs>
  <path d="M15 1C7.82 1 2 6.82 2 14c0 9.5 13 24 13 24s13-14.5 13-24C28 6.82 22.18 1 15 1z"
        fill="url(#scenicPinGrad)" stroke="#ffffff" stroke-width="2"/>
  <circle cx="15" cy="14" r="4.5" fill="#ffffff"/>
</svg>`.trim();

const savedIcon = L.divIcon({
  className: "scenic-saved-pin",
  html: savedPinSvg,
  iconSize: [30, 40],
  iconAnchor: [15, 39],
  popupAnchor: [0, -34],
  tooltipAnchor: [0, -34],
});

const draftIcon = L.divIcon({
  className: "",
  html: '<div class="scenic-draft-pin"><div class="scenic-draft-pin-ring"></div><div class="scenic-draft-pin-dot"></div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const userIcon = L.divIcon({
  className: "",
  html: '<div class="scenic-user-pin"><div class="scenic-user-pin-ring"></div><div class="scenic-user-pin-dot"></div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

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

  // Imperative fly-to for explicit targets (e.g. selecting a saved pin).
  useEffect(() => {
    if (!target) {
      // Reset so re-flying to the same coords (e.g. after a popup close)
      // isn't deduped against the last fly-to.
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

  // Follow camera: recenter on the user while follow mode is engaged.
  useEffect(() => {
    const justEngaged = following && !wasFollowingRef.current;
    wasFollowingRef.current = following;
    if (!following || !userLocation) {
      return;
    }
    const { lat, lng } = userLocation;
    if (!hasZoomedRef.current) {
      // First centering on the user: zoom in to street level.
      hasZoomedRef.current = true;
      map.flyTo([lat, lng], 16, { duration: 0.8 });
    } else if (justEngaged) {
      // Re-engaged via the toggle: snap back to the user at the current zoom.
      map.flyTo([lat, lng], map.getZoom(), { duration: 0.8 });
    } else {
      // Steady-state follow: pan to the user, keeping their chosen zoom.
      map.setView([lat, lng], map.getZoom(), { animate: true });
    }
  }, [following, userLocation, map]);

  // While following, anchor zoom gestures on the map center (i.e. the user)
  // instead of the cursor/pinch point, so zooming doesn't drift off the user.
  // Restore the default cursor-anchored zoom once follow is released.
  useEffect(() => {
    const zoomAnchor = following ? "center" : true;
    map.options.scrollWheelZoom = zoomAnchor;
    map.options.doubleClickZoom = zoomAnchor;
    map.options.touchZoom = zoomAnchor;
  }, [following, map]);

  // Only a user pan releases follow mode. Zoom gestures keep following on, so
  // the next position update simply re-centers at the user's chosen zoom.
  // Programmatic camera moves (flyTo/setView) never fire dragstart, so any
  // dragstart is the user grabbing the map.
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

export default function LoggerMap({
  pins,
  draft,
  target,
  userLocation,
  following,
  onDisengageFollow,
  onPinSelect,
}: LoggerMapProps) {
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
      className="h-dvh w-full"
      zoomControl={false}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={20}
      />
      <MapController
        target={target}
        following={following}
        userLocation={userLocation}
        onDisengageFollow={onDisengageFollow}
      />
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
