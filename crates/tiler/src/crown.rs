//! The slices a tree crown's shadow is swept between, shared by both halves of the shade model.
//!
//! A crown is not a flat sheet. It spans `CROWN_BASE_FRACTION * h` up to `h`, and its shadow is the
//! union over that range of heights — which at a 5 degree sun is a smear tens of metres long, not the
//! outline translated sideways. This module cuts a crown into `CROWN_SEGMENTS` nested rings, each
//! standing for the band of heights over which the crown is at least that wide, so a caster can sweep
//! ring `j` between where that band's two ends land and union the lot.
//!
//! `tiler shade` bakes that union into the raster pyramid and `tiler caster-chunks` ships the same
//! rings for the client to sweep itself; both call `slice_crowns`, so the two halves cannot disagree
//! about the geometry at the zoom where they hand over.

use cavalier_contours::polyline::{
    PlineCreation, PlineOffsetOptions, PlineSource, PlineSourceMut, Polyline,
};
use rayon::prelude::*;

use crate::binfmt::{Coord, Polygon, Ring};
use crate::geometry::METERS_PER_DEGREE_LAT;

/// Where a crown starts, as a share of the tree's height: the foliage runs from here to `h` and the
/// trunk carries it the rest of the way down. Everything the shadow does follows from that span — the
/// silhouette is cast from inside it, never from the polygon's own height, which would model the crown
/// as a flat sheet at the very top of the tree and throw the shadow about a crown radius too far, far
/// enough at a low sun to detach it from its tree.
///
/// 0.4 is an ASSUMPTION, not a measurement, but it is anchored on the quantity that means it: crown
/// ratio, crown length over tree height, is 0.39-0.60 for hardwoods across ~7000 trees in Russell &
/// Weiskittel 2011, "Maximum and Largest Crown Width Equations for 15 Tree Species in Maine", Table 1,
/// which puts the crown base near 0.4h. What is NOT sourced is where in that span the crown is widest
/// — height to largest crown width, a standard forestry quantity (Hann 1999, Forest Science 45(2)
/// 217-225, splits the crown profile at exactly this point) for which no published figure for urban
/// broadleaves could be found: the numeric work is all conifer, whose conic crowns are widest at the
/// base by construction and answer differently. `crown_segments` takes the midpoint of the span.
pub const CROWN_BASE_FRACTION: f64 = 0.4;

/// Where the crown is widest, as a share of tree height, and so how far up the trunk stands: the
/// crown's shadow is at its widest here and swallows the trunk's end, where standing it to the crown
/// BASE would leave the last of it beyond the narrow tip the crown reaches that low.
pub const CROWN_WIDEST_FRACTION: f64 = (1.0 + CROWN_BASE_FRACTION) / 2.0;

/// How many bands a crown is cut into. The slices are nested and overlap almost entirely, so the
/// union's residual error is a step in WIDTH across the shadow wherever one ring gives way to the
/// next — INDEPENDENT of the sun's altitude, which is what makes four enough where translating four
/// copies of the outline would leave along-sun gaps that need dozens. Along the shadow it stops
/// `1 - CROWN_TIP_FRACTION` of the smear short of either extreme, since the innermost ring still has
/// width and so cannot reach the crown's two points.
///
/// A caster may use fewer when the whole smear is only a pixel or two long, but only a divisor of
/// this: the inset rings ship at these fixed levels, so k slices means taking every
/// `CROWN_SEGMENTS / k`-th of them.
pub const CROWN_SEGMENTS: usize = 4;

/// How far up the crown's half-height the innermost ring is sampled at. Short of 1.0 because the
/// spheroid comes to a POINT there, and a ring of no width casts nothing over the band it would
/// otherwise be the only slice covering; at 0.99 it still reaches all but 1% of the smear.
const CROWN_TIP_FRACTION: f64 = 0.99;

// Arc length the outline is resampled at before its curvature is read.
const RESAMPLE_METERS: f64 = 1.0;
// Half-width of the circular moving average the resampled outline is smoothed with. The raw trace is
// a 1-foot raster staircase whose alternating right-angle turns read as a radius of ~0.64 m at every
// sample; this is what separates the signal (crown radii of 2.5-8 m) from that noise.
const SMOOTH_METERS: f64 = 2.0;
// Smoothing windows one curvature chord spans. Two is what the disc test settles on: one chord is too
// short to outrun the residual staircase and reads a five-metre disc at three, three starts flattening
// the small scallops that carry the answer over a park.
const CHORD_WINDOWS: usize = 2;
// The radii one scallop is allowed to imply, as outlier hygiene: below the first a sample is raster
// noise, above the second it is a stretch of outline too straight to be any crown's edge.
const MIN_RADIUS_METERS: f64 = 1.0;
const MAX_RADIUS_METERS: f64 = 30.0;
// Resampled samples below which an outline has no curvature to read and is taken for the single small
// crown it must be, whose own circle radius is `perimeter / 2 pi`.
const MIN_SAMPLES: usize = 12;

