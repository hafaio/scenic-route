// Woodland polygons from OpenStreetMap, the second half of the canopy model — the city's
// tree inventory is a street-tree register and carries no woodland at all. See
// scripts/README.md.

import { cached } from "./cache";
import type { Coord } from "./socrata";

// Rings of one wood, filled even-odd, so a multipolygon's inner rings punch holes.
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

export interface Woodland {
  polygons: Polygon[];
  ways: number;
  relations: number;
  unclosed: number; // rings whose member ways did not chain back to their start
}

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

// leisure=park is deliberately absent: a park is not canopy. The Great Lawn, the ballfields
// and the Reservoir are all park, and none of them is a tree.
const TAGS: readonly [string, string][] = [
  ["natural", "wood"],
  ["landuse", "forest"],
];

// Relations as well as ways: the big woods — Van Cortlandt, the Greenbelt — are mapped as
// multipolygons, so querying only ways would miss exactly the ones that matter most.
function query(
  south: number,
  west: number,
  north: number,
  east: number,
): string {
  const box = `${south},${west},${north},${east}`;
  const clauses = TAGS.flatMap(([key, value]) =>
    ["way", "relation"].map((kind) => `${kind}["${key}"="${value}"](${box});`),
  ).join("");
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(${clauses});out geom;`;
}

// Overpass returns each member way's geometry separately and an outer ring is routinely
// split across several of them, so the ways are chained end to end before anything can be
// filled. Shared endpoints are the same OSM node, so they match exactly and a string key
// finds them.
function stitchRings(ways: Coord[][]): { rings: Coord[][]; unclosed: number } {
  const keyOf = ({ lat, lng }: Coord): string => `${lng},${lat}`;
  const ends = new Map<string, number[]>();
  for (let way = 0; way < ways.length; way++) {
    for (const end of [ways[way][0], ways[way][ways[way].length - 1]]) {
      const key = keyOf(end);
      const existing = ends.get(key);
      if (existing) {
        existing.push(way);
      } else {
        ends.set(key, [way]);
      }
    }
  }

  const used = new Array<boolean>(ways.length).fill(false);
  const rings: Coord[][] = [];
  let unclosed = 0;
  for (let seed = 0; seed < ways.length; seed++) {
    if (used[seed]) {
      continue;
    }
    used[seed] = true;
    const ring = ways[seed].slice();
    while (keyOf(ring[0]) !== keyOf(ring[ring.length - 1])) {
      const tail = keyOf(ring[ring.length - 1]);
      const next = (ends.get(tail) ?? []).find((way) => !used[way]);
      if (next === undefined) {
        break;
      }
      used[next] = true;
      const piece = ways[next];
      const forward = keyOf(piece[0]) === tail;
      const ordered = forward ? piece : piece.slice().reverse();
      for (let point = 1; point < ordered.length; point++) {
        ring.push(ordered[point]);
      }
    }
    if (keyOf(ring[0]) === keyOf(ring[ring.length - 1]) && ring.length >= 4) {
      rings.push(ring);
    } else {
      unclosed += 1;
    }
  }
  return { rings, unclosed };
}

function toCoords(geometry: OverpassPoint[]): Coord[] {
  return geometry.map(({ lat, lon }) => ({ lat, lng: lon }));
}

function toPolygons(elements: OverpassElement[]): Woodland {
  const polygons: Polygon[] = [];
  let ways = 0;
  let relations = 0;
  let unclosed = 0;
  for (const element of elements) {
    if (element.type === "way") {
      const geometry = element.geometry ?? [];
      if (geometry.length >= 3) {
        ways += 1;
        polygons.push([toCoords(geometry)]);
      }
    } else if (element.type === "relation") {
      const members = (element.members ?? [])
        .filter(
          (member) =>
            member.type === "way" && (member.geometry?.length ?? 0) >= 2,
        )
        .map((member) => toCoords(member.geometry ?? []));
      if (members.length > 0) {
        relations += 1;
        const { rings, unclosed: broken } = stitchRings(members);
        unclosed += broken;
        if (rings.length > 0) {
          polygons.push(rings);
        }
      }
    }
  }
  return { polygons, ways, relations, unclosed };
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

export async function fetchWoodland(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<Woodland> {
  const elements = await overpassQuery(
    "overpass-woodland",
    query(south, west, north, east),
  );
  return toPolygons(elements);
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

// Decision 1 of the park-paths plan (scripts/README.md, "PATH v1"). footway/path/pedestrian/
// steps are the core walking net; cycleway brings the greenways (a bike-only segment carries
// foot=no and drops out); bridleway is the Central Park bridle path; track is park maintenance
// roads. footway=sidewalk|crossing|traffic_island are excluded — GRPH derives those from CSCL,
// and ingesting OSM's would double the sidewalk network. area=yes (plazas) is not an edge;
// access/foot no|private and indoor=yes are not walkable.
const PATH_FILTER =
  'way["highway"~"^(footway|path|pedestrian|steps|cycleway|bridleway|track)$"]' +
  '["footway"!~"^(sidewalk|crossing|traffic_island)$"]' +
  '["area"!="yes"]["access"!~"^(no|private)$"]["foot"!~"^(no|private)$"]["indoor"!="yes"]';

function pathsQuery(
  south: number,
  west: number,
  north: number,
  east: number,
): string {
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(${PATH_FILTER}(${box}););out geom;`;
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
