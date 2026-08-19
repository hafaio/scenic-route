import { projectX, projectY } from "./mercator";
import { type Cursor, readVarint } from "./varint";

// What every polyline overlay needs and none of them owns: reading a varint-delta line and a name
// blob out of a source file, filing lines in spatial buckets so a tile draw touches only what
// reaches it, and the two halves of a lane offset — the perpendicular it is applied along and how
// wide a lane is at a given zoom. Shared by the ferry/highway lines (./lines) and the subway
// (./subway), which draw different files with the same machinery.

// The zoom the offset normals are computed at. Web mercator scales uniformly with zoom, so a
// direction taken at any one of them is the direction at all of them.
const NORMAL_ZOOM = 0;
// How far a mitred normal may stretch to hold the offset distance through a corner, past which the
// corner is cut instead. Ferry corners are gentle enough that this never binds; it is here so a
// doubled-back vertex cannot fling a control point across the map.
const MITER_LIMIT = 2;

export interface Polyline {
  lngs: Float64Array;
  lats: Float64Array;
}

// One line's `vertices` (longitude, latitude) varint deltas, the first of them from the file's
// origin and the rest from the previous vertex — the FERR/GRPH/SBWY geometry convention.
export function readPolyline(
  bytes: Uint8Array,
  cursor: Cursor,
  vertices: number,
  originLng: number,
  originLat: number,
  scale: number,
): Polyline {
  const lngs = new Float64Array(vertices);
  const lats = new Float64Array(vertices);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let vertex = 0; vertex < vertices; vertex++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lngs[vertex] = originLng + quantizedX * scale;
    lats[vertex] = originLat + quantizedY * scale;
  }
  return { lngs, lats };
}

// The name blob a stop, a route or a station name indexes into: a u32 count, then each name as a u16
// byte length and that many UTF-8 bytes.
export function decodeNames(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): string[] {
  const decoder = new TextDecoder();
  const names: string[] = [];
  let cursor = offset + 4;
  for (let name = 0; name < view.getUint32(offset, true); name++) {
    const length = view.getUint16(cursor, true);
    cursor += 2;
    names.push(decoder.decode(bytes.subarray(cursor, cursor + length)));
    cursor += length;
  }
  return names;
}

// Polyline indices filed by `${cellX},${cellY}` over a `cellDeg` grid, each line under every cell its
// bounding box spans, so a tile draw gathers only the lines that reach it rather than the whole city.
export function bucketize(
  polylines: readonly Polyline[],
  cellDeg: number,
): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < polylines.length; index++) {
    const { lngs, lats } = polylines[index];
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      minLng = Math.min(minLng, lngs[vertex]);
      maxLng = Math.max(maxLng, lngs[vertex]);
      minLat = Math.min(minLat, lats[vertex]);
      maxLat = Math.max(maxLat, lats[vertex]);
    }
    for (
      let cellX = Math.floor(minLng / cellDeg);
      cellX <= Math.floor(maxLng / cellDeg);
      cellX++
    ) {
      for (
        let cellY = Math.floor(minLat / cellDeg);
        cellY <= Math.floor(maxLat / cellDeg);
        cellY++
      ) {
        const key = `${cellX},${cellY}`;
        const cell = buckets.get(key);
        if (cell) {
          cell.push(index);
        } else {
          buckets.set(key, [index]);
        }
      }
    }
  }
  return buckets;
}

// A polyline that shares its corridor with others: `route` is which of them this one belongs to,
// as an index into whatever order the caller wants the lanes stacked in.
export interface RoutedPolyline extends Polyline {
  route: number;
}

export interface LaneOptions {
  // The grid the local route set is counted over. Two routes closer than this share a lane stack;
  // two further apart are drawn where they are, each on lane 0.
  cellMeters: number;
  // How far a route takes to slide from one lane to the next where the set around it changes, so a
  // route joining a bundle crosses to its lane diagonally instead of stepping sideways at a vertex.
  blendMeters: number;
  // The latitude the two grid distances above are measured at, which only has to be right to the
  // degree: over the half a degree a city spans, the longitude scale it sets moves under a percent.
  latitude: number;
}

export const METERS_PER_DEGREE_LAT = 111_320;

