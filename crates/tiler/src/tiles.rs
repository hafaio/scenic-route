//! `tiler tiles`: renders data/{trees,woodland,land,streets}/<id>.bin into the two overlays the
//! client draws — raster tiles at public/tiles/tree-cover/{z}/{x}/{y}.png and vector chunks at
//! public/streets/{x}/{y}.bin. See scripts/README.md.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{
    self, LAND_FORMAT, Polygon, Streets, TREE_FORMAT, WOODLAND_FORMAT, write_varint, zigzag,
};
use crate::geometry::{self, BLUR_RADII, PolygonSet, round_half_up};
use crate::kde::{KERNEL_RADII, Projection, TreeIndex};
use crate::manifest::{Bounds, City, Manifest};

const TILE_SIZE: usize = 256;
const MIN_ZOOM: u32 = 9;
const MAX_ZOOM: u32 = 15; // past this the kernel has no detail left to show; Leaflet upscales
const MIN_ALPHA: u8 = 2; // below this the fill is invisible, and the pixel costs more than it says
const SQUARE_METERS_PER_HECTARE: f64 = 10_000.0;
const EQUATOR_METERS_PER_PIXEL: f64 = 156_543.033_92; // web mercator, at the equator, at z0
const MIN_FEATHER_PIXELS: f64 = 0.5; // below this the blur has nothing to say and is skipped
// The shoreline clip, rasterized once. Only woodland within a cell of the water can care, and
// the field this replaced clipped land on a 20 m grid too — rasterizing the boroughs into every
// tile instead costs a quarter of the whole build and buys nothing.
const LAND_METERS: f64 = 20.0;

// layouts: scripts/README.md
const CHUNK_FORMAT: u16 = 2;
const CHUNK_HEADER_BYTES: usize = 40;
const CHUNK_COORD_SCALE: f64 = 1e-6; // degrees per quantized unit, ~0.1 m
const CHUNK_ZOOM: u32 = 12;

pub struct Args {
    pub manifest: PathBuf,
    pub ramp: PathBuf,
    pub data: PathBuf,
    pub tiles: PathBuf,
    pub chunks: PathBuf,
}

/// Everything one city's overlays are computed from. The field is not stored anywhere: it is
/// summed from `trees` wherever it is wanted.
struct Layer {
    projection: Projection,
    trees: TreeIndex,
    woodland: PolygonSet,
    land: LandMask,
    saturation: f64, // trees per square metre the field divides by
    broad_sigma_meters: f64,
    woodland_floor: f64,
    woodland_feather_meters: f64,
    woodland_plateau: f64,
}

/// The land, on a regular LAND_METERS grid in the local metre space.
struct LandMask {
    cells: Vec<u8>,
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
}

/// One tile of the plan: which cities reach it, and where it goes.
struct Tile {
    zoom: u32,
    x: u32,
    y: u32,
    members: Vec<usize>,
}

/// Where the build's time went, timed once per tile per phase rather than inside any loop.
/// Summed across the pool, this is the whole cost of a build.
#[derive(Clone, Copy, Default)]
struct Timings {
    kde: Duration,   // the per-pixel field sum
    mask: Duration,  // rasterizing woodland and land, and feathering the two together
    png: Duration,   // deflate
    write: Duration, // the tile itself, to disk
    total: Duration,
    bytes: usize,
}

impl std::ops::Add for Timings {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self {
            kde: self.kde + other.kde,
            mask: self.mask + other.mask,
            png: self.png + other.png,
            write: self.write + other.write,
            total: self.total + other.total,
            bytes: self.bytes + other.bytes,
        }
    }
}

fn world_size(zoom: u32) -> f64 {
    (TILE_SIZE << zoom) as f64
}

fn lng_to_pixel_x(lng: f64, zoom: u32) -> f64 {
    (lng + 180.0) / 360.0 * world_size(zoom)
}

