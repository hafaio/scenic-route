//! Walking a polyline and asking, sample by sample, whether it is inside a set of polygons.
//!
//! Its own module rather than a helper in geometry.rs, which is where it would naturally sit: the
//! shade pass names geometry.rs in its code scope, so a function added there re-renders the whole
//! twenty-minute pyramid — for a sampler shade does not call. The scope is deliberately coarse
//! within a module, so a shared helper has to live outside the modules it is not shared WITH.

use crate::binfmt::Coord;
use crate::geometry::{METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet};
use crate::manifest::Bounds;

// One sample per metre of walk, which is what the two callers of `contained_fraction` want of it: a
// crown is metres across and a district boundary is drawn to the lot line, and even the shortest
// edge — a crossing runs ~15 m — still lands a dozen samples.
const SAMPLE_STEP_METERS: f64 = 1.0;

/// The share of a polyline's LENGTH that falls inside `set`: the line walked at
/// `SAMPLE_STEP_METERS` by arc length, each sample tested UNDERFOOT against the raw 0/1 indicator
/// with no kernel, and the inside share returned. The samples are the midpoints of equal
/// sub-lengths, so the estimate is the arc-length integral of that indicator and every metre of the
/// line weighs the same.
///
/// The candidates are gathered once for the whole polyline — a graph edge is a block long and the
/// grid's cells are wider — so the per-sample work is a box test against a few dozen outlines;
/// `candidates` is the caller's scratch, held across edges so the hot path allocates nothing. A line
/// of fewer than two points (a ferry edge carries none) reads 0.
pub fn contained_fraction(
    poly: &[Coord],
    set: &PolygonSet,
    grid: &PolygonGrid,
    meters_per_degree_lng: f64,
    candidates: &mut Vec<u32>,
) -> f64 {
    if poly.len() < 2 {
        return 0.0;
    }

    let mut spans: Vec<f64> = Vec::with_capacity(poly.len() - 1);
    let mut total = 0.0;
    let mut clip = Bounds {
        south: f64::INFINITY,
        west: f64::INFINITY,
        north: f64::NEG_INFINITY,
        east: f64::NEG_INFINITY,
    };
    for pair in poly.windows(2) {
        let east = (pair[1].lng - pair[0].lng) * meters_per_degree_lng;
        let north = (pair[1].lat - pair[0].lat) * METERS_PER_DEGREE_LAT;
        let span = east.hypot(north);
        spans.push(span);
        total += span;
    }
    for point in poly {
        clip.south = clip.south.min(point.lat);
        clip.north = clip.north.max(point.lat);
        clip.west = clip.west.min(point.lng);
        clip.east = clip.east.max(point.lng);
    }
    grid.candidates(&clip, candidates);
    if total <= 0.0 || candidates.is_empty() {
        return 0.0;
    }

    let samples = (total / SAMPLE_STEP_METERS).ceil().max(1.0) as usize;
    let step = total / samples as f64;
    let mut covered = 0usize;
    let mut segment = 0usize;
    let mut behind = 0.0; // metres of the segments before `segment`
    // The targets rise, so the segment cursor never walks back.
    for sample in 0..samples {
        let target = (sample as f64 + 0.5) * step;
        while segment + 1 < spans.len() && behind + spans[segment] < target {
            behind += spans[segment];
            segment += 1;
        }
        let along = if spans[segment] > 0.0 {
            ((target - behind) / spans[segment]).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let lng = poly[segment].lng + along * (poly[segment + 1].lng - poly[segment].lng);
        let lat = poly[segment].lat + along * (poly[segment + 1].lat - poly[segment].lat);
        if set.contains_point(candidates, lng, lat) {
            covered += 1;
        }
    }
    covered as f64 / samples as f64
}
