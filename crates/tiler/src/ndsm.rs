//! Roof heights where nobody publishes any: a surface model binned out of a raw LiDAR point cloud,
//! differenced against the bare-earth DEM under it, and sampled per building footprint by the same
//! polygon-against-raster pass the crown heights come from.
//!
//! San Francisco is handed height above ground as a band of a finished product. The East Bay's 2021
//! flight has no such derivative — no surface model, no canopy model — and its points carry no
//! building class either: 87% of them are class 1, unclassified, which is roofs and walls and trees
//! and rooftop plant together. So the separation here is geometric rather than by class. Binning to
//! one-metre cells and keeping each cell's highest return dissolves the walls (a wall return shares
//! its cell with the roof edge above it) and the ground and water and noise leave by class, which
//! makes the 75th percentile of a footprint's cells a roof-plane statistic in all but name.
//!
//! Measured against the 32 downtown-Oakland buildings whose height is OSM-tagged: median error
//! -3.3 m, mean absolute 5.7 m. The percentile is what buys that. Taking the maximum instead reads
//! the masts — one downtown roof at 84 m carries a return at 126.7 m — and taking the median reads
//! the podium a merged tower-plus-podium footprint is mostly made of.
//!
//! Two mosaics come out, not one: the surface above ground, and the ground itself. The second is
//! what a building's base elevation is read from, and it is where the flight's own ground returns
//! stand in for the DEM — the survey staged no tile for the bay-dominated squares, which is where
//! Oakland airport and Bay Farm Island are.
//!
//! The fetcher is scripts/lidar.ts, as ever: everything here reads cached files off disk.

use std::collections::VecDeque;
use std::f64::consts::PI;
use std::fs;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use las::Reader;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tiff::encoder::{Compression, TiffEncoder, colortype};
use tiff::tags::Tag;

use crate::Fallible;
use crate::binfmt::{Coord, Polygon};
use crate::dem::{Dem, TileGrid, read_tile_grid};
use crate::heights::{self, Source, Tmerc};

/// Web mercator, which is what an EPT index publishes its points in whatever grid they were flown
/// on, so every point is projected back out of it before it is binned.
const EARTH_RADIUS_METERS: f64 = 6_378_137.0;
const MERCATOR_HALF_WIDTH_METERS: f64 = 20_037_508.342_789_244;

/// The one class this flight puts anything above the ground in: unclassified. Ground is 2, water 9,
/// noise 7 and 18 — those run from -99 m to +253 m and dropping them is not optional — and there is
/// no building or vegetation class at all.
const SURFACE_CLASS: u8 = 1;
/// Bare earth. Only read where the survey staged no DEM tile to subtract.
const GROUND_CLASS: u8 = 2;

const CELL_METERS: f64 = 1.0;

/// The side of one written tile. Chosen to be the band height `crates/tiler/src/heights.rs` walks a
/// mosaic in: a taller tile would be decoded once per band it spans, and these are 1 m cells, so a
/// tile the size of the DEM's own 10 km squares would be decoded twenty times and hold 400 MB of
/// float32 each time.
const TILE_METERS: f64 = 500.0;

/// The side of the staged DEM's naming grid. One block of work is one of these squares: it is the
/// largest area that is covered by a single staged tile, and so the largest that can be binned and
/// differenced for one decode of one 400 MB tile.
const SQUARE_METERS: f64 = 10_000.0;

/// Written where no return landed or no ground was known, and below the -9000 every reader here
/// treats as nodata.
const NODATA_METERS: f32 = -9999.0;

/// How far past the window's corners the grid reaches. The window is a longitude/latitude rectangle
/// and the grid is a UTM one, and the ground the two disagree over at the corners is the grid
/// convergence — about half a degree of rotation this far off the central meridian, which over a
/// kilometre of window is metres.
const MARGIN_METERS: f64 = 16.0;

const ROOF_PERCENTILE: f64 = 0.75;
/// A building stands on one ground height, and the cells under its footprint disagree by whatever
/// the terrain does across it. The middle one is the least surprising answer, and it is the
/// statistic the bare-earth DEM is interpolated to give under a building in the first place.
const GROUND_PERCENTILE: f64 = 0.5;

/// Taller than any building on earth, so the cell filter that keeps a crown pass honest is
/// effectively off here. It is not zero work: the surface model measures whatever returned, and a
/// residual noise return inside a footprint would otherwise be a roof.
const IMPLAUSIBLE_ROOF_METERS: f64 = 600.0;
/// The same filter over the ground mosaic, above the highest ground any city sits on.
const IMPLAUSIBLE_GROUND_METERS: f64 = 4_000.0;

