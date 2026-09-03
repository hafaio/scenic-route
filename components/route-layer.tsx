"use client";

import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import { Marker, Polyline, useMap } from "react-leaflet";
import { CROSS_CITY_METERS } from "../src/cities";
import { FERRY_COLOR } from "../src/overlays/colors";
import { edgeKind, type RoutingGraph, subEdgePath } from "../src/routing/graph";
import type { RouteResult, RouteStep } from "../src/routing/search";
import type { Snap } from "../src/routing/snap";
import { currentTheme } from "../src/theme/current";
import CanvasGrid from "../src/tiles/canvas-grid";
import { KEEP_BUFFER, tileRatio } from "../src/tiles/raster";
import { repeatable } from "../src/tiles/repaint";
import { savedIcon, startIcon } from "./map-icons";

interface RouteLayerProps {
  result: RouteResult | null;
  // The graph `result` was computed against, handed down rather than fetched here. Both are edge
  // indices into one city's graph, and a layer that loads its own would draw a San Francisco route
  // through New York's edges for as long as the two disagreed — which is the whole span of a city
  // switch, since the result lands before the new fetch does.
  graph: RoutingGraph | null;
  dest: { lat: number; lng: number } | null; // the tapped/searched destination
  start: { lat: number; lng: number } | null; // the snapped start, for the dot
  dragging: boolean; // an endpoint is being dragged; reframe zooms out only, never in
  // A destination that arrived from a shared link alongside its own camera, so the shared framing is
  // kept instead of being reframed away the moment the route lands.
  preframedDest: { lat: number; lng: number } | null;
  onDisengageFollow: () => void;
  // Live position of a dragged endpoint, each frame: re-routes without reverse-geocoding.
  onEndpointDragMove: (
    which: "start" | "dest",
    lat: number,
    lng: number,
  ) => void;
  // Drop of a dragged endpoint: settles that end and reverse-geocodes its label.
  onEndpointDrag: (which: "start" | "dest", lat: number, lng: number) => void;
}

const TILE_SIZE = 256;
const PANE_NAME = "route";
const PANE_Z_INDEX = 450; // above tiles (~200), below markers (~600)
const MIN_ZOOM = 3;
const MAX_ZOOM = 20;

// Keep a dragged endpoint this far from the viewport edge; Leaflet auto-pans the map to hold it there.
const DRAG_AUTOPAN_PADDING: [number, number] = [80, 80];

// The line reads as a route ribbon: ~4.5 px at z16, growing with zoom like the street layer, drawn
// as a neutral slate core inside a white casing. A neutral route reads clearly over the canopy — or
// any future overlay — without competing with its colour, and the white halo lifts it off the map.
const WIDTH_AT_Z16 = 4.5;
const WIDTH_PER_ZOOM = 1.3;
const MIN_WIDTH = 2.5;
const CASING_EXTRA = 3; // white halo, ~1.5 px each side

const ROUTE_COLOR = "#334155"; // slate-700: a neutral route that reads over any overlay colour
const CASING_COLOR = "#ffffff";
const CONNECTOR_COLOR = "#94a3b8"; // slate-400
const CONNECTOR_MIN_METERS = 15; // draw the dashed tapped->snapped link only past this gap

const EARTH_RADIUS_METERS = 6_371_000;

function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const toRad = Math.PI / 180;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const deltaLat = (bLat - aLat) * toRad;
  const deltaLng = (bLng - aLng) * toRad;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const inner =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(inner)));
}

// A per-step polyline in travel order. Every kind now draws its stored geometry as-is: a sidewalk's
// baked offset already runs corner-to-corner on its own side, and a crossing or link is the straight
// corner-to-corner line edgePath synthesizes, so there is no draw-time offset to apply.
interface DrawStep {
  lngs: Float64Array;
  lats: Float64Array;
  ferry: boolean; // a ferry leg, stroked in blue instead of the neutral walked line
}

// The a -> b along-distance bounds this step actually walked, so the end edges are trimmed at the
// snap projections rather than drawn all the way to the intersection.
function stepBounds(
  graph: RoutingGraph,
  step: RouteStep,
  index: number,
  stepCount: number,
  start: Snap,
  dest: Snap,
): [number, number] {
  const edgeLength = graph.edgeLength[step.edge];
  if (stepCount === 1 && start.edge === dest.edge) {
    return [
      Math.min(start.metersFromA, dest.metersFromA),
      Math.max(start.metersFromA, dest.metersFromA),
    ];
  }
  if (index === 0) {
    // the start edge, departed through node b (forward) or node a (reverse)
    return step.forward
      ? [start.metersFromA, edgeLength]
      : [0, start.metersFromA];
  }
  if (index === stepCount - 1) {
    // the dest edge, reached through node a (forward) or node b (reverse)
    return step.forward
      ? [0, dest.metersFromA]
      : [dest.metersFromA, edgeLength];
  }
  return [0, edgeLength];
}

