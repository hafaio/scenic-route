//! How hilly each edge is: the two per-edge relief bytes the hill weight and the walking speed read.
//!
//! **Split, not signed.** Height GAINED and height LOST are accumulated separately, both walking the
//! polyline in its stored a->b direction; reversing an edge swaps them. Neither is the difference
//! between the two ends, which is the whole point: a block that climbs 10 m and comes back down is
//! flat end to end and is real work, and it reads 10 m of each.
//!
//! Their sum is what the hill penalty steers by — absolute, so a route that avoids a hill avoids it
//! in both directions — while the walking-speed model needs them apart, because a descent is walked
//! faster than a climb of the same grade.
//!
//! Each is a fraction of the same reference grade, so the two together can reach 70% of grade on an
//! edge that crests and drops where the old single byte clamped the pair at 35%.

use crate::Fallible;
use crate::binfmt::Coord;
use crate::dem::Field;

/// The grade the byte's full range spans. Chosen to clear the steepest street anyone walks — San
/// Francisco's worst blocks run to about 31.5% — so that NOTHING saturates and a 30% block is still
/// told apart from a 12% one. It used to stop at 12%, which made every serious hill in the city
/// identical to the router and to the walking-speed model, both of which care a great deal about the
/// difference. One step is 0.14% of grade, far finer than a grade means anything to.
const REFERENCE_GRADE: f64 = 0.35;

const MAX_BYTE: f64 = 254.0;

/// The shortest run a grade is taken over. A kerb link a metre long that happens to span three
/// metres of ground is not a 300% street, it is too short for a grade to mean anything — and left
/// alone it maxes the byte and makes the reported steepest nonsense. San Francisco's real steepest
/// blocks run to 31%, which this leaves untouched.
const MIN_GRADE_METERS: f64 = 10.0;

pub struct Relief {
    pub ascent: Vec<u8>,
    pub descent: Vec<u8>,
    pub measured: usize,
    pub mean_grade: f64,
    pub max_grade: f64,
}

/// The height climbed and the height dropped along one polyline walked a->b, or None where the field
/// had fewer than two readings for it — off the DEM, or over water. Such an edge keeps the pair of
/// zeros a flat one has, which is the right conflation for a penalty: both mean "nothing here to
/// avoid".
fn climb_of(polyline: &[Coord], field: &Field) -> Option<(f64, f64)> {
    if polyline.len() < 2 {
        return None;
    }
    let mut climbed = 0.0;
    let mut dropped = 0.0;
    let mut previous: Option<f32> = None;
    let mut samples = 0usize;
    for point in polyline {
        let height = field.sample(point.lng, point.lat);
        if !height.is_finite() {
            // A gap in the ground breaks the chain rather than being bridged: the height across it
            // is unknown, and treating the far side as the near side's neighbour would invent a
            // cliff at every shoreline.
            previous = None;
            continue;
        }
        if let Some(last) = previous {
            let step = f64::from(height - last);
            if step >= 0.0 {
                climbed += step;
            } else {
                dropped -= step;
            }
        }
        previous = Some(height);
        samples += 1;
    }
    if samples < 2 {
        None
    } else {
        Some((climbed, dropped))
    }
}

/// The ascent and descent bytes for every edge, given each edge's polyline in degrees and its length
/// in metres. `mean_grade` and `max_grade` are over their SUM, the figure the hill penalty reads.
pub fn relief(polylines: &[Vec<Coord>], lengths: &[f32], field: &Field) -> Fallible<Relief> {
    let mut ascent = vec![0u8; polylines.len()];
    let mut descent = vec![0u8; polylines.len()];
    let mut measured = 0usize;
    let mut grade_sum = 0.0;
    let mut max_grade = 0.0_f64;
    let to_byte = |grade: f64| ((grade / REFERENCE_GRADE).clamp(0.0, 1.0) * MAX_BYTE).round() as u8;
    for (edge, polyline) in polylines.iter().enumerate() {
        let Some((climbed, dropped)) = climb_of(polyline, field) else {
            continue;
        };
        let length = f64::from(lengths[edge]).max(MIN_GRADE_METERS);
        let grade = (climbed + dropped) / length;
        measured += 1;
        grade_sum += grade;
        max_grade = max_grade.max(grade);
        // Each byte is clamped on its own, so an edge that crests and drops can carry 35% of climb
        // AND 35% of drop where the single byte the two replace pinned the pair at 35% together.
        ascent[edge] = to_byte(climbed / length);
        descent[edge] = to_byte(dropped / length);
    }
    Ok(Relief {
        ascent,
        descent,
        measured,
        mean_grade: if measured > 0 {
            grade_sum / measured as f64
        } else {
            0.0
        },
        max_grade,
    })
}

