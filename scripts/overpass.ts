// OpenStreetMap via Overpass: the walking and park-drive network and the natural=tree points that
// supplement the ForMS street-tree census, plus the shared request helper and polygon-ring type
// the rest of the ingest builds on. See scripts/README.md.

import pRetry from "p-retry";
import { cached } from "./cache";
import { USER_AGENT } from "./http";
import type { Coord } from "./socrata";

// Rings of one area, filled even-odd, so a multipolygon's inner rings punch holes.
export type Polygon = Coord[][];

interface OverpassPoint {
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: "way";
  id?: number;
  tags?: Record<string, string>;
  geometry?: OverpassPoint[];
  center?: OverpassPoint; // present with `out center;` — a way's representative point
}

interface OverpassRelation {
  type: "relation";
  members?: { type: string; role: string; geometry?: OverpassPoint[] }[];
}

// `out;` (no geom) returns a node's position at the top level, not inside a geometry array.
interface OverpassNode {
  type: "node";
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

type OverpassElement = OverpassWay | OverpassRelation | OverpassNode;

// Attempts rotate: no one mirror serves a query this size reliably under load.
const ENDPOINTS: readonly string[] = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const ROTATIONS = 2;
const MAX_ATTEMPTS = ROTATIONS * ENDPOINTS.length;
const RETRY_BASE_MS = 30_000; // a busy Overpass frees a slot in minutes, not seconds
const QUERY_TIMEOUT_SECONDS = 300; // the server's own budget, which it is given in full
const REQUEST_TIMEOUT_MS = (QUERY_TIMEOUT_SECONDS + 60) * 1000; // only cuts off one that hung

function toCoords(geometry: OverpassPoint[]): Coord[] {
  return geometry.map(({ lat, lon }) => ({ lat, lng: lon }));
}

// Overpass answers a busy dispatcher with an HTML error page under a 200, so the body is checked
// rather than just the status. An empty element list is not one of those failures: it is a box
// with nothing mapped in it, and it stands.
async function queryEndpoint(
  endpoint: string,
  overpassQl: string,
): Promise<OverpassElement[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({ data: overpassQl }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  } else if (!body.startsWith("{")) {
    throw new Error(body.slice(0, 200).replace(/\s+/g, " "));
  }
  const parsed = JSON.parse(body) as { elements?: OverpassElement[] };
  if (!Array.isArray(parsed.elements)) {
    throw new Error("no elements in the response");
  }
  return parsed.elements;
}

// One pass over every mirror, which is the unit the backoff waits between: within a pass the next
// endpoint may well be free, so a failure there moves straight on.
async function queryRotation(
  overpassQl: string,
  rotation: number,
): Promise<OverpassElement[]> {
  let lastError: unknown;
  for (const [index, endpoint] of ENDPOINTS.entries()) {
    try {
      return await queryEndpoint(endpoint, overpassQl);
    } catch (error) {
      lastError = error;
      const attempt = (rotation - 1) * ENDPOINTS.length + index + 1;
      console.error(
        `  attempt ${attempt}/${MAX_ATTEMPTS} (${new URL(endpoint).host}) failed: ${error}`,
      );
    }
  }
  throw lastError;
}

// One Overpass request, cached under `cacheKey` by its exact QL, over the rotating mirrors.
export async function overpassQuery(
  cacheKey: string,
  overpassQl: string,
): Promise<OverpassElement[]> {
  return cached(cacheKey, overpassQl, async () => {
    try {
      return await pRetry((rotation) => queryRotation(overpassQl, rotation), {
        retries: ROTATIONS - 1,
        minTimeout: RETRY_BASE_MS,
        randomize: true,
      });
    } catch (error) {
      throw new Error(`Overpass query "${cacheKey}" failed: ${error}`);
    }
  });
}

// One OSM pedestrian/park way: the geometry, its uppercase-later name, and the two record flags
// the model reads — `steps` (highway=steps, kind 7) and `structure` (a bridge/tunnel deck or a
// non-zero layer, which suppresses false conflation welds in Phase 2).
export interface PathWay {
  id: number;
  name?: string;
  steps: boolean;
  structure: boolean;
  points: Coord[];
}

// Shared exclusions on every path clause: plazas (area=yes) are not edges, indoor ways are not
// the outdoor network, and anything barred to pedestrians (foot no|private) is not walkable.
const WALKABLE = '["area"!="yes"]["indoor"!="yes"]["foot"!~"^(no|private)$"]';

// The highway classes the pedestrian network is drawn from: footway/path/pedestrian/steps are the
// pedestrian core; cycleway brings the greenways (a bike-only segment carries foot=no and drops
// out); bridleway is Central Park's bridle path; track is park maintenance roads.
const FOOT_CLASSES =
  '["highway"~"^(footway|path|pedestrian|steps|cycleway|bridleway|track)$"]';
// The three `footway` values that describe a street's own pavement rather than a way of its own.
const SIDEWALK_CLASSES = "^(sidewalk|crossing|traffic_island)$";

// The core walking net: dedicated foot and park ways. Bridge and tunnel promenades ride in here
// already — the East River bridges' paths are footway/cycleway. The sidewalk classes are excluded
// because the graph reads them under a different rule: they are the sidewalk network itself, not a
// walk beside it, so none of the dedup bands the paths go through may touch them. They are fetched
// as their own extract by fetchSidewalks below, which is this clause's exact complement. access
// no|private is not walkable.
const FOOT_WAYS =
  `way${FOOT_CLASSES}["footway"!~"${SIDEWALK_CLASSES}"]` +
  '["access"!~"^(no|private)$"]' +
  WALKABLE;

// Park drives: a road open on foot but closed to through motor traffic — Central Park's East /
// West / Terrace Drives, Prospect Park's loop. The signal is motor_vehicle no|private on an
// ordinary road class; service=driveway and its kin are the private stubs to leave out. A merely
// private road (motor_vehicle=private) must also carry an affirmative pedestrian signal — a
// foot=yes|designated grant, or a name — so gated driveways lacking one stay out. Whatever leaks
// through and coincides with a real street is later deduped against CSCL by the graph conflation.
const DRIVE_ROAD =
  '["highway"~"^(unclassified|service|residential|tertiary|living_street)$"]' +
  '["service"!~"^(driveway|parking_aisle|alley|drive-through|emergency_access)$"]';
const DRIVE_CLAUSES = [
  `way["motor_vehicle"="no"]${DRIVE_ROAD}${WALKABLE}`,
  `way["motor_vehicle"="private"]["foot"~"^(yes|designated)$"]${DRIVE_ROAD}${WALKABLE}`,
  `way["motor_vehicle"="private"]["name"]${DRIVE_ROAD}${WALKABLE}`,
];

// Unioned in Overpass, which returns each matching way once even where the clauses overlap.
const PATH_CLAUSES = [FOOT_WAYS, ...DRIVE_CLAUSES];

function pathsQuery(
  south: number,
  west: number,
  north: number,
  east: number,
): string {
  const box = `${south},${west},${north},${east}`;
  const union = PATH_CLAUSES.map((clause) => `${clause}(${box});`).join("");
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(${union});out geom;`;
}

// present-and-not-"no": a bridge/tunnel tag is a structure unless it explicitly says "no".
function tagged(value: string | undefined): boolean {
  return value !== undefined && value !== "no";
}

export async function fetchPaths(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<PathWay[]> {
  const elements = await overpassQuery(
    "overpass-paths",
    pathsQuery(south, west, north, east),
  );
  const ways: PathWay[] = [];
  for (const element of elements) {
    if (element.type !== "way" || element.id === undefined) {
      continue;
    }
    const geometry = element.geometry ?? [];
    if (geometry.length < 2) {
      continue;
    }
    const tags = element.tags ?? {};
    const layer = Number.parseInt(tags.layer ?? "", 10);
    ways.push({
      id: element.id,
      name: tags.name,
      steps: tags.highway === "steps",
      structure:
        tagged(tags.bridge) ||
        tagged(tags.tunnel) ||
        (tags.layer !== undefined && layer !== 0),
      points: toCoords(geometry),
    });
  }
  return ways;
}

// One OSM road way that says, on the centreline itself, what its own kerbs carry. This is OSM's
// *other* way of recording a pavement — the four `sidewalk` keys — and it is a per-side statement
// about the road rather than a way of its own, so it is fetched apart from the footways above and
// read against the city centreline it matches rather than added to the walking network. The values
// are handed on raw: what each one means, and which key beats which, is `scripts/sidewalks.ts`.
export interface SidewalkTaggedRoad {
  id: number;
  sidewalk?: string; // `sidewalk` — both/left/right/yes/no/none/separate
  left?: string; // `sidewalk:left`
  right?: string; // `sidewalk:right`
  both?: string; // `sidewalk:both`
  points: Coord[];
}

// The road classes a city centreline can be. Motorways are left out — no centreline this pipeline
// ingests is one, so a tagged motorway could only ever match the frontage road beside it.
const ROAD_CLASSES =
  '["highway"~"^(trunk|primary|secondary|tertiary)(_link)?$|' +
  '^(unclassified|residential|living_street|service|road|busway)$"]';
const SIDEWALK_KEYS = [
  "sidewalk",
  "sidewalk:left",
  "sidewalk:right",
  "sidewalk:both",
];

// One clause per key rather than a key regex: Overpass returns a way once however many clauses it
// matches, and naming the four keys keeps `sidewalk:left:surface` and its kin out of the answer.
export async function fetchSidewalkTags(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<SidewalkTaggedRoad[]> {
  const box = `${south},${west},${north},${east}`;
  const union = SIDEWALK_KEYS.map(
    (key) => `way${ROAD_CLASSES}["${key}"](${box});`,
  ).join("");
  const query = `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(${union});out geom;`;
  const elements = await overpassQuery("overpass-sidewalk-tags", query);
  const roads: SidewalkTaggedRoad[] = [];
  for (const element of elements) {
    if (element.type !== "way" || element.id === undefined) {
      continue;
    }
    const geometry = element.geometry ?? [];
    if (geometry.length < 2) {
      continue;
    }
    const tags = element.tags ?? {};
    roads.push({
      id: element.id,
      sidewalk: tags.sidewalk,
      left: tags["sidewalk:left"],
      right: tags["sidewalk:right"],
      both: tags["sidewalk:both"],
      points: toCoords(geometry),
    });
  }
  return roads;
}

// One OSM way describing a street's own pavement: which of the three `footway` values it carries,
// and the same geometry/name/structure a PathWay does.
export interface SidewalkWay {
  id: number;
  name?: string;
  footway: "sidewalk" | "crossing" | "traffic_island";
  structure: boolean;
  points: Coord[];
}

const SIDEWALK_VALUES = ["sidewalk", "crossing", "traffic_island"] as const;

// The exact complement of FOOT_WAYS: the same highway classes and the same walkability filters, but
// keeping the sidewalk classes the walking net drops rather than dropping them. Crossings chain
// through median islands, so excluding the islands would cut every median crossing in two.
export async function fetchSidewalks(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<SidewalkWay[]> {
  const box = `${south},${west},${north},${east}`;
  const clause =
    `way${FOOT_CLASSES}["footway"~"${SIDEWALK_CLASSES}"]` +
    '["access"!~"^(no|private)$"]' +
    WALKABLE;
  const query = `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];${clause}(${box});out geom;`;
  const elements = await overpassQuery("overpass-sidewalks", query);
  const ways: SidewalkWay[] = [];
  for (const element of elements) {
    if (element.type !== "way" || element.id === undefined) {
      continue;
    }
    const geometry = element.geometry ?? [];
    if (geometry.length < 2) {
      continue;
    }
    const tags = element.tags ?? {};
    const footway = SIDEWALK_VALUES.find((value) => value === tags.footway);
    if (footway === undefined) {
      continue;
    }
    const layer = Number.parseInt(tags.layer ?? "", 10);
    ways.push({
      id: element.id,
      name: tags.name,
      footway,
      structure:
        tagged(tags.bridge) ||
        tagged(tags.tunnel) ||
        (tags.layer !== undefined && layer !== 0),
      points: toCoords(geometry),
    });
  }
  return ways;
}

// One OSM natural=tree node: a point, and the crown diameter the mapper recorded when there is
// one. These supplement the ForMS street-tree census where ForMS is a hole — Central Park is
// managed by the Conservancy and carries only 697 ForMS trees against ~3,945 OSM ones, so its
// paths would otherwise read bare. scripts/README.md
export interface OsmTree {
  lat: number;
  lng: number;
  crownDiameterMeters?: number; // diameter_crown, metres, when the tag is present and parses
}

function osmTreesQuery(
  south: number,
  west: number,
  north: number,
  east: number,
): string {
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];node["natural"="tree"](${box});out;`;
}

