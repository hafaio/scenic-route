// Open Location Code (Plus Code) encoder.
// Spec: https://github.com/google/open-location-code/blob/main/docs/specification.md
// Produces a 10-digit ("normal precision", ~14m × 14m) code with the standard
// "+" separator after position 8 — e.g. encode(37.7749, -122.4194) → "849VQH7V+M9".
// 10 digits is what plus.codes/Google Maps/Apple Maps expect when pasted as search input.

const ALPHABET = "23456789CFGHJMPQRVWX";
const SEPARATOR = "+";
const SEPARATOR_POSITION = 8;

// One entry per pair of digits. Each pair encodes lat and lng at the same
// resolution, so we step through these five place-values.
const PAIR_RESOLUTIONS = [20, 1, 0.05, 0.0025, 0.000125];

export function encodePlusCode(lat: number, lng: number): string {
  // Clamp lat to [-90, 90). The upper bound is exclusive in the spec, so nudge
  // an exact 90 inwards by less than the finest pair resolution.
  let latitude = Math.max(-90, Math.min(90, lat));
  if (latitude === 90) {
    latitude = 90 - PAIR_RESOLUTIONS[PAIR_RESOLUTIONS.length - 1] / 2;
  }

  let longitude = lng;
  while (longitude >= 180) {
    longitude -= 360;
  }
  while (longitude < -180) {
    longitude += 360;
  }

  // Shift into non-negative ranges for the base-20 decomposition.
  let latRemainder = latitude + 90;
  let lngRemainder = longitude + 180;

  let code = "";
  for (const placeValue of PAIR_RESOLUTIONS) {
    const latDigit = Math.min(19, Math.floor(latRemainder / placeValue));
    const lngDigit = Math.min(19, Math.floor(lngRemainder / placeValue));
    code += ALPHABET[latDigit] + ALPHABET[lngDigit];
    latRemainder -= latDigit * placeValue;
    lngRemainder -= lngDigit * placeValue;
  }
  return (
    code.slice(0, SEPARATOR_POSITION) +
    SEPARATOR +
    code.slice(SEPARATOR_POSITION)
  );
}
