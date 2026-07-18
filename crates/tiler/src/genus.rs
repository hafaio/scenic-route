//! `tiler genus`: renders data/trees/<id>.bin into a per-tree genus map at
//! public/tiles/genus/{z}/{x}/{y}.webp. Each tree is drawn as a filled disc sized by its crown and
//! coloured by its genus — no kernel and no blend, so overlapping trees layer rather than average
//! and every genus colour stays crisp instead of muddying. See scripts/README.md.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, Trees};
use crate::geometry::Projection;
use crate::manifest::{City, Manifest};
use crate::raster::{
    EQUATOR_METERS_PER_PIXEL, MIN_ZOOM, TILE_SIZE, Tile, encode_webp, lat_to_pixel_y,
    lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat, plan_tiles,
};

// The raster half of the overlay only carries the zoomed-out view: from z15 up the client draws
// the trees live as crisp canvas discs (components/tree-dots-layer.tsx), so the pyramid stops one
// level below MAX_ZOOM rather than chasing the deep zooms a raster tile can only blur into.
const GENUS_MAX_ZOOM: u32 = 14;

// A dot never shrinks below this, so a crown that is a fraction of a pixel when zoomed out still
// shows, nor grows past the ceiling, so a lone giant crown at high zoom does not swell into a blob.
// Between the two the dot is the crown's true radius in pixels, so bigger trees read bigger.
const MIN_DOT_PX: f64 = 1.5;
const MAX_DOT_PX: f64 = 16.0;
// How opaque one tree draws. Below 1 so a dense stand layers into a slightly richer patch and the
// basemap still reads through the gaps, but high enough that each genus colour stays legible.
const DOT_ALPHA: f64 = 0.85;

/// The number of genus bins: 11 ranked genera plus an "Other" tail. Must equal GENUS_COUNT in
/// src/tree-cover/genus.ts, the palette the tiler draws each tree with.
const GENUS_BINS: usize = 12;

const BUCKET_METERS: f64 = 60.0;

pub struct Args {
    pub manifest: PathBuf,
    pub palette: PathBuf, // GENUS_BINS RGBA entries, the genus colour a dot is filled with
    pub data: PathBuf,
    pub tiles: PathBuf,
}

/// One city's genus layer: the trees in a metre-space index and the projection that placed them.
struct Genus {
    trees: TreeIndex,
    projection: Projection,
    tree_count: usize,
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

fn read_genus(city: &City, data: &Path) -> Fallible<Option<Genus>> {
    if city.field.genus.is_none() {
        return Ok(None);
    }
    let trees = binfmt::read_trees(&data.join("trees").join(&city.field.trees.file))?;
    let projection = Projection::new(&city.bounds);
    let tree_count = trees.coords.len();
    Ok(Some(Genus {
        trees: TreeIndex::new(&trees, &projection),
        projection,
        tree_count,
    }))
}

/// Composite one straight-alpha colour over a pixel: the non-premultiplied "over" operator, so a
/// dot drawn on top of an earlier one keeps its own colour where it is opaque and blends only at
/// its anti-aliased rim.
fn over(pixels: &mut [u8], pixel: usize, rgb: [u8; 3], source_alpha: f64) {
    let destination_alpha = f64::from(pixels[pixel + 3]) / 255.0;
    let out_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
    if out_alpha <= 0.0 {
        return;
    }
    for channel in 0..3 {
        let source = f64::from(rgb[channel]) / 255.0;
        let destination = f64::from(pixels[pixel + channel]) / 255.0;
        let blended = (source * source_alpha
            + destination * destination_alpha * (1.0 - source_alpha))
            / out_alpha;
        pixels[pixel + channel] = (blended * 255.0).round() as u8;
    }
    pixels[pixel + 3] = (out_alpha * 255.0).round() as u8;
}

/// Draw one city's trees onto a tile, each a genus-coloured disc. Returns whether any pixel was
/// painted. The tile's metre-space box is grown by the largest dot's reach, so a tree just off the
/// edge whose disc spills in is still drawn; each disc is clipped to the tile and its rim feathered
/// over a pixel so the dots do not read as jagged squares.
fn paint(pixels: &mut [u8], genus: &Genus, palette: &[u8], tile: &Tile) -> bool {
    let zoom = tile.zoom;
    let origin_x = f64::from(tile.x) * TILE_SIZE as f64;
    let origin_y = f64::from(tile.y) * TILE_SIZE as f64;
    let centre_lat = pixel_y_to_lat(origin_y + TILE_SIZE as f64 / 2.0, zoom);
    let meters_per_pixel =
        EQUATOR_METERS_PER_PIXEL * centre_lat.to_radians().cos() / f64::from(1u32 << zoom);

    let min_x = genus.projection.x(pixel_x_to_lng(origin_x, zoom));
    let max_x = genus
        .projection
        .x(pixel_x_to_lng(origin_x + TILE_SIZE as f64, zoom));
    let min_y = genus
        .projection
        .y(pixel_y_to_lat(origin_y + TILE_SIZE as f64, zoom));
    let max_y = genus.projection.y(pixel_y_to_lat(origin_y, zoom));
    let reach = (genus.trees.max_crown_m() / meters_per_pixel).clamp(MIN_DOT_PX, MAX_DOT_PX)
        * meters_per_pixel;

    let mut painted = false;
    genus.trees.for_each_in_box(
        min_x,
        min_y,
        max_x,
        max_y,
        reach,
        |mx, my, crown_m, genus_id| {
            let centre_px = lng_to_pixel_x(genus.projection.lng(mx), zoom) - origin_x;
            let centre_py = lat_to_pixel_y(genus.projection.lat(my), zoom) - origin_y;
            let radius = (crown_m / meters_per_pixel).clamp(MIN_DOT_PX, MAX_DOT_PX);
            let base = genus_id as usize * 4;
            let rgb = [palette[base], palette[base + 1], palette[base + 2]];

            let x0 = (centre_px - radius - 1.0).floor().max(0.0) as usize;
            let x1 = (centre_px + radius + 1.0)
                .ceil()
                .clamp(0.0, TILE_SIZE as f64) as usize;
            let y0 = (centre_py - radius - 1.0).floor().max(0.0) as usize;
            let y1 = (centre_py + radius + 1.0)
                .ceil()
                .clamp(0.0, TILE_SIZE as f64) as usize;
            for iy in y0..y1 {
                let dy = iy as f64 + 0.5 - centre_py;
                for ix in x0..x1 {
                    let dx = ix as f64 + 0.5 - centre_px;
                    let coverage = (radius + 0.5 - dx.hypot(dy)).clamp(0.0, 1.0);
                    if coverage > 0.0 {
                        over(pixels, (iy * TILE_SIZE + ix) * 4, rgb, DOT_ALPHA * coverage);
                        painted = true;
                    }
                }
            }
        },
    );
    painted
}

fn render(
    genera: &[Option<Genus>],
    palette: &[u8],
    blank: &[u8],
    directory: &Path,
    tile: &Tile,
) -> Fallible<Stats> {
    let mut pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut painted = false;
    for member in &tile.members {
        if let Some(genus) = &genera[*member] {
            painted |= paint(&mut pixels, genus, palette, tile);
        }
    }

    let rendered = if painted {
        Some(encode_webp(&pixels)?)
    } else {
        None
    };
    let webp = rendered.as_deref().unwrap_or(blank);
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.webp", tile.y)),
        webp,
    )?;
    Ok(Stats {
        tiles: 1,
        painted: usize::from(painted),
        bytes: webp.len(),
    })
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;

