//! The tree-density estimator: a gridless kernel density estimate, evaluated exactly wherever
//! it is wanted — once per output pixel when a tile is painted, once per street vertex when a
//! road is annotated. See scripts/README.md.
//!
//! Everything here is f64. The field is not merely displayed: a pixel's density is quantized
//! to a 0..255 ramp step, and one step is worth up to two levels of alpha, so an f32
//! accumulator's 1e-7 of relative error would flip a rounding boundary often enough over 227 M
//! pixels to show. The masks, which are read at 1/255 of a step, are f32.

use std::sync::LazyLock;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use crate::binfmt::Trees;
use crate::geometry::PolygonIndex;
use crate::manifest::Bounds;

pub const METERS_PER_DEGREE_LAT: f64 = 111_320.0;
pub const KERNEL_RADII: f64 = 3.0; // where the kernel is truncated, in sigmas

/// The covered fraction of ground under canopy, from the crown-area index the KDE sums: the
/// standard Boolean (Poisson) canopy model, which handles overlapping crowns without
/// double-counting. It is in [0, 1) by construction, monotone in the index, and never clips —
/// which is the whole point of measuring cover instead of a tree count.
pub fn cover(canopy_area_index: f64) -> f64 {
    1.0 - (-canopy_area_index).exp()
}

// The truncated Gaussian is renormalized to integrate to 1, so a tree's crown area is spread
// over the ground exactly, and the canopy-area index it sums to is a true crown-per-ground
// fraction rather than one off by the truncated tail.
static TRUNCATION: LazyLock<f64> =
    LazyLock::new(|| 1.0 - (-(KERNEL_RADII * KERNEL_RADII) / 2.0).exp());
const BUCKET_METERS: f64 = 60.0;

// A full pyramid needs ~36e9 kernel evaluations. The kernel is smooth and only ever asked for
// t = d^2 / 2*sigma^2 in [0, 4.5), so a table over that range answers in a load; at this width
// the nearest entry is within 3e-4 of the exact weight. The size is a power of two so the index
// can be masked into range — see `evaluate`.
const LUT_SIZE: usize = 8192;
const LUT_SCALE: f64 = (LUT_SIZE - 1) as f64 / (KERNEL_RADII * KERNEL_RADII / 2.0);
static LUT: LazyLock<[f64; LUT_SIZE]> =
    LazyLock::new(|| std::array::from_fn(|index| (-(index as f64) / LUT_SCALE).exp()));

const LANES: usize = 4; // independent kernel accumulators, to cover the latency of an add
const MAX_REJECTION_RATIO: usize = 100; // draws per accepted sample before the land is called empty

/// A local metre space with the city bbox centre as its origin. One reference latitude for the
/// whole city: over NYC's 0.42 degrees of span that costs about 0.7% in the east-west scale,
/// which is well inside the noise of a 70 m kernel. Only cos(lat0) actually reaches the field —
/// the origin cancels out of every distance — so two callers agree as long as they agree on the
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
}

