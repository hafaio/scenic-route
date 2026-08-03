//! Whole-city properties of the finished walking network. Every check here is a pure function of
//! the edge view below, so each is unit-tested on a hand-built network and then run once, by
//! `graph::run`, over the real city — the same shape as the existence gate's two guards. DESIGN.md,
//! "What the whole city is held to", is why these are checked here rather than in a fixture, and how
//! each of their bounds in `graph.rs` was chosen.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

use crate::graph::{KIND_CROSSING, KIND_LINK, KIND_SIDEWALK, SIDE_EAST, SIDE_NORTH};

/// One finished edge, as the checks read it. `alley` and `demoted` come from the CSCL record the
/// edge was derived from: an alley is `rw_type` 10, and a demoted street is one the existence gate
/// found no pavement on and dropped to its centreline.
pub struct Edge {
    pub a: u32,
    pub b: u32,
    pub length: f32,
    pub kind: u8,
    pub side: u8,
    pub source_id: u32,
    pub osm: bool,
    pub alley: bool,
    pub demoted: bool,
    /// The compass bearing, in radians, of the first geometry step out of `a` and out of `b`.
    pub bearing_a: f64,
    pub bearing_b: f64,
}

/// The finished network: `node_count` nodes numbered `0..node_count`, joined by `edges`. The node
/// coordinates are the graph's own quantized units, with `meters_per_unit` converting them.
pub struct Walk<'a> {
    pub node_count: usize,
    pub node_x: &'a [i32],
    pub node_y: &'a [i32],
    pub meters_per_unit: (f64, f64),
    pub edges: &'a [Edge],
}

impl Walk<'_> {
    /// Which edges touch each node.
    fn incidence(&self) -> Vec<Vec<u32>> {
        let mut incidence = vec![Vec::new(); self.node_count];
        for (id, edge) in self.edges.iter().enumerate() {
            incidence[edge.a as usize].push(id as u32);
            if edge.b != edge.a {
                incidence[edge.b as usize].push(id as u32);
            }
        }
        incidence
    }
}

fn find(parent: &mut [u32], start: u32) -> u32 {
    let mut root = start;
    while parent[root as usize] != root {
        root = parent[root as usize];
    }
    let mut walk = start;
    while parent[walk as usize] != root {
        let next = parent[walk as usize];
        parent[walk as usize] = root;
        walk = next;
    }
    root
}

fn union(parent: &mut [u32], left: u32, right: u32) {
    let (left_root, right_root) = (find(parent, left), find(parent, right));
    if left_root != right_root {
        parent[left_root as usize] = right_root;
    }
}