function buildDrawSteps(graph: RoutingGraph, result: RouteResult): DrawStep[] {
  const draw: DrawStep[] = [];
  const stepCount = result.steps.length;
  for (let index = 0; index < stepCount; index++) {
    const step = result.steps[index];
    const [fromMeters, toMeters] = stepBounds(
      graph,
      step,
      index,
      stepCount,
      result.start,
      result.dest,
    );
    const clipped = subEdgePath(graph, step.edge, fromMeters, toMeters);
    // The clip runs a -> b; reverse it into travel order so the ribbon flows the way it is walked.
    const lngs = step.forward ? clipped.lngs : [...clipped.lngs].reverse();
    const lats = step.forward ? clipped.lats : [...clipped.lats].reverse();
    if (lngs.length < 2) {
      continue;
    }
    draw.push({
      lngs: Float64Array.from(lngs),
      lats: Float64Array.from(lats),
      ferry: edgeKind(graph, step.edge) === "ferry",
    });
  }
  return draw;
}

class RouteGrid extends CanvasGrid {
  private drawSteps: DrawStep[] = [];

  setDrawSteps(steps: DrawStep[]): void {
    this.drawSteps = steps;
    this.redraw();
  }

  createTile(coords: L.Coords): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = tileRatio();
    tile.width = TILE_SIZE * ratio;
    tile.height = TILE_SIZE * ratio;
    const context = tile.getContext("2d");
    if (context && this.drawSteps.length > 0) {
      this.watch(
        tile,
        repeatable(context, ratio, (target) => {
          this.draw(target, coords);
        }),
      );
    }
    return tile;
  }

  // Casing across every step first, then the coloured lines, so the round joins meet seamlessly
  // rather than each step's casing overpainting its neighbour's fill. Ferry legs collect into their
  // own path and stroke blue over the same shared casing, so a walk<->ferry junction stays clean.
  private draw(context: CanvasRenderingContext2D, coords: L.Coords): void {
    const map = this._map;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;
    const width = Math.max(
      MIN_WIDTH,
      WIDTH_AT_Z16 * WIDTH_PER_ZOOM ** (coords.z - 16),
    );
    const walkPath = new Path2D();
    const ferryPath = new Path2D();
    let longest = 0;
    for (const step of this.drawSteps) {
      longest = Math.max(longest, step.lngs.length);
    }
    const xs = new Float64Array(longest);
    const ys = new Float64Array(longest);

    for (const step of this.drawSteps) {
      const count = step.lngs.length;
      const margin = width;
      let low = Number.POSITIVE_INFINITY;
      let left = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      for (let vertex = 0; vertex < count; vertex++) {
        const point = map.project(
          L.latLng(step.lats[vertex], step.lngs[vertex]),
          coords.z,
        );
        xs[vertex] = point.x - originX;
        ys[vertex] = point.y - originY;
        left = Math.min(left, xs[vertex]);
        right = Math.max(right, xs[vertex]);
        low = Math.min(low, ys[vertex]);
        high = Math.max(high, ys[vertex]);
      }
      const overlaps =
        right >= -margin &&
        left <= TILE_SIZE + margin &&
        high >= -margin &&
        low <= TILE_SIZE + margin;
      if (!overlaps) {
        continue;
      }
      const path = step.ferry ? ferryPath : walkPath;
      path.moveTo(xs[0], ys[0]);
      for (let vertex = 1; vertex < count; vertex++) {
        path.lineTo(xs[vertex], ys[vertex]);
      }
    }

    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = width + CASING_EXTRA;
    context.strokeStyle = CASING_COLOR;
    context.stroke(walkPath);
    context.stroke(ferryPath);
    context.lineWidth = width;
    context.strokeStyle = ROUTE_COLOR;
    context.stroke(walkPath);
    context.strokeStyle = FERRY_COLOR[currentTheme()];
    context.stroke(ferryPath);
  }
}