/// How far the flight's own ground returns are carried into a cell that has none, where there is no
/// staged DEM tile to ask instead. Ground is continuous and the returns are dense, so this only ever
/// bridges a building's own footprint or a patch of water; past it the ground stays unknown and the
/// surface above it is not written at all.
const MAX_FILL_RINGS: usize = 64;

/// A published height this far under the measured one is a building that did not exist when the
/// flight happened, not a mismeasurement — the two downtown cases read 13.1 m against 120.4 and
/// 1.6 m against 73. They are held out of the error summary rather than counted as error.
const CONSTRUCTION_RATIO: f64 = 0.5;
const CONSTRUCTION_METERS: f64 = 20.0;

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// One cached point-cloud node and the ground its octree cube covers. The bounds are the fetcher's,
/// taken from the cube rather than from the points, so they are a superset and never cut a return.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Node {
    path: PathBuf,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    /// The cached EPT nodes, decoded and binned together. Their point coverage may overlap; taking
    /// the highest return per cell is idempotent under a duplicated point, so nothing is deduped.
    nodes: Vec<Node>,
    /// The staged bare-earth DEM tiles the surface is differenced against. A square of the window
    /// none of them covers is filled from the cloud's own ground returns instead.
    dem: Vec<PathBuf>,
    /// What heights.rs calls the projection the DEM is published on, which the surface model is
    /// binned onto so the two subtract cell for cell.
    crs: String,
    window: Window,
    /// The directory the two mosaics are written under, as `ndsm/` and `ground/`.
    out: PathBuf,
    /// GeoJSON footprints to sample the finished mosaics under. Absent, the rasters are written and
    /// nothing is measured.
    #[serde(default)]
    footprints: Option<PathBuf>,
    /// Where the per-footprint readings are written for the ingest to merge and encode.
    #[serde(default)]
    heights: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    nodes: usize,
    squares: usize,
    /// Squares of the window the survey staged no DEM tile for, whose ground is the flight's own.
    filled_squares: usize,
    points: u64,
    /// Points of `SURFACE_CLASS` that landed in a grid.
    surface_points: u64,
    tiles: usize,
    /// Cells holding a return, and of those the ones a ground height was known under.
    returned: u64,
    grounded: u64,
    footprints: usize,
    measured: usize,
    based: usize,
}

/// A rectangle of the output grid: the upper-left corner of cell (0, 0) at the origin, one metre
/// cells, row-major, in the DEM's own projection.
struct Grid {
    origin_x: f64,
    origin_y: f64,
    width: usize,
    height: usize,
}

