// Turning a point back into a name: what a dropped pin, a dragged route endpoint or "Log here" is
// called. The label only — a route is computed from coordinate to coordinate and does not care what
// the pin says.
//
// Answered from the two files the search worker already holds, so it needs no network, no new
// artifact and no index built for the occasion:
//
//   the nearest house number, out of ADDR (./addresses.ts). Every street there carries the box its
//   own addresses fall in, recorded free during the load pass, so the streets whose box is further
//   away than the best answer so far are never decoded. A point in Manhattan reads a handful of runs.
//
//   the nearest name, out of the SRCH document table (./search-query.ts), which is 326,000 places,
//   parks, stations and landmarks already sitting in memory as two coordinate arrays. A straight
//   scan of them costs about a millisecond and no memory at all, which is cheaper than any structure
//   that would make it faster.
//
// Which of the two answers is a question of how much ground a name stands for. A nail salon names
// the doorway it is in; Prospect Park names the square mile around its middle. The index already
// grades that as `prominence`, so it decides two things: how far away a name can be and still be
// offered at all, and the head start it gets when several things are near. Otherwise the nearest
// wins, and the house number — which is only ever true of the building it is on — gets no head start
// at all.
//
// NOTHING IS INVENTED. Every answer is a row of a file, at the coordinates the city published for
// it; a point with nothing near enough is answered with null, and the caller keeps saying "Dropped
// pin". The number found is never the number nearest to what a reader expects — it is the nearest
// real one, and when it is too far to claim the point is at it, the answer drops to the street, to
// the neighbourhood, or to nothing.

import { COORD_SCALE, formatHouseNumber } from "./address-format";
import { type AddressIndex, streetAddresses } from "./addresses";
import {
  type DocKind,
  tokenize,
  unpackKind,
  unpackTokenInfo,
} from "./search-format";
import { docLabel, docName, type SearchIndex } from "./search-query";

const METERS_PER_DEGREE_LAT = 111_320;
const METERS_PER_UNIT_LAT = METERS_PER_DEGREE_LAT / COORD_SCALE;

// How far a house number is allowed to be from the point and still be what the point is called. A
// New York block is about 80 m long and 275 m across, and an address point sits inside its building,
// so a pin dropped on a building is within a few tens of metres of its own number. Past this the
// number belongs to a different building and the answer drops to the street.
const AT_ADDRESS_METERS = 60;

// And how far the STREET reaches, once the number has been given up on. A point in the middle of a
// block interior, in a yard, or on a pier at the end of one is genuinely near the street it is
// reached from; a point a quarter of a kilometre from every address in the city is not.
const NEAR_STREET_METERS = 250;

// What a name covers, as a function of how prominent the index made it: 20 m for an office nobody
// walks to, 75 m for a shop, 240 m for a park or a station. Squared rather than straight, so the
// middle of the range stays tight and only the tiers built for open space — parks at 235, transit at
// 240 — reach out over real ground.
const NAME_RADIUS_FLOOR = 20;
const NAME_RADIUS_SPAN = 250;
const MAX_PROMINENCE = 255;

// The head start a name gets over whatever else is near the point, at the top of the prominence
// scale. Every source files a place as one point, so a tap on the Empire State Building lands a few
// metres from the tower and a few metres from the valuation firm on its fourth floor; without this
// the firm wins by a metre it did not earn. Forty metres is about half a New York block — enough to
// carry a landmark over the office in it, and far too little to carry a park over the house you are
// standing at.
const NAME_HEAD_START = 40;

// How far a name may be and still be worth saying at all, once nothing owns the point outright. A
// pier, a bridge deck or a marsh is named after what it is near, and three hundred metres is about
// as far as "near" carries on foot — past it a point in open water starts being named after an
// office on the far shore.
const NEAR_NAME_METERS = 300;

// And the last thing there is to say: which part of the city this is. A neighbourhood is filed at its
// middle and covers a good deal around it, so this is loose on purpose — but it is loose enough that
// the answer is only ever offered as "near", never as a place the point is at.
const NEAR_NEIGHBORHOOD_METERS = 1000;

// What the point turned out to be near. `name` and `label` are the two lines the search box shows a
// result with, built the same way, so a pin reads exactly as the same place would if it had been
// typed into the box. `at` is the whole honesty of it: false means the answer is something NEARBY
// rather than the thing the point is on.
export interface ReverseHit {
  kind: DocKind | "address";
  name: string; // "605 E 14th St", "Katz's Delicatessen"
  // The line under the name, as the search box builds it: the door and the borough for something the
  // point is at, and the borough alone for something it is merely near — a house number under a name
  // the point is a hundred metres from would be placing the pin at a door it is nowhere near.
  label: string; // "Manhattan", "205 E Houston St, Manhattan", or ""
  lat: number; // where the named thing is, which is not the point that was asked about
  lng: number;
  meters: number; // and how far that is from it
  at: boolean;
}

