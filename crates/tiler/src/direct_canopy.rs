//! The per-edge DIRECT canopy byte (GRPH v6, record byte 28): how much of a sidewalk has a crown
//! literally over it.
//!
//! This is **not** the cover byte (record byte 20). Cover is the deliberately smoothed field the
//! overlay is coloured from — an oriented anisotropic Gaussian, sigma 15 m along the road and 4 m
//! across, reaching +/-37.5 m — so the colour does not lurch block to block. That answers "is this a
//! leafy stretch"; a walker sheltering from rain is asking "is there anything over my head *here*",
//! which a kernel reaching most of a block cannot say. So this integrates the raw 0/1 canopy
//! indicator along the edge's own baked polyline with no kernel at all — the fraction of the edge's
//! length that falls under a canopy polygon — and quantizes it to the same 0..254 ceiling the cover
//! and scenic bytes use.
//!
//! It samples the sidewalk geometry the graph baked, not the street centreline, so the two sides of
//! a one-sided street differ, which is the whole point of asking.

use std::path::Path;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, Coord};
use crate::geometry::{METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet, flatten, round_half_up};
use crate::manifest::Bounds;

const BYTE_CEILING: f64 = 254.0; // as cover and the scenic bytes: keeps the client's max attr < 1
// One sample per metre of sidewalk. A crown is metres across and the canopy outline is traced from a
// 1 ft raster, so this resolves a single street tree; even the shortest edges — a crossing runs ~15 m
// — still land a dozen samples.
const SAMPLE_STEP_METERS: f64 = 1.0;

pub struct DirectCanopy {
    pub bytes: Vec<u8>,
    pub polygons: usize, // the canopy polygons the sampler read
    pub mean: f64,       // the mean covered fraction over the edges, for the build log
    pub max_byte: u8,
}

/// The covered fraction of one edge: its polyline walked at `SAMPLE_STEP_METERS` by arc length, each
/// sample tested against the canopy indicator, and the covered share returned. The candidates are
/// gathered once for the whole polyline — an edge is a block long and the grid's cells are wider —
/// so the per-sample work is a box test against a few dozen crowns. A ferry carries no polyline and
/// reads 0.
fn covered_fraction(
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

    // Midpoints of `samples` equal sub-lengths, so the estimate is the arc-length integral of the
    // indicator and every metre of the edge weighs the same. The targets rise, so the segment cursor
    // never walks back.
    let samples = (total / SAMPLE_STEP_METERS).ceil().max(1.0) as usize;
    let step = total / samples as f64;
    let mut covered = 0usize;
    let mut segment = 0usize;
    let mut behind = 0.0; // metres of the segments before `segment`
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

/// The direct-canopy byte of every edge, in the graph's edge order. `reference_lat` is the graph
/// origin's latitude, the one east-west scale the whole city is measured at, as the estimator uses.
/// The polygons are dropped before the return, so the optional shade bake that reads the same file
/// afterwards does not pay for two copies at once.
pub fn direct_canopy(
    edge_polys: &[Vec<Coord>],
    canopy: &Path,
    reference_lat: f64,
) -> Fallible<DirectCanopy> {
    let polygons = binfmt::read_polygons(canopy, "CNPY", binfmt::CANOPY_FORMAT)?;
    let count = polygons.len();
    let set = flatten(&polygons);
    drop(polygons);
    let grid = PolygonGrid::new(&set);
    let meters_per_degree_lng = METERS_PER_DEGREE_LAT * reference_lat.to_radians().cos();

    let fractions: Vec<f64> = edge_polys
        .par_iter()
        .map_init(Vec::new, |candidates, poly| {
            covered_fraction(poly, &set, &grid, meters_per_degree_lng, candidates)
        })
        .collect();

    let mut bytes = vec![0u8; fractions.len()];
    let mut max_byte = 0u8;
    for (byte, fraction) in bytes.iter_mut().zip(&fractions) {
        *byte = round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
    }
    let mean = if fractions.is_empty() {
        0.0
    } else {
        fractions.iter().sum::<f64>() / fractions.len() as f64
    };
    Ok(DirectCanopy {
        bytes,
        polygons: count,
        mean,
        max_byte,
    })
}
