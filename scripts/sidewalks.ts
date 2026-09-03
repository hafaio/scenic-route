// The sources that say whether a street's sidewalks actually exist, and the per-side bits they
// settle. Fetches OSM's own `footway=sidewalk|crossing|traffic_island` ways into
// data/sidewalks/<id>.bin (magic SWLK) and the city's own survey, then stamps four bits into every
// offsetted STRT record: whether OSM maps a sidewalk on each side, and whether a survey says there
// is one there. DESIGN.md, "Whether there is pavement at all", is why more than one source is
// needed and why the NYC planimetric layer is `52n9-sdep` and not its look-alike sibling; the gate
// in the graph pass (crates/tiler/src/graph.rs) drops a side only when all of them are silent.
//
// Behind the city's own survey stands OSM's OTHER way of recording a pavement: the `sidewalk`,
// `sidewalk:left`, `sidewalk:right` and `sidewalk:both` keys on the ROAD, which say per kerb what a
// separately-drawn footway says by being drawn. Some cities map one way, some the other — San
// Francisco and New York draw the ways, the East Bay largely tags the roads — so a pipeline that
// reads only the ways sees a fraction of what OSM records. The tags answer only where the city's
// survey has nothing to say, which is `statedSides` below. Layouts: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildNameTable, densify, encodeNetwork, UNNAMED_ID } from "./geometry";
import type { LandContext } from "./land";
import type { SourceFile } from "./manifest";
import {
  fetchSidewalks,
  fetchSidewalkTags,
  type SidewalkTaggedRoad,
  type SidewalkWay,
} from "./overpass";
import { projectX, projectY } from "./planar";
import { SIDEWALK_WIDTH_COUNT, SIDEWALK_WIDTH_DATASET } from "./sf";
import { type Coord, DATA_SF, NYC_OPEN_DATA } from "./socrata";
import { toInt } from "./streets";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const SIDEWALK_DIR = join(DATA_DIR, "sidewalks");
const SIDEWALK_MAGIC = "SWLK";
const SIDEWALK_FORMAT = 1;
// Record byte 20, deliberately outside CSCL's rw_type range (1..10) and PATH's 6/7: a reader
// pointed at the wrong file gets a kind it cannot mistake for a road type.
const KIND_SIDEWALK = 20;
const KIND_CROSSING = 21;
const KIND_TRAFFIC_ISLAND = 22;
const DENSIFY_METERS = 25; // PATH's step, so the two OSM extracts read under one rule
const U32_MAX = 0xffffffff; // record offset 0 is a u32; an OSM id past this cannot be stored

// STRT record byte 23, bits 3-6 — the per-side bits this writes. Left and right follow the
// digitization direction, left = 90 degrees counter-clockwise of travel, which is what
// crates/tiler/src/sidewalks.rs offsets the left sidewalk along and what the density blob's two
// bytes a vertex are ordered by.
export const FLAG_OSM_LEFT = 1 << 3; // an OSM sidewalk way flanks the left side
export const FLAG_OSM_RIGHT = 1 << 4;
// A survey says the left side carries pavement — the city's own where it publishes one (New York's
// aerial ROW polygons, San Francisco's widths study), and OSM's `sidewalk=*` tag on the road itself
// on any side that survey leaves unstated. "Surveyed", not "paved": the source says a sidewalk is
// there, and says nothing about what it is made of.
export const FLAG_SURVEYED_LEFT = 1 << 5;
export const FLAG_SURVEYED_RIGHT = 1 << 6;

// The corridor matcher: at each sample along a street, an OSM sidewalk sub-segment counts for a
// side when it runs alongside rather than across, sits beyond the roadway but not a block away,
// and falls on that side of the centreline. The near limit keeps a way drawn ON the centreline
// (a mis-mapped alley) from claiming both sides; the far limit is the derived sidewalk position
// plus the slack a real kerb line wanders by. This is its own test, deliberately not a widening
// of the conflation's 6 m dedup band: that band was tuned to shed on-street bike lanes, and a
// narrow street's sidewalk sits at ~5.7 m, inside it.
const SAMPLE_METERS = 20;
const MIN_MATCH_METERS = 2;
const EXTRA_MATCH_METERS = 12; // beyond the side's half-offset
const MATCH_BEARING_DEGREES = 30; // mod 180: a sidewalk may be digitized either way round
const MATCH_FRACTION = 0.5; // of a segment's samples, for the side to count as mapped

