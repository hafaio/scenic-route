//! Which CSCL street side each OSM sidewalk way flanks. The association is what gives a mapped
//! sidewalk edge everything durable about it — the street's name, its N/E/S/W side, its half-offset
//! byte and its physicalid key — and it is also what decides, stretch by stretch, where a derived
//! offset edge is placed at all. Both directions come out of this one pass, so the labels and the
//! exclusivity can never disagree. DESIGN.md, "OSM is the pavement, CSCL is the label" and "Named by
//! the street it flanks, not by the way id", is why. See scripts/README.md for the layouts.
//!
//! The corridor test here is the one `scripts/sidewalks.ts` matches the STRT per-side bits with, and
//! is deliberately not a widening of the conflation's 6 m dedup band.

use crate::conflate::{
    Point, ProtoEdge, SIDEWALK_LEFT, SIDEWALK_RIGHT, SegmentGrid, bearing_degrees, line_angle,
    meters_between, polyline_meters, project,
};
use crate::graph::{DECIMETERS_PER_METER, KIND_SIDEWALK};

// A way running ON the centreline is a mis-mapped alley, not a sidewalk, and would claim both
// sides; one beyond the derived position plus the slack a real kerb line wanders by belongs to some
// other street.
const MIN_MATCH_METERS: f64 = 2.0;
const EXTRA_MATCH_METERS: f64 = 12.0;
const MATCH_BEARING_DEGREES: f64 = 30.0; // mod 180: a sidewalk may be digitized either way round
// The widest half-offset the STRT byte can hold, so no street's band reaches past this.
const SEARCH_METERS: f64 = 25.5 + EXTRA_MATCH_METERS;
// A way crosses from one street to the next at a corner, and the match flickers over a metre or two
// where it wraps; a stretch shorter than this is absorbed rather than cut out as its own edge. The
// same figure closes the gaps between what OSM owns of one street side: two mapped stretches this
// close together leave no room for a derived edge anyone would walk between them, and a stretch of
// street this short at either end is the end.
const MIN_RUN_METERS: f64 = 8.0;
// A crossing runs *across* a street, so the corridor test cannot see it; its cover byte comes from
// the nearest street instead, at a radius that reaches over the widest roadway.
const CROSSED_METERS: f64 = 30.0;
// How short a stub of derived pavement at the end of a mapped side is not worth placing: the reach
// of the seam link a corner uses to meet the mapped pavement beside it (graph.rs SEAM_LINK_METERS).
// OSM's ways stop at the kerb ramp rather than at the CSCL intersection, so nearly every mapped side
// falls a few metres short at each end; placing an edge in that gap would leave a stub the corner
// already reaches over, on top of splitting the street twice to do it.
const MIN_DERIVED_METERS: f64 = 20.0;
// And how much wider than its own vertices a run's stretch is taken to be. The extent is measured by
// projecting the run's vertices, but the edge OSM's way becomes carries on to the node it shares
// with the next way, and the trim boundary is quantized and re-noded on its way through the
// conflation. Without this margin every boundary leaves a couple of metres of offset lying under the
// mapped pavement — most of what is left of the duplication once the per-stretch rule is in.
const SPAN_MARGIN_METERS: f64 = 4.0;

/// The street side one stretch of an OSM way was matched to.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Match {
    pub street: u32,
    pub sidewalk: u8, // SIDEWALK_LEFT or SIDEWALK_RIGHT, in that street's stored direction
    /// Whether the street lies to the *way's own* geometry-left — so the buildings are to its right.
    /// A derived sidewalk states this with the geometry-right flag and the shed placement reads it to
    /// know which side of the pavement the frontage is on; an OSM way is digitized whichever way its
    /// mapper drew it, so it has to be measured rather than assumed. A run that doubles back changes
    /// this and is cut at the turn, since the two halves face opposite ways.
    pub street_left: bool,
}

/// One stretch of an OSM way sharing a single association, vertices `from..=to`.
pub struct Run {
    pub from: usize,
    pub to: usize,
    pub matched: Option<Match>,
}

/// The stretches of one street side OSM maps for itself, in metres along the street's stored
/// direction, sorted and disjoint. A derived offset is placed over the complement of this and only
/// the complement: exclusivity is per stretch, so a side OSM maps a third of gets its OSM geometry
/// over that third and a derived edge over the other two, never both over the same ground.
type Spans = Vec<(f64, f64)>;

