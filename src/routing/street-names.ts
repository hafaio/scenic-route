// Prettify a raw CSCL street label ("W 60 ST") into display form ("West 60th Street"). The graph
// ships names uppercased-as-published; presentation stays in TypeScript, so this is the one place
// that knows the abbreviations. Kept deliberately small: the fixed token map covers the types that
// actually occur, a leading directional expands, and a number right before a type is ordinalized.

// Uppercase street-type abbreviation -> expanded word.
const TYPE_WORDS: Readonly<Record<string, string>> = {
  ST: "Street",
  AVE: "Avenue",
  RD: "Road",
  DR: "Drive",
  BLVD: "Boulevard",
  PL: "Place",
  CT: "Court",
  TER: "Terrace",
  LN: "Lane",
  PKWY: "Parkway",
  EXPY: "Expressway",
  HWY: "Highway",
  BR: "Bridge",
  PLZ: "Plaza",
  SQ: "Square",
  PROM: "Promenade",
  BDWK: "Boardwalk",
  TRL: "Trail",
  CIR: "Circle",
  ALY: "Alley",
};

// Leading directional letter -> expanded word (only expanded in the first token, so "AVE N" stays
// "Avenue N" while "W 60 ST" becomes "West ...").
const DIRECTIONAL_WORDS: Readonly<Record<string, string>> = {
  W: "West",
  E: "East",
  N: "North",
  S: "South",
};

// Connector words kept lowercase when they are not the first token ("Avenue of the Americas").
const SMALL_WORDS: ReadonlySet<string> = new Set([
  "of",
  "the",
  "and",
  "at",
  "on",
  "for",
  "to",
  "in",
  "by",
]);

function ordinal(value: number): string {
  const lastTwo = value % 100;
  const lastOne = value % 10;
  let suffix = "th";
  if (lastTwo < 11 || lastTwo > 13) {
    if (lastOne === 1) {
      suffix = "st";
    } else if (lastOne === 2) {
      suffix = "nd";
    } else if (lastOne === 3) {
      suffix = "rd";
    }
  }
  return `${value}${suffix}`;
}

function titleCase(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

export function prettifyStreetName(label: string): string {
  const tokens = label.trim().split(/\s+/);
  const out = tokens.map((token, index) => {
    const upper = token.toUpperCase();
    if (index === 0 && upper in DIRECTIONAL_WORDS) {
      return DIRECTIONAL_WORDS[upper];
    }
    // A leading "ST" is "Saint" (St Marks Pl); the type "Street" only ever trails ("W 60 ST").
    if (index === 0 && upper === "ST") {
      return "Saint";
    }
    if (upper in TYPE_WORDS) {
      return TYPE_WORDS[upper];
    }
    // A connector word stays lowercase unless it leads the name.
    if (index > 0 && SMALL_WORDS.has(token.toLowerCase())) {
      return token.toLowerCase();
    }
    // A bare number directly before a street type is a street ordinal ("W 60 ST" -> "60th").
    if (/^\d+$/.test(token)) {
      const next = tokens[index + 1]?.toUpperCase();
      if (next !== undefined && next in TYPE_WORDS) {
        return ordinal(Number.parseInt(token, 10));
      }
      return token;
    }
    return titleCase(token);
  });
  return out.join(" ");
}
