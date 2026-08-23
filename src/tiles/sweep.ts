import { DECK_HEIGHT_METERS } from "../routing/sheds";
import { DISK_SAMPLES, type SunSample, sunSamples } from "../shade/sun";
import {
  type CasterChunk,
  casterManifest,
  chunksFor,
  EQUATOR_METERS_PER_PIXEL,
} from "./casters";
import { unproject } from "./mercator";
import type { ShadeParams, TileCoords } from "./protocol";
import {
  forEachDeckIn,
  NO_DECKS,
  type ShedDecks,
  traceDeck,
} from "./shed-decks";

// The other half of the shade overlay: past the baked pyramid's deepest level the shadows are
// GENERATED here, from the caster chunks (src/tiles/casters.ts), rather than magnified out of a raster
// that stopped resolving. The model is the one crates/tiler/src/shade.rs bakes and has to stay it, or
// the two halves would not join — a building is swept, a crown is swept slice by slice, both are
// punched by the footprints, and the alpha comes out on the same scale. Trunks are the one thing here that the
// pyramid has none of; they are a tenth of a pixel wide at the handoff, so the join survives them.
//
// Every polygon is emitted POSITIVELY WOUND so the nonzero fill unions them: a ring handed over the
// way it happened to be stored, or a parallelogram whose edge runs against the shadow, subtracts from
// the shadows it overlaps and leaves holes through the middle of a block.

export const TILE_SIZE = 256;
const DEGREES = Math.PI / 180;

// Keep in sync with SHADE_RGB and MAX_SHADE_ALPHA in crates/tiler/src/shade.rs.
export const SHADE_RGB: readonly [number, number, number] = [51, 65, 85];
export const MAX_SHADE_ALPHA = 190;
const SHADE_CSS = SHADE_RGB.join(", ");

// Where a crown starts, as a share of the tree's height: the foliage runs from there to the full
// height and its shadow is the union over that range — a long smear at a low sun rather than the
// outline moved sideways — so the chunks ship it as nested SLICES, each the cross-section the crown
// keeps over one band of heights, and each is swept between where that band's two ends land. Keep all
// three in sync with crates/tiler/src/crown.rs, which carries the justification and cuts the rings
// both halves read.
const CROWN_BASE_FRACTION = 0.4;
const CROWN_SEGMENTS = 4;
const CROWN_TIP_FRACTION = 0.99;
const SMEAR_PIXELS_PER_SEGMENT = 2;

// Vertices one swept run is allowed before it is cut and carried on. Keep in sync with MAX_SWEEP_RUN
// in crates/tiler/src/shade.rs.
const MAX_SWEEP_RUN = 16;

// The baked pyramid snaps the sun to one of 58 gridded bins; the sweep can use where it actually is,
// but switching at the handoff would slide a 100 m tower's shadow tip by up to 17.8 m in one zoom
// step. So the sweep starts from the BIN's position where the two meet and ramps to the true sun over
// this many levels, by which point a tile covers little enough ground that the move is small.
const RAMP_LEVELS = 2;
// Levels above the handoff from which the sun disk is worth sampling: at the handoff itself the six
// disk samples move a pixel by a mean 0.3/255 against the one crisp sample, and they are not free.
const PENUMBRA_LEVELS = 2;

// One tile's casters and the sun to sweep them from.
export interface SweptGround {
  chunks: CasterChunk[];
  decks: ShedDecks;
  samples: SunSample[];
  intensity: number;
  maxShadowMeters: number;
}

// The transform from the chunks' zoom-0 world pixels into one tile's own, and the scale a shadow
// length in metres becomes a displacement in them (Mercator is conformal, so one factor does both
// axes).
export interface Frame {
  scale: number;
  originX: number;
  originY: number;
  pixelsPerMeter: number;
}

// What the cast* loops emit their polygons into. `Path2D` is one; src/tiles/sweep-gl.ts hands them a
// sink that writes flat arrays for the GPU instead, which is the whole point of the split.
export interface PolygonSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