impl Grid {
    /// The whole window, snapped out to the tile grid the mosaic is written on so that every tile
    /// of it lands on a whole multiple of `TILE_METERS` — which is what lets tiles binned in
    /// different squares be read back as one mosaic.
    fn over(window: &Window, projection: Tmerc) -> Grid {
        // Edges as well as corners: a longitude/latitude rectangle is not a rectangle on the grid,
        // and its widest point is in the middle of an edge rather than at a corner.
        let lngs = [window.west, (window.west + window.east) / 2.0, window.east];
        let lats = [
            window.south,
            (window.south + window.north) / 2.0,
            window.north,
        ];
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for lng in lngs {
            for lat in lats {
                let (x, y) = projection.forward(lng, lat);
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
        let west = ((min_x - MARGIN_METERS) / TILE_METERS).floor() * TILE_METERS;
        let east = ((max_x + MARGIN_METERS) / TILE_METERS).ceil() * TILE_METERS;
        let south = ((min_y - MARGIN_METERS) / TILE_METERS).floor() * TILE_METERS;
        let north = ((max_y + MARGIN_METERS) / TILE_METERS).ceil() * TILE_METERS;
        Grid {
            origin_x: west,
            origin_y: north,
            width: ((east - west) / CELL_METERS) as usize,
            height: ((north - south) / CELL_METERS) as usize,
        }
    }

    fn min_x(&self) -> f64 {
        self.origin_x
    }

    fn max_x(&self) -> f64 {
        self.origin_x + self.width as f64 * CELL_METERS
    }

    fn max_y(&self) -> f64 {
        self.origin_y
    }

    fn min_y(&self) -> f64 {
        self.origin_y - self.height as f64 * CELL_METERS
    }

    /// The part of this grid inside a rectangle, or nothing where the two do not meet.
    fn clipped(&self, west: f64, south: f64, east: f64, north: f64) -> Option<Grid> {
        let west = self.min_x().max(west);
        let east = self.max_x().min(east);
        let south = self.min_y().max(south);
        let north = self.max_y().min(north);
        if east <= west || north <= south {
            None
        } else {
            Some(Grid {
                origin_x: west,
                origin_y: north,
                width: ((east - west) / CELL_METERS) as usize,
                height: ((north - south) / CELL_METERS) as usize,
            })
        }
    }

    fn cell_of(&self, x: f64, y: f64) -> Option<usize> {
        let column = ((x - self.origin_x) / CELL_METERS).floor();
        let row = ((self.origin_y - y) / CELL_METERS).floor();
        if column < 0.0 || row < 0.0 || column >= self.width as f64 || row >= self.height as f64 {
            None
        } else {
            Some(row as usize * self.width + column as usize)
        }
    }
}

/// Web mercator metres back to degrees, the closed form.
fn to_degrees(x: f64, y: f64) -> (f64, f64) {
    let lng = x * 180.0 / MERCATOR_HALF_WIDTH_METERS;
    let lat = (2.0 * (y / EARTH_RADIUS_METERS).exp().atan() - PI / 2.0).to_degrees();
    (lng, lat)
}

/// A height as a u32 that sorts the way the height does, so a cell's maximum is one `fetch_max` on a
/// shared grid rather than one whole grid per worker. 0 stays free to mean "no return": it decodes
/// to a NaN, which no LiDAR return is.
fn ordered(meters: f32) -> u32 {
    let bits = meters.to_bits();
    if bits & 0x8000_0000 == 0 {
        bits | 0x8000_0000
    } else {
        !bits
    }
}

fn from_ordered(key: u32) -> f32 {
    if key & 0x8000_0000 == 0 {
        f32::from_bits(!key)
    } else {
        f32::from_bits(key & 0x7fff_ffff)
    }
}

/// A node's own extent on the output grid, so a block decodes only the nodes that reach it. The
/// cube is axis-aligned in web mercator and the grid is not, so the projected box is taken over the
/// edges too and margined by the same convergence the window is.
struct Reach {
    path: PathBuf,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

fn reach_of(node: &Node, projection: Tmerc) -> Reach {
    let lngs = [node.west, (node.west + node.east) / 2.0, node.east];
    let lats = [node.south, (node.south + node.north) / 2.0, node.north];
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for lng in lngs {
        for lat in lats {
            let (x, y) = projection.forward(lng, lat);
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
    }
    Reach {
        path: node.path.clone(),
        min_x: min_x - MARGIN_METERS,
        max_x: max_x + MARGIN_METERS,
        min_y: min_y - MARGIN_METERS,
        max_y: max_y + MARGIN_METERS,
    }
}

struct Binned {
    /// Per cell, the highest surface return as an `ordered` key, or 0 for none.
    surface: Vec<u32>,
    /// Per cell, the ground returns' total in decimetres and how many there were — read only where
    /// there is no staged DEM tile, and empty otherwise. At this flight's spacing a cell holds one
    /// or two ground returns, so their mean is their median.
    ground_sum: Vec<u32>,
    ground_count: Vec<u32>,
    points: u64,
    surface_points: u64,
    /// How many points of each classification landed in the grid. The flight's own summary of what
    /// it thinks it flew over, and the reason the surface has to be separated geometrically.
    classes: [u64; 256],
}

/// Every reaching node's returns binned to one block of the grid: the highest surface-class return
/// per cell, and — where the ground has to come from the cloud — the ground-class returns beside it.
fn bin(nodes: &[&Reach], grid: &Grid, projection: Tmerc, from_cloud: bool) -> Fallible<Binned> {
    let cells = grid.width * grid.height;
    let surface: Vec<AtomicU32> = (0..cells).map(|_| AtomicU32::new(0)).collect();
    let ground_sum: Vec<AtomicU32> = (0..if from_cloud { cells } else { 0 })
        .map(|_| AtomicU32::new(0))
        .collect();
    let ground_count: Vec<AtomicU32> = (0..if from_cloud { cells } else { 0 })
        .map(|_| AtomicU32::new(0))
        .collect();
    let tallies = nodes
        .par_iter()
        .map(|node| -> Fallible<(u64, u64, [u64; 256])> {
            let path = &node.path;
            let points = Reader::from_path(path)
                .map_err(|error| format!("{}: {error}", path.display()))?
                .read_all()
                .map_err(|error| format!("{}: {error}", path.display()))?;
            let mut inside = 0u64;
            let mut counted = 0u64;
            let mut classes = [0u64; 256];
            for (((x, y), z), class) in points
                .x()
                .zip(points.y())
                .zip(points.z())
                .zip(points.classification())
            {
                let (lng, lat) = to_degrees(x, y);
                let (east, north) = projection.forward(lng, lat);
                let Some(cell) = grid.cell_of(east, north) else {
                    continue;
                };
                inside += 1;
                classes[class as usize] += 1;
                if class == SURFACE_CLASS {
                    counted += 1;
                    surface[cell].fetch_max(ordered(z as f32), Ordering::Relaxed);
                } else if from_cloud && class == GROUND_CLASS {
                    let decimetres = (z * 10.0).round().clamp(0.0, f64::from(u32::MAX / 2)) as u32;
                    ground_sum[cell].fetch_add(decimetres, Ordering::Relaxed);
                    ground_count[cell].fetch_add(1, Ordering::Relaxed);
                }
            }
            Ok((inside, counted, classes))
        })
        .collect::<Fallible<Vec<(u64, u64, [u64; 256])>>>()?;

    let mut binned = Binned {
        surface: surface.into_iter().map(AtomicU32::into_inner).collect(),
        ground_sum: ground_sum.into_iter().map(AtomicU32::into_inner).collect(),
        ground_count: ground_count
            .into_iter()
            .map(AtomicU32::into_inner)
            .collect(),
        points: 0,
        surface_points: 0,
        classes: [0u64; 256],
    };
    for (inside, counted, classes) in tallies {
        binned.points += inside;
        binned.surface_points += counted;
        for (total, count) in binned.classes.iter_mut().zip(classes) {
            *total += count;
        }
    }
    Ok(binned)
}

/// Carries each known height out to the unknown cells nearest it, breadth first, so a cell with no
/// ground under it takes the ground of the closest cell that has one. Bounded, because past a
/// certain distance there is nothing to interpolate between — that is a hole in the flight rather
/// than a building's own footprint.
fn fill_nearest(values: &mut [f32], width: usize, height: usize, rings: usize) {
    // Seeded with the known cells that touch an unknown one rather than with every known cell: a
    // ten-kilometre square holds a hundred million of them, and the ones in the middle of a known
    // patch have nothing to carry their height to.
    let mut frontier: VecDeque<(usize, usize)> = VecDeque::new();
    for index in 0..values.len() {
        let row = index / width;
        let column = index % width;
        let edge = (column > 0 && !values[index - 1].is_finite())
            || (column + 1 < width && !values[index + 1].is_finite())
            || (row > 0 && !values[index - width].is_finite())
            || (row + 1 < height && !values[index + width].is_finite());
        if values[index].is_finite() && edge {
            frontier.push_back((index, 0));
        }
    }
    while let Some((index, ring)) = frontier.pop_front() {
        if ring >= rings {
            continue;
        }
        let value = values[index];
        let row = index / width;
        let column = index % width;
        let mut spread = |neighbour: usize, values: &mut [f32]| {
            if !values[neighbour].is_finite() {
                values[neighbour] = value;
                frontier.push_back((neighbour, ring + 1));
            }
        };
        if column > 0 {
            spread(index - 1, values);
        }
        if column + 1 < width {
            spread(index + 1, values);
        }
        if row > 0 {
            spread(index - width, values);
        }
        if row + 1 < height {
            spread(index + width, values);
        }
    }
}

/// The ground under one block: the staged DEM where the survey has one, and the flight's own
/// ground-classified returns where it has not.
fn ground_of(
    grid: &Grid,
    staged: Option<&TileGrid>,
    projection: Tmerc,
    binned: &Binned,
) -> Fallible<Vec<f32>> {
    let mut ground = match staged {
        Some(tile) => {
            let mut dem = Dem::open(std::slice::from_ref(&tile.path), projection, 0)?;
            let sampled = dem.sample_grid(
                grid.origin_x,
                grid.origin_y,
                CELL_METERS,
                grid.width,
                grid.height,
            )?;
            dem.release();
            sampled
        }
        None => vec![f32::NAN; grid.width * grid.height],
    };
    if !binned.ground_count.is_empty() {
        for (index, height) in ground.iter_mut().enumerate() {
            let count = binned.ground_count[index];
            if !height.is_finite() && count > 0 {
                *height = binned.ground_sum[index] as f32 / count as f32 / 10.0;
            }
        }
        fill_nearest(&mut ground, grid.width, grid.height, MAX_FILL_RINGS);
    }
    Ok(ground)
}

/// The raster, as the two tags `dem.rs` needs to georeference it and nothing else: a GeoTIFF's CRS
/// lives in keys this never writes, which is why every reader here is handed a projection by name.
fn write_raster(
    path: &Path,
    origin_x: f64,
    origin_y: f64,
    side: usize,
    values: &[f32],
) -> Fallible<()> {
    let mut encoder =
        TiffEncoder::new(BufWriter::new(File::create(path)?))?.with_compression(Compression::Lzw);
    let mut image = encoder.new_image::<colortype::Gray32Float>(side as u32, side as u32)?;
    image.encoder().write_tag(
        Tag::ModelPixelScaleTag,
        &[CELL_METERS, CELL_METERS, 0.0][..],
    )?;
    image.encoder().write_tag(
        Tag::ModelTiepointTag,
        &[0.0, 0.0, 0.0, origin_x, origin_y, 0.0][..],
    )?;
    image.write_data(values)?;
    Ok(())
}

/// What one block wrote: the tiles of each mosaic, and how much of it held anything.
struct Written {
    ndsm: Vec<PathBuf>,
    ground: Vec<PathBuf>,
    returned: u64,
    grounded: u64,
}

/// The block cut into the tiles the mosaic is read back as. A tile no return landed in is not
/// written at all — most of this window is water — and its ground is not written either, so the two
/// mosaics stay tile for tile the same.
fn write_tiles(
    grid: &Grid,
    binned: &Binned,
    ground: &[f32],
    ndsm_dir: &Path,
    ground_dir: &Path,
) -> Fallible<Written> {
    let side = (TILE_METERS / CELL_METERS) as usize;
    if !grid.width.is_multiple_of(side) || !grid.height.is_multiple_of(side) {
        return Err(format!(
            "a {} x {} block does not divide into {side} m tiles",
            grid.width, grid.height
        )
        .into());
    }
    let across = grid.width / side;
    let down = grid.height / side;
    let tiles: Vec<(usize, usize)> = (0..down)
        .flat_map(|row| (0..across).map(move |column| (row, column)))
        .collect();
    let written = tiles
        .par_iter()
        .map(|&(row, column)| -> Fallible<Written> {
            let origin_x = grid.origin_x + (column * side) as f64 * CELL_METERS;
            let origin_y = grid.origin_y - (row * side) as f64 * CELL_METERS;
            let mut heights = vec![NODATA_METERS; side * side];
            let mut grounds = vec![NODATA_METERS; side * side];
            let mut returned = 0u64;
            let mut grounded = 0u64;
            for line in 0..side {
                let from = (row * side + line) * grid.width + column * side;
                for step in 0..side {
                    let key = binned.surface[from + step];
                    let base = ground[from + step];
                    if base.is_finite() {
                        grounds[line * side + step] = base;
                    }
                    if key != 0 {
                        returned += 1;
                        if base.is_finite() {
                            grounded += 1;
                            heights[line * side + step] = from_ordered(key) - base;
                        }
                    }
                }
            }
            if grounded == 0 {
                return Ok(Written {
                    ndsm: Vec::new(),
                    ground: Vec::new(),
                    returned,
                    grounded,
                });
            }
            let name = format!("{}-{}.tif", origin_x as i64, origin_y as i64);
            let ndsm = ndsm_dir.join(&name);
            let base = ground_dir.join(&name);
            write_raster(&ndsm, origin_x, origin_y, side, &heights)?;
            write_raster(&base, origin_x, origin_y, side, &grounds)?;
            Ok(Written {
                ndsm: vec![ndsm],
                ground: vec![base],
                returned,
                grounded,
            })
        })
        .collect::<Fallible<Vec<Written>>>()?;
    let mut total = Written {
        ndsm: Vec::new(),
        ground: Vec::new(),
        returned: 0,
        grounded: 0,
    };
    for one in written {
        total.ndsm.extend(one.ndsm);
        total.ground.extend(one.ground);
        total.returned += one.returned;
        total.grounded += one.grounded;
    }
    Ok(total)
}

/// One building the rasters are sampled under, and whatever height its source already carried —
/// which is not used to measure anything here, only to report how far the measurement lands from it
/// and to be merged with it by the ingest.
struct Footprint {
    /// Which feature of the file this came from, so the ingest can put the reading back on its own
    /// building rather than on the one that happened to sort here.
    feature: usize,
    polygon: Polygon,
    name: Option<String>,
    published_meters: Option<f64>,
    /// Whether that published height came from OpenStreetMap rather than a machine-learning model.
    /// The distinction is the whole reason to measure: the ML heights in this county cap out at
    /// 32.5 m, and the OSM ones are surveyed tags on the towers.
    surveyed: bool,
}

fn ring_of(coordinates: &serde_json::Value) -> Vec<Coord> {
    coordinates
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|point| {
            let pair = point.as_array()?;
            Some(Coord {
                lng: pair.first()?.as_f64()?,
                lat: pair.get(1)?.as_f64()?,
            })
        })
        .collect()
}

/// GeoJSON footprints, kept to the ones lying wholly inside the window: a polygon crossing the edge
/// would be measured over the cells that made it into the grid and read as a fraction of a building.
fn read_footprints(path: &Path, window: &Window) -> Fallible<Vec<Footprint>> {
    let document: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
    let mut footprints = Vec::new();
    for (feature, value) in document["features"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let geometry = &value["geometry"];
        let parts: Vec<Polygon> = match geometry["type"].as_str() {
            Some("Polygon") => vec![
                geometry["coordinates"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(ring_of)
                    .collect(),
            ],
            Some("MultiPolygon") => geometry["coordinates"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|part| part.as_array().into_iter().flatten().map(ring_of).collect())
                .collect(),
            _ => Vec::new(),
        };
        let properties = &value["properties"];
        for polygon in parts {
            let inside = polygon.iter().flatten().all(|point| {
                point.lng >= window.west
                    && point.lng <= window.east
                    && point.lat >= window.south
                    && point.lat <= window.north
            });
            if inside && !polygon.is_empty() {
                footprints.push(Footprint {
                    feature,
                    polygon,
                    name: properties["name"].as_str().map(String::from),
                    published_meters: properties["height"].as_f64(),
                    surveyed: properties["surveyed"].as_bool().unwrap_or(false),
                });
            }
        }
    }
    Ok(footprints)
}

fn quantile(sorted: &[f64], quantile: f64) -> f64 {
    let rank = (sorted.len() as f64 * quantile).ceil() as usize;
    sorted.get(rank.max(1) - 1).copied().unwrap_or(f64::NAN)
}

/// How far the measurement lands from the published heights that are worth comparing against, at
/// each of the percentiles the choice of statistic was made between.
fn describe_errors(footprints: &[Footprint], readings: &[Vec<u16>]) {
    let mut compared = 0;
    let mut construction = 0;
    let mut errors: Vec<(f64, Vec<f64>)> = [0.5, ROOF_PERCENTILE, 0.9, 0.98]
        .into_iter()
        .map(|percentile| (percentile, Vec::new()))
        .collect();
    for (footprint, sample) in footprints.iter().zip(readings) {
        let (Some(published), true) = (footprint.published_meters, footprint.surveyed) else {
            continue;
        };
        if sample.is_empty() {
            continue;
        }
        let at = |percentile: f64| f64::from(heights::percentile_dm(sample, percentile)) / 10.0;
        if published > CONSTRUCTION_METERS && at(0.9) < CONSTRUCTION_RATIO * published {
            construction += 1;
            continue;
        }
        compared += 1;
        for (percentile, collected) in &mut errors {
            collected.push(at(*percentile) - published);
        }
    }
    eprintln!(
        "  against {compared} surveyed heights, {construction} held out as built after the flight:"
    );
    for (percentile, collected) in &mut errors {
        let mut absolute: Vec<f64> = collected.iter().map(|error| error.abs()).collect();
        collected.sort_by(f64::total_cmp);
        absolute.sort_by(f64::total_cmp);
        eprintln!(
            "    p{:.0}: median {:+.2} m, mean absolute {:.2} m, p90 absolute {:.2} m",
            *percentile * 100.0,
            quantile(collected, 0.5),
            absolute.iter().sum::<f64>() / absolute.len().max(1) as f64,
            quantile(&absolute, 0.9),
        );
    }
}

/// The tallest measurements, named — the check a numeric summary cannot make, because a raster
/// offset by a block still has a plausible height distribution and puts the tower on the wrong
/// polygon.
fn describe_tallest(footprints: &[Footprint], readings: &[Vec<u16>], count: usize) {
    let mut tallest: Vec<(f64, &Footprint)> = footprints
        .iter()
        .zip(readings)
        .map(|(footprint, sample)| {
            (
                f64::from(heights::percentile_dm(sample, ROOF_PERCENTILE)) / 10.0,
                footprint,
            )
        })
        .collect();
    tallest.sort_by(|left, right| right.0.total_cmp(&left.0));
    for (height, footprint) in tallest.iter().take(count) {
        eprintln!(
            "  {height:6.1} m  {} (published {})",
            footprint.name.as_deref().unwrap_or("unnamed"),
            footprint
                .published_meters
                .map_or("none".to_string(), |published| format!("{published:.1} m")),
        );
    }
}

/// What one footprint measured, for the ingest to merge with what its source published.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reading {
    feature: usize,
    /// The 75th percentile of the surface cells inside the footprint, in metres, or absent where it
    /// caught none.
    roof_meters: Option<f64>,
    /// The median of the ground cells under it, likewise.
    base_meters: Option<f64>,
    cells: u32,
}

/// Which staged tile covers a square whole. Not "reaches": the tiles overlap their neighbours by a
/// few metres, so a square is inside exactly one of them, and reading a block from the one that only
/// laps its edge would leave most of it unknown.
fn covering<'a>(tiles: &'a [TileGrid], grid: &Grid) -> Option<&'a TileGrid> {
    tiles.iter().find(|tile| {
        tile.contains(grid.min_x() + 0.5, grid.max_y() - 0.5)
            && tile.contains(grid.max_x() - 0.5, grid.min_y() + 0.5)
    })
}

pub fn run(params_file: &Path, report_file: &Path) -> Fallible<()> {
    let params: Params = serde_json::from_slice(&fs::read(params_file)?)?;
    let projection = heights::projection(&params.crs)?;
    let whole = Grid::over(&params.window, projection);
    let staged: Vec<TileGrid> = params
        .dem
        .iter()
        .map(|path| read_tile_grid(path))
        .collect::<Fallible<Vec<TileGrid>>>()?;
    let reaches: Vec<Reach> = params
        .nodes
        .iter()
        .map(|node| reach_of(node, projection))
        .collect();
    let ndsm_dir = params.out.join("ndsm");
    let ground_dir = params.out.join("ground");
    fs::create_dir_all(&ndsm_dir)?;
    fs::create_dir_all(&ground_dir)?;
    eprintln!(
        "  ndsm: {} x {} m over ({}, {}), from {} point-cloud nodes and {} staged ground tiles",
        whole.width,
        whole.height,
        whole.origin_x,
        whole.origin_y,
        reaches.len(),
        staged.len(),
    );

    let mut report = Report {
        nodes: params.nodes.len(),
        squares: 0,
        filled_squares: 0,
        points: 0,
        surface_points: 0,
        tiles: 0,
        returned: 0,
        grounded: 0,
        footprints: 0,
        measured: 0,
        based: 0,
    };
    let mut classes = [0u64; 256];
    let mut ndsm_tiles: Vec<PathBuf> = Vec::new();
    let mut ground_tiles: Vec<PathBuf> = Vec::new();
    let columns = (whole.width as f64 * CELL_METERS / SQUARE_METERS).ceil() as usize;
    let rows = (whole.height as f64 * CELL_METERS / SQUARE_METERS).ceil() as usize;
    let squares = rows * columns;
    for row in 0..rows {
        for column in 0..columns {
            let west = whole.origin_x + column as f64 * SQUARE_METERS;
            let north = whole.origin_y - row as f64 * SQUARE_METERS;
            let Some(grid) =
                whole.clipped(west, north - SQUARE_METERS, west + SQUARE_METERS, north)
            else {
                continue;
            };
            let reaching: Vec<&Reach> = reaches
                .iter()
                .filter(|reach| {
                    reach.min_x < grid.max_x()
                        && reach.max_x > grid.min_x()
                        && reach.min_y < grid.max_y()
                        && reach.max_y > grid.min_y()
                })
                .collect();
            let cover = covering(&staged, &grid);
            if reaching.is_empty() {
                continue;
            }
            report.squares += 1;
            report.filled_squares += usize::from(cover.is_none());
            let binned = bin(&reaching, &grid, projection, cover.is_none())?;
            let ground = ground_of(&grid, cover, projection, &binned)?;
            let written = write_tiles(&grid, &binned, &ground, &ndsm_dir, &ground_dir)?;
            report.points += binned.points;
            report.surface_points += binned.surface_points;
            report.returned += written.returned;
            report.grounded += written.grounded;
            for (total, count) in classes.iter_mut().zip(binned.classes) {
                *total += count;
            }
            eprintln!(
                "  ndsm: square {}/{squares} at ({}, {}) — {} nodes, {} returned cells, {} tiles{}",
                report.squares,
                grid.origin_x as i64,
                grid.origin_y as i64,
                reaching.len(),
                written.returned,
                written.ndsm.len(),
                if cover.is_some() {
                    ""
                } else {
                    ", ground from the cloud"
                },
            );
            ndsm_tiles.extend(written.ndsm);
            ground_tiles.extend(written.ground);
        }
    }
    report.tiles = ndsm_tiles.len();
    for (class, count) in classes.iter().enumerate() {
        if *count > 0 {
            eprintln!(
                "  class {class:2}: {count:>12} points ({:.1}%)",
                100.0 * *count as f64 / report.points.max(1) as f64
            );
        }
    }
    eprintln!(
        "  ndsm: {} cells hold a return, {} of them over known ground, in {} tiles",
        report.returned, report.grounded, report.tiles
    );

    let footprints = match &params.footprints {
        Some(path) => read_footprints(path, &params.window)?,
        None => Vec::new(),
    };
    report.footprints = footprints.len();
    if !footprints.is_empty() && !ndsm_tiles.is_empty() {
        let polygons: Vec<Polygon> = footprints
            .iter()
            .map(|footprint| footprint.polygon.clone())
            .collect();
        let roofs = heights::measure(
            &polygons,
            &Source::Mosaic {
                paths: ndsm_tiles,
                band: 0,
            },
            projection,
            IMPLAUSIBLE_ROOF_METERS,
        )?;
        let bases = heights::measure(
            &polygons,
            &Source::Mosaic {
                paths: ground_tiles,
                band: 0,
            },
            projection,
            IMPLAUSIBLE_GROUND_METERS,
        )?;
        let readings: Vec<Reading> = footprints
            .iter()
            .zip(&roofs.values)
            .zip(&bases.values)
            .zip(&roofs.cells)
            .map(|(((footprint, roof), base), cells)| Reading {
                feature: footprint.feature,
                roof_meters: (!roof.is_empty())
                    .then(|| f64::from(heights::percentile_dm(roof, ROOF_PERCENTILE)) / 10.0),
                base_meters: (!base.is_empty())
                    .then(|| f64::from(heights::percentile_dm(base, GROUND_PERCENTILE)) / 10.0),
                cells: *cells,
            })
            .collect();
        report.measured = readings
            .iter()
            .filter(|reading| reading.roof_meters.is_some())
            .count();
        report.based = readings
            .iter()
            .filter(|reading| reading.base_meters.is_some())
            .count();
        eprintln!(
            "  ndsm: {} of {} footprints measured, {} of them over known ground",
            report.measured, report.footprints, report.based
        );
        describe_tallest(&footprints, &roofs.values, 12);
        describe_errors(&footprints, &roofs.values);
        if let Some(path) = &params.heights {
            if let Some(directory) = path.parent() {
                fs::create_dir_all(directory)?;
            }
            fs::write(path, serde_json::to_vec(&readings)?)?;
            eprintln!("  ndsm: wrote {}", path.display());
        }
    }

    crate::write_report(report_file, &report)
}

#[cfg(test)]
mod tests {
    use super::{fill_nearest, from_ordered, ordered, to_degrees};