/// What the swap needs out of matching OSM's sidewalk ways against the CSCL streets.
pub struct Association {
    /// Per way, the stretches of it that carry one association each.
    pub runs: Vec<Vec<Run>>,
    /// Per street proto, what OSM owns of its geometry-left side then its geometry-right.
    pub covered: Vec<[Spans; 2]>,
    /// Per way, the nearest street proto to its middle *vertex* whatever its bearing — what a
    /// crossing takes its cover byte from. A two-vertex crossing has no interior vertex, so that is
    /// its far kerb rather than the middle of the roadway, which `CROSSED_METERS` is wide enough to
    /// absorb.
    pub crossed: Vec<Option<u32>>,
}

/// The sub-segment of a street a point lies alongside: the street, which side of it, and how far.
fn match_at(
    grid: &SegmentGrid,
    streets: &[ProtoEdge],
    point: Point,
    bearing: f64,
    meters_per_unit: (f64, f64),
) -> Option<Match> {
    let mut best: Option<(f64, Match)> = None;
    for (street_index, vertex) in grid.nearby(point, SEARCH_METERS, meters_per_unit) {
        let street = &streets[street_index as usize];
        // A street that is itself the walking surface has no sides to flank.
        if street.offset == 0 {
            continue;
        }
        let limit = f64::from(street.offset) / DECIMETERS_PER_METER + EXTRA_MATCH_METERS;
        let from = (
            street.poly_x[vertex as usize],
            street.poly_y[vertex as usize],
        );
        let to = (
            street.poly_x[vertex as usize + 1],
            street.poly_y[vertex as usize + 1],
        );
        let along = bearing_degrees(from, to, meters_per_unit);
        if line_angle(bearing, along) > MATCH_BEARING_DEGREES {
            continue; // runs across the street, not along it
        }
        let (distance, _, projected) = project(point, from, to, meters_per_unit);
        if distance < MIN_MATCH_METERS || distance > limit {
            continue;
        }
        // Left is 90 degrees counter-clockwise of the street's stored direction, as the density
        // blob's two bytes a vertex and the derived offset both are.
        let along_east = f64::from(to.0 - from.0) * meters_per_unit.0;
        let along_north = f64::from(to.1 - from.1) * meters_per_unit.1;
        let out_east = f64::from(point.0 - projected.0) * meters_per_unit.0;
        let out_north = f64::from(point.1 - projected.1) * meters_per_unit.1;
        // The way's own direction, for which side of *it* the roadway lies.
        let (way_north, way_east) = bearing.to_radians().sin_cos();
        let matched = Match {
            street: street_index,
            sidewalk: if along_east * out_north - along_north * out_east > 0.0 {
                SIDEWALK_LEFT
            } else {
                SIDEWALK_RIGHT
            },
            // The street is to the way's left when the turn from the way's own direction to the
            // vector pointing at the centreline is counter-clockwise. `out_*` runs from the street to
            // the way, so the vector at the street is its negation.
            street_left: way_east * -out_north - way_north * -out_east > 0.0,
        };
        // Nearest wins, with the street id breaking a tie so the result does not depend on the
        // order the grid happened to hand the candidates back.
        let better = best.is_none_or(|(incumbent, held)| {
            distance < incumbent || (distance == incumbent && matched.street < held.street)
        });
        if better {
            best = Some((distance, matched));
        }
    }
    best.map(|(_, matched)| matched)
}

/// The nearest street proto to a point, whatever its bearing.
fn nearest_street(
    grid: &SegmentGrid,
    streets: &[ProtoEdge],
    point: Point,
    meters_per_unit: (f64, f64),
) -> Option<u32> {
    let mut best: Option<(f64, u32)> = None;
    for (street_index, vertex) in grid.nearby(point, CROSSED_METERS, meters_per_unit) {
        let street = &streets[street_index as usize];
        let from = (
            street.poly_x[vertex as usize],
            street.poly_y[vertex as usize],
        );
        let to = (
            street.poly_x[vertex as usize + 1],
            street.poly_y[vertex as usize + 1],
        );
        let (distance, _, _) = project(point, from, to, meters_per_unit);
        if distance <= CROSSED_METERS
            && best.is_none_or(|(incumbent, held)| {
                distance < incumbent || (distance == incumbent && street_index < held)
            })
        {
            best = Some((distance, street_index));
        }
    }
    best.map(|(_, street)| street)
}