/// Where the field can be non-zero: the sources, grown by the widest kernel's reach. This is
/// what the tile pyramid is planned over, and the only thing outside the estimator the
/// truncation radius reaches — so the ingest asks for it rather than redeclaring the radius.
pub fn reach_bounds(source: &Bounds, broad_sigma_meters: f64) -> Bounds {
    let reach = KERNEL_RADII * broad_sigma_meters;
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
/// space, which is the cos and sin of its bearing. The oriented kernel rotates a tree's offset
/// into this frame.
#[derive(Clone, Copy)]
pub struct Bearing {
    pub along_x: f64,
    pub along_y: f64,
}

/// The trees in a uniform metre-space index, CSR-style: bucket `row * cols + col` owns
/// `[starts[bucket], starts[bucket + 1])`. Buckets along a row are contiguous, so the scan a
/// query makes is one run per row rather than one per bucket. Each tree carries the area of its
/// crown disc, the weight the canopy-cover model sums instead of a bare count.
pub struct TreeIndex {
    xs: Vec<f64>,
    ys: Vec<f64>,
    crown_areas: Vec<f64>, // pi * r^2, in square metres, in the same bucket order as xs/ys
    starts: Vec<u32>,
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
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
        let areas: Vec<f64> = trees
            .crown_radii_m
            .iter()
            .map(|radius| std::f64::consts::PI * radius * radius)
            .collect();
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
        let mut crown_areas = vec![0.0; trees.coords.len()];
        let mut cursors = starts.clone();
        for (tree, bucket) in buckets.iter().enumerate() {
            let slot = cursors[*bucket] as usize;
            cursors[*bucket] += 1;
            xs[slot] = tree_x[tree];
            ys[slot] = tree_y[tree];
            crown_areas[slot] = areas[tree];
        }
        Self {
            xs,
            ys,
            crown_areas,
            starts,
            cols,
            rows,
            min_x,
            min_y,
        }
    }

    /// The canopy-area index at a point: crown area per unit ground area, the current kernel
    /// density estimate with each tree weighted by the area of its crown disc rather than by 1.
    /// It may exceed 1 where crowns overlap; the covered fraction `1 - exp(-CAI)` is what the
    /// ramp reads. Every tree within 3 sigma contributes, and an empty bucket neighbourhood is
    /// exactly zero, not nearly.
    pub fn evaluate(&self, x: f64, y: f64, sigma: f64) -> f64 {
        let radius = KERNEL_RADII * sigma;
        let squared_radius = radius * radius;
        let scale = LUT_SCALE / (2.0 * sigma * sigma);
        let lut = &*LUT;

        let summed = self.accumulate(x, y, radius, |delta_x, delta_y| {
            let squared = delta_x * delta_x + delta_y * delta_y;
            // A bucket row overshoots the disc by a fifth of its area, so the truncation test is a
            // coin flip the branch predictor loses. Masking the index makes the load
            // unconditionally in range, which lets the test compile to a select instead of a
            // branch; the mask changes nothing where the weight is kept, since inside the
            // truncation the index cannot reach LUT_SIZE.
            let looked_up = lut[(squared * scale + 0.5) as usize & (LUT_SIZE - 1)];
            if squared < squared_radius {
                looked_up
            } else {
                0.0
            }
        });
        summed / (2.0 * std::f64::consts::PI * sigma * sigma * *TRUNCATION)
    }

    /// The same canopy-area index, from a kernel aligned to a street: `sigma_along` down the
    /// road, keeping the colour smooth as it runs, and `sigma_across` over it. With the crown
    /// discs doing the physical work of reaching across the road, `sigma_across` is loosened from
    /// the old hard cut, so a large tree on the far sidewalk genuinely reaches over rather than
    /// being cut off by a kernel we chose. Truncated at 3 sigma in the *rotated* metric, whose
    /// unit ellipse holds exactly the mass a 3-sigma disc does — so the same `1 - e^-4.5`
    /// renormalizes it, and this index lands on the very same scale as the broad one.
    pub fn evaluate_oriented(
        &self,
        x: f64,
        y: f64,
        bearing: Bearing,
        sigma_along: f64,
        sigma_across: f64,
    ) -> f64 {
        let radius = KERNEL_RADII * sigma_along.max(sigma_across);
        let along_scale = LUT_SCALE / (2.0 * sigma_along * sigma_along);
        let across_scale = LUT_SCALE / (2.0 * sigma_across * sigma_across);
        let lut = &*LUT;

        let summed = self.accumulate(x, y, radius, |delta_x, delta_y| {
            let along = delta_x * bearing.along_x + delta_y * bearing.along_y;
            let across = -delta_x * bearing.along_y + delta_y * bearing.along_x;
            // The table is indexed by the exponent's argument, so the rotated metric needs no
            // second table: LUT_SCALE * 4.5 is its last entry, and that is the truncation.
            let scaled = along * along * along_scale + across * across * across_scale;
            let looked_up = lut[(scaled + 0.5) as usize & (LUT_SIZE - 1)];
            if scaled < (LUT_SIZE - 1) as f64 {
                looked_up
            } else {
                0.0
            }
        });
        summed / (2.0 * std::f64::consts::PI * sigma_along * sigma_across * *TRUNCATION)
    }

    /// Every tree whose bucket a disc of `radius` around (x, y) reaches, its `kernel` weight times
    /// its crown area summed — the scan both kernels are built on. `kernel` is handed the offset
    /// to the tree and decides which of those trees are truly inside it; the crown area is the
    /// per-tree weight that turns a count into a canopy area.
    fn accumulate(&self, x: f64, y: f64, radius: f64, kernel: impl Fn(f64, f64) -> f64) -> f64 {
        let Some((low_col, high_col, low_row, high_row)) = self.span(x, y, x, y, radius) else {
            return 0.0;
        };

        // One accumulator would serialize the whole scan on the latency of a single add, which is
        // three times what the rest of a tree costs. Four independent ones cover it.
        let mut lanes = [0.0f64; LANES];
        for row in low_row..=high_row {
            let base = row * self.cols;
            let from = self.starts[base + low_col] as usize;
            let to = self.starts[base + high_col + 1] as usize;
            let xs = &self.xs[from..to];
            let ys = &self.ys[from..to];
            let areas = &self.crown_areas[from..to];
            let blocks = xs.len() - xs.len() % LANES;
            for ((block_x, block_y), block_area) in xs[..blocks]
                .chunks_exact(LANES)
                .zip(ys[..blocks].chunks_exact(LANES))
                .zip(areas[..blocks].chunks_exact(LANES))
            {
                for (lane, accumulator) in lanes.iter_mut().enumerate() {
                    *accumulator += kernel(block_x[lane] - x, block_y[lane] - y) * block_area[lane];
                }
            }
            for ((tree_x, tree_y), area) in
                xs[blocks..].iter().zip(&ys[blocks..]).zip(&areas[blocks..])
            {
                lanes[0] += kernel(*tree_x - x, *tree_y - y) * area;
            }
        }
        lanes.iter().sum()
    }

    /// Whether any tree lies within `radius` of the metre-space box — the test that sends a tile
    /// with nothing in it straight to the blank PNG.
    pub fn any_near(&self, min_x: f64, min_y: f64, max_x: f64, max_y: f64, radius: f64) -> bool {
        let Some((low_col, high_col, low_row, high_row)) =
            self.span(min_x, min_y, max_x, max_y, radius)
        else {
            return false;
        };
        (low_row..=high_row).any(|row| {
            let base = row * self.cols;
            self.starts[base + low_col] != self.starts[base + high_col + 1]
        })
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

/// The population the reported cover distribution is taken over: points drawn uniformly over the
/// city's *ground area* and kept if they land on it. Latitude is drawn uniform in sin(lat)
/// rather than in degrees, so a degree of latitude at the top of the city is not worth more
/// than one at the bottom.
pub struct LandSamples {
    pub field: Vec<f64>, // the broad canopy-area index at each accepted sample, crown m2 / ground m2
    pub xs: Vec<f64>,    // and where it was taken, in metre space, for the canopy floor
    pub ys: Vec<f64>,
    pub draws: usize, // including the ones that missed the land
}

/// The mean cover the draw reports is a committed manifest value, so the draw is seeded: ChaCha8
/// because `rand` documents it as reproducible across releases, which `SmallRng` — and `StdRng`
/// across a major — explicitly are not.
pub fn sample_land(
    index: &TreeIndex,
    projection: &Projection,
    land: &mut PolygonIndex,
    box_: &Bounds,
    sigma: f64,
    samples: usize,
    seed: u64,
) -> Result<LandSamples, String> {
    let mut random = ChaCha8Rng::seed_from_u64(seed);
    let radians = std::f64::consts::PI / 180.0;
    let sin_south = (box_.south * radians).sin();
    let sin_north = (box_.north * radians).sin();
    let mut drawn = LandSamples {
        field: Vec::with_capacity(samples),
        xs: Vec::with_capacity(samples),
        ys: Vec::with_capacity(samples),
        draws: 0,
    };
    let limit = samples * MAX_REJECTION_RATIO;

    while drawn.field.len() < samples {
        if drawn.draws >= limit {
            return Err(format!(
                "only {} of {samples} samples landed on the city in {} draws: the land mask is empty or does not overlap its own bounding box",
                drawn.field.len(),
                drawn.draws
            ));
        }
        drawn.draws += 1;
        let lng = random.random_range(box_.west..box_.east);
        let lat = random.random_range(sin_south..sin_north).asin() / radians;
        if land.contains(lng, lat) {
            let x = projection.x(lng);
            let y = projection.y(lat);
            drawn.xs.push(x);
            drawn.ys.push(y);
            drawn.field.push(index.evaluate(x, y, sigma));
        }
    }
    Ok(drawn)
}
