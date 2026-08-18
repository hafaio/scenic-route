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

// The placed labels bucketed by `${tileX},${tileY}`, which is both the draw index and the collision
// index — two overlapping boxes always share a tile.
export type PlacedLabels = Map<string, PlacedLabel[]>;

export interface LabelPoints {
  lngs: ArrayLike<number>;
  lats: ArrayLike<number>;
  names: readonly string[]; // per point, its label ("" for a point the source named none for)
}

// Greedy placement over the whole point set at one zoom, in the set's own order and in world pixels:
// no part of it depends on which tile asked, so every tile agrees on which labels survive and where.
// `radius` is the marker the text is set beside, and `above` which side of it the text sits — two
// layers labelling the same place can take opposite sides and never collide.
export function placeLabels(
  context: OffscreenCanvasRenderingContext2D,
  { lngs, lats, names }: LabelPoints,
  zoom: number,
  radius: number,
  above: boolean,
): PlacedLabels {
  context.font = LABEL_FONT;
  const byTile: PlacedLabels = new Map();
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
    const x = markerX + radius + LABEL_GAP_PX;
    const y = above ? markerY - radius : markerY + radius;
    const width = context.measureText(text).width;
    const label: PlacedLabel = {
      text,
      x,
      y,
      x0: x,
      y0: above ? y - LABEL_LINE_HEIGHT : y,
      x1: x + width,
      y1: above ? y : y + LABEL_LINE_HEIGHT,
    };
    const tileX0 = Math.floor(label.x0 / TILE_SIZE);
    const tileX1 = Math.floor(label.x1 / TILE_SIZE);
    const tileY0 = Math.floor(label.y0 / TILE_SIZE);
    const tileY1 = Math.floor(label.y1 / TILE_SIZE);
    let clashes = false;
    for (let tileX = tileX0; tileX <= tileX1 && !clashes; tileX++) {
      for (let tileY = tileY0; tileY <= tileY1 && !clashes; tileY++) {
        const bucket = byTile.get(`${tileX},${tileY}`);
        clashes =
          bucket?.some(
            (other) =>
              label.x0 < other.x1 &&
              label.x1 > other.x0 &&
              label.y0 < other.y1 &&
              label.y1 > other.y0,
          ) ?? false;
      }
    }
    if (clashes) {
      continue;
    }
    for (let tileX = tileX0; tileX <= tileX1; tileX++) {
      for (let tileY = tileY0; tileY <= tileY1; tileY++) {
        const key = `${tileX},${tileY}`;
        const bucket = byTile.get(key);
        if (bucket) {
          bucket.push(label);
        } else {
          byTile.set(key, [label]);
        }
      }
    }
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