    let palette = fs::read(&args.palette)?;
    if palette.len() != GENUS_BINS * 4 {
        return Err(format!(
            "{} is {} bytes, not the {} of a {GENUS_BINS}-entry RGBA palette",
            args.palette.display(),
            palette.len(),
            GENUS_BINS * 4
        )
        .into());
    }

    let genera: Vec<Option<Genus>> = manifest
        .cities
        .iter()
        .map(|city| read_genus(city, &args.data))
        .collect::<Fallible<Vec<Option<Genus>>>>()?;
    if genera.iter().all(Option::is_none) {
        eprintln!("no city has a genus layer; nothing to render");
        return Ok(());
    }
    for (city, genus) in manifest.cities.iter().zip(&genera) {
        if let Some(genus) = genus {
            eprintln!("{}: {} trees", city.id, genus.tree_count);
        }
    }

    let plan = plan_tiles(&manifest.cities, GENUS_MAX_ZOOM);
    for tile in &plan {
        fs::create_dir_all(
            args.tiles
                .join(tile.zoom.to_string())
                .join(tile.x.to_string()),
        )?;
    }
    let blank = encode_webp(&vec![0u8; TILE_SIZE * TILE_SIZE * 4])?;

    eprintln!(
        "rendering {} genus tiles across {} threads",
        plan.len(),
        rayon::current_num_threads()
    );
    let stats = plan
        .par_iter()
        .map(|tile| render(&genera, &palette, &blank, &args.tiles, tile))
        .try_reduce(Stats::default, |left, right| Ok(left + right))?;

