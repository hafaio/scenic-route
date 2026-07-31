"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { getResolvedDate, subscribeRouteTime } from "../src/route-time/store";
import { loadGraph, type RoutingGraph } from "../src/routing/graph";
import { loadSheds, type ShedHistory, shedDay } from "../src/routing/sheds";
import {
  forEachDeckIn,
  type ShedDecks,
  shedDecks,
  traceDeck,
} from "../src/tiles/shed-decks";
import manifest from "../src/tree-cover/manifest.json";

// The "Scaffolding" overlay: every sidewalk shed standing on the map's picked DATE, drawn as the
// stretch of sidewalk it decks over. The SHED artifact (src/routing/sheds.ts) carries eight and a
// half years of them as spans along GRPH edges, so scrubbing the date picker back re-reads the
// history rather than re-fetching anything.
//
// The deck geometry is src/tiles/shed-decks.ts's, which the shade layer casts the decks' shadows
// from — so a band and the shadow leaving it cannot disagree. A deck arrives as the polygon it
// covers, already pinned between the building line and the kerb at its own measured depth, so this
// only scales it into the tile and fills it. Where that depth falls under a pixel the minimum width
// opens the band out instead of dropping it.
//
// Everything is drawn on the main thread rather than in the tile worker: the graph and the artifact
// are both already there (the router reads them), and a day's ~13k spans project once into world
// coordinates, after which a tile is a scale and a bounding-box test.

const PANE_NAME = "sheds";
const PANE_Z_INDEX = 285; // above the commercial band (280), below the scenic lines (290)
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;
const TILE_SIZE = 256;

const MIN_WIDTH = 1.5; // px, so a city-wide view still shows where the scaffolding is
const SHED_COLOR = "#ea580c"; // orange-600, construction against the map's greens and blues
const SHED_ALPHA = 0.75; // the basemap's street still reads through the band

// Zoom 0 is the whole world in 256 px, which a double resolves far past z20.
const REFERENCE_ZOOM = 0;

const [city] = manifest.cities;

class ShedGrid extends L.GridLayer {
  private decks: ShedDecks | null = null;

  setDecks(decks: ShedDecks): void {
    this.decks = decks;
    this.redraw();
  }

  createTile(coords: L.Coords): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = window.devicePixelRatio || 1;
    tile.width = TILE_SIZE * ratio;
    tile.height = TILE_SIZE * ratio;
    const context = tile.getContext("2d");
    if (context && this.decks) {
      context.scale(ratio, ratio);
      this.draw(context, this.decks, coords);
    }
    return tile;
  }

  // One Path2D for the whole tile, filled once. The decks are short and there are thousands of them,
  // so a fill each would cost far more than the geometry does — and one nonzero fill also unions two
  // sheds that overlap, which separate fills would darken twice over.
  private draw(
    context: CanvasRenderingContext2D,
    decks: ShedDecks,
    coords: L.Coords,
  ): void {
    const scale = 2 ** (coords.z - REFERENCE_ZOOM);
    // The tile's own window in reference units, widened by half the minimum width so a deck just
    // outside it still paints the sliver of itself that reaches in. The boxes are the rings' own, so
    // each deck's depth is already in them and only the opening out has anything left to add.
    const margin = MIN_WIDTH / 2 / scale;
    const left = (coords.x * TILE_SIZE) / scale - margin;
    const top = (coords.y * TILE_SIZE) / scale - margin;
    const right = left + TILE_SIZE / scale + 2 * margin;
    const bottom = top + TILE_SIZE / scale + 2 * margin;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;

    const path = new Path2D();
    forEachDeckIn(decks, left, top, right, bottom, (deck) => {
      traceDeck(path, decks, deck, scale, originX, originY, MIN_WIDTH);
    });

    context.globalAlpha = SHED_ALPHA;
    context.fillStyle = SHED_COLOR;
    context.fill(path);
  }
}

export default function ShedLayer() {
  const map = useMap();

  useEffect(() => {
    // A dedicated pane, so the dark-mode tile-pane invert leaves the orange true.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }
    const grid = new ShedGrid({
      pane: PANE_NAME,
      bounds: L.latLngBounds(
        [city.bounds.south, city.bounds.west],
        [city.bounds.north, city.bounds.east],
      ),
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      keepBuffer: 4,
    });
    grid.addTo(map);

    let cancelled = false;
    let graph: RoutingGraph | null = null;
    let history: ShedHistory | null = null;
    let drawnDay = Number.NaN; // no day drawn yet; every real day differs from it

    // The picked DATE chooses the standing set. The store also ticks with the wall clock and with
    // the hour slider, neither of which moves the day, so the rebuild is gated on the day itself.
    const apply = (): void => {
      if (!graph || !history) {
        return;
      }
      const day = shedDay(getResolvedDate());
      if (day === drawnDay) {
        return;
      }
      drawnDay = day;
      grid.setDecks(shedDecks(graph, history, day));
    };

    Promise.all([loadGraph(), loadSheds()]).then(
      ([loaded, sheds]) => {
        if (!cancelled) {
          graph = loaded;
          history = sheds;
          apply();
        }
      },
      () => {},
    );
    const unsubscribe = subscribeRouteTime(apply);

    return () => {
      cancelled = true;
      unsubscribe();
      grid.remove();
    };
  }, [map]);

  return null;
}