export function frameFor({
  x,
  y,
  z,
}: TileCoords): Frame & { latitude: number } {
  const originX = x * TILE_SIZE;
  const originY = y * TILE_SIZE;
  const centre = unproject(originX + TILE_SIZE / 2, originY + TILE_SIZE / 2, z);
  return {
    scale: 2 ** z,
    originX,
    originY,
    pixelsPerMeter:
      2 ** z / (EQUATOR_METERS_PER_PIXEL * Math.cos(centre.lat * DEGREES)),
    latitude: centre.lat,
  };
}

// Where the sweep's sun sits at this zoom: the bin's position at the handoff, the true one once the
// ramp has run. The azimuths are within a bin of each other, but the difference is taken the short way
// round regardless so a pair straddling north cannot spin the shadow the wrong way.
function rampedSun(
  {
    vectorZoom,
    binElevation,
    binAzimuth,
    sunElevation,
    sunAzimuth,
  }: ShadeParams,
  zoom: number,
): { elevation: number; azimuth: number } {
  const level = Math.min(1, Math.max(0, (zoom - vectorZoom) / RAMP_LEVELS));
  const turn = ((sunAzimuth - binAzimuth + 540) % 360) - 180;
  return {
    elevation: binElevation + (sunElevation - binElevation) * level,
    azimuth: binAzimuth + turn * level,
  };
}

// Trace one ring into the path, displaced by `shiftX`/`shiftY` tile pixels, reversed when its own
// winding is the negative one.
function traceRing(
  path: PolygonSink,
  points: Float64Array,
  from: number,
  to: number,
  forward: boolean,
  { scale, originX, originY }: Frame,
  shiftX: number,
  shiftY: number,
): void {
  for (let step = 0; step < to - from; step++) {
    const index = forward ? from + step : to - 1 - step;
    const x = points[index * 2] * scale - originX + shiftX;
    const y = points[index * 2 + 1] * scale - originY + shiftY;
    if (step === 0) {
      path.moveTo(x, y);
    } else {
      path.lineTo(x, y);
    }
  }
  path.closePath();
}

// The convex hull of a positively wound convex ring and its translate, in one pass: the two vertices
// extreme along the shadow's normal split the ring into the chain the shadow leaves behind and the
// chain it drags forward, and the swept hull is the first followed by the second displaced. Same
// polygon `convex_hull(ring ∪ shift(ring))` gives in crates/tiler/src/shade.rs, without the sort.
function traceSweptHull(
  path: PolygonSink,
  points: Float64Array,
  from: number,
  to: number,
  { scale, originX, originY }: Frame,
  baseX: number,
  baseY: number,
  shiftX: number,
  shiftY: number,
): void {
  const span = to - from;
  let ahead = from;
  let behind = from;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  // Measured from the hull's own first vertex: a building is ~1e-5 of a zoom-0 pixel across, so on
  // absolute coordinates the spread that picks the two chains would be lost in the rounding.
  const pivotX = points[from * 2];
  const pivotY = points[from * 2 + 1];
  for (let index = from; index < to; index++) {
    const along =
      (points[index * 2] - pivotX) * -shiftY +
      (points[index * 2 + 1] - pivotY) * shiftX;
    if (along > high) {
      high = along;
      ahead = index;
    }
    if (along < low) {
      low = along;
      behind = index;
    }
  }

  const chains: [number, number, number, number][] = [
    [ahead, behind, baseX, baseY],
    [behind, ahead, baseX + shiftX, baseY + shiftY],
  ];
  let started = false;
  for (const [start, stop, dx, dy] of chains) {
    let index = start;
    for (;;) {
      const x = points[index * 2] * scale - originX + dx;
      const y = points[index * 2 + 1] * scale - originY + dy;
      if (started) {
        path.lineTo(x, y);
      } else {
        path.moveTo(x, y);
        started = true;
      }
      if (index === stop) {
        break;
      }
      index = from + ((index - from + 1) % span);
    }
  }
  path.closePath();
}