fn lat_to_pixel_y(lat: f64, zoom: u32) -> f64 {
    let sin = (lat * std::f64::consts::PI / 180.0).sin();
    (0.5 - ((1.0 + sin) / (1.0 - sin)).ln() / (4.0 * std::f64::consts::PI)) * world_size(zoom)
}

fn pixel_x_to_lng(pixel_x: f64, zoom: u32) -> f64 {
    pixel_x / world_size(zoom) * 360.0 - 180.0
}

fn pixel_y_to_lat(pixel_y: f64, zoom: u32) -> f64 {
    let mercator = std::f64::consts::PI * (1.0 - 2.0 * pixel_y / world_size(zoom));
    mercator.sinh().atan() * 180.0 / std::f64::consts::PI
}

fn tile_index(pixel: f64, zoom: u32) -> u32 {
    (pixel / TILE_SIZE as f64)
        .floor()
        .clamp(0.0, f64::from((1u32 << zoom) - 1)) as u32
}

fn rasterize_land(land: &[Polygon], bounds: &Bounds, projection: &Projection) -> LandMask {
    let min_x = projection.x(bounds.west);
    let min_y = projection.y(bounds.south);
    let cols = ((projection.x(bounds.east) - min_x) / LAND_METERS).ceil() as usize;
    let rows = ((projection.y(bounds.north) - min_y) / LAND_METERS).ceil() as usize;
    let mut cells = vec![0u8; cols * rows];
    geometry::fill_polygons(
        &mut cells,
        cols,
        rows,
        &geometry::flatten(land),
        bounds,
        |lng| (projection.x(lng) - min_x) / LAND_METERS,
        |lat| (projection.y(lat) - min_y) / LAND_METERS,
    );
    LandMask {
        cells,
        cols,
        rows,
        min_x,
        min_y,
    }
}

fn read_layer(city: &City, data: &Path) -> Fallible<Layer> {
    let source = |directory: &str, file: &str| data.join(directory).join(file);
    let trees = binfmt::read_points(
        &source("trees", &city.field.trees.file),
        "TREE",
        TREE_FORMAT,
    )?;
    let woodland = binfmt::read_polygons(
        &source("woodland", &city.field.woodland.file),
        "WOOD",
        WOODLAND_FORMAT,
    )?;
    let land = binfmt::read_polygons(&source("land", &city.field.land.file), "LAND", LAND_FORMAT)?;

    let projection = Projection::new(&city.bounds);
    Ok(Layer {
        trees: TreeIndex::new(&trees, &projection),
        woodland: geometry::flatten(&woodland),
        land: rasterize_land(&land, &city.bounds, &projection),
        projection,
        saturation: city.field.saturation_trees_per_hectare / SQUARE_METERS_PER_HECTARE,
        broad_sigma_meters: city.field.broad_sigma_meters,
        woodland_floor: city.field.woodland_floor,
        woodland_feather_meters: city.field.woodland_feather_meters,
        woodland_plateau: city.field.woodland_plateau,
    })
}

