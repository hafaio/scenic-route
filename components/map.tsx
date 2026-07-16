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
import type { Pin, PinDraft } from "../src/pin";
import type { RouteResult } from "../src/routing/search";
import { savedIcon, userIcon } from "./map-icons";
import RouteLayer from "./route-layer";
import StreetScoreLayer from "./street-score-layer";
import TreeCoverLayer from "./tree-cover-layer";

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
  treeCover: boolean;
  routeResult: RouteResult | null;
  routeDest: { lat: number; lng: number } | null;
  routeStart: { lat: number; lng: number } | null;
  picking: boolean;
  onMapPick: (lat: number, lng: number) => void;
  onDisengageFollow: () => void;
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
  treeCover,
  routeResult,
  routeDest,
  routeStart,
  picking,
  onMapPick,
  onDisengageFollow,
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
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={20}
      />
      {/* the smooth block-level fill, with the per-street lines drawn over it */}
      {treeCover ? <TreeCoverLayer /> : null}
      {treeCover ? <StreetScoreLayer /> : null}
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
      />
      {picking ? <PickCatcher onMapPick={onMapPick} /> : null}
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
