// Deciding whether a DOB permit's street is the street a graph edge carries. DOB writes the name out
// in full and pads its numbers ("WEST   057 STREET"); CSCL, which the routing graph ships, writes it
// abbreviated ("W 57 ST"). Both sides are normalised to the same token string and then compared on
// their distinctive tokens, with the street type required to agree — "182 ST" must not claim the
// "182 PL" stub one block over, and it would, since every other token matches.

// CSCL writes the abbreviation; DOB writes the expansion.
const SUFFIXES: Readonly<Record<string, string>> = {
  STREET: "ST",
  STR: "ST",
  AVENUE: "AVE",
  AVEN: "AVE",
  AV: "AVE",
  BOULEVARD: "BLVD",
  BOULEVARDE: "BLVD",
  PLACE: "PL",
  ROAD: "RD",
  DRIVE: "DR",
  PARKWAY: "PKWY",
  PARKWY: "PKWY",
  LANE: "LN",
  COURT: "CT",
  TERRACE: "TER",
  EXPRESSWAY: "EXPY",
  CIRCLE: "CIR",
  PLAZA: "PLZ",
  SQUARE: "SQ",
  TURNPIKE: "TPKE",
  HIGHWAY: "HWY",
  CRESCENT: "CRES",
  EXTENSION: "EXT",
  CONCOURSE: "CONC",
  ESPLANADE: "ESPL",
  PROMENADE: "PROM",
};

const PREFIXES: Readonly<Record<string, string>> = {
  EAST: "E",
  WEST: "W",
  NORTH: "N",
  SOUTH: "S",
  BEACH: "BCH",
  SAINT: "ST",
  MOUNT: "MT",
  FORT: "FT",
};

// A permit that spells its ordinal out ("FIFTH AVENUE") describes a street the graph numbers
// ("5 AVE"), and nothing else in the comparison can bridge that.
const SPELLED_ORDINALS: Readonly<Record<string, string>> = {
  FIRST: "1",
  SECOND: "2",
  THIRD: "3",
  FOURTH: "4",
  FIFTH: "5",
  SIXTH: "6",
  SEVENTH: "7",
  EIGHTH: "8",
  NINTH: "9",
  TENTH: "10",
  ELEVENTH: "11",
  TWELFTH: "12",
};

// The distinctive tokens are what the comparison runs on, so the generic type words are dropped.
const GENERIC: ReadonlySet<string> = new Set([
  "ST",
  "AVE",
  "BLVD",
  "PL",
  "RD",
  "DR",
  "PKWY",
  "LN",
  "CT",
  "TER",
  "EXPY",
  "CIR",
  "PLZ",
  "SQ",
  "TPKE",
  "HWY",
  "WALK",
  "LOOP",
  "PATH",
  "ROW",
  "WAY",
  "ALY",
  "BRG",
  "TUNL",
  "SLIP",
]);

// A particle the city writes both joined and split, and which side does it depends on the feed
// ("MC DOUGAL ST" in the graph against "MACDOUGAL ST" on the permit). Joining is safe in a way an
// alias is not: both names get the same treatment, so a merge that is wrong is at least consistent.
const JOINING_PARTICLES: ReadonlySet<string> = new Set(["MC", "MAC", "DE"]);

// Streets the city renamed but the permits still call by their number, and vice versa. A name scores
// against every one of its aliases, rather than being rewritten into one: `6 AVENUE` is Avenue of the
// Americas in Manhattan and a plain 6th Avenue in Brooklyn, and only the candidate edges near the lot
// decide which. Keyed and valued in normalised form.
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  "6 AVE": ["AVE OF THE AMERICAS"],
  "AVE OF THE AMERICAS": ["6 AVE"],
  "7 AVE": ["ADAM C POWELL BLVD"],
  "ADAM C POWELL BLVD": ["7 AVE"],
  "8 AVE": ["FREDERICK DOUGLASS BLVD"],
  "FREDERICK DOUGLASS BLVD": ["8 AVE"],
  "LENOX AVE": ["MALCOLM X BLVD"],
  "MALCOLM X BLVD": ["LENOX AVE"],
  "W 110 ST": ["CATHEDRAL PKWY"],
  "CATHEDRAL PKWY": ["W 110 ST"],
};

