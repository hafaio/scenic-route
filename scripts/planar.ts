// Planar geometry in a single equirectangular metre frame over New York. The city's latitude span
// keeps the x-scale error under 1%, i.e. sub-decimetre over the 10-30 m distances that decide which
// sidewalk a building fronts, so one frame for the whole city is enough and every distance below is
// a plain Euclidean one.
//
// Polylines and rings are interleaved [x0, y0, x1, y1, ...] in metres. A ring is closed: its last
// vertex repeats its first. Only what the sidewalk-shed placement needs lives here.

const METERS_PER_DEGREE_LAT = 111_320;
const REFERENCE_LAT = 40.7;
const COS_REFERENCE = Math.cos((REFERENCE_LAT * Math.PI) / 180);

export function projectX(lng: number): number {
  return lng * METERS_PER_DEGREE_LAT * COS_REFERENCE;
}

export function projectY(lat: number): number {
  return (lat - REFERENCE_LAT) * METERS_PER_DEGREE_LAT;
}

// [minX, minY, maxX, maxY] of an interleaved polyline or ring.
export function boundsOf(coords: Float64Array): Float64Array {
  const box = Float64Array.of(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  for (let at = 0; at < coords.length; at += 2) {
    box[0] = Math.min(box[0], coords[at]);
    box[1] = Math.min(box[1], coords[at + 1]);
    box[2] = Math.max(box[2], coords[at]);
    box[3] = Math.max(box[3], coords[at + 1]);
  }
  return box;
}

// The gap between two boxes, 0 when they touch or overlap. A lower bound on the distance between
// anything inside them, which is what makes it usable as a cheap reject.
export function boxGap(left: Float64Array, right: Float64Array): number {
  const gapX = Math.max(0, Math.max(left[0] - right[2], right[0] - left[2]));
  const gapY = Math.max(0, Math.max(left[1] - right[3], right[1] - left[3]));
  return Math.hypot(gapX, gapY);
}

export function polylineLength(coords: Float64Array): number {
  let total = 0;
  for (let at = 2; at < coords.length; at += 2) {
    total += Math.hypot(
      coords[at] - coords[at - 2],
      coords[at + 1] - coords[at - 1],
    );
  }
  return total;
}

// The signed area of a closed ring, positive when it winds counter-clockwise.
export function ringSignedArea(ring: Float64Array): number {
  let total = 0;
  for (let at = 2; at < ring.length; at += 2) {
    total += ring[at - 2] * ring[at + 1] - ring[at] * ring[at - 1];
  }
  return total / 2;
}

// The area centroid, which is what a building's "middle" means when the footprint is an L.
export function ringCentroid(ring: Float64Array): { x: number; y: number } {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let at = 2; at < ring.length; at += 2) {
    const cross = ring[at - 2] * ring[at + 1] - ring[at] * ring[at - 1];
    twiceArea += cross;
    x += (ring[at - 2] + ring[at]) * cross;
    y += (ring[at - 1] + ring[at + 1]) * cross;
  }
  if (twiceArea === 0) {
    return { x: ring[0], y: ring[1] }; // a degenerate ring has no area to weight by
  } else {
    return { x: x / (3 * twiceArea), y: y / (3 * twiceArea) };
  }
}

