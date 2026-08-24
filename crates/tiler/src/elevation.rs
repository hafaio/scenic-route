//! The elevation overlay: a topographic map of the city, as three data channels.
//!
//! The DEM arrives as several hundred one-metre tiles on the city's own projected grid, which is far
//! finer than any zoom the map shows and in the wrong coordinate system. So it is resampled once,
//! into a single longitude/latitude field at the finest zoom's own resolution, and the pyramid is
//! rendered from that. One pass over the tiles rather than one per zoom level, and the field for a
//! whole city is a few tens of megabytes where the tiles are gigabytes.
//!
//! Nothing here is coloured. R carries the height across the city's own range, G the relief shade,
//! and alpha how much of the pixel is ground; the client multiplies the three together and applies
//! the hypsometric tint — greens at the bottom through tans to browns at the top, the convention a
//! paper topographic map uses — in a shader. The range travels with the tiles in range.json, since
//! the stretch is over the city's own ground rather than an absolute scale: what a reader wants to
//! see is which of *these* streets are the hills.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, LAND_FORMAT};
use crate::dem::{Dem, Field, resample};
use crate::geometry::PolygonIndex;
use crate::manifest::{Bounds, Manifest};
use crate::raster::{
    MIN_ZOOM, TILE_SIZE, Tile, encode_webp_lossless, pixel_x_to_lng, pixel_y_to_lat, plan_tiles,
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
    /// The city's land polygons. The DEM covers water — 3DEP writes a returned surface for the bay
    /// as readily as for a hill — so without this the overlay tints the sea at sea level and reads
    /// as ground. Also clips the shoreline back from the small creep the gap fill leaves behind it.
    pub land: PathBuf,
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

/// A [0, 1] field as the byte the tile stores it in.
fn byte(fraction: f32) -> u8 {
    (fraction * 255.0).round() as u8
}

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

/// The largest value `hillshade` can return, 0.65 + 0.5 * 1.0. Dividing by it is what fits the
/// shade into a byte without clipping the brightening a lit face gets; the client multiplies it back
/// before shading the tint with it. Keep in sync with the elevation ramp's `reliefScale` in
/// src/theme/palette.ts.
const HILLSHADE_MAX: f32 = 1.15;

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
            let pixel = (row * TILE_SIZE + column) * 4;
            // Three fields, no colour: height across the city's range, the relief shade, and how
            // much of the pixel is ground. Blue is unused.
            pixels[pixel] = byte(((value - field.low()) / range).clamp(0.0, 1.0));
            pixels[pixel + 1] = byte((shade / HILLSHADE_MAX).clamp(0.0, 1.0));
            pixels[pixel + 3] = byte(coverage);
            painted = true;
        }
    }
    // A tile with no ground under it is not written at all: the client reads the 404 as transparent,
    // which is the contract elevation-layer.tsx and scripts/README.md both state.
    if !painted {
        return Ok(0);
    }
    // Lossless rather than lossy: alpha survives a lossy WebP exactly, but a COLOUR channel does
    // not — lossy keeps the two chroma planes at quarter resolution, and the measured error is
    // 18-22 — and this tile now carries data in R and G.
    let bytes = encode_webp_lossless(&pixels);
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.webp", tile.y)),
        &bytes,
    )?;
    Ok(bytes.len() as u64)
}

/// `dem` is borrowed rather than opened here because the graph pass resamples the same mosaic for its
/// relief byte, over different bounds at a different zoom; `tiler build` opens it once and hands it
/// to both.
pub fn run(args: &Args, dem: &mut Dem) -> Fallible<()> {
    let started = Instant::now();
    let mut manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    manifest.cities.retain(|city| city.id == args.city);
    if manifest.cities.is_empty() {
        return Err(format!("no city {} in the manifest", args.city).into());
    }
    eprintln!("{}: {} DEM tiles", args.city, dem.tiles());
    // Widened by the same reach the mask is allowed, because the city's bounds are the box around
    // those same shoreline polygons: without this the field simply ends where the polygons do and
    // there is nothing out there for the reach to keep. Hunters Point's docks sat past the east edge
    // and were cut by a ruler-straight line down the middle of the shipyard.
    manifest.cities[0].bounds = widen(&manifest.cities[0].bounds, SHORE_REACH_METERS);
    let mut field = resample(&manifest.cities[0].bounds, ELEVATION_MAX_ZOOM, dem)?;
    // The decoded tile is a city of float32 at one metre; nothing below reads the mosaic again.
    dem.release();

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
    // The tint the client applies is stretched over the city's own range, so the range has to travel
    // with the tiles: without it a reader has a picture of which streets are higher and no idea by
    // how much. HILLSHADE_MAX does not travel — it is a constant of `hillshade` rather than of this
    // city, so it is spelled on both sides like MAX_SHADE_ALPHA rather than shipped per pyramid.
    fs::write(
        root.join("range.json"),
        serde_json::to_vec(&serde_json::json!({
            "lowMeters": field.low(),
            "highMeters": field.high(),
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
