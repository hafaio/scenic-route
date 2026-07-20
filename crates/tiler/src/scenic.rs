//! The scenic per-edge routing attributes, baked into GRPH v5 from the committed POI and nuisance
//! sources plus the derived commercial-frontage lines. Each quantizes to a 0..254 byte per edge (the 254 ceiling keeps a discount
//! edge from ever reading free — the cost model's `maxAttr < 1` invariant, as cover already relies
//! on); a later phase reads the discount bytes as `1 - w*attr` and the penalty byte as `1 + w*attr`.
//!
//! - **Landmark and public-art amenity — a DISCOUNT, by network fan-out.** A landmark or mural only
//!   rewards you if your walking path passes it, so its reach is geodesic, not Euclidean: each POI
//!   snaps to the nearest walking node and a bounded Dijkstra deposits a network-distance-decaying
//!   contribution on the edges it reaches. Contributions accumulate across POIs and saturate
//!   `1 - e^{-k·field}`, so a dense cluster stops stacking linearly. The kernel is per-mood —
//!   landmarks reach further and saturate fast, art stays tight and keeps rewarding a rich corridor.
//! - **Highway / elevated-rail nuisance — a PENALTY, by an areal proximity field.** Noise and grime
//!   carry through the air regardless of the street grid, so this is Euclidean: each edge's penalty
//!   is a Gaussian of its metre distance to the nearest nuisance line.
//! - **Nice commercial frontage — a DISCOUNT, by the same proximity field over the qualifying blocks.**
//!   A commercial street is walked ALONG, so a tight Euclidean σ keeps the reward on the block's own
//!   sidewalks and off the parallel residential street a block over.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::binfmt::{Coord, Polygon};
use crate::geometry::round_half_up;

const BYTE_CEILING: f64 = 254.0; // a discount edge is never free: keeps maxAttr < 1, as cover does
const FANOUT_SIGMAS: f64 = 3.0; // the Gaussian is negligible past 3σ; searches and fan-outs stop there

// Landmarks read from a distance and one is plenty (wide σ, fast saturation); art is experienced up
// close and a rich corridor keeps giving (tight σ, slower saturation). Tunable by eye in Phase 3.
pub const LANDMARK_PARAMS: PoiParams = PoiParams {
    sigma_meters: 120.0,
    saturation: 1.0,
};
pub const ART_PARAMS: PoiParams = PoiParams {
    sigma_meters: 60.0,
    saturation: 1.2,
};
// A POI more than this from any walking node is off-network and contributes nothing.
const POI_SNAP_RADIUS_METERS: f64 = 150.0;
// The nuisance field's reach: walking within ~a σ of a highway or el is unpleasant.
const HIGHWAY_SIGMA_METERS: f64 = 35.0;
// The commercial-frontage reach: tight enough that the reward lands on the qualifying block's own
// street and its sidewalks, not a parallel residential block ~a σ or two over.
const COMMERCIAL_SIGMA_METERS: f64 = 20.0;

pub struct PoiParams {
    pub sigma_meters: f64,
    pub saturation: f64,
}

/// The finished walking graph as flat slices, everything the scenic passes need. Coordinates are
/// the quantized graph units; `mpu_*` convert a unit to metres at the origin latitude.
pub struct Network<'a> {
    pub node_x: &'a [i32],
    pub node_y: &'a [i32],
    pub csr: &'a [u32],       // node n owns half-edges [csr[n], csr[n + 1])
    pub adjacency: &'a [u32], // edge ids, indexed by the CSR
    pub edge_a: &'a [u32],
    pub edge_b: &'a [u32],
    pub edge_len_m: &'a [f64],
    pub origin_lng: f64,
    pub origin_lat: f64,
    pub scale: f64,
    pub mpu_lng: f64, // metres per quantized x unit at the origin latitude
    pub mpu_lat: f64, // metres per quantized y unit
}

impl Network<'_> {
    fn node_count(&self) -> usize {
        self.node_x.len()
    }

    fn edge_count(&self) -> usize {
        self.edge_a.len()
    }

    fn node_metres(&self, node: u32) -> (f64, f64) {
        (
            f64::from(self.node_x[node as usize]) * self.mpu_lng,
            f64::from(self.node_y[node as usize]) * self.mpu_lat,
        )
    }

    fn coord_metres(&self, coord: Coord) -> (f64, f64) {
        (
            (coord.lng - self.origin_lng) / self.scale * self.mpu_lng,
            (coord.lat - self.origin_lat) / self.scale * self.mpu_lat,
        )
    }
}

