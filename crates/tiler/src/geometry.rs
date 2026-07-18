//! Polygon rasterisation, the Gaussian feather over a mask, and the point-in-polygon index
//! the cover-distribution sampler queries a million times.

use std::sync::LazyLock;

use crate::binfmt::{Coord, Polygon};
use crate::kde::{Bearing, METERS_PER_DEGREE_LAT, Projection};
use crate::manifest::Bounds;

pub const BLUR_RADII: f64 = 3.0; // kernel half-width, in sigmas

// The quadrature the blurred canopy field is evaluated on: nodes every sigma/4 out to 2.5 sigma
// on each axis, so 21 per axis and 441 in the oriented kernel. The 1D weights are exp(-t^2/2) at
// t = node/4, normalized to sum to one; because the exponent's argument is offset/sigma squared,
// the weights are the same whatever sigma the caller scales the node positions by.
const QUAD_STEPS: i32 = 10; // +/- this many nodes of sigma/4, so the last node sits at 2.5 sigma
const QUAD_NODES: usize = (2 * QUAD_STEPS + 1) as usize;
static QUAD: LazyLock<([f64; QUAD_NODES], [f64; QUAD_NODES])> = LazyLock::new(|| {
    let mut positions = [0.0f64; QUAD_NODES]; // node offset in units of sigma
    let mut weights = [0.0f64; QUAD_NODES]; // its 1D Gaussian weight, normalized below
    let mut total = 0.0;
    for node in 0..QUAD_NODES {
        let position = (node as i32 - QUAD_STEPS) as f64 / 4.0;
        positions[node] = position;
        weights[node] = (-(position * position) / 2.0).exp();
        total += weights[node];
    }
    for weight in &mut weights {
        *weight /= total;
    }
    (positions, weights)
});

const LAT_BANDS: usize = 512; // horizontal strips the point-in-polygon edges are bucketed into

/// Half away from zero on a tie, as `Math.round` is and `f64::round` is not: the street
/// coordinates a chunk quantizes are signed, since a segment reaches into the tiles its
/// bounding box touches.
pub fn round_half_up(value: f64) -> f64 {
    let floored = value.floor();
    if value - floored >= 0.5 {
        floored + 1.0
    } else {
        floored
    }
}

/// Rings flattened into flat arrays, with each polygon's bounding box, so a tile can reject
/// the polygons it does not touch without walking their vertices.
pub struct PolygonSet {
    rings: Vec<Vec<RingXy>>,
    boxes: Vec<Bounds>,
}

struct RingXy {
    lngs: Vec<f64>,
    lats: Vec<f64>,
}

pub fn box_of(polygons: &[Polygon]) -> Bounds {
    let mut bounds = Bounds {
        south: f64::INFINITY,
        west: f64::INFINITY,
        north: f64::NEG_INFINITY,
        east: f64::NEG_INFINITY,
    };
    for polygon in polygons {
        for ring in polygon {
            for point in ring {
                bounds.south = bounds.south.min(point.lat);
                bounds.north = bounds.north.max(point.lat);
                bounds.west = bounds.west.min(point.lng);
                bounds.east = bounds.east.max(point.lng);
            }
        }
    }
    bounds
}

pub fn flatten(polygons: &[Polygon]) -> PolygonSet {
    let mut set = PolygonSet {
        rings: Vec::with_capacity(polygons.len()),
        boxes: Vec::with_capacity(polygons.len()),
    };
    for polygon in polygons {
        set.boxes.push(box_of(std::slice::from_ref(polygon)));
        set.rings.push(
            polygon
                .iter()
                .map(|ring| RingXy {
                    lngs: ring.iter().map(|point| point.lng).collect(),
                    lats: ring.iter().map(|point| point.lat).collect(),
                })
                .collect(),
        );
    }
    set
}

impl PolygonSet {
    /// Whether the polygon at `index` covers the point, even-odd over all of its rings so an
    /// inner ring cuts a hole rather than filling it — the containment counterpart of the fill's
    /// scanline crossing test, scoped to one polygon. The bounding box rejects the far misses in
    /// a couple of comparisons before any ring is walked.
    pub fn covers(&self, index: usize, lng: f64, lat: f64) -> bool {
        let box_ = &self.boxes[index];
        if lng < box_.west || lng > box_.east || lat < box_.south || lat > box_.north {
            return false;
        }
        let mut inside = false;
        for ring in &self.rings[index] {
            let mut previous = ring.lngs.len() - 1;
            for point in 0..ring.lngs.len() {
                if (ring.lats[point] > lat) != (ring.lats[previous] > lat) {
                    let at = ring.lngs[point]
                        + ((lat - ring.lats[point]) / (ring.lats[previous] - ring.lats[point]))
                            * (ring.lngs[previous] - ring.lngs[point]);
                    if lng < at {
                        inside = !inside;
                    }
                }
                previous = point;
            }
        }
        inside
    }
}

