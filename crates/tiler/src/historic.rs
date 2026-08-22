//! The per-edge historic-district byte (GRPH v10, record byte 37): how much of a walk runs inside a
//! designated historic district.
//!
//! The source (HDST) is a city's designating body's district BOUNDARIES — New York's Landmarks
//! Preservation Commission, San Francisco's Planning Department — which are area outlines drawn
//! around whole neighbourhoods, street beds included, so a walker on an interior sidewalk is
//! simply inside one,
//! and the byte is the length-fraction of the edge that is: the underfoot containment integral of
//! `geometry::contained_fraction`, the same shape the direct-canopy byte is measured with.
//!
//! Deliberately NOT industrial's sideways probes, though both read polygons. Industrial probes
//! sideways because a walker is never *in* a tax lot — what it measures is what stands beside the
//! walk. A district covers the walk itself, so probing would report the same thing on every interior
//! street and would smear the discount one street-width past a boundary the designation drew where
//! it did on purpose. Deliberately not the landmark fan-out either: a district is not a point with a
//! decaying influence, it has a hard edge, and containment honours it exactly.
//!
//! A bridge or tunnel deck counts here where it does not for industrial, and for the reason that
//! exemption exists: a rail yard passes UNDER a viaduct, where a viaduct through a district is still
//! amid its fabric.

use std::path::Path;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, Coord};
use crate::geometry::{METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet, flatten, round_half_up};
use crate::sampling::contained_fraction;

/// Kept here rather than beside the other format constants in binfmt.rs, which is where it
/// belongs by convention: the shade pass names binfmt.rs in its own code scope, so a constant
/// added there re-renders the whole twenty-minute pyramid for a format shade never reads.
const HISTORIC_FORMAT: u16 = 1;

const BYTE_CEILING: f64 = 254.0; // as the cover, scenic and direct-canopy bytes

pub struct Historic {
    pub bytes: Vec<u8>,
    pub polygons: usize, // the district parts the sampler read
    pub inside: usize,   // edges reading anything at all, for the build log
    pub mean: f64,       // the mean inside fraction over the edges
    pub max_byte: u8,
}

/// Every edge's inside fraction, in the graph's edge order.
fn fractions(
    edge_polys: &[Vec<Coord>],
    set: &PolygonSet,
    grid: &PolygonGrid,
    meters_per_degree_lng: f64,
) -> Vec<f64> {
    edge_polys
        .par_iter()
        .map_init(Vec::new, |candidates, poly| {
            contained_fraction(poly, set, grid, meters_per_degree_lng, candidates)
        })
        .collect()
}