// Douglas-Peucker tolerance EVERY ring ships at, the outline included, and it is two thirds of a z17
// pixel (0.91 m), the finest ground either half of the model draws a crown at.
//
// It runs HERE rather than in each caster so that the pyramid and the chunks sweep the same rings: the
// chunks simplified for display and the pyramid did not, which left the two halves half a metre apart
// at the zoom they hand over. It runs after the curvature, which wants the exact trace — Douglas-
// Peucker sharpens corners, the worst input a curvature estimate could have.
const CROWN_SIMPLIFY_METERS: f64 = 0.6;
// Chord tolerance the arcs an inward offset opens at concave corners are flattened to. Deliberately
// far under CROWN_SIMPLIFY_METERS, so that the simplification of the offset ring — and not this — is
// what sets how far a shipped ring may sit from the geometry it stands for.
const JOIN_ARC_METERS: f64 = 0.05;
// Below this two consecutive vertices are the same vertex, and the offset needs them merged: a
// repeated position has no direction, so there is no line to offset it along. A micrometre is under
// the decimetre the rings are stored on and far under anything the trace can resolve.
const REPEAT_POSITION_METERS: f64 = 1e-6;

// Pixels of shadow smear one slice is allowed to step by. Below this the whole smear is shorter than
// a couple of pixels and one slice says everything the four would, which is what keeps a high sun's
// bins at the cost they have today.
const SMEAR_PIXELS_PER_SEGMENT: f64 = 2.0;

/// One crown, cut. `levels[0]` is the outline and `levels[j]` is that same outline inset to
/// `radius_m * ring_share(j)`, the cross-section the crown keeps over the band of heights where it is
/// at least that wide. A level can hold several rings: insetting a blob splits it long before it
/// vanishes. Empty for a crown with no ring to cut.
pub struct Crown {
    pub levels: Vec<Vec<Ring>>,
    pub radius_m: f64, // the radius of the crowns forming the outline, from its own curvature
}

/// One swept slice: which inset level's rings to sweep, and the two shadow displacements, in metres,
/// to sweep them between.
pub struct Segment {
    pub level: usize,
    pub from_m: f64,
    pub to_m: f64,
}

/// Where slice `level`'s ring sits, as an offset from the crown's widest section in units of the
/// crown's own half-height. The offsets are spaced EVENLY, which is what makes the rings sample the
/// crown at evenly spaced heights. The crown is at least that ring's width over `+/- this`, so it is
/// half a band, not a height.
fn band_offset(level: usize) -> f64 {
    level as f64 / (CROWN_SEGMENTS - 1) as f64 * CROWN_TIP_FRACTION
}

/// The radius slice `level`'s ring keeps, as a share of the crown's own: the spheroid's profile
/// `radius(u) = r * sqrt(1 - u^2)` read at that slice's height.
fn ring_share(level: usize) -> f64 {
    (1.0 - band_offset(level).powi(2)).max(0.0).sqrt()
}

/// The slices one crown's shadow is swept in for one sun and one ground resolution. Slice `j` sweeps
/// the ring at its own inset between the ground displacements of the two heights where the crown
/// draws in to that ring's radius, so the union is gapless at any sun altitude — the segments are
/// nested and overlap almost entirely, and the whole point is that they go through ONE union rather
/// than compositing one at a time.
///
/// The crown is a SPHEROID over `CROWN_BASE_FRACTION * h .. h`: a point at the bole, widest at the
/// midpoint of that span, a point at the top. So each band is centred on the widest section and the
/// bands nest OUTWARD from it — the full-radius outline spans a single height and sweeps nothing,
/// while the innermost ring spans nearly the whole crown and sweeps nearly the whole smear. That
/// inversion is what makes the silhouette a lens rather than a bar: a shadow that narrows at the end
/// nearest its tree as well as at its tip.
///
/// The rings are spaced by equal HEIGHT, not by equal inset: slice `j` is the cross-section at
/// `j / (k - 1) * CROWN_TIP_FRACTION` of the way from the widest section to the crown's point, so its
/// radius is `r * sqrt(1 - u^2)`. Spacing by equal inset instead — rings at `d_j = j * r / k` — samples
/// the spheroid where its profile is flat and misses where it is not: three of the four rings land
/// within 25% of each other in width, which pins two thirds of the shadow's length at a single width
/// and caps the widest swept section at `r * sqrt(1 - 1/k^2)`, so the silhouette comes out a bar. At
/// equal height the same four rings hold one width over a third of the length and reach 94% of the
/// crown's true width, for the same four sweeps. Nothing is returned for a crown that casts nothing.
pub fn crown_segments(
    height_m: f64,
    shadow_per_height: f64,
    max_shadow_meters: f64,
    meters_per_pixel: f64,
) -> Vec<Segment> {
    if height_m <= 0.0 || shadow_per_height <= 0.0 {
        return Vec::new();
    }
    let smear_m = (1.0 - CROWN_BASE_FRACTION) * height_m * shadow_per_height;
    let wanted = (smear_m / meters_per_pixel / SMEAR_PIXELS_PER_SEGMENT).ceil();
    // Halved down to a divisor of CROWN_SEGMENTS, since the slices ship at fixed inset levels and
    // taking every stride-th of them is the only way to keep the two halves on the same rings. What
    // dropping to `k` costs is the far ends of the smear, which only the rings inside `r / k` reach:
    // a quarter of a pixel at two slices, and at one the whole smear — which by then is under two
    // pixels itself, so under one at each end.
    let mut count = CROWN_SEGMENTS;
    while count > 1 && (count / 2) as f64 >= wanted {
        count /= 2;
    }
    let stride = CROWN_SEGMENTS / count;
    let middle = CROWN_WIDEST_FRACTION;
    let half_height = (1.0 - CROWN_BASE_FRACTION) / 2.0;
    let displacement = |share_of_height: f64| {
        (share_of_height * height_m * shadow_per_height).min(max_shadow_meters)
    };
    let mut segments = Vec::with_capacity(count);
    for slice in 0..count {
        let level = slice * stride;
        let half = band_offset(level);
        let from_m = displacement(middle - half_height * half);
        let to_m = displacement(middle + half_height * half);
        // Slice 0 is the widest section, which spans one height and so sweeps nothing; past the shadow
        // clip every other slice lands on the same ground, where slice 0's ring covers them all.
        if to_m > from_m || slice == 0 {
            segments.push(Segment {
                level,
                from_m,
                to_m,
            });
        }
    }
    segments
}