#[cfg(test)]
mod tests {
    use super::{REFERENCE_GRADE, relief};
    use crate::binfmt::Coord;
    use crate::dem::Field;

    /// A one-degree-wide field of four cells running west to east at the given heights.
    fn ramp(heights: [f32; 4]) -> Field {
        Field::from_grid(0.0, 1.0, 1.0, 1.0, 4, 1, heights.to_vec())
    }

    /// An edge far shorter than a cell must climb far less than a cell's height step. Nearest-cell
    /// sampling handed it the whole step and saturated it — 6,396 San Francisco edges, the shortest
    /// 0.9 m long — which is the terrain's slope charged as the edge's own.
    #[test]
    fn a_short_edge_climbs_in_proportion_to_its_length() {
        // Two cells ten metres apart in height, and an edge crossing a tenth of the gap between them.
        let field = ramp([0.0, 10.0, 20.0, 30.0]);
        let short = vec![Coord { lng: 1.5, lat: 0.5 }, Coord { lng: 1.6, lat: 0.5 }];
        let baked = relief(&[short], &[100.0], &field).unwrap();
        assert!(
            baked.ascent[0] < 40,
            "a tenth-of-a-cell edge read {} of 254; nearest-cell sampling would saturate it",
            baked.ascent[0]
        );
    }

    fn along(count: usize) -> Vec<Coord> {
        (0..count)
            .map(|step| Coord {
                lng: step as f64 + 0.5,
                lat: 0.5,
            })
            .collect()
    }

    /// A block that climbs 10 m and comes back down is flat between its ends and is real work, which
    /// is the whole reason the height is summed along the polyline rather than differenced. Split in
    /// two, it reads 10% of climb and 10% of drop over its 100 m.
    #[test]
    fn a_crest_is_not_flat() {
        let field = ramp([0.0, 10.0, 0.0, 0.0]);
        let baked = relief(&[along(3)], &[100.0], &field).unwrap();
        let tenth = ((0.1 / REFERENCE_GRADE) * 254.0).round() as u8;
        assert_eq!(baked.ascent[0], tenth);
        assert_eq!(baked.descent[0], tenth);
        assert!((baked.max_grade - 0.2).abs() < 1e-6);
    }

    /// Reversing the polyline swaps the two bytes and leaves their sum — what the hill penalty reads
    /// — alone, because a route that avoids a hill has to avoid it in both directions.
    #[test]
    fn reversing_swaps_ascent_and_descent() {
        let field = ramp([0.0, 3.0, 6.0, 9.0]);
        let forward = along(4);
        let backward: Vec<Coord> = forward.iter().rev().copied().collect();
        let baked = relief(&[forward, backward], &[400.0, 400.0], &field).unwrap();
        assert!(baked.ascent[0] > 0);
        assert_eq!(baked.descent[0], 0);
        assert_eq!(baked.descent[1], baked.ascent[0]);
        assert_eq!(baked.ascent[1], baked.descent[0]);
    }

    /// A gap in the ground breaks the chain rather than being bridged, so a shoreline does not read
    /// as a cliff between the last cell before it and the first cell after.
    #[test]
    fn a_gap_does_not_invent_a_cliff() {
        let field = ramp([0.0, f32::NAN, 0.0, 50.0]);
        let baked = relief(&[along(3)], &[100.0], &field).unwrap();
        assert_eq!(baked.ascent[0], 0, "the two 0 m readings are level");
        assert_eq!(baked.descent[0], 0);
    }

    /// Each byte saturates on its own at the reference grade, so a crest steeper than it in both
    /// halves reads 35% of climb AND 35% of drop — 70% of grade in total, which the one byte these
    /// replace could not express.
    #[test]
    fn each_byte_saturates_at_the_reference_grade() {
        let field = ramp([0.0, 6.0, 0.0, 0.0]);
        let climbed = 6.0;
        let length = climbed / REFERENCE_GRADE;
        let baked = relief(&[along(3)], &[length as f32], &field).unwrap();
        assert_eq!(baked.ascent[0], 254);
        assert_eq!(baked.descent[0], 254);
        assert!((baked.max_grade - 2.0 * REFERENCE_GRADE).abs() < 1e-6);

        let baked = relief(&[along(3)], &[(2.0 * length) as f32], &field).unwrap();
        assert_eq!(
            baked.ascent[0], 127,
            "half the reference grade is half the byte"
        );
    }
}