// A degree of longitude in metres at `lat` — the other half of measuring a ground distance off
// coordinates, and the only part of it that is not a constant.
export function metersPerLng(lat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

interface Walked {
  sampleLngs: Float64Array;
  sampleLats: Float64Array;
  // Per sample, the unit direction of the span it was taken from, in projected space — the same
  // frame the normals are built in, so a dot product here is the angle the offset will see.
  sampleDirX: Float64Array;
  sampleDirY: Float64Array;
}

// One polyline resampled at half a cell. Resampled rather than read at its vertices because the
// shapes are coarse where the corridor is open — a ferry crossing is 4 to 12 vertices for a
// kilometre of water — so a span that only claimed the cells its endpoints fall in would leave the
// corridor between them unclaimed.
function walk(
  { lngs, lats }: Polyline,
  cellLng: number,
  cellLat: number,
): Walked {
  const count = lngs.length;
  const sampleLngs: number[] = [];
  const sampleLats: number[] = [];
  const sampleDirX: number[] = [];
  const sampleDirY: number[] = [];
  let lastDirX = 0;
  let lastDirY = 0;
  for (let vertex = 0; vertex + 1 < count; vertex++) {
    const deltaLng = lngs[vertex + 1] - lngs[vertex];
    const deltaLat = lats[vertex + 1] - lats[vertex];
    const deltaX =
      projectX(lngs[vertex + 1], NORMAL_ZOOM) -
      projectX(lngs[vertex], NORMAL_ZOOM);
    const deltaY =
      projectY(lats[vertex + 1], NORMAL_ZOOM) -
      projectY(lats[vertex], NORMAL_ZOOM);
    const projected = Math.hypot(deltaX, deltaY);
    if (projected > 0) {
      lastDirX = deltaX / projected;
      lastDirY = deltaY / projected;
    }
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(deltaLng / cellLng, deltaLat / cellLat) * 2),
    );
    for (let step = 0; step < steps; step++) {
      const along = step / steps;
      sampleLngs.push(lngs[vertex] + deltaLng * along);
      sampleLats.push(lats[vertex] + deltaLat * along);
      sampleDirX.push(lastDirX);
      sampleDirY.push(lastDirY);
    }
  }
  sampleLngs.push(lngs[count - 1]);
  sampleLats.push(lats[count - 1]);
  sampleDirX.push(lastDirX);
  sampleDirY.push(lastDirY);
  return {
    sampleLngs: Float64Array.from(sampleLngs),
    sampleLats: Float64Array.from(sampleLats),
    sampleDirX: Float64Array.from(sampleDirX),
    sampleDirY: Float64Array.from(sampleDirY),
  };
}

// The eight cells a cell touches, the four sharing a side first, for the walk that spreads a route's
// presence out to the cells around the ones it actually runs through.
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const NO_CELL = -1;

// Every cell any line runs through, in one table: the routes in it, which cells adjoin it, and which
// cell each line's samples fell in. All of it resolved once here, because everything below is a
// per-cell or per-route pass over it — on a file the size of the subway's, 29 routes over 10,763
// cells and 295,000 samples, that is the difference between a decode of 50 ms and one of 150.
interface Occupancy {
  idOf: Map<string, number>;
  routes: Set<number>[];
  adjoining: Int32Array; // NEIGHBOURS.length per cell, NO_CELL where no line runs
  sampled: Int32Array[]; // per line, the cell each of its samples fell in
}

function occupancyOf(
  lines: readonly RoutedPolyline[],
  walked: readonly Walked[],
  cellLng: number,
  cellLat: number,
): Occupancy {
  const idOf = new Map<string, number>();
  const cellX: number[] = [];
  const cellY: number[] = [];
  const routes: Set<number>[] = [];
  const sampled = walked.map(({ sampleLngs, sampleLats }, index) =>
    Int32Array.from(sampleLngs, (lng, sample) => {
      const atX = Math.floor(lng / cellLng);
      const atY = Math.floor(sampleLats[sample] / cellLat);
      const key = `${atX},${atY}`;
      let cell = idOf.get(key);
      if (cell === undefined) {
        cell = cellX.length;
        idOf.set(key, cell);
        cellX.push(atX);
        cellY.push(atY);
        routes.push(new Set());
      }
      routes[cell].add(lines[index].route);
      return cell;
    }),
  );

  const adjoining = new Int32Array(cellX.length * NEIGHBOURS.length);
  for (let cell = 0; cell < cellX.length; cell++) {
    NEIGHBOURS.forEach(([alongX, alongY], side) => {
      adjoining[cell * NEIGHBOURS.length + side] =
        idOf.get(`${cellX[cell] + alongX},${cellY[cell] + alongY}`) ?? NO_CELL;
    });
  }
  return { idOf, routes, adjoining, sampled };
}