/// Even-odd scanline fill of the polygons at `indices` into a `width` by `height` mask,
/// returning how many reached it. `project` carries a lng/lat to the mask's coordinate space;
/// both tile projections are separable, but a single point map keeps this one loop. Taking
/// every ring of a polygon together is what makes its inner rings cut holes rather than fill
/// them; taking the polygons one at a time is what keeps two overlapping woods from cancelling
/// out. The mask is set, never toggled, so a polygon drawn twice — a canopy candidate gathered
/// from two grid cells — is idempotent.
fn fill_indices(
    mask: &mut [u8],
    width: usize,
    height: usize,
    set: &PolygonSet,
    clip: &Bounds,
    project: impl Fn(f64, f64) -> (f64, f64),
    indices: impl Iterator<Item = usize>,
) -> usize {
    let mut crossings: Vec<f64> = Vec::new();
    let mut projected: Vec<(Vec<f64>, Vec<f64>)> = Vec::new();
    let mut drawn = 0;
    for index in indices {
        let polygon = &set.boxes[index];
        if polygon.east < clip.west
            || polygon.west > clip.east
            || polygon.north < clip.south
            || polygon.south > clip.north
        {
            continue;
        }
        drawn += 1;

        let mut low_row = f64::INFINITY;
        let mut high_row = f64::NEG_INFINITY;
        projected.clear();
        for ring in &set.rings[index] {
            let mut xs: Vec<f64> = Vec::with_capacity(ring.lngs.len());
            let mut ys: Vec<f64> = Vec::with_capacity(ring.lngs.len());
            for (lng, lat) in ring.lngs.iter().zip(&ring.lats) {
                let (x, y) = project(*lng, *lat);
                low_row = low_row.min(y);
                high_row = high_row.max(y);
                xs.push(x);
                ys.push(y);
            }
            projected.push((xs, ys));
        }

        let first_row = low_row.floor().max(0.0) as usize;
        let last_row = high_row.ceil().min((height as f64) - 1.0);
        if last_row < first_row as f64 {
            continue;
        }
        for row in first_row..=(last_row as usize) {
            let line = row as f64 + 0.5;
            crossings.clear();
            for (xs, ys) in &projected {
                let mut previous = xs.len() - 1;
                for point in 0..xs.len() {
                    if (ys[point] > line) != (ys[previous] > line) {
                        crossings.push(
                            xs[point]
                                + ((line - ys[point]) / (ys[previous] - ys[point]))
                                    * (xs[previous] - xs[point]),
                        );
                    }
                    previous = point;
                }
            }
            crossings.sort_by(|left, right| left.total_cmp(right));
            for pair in crossings.chunks_exact(2) {
                let from = (pair[0] - 0.5).ceil().max(0.0) as usize;
                let to = (pair[1] - 0.5).floor().min((width as f64) - 1.0);
                if to < from as f64 {
                    continue;
                }
                mask[row * width + from..=row * width + to as usize].fill(1);
            }
        }
    }
    drawn
}

/// Fill every polygon of the set that reaches the clip.
pub fn fill_polygons(
    mask: &mut [u8],
    width: usize,
    height: usize,
    set: &PolygonSet,
    clip: &Bounds,
    project: impl Fn(f64, f64) -> (f64, f64),
) -> usize {
    fill_indices(mask, width, height, set, clip, project, 0..set.rings.len())
}

/// Fill only the polygons a spatial grid gathered for this tile, so a million-polygon set is
/// never scanned in full per tile. `candidates` is deduplicated already; each is a valid index.
pub fn fill_polygons_indexed(
    mask: &mut [u8],
    width: usize,
    height: usize,
    set: &PolygonSet,
    candidates: &[u32],
    clip: &Bounds,
    project: impl Fn(f64, f64) -> (f64, f64),
) -> usize {
    fill_indices(
        mask,
        width,
        height,
        set,
        clip,
        project,
        candidates.iter().map(|index| *index as usize),
    )
}

