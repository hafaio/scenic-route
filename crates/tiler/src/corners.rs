//! The corner fan at one graph node: given the street- and path-ends leaving it, where the corner
//! nodes sit and which corner each departing end binds to. `tiler graph` turns every street into a
//! sidewalk on each side, the two sides meet at these corners, a crossing links the two corners
//! flanking a street, and a path links to the corner whose angular gap it departs into. The caller
//! passes the street-ends already in counter-clockwise order (street-ends first, then path-ends),
//! and reads the corners back per slot. See scripts/README.md.

use std::f64::consts::TAU;

use crate::geometry::round_half_up;

const RADIUS_MIN_METERS: f64 = 1.0;
const RADIUS_MAX_METERS: f64 = 30.0;
// A near-straight joint (gap ~= pi) would otherwise fire a corner far up the bisector; this floor
// caps the miter so a sliver gap cannot throw a corner into the next block.
const SINE_FLOOR: f64 = 0.25;

/// One end of a base edge as it leaves a node: which edge, whether this is its `a` end, the
/// departure bearing in the local metre frame (`atan2(north, east)`), and whether the edge is a
/// path surface rather than a street with sidewalks.
pub struct EdgeEnd {
    pub edge: u32,
    pub at_a: bool,
    pub bearing: f64,
    pub pathlike: bool,
}

/// The corners of one node and the binding from each end to them. `corner_x`/`corner_y` hold the
/// `s` corner coordinates in the counter-clockwise gap order the street-ends arrived in — corner
/// `k` fills the gap after street-end `k`. `corner_left`/`corner_right` are indexed per street-end
/// slot and give that street its counter-clockwise (left) and clockwise (right) corner;
/// `path_corner` is indexed per path-end slot and gives the containing corner.
pub struct CornerFan {
    pub corner_x: Vec<i32>,
    pub corner_y: Vec<i32>,
    pub corner_left: Vec<u32>,
    pub corner_right: Vec<u32>,
    pub path_corner: Vec<u32>,
}

fn norm_tau(angle: f64) -> f64 {
    let wrapped = angle % TAU;
    if wrapped < 0.0 {
        wrapped + TAU
    } else {
        wrapped
    }
}

/// The gap of `s` street-ends whose counter-clockwise arc contains `bearing`; a bearing exactly on
/// a street-end falls into the gap that starts there.
fn containing_gap(street_bearings: &[f64], bearing: f64) -> u32 {
    let count = street_bearings.len();
    if count == 1 {
        return 0;
    }
    let base = street_bearings[0];
    let relative = norm_tau(bearing - base);
    for slot in 0..count {
        let start = norm_tau(street_bearings[slot] - base);
        let raw = street_bearings[(slot + 1) % count] - street_bearings[slot];
        let gap = if raw <= 0.0 { raw + TAU } else { raw };
        if relative >= start && relative < start + gap {
            return slot as u32;
        }
        // The wrap gap (last to first) starts near TAU and its arc continues past 0.
        if start + gap >= TAU && relative < start + gap - TAU {
            return slot as u32;
        }
    }
    (count - 1) as u32
}

