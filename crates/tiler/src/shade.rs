//! `tiler shade`: rasterizes building shadows from data/buildings/<id>.bin — footprints with roof
//! heights, magic BLDG — into one WebP tile pyramid per time-of-day bucket at
//! <tiles>/shade/<bucket>/{z}/{x}/{y}.webp, with a physically-modelled penumbra. A bucket carries
//! several sun-disk samples; each building casts one shadow hull per sample, and a pixel's fill is
//! the fraction of samples that reach it — umbra where all do, penumbra where some do. Mirrors
//! `tiler canopy`'s rasterize/coverage/paint shape. See scripts/README.md.

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
    MIN_ALPHA, TILE_SIZE, Tile, encode_webp, lat_to_pixel_y, lng_to_pixel_x, pixel_x_to_lng,
    pixel_y_to_lat, plan_tiles,
};

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

/// One time-of-day bucket: the local clock minute it stands for (for the client manifest) and the
/// sun-disk samples whose shadows accumulate into its penumbra.
#[derive(Deserialize)]
pub(crate) struct Bucket {
    elevation: f64, // the bin's representative sun position, echoed to the client's schedule so it can
    azimuth: f64,   // map "now" to a bin; the geometry itself rides in `samples` and `intensity`
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

/// The client's schedule: which bin index stands for which sun position.
#[derive(Serialize)]
struct BucketEntry {
    index: usize,
    elevation: f64,
    azimuth: f64,
}

/// One city's buildings, ready to cast: the footprints and their roof heights in metres (the shadow
/// casters), plus the footprints as a rasterizable set and grid so each tile can punch the building
/// bases back OUT of the shadow — only the shadow that falls beyond a base is kept. Shadows fall on
/// water too (a tower's shadow across a river is worth seeing). Built once, shared across every bucket.
struct CityShade {
    polygons: Vec<Polygon>,
    heights: Vec<f64>,
    footprints: PolygonSet,
    footprint_grid: PolygonGrid,
}

/// One sample's shadow hulls for one city and bucket: the polygon set and its spatial grid, so a
/// tile gathers only the hulls it touches.
struct SampleSet {
    set: PolygonSet,
    grid: PolygonGrid,
}

#[derive(Clone, Copy, Default)]
struct Stats {
    tiles: usize,
    painted: usize,
    bytes: usize,
}

impl std::ops::Add for Stats {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self {
            tiles: self.tiles + other.tiles,
            painted: self.painted + other.painted,
            bytes: self.bytes + other.bytes,
        }
    }
}