/// A uniform grid over a PolygonSet's bounding boxes, CSR-style: each cell lists the polygons
/// whose box overlaps it. Built once, queried per tile — a tile gathers only the polygons its
/// own extent can reach rather than testing all ~1.08 M of the canopy set every time.
pub struct PolygonGrid {
    bounds: Bounds,
    cols: usize,
    rows: usize,
    cell_lng: f64, // degrees of longitude a column spans
    cell_lat: f64,
    starts: Vec<u32>, // cols * rows + 1 offsets into `items`
    items: Vec<u32>,  // polygon indices, grouped by the cell their box touches
}

impl PolygonGrid {
    const TARGET_PER_CELL: usize = 16; // a cell holds ~this many, so a tile gathers a few hundred

    pub fn new(set: &PolygonSet) -> Self {
        let bounds = {
            let mut bounds = Bounds {
                south: f64::INFINITY,
                west: f64::INFINITY,
                north: f64::NEG_INFINITY,
                east: f64::NEG_INFINITY,
            };
            for polygon in &set.boxes {
                bounds.south = bounds.south.min(polygon.south);
                bounds.west = bounds.west.min(polygon.west);
                bounds.north = bounds.north.max(polygon.north);
                bounds.east = bounds.east.max(polygon.east);
            }
            bounds
        };
        if set.boxes.is_empty() {
            return Self {
                bounds: Bounds {
                    south: 0.0,
                    west: 0.0,
                    north: 0.0,
                    east: 0.0,
                },
                cols: 1,
                rows: 1,
                cell_lng: 1.0,
                cell_lat: 1.0,
                starts: vec![0, 0],
                items: Vec::new(),
            };
        }

        let span_lng = (bounds.east - bounds.west).max(1e-9);
        let span_lat = (bounds.north - bounds.south).max(1e-9);
        let aspect = span_lng / span_lat;
        let target = (set.boxes.len() / Self::TARGET_PER_CELL).max(1) as f64;
        let cols = ((target * aspect).sqrt().round() as usize).max(1);
        let rows = ((target / aspect).sqrt().round() as usize).max(1);
        let cell_lng = span_lng / cols as f64;
        let cell_lat = span_lat / rows as f64;
        let col_of = |lng: f64| (((lng - bounds.west) / cell_lng) as usize).min(cols - 1);
        let row_of = |lat: f64| (((lat - bounds.south) / cell_lat) as usize).min(rows - 1);
        let cell_range = |polygon: &Bounds| {
            (
                col_of(polygon.west),
                col_of(polygon.east),
                row_of(polygon.south),
                row_of(polygon.north),
            )
        };

        let mut starts = vec![0u32; cols * rows + 1];
        for polygon in &set.boxes {
            let (west, east, south, north) = cell_range(polygon);
            for row in south..=north {
                for col in west..=east {
                    starts[row * cols + col + 1] += 1;
                }
            }
        }
        for cell in 0..cols * rows {
            starts[cell + 1] += starts[cell];
        }
        let mut items = vec![0u32; starts[cols * rows] as usize];
        let mut cursors = starts.clone();
        for (index, polygon) in set.boxes.iter().enumerate() {
            let (west, east, south, north) = cell_range(polygon);
            for row in south..=north {
                for col in west..=east {
                    let cell = row * cols + col;
                    items[cursors[cell] as usize] = index as u32;
                    cursors[cell] += 1;
                }
            }
        }

        Self {
            bounds,
            cols,
            rows,
            cell_lng,
            cell_lat,
            starts,
            items,
        }
    }

    /// Whether any polygon of `set` covers the point, found through the single grid cell the
    /// point falls in. A polygon that contains the point has a bounding box that contains it too,
    /// so it is listed in that cell — no wider search is needed. Allocation-free and unsorted, so
    /// the blurred-cover quadrature can call it once per node without touching the heap.
    pub fn covered(&self, set: &PolygonSet, lng: f64, lat: f64) -> bool {
        if lng < self.bounds.west
            || lng > self.bounds.east
            || lat < self.bounds.south
            || lat > self.bounds.north
        {
            return false;
        }
        let col = (((lng - self.bounds.west) / self.cell_lng) as usize).min(self.cols - 1);
        let row = (((lat - self.bounds.south) / self.cell_lat) as usize).min(self.rows - 1);
        let cell = row * self.cols + col;
        for slot in self.starts[cell]..self.starts[cell + 1] {
            if set.covers(self.items[slot as usize] as usize, lng, lat) {
                return true;
            }
        }
        false
    }