// The parallelogram one edge sweeps out, wound positively however the edge runs against the shadow.
// This is where an inconsistent winding bites hardest: half a ring's edges run one way round.
function traceEdgeSweep(
  path: PolygonSink,
  points: Float64Array,
  first: number,
  second: number,
  { scale, originX, originY }: Frame,
  shiftX: number,
  shiftY: number,
): void {
  const x0 = points[first * 2] * scale - originX;
  const y0 = points[first * 2 + 1] * scale - originY;
  const x1 = points[second * 2] * scale - originX;
  const y1 = points[second * 2 + 1] * scale - originY;
  const corners: [number, number][] =
    (x1 - x0) * shiftY - (y1 - y0) * shiftX > 0
      ? [
          [x0, y0],
          [x1, y1],
          [x1 + shiftX, y1 + shiftY],
          [x0 + shiftX, y0 + shiftY],
        ]
      : [
          [x0 + shiftX, y0 + shiftY],
          [x1 + shiftX, y1 + shiftY],
          [x1, y1],
          [x0, y0],
        ];
  path.moveTo(corners[0][0], corners[0][1]);
  for (const [x, y] of corners.slice(1)) {
    path.lineTo(x, y);
  }
  path.closePath();
}

// Whether a record's own box, together with the box it sweeps into, reaches the tile at all. The
// overwhelming majority of a halo's casters never do, and this is what keeps the cost with the tile's
// own ground rather than with the 500 m of city around it.
function reaches(
  boxes: Float64Array,
  record: number,
  { scale, originX, originY }: Frame,
  shiftX: number,
  shiftY: number,
): boolean {
  const left = boxes[record * 4] * scale - originX;
  const top = boxes[record * 4 + 1] * scale - originY;
  const right = boxes[record * 4 + 2] * scale - originX;
  const bottom = boxes[record * 4 + 3] * scale - originY;
  return (
    Math.min(left, left + shiftX) <= TILE_SIZE &&
    Math.max(right, right + shiftX) >= 0 &&
    Math.min(top, top + shiftY) <= TILE_SIZE &&
    Math.max(bottom, bottom + shiftY) >= 0
  );
}

// Every building shadow one sun sample throws onto the tile. A footprint its convex hull barely
// over-fills is swept as that hull; a real concavity is swept as the exact Minkowski sum — the ring,
// its translate and one parallelogram per edge — so its notch stays unshaded. Returns how many
// footprints reached the tile.
export function castBuildings(
  path: PolygonSink,
  chunks: CasterChunk[],
  sample: SunSample,
  maxShadowMeters: number,
  frame: Frame,
): number {
  let drawn = 0;
  for (const chunk of chunks) {
    const { points, rings, records, heights, boxes, hulls, hullPoints, wound } =
      chunk;
    for (let record = 0; record < chunk.buildings; record++) {
      const distance = Math.min(
        heights[record] * sample.shadowPerHeight,
        maxShadowMeters,
      );
      if (!(distance > 0)) {
        continue;
      }
      const shiftX = distance * sample.east * frame.pixelsPerMeter;
      const shiftY = -distance * sample.north * frame.pixelsPerMeter;
      if (!reaches(boxes, record, frame, shiftX, shiftY)) {
        continue;
      }
      drawn += 1;
      const outerRing = records[record];
      const hull = hulls[outerRing * 2 + 1];
      if (hull > 0) {
        const start = hulls[outerRing * 2];
        traceSweptHull(
          path,
          hullPoints,
          start,
          start + hull,
          frame,
          0,
          0,
          shiftX,
          shiftY,
        );
      } else {
        const outer = outerRing;
        const from = rings[outer];
        const to = rings[outer + 1];
        const forward = wound[outer] === 1;
        traceRing(path, points, from, to, forward, frame, 0, 0);
        traceRing(path, points, from, to, forward, frame, shiftX, shiftY);
        for (let index = from; index < to; index++) {
          const next = index + 1 < to ? index + 1 : from;
          traceEdgeSweep(path, points, index, next, frame, shiftX, shiftY);
        }
      }
    }
  }
  return drawn;
}

