//! `tiler shade`: rasterizes building shadows from data/buildings/<id>.bin — footprints with roof
//! heights, magic BLDG — into one lossless WebP tile pyramid per time-of-day bucket at
//! <tiles>/shade/<bucket>/{z}/{x}/{y}.webp, with a physically-modelled penumbra. A bucket carries
//! several sun-disk samples; each building casts one shadow hull per sample, and a pixel's fill is
//! the fraction of samples that reach it — umbra where all do, penumbra where some do. Mirrors
//! `tiler canopy`'s rasterize/coverage/paint shape. See scripts/README.md.
//!
//! The canopy casts a SECOND pyramid, <tiles>/tree-shade/<bucket>/{z}/{x}/{y}.webp, from the crown
//! heights in data/canopy/<id>.bin. Both pyramids are pure geometry at the same alpha scale, so the
//! client composites them into the one shade layer, folding in how much light a canopy actually stops
//! — which is seasonal, and so cannot be baked.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::Fallible;
use crate::binfmt::{self, Coord, Polygon};
use crate::geometry::{self, METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet, round_half_up};
use crate::manifest::{Bounds, City, Manifest};
use crate::raster::{
    MIN_ALPHA, TILE_SIZE, Tile, encode_webp_lossless, lat_to_pixel_y, lng_to_pixel_x,
    pixel_x_to_lng, pixel_y_to_lat, plan_tiles,
};

// The alpha — the one channel that varies — is quantised to this step before encoding, which keeps
// the deep z15 level (two thirds of the pyramid) inside the deploy's size budget at ~3% opacity
// granularity, fine enough to stay invisible. The lattice is coarser than the step alone implies:
// MAX_SHADE_ALPHA and the bin's intensity cap it well below 255, so 23 distinct values exist across
// the whole pyramid and a typical tile holds 13 — a low-sun bin only 2.
const SHADE_ALPHA_STEP: u16 = 8;

// Shadow edges are hard, so the fill is antialiased by rasterizing each sample at 4x and averaging
// the block back down — a pixel half inside a hull reads 0.5. Same pattern as canopy.
const SUPERSAMPLE: usize = 4;
const SHADE_RGB: [u8; 3] = [51, 65, 85]; // a cool slate; the shadow's only colour
// Umbra opacity at full solar intensity (a zenith sun, never reached at NYC's latitude). The shaded
// fraction AND the bucket's intensity scale down from here, so a low sun's long shadows read faint.
const MAX_SHADE_ALPHA: f64 = 190.0;

pub struct Args {
    pub manifest: PathBuf,
    pub data: PathBuf,
    pub tiles: PathBuf,
    pub params: PathBuf,
}

/// One sun-disk sample of the area light: a ground unit vector pointing down the shadow (anti-sun)
/// and the shadow length per unit of roof height, `1/tan(sunElevation)`. Precomputed by suncalc.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    east: f64,  // east component of the anti-sun ground direction
    north: f64, // north component
    shadow_per_height: f64,
}

/// One bin of the (declination, hourAngle) grid: its season/hour keys (echoed to the client so it can
/// map "now" to a bin), the representative sun position, and the sun-disk samples whose shadows
/// accumulate into its penumbra.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bucket {
    season: usize,   // the declination band this bin sits in — its season key
    hour_angle: f64, // the sun's hour angle (degrees, 0 at solar noon) — its time-of-day key
    elevation: f64, // the bin's representative sun position, echoed to the client's schedule alongside
    azimuth: f64,   // season/hourAngle; the geometry itself rides in `samples` and `intensity`
    intensity: f64, // solar intensity ~sin(elevation); scales the whole bin's shade darkness
    samples: Vec<Sample>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Params {
    max_zoom: u32,
    pub max_shadow_meters: f64, // a shadow is clipped to this, so a lone tower does not streak the city
    pub buckets: Vec<Bucket>,
}

/// The client's schedule: which bin index stands for which grid cell (season, hourAngle) and sun
/// position. The client selects on season/hourAngle; the position is carried for labelling/debugging.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BucketEntry {
    index: usize,
    season: usize,
    hour_angle: f64,
    elevation: f64,
    azimuth: f64,
}

/// What throws a shadow: the building footprints and their roof heights in metres, and the canopy
/// polygons that carry a measured crown height with those heights (empty for a city with no canopy).
/// Shared by the display pyramid and the per-edge bake.
pub struct Casters {
    polygons: Vec<Polygon>,
    heights: Vec<f64>,
    crowns: Vec<Polygon>,
    crown_heights: Vec<f64>,
}

/// One city's casters plus what the tiles need on top of them: the footprints as a rasterizable set
/// and grid so each tile can punch the building bases back OUT of both shadows — only shade that
/// falls beyond a base is ground shade. Shadows fall on water too (a tower's shadow across a river is
/// worth seeing).
struct CityShade {
    casters: Casters,
    footprints: PolygonSet,
    footprint_grid: PolygonGrid,
}

/// One sample's shadow hulls for one city and bucket: the polygon set and its spatial grid, so a
/// tile gathers only the hulls it touches.
struct SampleSet {
    set: PolygonSet,
    grid: PolygonGrid,
}

/// One tile of one bucket, counted once for each pyramid it fed.
#[derive(Clone, Copy, Default)]
struct Stats {
    tiles: usize,
    painted: usize,
    bytes: usize,
    tree_painted: usize,
    tree_bytes: usize,
}

impl std::ops::Add for Stats {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self {
            tiles: self.tiles + other.tiles,
            painted: self.painted + other.painted,
            bytes: self.bytes + other.bytes,
            tree_painted: self.tree_painted + other.tree_painted,
            tree_bytes: self.tree_bytes + other.tree_bytes,
        }
    }
}