// A min-heap entry for the fan-out Dijkstra: ordered so the smallest distance pops first.
struct HeapItem {
    dist: f64,
    node: u32,
}

impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.dist == other.dist
    }
}
impl Eq for HeapItem {}
impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other.dist.total_cmp(&self.dist) // reversed: BinaryHeap is a max-heap
    }
}
impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A grid of node ids in metre space, cells `cell_meters` on a side, for a nearest-node snap.
fn node_grid(net: &Network, cell_meters: f64) -> HashMap<(i32, i32), Vec<u32>> {
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for node in 0..net.node_count() {
        let (x, y) = net.node_metres(node as u32);
        grid.entry((
            (x / cell_meters).floor() as i32,
            (y / cell_meters).floor() as i32,
        ))
        .or_default()
        .push(node as u32);
    }
    grid
}

pub struct PoiStats {
    pub snapped: usize,
    pub max_byte: u8,
}

/// The per-edge amenity byte for one POI mood. Each point snaps to the nearest walking node within
/// `POI_SNAP_RADIUS_METERS`; a bounded Dijkstra out to `FANOUT_SIGMAS·σ` deposits `e^{-(d/σ)²/2}` on
/// every edge reached (`d` = the network distance to the edge's near end); the summed field
/// saturates `1 - e^{-k·field}`. Sequential — a few thousand small balls, each cheap.
pub fn poi_amenity(net: &Network, params: &PoiParams, pois: &[Coord]) -> (Vec<u8>, PoiStats) {
    let node_count = net.node_count();
    let edge_count = net.edge_count();
    let grid = node_grid(net, POI_SNAP_RADIUS_METERS.max(1.0));
    let cell = POI_SNAP_RADIUS_METERS.max(1.0);
    let radius = params.sigma_meters * FANOUT_SIGMAS;
    let inv_two_sigma2 = 1.0 / (2.0 * params.sigma_meters * params.sigma_meters);

    let mut acc = vec![0.0f64; edge_count];
    let mut dist = vec![f64::INFINITY; node_count];
    let mut touched: Vec<u32> = Vec::new();
    // Dedups an edge within one POI's fan-out (an edge is seen from both its endpoints): stamped
    // with the POI index the first time it is deposited on.
    let mut edge_stamp = vec![u32::MAX; edge_count];
    let mut heap: BinaryHeap<HeapItem> = BinaryHeap::new();
    let mut snapped = 0usize;

    for (index, poi) in pois.iter().enumerate() {
        let (px, py) = net.coord_metres(*poi);
        let (cx, cy) = ((px / cell).floor() as i32, (py / cell).floor() as i32);
        let mut nearest: Option<(u32, f64)> = None;
        for gx in cx - 1..=cx + 1 {
            for gy in cy - 1..=cy + 1 {
                for &node in grid.get(&(gx, gy)).into_iter().flatten() {
                    let (nx, ny) = net.node_metres(node);
                    let metres = (nx - px).hypot(ny - py);
                    if nearest.is_none_or(|(_, best)| metres < best) {
                        nearest = Some((node, metres));
                    }
                }
            }
        }
        let start = match nearest {
            Some((node, metres)) if metres <= POI_SNAP_RADIUS_METERS => node,
            _ => continue,
        };
        snapped += 1;

        let stamp = index as u32;
        dist[start as usize] = 0.0;
        touched.push(start);
        heap.push(HeapItem {
            dist: 0.0,
            node: start,
        });
        while let Some(HeapItem { dist: d, node }) = heap.pop() {
            if d > dist[node as usize] {
                continue; // a stale heap entry, already improved
            }
            let base = net.csr[node as usize] as usize;
            let end = net.csr[node as usize + 1] as usize;
            for &edge in &net.adjacency[base..end] {
                let edge = edge as usize;
                // Deposit once per POI, keyed on the edge's near end (both ends give the same min).
                if edge_stamp[edge] != stamp {
                    edge_stamp[edge] = stamp;
                    let near = dist[net.edge_a[edge] as usize].min(dist[net.edge_b[edge] as usize]);
                    acc[edge] += (-near * near * inv_two_sigma2).exp();
                }
                let other = if net.edge_a[edge] == node {
                    net.edge_b[edge]
                } else {
                    net.edge_a[edge]
                } as usize;
                let stepped = d + net.edge_len_m[edge];
                if stepped <= radius && stepped < dist[other] {
                    if dist[other].is_infinite() {
                        touched.push(other as u32);
                    }
                    dist[other] = stepped;
                    heap.push(HeapItem {
                        dist: stepped,
                        node: other as u32,
                    });
                }
            }
        }
        for &node in &touched {
            dist[node as usize] = f64::INFINITY;
        }
        touched.clear();
        heap.clear();
    }

    let mut bytes = vec![0u8; edge_count];
    let mut max_byte = 0u8;
    for (byte, total) in bytes.iter_mut().zip(&acc) {
        let amenity = 1.0 - (-params.saturation * total).exp();
        *byte = round_half_up(amenity * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
    }
    (bytes, PoiStats { snapped, max_byte })
}

fn point_segment_dist2(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let length2 = dx * dx + dy * dy;
    let t = if length2 > 0.0 {
        ((px - ax) * dx + (py - ay) * dy) / length2
    } else {
        0.0
    }
    .clamp(0.0, 1.0);
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    (px - cx).powi(2) + (py - cy).powi(2)
}

/// The per-edge nuisance-penalty byte: `e^{-(d/σ)²/2}` of the metre distance `d` from the edge to
/// the nearest highway or elevated-rail segment. A later phase reads it as a `1 + w·attr` penalty.
pub fn highway_penalty(net: &Network, lines: &[Polygon]) -> (Vec<u8>, u8) {
    line_proximity(net, lines, HIGHWAY_SIGMA_METERS)
}

/// The per-edge commercial-frontage byte, the same proximity field as the highway penalty but over
/// the qualifying commercial-block lines and read as a `1 - w·attr` DISCOUNT: an edge running along a
/// nice commercial street reads high, so the router will prefer it. Tight σ keeps it off parallel blocks.
pub fn commercial_amenity(net: &Network, lines: &[Polygon]) -> (Vec<u8>, u8) {
    line_proximity(net, lines, COMMERCIAL_SIGMA_METERS)
}

/// The per-edge proximity byte to a set of lines: `e^{-(d/σ)²/2}` of the metre distance `d` from the
/// edge to the nearest line segment. The edge is sampled at its two endpoints and its midpoint, and
/// the nearest of the three stands for it — if any part runs near a line, the whole edge reads near.
/// Each `Polygon` is one line as a single ring. The caller decides whether the byte is a discount or
/// a penalty. Returns the bytes and their max.
fn line_proximity(net: &Network, lines: &[Polygon], sigma_meters: f64) -> (Vec<u8>, u8) {
    let mut segments: Vec<(f64, f64, f64, f64)> = Vec::new();
    for polygon in lines {
        for ring in polygon {
            for pair in ring.windows(2) {
                let (ax, ay) = net.coord_metres(pair[0]);
                let (bx, by) = net.coord_metres(pair[1]);
                segments.push((ax, ay, bx, by));
            }
        }
    }
    let search = sigma_meters * FANOUT_SIGMAS;
    let cell = search.max(1.0);
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (index, &(ax, ay, bx, by)) in segments.iter().enumerate() {
        let gx0 = (ax.min(bx) / cell).floor() as i32;
        let gx1 = (ax.max(bx) / cell).floor() as i32;
        let gy0 = (ay.min(by) / cell).floor() as i32;
        let gy1 = (ay.max(by) / cell).floor() as i32;
        for gx in gx0..=gx1 {
            for gy in gy0..=gy1 {
                grid.entry((gx, gy)).or_default().push(index as u32);
            }
        }
    }
    let inv_two_sigma2 = 1.0 / (2.0 * sigma_meters * sigma_meters);

    let mut bytes = vec![0u8; net.edge_count()];
    let mut max_byte = 0u8;
    for (edge, byte) in bytes.iter_mut().enumerate() {
        let (ax, ay) = net.node_metres(net.edge_a[edge]);
        let (bx, by) = net.node_metres(net.edge_b[edge]);
        let samples = [(ax, ay), ((ax + bx) / 2.0, (ay + by) / 2.0), (bx, by)];
        let mut nearest2 = f64::INFINITY;
        for &(px, py) in &samples {
            let (cx, cy) = ((px / cell).floor() as i32, (py / cell).floor() as i32);
            for gx in cx - 1..=cx + 1 {
                for gy in cy - 1..=cy + 1 {
                    for &index in grid.get(&(gx, gy)).into_iter().flatten() {
                        let (sx, sy, tx, ty) = segments[index as usize];
                        let d2 = point_segment_dist2(px, py, sx, sy, tx, ty);
                        if d2 < nearest2 {
                            nearest2 = d2;
                        }
                    }
                }
            }
        }
        let proximity = if nearest2.is_finite() {
            (-nearest2 * inv_two_sigma2).exp()
        } else {
            0.0
        };
        *byte = round_half_up(proximity * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
    }
    (bytes, max_byte)
}
