//! Where the sidewalks are, and which way the street runs there. Nobody walks down the middle
//! of the road, so the field is sampled twice per vertex, once either side of the centreline —
//! and no usable sidewalk dataset exists to sample it on. See scripts/README.md.

use crate::kde::Bearing;

const METERS_PER_FOOT: f64 = 0.3048;
const MEDIAN_WIDTH_FEET: f64 = 30.0; // what the 2% of streets carrying no width fall back to
const STREET: u8 = 1;
const ALLEY: u8 = 10;
// The chunk carries the offset in a byte of decimetres, so a wider roadway than this could not
// be drawn where it was sampled. Four CSCL segments in the city claim one.
const MAX_OFFSET_METERS: f64 = 25.5;

/// Half the roadway plus the curb-to-sidewalk inset: where the two sidewalk lines sit, in metres
/// either side of the centreline. Zero for the road types that *are* the walking surface — a
/// boardwalk, a path, a step street — which carry no width and are sampled once, on the line
/// itself.
pub fn half_offset_meters(road_type: u8, width_feet: u8, inset_meters: f64) -> f64 {
    if road_type == STREET || road_type == ALLEY {
        let feet = if width_feet == 0 {
            MEDIAN_WIDTH_FEET
        } else {
            f64::from(width_feet)
        };
        (feet * METERS_PER_FOOT / 2.0 + inset_meters).min(MAX_OFFSET_METERS)
    } else {
        0.0
    }
}

/// The unit tangent at every vertex of one segment, in metre space: the central difference of
/// its neighbours, one-sided at the ends. The geometry is densified to 25 m, so a plain
/// difference is a good local tangent — but CSCL's own vertices can sit closer together than the
/// 0.1 m the coordinates are quantized to, and a neighbour that collapses onto this vertex would
/// leave the kernel with no direction at all. So the difference is taken over the nearest
/// *distinct* vertices on either side.
pub fn bearings(xs: &[f64], ys: &[f64]) -> Vec<Bearing> {
    let same = |left: usize, right: usize| xs[left] == xs[right] && ys[left] == ys[right];
    (0..xs.len())
        .map(|vertex| {
            let mut back = vertex;
            while back > 0 && same(back, vertex) {
                back -= 1;
            }
            let mut ahead = vertex;
            while ahead + 1 < xs.len() && same(ahead, vertex) {
                ahead += 1;
            }
            let delta_x = xs[ahead] - xs[back];
            let delta_y = ys[ahead] - ys[back];
            let length = delta_x.hypot(delta_y);
            // No distinct neighbour to point at: the whole segment has collapsed onto one
            // quantized point. The ingest drops anything shorter than a metre, so this is
            // unreachable; it is here so a degenerate file cannot put a NaN in the field.
            if length > 0.0 {
                Bearing {
                    along_x: delta_x / length,
                    along_y: delta_y / length,
                }
            } else {
                Bearing {
                    along_x: 1.0,
                    along_y: 0.0,
                }
            }
        })
        .collect()
}

/// The unit normal pointing at the *left* sidewalk: 90 degrees counter-clockwise of the
/// direction of travel, in a metre space whose y runs north. Left and right follow the
/// digitization direction, which is CSCL's own `l_`/`r_` convention.
pub fn left_normal(bearing: Bearing) -> (f64, f64) {
    (-bearing.along_y, bearing.along_x)
}
