//! `tiler heights`: the crown height of every measured-canopy polygon, sampled from the 1 m LiDAR
//! canopy height model. Run by scripts/build-tree-data.ts once the canopy `.bin` is written — the
//! file arrives with its height region zeroed and leaves with it filled, in place, exactly as the
//! street density blob does under `tiler densities`.
//!
//! A polygon's height is the 75th percentile of the CHM cells whose centres fall inside it, in
//! decimetres. The CHM is a thresholded crown-core product rather than a canopy surface — 95% of
//! its cells are nodata and its lowest real reading is 2.1 m — so a polygon that catches no cell
//! keeps 0, meaning unknown, which no real height can collide with.

use std::fs;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

use crate::Fallible;
use crate::binfmt::{self, Polygon};

pub struct Args {
    pub canopy: PathBuf,
    pub chm: PathBuf,
}

const HEIGHT_PERCENTILE: f64 = 0.75;
const NODATA: u16 = 65535; // the CHM's own nodata, and 95% of its cells
const TALL_METERS: f64 = 20.0; // the cut the reported share of canopy area is taken above
const PROGRESS_BANDS: usize = 40;

// NAD83(2011) / UTM zone 18N on GRS80, the projection the CHM is published in. Its tags carry the
// tie point and the cell size but not the CRS, so that much is named here.
const SEMI_MAJOR_METERS: f64 = 6_378_137.0;
const INVERSE_FLATTENING: f64 = 298.257222101;
const SCALE_FACTOR: f64 = 0.9996;
const CENTRAL_MERIDIAN: f64 = -75.0;
const FALSE_EASTING_METERS: f64 = 500_000.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    polygons: usize,
    measured: usize,      // polygons the CHM had at least one cell for
    skipped_tiles: usize, // raster tiles whose LZW stream would not decode
}

type Chm = Decoder<BufReader<File>>;

fn open(path: &Path) -> Fallible<Chm> {
    Ok(Decoder::new(BufReader::new(File::open(path)?))?)
}

/// Snyder's transverse Mercator series, forward: degrees to UTM 18N metres. Good to millimetres
/// this close to the central meridian — a round trip over the city measures 0.06 mm.
fn utm_forward(lng: f64, lat: f64) -> (f64, f64) {
    let flattening = 1.0 / INVERSE_FLATTENING;
    let eccentricity2 = flattening * (2.0 - flattening);
    let second2 = eccentricity2 / (1.0 - eccentricity2);
    let phi = lat.to_radians();
    let (sin_phi, cos_phi) = phi.sin_cos();
    let tan_phi = sin_phi / cos_phi;
    let curvature = SEMI_MAJOR_METERS / (1.0 - eccentricity2 * sin_phi * sin_phi).sqrt();
    let tan2 = tan_phi * tan_phi;
    let eta2 = second2 * cos_phi * cos_phi;
    let east = (lng - CENTRAL_MERIDIAN).to_radians() * cos_phi;
    let east2 = east * east;
    let meridian = SEMI_MAJOR_METERS
        * ((1.0
            - eccentricity2 / 4.0
            - 3.0 * eccentricity2 * eccentricity2 / 64.0
            - 5.0 * eccentricity2 * eccentricity2 * eccentricity2 / 256.0)
            * phi
            - (3.0 * eccentricity2 / 8.0
                + 3.0 * eccentricity2 * eccentricity2 / 32.0
                + 45.0 * eccentricity2 * eccentricity2 * eccentricity2 / 1024.0)
                * (2.0 * phi).sin()
            + (15.0 * eccentricity2 * eccentricity2 / 256.0
                + 45.0 * eccentricity2 * eccentricity2 * eccentricity2 / 1024.0)
                * (4.0 * phi).sin()
            - (35.0 * eccentricity2 * eccentricity2 * eccentricity2 / 3072.0) * (6.0 * phi).sin());
    let easting = SCALE_FACTOR
        * curvature
        * (east
            + (1.0 - tan2 + eta2) * east * east2 / 6.0
            + (5.0 - 18.0 * tan2 + tan2 * tan2 + 72.0 * eta2 - 58.0 * second2)
                * east
                * east2
                * east2
                / 120.0)
        + FALSE_EASTING_METERS;
    let northing = SCALE_FACTOR
        * (meridian
            + curvature
                * tan_phi
                * (east2 / 2.0
                    + (5.0 - tan2 + 9.0 * eta2 + 4.0 * eta2 * eta2) * east2 * east2 / 24.0
                    + (61.0 - 58.0 * tan2 + tan2 * tan2 + 600.0 * eta2 - 330.0 * second2)
                        * east2
                        * east2
                        * east2
                        / 720.0));
    (easting, northing)
}