// Per cell, how present a route is there: 1 in the cells it runs through, tapering to 0 over
// `blendMeters` of the cells around them, measured by the walk out through cells some line runs
// through rather than as the crow flies — so a route's presence reaches along the water it is on and
// not across to a corridor it never touches.
function presenceOf(
  { routes, adjoining }: Occupancy,
  route: number,
  cellMeters: number,
  blendMeters: number,
): Float64Array {
  const spread = new Float64Array(routes.length).fill(Number.POSITIVE_INFINITY);
  const pending: number[] = [];
  for (let cell = 0; cell < routes.length; cell++) {
    if (routes[cell].has(route)) {
      spread[cell] = 0;
      pending.push(cell);
    }
  }
  const steps = NEIGHBOURS.map(
    ([alongX, alongY]) => cellMeters * (alongX && alongY ? Math.SQRT2 : 1),
  );
  for (let head = 0; head < pending.length; head++) {
    const cell = pending[head];
    for (let side = 0; side < steps.length; side++) {
      const neighbour = adjoining[cell * steps.length + side];
      const reach = spread[cell] + steps[side];
      if (
        neighbour !== NO_CELL &&
        reach < spread[neighbour] &&
        reach < blendMeters
      ) {
        spread[neighbour] = reach;
        pending.push(neighbour);
      }
    }
  }
  return spread.map((reach) =>
    reach === Number.POSITIVE_INFINITY ? 0 : 1 - reach / blendMeters,
  );
}

// Metres of ground per unit of the projected space the normals and sample directions live in.
// Mercator is conformal, so one factor covers both axes; over the half a degree a city spans it
// moves under a percent, which is the same approximation `cellLng` already makes.
function metersPerPixel(latitude: number): number {
  return (metersPerLng(latitude) * 360) / (256 * 2 ** NORMAL_ZOOM);
}

// How far off the corridor a parting is worth counting, in cells. A parting says which SIDE the
// leaver left on, not how fast it got there, and once it is a cell off the two are no longer
// sharing anything — further metres only mean it left at a steeper angle, which is the case where
// the order matters least, since a route cutting across a bundle crosses it whatever lane it holds.
// Uncapped, those steep departures outvote the gentle ones: 1,031 introduced crossings across the
// New York subway against 935 capped at a cell, and 360 against 318 in San Francisco.
const VOTE_CAP_CELLS = 1;