export function pointInRing(ring: Float64Array, x: number, y: number): boolean {
  let inside = false;
  for (let at = 2; at < ring.length; at += 2) {
    const aboveX = ring[at - 2];
    const aboveY = ring[at - 1];
    const belowX = ring[at];
    const belowY = ring[at + 1];
    if (aboveY > y !== belowY > y) {
      const crossing =
        aboveX + ((y - aboveY) / (belowY - aboveY)) * (belowX - aboveX);
      if (x < crossing) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function pointToSegment(
  x: number,
  y: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const param =
    lengthSquared > 0
      ? Math.max(
          0,
          Math.min(
            1,
            ((x - fromX) * deltaX + (y - fromY) * deltaY) / lengthSquared,
          ),
        )
      : 0;
  return Math.hypot(x - (fromX + param * deltaX), y - (fromY + param * deltaY));
}

export function pointToPolyline(
  coords: Float64Array,
  x: number,
  y: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let at = 2; at < coords.length; at += 2) {
    best = Math.min(
      best,
      pointToSegment(
        x,
        y,
        coords[at - 2],
        coords[at - 1],
        coords[at],
        coords[at + 1],
      ),
    );
  }
  return best;
}

function segmentsIntersect(
  aX: number,
  aY: number,
  bX: number,
  bY: number,
  cX: number,
  cY: number,
  dX: number,
  dY: number,
): boolean {
  const side = (
    pX: number,
    pY: number,
    qX: number,
    qY: number,
    rX: number,
    rY: number,
  ): number => Math.sign((qX - pX) * (rY - pY) - (qY - pY) * (rX - pX));
  return (
    side(aX, aY, bX, bY, cX, cY) !== side(aX, aY, bX, bY, dX, dY) &&
    side(cX, cY, dX, dY, aX, aY) !== side(cX, cY, dX, dY, bX, bY)
  );
}

function polylineToPolyline(left: Float64Array, right: Float64Array): number {
  let best = Number.POSITIVE_INFINITY;
  for (let outer = 2; outer < left.length; outer += 2) {
    for (let inner = 2; inner < right.length; inner += 2) {
      if (
        segmentsIntersect(
          left[outer - 2],
          left[outer - 1],
          left[outer],
          left[outer + 1],
          right[inner - 2],
          right[inner - 1],
          right[inner],
          right[inner + 1],
        )
      ) {
        return 0;
      }
      best = Math.min(
        best,
        pointToSegment(
          left[outer - 2],
          left[outer - 1],
          right[inner - 2],
          right[inner - 1],
          right[inner],
          right[inner + 1],
        ),
        pointToSegment(
          right[inner - 2],
          right[inner - 1],
          left[outer - 2],
          left[outer - 1],
          left[outer],
          left[outer + 1],
        ),
      );
    }
  }
  return best;
}

// 0 when the polyline touches or runs inside the ring, else the gap to its boundary.
export function ringToPolyline(
  ring: Float64Array,
  coords: Float64Array,
): number {
  if (pointInRing(ring, coords[0], coords[1])) {
    return 0;
  } else {
    return polylineToPolyline(ring, coords);
  }
}

// 0 when the two rings touch or one contains the other, else the gap between their boundaries.
export function ringToRing(left: Float64Array, right: Float64Array): number {
  if (
    pointInRing(left, right[0], right[1]) ||
    pointInRing(right, left[0], left[1])
  ) {
    return 0;
  } else {
    return polylineToPolyline(left, right);
  }
}

export function ringToPoint(ring: Float64Array, x: number, y: number): number {
  return pointInRing(ring, x, y) ? 0 : pointToPolyline(ring, x, y);
}

// Resample a closed ring at about `step` metres, dropping the repeated closing vertex.
export function densifyRing(ring: Float64Array, step: number): Float64Array {
  const segments = ring.length / 2 - 1;
  const cumulative = new Float64Array(segments + 1);
  for (let segment = 0; segment < segments; segment++) {
    const at = segment * 2;
    cumulative[segment + 1] =
      cumulative[segment] +
      Math.hypot(ring[at + 2] - ring[at], ring[at + 3] - ring[at + 1]);
  }
  const total = cumulative[segments];
  const count = Math.max(8, Math.round(total / step));
  const points = new Float64Array(count * 2);
  let segment = 0;
  for (let index = 0; index < count; index++) {
    const position = (total * index) / count;
    while (segment + 1 < segments && cumulative[segment + 1] <= position) {
      segment += 1;
    }
    const at = segment * 2;
    const span = cumulative[segment + 1] - cumulative[segment];
    const local = span > 0 ? (position - cumulative[segment]) / span : 0;
    points[index * 2] = ring[at] + local * (ring[at + 2] - ring[at]);
    points[index * 2 + 1] =
      ring[at + 1] + local * (ring[at + 3] - ring[at + 1]);
  }
  return points;
}

// The unit outward normal at each sample of a counter-clockwise ring, taken across a window of
// samples so a single jagged vertex does not flip the direction the wall faces.
export function outwardNormals(
  points: Float64Array,
  window: number,
): Float64Array {
  const count = points.length / 2;
  const normals = new Float64Array(points.length);
  for (let index = 0; index < count; index++) {
    const ahead = (index + window) % count;
    const behind = (index - window + count * 2) % count;
    const tangentX = points[ahead * 2] - points[behind * 2];
    const tangentY = points[ahead * 2 + 1] - points[behind * 2 + 1];
    const scale = 1 / Math.max(Math.hypot(tangentX, tangentY), 1e-9);
    normals[index * 2] = tangentY * scale;
    normals[index * 2 + 1] = -tangentX * scale;
  }
  return normals;
}

// The point `along` metres from the start of a polyline, clamped to its ends.
export function pointAt(
  coords: Float64Array,
  along: number,
): { x: number; y: number } {
  let remaining = along;
  for (let at = 2; at < coords.length; at += 2) {
    const spanX = coords[at] - coords[at - 2];
    const spanY = coords[at + 1] - coords[at - 1];
    const span = Math.hypot(spanX, spanY);
    if (remaining <= span || at + 2 >= coords.length) {
      const local = span > 0 ? Math.max(0, Math.min(1, remaining / span)) : 0;
      return {
        x: coords[at - 2] + local * spanX,
        y: coords[at - 1] + local * spanY,
      };
    }
    remaining -= span;
  }
  return { x: coords[0], y: coords[1] };
}

// Where a point lands on a polyline: how far along the closest point sits, how far away it is, the
// closest point itself, and the unit direction the line runs there. The along-distance is what a
// shed's span is measured in, and the direction is what tells which SIDE of the line the point fell
// on, since the distance alone is unsigned.
export interface LineProjection {
  along: number;
  distance: number;
  x: number;
  y: number;
  tangentX: number;
  tangentY: number;
}

export function newProjection(): LineProjection {
  return { along: 0, distance: 0, x: 0, y: 0, tangentX: 1, tangentY: 0 };
}

export function projectToPolyline(
  coords: Float64Array,
  x: number,
  y: number,
  into: LineProjection,
): LineProjection {
  let bestDistance = Number.POSITIVE_INFINITY;
  let travelled = 0;
  for (let at = 2; at < coords.length; at += 2) {
    const fromX = coords[at - 2];
    const fromY = coords[at - 1];
    const deltaX = coords[at] - fromX;
    const deltaY = coords[at + 1] - fromY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const span = Math.sqrt(lengthSquared);
    const param =
      lengthSquared > 0
        ? Math.max(
            0,
            Math.min(
              1,
              ((x - fromX) * deltaX + (y - fromY) * deltaY) / lengthSquared,
            ),
          )
        : 0;
    const closestX = fromX + param * deltaX;
    const closestY = fromY + param * deltaY;
    const distance = Math.hypot(x - closestX, y - closestY);
    if (distance < bestDistance) {
      bestDistance = distance;
      into.along = travelled + param * span;
      into.distance = distance;
      into.x = closestX;
      into.y = closestY;
      // A collapsed segment leaves the previous direction standing rather than a zero vector; the
      // ingest drops anything shorter than a metre, so it is the degenerate-input guard.
      if (span > 0) {
        into.tangentX = deltaX / span;
        into.tangentY = deltaY / span;
      }
    }
    travelled += span;
  }
  return into;
}