/// The raster's shape and georeferencing, read from its own tags: the image and tile sizes, the
/// ground coordinate of the upper-left *corner* of pixel (0, 0) (RasterPixelIsArea), and the
/// metres a cell spans.
struct Grid {
    width: usize,
    height: usize,
    tile: usize,
    tiles_across: usize,
    bands: usize, // rows of tiles, each decoded and rasterized as one unit
    origin_x: f64,
    origin_y: f64,
    cell: f64,
}

impl Grid {
    /// Continuous pixel coordinates, so the centre of pixel (col, row) is (col + 0.5, row + 0.5).
    fn pixel(&self, lng: f64, lat: f64) -> (f64, f64) {
        let (x, y) = utm_forward(lng, lat);
        (
            (x - self.origin_x) / self.cell,
            (self.origin_y - y) / self.cell,
        )
    }
}

fn read_grid(decoder: &mut Chm) -> Fallible<Grid> {
    let (width, height) = decoder.dimensions()?;
    let (tile_width, tile_height) = decoder.chunk_dimensions();
    let scale = decoder.get_tag_f64_vec(Tag::ModelPixelScaleTag)?;
    let tie = decoder.get_tag_f64_vec(Tag::ModelTiepointTag)?;
    // The tie point ties a raster point to a ground point; only a tie at the raster's own origin
    // and square cells make the pixel map below a division rather than a full affine transform.
    if scale.len() < 2 || tie.len() < 6 || tie[..3] != [0.0, 0.0, 0.0] || scale[0] != scale[1] {
        return Err(format!(
            "the CHM is not an axis-aligned raster tied at its origin (scale {scale:?}, tie point {tie:?})"
        )
        .into());
    }
    if tile_width != tile_height {
        return Err(
            format!("the CHM's tiles are {tile_width} by {tile_height}, not square").into(),
        );
    }
    let tile = tile_width as usize;
    Ok(Grid {
        width: width as usize,
        height: height as usize,
        tile,
        tiles_across: (width as usize).div_ceil(tile),
        bands: (height as usize).div_ceil(tile),
        origin_x: tie[3],
        origin_y: tie[4],
        cell: scale[0],
    })
}

/// The polygons flattened into the raster's pixel space: `ring_starts` indexes the coordinate
/// arrays and `polygon_starts` indexes `ring_starts`, so a polygon's rings are filled together
/// (its inner rings cut holes) and one polygon at a time (two overlapping crowns do not cancel).
struct Shapes {
    xs: Vec<f64>,
    ys: Vec<f64>,
    ring_starts: Vec<u32>,
    polygon_starts: Vec<u32>,
    first_rows: Vec<u32>, // per polygon, clamped to the raster: the rows its box can reach
    last_rows: Vec<u32>,
}