// Which way round a pair of routes wants to be stacked, and by how much: per pair of routes, in
// metres, positive where the higher-numbered of the two wants the higher lane.
//
// A parting is a place one of them carries on and the other does not — the end of a stretch they
// share, or the start of one. There the route that is leaving swings off to one side of the
// corridor, and if its lane is on the other side it has to cross every ribbon in between to get
// there. So each parting votes for the side it left on: the route is followed `blendMeters` further
// (the distance its lane takes to slide, so the vote covers the stretch the sliding happens over)
// and the vote is how far that took it across the corridor, measured along the perpendicular its
// own lane offset is applied along, so the sign means what the drawing means.
//
// A route merely crossing a bundle votes for nothing: it arrives from one side and leaves by the
// other, and the two votes cancel, which is right — it crosses the bundle whichever lane it is in.
// A route that only clips the corner of a cell gains no separation and so votes for nothing much,
// which is what keeps a cell boundary crossed mid-bundle from reading as a parting.
function partingVotes(
  lines: readonly RoutedPolyline[],
  walked: readonly Walked[],
  { routes, sampled }: Occupancy,
  senses: Float64Array,
  cellLng: number,
  cellLat: number,
  cellMeters: number,
  blendMeters: number,
  metersPerUnit: number,
): Map<string, number> {
  const votes = new Map<string, number>();
  const cast = (route: number, other: number, lateral: number): void => {
    const capped =
      Math.sign(lateral) *
      Math.min(Math.abs(lateral), VOTE_CAP_CELLS * cellMeters);
    const key = route < other ? `${route},${other}` : `${other},${route}`;
    votes.set(key, (votes.get(key) ?? 0) + (route < other ? -capped : capped));
  };

  // Every sample in projected space, which is the frame the corridor direction and the lane normal
  // are both read in.
  const projected = walked.map(({ sampleLngs, sampleLats }) => [
    Float64Array.from(sampleLngs, (lng) => projectX(lng, NORMAL_ZOOM)),
    Float64Array.from(sampleLats, (lat) => projectY(lat, NORMAL_ZOOM)),
  ]);

  // The sample `blendMeters` of line away from `sample`, walking `step`.
  const reach = (index: number, sample: number, step: number): number => {
    const { sampleLngs, sampleLats } = walked[index];
    let at = sample;
    for (let travelled = 0; travelled < blendMeters; ) {
      const next = at + step;
      if (next < 0 || next >= sampleLngs.length) {
        break;
      }
      travelled +=
        Math.hypot(
          (sampleLngs[next] - sampleLngs[at]) / cellLng,
          (sampleLats[next] - sampleLats[at]) / cellLat,
        ) * cellMeters;
      at = next;
    }
    return at;
  };

  // How far off the corridor the line at `sample` gets over the next `blendMeters` of itself,
  // walking `step` (+1 off the end of a stretch it shared, -1 back off the start of one).
  //
  // The corridor is the chord of the `blendMeters` the line covered on the side it still had
  // company — its own path, but read from far enough back that a route already into its turn is
  // measured against the way it was going, not the way it has ended up going. Taken from the
  // instantaneous direction instead, a route that turns off the moment the two stop sharing a cell
  // measures nothing at all: it is running straight along its new heading by the time the parting
  // is seen.
  const lateralOf = (index: number, sample: number, step: number): number => {
    const { sampleDirX, sampleDirY } = walked[index];
    const [pixelX, pixelY] = projected[index];
    const away = reach(index, sample, step);
    const back = reach(index, sample, -step);
    const alongX = (pixelX[sample] - pixelX[back]) * step;
    const alongY = (pixelY[sample] - pixelY[back]) * step;
    const length = Math.hypot(alongX, alongY);
    const dirX = length > 0 ? alongX / length : sampleDirX[sample];
    const dirY = length > 0 ? alongY / length : sampleDirY[sample];
    return (
      senses[index] *
      ((pixelX[away] - pixelX[sample]) * dirY -
        (pixelY[away] - pixelY[sample]) * dirX) *
      metersPerUnit
    );
  };

  for (const [index, { route }] of lines.entries()) {
    const cells = sampled[index];
    // Only where a sample crosses into another cell can the company have changed, which is what
    // keeps this off the per-sample path: the subway file's 295,000 samples run through 10,763
    // cells. Each of the two laterals is then read at most once per cell crossed and not once per
    // route parting there, which is a quarter of what this pass costs on that file.
    for (let sample = 0; sample + 1 < cells.length; sample++) {
      if (cells[sample] !== cells[sample + 1]) {
        const here = routes[cells[sample]];
        const next = routes[cells[sample + 1]];
        let leaving = Number.NaN;
        let joining = Number.NaN;
        for (const other of here) {
          if (other !== route && !next.has(other)) {
            if (Number.isNaN(leaving)) {
              leaving = lateralOf(index, sample, 1);
            }
            cast(route, other, leaving);
          }
        }
        for (const other of next) {
          if (other !== route && !here.has(other)) {
            if (Number.isNaN(joining)) {
              joining = lateralOf(index, sample + 1, -1);
            }
            cast(route, other, joining);
          }
        }
      }
    }
  }
  return votes;
}

