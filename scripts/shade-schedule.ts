// The shade tiler's bins: the sun's POSITIONS over the year, gridded in (azimuth, elevation), and per
// bin the SUN-DISK samples that give the shadow its penumbra. `tiler shade` bakes one tile pyramid per
// bin; the client maps "now" (today's date + time) to a sun position and picks the bin. `tiler shade`
// does the geometry, this does the astronomy (suncalc), so the sun math stays in TS.

import * as SunCalc from "suncalc";
import manifest from "../src/tree-cover/manifest.json";

// suncalc@2.0.1 returns altitude/azimuth already in DEGREES; azimuth is a compass bearing measured
// clockwise from north. (The classic suncalc API returns radians from south — this fork does not.)
const sun = SunCalc as unknown as {
  getPosition: (
    date: Date,
    lat: number,
    lng: number,
  ) => { altitude: number; azimuth: number };
};

// Buckets are the sun's POSITION, binned over the whole YEAR — a shadow depends only on where the sun
// is, so the bins tile the 2-D (azimuth, elevation) envelope the sun sweeps at this latitude across the
// seasons, NOT a single day. We grid that envelope every EL_STEP_DEGREES of elevation by AZ_STEP_DEGREES
// of azimuth, keep the cells the sun actually enters over the year, and represent each by the mean sun
// position within it. Any real date+time then maps to a position and picks its bin (the client does this
// from "now"). Elevation steps stay coarse-near-peak / fine-near-horizon for free, since the sun lingers
// high and races low. Below the horizon there is no bin.
const EL_STEP_DEGREES = 9;
const AZ_STEP_DEGREES = 30;
const ENUM_YEAR = 2026;
const ENUM_STEP_MINUTES = 4; // the year is swept this finely to find which position cells the sun enters

// The sun is a disk ~0.53° across (angular radius ~0.265°), not a point, so its shadow has a penumbra
// that widens with distance from the occluding edge. The tiler models it directly by averaging the
// shadow cast from these samples spread over the disk: one at the centre, the rest on a ring.
const SUN_ANGULAR_RADIUS_DEG = 0.265;
const DISK_SAMPLES = 6;

// The finest native pyramid level (penumbrae are a 1-10 m effect, so they only resolve deep in) and
// the shadow-length clamp (past this a low sun's shadow is faint and unbounded to trace).
export const SHADE_MAX_ZOOM = 16;
export const SHADE_MAX_SHADOW_METERS = 500;

// One sun-disk sample as the tiler wants it: the ground unit vector pointing DOWN the shadow (anti-sun)
// and the shadow length per metre of building height.
interface ShadeSample {
  east: number;
  north: number;
  shadowPerHeight: number;
}

interface ShadeBucket {
  elevation: number; // the bin's representative sun elevation, degrees
  azimuth: number; // and azimuth (compass, clockwise from north), degrees — together, the sun position
  intensity: number; // solar intensity ~sin(elevation); scales the shade darkness
  samples: ShadeSample[];
}

// The disk samples for a base sun position: index 0 at the centre, the rest on a ring near the disk's
// mean. The azimuth spread divides by cos(elevation) so the offsets stay a circle on the sky.
function diskSamples(azimuthDeg: number, elevationDeg: number): ShadeSample[] {
  const ringRadius = SUN_ANGULAR_RADIUS_DEG * 0.75;
  const cosElevation = Math.cos(elevationDeg * (Math.PI / 180));
  const samples: ShadeSample[] = [];
  for (let index = 0; index < DISK_SAMPLES; index++) {
    let deltaElevation = 0;
    let deltaAzimuth = 0;
    if (index > 0) {
      const angle = (2 * Math.PI * (index - 1)) / (DISK_SAMPLES - 1);
      deltaElevation = ringRadius * Math.cos(angle);
      deltaAzimuth = (ringRadius * Math.sin(angle)) / cosElevation;
    }
    const azimuthRad = (azimuthDeg + deltaAzimuth) * (Math.PI / 180);
    const elevationRad = (elevationDeg + deltaElevation) * (Math.PI / 180);
    samples.push({
      east: -Math.sin(azimuthRad),
      north: -Math.cos(azimuthRad),
      shadowPerHeight: 1 / Math.tan(elevationRad),
    });
  }
  return samples;
}

// The sun-position bins for the year: sweep every day at ENUM_STEP_MINUTES, grid each above-horizon
// position into an (elevation, azimuth) cell, and emit one bucket per visited cell at its mean position.
export function computeShadeBuckets(): ShadeBucket[] {
  const [city] = manifest.cities;
  const { north, south, east, west } = city.bounds;
  const centreLat = (north + south) / 2;
  const centreLng = (east + west) / 2;

  const cells = new Map<
    string,
    { sumEl: number; sumAz: number; count: number }
  >();
  const yearStart = Date.UTC(ENUM_YEAR, 0, 1);
  for (let day = 0; day < 365; day++) {
    const dayStart = yearStart + day * 86_400_000;
    for (let minute = 0; minute < 1440; minute += ENUM_STEP_MINUTES) {
      const position = sun.getPosition(
        new Date(dayStart + minute * 60_000),
        centreLat,
        centreLng,
      );
      if (position.altitude <= 0.5) {
        continue;
      }
      const azimuth = ((position.azimuth % 360) + 360) % 360;
      const elCell = Math.floor(position.altitude / EL_STEP_DEGREES);
      const azCell = Math.floor(azimuth / AZ_STEP_DEGREES);
      const key = `${elCell},${azCell}`;
      const cell = cells.get(key) ?? { sumEl: 0, sumAz: 0, count: 0 };
      cell.sumEl += position.altitude;
      cell.sumAz += azimuth;
      cell.count += 1;
      cells.set(key, cell);
    }
  }

  const buckets: ShadeBucket[] = [];
  for (const cell of cells.values()) {
    const elevation = cell.sumEl / cell.count;
    const azimuth = cell.sumAz / cell.count;
    buckets.push({
      elevation,
      azimuth,
      intensity: Math.max(0, Math.sin(elevation * (Math.PI / 180))),
      samples: diskSamples(azimuth, elevation),
    });
  }
  // A stable order (low sun first, then by azimuth) so bin indices do not churn between builds.
  buckets.sort(
    (left, right) =>
      left.elevation - right.elevation || left.azimuth - right.azimuth,
  );
  return buckets;
}