// Every trunk shadow. Geometrically a trunk is a small building — a vertical cylinder swept by its
// own shadow — but it is emitted into the CROWN layer rather than the building one; the call site
// says why. So the shadow is a capsule, drawn here as
// the quad without its two round caps: a median trunk is 0.34 m across against a 0.91 m z17 pixel, so
// the caps are a hundredth of a pixel of area. A trunk stands to where its crown is WIDEST, so the
// crown's shadow is at full width over the trunk's far end and swallows it; ending it at the crown
// base would leave the last of it beside the narrow tip the crown reaches down to. `minWidth` is one
// DEVICE pixel in
// tile pixels, the floor the quad is drawn at, since a sliver thinner than a sample grid dashes or
// drops out of the rasterizer altogether rather than reading as the faint line it should.
export function castTrunks(
  path: PolygonSink,
  chunks: CasterChunk[],
  sample: SunSample,
  maxShadowMeters: number,
  frame: Frame,
  minWidth: number,
): number {
  if (!(sample.shadowPerHeight > 0)) {
    return 0;
  }
  // The unit normal to the shadow that winds the quad positively, as traceEdgeSweep winds its own.
  // Every trunk shares it — only the length of the shadow varies with the tree.
  const normalX = -sample.north;
  const normalY = -sample.east;

  const { scale, originX, originY, pixelsPerMeter } = frame;
  let drawn = 0;
  for (const chunk of chunks) {
    const { trunks, trunkRadii, trunkHeights, trunkBox, trunkMaxHeight } =
      chunk;
    const reach =
      Math.min(trunkMaxHeight * sample.shadowPerHeight, maxShadowMeters) *
      pixelsPerMeter;
    if (
      trunkRadii.length === 0 ||
      !reaches(trunkBox, 0, frame, reach * sample.east, -reach * sample.north)
    ) {
      continue;
    }
    for (let trunk = 0; trunk < trunkRadii.length; trunk++) {
      const distance = Math.min(
        trunkHeights[trunk] * sample.shadowPerHeight,
        maxShadowMeters,
      );
      const shiftX = distance * sample.east * pixelsPerMeter;
      const shiftY = -distance * sample.north * pixelsPerMeter;
      const x = trunks[trunk * 2] * scale - originX;
      const y = trunks[trunk * 2 + 1] * scale - originY;
      const half = Math.max(trunkRadii[trunk] * pixelsPerMeter, minWidth / 2);
      if (
        Math.min(x, x + shiftX) - half > TILE_SIZE ||
        Math.max(x, x + shiftX) + half < 0 ||
        Math.min(y, y + shiftY) - half > TILE_SIZE ||
        Math.max(y, y + shiftY) + half < 0
      ) {
        continue;
      }
      drawn += 1;
      const acrossX = half * normalX;
      const acrossY = half * normalY;
      path.moveTo(x - acrossX, y - acrossY);
      path.lineTo(x + acrossX, y + acrossY);
      path.lineTo(x + acrossX + shiftX, y + acrossY + shiftY);
      path.lineTo(x - acrossX + shiftX, y - acrossY + shiftY);
      path.closePath();
    }
  }
  return drawn;
}

