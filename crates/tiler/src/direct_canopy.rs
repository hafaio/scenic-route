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
use crate::geometry::{METERS_PER_DEGREE_LAT, PolygonGrid, flatten, round_half_up};
use crate::sampling::contained_fraction;

const BYTE_CEILING: f64 = 254.0; // as cover and the scenic bytes: keeps the client's max attr < 1

pub struct DirectCanopy {
    pub bytes: Vec<u8>,
    pub polygons: usize, // the canopy polygons the sampler read
    pub mean: f64,       // the mean covered fraction over the edges, for the build log
    pub max_byte: u8,
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
            contained_fraction(poly, &set, &grid, meters_per_degree_lng, candidates)
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
