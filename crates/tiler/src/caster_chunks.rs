//! `tiler caster-chunks`: bakes the shadow CASTERS — building footprints with their roof heights,
//! canopy crowns with their measured ones, census trunks holding those crowns up — into one chunk
//! per z15 tile at public/casters/{x}/{y}.bin, so the client can sweep the shadows itself past where
//! the baked raster pyramid stops. `tiler chunks` is the model: the same bucketing, the same
//! varint-delta codec, the same manifest conventions.
//!
//! A caster is CLIPPED to the chunk it ships in, so a canopy blob spanning fifty tiles costs its
//! own area once rather than fifty whole copies. That is lossless for what the client does with
//! it: a Minkowski sweep distributes over a union, so sweeping the pieces and unioning gives the
//! same shadow as sweeping the whole, and the pieces union back to the same footprint for the base
//! punch-out.
//!
//! Footprints ship at full source detail; crown outlines are simplified first, by
//! `CROWN_SIMPLIFY_METERS`, since theirs is a raster staircase no zoom this feeds can resolve. See
//! scripts/README.md.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::Fallible;
use crate::binfmt::{self, Coord, DECIMETERS_PER_METER, Polygon, Ring, write_varint, zigzag};
use crate::geometry::{Projection, round_half_up};
use crate::manifest::{City, Manifest};
use crate::raster::{
    TILE_SIZE, lat_to_pixel_y, lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat, tile_index,
};
use crate::shade;

// layouts: scripts/README.md
const CASTER_FORMAT: u16 = 2;
const CASTER_HEADER_BYTES: usize = 44;
// Degrees per quantized unit, ~0.1 m — the grid the two sources are themselves stored on, so the
// only coordinate error a chunk adds is the half unit of re-quantizing about its own origin.
const CASTER_COORD_SCALE: f64 = 1e-6;
// The zoom the baked pyramid stops at, so it is also the grid the client fetches its casters on.
const CHUNK_ZOOM: u32 = 15;
// Douglas-Peucker tolerance for crown outlines, DISPLAY ONLY — data/canopy/<id>.bin keeps the exact
// rings and everything that reads them, the routing field and the baked pyramid alike, is untouched.
// The outlines are traced from a 1-foot LiDAR raster, so they are a staircase of ~0.3 m steps; this
// is two thirds of a z17 pixel (0.91 m), the finest ground these chunks are ever drawn at, and just
// clear of the step, which is what collapses the whole staircase instead of decimating it.
const CROWN_SIMPLIFY_METERS: f64 = 0.6;

// The crown allometry of scripts/build-tree-data.ts run BACKWARDS, to recover the trunk the crown
// radius was grown from: crownDiameter = exp(a + b*ln(ln(dbh_cm + 1)) + bias) is monotone in dbh, so
// the inversion is exact wherever a dbh was what produced the crown.
const CROWN_A: f64 = -0.752;
const CROWN_B: f64 = 2.414;
const CROWN_LOG_BIAS: f64 = 0.00988;
// The dbh the inversion is allowed to return, 1 and 60 inches in centimetres. Only the upper bound
// mirrors the forward pass, which clamps there (MAX_DBH_INCHES in scripts/build-tree-data.ts); the
// lower one is this side's own floor, since the forward pass imputes a missing dbh to its median
// rather than clamping and so never produces a small one to mirror.
const MIN_DBH_CM: f64 = 2.54;
const MAX_DBH_CM: f64 = 152.4;
const CENTIMETERS_PER_METER: f64 = 100.0;

pub struct Args {
    pub manifest: PathBuf,
    pub data: PathBuf,
    pub chunks: PathBuf,
    pub params: PathBuf, // the sun-position file `tiler shade` reads, for max_shadow_meters
}

/// One shadow caster as it ships: the source polygon's rings in degrees, outer first, and the height
/// it casts from in decimetres — the unit both source files store.
struct Caster {
    rings: Polygon,
    height_dm: u16,
}

/// One trunk as it ships: where it stands, how thick it is in centimetres of RADIUS — the decimetre
/// the crown byte is quantized on is coarser than a whole median trunk — and how high it stands
/// before its crown starts, in the decimetres the crown heights are stored in.
struct Trunk {
    coord: Coord,
    radius_cm: u8,
    height_dm: u16,
}

/// A chunk's members, by section: indices into the city's caster lists.
#[derive(Default)]
struct Members {
    buildings: Vec<u32>,
    crowns: Vec<u32>,
    trunks: Vec<u32>,
}

/// What the client needs before it can fetch anything: the grid the chunks are cut on, the codec's
/// quantization, the halo radius a viewport has to gather casters over — a shadow reaches into the
/// view from that far outside it — and which chunks exist, since a 500 m halo spans dozens of z15
/// tiles and this is what keeps the empty ones from being dozens of 404s.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkManifest {
    chunk_zoom: u32,
    coord_scale: f64,
    max_shadow_meters: f64,
    chunks: Vec<ChunkEntry>,
}

#[derive(Serialize)]
struct ChunkEntry {
    x: u32,
    y: u32,
    bytes: usize,
}

/// The casters one source contributes: every polygon that casts something, at full source detail. A
/// polygon that casts nothing is dropped exactly as `tiler shade` drops it: no height (the canopy
/// file's 0 unknown sentinel, a footprint with no roof) or no ring to sweep.
///
/// `holes` keeps the inner rings. A footprint needs them, since the display path punches a
/// building's base back out of the shade and a courtyard would otherwise punch as though it were
/// roof; they cost 21k vertices across the city. A crown is never punched and `tiler shade`
/// translates its outer ring alone, and its LiDAR gaps would be a quarter of everything shipped.
fn casters(polygons: &[Polygon], heights: &[f64], holes: bool) -> Vec<Caster> {
    polygons
        .iter()
        .zip(heights)
        .filter_map(|(polygon, height)| {
            let outer = polygon.first()?;
            if outer.len() < 3 || *height <= 0.0 {
                return None;
            }
            let mut rings = vec![outer.clone()];
            if holes {
                rings.extend(polygon[1..].iter().filter(|ring| ring.len() >= 3).cloned());
            }
            Some(Caster {
                rings,
                height_dm: round_half_up(height * DECIMETERS_PER_METER) as u16,
            })
        })
        .collect()
}

/// The city's crowns and their measured heights, empty when it has no canopy layer or the file is
/// missing. The 0 unknown sentinel is dropped downstream by `casters`, with the roofless footprints.
fn city_crowns(city: &City, data: &Path) -> Fallible<(Vec<Polygon>, Vec<f64>)> {
    let Some(layer) = &city.field.canopy else {
        return Ok((Vec::new(), Vec::new()));
    };
    let path = data.join("canopy").join(&layer.file);
    if !path.exists() {
        return Ok((Vec::new(), Vec::new()));
    }
    let canopy = binfmt::read_canopy(&path)?;
    let heights = canopy.heights_m();
    Ok((canopy.polygons, heights))
}

