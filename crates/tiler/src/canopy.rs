//! `tiler canopy`: rasterizes data/canopy/<id>.bin — the measured 2017 LiDAR tree canopy,
//! magic CNPY, ~1.08 M polygons — into a per-pixel coverage pyramid at
//! public/tiles/canopy/{z}/{x}/{y}.webp, blurred and coloured by the shared ramp. This is the
//! map's cover fill; the routing graph reads the same canopy through `densities`, so the block
//! fill, the street lines and the routes all speak of one measured field. See scripts/README.md.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, LAND_FORMAT};
use crate::geometry::{self, PolygonGrid, PolygonSet, round_half_up};
use crate::kde::Projection;
use crate::manifest::{Bounds, City, Manifest};
use crate::raster::{
    EQUATOR_METERS_PER_PIXEL, LandMask, MAX_ZOOM, MIN_ALPHA, MIN_FEATHER_PIXELS, MIN_ZOOM,
    TILE_SIZE, Tile, encode_webp, lat_to_pixel_y, lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat,
    plan_tiles, rasterize_land,
};

// The pixel is fraction-of-ground-under-canopy, so the polygon fill is antialiased by
// rasterizing at 4x and averaging the block back down: a pixel half under canopy reads 0.5
// rather than a hard 0/1 edge.
const SUPERSAMPLE: usize = 4;
const CNPY_FORMAT: u16 = 1;
// The raw polygon coverage is too concentrated to read as density — a hard 1 under a crown, 0
// between — and shade physically reaches past a crown's edge. So the fraction is convolved with
// an isotropic Gaussian before colouring, the same blur the sidewalk sampler uses, at the same
// sigma. Held here as a const until the manifest carries it (Phase 3); mirrors densities.
const FILL_SIGMA_METERS: f64 = 15.0;

pub struct Args {
    pub manifest: PathBuf,
    pub ramp: PathBuf,
    pub data: PathBuf,
    pub tiles: PathBuf,
}

/// One city's canopy, ready to rasterize: the polygons, a spatial grid so a tile touches only
/// the polygons it must, and the land mask the coverage is clipped to so canopy never bleeds
/// over water at the shoreline.
struct Canopy {
    set: PolygonSet,
    grid: PolygonGrid,
    land: LandMask,
    projection: Projection,
    polygons: usize,
}

/// The build's totals. `land_pixels`/`canopy_sum` are accumulated only at MAX_ZOOM, where a
/// pixel is a true patch of ground, so their ratio is the citywide mean canopy over land.
#[derive(Clone, Copy, Default)]
struct Stats {
    tiles: usize,
    painted: usize,
    bytes: usize,
    land_pixels: u64,
    canopy_sum: f64,
}

impl std::ops::Add for Stats {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self {
            tiles: self.tiles + other.tiles,
            painted: self.painted + other.painted,
            bytes: self.bytes + other.bytes,
            land_pixels: self.land_pixels + other.land_pixels,
            canopy_sum: self.canopy_sum + other.canopy_sum,
        }
    }
}

fn read_canopy(city: &City, data: &Path) -> Fallible<Option<Canopy>> {
    let Some(canopy) = &city.field.canopy else {
        return Ok(None);
    };
    let polygons =
        binfmt::read_polygons(&data.join("canopy").join(&canopy.file), "CNPY", CNPY_FORMAT)?;
    let land = binfmt::read_polygons(
        &data.join("land").join(&city.field.land.file),
        "LAND",
        LAND_FORMAT,
    )?;
    let projection = Projection::new(&city.bounds);
    let set = geometry::flatten(&polygons);
    Ok(Some(Canopy {
        grid: PolygonGrid::new(&set),
        land: rasterize_land(&land, &city.bounds, &projection),
        set,
        projection,
        polygons: polygons.len(),
    }))
}

/// The land pixels a tile contributes to the citywide mean — the denominator has to include
/// leafless ground, not just canopy, so a tile with no polygons still counts its land.
fn land_pixel_count(land: &LandMask, rows: &[Option<usize>], cols: &[Option<usize>]) -> u64 {
    let mut total = 0;
    for base in rows.iter().flatten() {
        for column in cols.iter().flatten() {
            if land.is_land(*base, *column) {
                total += 1;
            }
        }
    }
    total
}

