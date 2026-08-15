//! The elevation overlay: a topographic map of the city, tinted by height.
//!
//! The DEM arrives as several hundred one-metre tiles on the city's own projected grid, which is far
//! finer than any zoom the map shows and in the wrong coordinate system. So it is resampled once,
//! into a single longitude/latitude field at the finest zoom's own resolution, and the pyramid is
//! rendered from that. One pass over the tiles rather than one per zoom level, and the field for a
//! whole city is a few tens of megabytes where the tiles are gigabytes.
//!
//! The tint is hypsometric — the convention a paper topographic map uses, greens at the bottom
//! through tans to browns at the top — stretched over the city's own range rather than an absolute
//! scale, because what a reader wants to see is which of *these* streets are the hills. A hillshade
//! is multiplied over it so the form reads at a glance; without it a smooth ramp looks like fog.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, LAND_FORMAT};
use crate::dem::{Dem, Field, resample};
use crate::geometry::PolygonIndex;
use crate::heights::Tmerc;
use crate::manifest::{Bounds, Manifest};
use crate::raster::{
    MIN_ZOOM, TILE_SIZE, Tile, encode_webp, pixel_x_to_lng, pixel_y_to_lat, plan_tiles,
};

/// The finest level the pyramid is baked to, at which a pixel is about 2.4 m of ground.
///
/// The tint itself has no detail to show at that scale — ground does not change over a few metres
/// the way a canopy edge does — but the COASTLINE does, and the coastline is what a reader notices.
/// The land mask is applied at the field's own resolution, so the shore is a staircase of whole
/// cells: at z14 that is 9.5 m steps, plainly visible the moment the tile is magnified, and no
/// amount of smoothing removes it because it is the shape that is wrong and not the pixels. Two
/// levels deeper cuts the step to 2.4 m, which is close enough to the 1 m source to stop reading as
/// a staircase.
///
/// Costs sixteen times the tiles and sixteen times the field. San Francisco's pyramid is 0.2 MiB at
/// z14, so that is affordable in a way the shade pyramid's levels are not.
pub const ELEVATION_MAX_ZOOM: u32 = 16;

pub struct Args {
    pub manifest: PathBuf,
    pub tiles: PathBuf,
    pub city: String,
    /// The DEM tiles, as a newline-separated list — several hundred paths is more than a command
    /// line should carry.
    pub dem: PathBuf,
    pub band: usize,
    /// The projection those tiles are published on. Named by the caller rather than resolved from a
    /// table here, because `tiler graph` is already told the same thing by `--elevation-crs` and two
    /// tables disagreeing means a city whose graph bakes correct relief and whose overlay is simply
    /// absent, with the build reporting success.
    pub projection: Tmerc,
    /// The city's land polygons. The DEM covers water — 3DEP writes a returned surface for the bay
    /// as readily as for a hill — so without this the overlay tints the sea at sea level and reads
    /// as ground. Also clips the shoreline back from the small creep the gap fill leaves behind it.
    pub land: PathBuf,
}

/// The hypsometric ramp, low to high: the greens, tans and browns a topographic map tints its
/// contour bands with. Interpolated rather than banded, so a city with 100 m of range does not come
/// out as three flat steps.
const RAMP: [[f32; 3]; 6] = [
    [86.0, 132.0, 96.0],   // valley green
    [140.0, 168.0, 112.0], // low slope
    [196.0, 190.0, 130.0], // tan
    [214.0, 176.0, 122.0], // ochre
    [186.0, 138.0, 104.0], // brown
    [150.0, 108.0, 92.0],  // summit
];

fn tint(fraction: f32) -> [f32; 3] {
    let clamped = fraction.clamp(0.0, 1.0) * (RAMP.len() - 1) as f32;
    let step = clamped.floor() as usize;
    let next = (step + 1).min(RAMP.len() - 1);
    let blend = clamped - step as f32;
    [0, 1, 2].map(|channel| RAMP[step][channel] * (1.0 - blend) + RAMP[next][channel] * blend)
}