/// The trunk radius a shipped crown radius implies, in metres. Two trees the inversion cannot know
/// about ride through it: one whose dbh was MISSING carries the imputed median (crown byte 39, 7.1%
/// of the city), and an OSM tree's crown is a RECORDED diameter that was never a dbh at all, which
/// the clamp below is what keeps from inverting into a metre-thick trunk.
fn trunk_radius_m(crown_radius_m: f64) -> f64 {
    let log_log = ((2.0 * crown_radius_m).ln() - CROWN_A - CROWN_LOG_BIAS) / CROWN_B;
    let dbh_cm = (log_log.exp().exp() - 1.0).clamp(MIN_DBH_CM, MAX_DBH_CM);
    dbh_cm / 2.0 / CENTIMETERS_PER_METER
}

/// The city's trunks, one per census tree, empty when the trees blob is missing. Their heights are
/// filled in by `stand_trunks`, which is also what decides which of them ship at all.
fn city_trunks(city: &City, data: &Path) -> Fallible<Vec<Trunk>> {
    let path = data.join("trees").join(&city.field.trees.file);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let trees = binfmt::read_trees(&path)?;
    Ok(trees
        .coords
        .into_iter()
        .zip(trees.crown_radii_m)
        .map(|(coord, crown_radius_m)| Trunk {
            coord,
            radius_cm: round_half_up(trunk_radius_m(crown_radius_m) * CENTIMETERS_PER_METER) as u8,
            height_dm: 0,
        })
        .collect())
}

/// The bounding box of one ring, as a rectangle in degrees.
fn ring_box(ring: &Ring) -> Rect {
    let mut rect = Rect {
        west: f64::INFINITY,
        east: f64::NEG_INFINITY,
        south: f64::INFINITY,
        north: f64::NEG_INFINITY,
    };
    for point in ring {
        rect.west = rect.west.min(point.lng);
        rect.east = rect.east.max(point.lng);
        rect.south = rect.south.min(point.lat);
        rect.north = rect.north.max(point.lat);
    }
    rect
}

/// Every trunk given the height it stands to, with the ones that have none DROPPED: a trunk rises to
/// the crown BASE of the canopy polygon it stands under, which is the very height that polygon's own
/// shadow is now cast from, so the two shadows meet rather than leaving bare ground between them.
///
/// A census tree under no measured crown — 342,619 of NYC's 925,338, the polygon over it carrying
/// the canopy file's 0 unknown-height sentinel, or the tree being too young for the 2017 LiDAR to
/// have caught it — ships nothing. There is no crown shadow over it to join, so a trunk there would
/// be a sliver of shade the model never casts.
///
/// The search is per z15 tile, on the same buckets the chunks are cut on, and the box test is what
/// keeps it off the rings: a trunk touches a handful of outlines out of its tile's hundreds.
fn stand_trunks(trunks: Vec<Trunk>, crowns: &[Caster]) -> Vec<Trunk> {
    let boxes: Vec<Rect> = crowns
        .iter()
        .map(|crown| ring_box(&crown.rings[0]))
        .collect();
    let mut by_tile: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    bucket(crowns, |key, index| {
        by_tile.entry(key).or_default().push(index);
    });
    trunks
        .into_iter()
        .filter_map(|trunk| {
            let tile = (
                tile_index(lng_to_pixel_x(trunk.coord.lng, CHUNK_ZOOM), CHUNK_ZOOM),
                tile_index(lat_to_pixel_y(trunk.coord.lat, CHUNK_ZOOM), CHUNK_ZOOM),
            );
            let height_dm = by_tile.get(&tile)?.iter().find_map(|index| {
                let crown = &crowns[*index as usize];
                (boxes[*index as usize].contains(&trunk.coord)
                    && point_inside_ring(&crown.rings[0], &trunk.coord))
                .then_some(crown.height_dm)
            })?;
            Some(Trunk {
                height_dm: round_half_up(f64::from(height_dm) * shade::CROWN_BASE_FRACTION) as u16,
                ..trunk
            })
        })
        .collect()
}

/// How far a point lies from a segment, all three in metres.
fn segment_distance(point: (f64, f64), from: (f64, f64), to: (f64, f64)) -> f64 {
    let (run, rise) = (to.0 - from.0, to.1 - from.1);
    let length = run * run + rise * rise;
    let along = if length == 0.0 {
        0.0
    } else {
        (((point.0 - from.0) * run + (point.1 - from.1) * rise) / length).clamp(0.0, 1.0)
    };
    f64::hypot(
        point.0 - from.0 - along * run,
        point.1 - from.1 - along * rise,
    )
}

/// One ring with everything Douglas-Peucker can drop dropped, and the worst deviation that cost, in
/// metres. The kept vertices are the SOURCE coordinates, never a round trip through the projection,
/// and they keep their order, so the ring closes and winds exactly as it did.
///
/// A closed ring has no pair of fixed ends to run the recursion between, so it is cut at its first
/// vertex and the vertex farthest from that — a diameter of sorts — and each half simplified as a
/// polyline. Distance is to the SEGMENT rather than to its infinite line, which is what makes the
/// tolerance a true bound on how far the ring moves. A ring the tolerance would collapse below a
/// triangle is smaller than the tolerance itself and is kept whole.
fn simplify_ring(ring: &Ring, projection: &Projection, tolerance: f64) -> (Ring, f64) {
    let mut metres: Vec<(f64, f64)> = ring
        .iter()
        .map(|point| (projection.x(point.lng), projection.y(point.lat)))
        .collect();
    metres.push(metres[0]);
    let last = metres.len() - 1;
    let reach =
        |index: usize| f64::hypot(metres[index].0 - metres[0].0, metres[index].1 - metres[0].1);
    let far = (1..last)
        .max_by(|left, right| reach(*left).total_cmp(&reach(*right)))
        .unwrap_or(0);

    let mut keep = vec![false; metres.len()];
    keep[0] = true;
    keep[far] = true;
    keep[last] = true;
    let mut deviation = 0.0f64;
    let mut spans = vec![(0, far), (far, last)];
    while let Some((first, end)) = spans.pop() {
        let Some((at, furthest)) = (first + 1..end)
            .map(|index| {
                (
                    index,
                    segment_distance(metres[index], metres[first], metres[end]),
                )
            })
            .max_by(|left, right| left.1.total_cmp(&right.1))
        else {
            continue;
        };
        if furthest > tolerance {
            keep[at] = true;
            spans.push((first, at));
            spans.push((at, end));
        } else {
            deviation = deviation.max(furthest);
        }
    }

    let simplified: Ring = (0..ring.len())
        .filter(|index| keep[*index])
        .map(|index| ring[index])
        .collect();
    if simplified.len() < 3 {
        (ring.clone(), 0.0)
    } else {
        (simplified, deviation)
    }
}