/// Every crown cut into its slices, in the canopy file's own order so a caster can zip them against
/// the heights. Parallel because the insetting is the expensive half of it: the city's outlines carry
/// 31 million vertices between them.
pub fn slice_crowns(crowns: &[Polygon]) -> Vec<Crown> {
    crowns
        .par_iter()
        .map(|crown| match crown.first() {
            Some(outer) if outer.len() >= 3 => crown_slices(outer),
            _ => Crown {
                levels: Vec::new(),
                radius_m: 0.0,
            },
        })
        .collect()
}

/// One outline cut into its nested rings.
///
/// The outline is simplified BEFORE it is inset, not after, and the inner rings are the offsets of the
/// simplified ring rather than of the raw trace. That is not the cheaper order merely — though it is
/// three times the speed — it is the more faithful one. A raw trace is a 1-foot raster staircase, and
/// an inward offset opens every one of its concave steps into an arc of the offset's own depth, so the
/// staircase bites a metre or two out of a ring it should not touch; clearing the steps first is the
/// difference between 1.7% and 3.3% of area lost at the deepest inset. It also makes the rings
/// genuinely nested, since each is now an offset of the ring shipped as level 0 rather than of a curve
/// nobody ships. What kept the simplification last before was the curvature estimate, which is read
/// off the raw trace — and still is, above.
pub fn crown_slices(outer: &Ring) -> Crown {
    let frame = Frame::of(outer);
    let metres = frame.to_meters(outer);
    let radius_m = curvature_radius(&metres);
    let insets: Vec<f64> = (1..CROWN_SEGMENTS)
        .map(|level| radius_m * (1.0 - ring_share(level)))
        .collect();
    let outline = simplified_or_whole(&metres);
    let mut levels = Vec::with_capacity(CROWN_SEGMENTS);
    levels.push(vec![frame.to_degrees(&outline)]);
    // Cut from the EXACT trace, not from the simplified outline that ships. What separates one crown
    // from the next in a merged blob is the neck between them, and a neck is a metre of outline that
    // the shipping tolerance is entitled to drop — drop it first and the offset has nothing to pull
    // apart, so a whole park comes back as one shape that never breaks into its trees.
    for inset in offset_rings(&metres, &insets) {
        levels.push(inset.iter().map(|ring| frame.to_degrees(ring)).collect());
    }
    Crown { levels, radius_m }
}

/// One ring with everything the tolerance can drop dropped — or whole, if that would leave it below a
/// triangle, since a ring the tolerance collapses is smaller than the tolerance itself.
fn simplified_or_whole(points: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let simplified = simplify_closed(points, CROWN_SIMPLIFY_METERS);
    if simplified.len() >= 3 {
        simplified
    } else {
        points.to_vec()
    }
}

/// The upper edge of each histogram bucket the build log reports the radii in.
pub const RADIUS_BUCKETS: [f64; 9] = [1.25, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 20.0, MAX_RADIUS_METERS];

/// How many crowns landed in each `RADIUS_BUCKETS` bucket, plus a final one for the top clamp. The
/// estimator's answer should pile up over a street tree's few metres; a peak against either guard rail
/// would mean the smoothing window is reading raster noise rather than scallops.
pub fn radius_histogram(crowns: &[Crown]) -> Vec<usize> {
    let mut counts = vec![0usize; RADIUS_BUCKETS.len() + 1];
    for crown in crowns.iter().filter(|crown| !crown.levels.is_empty()) {
        let bucket = RADIUS_BUCKETS
            .iter()
            .position(|edge| crown.radius_m < *edge)
            .unwrap_or(RADIUS_BUCKETS.len());
        counts[bucket] += 1;
    }
    counts
}

/// The local metre space one crown is cut in: its own first vertex as the origin and the east-west
/// scale at that latitude. A crown spans metres, so one reference latitude is exact enough that the
/// round trip through it is lossless at the decimetre the rings are stored on.
struct Frame {
    lng: f64,
    lat: f64,
    meters_per_lng: f64,
}

impl Frame {
    fn of(ring: &Ring) -> Self {
        let Coord { lng, lat } = ring[0];
        Self {
            lng,
            lat,
            meters_per_lng: METERS_PER_DEGREE_LAT * lat.to_radians().cos(),
        }
    }