interface NearestAddress {
  street: number;
  name: string;
  place: string;
  lat: number;
  lng: number;
  meters: number;
}

function nameRadius(prominence: number): number {
  const share = prominence / MAX_PROMINENCE;
  return NAME_RADIUS_FLOOR + NAME_RADIUS_SPAN * share * share;
}

// The same curve, for the head start: an office gets a metre of it, a shop nine, a park thirty-four.
function headStart(prominence: number): number {
  const share = prominence / MAX_PROMINENCE;
  return NAME_HEAD_START * share * share;
}

// How far outside a box a point is, along each axis independently: zero on the axes it is already
// within, which is what makes a point inside the box report no distance at all.
function boxGapUnits(low: number, high: number, at: number): number {
  if (at < low) {
    return low - at;
  } else if (at > high) {
    return at - high;
  } else {
    return 0;
  }
}

// The nearest real address, or null where every street's box is further off than the search is
// willing to look. The boxes are walked once to order the streets by how near they COULD hold
// something, and then decoded in that order only while the box is still nearer than the best address
// already found — so Broadway, whose box is most of Manhattan, is decoded when the point is on it and
// skipped when a side street has already answered.
function nearestAddress(
  addresses: AddressIndex,
  lat: number,
  lng: number,
  withinMeters: number,
): NearestAddress | null {
  const metersPerDegreeLng =
    METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  const metersPerUnitLng = metersPerDegreeLng / COORD_SCALE;
  const latUnits = lat * COORD_SCALE;
  const lngUnits = lng * COORD_SCALE;
  const streetCount = addresses.streetName.length;
  const candidates: { street: number; meters: number }[] = [];
  for (let street = 0; street < streetCount; street += 1) {
    const north =
      boxGapUnits(
        addresses.minLatUnits[street],
        addresses.maxLatUnits[street],
        latUnits,
      ) * METERS_PER_UNIT_LAT;
    const east =
      boxGapUnits(
        addresses.minLngUnits[street],
        addresses.maxLngUnits[street],
        lngUnits,
      ) * metersPerUnitLng;
    const meters = Math.sqrt(north * north + east * east);
    if (meters <= withinMeters) {
      candidates.push({ street, meters });
    }
  }
  candidates.sort((left, right) => left.meters - right.meters);

  let best: NearestAddress | null = null;
  let bestMeters = withinMeters;
  for (const candidate of candidates) {
    if (candidate.meters > bestMeters) {
      break; // and every street behind it in the order is further still
    }
    for (const address of streetAddresses(addresses, candidate.street)) {
      const north = (address.lat - lat) * METERS_PER_DEGREE_LAT;
      const east = (address.lng - lng) * metersPerDegreeLng;
      const meters = Math.sqrt(north * north + east * east);
      if (meters < bestMeters) {
        bestMeters = meters;
        best = {
          street: candidate.street,
          name: `${formatHouseNumber(address.number)} ${addresses.names[addresses.streetName[candidate.street]]}`,
          place:
            addresses.places[addresses.streetPlace[candidate.street]] ?? "",
          lat: address.lat,
          lng: address.lng,
          meters,
        };
      }
    }
  }
  return best;
}

interface NearestNames {
  // The best name to call the point: among the documents whose ground it is standing on, the one
  // nearest to it once each has been given its head start.
  owner: { doc: number; meters: number; rank: number } | null;
  // The nearest named thing of any kind, however small, and the nearest neighbourhood: the two
  // answers left when nothing owns the point.
  nearest: { doc: number; meters: number } | null;
  neighborhood: { doc: number; meters: number } | null;
}