/// The canopy floor at every pixel of one tile, or None if no woodland reaches it. The mask is
/// rasterized into a haloed buffer so the feather has the mass it needs at the tile's edge, and
/// both the woodland and the land are needed here: their AND is what keeps New Jersey's
/// forests, which the tile grid runs straight over, out of the picture.
fn tile_canopy(layer: &Layer, tile: &Tile, meters_per_pixel: f64) -> Option<Vec<f32>> {
    let zoom = tile.zoom;
    let sigma = layer.woodland_feather_meters / meters_per_pixel;
    let halo = (BLUR_RADII * sigma).ceil();
    let width = TILE_SIZE + 2 * halo as usize;
    let origin_x = f64::from(tile.x) * TILE_SIZE as f64 - halo;
    let origin_y = f64::from(tile.y) * TILE_SIZE as f64 - halo;
    let clip = Bounds {
        west: pixel_x_to_lng(origin_x, zoom),
        east: pixel_x_to_lng(origin_x + width as f64, zoom),
        north: pixel_y_to_lat(origin_y, zoom),
        south: pixel_y_to_lat(origin_y + width as f64, zoom),
    };

    let mut wooded = vec![0u8; width * width];
    let woods = geometry::fill_polygons(
        &mut wooded,
        width,
        width,
        &layer.woodland,
        &clip,
        |lng| lng_to_pixel_x(lng, zoom) - origin_x,
        |lat| lat_to_pixel_y(lat, zoom) - origin_y,
    );
    if woods == 0 {
        return None;
    }

    // Both projections are separable, so the land a row of pixels sits on is one lookup for the
    // row and one per column, rather than an unprojection at every cell.
    let land = &layer.land;
    let land_cols: Vec<Option<usize>> = (0..width)
        .map(|x| {
            let lng = pixel_x_to_lng(origin_x + x as f64 + 0.5, zoom);
            let col = ((layer.projection.x(lng) - land.min_x) / LAND_METERS).floor();
            (col >= 0.0 && col < land.cols as f64).then_some(col as usize)
        })
        .collect();
    let mut covered = 0;
    for y in 0..width {
        let lat = pixel_y_to_lat(origin_y + y as f64 + 0.5, zoom);
        let row = ((layer.projection.y(lat) - land.min_y) / LAND_METERS).floor();
        let base = (row >= 0.0 && row < land.rows as f64).then(|| row as usize * land.cols);
        for x in 0..width {
            let on_land = match (base, land_cols[x]) {
                (Some(base), Some(col)) => land.cells[base + col],
                _ => 0,
            };
            wooded[y * width + x] &= on_land;
            covered += usize::from(wooded[y * width + x]);
        }
    }
    if covered == 0 {
        return None;
    }

    let feathered =
        (sigma >= MIN_FEATHER_PIXELS).then(|| geometry::feather(&wooded, width, width, sigma));
    let halo = halo as usize;
    Some(
        (0..TILE_SIZE * TILE_SIZE)
            .map(|pixel| {
                let cell = (pixel / TILE_SIZE + halo) * width + pixel % TILE_SIZE + halo;
                let coverage = feathered
                    .as_ref()
                    .map_or_else(|| f64::from(wooded[cell]), |blur| f64::from(blur[cell]));
                (layer.woodland_floor * (coverage / layer.woodland_plateau).min(1.0)) as f32
            })
            .collect(),
    )
}

/// The field, summed exactly at every pixel centre. Mercator y is not linear in latitude, so
/// every tile row needs its own unprojection; the metre space both axes land in is separable,
/// so a column's x and a row's y are each computed once.
///
/// The kernel is widened to cover the pixel's footprint rather than its centre: a box of side p
/// has variance p^2/12, and convolving that into the Gaussian is what keeps a 232 m pixel at z9
/// from point-sampling a 70 m field and aliasing.
fn paint(
    pixels: &mut [u8],
    layer: &Layer,
    floor: Option<&[f32]>,
    ramp: &[u8],
    tile: &Tile,
    meters_per_pixel: f64,
) -> bool {
    let sigma = layer
        .broad_sigma_meters
        .hypot(meters_per_pixel / 12.0f64.sqrt());
    let origin_x = f64::from(tile.x) * TILE_SIZE as f64;
    let origin_y = f64::from(tile.y) * TILE_SIZE as f64;

    let xs: Vec<f64> = (0..TILE_SIZE)
        .map(|x| {
            layer
                .projection
                .x(pixel_x_to_lng(origin_x + x as f64 + 0.5, tile.zoom))
        })
        .collect();
    let ys: Vec<f64> = (0..TILE_SIZE)
        .map(|y| {
            layer
                .projection
                .y(pixel_y_to_lat(origin_y + y as f64 + 0.5, tile.zoom))
        })
        .collect();

    let trees = layer.trees.any_near(
        xs[0],
        ys[TILE_SIZE - 1],
        xs[TILE_SIZE - 1],
        ys[0],
        KERNEL_RADII * sigma + meters_per_pixel,
    );
    if !trees && floor.is_none() {
        return false;
    }

    let mut painted = false;
    for (y, up) in ys.iter().enumerate() {
        for (x, across) in xs.iter().enumerate() {
            let pixel = y * TILE_SIZE + x;
            let density = if trees {
                layer.trees.evaluate(*across, *up, sigma) / layer.saturation
            } else {
                0.0
            };
            let floored = floor.map_or(0.0, |floor| f64::from(floor[pixel]));
            let stop = round_half_up(density.min(1.0).max(floored) * 255.0) as usize * 4;
            if ramp[stop + 3] < MIN_ALPHA {
                continue;
            }
            pixels[pixel * 4..pixel * 4 + 4].copy_from_slice(&ramp[stop..stop + 4]);
            painted = true;
        }
    }
    painted
}

