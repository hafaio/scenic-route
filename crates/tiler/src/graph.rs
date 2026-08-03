//! `tiler graph`: contracts STRT v6 into the pedestrian routing graph the client searches, then
//! places the pavement a walker uses — where OSM maps a sidewalk that way is the edge, a street's
//! own offset is derived only on the sides OSM leaves, the two are joined at corner nodes, a
//! crossing is synthesized at every corner pair OSM does not serve for itself, and paths are
//! stitched in by links — and writes it as GRPH to public/routing/<id>.bin. Ferry terminals snap to
//! the nearest walking node so a ferry edge joins the two boroughs it serves. The tile pyramid and
//! the street chunks draw every walkable segment; this drops the vehicular-only ones, collapses the
//! shape joints, and turns "which side" from a display choice into topology, so a router settles a
//! cross-borough query in tens of milliseconds. v4 bakes three scenic-factor bytes per edge
//! (landmark and public-art amenity discounts, a highway/rail nuisance penalty) via `scenic.rs`. v6
//! adds two things. The direct-canopy byte, via `direct_canopy.rs` — the raw unblurred canopy
//! indicator integrated along each sidewalk, which the smoothed cover byte cannot stand in for. And
//! the durable edge key: a source record id (a CSCL physicalid, or an OSM way id for a conflated
//! path) plus an ordinal that, with the side label already in the record, picks it out within that
//! source.
//!
//! DESIGN.md, "The walking network", is why the pavement is placed the way it is — which source
//! answers which question, what the seam rules are, and what the alternatives cost when they were
//! measured. scripts/README.md is the layout.

use std::collections::{HashMap, HashSet};
use std::f64::consts::TAU;
use std::fs;
use std::ops::ControlFlow;
use std::path::PathBuf;

use crate::Fallible;
use crate::association;
use crate::binfmt::{self, SIDES, write_varint, zigzag};
use crate::conflate::{self, ProtoEdge, SIDEWALK_LEFT, SIDEWALK_RIGHT, swap_sidewalks};
use crate::corners::{self, EdgeEnd};
use crate::direct_canopy;
use crate::geometry::{METERS_PER_DEGREE_LAT, round_half_up};
use crate::scenic;
use crate::shade;
use crate::sidewalks::{self, FLAG_NON_VEHICULAR};

// STRT record flags (byte 23). FLAG_NON_VEHICULAR lives in sidewalks.rs, where the chunk offsets
// already consume it; these two were deferred from Phase 1 because a binary crate's `clippy -D
// warnings` rejects an unused `pub const`, and their only consumer is here.
pub const FLAG_VEHICULAR_ONLY: u8 = 1 << 0;
pub const FLAG_STRUCTURE: u8 = 1 << 2;
// The per-side sidewalk bits `scripts/sidewalks.ts` stamps into every offsetted record: whether OSM
// maps a sidewalk on that side, and whether the city's planimetric ROW-sidewalk polygons draw one.
const FLAG_OSM_LEFT: u8 = 1 << 3;
const FLAG_OSM_RIGHT: u8 = 1 << 4;
const FLAG_SURVEYED_LEFT: u8 = 1 << 5;
const FLAG_SURVEYED_RIGHT: u8 = 1 << 6;

// The existence gate's two guards, checked against the finished build: an implausible drop is a
// STRT file whose per-side bits were never stamped, and a build the gate does not take the alleys in
// has the rule the wrong way round. DESIGN.md, "The existence gate".
const MAX_DROPPED_SIDEWALK_FRACTION: f64 = 0.30;
const MIN_DEMOTED_ALLEY_FRACTION: f64 = 0.95;
const ALLEY: u8 = 10;
// SWLK record byte 20: the kind of OSM way. 21 is a crossing and 22 a traffic island, both of which
// become crossing edges — the island is the middle of the crossing it chains through.
const SWLK_SIDEWALK: u8 = 20;

// GRPH edge flags, distinct from the STRT record flags above. Contraction requires equal GRPH
// flags, so they never mix within one edge.
const GRPH_STRUCTURE: u8 = 1 << 0; // on a bridge or tunnel deck
const GRPH_STEPS: u8 = 1 << 1; // a step street (rw_type 7)
// A walking line the graph takes as drawn rather than offsetting from a centreline: a boardwalk,
// path, steps or non-vehicular deck, a street the gate demoted to its middle, and every OSM way.
// NOT the same as a zero half-offset any more — a matched OSM sidewalk keeps this flag and borrows
// its street's half-offset, which is what the shed's deck depth infers the kerb from.
const GRPH_PATHLIKE: u8 = 1 << 2;
// Written into the final edge record's flags byte (byte 23, bit 3): an OSM-sourced walking edge —
// a path, or a sidewalk or crossing OSM drew — as against a CSCL-derived one. The crossing
// suppression and the invariants feed below both key on it, and the client masks the bits it reads.
// Provenance rides in `Edge::osm` through construction and only lands in the byte at write.
const GRPH_OSM: u8 = 1 << 3;
// Internal only, masked out at write: this walking line has the buildings to its geometry-right, so
// the record it writes carries FLAG_GEOMETRY_RIGHT. A derived sidewalk knows this from which side it
// was offset to; an OSM way is digitized whichever way its mapper drew it, so the association
// measures it. The shed placement reads that flag to know which side of the pavement a frontage is
// on, and a walking line that lies about it places its scaffolding across the road.
const GRPH_BUILDING_RIGHT: u8 = 1 << 4;

// v3 edge kinds (record byte 22, bits 0-2) and side labels (bits 3-5). A crossing carries no side,
// and no geometry unless OSM drew it — a mapped crossing keeps its own polyline, a synthesized one is
// the straight line between its two corners; a sidewalk is the only kind with a half-offset and a
// ferry reuses the two cover/half-offset bytes (20-21) to carry a u16 crossing-plus-wait duration.
pub const KIND_SIDEWALK: u8 = 0;
pub const KIND_CROSSING: u8 = 1;
const KIND_LINK: u8 = 2;
pub const KIND_PATH: u8 = 3;
const KIND_FERRY: u8 = 4;
const KIND_MASK: u8 = 0x7;
const SIDE_SHIFT: u8 = 3;
pub const SIDE_NONE: u8 = 0;
const SIDE_NORTH: u8 = 1;
const SIDE_EAST: u8 = 2;
const SIDE_SOUTH: u8 = 3;
const SIDE_WEST: u8 = 4;
const FLAG_GEOMETRY_RIGHT: u8 = 1 << 2; // this sidewalk lies right of its stored geometry direction

const GRAPH_FORMAT: u16 = 6; // v6 adds the direct-canopy byte and the durable edge key
const GRAPH_HEADER_BYTES: usize = 64;
// 24 + landmark(24), art(25), highway(26), commercial(27), directCanopy(28), sourceId(29..32),
// ordinal(33)
const EDGE_RECORD_BYTES: usize = 34;
// Record bytes 29-33: the source record an edge was derived from (a CSCL physicalid, or an OSM way
// id for a conflated path) and the how-many-th edge of that source, on that side, this is. With the
// side label already in byte 22 the triple (source id, side, ordinal) survives a rebuild, where the
// positional edge id does not.
const NO_SOURCE_ID: u32 = 0xFFFF_FFFF; // no durable identity: a crossing, a link or a ferry
// A long greenway noded and welded against every street it crosses becomes many path edges under one
// source id, and they all carry SIDE_NONE: NYC's worst OSM way reaches 103 (its busiest sidewalk key
// only 25, the two sides splitting that source's edges between them), so the ordinal needs a byte.
const ORDINALS: usize = 256;
const NO_GEOMETRY: u32 = 0xFFFF_FFFF; // edge record byte 12 sentinel: straight a->b, no blob entry
const UNNAMED: u16 = 0xFFFF;
pub const DECIMETERS_PER_METER: f64 = 10.0; // the half-offset byte's unit, as the chunk uses
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
// The seam radius: how far from where a corner would be placed OSM's own corner may stand and still
// be that corner. A fan corner sits one averaged half-offset out along the gap bisector, and OSM's
// kerb ramp sits at the true corner of the roadway, so the two differ by the difference between the
// two flanking half-offsets — under 10 m even where a narrow street meets an avenue.
const SEAM_RADIUS_METERS: f64 = 12.0;
// And how far a corner that could not *be* an OSM node will reach to join one. A corner the fan had
// to invent — because a derived sidewalk or a park path binds to it — still has to reach the mapped
// pavement of the side beside it, or the two networks pass within metres of each other and never
// meet. This is the reach of that join, which the graph draws as a link edge.
const SEAM_LINK_METERS: f64 = 20.0;
// The kerb cut. Neither radius is a new number: the cut exists only to hand the seam above the node
// it is short of, so it is bounded by that seam's own two reaches. A corner cuts the pavement only
// where it would then *stand* on the cut — past the seam radius the corner could not resolve onto it
// and the cut would be a node nothing binds to. And it cuts only where the way's own nearest node is
// further off, along the pavement, than the seam can reach: inside that, the corner already has a
// node to bind to and a cut would only shed a second one beside it. Measured over the 191,692 corner
// / nearest-way pairs the pass considers, the distances have no gap to cut at — 47% of corners stand
// within 1 m of the line and the tail decays smoothly — but the detour does: 83% of pairs have a way
// node within 8 m along the pavement, and past 10 m the distribution flattens into the tail these
// two radii sit well inside.
const KERB_CUT_METERS: f64 = SEAM_RADIUS_METERS;
const KERB_CUT_DETOUR_METERS: f64 = SEAM_LINK_METERS;
// Two cut positions, or a cut and an existing vertex, within 2 m are one: a cut beside a vertex
// joins it rather than shedding a sliver edge, as the CSCL splits do.
const SPLIT_MERGE_METERS: f64 = 2.0;
// How far round an OSM crossing path may go and still count as serving the corner pair a
// synthesized crossing joins: a marked crossing that doglegs through a traffic island is longer than
// the straight line between the two kerbs, and is still the crossing.
const SUPPRESSION_SLACK: f64 = 1.5;
// The seam repair's reach. Where OSM's mapping of a side stops short of the corner the derived
// pavement reaches, the two stand a few metres apart with no edge between them; this is how far the
// repair will look for the other half before giving up and reporting the gap.
const SEAM_REPAIR_METERS: f64 = 60.0;
// What the swap measured, and the headroom over it: the ceiling is derived rather than written out,
// so the two can never drift apart again. Six times leaves the build failing loudly if the two
// networks stop meeting, without failing over the residue OSM's own patchiness leaves.
const MEASURED_SEAM_GAPS: usize = 80;
const MAX_SEAM_GAPS: usize = 6 * MEASURED_SEAM_GAPS;

pub struct Args {
    pub streets: PathBuf,
    pub paths: Option<PathBuf>,
    // OSM's own sidewalk network (SWLK): `footway=sidewalk`, `footway=crossing` and
    // `footway=traffic_island`, which the PATH extract deliberately excludes.
    pub sidewalks: Option<PathBuf>,
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
    // The measured canopy, read twice over: for the direct-canopy record byte, and — when the shade
    // bake runs — for the crowns that occlude the edges alongside the buildings.
    pub canopy: Option<PathBuf>,
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
    source_id: u32, // the CSCL physicalid or OSM way id this came from; the minimum over a contracted chain
    kind: u8,       // the GRPH record kind this becomes
    side: u8,       // and its N/E/S/W label, where the source already knows it
    sidewalks: u8,  // which sides get a *derived* sidewalk, in this edge's stored direction
    // And which sides have pavement at all, so a corner and its crossing are still placed. The name
    // is the ingest format's: the bits hold *existence* — OSM maps a sidewalk there, or the city's
    // survey drew one — and say nothing about surface.
    paved: u8,
    // This end entrance-snapped onto a street's derived sidewalk, so it binds to the corner node the
    // split made rather than to a path node standing in the roadway. See conflate.rs step 4.
    kerb_a: bool,
    kerb_b: bool,
}

/// Whether the given end of an edge is a kerb-bound entrance snap.
fn kerb_end(edge: &Edge, node: u32) -> bool {
    (edge.a == node && edge.kerb_a) || (edge.b == node && edge.kerb_b)
}

/// The existence gate: which sides of an offsetted street have pavement at all — OSM maps a sidewalk
/// there, or the city's planimetric survey draws one. See DESIGN.md, "Whether there is pavement at
/// all" and "The existence gate".
///
/// Existing is not the same as being *derived*: a stretch OSM has mapped exists because OSM's own
/// way is in the graph, and `trim_derived` cuts every stretch `Association::covered` names back out
/// of this mask before any offset is placed over it. That subtraction is the exclusivity rule —
/// DESIGN.md, "OSM is the pavement, CSCL is the label", is why it is per stretch and not per side.
fn gated_sidewalks(record_flags: u8) -> u8 {
    let mut sidewalks = 0u8;
    if record_flags & (FLAG_OSM_LEFT | FLAG_SURVEYED_LEFT) != 0 {
        sidewalks |= SIDEWALK_LEFT;
    }
    if record_flags & (FLAG_OSM_RIGHT | FLAG_SURVEYED_RIGHT) != 0 {
        sidewalks |= SIDEWALK_RIGHT;
    }
    sidewalks
}