/// The distance in metres from a polyline's start to each of its vertices.
pub fn cumulative_meters(poly_x: &[i32], poly_y: &[i32], meters_per_unit: (f64, f64)) -> Vec<f64> {
    let mut running = 0.0;
    let mut cumulative = Vec::with_capacity(poly_x.len());
    cumulative.push(0.0);
    for vertex in 1..poly_x.len() {
        running += meters_between(
            (poly_x[vertex - 1], poly_y[vertex - 1]),
            (poly_x[vertex], poly_y[vertex]),
            meters_per_unit,
        );
        cumulative.push(running);
    }
    cumulative
}

/// How far along a polyline the point on it nearest `point` lies, in metres.
fn along_meters(
    poly_x: &[i32],
    poly_y: &[i32],
    cumulative: &[f64],
    point: Point,
    meters_per_unit: (f64, f64),
) -> f64 {
    let mut best = (f64::INFINITY, 0.0);
    for vertex in 1..poly_x.len() {
        let from = (poly_x[vertex - 1], poly_y[vertex - 1]);
        let to = (poly_x[vertex], poly_y[vertex]);
        let (distance, param, _) = project(point, from, to, meters_per_unit);
        if distance < best.0 {
            let span = cumulative[vertex] - cumulative[vertex - 1];
            best = (distance, cumulative[vertex - 1] + param * span);
        }
    }
    best.1
}

