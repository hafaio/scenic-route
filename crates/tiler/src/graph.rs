//! `tiler graph`: contracts STRT v4 into the pedestrian routing graph the client searches —
//! intersection nodes, edges carrying a geodesic length, per-side aggregated cover and a pruned
//! polyline — and writes it as GRPH v1 to public/routing/<id>.bin. The tile pyramid and the
//! street chunks draw every walkable segment; this drops the vehicular-only ones and collapses
//! the shape joints, so a router settles a cross-borough query in tens of milliseconds. See
//! scripts/README.md.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::Fallible;
use crate::binfmt::{self, SIDES, write_varint, zigzag};
use crate::geometry::round_half_up;
use crate::kde::METERS_PER_DEGREE_LAT;
use crate::sidewalks::{self, FLAG_NON_VEHICULAR};

// STRT record flags (byte 23). FLAG_NON_VEHICULAR lives in sidewalks.rs, where the chunk offsets
// already consume it; these two were deferred from Phase 1 because a binary crate's `clippy -D
// warnings` rejects an unused `pub const`, and their only consumer is here.
pub const FLAG_VEHICULAR_ONLY: u8 = 1 << 0;
pub const FLAG_STRUCTURE: u8 = 1 << 2;

// GRPH edge flags, distinct from the STRT record flags above. Contraction requires equal GRPH
// flags, so they never mix within one edge.
const GRPH_STRUCTURE: u8 = 1 << 0; // on a bridge or tunnel deck
const GRPH_STEPS: u8 = 1 << 1; // a step street (rw_type 7)
const GRPH_PATHLIKE: u8 = 1 << 2; // offset 0: boardwalk, path, steps, or a non-vehicular deck

const GRAPH_FORMAT: u16 = 1;
const GRAPH_HEADER_BYTES: usize = 64;
const DECIMETERS_PER_METER: f64 = 10.0; // the half-offset byte's unit, as the chunk uses
const STEP_STREET: u8 = 7;
// The chunk offset uses the manifest's sidewalkInsetMeters; graph.rs takes only --streets/--out,
// so it mirrors that value here. It never turns a width-based offset into 0, and the path-like
// road types return 0 regardless, so the PATHLIKE classification does not depend on it — only the
// exact decimetre byte does, and this keeps it identical to the chunk the street layer draws.
const SIDEWALK_INSET_METERS: f64 = 2.0;

const MERGE_RADIUS_METERS: f64 = 1.0; // CSCL digitization slivers, mopped up after exact noding
const GRID_METERS: f64 = 3.0; // near-miss bucket size; a 3x3 scan then covers the merge radius
const PRUNE_DEVIATION_UNITS: f64 = 1.5; // ~0.15 m; the ingest's 25 m densification is pure lerp
const MAX_EDGE_VERTICES: usize = u16::MAX as usize; // a guard on the merged polyline, never a limit

pub struct Args {
    pub streets: PathBuf,
    pub out: PathBuf,
}

/// One edge, before and after contraction: the polyline runs a -> b with its endpoints pinned to
/// the node coordinates, the cover sides are in that travel direction, and the length is the sum
/// of the constituent STRT records' f32 geodesic lengths — never recomputed from the geometry.
struct Edge {
    a: u32,
    b: u32,
    poly_x: Vec<i32>,
    poly_y: Vec<i32>,
    length: f32,
    cover_left: u8,
    cover_right: u8,
    offset: u8,
    flags: u8,
}

fn find(parent: &mut [u32], start: u32) -> u32 {
    let mut node = start;
    while parent[node as usize] != node {
        parent[node as usize] = parent[parent[node as usize] as usize];
        node = parent[node as usize];
    }
    node
}

// The smaller id becomes the root, so a merged near-node keeps the coordinates of the lower id.
fn union(parent: &mut [u32], left: u32, right: u32) -> bool {
    let root_left = find(parent, left);
    let root_right = find(parent, right);
    if root_left == root_right {
        false
    } else {
        let (low, high) = (root_left.min(root_right), root_left.max(root_right));
        parent[high as usize] = low;
        true
    }
}