fn encode_png(pixels: &[u8]) -> Fallible<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, TILE_SIZE as u32, TILE_SIZE as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Balanced);
    let mut writer = encoder.write_header()?;
    writer.write_image_data(pixels)?;
    writer.finish()?;
    Ok(bytes)
}

// layout: scripts/README.md
fn encode_chunk(streets: &Streets, members: &[u32], origin_lng: f64, origin_lat: f64) -> Vec<u8> {
    let densities = streets.densities();
    let mut bytes = vec![0u8; CHUNK_HEADER_BYTES];
    for segment in members {
        let from = streets.starts[*segment as usize] as usize;
        let to = streets.starts[*segment as usize + 1] as usize;
        bytes.extend_from_slice(&((to - from) as u16).to_le_bytes());
        let mut previous_x = 0i64;
        let mut previous_y = 0i64;
        for vertex in from..to {
            let x = round_half_up((streets.lngs[vertex] - origin_lng) / CHUNK_COORD_SCALE) as i64;
            let y = round_half_up((streets.lats[vertex] - origin_lat) / CHUNK_COORD_SCALE) as i64;
            write_varint(&mut bytes, zigzag(x - previous_x));
            write_varint(&mut bytes, zigzag(y - previous_y));
            previous_x = x;
            previous_y = y;
        }
        bytes.extend_from_slice(&densities[from..to]);
    }

    bytes[0..4].copy_from_slice(b"STCK");
    bytes[4..6].copy_from_slice(&CHUNK_FORMAT.to_le_bytes());
    bytes[6..8].copy_from_slice(&(CHUNK_HEADER_BYTES as u16).to_le_bytes());
    bytes[8..12].copy_from_slice(&(members.len() as u32).to_le_bytes());
    bytes[16..24].copy_from_slice(&origin_lng.to_le_bytes());
    bytes[24..32].copy_from_slice(&origin_lat.to_le_bytes());
    bytes[32..40].copy_from_slice(&CHUNK_COORD_SCALE.to_le_bytes());
    bytes
}