// The survey probe. Stations are closer together than the match samples because a polygon gap —
// a driveway kerb cut, a plaza the layer draws separately — is a metres-wide hole, and each
// station fans across the sidewalk's own width so a station is not lost to a half-metre error in
// CSCL's roadway width or in where the centreline was digitized.
const STATION_METERS = 15;
const PROBE_FAN_METERS = [-1.5, 0, 1.5];
// The fan a street with no `streetwidth` gets instead. Its offset is not a measured width off by
// half a metre, it is the citywide median standing in for a width nobody recorded, so the fan has
// to cover the spread of what that width could have been: over the 104,658 offsetted segments that
// do carry one, the 1st to 99th percentile is 10 to 70 ft, which around the assumed 30 is -3.0 to
// +6.1 m of half-offset. Measured by throwing away the width of the streets that have one and
// re-probing them at the assumption: the narrow fan gets the true-width answer back on 84.7% of
// them and loses both sides of 7.5%, this one on 95.0% and 0.1%, and going wider still (-3..+9)
// falls back to 92.8% on sides it invents.
const ASSUMED_WIDTH_FAN_METERS = [-3, -1.5, 0, 1.5, 3, 4.5, 6];
const SURVEYED_FRACTION = 0.5;
const PROBE_GRID_METERS = 40; // ring bucket for the polygon index, a little over a station's fan

const SIDEWALK_DATASET = "52n9-sdep"; // NYC planimetric SIDEWALK polygons
const SIDEWALK_SUB_CODE = "380000"; // street ROW; 380010 is the interior-campus walkway
const SIDEWALK_POLYGON_COUNT = 44_683; // a floor, as every paged read here carries

// Mirrors crates/tiler/src/sidewalks.rs::half_offset_meters, which is what actually places the
// derived sidewalk lines: half the roadway plus the kerb inset, zero for the road types that ARE
// the walking surface. The bits below only mean anything where this is non-zero.
const METERS_PER_FOOT = 0.3048;
const MEDIAN_WIDTH_FEET = 30;
const SIDEWALK_INSET_METERS = 2;
const MAX_OFFSET_METERS = 25.5;
const FLAG_VEHICULAR_ONLY = 1 << 0;
const FLAG_NON_VEHICULAR = 1 << 1;
const FLAG_STRUCTURE = 1 << 2; // and SWLK byte 23's only bit, as PATH's
const WIDTH_BASED_TYPES = [1, 3, 4, 10]; // street, bridge, tunnel, alley

// The parts of a STRT segment the per-side bits are computed from. `flags` is stamped in place,
// the way buildNameTable stamps a record's name id.
export interface SidedSegment {
  // The city's own id for the row, which a survey published as a table is joined on.
  physicalId: number;
  roadType: number;
  streetWidth: number;
  flags: number;
  lengthMeters: number;
  points: Coord[];
}

function halfOffsetMeters(segment: SidedSegment): number {
  if (
    !WIDTH_BASED_TYPES.includes(segment.roadType) ||
    (segment.flags & FLAG_NON_VEHICULAR) !== 0
  ) {
    return 0;
  }
  const feet =
    segment.streetWidth === 0 ? MEDIAN_WIDTH_FEET : segment.streetWidth;
  return Math.min(
    (feet * METERS_PER_FOOT) / 2 + SIDEWALK_INSET_METERS,
    MAX_OFFSET_METERS,
  );
}

// A street the bits are meaningful for: one the tiler offsets two sidewalk lines off. A
// vehicular-only corridor is drawn but never walked, so its sides are not asked about.
function isOffsetted(segment: SidedSegment): boolean {
  return (
    (segment.flags & FLAG_VEHICULAR_ONLY) === 0 && halfOffsetMeters(segment) > 0
  );
}

// A uniform-grid index over line pieces or polygon rings in the shared metre frame. Both probes
// ask the same question — what is within a few tens of metres of this point — and the city is
// dense enough that a grid beats any tree here.
class Grid<Item> {
  private readonly cells = new Map<number, Item[]>();

  constructor(private readonly cellMeters: number) {}

  private static key(cellX: number, cellY: number): number {
    return cellX * 100_003 + cellY;
  }

  insert(item: Item, box: readonly number[]): void {
    const [minX, minY, maxX, maxY] = box;
    for (
      let cellX = Math.floor(minX / this.cellMeters);
      cellX <= Math.floor(maxX / this.cellMeters);
      cellX++
    ) {
      for (
        let cellY = Math.floor(minY / this.cellMeters);
        cellY <= Math.floor(maxY / this.cellMeters);
        cellY++
      ) {
        const key = Grid.key(cellX, cellY);
        const cell = this.cells.get(key);
        if (cell === undefined) {
          this.cells.set(key, [item]);
        } else {
          cell.push(item);
        }
      }
    }
  }

  near(x: number, y: number, radiusMeters: number): Item[] {
    const ring = Math.ceil(radiusMeters / this.cellMeters);
    const centreX = Math.floor(x / this.cellMeters);
    const centreY = Math.floor(y / this.cellMeters);
    const found: Item[] = [];
    for (let cellX = centreX - ring; cellX <= centreX + ring; cellX++) {
      for (let cellY = centreY - ring; cellY <= centreY + ring; cellY++) {
        const cell = this.cells.get(Grid.key(cellX, cellY));
        if (cell !== undefined) {
          found.push(...cell);
        }
      }
    }
    return found;
  }
}

