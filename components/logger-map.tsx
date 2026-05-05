"use client";

import L from "leaflet";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
import { useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  Marker,
  TileLayer,
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

// PNG imports are a union: Webpack/`next build` returns StaticImageData,
// Turbopack-dev sometimes returns a plain URL string. Normalize both.
function toUrl(asset: string | { src: string }): string {
  return typeof asset === "string" ? asset : asset.src;
}

// Leaflet's auto-detection of its image path breaks under bundlers. Skip the
// L.Icon.Default dance entirely and hand each Marker an explicit Icon built
// from bundler-emitted asset URLs.
const savedIcon = new L.Icon({
  iconUrl: toUrl(iconUrl),
  iconRetinaUrl: toUrl(iconRetinaUrl),
  shadowUrl: toUrl(shadowUrl),
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  tooltipAnchor: [16, -28],
  shadowSize: [41, 41],
});

const draftIcon = L.divIcon({
  className: "scenic-draft-marker",
  html: '<div class="scenic-draft-marker-dot"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
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
        />
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
