// The sun coordinates the shade bins are gridded on. A building's shadow depends ONLY on the sun's
// declination (which season) and its hour angle (how far the day has run) — not on the calendar date
// or clock: two dates with the same declination cast identical shadows, and the hour angle is what
// advances, smoothly and monotonically, as the day passes. So the shade bins tile a (declination,
// hourAngle) grid rather than the raw (elevation, azimuth) envelope, and mapping "now" to a bin is a
// season-band lookup plus a monotone step along the hour axis — no nearest-centroid flip as the clock
// moves, which is what jittered the old (azimuth, elevation) grid.
//
// Shared by the build-time schedule (scripts/shade-schedule.ts, which SYNTHESIsES each bin's sun
// position straight from its (declination, hourAngle)) and the two clients that map a time to a bin
// (the shade overlay and the router), so all three grid the sky identically. suncalc's azimuth is a
// compass bearing clockwise from north; every formula here uses that convention.

const DEGREES = Math.PI / 180;

// The sun's declination at the solstices; its declination stays within ±this all year, so the bands
// tile [-DECL_MAX_DEG, DECL_MAX_DEG].
export const DECL_MAX_DEG = 23.44;

// The grid resolution. SEASON_BANDS declination bands over the year × hour-angle steps of
// HOUR_ANGLE_STEP_DEG (15° = 1 h of the sun's rotation). Together these set the shade bin count, which
// trades off against the tile-pyramid size — tuned from a measured per-bin size at SHADE_MAX_ZOOM.
export const SEASON_BANDS = 6;
export const HOUR_ANGLE_STEP_DEG = 18;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// The sun's declination (degrees) from its horizontal position over an observer at `latDeg`. The
// inverse of the standard altitude formula: sin δ = sin φ sin el + cos φ cos el cos A.
export function declinationOf(
  elevationDeg: number,
  azimuthDeg: number,
  latDeg: number,
): number {
  const elevation = elevationDeg * DEGREES;
  const azimuth = azimuthDeg * DEGREES;
  const lat = latDeg * DEGREES;
  const sinDecl =
    Math.sin(lat) * Math.sin(elevation) +
    Math.cos(lat) * Math.cos(elevation) * Math.cos(azimuth);
  return Math.asin(clamp(sinDecl, -1, 1)) / DEGREES;
}

// The sun's hour angle (degrees; 0 at solar noon, negative before it, positive after) from its
// horizontal position and its declination. Solved from the same spherical triangle as the altitude.
export function hourAngleOf(
  elevationDeg: number,
  azimuthDeg: number,
  latDeg: number,
  declDeg: number,
): number {
  const elevation = elevationDeg * DEGREES;
  const azimuth = azimuthDeg * DEGREES;
  const lat = latDeg * DEGREES;
  const decl = declDeg * DEGREES;
  const sinHour = (-Math.cos(elevation) * Math.sin(azimuth)) / Math.cos(decl);
  const cosHour =
    (Math.sin(elevation) - Math.sin(lat) * Math.sin(decl)) /
    (Math.cos(lat) * Math.cos(decl));
  return Math.atan2(sinHour, cosHour) / DEGREES;
}

// The declination band [0, SEASON_BANDS) a declination falls in — the bin's season key. Two dates
// six months apart at the same declination share a band, so their identical shadows share one bin.
export function seasonBand(declDeg: number): number {
  const fraction = (declDeg + DECL_MAX_DEG) / (2 * DECL_MAX_DEG);
  return clamp(Math.floor(fraction * SEASON_BANDS), 0, SEASON_BANDS - 1);
}
