//! `tiler graph`: contracts STRT v5 into the pedestrian routing graph the client searches, then
//! expands every street into the two sidewalks a walker uses, joined at corner nodes, with derived
//! crossings at real intersections and paths stitched in by links — and writes it as GRPH v3 to
//! public/routing/<id>.bin. Ferry terminals snap to the nearest walking node so a ferry edge joins the
//! two boroughs it serves. The tile pyramid and the street chunks draw every walkable segment;
//! this drops the vehicular-only ones, collapses the shape joints, and turns "which side" from a
//! display choice into topology, so a router settles a cross-borough query in tens of
//! milliseconds. v4 bakes three scenic-factor bytes per edge (landmark and public-art amenity
//! discounts, a highway/rail nuisance penalty) via `scenic.rs`. See scripts/README.md.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use crate::Fallible;
use crate::binfmt::{self, SIDES, write_varint, zigzag};
use crate::conflate::{self, ProtoEdge};
use crate::corners::{self, EdgeEnd};
use crate::geometry::{METERS_PER_DEGREE_LAT, round_half_up};
use crate::scenic;
use crate::shade;
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
// Written into the final edge record's flags byte (byte 23, bit 3): an OSM-sourced path edge, as
// against a CSCL-derived one. The client masks the bits it reads; the verification harness reads
// this. Provenance rides in `Edge::osm` through construction and only lands in the byte at write.
const GRPH_OSM: u8 = 1 << 3;

// v3 edge kinds (record byte 22, bits 0-2) and side labels (bits 3-5). A crossing carries no
// geometry and no side; a sidewalk is the only kind with a half-offset and a geometry-right flag; a
// ferry reuses the two cover/half-offset bytes (20-21) to carry a u16 crossing-plus-wait duration.
const KIND_SIDEWALK: u8 = 0;
const KIND_CROSSING: u8 = 1;
const KIND_LINK: u8 = 2;
const KIND_PATH: u8 = 3;
const KIND_FERRY: u8 = 4;
const KIND_MASK: u8 = 0x7;
const SIDE_SHIFT: u8 = 3;
const SIDE_NONE: u8 = 0;
const SIDE_NORTH: u8 = 1;
const SIDE_EAST: u8 = 2;
const SIDE_SOUTH: u8 = 3;
const SIDE_WEST: u8 = 4;
const FLAG_GEOMETRY_RIGHT: u8 = 1 << 2; // this sidewalk lies right of its stored geometry direction

const GRAPH_FORMAT: u16 = 5; // v5 fills the record's last byte with the commercial-frontage attribute
const GRAPH_HEADER_BYTES: usize = 64;
const EDGE_RECORD_BYTES: usize = 28; // 24 + landmark(24), art(25), highway(26), commercial(27)
const NO_GEOMETRY: u32 = 0xFFFF_FFFF; // edge record byte 12 sentinel: straight a->b, no blob entry
const UNNAMED: u16 = 0xFFFF;
const DECIMETERS_PER_METER: f64 = 10.0; // the half-offset byte's unit, as the chunk uses
const STEP_STREET: u8 = 7;
// A sidewalk's baked geometry runs corner-to-corner (the centreline offset to its side, with the
// two end vertices replaced by the corner nodes), so its length is the geodesic sum of that
// polyline; it is clamped up to the straight corner-to-corner distance only if quantization ever
// leaves it a hair short, keeping the A* heuristic admissible. The chord that decides the N/S/E/W
// label degenerates on a tight loop; below this it falls back to the first geometry segment's
// bearing.
const SHORT_CHORD_METERS: f64 = 10.0;
const LENGTH_SLACK_METERS: f32 = 0.5; // f32 length vs great-circle node distance rounding
const EARTH_RADIUS_METERS: f64 = 6_371_000.0; // matches the client's haversineMeters
// The chunk offset uses the manifest's sidewalkInsetMeters; graph.rs takes only --streets/--out,
// so it mirrors that value here. It never turns a width-based offset into 0, and the path-like
// road types return 0 regardless, so the PATHLIKE classification does not depend on it — only the
// exact decimetre byte does, and this keeps it identical to the chunk the street layer draws.
const SIDEWALK_INSET_METERS: f64 = 2.0;

const MERGE_RADIUS_METERS: f64 = 1.0; // CSCL digitization slivers, mopped up after exact noding
const GRID_METERS: f64 = 3.0; // near-miss bucket size; a 3x3 scan then covers the merge radius
const PRUNE_DEVIATION_UNITS: f64 = 1.5; // ~0.15 m; the ingest's 25 m densification is pure lerp
const MAX_EDGE_VERTICES: usize = u16::MAX as usize; // a guard on the merged polyline, never a limit
// A ferry terminal (a pier) sits off the street grid, so its snap to the nearest walking node has a
// looser radius than the node merge; a linear scan over the ~26 stops is well under a millisecond.
const FERRY_SNAP_RADIUS_METERS: f64 = 250.0;

pub struct Args {
    pub streets: PathBuf,
    pub paths: Option<PathBuf>,
    pub ferries: Option<PathBuf>,
    pub landmarks: Option<PathBuf>,
    pub art: Option<PathBuf>,
    pub highways: Option<PathBuf>,
    pub commercial: Option<PathBuf>,
    pub out: PathBuf,
    // The optional SHDE bake: building footprints, the shade sun-position params (the same file
    // `tiler shade` reads), and the directory the per-bin shade files are written to. All three or none.
    pub buildings: Option<PathBuf>,
    pub shade_params: Option<PathBuf>,
    pub shade_dir: Option<PathBuf>,
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
    name_id: u16,
    osm: bool, // OSM-sourced (a conflated path); keeps contraction and island-drop from blending provenance
}

/// One finished v2 edge: a sidewalk, a crossing, a link, or a path. `geom` indexes the shared
/// geometry entries (`NO_GEOMETRY` for the geometry-less crossings and links); `name_id` is still
/// the original STRT id here and is remapped to the compact table at write time.
struct V2Edge {
    a: u32,
    b: u32,
    length: f32,
    geom: u32,
    cover: u8,
    half_offset: u8,
    name_id: u16,
    kind: u8,
    side: u8,
    flags: u8,
}

