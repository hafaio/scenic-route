//! Polygon rasterisation, the Gaussian feather over a mask, and the point-in-polygon index
//! the cover-distribution sampler queries a million times.

use crate::binfmt::{Coord, Polygon};
use crate::manifest::Bounds;

pub const BLUR_RADII: f64 = 3.0; // kernel half-width, in sigmas

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

/// Even-odd scanline fill into a `width` by `height` mask, returning the polygons that
/// reached it. Both projections are separable — a lat/lng grid and web mercator both put x on
/// longitude alone and y on latitude alone — which is what lets a scanline be a run of
/// columns at one latitude. Taking every ring of a polygon together is what makes its inner
/// rings cut holes rather than fill them; taking the polygons one at a time is what keeps two
/// overlapping woods from cancelling out.
pub fn fill_polygons(
    mask: &mut [u8],
    width: usize,
    height: usize,
    set: &PolygonSet,
    clip: &Bounds,
    to_x: impl Fn(f64) -> f64,
    to_y: impl Fn(f64) -> f64,
) -> usize {
    let mut crossings: Vec<f64> = Vec::new();
    let mut projected: Vec<(Vec<f64>, Vec<f64>)> = Vec::new();
    let mut drawn = 0;
    for (index, rings) in set.rings.iter().enumerate() {
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
        for ring in rings {
            let xs: Vec<f64> = ring.lngs.iter().map(|lng| to_x(*lng)).collect();
            let ys: Vec<f64> = ring.lats.iter().map(|lat| to_y(*lat)).collect();
            for y in &ys {
                low_row = low_row.min(*y);
                high_row = high_row.max(*y);
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

/// Separable Gaussian over a binary mask, zero-padded at the edges, with sigma in cells. The
/// caller is responsible for the halo: this truncates at BLUR_RADII sigmas, so a buffer with
/// no margin loses mass at its border.
pub fn feather(mask: &[u8], width: usize, height: usize, sigma: f64) -> Vec<f32> {
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

    let mut scratch = vec![0.0f32; mask.len()];
    for row in 0..height {
        let start = row * width;
        for col in 0..width {
            let low = radius.saturating_sub(col);
            let high = (radius + width - col).min(kernel.len());
            let mut sum = 0.0f64;
            for (slot, weight) in kernel[low..high].iter().enumerate() {
                sum += f64::from(mask[start + col + low + slot - radius]) * weight;
            }
            scratch[start + col] = sum as f32;
        }
    }
    let mut blurred = vec![0.0f32; mask.len()];
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