// The exact sweep of a ring too concave for its own hull to stand in: the ring where it starts, the
// ring where it ends, and the strips its FRONT-FACING boundary drags between the two. Mirrors
// `append_sweep` in crates/tiler/src/shade.rs, which carries the argument for why only those edges
// need a strip and why a whole run of them closes into one — and a canopy blob has a few long runs
// where it has thousands of edges, so run-at-a-time is what keeps a park tile drawable.
function traceRunSweep(
  path: PolygonSink,
  points: Float64Array,
  from: number,
  to: number,
  positive: boolean,
  frame: Frame,
  baseX: number,
  baseY: number,
  shiftX: number,
  shiftY: number,
): void {
  const span = to - from;
  traceRing(path, points, from, to, positive, frame, baseX, baseY);
  traceRing(
    path,
    points,
    from,
    to,
    positive,
    frame,
    baseX + shiftX,
    baseY + shiftY,
  );
  const winding = positive ? 1 : -1;
  const facing = (index: number): boolean => {
    const next = from + ((index - from + 1) % span);
    const cross =
      (points[next * 2] - points[index * 2]) * shiftY -
      (points[next * 2 + 1] - points[index * 2 + 1]) * shiftX;
    return winding * cross <= 0;
  };
  // Starting on an edge that faces away is what keeps a run from wrapping past the ring's own end;
  // only a ring with no area faces the sweep the whole way round, and it drags nothing anyway.
  let start = -1;
  for (let index = from; index < to; index++) {
    if (!facing(index)) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return;
  }

  const { scale, originX, originY } = frame;
  let run: number[] = [];
  const close = (): void => {
    if (run.length >= 2) {
      // The strip is the run followed by its own translate walked back, and it winds the way
      // traceEdgeSweep winds one edge's quad — the whole run shares that sign, so one test settles it,
      // and running the strip backwards is what flips it.
      const lead = run[0];
      const next = run[1];
      const walk =
        (points[next * 2] - points[lead * 2]) * shiftY -
          (points[next * 2 + 1] - points[lead * 2 + 1]) * shiftX >
        0
          ? run
          : [...run].reverse();
      let started = false;
      const emit = (index: number, dx: number, dy: number): void => {
        const x = points[index * 2] * scale - originX + dx;
        const y = points[index * 2 + 1] * scale - originY + dy;
        if (started) {
          path.lineTo(x, y);
        } else {
          path.moveTo(x, y);
          started = true;
        }
      };
      for (const index of walk) {
        emit(index, baseX, baseY);
      }
      for (let at = walk.length - 1; at >= 0; at--) {
        emit(walk[at], baseX + shiftX, baseY + shiftY);
      }
      path.closePath();
    }
    // The next run carries on from this one's last vertex, so a run cut for length leaves no gap.
    run = run.length > 0 ? [run[run.length - 1]] : [];
  };
  for (let step = 0; step < span; step++) {
    const index = from + ((start - from + step) % span);
    if (facing(index)) {
      if (run.length === 0) {
        run.push(index);
      }
      run.push(from + ((index - from + 1) % span));
      if (run.length >= MAX_SWEEP_RUN) {
        close();
      }
    } else {
      run = [];
    }
  }
  close();
}

// One swept slice of a crown: which of its rings to sweep, and how far down the shadow to sweep them
// between, in metres. Mirrors `crown_segments` in crates/tiler/src/crown.rs, which carries why the
// bands sit where they do — the two halves have to cut the same slices at the zoom they hand over or
// the seam would show.
export function crownSegments(
  heightM: number,
  shadowPerHeight: number,
  maxShadowMeters: number,
  metersPerPixel: number,
): { level: number; fromM: number; toM: number }[] {
  if (!(heightM > 0) || !(shadowPerHeight > 0)) {
    return [];
  }
  const smearM = (1 - CROWN_BASE_FRACTION) * heightM * shadowPerHeight;
  const wanted = Math.ceil(smearM / metersPerPixel / SMEAR_PIXELS_PER_SEGMENT);
  let count = CROWN_SEGMENTS;
  while (count > 1 && count / 2 >= wanted) {
    count /= 2;
  }
  const stride = CROWN_SEGMENTS / count;
  const middle = (1 + CROWN_BASE_FRACTION) / 2;
  const halfHeight = (1 - CROWN_BASE_FRACTION) / 2;
  const displacement = (shareOfHeight: number): number =>
    Math.min(shareOfHeight * heightM * shadowPerHeight, maxShadowMeters);
  const segments: { level: number; fromM: number; toM: number }[] = [];
  for (let slice = 0; slice < count; slice++) {
    const level = slice * stride;
    // Half the band the crown stays at least this ring's radius over, centred on its widest section.
    // The rings are spaced by equal HEIGHT, so the offsets are evenly spaced and this is just one.
    const half = (level / (CROWN_SEGMENTS - 1)) * CROWN_TIP_FRACTION;
    const fromM = displacement(middle - halfHeight * half);
    const toM = displacement(middle + halfHeight * half);
    // Slice 0 is the widest section, which spans one height and so sweeps nothing; past the shadow
    // clip every other slice lands on the same ground, where slice 0's ring covers them all.
    if (toM > fromM || slice === 0) {
      segments.push({ level, fromM, toM });
    }
  }
  return segments;
}

