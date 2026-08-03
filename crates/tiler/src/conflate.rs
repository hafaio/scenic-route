//! Conflation: the OSM pedestrian/park network (PATH v1) merged into the CSCL sidewalk network
//! (STRT v5) before `graph.rs` nodes and contracts it. The committed source files stay pure; this
//! runs entirely on the decoded, quantized proto-edges and hands `graph.rs` one combined list.
//! DESIGN.md, "The order conflation runs in", is why the passes are ordered as they are and what
//! each of them is a rule about; every tolerance below is a named constant with the Central Park
//! measurement that chose it. See scripts/README.md.
//!
//! All coordinates are quantized i32 in the streets file's frame (graph.rs re-quantizes the paths
//! against the streets origin first), so `meters_per_unit` converts a unit delta to metres on each
//! axis at the city's reference latitude — the same equirectangular frame the corners live in.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::ops::ControlFlow;

use crate::geometry::round_half_up;

// 408 of Central Park's 1,449 OSM ways (35.6 of 88.6 km) lie within 8 m of a walkable CSCL segment
// — the car-free drives (duplicated as highway=pedestrian) and the paths CSCL already carries. At
// 6 m with a bearing guard the on-street protected bike lanes (~5 m off the centreline, aligned)
// drop while off-street greenways (>10 m) survive.
const DEDUP_METERS: f64 = 6.0;
// A footpath running beside a drive shares its bearing; a path merely crossing it does not. 25°
// (mod 180°, a line has no direction) keeps a parallel duplicate and spares an oblique crossing.
const DEDUP_BEARING_DEGREES: f64 = 25.0;
// A way ≥80% covered by an aligned CSCL segment is a duplicate; 25–75% partial overlaps (a path
// that runs 5 m beside a drive then peels away) are a real distinct walk and are kept whole.
const DEDUP_FRACTION: f64 = 0.8;
// The orphan band (step 2b). 10 m is where the first band's evidence runs out: an off-street
// greenway sits more than 10 m from the centreline it follows, a re-mapped street sits inside the
// right-of-way. Only a named, standalone way tested against a CSCL segment of the same name reaches
// this band, so it never touches a path that is part of a network or that OSM names for itself.
const ORPHAN_DEDUP_METERS: f64 = 10.0;
// One sample every 10 m over each way: fine enough that a 6 m match band is not stepped over,
// coarse enough that 2,700 km of paths costs a few hundred thousand point queries.
const DEDUP_SAMPLE_METERS: f64 = 10.0;
// The dedup/weld/entrance grid cell. 16 m > the 6 m dedup band and the 4 m weld radius, so a 3×3
// scan covers those; the 20 m entrance radius scans the 2-cell ring it needs.
const GRID_CELL_METERS: f64 = 16.0;
// A crossing node in OSM sits on the road centreline, so 4 m is generous for welding a greenway
// mapped as one long way to every street it crosses at grade. Structure flags on either side (a
// bridge over a transverse, a path under a viaduct) suppress the false weld a bare distance makes.
const WELD_METERS: f64 = 4.0;
// Park entrances meet the street mid-block at arbitrary curb points: of Central Park's 318 dangling
// endpoints, 210 lie within 25 m of a walkable CSCL segment, the 3–15 m masses being sidewalk-line
// and curb endings. 20 m captures them; endpoints beyond stay honest interior dead-ends.
const ENTRANCE_METERS: f64 = 20.0;
// The continuation guard: an entrance connector is accepted only if it continues the way's exit
// direction within 75°. A fence-parallel path exits along the fence, so its connector to the curb
// runs ~90° across it and is rejected — Green-Wood's interior paths stay inside Green-Wood.
const CONTINUATION_DEGREES: f64 = 75.0;
// The guard only has something to guard beyond the street's own half-width. NYC's standard
// right-of-way is 60 ft, so a CSCL centreline is ~9 m from the property line and an endpoint within
// 8 m of it is standing in the roadbed or on its sidewalk — there is no fence between the two, and
// whatever direction the way exits, that curb is the one it belongs to. Below 8 m the guard is
// skipped: at that range rejecting costs a whole-block detour (Coenties Alley's 6 m-offset second
// mapping exits at 88° to its connector and was left a dead-end spur 1.7 m from the corner).
const CONTINUATION_FREE_METERS: f64 = 8.0;
// The dangling-end merge (step 6). The radius is the same right-of-way half-width the continuation
// guard uses: within it the two nodes are the same piece of street, outside it a dead end may be
// honestly separated from what it faces. The detour is what makes the pair unambiguous — 60 m is
// longer than any real corner-to-corner walk between two nodes 8 m apart, so anything past it means
// the network has no short way round and the gap is a seam, not a barrier.
const DANGLING_MERGE_METERS: f64 = 8.0;
const DANGLING_DETOUR_METERS: f64 = 60.0;
// Two CSCL split positions, or a split and an existing vertex/endpoint, within 2 m are merged to
// one: a mid-block entrance splits the block, but an entrance beside an intersection joins the node
// rather than shedding a 2 m sliver edge.
const SPLIT_MERGE_METERS: f64 = 2.0;

// Mirrors graph.rs's GRPH_STRUCTURE (edge flags bit 0): a bridge or tunnel deck. Weld and entrance
// never target a structure segment, and a structure OSM way never welds, so a deck above grade does
// not fuse to the road beneath it.
const STRUCTURE_FLAG: u8 = 1 << 0;

/// One edge before `graph.rs` nodes it: the same shape as its `Edge`, plus an `osm` provenance bit
/// the contraction and island-drop key on. The polyline is quantized in the streets frame with its
/// endpoints already at their final positions; `cover_left`/`cover_right` are in the stored
/// direction (equal for an offset-0 path); `length` is the ingest's geodesic metres. `source_id` is
/// the source record's own id (a CSCL physicalid or an OSM way id) and every cut, weld or weave
/// below hands it to each piece unchanged — it is what the graph's durable edge key is built from.
#[derive(Clone)]
pub struct ProtoEdge {
    pub poly_x: Vec<i32>,
    pub poly_y: Vec<i32>,
    pub length: f32,
    pub cover_left: u8,
    pub cover_right: u8,
    pub offset: u8,
    pub flags: u8,
    pub name_id: u16,
    pub osm: bool,
    pub source_id: u32,
}

/// What conflation did, folded into the graph's stats JSON.
pub struct ConflateStats {
    pub deduped_ways: usize, // whole OSM ways dropped as CSCL duplicates
    pub deduped_km: f64,
    pub deduped_orphan_ways: usize, // ways dropped by the wider orphan band (step 2b)
    pub deduped_orphan_km: f64,
    pub osm_t_splits: usize, // OSM ways cut at a shared interior vertex (T-junctions)
    pub welded_vertices: usize, // OSM vertices moved onto a CSCL segment at an at-grade crossing
    pub entrance_snaps: usize, // dangling OSM endpoints snapped to a curb, guard accepted
    pub short_entrance_snaps: usize, // of those, accepted only because the connector was under 8 m
    pub dangling_ends: usize, // degree-1 OSM endpoints left unconnected after every step
    pub merged_dangling_ends: usize, // dangling ends pulled onto a node a block away by network
    pub cscl_splits: usize,  // interior cuts applied to CSCL segments (weld + entrance)
    pub osm_ways: usize,     // OSM ways read (before dedup)
    pub osm_km: f64,
}