    /// The ring in metres, oriented POSITIVELY — the curvature reads a left turn as convex and the
    /// tracer emits its rings the same way, so both need the source's winding gone.
    fn to_meters(&self, ring: &Ring) -> Vec<(f64, f64)> {
        let mut points: Vec<(f64, f64)> = ring
            .iter()
            .map(|point| {
                (
                    (point.lng - self.lng) * self.meters_per_lng,
                    (point.lat - self.lat) * METERS_PER_DEGREE_LAT,
                )
            })
            .collect();
        if signed_double_area(&points) < 0.0 {
            points.reverse();
        }
        points
    }

    fn to_degrees(&self, points: &[(f64, f64)]) -> Ring {
        points
            .iter()
            .map(|(x, y)| Coord {
                lng: self.lng + x / self.meters_per_lng,
                lat: self.lat + y / METERS_PER_DEGREE_LAT,
            })
            .collect()
    }
}

fn signed_double_area(points: &[(f64, f64)]) -> f64 {
    let mut sum = 0.0;
    let mut previous = points.len() - 1;
    for current in 0..points.len() {
        sum += (points[current].0 - points[previous].0) * (points[current].1 + points[previous].1);
        previous = current;
    }
    -sum
}

/// The radius of the crowns that FORM an outline, read off how sharply it turns.
///
/// A merged canopy blob's edge is scalloped by the crowns standing along it, so the local radius of
/// curvature of that edge is the radius of those trees — and a lone crown's outline is one circle, so
/// the same measurement gives its own radius. That self-calibration is why this is not estimated from
/// area, which a blob's size would swamp.
///
/// The estimate is the TURNING-WEIGHTED MEDIAN of `ds / dtheta` over the convex samples, which is what
/// it is for two reasons. A signed mean collapses to `perimeter / 2 pi` for any closed ring
/// whatsoever, since its total turning is exactly one revolution; and a plain mean of the radii is
/// unbounded, because a traced stretch that happens to run straight has `dtheta -> 0` and pours its
/// whole length into the average. Weighting by turning makes each unit of turning vote once, so the
/// scallop caps dominate and the straight stretches carry no weight at all, and the median then
/// shrugs off what is left of both tails.
///
/// The tangent is read across a CHORD, not between neighbouring samples. A traced outline is a
/// staircase, and no amount of position smoothing stops it concentrating its turning at a handful of
/// samples and leaving the rest dead straight; measuring between adjacent samples therefore reads only
/// those concentrations and comes back at half the radius. A chord pair spans an arc however that arc
/// arrived, and the two chords and the angle between them are the three parts of the circle through
/// the three points — which is the radius exactly, at any chord length, so a small crown traced in
/// twenty samples is read as accurately as a large one.
fn curvature_radius(points: &[(f64, f64)]) -> f64 {
    let perimeter = closed_length(points);
    let samples = (perimeter / RESAMPLE_METERS).round() as usize;
    if samples < MIN_SAMPLES {
        return (perimeter / std::f64::consts::TAU).clamp(MIN_RADIUS_METERS, MAX_RADIUS_METERS);
    }
    let traced = resample_closed(points, samples, perimeter);
    let window = ((SMOOTH_METERS * samples as f64 / perimeter).round() as usize).max(1);
    let smoothed = circular_mean(&traced, window);
    let chord = (window * CHORD_WINDOWS).min(samples / 3).max(1);

    let mut turns: Vec<(f64, f64)> = Vec::with_capacity(samples);
    let mut total = 0.0;
    for index in 0..samples {
        let previous = smoothed[(index + samples - chord) % samples];
        let here = smoothed[index];
        let next = smoothed[(index + chord) % samples];
        let (into_x, into_y) = (here.0 - previous.0, here.1 - previous.1);
        let (out_x, out_y) = (next.0 - here.0, next.1 - here.1);
        let turn = f64::atan2(
            into_x * out_y - into_y * out_x,
            into_x * out_x + into_y * out_y,
        );
        if turn > 0.0 {
            let span = (f64::hypot(into_x, into_y) + f64::hypot(out_x, out_y)) / 2.0;
            let radius =
                (span / (2.0 * (turn / 2.0).sin())).clamp(MIN_RADIUS_METERS, MAX_RADIUS_METERS);
            total += turn;
            turns.push((radius, turn));
        }
    }
    if turns.is_empty() {
        return (perimeter / std::f64::consts::TAU).clamp(MIN_RADIUS_METERS, MAX_RADIUS_METERS);
    }
    turns.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut carried = 0.0;
    for (radius, turn) in &turns {
        carried += turn;
        if carried >= total / 2.0 {
            return *radius;
        }
    }
    turns[turns.len() - 1].0
}

fn closed_length(points: &[(f64, f64)]) -> f64 {
    let mut length = 0.0;
    let mut previous = points.len() - 1;
    for current in 0..points.len() {
        length += f64::hypot(
            points[current].0 - points[previous].0,
            points[current].1 - points[previous].1,
        );
        previous = current;
    }
    length
}