/// The departure bearing of one edge end: `atan2(north, east)` to the first geometry vertex
/// distinct from the node, in the local metre frame. Ties on a collapsed segment fall back to 0.
fn departure_bearing(
    poly_x: &[i32],
    poly_y: &[i32],
    at_a: bool,
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> f64 {
    let count = poly_x.len();
    let bearing_to = |origin_x: i32, origin_y: i32, other_x: i32, other_y: i32| {
        let east = f64::from(other_x - origin_x) * meters_per_unit_lng;
        let north = f64::from(other_y - origin_y) * meters_per_unit_lat;
        north.atan2(east)
    };
    if at_a {
        let (origin_x, origin_y) = (poly_x[0], poly_y[0]);
        for vertex in 1..count {
            if poly_x[vertex] != origin_x || poly_y[vertex] != origin_y {
                return bearing_to(origin_x, origin_y, poly_x[vertex], poly_y[vertex]);
            }
        }
    } else {
        let (origin_x, origin_y) = (poly_x[count - 1], poly_y[count - 1]);
        for vertex in (0..count - 1).rev() {
            if poly_x[vertex] != origin_x || poly_y[vertex] != origin_y {
                return bearing_to(origin_x, origin_y, poly_x[vertex], poly_y[vertex]);
            }
        }
    }
    0.0
}

/// The N/S/E/W wind a normal points into: nearest cardinal, exact diagonals resolved to N/S, as
/// decision 3 spells out.
fn side_label(normal_x: f64, normal_y: f64) -> u8 {
    if normal_y >= normal_x.abs() {
        SIDE_NORTH
    } else if normal_y <= -normal_x.abs() {
        SIDE_SOUTH
    } else if normal_x > 0.0 {
        SIDE_EAST
    } else {
        SIDE_WEST
    }
}

/// The side labels of a street's two sidewalks, geometry-left then geometry-right. The direction is
/// the whole-edge chord (first to last centreline vertex); a chord that degenerates on a tight loop
/// falls back to the first geometry segment's bearing. The right label is always the opposite wind.
fn side_labels(
    poly_x: &[i32],
    poly_y: &[i32],
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> (u8, u8) {
    let last = poly_x.len() - 1;
    let mut chord_x = f64::from(poly_x[last] - poly_x[0]) * meters_per_unit_lng;
    let mut chord_y = f64::from(poly_y[last] - poly_y[0]) * meters_per_unit_lat;
    if chord_x.hypot(chord_y) < SHORT_CHORD_METERS {
        let bearing = departure_bearing(
            poly_x,
            poly_y,
            true,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        chord_x = bearing.cos();
        chord_y = bearing.sin();
    }
    // The geometry-left normal is the travel direction turned 90 degrees counter-clockwise.
    let left = side_label(-chord_y, chord_x);
    let right = side_label(chord_y, -chord_x);
    (left, right)
}

/// Great-circle metres between two quantized nodes, matching the client's `haversineMeters` (same
/// mean earth radius) so a crossing or link length is exactly the A* heuristic between its ends and
/// the length-vs-node-distance invariant is admissible by construction — the equirectangular metre
/// frame the corners and labels live in overestimates east-west far from the reference latitude.
fn great_circle(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
) -> f64 {
    let lng_from = (origin_lng + f64::from(from_x) * scale).to_radians();
    let lng_to = (origin_lng + f64::from(to_x) * scale).to_radians();
    let lat_from = (origin_lat + f64::from(from_y) * scale).to_radians();
    let lat_to = (origin_lat + f64::from(to_y) * scale).to_radians();
    let sin_lat = ((lat_to - lat_from) / 2.0).sin();
    let sin_lng = ((lng_to - lng_from) / 2.0).sin();
    let inner = sin_lat * sin_lat + lat_from.cos() * lat_to.cos() * sin_lng * sin_lng;
    2.0 * EARTH_RADIUS_METERS * inner.sqrt().min(1.0).asin()
}

fn node_distance(
    node_x: &[i32],
    node_y: &[i32],
    left: u32,
    right: u32,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
) -> f64 {
    great_circle(
        node_x[left as usize],
        node_y[left as usize],
        node_x[right as usize],
        node_y[right as usize],
        origin_lng,
        origin_lat,
        scale,
    )
}

/// The geodesic length of a quantized polyline, summed segment by segment with the same mean earth
/// radius as `node_distance`, so a sidewalk's baked length and the corner-to-corner distance the
/// admissibility check compares it against are measured on one metric.
fn polyline_length(
    poly_x: &[i32],
    poly_y: &[i32],
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
) -> f64 {
    let mut total = 0.0;
    for vertex in 1..poly_x.len() {
        total += great_circle(
            poly_x[vertex - 1],
            poly_y[vertex - 1],
            poly_x[vertex],
            poly_y[vertex],
            origin_lng,
            origin_lat,
            scale,
        );
    }
    total
}

/// The baked geometry of one sidewalk: every interior centreline vertex shifted perpendicular to
/// the local direction by `half_offset_m` to the given side (`sign` +1 geometry-left, -1
/// geometry-right), with the first and last vertices replaced by the sidewalk's two corner nodes so
/// it runs corner-to-corner with no overshoot into the intersection. A straight two-vertex street
/// yields exactly `[corner_a, corner_b]`.
fn offset_polyline(
    poly_x: &[i32],
    poly_y: &[i32],
    half_offset_m: f64,
    sign: f64,
    corner_a: (i32, i32),
    corner_b: (i32, i32),
    meters_per_unit: (f64, f64),
) -> (Vec<i32>, Vec<i32>) {
    let (meters_per_unit_lng, meters_per_unit_lat) = meters_per_unit;
    let count = poly_x.len();
    let mut out_x = Vec::with_capacity(count);
    let mut out_y = Vec::with_capacity(count);
    out_x.push(corner_a.0);
    out_y.push(corner_a.1);
    let same =
        |left: usize, right: usize| poly_x[left] == poly_x[right] && poly_y[left] == poly_y[right];
    for vertex in 1..count - 1 {
        // The tangent runs between the neighbouring distinct vertices, so a coincident vertex does
        // not collapse the normal.
        let mut back = vertex;
        while back > 0 && same(back, vertex) {
            back -= 1;
        }
        let mut ahead = vertex;
        while ahead + 1 < count && same(ahead, vertex) {
            ahead += 1;
        }
        let tangent_east = f64::from(poly_x[ahead] - poly_x[back]) * meters_per_unit_lng;
        let tangent_north = f64::from(poly_y[ahead] - poly_y[back]) * meters_per_unit_lat;
        let length = tangent_east.hypot(tangent_north);
        // The geometry-left normal is the tangent turned 90 degrees counter-clockwise.
        let (normal_east, normal_north) = if length > 0.0 {
            (-tangent_north / length, tangent_east / length)
        } else {
            (0.0, 0.0)
        };
        let east = sign * half_offset_m * normal_east;
        let north = sign * half_offset_m * normal_north;
        out_x.push(poly_x[vertex] + round_half_up(east / meters_per_unit_lng) as i32);
        out_y.push(poly_y[vertex] + round_half_up(north / meters_per_unit_lat) as i32);
    }
    out_x.push(corner_b.0);
    out_y.push(corner_b.1);
    (out_x, out_y)
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

// Exactly two incident half-edges on two distinct edges, matching in the half-offset byte, the
// GRPH flags, and the street name: a shape joint the router does not need to see. A name change
// mid-block is kept — a sidewalk edge that spanned two names would label a lie.
fn contractible(edges: &[Edge], incidence: &[Vec<u32>], node: u32) -> bool {
    let incident = &incidence[node as usize];
    incident.len() == 2
        && incident[0] != incident[1]
        && edges[incident[0] as usize].offset == edges[incident[1] as usize].offset
        && edges[incident[0] as usize].flags == edges[incident[1] as usize].flags
        && edges[incident[0] as usize].name_id == edges[incident[1] as usize].name_id
        && edges[incident[0] as usize].osm == edges[incident[1] as usize].osm
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
    let name_id = edges[first_edge as usize].name_id;
    let osm = edges[first_edge as usize].osm;
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
        name_id,
        osm,
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

// Append `name` to `all_names` if new (deduped through `interned`) and return its u16 id. The ferry
// route and terminal names are not in the STRT/PATH name tables, so they are interned here.
fn intern_name(
    all_names: &mut Vec<String>,
    interned: &mut HashMap<String, u16>,
    name: &str,
) -> u16 {
    if let Some(&id) = interned.get(name) {
        id
    } else {
        let id = all_names.len() as u16;
        all_names.push(name.to_string());
        interned.insert(name.to_string(), id);
        id
    }
}

// The SHDE artifact, one file per sun-position bin so the client fetches only the ~2 bins a given
// time needs: `<dir>/bins.json` lists the bins (index + sun position) and the edge count, and
// `<dir>/<index>.bin` carries that bin's `edge_count` i8 attributes (0 neutral, positive sunnier,
// `attr = byte / 128`). The dir is wiped first so a shrunk bin set leaves no stale files. Each bin
// file is a 12-byte header (magic "SHDB", u16 version, u16 pad, u32 edgeCount) then the i8 row,
// little-endian; `edge_count` matches the GRPH edge count. Layout: scripts/README.md.
fn write_shade(
    dir: &std::path::Path,
    edge_count: usize,
    positions: &[shade::BinPosition],
    attrs: &[i8],
) -> Fallible<()> {
    match fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(dir)?;

    let bins: Vec<serde_json::Value> = positions
        .iter()
        .enumerate()
        .map(|(index, position)| {
            serde_json::json!({
                "index": index,
                "season": position.season,
                "hourAngle": position.hour_angle,
                "elevation": position.elevation,
                "azimuth": position.azimuth,
            })
        })
        .collect();
    let manifest = serde_json::json!({ "edgeCount": edge_count, "bins": bins });
    fs::write(dir.join("bins.json"), serde_json::to_vec(&manifest)?)?;

    const HEADER_BYTES: usize = 12;
    for index in 0..positions.len() {
        let row = &attrs[index * edge_count..index * edge_count + edge_count];
        let mut bytes = vec![0u8; HEADER_BYTES + row.len()];
        bytes[0..4].copy_from_slice(b"SHDB");
        put_u16(&mut bytes, 4, 1); // version
        // byte 6 is a u16 pad (kept zero).
        put_u32(&mut bytes, 8, edge_count as u32);
        // The i8 row reinterpreted into the byte buffer (two's complement, same width).
        for (slot, &attr) in row.iter().enumerate() {
            bytes[HEADER_BYTES + slot] = attr as u8;
        }
        fs::write(dir.join(format!("{index}.bin")), &bytes)?;
    }
    Ok(())
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
    let meters_per_unit = (meters_per_unit_lng, meters_per_unit_lat);

    // Everything is quantized in the streets frame, so the paths (whose PATH file carries its own
    // origin) are re-quantized against the streets origin too — a fraction-of-a-unit rounding, well
    // under the 1 m node merge — and the two networks share one integer grid the conflation compares.
    let quantize_x = |lng: f64| ((lng - origin_lng) / scale).round() as i32;
    let quantize_y = |lat: f64| ((lat - origin_lat) / scale).round() as i32;
    let quantized_x: Vec<i32> = streets.lngs.iter().map(|lng| quantize_x(*lng)).collect();
    let quantized_y: Vec<i32> = streets.lats.iter().map(|lat| quantize_y(*lat)).collect();
    let densities = streets.densities();

    // Street protos: one per walkable (non-vehicular-only) CSCL segment, raw polyline, the per-side
    // cover trapezoid over its original vertex range, and the sidewalk offset/flags — exactly the
    // Edge the pipeline built before, minus the endpoint pinning conflation does after.
    let mut dropped_vehicular = 0usize;
    let mut street_protos: Vec<ProtoEdge> = Vec::new();
    for segment in 0..streets.segments() {
        if streets.flags[segment] & FLAG_VEHICULAR_ONLY != 0 {
            dropped_vehicular += 1;
            continue;
        }
        let from = streets.starts[segment] as usize;
        let to = streets.starts[segment + 1] as usize;
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
        street_protos.push(ProtoEdge {
            poly_x: quantized_x[from..to].to_vec(),
            poly_y: quantized_y[from..to].to_vec(),
            length: streets.lengths_m[segment],
            cover_left,
            cover_right,
            offset,
            flags,
            name_id: streets.name_ids[segment],
            osm: false,
        });
    }
    // FLAG_NON_VEHICULAR rides in the STRT flags byte and is consumed inside half_offset_meters
    // (an NV deck is drawn on its own line), so the offset byte already carries it; the reference
    // keeps that dependency legible where the router reads the same flags byte.
    let _ = FLAG_NON_VEHICULAR;

    // The merged name table is the streets' names followed by the paths' (its ids offset past the
    // street count); path protos carry offset 0 (PATHLIKE), cover from their own density blob, and
    // the OSM provenance bit. When no PATH file is given the graph is byte-identical to before.
    let mut all_names: Vec<String> = streets.names.clone();
    let street_name_count = all_names.len();
    let mut path_protos: Vec<ProtoEdge> = Vec::new();
    if let Some(paths_file) = &args.paths {
        let paths = binfmt::read_paths(paths_file)?;
        if street_name_count + paths.names.len() > UNNAMED as usize {
            return Err(format!(
                "{} street + path names overflow a u16 id",
                street_name_count + paths.names.len()
            )
            .into());
        }
        let path_x: Vec<i32> = paths.lngs.iter().map(|lng| quantize_x(*lng)).collect();
        let path_y: Vec<i32> = paths.lats.iter().map(|lat| quantize_y(*lat)).collect();
        let path_densities = paths.densities();
        for segment in 0..paths.segments() {
            let from = paths.starts[segment] as usize;
            let to = paths.starts[segment + 1] as usize;
            let (cover_left, cover_right) = segment_cover(
                path_densities,
                &path_x,
                &path_y,
                from,
                to,
                meters_per_unit_lng,
                meters_per_unit_lat,
            );
            let mut flags = GRPH_PATHLIKE;
            if paths.flags[segment] & FLAG_STRUCTURE != 0 {
                flags |= GRPH_STRUCTURE;
            }
            if paths.road_types[segment] == STEP_STREET {
                flags |= GRPH_STEPS;
            }
            let name_id = if paths.name_ids[segment] == UNNAMED {
                UNNAMED
            } else {
                paths.name_ids[segment] + street_name_count as u16
            };
            path_protos.push(ProtoEdge {
                poly_x: path_x[from..to].to_vec(),
                poly_y: path_y[from..to].to_vec(),
                length: paths.lengths_m[segment],
                cover_left,
                cover_right,
                offset: 0,
                flags,
                name_id,
                osm: true,
            });
        }
        all_names.extend(paths.names);
    }

    // Conflate the two sources into one segment list, then node it exactly as before.
    let (protos, conflate_stats) = conflate::conflate(street_protos, path_protos, meters_per_unit);

    // Node the endpoints of every proto by exact quantized equality.
    let mut node_index: HashMap<(i32, i32), u32> = HashMap::new();
    let mut node_x: Vec<i32> = Vec::new();
    let mut node_y: Vec<i32> = Vec::new();
    let mut proto_ends: Vec<(u32, u32)> = Vec::with_capacity(protos.len()); // (node a, node b), raw ids
    for proto in &protos {
        let last = proto.poly_x.len() - 1;
        let mut intern = |key_x: i32, key_y: i32| {
            let next = node_x.len() as u32;
            *node_index.entry((key_x, key_y)).or_insert_with(|| {
                node_x.push(key_x);
                node_y.push(key_y);
                next
            })
        };
        let node_a = intern(proto.poly_x[0], proto.poly_y[0]);
        let node_b = intern(proto.poly_x[last], proto.poly_y[last]);
        proto_ends.push((node_a, node_b));
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

    // One edge per proto, endpoints pinned to the merged node coordinates; all other fields (cover,
    // offset, flags, name, provenance) come straight from the conflated proto.
    let mut edges: Vec<Edge> = Vec::with_capacity(protos.len());
    for (proto_index, &(raw_a, raw_b)) in proto_ends.iter().enumerate() {
        let proto = &protos[proto_index];
        let node_a = merged_id[raw_a as usize];
        let node_b = merged_id[raw_b as usize];
        let mut poly_x = proto.poly_x.clone();
        let mut poly_y = proto.poly_y.clone();
        let last = poly_x.len() - 1;
        poly_x[0] = merged_x[node_a as usize];
        poly_y[0] = merged_y[node_a as usize];
        poly_x[last] = merged_x[node_b as usize];
        poly_y[last] = merged_y[node_b as usize];
        edges.push(Edge {
            a: node_a,
            b: node_b,
            poly_x,
            poly_y,
            length: proto.length,
            cover_left: proto.cover_left,
            cover_right: proto.cover_right,
            offset: proto.offset,
            flags: proto.flags,
            name_id: proto.name_id,
            osm: proto.osm,
        });
    }

    let mut incidence: Vec<Vec<u32>> = vec![Vec::new(); merged_count];
    for (edge_id, edge) in edges.iter().enumerate() {
        incidence[edge.a as usize].push(edge_id as u32);
        incidence[edge.b as usize].push(edge_id as u32);
    }

    // A degree-2 joint that matches in offset and flags but not name is the one shape joint
    // contraction now keeps; count it, since it is the only source of extra edges over v1's graph.
    let mut name_break_joints = 0usize;
    for incident in &incidence {
        if incident.len() == 2
            && incident[0] != incident[1]
            && edges[incident[0] as usize].offset == edges[incident[1] as usize].offset
            && edges[incident[0] as usize].flags == edges[incident[1] as usize].flags
            && edges[incident[0] as usize].osm == edges[incident[1] as usize].osm
            && edges[incident[0] as usize].name_id != edges[incident[1] as usize].name_id
        {
            name_break_joints += 1;
        }
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

    // Island drop (decision-3 step 7): a contracted component with no CSCL-sourced edge is an
    // unanchored OSM path net (a playground stub the entrance snap could not reach, or NJ/Westchester
    // leakage the land clip missed) — unreachable in the model and a trap for snaps into dead ends.
    // Remove such components whole, before the base component count, so the v1/v2 parity assertion
    // still measures a partition the downstream construction preserves.
    let mut island_parent: Vec<u32> = (0..merged_count as u32).collect();
    for edge in &final_edges {
        union(&mut island_parent, edge.a, edge.b);
    }
    let mut component_has_cscl: HashMap<u32, bool> = HashMap::new();
    for edge in &final_edges {
        let root = find(&mut island_parent, edge.a);
        let entry = component_has_cscl.entry(root).or_insert(false);
        *entry = *entry || !edge.osm;
    }
    let mut dropped_osm_island_roots: HashSet<u32> = HashSet::new();
    let mut dropped_osm_island_km = 0.0f64;
    let keep_edge: Vec<bool> = final_edges
        .iter()
        .map(|edge| {
            let root = find(&mut island_parent, edge.a);
            if component_has_cscl[&root] {
                true
            } else {
                dropped_osm_island_roots.insert(root);
                dropped_osm_island_km += f64::from(edge.length) / 1000.0;
                false
            }
        })
        .collect();
    let dropped_osm_islands = dropped_osm_island_roots.len();
    let mut kept_edges: Vec<Edge> = Vec::with_capacity(final_edges.len());
    for (edge, keep) in final_edges.into_iter().zip(keep_edge) {
        if keep {
            kept_edges.push(edge);
        }
    }
    let final_edges = kept_edges;

    // The contracted graph's connected components are the v1 partition: every construction step
    // below stays inside one, and the finished v2 graph is asserted to have exactly this many
    // components before writing (decision 6). A node still counts only if a surviving edge touches
    // it, so the dropped islands leave the count.
    let mut base_kept = vec![false; merged_count];
    for edge in &final_edges {
        base_kept[edge.a as usize] = true;
        base_kept[edge.b as usize] = true;
    }
    let mut component_parent: Vec<u32> = (0..merged_count as u32).collect();
    for edge in &final_edges {
        union(&mut component_parent, edge.a, edge.b);
    }
    let mut base_component: HashSet<u32> = HashSet::new();
    for (node, &kept) in base_kept.iter().enumerate() {
        if kept {
            base_component.insert(find(&mut component_parent, node as u32));
        }
    }
    let v1_component_count = base_component.len();

    // Incidence over the contracted edges, each entry an (edge, is-a-end) pair; a self-loop lists
    // both of its ends on the one node it retains.
    let mut incidence2: Vec<Vec<(u32, bool)>> = vec![Vec::new(); merged_count];
    for (edge_id, edge) in final_edges.iter().enumerate() {
        incidence2[edge.a as usize].push((edge_id as u32, true));
        incidence2[edge.b as usize].push((edge_id as u32, false));
    }

    // The v2 nodes (corners, then any path node, per base node) and edges are built here. A street
    // edge's two sidewalk endpoints are the corners its fan assigns at each end, so the fans are
    // built for every base node first (crossings and links, being local to one node, are emitted
    // as they go); the sidewalk and path edges follow once both ends' corners are known.
    let mut v2_x: Vec<i32> = Vec::new();
    let mut v2_y: Vec<i32> = Vec::new();
    let mut v2_edges: Vec<V2Edge> = Vec::new();
    // Per base street edge, the four corner nodes its sidewalks attach to, filled by the fans.
    let mut left_at_a = vec![u32::MAX; final_edges.len()];
    let mut right_at_a = vec![u32::MAX; final_edges.len()];
    let mut left_at_b = vec![u32::MAX; final_edges.len()];
    let mut right_at_b = vec![u32::MAX; final_edges.len()];
    let mut path_node = vec![u32::MAX; merged_count];
    let mut link_pairs: HashMap<(u32, u32), u8> = HashMap::new();
    // (corner a, corner b, crossed edge): a deg-2 street joint's latent crossing, added only if the
    // mop-up finds its two sides in different components.
    let mut mopup_candidates: Vec<(u32, u32, u32)> = Vec::new();
    let mut corner_node_count = 0usize;
    let mut path_node_count = 0usize;
    let mut crossing_count = 0usize;

    let crossing_cover = |edge: &Edge| -> u8 {
        round_half_up((f64::from(edge.cover_left) + f64::from(edge.cover_right)) / 2.0) as u8
    };

    for base in 0..merged_count {
        if incidence2[base].is_empty() {
            continue;
        }
        // Split the incident ends into streets (ordered CCW by bearing) and paths, and gather each
        // street's half-offset in metres for the fan's corner radii.
        let mut street_ends: Vec<(EdgeEnd, f64)> = Vec::new();
        let mut path_ends: Vec<EdgeEnd> = Vec::new();
        for &(edge_id, at_a) in &incidence2[base] {
            let edge = &final_edges[edge_id as usize];
            let bearing = departure_bearing(
                &edge.poly_x,
                &edge.poly_y,
                at_a,
                meters_per_unit_lng,
                meters_per_unit_lat,
            );
            let end = EdgeEnd {
                edge: edge_id,
                at_a,
                bearing,
                pathlike: edge.flags & GRPH_PATHLIKE != 0,
            };
            if end.pathlike {
                path_ends.push(end);
            } else {
                street_ends.push((end, f64::from(edge.offset) / DECIMETERS_PER_METER));
            }
        }
        street_ends.sort_by(|left, right| {
            left.0
                .bearing
                .total_cmp(&right.0.bearing)
                .then(left.0.edge.cmp(&right.0.edge))
                .then(left.0.at_a.cmp(&right.0.at_a))
        });
        path_ends
            .sort_by(|left, right| left.edge.cmp(&right.edge).then(left.at_a.cmp(&right.at_a)));

        let street_count = street_ends.len();
        let degree = incidence2[base].len();
        let mut ends: Vec<EdgeEnd> = Vec::with_capacity(degree);
        let mut half_offsets: Vec<f64> = Vec::with_capacity(degree);
        for &(ref end, offset) in &street_ends {
            ends.push(EdgeEnd {
                edge: end.edge,
                at_a: end.at_a,
                bearing: end.bearing,
                pathlike: false,
            });
            half_offsets.push(offset);
        }
        for end in &path_ends {
            ends.push(EdgeEnd {
                edge: end.edge,
                at_a: end.at_a,
                bearing: end.bearing,
                pathlike: true,
            });
            half_offsets.push(0.0);
        }

        let fan = corners::build_fan(
            merged_x[base],
            merged_y[base],
            &ends,
            &half_offsets,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );

        // The fan's corner slots become v2 nodes; record their ids so the sidewalks, crossings and
        // links can reference them.
        let mut corner_ids: Vec<u32> = Vec::with_capacity(street_count);
        for slot in 0..street_count {
            corner_ids.push(v2_x.len() as u32);
            v2_x.push(fan.corner_x[slot]);
            v2_y.push(fan.corner_y[slot]);
        }
        corner_node_count += street_count;

        for slot in 0..street_count {
            let end = &ends[slot];
            let left = corner_ids[fan.corner_left[slot] as usize];
            let right = corner_ids[fan.corner_right[slot] as usize];
            if end.at_a {
                left_at_a[end.edge as usize] = left;
                right_at_a[end.edge as usize] = right;
            } else {
                left_at_b[end.edge as usize] = left;
                right_at_b[end.edge as usize] = right;
            }
        }

        // Crossings at a real intersection (degree >= 3, at least two streets): one per street,
        // joining the two corners that flank it, carrying its name, cover and structure/steps.
        if street_count >= 2 && degree >= 3 {
            for slot in 0..street_count {
                let crossed = &final_edges[ends[slot].edge as usize];
                let corner_a = corner_ids[fan.corner_right[slot] as usize];
                let corner_b = corner_ids[fan.corner_left[slot] as usize];
                let length = node_distance(
                    &v2_x, &v2_y, corner_a, corner_b, origin_lng, origin_lat, scale,
                );
                v2_edges.push(V2Edge {
                    a: corner_a,
                    b: corner_b,
                    length: length as f32,
                    geom: NO_GEOMETRY,
                    cover: crossing_cover(crossed),
                    half_offset: 0,
                    name_id: crossed.name_id,
                    kind: KIND_CROSSING,
                    side: SIDE_NONE,
                    flags: crossed.flags & (GRPH_STRUCTURE | GRPH_STEPS),
                });
                crossing_count += 1;
            }
        } else if street_count == 2 && degree == 2 {
            // A deg-2 through joint gets no crossing, but an isolated ring of them would split its
            // two sidewalk sides into two components; remember the latent crossing for the mop-up.
            mopup_candidates.push((corner_ids[0], corner_ids[1], ends[0].edge));
        }

        // A base node touched by any path becomes a path node at the old intersection position;
        // links tie it to the corner whose angular gap each path departs into.
        if !path_ends.is_empty() {
            let node = v2_x.len() as u32;
            v2_x.push(merged_x[base]);
            v2_y.push(merged_y[base]);
            path_node[base] = node;
            path_node_count += 1;
            for (path_slot, end) in path_ends.iter().enumerate() {
                if street_count == 0 {
                    continue;
                }
                let corner = corner_ids[fan.path_corner[path_slot] as usize];
                let cover = final_edges[end.edge as usize]
                    .cover_left
                    .max(final_edges[end.edge as usize].cover_right);
                link_pairs.entry((node, corner)).or_insert(cover);
            }
        }
    }

    // Two sidewalks per street edge (each its own baked corner-to-corner geometry, opposite side
    // labels) and one edge per path (its own centreline geometry). Crossings and links carry none.
    let mut geometry_polys: Vec<(Vec<i32>, Vec<i32>)> = Vec::new();
    let mut sidewalk_count = 0usize;
    let mut path_edge_count = 0usize;
    let mut osm_path_edges = 0usize;
    let mut osm_path_km = 0.0f64;
    let mut length_clamped = 0usize;
    let clamp_length = |from: u32, to: u32, straight: f32, counter: &mut usize| -> f32 {
        let distance = node_distance(&v2_x, &v2_y, from, to, origin_lng, origin_lat, scale) as f32;
        if distance > straight {
            *counter += 1;
            distance
        } else {
            straight
        }
    };
    for (edge_id, edge) in final_edges.iter().enumerate() {
        let base_flags = edge.flags & (GRPH_STRUCTURE | GRPH_STEPS);
        if edge.flags & GRPH_PATHLIKE != 0 {
            let node_a = path_node[edge.a as usize];
            let node_b = path_node[edge.b as usize];
            if node_a == u32::MAX || node_b == u32::MAX {
                return Err("a path edge is missing a path node".into());
            }
            let geom = geometry_polys.len() as u32;
            geometry_polys.push((edge.poly_x.clone(), edge.poly_y.clone()));
            // The stored length is the ingest's geodesic sum, but the 1 m node merge nudged the
            // pinned endpoints, so a near-straight path can end a metre or two under the node
            // distance; clamp it up like a sidewalk to keep the heuristic admissible.
            let length = clamp_length(node_a, node_b, edge.length, &mut length_clamped);
            let path_flags = if edge.osm {
                base_flags | GRPH_OSM
            } else {
                base_flags
            };
            v2_edges.push(V2Edge {
                a: node_a,
                b: node_b,
                length,
                geom,
                cover: edge.cover_left.max(edge.cover_right),
                half_offset: 0,
                name_id: edge.name_id,
                kind: KIND_PATH,
                side: SIDE_NONE,
                flags: path_flags,
            });
            path_edge_count += 1;
            if edge.osm {
                osm_path_edges += 1;
                osm_path_km += f64::from(length) / 1000.0;
            }
        } else {
            let left_a = left_at_a[edge_id];
            let right_a = right_at_a[edge_id];
            let left_b = left_at_b[edge_id];
            let right_b = right_at_b[edge_id];
            if left_a == u32::MAX
                || right_a == u32::MAX
                || left_b == u32::MAX
                || right_b == u32::MAX
            {
                return Err("a street edge is missing a corner assignment".into());
            }
            let (left_side, right_side) = side_labels(
                &edge.poly_x,
                &edge.poly_y,
                meters_per_unit_lng,
                meters_per_unit_lat,
            );
            let half_offset_m = f64::from(edge.offset) / DECIMETERS_PER_METER;
            let meters_per_unit = (meters_per_unit_lng, meters_per_unit_lat);
            // The left sidewalk runs cornerLeft(a) -> cornerRight(b), the centreline offset to its
            // geometry-left; the right runs cornerRight(a) -> cornerLeft(b), offset geometry-right.
            // Each bakes its own corners into its geometry so it reaches them without overshoot, and
            // its length is that offset polyline's geodesic sum. Both keep base node a first.
            let left_geom = offset_polyline(
                &edge.poly_x,
                &edge.poly_y,
                half_offset_m,
                1.0,
                (v2_x[left_a as usize], v2_y[left_a as usize]),
                (v2_x[right_b as usize], v2_y[right_b as usize]),
                meters_per_unit,
            );
            let left_baked =
                polyline_length(&left_geom.0, &left_geom.1, origin_lng, origin_lat, scale) as f32;
            let left_length = clamp_length(left_a, right_b, left_baked, &mut length_clamped);
            let left_geom_index = geometry_polys.len() as u32;
            geometry_polys.push(left_geom);
            v2_edges.push(V2Edge {
                a: left_a,
                b: right_b,
                length: left_length,
                geom: left_geom_index,
                cover: edge.cover_left,
                half_offset: edge.offset,
                name_id: edge.name_id,
                kind: KIND_SIDEWALK,
                side: left_side,
                flags: base_flags,
            });
            let right_geom = offset_polyline(
                &edge.poly_x,
                &edge.poly_y,
                half_offset_m,
                -1.0,
                (v2_x[right_a as usize], v2_y[right_a as usize]),
                (v2_x[left_b as usize], v2_y[left_b as usize]),
                meters_per_unit,
            );
            let right_baked =
                polyline_length(&right_geom.0, &right_geom.1, origin_lng, origin_lat, scale) as f32;
            let right_length = clamp_length(right_a, left_b, right_baked, &mut length_clamped);
            let right_geom_index = geometry_polys.len() as u32;
            geometry_polys.push(right_geom);
            v2_edges.push(V2Edge {
                a: right_a,
                b: left_b,
                length: right_length,
                geom: right_geom_index,
                cover: edge.cover_right,
                half_offset: edge.offset,
                name_id: edge.name_id,
                kind: KIND_SIDEWALK,
                side: right_side,
                flags: base_flags | FLAG_GEOMETRY_RIGHT,
            });
            sidewalk_count += 2;
        }
    }

    // Links, one per deduped (path node, corner) pair.
    let link_count = link_pairs.len();
    for (&(node, corner), &cover) in &link_pairs {
        let length = node_distance(&v2_x, &v2_y, node, corner, origin_lng, origin_lat, scale);
        v2_edges.push(V2Edge {
            a: node,
            b: corner,
            length: length as f32,
            geom: NO_GEOMETRY,
            cover,
            half_offset: 0,
            name_id: UNNAMED,
            kind: KIND_LINK,
            side: SIDE_NONE,
            flags: 0,
        });
    }

    // Connectivity mop-up: union-find over the v2 graph, then add a latent crossing at any deg-2
    // joint whose two sides are still separated, until every v1 component's image is whole.
    let v2_node_count = v2_x.len();
    let mut v2_parent: Vec<u32> = (0..v2_node_count as u32).collect();
    for edge in &v2_edges {
        union(&mut v2_parent, edge.a, edge.b);
    }
    let mut mopup_crossings = 0usize;
    for &(corner_a, corner_b, crossed_edge) in &mopup_candidates {
        if find(&mut v2_parent, corner_a) != find(&mut v2_parent, corner_b) {
            let crossed = &final_edges[crossed_edge as usize];
            let length = node_distance(
                &v2_x, &v2_y, corner_a, corner_b, origin_lng, origin_lat, scale,
            );
            v2_edges.push(V2Edge {
                a: corner_a,
                b: corner_b,
                length: length as f32,
                geom: NO_GEOMETRY,
                cover: crossing_cover(crossed),
                half_offset: 0,
                name_id: crossed.name_id,
                kind: KIND_CROSSING,
                side: SIDE_NONE,
                flags: crossed.flags & (GRPH_STRUCTURE | GRPH_STEPS),
            });
            union(&mut v2_parent, corner_a, corner_b);
            mopup_crossings += 1;
        }
    }

    // Components of the finished v2 graph, relabelled by size descending (0 = largest). Parity with
    // the v1 partition is the "fully connected" gate.
    let mut component_size: HashMap<u32, usize> = HashMap::new();
    let mut node_root = vec![0u32; v2_node_count];
    for (node, root_slot) in node_root.iter_mut().enumerate() {
        let root = find(&mut v2_parent, node as u32);
        *root_slot = root;
        *component_size.entry(root).or_insert(0) += 1;
    }
    let component_count = component_size.len();
    if component_count != v1_component_count {
        return Err(format!(
            "v2 has {component_count} components, v1 had {v1_component_count}: the image split"
        )
        .into());
    }
    if component_count > u16::MAX as usize + 1 {
        return Err(format!("{component_count} components do not fit a u16 label").into());
    }
    let mut roots: Vec<(u32, usize)> = component_size.into_iter().collect();
    roots.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    let mut component_label: HashMap<u32, u16> = HashMap::with_capacity(component_count);
    for (label, &(root, _)) in roots.iter().enumerate() {
        component_label.insert(root, label as u16);
    }
    let node_component_of_v2: Vec<u16> =
        node_root.iter().map(|root| component_label[root]).collect();

    // Sort the nodes by (component, lat, lng), renumber, and remap the edges onto the new ids.
    let mut node_order: Vec<u32> = (0..v2_node_count as u32).collect();
    node_order.sort_by(|&left, &right| {
        node_component_of_v2[left as usize]
            .cmp(&node_component_of_v2[right as usize])
            .then(v2_y[left as usize].cmp(&v2_y[right as usize]))
            .then(v2_x[left as usize].cmp(&v2_x[right as usize]))
    });
    let node_count = node_order.len();
    let mut new_id = vec![u32::MAX; v2_node_count];
    for (index, &old) in node_order.iter().enumerate() {
        new_id[old as usize] = index as u32;
    }
    let node_lng: Vec<i32> = node_order.iter().map(|&old| v2_x[old as usize]).collect();
    let node_lat: Vec<i32> = node_order.iter().map(|&old| v2_y[old as usize]).collect();
    let node_component: Vec<u16> = node_order
        .iter()
        .map(|&old| node_component_of_v2[old as usize])
        .collect();
    for edge in &mut v2_edges {
        edge.a = new_id[edge.a as usize];
        edge.b = new_id[edge.b as usize];
    }
    v2_edges.sort_by(|left, right| {
        node_component[left.a as usize]
            .cmp(&node_component[right.a as usize])
            .then(left.a.min(left.b).cmp(&right.a.min(right.b)))
    });

    // Ferries: a final stage, after the walking parity assertion and the node renumber above (both
    // left untouched, so they still validate the walking-only build). Each FERR segment becomes a
    // KIND_FERRY edge between the two walking nodes its terminals snap to; the merged walking-plus-
    // ferry connectivity then relabels the components, joining Staten Island and Governors Island to
    // the main component so the "an edge joins two components" invariant still holds for a ferry edge.
    let mut ferry_edges = 0usize;
    let mut ferry_dropped_unsnapped = 0usize;
    let mut ferry_dropped_same_node = 0usize;
    let mut ferry_dropped_duplicate = 0usize;
    let mut ferry_stops_unsnapped = 0usize;
    // Per ferry edge, the terminal stop name ids (into `all_names`) at its node-a and node-b ends,
    // aligned to `edgeNodeA`/`edgeNodeB`. Written as the byte-60 side table after the geometry blob;
    // these ids are not edge name_ids, so they are added to `used_names` and remapped explicitly.
    let mut ferry_stop_names: Vec<(u32, u16, u16)> = Vec::new();
    let mut ferry_interned: HashMap<String, u16> = HashMap::new();
    if let Some(ferries_file) = &args.ferries {
        let ferries = binfmt::read_ferries(ferries_file)?;

        // Snap each stop to the nearest walking node within the radius; a linear scan over the final
        // nodes is trivial for the ~26 stops. A stop with no node in range drops every segment on it.
        let mut stop_node: Vec<Option<u32>> = Vec::with_capacity(ferries.stops.len());
        for stop in &ferries.stops {
            let stop_x = quantize_x(stop.lng);
            let stop_y = quantize_y(stop.lat);
            let mut nearest: Option<(u32, f64)> = None;
            for node in 0..node_count {
                let metres = great_circle(
                    stop_x,
                    stop_y,
                    node_lng[node],
                    node_lat[node],
                    origin_lng,
                    origin_lat,
                    scale,
                );
                if nearest.is_none_or(|(_, best)| metres < best) {
                    nearest = Some((node as u32, metres));
                }
            }
            match nearest {
                Some((node, metres)) if metres <= FERRY_SNAP_RADIUS_METERS => {
                    stop_node.push(Some(node));
                }
                _ => {
                    ferry_stops_unsnapped += 1;
                    eprintln!(
                        "tiler graph: ferry stop \"{}\" ({:.6}, {:.6}) has no walking node within {FERRY_SNAP_RADIUS_METERS:.0} m; dropping its segments",
                        stop.name, stop.lng, stop.lat
                    );
                    stop_node.push(None);
                }
            }
        }

        // Dedup segments that snap to the same unordered node pair, keeping the smaller raw time.
        let mut best_segment: HashMap<(u32, u32), usize> = HashMap::new();
        for (index, segment) in ferries.segments.iter().enumerate() {
            let (Some(node_a), Some(node_b)) = (
                stop_node[segment.stop_a as usize],
                stop_node[segment.stop_b as usize],
            ) else {
                ferry_dropped_unsnapped += 1;
                continue;
            };
            if node_a == node_b {
                ferry_dropped_same_node += 1;
                continue;
            }
            let key = (node_a.min(node_b), node_a.max(node_b));
            let replace = match best_segment.get(&key).copied() {
                Some(kept) => {
                    ferry_dropped_duplicate += 1;
                    segment.raw_time_seconds < ferries.segments[kept].raw_time_seconds
                }
                None => true,
            };
            if replace {
                best_segment.insert(key, index);
            }
        }

        for &index in best_segment.values() {
            let segment = &ferries.segments[index];
            let node_a = stop_node[segment.stop_a as usize].expect("a kept segment's stop snapped");
            let node_b = stop_node[segment.stop_b as usize].expect("a kept segment's stop snapped");
            // The combined crossing-plus-wait time the later phase costs this leg by, rounded into a
            // u16 of seconds (well under the ~2200 s ceiling) and split across the cover/half-offset
            // bytes at write time.
            let duration = round_half_up(f64::from(segment.raw_time_seconds).max(0.0))
                .min(f64::from(u16::MAX)) as u16;
            let (geom, length) = match &segment.geometry {
                Some(shape) => {
                    // The stored polyline runs node_a -> the FERR interior shape vertices -> node_b, so
                    // its endpoints are exactly the two snapped node coordinates; the shape's own end
                    // vertices are the unsnapped stop coordinates and are dropped.
                    let mut poly_x = vec![node_lng[node_a as usize]];
                    let mut poly_y = vec![node_lat[node_a as usize]];
                    for point in &shape[1..shape.len() - 1] {
                        poly_x.push(quantize_x(point.lng));
                        poly_y.push(quantize_y(point.lat));
                    }
                    poly_x.push(node_lng[node_b as usize]);
                    poly_y.push(node_lat[node_b as usize]);
                    let length =
                        polyline_length(&poly_x, &poly_y, origin_lng, origin_lat, scale) as f32;
                    let geom_index = geometry_polys.len() as u32;
                    geometry_polys.push((poly_x, poly_y));
                    (geom_index, length)
                }
                None => {
                    // A straight leg carries no geometry entry; the client draws the line between its
                    // two node coordinates, so its length is that node distance.
                    let length = node_distance(
                        &node_lng, &node_lat, node_a, node_b, origin_lng, origin_lat, scale,
                    ) as f32;
                    (NO_GEOMETRY, length)
                }
            };
            // The route display name becomes the edge's name (so the client's `edgeName` returns it),
            // and the two terminal stop names go into the side table, aligned to node-a/node-b.
            let name_id = if segment.route_name.is_empty() {
                UNNAMED
            } else {
                intern_name(&mut all_names, &mut ferry_interned, &segment.route_name)
            };
            let a_stop_name = intern_name(
                &mut all_names,
                &mut ferry_interned,
                &ferries.stops[segment.stop_a as usize].name,
            );
            let b_stop_name = intern_name(
                &mut all_names,
                &mut ferry_interned,
                &ferries.stops[segment.stop_b as usize].name,
            );
            let edge_id = v2_edges.len() as u32;
            ferry_stop_names.push((edge_id, a_stop_name, b_stop_name));
            v2_edges.push(V2Edge {
                a: node_a,
                b: node_b,
                length,
                geom,
                cover: (duration & 0x00FF) as u8,
                half_offset: (duration >> 8) as u8,
                name_id,
                kind: KIND_FERRY,
                side: SIDE_NONE,
                flags: 0,
            });
            ferry_edges += 1;
        }
    }

    // Merged walking-plus-ferry connectivity: union-find over every edge, then relabel the components
    // by size descending (0 = largest). This overwrites the walking-only node_component/component_count
    // above, so the ferry-joined boroughs share one component and the pre-write invariant loop's "an
    // edge joins two components" check passes for the ferry edges that caused the merge. A walking
    // edge's two ends shared a component already, so a merge only ever keeps them together.
    let mut merged_parent: Vec<u32> = (0..node_count as u32).collect();
    for edge in &v2_edges {
        union(&mut merged_parent, edge.a, edge.b);
    }
    let mut merged_size: HashMap<u32, usize> = HashMap::new();
    let mut merged_root = vec![0u32; node_count];
    for (node, slot) in merged_root.iter_mut().enumerate() {
        let root = find(&mut merged_parent, node as u32);
        *slot = root;
        *merged_size.entry(root).or_insert(0) += 1;
    }
    let component_count = merged_size.len();
    if component_count > u16::MAX as usize + 1 {
        return Err(format!("{component_count} merged components do not fit a u16 label").into());
    }
    let mut merged_roots: Vec<(u32, usize)> = merged_size.into_iter().collect();
    merged_roots.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    let largest_component = merged_roots.first().map_or(0, |&(_, size)| size);
    let mut merged_label: HashMap<u32, u16> = HashMap::with_capacity(component_count);
    for (label, &(root, _)) in merged_roots.iter().enumerate() {
        merged_label.insert(root, label as u16);
    }
    let node_component: Vec<u16> = merged_root.iter().map(|root| merged_label[root]).collect();

    let edge_count = v2_edges.len();

    // The compact name table: only the names the kept edges reference, re-indexed, sorted by their
    // original id for a stable layout. 0xFFFF stays unnamed.
    let mut used_names: Vec<u16> = v2_edges
        .iter()
        .map(|edge| edge.name_id)
        .filter(|&id| id != UNNAMED)
        .collect();
    // The ferry side-table stop-name ids are not carried by any edge's name_id, so add them here or
    // the compaction below would drop the strings they point at.
    for &(_, a_stop_name, b_stop_name) in &ferry_stop_names {
        used_names.push(a_stop_name);
        used_names.push(b_stop_name);
    }
    used_names.sort_unstable();
    used_names.dedup();
    if used_names.len() > UNNAMED as usize {
        return Err(format!("{} names do not fit a u16 id", used_names.len()).into());
    }
    let mut name_remap: HashMap<u16, u16> = HashMap::with_capacity(used_names.len());
    for (index, &original) in used_names.iter().enumerate() {
        name_remap.insert(original, index as u16);
    }
    // Remap the side-table stop-name ids through the same compaction the edge names use.
    let ferry_side_table: Vec<(u32, u16, u16)> = ferry_stop_names
        .iter()
        .map(|&(edge_id, a_stop_name, b_stop_name)| {
            (edge_id, name_remap[&a_stop_name], name_remap[&b_stop_name])
        })
        .collect();

    // CSR adjacency of edge ids: node n owns [csr[n], csr[n + 1]); a self-loop lists its edge twice
    // on its node, so the half-edge total is 2E.
    let mut degree = vec![0u32; node_count];
    for edge in &v2_edges {
        degree[edge.a as usize] += 1;
        degree[edge.b as usize] += 1;
    }
    let mut csr = vec![0u32; node_count + 1];
    for node in 0..node_count {
        csr[node + 1] = csr[node] + degree[node];
    }
    let mut cursor = csr.clone();
    let mut adjacency = vec![0u32; 2 * edge_count];
    for (edge_id, edge) in v2_edges.iter().enumerate() {
        adjacency[cursor[edge.a as usize] as usize] = edge_id as u32;
        cursor[edge.a as usize] += 1;
        adjacency[cursor[edge.b as usize] as usize] = edge_id as u32;
        cursor[edge.b as usize] += 1;
    }

    // The scenic-factor bytes (GRPH v4): a network-fan-out amenity DISCOUNT for landmark and
    // public-art proximity, and an areal PENALTY for highway / elevated-rail nearness — one per-edge
    // byte each, which a later phase reads into the routing cost. Computed here over the finished
    // walking graph (nodes, edges and CSR are all final); a ferry edge carries none, zeroed at write.
    let edge_a: Vec<u32> = v2_edges.iter().map(|edge| edge.a).collect();
    let edge_b: Vec<u32> = v2_edges.iter().map(|edge| edge.b).collect();
    let edge_len_m: Vec<f64> = v2_edges.iter().map(|edge| f64::from(edge.length)).collect();
    let network = scenic::Network {
        node_x: &node_lng,
        node_y: &node_lat,
        csr: &csr,
        adjacency: &adjacency,
        edge_a: &edge_a,
        edge_b: &edge_b,
        edge_len_m: &edge_len_m,
        origin_lng,
        origin_lat,
        scale,
        mpu_lng: meters_per_unit_lng,
        mpu_lat: meters_per_unit_lat,
    };
    let landmark_bytes = match &args.landmarks {
        Some(path) => {
            let pois = binfmt::read_points(path, "LMRK", binfmt::LANDMARK_FORMAT)?;
            let (bytes, stats) = scenic::poi_amenity(&network, &scenic::LANDMARK_PARAMS, &pois);
            eprintln!(
                "landmarks: {} points, {} snapped, max amenity byte {}",
                pois.len(),
                stats.snapped,
                stats.max_byte
            );
            bytes
        }
        None => vec![0u8; edge_count],
    };
    let art_bytes = match &args.art {
        Some(path) => {
            let pois = binfmt::read_points(path, "ARTW", binfmt::ART_FORMAT)?;
            let (bytes, stats) = scenic::poi_amenity(&network, &scenic::ART_PARAMS, &pois);
            eprintln!(
                "art: {} points, {} snapped, max amenity byte {}",
                pois.len(),
                stats.snapped,
                stats.max_byte
            );
            bytes
        }
        None => vec![0u8; edge_count],
    };
    let highway_bytes = match &args.highways {
        Some(path) => {
            let lines = binfmt::read_polygons(path, "HWAY", binfmt::HIGHWAY_FORMAT)?;
            let (bytes, max_byte) = scenic::highway_penalty(&network, &lines);
            eprintln!(
                "highways: {} nuisance lines, max penalty byte {}",
                lines.len(),
                max_byte
            );
            bytes
        }
        None => vec![0u8; edge_count],
    };
    let commercial_bytes = match &args.commercial {
        Some(path) => {
            let lines = binfmt::read_polygons(path, "CMLN", binfmt::COMMERCIAL_FORMAT)?;
            let (bytes, max_byte) = scenic::commercial_amenity(&network, &lines);
            eprintln!(
                "commercial: {} qualifying lines, max amenity byte {}",
                lines.len(),
                max_byte
            );
            bytes
        }
        None => vec![0u8; edge_count],
    };

    // Pre-write invariants: a stored-geometry edge begins and ends exactly on its node coordinates
    // (a sidewalk is baked corner-to-corner, a path keeps its pinned endpoints), so no geometry
    // overshoots the intersection; every edge is at least as long as its straight-line node
    // distance; no edge joins two components; the CSR total is 2E.
    for edge in &v2_edges {
        if edge.geom != NO_GEOMETRY {
            let (poly_x, poly_y) = &geometry_polys[edge.geom as usize];
            let last = poly_x.len() - 1;
            if poly_x[0] != node_lng[edge.a as usize]
                || poly_y[0] != node_lat[edge.a as usize]
                || poly_x[last] != node_lng[edge.b as usize]
                || poly_y[last] != node_lat[edge.b as usize]
            {
                return Err("an edge geometry does not start and end on its nodes".into());
            }
        }
        let straight = node_distance(
            &node_lng, &node_lat, edge.a, edge.b, origin_lng, origin_lat, scale,
        ) as f32;
        if edge.length + LENGTH_SLACK_METERS < straight {
            return Err("an edge is shorter than its node distance".into());
        }
        if node_component[edge.a as usize] != node_component[edge.b as usize] {
            return Err("an edge joins two components".into());
        }
    }
    if csr[node_count] as usize != 2 * edge_count {
        return Err("the CSR half-edge count is not 2E".into());
    }

    // The geometry blob: one entry per sidewalk and per path edge, its first vertex absolute (delta
    // from the graph origin — kept origin-anchored so the client decoder is unchanged), the rest
    // from the previous vertex.
    let mut geometry: Vec<u8> = Vec::new();
    let mut geometry_offsets: Vec<u32> = Vec::with_capacity(geometry_polys.len());
    for (poly_x, poly_y) in &geometry_polys {
        geometry_offsets.push(geometry.len() as u32);
        let mut previous_x = 0i64;
        let mut previous_y = 0i64;
        for (&vertex_x, &vertex_y) in poly_x.iter().zip(poly_y) {
            write_varint(&mut geometry, zigzag(i64::from(vertex_x) - previous_x));
            write_varint(&mut geometry, zigzag(i64::from(vertex_y) - previous_y));
            previous_x = i64::from(vertex_x);
            previous_y = i64::from(vertex_y);
        }
    }

    // The name table blob: (count + 1) byte offsets, then the UTF-8 names back to back.
    let mut name_blob: Vec<u8> = Vec::new();
    let mut name_offsets: Vec<u32> = Vec::with_capacity(used_names.len() + 1);
    for &original in &used_names {
        name_offsets.push(name_blob.len() as u32);
        name_blob.extend_from_slice(all_names[original as usize].as_bytes());
    }
    name_offsets.push(name_blob.len() as u32);
    let name_table_bytes = 4 + 4 * name_offsets.len() + name_blob.len();

    let align4 = |offset: usize| offset.div_ceil(4) * 4;
    let component_pad = if node_count % 2 == 1 { 2 } else { 0 };
    let node_lng_offset = GRAPH_HEADER_BYTES;
    let node_lat_offset = node_lng_offset + 4 * node_count;
    let node_component_offset = node_lat_offset + 4 * node_count;
    let csr_offset = node_component_offset + 2 * node_count + component_pad;
    let adjacency_offset = csr_offset + 4 * (node_count + 1);
    let edges_offset = adjacency_offset + 8 * edge_count;
    let name_offset = edges_offset + EDGE_RECORD_BYTES * edge_count;
    let geometry_offset = align4(name_offset + name_table_bytes);

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
    put_u32(&mut bytes, 44, name_offset as u32);
    put_u32(&mut bytes, 48, name_table_bytes as u32);
    put_u32(&mut bytes, 52, geometry_offset as u32);
    put_u32(&mut bytes, 56, geometry.len() as u32);

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
    // The cover byte is clamped to 254 so the client's maxCover stays < 1: cost.ts's admissible
    // heuristic collapses (the greenest edge goes free at w = 1) if any edge reads a full 255, which
    // the denser OSM tree field can now reach.
    let mut cover_clamped = 0usize;
    for (edge_id, edge) in v2_edges.iter().enumerate() {
        let record = edges_offset + EDGE_RECORD_BYTES * edge_id;
        let (geom_offset, vertex_count) = if edge.geom == NO_GEOMETRY {
            (NO_GEOMETRY, 0u16)
        } else {
            (
                geometry_offsets[edge.geom as usize],
                geometry_polys[edge.geom as usize].0.len() as u16,
            )
        };
        let name = match name_remap.get(&edge.name_id) {
            Some(&index) => index,
            None => UNNAMED,
        };
        // A ferry carries a u16 duration in bytes 20-21 (edge.cover is its low byte, edge.half_offset
        // its high byte), so the 254 cover clamp — which keeps a real edge's client maxCover < 1 —
        // applies only to the cover-bearing kinds.
        let cover = if edge.kind == KIND_FERRY {
            edge.cover
        } else if edge.cover > 254 {
            cover_clamped += 1;
            254
        } else {
            edge.cover
        };
        put_u32(&mut bytes, record, edge.a);
        put_u32(&mut bytes, record + 4, edge.b);
        put_f32(&mut bytes, record + 8, edge.length);
        put_u32(&mut bytes, record + 12, geom_offset);
        put_u16(&mut bytes, record + 16, vertex_count);
        put_u16(&mut bytes, record + 18, name);
        bytes[record + 20] = cover;
        bytes[record + 21] = edge.half_offset;
        bytes[record + 22] = (edge.kind & KIND_MASK) | (edge.side << SIDE_SHIFT);
        bytes[record + 23] = edge.flags;
        // Scenic-factor bytes (v5): a ferry passes no landmark, art, highway, or commercial frontage,
        // so it keeps the record's default zeros; every walking kind carries the baked attributes.
        if edge.kind != KIND_FERRY {
            bytes[record + 24] = landmark_bytes[edge_id];
            bytes[record + 25] = art_bytes[edge_id];
            bytes[record + 26] = highway_bytes[edge_id];
            bytes[record + 27] = commercial_bytes[edge_id];
        }
    }

    put_u32(&mut bytes, name_offset, used_names.len() as u32);
    for (index, &value) in name_offsets.iter().enumerate() {
        put_u32(&mut bytes, name_offset + 4 + 4 * index, value);
    }
    let name_blob_offset = name_offset + 4 + 4 * name_offsets.len();
    bytes[name_blob_offset..name_blob_offset + name_blob.len()].copy_from_slice(&name_blob);
    bytes.extend_from_slice(&geometry);

    // The ferry endpoint-stop-name side table, 4-aligned after the geometry blob: a u32 count, then
    // per ferry edge a (u32 edge id, u16 a-stop name id, u16 b-stop name id) triple, the ids into
    // the name table above. Its offset rides in the spare header u32 at byte 60 (0-length when the
    // build carried no ferries).
    while bytes.len() % 4 != 0 {
        bytes.push(0);
    }
    let ferry_table_offset = bytes.len() as u32;
    put_u32(&mut bytes, 60, ferry_table_offset);
    bytes.extend_from_slice(&(ferry_side_table.len() as u32).to_le_bytes());
    for &(edge_id, a_stop_name, b_stop_name) in &ferry_side_table {
        bytes.extend_from_slice(&edge_id.to_le_bytes());
        bytes.extend_from_slice(&a_stop_name.to_le_bytes());
        bytes.extend_from_slice(&b_stop_name.to_le_bytes());
    }

    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, &bytes)?;

    // The SHDE artifact (optional): a signed shade attribute per edge per sun-position bin, keyed off
    // the same finalized `v2_edges` order the client reads GRPH records in. Each edge's polyline is
    // recovered in degrees exactly as the pre-write geometry check does — a ferry bakes to neutral,
    // a stored-geometry edge uses its blob, a geometry-less edge its straight node-to-node line.
    if let (Some(buildings_path), Some(shade_params_path), Some(shade_dir_path)) =
        (&args.buildings, &args.shade_params, &args.shade_dir)
    {
        let to_coord = |quantized_x: i32, quantized_y: i32| binfmt::Coord {
            lng: origin_lng + f64::from(quantized_x) * scale,
            lat: origin_lat + f64::from(quantized_y) * scale,
        };
        let edge_polys: Vec<Vec<binfmt::Coord>> = v2_edges
            .iter()
            .map(|edge| {
                if edge.kind == KIND_FERRY {
                    Vec::new()
                } else if edge.geom == NO_GEOMETRY {
                    vec![
                        to_coord(node_lng[edge.a as usize], node_lat[edge.a as usize]),
                        to_coord(node_lng[edge.b as usize], node_lat[edge.b as usize]),
                    ]
                } else {
                    let (poly_x, poly_y) = &geometry_polys[edge.geom as usize];
                    poly_x
                        .iter()
                        .zip(poly_y)
                        .map(|(&quantized_x, &quantized_y)| to_coord(quantized_x, quantized_y))
                        .collect()
                }
            })
            .collect();

        let params: shade::Params = serde_json::from_slice(&fs::read(shade_params_path)?)?;
        let (attr_bytes, positions) = shade::edge_shade_attrs(
            buildings_path,
            &params.buckets,
            params.max_shadow_meters,
            &edge_polys,
        )?;
        assert_eq!(attr_bytes.len(), positions.len() * v2_edges.len());
        write_shade(shade_dir_path, edge_count, &positions, &attr_bytes)?;
        eprintln!(
            "shade: {} bins x {edge_count} edges baked to {}",
            positions.len(),
            shade_dir_path.display()
        );
    }

    let total_km: f64 = v2_edges
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
        "sidewalkEdges": sidewalk_count,
        "crossingEdges": crossing_count,
        "linkEdges": link_count,
        "pathEdges": path_edge_count,
        "cornerNodes": corner_node_count,
        "pathNodes": path_node_count,
        "nameBreakJoints": name_break_joints,
        "mopupCrossings": mopup_crossings,
        "lengthClamped": length_clamped,
        "coverClamped": cover_clamped,
        "dedupedWays": conflate_stats.deduped_ways,
        "dedupedKm": conflate_stats.deduped_km,
        "osmTSplits": conflate_stats.osm_t_splits,
        "weldedVertices": conflate_stats.welded_vertices,
        "entranceSnaps": conflate_stats.entrance_snaps,
        "danglingEnds": conflate_stats.dangling_ends,
        "csclSplits": conflate_stats.cscl_splits,
        "osmWays": conflate_stats.osm_ways,
        "osmKm": conflate_stats.osm_km,
        "droppedOsmIslands": dropped_osm_islands,
        "droppedOsmIslandKm": dropped_osm_island_km,
        "osmPathEdges": osm_path_edges,
        "osmPathKm": osm_path_km,
        "ferryEdges": ferry_edges,
        "ferryStopsUnsnapped": ferry_stops_unsnapped,
        "ferryDroppedUnsnapped": ferry_dropped_unsnapped,
        "ferryDroppedSameNode": ferry_dropped_same_node,
        "ferryDroppedDuplicate": ferry_dropped_duplicate,
        "names": used_names.len(),
        "totalKm": total_km,
        "bytes": bytes.len(),
    });
    println!("{}", serde_json::to_string(&stats)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_per_bin_shade_files() {
        let dir = std::env::temp_dir().join(format!("tiler-shade-test-{}", std::process::id()));
        let positions = vec![
            shade::BinPosition {
                season: 0,
                hour_angle: -45.0,
                elevation: 10.0,
                azimuth: 100.0,
            },
            shade::BinPosition {
                season: 2,
                hour_angle: 15.0,
                elevation: 20.0,
                azimuth: 200.0,
            },
        ];
        let edge_count = 3;
        // Two bins x three edges, row-major; bin 1's row is the last three.
        let attrs: Vec<i8> = vec![1, -2, 3, -4, 5, -6];
        write_shade(&dir, edge_count, &positions, &attrs).expect("write");

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("bins.json")).expect("bins.json")).unwrap();
        assert_eq!(manifest["edgeCount"], 3);
        assert_eq!(manifest["bins"].as_array().unwrap().len(), 2);
        assert_eq!(manifest["bins"][1]["index"], 1);
        assert_eq!(manifest["bins"][1]["azimuth"], 200.0);
        assert_eq!(manifest["bins"][1]["season"], 2);
        assert_eq!(manifest["bins"][1]["hourAngle"], 15.0);

        let bin1 = fs::read(dir.join("1.bin")).expect("1.bin");
        assert_eq!(&bin1[0..4], b"SHDB");
        assert_eq!(u16::from_le_bytes([bin1[4], bin1[5]]), 1);
        assert_eq!(
            u32::from_le_bytes([bin1[8], bin1[9], bin1[10], bin1[11]]),
            3
        );
        assert_eq!(bin1.len(), 12 + 3);
        assert_eq!(
            [bin1[12] as i8, bin1[13] as i8, bin1[14] as i8],
            [-4, 5, -6]
        );

        fs::remove_dir_all(&dir).expect("cleanup");
    }
}