type Point = (i32, i32);

fn meters_between(from: Point, to: Point, meters_per_unit: (f64, f64)) -> f64 {
    let delta_x = f64::from(to.0 - from.0) * meters_per_unit.0;
    let delta_y = f64::from(to.1 - from.1) * meters_per_unit.1;
    delta_x.hypot(delta_y)
}

/// The geodesic length of a quantized polyline in the equirectangular metre frame — the metric the
/// stored f32 length is divided against when a polyline is cut, so the halves keep its proportions.
fn polyline_meters(poly_x: &[i32], poly_y: &[i32], meters_per_unit: (f64, f64)) -> f64 {
    let mut total = 0.0;
    for vertex in 1..poly_x.len() {
        total += meters_between(
            (poly_x[vertex - 1], poly_y[vertex - 1]),
            (poly_x[vertex], poly_y[vertex]),
            meters_per_unit,
        );
    }
    total
}

/// The bearing of a unit-space delta, in degrees (`atan2` of the metre-frame delta).
fn bearing_degrees(from: Point, to: Point, meters_per_unit: (f64, f64)) -> f64 {
    let east = f64::from(to.0 - from.0) * meters_per_unit.0;
    let north = f64::from(to.1 - from.1) * meters_per_unit.1;
    north.atan2(east).to_degrees()
}

/// The acute angle between two undirected lines, in [0, 90]: the dedup bearing guard, where a line
/// and its reverse are the same orientation.
fn line_angle(first_degrees: f64, second_degrees: f64) -> f64 {
    let wrapped = (first_degrees - second_degrees).rem_euclid(180.0);
    wrapped.min(180.0 - wrapped)
}

/// The angle between two directed bearings, in [0, 180]: the entrance continuation guard, where the
/// connector must continue the way's exit direction, not merely parallel it.
fn directed_angle(first_degrees: f64, second_degrees: f64) -> f64 {
    let wrapped = (first_degrees - second_degrees).rem_euclid(360.0);
    wrapped.min(360.0 - wrapped)
}

