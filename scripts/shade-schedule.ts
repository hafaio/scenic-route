// The shade tiler's bins: the sun's positions gridded on (declination, hourAngle) — its natural
// season × time-of-day axes — and per bin the SUN-DISK samples that give the shadow its penumbra.
// `tiler shade` bakes one tile pyramid per bin; the client maps "now" (today's declination + hour
// angle) to the bin and shows it. See src/shade/sun.ts for why this grid, not the raw (azimuth,
// elevation) envelope, is the one that scrubs without jitter.
//
// A shadow depends only on where the sun is, and (declination, hourAngle) fixes that exactly, so each
// bin's sun position is SYNTHESISED straight from its grid cell — no year sweep, no astronomy library
// here. `tiler shade` does the geometry; this does the trig.

import {
  DECL_MAX_DEG,
  HOUR_ANGLE_STEP_DEG,
  SEASON_BANDS,
} from "../src/shade/sun";
import manifest from "../src/tree-cover/manifest.json";

const DEGREES = Math.PI / 180;
const HORIZON_DEG = 0.5; // at or below this the sun is down; no bin

// The sun is a disk ~0.53° across (angular radius ~0.265°), not a point, so its shadow has a penumbra
// that widens with distance from the occluding edge. The tiler models it directly by averaging the
// shadow cast from these samples spread over the disk: one at the centre, the rest on a ring.
const SUN_ANGULAR_RADIUS_DEG = 0.265;
const DISK_SAMPLES = 6;

// The finest native pyramid level (penumbrae are a 1-10 m effect, so they only resolve deep in) and
// the shadow-length clamp (past this a low sun's shadow is faint and unbounded to trace).
export const SHADE_MAX_ZOOM = 15;
export const SHADE_MAX_SHADOW_METERS = 500;

// One sun-disk sample as the tiler wants it: the ground unit vector pointing DOWN the shadow (anti-sun)
// and the shadow length per metre of building height.
interface ShadeSample {
  east: number;
  north: number;
  shadowPerHeight: number;
}

interface ShadeBucket {
  season: number; // the declination band [0, SEASON_BANDS) this bin sits in — its season key
  hourAngle: number; // the sun's hour angle (degrees, 0 at solar noon) — its time-of-day key
  elevation: number; // the synthesised sun elevation for (season, hourAngle), degrees
  azimuth: number; // and azimuth (compass, clockwise from north), degrees
  intensity: number; // solar intensity ~sin(elevation); scales the shade darkness
  samples: ShadeSample[];
}

// The disk samples for a base sun position: index 0 at the centre, the rest on a ring near the disk's
// mean. The azimuth spread divides by cos(elevation) so the offsets stay a circle on the sky.
function diskSamples(azimuthDeg: number, elevationDeg: number): ShadeSample[] {
  const ringRadius = SUN_ANGULAR_RADIUS_DEG * 0.75;
  const cosElevation = Math.cos(elevationDeg * DEGREES);
  const samples: ShadeSample[] = [];
  for (let index = 0; index < DISK_SAMPLES; index++) {
    let deltaElevation = 0;
    let deltaAzimuth = 0;
    if (index > 0) {
      const angle = (2 * Math.PI * (index - 1)) / (DISK_SAMPLES - 1);
      deltaElevation = ringRadius * Math.cos(angle);
      deltaAzimuth = (ringRadius * Math.sin(angle)) / cosElevation;
    }
    const azimuthRad = (azimuthDeg + deltaAzimuth) * DEGREES;
    const elevationRad = (elevationDeg + deltaElevation) * DEGREES;
    samples.push({
      east: -Math.sin(azimuthRad),
      north: -Math.cos(azimuthRad),
      shadowPerHeight: 1 / Math.tan(elevationRad),
    });
  }
  return samples;
}

// The sun's horizontal position (degrees) for a declination and hour angle over `latDeg`: the forward
// spherical-triangle solution the clients invert in src/shade/sun.ts. Azimuth is a compass bearing.
function positionOf(
  declDeg: number,
  hourAngleDeg: number,
  latDeg: number,
): { elevation: number; azimuth: number } {
  const decl = declDeg * DEGREES;
  const hour = hourAngleDeg * DEGREES;
  const lat = latDeg * DEGREES;
  const sinEl =
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(hour);
  const elevation = Math.asin(Math.min(1, Math.max(-1, sinEl)));
  const sinAz = (-Math.cos(decl) * Math.sin(hour)) / Math.cos(elevation);
  const cosAz =
    (Math.sin(decl) - Math.sin(lat) * Math.sin(elevation)) /
    (Math.cos(lat) * Math.cos(elevation));
  const azimuth = Math.atan2(sinAz, cosAz) / DEGREES;
  return {
    elevation: elevation / DEGREES,
    azimuth: (azimuth + 360) % 360,
  };
}

// The bins: for each declination band, the sun position at the band's central declination stepped
// across the daytime hour angles. The band centre stands for every date in the band (identical
// shadows), and the hour steps run from just after sunrise to just before sunset.
export function computeShadeBuckets(): ShadeBucket[] {
  const [city] = manifest.cities;
  const centreLat = (city.bounds.north + city.bounds.south) / 2;

  const buckets: ShadeBucket[] = [];
  const bandWidth = (2 * DECL_MAX_DEG) / SEASON_BANDS;
  for (let band = 0; band < SEASON_BANDS; band++) {
    const declination = -DECL_MAX_DEG + (band + 0.5) * bandWidth;
    // The hour angle at sunrise/sunset for this declination (cos H = -tan φ tan δ); the sweep stays
    // inside it, and the horizon check below trims the last partial step.
    const cosSunset =
      -Math.tan(centreLat * DEGREES) * Math.tan(declination * DEGREES);
    const maxHourAngle =
      Math.abs(cosSunset) >= 1
        ? cosSunset < 0
          ? 180 // sun never sets at this band (not reached at NYC's latitude)
          : 0
        : Math.acos(cosSunset) / DEGREES;
    const steps = Math.floor(maxHourAngle / HOUR_ANGLE_STEP_DEG);
    for (let step = -steps; step <= steps; step++) {
      const hourAngle = step * HOUR_ANGLE_STEP_DEG;
      const position = positionOf(declination, hourAngle, centreLat);
      if (position.elevation <= HORIZON_DEG) {
        continue;
      }
      buckets.push({
        season: band,
        hourAngle,
        elevation: position.elevation,
        azimuth: position.azimuth,
        intensity: Math.max(0, Math.sin(position.elevation * DEGREES)),
        samples: diskSamples(position.azimuth, position.elevation),
      });
    }
  }
  // A stable order (season then hour angle) so bin indices do not churn between builds.
  buckets.sort(
    (left, right) =>
      left.season - right.season || left.hourAngle - right.hourAngle,
  );
  return buckets;
}
