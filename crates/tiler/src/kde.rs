//! Projection and reach helpers shared by the tile pyramids and the density sampler: a local
//! metre space for one city, the bounds its blurred field can reach, and a street's bearing.
//! (Slated to fold into geometry.rs, where the rest of the coordinate math lives.)

use crate::binfmt::Trees;
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

/// The number of genus bins: 11 ranked genera plus an "Other" tail. Must equal GENUS_COUNT in
/// src/tree-cover/genus.ts, the palette the tiler draws each tree with.
pub const GENUS_BINS: usize = 12;

const BUCKET_METERS: f64 = 60.0;

/// The trees in a uniform metre-space index, CSR-style: bucket `row * cols + col` owns
/// `[starts[bucket], starts[bucket + 1])`. Buckets along a row are contiguous, so the scan a
/// query makes is one run per row rather than one per bucket. Each tree carries its crown radius
/// (the size the overlay draws its dot at) and its genus id (the colour), in bucket order.
pub struct TreeIndex {
    xs: Vec<f64>,
    ys: Vec<f64>,
    crown_radii_m: Vec<f64>, // in bucket order alongside xs/ys
    genus_ids: Vec<u8>,      // 0..GENUS_BINS, in the same bucket order
    starts: Vec<u32>,
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
    max_crown_m: f64, // the largest crown, so a query knows how far a dot can reach past the box
}

impl TreeIndex {
    pub fn new(trees: &Trees, projection: &Projection) -> Self {
        let tree_x: Vec<f64> = trees
            .coords
            .iter()
            .map(|tree| projection.x(tree.lng))
            .collect();
        let tree_y: Vec<f64> = trees
            .coords
            .iter()
            .map(|tree| projection.y(tree.lat))
            .collect();
        let max_crown_m = trees.crown_radii_m.iter().copied().fold(0.0, f64::max);
        let min_x = tree_x.iter().copied().fold(f64::INFINITY, f64::min);
        let min_y = tree_y.iter().copied().fold(f64::INFINITY, f64::min);
        let max_x = tree_x.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let max_y = tree_y.iter().copied().fold(f64::NEG_INFINITY, f64::max);

        let cols = (((max_x - min_x) / BUCKET_METERS).floor() as usize + 1).max(1);
        let rows = (((max_y - min_y) / BUCKET_METERS).floor() as usize + 1).max(1);
        let mut starts = vec![0u32; cols * rows + 1];
        let buckets: Vec<usize> = (0..trees.coords.len())
            .map(|tree| {
                let col = ((tree_x[tree] - min_x) / BUCKET_METERS).floor() as usize;
                let row = ((tree_y[tree] - min_y) / BUCKET_METERS).floor() as usize;
                row * cols + col
            })
            .collect();
        for bucket in &buckets {
            starts[bucket + 1] += 1;
        }
        for bucket in 0..cols * rows {
            starts[bucket + 1] += starts[bucket];
        }

        let mut xs = vec![0.0; trees.coords.len()];
        let mut ys = vec![0.0; trees.coords.len()];
        let mut crown_radii_m = vec![0.0; trees.coords.len()];
        let mut genus_ids = vec![0u8; trees.coords.len()];
        let mut cursors = starts.clone();
        for (tree, bucket) in buckets.iter().enumerate() {
            let slot = cursors[*bucket] as usize;
            cursors[*bucket] += 1;
            xs[slot] = tree_x[tree];
            ys[slot] = tree_y[tree];
            crown_radii_m[slot] = trees.crown_radii_m[tree];
            genus_ids[slot] = trees.genus_ids[tree];
        }
        Self {
            xs,
            ys,
            crown_radii_m,
            genus_ids,
            starts,
            cols,
            rows,
            min_x,
            min_y,
            max_crown_m,
        }
    }

    pub fn max_crown_m(&self) -> f64 {
        self.max_crown_m
    }

    /// Every tree whose metre-space position lies within `reach` of the box, handed to `visit` as
    /// (x, y, crown_radius_m, genus_id). `reach` is the largest dot radius in metres, so a tree just
    /// outside the tile whose dot still spills into it is included. The bucket scan overshoots the
    /// box by up to a bucket, so each tree is tested against the grown box before it is visited.
    pub fn for_each_in_box(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        reach: f64,
        mut visit: impl FnMut(f64, f64, f64, u8),
    ) {
        let Some((low_col, high_col, low_row, high_row)) =
            self.span(min_x, min_y, max_x, max_y, reach)
        else {
            return;
        };
        let (low_x, high_x, low_y, high_y) =
            (min_x - reach, max_x + reach, min_y - reach, max_y + reach);
        for row in low_row..=high_row {
            let base = row * self.cols;
            let from = self.starts[base + low_col] as usize;
            let to = self.starts[base + high_col + 1] as usize;
            for tree in from..to {
                let x = self.xs[tree];
                let y = self.ys[tree];
                if x >= low_x && x <= high_x && y >= low_y && y <= high_y {
                    visit(x, y, self.crown_radii_m[tree], self.genus_ids[tree]);
                }
            }
        }
    }

    // The buckets a box grown by `radius` reaches, or None when it reaches none of them.
    fn span(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        radius: f64,
    ) -> Option<(usize, usize, usize, usize)> {
        let low_col = ((min_x - radius - self.min_x) / BUCKET_METERS)
            .floor()
            .max(0.0);
        let high_col = ((max_x + radius - self.min_x) / BUCKET_METERS)
            .floor()
            .min((self.cols - 1) as f64);
        let low_row = ((min_y - radius - self.min_y) / BUCKET_METERS)
            .floor()
            .max(0.0);
        let high_row = ((max_y + radius - self.min_y) / BUCKET_METERS)
            .floor()
            .min((self.rows - 1) as f64);
        if low_col > high_col || low_row > high_row {
            None
        } else {
            Some((
                low_col as usize,
                high_col as usize,
                low_row as usize,
                high_row as usize,
            ))
        }
    }
}