    /// The deduplicated polygon indices whose grid cells the clip overlaps, into `out`. A
    /// candidate's box may still miss the tile — the fill's own box test rejects it — but the
    /// set the caller rasterizes is a few hundred rather than a million.
    pub fn candidates(&self, clip: &Bounds, out: &mut Vec<u32>) {
        out.clear();
        if clip.east < self.bounds.west
            || clip.west > self.bounds.east
            || clip.north < self.bounds.south
            || clip.south > self.bounds.north
        {
            return;
        }
        let col_of = |lng: f64| {
            (((lng - self.bounds.west) / self.cell_lng).max(0.0) as usize).min(self.cols - 1)
        };
        let row_of = |lat: f64| {
            (((lat - self.bounds.south) / self.cell_lat).max(0.0) as usize).min(self.rows - 1)
        };
        for row in row_of(clip.south)..=row_of(clip.north) {
            for col in col_of(clip.west)..=col_of(clip.east) {
                let cell = row * self.cols + col;
                out.extend_from_slice(
                    &self.items[self.starts[cell] as usize..self.starts[cell + 1] as usize],
                );
            }
        }
        out.sort_unstable();
        out.dedup();
    }
}

/// The blurred canopy cover at one point: the oriented Gaussian convolution of the canopy
/// indicator, evaluated by quadrature. The kernel runs `sigma_along` down the street's bearing
/// and `sigma_across` over it (isotropic when the two are equal), so a sidewalk near but not
/// under a crown reads partial shade. Each node's world position is looked up in the grid's cell;
/// the node lands on canopy the moment a polygon there contains it, and its weight joins the
/// covered mass. The weights already sum to one, so the return is the covered fraction in [0, 1].
// The canopy set, its grid and the projection travel together and the two sigmas name the
// oriented kernel; bundling them into a struct only to satisfy the arg-count lint would obscure
// what each call passes.
#[allow(clippy::too_many_arguments)]
pub fn blurred_cover(
    set: &PolygonSet,
    grid: &PolygonGrid,
    projection: &Projection,
    lng: f64,
    lat: f64,
    bearing: Bearing,
    sigma_along: f64,
    sigma_across: f64,
) -> f64 {
    let (positions, weights) = &*QUAD;
    let meters_per_degree_lng = projection.meters_per_degree_lng();
    // The across axis is the street's left normal, so a node's offset rotates into the world
    // frame exactly as `sidewalks::left_normal` places the sidewalks it is sampled at.
    let across_x = -bearing.along_y;
    let across_y = bearing.along_x;
    let mut covered = 0.0;
    for (along_node, along_position) in positions.iter().enumerate() {
        let along = along_position * sigma_along;
        for (across_node, across_position) in positions.iter().enumerate() {
            let across = across_position * sigma_across;
            let metre_x = along * bearing.along_x + across * across_x;
            let metre_y = along * bearing.along_y + across * across_y;
            let query_lng = lng + metre_x / meters_per_degree_lng;
            let query_lat = lat + metre_y / METERS_PER_DEGREE_LAT;
            if grid.covered(set, query_lng, query_lat) {
                covered += weights[along_node] * weights[across_node];
            }
        }
    }
    covered
}

/// Separable Gaussian over a field of samples, zero-padded at the edges, with sigma in cells.
/// The samples are anything that reads as a scalar — a 0/1 mask or a fractional coverage — so
/// the fill can feather a supersample-averaged fraction and the land floor a binary mask through
/// one kernel. The caller is responsible for the halo: this truncates at BLUR_RADII sigmas, so a
/// buffer with no margin loses mass at its border.
pub fn feather<Sample: Copy + Into<f64>>(
    field: &[Sample],
    width: usize,
    height: usize,
    sigma: f64,
) -> Vec<f32> {
    let radius = (BLUR_RADII * sigma).ceil() as usize;
    let mut kernel = vec![0.0f64; radius * 2 + 1];
    let mut total = 0.0;
    for (index, weight) in kernel.iter_mut().enumerate() {
        let offset = index as f64 - radius as f64;
        *weight = (-(offset * offset) / (2.0 * sigma * sigma)).exp();
        total += *weight;
    }
    for weight in &mut kernel {
        *weight /= total;
    }

    let mut scratch = vec![0.0f32; field.len()];
    for row in 0..height {
        let start = row * width;
        for col in 0..width {
            let low = radius.saturating_sub(col);
            let high = (radius + width - col).min(kernel.len());
            let mut sum = 0.0f64;
            for (slot, weight) in kernel[low..high].iter().enumerate() {
                let sample: f64 = field[start + col + low + slot - radius].into();
                sum += sample * weight;
            }
            scratch[start + col] = sum as f32;
        }
    }
    let mut blurred = vec![0.0f32; field.len()];
    for col in 0..width {
        for row in 0..height {
            let low = radius.saturating_sub(row);
            let high = (radius + height - row).min(kernel.len());
            let mut sum = 0.0f64;
            for (slot, weight) in kernel[low..high].iter().enumerate() {
                sum += f64::from(scratch[(row + low + slot - radius) * width + col]) * weight;
            }
            blurred[row * width + col] = sum as f32;
        }
    }
    blurred
}