    /// The key a cell's maximum is taken on has to order the way the heights do across zero, which
    /// the float's own bit pattern does not: -1 m and +1 m differ only in the sign bit.
    #[test]
    fn the_cell_key_orders_heights_the_way_they_read() {
        let heights = [-120.5f32, -1.0, -0.0, 0.0, 0.05, 1.0, 122.4, 253.0];
        for pair in heights.windows(2) {
            assert!(
                ordered(pair[0]) <= ordered(pair[1]),
                "{} sorts above {}",
                pair[0],
                pair[1]
            );
        }
        for height in heights {
            assert_eq!(from_ordered(ordered(height)), height);
        }
        assert!(from_ordered(0).is_nan(), "an empty cell reads as a height");
    }

    /// Against the forward projection scripts/lidar.ts walks the octree with, at the corners of the
    /// window it walks: the two have to agree, or the points would be binned somewhere other than
    /// where the nodes holding them were asked for.
    #[test]
    fn mercator_metres_come_back_as_the_degrees_they_were() {
        for (x, y, lng, lat) in [
            (
                -13_611_034.139_293_559,
                4_551_915.359_055_145,
                -122.27,
                37.805,
            ),
            (
                -13_609_698.305_404_041,
                4_553_042.561_245_359,
                -122.258,
                37.813,
            ),
        ] {
            let (west, north) = to_degrees(x, y);
            assert!((west - lng).abs() < 1e-9, "longitude {west} not {lng}");
            assert!((north - lat).abs() < 1e-9, "latitude {north} not {lat}");
        }
    }

    /// The ground under a building's own footprint is the one hole the fill exists to close, and it
    /// has to close it with the nearest ground rather than with the first one the sweep meets.
    #[test]
    fn the_fill_takes_the_nearest_ground_and_stops() {
        let mut ground = vec![f32::NAN; 25];
        ground[0] = 1.0;
        ground[24] = 9.0;
        fill_nearest(&mut ground, 5, 5, 8);
        assert_eq!(ground[1], 1.0, "the cell beside the 1 took something else");
        assert_eq!(ground[23], 9.0, "the cell beside the 9 took something else");

        let mut far = vec![f32::NAN; 25];
        far[0] = 1.0;
        fill_nearest(&mut far, 5, 5, 2);
        assert!(far[24].is_nan(), "ground carried past the ring limit");
        assert_eq!(far[2], 1.0, "ground not carried to the ring limit");
    }
}