/// The per-pixel canopy fraction over one tile, or None where no canopy reaches it. Also the
/// land pixels and summed canopy the stats want (both zero unless `want_stats`, which is set
/// only at MAX_ZOOM). The polygons are rasterized supersampled, then the block is averaged and
/// clipped to land.
fn coverage(canopy: &Canopy, tile: &Tile, want_stats: bool) -> (Option<Vec<f32>>, u64, f64) {
    let zoom = tile.zoom;
    let origin_x = f64::from(tile.x) * TILE_SIZE as f64;
    let origin_y = f64::from(tile.y) * TILE_SIZE as f64;

    // The blur runs in pixel space, so its sigma is the fill metres over this zoom's ground
    // resolution at the tile's latitude. Below half a pixel it has nothing left to say and is
    // skipped (the supersample average is already the field); above it the tile grows a halo of
    // BLUR_RADII sigmas so the kernel has neighbouring canopy to draw from and tiles do not seam.
    let centre_lat = pixel_y_to_lat(origin_y + TILE_SIZE as f64 / 2.0, zoom);
    let meters_per_pixel =
        EQUATOR_METERS_PER_PIXEL * centre_lat.to_radians().cos() / f64::from(1u32 << zoom);
    let sigma_pixels = FILL_SIGMA_METERS / meters_per_pixel;
    let blur = sigma_pixels >= MIN_FEATHER_PIXELS;
    let halo = if blur {
        (geometry::BLUR_RADII * sigma_pixels).ceil() as usize
    } else {
        0
    };
    let padded = TILE_SIZE + 2 * halo;
    let pad_origin_x = origin_x - halo as f64;
    let pad_origin_y = origin_y - halo as f64;
    let clip = Bounds {
        west: pixel_x_to_lng(pad_origin_x, zoom),
        east: pixel_x_to_lng(pad_origin_x + padded as f64, zoom),
        north: pixel_y_to_lat(pad_origin_y, zoom),
        south: pixel_y_to_lat(pad_origin_y + padded as f64, zoom),
    };

    let mut candidates: Vec<u32> = Vec::new();
    canopy.grid.candidates(&clip, &mut candidates);
    if candidates.is_empty() && !want_stats {
        return (None, 0, 0.0);
    }

    // Land at each pixel centre, separably: a column's x and a row's base are each one lookup.
    let land = &canopy.land;
    let land_cols: Vec<Option<usize>> = (0..TILE_SIZE)
        .map(|x| {
            let lng = pixel_x_to_lng(origin_x + x as f64 + 0.5, zoom);
            land.column(canopy.projection.x(lng))
        })
        .collect();
    let land_rows: Vec<Option<usize>> = (0..TILE_SIZE)
        .map(|y| {
            let lat = pixel_y_to_lat(origin_y + y as f64 + 0.5, zoom);
            land.row_base(canopy.projection.y(lat))
        })
        .collect();

    if candidates.is_empty() {
        return (None, land_pixel_count(land, &land_rows, &land_cols), 0.0);
    }

    let scale = SUPERSAMPLE as f64;
    let width = padded * SUPERSAMPLE;
    let mut mask = vec![0u8; width * width];
    let drawn = geometry::fill_polygons_indexed(
        &mut mask,
        width,
        width,
        &canopy.set,
        &candidates,
        &clip,
        |lng, lat| {
            (
                (lng_to_pixel_x(lng, zoom) - pad_origin_x) * scale,
                (lat_to_pixel_y(lat, zoom) - pad_origin_y) * scale,
            )
        },
    );
    if drawn == 0 {
        let land_pixels = if want_stats {
            land_pixel_count(land, &land_rows, &land_cols)
        } else {
            0
        };
        return (None, land_pixels, 0.0);
    }

    // Average each supersample block down to its pixel's covered fraction over the padded grid,
    // then blur the field so shade grades out past a crown rather than stopping at its edge.
    let subpixels = (SUPERSAMPLE * SUPERSAMPLE) as f32;
    let mut field = vec![0.0f32; padded * padded];
    for pixel_y in 0..padded {
        for pixel_x in 0..padded {
            let mut covered = 0u32;
            for sub_y in 0..SUPERSAMPLE {
                let row = (pixel_y * SUPERSAMPLE + sub_y) * width + pixel_x * SUPERSAMPLE;
                for sub_x in 0..SUPERSAMPLE {
                    covered += u32::from(mask[row + sub_x]);
                }
            }
            field[pixel_y * padded + pixel_x] = covered as f32 / subpixels;
        }
    }
    let blurred = if blur {
        geometry::feather(&field, padded, padded, sigma_pixels)
    } else {
        field
    };

    // Crop the halo back off and clip to land: the kernel spread canopy over the shoreline, and
    // only ground under the field counts, both for the pixel and for the citywide mean.
    let mut fraction = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    let mut painted = false;
    let mut land_pixels = 0u64;
    let mut canopy_sum = 0.0;
    for (y, base) in land_rows.iter().enumerate() {
        let Some(base) = base else { continue };
        for (x, column) in land_cols.iter().enumerate() {
            let Some(column) = column else { continue };
            if !land.is_land(*base, *column) {
                continue;
            }
            land_pixels += 1;
            let value = blurred[(y + halo) * padded + (x + halo)];
            if value > 0.0 {
                fraction[y * TILE_SIZE + x] = value;
                canopy_sum += f64::from(value);
                painted = true;
            }
        }
    }
    (
        painted.then_some(fraction),
        if want_stats { land_pixels } else { 0 },
        canopy_sum,
    )
}