/// The crowns a canopy file carries and their heights. A height of 0 is the file's unknown sentinel —
/// the height model saw no cell inside the polygon — so those polygons are dropped here rather than
/// cast as if they were flat.
fn read_crowns(path: &Path) -> Fallible<(Vec<Polygon>, Vec<f64>)> {
    let canopy = binfmt::read_canopy(path)?;
    let heights = canopy.heights_m();
    Ok(canopy
        .polygons
        .into_iter()
        .zip(heights)
        .filter(|(_, height)| *height > 0.0)
        .unzip())
}

/// The city's crowns, empty when it has no canopy layer or the file is missing.
fn city_crowns(city: &City, data: &Path) -> Fallible<(Vec<Polygon>, Vec<f64>)> {
    let Some(layer) = &city.field.canopy else {
        return Ok((Vec::new(), Vec::new()));
    };
    let path = data.join("canopy").join(&layer.file);
    if path.exists() {
        read_crowns(&path)
    } else {
        Ok((Vec::new(), Vec::new()))
    }
}

fn read_city_shade(city: &City, data: &Path) -> Fallible<Option<CityShade>> {
    let buildings = data.join("buildings").join(format!("{}.bin", city.id));
    if !buildings.exists() {
        return Ok(None);
    }
    let (polygons, heights) = binfmt::read_buildings(&buildings)?;
    let (crowns, crown_heights) = city_crowns(city, data)?;
    let footprints = geometry::flatten(&polygons);
    let footprint_grid = PolygonGrid::new(&footprints);
    Ok(Some(CityShade {
        casters: Casters {
            polygons,
            heights,
            crowns,
            crown_heights,
        },
        footprints,
        footprint_grid,
    }))
}

/// Andrew's monotone-chain convex hull of a point set, as a single counter-clockwise ring. Even-odd
/// fill ignores winding, so the orientation is only a convention. Fewer than three distinct points
/// have no area and return as-is (the caller drops them).
fn convex_hull(points: &[Coord]) -> Vec<Coord> {
    let mut sorted = points.to_vec();
    sorted.sort_by(|left, right| {
        left.lng
            .total_cmp(&right.lng)
            .then(left.lat.total_cmp(&right.lat))
    });
    sorted.dedup_by(|left, right| left.lng == right.lng && left.lat == right.lat);
    if sorted.len() < 3 {
        return sorted;
    }
    // > 0 is a left turn; popping on <= 0 keeps the hull strictly convex and drops collinear points.
    let cross = |origin: &Coord, first: &Coord, second: &Coord| {
        (first.lng - origin.lng) * (second.lat - origin.lat)
            - (first.lat - origin.lat) * (second.lng - origin.lng)
    };
    let mut hull: Vec<Coord> = Vec::with_capacity(sorted.len() + 1);
    for point in &sorted {
        while hull.len() >= 2 && cross(&hull[hull.len() - 2], &hull[hull.len() - 1], point) <= 0.0 {
            hull.pop();
        }
        hull.push(*point);
    }
    let lower = hull.len() + 1; // the upper hull may not pop below the last lower-hull vertex
    for point in sorted.iter().rev() {
        while hull.len() >= lower
            && cross(&hull[hull.len() - 2], &hull[hull.len() - 1], point) <= 0.0
        {
            hull.pop();
        }
        hull.push(*point);
    }
    hull.pop(); // the first point closes both chains
    hull
}

// A footprint whose convex hull over-fills it by less than this (m²) is swept as that single hull:
// the over-fill is well under a pixel at the finest zoom, and one polygon keeps the spatial grid
// small. Only a genuine concavity above this — a courtyard, an L-block — is swept exactly, since the
// exact sweep costs a polygon per edge, and a low sun stretches each into a long grid-heavy sliver.
const MIN_CONCAVITY_M2: f64 = 200.0;

/// Twice the area a ring encloses, by the shoelace sum, unsigned so either winding works. Used only
/// to weigh a footprint against its convex hull.
fn double_area(ring: &[Coord]) -> f64 {
    let mut sum = 0.0;
    let mut previous = ring.len() - 1;
    for current in 0..ring.len() {
        sum += (ring[previous].lng - ring[current].lng) * (ring[previous].lat + ring[current].lat);
        previous = current;
    }
    sum.abs()
}

/// Append the shadow one building casts for one sample to `out`: the footprint's outer ring swept
/// down the shadow by `min(max_shadow, height * shadowPerHeight)` metres. A ring that its convex hull
/// barely over-fills (a rectangle, a small notch) is swept as the single convex hull of the ring and
/// its translate — exact for a convex ring, sub-pixel-close otherwise, and one cheap polygon. A real
/// concavity is instead swept EXACTLY as the Minkowski sum of the ring with that displacement — the
/// union of the ring, its translate, and one parallelogram per edge, which the rasteriser composites
/// for free since it unions the polygons it fills — so its notch is left unshaded rather than filled
/// in. Nothing is appended when the building has no footprint or casts nothing (zero height or a sun
/// at the zenith).
fn append_shadow(
    footprint: &Polygon,
    height: f64,
    sample: &Sample,
    max_shadow_meters: f64,
    out: &mut Vec<Polygon>,
) {
    let Some(outer) = footprint.first() else {
        return;
    };
    if outer.len() < 3 || height <= 0.0 {
        return;
    }
    let distance = (height * sample.shadow_per_height).min(max_shadow_meters);
    if distance <= 0.0 {
        return;
    }
    // The east-west scale at the footprint's latitude; city-scale, so its first vertex stands in.
    let meters_per_lng = METERS_PER_DEGREE_LAT * outer[0].lat.to_radians().cos();
    let d_lng = distance * sample.east / meters_per_lng;
    let d_lat = distance * sample.north / METERS_PER_DEGREE_LAT;
    let shift = |vertex: &Coord| Coord {
        lng: vertex.lng + d_lng,
        lat: vertex.lat + d_lat,
    };

    let footprint_hull = convex_hull(outer);
    let concavity_m2 = 0.5
        * (double_area(&footprint_hull) - double_area(outer))
        * METERS_PER_DEGREE_LAT
        * meters_per_lng;
    if concavity_m2 < MIN_CONCAVITY_M2 {
        let mut points: Vec<Coord> = Vec::with_capacity(outer.len() * 2);
        for vertex in outer {
            points.push(*vertex);
            points.push(shift(vertex));
        }
        let hull = convex_hull(&points);
        if hull.len() >= 3 {
            out.push(vec![hull]);
        }
        return;
    }

    out.push(vec![outer.clone()]);
    out.push(vec![outer.iter().map(shift).collect()]);
    for pair in outer.windows(2) {
        out.push(vec![vec![
            pair[0],
            pair[1],
            shift(&pair[1]),
            shift(&pair[0]),
        ]]);
    }
    // `windows` omits the closing edge when the ring is not explicitly closed; sweep it too.
    if let (Some(first), Some(last)) = (outer.first(), outer.last())
        && (first.lng != last.lng || first.lat != last.lat)
    {
        out.push(vec![vec![*last, *first, shift(first), shift(last)]]);
    }
}