/// A relief shade from the field's own slope, lit from the north-west at 45 degrees — the direction
/// every printed relief map lights from, because lighting from below reads as an inversion.
fn hillshade(field: &Field, lng: f64, lat: f64, meters_per_degree_lat: f64) -> f32 {
    let east = field.sample(lng + field.step_lng(), lat);
    let west = field.sample(lng - field.step_lng(), lat);
    let north = field.sample(lng, lat + field.step_lat());
    let south = field.sample(lng, lat - field.step_lat());
    if !east.is_finite() || !west.is_finite() || !north.is_finite() || !south.is_finite() {
        return 1.0;
    }
    let run_x = 2.0 * field.step_lng() * meters_per_degree_lat * lat.to_radians().cos();
    let run_y = 2.0 * field.step_lat() * meters_per_degree_lat;
    let slope_x = f64::from(east - west) / run_x;
    let slope_y = f64::from(north - south) / run_y;
    // The surface normal against the light, compressed afterwards so the darkest face still shows
    // its tint rather than going to black.
    //
    // For ground at height z, the normal is (-dz/dx, -dz/dy, 1) and the unit vector toward a
    // north-west light 45 degrees up is (-1, 1, 1)/sqrt(3), so their dot product is
    // (slope_x - slope_y + 1). Both signs matter and both were wrong here: the shade was lit from
    // the SOUTH-EAST, which is the inversion the doc comment above warns about — a north-west face
    // scored 0.33 where it should score 0.94, and every hill read as a hollow.
    let light = (slope_x - slope_y + 1.0)
        / (slope_x * slope_x + slope_y * slope_y + 1.0).sqrt()
        / 3.0_f64.sqrt();
    (0.65 + 0.5 * light.clamp(-1.0, 1.0)) as f32
}

/// Sub-samples across a pixel, per axis, when deciding how much of it is ground. Four by four: the
/// shore is the only place it changes anything, and sixteen array reads on a field already in cache
/// costs less than the tile's WebP encode.
const COVERAGE_SAMPLES: usize = 4;

/// How much of one tile pixel stands on ground, 0 to 1.
fn pixel_coverage(field: &Field, lng: f64, lat: f64, zoom: u32) -> f32 {
    // The pixel's own span in degrees, from the tile grid rather than the field's step: what is
    // being antialiased is the pixel, and past the field's resolution the two differ.
    let span_lng = 360.0 / (f64::from(1u32 << zoom) * TILE_SIZE as f64);
    let span_lat = span_lng * lat.to_radians().cos();
    let mut total = 0.0;
    for row in 0..COVERAGE_SAMPLES {
        let offset_lat = (row as f64 + 0.5) / COVERAGE_SAMPLES as f64 - 0.5;
        for column in 0..COVERAGE_SAMPLES {
            let offset_lng = (column as f64 + 0.5) / COVERAGE_SAMPLES as f64 - 0.5;
            total += field.coverage(lng + offset_lng * span_lng, lat + offset_lat * span_lat);
        }
    }
    total / (COVERAGE_SAMPLES * COVERAGE_SAMPLES) as f32
}

const METERS_PER_DEGREE_LAT: f64 = 111_320.0;
// Low enough that the basemap under it stays legible — street names, park fills, the water — since
// the terrain covers every pixel of the city and anything it buries is buried everywhere.
const ALPHA: u8 = 170;

// How far past the land polygons the surface is still allowed to be ground, and how far up it has to
// stand out there to count. San Francisco's shoreline polygons follow the natural shore, so the
// port's piers and the built edges of Treasure Island fell outside them and came out as holes in the
// middle of the city. 300 m clears the longest finger pier; the deck height is what stops the reach
// from tinting the bay with it, since the water's own returns sit near the tidal plane — MHHW is
// about 1.8 m on this datum — and a pier deck stands several metres over that.
const SHORE_REACH_METERS: f64 = 300.0;
const DECK_METERS: f32 = 2.5;

/// A city's box pushed out by a distance on every side.
fn widen(bounds: &Bounds, meters: f64) -> Bounds {
    let lat = (bounds.north - bounds.south) / 2.0 + bounds.south;
    let north_south = meters / METERS_PER_DEGREE_LAT;
    let east_west = north_south / lat.to_radians().cos();
    Bounds {
        south: bounds.south - north_south,
        west: bounds.west - east_west,
        north: bounds.north + north_south,
        east: bounds.east + east_west,
    }
}