/// Cut a street into the stretches that share one derived-sidewalk mask, so an offset is placed only
/// where OSM has not already drawn the pavement. Each piece keeps everything durable the street
/// knows — its physicalid, its name, its half-offset and its pavement mask — and shares its cut
/// vertices exactly with its neighbours, so the noding puts the chain back together and contraction
/// re-merges any pair the mask does not actually separate. The cover bytes are copied rather than
/// re-integrated, which is what the contraction's length-weighted merge would hand back anyway.
fn trim_derived(
    street: ProtoEdge,
    covered: &[Vec<(f64, f64)>; 2],
    meters_per_unit: (f64, f64),
) -> Vec<ProtoEdge> {
    if street.offset == 0 || covered.iter().all(Vec::is_empty) {
        return vec![street];
    }
    let ruler = association::cumulative_meters(&street.poly_x, &street.poly_y, meters_per_unit);
    let whole = ruler.last().copied().unwrap_or(0.0);
    let stretches = association::derived_stretches(covered, street.sidewalks, whole);
    if let [(_, mask)] = stretches[..] {
        return vec![ProtoEdge {
            sidewalks: mask,
            ..street
        }];
    }

    let mut pieces: Vec<ProtoEdge> = Vec::with_capacity(stretches.len());
    let mut poly_x: Vec<i32> = vec![street.poly_x[0]];
    let mut poly_y: Vec<i32> = vec![street.poly_y[0]];
    let mut vertex = 1usize;
    for (index, &(end, mask)) in stretches.iter().enumerate() {
        let last = index + 1 == stretches.len();
        while vertex < ruler.len() && (last || ruler[vertex] < end) {
            poly_x.push(street.poly_x[vertex]);
            poly_y.push(street.poly_y[vertex]);
            vertex += 1;
        }
        if !last {
            // The cut, interpolated along the segment it falls in. Quantization can land it on the
            // vertex either side, which the dedup below folds away.
            let span = ruler[vertex] - ruler[vertex - 1];
            let param = if span > 0.0 {
                (end - ruler[vertex - 1]) / span
            } else {
                0.0
            };
            let lerp = |from: i32, to: i32| {
                round_half_up(f64::from(from) + param * f64::from(to - from)) as i32
            };
            poly_x.push(lerp(street.poly_x[vertex - 1], street.poly_x[vertex]));
            poly_y.push(lerp(street.poly_y[vertex - 1], street.poly_y[vertex]));
        }
        let mut piece_x = vec![poly_x[0]];
        let mut piece_y = vec![poly_y[0]];
        for point in 1..poly_x.len() {
            if (poly_x[point], poly_y[point]) != (poly_x[point - 1], poly_y[point - 1]) {
                piece_x.push(poly_x[point]);
                piece_y.push(poly_y[point]);
            }
        }
        poly_x = vec![*poly_x.last().expect("a cut vertex")];
        poly_y = vec![*poly_y.last().expect("a cut vertex")];
        if piece_x.len() < 2 {
            continue; // the whole stretch quantized onto one point
        }
        let piece_meters = conflate::polyline_meters(&piece_x, &piece_y, meters_per_unit);
        let length = if whole > 0.0 {
            (f64::from(street.length) * piece_meters / whole) as f32
        } else {
            street.length
        };
        pieces.push(ProtoEdge {
            poly_x: piece_x,
            poly_y: piece_y,
            length,
            sidewalks: mask,
            ..street.clone()
        });
    }
    pieces
}

/// What a crossing over a street is worth in cover: the mean of the street's two side bytes, since
/// it spends half its length under each.
fn crossing_cover_bytes(left: u8, right: u8) -> u8 {
    round_half_up((f64::from(left) + f64::from(right)) / 2.0) as u8
}

/// The ends leaving one base node — streets first, in counter-clockwise bearing order, then paths —
/// and the corner fan they make. The construction below walks the nodes twice, once to place the
/// corners the seam resolves against and once to build the edges, so this is a function rather than
/// a block inside the second loop.
struct NodeFan {
    ends: Vec<EdgeEnd>,
    street_count: usize,
    degree: usize,
    fan: corners::CornerFan,
}

