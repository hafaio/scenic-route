import { projectX, projectY } from "./mercator";
import type { TileCoords } from "./protocol";

// Naming a set of map points without two names landing on each other, and without a name that
// straddles a tile seam disagreeing with itself across it. Shared by the POI dots (./poi) and the
// subway stations (./subway), which label different point sets exactly the same way.

const TILE_SIZE = 256;
// A generic stack, so the worker resolves it without any font plumbing.
const LABEL_FONT = "600 11px system-ui, sans-serif";
const LABEL_MAX_CHARS = 26; // long names truncate with an ellipsis so a box stays bounded
const LABEL_LINE_HEIGHT = 12;
const LABEL_GAP_PX = 3; // between the marker's edge and the start of the text

// One label the placement pass kept, in world pixels at its zoom: where to draw the text and the box
// that reserved the space.
export interface PlacedLabel {
  text: string;
  x: number;
  y: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// The placed labels bucketed by `${tileX},${tileY}`, which is the draw index; two boxes that
// overlap always share a tile, so the same bucketing serves as the collision index.
export type PlacedLabels = Map<string, PlacedLabel[]>;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Files a box under every tile it touches.
function occupy<Filed extends Box>(
  index: Map<string, Filed[]>,
  box: Filed,
): void {
  for (
    let tileX = Math.floor(box.x0 / TILE_SIZE);
    tileX <= Math.floor(box.x1 / TILE_SIZE);
    tileX++
  ) {
    for (
      let tileY = Math.floor(box.y0 / TILE_SIZE);
      tileY <= Math.floor(box.y1 / TILE_SIZE);
      tileY++
    ) {
      const key = `${tileX},${tileY}`;
      const bucket = index.get(key);
      if (bucket) {
        bucket.push(box);
      } else {
        index.set(key, [box]);
      }
    }
  }
}

function collides(index: Map<string, Box[]>, box: Box): boolean {
  for (
    let tileX = Math.floor(box.x0 / TILE_SIZE);
    tileX <= Math.floor(box.x1 / TILE_SIZE);
    tileX++
  ) {
    for (
      let tileY = Math.floor(box.y0 / TILE_SIZE);
      tileY <= Math.floor(box.y1 / TILE_SIZE);
      tileY++
    ) {
      const hit = index
        .get(`${tileX},${tileY}`)
        ?.some(
          (other) =>
            box.x0 < other.x1 &&
            box.x1 > other.x0 &&
            box.y0 < other.y1 &&
            box.y1 > other.y0,
        );
      if (hit) {
        return true;
      }
    }
  }
  return false;
}

export interface LabelPoints {
  lngs: ArrayLike<number>;
  lats: ArrayLike<number>;
  names: readonly string[]; // per point, its label ("" for a point the source named none for)
  // Per point, half the marker's width and height in CSS pixels, for a layer whose markers are not
  // all one size — the subway's route-bullet blocks run from one bullet wide to four by three.
  // Absent means `radius` in both directions, which is what a layer of equal dots wants.
  halfWidths?: ArrayLike<number>;
  halfHeights?: ArrayLike<number>;
}

// Greedy placement over the whole point set at one zoom, in the set's own order and in world pixels:
// no part of it depends on which tile asked, so every tile agrees on which labels survive and where.
// `radius` is the marker the text is set beside, and `above` which side of it the text sits — two
// layers labelling the same place can take opposite sides and never collide.
export function placeLabels(
  context: OffscreenCanvasRenderingContext2D,
  { lngs, lats, names, halfWidths, halfHeights }: LabelPoints,
  zoom: number,
  radius: number,
  above: boolean,
): PlacedLabels {
  context.font = LABEL_FONT;
  const byTile: PlacedLabels = new Map();
  // Every marker's own footprint, reserved before any text is placed, so a name never lands on a
  // neighbour's marker — which for the subway means covering the very bullets the marker is there
  // to show. Markers come first because they are drawn whether or not their name survives.
  const taken = new Map<string, Box[]>();
  for (let point = 0; point < names.length; point++) {
    const markerX = projectX(lngs[point], zoom);
    const markerY = projectY(lats[point], zoom);
    const halfWidth = halfWidths?.[point] ?? radius;
    const halfHeight = halfHeights?.[point] ?? radius;
    occupy(taken, {
      x0: markerX - halfWidth,
      y0: markerY - halfHeight,
      x1: markerX + halfWidth,
      y1: markerY + halfHeight,
    });
  }
  for (let point = 0; point < names.length; point++) {
    const raw = names[point];
    if (!raw) {
      continue;
    }
    const text =
      raw.length > LABEL_MAX_CHARS
        ? `${raw.slice(0, LABEL_MAX_CHARS - 1)}…`
        : raw;
    const markerX = projectX(lngs[point], zoom);
    const markerY = projectY(lats[point], zoom);
    const halfWidth = halfWidths?.[point] ?? radius;
    const halfHeight = halfHeights?.[point] ?? radius;
    const y = above ? markerY - halfHeight : markerY + halfHeight;
    const width = context.measureText(text).width;
    const at = (x: number): PlacedLabel => ({
      text,
      x,
      y,
      x0: x,
      y0: above ? y - LABEL_LINE_HEIGHT : y,
      x1: x + width,
      y1: above ? y : y + LABEL_LINE_HEIGHT,
    });
    // Right of the marker by preference, and left of it when that side is taken — which in a dense
    // downtown is most often by a neighbour's marker rather than by another name. Times Sq-42 St at
    // z15 is exactly that: its name only fits west, because 42 St-Bryant Pk sits 40 px east of it.
    const label = [
      at(markerX + halfWidth + LABEL_GAP_PX),
      at(markerX - halfWidth - LABEL_GAP_PX - width),
    ].find((candidate) => !collides(taken, candidate));
    if (!label) {
      continue;
    }
    occupy(taken, label);
    occupy(byTile, label);
  }
  return byTile;
}

// The labels one tile holds, drawn in tile coordinates from the shared placement: a dark-outlined
// name in the layer's colour. A label reaching over a seam belongs to both tiles and is drawn at the
// same world position by each, so the two clipped halves line up exactly.
export function drawLabels(
  context: OffscreenCanvasRenderingContext2D,
  placed: PlacedLabels,
  coords: TileCoords,
  color: string,
  above: boolean,
): void {
  const tile = placed.get(`${coords.x},${coords.y}`);
  if (!tile) {
    return;
  }
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  context.font = LABEL_FONT;
  context.textAlign = "left";
  context.textBaseline = above ? "bottom" : "top";
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.strokeStyle = "rgba(0, 0, 0, 0.75)";
  context.fillStyle = color;
  for (const { text, x, y } of tile) {
    context.strokeText(text, x - originX, y - originY);
    context.fillText(text, x - originX, y - originY);
  }
}
