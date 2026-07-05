// Open Location Code (Plus Code) encoder.
// Spec: https://github.com/google/open-location-code/blob/main/docs/specification.md
// Produces a 10-digit ("normal precision", ~14m × 14m) code with the standard
// "+" separator after position 8 — e.g. encode(37.7749, -122.4194) → "849VQHFJ+X6".
// 10 digits is what plus.codes/Google Maps/Apple Maps expect when pasted as search input.

const ALPHABET = "23456789CFGHJMPQRVWX";
const SEPARATOR = "+";
const SEPARATOR_POSITION = 8;

// integer 1/8000° units (the finest pair resolution) keep the base-20 decomposition exact, avoiding FP errors
const PAIR_COUNT = 5;
const UNITS_PER_DEGREE = 8000;
const PAIR_BASE = 20;
const LAT_UNITS_RANGE = 180 * UNITS_PER_DEGREE;
const LNG_UNITS_RANGE = 360 * UNITS_PER_DEGREE;

export function encodePlusCode(lat: number, lng: number): string {
  // spec's upper bound is exclusive; the unit clamp keeps an exact 90 in range
  const latitude = Math.max(-90, Math.min(90, lat));

  let longitude = lng;
  while (longitude >= 180) {
    longitude -= 360;
  }
  while (longitude < -180) {
    longitude += 360;
  }

  // floor, not round: a code names the cell its coordinate falls on or past
  let latUnits = Math.floor((latitude + 90) * UNITS_PER_DEGREE);
  let lngUnits = Math.floor((longitude + 180) * UNITS_PER_DEGREE);
  latUnits = Math.max(0, Math.min(LAT_UNITS_RANGE - 1, latUnits));
  lngUnits = Math.max(0, Math.min(LNG_UNITS_RANGE - 1, lngUnits));

  // reversed so the coarsest pair leads
  const pairs: string[] = [];
  for (let pairIndex = 0; pairIndex < PAIR_COUNT; pairIndex++) {
    pairs.push(ALPHABET[latUnits % PAIR_BASE] + ALPHABET[lngUnits % PAIR_BASE]);
    latUnits = Math.floor(latUnits / PAIR_BASE);
    lngUnits = Math.floor(lngUnits / PAIR_BASE);
  }
  const code = pairs.reverse().join("");
  return (
    code.slice(0, SEPARATOR_POSITION) +
    SEPARATOR +
    code.slice(SEPARATOR_POSITION)
  );
}