/// The share of a crown polygon's height its silhouette is cast from. The outline is the crown's
/// WIDEST cross-section, and on the half-ellipsoid, ovoid and spherical crowns urban broadleaves take
/// (Forests 13(5) 748, 2022) that sits at or near the crown BASE — so casting from the polygon's own
/// height models the crown as a flat sheet at the very top of the tree and throws the shadow about a
/// crown radius too far, far enough at a low sun to detach it from its tree.
///
/// 0.4 is an ASSUMPTION, not a measurement. It is anchored on crown ratio (crown length over tree
/// height), 0.39-0.60 for hardwoods across ~7000 trees in Russell & Weiskittel 2011, "Maximum and
/// Largest Crown Width Equations for 15 Tree Species in Maine", Table 1 — which puts the crown base
/// near 0.4h. The parameter this actually wants is height to largest crown width, a standard forestry
/// quantity (Hann 1999, Forest Science 45(2) 217-225, splits the crown profile at exactly this
/// point), but no published HLCW fraction for urban broadleaves could be found: the numeric work is
/// all conifer, whose conic crowns are widest at the base by construction and answer differently.
pub const CROWN_BASE_FRACTION: f64 = 0.4;

/// Append the shadow one crown casts for one sample to `out`: its ring TRANSLATED down the shadow by
/// `min(max_shadow, CROWN_BASE_FRACTION * height * shadowPerHeight)` metres. A crown floats in the
/// air, so unlike a building there is no wall connecting it to the ground and nothing to sweep — the
/// displaced ring alone is the shadow, which is both cheaper and more correct. Nothing is appended for
/// a crown of unknown height.
fn append_crown_shadow(
    crown: &Polygon,
    height: f64,
    sample: &Sample,
    max_shadow_meters: f64,
    out: &mut Vec<Polygon>,
) {
    let Some(outer) = crown.first() else {
        return;
    };
    if outer.len() < 3 || height <= 0.0 {
        return;
    }
    let distance = (CROWN_BASE_FRACTION * height * sample.shadow_per_height).min(max_shadow_meters);
    if distance <= 0.0 {
        return;
    }
    let meters_per_lng = METERS_PER_DEGREE_LAT * outer[0].lat.to_radians().cos();
    let d_lng = distance * sample.east / meters_per_lng;
    let d_lat = distance * sample.north / METERS_PER_DEGREE_LAT;
    out.push(vec![
        outer
            .iter()
            .map(|vertex| Coord {
                lng: vertex.lng + d_lng,
                lat: vertex.lat + d_lat,
            })
            .collect(),
    ]);
}

/// Every building's shadow for one sun-disk sample — each footprint that casts anything, swept.
/// Around ~867k footprints per sample (a convex one is a single polygon, a concave one a few more).
/// Shared by the display pyramid and the per-edge bake so the shadow model has one implementation.
fn hulls_for_sample(
    polygons: &[Polygon],
    heights: &[f64],
    sample: &Sample,
    max_shadow_meters: f64,
) -> Vec<Polygon> {
    let mut hulls: Vec<Polygon> = Vec::with_capacity(polygons.len());
    for (footprint, height) in polygons.iter().zip(heights) {
        append_shadow(footprint, *height, sample, max_shadow_meters, &mut hulls);
    }
    hulls
}

/// Every measured crown's shadow for one sun-disk sample — each crown's ring, translated. The crown
/// mirror of `hulls_for_sample`, shared by the display pyramid and the per-edge bake.
fn crown_hulls_for_sample(
    crowns: &[Polygon],
    heights: &[f64],
    sample: &Sample,
    max_shadow_meters: f64,
) -> Vec<Polygon> {
    let mut hulls: Vec<Polygon> = Vec::with_capacity(crowns.len());
    for (crown, height) in crowns.iter().zip(heights) {
        append_crown_shadow(crown, *height, sample, max_shadow_meters, &mut hulls);
    }
    hulls
}

/// Every building's shadow hull for one bucket, one sample set per sun-disk sample. ~867k hulls
/// per sample; built fresh per bucket, which the loop keeps to one bucket alive at a time.
fn build_sample_sets(shade: &CityShade, bucket: &Bucket, max_shadow_meters: f64) -> Vec<SampleSet> {
    bucket
        .samples
        .iter()
        .map(|sample| {
            let hulls = hulls_for_sample(
                &shade.casters.polygons,
                &shade.casters.heights,
                sample,
                max_shadow_meters,
            );
            let set = geometry::flatten(&hulls);
            let grid = PolygonGrid::new(&set);
            SampleSet { set, grid }
        })
        .collect()
}

