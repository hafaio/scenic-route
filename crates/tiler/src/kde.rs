//! Projection and reach helpers shared by the tile pyramids and the density sampler: a local
//! metre space for one city, the bounds its blurred field can reach, and a street's bearing.
//! (Slated to fold into geometry.rs, where the rest of the coordinate math lives.)

use crate::manifest::Bounds;

pub const METERS_PER_DEGREE_LAT: f64 = 111_320.0;
pub const KERNEL_RADII: f64 = 3.0; // where the blur is truncated, in sigmas; matches geometry::BLUR_RADII

/// A local metre space with the city bbox centre as its origin. One reference latitude for the
/// whole city: over NYC's 0.42 degrees of span that costs about 0.7% in the east-west scale,
/// which is well inside the noise of the blur. Only cos(lat0) actually reaches the field — the
/// origin cancels out of every distance — so two callers agree as long as they agree on the
/// bounds.
#[derive(Clone, Copy)]
pub struct Projection {
    lng0: f64,
    lat0: f64,
    meters_per_degree_lng: f64,
}

impl Projection {
    pub fn new(bounds: &Bounds) -> Self {
        let lat0 = (bounds.south + bounds.north) / 2.0;
        Self {
            lng0: (bounds.west + bounds.east) / 2.0,
            lat0,
            meters_per_degree_lng: METERS_PER_DEGREE_LAT
                * (lat0 * std::f64::consts::PI / 180.0).cos(),
        }
    }

    pub fn x(&self, lng: f64) -> f64 {
        (lng - self.lng0) * self.meters_per_degree_lng
    }

    pub fn y(&self, lat: f64) -> f64 {
        (lat - self.lat0) * METERS_PER_DEGREE_LAT
    }

    /// The inverses of `x` and `y`: a metre-space offset from the origin back to a coordinate, so
    /// a sidewalk placed in metre space can be handed to the lng/lat blurred-cover sampler.
    pub fn lng(&self, x: f64) -> f64 {
        self.lng0 + x / self.meters_per_degree_lng
    }

    pub fn lat(&self, y: f64) -> f64 {
        self.lat0 + y / METERS_PER_DEGREE_LAT
    }

    /// Metres per degree of longitude at the reference latitude, the east-west scale the blurred
    /// field converts its kernel offsets through.
    pub fn meters_per_degree_lng(&self) -> f64 {
        self.meters_per_degree_lng
    }
}

/// Where the field can be non-zero: the sources, grown by the blur's reach. This is what the tile
/// pyramid is planned over, and the only thing outside the sampler the truncation radius reaches —
/// so the ingest asks for it rather than redeclaring the radius.
pub fn reach_bounds(source: &Bounds, sigma_meters: f64) -> Bounds {
    let reach = KERNEL_RADII * sigma_meters;
    let meters_per_degree_lng = METERS_PER_DEGREE_LAT
        * ((source.south + source.north) / 2.0 * std::f64::consts::PI / 180.0).cos();
    Bounds {
        south: source.south - reach / METERS_PER_DEGREE_LAT,
        north: source.north + reach / METERS_PER_DEGREE_LAT,
        west: source.west - reach / meters_per_degree_lng,
        east: source.east + reach / meters_per_degree_lng,
    }
}

/// The direction a street runs at one of its vertices: the unit tangent in the local metre
/// space, which is the cos and sin of its bearing. The oriented sampler rotates a sidewalk's
/// offset into this frame.
#[derive(Clone, Copy)]
pub struct Bearing {
    pub along_x: f64,
    pub along_y: f64,
}
