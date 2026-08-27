// `bun run update-places`: every named place in both cities — the shops, restaurants, parks,
// schools, stations and landmarks a destination box is typed at rather than an address — read out of
// Overture Maps and joined to the address file the geocoder already ships.
//
// Overture publishes the planet as parquet on S3, but every row carries its own bounding box, so a
// query naming a city's box reads only the byte ranges that hold it: both cities come down in about
// twenty-five seconds over the open internet, with no account and no planet-sized download. The box is
// only a prefilter — the city's real outline, taken from Overture's own divisions theme, decides
// what is inside it, which is the difference between 533,628 rows in New York's box and 389,043 in
// New York.
//
// A place that resolves to a doorway is stored as that doorway, spelt the way
// public/addresses/<city>.bin.gz spells it, so a search index can hand the pair straight to the
// address search that already exists rather than carrying a second copy of the street names. Parks,
// beaches and landmarks have no street address and never will, so every row keeps its coordinates
// whether it joined or not.
//
// Written to data/places/<city>.jsonl, one JSON object per line, gitignored. This is an
// INTERMEDIATE artifact: the shipped search index is still being designed and will read this.
//
// Overture places is CDLA-Permissive-2.0, with Apache-2.0 on the rows Foursquare sourced and CC0 on
// those from AllThePlaces; its one condition is that the licence text travels with the data
// (scripts/README.md).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  type HouseNumber,
  parseHouseNumber,
} from "../src/search/address-format";
import { decodeAddresses, streetAddresses } from "../src/search/addresses";
import { cached } from "./cache";
import { haversineMeters } from "./geometry";
import type { Coord } from "./socrata";

const PLACES_DIR = join(import.meta.dirname, "..", "data", "places");
// What the city's neighborhood file is called. Spelt out again in scripts/search-index.ts, which
// reads it: importing it from here would open DuckDB in a module that has no use for it.
const NEIGHBORHOOD_SUFFIX = "-neighborhoods.jsonl";
const ADDRESS_DIR = join(import.meta.dirname, "..", "public", "addresses");