/// Every measured crown's shadow for one bucket, from the CENTRE sun-disk sample alone: at z15 a 10 m
/// crown's penumbra is ~5 cm against a ~3.6 m pixel, so the ring samples would paint the same picture
/// six times over. None when the city has no measured crown.
fn build_crown_set(
    shade: &CityShade,
    bucket: &Bucket,
    max_shadow_meters: f64,
) -> Option<SampleSet> {
    let sample = bucket.samples.first()?;
    if shade.casters.crowns.is_empty() {
        return None;
    }
    let hulls = crown_hulls_for_sample(
        &shade.casters.crowns,
        &shade.casters.crown_heights,
        sample,
        max_shadow_meters,
    );
    let set = geometry::flatten(&hulls);
    drop(hulls); // the flattened copy is the one the tiles read; ~25 M vertices is worth not doubling
    let grid = PolygonGrid::new(&set);
    Some(SampleSet { set, grid })
}

/// One tile's supersampled rasterizer: the lng/lat window the tile covers, the projection into its
/// supersampled grid, and the scratch a fill reuses. Every plane the tile needs — each sun-disk
/// sample's shadow, the crown shadows, the footprint punch-out — goes through `accumulate`.
struct TileRaster {
    clip: Bounds,
    zoom: u32,
    origin_x: f64,
    origin_y: f64,
    mask: Vec<u8>,
    candidates: Vec<u32>,
}

impl TileRaster {
    fn new(tile: &Tile) -> Self {
        let zoom = tile.zoom;
        let origin_x = f64::from(tile.x) * TILE_SIZE as f64;
        let origin_y = f64::from(tile.y) * TILE_SIZE as f64;
        let width = TILE_SIZE * SUPERSAMPLE;
        Self {
            // Each hull already extends to where its shadow lands, so the tile's own lng/lat bounds
            // gather every hull that can touch it — no reach halo, unlike the blurred canopy fill.
            clip: Bounds {
                west: pixel_x_to_lng(origin_x, zoom),
                east: pixel_x_to_lng(origin_x + TILE_SIZE as f64, zoom),
                north: pixel_y_to_lat(origin_y, zoom),
                south: pixel_y_to_lat(origin_y + TILE_SIZE as f64, zoom),
            },
            zoom,
            origin_x,
            origin_y,
            mask: vec![0u8; width * width],
            candidates: Vec::new(),
        }
    }

    /// Add the fraction of each pixel that the set's candidate polygons cover into `target`, by
    /// rasterizing them supersampled and averaging the block back down — a pixel half inside a hull
    /// reads 0.5. False when nothing reached the tile, so the caller can skip it.
    fn accumulate(&mut self, set: &PolygonSet, grid: &PolygonGrid, target: &mut [f32]) -> bool {
        grid.candidates(&self.clip, &mut self.candidates);
        if self.candidates.is_empty() {
            return false;
        }
        self.mask.iter_mut().for_each(|cell| *cell = 0);
        let scale = SUPERSAMPLE as f64;
        let width = TILE_SIZE * SUPERSAMPLE;
        let (zoom, origin_x, origin_y) = (self.zoom, self.origin_x, self.origin_y);
        let drawn = geometry::fill_polygons_indexed(
            &mut self.mask,
            width,
            width,
            set,
            &self.candidates,
            &self.clip,
            |lng, lat| {
                (
                    (lng_to_pixel_x(lng, zoom) - origin_x) * scale,
                    (lat_to_pixel_y(lat, zoom) - origin_y) * scale,
                )
            },
        );
        if drawn == 0 {
            return false;
        }
        let subpixels = (SUPERSAMPLE * SUPERSAMPLE) as f32;
        for pixel_y in 0..TILE_SIZE {
            for pixel_x in 0..TILE_SIZE {
                let mut covered = 0u32;
                for sub_y in 0..SUPERSAMPLE {
                    let row = (pixel_y * SUPERSAMPLE + sub_y) * width + pixel_x * SUPERSAMPLE;
                    for sub_x in 0..SUPERSAMPLE {
                        covered += u32::from(self.mask[row + sub_x]);
                    }
                }
                target[pixel_y * TILE_SIZE + pixel_x] += covered as f32 / subpixels;
            }
        }
        true
    }
}

/// One tile's two shadow fractions, each None where nothing was cast onto it.
#[derive(Default)]
struct Coverage {
    buildings: Option<Vec<f32>>,
    trees: Option<Vec<f32>>,
}

/// Turn one accumulated plane into the shadow fraction the tile paints: averaged over the samples
/// that fed it, then punched by the building footprints. False when nothing survives.
fn resolve(plane: &mut [f32], samples: f32, base: &[f32]) -> bool {
    let mut painted = false;
    for (value, base) in plane.iter_mut().zip(base) {
        *value = (*value / samples) * (1.0 - base);
        painted |= *value > 0.0;
    }
    painted
}

/// The per-pixel building and tree shadow fractions over one tile. Each sun-disk sample's candidate
/// hulls are accumulated and the sum divided by the sample count, so a pixel every sample covers reads
/// 1 (umbra) and one only some reach reads partial (penumbra); the crowns cast from one sample, so
/// theirs is a plain fill. Both are then punched by the building footprints — shade landing on a roof
/// is not ground shade. The crowns are deliberately NOT punched out of their own shadow: the ground
/// under a tree is where you stand, and it is the shadiest place there is.
fn coverage(
    shade: &CityShade,
    samples: &[SampleSet],
    crowns: Option<&SampleSet>,
    tile: &Tile,
) -> Coverage {
    let mut raster = TileRaster::new(tile);

    let mut buildings = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    let mut any_buildings = false;
    for sample in samples {
        any_buildings |= raster.accumulate(&sample.set, &sample.grid, &mut buildings);
    }
    let mut trees = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    let any_trees =
        crowns.is_some_and(|crowns| raster.accumulate(&crowns.set, &crowns.grid, &mut trees));
    if !any_buildings && !any_trees {
        return Coverage::default();
    }

    let mut base = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    raster.accumulate(&shade.footprints, &shade.footprint_grid, &mut base);
    Coverage {
        buildings: (any_buildings && resolve(&mut buildings, samples.len() as f32, &base))
            .then_some(buildings),
        trees: (any_trees && resolve(&mut trees, 1.0, &base)).then_some(trees),
    }
}

