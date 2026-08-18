import { activeCity } from "../cities";
import { decodeSubway, type SubwayStation, stationRoutes } from "./format";

// The station list address search offers alongside the geocoder's results. A visitor typing
// "Bedford Av" or "Union Sq" means the station at least as often as the street, and Photon has no
// idea which of New York's several Bedford Avs is the one with a train under it.
//
// The whole SBWY blob is 166 KB and already served for the overlay, so this is one fetch the first
// time someone types, cached for the session, and no network call per keystroke after that.

const MAX_ROUTE_BULLETS = 4; // Times Sq serves ten; the rest are "…"
// Two same-named stations within a chain of hops this short are one complex under several of its
// lines — Times Sq-42 St is five records spread over 153 m. Only the first is offered, so the list
// does not read as five different places. Two Manhattan short blocks, the same figure the overlay
// suppresses a repeated label at; Wall St on the 2/3 and on the 4/5 are 247 m apart and stay two.
const SAME_COMPLEX_METERS = 200;
const METERS_PER_DEGREE_LAT = 111_320;

export interface SubwayStationMatch {
  name: string;
  lat: number;
  lng: number;
  routes: string[]; // short names, in the MTA's own route order
  index: number; // position in the deduped list, so a match has a stable id
}

const loaded = new Map<string, Promise<SubwayStationMatch[]>>();

function metersApart(from: SubwayStation, to: SubwayStation): number {
  const north = (from.lat - to.lat) * METERS_PER_DEGREE_LAT;
  const east =
    (from.lng - to.lng) *
    METERS_PER_DEGREE_LAT *
    Math.cos((from.lat * Math.PI) / 180);
  return Math.hypot(north, east);
}

function load(cityId: string): Promise<SubwayStationMatch[]> {
  const pending = loaded.get(cityId);
  if (pending) {
    return pending;
  } else {
    // Relative, so it picks up the basePath the deploy injects.
    const url = `subway/${cityId}.bin`;
    const request = fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${url}: ${response.status} ${response.statusText}`);
        }
        const { routes, stations } = decodeSubway(await response.arrayBuffer());
        // Every station is compared against every one already seen, not only the ones offered, so a
        // complex strung out in a line collapses to a single offer rather than one per hop. The
        // survivor carries the whole complex's routes, since a rider searching Times Sq means all
        // ten of them.
        const seen: SubwayStation[] = [];
        const owners: number[] = []; // per seen station, which offer it belongs to
        const kept: SubwayStation[] = [];
        for (const station of stations) {
          const complex = seen.findIndex(
            (other) =>
              other.name === station.name &&
              metersApart(other, station) < SAME_COMPLEX_METERS,
          );
          if (complex < 0) {
            owners.push(kept.length);
            kept.push({ ...station });
          } else {
            owners.push(owners[complex]);
            kept[owners[complex]].routes |= station.routes;
          }
          seen.push(station);
        }
        return kept.map((station, index) => ({
          name: station.name,
          lat: station.lat,
          lng: station.lng,
          routes: stationRoutes(station, routes),
          index,
        }));
      })
      .catch((error: unknown) => {
        loaded.delete(cityId);
        throw error;
      });
    loaded.set(cityId, request);
    return request;
  }
}

// How well a station answers the query, or null for no match at all. 2 is the name starting with
// what was typed, 1 is a word inside it starting with it — "Union Sq" reaching "14 St-Union Sq",
// which is what riders call that station. Anything looser (a match mid-word) is not offered: it
// would put "Marcy Av" under a search for "arc".
function matchRank(name: string, query: string): number | null {
  const haystack = name.toLowerCase();
  if (haystack.startsWith(query)) {
    return 2;
  }
  for (
    let at = haystack.indexOf(query);
    at > 0;
    at = haystack.indexOf(query, at + 1)
  ) {
    if (!/[a-z0-9]/.test(haystack[at - 1])) {
      return 1;
    }
  }
  return null;
}

export function stationLabel({ name, routes }: SubwayStationMatch): string {
  const bullets = routes.slice(0, MAX_ROUTE_BULLETS).join("/");
  const shown = routes.length > MAX_ROUTE_BULLETS ? `${bullets}…` : bullets;
  return shown
    ? `${name} (${shown}) — subway station`
    : `${name} — subway station`;
}

// The active city's stations answering `query`, best first. Empty — never a throw — for a city with
// no subway artifact or a blob that will not load: a station is an extra on top of address search,
// and losing it must not lose the addresses too.
export async function searchStations(
  query: string,
): Promise<{ station: SubwayStationMatch; rank: number }[]> {
  const city = activeCity();
  if (!city.overlays.includes("subway")) {
    return [];
  }
  const stations = await load(city.id).catch(() => []);
  const needle = query.trim().toLowerCase();
  const hits: { station: SubwayStationMatch; rank: number }[] = [];
  for (const station of stations) {
    const rank = matchRank(station.name, needle);
    if (rank !== null) {
      hits.push({ station, rank });
    }
  }
  // Ties break on the file's own order, which is south to north — deterministic, and not a ranking
  // this list has any business inventing.
  return hits.sort((left, right) => right.rank - left.rank);
}