/// A segment goes into every z12 tile its bounding box touches, which overshoots slightly but
/// cannot leave a gap at a tile seam.
fn write_chunks(streets: &Streets, chunks: &Path) -> Fallible<(usize, usize)> {
    let mut buckets: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    for segment in 0..streets.segments() {
        let from = streets.starts[segment] as usize;
        let to = streets.starts[segment + 1] as usize;
        let lngs = &streets.lngs[from..to];
        let lats = &streets.lats[from..to];
        let west = lngs.iter().copied().fold(f64::INFINITY, f64::min);
        let east = lngs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let south = lats.iter().copied().fold(f64::INFINITY, f64::min);
        let north = lats.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let min_x = tile_index(lng_to_pixel_x(west, CHUNK_ZOOM), CHUNK_ZOOM);
        let max_x = tile_index(lng_to_pixel_x(east, CHUNK_ZOOM), CHUNK_ZOOM);
        let min_y = tile_index(lat_to_pixel_y(north, CHUNK_ZOOM), CHUNK_ZOOM);
        let max_y = tile_index(lat_to_pixel_y(south, CHUNK_ZOOM), CHUNK_ZOOM);
        for tile_x in min_x..=max_x {
            for tile_y in min_y..=max_y {
                buckets
                    .entry((tile_x, tile_y))
                    .or_default()
                    .push(segment as u32);
            }
        }
    }

    let mut bytes = 0;
    for ((tile_x, tile_y), members) in &buckets {
        let origin_lng = pixel_x_to_lng(f64::from(*tile_x) * TILE_SIZE as f64, CHUNK_ZOOM);
        let origin_lat = pixel_y_to_lat(f64::from(*tile_y) * TILE_SIZE as f64, CHUNK_ZOOM);
        let encoded = encode_chunk(streets, members, origin_lng, origin_lat);
        let path = chunks
            .join(tile_x.to_string())
            .join(format!("{tile_y}.bin"));
        fs::create_dir_all(path.parent().expect("a chunk row directory"))?;
        fs::write(path, &encoded)?;
        bytes += encoded.len();
    }
    Ok((buckets.len(), bytes))
}

/// Cities can share a tile at low zoom, so tiles are keyed globally and every city touching one
/// paints into the same buffer rather than overwriting it.
fn plan_tiles(cities: &[City]) -> Vec<Tile> {
    let mut plan: Vec<Tile> = Vec::new();
    let mut seen: HashMap<(u32, u32, u32), usize> = HashMap::new();
    for (index, city) in cities.iter().enumerate() {
        let Bounds {
            south,
            west,
            north,
            east,
        } = city.bounds;
        for zoom in MIN_ZOOM..=MAX_ZOOM {
            let min_x = tile_index(lng_to_pixel_x(west, zoom), zoom);
            let max_x = tile_index(lng_to_pixel_x(east, zoom), zoom);
            let min_y = tile_index(lat_to_pixel_y(north, zoom), zoom);
            let max_y = tile_index(lat_to_pixel_y(south, zoom), zoom);
            for x in min_x..=max_x {
                for y in min_y..=max_y {
                    match seen.get(&(zoom, x, y)) {
                        Some(slot) => plan[*slot].members.push(index),
                        None => {
                            seen.insert((zoom, x, y), plan.len());
                            plan.push(Tile {
                                zoom,
                                x,
                                y,
                                members: vec![index],
                            });
                        }
                    }
                }
            }
        }
    }
    plan
}

fn render(
    layers: &[Layer],
    ramp: &[u8],
    blank: &[u8],
    directory: &Path,
    tile: &Tile,
) -> Fallible<Timings> {
    let started = Instant::now();
    let mut timings = Timings::default();
    let lat = pixel_y_to_lat((f64::from(tile.y) + 0.5) * TILE_SIZE as f64, tile.zoom);
    let meters_per_pixel = EQUATOR_METERS_PER_PIXEL * (lat * std::f64::consts::PI / 180.0).cos()
        / f64::from(1u32 << tile.zoom);

    let mut pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut painted = false;
    for member in &tile.members {
        let layer = &layers[*member];
        let masked = Instant::now();
        let floor = tile_canopy(layer, tile, meters_per_pixel);
        let summed = Instant::now();
        timings.mask += summed - masked;
        painted |= paint(
            &mut pixels,
            layer,
            floor.as_deref(),
            ramp,
            tile,
            meters_per_pixel,
        );
        timings.kde += summed.elapsed();
    }

    let encoded = Instant::now();
    let rendered = if painted {
        Some(encode_png(&pixels)?)
    } else {
        None
    };
    let png = rendered.as_deref().unwrap_or(blank);
    timings.png += encoded.elapsed();

    let written = Instant::now();
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.png", tile.y)),
        png,
    )?;
    timings.write += written.elapsed();
    timings.bytes = png.len();
    timings.total = started.elapsed();
    Ok(timings)
}