// One pass over the document table. Streets and neighbourhoods are left out of the first two answers
// for the same reason: each is filed at the mean of the ground it covers, so how far Broadway's point
// or Bushwick's point is from a pin says nothing about how far Broadway or Bushwick is. The address
// search above answers a street properly, and a neighbourhood is only ever offered as the last thing
// there is to say.
function nearestNames(
  index: SearchIndex,
  lat: number,
  lng: number,
): NearestNames {
  const metersPerUnitLng =
    METERS_PER_UNIT_LAT * Math.cos((lat * Math.PI) / 180);
  const latUnits = lat * COORD_SCALE;
  const lngUnits = lng * COORD_SCALE;
  const found: NearestNames = {
    owner: null,
    nearest: null,
    neighborhood: null,
  };
  // A name with no word in it — a bare "?", a private-use glyph — is in no posting list, so the box
  // cannot find it and a pin has no business being called it. The builder drops these now; the check
  // is here for the files that already shipped with them, and it costs a name decode only for a
  // document that is about to become the answer.
  const findable = (doc: number): boolean =>
    tokenize(docName(index, doc)).length > 0;
  for (let doc = 0; doc < index.docCount; doc += 1) {
    const kind = unpackKind(index.kindFlags[doc]);
    if (kind === "street") {
      continue;
    }
    const north = (index.latUnits[doc] - latUnits) * METERS_PER_UNIT_LAT;
    const east = (index.lngUnits[doc] - lngUnits) * metersPerUnitLng;
    // Squared and rooted rather than Math.hypot, which guards against an overflow no coordinate on
    // Earth can reach and costs five times as much over three hundred thousand documents.
    const meters = Math.sqrt(north * north + east * east);
    if (kind === "neighborhood") {
      if (
        (found.neighborhood === null || meters < found.neighborhood.meters) &&
        findable(doc)
      ) {
        found.neighborhood = { doc, meters };
      }
      continue;
    }
    const rank = meters - headStart(index.prominence[doc]);
    if (
      meters <= nameRadius(index.prominence[doc]) &&
      (found.owner === null || rank < found.owner.rank) &&
      findable(doc)
    ) {
      found.owner = { doc, meters, rank };
    }
    if (
      (found.nearest === null || meters < found.nearest.meters) &&
      findable(doc)
    ) {
      found.nearest = { doc, meters };
    }
  }
  return found;
}

function documentHit(
  index: SearchIndex,
  addresses: AddressIndex,
  doc: number,
  meters: number,
  at: boolean,
): ReverseHit {
  const { placeIndex } = unpackTokenInfo(index.tokenInfo[doc]);
  return {
    kind: unpackKind(index.kindFlags[doc]),
    name: docName(index, doc),
    label: at
      ? docLabel(index, addresses, doc)
      : (addresses.places[placeIndex] ?? ""),
    lat: index.latUnits[doc] / COORD_SCALE,
    lng: index.lngUnits[doc] / COORD_SCALE,
    meters,
    at,
  };
}

// What is near the point, once nothing owns it: the street the nearest number is on, with no number,
// or a name near enough that "near" still means something on foot, whichever is nearer — an
// expressway two hundred metres off is a worse thing to call a spot in Van Cortlandt Park than the
// park's own boathouse. Failing both, which part of the city this is. Failing that, nothing.
function nearbyHit(
  index: SearchIndex,
  addresses: AddressIndex,
  { nearest, neighborhood }: NearestNames,
  address: NearestAddress | null,
): ReverseHit | null {
  const named =
    nearest !== null && nearest.meters <= NEAR_NAME_METERS ? nearest : null;
  if (address !== null && (named === null || address.meters <= named.meters)) {
    return {
      kind: "street",
      name: addresses.names[addresses.streetName[address.street]],
      label: addresses.places[addresses.streetPlace[address.street]] ?? "",
      lat: address.lat,
      lng: address.lng,
      meters: address.meters,
      at: false,
    };
  } else if (named !== null) {
    return documentHit(index, addresses, named.doc, named.meters, false);
  } else if (
    neighborhood !== null &&
    neighborhood.meters <= NEAR_NEIGHBORHOOD_METERS
  ) {
    return documentHit(
      index,
      addresses,
      neighborhood.doc,
      neighborhood.meters,
      false,
    );
  } else {
    return null;
  }
}

// What to call a point. Null where the city has nothing near enough to name it with, which is the
// honest answer for the middle of the harbour and for a point in another city altogether.
export function reverseCity(
  index: SearchIndex,
  addresses: AddressIndex,
  { lat, lng }: { lat: number; lng: number },
): ReverseHit | null {
  const address = nearestAddress(addresses, lat, lng, NEAR_STREET_METERS);
  const names = nearestNames(index, lat, lng);
  const { owner } = names;
  // The number is the plain answer and gets no head start: a name has to be NEARER than the door,
  // after its own head start, to be what the point is called instead.
  if (
    address !== null &&
    address.meters <= AT_ADDRESS_METERS &&
    (owner === null || address.meters <= owner.rank)
  ) {
    return {
      kind: "address",
      name: address.name,
      label: address.place,
      lat: address.lat,
      lng: address.lng,
      meters: address.meters,
      at: true,
    };
  } else if (owner !== null) {
    return documentHit(index, addresses, owner.doc, owner.meters, true);
  } else {
    return nearbyHit(index, addresses, names, address);
  }
}