/// `count` points spaced evenly by arc length around the closed ring, starting at its first vertex.
fn resample_closed(points: &[(f64, f64)], count: usize, perimeter: f64) -> Vec<(f64, f64)> {
    let step = perimeter / count as f64;
    let segment = |at: usize| {
        let next = (at + 1) % points.len();
        (
            points[at],
            (points[next].0 - points[at].0, points[next].1 - points[at].1),
        )
    };
    let mut traced = Vec::with_capacity(count);
    let mut at = 0usize; // the segment the walk is on, from points[at] to its successor
    let mut walked = 0.0; // arc length consumed before it
    let mut span = f64::hypot(segment(0).1.0, segment(0).1.1);
    for sample in 0..count {
        let target = sample as f64 * step;
        while walked + span < target && at + 1 < points.len() {
            walked += span;
            at += 1;
            let (_, delta) = segment(at);
            span = f64::hypot(delta.0, delta.1);
        }
        let (from, delta) = segment(at);
        let along = if span > 0.0 {
            ((target - walked) / span).clamp(0.0, 1.0)
        } else {
            0.0
        };
        traced.push((from.0 + delta.0 * along, from.1 + delta.1 * along));
    }
    traced
}

/// Each point replaced by the mean of itself and the `window` points either side of it, around the
/// ring. Prefix sums, so the whole trace costs one pass whatever the window.
fn circular_mean(points: &[(f64, f64)], window: usize) -> Vec<(f64, f64)> {
    let count = points.len();
    let width = 2 * window + 1;
    let mut prefix: Vec<(f64, f64)> = Vec::with_capacity(count + 1);
    prefix.push((0.0, 0.0));
    for (x, y) in points {
        let (carried_x, carried_y) = prefix[prefix.len() - 1];
        prefix.push((carried_x + x, carried_y + y));
    }
    let total = prefix[count];
    // A window wider than the ring wraps all the way round it, so it is whole laps plus a remainder.
    let laps = (width / count) as f64;
    let rest = width % count;
    (0..count)
        .map(|index| {
            let start = (index + count - window % count) % count;
            let end = start + rest;
            let (span_x, span_y) = if end <= count {
                (
                    prefix[end].0 - prefix[start].0,
                    prefix[end].1 - prefix[start].1,
                )
            } else {
                (
                    total.0 - prefix[start].0 + prefix[end - count].0,
                    total.1 - prefix[start].1 + prefix[end - count].1,
                )
            };
            (
                (laps * total.0 + span_x) / width as f64,
                (laps * total.1 + span_y) / width as f64,
            )
        })
        .collect()
}

/// The outline offset INWARD by each of `insets`, as rings in the same metre space.
///
/// An inward offset with ROUND joins IS Euclidean erosion: a concave corner of the outline opens into
/// an arc of the offset's own depth, which is the one place a mitred or squared join would answer with
/// a different shape rather than a coarser one. The offset also handles a blob pinching itself in two
/// on the way in — the pieces come back as separate rings, which is ordinary output for a merged
/// canopy and not a failure — and each ring is simplified at the shipping tolerance, since a segment
/// that mattered on the outline can fall under it once the ring it belongs to has drawn in by a metre.
fn offset_rings(outline: &[(f64, f64)], insets: &[f64]) -> Vec<Vec<Vec<(f64, f64)>>> {
    let mut source: Polyline<f64> = Polyline::with_capacity(outline.len(), true);
    for (x, y) in outline {
        source.add(*x, *y, 0.0);
    }
    let source = source
        .remove_repeat_pos(REPEAT_POSITION_METERS)
        .unwrap_or(source);
    let index = source.create_approx_aabb_index();
    // An outline traced off a raster pinches, and the offset's own check that a candidate piece stands
    // clear of it measures distance without a side — so a piece lying OUTSIDE at that distance passes
    // too. The guards below are what catch those, rather than the crate's self-intersection path,
    // which costs twice the bake and finds nothing they do not.
    let options = PlineOffsetOptions {
        aabb_index: Some(&index),
        ..Default::default()
    };
    // Each level is cut from the one before it, so its rings enclose less between them than that one
    // did. Where the outline all but touches itself the offset crosses itself too and throws loops
    // that do not — inverted, or larger than what they were cut from — and a level that grows is the
    // tell. Carrying the bound down the levels catches a loop that is small against the whole crown
    // but larger than the ring it stands inside.
    let mut enclosed = signed_double_area(outline);
    insets
        .iter()
        .map(|inset| {
            // An inset under the tolerance the outline is already flattened at asks the offset to cut
            // by less than the vertex noise it is cutting from, which is where it crosses itself and
            // answers with a shape that is not the outline drawn in at all. The outline itself IS that
            // ring to within the tolerance both would ship at.
            if *inset < CROWN_SIMPLIFY_METERS {
                return vec![outline.to_vec()];
            }
            let source_area = enclosed;
            let level: Vec<Vec<(f64, f64)>> = source
                .parallel_offset_opt(*inset, &options)
                .iter()
                .filter_map(|ring| {
                    let straight = ring
                        .arcs_to_approx_lines(JOIN_ARC_METERS)
                        .unwrap_or_else(|| ring.clone());
                    let traced: Vec<(f64, f64)> =
                        straight.iter_vertexes().map(|at| (at.x, at.y)).collect();
                    if traced.len() < 3 {
                        return None;
                    }
                    let metres = simplified_or_whole(&traced);
                    let area = signed_double_area(&metres);
                    if area <= 0.0 || area >= source_area {
                        return None;
                    }
                    Some(metres)
                })
                .collect();
            // A level the offset had nothing to say about bounds nothing: carrying its zero down would
            // drop every level below it as well.
            let total: f64 = level.iter().map(|ring| signed_double_area(ring)).sum();
            if total > 0.0 {
                enclosed = total;
            }
            level
        })
        .collect()
}

