//! How hilly each edge is: the per-edge relief byte the hill-avoidance weight reads.
//!
//! **Absolute, not signed.** What is stored is the total height a walker gains or loses along the
//! edge, added up without regard to which way they are going — so it costs the same in both
//! directions and the same whether a block climbs, drops, or crests in the middle. That last case is
//! the reason it is a sum along the polyline rather than the difference between the two ends: a
//! block that goes up and comes back down is flat end to end and is real work.
//!
//! A signed version — ascent in the direction of travel, so downhill is free — is a strictly bigger
//! change: it makes the attribute direction-dependent and interacts with the A* heuristic's speed
//! bound. This one answers "keep me off the hills" and nothing more.

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
    pub bytes: Vec<u8>,
    pub measured: usize,
    pub mean_grade: f64,
    pub max_grade: f64,
}

/// The height climbed and dropped along one polyline, or None where the field had fewer than two
/// readings for it — off the DEM, or over water. Such an edge keeps the 0 a flat one has, which is
/// the right conflation for a penalty: both mean "nothing here to avoid".
fn climb_of(polyline: &[Coord], field: &Field) -> Option<f64> {
    if polyline.len() < 2 {
        return None;
    }
    let mut climbed = 0.0;
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
            climbed += f64::from((height - last).abs());
        }
        previous = Some(height);
        samples += 1;
    }
    if samples < 2 { None } else { Some(climbed) }
}

/// The relief byte for every edge, given each edge's polyline in degrees and its length in metres.
pub fn relief(polylines: &[Vec<Coord>], lengths: &[f32], field: &Field) -> Fallible<Relief> {
    let mut bytes = vec![0u8; polylines.len()];
    let mut measured = 0usize;
    let mut grade_sum = 0.0;
    let mut max_grade = 0.0_f64;
    for (edge, polyline) in polylines.iter().enumerate() {
        let Some(climbed) = climb_of(polyline, field) else {
            continue;
        };
        let length = f64::from(lengths[edge]).max(MIN_GRADE_METERS);
        let grade = climbed / length;
        measured += 1;
        grade_sum += grade;
        max_grade = max_grade.max(grade);
        bytes[edge] = ((grade / REFERENCE_GRADE).clamp(0.0, 1.0) * MAX_BYTE).round() as u8;
    }
    Ok(Relief {
        bytes,
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
            baked.bytes[0] < 40,
            "a tenth-of-a-cell edge read {} of 254; nearest-cell sampling would saturate it",
            baked.bytes[0]
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
    /// is the whole reason the height is summed along the polyline rather than differenced.
    #[test]
    fn a_crest_is_not_flat() {
        let field = ramp([0.0, 10.0, 0.0, 0.0]);
        let baked = relief(&[along(3)], &[100.0], &field).unwrap();
        // 20 m climbed over 100 m is a 20% grade, well past flat and well short of the 35% the byte
        // spans — the point being that it lands somewhere in between rather than pinned at either end.
        assert_eq!(
            baked.bytes[0],
            ((0.2 / REFERENCE_GRADE) * 254.0).round() as u8
        );
        assert!(baked.bytes[0] > 0 && baked.bytes[0] < 254);
        assert!((baked.max_grade - 0.2).abs() < 1e-6);
    }

    /// Reversing the polyline reverses nothing: the attribute is absolute by construction, and a
    /// route that avoids a hill has to avoid it in both directions.
    #[test]
    fn it_reads_the_same_in_either_direction() {
        let field = ramp([0.0, 3.0, 6.0, 9.0]);
        let forward = along(4);
        let backward: Vec<Coord> = forward.iter().rev().copied().collect();
        let baked = relief(&[forward, backward], &[400.0, 400.0], &field).unwrap();
        assert_eq!(baked.bytes[0], baked.bytes[1]);
    }

    /// A gap in the ground breaks the chain rather than being bridged, so a shoreline does not read
    /// as a cliff between the last cell before it and the first cell after.
    #[test]
    fn a_gap_does_not_invent_a_cliff() {
        let field = ramp([0.0, f32::NAN, 0.0, 50.0]);
        let baked = relief(&[along(3)], &[100.0], &field).unwrap();
        assert_eq!(baked.bytes[0], 0, "the two 0 m readings are level");
    }

    /// The byte saturates exactly at the reference grade, so the slider's full strength means
    /// "avoid anything this steep or steeper" and grades everything below it.
    #[test]
    fn the_reference_grade_is_where_it_saturates() {
        let field = ramp([0.0, 6.0, 0.0, 0.0]);
        let climbed = 12.0;
        let length = climbed / REFERENCE_GRADE;
        let baked = relief(&[along(3)], &[length as f32], &field).unwrap();
        assert_eq!(baked.bytes[0], 254);

        let baked = relief(&[along(3)], &[(2.0 * length) as f32], &field).unwrap();
        assert_eq!(
            baked.bytes[0], 127,
            "half the reference grade is half the byte"
        );
    }
}
