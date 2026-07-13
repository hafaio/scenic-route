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
  geometry?: OverpassPoint[];
}

interface OverpassRelation {
  type: "relation";
  members?: { type: string; role: string; geometry?: OverpassPoint[] }[];
}

type OverpassElement = OverpassWay | OverpassRelation;

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
    } else {
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

// Overpass answers a busy dispatcher with an HTML error page under a 200, so the body is
// checked rather than just the status. An empty element list is not one of those failures:
// it is a box with no wood mapped in it, and it stands.
export async function fetchWoodland(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<Woodland> {
  const overpassQl = query(south, west, north, east);
  const elements = await cached("overpass-woodland", overpassQl, async () => {
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
    throw new Error(`failed to fetch woodland: ${lastError}`);
  });
  return toPolygons(elements);
}