// The order the lanes are stacked in, as a rank per route.
//
// Any one order over the routes keeps the no-weaving guarantee below, so which order it is comes
// free — and an arbitrary one (the ferries' route names sorted, the subway feed's own order) leaves
// a route that peels off to the left of a bundle sitting on its right, crossing everything between
// to get there. This takes the order that leaves the least of `partingVotes` unsatisfied, which is
// the linear ordering problem: NP-hard in general, tiny here — New York has 8 ferry routes and 29
// subway ones, San Francisco 14 — so routes are sorted by how much the rest of the file wants to be
// after them and then moved one at a time while that pays.
//
// Measured on the committed artifacts, counting a crossing as one drawn ribbon properly crossing
// another of a different route at z15, and counting as INTRODUCED one with no crossing of the same
// two routes' published centrelines within 130 m of it: New York's ferries fall from 26 introduced
// (63 crossings in all) to 14 (47), and its subway from 1,530 (6,143) to 935 (5,515). San
// Francisco's subway goes the other way, 306 (506) to 318 (581), which is the honest cost of one
// order for the whole file: its Muni and BART tracks are digitised as near-coincident lines that
// cross each other constantly wherever two of them run down the same street, and the order its
// partings ask for is not the order that noise happens to like. What is actually being minimised
// falls in all three — the vote weight left unsatisfied goes from 1.7 km over 8 pairs to nothing
// for the ferries, 40.8 km over 132 pairs to 6.5 km over 67 for the New York subway, and 15.5 km
// over 44 pairs to 0.4 km over 7 for San Francisco's.
function laneOrder(
  routes: readonly number[],
  votes: Map<string, number>,
): Map<number, number> {
  // The votes as a dense matrix over the routes, `wants[first * routes.length + second]` being what
  // placing that first buys. Dense because the search below reads it a few hundred thousand times.
  const wants = new Float64Array(routes.length * routes.length);
  for (let first = 0; first < routes.length; first++) {
    for (let second = 0; second < routes.length; second++) {
      const left = routes[first];
      const right = routes[second];
      const vote =
        votes.get(left < right ? `${left},${right}` : `${right},${left}`) ?? 0;
      wants[first * routes.length + second] = left < right ? vote : -vote;
    }
  }

  const pull = routes.map((_, route) => {
    let total = 0;
    for (let other = 0; other < routes.length; other++) {
      total += wants[route * routes.length + other];
    }
    return total;
  });
  const order = routes.map((_, route) => route);
  order.sort((left, right) => pull[right] - pull[left] || left - right);

  // Moving one route through the ones between it and its new place flips its order with each of
  // them and with nobody else, so what the move is worth is that sum and not a rescore of the whole
  // order.
  for (let pass = 0; pass < routes.length; pass++) {
    let improved = false;
    for (let from = 0; from < order.length; from++) {
      for (let to = 0; to < order.length; to++) {
        let gain = 0;
        for (
          let at = Math.min(from + 1, to);
          at <= Math.max(from - 1, to);
          at++
        ) {
          if (at !== from) {
            gain +=
              (at > from ? -2 : 2) *
              wants[order[from] * routes.length + order[at]];
          }
        }
        if (gain > 0) {
          order.splice(to, 0, ...order.splice(from, 1));
          improved = true;
        }
      }
    }
    if (!improved) {
      break;
    }
  }
  return new Map(order.map((route, rank) => [routes[route], rank]));
}

// Per line and per vertex, in lane widths, which lane of its corridor that line holds *there* —
// which is what makes the offset local: a route displaces sideways only where it would otherwise
// draw over another, and goes back onto its own published shape as soon as it is alone again.
//
// Per vertex and not per line because a line's company changes along it: a ferry leaves the East
// River bundle for open water, and the 5 runs with the 2 in the Bronx and the 4 and 6 down
// Lexington Av.
//
// A lane is how much of the route order (`laneOrder`) ranks before this one *at that place*: the sum,
// over the routes that rank earlier, of how present each of them is in the cell the vertex falls in.
// Which is the whole of the no-weaving guarantee, because the sum is over a term per route that is
// never negative and the place is the same for both — so wherever two routes are in one cell, the
// one that ranks later holds the higher lane, and it holds it by a full lane, since a route is fully
// present in a cell it runs through. Their lanes cannot come level, let alone swap.
//
// It is a field over the cells rather than a mean taken along each line's own path for exactly that
// reason: a mean along the line reads the company either side of the vertex, which is a different
// stretch of route for each of them, and over New York's ferry file that swapped three pairs of
// routes' lanes by as much as 1.5 lane widths where one of them was leaving a bundle the other was
// joining.
function laneTracks(
  lines: readonly RoutedPolyline[],
  occupancy: Occupancy,
  ranks: Map<number, number>,
  cellLng: number,
  cellLat: number,
  cellMeters: number,
  blendMeters: number,
): Float64Array[] {
  const presence = [...ranks].map(([route, rank]) => ({
    rank,
    present: presenceOf(occupancy, route, cellMeters, blendMeters),
  }));
  return lines.map(({ lngs, lats, route }) => {
    const own = ranks.get(route) ?? 0;
    return Float64Array.from(lngs, (lng, vertex) => {
      const cell = occupancy.idOf.get(
        `${Math.floor(lng / cellLng)},${Math.floor(lats[vertex] / cellLat)}`,
      );
      if (cell === undefined) {
        return 0;
      } else {
        let lane = 0;
        for (const { rank, present } of presence) {
          if (rank < own) {
            lane += present[cell];
          }
        }
        return lane;
      }
    });
  });
}