// Every crown shadow: each of a crown's slices SWEPT between where its band of the crown starts
// casting and where it stops. A crown floats free, so there is no wall joining it to the ground — but
// it is not a sheet either, and sweeping between two airborne slices is the crown's own projection.
export function castCrowns(
  path: PolygonSink,
  chunks: CasterChunk[],
  sample: SunSample,
  maxShadowMeters: number,
  frame: Frame,
): number {
  const metersPerPixel = 1 / frame.pixelsPerMeter;
  let drawn = 0;
  for (const chunk of chunks) {
    const {
      points,
      rings,
      records,
      heights,
      boxes,
      hulls,
      hullPoints,
      wound,
      levels,
    } = chunk;
    for (let record = chunk.buildings; record < records.length - 1; record++) {
      const segments = crownSegments(
        heights[record],
        sample.shadowPerHeight,
        maxShadowMeters,
        metersPerPixel,
      );
      if (segments.length === 0) {
        continue;
      }
      const reach = segments[segments.length - 1].toM * frame.pixelsPerMeter;
      if (
        !reaches(
          boxes,
          record,
          frame,
          reach * sample.east,
          -reach * sample.north,
        )
      ) {
        continue;
      }
      drawn += 1;
      for (const { level, fromM, toM } of segments) {
        const baseX = fromM * sample.east * frame.pixelsPerMeter;
        const baseY = -fromM * sample.north * frame.pixelsPerMeter;
        const shiftX = (toM - fromM) * sample.east * frame.pixelsPerMeter;
        const shiftY = -(toM - fromM) * sample.north * frame.pixelsPerMeter;
        for (let ring = records[record]; ring < records[record + 1]; ring++) {
          if (levels[ring] !== level) {
            continue;
          }
          const from = rings[ring];
          const to = rings[ring + 1];
          const positive = wound[ring] === 1;
          if (shiftX === 0 && shiftY === 0) {
            traceRing(path, points, from, to, positive, frame, baseX, baseY);
          } else if (hulls[ring * 2 + 1] > 0) {
            const start = hulls[ring * 2];
            traceSweptHull(
              path,
              hullPoints,
              start,
              start + hulls[ring * 2 + 1],
              frame,
              baseX,
              baseY,
              shiftX,
              shiftY,
            );
          } else {
            traceRunSweep(
              path,
              points,
              from,
              to,
              positive,
              frame,
              baseX,
              baseY,
              shiftX,
              shiftY,
            );
          }
        }
      }
    }
  }
  return drawn;
}