// The pool is where the whole cost of this build sits, and which part of it is worth what is not
// obvious from the outside — so it says.
fn report(timings: &Timings) {
    let total = timings.total.as_secs_f64();
    let parts = [
        ("kde", timings.kde),
        ("mask", timings.mask),
        ("png", timings.png),
        ("write", timings.write),
    ];
    let other = total
        - parts
            .iter()
            .map(|(_, spent)| spent.as_secs_f64())
            .sum::<f64>();
    let breakdown = parts
        .iter()
        .map(|(what, spent)| ((*what), spent.as_secs_f64()))
        .chain([("other", other)])
        .map(|(what, spent)| format!("{what} {spent:.1}s ({:.0}%)", 100.0 * spent / total))
        .collect::<Vec<String>>()
        .join(", ");
    eprintln!("tile workers: {total:.1} core-s = {breakdown}");
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    let ramp = fs::read(&args.ramp)?;
    if ramp.len() != 256 * 4 {
        return Err(format!(
            "{} is {} bytes, not the 1024 of a 256-step RGBA ramp",
            args.ramp.display(),
            ramp.len()
        )
        .into());
    }

    let mut chunks = 0;
    let mut chunk_bytes = 0;
    for city in &manifest.cities {
        let streets = binfmt::read_streets(&args.data.join("streets").join(&city.streets.file))?;
        eprintln!(
            "{}: {} trees, {} woodland polygons, {} segments, ramp saturates at {} trees/ha",
            city.id,
            city.field.trees.count,
            city.field.woodland.count,
            streets.segments(),
            city.field.saturation_trees_per_hectare
        );
        let (city_chunks, city_bytes) = write_chunks(&streets, &args.chunks)?;
        chunks += city_chunks;
        chunk_bytes += city_bytes;
    }
    let chunked = started.elapsed();

    let setup = Instant::now();
    let layers: Vec<Layer> = manifest
        .cities
        .iter()
        .map(|city| read_layer(city, &args.data))
        .collect::<Fallible<Vec<Layer>>>()?;
    let plan = plan_tiles(&manifest.cities);
    for tile in &plan {
        fs::create_dir_all(
            args.tiles
                .join(tile.zoom.to_string())
                .join(tile.x.to_string()),
        )?;
    }
    let blank = encode_png(&vec![0u8; TILE_SIZE * TILE_SIZE * 4])?;
    let setup = setup.elapsed();

    eprintln!(
        "rendering {} tiles across {} threads",
        plan.len(),
        rayon::current_num_threads()
    );
    let mut timings = plan
        .par_iter()
        .map(|tile| render(&layers, &ramp, &blank, &args.tiles, tile))
        .try_reduce(Timings::default, |left, right| Ok(left + right))?;
    // The setup is single-threaded now, but the TypeScript pool it replaced charged its share to
    // every worker — each rebuilt the tree index for itself — so it stays in the same total.
    timings.total += setup;

    let mut per_zoom: Vec<(u32, usize)> = Vec::new();
    for tile in &plan {
        match per_zoom.iter_mut().find(|(zoom, _)| *zoom == tile.zoom) {
            Some((_, count)) => *count += 1,
            None => per_zoom.push((tile.zoom, 1)),
        }
    }
    per_zoom.sort_unstable();
    eprintln!(
        "wrote {} tiles (z{MIN_ZOOM}-z{MAX_ZOOM}, {:.1} MiB) and {chunks} street chunks (z{CHUNK_ZOOM}, {:.1} MiB) in {:.1}s",
        plan.len(),
        timings.bytes as f64 / 1024.0 / 1024.0,
        chunk_bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    eprintln!(
        "tiles per zoom: {}",
        per_zoom
            .iter()
            .map(|(zoom, count)| format!("z{zoom} {count}"))
            .collect::<Vec<String>>()
            .join(", ")
    );
    report(&timings);
    eprintln!("main thread: chunks {:.1}s", chunked.as_secs_f64());
    Ok(())
}