/// One closed ring with everything Douglas-Peucker can drop dropped. Cut at its first vertex and the
/// one farthest from it, since a closed ring has no pair of fixed ends to run the recursion between.
fn simplify_closed(points: &[(f64, f64)], tolerance: f64) -> Vec<(f64, f64)> {
    let count = points.len();
    let reach =
        |index: usize| f64::hypot(points[index].0 - points[0].0, points[index].1 - points[0].1);
    let far = (1..count)
        .max_by(|left, right| reach(*left).total_cmp(&reach(*right)))
        .unwrap_or(0);
    let mut keep = vec![false; count + 1];
    keep[0] = true;
    keep[far] = true;
    keep[count] = true;
    let at = |index: usize| points[index % count];
    let mut spans = vec![(0usize, far), (far, count)];
    while let Some((first, end)) = spans.pop() {
        let Some((worst, distance)) = (first + 1..end)
            .map(|index| (index, segment_distance(at(index), at(first), at(end))))
            .max_by(|left, right| left.1.total_cmp(&right.1))
        else {
            continue;
        };
        if distance > tolerance {
            keep[worst] = true;
            spans.push((first, worst));
            spans.push((worst, end));
        }
    }
    (0..count).filter(|index| keep[*index]).map(at).collect()
}

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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// The outline of the cells a `cell`-metre raster sets, as the staircase of right angles the
    /// canopy file's own outlines are. Every set cell contributes the sides it shows to an unset
    /// neighbour, directed so the region stays on its left, and the sides are chained end to end; the
    /// runs along one straight edge then collapse to their two ends. The masks here are single blobs
    /// with no diagonal pinch, so one side leaves each corner and the chain is unambiguous.
    fn traced(inside: impl Fn(f64, f64) -> bool, span: i64, cell: f64) -> Vec<(f64, f64)> {
        let cells = (2 * span) as usize;
        let at = |col: usize, row: usize| {
            inside(
                (col as i64 - span) as f64 * cell + cell / 2.0,
                (row as i64 - span) as f64 * cell + cell / 2.0,
            )
        };
        let mut sides: HashMap<(i64, i64), (i64, i64)> = HashMap::new();
        for row in 0..cells {
            for col in 0..cells {
                if !at(col, row) {
                    continue;
                }
                let (west, south) = (col as i64, row as i64);
                let (east, north) = (west + 1, south + 1);
                let open = |step: (i64, i64)| {
                    let (col, row) = (col as i64 + step.0, row as i64 + step.1);
                    col < 0
                        || row < 0
                        || col >= cells as i64
                        || row >= cells as i64
                        || !at(col as usize, row as usize)
                };
                for (step, from, to) in [
                    ((1, 0), (east, south), (east, north)),
                    ((0, 1), (east, north), (west, north)),
                    ((-1, 0), (west, north), (west, south)),
                    ((0, -1), (west, south), (east, south)),
                ] {
                    if open(step) {
                        sides.insert(from, to);
                    }
                }
            }
        }
        let start = *sides.keys().next().expect("a traced blob");
        let mut walked = vec![start];
        let mut corner = sides[&start];
        while corner != start {
            walked.push(corner);
            corner = sides[&corner];
        }
        (0..walked.len())
            .filter(|step| {
                let previous = walked[(step + walked.len() - 1) % walked.len()];
                let here = walked[*step];
                let next = walked[(step + 1) % walked.len()];
                (here.0 - previous.0, here.1 - previous.1) != (next.0 - here.0, next.1 - here.1)
            })
            .map(|step| {
                let (col, row) = walked[step];
                ((col - span) as f64 * cell, (row - span) as f64 * cell)
            })
            .collect()
    }

    /// A disc of `radius` metres traced off a one-metre raster.
    fn traced_disc(radius: f64) -> Vec<(f64, f64)> {
        traced(
            |x, y| f64::hypot(x, y) < radius,
            radius.ceil() as i64 + 2,
            1.0,
        )
    }

    /// The estimator against discs of a known radius, which is the whole calibration of the smoothing
    /// window: too narrow and it reads the raster staircase's own right angles, too wide and it flattens
    /// the scallops it is there to measure.
    #[test]
    fn reads_a_disc_radius() {
        for radius in [3.0, 5.0, 8.0] {
            let estimate = curvature_radius(&traced_disc(radius));
            assert!(
                (estimate - radius).abs() <= 0.2 * radius,
                "a {radius} m disc read as {estimate} m"
            );
        }
    }

    /// Two discs merged into one blob read as ONE disc's radius, not as the blob's: the outline's
    /// curvature is the crowns forming it, which is what makes the estimate self-calibrating over a
    /// park where nothing else could say how big its trees are.
    #[test]
    fn reads_the_crowns_a_blob_is_made_of() {
        let blob = traced(
            |x, y| f64::hypot(x + 4.0, y) < 5.0 || f64::hypot(x - 4.0, y) < 5.0,
            20,
            1.0,
        );
        let estimate = curvature_radius(&blob);
        assert!(
            (estimate - 5.0).abs() <= 1.5,
            "the blob read as {estimate} m"
        );
    }

    /// An inward offset of a disc is a concentric disc of `radius - inset`, positively wound so a
    /// nonzero fill unions the slices instead of cancelling them. The source is sampled smoothly
    /// rather than traced, so what is measured here is the offset alone.
    #[test]
    fn insets_a_disc_by_its_offset() {
        let radius = 30.0;
        let ring: Vec<(f64, f64)> = (0..360)
            .map(|degree| {
                let angle = f64::from(degree).to_radians();
                (radius * angle.cos(), radius * angle.sin())
            })
            .collect();
        for (inset, rings) in [5.0, 10.0].iter().zip(offset_rings(&ring, &[5.0, 10.0])) {
            assert_eq!(rings.len(), 1, "insetting a disc leaves one piece");
            let area = signed_double_area(&rings[0]) / 2.0;
            let expected = std::f64::consts::PI * (radius - inset).powi(2);
            assert!(area > 0.0, "the inset ring winds positively");
            assert!(
                (area - expected).abs() < 0.03 * expected,
                "insetting {radius} m by {inset} m left {area:.1} m2, not {expected:.1}"
            );
        }
    }

    /// A concave corner opens into an ARC of the offset's own depth, which is the one place a mitred
    /// or squared join answers with a different shape rather than a coarser one: both would run the
    /// two offset edges on to where they cross and cut the corner off there, losing everything
    /// between that point and the arc — `(1 - pi/4) * inset^2` at a right angle.
    #[test]
    fn rounds_the_joins_a_concave_corner_opens() {
        let ell = [
            (0.0, 0.0),
            (100.0, 0.0),
            (100.0, 40.0),
            (40.0, 40.0),
            (40.0, 100.0),
            (0.0, 100.0),
        ];
        let inset = 10.0;
        let rings = offset_rings(&ell, &[inset]).remove(0);
        assert_eq!(rings.len(), 1);
        let corner = (40.0, 40.0);
        let arc: Vec<&(f64, f64)> = rings[0]
            .iter()
            .filter(|(x, y)| *x > corner.0 - inset && *y > corner.1 - inset)
            .collect();
        assert!(
            arc.len() >= 2,
            "a mitred or squared join would leave nothing inside the corner, this left {arc:?}"
        );
        for (x, y) in &arc {
            let reach = f64::hypot(x - corner.0, y - corner.1);
            assert!(
                (reach - inset).abs() < CROWN_SIMPLIFY_METERS,
                "a corner vertex {reach:.2} m out, not {inset}"
            );
        }
        // The union of the two arms eroded on their own, which is what a mitred join would have left.
        let mitred =
            2.0 * (100.0 - 2.0 * inset) * (40.0 - 2.0 * inset) - (40.0 - 2.0 * inset).powi(2);
        let corner_area = (1.0 - std::f64::consts::FRAC_PI_4) * inset * inset;
        let area = signed_double_area(&rings[0]) / 2.0;
        assert!(
            (area - mitred - corner_area).abs() < 0.3 * corner_area,
            "the corner left {area:.1} m2, nearer the mitred {mitred:.1} than the rounded {:.1}",
            mitred + corner_area
        );
    }

    /// A dumbbell pinches into two rings before it vanishes, which is the case a polygon offset has to
    /// carry and the one an outline translated sideways never would.
    #[test]
    fn splits_a_blob_that_pinches_in_two() {
        let waist = |x: f64, y: f64| y.abs() < 2.0 && x.abs() < 9.0;
        let dumbbell = simplified_or_whole(&traced(
            |x, y| f64::hypot(x + 8.0, y) < 5.0 || f64::hypot(x - 8.0, y) < 5.0 || waist(x, y),
            20,
            1.0,
        ));
        let inset = offset_rings(&dumbbell, &[1.5, 3.0]);
        assert_eq!(inset[0].len(), 1, "the waist still joins them at 1.5 m");
        assert_eq!(inset[1].len(), 2, "at 3 m the waist is gone");
        for ring in &inset[1] {
            assert!(
                signed_double_area(ring) > 0.0,
                "both pieces wind positively"
            );
        }
    }

    /// The slices NEST around the crown's widest section rather than stacking away from its base: the
    /// widest ring sweeps nothing in the middle of the smear and each narrower one reaches further out
    /// at both ends, which is what makes the silhouette a lens. A smear under a couple of pixels
    /// collapses to the widest ring alone, which is what keeps a high sun at the cost it has today.
    #[test]
    fn nests_the_slices_around_the_widest_section() {
        // A 10 m crown at a 5 degree sun: 0.6 * 10 * 11.43 = 68.6 m of smear over 3.6 m pixels.
        let low = crown_segments(10.0, 11.43, 500.0, 3.6);
        assert_eq!(low.len(), CROWN_SEGMENTS);
        let middle = 0.7 * 10.0 * 11.43;
        assert_eq!(low[0].level, 0);
        assert!((low[0].from_m - middle).abs() < 1e-9);
        assert!((low[0].to_m - middle).abs() < 1e-9);
        for (slice, pair) in low.windows(2).enumerate() {
            assert_eq!(pair[1].level, slice + 1);
            assert!(pair[1].from_m < pair[0].from_m, "reaches back further");
            assert!(pair[1].to_m > pair[0].to_m, "reaches out further");
            assert!(
                ((pair[1].from_m + pair[1].to_m) / 2.0 - middle).abs() < 1e-9,
                "centred on the widest section"
            );
        }
        // Every band is inside the crown, and the innermost one spans all but the crown's two points.
        assert!(low[CROWN_SEGMENTS - 1].from_m > 0.4 * 10.0 * 11.43);
        assert!(low[CROWN_SEGMENTS - 1].to_m < 10.0 * 11.43);
        let swept = low[CROWN_SEGMENTS - 1].to_m - low[CROWN_SEGMENTS - 1].from_m;
        let smear = 0.6 * 10.0 * 11.43;
        assert!((swept - CROWN_TIP_FRACTION * smear).abs() < 1e-9);

        // The same crown at a 60 degree sun smears 3.5 m, under a pixel.
        let high = crown_segments(10.0, 0.577, 500.0, 3.6);
        assert_eq!(high.len(), 1);
        assert_eq!(high[0].level, 0);
        assert!((high[0].to_m - high[0].from_m).abs() < 1e-9);
    }

    /// The rings sample the crown at evenly spaced HEIGHTS, which is what keeps the silhouette a lens.
    /// Spacing the same four rings by equal inset instead puts two thirds of the shadow's length at one
    /// width and caps that width at 75% of the crown's, so it renders as a bar.
    #[test]
    fn spaces_the_rings_by_equal_height() {
        let offsets: Vec<f64> = (0..CROWN_SEGMENTS).map(band_offset).collect();
        for step in offsets.windows(2) {
            assert!(
                (step[1] - step[0] - CROWN_TIP_FRACTION / (CROWN_SEGMENTS - 1) as f64).abs()
                    < 1e-12,
                "evenly spaced in height"
            );
        }
        assert!((offsets[CROWN_SEGMENTS - 1] - CROWN_TIP_FRACTION).abs() < 1e-12);

        // Slice 0 spans a single height and sweeps nothing, so the widest ring the shadow is ever as
        // wide as is slice 1's — 94% of the crown's radius here, 75% under equal inset.
        assert!((ring_share(0) - 1.0).abs() < 1e-12);
        assert!(ring_share(1) > 0.94);
        assert!(
            ring_share(1) > (1.0f64 - 1.0 / CROWN_SEGMENTS as f64),
            "wider than the equal-inset spacing this replaced"
        );
        // And it holds that width over a third of the smear, where equal inset held it over two thirds.
        assert!(band_offset(1) < 0.34);
    }

    /// Two slices take every other LEVEL, since the rings ship at fixed insets, and past the shadow
    /// clip the flattened inner slices are dropped in favour of the widest ring that covers them.
    #[test]
    fn steps_by_stride_and_drops_the_slices_the_clip_flattens() {
        let coarse = crown_segments(10.0, 5.0, 500.0, 8.0);
        assert_eq!(coarse.len(), 2);
        assert_eq!(coarse[1].level, 2);

        let clipped = crown_segments(10.0, 5.0, 21.0, 0.91);
        assert_eq!(clipped.len(), 2, "only the two bands that start inside it");
        assert_eq!(clipped[0].level, 0);
        assert!(clipped.iter().all(|segment| segment.to_m <= 21.0));
    }

    /// The bands both halves of the model cut, in metres of shadow displacement, for
    /// (height, shadow per height, metres per pixel). Duplicated verbatim in the matching case of
    /// src/tiles/sweep.test.ts: the pyramid hands over to the client's own sweep at one zoom, and a
    /// table on each side is what catches either drifting from the other.
    #[test]
    fn cuts_the_bands_the_client_cuts() {
        let cases: [(f64, f64, f64, &[(usize, f64, f64)]); 3] = [
            (
                10.0,
                5.0,
                0.91,
                &[
                    (0, 35.0, 35.0),
                    (1, 30.05, 39.95),
                    (2, 25.10, 44.90),
                    (3, 20.15, 49.85),
                ],
            ),
            (
                18.0,
                2.0,
                0.91,
                &[
                    (0, 25.2, 25.2),
                    (1, 21.636, 28.764),
                    (2, 18.072, 32.328),
                    (3, 14.508, 35.892),
                ],
            ),
            (
                7.0,
                11.43,
                3.6,
                &[
                    (0, 56.007, 56.007),
                    (1, 48.08601, 63.92799),
                    (2, 40.16502, 71.84898),
                    (3, 32.24403, 79.76997),
                ],
            ),
        ];
        for (height, shadow_per_height, meters_per_pixel, expected) in cases {
            let cut = crown_segments(height, shadow_per_height, 500.0, meters_per_pixel);
            assert_eq!(cut.len(), expected.len());
            for (segment, (level, from_m, to_m)) in cut.iter().zip(expected) {
                assert_eq!(segment.level, *level);
                assert!(
                    (segment.from_m - from_m).abs() < 1e-6 && (segment.to_m - to_m).abs() < 1e-6,
                    "a {height} m crown's slice {level} swept {:.6}..{:.6}, not {from_m}..{to_m}",
                    segment.from_m,
                    segment.to_m
                );
            }
        }
    }
}