/// Every crown's outline simplified, and the worst deviation that introduced anywhere in the city.
///
/// This runs BEFORE the bucketing and the clip, on whole polygons: two chunks that share a crown
/// would otherwise each simplify their own side of the seam and leave a gap or an overlap along it,
/// where simplifying first leaves every seam decided by the exact tile rectangle, as the clip alone
/// decided it before.
fn simplify_crowns(crowns: &mut [Caster], projection: &Projection) -> f64 {
    let mut deviation = 0.0f64;
    for crown in crowns {
        let (simplified, moved) = simplify_ring(&crown.rings[0], projection, CROWN_SIMPLIFY_METERS);
        crown.rings[0] = simplified;
        deviation = deviation.max(moved);
    }
    deviation
}

/// Buckets casters into every z15 tile their outer ring's bounding box touches, as `tiler chunks`
/// does its segments. The box only has to cover the tiles a caster could reach — the clip decides
/// what it actually leaves there, and a tile the box overshoots into is one the clip empties. A
/// caster lands where it STANDS, not where its shadow falls; gathering the casters beyond the
/// viewport is the client's halo, which is what the manifest's `maxShadowMeters` is for.
fn bucket(casters: &[Caster], mut push: impl FnMut((u32, u32), u32)) {
    for (index, caster) in casters.iter().enumerate() {
        let rect = ring_box(&caster.rings[0]);
        let min_x = tile_index(lng_to_pixel_x(rect.west, CHUNK_ZOOM), CHUNK_ZOOM);
        let max_x = tile_index(lng_to_pixel_x(rect.east, CHUNK_ZOOM), CHUNK_ZOOM);
        let min_y = tile_index(lat_to_pixel_y(rect.north, CHUNK_ZOOM), CHUNK_ZOOM);
        let max_y = tile_index(lat_to_pixel_y(rect.south, CHUNK_ZOOM), CHUNK_ZOOM);
        for tile_x in min_x..=max_x {
            for tile_y in min_y..=max_y {
                push((tile_x, tile_y), index as u32);
            }
        }
    }
}

/// Buckets trunks into the one z15 tile each stands in. A trunk is a point, so there is nothing to
/// clip and nothing to overlap: it ships whole into exactly one chunk.
fn bucket_trunks(trunks: &[Trunk], mut push: impl FnMut((u32, u32), u32)) {
    for (index, trunk) in trunks.iter().enumerate() {
        let tile_x = tile_index(lng_to_pixel_x(trunk.coord.lng, CHUNK_ZOOM), CHUNK_ZOOM);
        let tile_y = tile_index(lat_to_pixel_y(trunk.coord.lat, CHUNK_ZOOM), CHUNK_ZOOM);
        push((tile_x, tile_y), index as u32);
    }
}

/// The rectangle one chunk covers: its z15 tile's own bounds, in degrees. Tile seams are lines of
/// constant longitude and latitude, so the clip is axis-aligned in the coordinates the casters are
/// already stored in and needs no projection.
#[derive(Clone, Copy)]
struct Rect {
    west: f64,
    east: f64,
    south: f64,
    north: f64,
}

impl Rect {
    fn contains(&self, point: &Coord) -> bool {
        point.lng >= self.west
            && point.lng <= self.east
            && point.lat >= self.south
            && point.lat <= self.north
    }

    /// The four corners counter-clockwise from the south-west, so corner `index` sits at perimeter
    /// position `index`.
    fn corners(&self) -> [Coord; 4] {
        [
            Coord {
                lng: self.west,
                lat: self.south,
            },
            Coord {
                lng: self.east,
                lat: self.south,
            },
            Coord {
                lng: self.east,
                lat: self.north,
            },
            Coord {
                lng: self.west,
                lat: self.north,
            },
        ]
    }

    /// Where a point on the rectangle's boundary lies along it, in [0, 4) counter-clockwise from the
    /// south-west corner — one unit per side. Ordering these is what says which piece of a clipped
    /// ring the boundary walk reaches next. Clip points are snapped exactly onto the side they were
    /// cut against, so the equality tests here are exact; the arms are ordered so a corner belongs
    /// to the side it starts.
    fn perimeter(&self, point: &Coord) -> f64 {
        if point.lat == self.south && point.lng < self.east {
            (point.lng - self.west) / (self.east - self.west)
        } else if point.lng == self.east && point.lat < self.north {
            1.0 + (point.lat - self.south) / (self.north - self.south)
        } else if point.lat == self.north && point.lng > self.west {
            2.0 + (self.east - point.lng) / (self.east - self.west)
        } else {
            3.0 + (self.north - point.lat) / (self.north - self.south)
        }
    }

    /// The rectangle itself as a ring wound the given way — what a ring that swallows the whole
    /// chunk clips to.
    fn ring(&self, counter_clockwise: bool) -> Ring {
        let mut ring = self.corners().to_vec();
        if !counter_clockwise {
            ring.reverse();
        }
        ring
    }
}

/// The z15 tile a chunk covers.
fn tile_rect(tile_x: u32, tile_y: u32) -> Rect {
    let edge = |tile: u32| f64::from(tile) * TILE_SIZE as f64;
    Rect {
        west: pixel_x_to_lng(edge(tile_x), CHUNK_ZOOM),
        east: pixel_x_to_lng(edge(tile_x + 1), CHUNK_ZOOM),
        south: pixel_y_to_lat(edge(tile_y + 1), CHUNK_ZOOM),
        north: pixel_y_to_lat(edge(tile_y), CHUNK_ZOOM),
    }
}

fn same(left: &Coord, right: &Coord) -> bool {
    left.lng == right.lng && left.lat == right.lat
}

/// Twice the area the ring encloses by the shoelace sum, SIGNED: positive counter-clockwise. The
/// clip preserves a ring's winding, and this is what it reads the winding off.
fn signed_double_area(ring: &[Coord]) -> f64 {
    let mut sum = 0.0;
    let mut previous = ring.len() - 1;
    for current in 0..ring.len() {
        sum += (ring[current].lng - ring[previous].lng) * (ring[current].lat + ring[previous].lat);
        previous = current;
    }
    -sum
}