/// Colour EVERY pixel the fixed slate, so the colour plane is one constant and only alpha carries
/// the tile, scaled from the shadow fraction and the bucket's solar intensity. A pixel whose alpha
/// rounds below MIN_ALPHA, where the fill is invisible, stays transparent. Writing the slate
/// unconditionally is byte-neutral — the lossless encoder zeroes RGB under transparent pixels
/// itself — and is done for the invariant, not to save anything.
fn paint(pixels: &mut [u8], fraction: &[f32], intensity: f64) -> bool {
    let mut painted = false;
    for (pixel, value) in fraction.iter().enumerate() {
        pixels[pixel * 4..pixel * 4 + 3].copy_from_slice(&SHADE_RGB);
        if *value <= 0.0 {
            continue;
        }
        let exact = round_half_up(f64::from(*value) * intensity * MAX_SHADE_ALPHA) as u16;
        let alpha =
            (((exact + SHADE_ALPHA_STEP / 2) / SHADE_ALPHA_STEP) * SHADE_ALPHA_STEP).min(255) as u8;
        if alpha < MIN_ALPHA {
            continue;
        }
        pixels[pixel * 4 + 3] = alpha;
        painted = true;
    }
    painted
}

fn write_tile(directory: &Path, tile: &Tile, pixels: &[u8]) -> Fallible<usize> {
    let encoded = encode_webp_lossless(pixels);
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.webp", tile.y)),
        &encoded,
    )?;
    Ok(encoded.len())
}

/// Everything one bucket's tiles are rendered from: the cities' casters, this bucket's shadow hulls,
/// its solar intensity, and where each pyramid's tiles go. `trees` is None for a city with no measured
/// crown, and `tree_dir` None when no city has any — then only the building pyramid is written.
struct BucketRender<'a> {
    cities: &'a [Option<CityShade>],
    buildings: Vec<Option<Vec<SampleSet>>>,
    trees: Vec<Option<SampleSet>>,
    intensity: f64,
    building_dir: PathBuf,
    tree_dir: Option<PathBuf>,
}