// The release a local run reads, pinned rather than "latest" so a rebuild answers with the rows the
// counts in scripts/README.md were measured against rather than whatever shipped this month.
// `OVERTURE_RELEASE` in the environment overrides it, which is what the monthly refresh job passes:
// that job exists to follow the data, and Overture keeps only its last two releases in the public
// bucket, so a job on this pin would stop finding any parquet at all two months after it was set.
// Every run says which release it read, and the job puts that in the commit message it writes.
const PINNED_RELEASE = "2026-08-19.0";
const OVERTURE_RELEASE = process.env.OVERTURE_RELEASE || PINNED_RELEASE;
const OVERTURE_BUCKET = "s3://overturemaps-us-west-2/release";
const PLACES_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=places/type=place/*.parquet`;
const DIVISIONS_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=divisions/type=division_area/*.parquet`;
// The same theme's places rather than its shapes: a division_area is the outline a city is clipped
// to, and a division is the named point inside it, which is what a neighborhood is here.
const DIVISION_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=divisions/type=division/*.parquet`;

// What Overture calls the parts of a city a person names: a macrohood is Brooklyn or the Mission, a
// neighborhood is Park Slope or Noe Valley, and a microhood is Williamsburg, Harlem and Times
// Square. The tier says how the sources nest, not how well known the name is — leave the last of the
// three out and the city loses exactly the names most likely to be typed — so all three are read.
const NEIGHBORHOOD_SUBTYPES = ["macrohood", "neighborhood", "microhood"];

// An administrative unit filed as a neighborhood. Nobody walks to Manhattan Community Board 5, and
// the name is the only thing that says so.
const NOT_A_NEIGHBORHOOD = /\bcommunity (board|district)\b/i;

// How near two rows of one name have to be to be one neighborhood written down twice. The gap in the
// data is wide, so this sits in the middle of it: Herald Square, Union Square, Hayes Valley and
// Fresh Meadows are each filed twice within 1.2 km, and the next pair of a shared name stands ten
// kilometres apart — Chelsea in Manhattan and Chelsea in Staten Island, which are two real places.
const SAME_NEIGHBORHOOD_METERS = 2000;

// How sure Overture is that a place exists and is what it says. Below this the names stop being
// things anyone would type — a phone number where the name goes, a half-transcribed shopfront — and
// the cut is visible in the summary: it takes New York from 389,043 rows inside the city to 309,968.
const MIN_CONFIDENCE = 0.5;

// A place Overture knows has closed. Most rows say nothing either way, and those are kept.
const CLOSED = "permanently_closed";

// How far a place may sit from the doorway it claims. New York does not qualify its street names, so
// its five Court Streets are one street to look a house number up in, and a place in Staten Island
// can match a house on the Queens street of that name: 1.7% of the joins landed over 500 m out, the
// worst of them 50 km. There is no gap in the distances to cut at — 96% are within 100 m and the
// rest tails off — so this is not tuned to the data. It is the distance past which a place and its
// own front door cannot be the same thing, set wide enough to keep a hospital or a campus whose
// point is a centroid and whose address is a gate. A place it rejects keeps its coordinates and
// loses only the doorway.
const MAX_JOIN_METERS = 1000;

export interface PlaceRow {
  name: string;
  category: string | null;
  lat: number;
  lng: number;
  // The ADDRESS FILE's spelling of the doorway, not Overture's, and null on both where the place did
  // not join — which is every park and most landmarks, since they have no street address to join.
  street: string | null;
  houseNumber: HouseNumber | null;
}

// A named part of a city — what someone types when they mean an area rather than a door. Written
// beside the places because it comes out of the same read, and read back by the search index.
export interface NeighborhoodRow {
  name: string;
  lat: number;
  lng: number;
}

// A place as Overture hands it over, before the confidence filter and before the address join.
interface RawPlace {
  name: string;
  category: string | null;
  lat: number;
  lng: number;
  address: string | null;
  confidence: number;
  status: string | null;
}

// The long forms one file writes out and the other abbreviates. Applied to both sides of the join,
// so a fold that is wrong is wrong symmetrically and cannot invent a match.
const STREET_WORDS: Readonly<Record<string, string>> = {
  AVENUE: "AVE",
  STREET: "ST",
  ROAD: "RD",
  BOULEVARD: "BLVD",
  PLACE: "PL",
  DRIVE: "DR",
  PARKWAY: "PKWY",
  TERRACE: "TER",
  COURT: "CT",
  LANE: "LN",
  HIGHWAY: "HWY",
  PLAZA: "PLZ",
  SQUARE: "SQ",
  TURNPIKE: "TPKE",
  EXPRESSWAY: "EXPY",
  CIRCLE: "CIR",
  ALLEY: "ALY",
  SAINT: "ST",
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
};

// Ordinals because Overture writes "W 39th St" where New York files "W 39 ST"; leading zeros because
// San Francisco files "03 ST"; apostrophes because San Francisco drops them ("OFARRELL ST") and New
// York keeps them ("O'BRIEN AVE").
export function normalizeStreet(text: string): string {
  return text
    .toUpperCase()
    .replace(/[.,']/g, "")
    .replace(/([0-9])(?:ST|ND|RD|TH)\b/g, "$1")
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => STREET_WORDS[word] ?? word.replace(/^0+(?=[0-9])/, ""))
    .join(" ");
}

// The names the two files genuinely disagree about, each checked against the published street list
// rather than guessed. The key is what Overture writes, the value what the address file files it
// under; both go through normalizeStreet, so neither has to be written pre-folded.
const STREET_ALIASES: Readonly<Record<string, string>> = {
  // New York abbreviates these where Overture writes them out.
  "Grand Concourse": "Grand Conc",
  "Beach Channel Dr": "Bch Channel Dr",
  "MacDougal St": "Mac Dougal St",
  "MacDougal Aly": "Mac Dougal Aly",
  "Crossbay Blvd": "Cross Bay Blvd",
  // An honorary name the address file never adopted.
  "Fashion Ave": "7 Ave",
  // San Francisco splits Bayshore, files two streets with no type at all, and keeps the
  // Embarcadero's article.
  "Bayshore Blvd": "Bay Shore Blvd",
  "La Playa St": "La Playa",
  "South Park St": "South Park",
  Embarcadero: "The Embarcadero",
  "Cesar Chavez": "Cesar Chavez St",
};

const ALIASED_STREETS = new Map(
  Object.entries(STREET_ALIASES).map(([overture, published]) => [
    normalizeStreet(overture),
    normalizeStreet(published),
  ]),
);

// A unit inside the building — "305 W 39th St Ste 210", "246 2nd St Apt 1102" — which the address
// file does not carry and the street name has to lose before it can be looked up.
const UNIT_TAIL =
  /\s+(?:STE|SUITE|APT|UNIT|FL|FLOOR|RM|ROOM|BLDG|LBBY|PH|BSMT|SPC|#)\b.*$/i;

export interface SplitAddress {
  number: HouseNumber;
  street: string; // normalized, ready to look up
}

// Overture writes a US address as one line with the house number first, so the split is that first
// run of digits. Null where the line names a street with no number on it, or is not an address at
// all ("Ocean Beach Parking"), which is what the parks and the landmarks have.
export function splitAddress(freeform: string): SplitAddress | null {
  const match = /^\s*([0-9]{1,7}(?:\s*-\s*[0-9]{1,4})?[A-Za-z]?)\s+(.+)$/.exec(
    freeform,
  );
  if (match === null) {
    return null;
  } else {
    const number = parseHouseNumber(match[1]);
    const street = normalizeStreet(match[2].replace(UNIT_TAIL, ""));
    if (number === null || street === "") {
      return null;
    } else {
      return { number, street };
    }
  }
}

// One house of the address file, where the file puts it.
export interface PlacedAddress extends Coord {
  number: HouseNumber;
}

// One street of the address file: the name as it publishes it, and its houses under a key that runs
// the three parts of a house number together. A key holds a LIST because the boroughs merge below,
// and New York has a 312 on more than one Court Street.
export interface StreetAddresses {
  name: string;
  numbers: Map<string, PlacedAddress[]>;
  // The hyphenated numbers under the key they get when the two halves are run together, kept apart
  // from the real ones so that a street with both a 126-10 and a 12610 answers "12610" with the
  // house of that number rather than with whichever was filed first.
  runTogether: Map<string, PlacedAddress[]>;
}

export type PlaceAddressIndex = Map<string, StreetAddresses>;

function numberKey({ major, minor, suffix }: HouseNumber): string {
  return `${major}/${minor}/${suffix}`;
}

function addHouse(
  houses: Map<string, PlacedAddress[]>,
  key: string,
  address: PlacedAddress,
): void {
  const existing = houses.get(key);
  if (existing === undefined) {
    houses.set(key, [address]);
  } else {
    existing.push(address);
  }
}

// Queens files a house as "126-10" and Overture writes it either way, so the hyphenated numbers are
// registered a second time as the digits run together. The minor is a number by the time it gets
// here, so its padding is put back — "25-07" is 2507 and never 257.
function runTogetherKey(number: HouseNumber): string | null {
  if (number.minor === 0) {
    return null;
  } else {
    const digits = `${number.major}${String(number.minor).padStart(2, "0")}`;
    return numberKey({
      major: Number(digits),
      minor: 0,
      suffix: number.suffix,
    });
  }
}

// New York has five Court Streets and one published spelling of the name, so the boroughs merge
// here: the name is all a place's address line gives us to look them up by. Which of them a house is
// on is settled at the join, by distance.
export function buildAddressIndex(
  streets: Iterable<{ name: string; addresses: Iterable<PlacedAddress> }>,
): PlaceAddressIndex {
  const index: PlaceAddressIndex = new Map();
  for (const { name, addresses } of streets) {
    const key = normalizeStreet(name);
    let street = index.get(key);
    if (street === undefined) {
      street = { name, numbers: new Map(), runTogether: new Map() };
      index.set(key, street);
    }
    for (const address of addresses) {
      addHouse(street.numbers, numberKey(address.number), address);
      const alias = runTogetherKey(address.number);
      if (alias !== null) {
        addHouse(street.runTogether, alias, address);
      }
    }
  }
  return index;
}

export interface JoinedAddress {
  street: string;
  houseNumber: HouseNumber;
  // How far the house the address file puts there is from the place. Answered rather than judged:
  // whether it is near enough to be the same doorway is MAX_JOIN_METERS' call, not this function's.
  meters: number;
}

// The house an Overture address line names — the nearest of them where a name is shared — or null
// where the address file has no such street or no such number on it. `at` is where Overture puts the place, which is the only
// thing that tells the boroughs' streets of one name apart.
export function matchAddress(
  freeform: string,
  at: Coord,
  index: PlaceAddressIndex,
): JoinedAddress | null {
  const split = splitAddress(freeform);
  if (split === null) {
    return null;
  }
  const alias = ALIASED_STREETS.get(split.street);
  const street =
    index.get(split.street) ??
    (alias === undefined ? undefined : index.get(alias));
  const key = numberKey(split.number);
  // A house of that number outranks a hyphenated one that happens to spell it.
  const houses = street?.numbers.get(key) ?? street?.runTogether.get(key);
  if (street === undefined || houses === undefined) {
    return null;
  } else {
    let nearest = houses[0];
    let meters = haversineMeters(at, nearest);
    for (const house of houses) {
      const distance = haversineMeters(at, house);
      if (distance < meters) {
        nearest = house;
        meters = distance;
      }
    }
    return { street: street.name, houseNumber: nearest.number, meters };
  }
}

// One city's read: the box that prefilters the parquet, and the division that decides the outline.
// The box is deliberately generous — it only has to contain the city, and the outline does the rest.
interface Source {
  id: string;
  name: string;
  west: number;
  south: number;
  east: number;
  north: number;
  // The Overture division that is the city. New York is a locality of all five boroughs; San
  // Francisco is a county, and its land class is the one that leaves out the bay.
  division: { name: string; subtype: string };
}

const SOURCES: readonly Source[] = [
  {
    id: "nyc",
    name: "New York",
    west: -74.3,
    south: 40.47,
    east: -73.68,
    north: 40.93,
    division: { name: "New York", subtype: "locality" },
  },
  {
    id: "sf",
    name: "San Francisco",
    west: -122.53,
    south: 37.69,
    east: -122.34,
    north: 37.84,
    division: { name: "San Francisco", subtype: "county" },
  },
];

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// The outline is prefiltered by INTERSECTION rather than containment: San Francisco's county polygon
// reaches out to the Farallon Islands, so its own box is far wider than the city's and a containment
// test would match nothing.
function outlineSql(source: Source): string {
  const { name, subtype } = source.division;
  return `SELECT geometry FROM read_parquet(${sqlText(DIVISIONS_PARQUET)})
    WHERE country = 'US'
      AND subtype = ${sqlText(subtype)}
      AND class = 'land'
      AND names.primary = ${sqlText(name)}
      AND bbox.xmin < ${source.east} AND bbox.xmax > ${source.west}
      AND bbox.ymin < ${source.north} AND bbox.ymax > ${source.south}`;
}

function placesSql(source: Source): string {
  return `WITH outline AS (${outlineSql(source)})
    SELECT
      place.names.primary AS name,
      place.categories.primary AS category,
      ST_Y(place.geometry) AS lat,
      ST_X(place.geometry) AS lng,
      place.addresses[1].freeform AS address,
      place.confidence AS confidence,
      place.operating_status AS status
    FROM read_parquet(${sqlText(PLACES_PARQUET)}) AS place, outline
    WHERE place.bbox.xmin > ${source.west} AND place.bbox.xmax < ${source.east}
      AND place.bbox.ymin > ${source.south} AND place.bbox.ymax < ${source.north}
      AND place.names.primary IS NOT NULL
      AND ST_Contains(outline.geometry, place.geometry)`;
}

// Every named part of one city: the same outline the places are clipped to, and the division points
// inside it. The subtypes come back together because the three of them are one list to a reader —
// Brooklyn, Park Slope and Williamsburg are all answers to "where is that".
function neighborhoodsSql(source: Source): string {
  const subtypes = NEIGHBORHOOD_SUBTYPES.map(sqlText).join(", ");
  return `WITH outline AS (${outlineSql(source)})
    SELECT
      area.names.primary AS name,
      ST_Y(area.geometry) AS lat,
      ST_X(area.geometry) AS lng
    FROM read_parquet(${sqlText(DIVISION_PARQUET)}) AS area, outline
    WHERE area.country = 'US'
      AND area.subtype IN (${subtypes})
      AND area.bbox.xmin > ${source.west} AND area.bbox.xmax < ${source.east}
      AND area.bbox.ymin > ${source.south} AND area.bbox.ymax < ${source.north}
      AND area.names.primary IS NOT NULL
      AND ST_Contains(outline.geometry, area.geometry)`;
}

// The rows worth typing at, out of the ones the query returned: the administrative units dropped, and
// a name the theme files twice kept once. Sorted first, so which of a repeated pair survives is the
// file's own order rather than the parquet's.
export function toNeighborhoods(
  rows: readonly NeighborhoodRow[],
): NeighborhoodRow[] {
  const kept: NeighborhoodRow[] = [];
  const ordered = [...rows].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.lat - right.lat ||
      left.lng - right.lng,
  );
  for (const row of ordered) {
    if (NOT_A_NEIGHBORHOOD.test(row.name)) {
      continue;
    }
    const twice = kept.some(
      (other) =>
        other.name === row.name &&
        haversineMeters(other, row) <= SAME_NEIGHBORHOOD_METERS,
    );
    if (!twice) {
      kept.push(row);
    }
  }
  return kept;
}

async function connect(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';",
  );
  return connection;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function coordinate(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`a place came back with no ${field}`);
  } else {
    return value;
  }
}

// Every named place inside one city, unfiltered, cached under .cache/ against the query itself — so
// a changed release, box or outline lands on a different entry rather than reusing the old one, and
// REFRESH=1 goes back to the network regardless.
async function fetchPlaces(
  connection: DuckDBConnection,
  source: Source,
): Promise<RawPlace[]> {
  const sql = placesSql(source);
  return await cached(`places.${source.id}`, sql, async () => {
    const outlines = await connection.runAndReadAll(
      `SELECT count(*) AS found FROM (${outlineSql(source)})`,
    );
    const found = Number(outlines.getRowObjects()[0].found);
    if (found !== 1) {
      // Overture renames and re-classes divisions between releases. Silently clipping every place
      // away is the failure this catches.
      throw new Error(
        `${source.name}: ${found} divisions named ${source.division.name}, expected 1`,
      );
    }
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjects().map((row) => ({
      name: String(row.name),
      category: text(row.category),
      lat: coordinate(row.lat, "latitude"),
      lng: coordinate(row.lng, "longitude"),
      address: text(row.address),
      confidence: typeof row.confidence === "number" ? row.confidence : 0,
      status: text(row.status),
    }));
  });
}

// The city's own named parts, cached against the query the way the places are.
async function fetchNeighborhoods(
  connection: DuckDBConnection,
  source: Source,
): Promise<NeighborhoodRow[]> {
  const sql = neighborhoodsSql(source);
  return await cached(`neighborhoods.${source.id}`, sql, async () => {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjects().map((row) => ({
      name: String(row.name),
      lat: coordinate(row.lat, "latitude"),
      lng: coordinate(row.lng, "longitude"),
    }));
  });
}

// The address file as it shipped, which is the point of reading it back rather than the city's
// export: a place joins to the spelling the client will look up, or it does not join.
async function loadAddressIndex(cityId: string): Promise<PlaceAddressIndex> {
  const gzipped = await readFile(join(ADDRESS_DIR, `${cityId}.bin.gz`));
  const addresses = decodeAddresses(gunzipSync(gzipped));
  return buildAddressIndex(
    addresses.streetName.entries().map(([street, name]) => ({
      name: addresses.sourceNames[name],
      addresses: streetAddresses(addresses, street),
    })),
  );
}

interface Summary {
  fetched: number;
  kept: number;
  joined: number;
  tooFar: number; // named a house the place is nowhere near, and so did not join
  categories: number;
}

function toRows(
  places: readonly RawPlace[],
  index: PlaceAddressIndex,
): { rows: PlaceRow[]; summary: Summary } {
  const rows: PlaceRow[] = [];
  const categories = new Set<string>();
  let joined = 0;
  let tooFar = 0;
  for (const place of places) {
    if (place.confidence < MIN_CONFIDENCE || place.status === CLOSED) {
      continue;
    }
    const match =
      place.address === null ? null : matchAddress(place.address, place, index);
    const address =
      match !== null && match.meters <= MAX_JOIN_METERS ? match : null;
    if (address !== null) {
      joined += 1;
    } else if (match !== null) {
      tooFar += 1;
    }
    if (place.category !== null) {
      categories.add(place.category);
    }
    rows.push({
      name: place.name,
      category: place.category,
      lat: place.lat,
      lng: place.lng,
      street: address?.street ?? null,
      houseNumber: address?.houseNumber ?? null,
    });
  }
  return {
    rows,
    summary: {
      fetched: places.length,
      kept: rows.length,
      joined,
      tooFar,
      categories: categories.size,
    },
  };
}

export async function updatePlaces(): Promise<void> {
  await mkdir(PLACES_DIR, { recursive: true });
  const connection = await connect();
  for (const source of SOURCES) {
    console.error(
      `places: reading ${source.name} from Overture ${OVERTURE_RELEASE}`,
    );
    const places = await fetchPlaces(connection, source);
    const index = await loadAddressIndex(source.id);
    const { rows, summary } = toRows(places, index);
    const lines = rows.map((row) => JSON.stringify(row));
    await writeFile(
      join(PLACES_DIR, `${source.id}.jsonl`),
      `${lines.join("\n")}\n`,
    );
    const found = await fetchNeighborhoods(connection, source);
    const neighborhoods = toNeighborhoods(found);
    await writeFile(
      join(PLACES_DIR, `${source.id}${NEIGHBORHOOD_SUFFIX}`),
      `${neighborhoods.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const rate = ((100 * summary.joined) / summary.kept).toFixed(1);
    console.error(
      `places: ${source.id}: ${summary.fetched} in the city, ${summary.kept} kept, ` +
        `${summary.joined} joined to an address (${rate}%), ` +
        `${summary.kept - summary.joined} with coordinates only, ` +
        `${summary.tooFar} of those a house too far off to be theirs, ` +
        `${summary.categories} categories, ` +
        `${neighborhoods.length} neighborhoods of ${found.length} named parts`,
    );
  }
  connection.closeSync();
}

if (import.meta.main) {
  await updatePlaces();
}