/// Sort the stretches OSM owns of one street side and fuse the ones that touch: overlapping, or
/// parted by less than a stretch anybody would walk. A stretch that reaches within a seam link of
/// the street's own end, and is longer than the stub it would leave there, is taken to reach it —
/// which is what keeps a mapped side from being cut twice to place two kerb-length stubs.
fn merge_spans(mut spans: Spans, length: f64) -> Spans {
    spans.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut merged: Spans = Vec::with_capacity(spans.len());
    for (start, end) in spans {
        let (start, end) = (
            (start - SPAN_MARGIN_METERS).max(0.0),
            (end + SPAN_MARGIN_METERS).min(length),
        );
        match merged.last_mut() {
            Some(last) if start <= last.1 + MIN_RUN_METERS => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    if let Some(first) = merged.first_mut()
        && first.0 < MIN_DERIVED_METERS.min(first.1 - first.0)
    {
        first.0 = 0.0;
    }
    if let Some(last) = merged.last_mut()
        && length - last.1 < MIN_DERIVED_METERS.min(last.1 - last.0)
    {
        last.1 = length;
    }
    merged
}

/// The stretches of a street that share one derived-sidewalk mask, as (end metre, mask) pairs
/// spanning `0..length` in order: the sides pavement exists on, minus whatever OSM owns there. A
/// stretch too short to be worth its own pair of corner nodes is absorbed into its longer
/// neighbour, so the street is cut only where the answer really changes.
pub fn derived_stretches(covered: &[Spans; 2], exists: u8, length: f64) -> Vec<(f64, u8)> {
    let mut edges: Vec<f64> = vec![0.0, length];
    for spans in covered {
        for &(start, end) in spans {
            edges.push(start.clamp(0.0, length));
            edges.push(end.clamp(0.0, length));
        }
    }
    edges.sort_by(f64::total_cmp);
    edges.dedup();

    let owns = |spans: &Spans, at: f64| spans.iter().any(|&(start, end)| at >= start && at <= end);
    let mut stretches: Vec<(f64, u8)> = Vec::with_capacity(edges.len());
    for pair in edges.windows(2) {
        let middle = (pair[0] + pair[1]) / 2.0;
        let mut mask = exists;
        if owns(&covered[0], middle) {
            mask &= !SIDEWALK_LEFT;
        }
        if owns(&covered[1], middle) {
            mask &= !SIDEWALK_RIGHT;
        }
        match stretches.last_mut() {
            Some(last) if last.1 == mask => last.0 = pair[1],
            _ => stretches.push((pair[1], mask)),
        }
    }
    // Same absorption `runs_of` does, for the same reason: two sides' stretch ends land a metre
    // apart and would otherwise cut a sliver of street out between them.
    while stretches.len() > 1 {
        let (shortest, span) = (0..stretches.len())
            .map(|index| (index, stretches[index].0 - stretch_start(&stretches, index)))
            .min_by(|left, right| left.1.total_cmp(&right.1).then(left.0.cmp(&right.0)))
            .expect("a stretch");
        if span >= MIN_RUN_METERS {
            break;
        }
        let before = shortest
            .checked_sub(1)
            .map(|index| stretches[index].0 - stretch_start(&stretches, index));
        let after = stretches
            .get(shortest + 1)
            .map(|&(end, _)| end - stretches[shortest].0);
        let absorb_back = match (before, after) {
            (Some(back), Some(ahead)) => back >= ahead,
            (Some(_), None) => true,
            _ => false,
        };
        // Absorbing back moves the previous stretch's end forward over this one; absorbing ahead
        // needs nothing, since the next already ends where it should and now starts earlier.
        if absorb_back {
            stretches[shortest - 1].0 = stretches[shortest].0;
        }
        stretches.remove(shortest);
    }
    stretches
}

/// Where a stretch begins, given where the one before it ends.
fn stretch_start(stretches: &[(f64, u8)], index: usize) -> f64 {
    index
        .checked_sub(1)
        .map_or(0.0, |before| stretches[before].0)
}

/// The length in metres of vertices `from..=to` of a polyline.
fn stretch_meters(
    poly_x: &[i32],
    poly_y: &[i32],
    from: usize,
    to: usize,
    meters_per_unit: (f64, f64),
) -> f64 {
    polyline_meters(&poly_x[from..=to], &poly_y[from..=to], meters_per_unit)
}

/// Cut a way into stretches of one association each, then absorb every stretch too short to stand
/// on its own into its longer neighbour, taking that neighbour's association with it.
fn runs_of(
    matches: &[Option<Match>],
    poly_x: &[i32],
    poly_y: &[i32],
    meters_per_unit: (f64, f64),
) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for (piece, matched) in matches.iter().enumerate() {
        match runs.last_mut() {
            Some(run) if run.matched == *matched => run.to = piece + 1,
            _ => runs.push(Run {
                from: piece,
                to: piece + 1,
                matched: *matched,
            }),
        }
    }
    while runs.len() > 1 {
        let (shortest, length) = runs
            .iter()
            .enumerate()
            .map(|(index, run)| {
                (
                    index,
                    stretch_meters(poly_x, poly_y, run.from, run.to, meters_per_unit),
                )
            })
            .min_by(|left, right| left.1.total_cmp(&right.1).then(left.0.cmp(&right.0)))
            .expect("a run");
        if length >= MIN_RUN_METERS {
            break;
        }
        let before = shortest.checked_sub(1).map(|index| {
            stretch_meters(
                poly_x,
                poly_y,
                runs[index].from,
                runs[index].to,
                meters_per_unit,
            )
        });
        let after = runs
            .get(shortest + 1)
            .map(|run| stretch_meters(poly_x, poly_y, run.from, run.to, meters_per_unit));
        let absorb_back = match (before, after) {
            (Some(back), Some(ahead)) => back >= ahead,
            (Some(_), None) => true,
            _ => false,
        };
        if absorb_back {
            runs[shortest - 1].to = runs[shortest].to;
        } else {
            runs[shortest + 1].from = runs[shortest].from;
        }
        runs.remove(shortest);
    }
    runs
}

/// Match every OSM sidewalk way against the CSCL streets, both ways round.
pub fn associate(
    streets: &[ProtoEdge],
    ways: &[ProtoEdge],
    meters_per_unit: (f64, f64),
) -> Association {
    let grid = SegmentGrid::new(
        streets
            .iter()
            .map(|street| (&street.poly_x[..], &street.poly_y[..])),
        meters_per_unit,
    );

    let mut runs: Vec<Vec<Run>> = Vec::with_capacity(ways.len());
    let mut crossed: Vec<Option<u32>> = Vec::with_capacity(ways.len());
    for way in ways {
        let pieces = way.poly_x.len() - 1;
        if way.kind == KIND_SIDEWALK {
            let matches: Vec<Option<Match>> = (0..pieces)
                .map(|piece| {
                    let from = (way.poly_x[piece], way.poly_y[piece]);
                    let to = (way.poly_x[piece + 1], way.poly_y[piece + 1]);
                    let midpoint = ((from.0 + to.0) / 2, (from.1 + to.1) / 2);
                    if meters_between(from, to, meters_per_unit) == 0.0 {
                        None
                    } else {
                        match_at(
                            &grid,
                            streets,
                            midpoint,
                            bearing_degrees(from, to, meters_per_unit),
                            meters_per_unit,
                        )
                    }
                })
                .collect();
            runs.push(runs_of(&matches, &way.poly_x, &way.poly_y, meters_per_unit));
            crossed.push(None);
        } else {
            // A crossing or a traffic island: one stretch, no side of its own.
            runs.push(vec![Run {
                from: 0,
                to: pieces,
                matched: None,
            }]);
            let middle = way.poly_x.len() / 2;
            crossed.push(nearest_street(
                &grid,
                streets,
                (way.poly_x[middle], way.poly_y[middle]),
                meters_per_unit,
            ));
        }
    }

    // What OSM owns of each street side, stretch by stretch: every matched run projected back onto
    // the street it flanks, so the assignment above — not a second, separately drifting test — is
    // what says where the derived edge stands down, and says it over exactly that ground.
    let rulers: Vec<Vec<f64>> = streets
        .iter()
        .map(|street| cumulative_meters(&street.poly_x, &street.poly_y, meters_per_unit))
        .collect();
    let mut covered: Vec<[Spans; 2]> = streets
        .iter()
        .map(|_| [Spans::new(), Spans::new()])
        .collect();
    for (way, way_runs) in ways.iter().zip(&runs) {
        for run in way_runs {
            let Some(matched) = run.matched else {
                continue;
            };
            let street = &streets[matched.street as usize];
            let ruler = &rulers[matched.street as usize];
            let mut span = (f64::INFINITY, f64::NEG_INFINITY);
            for vertex in run.from..=run.to {
                let along = along_meters(
                    &street.poly_x,
                    &street.poly_y,
                    ruler,
                    (way.poly_x[vertex], way.poly_y[vertex]),
                    meters_per_unit,
                );
                span = (span.0.min(along), span.1.max(along));
            }
            let side = usize::from(matched.sidewalk == SIDEWALK_RIGHT);
            covered[matched.street as usize][side].push(span);
        }
    }
    for (sides, ruler) in covered.iter_mut().zip(&rulers) {
        let length = ruler.last().copied().unwrap_or(0.0);
        for spans in sides.iter_mut() {
            *spans = merge_spans(std::mem::take(spans), length);
        }
    }

    Association {
        runs,
        covered,
        crossed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{KIND_CROSSING, SIDE_NONE};

    const MPU: (f64, f64) = (1.0, 1.0); // quantized units are metres, so fixtures read in metres

    fn proto(poly: &[(i32, i32)], offset: u8, kind: u8) -> ProtoEdge {
        let poly_x: Vec<i32> = poly.iter().map(|point| point.0).collect();
        let poly_y: Vec<i32> = poly.iter().map(|point| point.1).collect();
        let length = polyline_meters(&poly_x, &poly_y, MPU) as f32;
        ProtoEdge {
            poly_x,
            poly_y,
            length,
            cover_left: 0,
            cover_right: 0,
            offset,
            flags: 0,
            name_id: 0xFFFF,
            osm: offset == 0,
            source_id: 0,
            kind,
            side: SIDE_NONE,
            sidewalks: 0,
            paved: 0,
            kerb_a: false,
            kerb_b: false,
        }
    }

    #[test]
    fn a_way_beside_a_street_takes_that_street_and_side() {
        // The street's sidewalks sit 4 m either side; the way runs along the northern one, which is
        // geometry-left of a street digitized west to east.
        let streets = vec![proto(&[(0, 0), (100, 0)], 40, KIND_SIDEWALK)];
        let ways = vec![proto(&[(0, 4), (100, 4)], 0, KIND_SIDEWALK)];
        let association = associate(&streets, &ways, MPU);
        assert_eq!(association.runs[0].len(), 1);
        let matched = association.runs[0][0].matched.expect("a match");
        assert_eq!(matched.street, 0);
        assert_eq!(matched.sidewalk, SIDEWALK_LEFT);
        // Both run west to east, so the street is to the way's right and the buildings to its left.
        assert!(!matched.street_left);
        assert_eq!(
            association.covered[0][0],
            vec![(0.0, 100.0)],
            "the whole left side"
        );
        assert!(association.covered[0][1].is_empty());
    }

    #[test]
    fn a_way_digitized_against_its_street_puts_the_buildings_the_other_way() {
        // The same pavement, drawn east to west: the street is now to the way's left, so the shed
        // placement must look for the frontage on its right.
        let streets = vec![proto(&[(0, 0), (100, 0)], 40, KIND_SIDEWALK)];
        let ways = vec![proto(&[(100, 4), (0, 4)], 0, KIND_SIDEWALK)];
        let association = associate(&streets, &ways, MPU);
        let matched = association.runs[0][0].matched.expect("a match");
        assert_eq!(
            matched.sidewalk, SIDEWALK_LEFT,
            "still the street's left side"
        );
        assert!(matched.street_left);
    }

    #[test]
    fn a_way_on_the_centreline_claims_no_side() {
        // Under 2 m off: a mis-mapped way lying on the road itself, which would otherwise claim
        // whichever side rounding put it on.
        let streets = vec![proto(&[(0, 0), (100, 0)], 40, KIND_SIDEWALK)];
        let ways = vec![proto(&[(0, 1), (100, 1)], 0, KIND_SIDEWALK)];
        let association = associate(&streets, &ways, MPU);
        assert!(association.runs[0][0].matched.is_none());
        assert!(association.covered[0].iter().all(Vec::is_empty));
    }

    #[test]
    fn a_way_down_part_of_a_street_owns_only_that_part() {
        // The defect this replaces: 40 m of a 100 m side was under the old per-side threshold, so
        // the side kept a *full-length* derived offset alongside the OSM way — two routable
        // sidewalks over the same 40 m. It now owns its 40 m and the offset takes the other 60.
        let streets = vec![proto(&[(0, 0), (100, 0)], 40, KIND_SIDEWALK)];
        let ways = vec![proto(&[(0, 4), (40, 4)], 0, KIND_SIDEWALK)];
        let association = associate(&streets, &ways, MPU);
        assert!(association.runs[0][0].matched.is_some(), "still matched");
        // 0..40 as the way's own vertices project, widened by the margin the edge it becomes runs
        // on past them, and reaching the street's start because the stub it would leave is shorter.
        assert_eq!(association.covered[0][0], vec![(0.0, 44.0)]);
        assert_eq!(
            derived_stretches(
                &association.covered[0],
                SIDEWALK_LEFT | SIDEWALK_RIGHT,
                100.0
            ),
            vec![
                (44.0, SIDEWALK_RIGHT),
                (100.0, SIDEWALK_LEFT | SIDEWALK_RIGHT)
            ],
        );
    }

    #[test]
    fn stretches_a_metre_apart_are_one_stretch() {
        // Two ways along the same side with a 2 m gap between them: fused, because a 2 m derived
        // sidewalk between two mapped ones is an edge nobody walks, and its ends reach the street's.
        let streets = vec![proto(&[(0, 0), (100, 0)], 40, KIND_SIDEWALK)];
        let ways = vec![
            proto(&[(3, 4), (49, 4)], 0, KIND_SIDEWALK),
            proto(&[(51, 4), (96, 4)], 0, KIND_SIDEWALK),
        ];
        let association = associate(&streets, &ways, MPU);
        assert_eq!(association.covered[0][0], vec![(0.0, 100.0)]);
        assert_eq!(
            derived_stretches(
                &association.covered[0],
                SIDEWALK_LEFT | SIDEWALK_RIGHT,
                100.0
            ),
            vec![(100.0, SIDEWALK_RIGHT)],
            "one uncut street with no left offset at all",
        );
    }

    #[test]
    fn a_way_turning_a_corner_is_cut_where_the_street_changes() {
        // Two streets meeting at the origin; one way wraps from the first's north side onto the
        // second's east side.
        let streets = vec![
            proto(&[(-100, 0), (0, 0)], 40, KIND_SIDEWALK),
            proto(&[(0, 0), (0, 100)], 40, KIND_SIDEWALK),
        ];
        let ways = vec![proto(&[(-60, 4), (-4, 4), (-4, 60)], 0, KIND_SIDEWALK)];
        let association = associate(&streets, &ways, MPU);
        let matched: Vec<u32> = association.runs[0]
            .iter()
            .filter_map(|run| run.matched.map(|found| found.street))
            .collect();
        assert_eq!(matched, vec![0, 1]);
    }

    #[test]
    fn a_crossing_takes_no_side_but_names_the_street_it_crosses() {
        let streets = vec![proto(&[(0, 0), (100, 0)], 40, KIND_SIDEWALK)];
        let ways = vec![proto(&[(50, -6), (50, 6)], 0, KIND_CROSSING)];
        let association = associate(&streets, &ways, MPU);
        assert!(association.runs[0][0].matched.is_none());
        assert_eq!(association.crossed[0], Some(0));
        assert!(association.covered[0].iter().all(Vec::is_empty));
    }
}