impl BucketRender<'_> {
    /// One tile of one bucket: accumulate every member city's shadows, and write each pyramid's WebP
    /// only if some pixel was painted — the client reads a 404 as fully transparent, so a blank tile
    /// is never written.
    fn render(&self, tile: &Tile) -> Fallible<Stats> {
        let mut building_pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
        let mut tree_pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
        let mut painted = false;
        let mut tree_painted = false;
        for member in &tile.members {
            if let (Some(shade), Some(samples)) = (&self.cities[*member], &self.buildings[*member])
            {
                let fractions = coverage(shade, samples, self.trees[*member].as_ref(), tile);
                if let Some(fraction) = fractions.buildings {
                    painted |= paint(&mut building_pixels, &fraction, self.intensity);
                }
                if let Some(fraction) = fractions.trees {
                    tree_painted |= paint(&mut tree_pixels, &fraction, self.intensity);
                }
            }
        }
        let bytes = if painted {
            write_tile(&self.building_dir, tile, &building_pixels)?
        } else {
            0
        };
        let tree_bytes = match &self.tree_dir {
            Some(directory) if tree_painted => write_tile(directory, tile, &tree_pixels)?,
            _ => 0,
        };
        Ok(Stats {
            tiles: 1,
            painted: usize::from(painted),
            bytes,
            tree_painted: usize::from(tree_bytes > 0),
            tree_bytes,
        })
    }
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    let params: Params = serde_json::from_slice(&fs::read(&args.params)?)?;

    let cities: Vec<Option<CityShade>> = manifest
        .cities
        .iter()
        .map(|city| read_city_shade(city, &args.data))
        .collect::<Fallible<Vec<Option<CityShade>>>>()?;
    if cities.iter().all(Option::is_none) {
        eprintln!("no city has a buildings layer; nothing to render");
        return Ok(());
    }
    for (city, shade) in manifest.cities.iter().zip(&cities) {
        if let Some(shade) = shade {
            eprintln!(
                "{}: {} building footprints, {} crowns with a measured height",
                city.id,
                shade.casters.polygons.len(),
                shade.casters.crowns.len()
            );
        }
    }

    let plan = plan_tiles(&manifest.cities, params.max_zoom);
    let shade_dir = args.tiles.join("shade");
    fs::create_dir_all(&shade_dir)?;
    // No canopy or no measured heights anywhere: the tree pyramid is simply not produced, and the
    // client's composite falls back to the building tiles alone.
    let tree_root = cities
        .iter()
        .flatten()
        .any(|shade| !shade.casters.crowns.is_empty())
        .then(|| args.tiles.join("tree-shade"));
    if let Some(root) = &tree_root {
        fs::create_dir_all(root)?;
    }

    let mut total = Stats::default();
    for (index, bucket) in params.buckets.iter().enumerate() {
        let building_dir = shade_dir.join(index.to_string());
        let tree_dir = tree_root.as_ref().map(|root| root.join(index.to_string()));
        for tile in &plan {
            for directory in [Some(&building_dir), tree_dir.as_ref()]
                .into_iter()
                .flatten()
            {
                fs::create_dir_all(
                    directory
                        .join(tile.zoom.to_string())
                        .join(tile.x.to_string()),
                )?;
            }
        }
        let render = BucketRender {
            cities: &cities,
            buildings: cities
                .iter()
                .map(|city| {
                    city.as_ref()
                        .map(|shade| build_sample_sets(shade, bucket, params.max_shadow_meters))
                })
                .collect(),
            trees: cities
                .iter()
                .map(|city| {
                    city.as_ref()
                        .and_then(|shade| build_crown_set(shade, bucket, params.max_shadow_meters))
                })
                .collect(),
            intensity: bucket.intensity,
            building_dir,
            tree_dir,
        };

        eprintln!(
            "bin {index} (el {:.0}° az {:.0}°): rendering {} tiles across {} threads",
            bucket.elevation,
            bucket.azimuth,
            plan.len(),
            rayon::current_num_threads()
        );
        let stats = plan
            .par_iter()
            .map(|tile| render.render(tile))
            .try_reduce(Stats::default, |left, right| Ok(left + right))?;
        eprintln!(
            "  wrote {} tiles ({} building painted, {:.1} MiB; {} tree painted, {:.1} MiB)",
            stats.tiles,
            stats.painted,
            stats.bytes as f64 / 1024.0 / 1024.0,
            stats.tree_painted,
            stats.tree_bytes as f64 / 1024.0 / 1024.0
        );
        total = total + stats;
    }

    let schedule: Vec<BucketEntry> = params
        .buckets
        .iter()
        .enumerate()
        .map(|(index, bucket)| BucketEntry {
            index,
            season: bucket.season,
            hour_angle: bucket.hour_angle,
            elevation: bucket.elevation,
            azimuth: bucket.azimuth,
        })
        .collect();
    fs::write(
        shade_dir.join("buckets.json"),
        serde_json::to_vec(&schedule)?,
    )?;

    eprintln!(
        "wrote {} shade tiles across {} buckets ({} building painted, {:.1} MiB; {} tree painted, {:.1} MiB) in {:.1}s",
        total.tiles,
        params.buckets.len(),
        total.painted,
        total.bytes as f64 / 1024.0 / 1024.0,
        total.tree_painted,
        total.tree_bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// One bin's grid cell and sun position, echoed into the SHDE artifact so the router maps "now" to a
/// bin the same way the tile pyramid's `buckets.json` does — on season/hourAngle, not raw position.
pub struct BinPosition {
    pub season: usize,
    pub hour_angle: f64,
    pub elevation: f64,
    pub azimuth: f64,
}

const SHADE_SAMPLE_METERS: f64 = 5.0; // spacing of the along-edge shade probes
const SHADE_CELL_METERS: f64 = 5.0; // the coverage grid's cell size; halved-ish would just add cost
const SHADE_COARSE_CELL_METERS: f64 = 8.0; // fallback cell for a bbox too large for a 5 m grid
const SHADE_CELL_BUDGET: usize = 128_000_000; // ~128 MB per bin grid before the coarser cell kicks in

/// A rasterized shadow-coverage grid for one bin over the edges' bounding box: `cells[r*cols+c]` is
/// nonzero where the bin's shadow hulls cover that ~`cell`-metre cell. A point maps to its cell the
/// same way `fill_polygons` places the hulls, so `shaded` reads the fill back in O(1); a point
/// outside the grid is sunlit (a shadow beyond the edge extent never touches a sample).
struct CoverageGrid {
    cells: Vec<u8>,
    cols: usize,
    rows: usize,
    west: f64,
    south: f64,
    meters_per_lng: f64,
    cell: f64,
}

impl CoverageGrid {
    fn shaded(&self, lng: f64, lat: f64) -> bool {
        let col = (lng - self.west) * self.meters_per_lng / self.cell;
        let row = (lat - self.south) * METERS_PER_DEGREE_LAT / self.cell;
        if col < 0.0 || row < 0.0 || col > self.cols as f64 || row > self.rows as f64 {
            false
        } else {
            // A probe on the east/north bbox edge lands exactly on cols/rows; fold it into the last
            // cell rather than reading out of bounds (every probe is an edge vertex inside the bbox).
            let col = (col as usize).min(self.cols - 1);
            let row = (row as usize).min(self.rows - 1);
            self.cells[row * self.cols + col] != 0
        }
    }
}

/// The fraction of an edge's polyline that lies in shadow: probe the endpoints and every
/// ~SHADE_SAMPLE_METERS along it, counting the probes over a shaded cell. `None` for an empty
/// polyline (a ferry or a degenerate edge), which the caller reads as no shade signal.
fn edge_shaded_fraction(poly: &[Coord], grid: &CoverageGrid) -> Option<f64> {
    if poly.is_empty() {
        return None;
    }
    let mut shaded = 0usize;
    let mut probes = 0usize;
    let mut probe = |lng: f64, lat: f64| {
        if grid.shaded(lng, lat) {
            shaded += 1;
        }
        probes += 1;
    };
    probe(poly[0].lng, poly[0].lat);
    for pair in poly.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        let meters_per_lng = METERS_PER_DEGREE_LAT * ((from.lat + to.lat) / 2.0).to_radians().cos();
        let east = (to.lng - from.lng) * meters_per_lng;
        let north = (to.lat - from.lat) * METERS_PER_DEGREE_LAT;
        let steps = (east.hypot(north) / SHADE_SAMPLE_METERS).ceil().max(1.0) as usize;
        for step in 1..=steps {
            let fraction = step as f64 / steps as f64;
            probe(
                from.lng + (to.lng - from.lng) * fraction,
                from.lat + (to.lat - from.lat) * fraction,
            );
        }
    }
    Some(shaded as f64 / probes as f64)
}

/// u8 encoding of a shadow fraction in [0, 1]: the client reads it back as `byte / 255`. Unsigned and
/// intensity-free on purpose — the bin's solar intensity and the season's canopy transmittance are
/// folded in by the client, which also does the signed encoding the cost model's `|attr| < 1`
/// invariant rides on, because neither is recoverable once baked.
fn encode_fraction(fraction: f64) -> u8 {
    round_half_up(fraction * 255.0).clamp(0.0, 255.0) as u8
}