export async function fetchOsmTrees(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<OsmTree[]> {
  const elements = await overpassQuery(
    "overpass-trees",
    osmTreesQuery(south, west, north, east),
  );
  const trees: OsmTree[] = [];
  for (const element of elements) {
    if (
      element.type !== "node" ||
      element.lat === undefined ||
      element.lon === undefined
    ) {
      continue;
    }
    // Lenient: diameter_crown is metres but comes in as "12", "12 m", "12.5" — parseFloat takes
    // the leading number and ignores the unit. A zero or unparseable value is treated as absent,
    // so the ingest sizes that tree's crown from the imputed median instead.
    const diameter = Number.parseFloat(element.tags?.diameter_crown ?? "");
    trees.push({
      lat: element.lat,
      lng: element.lon,
      crownDiameterMeters:
        Number.isFinite(diameter) && diameter > 0 ? diameter : undefined,
    });
  }
  return trees;
}

// One OSM public-art point: its coordinate and the `name` tag when it carries one (many artworks do).
export interface OsmArtwork extends Coord {
  name?: string;
}

// OSM public-art points: tourism=artwork (murals, sculptures, statues, installations). A node is a
// point; a way (a painted wall, a large installation) is taken at its center. Supplements the NYC
// PDC public-art inventory, which is thin on murals. The art ingest clips these to land and dedups
// them against the PDC works.
export async function fetchOsmArtwork(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<OsmArtwork[]> {
  const box = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];` +
    `(node["tourism"="artwork"](${box});way["tourism"="artwork"](${box}););out center;`;
  const elements = await overpassQuery("overpass-artwork", query);
  const points: OsmArtwork[] = [];
  for (const element of elements) {
    if (
      element.type === "node" &&
      element.lat !== undefined &&
      element.lon !== undefined
    ) {
      points.push({
        lat: element.lat,
        lng: element.lon,
        name: element.tags?.name?.trim(),
      });
    } else if (element.type === "way" && element.center) {
      points.push({
        lat: element.center.lat,
        lng: element.center.lon,
        name: element.tags?.name?.trim(),
      });
    }
  }
  return points;
}

// One OSM outdoor-seating point: its coordinate and the `name` tag when it carries one (most cafés do).
export interface OsmSeating extends Coord {
  name?: string;
}

// OSM outdoor-seating points: outdoor_seating=yes (cafés, restaurants, bars with pavement tables). A
// node is a point; a way (a building or seating area outline) is taken at its center. Supplements the
// NYC Dining Out café-licence inventory. The dining ingest clips these to land and dedups them
// against the licensed cafés.
export async function fetchOutdoorSeating(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<OsmSeating[]> {
  const box = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];` +
    `nwr["outdoor_seating"="yes"](${box});out center tags;`;
  const elements = await overpassQuery("overpass-outdoor-seating", query);
  const points: OsmSeating[] = [];
  for (const element of elements) {
    if (
      element.type === "node" &&
      element.lat !== undefined &&
      element.lon !== undefined
    ) {
      points.push({
        lat: element.lat,
        lng: element.lon,
        name: element.tags?.name?.trim(),
      });
    } else if (element.type === "way" && element.center) {
      points.push({
        lat: element.center.lat,
        lng: element.center.lon,
        name: element.tags?.name?.trim(),
      });
    }
  }
  return points;
}

// One line walking near is unpleasant: a limited-access highway (or ramp), or ABOVE-GROUND rail. The
// `kind` is kept for the ingest log; the routing penalty treats them the same. Never part of the
// walking network — these are only rasterized into a proximity field, never routed.
export interface NuisanceLine {
  kind: "highway" | "rail";
  points: Coord[];
}

const HIGHWAY_CLASSES = "^(motorway|trunk|motorway_link|trunk_link)$";
const RAIL_CLASSES = "^(rail|subway|light_rail)$";

// Highways and above-ground rail as polylines. Rail counts when it is not underground — surface,
// open cut, or elevated are all unpleasant to walk beside (the Franklin Ave shuttle runs in an open
// cut with no bridge/layer tag, so an "elevated only" filter dropped most of it). Only `tunnel=yes`
// and below-grade covered sections (`layer` < 0) are excluded.
export async function fetchNuisanceLines(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<NuisanceLine[]> {
  const box = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(` +
    `way["highway"~"${HIGHWAY_CLASSES}"](${box});` +
    `way["railway"~"${RAIL_CLASSES}"]["tunnel"!~"yes"](${box});` +
    `);out geom;`;
  const elements = await overpassQuery("overpass-nuisance", query);
  const lines: NuisanceLine[] = [];
  for (const element of elements) {
    if (
      element.type !== "way" ||
      !element.geometry ||
      element.geometry.length < 2
    ) {
      continue;
    }
    const tags = element.tags ?? {};
    let kind: NuisanceLine["kind"] | null = null;
    if (tags.highway !== undefined) {
      kind = "highway";
    } else if (tags.railway !== undefined && tags.tunnel !== "yes") {
      const layer = Number.parseInt(tags.layer ?? "", 10);
      // Keep everything not underground; a negative layer is a below-grade covered stretch, dropped.
      if (!Number.isFinite(layer) || layer >= 0) {
        kind = "rail";
      }
    }
    if (kind !== null) {
      lines.push({ kind, points: toCoords(element.geometry) });
    }
  }
  return lines;
}