/// The nearest-rank percentile of a sample, in the sample's own units. An empty sample has none.
fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (fraction * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// How much of the alley network hangs off the main body of the walking graph.
///
/// An alley is walkable in itself whether or not anything reaches it, so a break between an alley
/// and the pavement it opens off is invisible to every local check: the alley's own edges are all
/// present, all connected to each other, and all useless. The router answers a trip that ends on one
/// by silently snapping to the nearest street instead, so it is invisible from the app too.
pub struct AlleyReach {
    pub total_km: f64,
    pub off_component_km: f64,
}

/// The component holding the most walking kilometres, and every node's component root.
fn components(walk: &Walk) -> (u32, Vec<u32>) {
    let mut parent: Vec<u32> = (0..walk.node_count as u32).collect();
    for edge in walk.edges {
        union(&mut parent, edge.a, edge.b);
    }
    let roots: Vec<u32> = (0..walk.node_count as u32)
        .map(|node| find(&mut parent, node))
        .collect();
    let mut km: HashMap<u32, f64> = HashMap::new();
    for edge in walk.edges {
        *km.entry(roots[edge.a as usize]).or_insert(0.0) += f64::from(edge.length);
    }
    // Ties break on the lower root so the answer does not depend on the hash order.
    let main = km
        .into_iter()
        .max_by(|left, right| {
            left.1
                .partial_cmp(&right.1)
                .unwrap_or(Ordering::Equal)
                .then(right.0.cmp(&left.0))
        })
        .map_or(0, |(root, _)| root);
    (main, roots)
}

pub fn alley_reach(walk: &Walk) -> AlleyReach {
    let (main, roots) = components(walk);
    let mut reach = AlleyReach {
        total_km: 0.0,
        off_component_km: 0.0,
    };
    for edge in walk.edges.iter().filter(|edge| edge.alley) {
        let km = f64::from(edge.length) / 1000.0;
        reach.total_km += km;
        if roots[edge.a as usize] != main {
            reach.off_component_km += km;
        }
    }
    reach
}

/// How far an alley mouth has to walk to stand on mapped pavement.
///
/// A mouth is a node where the alley meets something that is not an alley. Reaching pavement is not
/// the same as being connected to it: a mouth that can only get to the sidewalk it is five metres
/// from by going round the block is connected, is reachable, and is wrong. The distance is measured
/// through the graph, so that detour is what it reports.
pub struct MouthWalk {
    pub mouths: usize,
    pub stranded: usize,
    pub median_meters: f64,
    pub p90_meters: f64,
}

pub fn alley_mouth_walk(walk: &Walk) -> MouthWalk {
    let incidence = walk.incidence();
    // Multi-source Dijkstra out of every node an OSM sidewalk touches, so each node learns its walk
    // to the nearest mapped pavement in one sweep.
    let mut distance = vec![f64::INFINITY; walk.node_count];
    let mut queue: BinaryHeap<(std::cmp::Reverse<u64>, u32)> = BinaryHeap::new();
    for edge in walk.edges {
        if edge.osm && edge.kind == KIND_SIDEWALK {
            for node in [edge.a, edge.b] {
                if distance[node as usize] != 0.0 {
                    distance[node as usize] = 0.0;
                    queue.push((std::cmp::Reverse(0), node));
                }
            }
        }
    }
    while let Some((std::cmp::Reverse(key), node)) = queue.pop() {
        let here = f64::from_bits(key);
        if here > distance[node as usize] {
            continue;
        }
        for &id in &incidence[node as usize] {
            let edge = &walk.edges[id as usize];
            let other = if edge.a == node { edge.b } else { edge.a };
            let through = here + f64::from(edge.length);
            if through < distance[other as usize] {
                distance[other as usize] = through;
                queue.push((std::cmp::Reverse(through.to_bits()), other));
            }
        }
    }

    let mut alleys = vec![false; walk.node_count];
    let mut others = vec![false; walk.node_count];
    for edge in walk.edges {
        let flag = if edge.alley { &mut alleys } else { &mut others };
        flag[edge.a as usize] = true;
        flag[edge.b as usize] = true;
    }
    let mut walks: Vec<f64> = Vec::new();
    let mut stranded = 0usize;
    for node in 0..walk.node_count {
        if alleys[node] && others[node] {
            if distance[node].is_finite() {
                walks.push(distance[node]);
            } else {
                stranded += 1;
            }
        }
    }
    walks.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
    MouthWalk {
        mouths: walks.len() + stranded,
        stranded,
        median_meters: percentile(&walks, 0.5),
        p90_meters: percentile(&walks, 0.9),
    }
}

/// Crossings that stop in the middle of the road. A marked crossing of a divided street is drawn as
/// two ways chained through the traffic island between them, so a build that loses the islands keeps
/// the two halves and joins neither: the walker steps off the kerb, reaches the median, and the
/// route ends there. The finished shape is a crossing whose far end has nothing else on it.
pub fn crossings_to_nowhere(walk: &Walk) -> usize {
    let incidence = walk.incidence();
    walk.edges
        .iter()
        .filter(|edge| edge.kind == KIND_CROSSING)
        .filter(|edge| {
            incidence[edge.a as usize].len() == 1 || incidence[edge.b as usize].len() == 1
        })
        .count()
}

/// Pavement on the side of a street that has none. `one_sided` holds the CSCL streets the existence
/// gate left pavement on exactly one side of; a phantom is one of those carrying sidewalk edges on
/// two opposing sides at once, which is the graph putting a walker on ground the road runs over.
///
/// The test is the pair of *opposite* labels rather than the label the gate chose, because a label
/// is taken from the chord of the edge that carries it: a street's two sides always face opposite
/// winds, but one side broken into pieces by the conflation drifts between neighbouring winds along
/// a bend. Opposition is the part of the label that means something here.
pub fn phantom_sidewalks(walk: &Walk, one_sided: &HashSet<u32>) -> usize {
    let mut sides: HashMap<u32, u8> = HashMap::new();
    for edge in walk.edges.iter().filter(|edge| edge.kind == KIND_SIDEWALK) {
        if one_sided.contains(&edge.source_id) {
            *sides.entry(edge.source_id).or_insert(0) |= 1 << edge.side;
        }
    }
    // The labels are 1 north, 2 east, 3 south, 4 west, so a wind and its opposite sit two apart.
    let opposed = |mask: u8, wind: u8| mask & (1 << wind) != 0 && mask & (1 << (wind + 2)) != 0;
    sides
        .values()
        .filter(|&&mask| opposed(mask, SIDE_NORTH) || opposed(mask, SIDE_EAST))
        .count()
}

/// The link edges' lengths: the stitches the graph draws where an entrance, a park path or a corner
/// has to reach the pavement beside it. The router spends one of these on the way into every plaza,
/// so a long one is a walker sent out to the roadway and back.
pub struct LinkLengths {
    pub links: usize,
    pub p99_meters: f64,
    pub longest_meters: f64,
}

pub fn link_lengths(walk: &Walk) -> LinkLengths {
    let mut lengths: Vec<f64> = walk
        .edges
        .iter()
        .filter(|edge| edge.kind == KIND_LINK)
        .map(|edge| f64::from(edge.length))
        .collect();
    lengths.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
    LinkLengths {
        links: lengths.len(),
        p99_meters: percentile(&lengths, 0.99),
        longest_meters: lengths.last().copied().unwrap_or(0.0),
    }
}

/// The worst neighbourhood's pavement, over a grid of `cell_meters` squares. Per cell this is the
/// share of its walking kilometres that are streets the gate found no pavement on — an ordinary
/// neighbourhood has few, and a neighbourhood nobody has mapped and whose survey went missing has
/// nothing but. Alleys are excluded: they are demoted on purpose. Cells under `floor_km` of walking
/// network are skipped, so a park edge or a strip of waterfront cannot be the worst cell.
pub struct PavementCells {
    pub cells: usize,
    pub p90_demoted_share: f64,
    pub p99_demoted_share: f64,
    pub worst_demoted_share: f64,
}

pub fn pavement_cells(walk: &Walk, cell_meters: f64, floor_km: f64) -> PavementCells {
    let (meters_per_unit_lng, meters_per_unit_lat) = walk.meters_per_unit;
    let mut totals: HashMap<(i32, i32), (f64, f64)> = HashMap::new();
    for edge in walk.edges {
        let cell = (
            (f64::from(walk.node_x[edge.a as usize]) * meters_per_unit_lng / cell_meters).floor()
                as i32,
            (f64::from(walk.node_y[edge.a as usize]) * meters_per_unit_lat / cell_meters).floor()
                as i32,
        );
        let entry = totals.entry(cell).or_insert((0.0, 0.0));
        entry.0 += f64::from(edge.length) / 1000.0;
        if edge.demoted && !edge.alley {
            entry.1 += f64::from(edge.length) / 1000.0;
        }
    }
    let mut scored: Vec<f64> = totals
        .values()
        .filter(|&&(total, _)| total >= floor_km)
        .map(|&(total, demoted)| demoted / total)
        .collect();
    scored.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
    PavementCells {
        cells: scored.len(),
        p90_demoted_share: percentile(&scored, 0.9),
        p99_demoted_share: percentile(&scored, 0.99),
        worst_demoted_share: scored.last().copied().unwrap_or(0.0),
    }
}

/// Hand-offs that double back. Where a derived sidewalk meets a mapped one at a node with nothing
/// else on it, the two should carry on in roughly the same direction; a turn past a right angle is
/// either a sliver between two mappings of the same pavement or the wrap round the head of a
/// cul-de-sac, which is correct topology that merely draws as a hairpin. The two are not
/// distinguishable here, so this is a count to watch rather than a property to hold.
pub fn seam_hairpins(walk: &Walk) -> usize {
    let incidence = walk.incidence();
    (0..walk.node_count)
        .filter(|&node| {
            let incident = &incidence[node];
            if incident.len() != 2 {
                return false;
            }
            let (left, right) = (
                &walk.edges[incident[0] as usize],
                &walk.edges[incident[1] as usize],
            );
            if left.kind != KIND_SIDEWALK || right.kind != KIND_SIDEWALK || left.osm == right.osm {
                return false;
            }
            let leaving = |edge: &Edge| {
                if edge.a == node as u32 {
                    edge.bearing_a
                } else {
                    edge.bearing_b
                }
            };
            // Both bearings point away from the shared node, so a straight-through hand-off has them
            // opposed — a separation of half a turn. A hairpin is the two leaving within a right
            // angle of each other, which is the walker turning back the way they came.
            let gap = (leaving(left) - leaving(right)).rem_euclid(std::f64::consts::TAU);
            let separation = gap.min(std::f64::consts::TAU - gap);
            separation < std::f64::consts::FRAC_PI_2
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{KIND_PATH, SIDE_SOUTH};

    /// One edge of a hand-built network, straight between its two nodes and 10 m long unless said
    /// otherwise. The bearings are the straight line's, so a hand-off between two of these bends by
    /// whatever the geometry bends by.
    fn edge(a: u32, b: u32) -> Edge {
        Edge {
            a,
            b,
            length: 10.0,
            kind: KIND_SIDEWALK,
            side: 0,
            source_id: NO_SOURCE,
            osm: false,
            alley: false,
            demoted: false,
            bearing_a: 0.0,
            bearing_b: std::f64::consts::PI,
        }
    }

    const NO_SOURCE: u32 = 0xFFFF_FFFF;

    /// A network over `node_count` nodes, all at the origin: the checks that read coordinates say so.
    fn walk<'a>(node_count: usize, zeros: &'a [i32], edges: &'a [Edge]) -> Walk<'a> {
        Walk {
            node_count,
            node_x: zeros,
            node_y: zeros,
            meters_per_unit: (1.0, 1.0),
            edges,
        }
    }

    #[test]
    fn an_alley_nothing_reaches_is_off_the_component_it_should_be_on() {
        let zeros = [0i32; 5];
        // The city's own shape: a street's two sidewalks (0-1-2) with an alley (3-4) behind the
        // block. The alley's mouth stands on the street's centreline with no node cut there, so
        // nothing joins the two — which is exactly what the graph did before the mouths were noded,
        // over 264 of 302 km of alley.
        let mut edges = vec![edge(0, 1), edge(1, 2), edge(3, 4)];
        edges[2].alley = true;
        edges[2].kind = KIND_PATH;
        let stranded = alley_reach(&walk(5, &zeros, &edges));
        assert_eq!(stranded.total_km, 0.01);
        assert_eq!(stranded.off_component_km, 0.01);

        // Cut the street at the mouth and the alley is on the network with everything else.
        edges.push(edge(1, 3));
        let noded = alley_reach(&walk(5, &zeros, &edges));
        assert_eq!(noded.total_km, 0.01);
        assert_eq!(noded.off_component_km, 0.0);
    }

    #[test]
    fn an_alley_mouth_walks_to_the_pavement_it_can_reach_not_the_one_it_faces() {
        let zeros = [0i32; 6];
        // The alley 0-3, whose mouth is node 3, standing beside the middle of one unbroken mapped
        // sidewalk way 1-2 whose only nodes are at the far ends of the block. Nothing binds the two,
        // so the mouth's only route onto that pavement is round the block, 3-4-5-1.
        let mut edges = vec![edge(0, 3), edge(3, 4), edge(4, 5), edge(5, 1), edge(1, 2)];
        edges[4].osm = true;
        edges[0].alley = true;
        edges[0].kind = KIND_PATH;
        let round_the_block = alley_mouth_walk(&walk(6, &zeros, &edges));
        assert_eq!(round_the_block.mouths, 1);
        assert_eq!(round_the_block.median_meters, 30.0);

        // The kerb cut: the way is cut where the mouth stands beside it, and the mouth binds to the
        // cut. The two halves keep the way's mapped provenance, so the walk is nothing at all.
        let mut cut = vec![
            edge(0, 3),
            edge(3, 4),
            edge(4, 5),
            edge(5, 1),
            edge(1, 3),
            edge(3, 2),
        ];
        cut[4].osm = true;
        cut[5].osm = true;
        cut[0].alley = true;
        cut[0].kind = KIND_PATH;
        let bound = alley_mouth_walk(&walk(6, &zeros, &cut));
        assert_eq!(bound.mouths, 1);
        assert_eq!(bound.median_meters, 0.0);
    }

    #[test]
    fn a_mouth_with_no_mapped_pavement_in_its_component_is_stranded_rather_than_near() {
        let zeros = [0i32; 3];
        let mut edges = vec![edge(0, 1), edge(1, 2)];
        edges[0].alley = true;
        let stranded = alley_mouth_walk(&walk(3, &zeros, &edges));
        assert_eq!(stranded.mouths, 1);
        assert_eq!(stranded.stranded, 1);
    }

    #[test]
    fn a_crossing_chained_through_its_island_is_whole_and_one_cut_in_half_is_not() {
        let zeros = [0i32; 6];
        // Kerb 0, island 2-3, kerb 1: the crossing is three edges and both ends stand on pavement.
        let mut whole = vec![edge(4, 0), edge(0, 2), edge(2, 3), edge(3, 1), edge(1, 5)];
        for crossing in &mut whole[1..4] {
            crossing.kind = KIND_CROSSING;
        }
        assert_eq!(crossings_to_nowhere(&walk(6, &zeros, &whole)), 0);

        // The island dropped: the two halves reach the median and stop there.
        let mut halved = vec![edge(4, 0), edge(0, 2), edge(3, 1), edge(1, 5)];
        halved[1].kind = KIND_CROSSING;
        halved[2].kind = KIND_CROSSING;
        assert_eq!(crossings_to_nowhere(&walk(6, &zeros, &halved)), 2);
    }

    #[test]
    fn a_one_sided_street_with_pavement_on_the_far_side_too_is_a_phantom() {
        let zeros = [0i32; 4];
        let one_sided: HashSet<u32> = [7u32].into_iter().collect();
        // The side the gate kept, broken into two pieces by a bend, so the label drifts from north
        // to east. Drift is not a phantom: the pieces are the same pavement.
        let mut drifted = vec![edge(0, 1), edge(1, 2)];
        for piece in &mut drifted {
            piece.source_id = 7;
        }
        drifted[0].side = SIDE_NORTH;
        drifted[1].side = SIDE_EAST;
        assert_eq!(phantom_sidewalks(&walk(4, &zeros, &drifted), &one_sided), 0);

        // Pavement facing the opposite wind is the other side of the street, which this street does
        // not have.
        let mut both = drifted;
        both.push(edge(2, 3));
        both[2].source_id = 7;
        both[2].side = SIDE_SOUTH;
        assert_eq!(phantom_sidewalks(&walk(4, &zeros, &both), &one_sided), 1);
    }

    #[test]
    fn the_link_lengths_are_the_links_own_and_nothing_elses() {
        let zeros = [0i32; 4];
        let mut edges = vec![edge(0, 1), edge(1, 2), edge(2, 3)];
        edges[0].kind = KIND_LINK;
        edges[1].kind = KIND_LINK;
        edges[1].length = 50.0;
        edges[2].length = 900.0;
        // The 900 m sidewalk is not a link however long it is, so neither statistic sees it.
        let lengths = link_lengths(&walk(4, &zeros, &edges));
        assert_eq!(lengths.longest_meters, 50.0);
        assert_eq!(lengths.p99_meters, 50.0);
    }

    #[test]
    fn a_neighbourhood_of_streets_with_no_pavement_is_its_own_cell() {
        // Two cells a kilometre apart in x: an ordinary one at the origin and one whose streets the
        // gate found no pavement on at all. The cell scores the share of its walking kilometres that
        // are demoted street, so the bad cell reads 1 and the good one 0.
        let node_x = [0i32, 0, 2000, 2000];
        let node_y = [0i32; 4];
        let mut edges = vec![edge(0, 1), edge(2, 3)];
        edges[0].length = 3000.0;
        edges[1].length = 3000.0;
        edges[1].demoted = true;
        edges[1].kind = KIND_PATH;
        let cells = pavement_cells(
            &Walk {
                node_count: 4,
                node_x: &node_x,
                node_y: &node_y,
                meters_per_unit: (1.0, 1.0),
                edges: &edges,
            },
            500.0,
            2.0,
        );
        assert_eq!(cells.cells, 2);
        assert_eq!(cells.worst_demoted_share, 1.0);
        assert_eq!(cells.p90_demoted_share, 1.0);

        // An alley is demoted on purpose and is not a neighbourhood without pavement.
        edges[1].alley = true;
        let alleys = pavement_cells(
            &Walk {
                node_count: 4,
                node_x: &node_x,
                node_y: &node_y,
                meters_per_unit: (1.0, 1.0),
                edges: &edges,
            },
            500.0,
            2.0,
        );
        assert_eq!(alleys.worst_demoted_share, 0.0);
    }

    #[test]
    fn a_hand_off_that_doubles_back_is_a_hairpin_and_one_that_carries_on_is_not() {
        let zeros = [0i32; 3];
        // A derived sidewalk arriving at node 1 heading east, and a mapped one leaving it heading
        // east: the two bearings out of the shared node are opposed, which is straight through.
        let mut straight = vec![edge(0, 1), edge(1, 2)];
        straight[0].bearing_b = std::f64::consts::PI; // 0 -> 1 runs east, so it leaves 1 westward
        straight[1].bearing_a = 0.0;
        straight[1].osm = true;
        assert_eq!(seam_hairpins(&walk(3, &zeros, &straight)), 0);

        // The same hand-off with the mapped side doubling back the way the derived one came.
        let mut hairpin = straight;
        hairpin[1].bearing_a = std::f64::consts::PI;
        assert_eq!(seam_hairpins(&walk(3, &zeros, &hairpin)), 1);
    }
}