/// The edges' bounding box in metres and the cell-grid it induces, computed once and shared across
/// bins (only the rasterized `cells` differ per bin). `None` when no edge carries geometry.
struct GridSpec {
    bounds: Bounds,
    cols: usize,
    rows: usize,
    west: f64,
    south: f64,
    meters_per_lng: f64,
    cell: f64,
}

fn grid_spec(edge_polys: &[Vec<Coord>]) -> Option<GridSpec> {
    let mut west = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    let mut south = f64::INFINITY;
    let mut north = f64::NEG_INFINITY;
    for poly in edge_polys {
        for point in poly {
            west = west.min(point.lng);
            east = east.max(point.lng);
            south = south.min(point.lat);
            north = north.max(point.lat);
        }
    }
    if !west.is_finite() {
        return None;
    }
    let mid_lat = (south + north) / 2.0;
    let meters_per_lng = METERS_PER_DEGREE_LAT * mid_lat.to_radians().cos();
    let width_m = (east - west) * meters_per_lng;
    let height_m = (north - south) * METERS_PER_DEGREE_LAT;
    // A 5 m cell unless the bbox is large enough that its grid would blow the memory budget, in which
    // case the coarser 8 m cell (~40% fewer cells) stands in.
    let fine_cols = (width_m / SHADE_CELL_METERS).ceil().max(1.0) as usize;
    let fine_rows = (height_m / SHADE_CELL_METERS).ceil().max(1.0) as usize;
    let cell = if fine_cols.saturating_mul(fine_rows) > SHADE_CELL_BUDGET {
        SHADE_COARSE_CELL_METERS
    } else {
        SHADE_CELL_METERS
    };
    let cols = (width_m / cell).ceil().max(1.0) as usize;
    let rows = (height_m / cell).ceil().max(1.0) as usize;
    Some(GridSpec {
        bounds: Bounds {
            west,
            east,
            south,
            north,
        },
        cols,
        rows,
        west,
        south,
        meters_per_lng,
        cell,
    })
}

/// The share of each edge's polyline that one set of shadow hulls covers, `encode_fraction`d.
///
/// The bin's ~867k hulls are rasterized once into a coverage grid (cost ~ shadow area), then each
/// edge probe is an O(1) grid read — versus a per-probe point-in-polygon test against the thousands
/// of overlapping hulls a low sun throws. The grid maps lng/lat to continuous cell coordinates
/// exactly as `CoverageGrid::shaded` reads them back.
fn edge_fractions(hulls: &[Polygon], spec: &GridSpec, edge_polys: &[Vec<Coord>]) -> Vec<u8> {
    let mut cells = vec![0u8; spec.cols * spec.rows];
    geometry::fill_polygons(
        &mut cells,
        spec.cols,
        spec.rows,
        &geometry::flatten(hulls),
        &spec.bounds,
        |lng, lat| {
            (
                (lng - spec.west) * spec.meters_per_lng / spec.cell,
                (lat - spec.south) * METERS_PER_DEGREE_LAT / spec.cell,
            )
        },
    );
    let grid = CoverageGrid {
        cells,
        cols: spec.cols,
        rows: spec.rows,
        west: spec.west,
        south: spec.south,
        meters_per_lng: spec.meters_per_lng,
        cell: spec.cell,
    };
    edge_polys
        .iter()
        .map(|poly| match edge_shaded_fraction(poly, &grid) {
            Some(fraction) => encode_fraction(fraction),
            None => 0,
        })
        .collect()
}

/// Per bin, per edge, the two unsigned occlusion fractions the client routes on: how much of the
/// edge's polyline the bin's BUILDING shadows cover, and how much its CROWN shadows do, both from the
/// bin's crisp centre sample (the ring samples give the tiles their penumbra; an edge is cleanly in
/// or out of shadow). Two row-major `[bin * edge_count + edge]` grids, buildings then trees. An edge
/// with no polyline — a ferry, whose cost never reads a shade attribute — reads 0 in both.
fn bake_edge_shade(
    casters: &Casters,
    bins: &[Bucket],
    max_shadow_meters: f64,
    edge_polys: &[Vec<Coord>],
) -> (Vec<u8>, Vec<u8>, Vec<BinPosition>) {
    let edge_count = edge_polys.len();
    let positions = bins
        .iter()
        .map(|bucket| BinPosition {
            season: bucket.season,
            hour_angle: bucket.hour_angle,
            elevation: bucket.elevation,
            azimuth: bucket.azimuth,
        })
        .collect();
    let Some(spec) = grid_spec(edge_polys) else {
        // No edge carries geometry (all ferries/empty): nothing occludes anything.
        let empty = vec![0u8; bins.len() * edge_count];
        return (empty.clone(), empty, positions);
    };

    let mut rows: Vec<(usize, Vec<u8>, Vec<u8>)> = bins
        .par_iter()
        .enumerate()
        .map(|(bin, bucket)| {
            let Some(sample) = bucket.samples.first() else {
                return (bin, vec![0u8; edge_count], vec![0u8; edge_count]);
            };
            // The two grids are built and read one at a time, so a bin holds only one of them (up to
            // SHADE_CELL_BUDGET bytes, once per rayon thread) alive at a time.
            let buildings = edge_fractions(
                &hulls_for_sample(
                    &casters.polygons,
                    &casters.heights,
                    sample,
                    max_shadow_meters,
                ),
                &spec,
                edge_polys,
            );
            let trees = if casters.crowns.is_empty() {
                vec![0u8; edge_count]
            } else {
                edge_fractions(
                    &crown_hulls_for_sample(
                        &casters.crowns,
                        &casters.crown_heights,
                        sample,
                        max_shadow_meters,
                    ),
                    &spec,
                    edge_polys,
                )
            };
            (bin, buildings, trees)
        })
        .collect();
    rows.sort_by_key(|(bin, _, _)| *bin);

    let mut building_bytes: Vec<u8> = Vec::with_capacity(bins.len() * edge_count);
    let mut tree_bytes: Vec<u8> = Vec::with_capacity(bins.len() * edge_count);
    for (_, buildings, trees) in rows {
        building_bytes.extend_from_slice(&buildings);
        tree_bytes.extend_from_slice(&trees);
    }
    (building_bytes, tree_bytes, positions)
}