fn project(polygons: &[Polygon], grid: &Grid) -> Shapes {
    let mut shapes = Shapes {
        xs: Vec::new(),
        ys: Vec::new(),
        ring_starts: Vec::new(),
        polygon_starts: Vec::with_capacity(polygons.len() + 1),
        first_rows: Vec::with_capacity(polygons.len()),
        last_rows: Vec::with_capacity(polygons.len()),
    };
    for polygon in polygons {
        shapes.polygon_starts.push(shapes.ring_starts.len() as u32);
        let mut lowest = f64::INFINITY;
        let mut highest = f64::NEG_INFINITY;
        for ring in polygon {
            shapes.ring_starts.push(shapes.xs.len() as u32);
            for point in ring {
                let (x, y) = grid.pixel(point.lng, point.lat);
                lowest = lowest.min(y);
                highest = highest.max(y);
                shapes.xs.push(x);
                shapes.ys.push(y);
            }
        }
        let first = lowest.floor().clamp(0.0, grid.height as f64);
        let last = highest.ceil().clamp(first, grid.height as f64);
        shapes.first_rows.push(first as u32);
        shapes.last_rows.push(last as u32);
    }
    shapes.polygon_starts.push(shapes.ring_starts.len() as u32);
    shapes.ring_starts.push(shapes.xs.len() as u32);
    shapes
}

/// Which polygons each band of the raster has to fill, CSR-style, so a band is decoded once and
/// only the polygons reaching it are walked. A polygon spanning two bands is listed in both.
struct Bands {
    starts: Vec<u32>,
    polygons: Vec<u32>,
}

fn bucket_bands(shapes: &Shapes, grid: &Grid) -> Bands {
    let band_of = |row: u32| (row as usize / grid.tile).min(grid.bands - 1);
    let mut counts = vec![0u32; grid.bands + 1];
    for polygon in 0..shapes.first_rows.len() {
        if shapes.last_rows[polygon] > shapes.first_rows[polygon] {
            for band in band_of(shapes.first_rows[polygon])..=band_of(shapes.last_rows[polygon] - 1)
            {
                counts[band + 1] += 1;
            }
        }
    }
    for band in 0..grid.bands {
        counts[band + 1] += counts[band];
    }
    let mut polygons = vec![0u32; counts[grid.bands] as usize];
    let mut cursor = counts.clone();
    for polygon in 0..shapes.first_rows.len() {
        if shapes.last_rows[polygon] > shapes.first_rows[polygon] {
            for band in band_of(shapes.first_rows[polygon])..=band_of(shapes.last_rows[polygon] - 1)
            {
                polygons[cursor[band] as usize] = polygon as u32;
                cursor[band] += 1;
            }
        }
    }
    Bands {
        starts: counts,
        polygons,
    }
}

/// One band's readings for one polygon: how many of its cells the band covered, and the heights
/// the CHM carried for them. A polygon crossing a band edge contributes one of these per band.
struct Reading {
    polygon: u32,
    cells: u32,
    values: Vec<u16>,
}

struct BandResult {
    readings: Vec<Reading>,
    skipped_tiles: usize,
    skipped_cells: u64, // polygon cells that fell inside one
}