// One straight piece of an OSM sidewalk way, in metres.
interface Piece {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function indexPieces(segments: readonly SidewalkSegment[]): Grid<Piece> {
  const grid = new Grid<Piece>(PROBE_GRID_METERS);
  for (const way of segments) {
    if (way.kind !== KIND_SIDEWALK) {
      continue; // a crossing runs across the street, an island sits in it: neither is a side
    }
    for (let index = 1; index < way.points.length; index++) {
      const from = way.points[index - 1];
      const to = way.points[index];
      const piece = {
        x1: projectX(from.lng),
        y1: projectY(from.lat),
        x2: projectX(to.lng),
        y2: projectY(to.lat),
      };
      grid.insert(piece, [
        Math.min(piece.x1, piece.x2),
        Math.min(piece.y1, piece.y2),
        Math.max(piece.x1, piece.x2),
        Math.max(piece.y1, piece.y2),
      ]);
    }
  }
  return grid;
}

// Which sides of one sample an OSM sidewalk flanks: [left, right].
function sampleSides(
  pieces: Grid<Piece>,
  x: number,
  y: number,
  alongX: number,
  alongY: number,
  halfOffset: number,
): [boolean, boolean] {
  const limit = halfOffset + EXTRA_MATCH_METERS;
  const cosLimit = Math.cos((MATCH_BEARING_DEGREES * Math.PI) / 180);
  let left = false;
  let right = false;
  for (const piece of pieces.near(x, y, limit)) {
    const edgeX = piece.x2 - piece.x1;
    const edgeY = piece.y2 - piece.y1;
    const length = Math.hypot(edgeX, edgeY);
    if (length === 0) {
      continue;
    } else if (
      Math.abs((edgeX * alongX + edgeY * alongY) / length) < cosLimit
    ) {
      continue; // runs across the street, not along it
    }
    const along = Math.max(
      0,
      Math.min(
        1,
        ((x - piece.x1) * edgeX + (y - piece.y1) * edgeY) / (length * length),
      ),
    );
    const toX = piece.x1 + along * edgeX - x;
    const toY = piece.y1 + along * edgeY - y;
    const distance = Math.hypot(toX, toY);
    if (distance < MIN_MATCH_METERS || distance > limit) {
      continue;
    } else if (alongX * toY - alongY * toX > 0) {
      left = true;
    } else {
      right = true;
    }
    if (left && right) {
      return [true, true];
    }
  }
  return [left, right];
}

// One station along a segment: where it is and which way the street runs there.
interface Station {
  x: number;
  y: number;
  alongX: number;
  alongY: number;
}

// The segment cut into `ceil(length / stepMeters)` equal pieces, one station at the centre of each,
// each carrying the local tangent. Centred rather than started at arc length 0: a CSCL segment ends
// at an intersection, so a station on the end vertex takes its perpendicular offset into the *cross*
// street's roadway, and the shorter the segment the more of its answer that one station is. A
// segment under one step gets its midpoint, which is as far from both junctions as it can be, and
// the spacing stays at most `stepMeters` so the gaps the probe is looking for cannot hide between
// two stations.
function stations(points: readonly Coord[], stepMeters: number): Station[] {
  const xs = points.map((point) => projectX(point.lng));
  const ys = points.map((point) => projectY(point.lat));
  let total = 0;
  for (let index = 1; index < xs.length; index++) {
    total += Math.hypot(xs[index] - xs[index - 1], ys[index] - ys[index - 1]);
  }
  if (total === 0) {
    return [];
  }
  const count = Math.max(1, Math.ceil(total / stepMeters));
  const spacing = total / count;
  const found: Station[] = [];
  let travelled = 0; // arc length at the start of the current piece
  let which = 0; // how many stations have been placed
  for (let index = 1; index < xs.length && which < count; index++) {
    const edgeX = xs[index] - xs[index - 1];
    const edgeY = ys[index] - ys[index - 1];
    const length = Math.hypot(edgeX, edgeY);
    if (length === 0) {
      continue;
    }
    const alongX = edgeX / length;
    const alongY = edgeY / length;
    while (which < count && (which + 0.5) * spacing <= travelled + length) {
      const at = (which + 0.5) * spacing - travelled;
      found.push({
        x: xs[index - 1] + alongX * at,
        y: ys[index - 1] + alongY * at,
        alongX,
        alongY,
      });
      which += 1;
    }
    travelled += length;
  }
  return found;
}

interface PolygonRow {
  the_geom?: { coordinates: [number, number][][][] };
}

// One ring of one planimetric sidewalk polygon, interleaved [x0, y0, x1, y1, ...] in metres, with
// the feature it belongs to: a polygon's rings are filled even-odd (an outer ring and its holes),
// so a hit has to be resolved per feature rather than by toggling across every ring nearby.
interface Ring {
  feature: number;
  coords: Float64Array;
}

// San Francisco's survey: the 2014 Sidewalk Widths study, which records per centreline segment
// which SIDES carry a sidewalk — "Both", "None", or a compass side. That is the same statement the
// polygon probe works to reach, published directly, so it is read rather than probed.
//
// A compass side has to be resolved against the segment's own direction, because left and right are
// the digitisation's: left faces 90 degrees counter-clockwise of travel. A segment with no row is
// left unsurveyed rather than assumed bare — 94% of segments carry one, and the existence gate still
// has OSM's mapping to fall back on for the rest.
async function sfSurvey(): Promise<Survey> {
  const rows = await DATA_SF.dataset<{ cnn?: string; side?: string }>(
    SIDEWALK_WIDTH_DATASET,
    { $select: "cnn,side" },
    SIDEWALK_WIDTH_COUNT,
  );
  // Keyed through the same normalisation the segment's own id went through (`toInt` of the raw
  // column), so the two sides of the join cannot drift. Keyed on the raw string, a leading zero or a
  // ".0" suffix would miss for EVERY segment and the survey would report no pavement anywhere, with
  // nothing to say it had.
  const sides = new Map<string, string>();
  for (const row of rows) {
    if (row.cnn && row.side) {
      sides.set(String(toInt(row.cnn)), row.side.trim().toUpperCase());
    }
  }
  return (segment) => {
    const side = sides.get(String(segment.physicalId));
    if (side === undefined) {
      return { left: "unstated", right: "unstated" };
    }
    if (side === "NONE") {
      return { left: "bare", right: "bare" };
    }
    if (side === "BOTH") {
      return { left: "paved", right: "paved" };
    }
    // The bearing of the whole segment, end to end, is enough: a city block does not turn far
    // enough for its two ends to disagree about which way is north.
    const first = segment.points[0];
    const last = segment.points[segment.points.length - 1];
    const bearing = Math.atan2(
      (last.lng - first.lng) * Math.cos(((first.lat + last.lat) / 2) * DEGREES),
      last.lat - first.lat,
    );
    // Left faces a quarter turn counter-clockwise of travel, right a quarter turn clockwise.
    const facing = (turn: number): number =>
      ((bearing + turn) / DEGREES + 360) % 360;
    const wanted = COMPASS[side];
    if (wanted === undefined) {
      return { left: "unstated", right: "unstated" }; // a value nobody has seen: not a bare kerb
    }
    const away = (from: number): number => {
      const gap = Math.abs(((from - wanted + 540) % 360) - 180);
      return gap;
    };
    // The study names the one side that carries pavement, so the other is a stated bare.
    const left = away(facing(-Math.PI / 2)) < away(facing(Math.PI / 2));
    return {
      left: left ? "paved" : "bare",
      right: left ? "bare" : "paved",
    };
  };
}

const DEGREES = Math.PI / 180;
const COMPASS: Record<string, number> = {
  // One row spells south "STH". Reading it as "both sides" would have claimed pavement the survey
  // never recorded, on the strength of a typo.
  STH: 180,
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

export const NYC_SURVEY: () => Promise<Survey> = async () =>
  polygonSurvey(await fetchSurveyedSidewalks());
export const SF_SURVEY: () => Promise<Survey> = sfSurvey;

async function fetchSurveyedSidewalks(): Promise<Grid<Ring>> {
  // The geometry alone, not the `*` the smaller sources ask for: these polygons are ~450 MB of
  // GeoJSON on their own, and the columns beside them (source ids, shape lengths, capture status)
  // are of no use to a point-in-polygon probe.
  const rows = await NYC_OPEN_DATA.dataset<PolygonRow>(
    SIDEWALK_DATASET,
    { $select: "the_geom", $where: `sub_code='${SIDEWALK_SUB_CODE}'` },
    SIDEWALK_POLYGON_COUNT,
  );
  const grid = new Grid<Ring>(PROBE_GRID_METERS);
  let feature = 0;
  for (const row of rows) {
    for (const polygon of row.the_geom?.coordinates ?? []) {
      feature += 1;
      for (const ring of polygon) {
        const coords = new Float64Array(ring.length * 2);
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < ring.length; index++) {
          const x = projectX(ring[index][0]);
          const y = projectY(ring[index][1]);
          coords[index * 2] = x;
          coords[index * 2 + 1] = y;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        grid.insert({ feature, coords }, [minX, minY, maxX, maxY]);
      }
    }
  }
  return grid;
}

function inRing(coords: Float64Array, x: number, y: number): boolean {
  let inside = false;
  for (
    let at = 0, previous = coords.length - 2;
    at < coords.length;
    previous = at, at += 2
  ) {
    const atY = coords[at + 1];
    const previousY = coords[previous + 1];
    if (
      atY > y !== previousY > y &&
      x <
        ((coords[previous] - coords[at]) * (y - atY)) / (previousY - atY) +
          coords[at]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function onSurveyedSidewalk(survey: Grid<Ring>, x: number, y: number): boolean {
  const hits: number[] = [];
  for (const ring of survey.near(x, y, 0)) {
    if (inRing(ring.coords, x, y)) {
      hits.push(ring.feature);
    }
  }
  if (hits.length < 2) {
    return hits.length === 1; // the common case: one polygon, no hole under the point
  } else {
    // Two or more rings of the same feature: an odd count is inside its outer ring and outside
    // every hole of it, an even one fell in a hole. Rings of different features never overlap.
    return hits.some(
      (feature) => hits.filter((other) => other === feature).length % 2 === 1,
    );
  }
}

// What one side of a street carries, as a source states it. Three states and not two, because
// "there is no pavement here" and "nobody has said" are different facts and only one of them is
// evidence: OSM's silence is a mapping gap or a bare kerb and cannot be told apart, where
// `sidewalk=no` and a survey row reading NONE are somebody saying the kerb is bare. Only "paved"
// sets a STRT bit, so bare and unstated land on the same four bits — but they are held apart here
// because a stated bare is what stops a weaker source being asked, and because the build reports
// them apart: a region that is largely unstated is missing data, and one that is largely bare is
// missing pavement.
export type SideState = "paved" | "bare" | "unstated";

// What a source says a street has pavement on, per side, in the segment's own left/right terms.
// New York answers it by probing planimetric polygons; San Francisco publishes the answer as a
// column; OSM's road tags answer it wherever a mapper wrote one down. A survey is the authoritative
// half of the existence gate — OSM's silence is ambiguous between a mapping gap and genuinely bare
// kerb, and a survey's is not.
export interface SidewalkSides {
  left: SideState;
  right: SideState;
}

export type Survey = (segment: SidedSegment) => SidewalkSides;

// The city's own survey first, OSM's on-street tags only on a side it leaves unstated. The order is
// not a preference between two equals and the two are deliberately not unioned: a municipal survey
// is one trace of the whole city, where a tag is one mapper's note on one way, and a city that
// already has a survey must not have its numbers moved by a source it never used. New York's
// polygon probe answers every side of every street, so it never reaches the tags at all; San
// Francisco's widths study answers the 94% of segments that carry a row; the East Bay has no survey,
// so the tags are the whole of its answer.
export function statedSides(
  own: SidewalkSides,
  tagged: () => SidewalkSides,
): SidewalkSides {
  if (own.left !== "unstated" && own.right !== "unstated") {
    return own; // asked lazily, so New York's probe never pays for a match it cannot use
  } else {
    const tags = tagged();
    return {
      left: own.left === "unstated" ? tags.left : own.left,
      right: own.right === "unstated" ? tags.right : own.right,
    };
  }
}

// One tag value on a side-specific key (`sidewalk:left`, `sidewalk:right`, `sidewalk:both`).
// `separate` is deliberately no statement: it says the pavement is drawn as its own way, which is
// what the mapped bits already answer, so reading it as presence would claim one side twice from
// one fact — and it says nothing at all where the way it points at was never drawn.
function sideState(value: string | undefined): SideState {
  switch (value) {
    case "yes":
      return "paved";
    case "no":
    case "none":
      return "bare";
    default:
      return "unstated";
  }
}

// The four keys resolved to one statement per kerb, in the WAY's own digitization direction. The
// generic `sidewalk` key is read first and the side-specific keys override it, which is the
// convention a mapper refining `sidewalk=both` into `sidewalk:left=no` is relying on.
export function taggedSides(road: SidewalkTaggedRoad): SidewalkSides {
  let left: SideState = "unstated";
  let right: SideState = "unstated";
  switch (road.sidewalk) {
    case "both":
    // `yes` predates the sided values and the wiki deprecates it in their favour. It asserts a
    // pavement without saying which kerb, and both sides is the only reading that keeps the
    // assertion: there is no side to pick, and dropping it would throw away a mapper's statement
    // that the street is walkable on the strength of the form they wrote it in.
    case "yes":
      left = "paved";
      right = "paved";
      break;
    // "on the left side only", so the other kerb is a stated bare rather than an unstated one.
    case "left":
      left = "paved";
      right = "bare";
      break;
    case "right":
      left = "bare";
      right = "paved";
      break;
    case "no":
    case "none":
      left = "bare";
      right = "bare";
      break;
    default:
      break; // `separate`, `crossing`, absent: no statement about either kerb
  }
  const both = sideState(road.both);
  if (both !== "unstated") {
    left = both;
    right = both;
  }
  const taggedLeft = sideState(road.left);
  if (taggedLeft !== "unstated") {
    left = taggedLeft;
  }
  const taggedRight = sideState(road.right);
  if (taggedRight !== "unstated") {
    right = taggedRight;
  }
  return { left, right };
}

// One straight piece of a tagged OSM road, carrying what its two kerbs are said to have. The states
// are the piece's own direction's, so a station has to orient itself against it before reading them.
interface TaggedPiece extends Piece {
  left: SideState;
  right: SideState;
}

// The OSM road that IS this centreline, not one beside it. The two datasets draw the same street
// within a metre or two of each other, and the city grid puts the next parallel road most of a
// block away, so the nearest aligned way inside this radius is that street. A dual carriageway is
// the case that pushes it: OSM splits one where the city centreline does not, which leaves the
// centreline between the two halves rather than on either.
const TAG_MATCH_METERS = 12;

function indexTaggedRoads(
  roads: readonly SidewalkTaggedRoad[],
): Grid<TaggedPiece> {
  const grid = new Grid<TaggedPiece>(PROBE_GRID_METERS);
  for (const road of roads) {
    const sides = taggedSides(road);
    if (sides.left === "unstated" && sides.right === "unstated") {
      continue; // a `sidewalk:left:surface` or a `separate`: fetched, but saying nothing
    }
    for (let index = 1; index < road.points.length; index++) {
      const from = road.points[index - 1];
      const to = road.points[index];
      const piece = {
        x1: projectX(from.lng),
        y1: projectY(from.lat),
        x2: projectX(to.lng),
        y2: projectY(to.lat),
        left: sides.left,
        right: sides.right,
      };
      grid.insert(piece, [
        Math.min(piece.x1, piece.x2),
        Math.min(piece.y1, piece.y2),
        Math.max(piece.x1, piece.x2),
        Math.max(piece.y1, piece.y2),
      ]);
    }
  }
  return grid;
}

// The nearest tagged road piece running the same way as the street at this station, or undefined
// where none is close enough. Only the nearest is read, so a tagged service spur that grazes the
// radius cannot outvote the road the station is standing on.
function nearestTagged(
  roads: Grid<TaggedPiece>,
  x: number,
  y: number,
  alongX: number,
  alongY: number,
): TaggedPiece | undefined {
  const cosLimit = Math.cos((MATCH_BEARING_DEGREES * Math.PI) / 180);
  let nearest: TaggedPiece | undefined;
  let nearestDistance = TAG_MATCH_METERS;
  for (const piece of roads.near(x, y, TAG_MATCH_METERS)) {
    const edgeX = piece.x2 - piece.x1;
    const edgeY = piece.y2 - piece.y1;
    const length = Math.hypot(edgeX, edgeY);
    if (length === 0) {
      continue;
    } else if (
      Math.abs((edgeX * alongX + edgeY * alongY) / length) < cosLimit
    ) {
      continue; // a cross street through the junction, not this street
    }
    const along = Math.max(
      0,
      Math.min(
        1,
        ((x - piece.x1) * edgeX + (y - piece.y1) * edgeY) / (length * length),
      ),
    );
    const distance = Math.hypot(
      piece.x1 + along * edgeX - x,
      piece.y1 + along * edgeY - y,
    );
    if (distance < nearestDistance) {
      nearest = piece;
      nearestDistance = distance;
    }
  }
  return nearest;
}

// OSM's road tags as a survey: at each station along the street, the tagged road under it says what
// its two kerbs carry, turned round where OSM digitized the street the other way. A side is decided
// by the same "half the stations, not one lucky point" rule the other two sources are read under,
// over ALL the segment's stations rather than only the matched ones — a tag on a fifth of a block is
// not a statement about the block.
export function tagSurvey(roads: readonly SidewalkTaggedRoad[]): Survey {
  const grid = indexTaggedRoads(roads);
  return (segment) => {
    const samples = stations(segment.points, SAMPLE_METERS);
    const paved = [0, 0]; // left, right
    const bare = [0, 0];
    for (const { x, y, alongX, alongY } of samples) {
      const piece = nearestTagged(grid, x, y, alongX, alongY);
      if (piece === undefined) {
        continue;
      }
      // The tag's left and right are the OSM way's; this street may run the other way.
      const forward =
        (piece.x2 - piece.x1) * alongX + (piece.y2 - piece.y1) * alongY > 0;
      const sides = forward
        ? [piece.left, piece.right]
        : [piece.right, piece.left];
      for (const side of [0, 1]) {
        paved[side] += sides[side] === "paved" ? 1 : 0;
        bare[side] += sides[side] === "bare" ? 1 : 0;
      }
    }
    const decide = (side: number): SideState => {
      if (samples.length === 0) {
        return "unstated";
      } else if (paved[side] / samples.length >= MATCH_FRACTION) {
        return "paved";
      } else if (bare[side] / samples.length >= MATCH_FRACTION) {
        return "bare";
      } else {
        return "unstated";
      }
    };
    return { left: decide(0), right: decide(1) };
  };
}

// The four bits of one street. A side counts as mapped when the corridor matcher finds an OSM
// sidewalk way at half its samples, and as surveyed when the statement `statedSides` settled on
// reads "paved" — a stated bare and an unstated side both leave the bit clear, since the bits hold
// presence and the gate is an OR over them.
function sidesOf(
  segment: SidedSegment,
  pieces: Grid<Piece>,
  surveyed: SidewalkSides,
): number {
  const halfOffset = halfOffsetMeters(segment);
  let osmLeft = 0;
  let osmRight = 0;
  const samples = stations(segment.points, SAMPLE_METERS);
  for (const { x, y, alongX, alongY } of samples) {
    const [left, right] = sampleSides(pieces, x, y, alongX, alongY, halfOffset);
    osmLeft += left ? 1 : 0;
    osmRight += right ? 1 : 0;
  }
  const covered = (hits: number, total: number, fraction: number): boolean =>
    total > 0 && hits / total >= fraction;
  return (
    (covered(osmLeft, samples.length, MATCH_FRACTION) ? FLAG_OSM_LEFT : 0) |
    (covered(osmRight, samples.length, MATCH_FRACTION) ? FLAG_OSM_RIGHT : 0) |
    (surveyed.left === "paved" ? FLAG_SURVEYED_LEFT : 0) |
    (surveyed.right === "paved" ? FLAG_SURVEYED_RIGHT : 0)
  );
}

// New York's survey: the planimetric ROW-sidewalk polygons, probed every STATION_METERS along the
// street and fanned across the pavement's own width, and counted as present when half the stations
// land inside one.
function polygonSurvey(rings: Grid<Ring>): Survey {
  return (segment) => {
    const halfOffset = halfOffsetMeters(segment);
    const probes = stations(segment.points, STATION_METERS);
    const fanMeters =
      segment.streetWidth === 0 ? ASSUMED_WIDTH_FAN_METERS : PROBE_FAN_METERS;
    let left = 0;
    let right = 0;
    for (const { x, y, alongX, alongY } of probes) {
      for (const side of [1, -1]) {
        const hit = fanMeters.some((fan) => {
          const offset = side * (halfOffset + fan);
          return onSurveyedSidewalk(
            rings,
            x - alongY * offset,
            y + alongX * offset,
          );
        });
        if (side === 1) {
          left += hit ? 1 : 0;
        } else {
          right += hit ? 1 : 0;
        }
      }
    }
    // An aerial trace of the whole city: where it draws no polygon the kerb is bare, not unstated,
    // which is what makes it authoritative and is why it never falls through to OSM's road tags.
    const covered = (hits: number): SideState =>
      probes.length > 0 && hits / probes.length >= SURVEYED_FRACTION
        ? "paved"
        : "bare";
    return { left: covered(left), right: covered(right) };
  };
}

const KIND_OF = {
  sidewalk: KIND_SIDEWALK,
  crossing: KIND_CROSSING,
  traffic_island: KIND_TRAFFIC_ISLAND,
} as const;

// One SWLK record: the way, land-clipped and densified, ready to encode.
interface SidewalkSegment {
  osmId: number;
  kind: number;
  name: string;
  nameId: number;
  structure: boolean;
  points: Coord[];
  lengthMeters: number;
}

// Land-clips, densifies and uppercases the OSM ways, exactly as the path ingest does: a way is
// kept if its midpoint or either endpoint is on land, which drops the New Jersey and Westchester
// spill the city bounding box reaches without clipping one that only grazes the shoreline.
function toSidewalkSegments(
  ways: readonly SidewalkWay[],
  onLand: (coord: Coord) => boolean,
): { segments: SidewalkSegment[]; onLandCount: number } {
  const segments: SidewalkSegment[] = [];
  let onLandCount = 0;
  for (const way of ways) {
    const { points } = way;
    const midpoint = points[Math.floor(points.length / 2)];
    if (
      !onLand(midpoint) &&
      !onLand(points[0]) &&
      !onLand(points[points.length - 1])
    ) {
      continue;
    }
    onLandCount += 1;
    if (way.id > U32_MAX) {
      continue;
    }
    const dense = densify(points, DENSIFY_METERS);
    segments.push({
      osmId: way.id,
      kind: KIND_OF[way.footway],
      name: (way.name ?? "").trim().toUpperCase(),
      nameId: UNNAMED_ID,
      structure: way.structure,
      points: dense.points,
      lengthMeters: dense.lengthMeters,
    });
  }
  return { segments, onLandCount };
}

// SWLK v1: the OSM sidewalk, crossing and traffic-island ways. The record id is the OSM way id;
// kind is 20/21/22; these have no roadway of their own, so width and speed are 0 and byte 23
// carries only the structure flag. layout: scripts/README.md
function encodeSidewalks(
  segments: readonly SidewalkSegment[],
  names: readonly string[],
): Uint8Array {
  return encodeNetwork(
    SIDEWALK_MAGIC,
    SIDEWALK_FORMAT,
    segments.map((segment) => ({
      id: segment.osmId,
      nameId: segment.nameId,
      lengthMeters: segment.lengthMeters,
      kind: segment.kind,
      width: 0,
      speed: 0,
      flags: segment.structure ? FLAG_STRUCTURE : 0,
      points: segment.points,
    })),
    names,
  );
}

// Writes the SWLK extract and stamps the four per-side bits into every offsetted street's flags
// byte, in place. Returns the extract the way every other committed source does; the per-side
// rates are reported to the build log rather than returned, since nothing consumes them.
export async function ingestSidewalks(
  cityId: string,
  streets: SidedSegment[],
  land: LandContext,
  buildSurvey: () => Promise<Survey>,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(SIDEWALK_DIR, { recursive: true });

  const { south, west, north, east } = land.box;
  const ways = await fetchSidewalks(south, west, north, east);
  const roads = await fetchSidewalkTags(south, west, north, east);
  const { segments, onLandCount } = toSidewalkSegments(ways, land.onLand);
  const names = buildNameTable(segments);
  const bytes = encodeSidewalks(segments, names);
  const file = `${cityId}.bin`;
  await writeFile(join(SIDEWALK_DIR, file), bytes);

  const kept = segments.filter((segment) => segment.kind === KIND_SIDEWALK);
  const sidewalkKm =
    kept.reduce((total, segment) => total + segment.lengthMeters, 0) / 1000;
  console.error(
    `  sidewalks: ${ways.length} ways fetched, ${onLandCount} on land, ${segments.length} encoded (${sidewalkKm.toFixed(0)} km of sidewalk, ${names.length} distinct names)`,
  );

  const pieces = indexPieces(segments);
  const survey = await buildSurvey();
  const tags = tagSurvey(roads);
  const stating = roads.filter((road) => {
    const sides = taggedSides(road);
    return sides.left !== "unstated" || sides.right !== "unstated";
  }).length;

  let offsettedKm = 0;
  let osmBothKm = 0;
  let osmOneKm = 0;
  let surveyedBothKm = 0;
  let surveyedOneKm = 0;
  // The road tags' own contribution: side-km they paved, and side-km they stated bare, both counted
  // only where the city's own survey had nothing to say. The second is not pavement, it is the
  // difference between a region that is missing data and one that is missing sidewalks.
  let taggedPavedSideKm = 0;
  let taggedBareSideKm = 0;
  for (const street of streets) {
    if (!isOffsetted(street)) {
      continue;
    }
    const own = survey(street);
    const stated = statedSides(own, () => tags(street));
    const bits = sidesOf(street, pieces, stated);
    street.flags |= bits;
    const km = street.lengthMeters / 1000;
    offsettedKm += km;
    for (const side of ["left", "right"] as const) {
      if (own[side] !== "unstated") {
        continue;
      }
      taggedPavedSideKm += stated[side] === "paved" ? km : 0;
      taggedBareSideKm += stated[side] === "bare" ? km : 0;
    }
    const osm =
      ((bits & FLAG_OSM_LEFT) !== 0 ? 1 : 0) +
      ((bits & FLAG_OSM_RIGHT) !== 0 ? 1 : 0);
    const surveyed =
      ((bits & FLAG_SURVEYED_LEFT) !== 0 ? 1 : 0) +
      ((bits & FLAG_SURVEYED_RIGHT) !== 0 ? 1 : 0);
    osmBothKm += osm === 2 ? km : 0;
    osmOneKm += osm === 1 ? km : 0;
    surveyedBothKm += surveyed === 2 ? km : 0;
    surveyedOneKm += surveyed === 1 ? km : 0;
  }

  const percent = (km: number): string => ((100 * km) / offsettedKm).toFixed(1);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `  sidewalks: ${offsettedKm.toFixed(0)} km offsetted — OSM maps both sides of ${percent(osmBothKm)}%, one of ${percent(osmOneKm)}%; the survey draws both of ${percent(surveyedBothKm)}%, one of ${percent(surveyedOneKm)}% (${seconds}s)`,
  );
  console.error(
    `  sidewalk tags: ${stating} of ${roads.length} roads state a side — ${taggedPavedSideKm.toFixed(0)} km of side paved and ${taggedBareSideKm.toFixed(0)} km stated bare where the survey was silent`,
  );
  return {
    file,
    format: SIDEWALK_FORMAT,
    count: segments.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