fn read_city_shade(city: &City, data: &Path) -> Fallible<Option<CityShade>> {
    let buildings = data.join("buildings").join(format!("{}.bin", city.id));
    if !buildings.exists() {
        return Ok(None);
    }
    let (polygons, heights) = binfmt::read_buildings(&buildings)?;
    let footprints = geometry::flatten(&polygons);
    let footprint_grid = PolygonGrid::new(&footprints);
    Ok(Some(CityShade {
        polygons,
        heights,
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

/// The shadow one building casts for one sample: the convex hull of the footprint's outer ring
/// together with that ring displaced down the shadow by `min(max_shadow, height * shadowPerHeight)`
/// metres. For a rectangular footprint the hull is the exact swept shadow; for an L it slightly
/// over-fills the concavity, which is acceptable. None when the building has no footprint or casts
/// nothing (zero height or a sun at the zenith).
fn shadow_hull(
    footprint: &Polygon,
    height: f64,
    sample: &Sample,
    max_shadow_meters: f64,
) -> Option<Polygon> {
    let outer = footprint.first()?;
    if outer.len() < 3 || height <= 0.0 {
        return None;
    }
    let distance = (height * sample.shadow_per_height).min(max_shadow_meters);
    if distance <= 0.0 {
        return None;
    }
    // The east-west scale at the footprint's latitude; city-scale, so its first vertex stands in.
    let meters_per_lng = METERS_PER_DEGREE_LAT * outer[0].lat.to_radians().cos();
    let d_lng = distance * sample.east / meters_per_lng;
    let d_lat = distance * sample.north / METERS_PER_DEGREE_LAT;
    let mut points: Vec<Coord> = Vec::with_capacity(outer.len() * 2);
    for vertex in outer {
        points.push(*vertex);
        points.push(Coord {
            lng: vertex.lng + d_lng,
            lat: vertex.lat + d_lat,
        });
    }
    let hull = convex_hull(&points);
    (hull.len() >= 3).then_some(vec![hull])
}

/// Every building's shadow hull for one bucket, one sample set per sun-disk sample. ~867k hulls
/// per sample; built fresh per bucket, which the loop keeps to one bucket alive at a time.
fn build_sample_sets(shade: &CityShade, bucket: &Bucket, max_shadow_meters: f64) -> Vec<SampleSet> {
    bucket
        .samples
        .iter()
        .map(|sample| {
            let hulls: Vec<Polygon> = shade
                .polygons
                .iter()
                .zip(&shade.heights)
                .filter_map(|(footprint, height)| {
                    shadow_hull(footprint, *height, sample, max_shadow_meters)
                })
                .collect();
            let set = geometry::flatten(&hulls);
            let grid = PolygonGrid::new(&set);
            SampleSet { set, grid }
        })
        .collect()
}

/// The per-pixel shadow fraction over one tile, or None where no sample reaches it. Each sample's
/// candidate hulls are rasterized supersampled and block-averaged into a covered fraction, summed
/// across samples, divided by the sample count, and clipped to land — a pixel every sample covers
/// reads 1 (umbra), some reads partial (penumbra), the supersample antialiasing each sample's edge.
fn coverage(shade: &CityShade, samples: &[SampleSet], tile: &Tile) -> Option<Vec<f32>> {
    let zoom = tile.zoom;
    let origin_x = f64::from(tile.x) * TILE_SIZE as f64;
    let origin_y = f64::from(tile.y) * TILE_SIZE as f64;
    // Each hull already extends to where its shadow lands, so the tile's own lng/lat bounds gather
    // every hull that can touch it — no reach halo, unlike the blurred canopy fill.
    let clip = Bounds {
        west: pixel_x_to_lng(origin_x, zoom),
        east: pixel_x_to_lng(origin_x + TILE_SIZE as f64, zoom),
        north: pixel_y_to_lat(origin_y, zoom),
        south: pixel_y_to_lat(origin_y + TILE_SIZE as f64, zoom),
    };

    let scale = SUPERSAMPLE as f64;
    let width = TILE_SIZE * SUPERSAMPLE;
    let subpixels = (SUPERSAMPLE * SUPERSAMPLE) as f32;
    let project = |lng: f64, lat: f64| {
        (
            (lng_to_pixel_x(lng, zoom) - origin_x) * scale,
            (lat_to_pixel_y(lat, zoom) - origin_y) * scale,
        )
    };
    // Average one supersampled mask down into a per-pixel covered fraction in `target`.
    let block_average = |mask: &[u8], target: &mut [f32]| {
        for pixel_y in 0..TILE_SIZE {
            for pixel_x in 0..TILE_SIZE {
                let mut covered = 0u32;
                for sub_y in 0..SUPERSAMPLE {
                    let row = (pixel_y * SUPERSAMPLE + sub_y) * width + pixel_x * SUPERSAMPLE;
                    for sub_x in 0..SUPERSAMPLE {
                        covered += u32::from(mask[row + sub_x]);
                    }
                }
                target[pixel_y * TILE_SIZE + pixel_x] += covered as f32 / subpixels;
            }
        }
    };

    let mut candidates: Vec<u32> = Vec::new();
    let mut mask = vec![0u8; width * width];

    // The shadow: every sample's candidate hulls, block-averaged and summed over the samples.
    let mut accum = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    let mut any = false;
    for sample in samples {
        sample.grid.candidates(&clip, &mut candidates);
        if candidates.is_empty() {
            continue;
        }
        mask.iter_mut().for_each(|cell| *cell = 0);
        let drawn = geometry::fill_polygons_indexed(
            &mut mask,
            width,
            width,
            &sample.set,
            &candidates,
            &clip,
            project,
        );
        if drawn == 0 {
            continue;
        }
        any = true;
        block_average(&mask, &mut accum);
    }
    if !any {
        return None;
    }

    // The building bases, punched OUT of the shadow: rasterize the footprints and keep only the shadow
    // beyond them, so the overwhelming shade sitting on the footprints themselves goes.
    let mut base = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    shade.footprint_grid.candidates(&clip, &mut candidates);
    if !candidates.is_empty() {
        mask.iter_mut().for_each(|cell| *cell = 0);
        let drawn = geometry::fill_polygons_indexed(
            &mut mask,
            width,
            width,
            &shade.footprints,
            &candidates,
            &clip,
            project,
        );
        if drawn > 0 {
            block_average(&mask, &mut base);
        }
    }

    let denominator = samples.len() as f32;
    let mut fraction = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    let mut painted = false;
    for pixel in 0..TILE_SIZE * TILE_SIZE {
        let value = (accum[pixel] / denominator) * (1.0 - base[pixel]);
        if value > 0.0 {
            fraction[pixel] = value;
            painted = true;
        }
    }
    painted.then_some(fraction)
}

/// Colour a tile's pixels the fixed slate, alpha scaled from the shadow fraction and the bucket's
/// solar intensity. Skips pixels whose alpha rounds below MIN_ALPHA, where the fill is invisible.
fn paint(pixels: &mut [u8], fraction: &[f32], intensity: f64) -> bool {
    let mut painted = false;
    for (pixel, value) in fraction.iter().enumerate() {
        if *value <= 0.0 {
            continue;
        }
        let alpha = round_half_up(f64::from(*value) * intensity * MAX_SHADE_ALPHA) as u8;
        if alpha < MIN_ALPHA {
            continue;
        }
        pixels[pixel * 4] = SHADE_RGB[0];
        pixels[pixel * 4 + 1] = SHADE_RGB[1];
        pixels[pixel * 4 + 2] = SHADE_RGB[2];
        pixels[pixel * 4 + 3] = alpha;
        painted = true;
    }
    painted
}

/// One tile of one bucket: accumulate every member city's shadow, and write the WebP only if some
/// pixel was painted — the client reads a 404 as fully transparent, so a blank tile is never written.
fn render(
    cities: &[Option<CityShade>],
    bucket_sets: &[Option<Vec<SampleSet>>],
    intensity: f64,
    directory: &Path,
    tile: &Tile,
) -> Fallible<Stats> {
    let mut pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut painted = false;
    for member in &tile.members {
        if let (Some(shade), Some(samples)) = (&cities[*member], &bucket_sets[*member])
            && let Some(fraction) = coverage(shade, samples, tile)
        {
            painted |= paint(&mut pixels, &fraction, intensity);
        }
    }
    if !painted {
        return Ok(Stats {
            tiles: 1,
            painted: 0,
            bytes: 0,
        });
    }
    let encoded = encode_webp(&pixels)?;
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.webp", tile.y)),
        &encoded,
    )?;
    Ok(Stats {
        tiles: 1,
        painted: 1,
        bytes: encoded.len(),
    })
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
            eprintln!("{}: {} building footprints", city.id, shade.polygons.len());
        }
    }

    let plan = plan_tiles(&manifest.cities, params.max_zoom);
    let shade_dir = args.tiles.join("shade");
    fs::create_dir_all(&shade_dir)?;

    let mut total = Stats::default();
    for (index, bucket) in params.buckets.iter().enumerate() {
        let bucket_dir = shade_dir.join(index.to_string());
        for tile in &plan {
            fs::create_dir_all(
                bucket_dir
                    .join(tile.zoom.to_string())
                    .join(tile.x.to_string()),
            )?;
        }
        let bucket_sets: Vec<Option<Vec<SampleSet>>> = cities
            .iter()
            .map(|city| {
                city.as_ref()
                    .map(|shade| build_sample_sets(shade, bucket, params.max_shadow_meters))
            })
            .collect();

        eprintln!(
            "bin {index} (el {:.0}° az {:.0}°): rendering {} tiles across {} threads",
            bucket.elevation,
            bucket.azimuth,
            plan.len(),
            rayon::current_num_threads()
        );
        let stats = plan
            .par_iter()
            .map(|tile| render(&cities, &bucket_sets, bucket.intensity, &bucket_dir, tile))
            .try_reduce(Stats::default, |left, right| Ok(left + right))?;
        eprintln!(
            "  wrote {} shade tiles ({} painted, {:.1} MiB)",
            stats.tiles,
            stats.painted,
            stats.bytes as f64 / 1024.0 / 1024.0
        );
        total = total + stats;
    }

    let schedule: Vec<BucketEntry> = params
        .buckets
        .iter()
        .enumerate()
        .map(|(index, bucket)| BucketEntry {
            index,
            elevation: bucket.elevation,
            azimuth: bucket.azimuth,
        })
        .collect();
    fs::write(
        shade_dir.join("buckets.json"),
        serde_json::to_vec(&schedule)?,
    )?;

    eprintln!(
        "wrote {} shade tiles across {} buckets ({} painted, {:.1} MiB) in {:.1}s",
        total.tiles,
        params.buckets.len(),
        total.painted,
        total.bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// One bin's sun position, echoed into the SHDE artifact so the client's schedule maps "now" to a
/// bin the same way the tile pyramid's `buckets.json` does.
pub struct BinPosition {
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

/// i8 encoding of a shade attribute in [-1, 1]: 0 is neutral, positive is sunnier. The magnitude is
/// capped at 127 (never -128), so the client's decoded `attr = byte / 128` has `|attr| <= 127/128 <
/// 1`, keeping its admissible `1 - w*attr` strictly positive for `|w| <= 1`.
fn encode_attr(attr: f64) -> i8 {
    round_half_up(attr * 128.0).clamp(-127.0, 127.0) as i8
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

/// Per bin, per edge, the shade attribute the client routes on: for the bin's crisp center-sample
/// shadow, `intensity * (1 - 2 * shadedFraction)` — sunlit edges positive, shaded negative, folded
/// by the bin's solar intensity — encoded as an i8. Row-major `[bin * edge_count + edge]`.
///
/// The bin's ~867k shadow hulls are rasterized once into a coverage grid (cost ~ shadow area), then
/// each edge sample is an O(1) grid read — versus a per-sample point-in-polygon test against the
/// thousands of overlapping hulls a low sun throws.
fn bake_edge_shade(
    polygons: &[Polygon],
    heights: &[f64],
    bins: &[Bucket],
    max_shadow_meters: f64,
    edge_polys: &[Vec<Coord>],
) -> (Vec<i8>, Vec<BinPosition>) {
    let edge_count = edge_polys.len();
    let positions = bins
        .iter()
        .map(|bucket| BinPosition {
            elevation: bucket.elevation,
            azimuth: bucket.azimuth,
        })
        .collect();
    let Some(spec) = grid_spec(edge_polys) else {
        // No edge carries geometry (all ferries/empty): every attribute is neutral.
        return (vec![0i8; bins.len() * edge_count], positions);
    };

    let mut rows: Vec<(usize, Vec<i8>)> = bins
        .par_iter()
        .enumerate()
        .map(|(bin, bucket)| {
            // The bin's center sample (index 0) is the crisp hard shadow; the ring samples that give
            // the tile penumbra are not used, so an edge is cleanly in or out of shadow.
            let hulls: Vec<Polygon> = match bucket.samples.first() {
                Some(sample) => polygons
                    .iter()
                    .zip(heights)
                    .filter_map(|(footprint, height)| {
                        shadow_hull(footprint, *height, sample, max_shadow_meters)
                    })
                    .collect(),
                None => Vec::new(),
            };
            // Rasterize every hull into the grid once, mapping lng/lat to continuous cell coordinates
            // exactly as `CoverageGrid::shaded` reads them back.
            let mut cells = vec![0u8; spec.cols * spec.rows];
            geometry::fill_polygons(
                &mut cells,
                spec.cols,
                spec.rows,
                &geometry::flatten(&hulls),
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
            let row = edge_polys
                .iter()
                .map(|poly| match edge_shaded_fraction(poly, &grid) {
                    Some(fraction) => encode_attr(bucket.intensity * (1.0 - 2.0 * fraction)),
                    None => encode_attr(0.0),
                })
                .collect();
            (bin, row)
        })
        .collect();
    rows.sort_by_key(|(bin, _)| *bin);

    let mut attr_bytes: Vec<i8> = Vec::with_capacity(bins.len() * edge_count);
    for (_, row) in rows {
        attr_bytes.extend_from_slice(&row);
    }
    (attr_bytes, positions)
}

/// The per-edge, per-bin shade routing attributes for one city: read the buildings, then bake the
/// i8 grid over `edge_polys` (each an edge's polyline in DEGREES, in GRPH `v2_edges` order; an empty
/// vec — a ferry or degenerate edge — bakes to the neutral 0). Returns the row-major attr bytes and
/// the bins' sun positions, both in bin order.
pub fn edge_shade_attrs(
    buildings_path: &Path,
    bins: &[Bucket],
    max_shadow_meters: f64,
    edge_polys: &[Vec<Coord>],
) -> Fallible<(Vec<i8>, Vec<BinPosition>)> {
    let (polygons, heights) = binfmt::read_buildings(buildings_path)?;
    Ok(bake_edge_shade(
        &polygons,
        &heights,
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

    // One 100 m building near (-74, 40.7) and two bins whose center sample throws a 500 m shadow due
    // north; an edge in that shadow reads negative, one to the south reads positive, and the second
    // bin's unit intensity exercises both encoding clamps.
    #[test]
    fn bakes_signed_shade_attributes() {
        let building: Polygon = vec![vec![
            coord(-74.0000, 40.7000),
            coord(-73.9999, 40.7000),
            coord(-73.9999, 40.7001),
            coord(-74.0000, 40.7001),
        ]];
        let heights = vec![100.0];
        // The center sample throws a 500 m shadow due north (1 / tan folded into shadow_per_height).
        let north_shadow = || Sample {
            east: 0.0,
            north: 1.0,
            shadow_per_height: 5.0,
        };
        let bins = vec![
            Bucket {
                elevation: 30.0,
                azimuth: 180.0,
                intensity: 0.8,
                samples: vec![north_shadow()],
            },
            Bucket {
                elevation: 60.0,
                azimuth: 200.0,
                intensity: 1.0,
                samples: vec![north_shadow()],
            },
        ];
        let shaded_edge = vec![coord(-73.99995, 40.7020), coord(-73.99993, 40.7021)];
        let sunlit_edge = vec![coord(-73.99995, 40.6900), coord(-73.99993, 40.6901)];
        let ferry_edge: Vec<Coord> = Vec::new();
        let edge_polys = vec![shaded_edge, sunlit_edge, ferry_edge];

        let (attr, positions) = bake_edge_shade(&[building], &heights, &bins, 500.0, &edge_polys);

        assert_eq!(positions.len(), 2);
        assert_eq!(attr.len(), bins.len() * edge_polys.len());
        assert!(
            attr.iter().all(|&byte| byte >= -127),
            "-128 is never emitted"
        );

        let edge_count = edge_polys.len();
        let at = |bin: usize, edge: usize| attr[bin * edge_count + edge];
        // bin 0 (intensity 0.8): the shaded edge reads negative, the sunlit one positive.
        assert!(at(0, 0) < 0, "shaded edge should read negative");
        assert!(at(0, 1) > 0, "sunlit edge should read positive");
        // The empty ferry polyline bakes to exactly neutral.
        assert_eq!(at(0, 2), 0);
        // bin 1 (intensity 1.0): a fully shaded edge saturates to -127, a fully sunlit one to +127,
        // keeping the decoded magnitude under 1.
        assert_eq!(at(1, 0), -127);
        assert_eq!(at(1, 1), 127);
    }
}