/// Every edge, bucketed into the horizontal bands it spans. A shoreline runs to ~200k edges
/// and the cover-distribution sampler throws a million points at it, so a query has to look at
/// the handful of edges its own latitude can possibly cross, not all of them.
pub struct PolygonIndex {
    south: f64,
    north: f64,
    bands_per_degree: f64,
    from: Vec<Coord>,
    to: Vec<Coord>,
    owner: Vec<u32>,
    starts: Vec<u32>,
    items: Vec<u32>,
    // Crossings are counted per polygon and only the polygons the band touched are cleared, so
    // a woodland set of thousands does not pay to reset an array it never wrote to.
    parity: Vec<u8>,
    touched: Vec<u32>,
}

impl PolygonIndex {
    pub fn new(polygons: &[Polygon]) -> Self {
        let Bounds { south, north, .. } = box_of(polygons);
        let bands_per_degree = LAT_BANDS as f64 / (north - south).max(1e-9);
        let band_of = |lat: f64| -> usize {
            (((lat - south) * bands_per_degree).floor().max(0.0) as usize).min(LAT_BANDS - 1)
        };

        let mut from: Vec<Coord> = Vec::new();
        let mut to: Vec<Coord> = Vec::new();
        let mut owner: Vec<u32> = Vec::new();
        for (index, polygon) in polygons.iter().enumerate() {
            for ring in polygon {
                let mut previous = ring.len() - 1;
                for point in 0..ring.len() {
                    from.push(ring[previous]);
                    to.push(ring[point]);
                    owner.push(index as u32);
                    previous = point;
                }
            }
        }

        let bands = |edge: usize| -> (usize, usize) {
            (
                band_of(from[edge].lat.min(to[edge].lat)),
                band_of(from[edge].lat.max(to[edge].lat)),
            )
        };
        let mut starts = vec![0u32; LAT_BANDS + 1];
        for edge in 0..from.len() {
            let (low, high) = bands(edge);
            for band in low..=high {
                starts[band + 1] += 1;
            }
        }
        for band in 0..LAT_BANDS {
            starts[band + 1] += starts[band];
        }
        let mut items = vec![0u32; starts[LAT_BANDS] as usize];
        let mut cursors = starts.clone();
        for edge in 0..from.len() {
            let (low, high) = bands(edge);
            for band in low..=high {
                items[cursors[band] as usize] = edge as u32;
                cursors[band] += 1;
            }
        }

        Self {
            south,
            north,
            bands_per_degree,
            from,
            to,
            owner,
            starts,
            items,
            parity: vec![0u8; polygons.len()],
            touched: Vec::new(),
        }
    }

    pub fn contains(&mut self, lng: f64, lat: f64) -> bool {
        if lat < self.south || lat > self.north {
            return false;
        }
        let band = (((lat - self.south) * self.bands_per_degree)
            .floor()
            .max(0.0) as usize)
            .min(LAT_BANDS - 1);
        self.touched.clear();
        for slot in self.starts[band]..self.starts[band + 1] {
            let edge = self.items[slot as usize] as usize;
            let (from, to) = (self.from[edge], self.to[edge]);
            if (from.lat > lat) != (to.lat > lat) {
                let at = from.lng + ((lat - from.lat) / (to.lat - from.lat)) * (to.lng - from.lng);
                if lng < at {
                    let polygon = self.owner[edge] as usize;
                    if self.parity[polygon] == 0 {
                        self.touched.push(polygon as u32);
                    }
                    self.parity[polygon] ^= 1;
                }
            }
        }
        let mut inside = false;
        for polygon in &self.touched {
            inside = inside || self.parity[*polygon as usize] == 1;
            self.parity[*polygon as usize] = 0;
        }
        inside
    }
}