/// The historic-district byte of every edge. `reference_lat` is the graph origin's latitude, the one
/// east-west scale the whole city is measured at, as the other per-edge bakes use.
pub fn historic(
    edge_polys: &[Vec<Coord>],
    districts: &Path,
    reference_lat: f64,
) -> Fallible<Historic> {
    let polygons = binfmt::read_polygons(districts, "HDST", HISTORIC_FORMAT)?;
    let count = polygons.len();
    let set = flatten(&polygons);
    drop(polygons);
    let grid = PolygonGrid::new(&set);
    let meters_per_degree_lng = METERS_PER_DEGREE_LAT * reference_lat.to_radians().cos();

    let fractions = fractions(edge_polys, &set, &grid, meters_per_degree_lng);
    let mut bytes = vec![0u8; fractions.len()];
    let mut max_byte = 0u8;
    let mut inside = 0usize;
    for (byte, fraction) in bytes.iter_mut().zip(&fractions) {
        *byte = round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
        inside += usize::from(*byte > 0);
    }
    let mean = if fractions.is_empty() {
        0.0
    } else {
        fractions.iter().sum::<f64>() / fractions.len() as f64
    };
    Ok(Historic {
        bytes,
        polygons: count,
        inside,
        mean,
        max_byte,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binfmt::Polygon;

    const LAT: f64 = 40.7;

    /// A point `east_meters` east and `north_meters` north of a reference in the middle of New
    /// York, so the tests read in metres and still exercise the cos(lat) scaling of the real bake.
    fn at(east_meters: f64, north_meters: f64) -> Coord {
        Coord {
            lng: -74.0 + east_meters / meters_per_degree_lng(),
            lat: LAT + north_meters / METERS_PER_DEGREE_LAT,
        }
    }

    fn meters_per_degree_lng() -> f64 {
        METERS_PER_DEGREE_LAT * LAT.to_radians().cos()
    }

    /// An axis-aligned ring in metres, corners `(west, south)` to `(east, north)`.
    fn rectangle(west: f64, south: f64, east: f64, north: f64) -> Vec<Coord> {
        vec![
            at(west, south),
            at(east, south),
            at(east, north),
            at(west, north),
        ]
    }

    fn fraction_of(poly: &[Coord], districts: &[Polygon]) -> f64 {
        let set = flatten(districts);
        let grid = PolygonGrid::new(&set);
        fractions(&[poly.to_vec()], &set, &grid, meters_per_degree_lng())[0]
    }

    /// The fraction of a 100 m east-west walk along the reference latitude that runs inside
    /// `districts`.
    fn walk_fraction(districts: &[Polygon]) -> f64 {
        fraction_of(&[at(0.0, 0.0), at(100.0, 0.0)], districts)
    }

    fn byte_of(fraction: f64) -> u8 {
        round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8
    }

    /// The whole reason the boundaries can be read underfoot: a district outline includes the street
    /// beds it encloses, so an interior sidewalk is inside it for its whole length.
    #[test]
    fn a_walk_down_an_interior_street_is_inside_for_its_whole_length() {
        let fraction = walk_fraction(&[vec![rectangle(-50.0, -50.0, 150.0, 50.0)]]);

        assert_eq!(fraction, 1.0);
        assert_eq!(byte_of(fraction), 254); // never 255: the client's maxHistoric must stay < 1
    }

    /// The hard edge is the point. Industrial's probes reach 27 m to either side; a district's
    /// discount stops at the boundary, so the block across the street from one reads nothing.
    #[test]
    fn a_walk_beside_a_district_is_not_in_it() {
        assert_eq!(
            walk_fraction(&[vec![rectangle(-50.0, 10.0, 150.0, 200.0)]]),
            0.0
        );
    }

    /// A boundary that crosses a block prices the share of the walk inside it and no more.
    #[test]
    fn a_walk_that_leaves_a_district_is_priced_by_the_share_inside() {
        let fraction = walk_fraction(&[vec![rectangle(-50.0, -50.0, 40.0, 50.0)]]);

        assert!(
            (fraction - 0.4).abs() < 0.01,
            "40 m of a 100 m walk reads {fraction}"
        );
        // 0.4 of 255 is 102, but the fixture's walk is a hair over 100 m once its degrees are
        // metres, so it takes 101 samples rather than 100 and the share lands one step under. The
        // byte follows the share the sampler measured, not the round number the fixture meant.
        assert!(
            matches!(byte_of(fraction), 101 | 102),
            "{fraction} reads {}",
            byte_of(fraction)
        );
    }

    /// Districts nest: four of New York's sit inside larger ones (Carnegie Hill in Expanded Carnegie
    /// Hill, and so on). `contains_point` ORs its candidates, so an overlap reads as the union it is
    /// rather than cancelling to a hole — which is why no city's parts need a dissolve before the
    /// bake.
    #[test]
    fn a_district_inside_another_reads_as_the_union_of_the_two() {
        let enclosing = vec![rectangle(-50.0, -50.0, 150.0, 50.0)];
        let enclosed = vec![rectangle(0.0, -10.0, 50.0, 10.0)];

        assert_eq!(walk_fraction(&[enclosing, enclosed]), 1.0);
    }

    #[test]
    fn a_walk_nowhere_near_a_district_reads_nothing() {
        assert_eq!(
            walk_fraction(&[vec![rectangle(1000.0, 1000.0, 1100.0, 1100.0)]]),
            0.0
        );
    }

    /// A ferry carries no polyline, and must not lift the graph-wide max the A* floor is taken from.
    #[test]
    fn an_edge_with_no_polyline_reads_nothing() {
        assert_eq!(
            fraction_of(&[], &[vec![rectangle(-50.0, -50.0, 150.0, 50.0)]]),
            0.0
        );
    }
}