// How wide one lane is, in CSS pixels, at `zoom`. At and above `fullZoom` it is the full `spacingPx`
// — a screen distance, so a bundle neither merges as the map zooms out nor spreads as it zooms in.
// Below it the lane is a *ground* distance instead, halving with every level out.
//
// Per-stretch lanes (laneTracks) settle how many lanes a bundle has; the taper is what keeps that
// bundle inside the water or the street it belongs to, because a lane held at a screen width is a
// ground distance that doubles with every zoom out. New York's tightest genuine ferry bundle
// measures it: four routes down Buttermilk Channel between Governors Island and Red Hook, where the
// channel is 414 m across — 28.6 px at z13, 14.3 px at z12, 7.1 px at z11. Held at 2.5 px their
// three lane widths would be 109 m at z13 and 435 m at z11, wider than the channel itself. Tapered
// below z14 they are a fixed 54 m band, an eighth of the channel at every zoom out.
export function laneSpacingPx(
  zoom: number,
  spacingPx: number,
  fullZoom: number,
): number {
  return spacingPx * Math.min(1, 2 ** (zoom - fullZoom));
}

// The perpendicular the lane offset is applied along, per vertex, taken from the whole polyline:
// a tile that took it from its own clipped piece would step the ribbon sideways at every seam.
//
// Interior vertices get the mitre of the two adjoining perpendiculars — the offset line stays the
// full lane width from the original through a corner rather than pinching in on the inside of it.
//
// `sense` is which of the two perpendiculars that is, +1 or -1, and it is not this line's own to
// pick: see `orientations`.
function offsetNormals(
  lngs: Float64Array,
  lats: Float64Array,
  sense: number,
): { normalX: Float64Array; normalY: Float64Array } {
  const count = lngs.length;
  if (count < 2) {
    return {
      normalX: new Float64Array(count),
      normalY: new Float64Array(count),
    };
  }
  const pixelX = Float64Array.from(lngs, (lng) => projectX(lng, NORMAL_ZOOM));
  const pixelY = Float64Array.from(lats, (lat) => projectY(lat, NORMAL_ZOOM));

  // Per span, the unit perpendicular of its own direction on the side `sense` puts it. Strictly its
  // own direction, with nothing carried over from the span before: a side carried through a corner
  // is a side that depends on how much the line turned before it got here, and a ferry shape turns
  // more than 90° wherever it follows the boat into its slip — over New York's ferry file that left
  // 24 of the 36 crossings with most of their spans offset on the carried side rather than the side
  // their own direction gives, which no other line running the same water can agree with.
  const spanX = new Float64Array(count - 1);
  const spanY = new Float64Array(count - 1);
  let lastX = 0;
  let lastY = 1;
  for (let span = 0; span + 1 < count; span++) {
    const deltaX = pixelX[span + 1] - pixelX[span];
    const deltaY = pixelY[span + 1] - pixelY[span];
    const length = Math.hypot(deltaX, deltaY);
    if (length > 0) {
      lastX = (sense * deltaY) / length;
      lastY = (-sense * deltaX) / length;
    }
    spanX[span] = lastX;
    spanY[span] = lastY;
  }

  const normalX = new Float64Array(count);
  const normalY = new Float64Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    const before = Math.max(vertex - 1, 0);
    const after = Math.min(vertex, count - 2);
    const sumX = spanX[before] + spanX[after];
    const sumY = spanY[before] + spanY[after];
    const length = Math.hypot(sumX, sumY);
    if (length === 0) {
      normalX[vertex] = spanX[after];
      normalY[vertex] = spanY[after];
    } else {
      const cosine = (sumX * spanX[after] + sumY * spanY[after]) / length;
      const miter = 1 / Math.max(cosine, 1 / MITER_LIMIT);
      normalX[vertex] = (sumX / length) * miter;
      normalY[vertex] = (sumY / length) * miter;
    }
  }
  return { normalX, normalY };
}

