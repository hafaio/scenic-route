import {
  decodeStreetChunk,
  type StreetSegment as Segment,
} from "../streets/chunk";
import {
  PALETTES,
  ROAD_OPACITY,
  rampCss,
  type ThemeName,
} from "../theme/palette";
import { resolveUrl } from "./base-url";
import { projectX, projectY, unproject } from "./mercator";
import type { StreetScoreParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { themeName } from "./theme";

// One chunk per z12 tile, fetched lazily. layout: scripts/README.md
// Relative, so it picks up the basePath the deploy injects; the app is a single-route SPA.
const CHUNK_URL = "streets/{x}/{y}.bin";
const CHUNK_ZOOM = 12;
const SIDES = 2;

const TILE_SIZE = 256;
const EQUATOR_METERS_PER_PIXEL = 156_543.033_92; // web mercator, at the equator, at z0

// Lines read as street width, so they grow with zoom: about 1.5 px at z13, 5 px at z17. Anchored at
// the layer's own minZoom (components/street-score-layer.tsx).
const WIDTH_ANCHOR_ZOOM = 13;
const BASE_WIDTH = 1.5;
const WIDTH_PER_ZOOM = 1.32;

// Density is quantized into levels so the pieces of a road that share one can be stroked as
// a single path. 32 levels is finer than the alpha curve resolves on a 2 px line, so the
// gradient along a road still reads as continuous.
const LEVEL_BITS = 3;
const LEVELS = 256 >> LEVEL_BITS;

// Both themes' levels, built once each: a theme flip redraws every tile, and rebuilding 32 CSS
// strings per tile to answer a question that has two answers is not worth doing.
const COLORS: Record<ThemeName, readonly string[]> = {
  light: levels("light"),
  dark: levels("dark"),
};

function levels(theme: ThemeName): readonly string[] {
  return Array.from({ length: LEVELS }, (_unused, level) =>
    rampCss(
      PALETTES[theme].canopy,
      ((level << LEVEL_BITS) + (1 << (LEVEL_BITS - 1))) / 255,
      ROAD_OPACITY[theme],
    ),
  );
}

const chunks = new Map<string, Promise<Segment[]>>();

// The unit normal at each projected vertex, pointing at the *left* sidewalk. Left is 90 degrees
// counter-clockwise of the direction of travel — CSCL's own l_/r_ convention, and the side the
// first of a vertex's two density bytes carries — and canvas y runs south, so on screen that is
// (ty, -tx): the left of an eastbound street points up. The tangent is the central difference of
// the nearest *distinct* neighbours, one-sided at the ends, since two vertices of the source
// geometry can sit closer together than the 0.1 m the coordinates are quantized to.
function leftNormals(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
  normalXs: Float64Array,
  normalYs: Float64Array,
): void {
  const same = (left: number, right: number): boolean =>
    xs[left] === xs[right] && ys[left] === ys[right];
  for (let vertex = 0; vertex < count; vertex++) {
    let back = vertex;
    while (back > 0 && same(back, vertex)) {
      back -= 1;
    }
    let ahead = vertex;
    while (ahead + 1 < count && same(ahead, vertex)) {
      ahead += 1;
    }
    const tangentX = xs[ahead] - xs[back];
    const tangentY = ys[ahead] - ys[back];
    // A vertex every neighbour has collapsed onto has no side to take: its two lines meet on the
    // centreline, rather than carrying a NaN into the path.
    const length = Math.hypot(tangentX, tangentY) || 1;
    normalXs[vertex] = tangentY / length;
    normalYs[vertex] = -tangentX / length;
  }
}

// One in-flight fetch per chunk, shared by every tile that needs it. A 404 is an answer —
// the tile is all water, and caches as empty — but any other failure drops the entry, so
// the next tile over this chunk goes back for it.
function loadChunk(tileX: number, tileY: number): Promise<Segment[]> {
  const key = `${tileX}/${tileY}`;
  const pending = chunks.get(key);
  if (pending) {
    return pending;
  } else {
    const url = resolveUrl(
      CHUNK_URL.replace("{x}", String(tileX)).replace("{y}", String(tileY)),
    );
    const request = fetch(url)
      .then(async (response) => {
        if (response.ok) {
          return decodeStreetChunk(await response.arrayBuffer());
        } else if (response.status === 404) {
          return [];
        } else {
          throw new Error(`${url}: ${response.status} ${response.statusText}`);
        }
      })
      .catch((error: unknown) => {
        chunks.delete(key);
        throw error;
      });
    chunks.set(key, request);
    return request;
  }
}

function load(
  _params: StreetScoreParams,
  coords: TileCoords,
): Promise<Segment[]> {
  const shift = coords.z - CHUNK_ZOOM;
  return loadChunk(coords.x >> shift, coords.y >> shift);
}

// Projected at the tile's own zoom, so the lines stay crisp however far in the map goes.
// A street is two lines, one per sidewalk, each quantized into its own level; each piece
// takes the level its two ends average to, and the pieces are gathered into one path per
// level, so a tile costs a stroke per level rather than per piece. Runs meet butt to butt:
// two translucent strokes overlapping would bead.
function draw(
  context: OffscreenCanvasRenderingContext2D,
  segments: Segment[],
  coords: TileCoords,
): void {
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const width = BASE_WIDTH * WIDTH_PER_ZOOM ** (coords.z - WIDTH_ANCHOR_ZOOM);
  const center = unproject(
    originX + TILE_SIZE / 2,
    originY + TILE_SIZE / 2,
    coords.z,
  );
  const metersPerPixel =
    (EQUATOR_METERS_PER_PIXEL * Math.cos((center.lat * Math.PI) / 180)) /
    2 ** coords.z;

  context.lineCap = "butt";
  context.lineJoin = "round";
  context.lineWidth = width;

  const paths: (Path2D | undefined)[] = new Array(LEVELS);
  const longest = segments.reduce(
    (most, segment) => Math.max(most, segment.lngs.length),
    0,
  );
  const xs = new Float64Array(longest);
  const ys = new Float64Array(longest);
  const normalXs = new Float64Array(longest);
  const normalYs = new Float64Array(longest);

  for (const { lngs, lats, densities, offsetMeters, stranded } of segments) {
    // A green line here is an offer to walk somewhere pleasant, so a path the routing graph dropped
    // has no business being one: the router would answer with a way round it, or nothing at all.
    if (stranded) {
      continue;
    }
    // The two sidewalks of a street are ~14 m apart, which at z13 is one pixel: drawn true to
    // the ground they would merge into the single line this layer exists to take apart. So the
    // separation is a screen-space decision, never baked into the data — floored at a stroke
    // width, which the true offset overtakes around z16, from where the exaggeration dissolves
    // on its own as the map zooms in.
    const offsetPx =
      offsetMeters > 0 ? Math.max(offsetMeters / metersPerPixel, width) : 0;
    const margin = width + offsetPx;
    let low = Number.POSITIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      xs[vertex] = projectX(lngs[vertex], coords.z) - originX;
      ys[vertex] = projectY(lats[vertex], coords.z) - originY;
      left = Math.min(left, xs[vertex]);
      right = Math.max(right, xs[vertex]);
      low = Math.min(low, ys[vertex]);
      high = Math.max(high, ys[vertex]);
    }
    // The chunk covers a whole z12 tile, so most of its segments miss this one. A segment
    // can cross the tile between two vertices that are both outside it, so the test is on
    // its box rather than on its vertices.
    const overlaps =
      right >= -margin &&
      left <= TILE_SIZE + margin &&
      high >= -margin &&
      low <= TILE_SIZE + margin;
    if (!overlaps) {
      continue;
    }
    leftNormals(xs, ys, lngs.length, normalXs, normalYs);

    // A path or a boardwalk has no offset: it is drawn as the one line it is, and its two
    // densities are the same sample anyway.
    const sides = offsetMeters > 0 ? SIDES : 1;
    for (let side = 0; side < sides; side++) {
      const away = side === 0 ? offsetPx : -offsetPx;
      let run = -1;
      for (let piece = 0; piece + 1 < lngs.length; piece++) {
        const level =
          (densities[SIDES * piece + side] +
            densities[SIDES * (piece + 1) + side]) >>
          (LEVEL_BITS + 1);
        if (level === 0) {
          run = -1;
          continue;
        }
        let path = paths[level];
        if (!path) {
          path = new Path2D();
          paths[level] = path;
        }
        if (level !== run) {
          path.moveTo(
            xs[piece] + away * normalXs[piece],
            ys[piece] + away * normalYs[piece],
          );
        }
        path.lineTo(
          xs[piece + 1] + away * normalXs[piece + 1],
          ys[piece + 1] + away * normalYs[piece + 1],
        );
        run = level;
      }
    }
  }

  const colors = COLORS[themeName()];
  for (let level = 1; level < LEVELS; level++) {
    const path = paths[level];
    if (path) {
      context.strokeStyle = colors[level];
      context.stroke(path);
    }
  }
}

export const streetScoreRenderer: TileRenderer<StreetScoreParams, Segment[]> = {
  load,
  draw,
};