    eprintln!(
        "wrote {} genus tiles (z{MIN_ZOOM}-z{GENUS_MAX_ZOOM}, {} painted, {:.1} MiB) in {:.1}s",
        stats.tiles,
        stats.painted,
        stats.bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// The trees in a uniform metre-space index, CSR-style: bucket `row * cols + col` owns
/// `[starts[bucket], starts[bucket + 1])`. Buckets along a row are contiguous, so the scan a
/// query makes is one run per row rather than one per bucket. Each tree carries its crown radius
/// (the size the overlay draws its dot at) and its genus id (the colour), in bucket order.
pub struct TreeIndex {
    xs: Vec<f64>,
    ys: Vec<f64>,
    crown_radii_m: Vec<f64>, // in bucket order alongside xs/ys
    genus_ids: Vec<u8>,      // 0..GENUS_BINS, in the same bucket order
    starts: Vec<u32>,
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
    max_crown_m: f64, // the largest crown, so a query knows how far a dot can reach past the box
}

impl TreeIndex {
    pub fn new(trees: &Trees, projection: &Projection) -> Self {
        let tree_x: Vec<f64> = trees
            .coords
            .iter()
            .map(|tree| projection.x(tree.lng))
            .collect();
        let tree_y: Vec<f64> = trees
            .coords
            .iter()
            .map(|tree| projection.y(tree.lat))
            .collect();
        let max_crown_m = trees.crown_radii_m.iter().copied().fold(0.0, f64::max);
        let min_x = tree_x.iter().copied().fold(f64::INFINITY, f64::min);
        let min_y = tree_y.iter().copied().fold(f64::INFINITY, f64::min);
        let max_x = tree_x.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let max_y = tree_y.iter().copied().fold(f64::NEG_INFINITY, f64::max);

        let cols = (((max_x - min_x) / BUCKET_METERS).floor() as usize + 1).max(1);
        let rows = (((max_y - min_y) / BUCKET_METERS).floor() as usize + 1).max(1);
        let mut starts = vec![0u32; cols * rows + 1];
        let buckets: Vec<usize> = (0..trees.coords.len())
            .map(|tree| {
                let col = ((tree_x[tree] - min_x) / BUCKET_METERS).floor() as usize;
                let row = ((tree_y[tree] - min_y) / BUCKET_METERS).floor() as usize;
                row * cols + col
            })
            .collect();
        for bucket in &buckets {
            starts[bucket + 1] += 1;
        }
        for bucket in 0..cols * rows {
            starts[bucket + 1] += starts[bucket];
        }

        let mut xs = vec![0.0; trees.coords.len()];
        let mut ys = vec![0.0; trees.coords.len()];
        let mut crown_radii_m = vec![0.0; trees.coords.len()];
        let mut genus_ids = vec![0u8; trees.coords.len()];
        let mut cursors = starts.clone();
        for (tree, bucket) in buckets.iter().enumerate() {
            let slot = cursors[*bucket] as usize;
            cursors[*bucket] += 1;
            xs[slot] = tree_x[tree];
            ys[slot] = tree_y[tree];
            crown_radii_m[slot] = trees.crown_radii_m[tree];
            genus_ids[slot] = trees.genus_ids[tree];
        }
        Self {
            xs,
            ys,
            crown_radii_m,
            genus_ids,
            starts,
            cols,
            rows,
            min_x,
            min_y,
            max_crown_m,
        }
    }

    pub fn max_crown_m(&self) -> f64 {
        self.max_crown_m
    }

    /// Every tree whose metre-space position lies within `reach` of the box, handed to `visit` as
    /// (x, y, crown_radius_m, genus_id). `reach` is the largest dot radius in metres, so a tree just
    /// outside the tile whose dot still spills into it is included. The bucket scan overshoots the
    /// box by up to a bucket, so each tree is tested against the grown box before it is visited.
    pub fn for_each_in_box(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        reach: f64,
        mut visit: impl FnMut(f64, f64, f64, u8),
    ) {
        let Some((low_col, high_col, low_row, high_row)) =
            self.span(min_x, min_y, max_x, max_y, reach)
        else {
            return;
        };
        let (low_x, high_x, low_y, high_y) =
            (min_x - reach, max_x + reach, min_y - reach, max_y + reach);
        for row in low_row..=high_row {
            let base = row * self.cols;
            let from = self.starts[base + low_col] as usize;
            let to = self.starts[base + high_col + 1] as usize;
            for tree in from..to {
                let x = self.xs[tree];
                let y = self.ys[tree];
                if x >= low_x && x <= high_x && y >= low_y && y <= high_y {
                    visit(x, y, self.crown_radii_m[tree], self.genus_ids[tree]);
                }
            }
        }
    }

    // The buckets a box grown by `radius` reaches, or None when it reaches none of them.
    fn span(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        radius: f64,
    ) -> Option<(usize, usize, usize, usize)> {
        let low_col = ((min_x - radius - self.min_x) / BUCKET_METERS)
            .floor()
            .max(0.0);
        let high_col = ((max_x + radius - self.min_x) / BUCKET_METERS)
            .floor()
            .min((self.cols - 1) as f64);
        let low_row = ((min_y - radius - self.min_y) / BUCKET_METERS)
            .floor()
            .max(0.0);
        let high_row = ((max_y + radius - self.min_y) / BUCKET_METERS)
            .floor()
            .min((self.rows - 1) as f64);
        if low_col > high_col || low_row > high_row {
            None
        } else {
            Some((
                low_col as usize,
                high_col as usize,
                low_row as usize,
                high_row as usize,
            ))
        }
    }
}