const ORDINAL = /^(\d+)(ST|ND|RD|TH)$/;
const PUNCTUATION = /[.,'`]/g;

// The graph carries 8,495 distinct names and the feed a comparable number of streets, so both
// normalisation and the pair score are worth memoizing: the placement asks for a score once per
// candidate sidewalk per shed, which is millions of calls over 61,302 permits.
const normalised = new Map<string, string>();
const cores = new Map<string, ReadonlySet<string>>();
const scores = new Map<string, number>();

// Canonical token string, e.g. "WEST   057 STREET" -> "W 57 ST".
export function normalizeStreet(name: string): string {
  const hit = normalised.get(name);
  if (hit !== undefined) {
    return hit;
  }
  const cleaned = name
    .toUpperCase()
    .replace(PUNCTUATION, "")
    .replace(/[-/]/g, " ");
  const tokens: string[] = [];
  for (let token of cleaned.split(/\s+/)) {
    if (token === "") {
      continue;
    }
    const ordinal = ORDINAL.exec(token);
    if (ordinal) {
      token = ordinal[1];
    }
    if (/^\d+$/.test(token)) {
      token = String(Number.parseInt(token, 10)); // drop DOB's zero and space padding
    }
    token =
      SPELLED_ORDINALS[token] ?? PREFIXES[token] ?? SUFFIXES[token] ?? token;
    const previous = tokens[tokens.length - 1];
    if (
      previous !== undefined &&
      JOINING_PARTICLES.has(previous) &&
      /^[A-Z]/.test(token)
    ) {
      tokens[tokens.length - 1] = previous + token;
    } else {
      tokens.push(token);
    }
  }
  const value = tokens.join(" ");
  normalised.set(name, value);
  return value;
}

function coreTokens(canonical: string): ReadonlySet<string> {
  const hit = cores.get(canonical);
  if (hit !== undefined) {
    return hit;
  }
  const value = new Set(
    canonical.split(" ").filter((token) => token !== "" && !GENERIC.has(token)),
  );
  cores.set(canonical, value);
  return value;
}

function suffixOf(canonical: string): string | null {
  const tokens = canonical.split(" ");
  const last = tokens[tokens.length - 1];
  return last !== undefined && GENERIC.has(last) ? last : null;
}

function scoreCanonical(shed: string, graph: string): number {
  if (shed === graph) {
    return 1;
  }
  const shedCore = coreTokens(shed);
  const graphCore = coreTokens(graph);
  if (shedCore.size === 0 || graphCore.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of shedCore) {
    if (graphCore.has(token)) {
      shared += 1;
    }
  }
  // A numbered street and the numbered place one block over share every distinctive token, so the
  // type has to agree or the mapping happily walks onto the wrong pavement.
  const sameSuffix = suffixOf(shed) === suffixOf(graph);
  if (shared === shedCore.size && shared === graphCore.size) {
    return sameSuffix ? 0.75 : 0.3;
  } else {
    const overlap = shared / (shedCore.size + graphCore.size - shared);
    return (sameSuffix ? 0.7 : 0.3) * overlap;
  }
}

// How well a permit's street agrees with a graph edge's: 1 exact, 0.75 same distinctive tokens and
// the same type, otherwise the Jaccard of those tokens, halved when the type disagrees.
export function streetScore(
  shedName: string,
  graphName: string | null,
): number {
  if (graphName === null) {
    return 0;
  }
  // NUL joins the two names because a street name can contain anything else, and a separator
  // that appears in a name would let one pair collide with another.
  const key = `${shedName}\u0000${graphName}`;
  const hit = scores.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const shed = normalizeStreet(shedName);
  const graph = normalizeStreet(graphName);
  let best = scoreCanonical(shed, graph);
  for (const alias of ALIASES[shed] ?? []) {
    best = Math.max(best, scoreCanonical(alias, graph));
  }
  for (const alias of ALIASES[graph] ?? []) {
    best = Math.max(best, scoreCanonical(shed, alias));
  }
  scores.set(key, best);
  return best;
}