// Below this the two lines are crossing rather than sharing, and a crossing says nothing about which
// way round either of them should be read.
const MIN_PARALLEL_COSINE = Math.cos((30 * Math.PI) / 180);

// Which way round each line's direction is read when its perpendicular is taken, +1 or -1.
//
// This is not a line's own choice to make. A perpendicular taken from a line's own direction points
// the opposite way on a line stored back to front, so the same lane index lands on opposite sides of
// the water they share and the two ribbons weave across each other. The artifacts have no common
// orientation to lean on: of the co-located near-parallel samples in New York's ferry file 39% run
// opposite ways, and 7% of the subway file's. Taking the side from each line's own chord — its
// average direction, which in a corridor it only crosses says nothing about the corridor — left 53%
// of those ferry pairs and 7% of the subway ones with mirrored normals.
//
// So the choice is per *bundle*, not per line. Lines vote pairwise: every cell two of them share
// contributes the dot product of their mean directions there, positive where they are stored the
// same way round and negative where they are stored opposite. The votes are then settled
// strongest-first over a spanning forest, so a bundle's orientation is set by the longest and
// straightest agreement in it and the rest follows; a pair still disagreeing once both are in the
// tree is outvoted rather than honoured. Which way the whole bundle faces is free — it mirrors which
// side of the corridor the stack builds out on, the same for every line in it — and is taken
// eastward off the bundle's combined chord, so a line sharing water with nobody keeps the chord rule
// it had.
function orientations(
  lines: readonly Polyline[],
  walked: readonly Walked[],
  { routes, sampled }: Occupancy,
): Float64Array {
  const headings = routes.map(
    () => new Map<number, { x: number; y: number; samples: number }>(),
  );
  for (const [index, { sampleDirX, sampleDirY }] of walked.entries()) {
    for (let sample = 0; sample < sampleDirX.length; sample++) {
      const cell = headings[sampled[index][sample]];
      const heading = cell.get(index);
      if (heading) {
        heading.x += sampleDirX[sample];
        heading.y += sampleDirY[sample];
        heading.samples++;
      } else {
        cell.set(index, {
          x: sampleDirX[sample],
          y: sampleDirY[sample],
          samples: 1,
        });
      }
    }
  }

  // A line's heading in a cell is its samples' mean direction, so a line that turns through the cell
  // or doubles back inside it is short of a unit vector and counts for less than one running
  // straight through. The vote is the dot product of the two headings, which carries both how
  // parallel they are and how sure the cell is of either.
  const votes = new Map<string, number>();
  for (const cell of headings) {
    const present = [...cell].map(([index, { x, y, samples }]) => ({
      index,
      x: x / samples,
      y: y / samples,
    }));
    for (let first = 0; first < present.length; first++) {
      for (let second = first + 1; second < present.length; second++) {
        const vote =
          present[first].x * present[second].x +
          present[first].y * present[second].y;
        const cosine =
          vote /
          (Math.hypot(present[first].x, present[first].y) *
            Math.hypot(present[second].x, present[second].y));
        if (Math.abs(cosine) >= MIN_PARALLEL_COSINE) {
          const key = `${present[first].index},${present[second].index}`;
          votes.set(key, (votes.get(key) ?? 0) + vote);
        }
      }
    }
  }

  // Union-find over the lines, carrying each one's sense relative to its component's root, so an
  // edge joins two bundles by the sense that satisfies it.
  const parent = Int32Array.from(lines, (_, index) => index);
  const flipped = new Uint8Array(lines.length);
  const find = (node: number): { root: number; flip: number } => {
    let root = node;
    let flip = 0;
    while (parent[root] !== root) {
      flip ^= flipped[root];
      root = parent[root];
    }
    for (let step = node, stepFlip = flip; parent[step] !== step; ) {
      const next = parent[step];
      const nextFlip = stepFlip ^ flipped[step];
      parent[step] = root;
      flipped[step] = stepFlip;
      step = next;
      stepFlip = nextFlip;
    }
    return { root, flip };
  };

  const edges = [...votes].map(([key, weight]) => {
    const [first, second] = key.split(",").map(Number);
    return { first, second, weight };
  });
  edges.sort(
    (left, right) =>
      Math.abs(right.weight) - Math.abs(left.weight) ||
      left.first - right.first ||
      left.second - right.second,
  );
  for (const { first, second, weight } of edges) {
    const from = find(first);
    const to = find(second);
    if (from.root !== to.root) {
      parent[from.root] = to.root;
      flipped[from.root] = from.flip ^ to.flip ^ (weight < 0 ? 1 : 0);
    }
  }
  const senses = Float64Array.from(lines, (_, index) =>
    find(index).flip ? -1 : 1,
  );

  // Not every set of votes can be satisfied at once: three lines whose shared water asks A to agree
  // with B, B with C and C to disagree with A have no answer, and the tree above resolves the cycle
  // by ignoring whichever vote it reached last rather than the weakest. So each line is then offered
  // its own flip, in weight order and repeatedly, and takes it whenever that leaves less vote weight
  // unsatisfied than before — which over New York's ferry file settles 14.3% of the weight
  // unsatisfied down to 3.8%, and the subway file's 0.26% to 0.20%.
  const neighbours = lines.map((): { line: number; weight: number }[] => []);
  for (const { first, second, weight } of edges) {
    neighbours[first].push({ line: second, weight });
    neighbours[second].push({ line: first, weight });
  }
  for (let pass = 0; pass < lines.length; pass++) {
    let improved = false;
    for (let line = 0; line < lines.length; line++) {
      let satisfied = 0;
      for (const { line: other, weight } of neighbours[line]) {
        satisfied += senses[line] * senses[other] * weight;
      }
      if (satisfied < 0) {
        senses[line] = -senses[line];
        improved = true;
      }
    }
    if (!improved) {
      break;
    }
  }

  // Each bundle faces the way its lines' chords, read with the senses just settled, mostly face.
  const chordX = new Map<number, number>();
  const chordY = new Map<number, number>();
  for (const [index, { lngs, lats }] of lines.entries()) {
    const last = lngs.length - 1;
    const { root } = find(index);
    const sense = senses[index];
    if (last > 0) {
      const alongX =
        projectX(lngs[last], NORMAL_ZOOM) - projectX(lngs[0], NORMAL_ZOOM);
      const alongY =
        projectY(lats[last], NORMAL_ZOOM) - projectY(lats[0], NORMAL_ZOOM);
      chordX.set(root, (chordX.get(root) ?? 0) + sense * alongX);
      chordY.set(root, (chordY.get(root) ?? 0) + sense * alongY);
    }
  }
  for (const [index] of lines.entries()) {
    const root = find(index).root;
    const alongX = chordX.get(root) ?? 0;
    const alongY = chordY.get(root) ?? 0;
    const eastward = alongX > 0 || (alongX === 0 && alongY > 0) ? 1 : -1;
    senses[index] *= eastward;
  }
  return senses;
}