fn node_fan(
    base: usize,
    incidence2: &[Vec<(u32, bool)>],
    final_edges: &[Edge],
    merged_x: &[i32],
    merged_y: &[i32],
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> NodeFan {
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
    path_ends.sort_by(|left, right| left.edge.cmp(&right.edge).then(left.at_a.cmp(&right.at_a)));

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
    for end in path_ends {
        ends.push(end);
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
    NodeFan {
        ends,
        street_count,
        degree,
        fan,
    }
}

/// One of an edge's per-side masks as seen leaving a given end: the stored mask at its `a` end,
/// mirrored at its `b` end, where travel runs against the stored direction.
fn mask_leaving(mask: u8, at_a: bool) -> u8 {
    if at_a { mask } else { swap_sidewalks(mask) }
}

/// An edge's derived sidewalk sides as seen leaving one of its ends.
fn sidewalks_leaving(edge: &Edge, node: u32) -> u8 {
    mask_leaving(edge.sidewalks, edge.a == node)
}

/// And the sides it has pavement on at all, which is the wider mask: a side OSM maps for itself is
/// paved without being derived. Despite the name the mask is one of existence, not of surface.
fn paved_leaving(edge: &Edge, node: u32) -> u8 {
    mask_leaving(edge.paved, edge.a == node)
}

/// An edge's flags as seen leaving one of its ends. Only `GRPH_BUILDING_RIGHT` is direction-
/// dependent, and only on an OSM sidewalk the association matched to a street: a derived sidewalk
/// never carries it, and an unmatched OSM way is a path by the time it gets here. Flipping it
/// unconditionally would invent a side for every edge that has none.
fn flags_leaving(edge: &Edge, node: u32) -> u8 {
    if edge.a == node || !edge.osm || edge.kind != KIND_SIDEWALK {
        edge.flags
    } else {
        edge.flags ^ GRPH_BUILDING_RIGHT
    }
}

/// Cut one contracted edge at a set of interior positions, dividing the stored length by each
/// piece's share of the parent's geodesic length and interning a node at every cut. A position
/// within `SPLIT_MERGE_METERS` of an existing vertex, or of a cut already taken, joins it rather
/// than shedding a sliver — the same merge `conflate::apply_splits` makes on the CSCL side.
fn cut_edge_at(
    edge: &Edge,
    cuts: &[f64],
    merged_x: &mut Vec<i32>,
    merged_y: &mut Vec<i32>,
    meters_per_unit: (f64, f64),
) -> Vec<Edge> {
    let along = association::cumulative_meters(&edge.poly_x, &edge.poly_y, meters_per_unit);
    let full = along.last().copied().unwrap_or(0.0);
    let last = edge.poly_x.len() - 1;

    // The woven vertex list: every original vertex, plus each cut that did not land on one, each
    // flagged with whether a piece boundary falls there.
    let mut woven: Vec<(f64, i32, i32, bool)> = (0..=last)
        .map(|vertex| {
            (
                along[vertex],
                edge.poly_x[vertex],
                edge.poly_y[vertex],
                false,
            )
        })
        .collect();
    for &cut in cuts {
        let nearest = (0..woven.len())
            .min_by(|&left, &right| {
                (woven[left].0 - cut)
                    .abs()
                    .total_cmp(&(woven[right].0 - cut).abs())
            })
            .expect("a non-empty polyline");
        if (woven[nearest].0 - cut).abs() <= SPLIT_MERGE_METERS {
            // Never at an end: that node exists already, and cutting there would shed an empty piece.
            if nearest != 0 && nearest != woven.len() - 1 {
                woven[nearest].3 = true;
            }
            continue;
        }
        let after = woven
            .iter()
            .position(|entry| entry.0 > cut)
            .expect("a cut inside the polyline");
        let span = woven[after].0 - woven[after - 1].0;
        let param = if span > 0.0 {
            (cut - woven[after - 1].0) / span
        } else {
            0.0
        };
        let lerp = |from: i32, to: i32| {
            round_half_up(f64::from(from) + param * f64::from(to - from)) as i32
        };
        let point_x = lerp(woven[after - 1].1, woven[after].1);
        let point_y = lerp(woven[after - 1].2, woven[after].2);
        woven.insert(after, (cut, point_x, point_y, true));
    }
    if woven.iter().all(|entry| !entry.3) {
        return vec![Edge { ..clone_edge(edge) }];
    }

    let mut pieces: Vec<Edge> = Vec::new();
    let mut start = 0usize;
    let mut start_node = edge.a;
    for boundary in 1..woven.len() {
        if !woven[boundary].3 && boundary != woven.len() - 1 {
            continue;
        }
        let poly_x: Vec<i32> = woven[start..=boundary]
            .iter()
            .map(|entry| entry.1)
            .collect();
        let poly_y: Vec<i32> = woven[start..=boundary]
            .iter()
            .map(|entry| entry.2)
            .collect();
        let span = conflate::polyline_meters(&poly_x, &poly_y, meters_per_unit);
        let length = if full > 0.0 {
            (f64::from(edge.length) * span / full) as f32
        } else {
            edge.length
        };
        let end_node = if boundary == woven.len() - 1 {
            edge.b
        } else {
            merged_x.push(woven[boundary].1);
            merged_y.push(woven[boundary].2);
            (merged_x.len() - 1) as u32
        };
        pieces.push(Edge {
            a: start_node,
            b: end_node,
            poly_x,
            poly_y,
            length,
            kerb_a: edge.kerb_a && start == 0,
            kerb_b: edge.kerb_b && boundary == woven.len() - 1,
            ..clone_edge(edge)
        });
        start = boundary;
        start_node = end_node;
    }
    pieces
}

/// Everything a cut piece inherits from its parent — the geometry, the length and the two kerb
/// flags are set per piece, and `Edge` is deliberately not `Clone` so the rest cannot drift.
fn clone_edge(edge: &Edge) -> Edge {
    Edge {
        a: edge.a,
        b: edge.b,
        poly_x: edge.poly_x.clone(),
        poly_y: edge.poly_y.clone(),
        length: edge.length,
        cover_left: edge.cover_left,
        cover_right: edge.cover_right,
        offset: edge.offset,
        flags: edge.flags,
        name_id: edge.name_id,
        osm: edge.osm,
        source_id: edge.source_id,
        kind: edge.kind,
        side: edge.side,
        sidewalks: edge.sidewalks,
        paved: edge.paved,
        kerb_a: edge.kerb_a,
        kerb_b: edge.kerb_b,
    }
}

/// The cumulative along-distance of every vertex of a polyline, in metres.
/// The kerb cut: a corner cuts the OSM sidewalk way it stands beside, giving the seam the node it
/// was missing. DESIGN.md, "The seam", is the join this is the fourth case of.
///
/// The cut is guarded three ways, because a line passing close is not by itself pavement this
/// corner opens onto:
///
/// - **The wedge.** The projection must fall inside the corner's own angular gap, seen from the
///   node — the quadrant that corner *is*. The pavement across a roadway lies beyond one of the
///   street-ends bounding the gap, not inside it, so it is never cut; nor is the sidewalk of a
///   street that merely passes nearby.
/// - **The detour.** The nearest node the way already offers must be more than
///   `KERB_CUT_DETOUR_METERS` further along it. That distance is a lower bound on the walk the cut
///   removes — every route to this pavement has to enter the way through one of its ends — so a
///   corner the seam can already reach round the block takes no cut, and only a genuine stranding
///   does.
/// - **Grade.** Neither the way nor anything at the node may be a bridge or tunnel deck: a footway
///   over a cutting passes within metres of the road below it and shares no ground with it.
///
/// Measured citywide, 21,593 corners cut and 21,150 of them — 97.9% — landed on pavement carrying
/// the name of one of the two streets bounding their own wedge, which is the check that the geometry
/// picked the pavement the corner really opens onto and not merely the nearest line.
///
/// Returns the number of cuts made.
fn cut_sidewalks_at_corners(
    final_edges: &mut Vec<Edge>,
    merged_x: &mut Vec<i32>,
    merged_y: &mut Vec<i32>,
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> usize {
    let meters_per_unit = (meters_per_unit_lng, meters_per_unit_lat);
    let mut incidence: Vec<Vec<(u32, bool)>> = vec![Vec::new(); merged_x.len()];
    for (edge_id, edge) in final_edges.iter().enumerate() {
        incidence[edge.a as usize].push((edge_id as u32, true));
        incidence[edge.b as usize].push((edge_id as u32, false));
    }

    // The pavement a cut may fall on: OSM's own sidewalk edges, at grade. A crossing is not among
    // them — it is metres long and both its ends are already nodes — and no derived sidewalk exists
    // yet, its geometry being made from the corners this pass runs before.
    let pavement: Vec<u32> = (0..final_edges.len() as u32)
        .filter(|&edge_id| {
            let edge = &final_edges[edge_id as usize];
            edge.osm && edge.kind == KIND_SIDEWALK && edge.flags & GRPH_STRUCTURE == 0
        })
        .collect();
    let grid = conflate::SegmentGrid::new(
        pavement.iter().map(|&edge_id| {
            let edge = &final_edges[edge_id as usize];
            (&edge.poly_x[..], &edge.poly_y[..])
        }),
        meters_per_unit,
    );
    let along_of: Vec<Vec<f64>> = pavement
        .iter()
        .map(|&edge_id| {
            let edge = &final_edges[edge_id as usize];
            association::cumulative_meters(&edge.poly_x, &edge.poly_y, meters_per_unit)
        })
        .collect();

    let mut cuts_by_edge: HashMap<u32, Vec<f64>> = HashMap::new();
    for base in 0..incidence.len() {
        if incidence[base].is_empty() {
            continue;
        }
        // A deck above or below grade shares no ground with what passes under or over it.
        if incidence[base]
            .iter()
            .any(|&(edge_id, _)| final_edges[edge_id as usize].flags & GRPH_STRUCTURE != 0)
        {
            continue;
        }
        let NodeFan {
            ends,
            street_count,
            degree,
            fan,
        } = node_fan(
            base,
            &incidence,
            final_edges,
            merged_x,
            merged_y,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        // Two street-ends at least: one on its own has a single corner wrapping the whole circle,
        // and a gap of 360 degrees is not a wedge — the guard below would have nothing to say, and
        // a cul-de-sac's tip would cut whatever pavement happened to pass within a radius of it.
        if street_count < 2 {
            continue;
        }
        // The same "does anything bind here" test the construction makes: a corner nothing reaches
        // for is never materialized, so cutting the pavement for one would only add a stray node.
        let mut needed = vec![false; street_count];
        for slot in 0..street_count {
            let end = &ends[slot];
            let leaving = mask_leaving(final_edges[end.edge as usize].paved, end.at_a);
            if leaving & SIDEWALK_LEFT != 0 {
                needed[fan.corner_left[slot] as usize] = true;
            }
            if leaving & SIDEWALK_RIGHT != 0 {
                needed[fan.corner_right[slot] as usize] = true;
            }
        }
        for path_slot in 0..degree - street_count {
            needed[fan.path_corner[path_slot] as usize] = true;
        }

        for slot in 0..street_count {
            if !needed[slot] {
                continue;
            }
            let corner = (fan.corner_x[slot], fan.corner_y[slot]);
            // The corner's own angular gap, as `corners::build_fan` measures it: the arc from this
            // street-end counter-clockwise to the next, which is the wedge the corner fills.
            let start = ends[slot].bearing;
            let raw = ends[(slot + 1) % street_count].bearing - start;
            let gap = if street_count == 1 || raw <= 0.0 {
                raw + TAU
            } else {
                raw
            };
            for candidate in pavement_within(
                &grid,
                final_edges,
                &pavement,
                corner,
                KERB_CUT_METERS,
                meters_per_unit,
            ) {
                // The wedge: the projection, seen from the node, must lie in that gap. Pavement
                // across a roadway lies beyond one of the two street-ends bounding it, never inside.
                let toward = (f64::from(candidate.point.1 - merged_y[base]) * meters_per_unit_lat)
                    .atan2(f64::from(candidate.point.0 - merged_x[base]) * meters_per_unit_lng);
                if (toward - start).rem_euclid(TAU) >= gap {
                    continue;
                }
                // The detour: how far along the way its own nearest node stands from here. Every
                // walk onto this pavement enters through one of the way's ends, so that distance is
                // a lower bound on the walk the cut removes.
                let along = &along_of[candidate.entry];
                let (from, to) = (along[candidate.vertex], along[candidate.vertex + 1]);
                let cut = from + candidate.param * (to - from);
                let whole = along.last().copied().unwrap_or(0.0);
                if cut.min(whole - cut) <= KERB_CUT_DETOUR_METERS {
                    continue;
                }
                cuts_by_edge
                    .entry(pavement[candidate.entry])
                    .or_default()
                    .push(cut);
                break;
            }
        }
    }

    let mut cut_count = 0usize;
    let mut cut_edges: Vec<Edge> = Vec::with_capacity(final_edges.len());
    for (edge_id, edge) in final_edges.iter().enumerate() {
        match cuts_by_edge.get(&(edge_id as u32)) {
            Some(cuts) => {
                let mut sorted = cuts.clone();
                sorted.sort_by(f64::total_cmp);
                let pieces = cut_edge_at(edge, &sorted, merged_x, merged_y, meters_per_unit);
                cut_count += pieces.len() - 1;
                cut_edges.extend(pieces);
            }
            None => cut_edges.push(clone_edge(edge)),
        }
    }
    *final_edges = cut_edges;
    cut_count
}

/// One projection of a corner onto a candidate stretch of pavement.
struct Projection {
    entry: usize,  // which entry of the `pavement` list
    vertex: usize, // its sub-segment, by that sub-segment's first vertex
    param: f64,    // how far along the sub-segment the projection falls
    point: (i32, i32),
    metres: f64,
}

/// Every sub-segment of `pavement` within `radius` of a point, nearest first — nearest because the
/// guards above take the first candidate that passes them, and the pavement a corner opens onto is
/// not always the nearest line to it.
fn pavement_within(
    grid: &conflate::SegmentGrid,
    final_edges: &[Edge],
    pavement: &[u32],
    point: (i32, i32),
    radius: f64,
    meters_per_unit: (f64, f64),
) -> Vec<Projection> {
    let mut found: Vec<Projection> = Vec::new();
    for (entry, vertex) in grid.nearby(point, radius, meters_per_unit) {
        let edge = &final_edges[pavement[entry as usize] as usize];
        let from = (edge.poly_x[vertex as usize], edge.poly_y[vertex as usize]);
        let to = (
            edge.poly_x[vertex as usize + 1],
            edge.poly_y[vertex as usize + 1],
        );
        let (metres, param, projected) = conflate::project(point, from, to, meters_per_unit);
        if metres <= radius {
            found.push(Projection {
                entry: entry as usize,
                vertex: vertex as usize,
                param,
                point: projected,
                metres,
            });
        }
    }
    found.sort_by(|left, right| {
        left.metres
            .total_cmp(&right.metres)
            .then(left.entry.cmp(&right.entry))
            .then(left.vertex.cmp(&right.vertex))
    });
    found
}

/// One finished v2 edge: a sidewalk, a crossing, a link, or a path. `geom` indexes the shared
/// geometry entries (`NO_GEOMETRY` for the geometry-less crossings and links); `name_id` is still
/// the original STRT id here and is remapped to the compact table at write time. `source_id` is the
/// contracted street or path edge this was derived from, `NO_SOURCE_ID` for the derived kinds.
#[derive(Clone)]
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
    source_id: u32,
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

/// The N/S/E/W wind a normal points into: nearest cardinal, exact diagonals resolved to N/S.
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

impl conflate::Adjacency for HashMap<u32, Vec<(u32, f64)>> {
    fn neighbours(&self, node: u32) -> &[(u32, f64)] {
        self.get(&node).map_or(&[], Vec::as_slice)
    }
}

/// Whether an OSM crossing path joins two termini within `cap` metres — a walk over the mapped
/// crossings alone, capped so it covers an intersection, not a neighbourhood.
fn crossing_joins(adjacency: &HashMap<u32, Vec<(u32, f64)>>, from: u32, to: u32, cap: f64) -> bool {
    let mut joined = false;
    conflate::walk_within(adjacency, from, cap, |node| {
        if node == to {
            joined = true;
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    });
    joined
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
        // A mapped sidewalk arrives already labelled, so two pieces merge only when they are the
        // same kind of thing on the same side of the same street — never a sidewalk into a crossing,
        // and never the north pavement into the south.
        && edges[incident[0] as usize].kind == edges[incident[1] as usize].kind
        && edges[incident[0] as usize].side == edges[incident[1] as usize].side
        // Two halves of one street leave the joint in opposite directions, so their surviving sides
        // agree when one's mask mirrors the other's. A block that has pavement on the north only and
        // meets one that has it on the south only is two edges, not a lie spanning both.
        && sidewalks_leaving(&edges[incident[0] as usize], node)
            == swap_sidewalks(sidewalks_leaving(&edges[incident[1] as usize], node))
        // And the same for the wider pavement mask, which the corner fan reads to decide which
        // corner slots exist and so whether a crossing is built there. It diverges from the derived
        // mask wherever OSM owns a side — `sidewalks = paved & !covered` — so two blocks can agree
        // on what is derived and still disagree on what is paved; merging them would carry the near
        // segment's pavement to the far end and place, or miss, a crossing at a real intersection.
        && paved_leaving(&edges[incident[0] as usize], node)
            == swap_sidewalks(paved_leaving(&edges[incident[1] as usize], node))
        // A kerb end binds to a corner of the street split under it, which only exists while the
        // node does. Contracting it away would strand the entrance back in the roadway; the street's
        // two halves make this node degree 3 anyway, so this only ever guards the degenerate case.
        && !kerb_end(&edges[incident[0] as usize], node)
        && !kerb_end(&edges[incident[1] as usize], node)
}

/// Walk the chain of degree-2 nodes out of `start` along `first_edge`, merging edges as long as
/// the far node stays contractible, and emit the single edge that spans it. Each part is oriented
/// to flow from the running end; a reversed part swaps its two cover sides. The merged cover is the
/// length-weighted mean of the parts, the length is their f32 sum, and the shared junction vertex
/// is dropped where two parts meet. The merged source id is the minimum over the parts, so a chain
/// traced from either end names the same source record.
fn trace_chain(
    edges: &[Edge],
    incidence: &[Vec<u32>],
    visited: &mut [bool],
    start: u32,
    first_edge: u32,
) -> Edge {
    let offset = edges[first_edge as usize].offset;
    let flags = flags_leaving(&edges[first_edge as usize], start);
    let name_id = edges[first_edge as usize].name_id;
    let osm = edges[first_edge as usize].osm;
    let kind = edges[first_edge as usize].kind;
    let side = edges[first_edge as usize].side;
    let mut source_id = edges[first_edge as usize].source_id;
    // Every part of a contractible chain agrees on both masks once oriented, so the chain's are the
    // first part's, read in the direction the trace walks it.
    let sidewalks = sidewalks_leaving(&edges[first_edge as usize], start);
    let paved = paved_leaving(&edges[first_edge as usize], start);
    let kerb_a = kerb_end(&edges[first_edge as usize], start);
    // Assigned on every pass before any break, so the chain's far end is the last one walked to.
    let mut kerb_b;
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
        source_id = source_id.min(edge.source_id);
        total_weight += f64::from(edge.length);
        left_weighted += f64::from(edge.length) * f64::from(left);
        right_weighted += f64::from(edge.length) * f64::from(right);
        current = far;
        kerb_b = kerb_end(edge, current);

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
        source_id,
        kind,
        side,
        sidewalks,
        paved,
        kerb_a,
        kerb_b,
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

/// Which of two crossings over one pair of nodes the graph keeps. A mapped crossing beats a
/// synthesized one — it is drawn on the ground rather than inferred, and it carries the geometry the
/// straight corner-to-corner line has none of. Between two of the same provenance the shorter wins:
/// the duplicate is a second way round the same roadway, and the walk is the short side of it. An
/// exact tie keeps the incumbent, so the survivor is the earlier edge rather than a hash order.
fn crossing_supersedes(candidate: &V2Edge, incumbent: &V2Edge) -> bool {
    let candidate_mapped = candidate.flags & GRPH_OSM != 0;
    let incumbent_mapped = incumbent.flags & GRPH_OSM != 0;
    if candidate_mapped == incumbent_mapped {
        candidate.length < incumbent.length
    } else {
        candidate_mapped
    }
}

/// Drops every edge that runs from a node back to itself, returning the ones it dropped. Both ends of
/// a walking line can land on one node: the 1 m near-node merge folds a way shorter than itself into a
/// single base node, an entrance snap binds one end to the very node the other end already sits on, or
/// OSM draws a closed way that arrives back where it left. What comes out carries nobody anywhere —
/// taking it pays its length and returns the walker to the node they started from, so no search can
/// ever take it — and for that same reason dropping it cannot disconnect anything: a node is already
/// reachable from itself.
fn drop_self_loops(edges: &mut Vec<V2Edge>) -> Vec<V2Edge> {
    let mut dropped: Vec<V2Edge> = Vec::new();
    edges.retain(|edge| {
        if edge.a == edge.b {
            dropped.push(edge.clone());
            false
        } else {
            true
        }
    });
    dropped
}

/// Leaves one crossing over each pair of nodes and drops the rest, returning how many it dropped.
/// Parallel edges are never the only path between their own two ends, so this cannot disconnect
/// anything: every pair it touches keeps a crossing.
fn collapse_parallel_crossings(edges: &mut Vec<V2Edge>) -> usize {
    let mut kept: HashMap<(u32, u32), usize> = HashMap::new();
    let mut dropped = vec![false; edges.len()];
    for edge_id in 0..edges.len() {
        let edge = &edges[edge_id];
        if edge.kind != KIND_CROSSING {
            continue;
        }
        let pair = (edge.a.min(edge.b), edge.a.max(edge.b));
        match kept.get(&pair).copied() {
            None => {
                kept.insert(pair, edge_id);
            }
            Some(incumbent) => {
                let (winner, loser) = if crossing_supersedes(edge, &edges[incumbent]) {
                    (edge_id, incumbent)
                } else {
                    (incumbent, edge_id)
                };
                dropped[loser] = true;
                kept.insert(pair, winner);
            }
        }
    }
    let collapsed = dropped.iter().filter(|&&drop| drop).count();
    if collapsed > 0 {
        let mut survivors: Vec<V2Edge> = Vec::with_capacity(edges.len() - collapsed);
        for (edge, drop) in edges.drain(..).zip(&dropped) {
            if !drop {
                survivors.push(edge);
            }
        }
        *edges = survivors;
    }
    collapsed
}

/// The ordinal half of the durable key, over the final edge order: for each edge carrying a source
/// id, how many earlier edges share its `(source id, side)` pair. That makes the triple unique by
/// construction, so it also settles the theoretical collision between a small OSM way id and a CSCL
/// physicalid. Record byte 33 holds it, so a source that would need a 257th edge on one side is an
/// error rather than a silently truncated duplicate key.
fn assign_ordinals(edges: &[V2Edge]) -> Fallible<Vec<u8>> {
    let mut seen: HashMap<(u32, u8), usize> = HashMap::new();
    let mut ordinals = vec![0u8; edges.len()];
    for (edge_id, edge) in edges.iter().enumerate() {
        if edge.source_id == NO_SOURCE_ID {
            continue;
        }
        let count = seen.entry((edge.source_id, edge.side)).or_insert(0);
        if *count >= ORDINALS {
            return Err(format!(
                "source id {} side {} carries more than {ORDINALS} edges: the durable key's ordinal overflows",
                edge.source_id, edge.side
            )
            .into());
        }
        ordinals[edge_id] = *count as u8;
        *count += 1;
    }
    Ok(ordinals)
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
// time needs: `<dir>/bins.json` lists the bins (index + sun position, the elevation being what the
// client derives the bin's solar intensity from) and the edge count, and `<dir>/<index>.bin` carries
// that bin's two u8 occlusion rows — buildings then trees, `fraction = byte / 255`. The dir is wiped
// first so a shrunk bin set leaves no stale files. Each bin file is a 12-byte header (magic "SHDB",
// u16 version, u16 pad, u32 edgeCount) then the two `edge_count`-byte rows, little-endian;
// `edge_count` matches the GRPH edge count. Layout: scripts/README.md.
fn write_shade(
    dir: &std::path::Path,
    edge_count: usize,
    positions: &[shade::BinPosition],
    buildings: &[u8],
    trees: &[u8],
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
        let span = index * edge_count..index * edge_count + edge_count;
        let mut bytes = Vec::with_capacity(HEADER_BYTES + 2 * edge_count);
        bytes.extend_from_slice(b"SHDB");
        bytes.extend_from_slice(&2u16.to_le_bytes()); // version
        bytes.extend_from_slice(&0u16.to_le_bytes()); // pad
        bytes.extend_from_slice(&(edge_count as u32).to_le_bytes());
        bytes.extend_from_slice(&buildings[span.clone()]);
        bytes.extend_from_slice(&trees[span]);
        fs::write(dir.join(format!("{index}.bin")), &bytes)?;
    }
    Ok(())
}

// `version.json`, written beside the graph: what the deployed graph *is*, so a job that only has the
// live site can tell whether the artifact it snapped against is still the one being served. FNV-1a
// 64 over the file's own bytes — this detects a rebuild, it does not defend against one, and a
// hand-rolled hash beats a crypto dependency for that.
fn write_version(out: &std::path::Path, bytes: &[u8], edge_count: usize) -> Fallible<()> {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let generated = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let version = serde_json::json!({
        "graph": out.file_name().map(|name| name.to_string_lossy()),
        "hash": format!("{hash:016x}"),
        "edges": edge_count,
        "bytes": bytes.len(),
        "generatedUnixSeconds": generated,
    });
    fs::write(
        out.with_file_name("version.json"),
        serde_json::to_vec(&version)?,
    )?;
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
    // Edge the pipeline built before, minus the endpoint pinning conflation does after. The
    // existence gate runs a few blocks below, once the association knows which sides OSM owns.
    let mut dropped_vehicular = 0usize;
    let mut street_protos: Vec<ProtoEdge> = Vec::new();
    let mut street_segment: Vec<usize> = Vec::new(); // per proto, the STRT record it came from
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
        let mut flags = 0u8;
        if streets.flags[segment] & FLAG_STRUCTURE != 0 {
            flags |= GRPH_STRUCTURE;
        }
        if streets.road_types[segment] == STEP_STREET {
            flags |= GRPH_STEPS;
        }
        street_protos.push(ProtoEdge {
            poly_x: quantized_x[from..to].to_vec(),
            poly_y: quantized_y[from..to].to_vec(),
            length: streets.lengths_m[segment],
            cover_left,
            cover_right,
            offset: round_half_up(offset_meters * DECIMETERS_PER_METER) as u8,
            flags,
            name_id: streets.name_ids[segment],
            osm: false,
            source_id: streets.ids[segment],
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks: 0,
            paved: 0,
            kerb_a: false,
            kerb_b: false,
        });
        street_segment.push(segment);
    }
    // FLAG_NON_VEHICULAR rides in the STRT flags byte and is consumed inside half_offset_meters
    // (an NV deck is drawn on its own line), so the offset byte already carries it; the reference
    // keeps that dependency legible where the router reads the same flags byte.
    let _ = FLAG_NON_VEHICULAR;

    // The merged name table is the streets' names followed by the paths' (its ids offset past the
    // street count); path protos carry offset 0 (PATHLIKE), cover from their own density blob, and
    // the OSM provenance bit.
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
                source_id: paths.ids[segment],
                kind: KIND_PATH,
                side: SIDE_NONE,
                sidewalks: 0,
                paved: 0,
                kerb_a: false,
                kerb_b: false,
            });
        }
        all_names.extend(paths.names);
    }
    let path_name_count = all_names.len();

    // OSM's own sidewalk network (SWLK), the swap's primary source: sidewalk, crossing and
    // traffic-island ways, quantized into the streets frame like the paths. They arrive here raw —
    // one proto per way, keyed by way id and carrying no cover — because what they *are* is settled
    // by the association below.
    let osm_sidewalks = match &args.sidewalks {
        Some(file) => Some(binfmt::read_sidewalks(file)?),
        None => None,
    };
    let mut sidewalk_ways: Vec<ProtoEdge> = Vec::new();
    if let Some(ways) = &osm_sidewalks {
        if path_name_count + ways.names.len() > UNNAMED as usize {
            return Err(format!(
                "{} street + path + sidewalk names overflow a u16 id",
                path_name_count + ways.names.len()
            )
            .into());
        }
        let way_x: Vec<i32> = ways.lngs.iter().map(|lng| quantize_x(*lng)).collect();
        let way_y: Vec<i32> = ways.lats.iter().map(|lat| quantize_y(*lat)).collect();
        for segment in 0..ways.segments() {
            let from = ways.starts[segment] as usize;
            let to = ways.starts[segment + 1] as usize;
            let mut flags = GRPH_PATHLIKE;
            if ways.flags[segment] & FLAG_STRUCTURE != 0 {
                flags |= GRPH_STRUCTURE;
            }
            let name_id = if ways.name_ids[segment] == UNNAMED {
                UNNAMED
            } else {
                ways.name_ids[segment] + path_name_count as u16
            };
            sidewalk_ways.push(ProtoEdge {
                poly_x: way_x[from..to].to_vec(),
                poly_y: way_y[from..to].to_vec(),
                length: ways.lengths_m[segment],
                cover_left: 0,
                cover_right: 0,
                offset: 0,
                flags,
                name_id,
                osm: true,
                source_id: ways.ids[segment],
                // A traffic island is part of the crossing it chains through, and is costed as one.
                kind: if ways.road_types[segment] == SWLK_SIDEWALK {
                    KIND_SIDEWALK
                } else {
                    KIND_CROSSING
                },
                side: SIDE_NONE,
                sidewalks: 0,
                paved: 0,
                kerb_a: false,
                kerb_b: false,
            });
        }
        all_names.extend(ways.names.clone());
    }

    // The association: which CSCL street side each OSM sidewalk flanks. It supplies the labels and
    // the keys of every mapped sidewalk edge, and — read the other way — the per-stretch exclusivity
    // that keeps ground OSM has mapped from also being offset.
    let association = association::associate(&street_protos, &sidewalk_ways, meters_per_unit);
    let street_labels: Vec<(u8, u8)> = street_protos
        .iter()
        .map(|street| {
            side_labels(
                &street.poly_x,
                &street.poly_y,
                meters_per_unit_lng,
                meters_per_unit_lat,
            )
        })
        .collect();

    // The existence gate, now that both sources have spoken. A side exists when OSM maps any of it
    // or the city's survey draws it; a street with neither side is demoted to its centreline. Which
    // of the side is *derived* is settled per stretch further down — a run OSM maps is evidence that
    // the pavement is there, whether or not it is enough of the side for the survey's bit to be set,
    // so it counts here and is subtracted there.
    let mut demoted_streets = 0usize;
    let mut demoted_km = 0.0f64;
    let mut one_sided_streets = 0usize;
    let mut osm_covered_streets = 0usize;
    let mut derived_side_km = 0.0f64; // the two-a-street the unconditional derivation would give
    let mut kept_side_km = 0.0f64; // sides with pavement, however that pavement is drawn
    let mut osm_side_km = 0.0f64; // of those, the sides OSM maps for itself
    let mut alley_km = 0.0f64;
    let mut demoted_alley_km = 0.0f64;
    for (proto_index, proto) in street_protos.iter_mut().enumerate() {
        if proto.offset == 0 {
            proto.flags |= GRPH_PATHLIKE;
            proto.kind = KIND_PATH;
            continue;
        }
        let segment = street_segment[proto_index];
        let km = f64::from(streets.lengths_m[segment]) / 1000.0;
        let covered = &association.covered[proto_index];
        let mut owned = 0u8;
        if !covered[0].is_empty() {
            owned |= SIDEWALK_LEFT;
        }
        if !covered[1].is_empty() {
            owned |= SIDEWALK_RIGHT;
        }
        let exists = gated_sidewalks(streets.flags[segment]) | owned;
        // Everything pavement exists on, pre-trim: `trim_derived` below takes the mapped stretches
        // back out of `sidewalks`, which is where the two networks are actually held apart, and
        // leaves `paved` whole. So `paved` is literally this `exists` — the field is named for the
        // STRT bits it is read out of, not for what it holds.
        proto.sidewalks = exists;
        proto.paved = exists;
        derived_side_km += 2.0 * km;
        kept_side_km += f64::from(exists.count_ones()) * km;
        let owned_meters: f64 = covered
            .iter()
            .flatten()
            .map(|&(start, end)| end - start)
            .sum();
        osm_side_km += owned_meters / 1000.0;
        if streets.road_types[segment] == ALLEY {
            alley_km += km;
        }
        match exists.count_ones() {
            0 => {
                proto.offset = 0;
                proto.flags |= GRPH_PATHLIKE;
                proto.kind = KIND_PATH;
                demoted_streets += 1;
                demoted_km += km;
                if streets.road_types[segment] == ALLEY {
                    demoted_alley_km += km;
                }
            }
            1 => one_sided_streets += 1,
            _ => {}
        }
        if proto.offset > 0 && exists & !owned == 0 {
            osm_covered_streets += 1;
        }
    }

    // Cut each way where its association changes and hand every stretch what the street it flanks
    // knows: the street's name, its side label, its half-offset byte, that side's cover byte and its
    // physicalid — the key, because OSM way ids churn ~1.5-2%/yr and the scaffolding artifact hangs
    // off these. A stretch with no street beside it (an esplanade, a bridge walk) stays a path edge
    // under its own way id, which is the ~155 km where that exposure is worth taking.
    let mut streetless_sidewalk_km = 0.0f64;
    let mut sidewalk_protos: Vec<ProtoEdge> = Vec::new();
    for (way_index, way) in sidewalk_ways.iter().enumerate() {
        let whole = conflate::polyline_meters(&way.poly_x, &way.poly_y, meters_per_unit);
        for run in &association.runs[way_index] {
            let poly_x = way.poly_x[run.from..=run.to].to_vec();
            let poly_y = way.poly_y[run.from..=run.to].to_vec();
            let stretch = conflate::polyline_meters(&poly_x, &poly_y, meters_per_unit);
            let length = if whole > 0.0 {
                (f64::from(way.length) * stretch / whole) as f32
            } else {
                way.length
            };
            let mut piece = ProtoEdge {
                poly_x,
                poly_y,
                length,
                ..way.clone()
            };
            match run.matched {
                Some(matched) => {
                    let street = &street_protos[matched.street as usize];
                    let left = matched.sidewalk == SIDEWALK_LEFT;
                    let (left_label, right_label) = street_labels[matched.street as usize];
                    let cover = if left {
                        street.cover_left
                    } else {
                        street.cover_right
                    };
                    piece.cover_left = cover;
                    piece.cover_right = cover;
                    piece.offset = street.offset;
                    piece.name_id = street.name_id;
                    piece.source_id = street.source_id;
                    piece.side = if left { left_label } else { right_label };
                    if matched.street_left {
                        piece.flags |= GRPH_BUILDING_RIGHT;
                    }
                }
                None if way.kind == KIND_SIDEWALK => {
                    piece.kind = KIND_PATH;
                    streetless_sidewalk_km += f64::from(length) / 1000.0;
                }
                // A crossing belongs to no side and carries no durable key — the scaffolding never
                // places on one — but it does take the name and the cover of the street it crosses,
                // so a marked crossing costs what the synthesized one beside it does.
                None => {
                    piece.source_id = NO_SOURCE_ID;
                    if let Some(crossed) = association.crossed[way_index] {
                        let street = &street_protos[crossed as usize];
                        piece.cover_left =
                            crossing_cover_bytes(street.cover_left, street.cover_right);
                        piece.cover_right = piece.cover_left;
                        piece.name_id = street.name_id;
                    }
                }
            }
            sidewalk_protos.push(piece);
        }
    }
    let sidewalk_edge_protos = sidewalk_protos.len();
    path_protos.extend(sidewalk_protos);

    // The exclusivity, applied over the ground it is about. Every stretch of street OSM's own ways
    // were just cut into is taken back out of the derived mask, and the street is cut where the
    // answer changes — so a side OSM maps a third of gets its OSM geometry over that third and a
    // derived edge over the other two, and never both over the same pavement. Done after the loop
    // above, which addresses `street_protos` by the index `Association` matched against.
    let mut trimmed_streets = 0usize;
    let mut street_pieces: Vec<ProtoEdge> = Vec::with_capacity(street_protos.len());
    for (proto_index, proto) in street_protos.into_iter().enumerate() {
        let pieces = trim_derived(proto, &association.covered[proto_index], meters_per_unit);
        if pieces.len() > 1 {
            trimmed_streets += 1;
        }
        street_pieces.extend(pieces);
    }

    // Conflate the two sources into one segment list, then node it exactly as before.
    let (protos, conflate_stats) =
        conflate::conflate(street_pieces, path_protos, &all_names, meters_per_unit);

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
            source_id: proto.source_id,
            kind: proto.kind,
            side: proto.side,
            sidewalks: proto.sidewalks,
            paved: proto.paved,
            kerb_a: proto.kerb_a,
            kerb_b: proto.kerb_b,
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

    // Island drop, the last conflation step: a contracted component with nothing CSCL anchors it to
    // is an unanchored OSM path net (a playground stub the entrance snap could not reach, or
    // NJ/Westchester leakage the land clip missed) — unreachable in the model and a trap for snaps
    // into dead ends. Remove such components whole, before the base component count.
    //
    // A mapped sidewalk anchors as firmly as a CSCL edge does: the association tied it to a
    // physicalid, it is one side of a real street, and the seam below is what joins it to that
    // street's corners — which happens after this, so judging it unanchored here would delete the
    // pavement of every block OSM maps and CSCL's own geometry never touches.
    let mut island_parent: Vec<u32> = (0..merged_count as u32).collect();
    for edge in &final_edges {
        union(&mut island_parent, edge.a, edge.b);
    }
    let mut component_has_cscl: HashMap<u32, bool> = HashMap::new();
    for edge in &final_edges {
        let root = find(&mut island_parent, edge.a);
        let entry = component_has_cscl.entry(root).or_insert(false);
        *entry = *entry || !edge.osm || edge.kind == KIND_SIDEWALK;
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
    let mut final_edges = kept_edges;

    // The kerb cut — the seam's fourth join case (DESIGN.md, "The seam"). Every step below binds a
    // corner to OSM's pavement through a *node* of it, and where OSM draws a block as one unbroken
    // way there is no node to bind to: the corner cuts the way at its own projection instead, and
    // the seam then resolves onto the cut exactly as it would onto a kerb ramp OSM had drawn.
    let kerb_cuts = cut_sidewalks_at_corners(
        &mut final_edges,
        &mut merged_x,
        &mut merged_y,
        meters_per_unit_lng,
        meters_per_unit_lat,
    );
    let merged_count = merged_x.len();
    let final_edges = final_edges;

    // The contracted graph's connected components are the v1 partition: the base graph's own answer
    // to which nodes are one street. It is no longer a count the finished graph has to match — the
    // seam merges components only the mapped pavement connected — so what holds it to account is the
    // seam-gap ceiling below. A node still counts only if a surviving edge touches it, so the dropped
    // islands leave the count.
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
    let mut v2_base: Vec<u32> = Vec::new(); // the base node each v2 node was made for
    let mut v2_edges: Vec<V2Edge> = Vec::new();
    // Per base street edge, the four corner nodes its sidewalks attach to, filled by the fans.
    let mut left_at_a = vec![u32::MAX; final_edges.len()];
    let mut right_at_a = vec![u32::MAX; final_edges.len()];
    let mut left_at_b = vec![u32::MAX; final_edges.len()];
    let mut right_at_b = vec![u32::MAX; final_edges.len()];
    let mut path_node = vec![u32::MAX; merged_count];
    // Per base path edge end, the corner an entrance snap bound it to — the kerb it arrives at,
    // standing in for the path node the join used to detour through.
    let mut kerb_node_at_a = vec![u32::MAX; final_edges.len()];
    let mut kerb_node_at_b = vec![u32::MAX; final_edges.len()];
    let mut link_pairs: HashMap<(u32, u32), u8> = HashMap::new();
    // (corner a, corner b, crossed edge): a deg-2 street joint's latent crossing, added only if the
    // mop-up finds its two sides in different components.
    let mut mopup_candidates: Vec<(u32, u32, u32)> = Vec::new();
    let mut corner_node_count = 0usize;
    let mut path_node_count = 0usize;
    let mut crossing_count = 0usize;
    let mut synthesized_crossings = 0usize;
    let mut seam_links = 0usize;

    // The seam, first half (DESIGN.md, "The seam"): the base nodes that are corners of OSM's own
    // sidewalk network — where a mapped sidewalk ends and no CSCL street does. These are the
    // termini a mapped street-side slot resolves to.
    let mut osm_corner: Vec<u32> = Vec::new();
    for (base, incident) in incidence2.iter().enumerate() {
        let mut sidewalk = false;
        let mut street = false;
        for &(edge_id, _) in incident {
            let edge = &final_edges[edge_id as usize];
            if edge.flags & GRPH_PATHLIKE == 0 {
                street = true;
            } else if edge.osm && edge.kind == KIND_SIDEWALK {
                sidewalk = true;
            }
        }
        if sidewalk && !street {
            osm_corner.push(base as u32);
        }
    }
    // Cells a seam radius wide in longitude — and so more than that in latitude — so a 3x3 scan
    // covers the radius on both axes, as the near-node merge's grid does.
    let seam_cell = (SEAM_RADIUS_METERS / meters_per_unit_lng).ceil().max(1.0) as i32;
    let mut seam_grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for &base in &osm_corner {
        let point = (merged_x[base as usize], merged_y[base as usize]);
        seam_grid
            .entry((point.0.div_euclid(seam_cell), point.1.div_euclid(seam_cell)))
            .or_default()
            .push(base);
    }

    // Where every corner would go, so the resolution below can ask which of them OSM already stands
    // at. The fan is rebuilt in the construction loop rather than kept: it is O(degree) to make and
    // the alternative is holding a few million small vectors.
    let mut corner_start: Vec<usize> = Vec::with_capacity(merged_count + 1);
    let mut corner_x: Vec<i32> = Vec::new();
    let mut corner_y: Vec<i32> = Vec::new();
    for base in 0..merged_count {
        corner_start.push(corner_x.len());
        if incidence2[base].is_empty() {
            continue;
        }
        let placed = node_fan(
            base,
            &incidence2,
            &final_edges,
            &merged_x,
            &merged_y,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        corner_x.extend_from_slice(&placed.fan.corner_x);
        corner_y.extend_from_slice(&placed.fan.corner_y);
    }
    corner_start.push(corner_x.len());

    // Nearest first, and each OSM corner claimed once: two slots of one intersection resolving to the
    // same node would collapse the crossing between them into a self-loop.
    let mut seam_candidates: Vec<(f64, u32, u32)> = Vec::new();
    for slot in 0..corner_x.len() {
        let cell_x = corner_x[slot].div_euclid(seam_cell);
        let cell_y = corner_y[slot].div_euclid(seam_cell);
        for offset_x in -1..=1 {
            for offset_y in -1..=1 {
                for &base in seam_grid
                    .get(&(cell_x + offset_x, cell_y + offset_y))
                    .into_iter()
                    .flatten()
                {
                    let delta_x =
                        f64::from(merged_x[base as usize] - corner_x[slot]) * meters_per_unit_lng;
                    let delta_y =
                        f64::from(merged_y[base as usize] - corner_y[slot]) * meters_per_unit_lat;
                    let metres = delta_x.hypot(delta_y);
                    if metres <= SEAM_LINK_METERS {
                        seam_candidates.push((metres, slot as u32, base));
                    }
                }
            }
        }
    }
    seam_candidates.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    let mut corner_osm = vec![u32::MAX; corner_x.len()];
    let mut claimed_osm: HashSet<u32> = HashSet::new();
    for &(metres, slot, base) in &seam_candidates {
        if metres <= SEAM_RADIUS_METERS
            && corner_osm[slot as usize] == u32::MAX
            && claimed_osm.insert(base)
        {
            corner_osm[slot as usize] = base;
        }
    }
    let seam_corners = claimed_osm.len();
    // A corner the fan still has to invent reaches a little further for the mapped pavement beside
    // it, and joins it with a link rather than becoming it. Same candidate list, same nearest-first
    // order, so the two halves of the rule cannot claim the same node.
    let mut corner_link = vec![u32::MAX; corner_x.len()];
    for &(_, slot, base) in &seam_candidates {
        if corner_osm[slot as usize] == u32::MAX
            && corner_link[slot as usize] == u32::MAX
            && claimed_osm.insert(base)
        {
            corner_link[slot as usize] = base;
        }
    }
    for base in 0..merged_count {
        if claimed_osm.contains(&(base as u32)) {
            path_node[base] = v2_x.len() as u32;
            v2_x.push(merged_x[base]);
            v2_y.push(merged_y[base]);
            v2_base.push(base as u32);
            path_node_count += 1;
        }
    }

    let crossing_cover =
        |edge: &Edge| -> u8 { crossing_cover_bytes(edge.cover_left, edge.cover_right) };

    for base in 0..merged_count {
        if incidence2[base].is_empty() {
            continue;
        }
        let NodeFan {
            ends,
            street_count,
            degree,
            fan,
        } = node_fan(
            base,
            &incidence2,
            &final_edges,
            &merged_x,
            &merged_y,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );

        // Which corners something actually binds to: a derived sidewalk reaching for one, or a path
        // end departing into its gap. A corner nobody binds to and OSM does not already stand at is
        // not materialized — at a fully mapped intersection that is all four of them, and inventing
        // them would leave a ring of corners joined to each other and to nothing else.
        let mut needed = vec![false; street_count];
        for slot in 0..street_count {
            let end = &ends[slot];
            let edge = &final_edges[end.edge as usize];
            // Pavement, not a derived edge: a side OSM maps still has a corner, because the
            // synthesized crossing to the next street has to land somewhere (DESIGN.md,
            // "Crossings"). The corner then reaches the mapped pavement by resolution or by a seam
            // link.
            let leaving = mask_leaving(edge.paved, end.at_a);
            if leaving & SIDEWALK_LEFT != 0 {
                needed[fan.corner_left[slot] as usize] = true;
            }
            if leaving & SIDEWALK_RIGHT != 0 {
                needed[fan.corner_right[slot] as usize] = true;
            }
        }
        for path_slot in 0..degree - street_count {
            if street_count > 0 {
                needed[fan.path_corner[path_slot] as usize] = true;
            }
        }

        // The seam: a street-side slot whose corner OSM already stands at resolves to *that* node
        // rather than to an invented one, so the mapped pavement and the derived pavement meet at one
        // point — no gap between them, and no second corner beside the real one.
        let mut corner_ids: Vec<u32> = vec![u32::MAX; street_count];
        for slot in 0..street_count {
            let resolved = corner_osm[corner_start[base] + slot];
            if resolved != u32::MAX {
                corner_ids[slot] = path_node[resolved as usize];
            } else if needed[slot] {
                let corner = v2_x.len() as u32;
                corner_ids[slot] = corner;
                v2_x.push(fan.corner_x[slot]);
                v2_y.push(fan.corner_y[slot]);
                v2_base.push(base as u32);
                corner_node_count += 1;
                let reached = corner_link[corner_start[base] + slot];
                if reached != u32::MAX {
                    let cover = 0;
                    link_pairs
                        .entry((path_node[reached as usize], corner))
                        .or_insert(cover);
                    seam_links += 1;
                }
            }
        }

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
        // joining the two corners that flank it, carrying its name, cover and structure/steps. Where
        // OSM maps the crossing itself the synthesized one is dropped later, once every terminus is
        // known; what it must not do is refuse the legal unmarked crossing OSM has no way for.
        if street_count >= 2 && degree >= 3 {
            // Two street-ends at one node can flank the same pair of corners — a street that both
            // arrives and leaves has an end in two slots, and where the fan gives it only two gaps
            // both slots name the same two corners. Emitting per slot then writes the same crossing
            // twice: same pair of nodes, same name, same length, one on top of the other.
            let mut crossed_pairs: Vec<(u32, u32)> = Vec::with_capacity(street_count);
            for slot in 0..street_count {
                let crossed = &final_edges[ends[slot].edge as usize];
                let corner_a = corner_ids[fan.corner_right[slot] as usize];
                let corner_b = corner_ids[fan.corner_left[slot] as usize];
                if corner_a == u32::MAX || corner_b == u32::MAX || corner_a == corner_b {
                    continue;
                }
                let pair = if corner_a <= corner_b {
                    (corner_a, corner_b)
                } else {
                    (corner_b, corner_a)
                };
                if crossed_pairs.contains(&pair) {
                    continue;
                }
                crossed_pairs.push(pair);
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
                    source_id: NO_SOURCE_ID,
                });
                crossing_count += 1;
                synthesized_crossings += 1;
            }
        } else if street_count == 2
            && degree == 2
            && corner_ids[0] != u32::MAX
            && corner_ids[1] != u32::MAX
            && corner_ids[0] != corner_ids[1]
        {
            // A deg-2 through joint gets no crossing, but an isolated ring of them would split its
            // two sidewalk sides into two components; remember the latent crossing for the mop-up.
            mopup_candidates.push((corner_ids[0], corner_ids[1], ends[0].edge));
        }

        // A path end that entrance-snapped onto a sidewalk binds straight to the corner in the gap
        // it departs into — the kerb it reaches — so the walk never enters the roadway. Every other
        // path end meets at the old intersection position, which a link ties to its corner; that
        // node is only created if one of them needs it.
        //
        // A walking surface that merely *ends* at a street arrives at the kerb too, whether or not
        // conflation snapped it there: CSCL digitizes a boardwalk or a walkway as meeting the road at
        // its centreline, and binding that end to the intersection would leave the walk stopping in
        // the middle of the roadbed. It is the sole path end that makes it an ending — where two or
        // more meet, the path net genuinely passes through the intersection and keeps its node.
        let terminates = ends.len() == street_count + 1 && street_count > 0;
        let kerbs: Vec<bool> = ends[street_count..]
            .iter()
            .enumerate()
            .map(|(path_slot, end)| {
                let edge = &final_edges[end.edge as usize];
                let kerb = (if end.at_a { edge.kerb_a } else { edge.kerb_b }) || terminates;
                let corner = if street_count > 0 {
                    corner_ids[fan.path_corner[path_slot] as usize]
                } else {
                    u32::MAX
                };
                if kerb && corner != u32::MAX {
                    if end.at_a {
                        kerb_node_at_a[end.edge as usize] = corner;
                    } else {
                        kerb_node_at_b[end.edge as usize] = corner;
                    }
                    true
                } else {
                    false
                }
            })
            .collect();
        if kerbs.iter().any(|kerb| !kerb) {
            let node = match path_node[base] {
                u32::MAX => {
                    let node = v2_x.len() as u32;
                    v2_x.push(merged_x[base]);
                    v2_y.push(merged_y[base]);
                    v2_base.push(base as u32);
                    path_node[base] = node;
                    path_node_count += 1;
                    node
                }
                existing => existing,
            };
            for (path_slot, end) in ends[street_count..].iter().enumerate() {
                if street_count == 0 || kerbs[path_slot] {
                    continue;
                }
                let corner = corner_ids[fan.path_corner[path_slot] as usize];
                if corner == u32::MAX {
                    continue;
                }
                let cover = final_edges[end.edge as usize]
                    .cover_left
                    .max(final_edges[end.edge as usize].cover_right);
                link_pairs.entry((node, corner)).or_insert(cover);
            }
        }
    }

    // One edge per surviving side of a street (each its own baked corner-to-corner geometry,
    // opposite side labels) and one per walking line — a path, or a sidewalk or crossing OSM drew,
    // which keeps its own polyline. Only the synthesized crossings and the links carry none.
    let mut geometry_polys: Vec<(Vec<i32>, Vec<i32>)> = Vec::new();
    let mut sidewalk_count = 0usize;
    let mut path_edge_count = 0usize;
    let mut osm_path_edges = 0usize;
    let mut osm_path_km = 0.0f64;
    let mut osm_sidewalk_edges = 0usize;
    let mut osm_sidewalk_km = 0.0f64;
    let mut osm_crossing_edges = 0usize;
    let mut derived_sidewalk_km = 0.0f64;
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
            // An end the entrance snap bound to a kerb takes that corner; the rest take the base
            // node's path node. The stored polyline ends on the centreline either way — that is what
            // located the street split — so both endpoints are re-pinned onto whatever they resolved
            // to, which is what actually moves the join out of the roadway and onto the pavement.
            let node_a = match kerb_node_at_a[edge_id] {
                u32::MAX => path_node[edge.a as usize],
                corner => corner,
            };
            let node_b = match kerb_node_at_b[edge_id] {
                u32::MAX => path_node[edge.b as usize],
                corner => corner,
            };
            if node_a == u32::MAX || node_b == u32::MAX {
                return Err("a path edge is missing a path node".into());
            }
            let mut poly_x = edge.poly_x.clone();
            let mut poly_y = edge.poly_y.clone();
            let last = poly_x.len() - 1;
            poly_x[0] = v2_x[node_a as usize];
            poly_y[0] = v2_y[node_a as usize];
            poly_x[last] = v2_x[node_b as usize];
            poly_y[last] = v2_y[node_b as usize];
            let geom = geometry_polys.len() as u32;
            geometry_polys.push((poly_x, poly_y));
            // The stored length is the ingest's geodesic sum, but the 1 m node merge nudged the
            // pinned endpoints, so a near-straight path can end a metre or two under the node
            // distance; clamp it up like a sidewalk to keep the heuristic admissible.
            let length = clamp_length(node_a, node_b, edge.length, &mut length_clamped);
            let mut path_flags = if edge.osm {
                base_flags | GRPH_OSM
            } else {
                base_flags
            };
            if edge.flags & GRPH_BUILDING_RIGHT != 0 {
                path_flags |= FLAG_GEOMETRY_RIGHT;
            }
            // A mapped sidewalk is a walking line like a path is, so it is built as one — but the
            // record it writes is a sidewalk on a named side of a named street, and it keeps that
            // street's half-offset byte, which is what the scaffolding's depth infers the kerb from.
            v2_edges.push(V2Edge {
                a: node_a,
                b: node_b,
                length,
                geom,
                cover: edge.cover_left.max(edge.cover_right),
                half_offset: edge.offset,
                name_id: edge.name_id,
                kind: edge.kind,
                side: edge.side,
                flags: path_flags,
                source_id: edge.source_id,
            });
            match edge.kind {
                KIND_SIDEWALK => {
                    sidewalk_count += 1;
                    osm_sidewalk_edges += 1;
                    osm_sidewalk_km += f64::from(length) / 1000.0;
                }
                KIND_CROSSING => {
                    crossing_count += 1;
                    osm_crossing_edges += 1;
                }
                _ => path_edge_count += 1,
            }
            if edge.osm && edge.kind == KIND_PATH {
                osm_path_edges += 1;
                osm_path_km += f64::from(length) / 1000.0;
            }
        } else {
            let left_a = left_at_a[edge_id];
            let right_a = right_at_a[edge_id];
            let left_b = left_at_b[edge_id];
            let right_b = right_at_b[edge_id];
            // Only the corners a derived sidewalk actually reaches for have to exist: a street both
            // of whose sides OSM maps places no offset at all, and the fan may not have materialized
            // a corner nobody binds to.
            if (edge.sidewalks & SIDEWALK_LEFT != 0 && (left_a == u32::MAX || right_b == u32::MAX))
                || (edge.sidewalks & SIDEWALK_RIGHT != 0
                    && (right_a == u32::MAX || left_b == u32::MAX))
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
            if edge.sidewalks & SIDEWALK_LEFT != 0 {
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
                    polyline_length(&left_geom.0, &left_geom.1, origin_lng, origin_lat, scale)
                        as f32;
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
                    source_id: edge.source_id,
                });
                sidewalk_count += 1;
                derived_sidewalk_km += f64::from(left_length) / 1000.0;
            }
            if edge.sidewalks & SIDEWALK_RIGHT != 0 {
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
                    polyline_length(&right_geom.0, &right_geom.1, origin_lng, origin_lat, scale)
                        as f32;
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
                    source_id: edge.source_id,
                });
                sidewalk_count += 1;
                derived_sidewalk_km += f64::from(right_length) / 1000.0;
            }
        }
    }

    // Links, one per deduped (path node, corner) pair, emitted in key order: a hash map's iteration
    // order is seeded per process, and the edge sort below breaks ties only on the smaller node id,
    // so leaving it would shuffle a handful of edge ids between two runs over identical inputs.
    let mut link_count = link_pairs.len();
    let mut link_list: Vec<((u32, u32), u8)> = link_pairs.into_iter().collect();
    link_list.sort_unstable();
    for ((node, corner), cover) in link_list {
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
            source_id: NO_SOURCE_ID,
        });
    }

    // Crossing suppression: where OSM maps the crossing, OSM's crossing is the crossing. A
    // synthesized corner-to-corner one whose two termini an OSM crossing path already joins — within
    // half again its own length, so one that chains through a traffic island still counts — is
    // dropped as a duplicate. Every corner pair OSM does *not* serve keeps its synthesized crossing:
    // without that the router would refuse the legal unmarked crossing and detour around the corner.
    let mut crossing_adjacency: HashMap<u32, Vec<(u32, f64)>> = HashMap::new();
    for edge in &v2_edges {
        if edge.kind == KIND_CROSSING && edge.flags & GRPH_OSM != 0 {
            let length = f64::from(edge.length);
            crossing_adjacency
                .entry(edge.a)
                .or_default()
                .push((edge.b, length));
            crossing_adjacency
                .entry(edge.b)
                .or_default()
                .push((edge.a, length));
        }
    }
    let mut suppressed_crossings = 0usize;
    let keep_crossing: Vec<bool> = v2_edges
        .iter()
        .map(|edge| {
            if edge.kind != KIND_CROSSING
                || edge.flags & GRPH_OSM != 0
                || !crossing_joins(
                    &crossing_adjacency,
                    edge.a,
                    edge.b,
                    SUPPRESSION_SLACK * f64::from(edge.length),
                )
            {
                true
            } else {
                suppressed_crossings += 1;
                false
            }
        })
        .collect();
    let mut kept_v2: Vec<V2Edge> = Vec::with_capacity(v2_edges.len() - suppressed_crossings);
    for (edge, keep) in v2_edges.into_iter().zip(keep_crossing) {
        if keep {
            kept_v2.push(edge);
        }
    }
    let mut v2_edges = kept_v2;
    crossing_count -= suppressed_crossings;

    // The backstop, over whatever the passes above left: one crossing per pair of nodes, whoever
    // drew them. Collapsing here catches the duplicates no rule upstream can see — a synthesized
    // crossing and a mapped one over the same two kerbs, or two mapped ways over one roadway —
    // because it asks only what the finished graph says, which is where the defect is visible.
    let collapsed_crossings = collapse_parallel_crossings(&mut v2_edges);
    crossing_count -= collapsed_crossings;

    // Connectivity mop-up: union-find over the v2 graph, then add a latent crossing at any deg-2
    // joint whose two sides are still separated, until every v1 component's image is whole. Nothing
    // it adds can duplicate: it only joins two corners no edge already joins.
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
                source_id: NO_SOURCE_ID,
            });
            union(&mut v2_parent, corner_a, corner_b);
            mopup_crossings += 1;
        }
    }

    // The seam repair. Where OSM maps a side, its way is that side's edge and no offset is placed —
    // so if the mapped way stops short of the corner the rest of the block reaches, the two halves of
    // one street stand metres apart with nothing between them. Every such gap is *inside* one v1
    // component, which is what makes it repairable without inventing connectivity: the base graph
    // already said these two nodes are the same street, and the repair only supplies the join the
    // seam did not find. It is measured (`seamRepairLinks`, `seamRepairMeters`) because a large or a
    // long one means the seam rule missed, not that OSM is patchy.
    let mut node_v1 = vec![0u32; v2_node_count];
    for (node, root) in node_v1.iter_mut().enumerate() {
        *root = find(&mut component_parent, v2_base[node]);
    }
    let mut piece_size: HashMap<u32, usize> = HashMap::new();
    for node in 0..v2_node_count {
        *piece_size
            .entry(find(&mut v2_parent, node as u32))
            .or_insert(0) += 1;
    }
    let mut split_v1: HashMap<u32, HashSet<u32>> = HashMap::new();
    for (node, &root) in node_v1.iter().enumerate() {
        split_v1
            .entry(root)
            .or_default()
            .insert(find(&mut v2_parent, node as u32));
    }
    let mut seam_repair_links = 0usize;
    let mut seam_repair_meters = 0.0f64;
    let mut seam_repair_longest = 0.0f64;
    let mut seam_gaps = 0usize;
    if split_v1.values().any(|pieces| pieces.len() > 1) {
        let repair_cell = (SEAM_REPAIR_METERS / meters_per_unit_lng).ceil().max(1.0) as i32;
        let mut repair_grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for node in 0..v2_node_count {
            repair_grid
                .entry((
                    v2_x[node].div_euclid(repair_cell),
                    v2_y[node].div_euclid(repair_cell),
                ))
                .or_default()
                .push(node as u32);
        }
        // Only a node in a piece that is not its v1 component's largest can need a join, and the
        // nearest peer across the gap is what it joins to; the pairs are then taken shortest first
        // until every v1 component is whole again.
        let mut joins: Vec<(f64, u32, u32)> = Vec::new();
        for node in 0..v2_node_count {
            let piece = find(&mut v2_parent, node as u32);
            let Some(pieces) = split_v1.get(&node_v1[node]) else {
                continue;
            };
            if pieces.len() < 2
                || pieces
                    .iter()
                    .all(|other| piece_size[other] <= piece_size[&piece])
            {
                continue;
            }
            let cell_x = v2_x[node].div_euclid(repair_cell);
            let cell_y = v2_y[node].div_euclid(repair_cell);
            let mut best: Option<(f64, u32)> = None;
            for offset_x in -1..=1 {
                for offset_y in -1..=1 {
                    for &other in repair_grid
                        .get(&(cell_x + offset_x, cell_y + offset_y))
                        .into_iter()
                        .flatten()
                    {
                        if node_v1[other as usize] != node_v1[node]
                            || find(&mut v2_parent, other) == piece
                        {
                            continue;
                        }
                        let metres = node_distance(
                            &v2_x,
                            &v2_y,
                            node as u32,
                            other,
                            origin_lng,
                            origin_lat,
                            scale,
                        );
                        if metres <= SEAM_REPAIR_METERS
                            && best.is_none_or(|(held, at)| {
                                metres < held || (metres == held && other < at)
                            })
                        {
                            best = Some((metres, other));
                        }
                    }
                }
            }
            if let Some((metres, other)) = best {
                joins.push((metres, node as u32, other));
            }
        }
        joins.sort_by(|left, right| {
            left.0
                .total_cmp(&right.0)
                .then(left.1.cmp(&right.1))
                .then(left.2.cmp(&right.2))
        });
        for &(metres, node, other) in &joins {
            if find(&mut v2_parent, node) == find(&mut v2_parent, other) {
                continue;
            }
            v2_edges.push(V2Edge {
                a: node,
                b: other,
                length: metres as f32,
                geom: NO_GEOMETRY,
                cover: 0,
                half_offset: 0,
                name_id: UNNAMED,
                kind: KIND_LINK,
                side: SIDE_NONE,
                flags: 0,
                source_id: NO_SOURCE_ID,
            });
            union(&mut v2_parent, node, other);
            seam_repair_links += 1;
            seam_repair_meters += metres;
            seam_repair_longest = seam_repair_longest.max(metres);
        }
        for pieces in split_v1.values() {
            let mut whole: HashSet<u32> = HashSet::new();
            for &piece in pieces {
                whole.insert(find(&mut v2_parent, piece));
            }
            seam_gaps += whole.len() - 1;
        }
    }

    // The degenerate backstop, run once every pass that can place an edge has run: an edge from a node
    // back to itself is no edge, whichever pass drew it. Its kind is what the counts have to be told,
    // because they were taken as the edges were built.
    let self_loops = drop_self_loops(&mut v2_edges);
    for edge in &self_loops {
        let km = f64::from(edge.length) / 1000.0;
        let mapped = edge.flags & GRPH_OSM != 0;
        match edge.kind {
            KIND_SIDEWALK => {
                sidewalk_count -= 1;
                if mapped {
                    osm_sidewalk_edges -= 1;
                    osm_sidewalk_km -= km;
                } else {
                    derived_sidewalk_km -= km;
                }
            }
            KIND_CROSSING => {
                crossing_count -= 1;
                if mapped {
                    osm_crossing_edges -= 1;
                }
            }
            KIND_LINK => link_count -= 1,
            _ => {
                path_edge_count -= 1;
                if mapped {
                    osm_path_edges -= 1;
                    osm_path_km -= km;
                }
            }
        }
    }
    // A dropped walking line took its polyline with it, and nothing else points at it, so the table is
    // compacted and the survivors renumbered onto it — an entry no edge names would still be written.
    let mut geometry_slot: Vec<u32> = vec![u32::MAX; geometry_polys.len()];
    for edge in &v2_edges {
        if edge.geom != NO_GEOMETRY {
            geometry_slot[edge.geom as usize] = 0;
        }
    }
    let mut kept_polys: Vec<(Vec<i32>, Vec<i32>)> = Vec::with_capacity(geometry_polys.len());
    for (index, slot) in geometry_slot.iter_mut().enumerate() {
        if *slot != u32::MAX {
            *slot = kept_polys.len() as u32;
            kept_polys.push(std::mem::take(&mut geometry_polys[index]));
        }
    }
    let mut geometry_polys = kept_polys;
    for edge in &mut v2_edges {
        if edge.geom != NO_GEOMETRY {
            edge.geom = geometry_slot[edge.geom as usize];
        }
    }

    // Components of the finished v2 graph, relabelled by size descending (0 = largest). What holds
    // the partition to account is the seam-gap ceiling below, not an equality with v1's.
    let mut component_size: HashMap<u32, usize> = HashMap::new();
    let mut node_root = vec![0u32; v2_node_count];
    for (node, root_slot) in node_root.iter_mut().enumerate() {
        let root = find(&mut v2_parent, node as u32);
        *root_slot = root;
        *component_size.entry(root).or_insert(0) += 1;
    }
    let component_count = component_size.len();
    // What the seam did to the v1 partition, net. It is no longer a parity: the seam deliberately
    // *joins* OSM's sidewalk network to the CSCL streets it flanks, merging v1 components that only
    // the mapped pavement connected; and it leaves a gap wherever OSM owns a side but its ways stop
    // short of the block, which the repair above could not reach across. The gaps are counted rather
    // than asserted away — inventing a join over an arbitrary distance would be a worse lie than the
    // honest break — but a build that shatters is still an error.
    let seam_merged_components = v1_component_count.saturating_sub(component_count);
    if seam_gaps > MAX_SEAM_GAPS {
        return Err(format!(
            "the seam left {seam_gaps} v1 components split, over the {MAX_SEAM_GAPS} ceiling: the \
             mapped and derived networks are not meeting"
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

    // Ferries: a final stage, after the seam-gap ceiling and the node renumber above (both
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

        // In node-pair order, for the same reason the links are: the ferry edges are appended after
        // the walking renumber, so their order is the order they are emitted in.
        let mut kept_segments: Vec<((u32, u32), usize)> = best_segment.into_iter().collect();
        kept_segments.sort_unstable();
        for (_, index) in kept_segments {
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
                source_id: NO_SOURCE_ID,
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

    // Every edge's polyline in degrees, recovered exactly as the pre-write geometry check does: a
    // ferry has none, a geometry-less edge is its straight node-to-node line, and a sidewalk or path
    // is its own baked entry. Both canopy bakes below read the sidewalk a walker is actually on.
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

    // The direct-canopy byte (v6): the fraction of the edge under a crown, integrated along that
    // polyline with no kernel — see direct_canopy.rs for why the cover byte cannot stand in.
    let direct_canopy_bytes = match &args.canopy {
        Some(path) => {
            let baked = direct_canopy::direct_canopy(&edge_polys, path, origin_lat)?;
            eprintln!(
                "direct canopy: {} polygons, mean covered fraction {:.3}, max byte {}",
                baked.polygons, baked.mean, baked.max_byte
            );
            baked.bytes
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

    // The durable key's ordinals, over the exact order the records are written in — the walking sort
    // and the ferry append are both behind us, so an edge id here is the id the file ships.
    let edge_ordinals = assign_ordinals(&v2_edges)?;
    let durable_id_edges = v2_edges
        .iter()
        .filter(|edge| edge.source_id != NO_SOURCE_ID)
        .count();
    let max_ordinal = edge_ordinals.iter().copied().max().unwrap_or(0);

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
    // The 34-byte record leaves the edge section off a 4-byte boundary, so the name table is padded
    // back onto one like every other section.
    let name_offset = align4(edges_offset + EDGE_RECORD_BYTES * edge_count);
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
        // The attribute bytes (v5 scenic, v6 direct canopy): a ferry passes no landmark, art,
        // highway or commercial frontage and walks under no crown, so it keeps the record's default
        // zeros; every walking kind carries the baked attributes.
        if edge.kind != KIND_FERRY {
            bytes[record + 24] = landmark_bytes[edge_id];
            bytes[record + 25] = art_bytes[edge_id];
            bytes[record + 26] = highway_bytes[edge_id];
            bytes[record + 27] = commercial_bytes[edge_id];
            bytes[record + 28] = direct_canopy_bytes[edge_id];
        }
        // The durable key (v6): the source record's id, and the ordinal that — with the side already
        // in byte 22 — picks this edge out within it. A crossing, link or ferry has no source
        // geometry, so it carries the sentinel and a zero ordinal.
        put_u32(&mut bytes, record + 29, edge.source_id);
        bytes[record + 33] = edge_ordinals[edge_id];
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
    write_version(&args.out, &bytes, edge_count)?;

    // The SHDE artifact (optional): the building and crown occlusion fractions per edge per
    // sun-position bin, keyed off the same finalized `v2_edges` order the client reads GRPH records
    // in, over the same `edge_polys` the direct-canopy bake sampled.
    if let (Some(buildings_path), Some(shade_params_path), Some(shade_dir_path)) =
        (&args.buildings, &args.shade_params, &args.shade_dir)
    {
        let params: shade::Params = serde_json::from_slice(&fs::read(shade_params_path)?)?;
        let (building_bytes, tree_bytes, positions) = shade::edge_shade_attrs(
            buildings_path,
            args.canopy.as_deref(),
            &params.buckets,
            params.max_shadow_meters,
            &edge_polys,
        )?;
        assert_eq!(building_bytes.len(), positions.len() * v2_edges.len());
        assert_eq!(tree_bytes.len(), building_bytes.len());
        write_shade(
            shade_dir_path,
            edge_count,
            &positions,
            &building_bytes,
            &tree_bytes,
        )?;
        eprintln!(
            "shade: {} bins x {edge_count} edges baked to {}",
            positions.len(),
            shade_dir_path.display()
        );
    }

    // The gate's two guards. Neither is a tolerance on the data: each catches the rule being wrong.
    let dropped_fraction = if derived_side_km > 0.0 {
        1.0 - kept_side_km / derived_side_km
    } else {
        0.0
    };
    if dropped_fraction > MAX_DROPPED_SIDEWALK_FRACTION {
        return Err(format!(
            "the existence gate dropped {:.1}% of derived sidewalk km, over the {:.0}% ceiling: the \
             STRT per-side bits look unstamped, which reads as a city with no pavement",
            100.0 * dropped_fraction,
            100.0 * MAX_DROPPED_SIDEWALK_FRACTION
        )
        .into());
    }
    let demoted_alley_fraction = if alley_km > 0.0 {
        demoted_alley_km / alley_km
    } else {
        1.0
    };
    if demoted_alley_fraction < MIN_DEMOTED_ALLEY_FRACTION {
        return Err(format!(
            "only {:.1}% of alley km demoted to its centreline, under the {:.0}% floor: alleys have \
             no sidewalks, so a build that keeps them has the gate the wrong way round",
            100.0 * demoted_alley_fraction,
            100.0 * MIN_DEMOTED_ALLEY_FRACTION
        )
        .into());
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
        "demotedStreets": demoted_streets,
        "demotedKm": demoted_km,
        "oneSidedStreets": one_sided_streets,
        "trimmedStreets": trimmed_streets,
        "droppedSidewalkFraction": dropped_fraction,
        "demotedAlleyFraction": demoted_alley_fraction,
        "crossingEdges": crossing_count,
        "linkEdges": link_count,
        "pathEdges": path_edge_count,
        "cornerNodes": corner_node_count,
        "pathNodes": path_node_count,
        "seamCorners": seam_corners,
        "seamLinks": seam_links,
        "osmCorners": osm_corner.len(),
        "synthesizedCrossings": synthesized_crossings,
        "nameBreakJoints": name_break_joints,
        "mopupCrossings": mopup_crossings,
        "seamRepairLinks": seam_repair_links,
        "seamRepairMeters": seam_repair_meters,
        "seamRepairLongest": seam_repair_longest,
        "seamGaps": seam_gaps,
        "suppressedCrossings": suppressed_crossings,
        "collapsedCrossings": collapsed_crossings,
        "selfLoopEdges": self_loops.len(),
        "seamMergedComponents": seam_merged_components,
        "v1Components": v1_component_count,
        "lengthClamped": length_clamped,
        "coverClamped": cover_clamped,
        "durableIdEdges": durable_id_edges,
        "maxOrdinal": max_ordinal,
        "dedupedWays": conflate_stats.deduped_ways,
        "dedupedKm": conflate_stats.deduped_km,
        "dedupedOrphanWays": conflate_stats.deduped_orphan_ways,
        "dedupedOrphanKm": conflate_stats.deduped_orphan_km,
        "osmTSplits": conflate_stats.osm_t_splits,
        "csclTSplits": conflate_stats.cscl_t_splits,
        "kerbCuts": kerb_cuts,
        "weldedVertices": conflate_stats.welded_vertices,
        "entranceSnaps": conflate_stats.entrance_snaps,
        "entranceSnapsKerb": conflate_stats.entrance_snaps_kerb,
        "shortEntranceSnaps": conflate_stats.short_entrance_snaps,
        "danglingEnds": conflate_stats.dangling_ends,
        "mergedDanglingEnds": conflate_stats.merged_dangling_ends,
        "csclSplits": conflate_stats.cscl_splits,
        "osmWays": conflate_stats.osm_ways,
        "osmKm": conflate_stats.osm_km,
        "sidewalkWays": sidewalk_ways.len(),
        "sidewalkEdgeProtos": sidewalk_edge_protos,
        "streetlessSidewalkKm": streetless_sidewalk_km,
        "osmSideKm": osm_side_km,
        "osmCoveredStreets": osm_covered_streets,
        "droppedOsmIslands": dropped_osm_islands,
        "droppedOsmIslandKm": dropped_osm_island_km,
        "osmPathEdges": osm_path_edges,
        "osmPathKm": osm_path_km,
        "osmSidewalkEdges": osm_sidewalk_edges,
        "osmSidewalkKm": osm_sidewalk_km,
        "osmCrossingEdges": osm_crossing_edges,
        "derivedSidewalkKm": derived_sidewalk_km,
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

    fn keyed(source_id: u32, side: u8) -> V2Edge {
        V2Edge {
            a: 0,
            b: 0,
            length: 0.0,
            geom: NO_GEOMETRY,
            cover: 0,
            half_offset: 0,
            name_id: UNNAMED,
            kind: KIND_SIDEWALK,
            side,
            flags: 0,
            source_id,
        }
    }

    fn crossing(a: u32, b: u32, length: f32, mapped: bool) -> V2Edge {
        V2Edge {
            kind: KIND_CROSSING,
            a,
            b,
            length,
            flags: if mapped { GRPH_OSM } else { 0 },
            ..keyed(NO_SOURCE_ID, SIDE_NONE)
        }
    }

    #[test]
    fn a_mapped_crossing_takes_the_pair_from_a_synthesized_one_however_far_it_doglegs() {
        // What the suppression's length slack cannot reach: the mapped crossing rounds a kerb and
        // runs to twice the straight line the synthesis drew between the same two corners.
        let mut edges = vec![crossing(4, 9, 10.9, false), crossing(9, 4, 21.8, true)];
        assert_eq!(collapse_parallel_crossings(&mut edges), 1);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].length, 21.8);
    }

    #[test]
    fn two_mapped_crossings_over_one_pair_leave_the_shorter() {
        // An island drawn as a closed way, cut at two nodes: both ways round it join the same pair.
        let mut edges = vec![
            crossing(4, 9, 28.4, true),
            crossing(1, 2, 12.0, false),
            crossing(9, 4, 8.5, true),
        ];
        assert_eq!(collapse_parallel_crossings(&mut edges), 1);
        assert_eq!(
            edges.iter().map(|edge| edge.length).collect::<Vec<f32>>(),
            vec![12.0, 8.5]
        );
    }

    #[test]
    fn a_crossing_pair_nothing_else_joins_is_left_alone() {
        let mut edges = vec![
            crossing(4, 9, 10.9, false),
            crossing(9, 12, 10.9, false),
            V2Edge {
                a: 4,
                b: 9,
                ..keyed(3, SIDE_NORTH)
            },
        ];
        assert_eq!(collapse_parallel_crossings(&mut edges), 0);
        assert_eq!(edges.len(), 3);
    }

    #[test]
    fn an_edge_from_a_node_back_to_itself_is_no_edge_of_any_kind() {
        let mut edges = vec![
            crossing(9, 9, 0.62, true),
            V2Edge {
                a: 4,
                b: 4,
                length: 0.79,
                kind: KIND_PATH,
                flags: GRPH_OSM,
                ..keyed(NO_SOURCE_ID, SIDE_NONE)
            },
            crossing(4, 9, 10.9, false),
        ];
        let dropped = drop_self_loops(&mut edges);
        assert_eq!(
            dropped
                .iter()
                .map(|edge| (edge.kind, edge.a))
                .collect::<Vec<(u8, u32)>>(),
            vec![(KIND_CROSSING, 9), (KIND_PATH, 4)]
        );
        assert_eq!(edges.len(), 1);
        assert_eq!((edges[0].a, edges[0].b), (4, 9));
    }

    #[test]
    fn an_edge_between_two_nodes_is_left_alone() {
        let mut edges = vec![crossing(4, 9, 10.9, false), crossing(9, 4, 10.9, true)];
        assert!(drop_self_loops(&mut edges).is_empty());
        assert_eq!(edges.len(), 2);
    }

    // The STRT flags byte of an offsetted record, from the four per-side bits.
    fn record(osm_left: bool, osm_right: bool, surveyed_left: bool, surveyed_right: bool) -> u8 {
        u8::from(osm_left) * FLAG_OSM_LEFT
            | u8::from(osm_right) * FLAG_OSM_RIGHT
            | u8::from(surveyed_left) * FLAG_SURVEYED_LEFT
            | u8::from(surveyed_right) * FLAG_SURVEYED_RIGHT
    }

    #[test]
    fn the_gate_keeps_a_side_either_source_vouches_for() {
        // Both sources agree: an ordinary block, two sidewalks.
        assert_eq!(
            gated_sidewalks(record(true, true, true, true)),
            SIDEWALK_LEFT | SIDEWALK_RIGHT
        );
        // The Bronx case, and the reason OSM alone cannot decide: nobody has mapped this block, but
        // the city's survey draws pavement on both sides, so both survive.
        assert_eq!(
            gated_sidewalks(record(false, false, true, true)),
            SIDEWALK_LEFT | SIDEWALK_RIGHT
        );
        // And the reverse: the survey missed it — a driveway kerb cut, a plaza drawn separately —
        // but a mapper walked it, so it survives too.
        assert_eq!(
            gated_sidewalks(record(true, false, false, false)),
            SIDEWALK_LEFT
        );
        // A genuinely one-sided street keeps the side it has and loses the side it has not.
        assert_eq!(
            gated_sidewalks(record(false, false, false, true)),
            SIDEWALK_RIGHT
        );
    }

    #[test]
    fn the_gate_leaves_an_alley_no_sidewalks_at_all() {
        // 99.4% of the city's alley km is like this: no OSM sidewalk, no surveyed polygon, either
        // side. The gate returns nothing, which is what demotes the alley to a centreline path edge
        // — the alley stays routable, it just stops pretending to have pavement.
        assert_eq!(gated_sidewalks(record(false, false, false, false)), 0);
        // The other flag bits share the byte and must not be read as sides.
        let alley = FLAG_VEHICULAR_ONLY | FLAG_STRUCTURE | (1 << 1);
        assert_eq!(gated_sidewalks(alley), 0);
    }

    #[test]
    fn a_mask_read_backwards_swaps_its_sides() {
        assert_eq!(swap_sidewalks(SIDEWALK_LEFT), SIDEWALK_RIGHT);
        assert_eq!(swap_sidewalks(SIDEWALK_RIGHT), SIDEWALK_LEFT);
        assert_eq!(
            swap_sidewalks(SIDEWALK_LEFT | SIDEWALK_RIGHT),
            SIDEWALK_LEFT | SIDEWALK_RIGHT
        );
        assert_eq!(swap_sidewalks(0), 0);
    }

    #[test]
    fn a_chain_contracts_only_where_the_surviving_sides_line_up() {
        // Two halves of one street meeting at node 1: the first arrives (its `b` end), the second
        // departs (its `a` end), so their stored masks are read the same way round.
        let block = |a: u32, b: u32, sidewalks: u8, paved: u8| Edge {
            a,
            b,
            poly_x: vec![0, 1],
            poly_y: vec![0, 0],
            length: 1.0,
            cover_left: 0,
            cover_right: 0,
            offset: 40,
            flags: 0,
            name_id: 0,
            osm: false,
            source_id: 1,
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks,
            paved,
            kerb_a: false,
            kerb_b: false,
        };
        let north_only = |a: u32, b: u32, sidewalks: u8| block(a, b, sidewalks, sidewalks);
        let incidence = vec![vec![0u32], vec![0u32, 1u32], vec![1u32]];
        let agreeing = vec![
            north_only(0, 1, SIDEWALK_LEFT),
            north_only(1, 2, SIDEWALK_LEFT),
        ];
        assert!(contractible(&agreeing, &incidence, 1));
        // The next block has pavement on the other side only: a joint, not a shape joint.
        let differing = vec![
            north_only(0, 1, SIDEWALK_LEFT),
            north_only(1, 2, SIDEWALK_RIGHT),
        ];
        assert!(!contractible(&differing, &incidence, 1));
        // The same two sides, but the second block digitized the other way round, so both edges end
        // at the joint and the masks must mirror to mean the same pavement.
        let mirrored = vec![
            north_only(0, 1, SIDEWALK_LEFT),
            north_only(2, 1, SIDEWALK_RIGHT),
        ];
        assert!(contractible(&mirrored, &incidence, 1));
        // The derived masks agree and the paved ones do not: the first block's north side is OSM's,
        // so nothing is derived there but the pavement is real, while the second's is bare on both.
        // The corner fan reads `paved`, so merging these would carry the first block's kerb to the
        // far end and place a crossing where there is no pavement to cross to.
        let paved_only = vec![block(0, 1, 0, SIDEWALK_LEFT), block(1, 2, 0, 0)];
        assert!(!contractible(&paved_only, &incidence, 1));
        // And it mirrors like the derived mask does.
        let paved_mirrored = vec![
            block(0, 1, 0, SIDEWALK_LEFT),
            block(2, 1, 0, SIDEWALK_RIGHT),
        ];
        assert!(contractible(&paved_mirrored, &incidence, 1));
    }

    #[test]
    fn a_street_is_cut_where_osm_takes_over_its_side() {
        // 100 m of street, OSM owning the first 40 m of its geometry-left side. The offset is placed
        // over the other 60 and nowhere else, and the two pieces share the cut vertex exactly so the
        // noding puts them back together.
        let street = ProtoEdge {
            poly_x: vec![0, 100],
            poly_y: vec![0, 0],
            length: 100.0,
            cover_left: 3,
            cover_right: 4,
            offset: 40,
            flags: 0,
            name_id: 7,
            osm: false,
            source_id: 11,
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            paved: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            kerb_a: false,
            kerb_b: false,
        };
        let covered = [vec![(0.0, 40.0)], Vec::new()];
        let pieces = trim_derived(street, &covered, (1.0, 1.0));
        let shape: Vec<(Vec<i32>, u8, u32)> = pieces
            .iter()
            .map(|piece| (piece.poly_x.clone(), piece.sidewalks, piece.source_id))
            .collect();
        assert_eq!(
            shape,
            vec![
                (vec![0, 40], SIDEWALK_RIGHT, 11),
                (vec![40, 100], SIDEWALK_LEFT | SIDEWALK_RIGHT, 11),
            ]
        );
        // Both keep the whole street's pavement mask, which is what the corner fan reads, and their
        // lengths still sum to it.
        assert!(
            pieces
                .iter()
                .all(|piece| piece.paved == SIDEWALK_LEFT | SIDEWALK_RIGHT)
        );
        assert_eq!(pieces.iter().map(|piece| piece.length).sum::<f32>(), 100.0);
    }

    #[test]
    fn a_street_osm_owns_outright_keeps_one_piece_and_no_offset() {
        let street = ProtoEdge {
            poly_x: vec![0, 50, 100],
            poly_y: vec![0, 0, 0],
            length: 100.0,
            cover_left: 0,
            cover_right: 0,
            offset: 40,
            flags: 0,
            name_id: 7,
            osm: false,
            source_id: 11,
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            paved: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            kerb_a: false,
            kerb_b: false,
        };
        let covered = [vec![(0.0, 100.0)], vec![(0.0, 100.0)]];
        let pieces = trim_derived(street, &covered, (1.0, 1.0));
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].sidewalks, 0);
        assert_eq!(pieces[0].poly_x, vec![0, 50, 100], "uncut");
    }

    #[test]
    fn ordinals_count_per_source_and_side() {
        let edges = vec![
            keyed(7, SIDE_NORTH),
            keyed(7, SIDE_SOUTH),
            keyed(NO_SOURCE_ID, SIDE_NONE),
            keyed(7, SIDE_NORTH),
            keyed(9, SIDE_NORTH),
        ];
        let ordinals = assign_ordinals(&edges).expect("ordinals");
        assert_eq!(ordinals, vec![0, 0, 0, 1, 0]);
    }

    #[test]
    fn an_ordinal_past_the_byte_is_an_error() {
        let edges: Vec<V2Edge> = (0..=ORDINALS).map(|_| keyed(7, SIDE_NORTH)).collect();
        let message = assign_ordinals(&edges).expect_err("overflow").to_string();
        assert!(message.contains("source id 7"), "{message}");
    }

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
        // Two bins x three edges, row-major; bin 1's row is the last three of each grid.
        let buildings: Vec<u8> = vec![1, 2, 3, 4, 5, 6];
        let trees: Vec<u8> = vec![10, 20, 30, 40, 50, 60];
        write_shade(&dir, edge_count, &positions, &buildings, &trees).expect("write");

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
        assert_eq!(u16::from_le_bytes([bin1[4], bin1[5]]), 2);
        assert_eq!(
            u32::from_le_bytes([bin1[8], bin1[9], bin1[10], bin1[11]]),
            3
        );
        assert_eq!(bin1.len(), 12 + 2 * 3);
        assert_eq!(&bin1[12..15], [4, 5, 6]);
        assert_eq!(&bin1[15..18], [40, 50, 60]);

        fs::remove_dir_all(&dir).expect("cleanup");
    }

    // The kerb-cut fixture: a bend node where an east street and a south street meet, and one OSM
    // sidewalk way running east-west a little to the north of it. Metres are units here, so the
    // coordinates read directly. The fan puts one corner in the 90-degree south-east wedge at
    // (4, -4) and one in the 270-degree wedge behind it at (-4, 4); the way passes through the
    // second wedge and only clips the corner of the first, which is what the guards have to tell
    // apart.
    fn cut_edge(a: u32, b: u32, poly: &[(i32, i32)], pathlike: bool, structure: bool) -> Edge {
        let poly_x: Vec<i32> = poly.iter().map(|point| point.0).collect();
        let poly_y: Vec<i32> = poly.iter().map(|point| point.1).collect();
        let length = conflate::polyline_meters(&poly_x, &poly_y, (1.0, 1.0)) as f32;
        Edge {
            a,
            b,
            poly_x,
            poly_y,
            length,
            cover_left: 0,
            cover_right: 0,
            offset: 40, // a 4 m half-offset, so the corners land 4 m out
            flags: u8::from(pathlike) * GRPH_PATHLIKE | u8::from(structure) * GRPH_STRUCTURE,
            name_id: UNNAMED,
            osm: pathlike,
            source_id: NO_SOURCE_ID,
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            paved: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            kerb_a: false,
            kerb_b: false,
        }
    }

    /// Runs the pass over the fixture with one sidewalk way of the caller's choosing, and returns
    /// the cut count and the x coordinates the way was cut at.
    fn cut_fixture(
        way: &[(i32, i32)],
        way_structure: bool,
        street_structure: bool,
    ) -> (usize, Vec<i32>) {
        let mut merged_x = vec![0, 100, 0, way[0].0, way[way.len() - 1].0];
        let mut merged_y = vec![0, 0, -100, way[0].1, way[way.len() - 1].1];
        let mut edges = vec![
            cut_edge(0, 1, &[(0, 0), (100, 0)], false, street_structure),
            cut_edge(0, 2, &[(0, 0), (0, -100)], false, false),
            cut_edge(3, 4, way, true, way_structure),
        ];
        let cuts = cut_sidewalks_at_corners(&mut edges, &mut merged_x, &mut merged_y, 1.0, 1.0);
        let mut at: Vec<i32> = edges
            .iter()
            .filter(|edge| edge.osm)
            .map(|edge| edge.poly_x[0])
            .filter(|&x| x != way[0].0)
            .collect();
        at.sort_unstable();
        (cuts, at)
    }

    #[test]
    fn a_corner_cuts_the_unbroken_sidewalk_it_stands_on_and_only_that_corner() {
        // The way runs 400 m with no node of its own, so the seam has nothing to bind the corner in
        // its wedge to; the cut gives it one, at the corner's own projection.
        //
        // Both corners are inside the 12 m radius of that way — the south-east one at (4, -4) is 8 m
        // from it — and both are far from either of its ends, so only the wedge tells them apart:
        // the way passes behind the south-east corner, on the far side of the east street it flanks.
        // Hence one cut rather than two. Take the wedge guard out and this fails on the count.
        let (cuts, at) = cut_fixture(&[(-200, 4), (200, 4)], false, false);
        assert_eq!(cuts, 1);
        assert_eq!(
            at,
            vec![-4],
            "the north-west corner's projection, not the south-east one's"
        );
    }

    #[test]
    fn a_corner_beside_the_way_s_own_node_takes_no_cut() {
        // The same corner and the same wedge, but now the way is 20 m long: its own ends are 6 m
        // and 14 m along from the projection, well inside the seam's reach, so the corner already
        // has a node to bind to and cutting would only shed a second one beside it.
        assert_eq!(cut_fixture(&[(-10, 4), (10, 4)], false, false), (0, vec![]));
    }

    #[test]
    fn a_corner_does_not_reach_past_the_seam_radius() {
        // 16 m from the corner: past that the corner could not resolve onto the cut anyway, so the
        // cut would be a node nothing binds to.
        assert_eq!(
            cut_fixture(&[(-200, 20), (200, 20)], false, false),
            (0, vec![])
        );
    }

    #[test]
    fn grade_separation_is_never_cut() {
        // A footway on a bridge deck passes within metres of the road under it and shares no ground
        // with it — from either side of the pairing.
        assert_eq!(
            cut_fixture(&[(-200, 4), (200, 4)], true, false),
            (0, vec![])
        );
        assert_eq!(
            cut_fixture(&[(-200, 4), (200, 4)], false, true),
            (0, vec![])
        );
    }
}