/// The length-weighted trapezoid of the vertex cover bytes on each side, in the stored direction:
/// one value per sidewalk for a whole segment, computed on the original bytes before any merging.
fn segment_cover(
    densities: &[u8],
    quantized_x: &[i32],
    quantized_y: &[i32],
    from: usize,
    to: usize,
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> (u8, u8) {
    let mut total = 0.0;
    let mut left = 0.0;
    let mut right = 0.0;
    for vertex in from..to - 1 {
        let delta_x =
            f64::from(quantized_x[vertex + 1] - quantized_x[vertex]) * meters_per_unit_lng;
        let delta_y =
            f64::from(quantized_y[vertex + 1] - quantized_y[vertex]) * meters_per_unit_lat;
        let length = delta_x.hypot(delta_y);
        let left_pair =
            f64::from(densities[SIDES * vertex]) + f64::from(densities[SIDES * (vertex + 1)]);
        let right_pair = f64::from(densities[SIDES * vertex + 1])
            + f64::from(densities[SIDES * (vertex + 1) + 1]);
        left += length * left_pair / 2.0;
        right += length * right_pair / 2.0;
        total += length;
    }
    if total > 0.0 {
        (
            round_half_up(left / total) as u8,
            round_half_up(right / total) as u8,
        )
    } else {
        (densities[SIDES * from], densities[SIDES * from + 1])
    }
}

// Exactly two incident half-edges on two distinct edges, matching in both the half-offset byte and
// the GRPH flags: a shape joint the router does not need to see.
fn contractible(edges: &[Edge], incidence: &[Vec<u32>], node: u32) -> bool {
    let incident = &incidence[node as usize];
    incident.len() == 2
        && incident[0] != incident[1]
        && edges[incident[0] as usize].offset == edges[incident[1] as usize].offset
        && edges[incident[0] as usize].flags == edges[incident[1] as usize].flags
}

/// Walk the chain of degree-2 nodes out of `start` along `first_edge`, merging edges as long as
/// the far node stays contractible, and emit the single edge that spans it. Each part is oriented
/// to flow from the running end; a reversed part swaps its two cover sides. The merged cover is the
/// length-weighted mean of the parts, the length is their f32 sum, and the shared junction vertex
/// is dropped where two parts meet.
fn trace_chain(
    edges: &[Edge],
    incidence: &[Vec<u32>],
    visited: &mut [bool],
    start: u32,
    first_edge: u32,
) -> Edge {
    let offset = edges[first_edge as usize].offset;
    let flags = edges[first_edge as usize].flags;
    let mut poly_x: Vec<i32> = Vec::new();
    let mut poly_y: Vec<i32> = Vec::new();
    let mut length = 0.0f32;
    let mut total_weight = 0.0f64;
    let mut left_weighted = 0.0f64;
    let mut right_weighted = 0.0f64;
    let mut current = start;
    let mut edge_id = first_edge;
    loop {
        let edge = &edges[edge_id as usize];
        visited[edge_id as usize] = true;
        let (part_x, part_y, far, left, right) = if edge.a == current {
            (
                edge.poly_x.clone(),
                edge.poly_y.clone(),
                edge.b,
                edge.cover_left,
                edge.cover_right,
            )
        } else {
            let mut reversed_x = edge.poly_x.clone();
            let mut reversed_y = edge.poly_y.clone();
            reversed_x.reverse();
            reversed_y.reverse();
            (
                reversed_x,
                reversed_y,
                edge.a,
                edge.cover_right,
                edge.cover_left,
            )
        };
        if poly_x.is_empty() {
            poly_x.extend_from_slice(&part_x);
            poly_y.extend_from_slice(&part_y);
        } else {
            poly_x.extend_from_slice(&part_x[1..]);
            poly_y.extend_from_slice(&part_y[1..]);
        }
        length += edge.length;
        total_weight += f64::from(edge.length);
        left_weighted += f64::from(edge.length) * f64::from(left);
        right_weighted += f64::from(edge.length) * f64::from(right);
        current = far;

        if !contractible(edges, incidence, current) {
            break;
        }
        let incident = &incidence[current as usize];
        let next = if incident[0] == edge_id {
            incident[1]
        } else {
            incident[0]
        };
        // A chain that closes back onto an edge already in it is a pure degree-2 cycle; stop and
        // let it be emitted as a self-loop on the node this trace retained.
        if visited[next as usize] {
            break;
        }
        // Unreachable for the current data (the longest merged polyline is ~84 vertices), but the
        // format caps a vertex count at u16, so the guard is honoured rather than assumed away.
        if poly_x.len() + edges[next as usize].poly_x.len() - 1 > MAX_EDGE_VERTICES {
            break;
        }
        edge_id = next;
    }
    let (cover_left, cover_right) = if total_weight > 0.0 {
        (
            round_half_up(left_weighted / total_weight) as u8,
            round_half_up(right_weighted / total_weight) as u8,
        )
    } else {
        (0, 0)
    };
    Edge {
        a: start,
        b: current,
        poly_x,
        poly_y,
        length,
        cover_left,
        cover_right,
        offset,
        flags,
    }
}

/// Greedy collinear pruning: drop any interior vertex whose perpendicular deviation from the chord
/// between the last kept vertex and the next one is under ~0.15 m. Endpoints are always kept, so
/// the pinned node coordinates survive. Cover was aggregated before this, so pruning is drawing-
/// only.
fn prune_collinear(xs: &[i32], ys: &[i32]) -> (Vec<i32>, Vec<i32>) {
    let count = xs.len();
    if count <= 2 {
        return (xs.to_vec(), ys.to_vec());
    }
    let mut keep = vec![0usize];
    for vertex in 1..count - 1 {
        let anchor = *keep.last().expect("a kept vertex");
        let chord_x = f64::from(xs[vertex + 1] - xs[anchor]);
        let chord_y = f64::from(ys[vertex + 1] - ys[anchor]);
        let point_x = f64::from(xs[vertex] - xs[anchor]);
        let point_y = f64::from(ys[vertex] - ys[anchor]);
        let cross = (chord_x * point_y - chord_y * point_x).abs();
        let chord = chord_x.hypot(chord_y);
        let deviation = if chord > 0.0 {
            cross / chord
        } else {
            point_x.hypot(point_y)
        };
        if deviation > PRUNE_DEVIATION_UNITS {
            keep.push(vertex);
        }
    }
    keep.push(count - 1);
    (
        keep.iter().map(|&index| xs[index]).collect(),
        keep.iter().map(|&index| ys[index]).collect(),
    )
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_i32(bytes: &mut [u8], offset: usize, value: i32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_f32(bytes: &mut [u8], offset: usize, value: f32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_f64(bytes: &mut [u8], offset: usize, value: f64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

pub fn run(args: &Args) -> Fallible<()> {
    let streets = binfmt::read_streets(&args.streets)?;
    let origin_lng = streets.origin_lng;
    let origin_lat = streets.origin_lat;
    let scale = streets.scale;
    // Equirectangular metres per quantized unit at the origin latitude — one reference latitude
    // for the whole city, as the estimator uses.
    let meters_per_unit_lat = METERS_PER_DEGREE_LAT * scale;
    let meters_per_unit_lng = METERS_PER_DEGREE_LAT * origin_lat.to_radians().cos() * scale;

    // The stored deltas were quantized ints; f64 is exact at this magnitude, so rounding recovers
    // them exactly.
    let quantized_x: Vec<i32> = streets
        .lngs
        .iter()
        .map(|lng| ((lng - origin_lng) / scale).round() as i32)
        .collect();
    let quantized_y: Vec<i32> = streets
        .lats
        .iter()
        .map(|lat| ((lat - origin_lat) / scale).round() as i32)
        .collect();
    let densities = streets.densities();

    // Node the endpoints of every kept segment by exact quantized equality; drop the vehicular-only
    // segments the overlay still draws.
    let mut node_index: HashMap<(i32, i32), u32> = HashMap::new();
    let mut node_x: Vec<i32> = Vec::new();
    let mut node_y: Vec<i32> = Vec::new();
    let mut segment_ends: Vec<(usize, u32, u32)> = Vec::new(); // (segment, node a, node b), raw ids
    let mut dropped_vehicular = 0usize;
    for segment in 0..streets.segments() {
        if streets.flags[segment] & FLAG_VEHICULAR_ONLY != 0 {
            dropped_vehicular += 1;
            continue;
        }
        let from = streets.starts[segment] as usize;
        let to = streets.starts[segment + 1] as usize;
        let mut intern = |key_x: i32, key_y: i32| {
            let next = node_x.len() as u32;
            *node_index.entry((key_x, key_y)).or_insert_with(|| {
                node_x.push(key_x);
                node_y.push(key_y);
                next
            })
        };
        let node_a = intern(quantized_x[from], quantized_y[from]);
        let node_b = intern(quantized_x[to - 1], quantized_y[to - 1]);
        segment_ends.push((segment, node_a, node_b));
    }
    let raw_node_count = node_x.len();

    // Mop up near-misses: bucket the nodes into a ~3 m grid and union any pair within 1 m.
    let cell_units = (GRID_METERS / meters_per_unit_lng).floor().max(1.0) as i32;
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for node in 0..raw_node_count {
        let cell = (
            node_x[node].div_euclid(cell_units),
            node_y[node].div_euclid(cell_units),
        );
        grid.entry(cell).or_default().push(node as u32);
    }
    let mut parent: Vec<u32> = (0..raw_node_count as u32).collect();
    let squared_radius = MERGE_RADIUS_METERS * MERGE_RADIUS_METERS;
    for node in 0..raw_node_count {
        let cell_x = node_x[node].div_euclid(cell_units);
        let cell_y = node_y[node].div_euclid(cell_units);
        for offset_x in -1..=1 {
            for offset_y in -1..=1 {
                let Some(bucket) = grid.get(&(cell_x + offset_x, cell_y + offset_y)) else {
                    continue;
                };
                for &other in bucket {
                    if other as usize <= node {
                        continue;
                    }
                    let delta_x =
                        f64::from(node_x[other as usize] - node_x[node]) * meters_per_unit_lng;
                    let delta_y =
                        f64::from(node_y[other as usize] - node_y[node]) * meters_per_unit_lat;
                    if delta_x * delta_x + delta_y * delta_y <= squared_radius {
                        union(&mut parent, node as u32, other);
                    }
                }
            }
        }
    }

    // Compact the merged nodes; the surviving id carries the smaller original id's coordinates.
    let mut merged_id = vec![u32::MAX; raw_node_count];
    let mut merged_x: Vec<i32> = Vec::new();
    let mut merged_y: Vec<i32> = Vec::new();
    for node in 0..raw_node_count {
        let root = find(&mut parent, node as u32) as usize;
        if merged_id[root] == u32::MAX {
            merged_id[root] = merged_x.len() as u32;
            merged_x.push(node_x[root]);
            merged_y.push(node_y[root]);
        }
        merged_id[node] = merged_id[root];
    }
    let merged_count = merged_x.len();
    let merged_near_nodes = raw_node_count - merged_count;

    // One edge per kept segment, endpoints pinned to the merged node coordinates.
    let mut edges: Vec<Edge> = Vec::with_capacity(segment_ends.len());
    for &(segment, raw_a, raw_b) in &segment_ends {
        let from = streets.starts[segment] as usize;
        let to = streets.starts[segment + 1] as usize;
        let node_a = merged_id[raw_a as usize];
        let node_b = merged_id[raw_b as usize];
        let mut poly_x: Vec<i32> = quantized_x[from..to].to_vec();
        let mut poly_y: Vec<i32> = quantized_y[from..to].to_vec();
        let last = poly_x.len() - 1;
        poly_x[0] = merged_x[node_a as usize];
        poly_y[0] = merged_y[node_a as usize];
        poly_x[last] = merged_x[node_b as usize];
        poly_y[last] = merged_y[node_b as usize];
        let (cover_left, cover_right) = segment_cover(
            densities,
            &quantized_x,
            &quantized_y,
            from,
            to,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        let offset_meters = sidewalks::half_offset_meters(
            streets.road_types[segment],
            streets.flags[segment],
            streets.width_feet[segment],
            SIDEWALK_INSET_METERS,
        );
        let offset = round_half_up(offset_meters * DECIMETERS_PER_METER) as u8;
        let mut flags = 0u8;
        if streets.flags[segment] & FLAG_STRUCTURE != 0 {
            flags |= GRPH_STRUCTURE;
        }
        if streets.road_types[segment] == STEP_STREET {
            flags |= GRPH_STEPS;
        }
        if offset == 0 {
            flags |= GRPH_PATHLIKE;
        }
        edges.push(Edge {
            a: node_a,
            b: node_b,
            poly_x,
            poly_y,
            length: streets.lengths_m[segment],
            cover_left,
            cover_right,
            offset,
            flags,
        });
    }
    // FLAG_NON_VEHICULAR rides in the STRT flags byte and is consumed inside half_offset_meters
    // (an NV deck is drawn on its own line), so the offset byte already carries it; the reference
    // keeps that dependency legible where the router reads the same flags byte.
    let _ = FLAG_NON_VEHICULAR;

    let mut incidence: Vec<Vec<u32>> = vec![Vec::new(); merged_count];
    for (edge_id, edge) in edges.iter().enumerate() {
        incidence[edge.a as usize].push(edge_id as u32);
        incidence[edge.b as usize].push(edge_id as u32);
    }

    // Contract the degree-2 chains. A chain starts at every non-contractible node; whatever edges
    // are left afterwards are pure degree-2 cycles, each emitted as a self-loop on one retained
    // node.
    let mut visited = vec![false; edges.len()];
    let mut final_edges: Vec<Edge> = Vec::new();
    let mut kept_node = vec![false; merged_count];
    for node in 0..merged_count {
        if contractible(&edges, &incidence, node as u32) {
            continue;
        }
        kept_node[node] = true;
        for slot in 0..incidence[node].len() {
            let edge_id = incidence[node][slot];
            if visited[edge_id as usize] {
                continue;
            }
            let edge = trace_chain(&edges, &incidence, &mut visited, node as u32, edge_id);
            kept_node[edge.a as usize] = true;
            kept_node[edge.b as usize] = true;
            final_edges.push(edge);
        }
    }
    for edge_id in 0..edges.len() {
        if visited[edge_id] {
            continue;
        }
        let start = edges[edge_id].a;
        let edge = trace_chain(&edges, &incidence, &mut visited, start, edge_id as u32);
        kept_node[edge.a as usize] = true;
        kept_node[edge.b as usize] = true;
        final_edges.push(edge);
    }
    let contracted_nodes = merged_count - kept_node.iter().filter(|&&kept| kept).count();

    let mut pruned_vertices = 0usize;
    for edge in &mut final_edges {
        let before = edge.poly_x.len();
        let (pruned_x, pruned_y) = prune_collinear(&edge.poly_x, &edge.poly_y);
        pruned_vertices += before - pruned_x.len();
        edge.poly_x = pruned_x;
        edge.poly_y = pruned_y;
    }

    // Components over the contracted graph, relabelled by size descending (0 = largest).
    let mut component_parent: Vec<u32> = (0..merged_count as u32).collect();
    for edge in &final_edges {
        union(&mut component_parent, edge.a, edge.b);
    }
    let mut component_size: HashMap<u32, usize> = HashMap::new();
    for (node, &kept) in kept_node.iter().enumerate() {
        if kept {
            let root = find(&mut component_parent, node as u32);
            *component_size.entry(root).or_insert(0) += 1;
        }
    }
    let mut roots: Vec<(u32, usize)> = component_size.into_iter().collect();
    roots.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    let component_count = roots.len();
    if component_count > u16::MAX as usize + 1 {
        return Err(format!("{component_count} components do not fit a u16 label").into());
    }
    let largest_component = roots.first().map_or(0, |&(_, size)| size);
    let mut component_label: HashMap<u32, u16> = HashMap::with_capacity(component_count);
    for (label, &(root, _)) in roots.iter().enumerate() {
        component_label.insert(root, label as u16);
    }
    let mut node_component_of_merged = vec![0u16; merged_count];
    for (node, &kept) in kept_node.iter().enumerate() {
        if kept {
            let root = find(&mut component_parent, node as u32);
            node_component_of_merged[node] = component_label[&root];
        }
    }

    // Sort the kept nodes by (component, lat, lng), renumber, and remap the edges onto the new ids.
    let mut node_order: Vec<u32> = (0..merged_count as u32)
        .filter(|&node| kept_node[node as usize])
        .collect();
    node_order.sort_by(|&left, &right| {
        node_component_of_merged[left as usize]
            .cmp(&node_component_of_merged[right as usize])
            .then(merged_y[left as usize].cmp(&merged_y[right as usize]))
            .then(merged_x[left as usize].cmp(&merged_x[right as usize]))
    });
    let node_count = node_order.len();
    let mut new_id = vec![u32::MAX; merged_count];
    for (index, &old) in node_order.iter().enumerate() {
        new_id[old as usize] = index as u32;
    }
    let node_lng: Vec<i32> = node_order
        .iter()
        .map(|&old| merged_x[old as usize])
        .collect();
    let node_lat: Vec<i32> = node_order
        .iter()
        .map(|&old| merged_y[old as usize])
        .collect();
    let node_component: Vec<u16> = node_order
        .iter()
        .map(|&old| node_component_of_merged[old as usize])
        .collect();
    for edge in &mut final_edges {
        edge.a = new_id[edge.a as usize];
        edge.b = new_id[edge.b as usize];
    }
    final_edges.sort_by(|left, right| {
        node_component[left.a as usize]
            .cmp(&node_component[right.a as usize])
            .then(left.a.min(left.b).cmp(&right.a.min(right.b)))
    });
    let edge_count = final_edges.len();

    // CSR adjacency of edge ids: node n owns [csr[n], csr[n + 1]); a self-loop lists its edge twice
    // on its node, so the half-edge total is 2E.
    let mut degree = vec![0u32; node_count];
    for edge in &final_edges {
        degree[edge.a as usize] += 1;
        degree[edge.b as usize] += 1;
    }
    let mut csr = vec![0u32; node_count + 1];
    for node in 0..node_count {
        csr[node + 1] = csr[node] + degree[node];
    }
    let mut cursor = csr.clone();
    let mut adjacency = vec![0u32; 2 * edge_count];
    for (edge_id, edge) in final_edges.iter().enumerate() {
        adjacency[cursor[edge.a as usize] as usize] = edge_id as u32;
        cursor[edge.a as usize] += 1;
        adjacency[cursor[edge.b as usize] as usize] = edge_id as u32;
        cursor[edge.b as usize] += 1;
    }

    // The ten pre-write invariants.
    for edge in &final_edges {
        let last = edge.poly_x.len() - 1;
        if edge.poly_x[0] != node_lng[edge.a as usize]
            || edge.poly_y[0] != node_lat[edge.a as usize]
            || edge.poly_x[last] != node_lng[edge.b as usize]
            || edge.poly_y[last] != node_lat[edge.b as usize]
        {
            return Err("an edge polyline does not start and end on its nodes".into());
        }
        if node_component[edge.a as usize] != node_component[edge.b as usize] {
            return Err("an edge joins two components".into());
        }
    }
    if csr[node_count] as usize != 2 * edge_count {
        return Err("the CSR half-edge count is not 2E".into());
    }

    // The geometry blob, then the file. The first delta of every edge is taken from node a's
    // position, so it is (0, 0); the rest are from the previous vertex.
    let mut geometry: Vec<u8> = Vec::new();
    let mut geometry_offsets: Vec<u32> = Vec::with_capacity(edge_count);
    for edge in &final_edges {
        geometry_offsets.push(geometry.len() as u32);
        let mut previous_x = i64::from(node_lng[edge.a as usize]);
        let mut previous_y = i64::from(node_lat[edge.a as usize]);
        for (&vertex_x, &vertex_y) in edge.poly_x.iter().zip(&edge.poly_y) {
            write_varint(&mut geometry, zigzag(i64::from(vertex_x) - previous_x));
            write_varint(&mut geometry, zigzag(i64::from(vertex_y) - previous_y));
            previous_x = i64::from(vertex_x);
            previous_y = i64::from(vertex_y);
        }
    }

    let component_pad = if node_count % 2 == 1 { 2 } else { 0 };
    let node_lng_offset = GRAPH_HEADER_BYTES;
    let node_lat_offset = node_lng_offset + 4 * node_count;
    let node_component_offset = node_lat_offset + 4 * node_count;
    let csr_offset = node_component_offset + 2 * node_count + component_pad;
    let adjacency_offset = csr_offset + 4 * (node_count + 1);
    let edges_offset = adjacency_offset + 8 * edge_count;
    let geometry_offset = edges_offset + 24 * edge_count;

    let mut bytes = vec![0u8; geometry_offset];
    bytes[0..4].copy_from_slice(b"GRPH");
    put_u16(&mut bytes, 4, GRAPH_FORMAT);
    put_u16(&mut bytes, 6, GRAPH_HEADER_BYTES as u16);
    put_u32(&mut bytes, 8, node_count as u32);
    put_u32(&mut bytes, 12, edge_count as u32);
    put_f64(&mut bytes, 16, origin_lng);
    put_f64(&mut bytes, 24, origin_lat);
    put_f64(&mut bytes, 32, scale);
    put_u32(&mut bytes, 40, component_count as u32);
    put_u32(&mut bytes, 44, geometry_offset as u32);
    put_u32(&mut bytes, 48, geometry.len() as u32);

    for (index, &value) in node_lng.iter().enumerate() {
        put_i32(&mut bytes, node_lng_offset + 4 * index, value);
    }
    for (index, &value) in node_lat.iter().enumerate() {
        put_i32(&mut bytes, node_lat_offset + 4 * index, value);
    }
    for (index, &value) in node_component.iter().enumerate() {
        put_u16(&mut bytes, node_component_offset + 2 * index, value);
    }
    for (index, &value) in csr.iter().enumerate() {
        put_u32(&mut bytes, csr_offset + 4 * index, value);
    }
    for (index, &value) in adjacency.iter().enumerate() {
        put_u32(&mut bytes, adjacency_offset + 4 * index, value);
    }
    for (edge_id, edge) in final_edges.iter().enumerate() {
        let record = edges_offset + 24 * edge_id;
        put_u32(&mut bytes, record, edge.a);
        put_u32(&mut bytes, record + 4, edge.b);
        put_f32(&mut bytes, record + 8, edge.length);
        put_u32(&mut bytes, record + 12, geometry_offsets[edge_id]);
        put_u16(&mut bytes, record + 16, edge.poly_x.len() as u16);
        bytes[record + 18] = edge.cover_left;
        bytes[record + 19] = edge.cover_right;
        bytes[record + 20] = edge.offset;
        bytes[record + 21] = edge.flags;
    }
    bytes.extend_from_slice(&geometry);

    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, &bytes)?;

    let total_km: f64 = final_edges
        .iter()
        .map(|edge| f64::from(edge.length))
        .sum::<f64>()
        / 1000.0;
    let largest_fraction = if node_count > 0 {
        largest_component as f64 / node_count as f64
    } else {
        0.0
    };
    let stats = serde_json::json!({
        "nodes": node_count,
        "edges": edge_count,
        "components": component_count,
        "largestComponentFraction": largest_fraction,
        "droppedVehicularOnly": dropped_vehicular,
        "mergedNearNodes": merged_near_nodes,
        "contractedNodes": contracted_nodes,
        "prunedVertices": pruned_vertices,
        "totalKm": total_km,
        "bytes": bytes.len(),
    });
    println!("{}", serde_json::to_string(&stats)?);
    Ok(())
}