// Every sidewalk-shed shadow. A deck is a crown by another name — an opaque slab floating clear of
// the ground, so its shadow is its footprint TRANSLATED and there is no wall to sweep — differing
// only in hanging at a fixed height rather than at a share of its own, and in passing no light at
// all, which is why the decks go into the buildings' layer and not the canopy's tau. One sun sample
// like the crowns: a 4 m deck's penumbra is 3.7 cm against a 0.45 m z18 pixel.
//
// The footprint is the same ring the band is drawn from (src/tiles/shed-decks.ts), traced through
// the same call, so the shadow cannot leave a shed the display never drew. `minWidth` is one DEVICE
// pixel in tile pixels, the floor a band is opened out to, as the trunks use.
export function castSheds(
  path: PolygonSink,
  decks: ShedDecks,
  sample: SunSample,
  maxShadowMeters: number,
  frame: Frame,
  minWidth: number,
): number {
  const distance = Math.min(
    DECK_HEIGHT_METERS * sample.shadowPerHeight,
    maxShadowMeters,
  );
  if (!(distance > 0)) {
    return 0;
  }
  const { scale, originX, originY, pixelsPerMeter } = frame;
  const shiftX = distance * sample.east * pixelsPerMeter;
  const shiftY = -distance * sample.north * pixelsPerMeter;
  // The tile in world pixels, widened the way the shadow runs: a deck reaches the tile if either it or
  // its translate does, which is what `reaches` asks of a caster chunk one box at a time.
  const windowMinX = (originX - Math.max(shiftX, 0)) / scale;
  const windowMinY = (originY - Math.max(shiftY, 0)) / scale;
  const windowMaxX = (originX + TILE_SIZE - Math.min(shiftX, 0)) / scale;
  const windowMaxY = (originY + TILE_SIZE - Math.min(shiftY, 0)) / scale;
  let drawn = 0;
  forEachDeckIn(
    decks,
    windowMinX,
    windowMinY,
    windowMaxX,
    windowMaxY,
    (deck) => {
      drawn += 1;
      // The shadow is the ring displaced, which the origin carries rather than the trace.
      traceDeck(
        path,
        decks,
        deck,
        scale,
        originX - shiftX,
        originY - shiftY,
        minWidth,
      );
    },
  );
  return drawn;
}

// The building footprints over the tile, holes wound against their outer ring so a courtyard stays
// open. Punched out of both shadow layers: shade on a roof is not ground shade.
export function castBases(
  path: PolygonSink,
  chunks: CasterChunk[],
  frame: Frame,
): void {
  for (const chunk of chunks) {
    const { points, rings, records, boxes, wound } = chunk;
    for (let record = 0; record < chunk.buildings; record++) {
      if (!reaches(boxes, record, frame, 0, 0)) {
        continue;
      }
      for (let ring = records[record]; ring < records[record + 1]; ring++) {
        const positive = wound[ring] === 1;
        const outer = ring === records[record];
        traceRing(
          path,
          points,
          rings[ring],
          rings[ring + 1],
          outer ? positive : !positive,
          frame,
          0,
          0,
        );
      }
    }
  }
}

// The two scratch layers a composite needs, at the tile's device resolution and reused across draws —
// the worker rasterizes one tile at a time, so nothing else is ever mid-draw on them.
const scratch: (OffscreenCanvasRenderingContext2D | null)[] = [null, null];

function layer(
  slot: number,
  size: number,
  ratio: number,
): OffscreenCanvasRenderingContext2D | null {
  const held = scratch[slot];
  const context =
    held?.canvas.width === size
      ? held
      : new OffscreenCanvas(size, size).getContext("2d");
  scratch[slot] = context;
  if (context) {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  }
  return context;
}

// The shed decks the worker sweeps, for the one picked DATE: which sheds are standing moves with it,
// unlike the buildings and crowns a chunk carries. Handed over from the main thread
// (components/shade-layer.tsx) rather than read here, because the geometry hangs off the routing
// graph and the worker has no copy of that.
let standing: ShedDecks = NO_DECKS;

export function setShedDecks(decks: ShedDecks): void {
  standing = decks;
}

// The chunks a tile's shadows can come from, and the sun to throw them with. Null where the deploy
// carries no casters, and null again where a chunk this tile needed did not arrive — both send the
// tile back to the magnified pyramid, which is blurry but whole. Sweeping the chunks that did arrive
// would be sharper and wrong: the missing one's buildings would come out as sunlit ground.
export async function sweptGround(
  params: ShadeParams,
  coords: TileCoords,
): Promise<SweptGround | null> {
  const manifest = await casterManifest();
  if (!manifest) {
    return null;
  }
  const frame = frameFor(coords);
  const { chunks, complete } = await chunksFor(
    manifest,
    frame.originX / frame.scale,
    frame.originY / frame.scale,
    (frame.originX + TILE_SIZE) / frame.scale,
    (frame.originY + TILE_SIZE) / frame.scale,
    frame.latitude,
  );
  if (!complete) {
    return null;
  }
  const { elevation, azimuth } = rampedSun(params, coords.z);
  return {
    chunks,
    decks: standing,
    samples: sunSamples(
      azimuth,
      elevation,
      coords.z >= params.vectorZoom + PENUMBRA_LEVELS ? DISK_SAMPLES : 1,
    ),
    intensity: Math.max(0, Math.sin(elevation * DEGREES)),
    maxShadowMeters: manifest.maxShadowMeters,
  };
}