/// Project a point onto a segment in the metre frame: the perpendicular distance in metres, the
/// clamped parameter along the segment, and the quantized projection point.
fn project(point: Point, from: Point, to: Point, meters_per_unit: (f64, f64)) -> (f64, f64, Point) {
    let edge_x = f64::from(to.0 - from.0) * meters_per_unit.0;
    let edge_y = f64::from(to.1 - from.1) * meters_per_unit.1;
    let point_x = f64::from(point.0 - from.0) * meters_per_unit.0;
    let point_y = f64::from(point.1 - from.1) * meters_per_unit.1;
    let length2 = edge_x * edge_x + edge_y * edge_y;
    let param = if length2 > 0.0 {
        ((point_x * edge_x + point_y * edge_y) / length2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let projected_x = f64::from(from.0) + param * f64::from(to.0 - from.0);
    let projected_y = f64::from(from.1) + param * f64::from(to.1 - from.1);
    let residual_x = (f64::from(point.0) - projected_x) * meters_per_unit.0;
    let residual_y = (f64::from(point.1) - projected_y) * meters_per_unit.1;
    let distance = residual_x.hypot(residual_y);
    (
        distance,
        param,
        (
            round_half_up(projected_x) as i32,
            round_half_up(projected_y) as i32,
        ),
    )
}

/// A grid over the CSCL sub-segments: each `(proto, vertex)` sub-segment registered in every 16 m
/// cell its bounding box touches, so a point query scans only the handful of cells its own radius
/// can reach. The proto index is into the street proto list; `vertex` is the sub-segment's first
/// vertex.
struct SegmentGrid {
    cell_units_x: i32,
    cell_units_y: i32,
    cells: HashMap<Point, Vec<(u32, u32)>>,
}

impl SegmentGrid {
    fn new(streets: &[ProtoEdge], meters_per_unit: (f64, f64)) -> Self {
        let cell_units_x = (GRID_CELL_METERS / meters_per_unit.0).floor().max(1.0) as i32;
        let cell_units_y = (GRID_CELL_METERS / meters_per_unit.1).floor().max(1.0) as i32;
        let mut cells: HashMap<Point, Vec<(u32, u32)>> = HashMap::new();
        for (proto_index, proto) in streets.iter().enumerate() {
            for vertex in 0..proto.poly_x.len() - 1 {
                let (min_x, max_x) = (
                    proto.poly_x[vertex].min(proto.poly_x[vertex + 1]),
                    proto.poly_x[vertex].max(proto.poly_x[vertex + 1]),
                );
                let (min_y, max_y) = (
                    proto.poly_y[vertex].min(proto.poly_y[vertex + 1]),
                    proto.poly_y[vertex].max(proto.poly_y[vertex + 1]),
                );
                for cell_x in min_x.div_euclid(cell_units_x)..=max_x.div_euclid(cell_units_x) {
                    for cell_y in min_y.div_euclid(cell_units_y)..=max_y.div_euclid(cell_units_y) {
                        cells
                            .entry((cell_x, cell_y))
                            .or_default()
                            .push((proto_index as u32, vertex as u32));
                    }
                }
            }
        }
        Self {
            cell_units_x,
            cell_units_y,
            cells,
        }
    }

    /// Every sub-segment registered in a cell within `radius` metres of the point (Chebyshev ring
    /// `ceil(radius / cell)`), possibly with duplicates the caller resolves by taking the minimum.
    fn nearby(&self, point: Point, radius: f64, meters_per_unit: (f64, f64)) -> Vec<(u32, u32)> {
        let ring_x = (radius / (f64::from(self.cell_units_x) * meters_per_unit.0)).ceil() as i32;
        let ring_y = (radius / (f64::from(self.cell_units_y) * meters_per_unit.1)).ceil() as i32;
        let centre_x = point.0.div_euclid(self.cell_units_x);
        let centre_y = point.1.div_euclid(self.cell_units_y);
        let mut found = Vec::new();
        for cell_x in centre_x - ring_x..=centre_x + ring_x {
            for cell_y in centre_y - ring_y..=centre_y + ring_y {
                if let Some(bucket) = self.cells.get(&(cell_x, cell_y)) {
                    found.extend_from_slice(bucket);
                }
            }
        }
        found
    }
}

/// The nearest street sub-segment to a point within `radius`, honouring the structure filter (weld
/// and entrance never target a bridge/tunnel deck): the proto, its sub-segment, the parameter, the
/// quantized projection point, and the distance.
fn nearest_street(
    grid: &SegmentGrid,
    streets: &[ProtoEdge],
    point: Point,
    radius: f64,
    exclude_structure: bool,
    meters_per_unit: (f64, f64),
) -> Option<(usize, usize, f64, Point, f64)> {
    let mut best: Option<(usize, usize, f64, Point, f64)> = None;
    for (proto_index, vertex) in grid.nearby(point, radius, meters_per_unit) {
        let proto = &streets[proto_index as usize];
        if exclude_structure && proto.flags & STRUCTURE_FLAG != 0 {
            continue;
        }
        let from = (proto.poly_x[vertex as usize], proto.poly_y[vertex as usize]);
        let to = (
            proto.poly_x[vertex as usize + 1],
            proto.poly_y[vertex as usize + 1],
        );
        let (distance, param, projected) = project(point, from, to, meters_per_unit);
        if distance <= radius && best.is_none_or(|(_, _, _, _, incumbent)| distance < incumbent) {
            best = Some((
                proto_index as usize,
                vertex as usize,
                param,
                projected,
                distance,
            ));
        }
    }
    best
}

/// Samples along a way ~`DEDUP_SAMPLE_METERS` apart, each with the bearing of the segment it lies
/// on. Positions are evenly spaced so the last sample lands on the far endpoint.
fn dedup_samples(poly_x: &[i32], poly_y: &[i32], meters_per_unit: (f64, f64)) -> Vec<(Point, f64)> {
    let mut prefix = vec![0.0f64];
    for vertex in 1..poly_x.len() {
        let step = meters_between(
            (poly_x[vertex - 1], poly_y[vertex - 1]),
            (poly_x[vertex], poly_y[vertex]),
            meters_per_unit,
        );
        prefix.push(prefix[vertex - 1] + step);
    }
    let total = *prefix.last().expect("a non-empty prefix");
    let count = (total / DEDUP_SAMPLE_METERS).round().max(1.0) as usize;
    let mut samples = Vec::with_capacity(count + 1);
    let mut segment = 0usize;
    for step in 0..=count {
        let target = total * step as f64 / count as f64;
        while segment + 2 < poly_x.len() && prefix[segment + 1] < target {
            segment += 1;
        }
        let span = prefix[segment + 1] - prefix[segment];
        let param = if span > 0.0 {
            (target - prefix[segment]) / span
        } else {
            0.0
        };
        let sample_x =
            f64::from(poly_x[segment]) + param * f64::from(poly_x[segment + 1] - poly_x[segment]);
        let sample_y =
            f64::from(poly_y[segment]) + param * f64::from(poly_y[segment + 1] - poly_y[segment]);
        let bearing = bearing_degrees(
            (poly_x[segment], poly_y[segment]),
            (poly_x[segment + 1], poly_y[segment + 1]),
            meters_per_unit,
        );
        samples.push((
            (
                round_half_up(sample_x) as i32,
                round_half_up(sample_y) as i32,
            ),
            bearing,
        ));
    }
    samples
}

/// The share of a way's samples that lie within `band` metres of a CSCL sub-segment running the
/// same way (within `DEDUP_BEARING_DEGREES`) — the duplicate test, with the band as a parameter so
/// the orphan pass can ask the same question of a wider one, and with an optional name the matched
/// segment must also carry.
fn aligned_fraction(
    way: &ProtoEdge,
    grid: &SegmentGrid,
    streets: &[ProtoEdge],
    band: f64,
    same_name_as: Option<&str>,
    names: &[String],
    meters_per_unit: (f64, f64),
) -> f64 {
    let samples = dedup_samples(&way.poly_x, &way.poly_y, meters_per_unit);
    let mut matched = 0usize;
    for (sample, bearing) in &samples {
        let is_duplicate =
            grid.nearby(*sample, band, meters_per_unit)
                .into_iter()
                .any(|(proto_index, vertex)| {
                    let proto = &streets[proto_index as usize];
                    if same_name_as.is_some()
                        && street_key(proto.name_id, names).as_deref() != same_name_as
                    {
                        return false;
                    }
                    let from = (proto.poly_x[vertex as usize], proto.poly_y[vertex as usize]);
                    let to = (
                        proto.poly_x[vertex as usize + 1],
                        proto.poly_y[vertex as usize + 1],
                    );
                    let (distance, _, _) = project(*sample, from, to, meters_per_unit);
                    distance <= band
                        && line_angle(*bearing, bearing_degrees(from, to, meters_per_unit))
                            <= DEDUP_BEARING_DEGREES
                });
        if is_duplicate {
            matched += 1;
        }
    }
    matched as f64 / samples.len() as f64
}

/// A name reduced to a comparison key: upper case, alphanumeric words, with CSCL's suffix
/// abbreviations spelled out, so the city's "COENTIES ALY" and OSM's "Coenties Alley" compare equal.
/// Only a non-leading word is expanded — CSCL's "ST NICHOLAS AVE" opens with Saint, not Street — and
/// an unrecognized abbreviation simply fails to match, which keeps the way.
fn street_key(name_id: u16, names: &[String]) -> Option<String> {
    let name = names.get(name_id as usize)?;
    let words: Vec<String> = name
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_uppercase)
        .collect();
    if words.is_empty() {
        return None;
    }
    let expanded: Vec<&str> = words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            if index == 0 {
                return word.as_str();
            }
            match word.as_str() {
                "ST" => "STREET",
                "AVE" | "AV" => "AVENUE",
                "ALY" => "ALLEY",
                "BLVD" => "BOULEVARD",
                "PKWY" | "PKY" => "PARKWAY",
                "DR" => "DRIVE",
                "RD" => "ROAD",
                "LN" => "LANE",
                "CT" => "COURT",
                "PL" => "PLACE",
                "TER" | "TERR" => "TERRACE",
                "SQ" => "SQUARE",
                "PLZ" => "PLAZA",
                "CIR" => "CIRCLE",
                "TPKE" => "TURNPIKE",
                "EXPY" => "EXPRESSWAY",
                "HWY" => "HIGHWAY",
                "BRG" => "BRIDGE",
                other => other,
            }
        })
        .collect();
    Some(expanded.join(" "))
}

/// Cut a proto at a sorted, distinct set of interior vertex indices, dividing the stored length by
/// each piece's share of the parent's geodesic length. Every field but the geometry and length is
/// inherited (per-side cover is the parent's block-half approximation).
fn split_at_vertices(
    parent: &ProtoEdge,
    cuts: &[usize],
    meters_per_unit: (f64, f64),
) -> Vec<ProtoEdge> {
    let full = polyline_meters(&parent.poly_x, &parent.poly_y, meters_per_unit);
    let mut boundaries: Vec<usize> = cuts.to_vec();
    boundaries.push(parent.poly_x.len() - 1);
    let mut pieces = Vec::with_capacity(boundaries.len());
    let mut start = 0usize;
    for &end in &boundaries {
        let poly_x = parent.poly_x[start..=end].to_vec();
        let poly_y = parent.poly_y[start..=end].to_vec();
        let piece = polyline_meters(&poly_x, &poly_y, meters_per_unit);
        let length = if full > 0.0 {
            (f64::from(parent.length) * piece / full) as f32
        } else {
            parent.length
        };
        pieces.push(ProtoEdge {
            poly_x,
            poly_y,
            length,
            cover_left: parent.cover_left,
            cover_right: parent.cover_right,
            offset: parent.offset,
            flags: parent.flags,
            name_id: parent.name_id,
            osm: parent.osm,
            source_id: parent.source_id,
        });
        start = end;
    }
    pieces
}