fn render(field: &Field, directory: &std::path::Path, tile: &Tile) -> Fallible<u64> {
    let mut pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut painted = false;
    let range = (field.high() - field.low()).max(1.0);
    for row in 0..TILE_SIZE {
        let lat = pixel_y_to_lat(
            (tile.y as f64 * TILE_SIZE as f64) + row as f64 + 0.5,
            tile.zoom,
        );
        for column in 0..TILE_SIZE {
            let lng = pixel_x_to_lng(
                (tile.x as f64 * TILE_SIZE as f64) + column as f64 + 0.5,
                tile.zoom,
            );
            let value = field.sample(lng, lat);
            if !value.is_finite() {
                continue;
            }
            // Opacity follows how much ground is under the PIXEL, sampled on a grid across it
            // rather than once at its centre. Once at the centre is what the field's own coverage
            // gives, and that varies only within a single field cell — narrower than a pixel — so
            // the shore still landed on whole-pixel boundaries and came out a staircase. Averaging
            // across the pixel puts a real fractional edge in the tile, which is what survives being
            // magnified past the deepest baked zoom.
            let coverage = pixel_coverage(field, lng, lat, tile.zoom);
            if coverage <= 0.0 {
                continue;
            }
            let shade = hillshade(field, lng, lat, METERS_PER_DEGREE_LAT);
            let colour = tint((value - field.low()) / range);
            let pixel = (row * TILE_SIZE + column) * 4;
            for channel in 0..3 {
                pixels[pixel + channel] = (colour[channel] * shade).clamp(0.0, 255.0) as u8;
            }
            pixels[pixel + 3] = (f32::from(ALPHA) * coverage).round().clamp(0.0, 255.0) as u8;
            painted = true;
        }
    }
    // A tile with no ground under it is not written at all: the client reads the 404 as transparent,
    // which is the contract elevation-layer.tsx and scripts/README.md both state.
    if !painted {
        return Ok(0);
    }
    let bytes = encode_webp(&pixels)?;
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.webp", tile.y)),
        &bytes,
    )?;
    Ok(bytes.len() as u64)
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let mut manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    manifest.cities.retain(|city| city.id == args.city);
    if manifest.cities.is_empty() {
        return Err(format!("no city {} in the manifest", args.city).into());
    }
    let paths: Vec<PathBuf> = fs::read_to_string(&args.dem)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    let mut dem = Dem::open(&paths, args.projection, args.band)?;
    eprintln!("{}: {} DEM tiles", args.city, dem.tiles());
    // Widened by the same reach the mask is allowed, because the city's bounds are the box around
    // those same shoreline polygons: without this the field simply ends where the polygons do and
    // there is nothing out there for the reach to keep. Hunters Point's docks sat past the east edge
    // and were cut by a ruler-straight line down the middle of the shipyard.
    manifest.cities[0].bounds = widen(&manifest.cities[0].bounds, SHORE_REACH_METERS);
    let mut field = resample(&manifest.cities[0].bounds, ELEVATION_MAX_ZOOM, &mut dem)?;
    drop(dem);

    // Water out. The DEM answers over the bay and the ocean the same way it answers over a hill, so
    // an unmasked overlay tints the sea a valley green and the reader has to know the coastline to
    // tell them apart. Dropped from the field rather than skipped at render time so the hillshade
    // never differences a shore cell against a sea cell, and so the tint's range is the range of
    // the city's actual ground.
    let land = binfmt::read_polygons(&args.land, "LAND", LAND_FORMAT)?;
    let mut on_land = PolygonIndex::new(&land);
    let wet = field.retain(SHORE_REACH_METERS, DECK_METERS, |lng, lat| {
        on_land.contains(lng, lat)
    });
    eprintln!(
        "{}: {wet} field cells dropped as water, ground now {:.0} m to {:.0} m",
        args.city,
        field.low(),
        field.high()
    );

    let root = args.tiles.join("elevation").join(&args.city);
    let plan = plan_tiles(&manifest.cities, ELEVATION_MAX_ZOOM);
    for tile in &plan {
        fs::create_dir_all(root.join(tile.zoom.to_string()).join(tile.x.to_string()))?;
    }
    // The tint is stretched over the city's own range, so the range has to travel with it: without
    // it a reader has a picture of which streets are higher and no idea by how much.
    fs::write(
        root.join("range.json"),
        serde_json::to_vec(&serde_json::json!({
            "lowMeters": field.low(),
            "highMeters": field.high(),
            "ramp": RAMP.map(|colour| colour.map(|channel| channel.round() as u8)),
        }))?,
    )?;
    let bytes: u64 = plan
        .par_iter()
        .map(|tile| render(&field, &root, tile))
        .try_reduce(|| 0, |left, right| Ok(left + right))?;

    eprintln!(
        "{}: wrote {} elevation tiles (z{MIN_ZOOM}-z{ELEVATION_MAX_ZOOM}, {:.1} MiB) in {:.1}s",
        args.city,
        plan.len(),
        bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}