// One band: its tiles decoded into `cells`, then every polygon that reaches it filled even-odd at
// cell centres — a row's crossings are taken at y = row + 0.5 and each span covers the columns
// whose centre x = col + 0.5 lies between two of them.
fn sample_band(
    decoder: &mut Chm,
    cells: &mut [u16],
    band: usize,
    grid: &Grid,
    shapes: &Shapes,
    bands: &Bands,
) -> Fallible<BandResult> {
    let top = band * grid.tile;
    let rows = (grid.height - top).min(grid.tile);
    cells[..rows * grid.width].fill(NODATA);
    let mut skipped = vec![false; grid.tiles_across];
    for (column, failed) in skipped.iter_mut().enumerate() {
        let chunk = (band * grid.tiles_across + column) as u32;
        let (chunk_width, chunk_rows) = decoder.chunk_data_dimensions(chunk);
        let values = match decoder.read_chunk(chunk) {
            Ok(DecodingResult::U16(values)) => values,
            Ok(_) => return Err(format!("CHM tile {chunk} is not 16-bit").into()),
            Err(_) => {
                *failed = true;
                continue;
            }
        };
        let chunk_width = chunk_width as usize;
        for row in 0..(chunk_rows as usize).min(rows) {
            let left = row * grid.width + column * grid.tile;
            cells[left..left + chunk_width]
                .copy_from_slice(&values[row * chunk_width..(row + 1) * chunk_width]);
        }
    }

    let mut result = BandResult {
        readings: Vec::new(),
        skipped_tiles: skipped.iter().filter(|failed| **failed).count(),
        skipped_cells: 0,
    };
    let mut crossings: Vec<f64> = Vec::new();
    for polygon in &bands.polygons[bands.starts[band] as usize..bands.starts[band + 1] as usize] {
        let polygon = *polygon as usize;
        let first_ring = shapes.polygon_starts[polygon] as usize;
        let last_ring = shapes.polygon_starts[polygon + 1] as usize;
        let mut reading = Reading {
            polygon: polygon as u32,
            cells: 0,
            values: Vec::new(),
        };
        let from_row = (shapes.first_rows[polygon] as usize).max(top);
        let to_row = (shapes.last_rows[polygon] as usize).min(top + rows);
        for row in from_row..to_row {
            let scan = row as f64 + 0.5;
            crossings.clear();
            for ring in first_ring..last_ring {
                let from = shapes.ring_starts[ring] as usize;
                let to = shapes.ring_starts[ring + 1] as usize;
                let (xs, ys) = (&shapes.xs[from..to], &shapes.ys[from..to]);
                let mut previous = xs.len() - 1;
                for index in 0..xs.len() {
                    if (ys[previous] <= scan) != (ys[index] <= scan) {
                        let along = (scan - ys[previous]) / (ys[index] - ys[previous]);
                        crossings.push(xs[previous] + along * (xs[index] - xs[previous]));
                    }
                    previous = index;
                }
            }
            crossings.sort_by(f64::total_cmp);
            for pair in crossings.chunks_exact(2) {
                let from = (pair[0] - 0.5).ceil().max(0.0) as usize;
                let to = ((pair[1] - 0.5).ceil().max(0.0) as usize).min(grid.width);
                for column in from..to {
                    reading.cells += 1;
                    let value = cells[(row - top) * grid.width + column];
                    if value != NODATA {
                        reading.values.push(value);
                    } else if skipped[column / grid.tile] {
                        result.skipped_cells += 1;
                    }
                }
            }
        }
        if reading.cells > 0 {
            result.readings.push(reading);
        }
    }
    Ok(result)
}

fn sample(
    args: &Args,
    grid: &Grid,
    shapes: &Shapes,
    bands: &Bands,
    started: Instant,
) -> Fallible<Vec<BandResult>> {
    let done = AtomicUsize::new(0);
    (0..grid.bands)
        .into_par_iter()
        .map_init(
            // One decoder and one band buffer per worker: reopening the file per band would reparse
            // the BigTIFF directory, and the buffer is 12 MB.
            || (open(&args.chm).ok(), vec![NODATA; grid.width * grid.tile]),
            |(decoder, cells), band| {
                let decoder = decoder
                    .as_mut()
                    .ok_or_else(|| format!("{} could not be reopened", args.chm.display()))?;
                let result = sample_band(decoder, cells, band, grid, shapes, bands)?;
                let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                if finished.is_multiple_of(PROGRESS_BANDS) {
                    eprintln!(
                        "  [{:>5.1}s] {finished}/{} raster bands sampled",
                        started.elapsed().as_secs_f64(),
                        grid.bands
                    );
                }
                Ok(result)
            },
        )
        .collect()
}

/// The height at which the polygons no taller than it first hold `quantile` of the measured area.
fn area_quantile(sorted: &[(f64, u64)], area: u64, quantile: f64) -> f64 {
    let target = (area as f64 * quantile) as u64;
    let mut seen = 0;
    for (height, weight) in sorted {
        seen += weight;
        if seen >= target {
            return *height;
        }
    }
    sorted.last().map_or(0.0, |(height, _)| *height)
}

