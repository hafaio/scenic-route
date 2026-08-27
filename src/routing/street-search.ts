import type { RoutingGraph } from "./graph";
import { prettifyStreetName } from "./street-names";

// Searching the street names the routing graph already carries.
//
// The graph names every edge it can — 9,881 distinct names in New York, 2,758 in San Francisco — and
// those names cost nothing extra: they are already on the device, already cached for offline use,
// and already the names the directions read out. So "Bedford Av" is answerable with no network and
// no new bytes, which is most of what a reader wants when they are naming a destination.
//
// What this is NOT is address search. There are no house numbers here; a street resolves to one
// point on it. That is a real limit and the search box says so rather than letting a thin list read
// as the whole world.

// Where a street is, for the purposes of putting a pin on it. One point for the whole of Broadway is
// crude, and deliberately so: the alternative is splitting a name into its segments, which turns one
// answer into forty and buries everything else in the list.
export interface StreetPlace {
  name: string;
  lat: number;
  lng: number;
}

export interface StreetHit {
  place: StreetPlace;
  rank: number; // 2 the name starts with the query, 1 a word inside it does
}

// Built once per graph and held against it, so switching city rebuilds and a re-render does not. The
// graph is tens of megabytes and lives as long as the city does, so keying on it directly is what
// keeps this from being rebuilt or leaked.
const indexes = new WeakMap<RoutingGraph, StreetPlace[]>();

function placesOf(graph: RoutingGraph): StreetPlace[] {
  const cached = indexes.get(graph);
  if (cached) {
    return cached;
  }
  // The first edge carrying each name decides where the name points. Walking edges in order makes
  // that deterministic, which matters because an arbitrary pin that moves between sessions reads as
  // a bug.
  const seen = new Set<number>();
  const places: StreetPlace[] = [];
  for (let edge = 0; edge < graph.edgeCount; edge += 1) {
    const nameId = graph.edgeNameId[edge];
    const name = graph.names[nameId];
    if (name === undefined || name === "" || seen.has(nameId)) {
      continue;
    }
    seen.add(nameId);
    const node = graph.edgeNodeA[edge];
    places.push({
      // The graph stores names as the source wrote them, which is upper case. The directions already
      // pass them through this before reading them out; a search result shouting next to a station
      // name that does not is the same name looking like two different things.
      name: prettifyStreetName(name),
      lat: graph.originLat + graph.nodeQy[node] * graph.scale,
      lng: graph.originLng + graph.nodeQx[node] * graph.scale,
    });
  }
  indexes.set(graph, places);
  return places;
}

// The same two-tier match the station search uses, so a local hit ranks the same however it got here.
export function rankName(name: string, query: string): number {
  const haystack = name.toLowerCase();
  if (haystack.startsWith(query)) {
    return 2;
  }
  // A word inside it: "grand" should find "Sixth Grand Avenue", not only names opening with it.
  return haystack.split(/[^a-z0-9]+/).some((word) => word.startsWith(query))
    ? 1
    : 0;
}

export function searchStreets(
  graph: RoutingGraph,
  query: string,
  limit: number,
): StreetHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) {
    return []; // one letter matches half a city, which is a list nobody can read
  }
  const hits: StreetHit[] = [];
  for (const place of placesOf(graph)) {
    const rank = rankName(place.name, needle);
    if (rank > 0) {
      hits.push({ place, rank });
    }
  }
  hits.sort(
    (left, right) =>
      right.rank - left.rank || left.place.name.localeCompare(right.place.name),
  );
  return hits.slice(0, limit);
}

// The graph the app currently holds, for the search box — which runs long before anything asks for a
// route and cannot take one as a prop. Set wherever the app sets its routing graph. Null until one
// has loaded, which is simply a search with no streets in it rather than a search that waits: the
// graph is tens of megabytes and no one typing a destination should wait on it.
let loaded: RoutingGraph | null = null;

export function setSearchGraph(graph: RoutingGraph | null): void {
  loaded = graph;
}

export function searchLoadedStreets(query: string, limit: number): StreetHit[] {
  return loaded === null ? [] : searchStreets(loaded, query, limit);
}