/// One recorded CSCL split before step 5 applies it: where along the proto it falls, and the
/// quantized projection point the OSM vertex was moved onto.
struct CsclSplit {
    along: f64,
    point: Point,
}

/// Decision 3, steps 1–6. `streets` and `paths` are the per-source proto lists (paths carry
/// `osm = true`); the return is the combined list `graph.rs` nodes and contracts.
pub fn conflate(
    streets: Vec<ProtoEdge>,
    paths: Vec<ProtoEdge>,
    names: &[String],
    meters_per_unit: (f64, f64),
) -> (Vec<ProtoEdge>, ConflateStats) {
    let osm_ways = paths.len();
    let osm_km = paths.iter().map(|way| f64::from(way.length)).sum::<f64>() / 1000.0;

    let grid = SegmentGrid::new(&streets, meters_per_unit);

    // Step 1: drop OSM ways that duplicate a walkable CSCL segment.
    let mut deduped_ways = 0usize;
    let mut deduped_km = 0.0;
    let mut ways: Vec<ProtoEdge> = Vec::with_capacity(paths.len());
    for way in paths {
        if aligned_fraction(
            &way,
            &grid,
            &streets,
            DEDUP_METERS,
            None,
            names,
            meters_per_unit,
        ) >= DEDUP_FRACTION
        {
            deduped_ways += 1;
            deduped_km += f64::from(way.length) / 1000.0;
        } else {
            ways.push(way);
        }
    }

    // Step 2: node the OSM ways among themselves — split a way at an interior vertex that coincides
    // with another way's endpoint (a shared OSM node, so equality is exact).
    let mut endpoints: HashSet<Point> = HashSet::new();
    for way in &ways {
        endpoints.insert((way.poly_x[0], way.poly_y[0]));
        endpoints.insert((
            *way.poly_x.last().expect("a vertex"),
            *way.poly_y.last().expect("a vertex"),
        ));
    }
    let mut osm_t_splits = 0usize;
    let mut noded: Vec<ProtoEdge> = Vec::with_capacity(ways.len());
    for way in ways {
        let last = way.poly_x.len() - 1;
        let cuts: Vec<usize> = (1..last)
            .filter(|&vertex| endpoints.contains(&(way.poly_x[vertex], way.poly_y[vertex])))
            .collect();
        if cuts.is_empty() {
            noded.push(way);
        } else {
            osm_t_splits += cuts.len();
            noded.extend(split_at_vertices(&way, &cuts, meters_per_unit));
        }
    }
    let ways = noded;

    // Step 2b: the orphan band — the wider dedup, which asks for two more witnesses than geometry
    // (same street name as the CSCL segment it parallels, and no node shared with any other OSM
    // way). DESIGN.md, "The order conflation runs in", is why both are required.
    let mut way_ends: HashMap<Point, usize> = HashMap::new();
    for way in &ways {
        let last = way.poly_x.len() - 1;
        *way_ends.entry((way.poly_x[0], way.poly_y[0])).or_default() += 1;
        *way_ends
            .entry((way.poly_x[last], way.poly_y[last]))
            .or_default() += 1;
    }
    let mut deduped_orphan_ways = 0usize;
    let mut deduped_orphan_km = 0.0;
    let mut kept: Vec<ProtoEdge> = Vec::with_capacity(ways.len());
    for way in ways {
        let last = way.poly_x.len() - 1;
        let standalone = way.flags & STRUCTURE_FLAG == 0
            && way_ends[&(way.poly_x[0], way.poly_y[0])] == 1
            && way_ends[&(way.poly_x[last], way.poly_y[last])] == 1;
        let way_name = street_key(way.name_id, names);
        if standalone
            && way_name.is_some()
            && aligned_fraction(
                &way,
                &grid,
                &streets,
                ORPHAN_DEDUP_METERS,
                way_name.as_deref(),
                names,
                meters_per_unit,
            ) >= DEDUP_FRACTION
        {
            deduped_orphan_ways += 1;
            deduped_orphan_km += f64::from(way.length) / 1000.0;
        } else {
            kept.push(way);
        }
    }
    let ways = kept;

    // Step 3: weld at-grade crossings — move each vertex of a non-structure OSM way onto the nearest
    // non-structure CSCL segment within 4 m and record the CSCL split there.
    let mut cscl_splits_by_proto: HashMap<usize, Vec<CsclSplit>> = HashMap::new();
    let mut welded_coords: HashSet<Point> = HashSet::new();
    let mut welded_vertices = 0usize;
    let mut welded: Vec<ProtoEdge> = Vec::with_capacity(ways.len());
    for mut way in ways {
        if way.flags & STRUCTURE_FLAG != 0 {
            welded.push(way);
            continue;
        }
        let last = way.poly_x.len() - 1;
        let mut interior_cuts: Vec<usize> = Vec::new();
        for vertex in 0..=last {
            let point = (way.poly_x[vertex], way.poly_y[vertex]);
            let Some((proto_index, seg, param, projected, _)) =
                nearest_street(&grid, &streets, point, WELD_METERS, true, meters_per_unit)
            else {
                continue;
            };
            way.poly_x[vertex] = projected.0;
            way.poly_y[vertex] = projected.1;
            welded_coords.insert(projected);
            welded_vertices += 1;
            let along = street_along(&streets[proto_index], seg, param, meters_per_unit);
            cscl_splits_by_proto
                .entry(proto_index)
                .or_default()
                .push(CsclSplit {
                    along,
                    point: projected,
                });
            if vertex != 0 && vertex != last {
                interior_cuts.push(vertex);
            }
        }
        if interior_cuts.is_empty() {
            welded.push(way);
        } else {
            welded.extend(split_at_vertices(&way, &interior_cuts, meters_per_unit));
        }
    }
    let mut ways = welded;

    // Step 4: entrance snap — a dangling OSM endpoint (degree 1, unwelded) reaches to the nearest
    // non-structure CSCL segment within 20 m, accepted only if the connector continues the way's
    // exit direction (the continuation guard).
    let mut endpoint_degree: HashMap<Point, usize> = HashMap::new();
    for way in &ways {
        *endpoint_degree
            .entry((way.poly_x[0], way.poly_y[0]))
            .or_default() += 1;
        *endpoint_degree
            .entry((
                *way.poly_x.last().expect("a vertex"),
                *way.poly_y.last().expect("a vertex"),
            ))
            .or_default() += 1;
    }
    let mut entrance_snaps = 0usize;
    let mut short_entrance_snaps = 0usize;
    let mut dangling_ends = 0usize;
    for way in &mut ways {
        for at_start in [true, false] {
            let last = way.poly_x.len() - 1;
            let endpoint = if at_start {
                (way.poly_x[0], way.poly_y[0])
            } else {
                (way.poly_x[last], way.poly_y[last])
            };
            let connected = endpoint_degree.get(&endpoint).copied().unwrap_or(0) >= 2
                || welded_coords.contains(&endpoint);
            if connected {
                continue;
            }
            let Some((proto_index, seg, param, projected, gap)) = nearest_street(
                &grid,
                &streets,
                endpoint,
                ENTRANCE_METERS,
                true,
                meters_per_unit,
            ) else {
                dangling_ends += 1;
                continue;
            };
            // The exit bearing points out of the endpoint along the way's last segment; the
            // connector must continue it, not run across it.
            let interior = if at_start {
                first_distinct(&way.poly_x, &way.poly_y, 0, 1)
            } else {
                first_distinct(&way.poly_x, &way.poly_y, last, -1)
            };
            let Some(interior_vertex) = interior else {
                dangling_ends += 1;
                continue;
            };
            let exit = bearing_degrees(
                (way.poly_x[interior_vertex], way.poly_y[interior_vertex]),
                endpoint,
                meters_per_unit,
            );
            let connector = bearing_degrees(endpoint, projected, meters_per_unit);
            let turned = directed_angle(exit, connector) > CONTINUATION_DEGREES;
            if turned && gap > CONTINUATION_FREE_METERS {
                dangling_ends += 1;
                continue;
            }
            if turned {
                short_entrance_snaps += 1;
            }
            let along = street_along(&streets[proto_index], seg, param, meters_per_unit);
            cscl_splits_by_proto
                .entry(proto_index)
                .or_default()
                .push(CsclSplit {
                    along,
                    point: projected,
                });
            let connector_meters = meters_between(endpoint, projected, meters_per_unit) as f32;
            if at_start {
                way.poly_x.insert(0, projected.0);
                way.poly_y.insert(0, projected.1);
            } else {
                way.poly_x.push(projected.0);
                way.poly_y.push(projected.1);
            }
            way.length += connector_meters;
            entrance_snaps += 1;
        }
    }

    // Step 5: apply the CSCL splits. Per proto, sort the split positions, merge any within 2 m of
    // each other or of an existing vertex/endpoint, cut the geometry, and record how each merged
    // split's projection point must move so the OSM vertex on it lands exactly on the cut.
    let mut streets = streets;
    let mut relocate: HashMap<Point, Point> = HashMap::new();
    let mut cscl_splits = 0usize;
    let mut split_streets: Vec<ProtoEdge> = Vec::with_capacity(streets.len());
    let mut proto_splits: Vec<Option<Vec<CsclSplit>>> = (0..streets.len()).map(|_| None).collect();
    for (proto_index, splits) in cscl_splits_by_proto {
        proto_splits[proto_index] = Some(splits);
    }
    for (proto_index, proto) in streets.drain(..).enumerate() {
        let Some(mut splits) = proto_splits[proto_index].take() else {
            split_streets.push(proto);
            continue;
        };
        splits.sort_by(|left, right| left.along.total_cmp(&right.along));
        let vertex_along = vertex_prefix(&proto.poly_x, &proto.poly_y, meters_per_unit);
        let last = proto.poly_x.len() - 1;

        // Existing interior vertices chosen as cuts, and new points to insert, both keyed by their
        // along-distance; every merged split records its projection point's final coordinate.
        let mut existing_cuts: HashSet<usize> = HashSet::new();
        let mut inserted: Vec<(f64, Point)> = Vec::new();
        for split in &splits {
            // Nearest existing vertex by along-distance (a proxy for metres on the polyline).
            let mut nearest_vertex = 0usize;
            let mut nearest_gap = f64::INFINITY;
            for (vertex, &along) in vertex_along.iter().enumerate() {
                let gap = (along - split.along).abs();
                if gap < nearest_gap {
                    nearest_gap = gap;
                    nearest_vertex = vertex;
                }
            }
            if nearest_gap <= SPLIT_MERGE_METERS {
                let target = (proto.poly_x[nearest_vertex], proto.poly_y[nearest_vertex]);
                if split.point != target {
                    relocate.insert(split.point, target);
                }
                if nearest_vertex != 0 && nearest_vertex != last {
                    existing_cuts.insert(nearest_vertex);
                }
                continue;
            }
            // Merge into an earlier inserted cut within 2 m, else start a new one.
            if let Some((_, target)) = inserted
                .iter()
                .find(|(along, _)| (along - split.along).abs() <= SPLIT_MERGE_METERS)
                .copied()
            {
                if split.point != target {
                    relocate.insert(split.point, target);
                }
            } else {
                inserted.push((split.along, split.point));
            }
        }

        if existing_cuts.is_empty() && inserted.is_empty() {
            split_streets.push(proto);
            continue;
        }

        // Weave the inserted points into the polyline by along-distance, then cut at every interior
        // cut vertex (existing plus inserted).
        let mut vertices: Vec<(f64, Point, bool)> = Vec::with_capacity(last + 1 + inserted.len());
        for (vertex, &along) in vertex_along.iter().enumerate() {
            vertices.push((
                along,
                (proto.poly_x[vertex], proto.poly_y[vertex]),
                existing_cuts.contains(&vertex),
            ));
        }
        for (along, point) in inserted {
            vertices.push((along, point, true));
        }
        vertices.sort_by(|left, right| left.0.total_cmp(&right.0));

        let mut woven = ProtoEdge {
            poly_x: vertices.iter().map(|entry| entry.1.0).collect(),
            poly_y: vertices.iter().map(|entry| entry.1.1).collect(),
            length: proto.length,
            cover_left: proto.cover_left,
            cover_right: proto.cover_right,
            offset: proto.offset,
            flags: proto.flags,
            name_id: proto.name_id,
            osm: proto.osm,
            source_id: proto.source_id,
        };
        let woven_last = woven.poly_x.len() - 1;
        let cuts: Vec<usize> = (1..woven_last)
            .filter(|&vertex| vertices[vertex].2)
            .collect();
        cscl_splits += cuts.len();
        // Endpoints re-pinned by graph.rs's node merge, so a weave that added no interior cut (all
        // splits snapped to an endpoint) stays a single edge.
        if cuts.is_empty() {
            woven.poly_x = proto.poly_x;
            woven.poly_y = proto.poly_y;
            split_streets.push(woven);
        } else {
            split_streets.extend(split_at_vertices(&woven, &cuts, meters_per_unit));
        }
    }

    // Relocate the OSM vertices whose projection points were merged onto an existing CSCL vertex or
    // an earlier cut, so a welded/snapped endpoint shares the cut's exact coordinate.
    if !relocate.is_empty() {
        for way in &mut ways {
            for vertex in 0..way.poly_x.len() {
                if let Some(&target) = relocate.get(&(way.poly_x[vertex], way.poly_y[vertex])) {
                    way.poly_x[vertex] = target.0;
                    way.poly_y[vertex] = target.1;
                }
            }
        }
    }

    let mut combined = split_streets;
    combined.extend(ways);

    // Step 6: the dangling-end merge, run on the finished list so it sees every weld, snap and split
    // the steps above made.
    let merged_dangling_ends = merge_dangling_ends(&mut combined, meters_per_unit);

    let stats = ConflateStats {
        deduped_ways,
        deduped_km,
        deduped_orphan_ways,
        deduped_orphan_km,
        osm_t_splits,
        welded_vertices,
        entrance_snaps,
        short_entrance_snaps,
        dangling_ends,
        merged_dangling_ends,
        cscl_splits,
        osm_ways,
        osm_km,
    };
    (combined, stats)
}