/// Whether a point is inside a ring, by the even-odd crossing count — asked only of a chunk's
/// centre, to tell a ring that misses the chunk from one that swallows it whole.
fn point_inside_ring(ring: &[Coord], point: &Coord) -> bool {
    let mut inside = false;
    let mut previous = ring.len() - 1;
    for current in 0..ring.len() {
        let (from, to) = (&ring[current], &ring[previous]);
        if (from.lat > point.lat) != (to.lat > point.lat)
            && point.lng
                < from.lng + (point.lat - from.lat) / (to.lat - from.lat) * (to.lng - from.lng)
        {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

/// The part of one segment inside the rectangle, by Liang-Barsky: the two ends of the surviving
/// span, or None when the segment misses entirely. An end that was cut lands exactly on the side it
/// was cut against rather than wherever the interpolation fell, and an end that was already inside
/// comes back as the original vertex — which is what lets the ring walk join spans by plain
/// equality, and what keeps a caster that never leaves its chunk byte-identical.
fn clip_segment(rect: &Rect, from: &Coord, to: &Coord) -> Option<(Coord, Coord)> {
    let mut enter = 0.0f64;
    let mut leave = 1.0f64;
    // the side each end was cut against, as (is a latitude, that side's coordinate)
    let mut enter_side: Option<(bool, f64)> = None;
    let mut leave_side: Option<(bool, f64)> = None;
    for (is_lat, start, delta, low, high) in [
        (false, from.lng, to.lng - from.lng, rect.west, rect.east),
        (true, from.lat, to.lat - from.lat, rect.south, rect.north),
    ] {
        if delta == 0.0 {
            if start < low || start > high {
                return None;
            }
        } else {
            let (near, far) = if delta > 0.0 {
                (low, high)
            } else {
                (high, low)
            };
            let at_near = (near - start) / delta;
            let at_far = (far - start) / delta;
            if at_near > enter {
                enter = at_near;
                enter_side = Some((is_lat, near));
            }
            if at_far < leave {
                leave = at_far;
                leave_side = Some((is_lat, far));
            }
            if enter > leave {
                return None;
            }
        }
    }
    let cut = |at: f64, side: Option<(bool, f64)>, uncut: &Coord| match side {
        None => *uncut,
        Some((is_lat, value)) => {
            let mut point = Coord {
                lng: from.lng + at * (to.lng - from.lng),
                lat: from.lat + at * (to.lat - from.lat),
            };
            if is_lat {
                point.lat = value;
            } else {
                point.lng = value;
            }
            point
        }
    };
    Some((cut(enter, enter_side, from), cut(leave, leave_side, to)))
}

/// Where the boundary walk gets from one perimeter position to another, going the way the ring runs.
fn advance(from: f64, to: f64, counter_clockwise: bool) -> f64 {
    if counter_clockwise {
        (to - from).rem_euclid(4.0)
    } else {
        (from - to).rem_euclid(4.0)
    }
}

/// A ring clipped to the rectangle: the closed pieces of ring ∩ rect, each wound the way the source
/// ring was. A ring that never leaves comes back untouched, which is the overwhelmingly common case
/// and the one that must stay free.
///
/// The walk is Weiler-Atherton, not Sutherland-Hodgman: a ring that leaves the chunk and comes back
/// makes SEVERAL pieces, and Sutherland-Hodgman would join them with a zero-area bridge along the
/// seam — invisible to a fill, but a sweep would drag that bridge into a shadow that is not there.
/// So the spans inside are collected first, then closed by walking the rectangle's own sides from
/// each span's exit to the next span's entry, picking up the corners passed on the way.
fn clip_ring(ring: &[Coord], rect: &Rect) -> Vec<Ring> {
    let Some(start) = ring.iter().position(|point| !rect.contains(point)) else {
        return vec![ring.to_vec()];
    };
    let counter_clockwise = signed_double_area(ring) > 0.0;

    // The spans of the ring that lie inside, in the ring's own direction. Starting the walk at a
    // vertex outside is what keeps a span from wrapping around the ring's end.
    let mut spans: Vec<Ring> = Vec::new();
    let mut span: Ring = Vec::new();
    let close = |span: &mut Ring, spans: &mut Vec<Ring>| {
        if span.len() > 1 {
            spans.push(std::mem::take(span));
        } else {
            span.clear();
        }
    };
    for step in 0..ring.len() {
        let from = &ring[(start + step) % ring.len()];
        let to = &ring[(start + step + 1) % ring.len()];
        match clip_segment(rect, from, to) {
            None => close(&mut span, &mut spans),
            Some((entry, exit)) => {
                match span.last() {
                    // the ring left and came back: this is a new span, not a continuation
                    Some(last) if !same(last, &entry) => {
                        close(&mut span, &mut spans);
                        span.push(entry);
                    }
                    None => span.push(entry),
                    Some(_) => {}
                }
                if span.last().is_none_or(|last| !same(last, &exit)) {
                    span.push(exit);
                }
            }
        }
    }
    close(&mut span, &mut spans);

    if spans.is_empty() {
        // the ring never meets the chunk: it either misses it or swallows it whole
        let centre = Coord {
            lng: (rect.west + rect.east) / 2.0,
            lat: (rect.south + rect.north) / 2.0,
        };
        return if point_inside_ring(ring, &centre) {
            vec![rect.ring(counter_clockwise)]
        } else {
            Vec::new()
        };
    }

    let entries: Vec<f64> = spans.iter().map(|span| rect.perimeter(&span[0])).collect();
    let exits: Vec<f64> = spans
        .iter()
        .map(|span| rect.perimeter(span.last().expect("a span has two ends")))
        .collect();
    let corners = rect.corners();
    let mut used = vec![false; spans.len()];
    let mut pieces: Vec<Ring> = Vec::new();
    for first in 0..spans.len() {
        if used[first] {
            continue;
        }
        let mut piece: Ring = Vec::new();
        let mut current = first;
        loop {
            used[current] = true;
            for point in &spans[current] {
                if piece.last().is_none_or(|last| !same(last, point)) {
                    piece.push(*point);
                }
            }
            // The span the walk reaches next along the boundary. The piece's own first span is
            // always a candidate, so the walk always closes.
            let exit = exits[current];
            let next = (0..spans.len())
                .filter(|index| !used[*index] || *index == first)
                .min_by(|left, right| {
                    advance(exit, entries[*left], counter_clockwise).total_cmp(&advance(
                        exit,
                        entries[*right],
                        counter_clockwise,
                    ))
                })
                .expect("the piece's own first span");
            let reach = advance(exit, entries[next], counter_clockwise);
            let mut passed: Vec<(f64, Coord)> = corners
                .iter()
                .enumerate()
                .map(|(index, corner)| (advance(exit, index as f64, counter_clockwise), *corner))
                .filter(|(at, _)| *at > 0.0 && *at < reach)
                .collect();
            passed.sort_by(|left, right| left.0.total_cmp(&right.0));
            for (_, corner) in passed {
                if piece.last().is_none_or(|last| !same(last, &corner)) {
                    piece.push(corner);
                }
            }
            if next == first {
                break;
            }
            current = next;
        }
        // the closing vertex is implied by the format, and a piece with no area is bytes for nothing
        if piece.len() > 1 && same(&piece[0], piece.last().expect("a non-empty piece")) {
            piece.pop();
        }
        if piece.len() >= 3 && signed_double_area(&piece) != 0.0 {
            pieces.push(piece);
        }
    }
    pieces
}

/// One caster as it ships in one chunk: its rings clipped to that chunk. A ring can clip into
/// several disjoint pieces, which the record format cannot hold — its ring list is one outer ring
/// and its holes — so each piece ships as its own record, at the same height. That is exactly what
/// the client already does with two casters that overlap: it unions their shadows and unions their
/// bases, and a union of the pieces is the whole.
///
/// A footprint that splits AND has holes is the one case with nowhere to put a hole, since nothing
/// in the format says which piece it belongs to; it ships whole, as it did before, which is
/// trivially still correct because the pieces it duplicates are subsets of it.
fn clip_caster(caster: &Caster, rect: &Rect, out: &mut Vec<Caster>) {
    let mut pieces = clip_ring(&caster.rings[0], rect);
    let holes = &caster.rings[1..];
    if !holes.is_empty() && pieces.len() > 1 {
        out.push(Caster {
            rings: caster.rings.clone(),
            height_dm: caster.height_dm,
        });
    } else if holes.is_empty() {
        out.extend(pieces.into_iter().map(|ring| Caster {
            rings: vec![ring],
            height_dm: caster.height_dm,
        }));
    } else if let Some(outer) = pieces.pop() {
        // The clipped holes are the same intersection taken against the same rectangle, so they cut
        // the clipped outer exactly where they cut the whole one.
        let mut rings = vec![outer];
        for hole in holes {
            rings.extend(clip_ring(hole, rect));
        }
        out.push(Caster {
            rings,
            height_dm: caster.height_dm,
        });
    }
}

/// One caster: its height, its ring count, then per ring a vertex count and the ring's varint deltas.
/// The delta chain runs on across a record's rings, so an inner ring starts from the outer ring's
/// last vertex rather than from the chunk origin again.
fn encode_caster(caster: &Caster, origin_lng: f64, origin_lat: f64, bytes: &mut Vec<u8>) {
    write_varint(bytes, u64::from(caster.height_dm));
    write_varint(bytes, caster.rings.len() as u64);
    let mut previous_x = 0i64;
    let mut previous_y = 0i64;
    for ring in &caster.rings {
        write_varint(bytes, ring.len() as u64);
        for point in ring {
            let x = round_half_up((point.lng - origin_lng) / CASTER_COORD_SCALE) as i64;
            let y = round_half_up((point.lat - origin_lat) / CASTER_COORD_SCALE) as i64;
            write_varint(bytes, zigzag(x - previous_x));
            write_varint(bytes, zigzag(y - previous_y));
            previous_x = x;
            previous_y = y;
        }
    }
}

/// The trunk section: per trunk a zigzag varint step in x and y from the trunk before it, a varint
/// radius in centimetres and a varint height in decimetres. The steps are taken in the chunk's own
/// row-major order rather than the city's, which is what keeps them short.
fn encode_trunks(
    trunks: &[Trunk],
    indices: &[u32],
    origin_lng: f64,
    origin_lat: f64,
    bytes: &mut Vec<u8>,
) {
    let mut quantized: Vec<(i64, i64, u8, u16)> = indices
        .iter()
        .map(|index| {
            let trunk = &trunks[*index as usize];
            (
                round_half_up((trunk.coord.lng - origin_lng) / CASTER_COORD_SCALE) as i64,
                round_half_up((trunk.coord.lat - origin_lat) / CASTER_COORD_SCALE) as i64,
                trunk.radius_cm,
                trunk.height_dm,
            )
        })
        .collect();
    quantized.sort_unstable_by_key(|(x, y, _, _)| (*y, *x));
    let (mut previous_x, mut previous_y) = (0i64, 0i64);
    for (x, y, radius_cm, height_dm) in quantized {
        write_varint(bytes, zigzag(x - previous_x));
        write_varint(bytes, zigzag(y - previous_y));
        write_varint(bytes, u64::from(radius_cm));
        write_varint(bytes, u64::from(height_dm));
        previous_x = x;
        previous_y = y;
    }
}

// The three sections back to back, buildings then crowns then trunks: a footprint is SWEPT (its ring
// together with its translate, since a wall connects the roof to the ground) while a crown floats
// free and is only TRANSLATED, so which section a record came from is what it casts by. A trunk is a
// building the size of a fence post — swept, and swept OPAQUELY, since wood does not thin out in
// October the way the crown above it does. Every polygon caster is clipped to the chunk on the way
// in, so a record count is a count of clipped PIECES rather than of members.
// layout: scripts/README.md
fn encode_chunk(
    buildings: &[Caster],
    crowns: &[Caster],
    trunks: &[Trunk],
    members: &Members,
    rect: &Rect,
) -> Vec<u8> {
    let (origin_lng, origin_lat) = (rect.west, rect.north);
    let mut bytes = vec![0u8; CASTER_HEADER_BYTES];
    let mut counts = [0u32; 2];
    let mut clipped: Vec<Caster> = Vec::new();
    let sections = [(buildings, &members.buildings), (crowns, &members.crowns)];
    for (count, (casters, indices)) in counts.iter_mut().zip(sections) {
        for index in indices {
            clipped.clear();
            clip_caster(&casters[*index as usize], rect, &mut clipped);
            *count += clipped.len() as u32;
            for caster in &clipped {
                encode_caster(caster, origin_lng, origin_lat, &mut bytes);
            }
        }
    }

    encode_trunks(trunks, &members.trunks, origin_lng, origin_lat, &mut bytes);

    bytes[0..4].copy_from_slice(b"CSTR");
    bytes[4..6].copy_from_slice(&CASTER_FORMAT.to_le_bytes());
    bytes[6..8].copy_from_slice(&(CASTER_HEADER_BYTES as u16).to_le_bytes());
    bytes[8..12].copy_from_slice(&counts[0].to_le_bytes());
    bytes[12..16].copy_from_slice(&counts[1].to_le_bytes());
    bytes[16..24].copy_from_slice(&origin_lng.to_le_bytes());
    bytes[24..32].copy_from_slice(&origin_lat.to_le_bytes());
    bytes[32..40].copy_from_slice(&CASTER_COORD_SCALE.to_le_bytes());
    bytes[40..44].copy_from_slice(&(members.trunks.len() as u32).to_le_bytes());
    bytes
}

/// Every chunk one city's casters land in, written, and what each cost. A chunk's origin is its own
/// tile's north-west corner, which keeps the first delta of every record small.
fn write_chunks(
    buildings: &[Caster],
    crowns: &[Caster],
    trunks: &[Trunk],
    chunks: &Path,
) -> Fallible<Vec<ChunkEntry>> {
    let mut buckets: HashMap<(u32, u32), Members> = HashMap::new();
    bucket(buildings, |key, index| {
        buckets.entry(key).or_default().buildings.push(index);
    });
    bucket(crowns, |key, index| {
        buckets.entry(key).or_default().crowns.push(index);
    });
    bucket_trunks(trunks, |key, index| {
        buckets.entry(key).or_default().trunks.push(index);
    });

    let mut entries = Vec::with_capacity(buckets.len());
    for ((tile_x, tile_y), members) in &buckets {
        let encoded = encode_chunk(
            buildings,
            crowns,
            trunks,
            members,
            &tile_rect(*tile_x, *tile_y),
        );
        // Bucketing is by bounding box, so a chunk can hold nothing once its members are clipped to
        // it; an empty chunk is a request for a bare header and is left unwritten.
        if encoded.len() == CASTER_HEADER_BYTES {
            continue;
        }
        let path = chunks
            .join(tile_x.to_string())
            .join(format!("{tile_y}.bin"));
        fs::create_dir_all(path.parent().expect("a chunk row directory"))?;
        fs::write(path, &encoded)?;
        entries.push(ChunkEntry {
            x: *tile_x,
            y: *tile_y,
            bytes: encoded.len(),
        });
    }
    entries.sort_by_key(|entry| (entry.x, entry.y));
    Ok(entries)
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    let params: shade::Params = serde_json::from_slice(&fs::read(&args.params)?)?;

    let mut entries: Vec<ChunkEntry> = Vec::new();
    for city in &manifest.cities {
        // Either source alone still makes chunks worth having; a city with neither is skipped, and
        // the client simply finds no chunk over it.
        let footprints = args.data.join("buildings").join(format!("{}.bin", city.id));
        let (polygons, heights) = if footprints.exists() {
            binfmt::read_buildings(&footprints)?
        } else {
            (Vec::new(), Vec::new())
        };
        let (crown_polygons, crown_heights) = city_crowns(city, &args.data)?;
        let buildings = casters(&polygons, &heights, true);
        let mut crowns = casters(&crown_polygons, &crown_heights, false);
        if buildings.is_empty() && crowns.is_empty() {
            continue;
        }
        let vertices = |casters: &[Caster]| -> usize {
            casters
                .iter()
                .map(|caster| caster.rings[0].len())
                .sum::<usize>()
        };
        let source_vertices = vertices(&crowns);
        let deviation = simplify_crowns(&mut crowns, &Projection::new(&city.bounds));
        let census = city_trunks(city, &args.data)?;
        let standing = census.len();
        let trunks = stand_trunks(census, &crowns);
        eprintln!(
            "{}: {} footprints, {} crowns with a measured height, {} of their {source_vertices} \
             outline vertices kept, moving them at most {deviation:.3} m, {} of {standing} census \
             trunks standing under one",
            city.id,
            buildings.len(),
            crowns.len(),
            vertices(&crowns),
            trunks.len(),
        );
        entries.extend(write_chunks(&buildings, &crowns, &trunks, &args.chunks)?);
    }

    let bytes: usize = entries.iter().map(|entry| entry.bytes).sum();
    let chunks = entries.len();
    fs::write(
        args.chunks.join("manifest.json"),
        serde_json::to_vec(&ChunkManifest {
            chunk_zoom: CHUNK_ZOOM,
            coord_scale: CASTER_COORD_SCALE,
            max_shadow_meters: params.max_shadow_meters,
            chunks: entries,
        })?,
    )?;
    eprintln!(
        "wrote {chunks} caster chunks (z{CHUNK_ZOOM}, {:.1} MiB) in {:.1}s",
        bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::METERS_PER_DEGREE_LAT;
    use crate::manifest::Bounds;

    fn coord(lng: f64, lat: f64) -> Coord {
        Coord { lng, lat }
    }

    /// One chunk read back: its two polygon sections, and its trunks as a point, a radius in metres
    /// and a height in decimetres.
    struct Decoded {
        polygons: [Vec<(u16, Polygon)>; 2],
        trunks: Vec<(Coord, f64, u16)>,
    }

    /// Walks a chunk back the way the client will: the header, then each polygon section's records
    /// as a height, a ring count, and per ring a vertex count and the running varint deltas, then
    /// the trunks as their own running deltas, a radius and a height.
    fn decode(bytes: &[u8]) -> Decoded {
        assert_eq!(&bytes[0..4], b"CSTR");
        let counts = [
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize,
            u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize,
        ];
        let origin_lng = f64::from_le_bytes(bytes[16..24].try_into().unwrap());
        let origin_lat = f64::from_le_bytes(bytes[24..32].try_into().unwrap());
        let scale = f64::from_le_bytes(bytes[32..40].try_into().unwrap());
        let mut offset = usize::from(u16::from_le_bytes(bytes[6..8].try_into().unwrap()));
        let varint = |offset: &mut usize| -> u64 {
            let mut value = 0u64;
            let mut shift = 0;
            loop {
                let byte = bytes[*offset];
                *offset += 1;
                value |= u64::from(byte & 0x7f) << shift;
                shift += 7;
                if byte & 0x80 == 0 {
                    return value;
                }
            }
        };
        let mut sections = counts.map(Vec::with_capacity);
        for (section, count) in sections.iter_mut().zip(counts) {
            for _ in 0..count {
                let height_dm = varint(&mut offset) as u16;
                let rings = varint(&mut offset) as usize;
                let mut polygon: Polygon = Vec::with_capacity(rings);
                let (mut x, mut y) = (0i64, 0i64);
                for _ in 0..rings {
                    let vertices = varint(&mut offset) as usize;
                    let mut ring = Vec::with_capacity(vertices);
                    for _ in 0..vertices {
                        for axis in [&mut x, &mut y] {
                            let zigzagged = varint(&mut offset);
                            *axis += (zigzagged >> 1) as i64 ^ -((zigzagged & 1) as i64);
                        }
                        ring.push(coord(
                            origin_lng + x as f64 * scale,
                            origin_lat + y as f64 * scale,
                        ));
                    }
                    polygon.push(ring);
                }
                section.push((height_dm, polygon));
            }
        }

        let mut trunks = Vec::new();
        let (mut x, mut y) = (0i64, 0i64);
        for _ in 0..u32::from_le_bytes(bytes[40..44].try_into().unwrap()) {
            for axis in [&mut x, &mut y] {
                let zigzagged = varint(&mut offset);
                *axis += (zigzagged >> 1) as i64 ^ -((zigzagged & 1) as i64);
            }
            let radius_m = varint(&mut offset) as f64 / CENTIMETERS_PER_METER;
            trunks.push((
                coord(origin_lng + x as f64 * scale, origin_lat + y as f64 * scale),
                radius_m,
                varint(&mut offset) as u16,
            ));
        }
        assert_eq!(offset, bytes.len(), "the chunk decodes with nothing left");
        Decoded {
            polygons: sections,
            trunks,
        }
    }

    // A stand-in chunk, the shape of a z15 tile but on round numbers so the expected clips can be
    // written down. Its origin — the north-west corner — is what the records are encoded about.
    const CHUNK: Rect = Rect {
        west: -74.0114,
        east: -74.0050,
        south: 40.7080,
        north: 40.7130,
    };

    fn close_enough(left: &Coord, right: &Coord) -> bool {
        (left.lng - right.lng).abs() <= CASTER_COORD_SCALE / 2.0
            && (left.lat - right.lat).abs() <= CASTER_COORD_SCALE / 2.0
    }

    /// A ring matches a source ring up to the codec's half unit, starting anywhere on it — the clip
    /// closes a piece wherever the ring first entered the chunk.
    fn matches(ring: &[Coord], expected: &[Coord]) -> bool {
        ring.len() == expected.len()
            && (0..expected.len()).any(|shift| {
                ring.iter().enumerate().all(|(index, point)| {
                    close_enough(point, &expected[(index + shift) % ring.len()])
                })
            })
    }

    /// A courtyard building and a crown, both well inside the chunk, plus the two ways a caster can
    /// straddle its edge. Encoded about the chunk origin and read back: the footprint's rings survive
    /// within the half unit quantization allows, the two sections stay apart — the client casts a
    /// footprint and a crown differently — and a caster that leaves the chunk ships only the part
    /// inside it, closed along the chunk's own edge.
    #[test]
    fn round_trips_a_chunk() {
        let courtyard: Polygon = vec![
            vec![
                coord(-74.0100, 40.7100),
                coord(-74.0090, 40.7100),
                coord(-74.0090, 40.7110),
                coord(-74.0100, 40.7110),
            ],
            vec![
                coord(-74.0097, 40.7103),
                coord(-74.0093, 40.7103),
                coord(-74.0093, 40.7107),
                coord(-74.0097, 40.7107),
            ],
        ];
        // Pokes out past the chunk's east edge, so it ships as one piece closed along that edge.
        let straddler: Polygon = vec![vec![
            coord(-74.0060, 40.7100),
            coord(-74.0040, 40.7100),
            coord(-74.0040, 40.7110),
            coord(-74.0060, 40.7110),
        ]];
        let crown: Polygon = vec![vec![
            coord(-74.0080, 40.7100),
            coord(-74.0078, 40.7100),
            coord(-74.0079, 40.7102),
        ]];
        // A body outside the chunk with two prongs reaching in: one caster, two pieces in this chunk.
        let two_pronged: Polygon = vec![vec![
            coord(-74.0045, 40.7085),
            coord(-74.0040, 40.7085),
            coord(-74.0040, 40.7125),
            coord(-74.0045, 40.7125),
            coord(-74.0045, 40.7120),
            coord(-74.0060, 40.7120),
            coord(-74.0060, 40.7115),
            coord(-74.0045, 40.7115),
            coord(-74.0045, 40.7095),
            coord(-74.0060, 40.7095),
            coord(-74.0060, 40.7090),
            coord(-74.0045, 40.7090),
        ]];
        let buildings = casters(&[courtyard.clone(), straddler.clone()], &[42.5, 12.0], true);
        // The second crown carries the canopy file's 0 unknown-height sentinel and must not ship.
        let crowns = casters(
            &[crown.clone(), crown.clone(), two_pronged.clone()],
            &[9.3, 0.0, 5.0],
            false,
        );
        assert_eq!(crowns.len(), 2);

        let members = Members {
            buildings: vec![0, 1],
            crowns: vec![0, 1],
            trunks: Vec::new(),
        };
        let encoded = encode_chunk(&buildings, &crowns, &[], &members, &CHUNK);
        let Decoded {
            polygons: [decoded_buildings, decoded_crowns],
            ..
        } = decode(&encoded);

        // The two prongs are two records at the caster's own height, not one record and not a
        // record joined across the chunk's edge by a bridge the client would sweep into a shadow.
        assert_eq!(decoded_buildings.len(), 2);
        assert_eq!(decoded_crowns.len(), 3);
        assert_eq!(decoded_buildings[0].0, 425);
        assert_eq!(decoded_crowns[0].0, 93);
        assert_eq!(decoded_crowns[1].0, 50);
        assert_eq!(decoded_crowns[2].0, 50);

        // A caster wholly inside the chunk is untouched, ring for ring and vertex for vertex.
        for (source, (_, rings)) in [
            (&courtyard, &decoded_buildings[0]),
            (&crown, &decoded_crowns[0]),
        ] {
            assert_eq!(rings.len(), source.len());
            for (source, ring) in source.iter().zip(rings) {
                assert_eq!(ring.len(), source.len());
                for (source, point) in source.iter().zip(ring) {
                    assert!(close_enough(source, point));
                }
            }
        }

        let clipped_straddler = [
            coord(-74.0060, 40.7100),
            coord(CHUNK.east, 40.7100),
            coord(CHUNK.east, 40.7110),
            coord(-74.0060, 40.7110),
        ];
        assert!(matches(&decoded_buildings[1].1[0], &clipped_straddler));
        let prongs = [
            [
                coord(CHUNK.east, 40.7120),
                coord(-74.0060, 40.7120),
                coord(-74.0060, 40.7115),
                coord(CHUNK.east, 40.7115),
            ],
            [
                coord(CHUNK.east, 40.7095),
                coord(-74.0060, 40.7095),
                coord(-74.0060, 40.7090),
                coord(CHUNK.east, 40.7090),
            ],
        ];
        for prong in &prongs {
            assert!(
                decoded_crowns[1..]
                    .iter()
                    .any(|(_, rings)| matches(&rings[0], prong))
            );
        }
    }

    /// The clip keeps a ring's winding whichever way it runs, and gives back the same ground either
    /// way: the sweep and the base punch-out both read the winding, and a piece wound against its
    /// source would cancel rather than fill.
    #[test]
    fn preserves_winding() {
        let ring = vec![
            coord(-74.0060, 40.7100),
            coord(-74.0040, 40.7100),
            coord(-74.0040, 40.7110),
            coord(-74.0060, 40.7110),
        ];
        let reversed: Ring = ring.iter().rev().copied().collect();
        assert!(signed_double_area(&ring) > 0.0);

        let forward = clip_ring(&ring, &CHUNK);
        let backward = clip_ring(&reversed, &CHUNK);
        assert_eq!(forward.len(), 1);
        assert_eq!(backward.len(), 1);
        assert!(signed_double_area(&forward[0]) > 0.0);
        assert!(signed_double_area(&backward[0]) < 0.0);
        assert!((signed_double_area(&forward[0]) + signed_double_area(&backward[0])).abs() < 1e-18);
        let flipped: Ring = backward[0].iter().rev().copied().collect();
        assert!(matches(&forward[0], &flipped));
    }

    /// A ring big enough to swallow the whole chunk has no vertex and no crossing inside it, and
    /// clips to the chunk's own rectangle rather than to nothing.
    #[test]
    fn clips_a_swallowed_chunk() {
        let ring = vec![
            coord(-74.02, 40.70),
            coord(-74.00, 40.70),
            coord(-74.00, 40.72),
            coord(-74.02, 40.72),
        ];
        let pieces = clip_ring(&ring, &CHUNK);
        assert_eq!(pieces.len(), 1);
        assert!(matches(&pieces[0], &CHUNK.corners()));

        let missing = vec![
            coord(-74.00, 40.70),
            coord(-73.99, 40.70),
            coord(-73.99, 40.72),
        ];
        assert!(clip_ring(&missing, &CHUNK).is_empty());
    }

    /// A hole is clipped against the same rectangle as its outer ring, so a courtyard straddling the
    /// chunk edge still punches exactly the part of itself that is inside.
    #[test]
    fn clips_a_hole_with_its_outer_ring() {
        let courtyard: Polygon = vec![
            vec![
                coord(-74.0060, 40.7100),
                coord(-74.0040, 40.7100),
                coord(-74.0040, 40.7110),
                coord(-74.0060, 40.7110),
            ],
            vec![
                coord(-74.0058, 40.7102),
                coord(-74.0042, 40.7102),
                coord(-74.0042, 40.7108),
                coord(-74.0058, 40.7108),
            ],
        ];
        let caster = &casters(std::slice::from_ref(&courtyard), &[20.0], true)[0];
        let mut clipped: Vec<Caster> = Vec::new();
        clip_caster(caster, &CHUNK, &mut clipped);
        assert_eq!(clipped.len(), 1);
        assert_eq!(clipped[0].rings.len(), 2);
        assert!(matches(
            &clipped[0].rings[1],
            &[
                coord(-74.0058, 40.7102),
                coord(CHUNK.east, 40.7102),
                coord(CHUNK.east, 40.7108),
                coord(-74.0058, 40.7108),
            ]
        ));
    }

    /// The inversion recovers the dbh the crown was grown from exactly, and still within 1.5 mm once
    /// the crown has been through the decimetre byte it ships in — checked at the 22.86 cm (9 inch)
    /// dbh the ingest imputes for a missing one, which is where 7.1% of the city sits. A crown no dbh
    /// could have grown (an OSM tree's recorded 20 m radius) and a crown of nothing land on the clamps.
    #[test]
    fn inverts_the_crown_allometry() {
        let median_dbh_cm: f64 = 22.86;
        let crown_radius_m =
            (CROWN_A + CROWN_B * (median_dbh_cm + 1.0).ln().ln() + CROWN_LOG_BIAS).exp() / 2.0;
        let expected = median_dbh_cm / 2.0 / CENTIMETERS_PER_METER;
        assert!((trunk_radius_m(crown_radius_m) - expected).abs() < 1e-12);
        let shipped = (crown_radius_m * DECIMETERS_PER_METER).round() / DECIMETERS_PER_METER;
        assert!((trunk_radius_m(shipped) - expected).abs() < 0.0015);
        assert_eq!(
            trunk_radius_m(20.0),
            MAX_DBH_CM / 2.0 / CENTIMETERS_PER_METER
        );
        assert_eq!(
            trunk_radius_m(0.0),
            MIN_DBH_CM / 2.0 / CENTIMETERS_PER_METER
        );
    }

    /// A trunk stands to the crown BASE of the polygon it is under — 0.4 of that polygon's height,
    /// which is where the crown's own shadow is now cast from — and a census tree under no measured
    /// crown is dropped rather than shipped holding nothing up.
    #[test]
    fn stands_trunks_under_their_crowns() {
        let square = |lng: f64| -> Polygon {
            vec![vec![
                coord(lng, 40.7100),
                coord(lng + 0.0002, 40.7100),
                coord(lng + 0.0002, 40.7102),
                coord(lng, 40.7102),
            ]]
        };
        let crowns = casters(&[square(-74.0100), square(-74.0090)], &[12.0, 8.0], false);
        let trunk = |lng: f64| Trunk {
            coord: coord(lng, 40.7101),
            radius_cm: 12,
            height_dm: 0,
        };

        let standing = stand_trunks(
            vec![trunk(-74.0099), trunk(-74.0089), trunk(-74.0060)],
            &crowns,
        );
        assert_eq!(standing.len(), 2);
        assert_eq!(standing[0].height_dm, 48);
        assert_eq!(standing[1].height_dm, 32);
    }

    /// Trunks ride in their own section, needing no clip: every one that stands in the chunk comes
    /// back where it stood, as thick and as tall as it went in, whatever order it was handed over in.
    #[test]
    fn round_trips_trunks() {
        let standing = [
            (coord(-74.0100, 40.7120), 12u8, 40u16),
            (coord(-74.0060, 40.7090), 76u8, 130u16),
            (coord(-74.0099, 40.7091), 3u8, 8u16),
        ];
        let trunks: Vec<Trunk> = standing
            .iter()
            .map(|(coord, radius_cm, height_dm)| Trunk {
                coord: *coord,
                radius_cm: *radius_cm,
                height_dm: *height_dm,
            })
            .collect();
        let members = Members {
            trunks: vec![0, 1, 2],
            ..Members::default()
        };

        let decoded = decode(&encode_chunk(&[], &[], &trunks, &members, &CHUNK)).trunks;
        assert_eq!(decoded.len(), standing.len());
        for (at, radius_cm, height_dm) in standing {
            assert!(decoded.iter().any(|(point, radius_m, decoded_height)| {
                close_enough(point, &at)
                    && (radius_m * CENTIMETERS_PER_METER - f64::from(radius_cm)).abs() < 1e-9
                    && *decoded_height == height_dm
            }));
        }
    }

    fn projection() -> Projection {
        Projection::new(&Bounds {
            south: CHUNK.south,
            west: CHUNK.west,
            north: CHUNK.north,
            east: CHUNK.east,
        })
    }

    /// A staircase of 0.5 m steps laid on the axis a degree measures loosest, which is what the
    /// canopy's rings are: it collapses to the run it traces, keeping the winding and moving the
    /// outline by less than a step. Run in degrees instead of metres it would keep every step, since
    /// 0.5 m of longitude is 5.9e-6° here against the 5.4e-6° a 0.6 m tolerance would be.
    #[test]
    fn simplifies_a_staircase_in_metres() {
        let projection = projection();
        let step = 0.5 / projection.meters_per_degree_lng();
        let rise = 2.0 / METERS_PER_DEGREE_LAT;
        let mut ring: Ring = (0..20)
            .map(|index| {
                coord(
                    -74.0100 + f64::from(index % 2) * step,
                    40.7100 + f64::from(index) * rise,
                )
            })
            .collect();
        ring.push(coord(-74.0080, 40.7100 + 19.0 * rise));
        ring.push(coord(-74.0080, 40.7100));
        assert!(signed_double_area(&ring) < 0.0);

        let (simplified, deviation) = simplify_ring(&ring, &projection, 0.6);
        assert_eq!(simplified.len(), 4);
        assert!(deviation < 0.5);
        assert!(signed_double_area(&simplified) < 0.0);
    }

    /// Simplifying before the clip is what keeps a seam a seam: the pieces a crown leaves in two
    /// neighbouring chunks still tile it exactly, with no gap and no overlap along the edge they
    /// share. Simplifying each chunk's own piece afterwards would move the two sides of that edge
    /// apart.
    #[test]
    fn keeps_seams_agreeing_across_chunks() {
        let rise = 1.5 / METERS_PER_DEGREE_LAT;
        let ring: Ring = (0..24)
            .map(|index| {
                let angle = f64::from(index) / 24.0 * std::f64::consts::TAU;
                coord(
                    CHUNK.east + 0.0004 * angle.cos(),
                    40.7105 + 0.0003 * angle.sin() + f64::from(index % 2) * rise,
                )
            })
            .collect();
        let (simplified, _) = simplify_ring(&ring, &projection(), 0.6);
        assert!(simplified.len() < ring.len());

        let east = Rect {
            west: CHUNK.east,
            east: CHUNK.east + 0.0064,
            south: CHUNK.south,
            north: CHUNK.north,
        };
        let area: f64 = [CHUNK, east]
            .iter()
            .flat_map(|rect| clip_ring(&simplified, rect))
            .map(|piece| signed_double_area(&piece))
            .sum();
        let whole = signed_double_area(&simplified);
        assert!((area - whole).abs() < whole.abs() * 1e-9);
    }
}
