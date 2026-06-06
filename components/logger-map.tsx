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

export interface MapTarget {
  lat: number;
  lng: number;
  zoom?: number;
}

interface LoggerMapProps {
  pins: Pin[];
  draft: PinDraft | null;
  target: MapTarget | null;
  onMapClick: (lat: number, lng: number) => void;
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

function MapClickHandler({
  onMapClick,
}: {
  onMapClick: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(event) {
      onMapClick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

function MapFlyTo({ target }: { target: MapTarget | null }) {
  const map = useMap();
  const lastKey = useRef<string>("");
  useEffect(() => {
    if (!target) {
      // Reset so re-flying to the same coords (e.g. after a popup close)
      // isn't deduped against the last fly-to.
      lastKey.current = "";
      return;
    }
    const key = `${target.lat},${target.lng},${target.zoom ?? ""}`;
    if (key === lastKey.current) {
      return;
    }
    lastKey.current = key;
    map.flyTo([target.lat, target.lng], target.zoom ?? map.getZoom(), {
      duration: 0.8,
    });
  }, [target, map]);
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
  onMapClick,
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
      <MapClickHandler onMapClick={onMapClick} />
      <MapFlyTo target={target} />
      {markers}
      {draft ? (
        <Marker position={[draft.lat, draft.lng]} icon={draftIcon} />
      ) : null}
    </MapContainer>
  );
}