fn describe(heights_m: &[f64], areas: &[u32]) -> usize {
    let mut measured: Vec<(f64, u64)> = heights_m
        .iter()
        .zip(areas)
        .filter(|(height, _)| **height > 0.0)
        .map(|(height, area)| (*height, u64::from(*area)))
        .collect();
    measured.sort_by(|left, right| left.0.total_cmp(&right.0));
    let total: u64 = areas.iter().map(|area| u64::from(*area)).sum();
    let area: u64 = measured.iter().map(|(_, weight)| weight).sum();
    eprintln!(
        "  {} of {} polygons ({:.2}%) carry a measured height, over {:.2} km2 of {:.2} km2 of polygon area ({:.2}%)",
        measured.len(),
        heights_m.len(),
        100.0 * measured.len() as f64 / heights_m.len() as f64,
        area as f64 / 1e6,
        total as f64 / 1e6,
        100.0 * area as f64 / total as f64
    );
    if !measured.is_empty() {
        let quartiles: Vec<f64> = [0.25, 0.5, 0.75]
            .iter()
            .map(|quantile| area_quantile(&measured, area, *quantile))
            .collect();
        let tall: u64 = measured
            .iter()
            .filter(|(height, _)| *height > TALL_METERS)
            .map(|(_, weight)| weight)
            .sum();
        eprintln!(
            "  area-weighted height: median {:.1} m, IQR {:.1}-{:.1} m ({:.1} m), {:.2}% of it above {TALL_METERS:.0} m",
            quartiles[1],
            quartiles[0],
            quartiles[2],
            quartiles[2] - quartiles[0],
            100.0 * tall as f64 / area as f64
        );
    }
    measured.len()
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let mut canopy = binfmt::read_canopy(&args.canopy)?;
    let grid = read_grid(&mut open(&args.chm)?)?;
    eprintln!(
        "  [{:>5.1}s] {} canopy polygons against a {} x {} CHM of {} m cells",
        started.elapsed().as_secs_f64(),
        canopy.polygons.len(),
        grid.width,
        grid.height,
        grid.cell
    );

    let shapes = project(&canopy.polygons, &grid);
    let bands = bucket_bands(&shapes, &grid);
    eprintln!(
        "  [{:>5.1}s] {} vertices projected into the raster's UTM grid",
        started.elapsed().as_secs_f64(),
        shapes.xs.len()
    );

    let sampled = sample(args, &grid, &shapes, &bands, started)?;
    let mut areas = vec![0u32; canopy.polygons.len()];
    let mut values: Vec<Vec<u16>> = vec![Vec::new(); canopy.polygons.len()];
    let mut skipped_tiles = 0;
    let mut skipped_cells = 0;
    for band in sampled {
        skipped_tiles += band.skipped_tiles;
        skipped_cells += band.skipped_cells;
        for reading in band.readings {
            let polygon = reading.polygon as usize;
            areas[polygon] += reading.cells;
            values[polygon].extend(reading.values);
        }
    }
    eprintln!(
        "  [{:>5.1}s] {skipped_tiles} CHM tiles would not decode, holding {skipped_cells} polygon cells",
        started.elapsed().as_secs_f64()
    );

    let heights: Vec<u16> = values
        .iter_mut()
        .map(|sample| {
            sample.sort_unstable();
            // Nearest-rank: the lowest reading three quarters of the cells are at or below, and 0
            // — the unknown sentinel — when the polygon caught no cell at all.
            let rank = (sample.len() as f64 * HEIGHT_PERCENTILE).ceil() as usize;
            sample.get(rank.max(1) - 1).copied().unwrap_or(0)
        })
        .collect();
    canopy.set_heights_dm(&heights);
    fs::write(&args.canopy, &canopy.bytes)?;
    let measured = describe(&canopy.heights_m(), &areas);
    eprintln!(
        "  [{:>5.1}s] wrote {}",
        started.elapsed().as_secs_f64(),
        args.canopy.display()
    );

    println!(
        "{}",
        serde_json::to_string(&Report {
            polygons: canopy.polygons.len(),
            measured,
            skipped_tiles,
        })?
    );
    Ok(())
}
