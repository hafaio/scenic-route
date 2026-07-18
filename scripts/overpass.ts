// OpenStreetMap via Overpass: the walking and park-drive network and the natural=tree points that
// supplement the ForMS street-tree census, plus the shared request helper and polygon-ring type
// the rest of the ingest builds on. See scripts/README.md.

import { cached } from "./cache";
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
// Required, not politeness: a mirror 429s an anonymous client on sight.
const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";
const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 30_000; // a busy Overpass frees a slot in minutes, not seconds
const QUERY_TIMEOUT_SECONDS = 300; // the server's own budget, which it is given in full
const REQUEST_TIMEOUT_MS = (QUERY_TIMEOUT_SECONDS + 60) * 1000; // only cuts off one that hung

function toCoords(geometry: OverpassPoint[]): Coord[] {
  return geometry.map(({ lat, lon }) => ({ lat, lng: lon }));
}

// One Overpass request, cached under `cacheKey` by its exact QL, over the rotating mirrors.
// Overpass answers a busy dispatcher with an HTML error page under a 200, so the body is
// checked rather than just the status. An empty element list is not one of those failures:
// it is a box with nothing mapped in it, and it stands.
export async function overpassQuery(
  cacheKey: string,
  overpassQl: string,
): Promise<OverpassElement[]> {
  return cached(cacheKey, overpassQl, async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
      try {
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
      } catch (error) {
        lastError = error;
        console.error(
          `  attempt ${attempt + 1}/${MAX_ATTEMPTS} (${new URL(endpoint).host}) failed: ${error}`,
        );
        // Only wait once every endpoint has been tried; the next one may well be free.
        if (attempt % ENDPOINTS.length === ENDPOINTS.length - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_DELAY_MS * (1 + attempt)),
          );
        }
      }
    }
    throw new Error(`Overpass query "${cacheKey}" failed: ${lastError}`);
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

// The core walking net: dedicated foot and park ways. footway/path/pedestrian/steps are the
// pedestrian core; cycleway brings the greenways (a bike-only segment carries foot=no and drops
// out); bridleway is Central Park's bridle path; track is park maintenance roads. Bridge and
// tunnel promenades ride in here already — the East River bridges' paths are footway/cycleway.
// footway=sidewalk|crossing|traffic_island are excluded: GRPH derives those from CSCL, and
// ingesting OSM's would double the sidewalk network. access no|private is not walkable.
const FOOT_WAYS =
  'way["highway"~"^(footway|path|pedestrian|steps|cycleway|bridleway|track)$"]' +
  '["footway"!~"^(sidewalk|crossing|traffic_island)$"]["access"!~"^(no|private)$"]' +
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

// One OSM natural=tree node: a point, and the crown diameter the mapper recorded when there is
// one. Phase 3 of the park-paths plan supplements the ForMS street-tree census with these where
// ForMS is a hole — Central Park is managed by the Conservancy and carries only 697 ForMS trees
// against ~3,945 OSM ones, so its paths would otherwise read bare. scripts/README.md
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