/// Step 6: pull a dangling OSM end onto the node it is standing on — one within
/// `DANGLING_MERGE_METERS` of it and more than `DANGLING_DETOUR_METERS` away through the network.
/// DESIGN.md, "The order conflation runs in", is why both conditions are required and why the end
/// that moves is always OSM's. Returns the number of ends moved.
fn merge_dangling_ends(protos: &mut [ProtoEdge], meters_per_unit: (f64, f64)) -> usize {
    let mut node_of: HashMap<Point, u32> = HashMap::new();
    let mut node_point: Vec<Point> = Vec::new();
    let mut ends: Vec<(u32, u32)> = Vec::with_capacity(protos.len());
    for proto in protos.iter() {
        let last = proto.poly_x.len() - 1;
        let mut intern = |point: Point| -> u32 {
            let next = node_point.len() as u32;
            *node_of.entry(point).or_insert_with(|| {
                node_point.push(point);
                next
            })
        };
        let node_a = intern((proto.poly_x[0], proto.poly_y[0]));
        let node_b = intern((proto.poly_x[last], proto.poly_y[last]));
        ends.push((node_a, node_b));
    }
    let node_count = node_point.len();

    // The conflated network as an adjacency list, plus the two facts a merge is judged on: whether
    // a node is a bridge or tunnel deck (grade separation the plan-view geometry cannot see), and its
    // one incident proto when it is dangling.
    let mut adjacency: Vec<Vec<(u32, f64)>> = vec![Vec::new(); node_count];
    let mut structure: Vec<bool> = vec![false; node_count];
    let mut sole_proto: Vec<u32> = vec![u32::MAX; node_count];
    for (proto_index, &(node_a, node_b)) in ends.iter().enumerate() {
        let proto = &protos[proto_index];
        let length = f64::from(proto.length).max(0.0);
        adjacency[node_a as usize].push((node_b, length));
        adjacency[node_b as usize].push((node_a, length));
        for node in [node_a, node_b] {
            structure[node as usize] |= proto.flags & STRUCTURE_FLAG != 0;
            sole_proto[node as usize] = proto_index as u32;
        }
    }

    let cell_units_x = (GRID_CELL_METERS / meters_per_unit.0).floor().max(1.0) as i32;
    let cell_units_y = (GRID_CELL_METERS / meters_per_unit.1).floor().max(1.0) as i32;
    let mut cells: HashMap<Point, Vec<u32>> = HashMap::new();
    for (node, point) in node_point.iter().enumerate() {
        cells
            .entry((
                point.0.div_euclid(cell_units_x),
                point.1.div_euclid(cell_units_y),
            ))
            .or_default()
            .push(node as u32);
    }

    let mut parent: Vec<u32> = (0..node_count as u32).collect();
    let mut merged = 0usize;
    for node in 0..node_count {
        if adjacency[node].len() != 1 || structure[node] {
            continue;
        }
        let proto_index = sole_proto[node] as usize;
        if !protos[proto_index].osm {
            continue;
        }
        let point = node_point[node];
        let cell = (
            point.0.div_euclid(cell_units_x),
            point.1.div_euclid(cell_units_y),
        );
        let mut candidates: Vec<(f64, u32)> = Vec::new();
        for cell_x in cell.0 - 1..=cell.0 + 1 {
            for cell_y in cell.1 - 1..=cell.1 + 1 {
                for &other in cells.get(&(cell_x, cell_y)).into_iter().flatten() {
                    if other as usize == node || structure[other as usize] {
                        continue;
                    }
                    let gap = meters_between(point, node_point[other as usize], meters_per_unit);
                    if gap <= DANGLING_MERGE_METERS {
                        candidates.push((gap, other));
                    }
                }
            }
        }
        if candidates.is_empty() {
            continue;
        }
        candidates.sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.cmp(&right.1)));
        let reached = reachable_within(
            &adjacency,
            node as u32,
            DANGLING_DETOUR_METERS,
            &candidates.iter().map(|&(_, other)| other).collect(),
        );
        // The other end of the dangling proto is where it already leads; merging onto that (or onto
        // anything already fused with it) would fold the proto into a degenerate loop.
        let own_far_end = if ends[proto_index].0 == node as u32 {
            ends[proto_index].1
        } else {
            ends[proto_index].0
        };
        for &(_, other) in &candidates {
            if reached.contains(&other) {
                continue;
            }
            let (from_root, to_root) = (find(&mut parent, node as u32), find(&mut parent, other));
            if from_root == to_root || to_root == find(&mut parent, own_far_end) {
                continue;
            }
            parent[from_root as usize] = to_root;
            merged += 1;
            break;
        }
    }
    if merged == 0 {
        return 0;
    }

    for (proto_index, proto) in protos.iter_mut().enumerate() {
        let last = proto.poly_x.len() - 1;
        for (vertex, node) in [(0, ends[proto_index].0), (last, ends[proto_index].1)] {
            let target = node_point[find(&mut parent, node) as usize];
            proto.poly_x[vertex] = target.0;
            proto.poly_y[vertex] = target.1;
        }
    }
    merged
}