// One tile, swept. Each sun sample's shadows are unioned by a single nonzero fill and the samples
// accumulated at 1/n opacity, so the layer's alpha IS the shaded fraction — umbra where every sample
// reached, penumbra where only some did. The crowns then compose over that under source-over, whose
// arithmetic is exactly `1 - (1 - buildings)(1 - tau * trees)`, and the whole thing lands on the tile
// at the pyramid's own `MAX_SHADE_ALPHA * intensity` scale, so the two halves are interchangeable.
export function drawSweep(
  context: OffscreenCanvasRenderingContext2D,
  ground: SweptGround,
  coords: TileCoords,
  { tau }: ShadeParams,
  ratio: number,
): void {
  const { chunks, decks, samples, intensity, maxShadowMeters } = ground;
  const frame = frameFor(coords);
  const shadows = samples.map((sample) => {
    const path = new Path2D();
    return {
      path,
      drawn: castBuildings(path, chunks, sample, maxShadowMeters, frame),
    };
  });
  const sheds = new Path2D();
  const shedsDrawn = castSheds(
    sheds,
    decks,
    samples[0],
    maxShadowMeters,
    frame,
    1 / ratio,
  );
  // Trunks ride with the crowns, not with the buildings. Wood does not leaf off, so the season's tau
  // is a little wrong on them — but a trunk stands under its own crown and the lower crown tapers to
  // nothing around it, so the ground there is part trunk and part thin crown either way. Casting them
  // opaquely made them read as dark scratches across the softer shade they sit in.
  const crowns = new Path2D();
  const crownsDrawn =
    castCrowns(crowns, chunks, samples[0], maxShadowMeters, frame) +
    castTrunks(crowns, chunks, samples[0], maxShadowMeters, frame, 1 / ratio);
  if (
    crownsDrawn === 0 &&
    shedsDrawn === 0 &&
    shadows.every(({ drawn }) => drawn === 0)
  ) {
    return;
  }
  const bases = new Path2D();
  castBases(bases, chunks, frame);

  const size = Math.round(TILE_SIZE * ratio);
  const shade = layer(0, size, ratio);
  if (!shade) {
    return;
  }
  shade.globalCompositeOperation = "lighter";
  shade.fillStyle = `rgba(${SHADE_CSS}, ${1 / samples.length})`;
  for (const { path } of shadows) {
    shade.fill(path);
  }
  // The decks land at full alpha under source-over rather than joining the samples' additive pass: a
  // deck stops all of the light, and adding it in would double the slate wherever it fell on a
  // building's shadow, which comes out LIGHTER rather than darker.
  if (shedsDrawn > 0) {
    shade.globalCompositeOperation = "source-over";
    shade.fillStyle = `rgb(${SHADE_CSS})`;
    shade.fill(sheds);
  }
  shade.globalCompositeOperation = "destination-out";
  shade.fillStyle = "#000";
  shade.fill(bases);

  const crown = crownsDrawn > 0 ? layer(1, size, ratio) : null;
  if (crown) {
    crown.fillStyle = `rgb(${SHADE_CSS})`;
    crown.fill(crowns);
    crown.globalCompositeOperation = "destination-out";
    crown.fill(bases);
    shade.globalCompositeOperation = "source-over";
    shade.globalAlpha = tau;
    shade.drawImage(crown.canvas, 0, 0, TILE_SIZE, TILE_SIZE);
    shade.globalAlpha = 1;
  }

  context.globalAlpha = (MAX_SHADE_ALPHA * intensity) / 255;
  context.drawImage(shade.canvas, 0, 0, TILE_SIZE, TILE_SIZE);
  context.globalAlpha = 1;
}