/// `ends` lists every end at the node with the street-ends first, already sorted counter-clockwise
/// by bearing, then the path-ends in any order; `half_offsets_m` is parallel (the sidewalk
/// half-offset of each street-end, ignored for path-ends). Corners are placed on the bisector of
/// each street gap, a half-offset out, with the miter capped by the sine floor and the radius
/// clamped to [1, 30] m.
pub fn build_fan(
    node_x: i32,
    node_y: i32,
    ends: &[EdgeEnd],
    half_offsets_m: &[f64],
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> CornerFan {
    let street_count = ends.iter().filter(|end| !end.pathlike).count();
    let street_bearings: Vec<f64> = ends[..street_count].iter().map(|end| end.bearing).collect();

    let mut corner_x = Vec::with_capacity(street_count);
    let mut corner_y = Vec::with_capacity(street_count);
    for slot in 0..street_count {
        let next = (slot + 1) % street_count;
        let gap = if street_count == 1 {
            TAU
        } else {
            let raw = street_bearings[next] - street_bearings[slot];
            if raw <= 0.0 { raw + TAU } else { raw }
        };
        let bisector = street_bearings[slot] + gap / 2.0;
        let half = (half_offsets_m[slot] + half_offsets_m[next]) / 2.0;
        let radius =
            (half / (gap / 2.0).sin().max(SINE_FLOOR)).clamp(RADIUS_MIN_METERS, RADIUS_MAX_METERS);
        let east = radius * bisector.cos();
        let north = radius * bisector.sin();
        corner_x.push(node_x + round_half_up(east / meters_per_unit_lng) as i32);
        corner_y.push(node_y + round_half_up(north / meters_per_unit_lat) as i32);
    }

    let mut corner_left = Vec::with_capacity(street_count);
    let mut corner_right = Vec::with_capacity(street_count);
    for slot in 0..street_count {
        corner_left.push(slot as u32);
        corner_right.push(((slot + street_count - 1) % street_count) as u32);
    }
    let path_corner: Vec<u32> = ends[street_count..]
        .iter()
        .map(|end| {
            if street_count == 0 {
                u32::MAX
            } else {
                containing_gap(&street_bearings, end.bearing)
            }
        })
        .collect();

    CornerFan {
        corner_x,
        corner_y,
        corner_left,
        corner_right,
        path_corner,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::{FRAC_PI_2, PI};

    // A metre frame close to New York's, so the tests exercise the real conversion path.
    const MPU_LNG: f64 = 0.0843;
    const MPU_LAT: f64 = 0.1113;

    fn street(edge: u32, bearing: f64) -> EdgeEnd {
        EdgeEnd {
            edge,
            at_a: true,
            bearing,
            pathlike: false,
        }
    }

    fn path(edge: u32, bearing: f64) -> EdgeEnd {
        EdgeEnd {
            edge,
            at_a: true,
            bearing,
            pathlike: true,
        }
    }

    // A corner is placed roughly on the bisector of its gap, so its bearing from the node should
    // land inside that gap's arc.
    fn corner_bearing(fan: &CornerFan, slot: usize) -> f64 {
        let east = f64::from(fan.corner_x[slot]) * MPU_LNG;
        let north = f64::from(fan.corner_y[slot]) * MPU_LAT;
        north.atan2(east)
    }

    #[test]
    fn four_way_has_four_corners_flanking_each_leg() {
        // Legs E, N, W, S in counter-clockwise order.
        let ends = [
            street(0, 0.0),
            street(1, FRAC_PI_2),
            street(2, PI),
            street(3, -FRAC_PI_2),
        ];
        let offsets = [5.0, 5.0, 5.0, 5.0];
        let fan = build_fan(0, 0, &ends, &offsets, MPU_LNG, MPU_LAT);
        assert_eq!(fan.corner_x.len(), 4);
        assert_eq!(fan.corner_left, vec![0, 1, 2, 3]);
        assert_eq!(fan.corner_right, vec![3, 0, 1, 2]);
        // The E leg (slot 0) is flanked by corner 0 (NE, its left) and corner 3 (SE, its right).
        let north_east = corner_bearing(&fan, 0);
        assert!(
            north_east > 0.0 && north_east < FRAC_PI_2,
            "NE corner in the E-N gap"
        );
    }

    #[test]
    fn t_intersection_has_three_corners_and_a_through_corner() {
        // Through street E-W plus a south stem: legs E, W, S counter-clockwise.
        let ends = [street(0, 0.0), street(1, PI), street(2, -FRAC_PI_2)];
        let offsets = [5.0, 5.0, 5.0];
        let fan = build_fan(0, 0, &ends, &offsets, MPU_LNG, MPU_LAT);
        assert_eq!(fan.corner_x.len(), 3);
        // The gap between E (slot 0) and W (slot 1) is the whole north side: one through corner.
        let through = corner_bearing(&fan, 0);
        assert!(through > 0.0 && through < PI, "the north through corner");
        assert_eq!(fan.corner_left, vec![0, 1, 2]);
        assert_eq!(fan.corner_right, vec![2, 0, 1]);
    }

    #[test]
    fn dead_end_wraps_to_a_single_corner() {
        let ends = [street(0, 0.0)];
        let offsets = [5.0];
        let fan = build_fan(0, 0, &ends, &offsets, MPU_LNG, MPU_LAT);
        assert_eq!(fan.corner_x.len(), 1);
        // Both sides of the one street bind to the single wrap corner.
        assert_eq!(fan.corner_left, vec![0]);
        assert_eq!(fan.corner_right, vec![0]);
    }

    #[test]
    fn five_way_with_a_path_binds_the_path_to_its_gap() {
        // Five streets roughly at 0, 72, 144, 216, 288 degrees, plus a path at ~36 degrees which
        // sits in the gap after street 0.
        let step = TAU / 5.0;
        let ends = [
            street(0, 0.0),
            street(1, step),
            street(2, 2.0 * step),
            street(3, 3.0 * step),
            street(4, 4.0 * step),
            path(5, step / 2.0),
        ];
        let offsets = [5.0, 5.0, 5.0, 5.0, 5.0, 0.0];
        let fan = build_fan(0, 0, &ends, &offsets, MPU_LNG, MPU_LAT);
        assert_eq!(fan.corner_x.len(), 5);
        assert_eq!(fan.path_corner, vec![0]);
    }

    #[test]
    fn path_in_the_wrap_gap_of_a_dead_end_binds_to_the_only_corner() {
        let ends = [street(0, 0.0), path(1, PI)];
        let offsets = [5.0, 0.0];
        let fan = build_fan(0, 0, &ends, &offsets, MPU_LNG, MPU_LAT);
        assert_eq!(fan.path_corner, vec![0]);
    }
}