/// The per-edge, per-bin shade routing fractions for one city: read the buildings and, when the city
/// has one, the canopy, then bake the two grids over `edge_polys` (each an edge's polyline in
/// DEGREES, in GRPH `v2_edges` order). A city with no canopy file, or none of whose crowns carries a
/// measured height, bakes all-zero tree fractions and routes on buildings alone. Returns the two
/// row-major byte grids and the bins' sun positions, all in bin order.
pub fn edge_shade_attrs(
    buildings_path: &Path,
    canopy_path: Option<&Path>,
    bins: &[Bucket],
    max_shadow_meters: f64,
    edge_polys: &[Vec<Coord>],
) -> Fallible<(Vec<u8>, Vec<u8>, Vec<BinPosition>)> {
    let (polygons, heights) = binfmt::read_buildings(buildings_path)?;
    let (crowns, crown_heights) = match canopy_path {
        Some(path) => read_crowns(path)?,
        None => (Vec::new(), Vec::new()),
    };
    Ok(bake_edge_shade(
        &Casters {
            polygons,
            heights,
            crowns,
            crown_heights,
        },
        bins,
        max_shadow_meters,
        edge_polys,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coord(lng: f64, lat: f64) -> Coord {
        Coord { lng, lat }
    }

    // A 100 m building near (-74, 40.7) and, 850 m east of it, a 10 m crown and a crown of unknown
    // height, against two bins whose centre sample throws a shadow due north at 5 m per metre: 500 m
    // for the building, 20 m for the crown (cast from its 4 m crown base, not its top), none for the
    // unknown one. Each edge sits under one caster (or neither), so the two fractions separate.
    #[test]
    fn bakes_building_and_crown_fractions() {
        let building: Polygon = vec![vec![
            coord(-74.0000, 40.7000),
            coord(-73.9999, 40.7000),
            coord(-73.9999, 40.7001),
            coord(-74.0000, 40.7001),
        ]];
        let heights = vec![100.0];
        let crown = |lng: f64| -> Polygon {
            vec![vec![
                coord(lng, 40.7000),
                coord(lng + 0.0002, 40.7000),
                coord(lng + 0.0002, 40.7002),
                coord(lng, 40.7002),
            ]]
        };
        let crowns = vec![crown(-73.9901), crown(-73.9801)];
        let crown_heights = vec![10.0, 0.0]; // 0 is the canopy file's unknown-height sentinel
        // The center sample throws a 500 m shadow due north (1 / tan folded into shadow_per_height).
        let north_shadow = || Sample {
            east: 0.0,
            north: 1.0,
            shadow_per_height: 5.0,
        };
        let bins = vec![
            Bucket {
                season: 0,
                hour_angle: -30.0,
                elevation: 30.0,
                azimuth: 180.0,
                intensity: 0.8,
                samples: vec![north_shadow()],
            },
            Bucket {
                season: 3,
                hour_angle: 0.0,
                elevation: 60.0,
                azimuth: 200.0,
                intensity: 1.0,
                samples: vec![north_shadow()],
            },
        ];
        let building_shaded = vec![coord(-73.99995, 40.7020), coord(-73.99993, 40.7021)];
        // Under the crown's translated ring (20 m north of it), and under where the unknown-height
        // crown's ring would land if it cast anything.
        let crown_shaded = vec![coord(-73.99000, 40.70025), coord(-73.98995, 40.70030)];
        let unknown_crown = vec![coord(-73.98000, 40.70025), coord(-73.97995, 40.70030)];
        let sunlit_edge = vec![coord(-73.99995, 40.6900), coord(-73.99993, 40.6901)];
        let ferry_edge: Vec<Coord> = Vec::new();
        let edge_polys = vec![
            building_shaded,
            crown_shaded,
            unknown_crown,
            sunlit_edge,
            ferry_edge,
        ];

        let casters = Casters {
            polygons: vec![building],
            heights,
            crowns,
            crown_heights,
        };
        let (buildings, trees, positions) = bake_edge_shade(&casters, &bins, 500.0, &edge_polys);

        assert_eq!(positions.len(), 2);
        let edge_count = edge_polys.len();
        assert_eq!(buildings.len(), bins.len() * edge_count);
        assert_eq!(trees.len(), bins.len() * edge_count);

        for bin in 0..bins.len() {
            let building_at = |edge: usize| buildings[bin * edge_count + edge];
            let tree_at = |edge: usize| trees[bin * edge_count + edge];
            assert_eq!(
                building_at(0),
                255,
                "the swept shadow covers the whole edge"
            );
            assert_eq!(tree_at(0), 0, "no crown is anywhere near it");
            assert_eq!(building_at(1), 0);
            assert_eq!(tree_at(1), 255, "the translated crown ring covers it");
            // A crown of unknown height casts nothing, so its edge is unoccluded by either caster.
            assert_eq!(building_at(2), 0);
            assert_eq!(tree_at(2), 0);
            assert_eq!(building_at(3), 0);
            assert_eq!(tree_at(3), 0);
            // The empty ferry polyline reads 0 in both, which the client never consults.
            assert_eq!(building_at(4), 0);
            assert_eq!(tree_at(4), 0);
        }
    }
}