/// What a bounded walk needs of a network: a node's neighbours, each with its length in metres. It
/// is a trait because callers hold their adjacency differently — indexed by node here, keyed by it
/// in `graph.rs` — and nothing else about the walk changes with that.
pub trait Adjacency {
    fn neighbours(&self, node: u32) -> &[(u32, f64)];
}

impl Adjacency for [Vec<(u32, f64)>] {
    fn neighbours(&self, node: u32) -> &[(u32, f64)] {
        &self[node as usize]
    }
}

/// Everything within `cap` metres of `source` through the network, in ascending distance — a Dijkstra
/// that stops at the cap, so it walks a block, not a borough. `settle` sees each node once, at its
/// own distance, and breaks the walk off as soon as it has seen enough.
pub fn walk_within<A: Adjacency + ?Sized>(
    adjacency: &A,
    source: u32,
    cap: f64,
    mut settle: impl FnMut(u32) -> ControlFlow<()>,
) {
    let mut best: HashMap<u32, f64> = HashMap::from([(source, 0.0)]);
    // Centimetres, so the queue orders on an integer key; the cap keeps the frontier tiny.
    let mut queue: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::from([Reverse((0, source))]);
    while let Some(Reverse((centimetres, node))) = queue.pop() {
        let distance = centimetres as f64 / 100.0;
        if best
            .get(&node)
            .is_some_and(|&incumbent| distance > incumbent + 0.01)
        {
            continue;
        }
        if settle(node).is_break() {
            return;
        }
        for &(next, length) in adjacency.neighbours(node) {
            let step = distance + length;
            if step > cap {
                continue;
            }
            if best.get(&next).is_none_or(|&incumbent| step < incumbent) {
                best.insert(next, step);
                queue.push(Reverse(((step * 100.0) as u64, next)));
            }
        }
    }
}

