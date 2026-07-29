"use client";

import L from "leaflet";
import { Fragment, useEffect, useMemo, useRef } from "react";
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
  activeOverlays: ReadonlySet<OverlayId>;
  routeResult: RouteResult | null;
  routeDest: { lat: number; lng: number } | null;
  routeStart: { lat: number; lng: number } | null;
  picking: boolean;
  dragging: boolean; // an endpoint marker is being dragged; the route reframe goes zoom-out-only
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

// Leaflet's private zoom plumbing, which @types/leaflet doesn't expose.
interface MapZoomInternals {
  _stop(): void;
  _move(
    center: L.LatLng,
    zoom: number,
    data: { pinch: boolean; round: boolean },
  ): void;
  _animateZoom(
    center: L.LatLng,
    zoom: number,
    startAnim: boolean,
    noUpdate: number | boolean,
  ): void;
  _limitZoom(zoom: number): number;
}

// Leaflet 1.9 dropped its touch `tap` handler, so this restores double-tap zoom and adds Android's
// quick zoom: hold the second tap and drag, down to zoom in. The drag mirrors Map.TouchZoom, hence
// the private calls. preventDefault on the second tap suppresses the browser's own double-tap zoom
// and the synthesised dblclick.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 40; // px between the two taps
const TAP_MOVE_SLOP = 12; // px a tap may drift and still count as a tap rather than a drag
const ZOOM_PX_PER_LEVEL = 128; // matching MapLibre's quick zoom

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
    const internals = map as unknown as MapZoomInternals;
    let lastTap: { time: number; at: L.Point } | null = null;
    let start: L.Point | null = null; // null when the touch began somewhere we must not zoom from
    let fingers = 0;
    let armed = false;
    let dragSuspended = false;
    let anchor: { latLng: L.LatLng; at: L.Point } | null = null;
    let zoomFrom: { zoom: number; clientY: number } | null = null;
    let gesture: { zoom: number; center: L.LatLng } | null = null;
    let animFrame: number | undefined;

    const screenPoint = ({ clientX, clientY }: Touch): L.Point =>
      L.point(clientX, clientY);

    const containerPoint = (touch: Touch): L.Point => {
      const { left, top } = container.getBoundingClientRect();
      return screenPoint(touch).subtract(L.point(left, top));
    };

    const reset = () => {
      armed = false;
      anchor = null;
      zoomFrom = null;
      gesture = null;
      if (animFrame !== undefined) {
        L.Util.cancelAnimFrame(animFrame);
        animFrame = undefined;
      }
      if (dragSuspended) {
        dragSuspended = false;
        map.dragging.enable();
      }
    };

    // no-op unless a quick zoom ran, in which case it settles on an integer zoom
    const end = () => {
      const settled = gesture;
      reset();
      if (settled) {
        const { center } = settled;
        const zoom = internals._limitZoom(settled.zoom);
        if (map.options.zoomAnimation) {
          internals._animateZoom(center, zoom, true, map.options.zoomSnap ?? 1);
        } else {
          map.setView(center, zoom, { animate: false });
        }
      }
    };

    const onStart = (event: TouchEvent) => {
      fingers = event.touches.length;
      if (fingers !== 1) {
        end(); // pinch is taking over; don't leave our move dangling
        lastTap = null;
      } else {
        const [touch] = event.touches;
        // a draggable marker has its own Draggable, which map.dragging doesn't cover, so zooming
        // from a route endpoint would drag the pin at the same time
        const onMarker =
          touch.target instanceof Element &&
          touch.target.closest(".leaflet-marker-draggable") !== null;
        start = onMarker ? null : screenPoint(touch);
        if (
          start &&
          lastTap &&
          event.timeStamp - lastTap.time < DOUBLE_TAP_MS &&
          start.distanceTo(lastTap.at) < DOUBLE_TAP_SLOP
        ) {
          lastTap = null;
          armed = true;
          // while following, anchor on the centre so the zoom can't drift off the user
          const at = following
            ? map.getSize().divideBy(2)
            : containerPoint(touch);
          anchor = { at, latLng: map.containerPointToLatLng(at) };
        }
      }
    };

    const onMove = (event: TouchEvent) => {
      if (
        !armed ||
        picking ||
        !anchor ||
        !start ||
        event.touches.length !== 1
      ) {
        return;
      }
      const [touch] = event.touches;
      if (!zoomFrom) {
        // beat Leaflet's Draggable to its own 3px tolerance — ours is on the container, its on the
        // document — so nothing pans and no dragstart fires to disengage follow
        if (!dragSuspended) {
          dragSuspended = true;
          map.dragging.disable();
        }
        if (screenPoint(touch).distanceTo(start) <= TAP_MOVE_SLOP) {
          return;
        }
        zoomFrom = { zoom: map.getZoom(), clientY: touch.clientY };
        internals._stop();
        map.fire("zoomstart").fire("movestart");
      }
      const target =
        zoomFrom.zoom + (touch.clientY - zoomFrom.clientY) / ZOOM_PX_PER_LEVEL;
      // bounceAtZoomLimits is off, so clamp; _limitZoom would snap mid-gesture
      const zoom = Math.max(
        map.getMinZoom(),
        Math.min(map.getMaxZoom(), target),
      );
      // offset the anchor's projected position so it stays under the pixel it was tapped at
      const center = map.unproject(
        map
          .project(anchor.latLng, zoom)
          .subtract(anchor.at.subtract(map.getSize().divideBy(2))),
        zoom,
      );
      gesture = { zoom, center };
      if (animFrame !== undefined) {
        L.Util.cancelAnimFrame(animFrame);
      }
      animFrame = L.Util.requestAnimFrame(
        () => {
          internals._move(center, zoom, { pinch: true, round: false });
        },
        undefined,
        true,
      );
      event.preventDefault();
    };

    const onEnd = (event: TouchEvent) => {
      if (zoomFrom) {
        event.preventDefault();
        end();
        lastTap = null;
      } else if (armed) {
        const tapped = anchor;
        end();
        lastTap = null;
        event.preventDefault();
        if (tapped && !picking) {
          map.setZoomAround(tapped.latLng, map.getZoom() + 1, {
            animate: true,
          });
        }
      } else if (fingers > 1 || event.changedTouches.length !== 1) {
        // only a clean single-finger tap counts — not the lift-off of a pinch or a drag
        lastTap = null;
      } else {
        const [touch] = event.changedTouches;
        const at = screenPoint(touch);
        lastTap =
          start && at.distanceTo(start) <= TAP_MOVE_SLOP
            ? { time: event.timeStamp, at }
            : null;
      }
    };

    const onCancel = () => {
      end();
      lastTap = null;
    };

    container.addEventListener("touchstart", onStart, { passive: true });
    container.addEventListener("touchmove", onMove, { passive: false });
    container.addEventListener("touchend", onEnd, { passive: false });
    container.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      container.removeEventListener("touchstart", onStart);
      container.removeEventListener("touchmove", onMove);
      container.removeEventListener("touchend", onEnd);
      container.removeEventListener("touchcancel", onCancel);
      // end, not reset: a prop change mid-drag would otherwise strand the map on the gesture's
      // fractional zoom, which MapController then carries into every later flyTo
      end();
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
  activeOverlays,
  routeResult,
  routeDest,
  routeStart,
  picking,
  dragging,
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
        keepBuffer={4}
      />
      {/* every active overlay's Leaflet layers, from the registry; nothing when the set is empty */}
      {OVERLAYS.filter((overlay) => activeOverlays.has(overlay.id)).map(
        (overlay) => (
          <Fragment key={overlay.id}>{overlay.render()}</Fragment>
        ),
      )}
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
        dragging={dragging}
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