function routeBounds(result: RouteResult): L.LatLngBounds {
  const { lats, lngs } = result.path;
  const bounds = L.latLngBounds([lats[0], lngs[0]], [lats[0], lngs[0]]);
  for (let vertex = 1; vertex < lats.length; vertex++) {
    bounds.extend([lats[vertex], lngs[vertex]]);
  }
  return bounds;
}

export default function RouteLayer({
  result,
  graph,
  dest,
  start,
  dragging,
  preframedDest,
  onDisengageFollow,
  onEndpointDragMove,
  onEndpointDrag,
}: RouteLayerProps) {
  const map = useMap();
  const gridRef = useRef<RouteGrid | null>(null);
  // The dest object last framed by the camera; a slider recompute keeps its identity, a new
  // destination replaces it, so only the latter re-frames.
  const framedDest = useRef<{ lat: number; lng: number } | null>(preframedDest);

  useEffect(() => {
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }
    const grid = new RouteGrid({
      pane: PANE_NAME,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      keepBuffer: KEEP_BUFFER,
    });
    gridRef.current = grid;
    grid.addTo(map);
    return () => {
      grid.remove();
      gridRef.current = null;
    };
  }, [map]);

  const drawSteps = useMemo(
    () => (graph && result ? buildDrawSteps(graph, result) : []),
    [graph, result],
  );

  useEffect(() => {
    gridRef.current?.setDrawSteps(drawSteps);
  }, [drawSteps]);

  // Frame a fresh destination once its route lands; slider recomputes leave the camera alone. While an
  // endpoint is dragged we leave the camera to the marker's own autoPan (below) — any programmatic
  // view change mid-drag desyncs the pin from the cursor — and just remember the dest so releasing the
  // drag doesn't snap-reframe the settled route.
  useEffect(() => {
    if (!dest) {
      // Cleared, so the next destination reframes even if it lands on the same coordinates.
      framedDest.current = null;
      return;
    }
    if (!result) {
      return;
    }
    if (dragging) {
      framedDest.current = dest;
      return;
    }
    if (
      framedDest.current &&
      framedDest.current.lat === dest.lat &&
      framedDest.current.lng === dest.lng
    ) {
      return;
    }
    framedDest.current = dest;
    const bounds = routeBounds(result);
    const padding: [number, number] = [64, 96];
    // A route in the city on screen is flown to; one a city away is cut to, for the reason
    // CROSS_CITY_METERS carries — an animated crossing draws this very layer over open water for the
    // length of it. This is the third camera that can cross a city, after the explicit target and the
    // follow centring, and it is the one a shared link reaches first.
    if (map.distance(bounds.getCenter(), map.getCenter()) > CROSS_CITY_METERS) {
      map.fitBounds(bounds, { padding, animate: false });
    } else {
      map.flyToBounds(bounds, { padding });
    }
    onDisengageFollow();
  }, [result, dest, map, dragging, onDisengageFollow]);

  const snappedDest = result?.dest.point ?? null;
  const showConnector =
    dest && snappedDest
      ? haversineMeters(dest.lat, dest.lng, snappedDest.lat, snappedDest.lng) >
        CONNECTOR_MIN_METERS
      : false;

  return (
    <>
      {start ? (
        <Marker
          position={[start.lat, start.lng]}
          icon={startIcon}
          draggable
          autoPan
          autoPanPadding={DRAG_AUTOPAN_PADDING}
          // Above the live-location marker (which renders later at the same spot) so the start always
          // owns the drag gesture; otherwise the location marker can swallow it and strand the drag.
          zIndexOffset={1000}
          eventHandlers={{
            drag: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onEndpointDragMove("start", lat, lng);
            },
            dragend: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onEndpointDrag("start", lat, lng);
            },
          }}
        />
      ) : null}
      {dest ? (
        <Marker
          position={[dest.lat, dest.lng]}
          icon={savedIcon}
          draggable
          autoPan
          autoPanPadding={DRAG_AUTOPAN_PADDING}
          eventHandlers={{
            drag: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onEndpointDragMove("dest", lat, lng);
            },
            dragend: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onEndpointDrag("dest", lat, lng);
            },
          }}
        />
      ) : null}
      {showConnector && dest && snappedDest ? (
        <Polyline
          positions={[
            [dest.lat, dest.lng],
            [snappedDest.lat, snappedDest.lng],
          ]}
          pathOptions={{
            color: CONNECTOR_COLOR,
            weight: 2,
            dashArray: "4 5",
          }}
        />
      ) : null}
    </>
  );
}