/// Which of `targets` lie within `cap` metres of `source` through the network.
fn reachable_within(
    adjacency: &[Vec<(u32, f64)>],
    source: u32,
    cap: f64,
    targets: &HashSet<u32>,
) -> HashSet<u32> {
    let mut reached: HashSet<u32> = HashSet::new();
    walk_within(adjacency, source, cap, |node| {
        if targets.contains(&node) {
            reached.insert(node);
            if reached.len() == targets.len() {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    });
    reached
}

/// Union-find over the merge groups: the root's coordinate is the one every end in the group lands
/// on, and a group only ever grows toward the node a dangling end was pulled to.
fn find(parent: &mut [u32], node: u32) -> u32 {
    let mut root = node;
    while parent[root as usize] != root {
        root = parent[root as usize];
    }
    let mut walk = node;
    while parent[walk as usize] != root {
        let next = parent[walk as usize];
        parent[walk as usize] = root;
        walk = next;
    }
    root
}

/// The along-distance in metres to a projection at parameter `param` on sub-segment `seg` of a
/// proto — the prefix length to `seg` plus the fraction of that sub-segment.
fn street_along(proto: &ProtoEdge, seg: usize, param: f64, meters_per_unit: (f64, f64)) -> f64 {
    let mut prefix = 0.0;
    for vertex in 1..=seg {
        prefix += meters_between(
            (proto.poly_x[vertex - 1], proto.poly_y[vertex - 1]),
            (proto.poly_x[vertex], proto.poly_y[vertex]),
            meters_per_unit,
        );
    }
    let span = meters_between(
        (proto.poly_x[seg], proto.poly_y[seg]),
        (proto.poly_x[seg + 1], proto.poly_y[seg + 1]),
        meters_per_unit,
    );
    prefix + param * span
}

/// The cumulative along-distance of every vertex of a polyline.
fn vertex_prefix(poly_x: &[i32], poly_y: &[i32], meters_per_unit: (f64, f64)) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(poly_x.len());
    prefix.push(0.0);
    for vertex in 1..poly_x.len() {
        let step = meters_between(
            (poly_x[vertex - 1], poly_y[vertex - 1]),
            (poly_x[vertex], poly_y[vertex]),
            meters_per_unit,
        );
        prefix.push(prefix[vertex - 1] + step);
    }
    prefix
}

/// The first vertex distinct from `origin`, scanning in `step` direction (+1 forward, -1 back), for
/// the exit bearing at an endpoint.
fn first_distinct(poly_x: &[i32], poly_y: &[i32], origin: usize, step: isize) -> Option<usize> {
    let mut vertex = origin as isize + step;
    while vertex >= 0 && (vertex as usize) < poly_x.len() {
        let index = vertex as usize;
        if poly_x[index] != poly_x[origin] || poly_y[index] != poly_y[origin] {
            return Some(index);
        }
        vertex += step;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // A metre-per-unit frame of exactly 1, so quantized units are metres and fixtures read in
    // metres directly.
    const MPU: (f64, f64) = (1.0, 1.0);

    fn street(poly: &[(i32, i32)]) -> ProtoEdge {
        line(poly, false, 0)
    }

    fn path(poly: &[(i32, i32)]) -> ProtoEdge {
        line(poly, true, 4) // GRPH_PATHLIKE, as an OSM proto carries
    }

    fn line(poly: &[(i32, i32)], osm: bool, flags: u8) -> ProtoEdge {
        let poly_x: Vec<i32> = poly.iter().map(|point| point.0).collect();
        let poly_y: Vec<i32> = poly.iter().map(|point| point.1).collect();
        let length = polyline_meters(&poly_x, &poly_y, MPU) as f32;
        ProtoEdge {
            poly_x,
            poly_y,
            length,
            cover_left: 0,
            cover_right: 0,
            offset: if osm { 0 } else { 40 },
            flags,
            name_id: 0xFFFF,
            osm,
            source_id: 0,
        }
    }

    fn with_source_id(mut edge: ProtoEdge, source_id: u32) -> ProtoEdge {
        edge.source_id = source_id;
        edge
    }

    #[test]
    fn duplicate_way_beside_a_street_is_dropped() {
        let streets = vec![street(&[(0, 0), (100, 0)])];
        let paths = vec![path(&[(0, 3), (100, 3)])]; // parallel, 3 m off, aligned bearing
        let (combined, stats) = conflate(streets, paths, &[], MPU);
        assert_eq!(stats.deduped_ways, 1);
        assert!(
            combined.iter().all(|edge| !edge.osm),
            "the duplicate is gone"
        );
    }

    #[test]
    fn oblique_crossing_is_not_deduped() {
        let streets = vec![street(&[(0, 0), (100, 0)])];
        // Crosses the street at a right angle: samples are within 6 m only briefly and never
        // bearing-aligned, so it survives.
        let paths = vec![path(&[(50, -40), (50, 40)])];
        let (combined, stats) = conflate(streets, paths, &[], MPU);
        assert_eq!(stats.deduped_ways, 0);
        assert!(combined.iter().any(|edge| edge.osm));
    }

    #[test]
    fn shared_vertex_splits_the_through_way() {
        // Way A runs through a vertex that is way B's endpoint: A is T-split there.
        let through = path(&[(0, 0), (50, 0), (100, 0)]);
        let stem = path(&[(50, 0), (50, 50)]);
        let (combined, stats) = conflate(vec![], vec![through, stem], &[], MPU);
        assert_eq!(stats.osm_t_splits, 1);
        assert_eq!(combined.iter().filter(|edge| edge.osm).count(), 3);
    }

    #[test]
    fn greenway_crossing_two_streets_welds_and_splits_both() {
        let streets = vec![
            street(&[(0, -50), (0, 50)]),
            street(&[(100, -50), (100, 50)]),
        ];
        // A vertex sits on each crossing (a shared OSM node), so both weld.
        let greenway = path(&[(-20, 0), (0, 0), (100, 0), (120, 0)]);
        let (combined, stats) = conflate(streets, vec![greenway], &[], MPU);
        assert_eq!(stats.welded_vertices, 2);
        assert_eq!(stats.cscl_splits, 2);
        // Each street cut in two, the greenway cut at both crossings.
        assert_eq!(combined.iter().filter(|edge| !edge.osm).count(), 4);
        assert_eq!(combined.iter().filter(|edge| edge.osm).count(), 3);
    }

    #[test]
    fn every_piece_of_a_cut_edge_keeps_its_source_id() {
        let streets = vec![with_source_id(street(&[(0, -50), (0, 50)]), 11)];
        // A T-split among the ways and a weld-driven CSCL split, so both cut paths run.
        let greenway = with_source_id(path(&[(-20, 0), (0, 0), (20, 0)]), 22);
        let stem = with_source_id(path(&[(20, 0), (20, 40)]), 33);
        let (combined, _) = conflate(streets, vec![greenway, stem], &[], MPU);
        assert_eq!(
            combined.iter().filter(|edge| edge.source_id == 11).count(),
            2,
            "the street was cut in two"
        );
        assert_eq!(
            combined.iter().filter(|edge| edge.source_id == 22).count(),
            2,
            "the greenway was cut at the crossing"
        );
        assert_eq!(
            combined.iter().filter(|edge| edge.source_id == 33).count(),
            1
        );
    }

    #[test]
    fn entrance_snap_accepts_a_continuation_and_rejects_a_fence_parallel() {
        let streets = vec![street(&[(-50, 0), (50, 0)])];
        // Heads south toward the curb: exit and connector both point south, accepted.
        let entering = path(&[(0, 20), (0, 5)]);
        // Runs parallel 15 m off (too far to dedup): its endpoints exit east/west while the
        // connector would cross south, ~90°, rejected.
        let fence = path(&[(-30, 15), (30, 15)]);
        let (combined, stats) = conflate(streets, vec![entering, fence], &[], MPU);
        assert_eq!(stats.entrance_snaps, 1);
        // The accepted way grew a connector vertex reaching the curb.
        let reaches = combined
            .iter()
            .filter(|edge| edge.osm)
            .any(|edge| edge.poly_y.contains(&0));
        assert!(reaches, "the accepted entrance reaches the street");
        // The street was split once by the accepted entrance.
        assert_eq!(stats.cscl_splits, 1);
    }

    #[test]
    fn splits_at_a_segment_end_merge_onto_the_endpoint() {
        let streets = vec![street(&[(0, 0), (100, 0)])];
        // Two entrances land within 2 m of the street's start endpoint (and beyond the 4 m weld
        // radius, so they entrance-snap rather than weld): both snap to it, no sliver.
        let first = path(&[(1, 10), (1, 5)]);
        let second = path(&[(2, 12), (2, 5)]);
        let (combined, stats) = conflate(streets, vec![first, second], &[], MPU);
        assert_eq!(stats.entrance_snaps, 2);
        assert_eq!(stats.cscl_splits, 0, "endpoint snaps add no interior cut");
        assert_eq!(
            combined.iter().filter(|edge| !edge.osm).count(),
            1,
            "the street stays one edge"
        );
        // Both OSM endpoints were relocated onto the shared street endpoint.
        let on_origin = combined
            .iter()
            .filter(|edge| edge.osm)
            .filter(|edge| {
                (edge.poly_x[0] == 0 && edge.poly_y[0] == 0)
                    || (*edge.poly_x.last().unwrap() == 0 && *edge.poly_y.last().unwrap() == 0)
            })
            .count();
        assert_eq!(on_origin, 2);
    }

    #[test]
    fn a_short_connector_snaps_whatever_direction_it_turns() {
        let streets = vec![street(&[(-50, 0), (50, 0)])];
        // Ends 7 m from the curb running east, so the connector turns ~90° south to reach it —
        // past the 6 m dedup band, inside the right-of-way half-width where the guard is waived.
        let inside = path(&[(-20, 7), (20, 7)]);
        let (_, stats) = conflate(streets.clone(), vec![inside], &[], MPU);
        assert_eq!(stats.entrance_snaps, 2, "both ends reach the curb");
        assert_eq!(
            stats.short_entrance_snaps, 2,
            "both only because of the waiver"
        );
        // The same way 12 m out is beyond the half-width: the guard turns both ends away.
        let outside = path(&[(-20, 12), (20, 12)]);
        let (_, stats) = conflate(streets, vec![outside], &[], MPU);
        assert_eq!(stats.entrance_snaps, 0);
    }

    #[test]
    fn a_named_orphan_lying_on_its_own_street_is_dropped() {
        let names = vec!["COENTIES ALY".to_string(), "COENTIES ALLEY".to_string()];
        let mut alley = street(&[(0, 0), (100, 0)]);
        alley.name_id = 0;
        // 8 m off — past the 6 m band — and standalone, so only the orphan band can see it.
        let mut remapped = path(&[(0, 8), (100, 8)]);
        remapped.name_id = 1;
        let (combined, stats) = conflate(vec![alley.clone()], vec![remapped.clone()], &names, MPU);
        assert_eq!(stats.deduped_ways, 0, "the 6 m band does not reach it");
        assert_eq!(stats.deduped_orphan_ways, 1);
        assert!(combined.iter().all(|edge| !edge.osm));

        // The same geometry under any other name is a path that merely runs beside the street.
        let mut greenway = remapped.clone();
        greenway.name_id = UNNAMED_FIXTURE;
        let (_, stats) = conflate(vec![alley.clone()], vec![greenway], &names, MPU);
        assert_eq!(stats.deduped_orphan_ways, 0);

        // And so is one that meets another way — a network member, not a lone re-mapping.
        let joined = path(&[(100, 8), (140, 40)]);
        let (_, stats) = conflate(vec![alley], vec![remapped, joined], &names, MPU);
        assert_eq!(stats.deduped_orphan_ways, 0);
    }

    // The name id a PATH record carries when OSM gave the way no name.
    const UNNAMED_FIXTURE: u16 = 0xFFFF;

    #[test]
    fn a_dangling_end_merges_onto_a_node_a_block_away_through_the_network() {
        // A U of three ways: the free end of the right arm stops 2 m short of the left arm's, and
        // the walk between them through the network is the whole 140 m of the U.
        let left = path(&[(0, 0), (0, 50)]);
        let base = path(&[(0, 0), (40, 0)]);
        let right = path(&[(40, 0), (40, 50), (2, 50)]);
        let (combined, stats) = conflate(vec![], vec![left, base, right], &[], MPU);
        assert_eq!(stats.merged_dangling_ends, 1);
        let free_ends: HashSet<Point> = combined
            .iter()
            .map(|edge| {
                let last = edge.poly_x.len() - 1;
                (edge.poly_x[last], edge.poly_y[last])
            })
            .collect();
        assert_eq!(free_ends.len(), 2, "the two free ends became one node");
        assert!(free_ends.contains(&(40, 0)));
    }

    #[test]
    fn a_dangling_end_beside_its_own_junction_is_left_alone() {
        // The same 2 m gap, but only 38 m apart through the network — a stub beside a junction it
        // already reaches, not a seam.
        let spine = path(&[(0, 0), (0, 10)]);
        let arm = path(&[(0, 10), (10, 10), (10, 2), (0, 2)]);
        let (combined, stats) = conflate(vec![], vec![spine, arm], &[], MPU);
        assert_eq!(stats.merged_dangling_ends, 0);
        assert!(
            combined
                .iter()
                .any(|edge| *edge.poly_x.last().expect("a vertex") == 0
                    && *edge.poly_y.last().expect("a vertex") == 2),
            "the arm still ends where it did"
        );
    }
}