/// Colour a tile's pixels from the canopy fraction through the shared ramp LUT. Fraction is a
/// covered fraction in [0, 1], exactly what the ramp is defined over.
fn paint(pixels: &mut [u8], fraction: &[f32], ramp: &[u8]) -> bool {
    let mut painted = false;
    for (pixel, value) in fraction.iter().enumerate() {
        if *value <= 0.0 {
            continue;
        }
        let stop = round_half_up(f64::from(*value) * 255.0) as usize * 4;
        if ramp[stop + 3] < MIN_ALPHA {
            continue;
        }
        pixels[pixel * 4..pixel * 4 + 4].copy_from_slice(&ramp[stop..stop + 4]);
        painted = true;
    }
    painted
}

fn render(
    canopies: &[Option<Canopy>],
    ramp: &[u8],
    blank: &[u8],
    directory: &Path,
    tile: &Tile,
) -> Fallible<Stats> {
    let want_stats = tile.zoom == MAX_ZOOM;
    let mut pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut painted = false;
    let mut land_pixels = 0u64;
    let mut canopy_sum = 0.0;
    for member in &tile.members {
        if let Some(canopy) = &canopies[*member] {
            let (fraction, pixels_on_land, sum) = coverage(canopy, tile, want_stats);
            land_pixels += pixels_on_land;
            canopy_sum += sum;
            if let Some(fraction) = fraction {
                painted |= paint(&mut pixels, &fraction, ramp);
            }
        }
    }

    let rendered = if painted {
        Some(encode_webp(&pixels)?)
    } else {
        None
    };
    let png = rendered.as_deref().unwrap_or(blank);
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.webp", tile.y)),
        png,
    )?;
    Ok(Stats {
        tiles: 1,
        painted: usize::from(painted),
        bytes: png.len(),
        land_pixels,
        canopy_sum,
    })
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

    let canopies: Vec<Option<Canopy>> = manifest
        .cities
        .iter()
        .map(|city| read_canopy(city, &args.data))
        .collect::<Fallible<Vec<Option<Canopy>>>>()?;
    if canopies.iter().all(Option::is_none) {
        eprintln!("no city has a canopy layer; nothing to render");
        return Ok(());
    }
    for (city, canopy) in manifest.cities.iter().zip(&canopies) {
        if let Some(canopy) = canopy {
            eprintln!("{}: {} canopy polygons", city.id, canopy.polygons);
        }
    }

    let plan = plan_tiles(&manifest.cities);
    for tile in &plan {
        fs::create_dir_all(
            args.tiles
                .join(tile.zoom.to_string())
                .join(tile.x.to_string()),
        )?;
    }
    let blank = encode_webp(&vec![0u8; TILE_SIZE * TILE_SIZE * 4])?;

    eprintln!(
        "rendering {} canopy tiles across {} threads",
        plan.len(),
        rayon::current_num_threads()
    );
    let stats = plan
        .par_iter()
        .map(|tile| render(&canopies, &ramp, &blank, &args.tiles, tile))
        .try_reduce(Stats::default, |left, right| Ok(left + right))?;

    let mean = if stats.land_pixels > 0 {
        stats.canopy_sum / stats.land_pixels as f64
    } else {
        0.0
    };
    eprintln!(
        "wrote {} canopy tiles (z{MIN_ZOOM}-z{MAX_ZOOM}, {} painted, {:.1} MiB) in {:.1}s",
        stats.tiles,
        stats.painted,
        stats.bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    eprintln!("mean canopy fraction over land (z{MAX_ZOOM}): {mean:.3}");
    Ok(())
}