// What a lane overlay draws each of its lines with: the lane it holds at each vertex and the
// perpendicular that lane is measured along. The two are one call because they are one decision —
// a lane is a signed distance, and the sign is only meaningful once every line through the corridor
// measures it the same way (see `orientations`).
export function laneRibbons(
  lines: readonly RoutedPolyline[],
  { cellMeters, blendMeters, latitude }: LaneOptions,
): { lanes: Float64Array; normalX: Float64Array; normalY: Float64Array }[] {
  const cellLat = cellMeters / METERS_PER_DEGREE_LAT;
  const cellLng = cellMeters / metersPerLng(latitude);
  const walked = lines.map((line) => walk(line, cellLng, cellLat));
  const occupancy = occupancyOf(lines, walked, cellLng, cellLat);
  // The senses come first because the lane order is read off the same axis the lanes are drawn
  // along, and that axis is only meaningful once the bundle agrees which way round it faces.
  const senses = orientations(lines, walked, occupancy);
  const routeIds = [...new Set(lines.map((line) => line.route))].sort(
    (left, right) => left - right,
  );
  const ranks = laneOrder(
    routeIds,
    partingVotes(
      lines,
      walked,
      occupancy,
      senses,
      cellLng,
      cellLat,
      cellMeters,
      blendMeters,
      metersPerPixel(latitude),
    ),
  );
  const lanes = laneTracks(
    lines,
    occupancy,
    ranks,
    cellLng,
    cellLat,
    cellMeters,
    blendMeters,
  );
  return lines.map(({ lngs, lats }, index) => ({
    lanes: lanes[index],
    ...offsetNormals(lngs, lats, senses[index]),
  }));
}
