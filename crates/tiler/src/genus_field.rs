//! `tiler genus-field`: the low-zoom genus overlay as CLIENT-SHADED data tiles, replacing the split
//! per-genus colour pyramids `tiler genus` bakes. Where those pre-colour each tree's disc and lean on
//! the client to alpha-stack the enabled layers — which can only add ink, never renormalise — this
//! bakes the raw material and defers the colouring: each tile channel carries ONE genus's local crown
//! density (12 genera packed 4 to an RGBA tile, so 3 tiles cover them all), and the client's shader
//! reads the enabled channels to pick the dominant genus, dither it against the runner-up, and fade
//! by the total density. That moves the dominance decision from bake time to render time, so toggling
//! a genus recolours live and a region hands off to its runner-up instead of going blank.
//!
//! The tiles are DATA, not colour, so they are encoded lossless — a lossy byte would misread as a
//! different density. See components/genus-gl-layer.tsx for the reader and scripts/README.md.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt;
use crate::binfmt::Trees;
use crate::geometry::Projection;
use crate::manifest::{City, Manifest};
use crate::raster::{
    EQUATOR_METERS_PER_PIXEL, MIN_ZOOM, TILE_SIZE, Tile, encode_webp_lossless, lat_to_pixel_y,
    lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat, plan_tiles,
};

// Matches `tiler genus`: the raster half stops at z14 and the client's live dots take over at z15.
const GENUS_MAX_ZOOM: u32 = 14;

// A crown's disc, in pixels, is clamped to this band just as the colour pyramid clamps it: a floor so
// a sub-pixel crown at low zoom still deposits density, a ceiling so a lone giant crown does not smear.
const MIN_DOT_PX: f64 = 1.5;
const MAX_DOT_PX: f64 = 16.0;

/// The 11 ranked genera plus the "Other" tail — must equal GENUS_COUNT in src/tree-cover/genus.ts.
const GENUS_BINS: usize = 12;
/// Three genus densities pack into one tile's R, G, B; the alpha stays opaque. Data goes in RGB, NOT
/// alpha, because a browser premultiplies RGB by alpha when it decodes the image — which would corrupt
/// the other genera's densities wherever a genus-in-alpha read below full. So ceil(12 / 3) = 4 tiles.
const GENERA_PER_TILE: usize = 3;
const LAYERS: usize = GENUS_BINS.div_ceil(GENERA_PER_TILE);

// The metre-space bucket edge the tree index sorts into, so a box query scans one run per row.
const BUCKET_METERS: f64 = 60.0;

// The accumulated crown coverage that quantizes to a full density byte (255). One opaque crown
// deposits coverage 1 at its centre, so 2.5 means "about two or three crowns deep reads as full" —
// the point where a channel saturates. Ratios below it are preserved, so the client's dither and
// dominance stay faithful; only the very densest stands clip, which still read as fully dominant.
const DENSITY_FULL: f32 = 2.5;

pub struct Args {
    pub manifest: PathBuf,
    pub data: PathBuf,
    pub tiles: PathBuf,
}

/// One city's trees in metre space, plus the projection that placed them.
struct Field {
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

fn read_field(city: &City, data: &Path) -> Fallible<Option<Field>> {
    if city.field.genus.is_none() {
        return Ok(None);
    }
    let trees = binfmt::read_trees(&data.join("trees").join(&city.field.trees.file))?;
    let projection = Projection::new(&city.bounds);
    Ok(Some(Field {
        tree_count: trees.coords.len(),
        trees: TreeIndex::new(&trees, &projection),
        projection,
    }))
}

/// Accumulate one city's crown coverage into a tile's per-genus density buffer (`GENUS_BINS` floats
/// per pixel). Every tree adds its disc's anti-aliased coverage into its own genus channel — additive,
/// so overlapping crowns of a genus build density and crowns of different genera are kept apart per
/// channel rather than compositing into one colour. Mirrors the disc geometry of `tiler genus`.
fn accumulate(density: &mut [f32], field: &Field, tile: &Tile) {
    let zoom = tile.zoom;
    let origin_x = f64::from(tile.x) * TILE_SIZE as f64;
    let origin_y = f64::from(tile.y) * TILE_SIZE as f64;
    let centre_lat = pixel_y_to_lat(origin_y + TILE_SIZE as f64 / 2.0, zoom);
    let meters_per_pixel =
        EQUATOR_METERS_PER_PIXEL * centre_lat.to_radians().cos() / f64::from(1u32 << zoom);

    let min_x = field.projection.x(pixel_x_to_lng(origin_x, zoom));
    let max_x = field
        .projection
        .x(pixel_x_to_lng(origin_x + TILE_SIZE as f64, zoom));
    let min_y = field
        .projection
        .y(pixel_y_to_lat(origin_y + TILE_SIZE as f64, zoom));
    let max_y = field.projection.y(pixel_y_to_lat(origin_y, zoom));
    let reach = (field.trees.max_crown_m() / meters_per_pixel).clamp(MIN_DOT_PX, MAX_DOT_PX)
        * meters_per_pixel;

    field.trees.for_each_in_box(
        min_x,
        min_y,
        max_x,
        max_y,
        reach,
        |mx, my, crown_m, genus_id| {
            let genus = genus_id as usize;
            if genus >= GENUS_BINS {
                return;
            }
            let centre_px = lng_to_pixel_x(field.projection.lng(mx), zoom) - origin_x;
            let centre_py = lat_to_pixel_y(field.projection.lat(my), zoom) - origin_y;
            let radius = (crown_m / meters_per_pixel).clamp(MIN_DOT_PX, MAX_DOT_PX);

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
                        density[(iy * TILE_SIZE + ix) * GENUS_BINS + genus] += coverage as f32;
                    }
                }
            }
        },
    );
}

/// The byte an opaque, tree-free pixel holds: RGB zero, alpha full. The alpha is always full because
/// the genus densities live in RGB (see GENERA_PER_TILE) and a translucent tile would be premultiplied
/// on decode. The shared blank is this repeated, so a treeless tile still reads as density zero.
const OPAQUE_ZERO: [u8; 4] = [0, 0, 0, 255];

/// Quantize one packed layer (genera `base..base + 3`) of the density buffer into an RGB-in-opaque
/// tile. Returns None when the layer is entirely empty, so the caller can write the shared blank.
fn pack_layer(density: &[f32], base: usize) -> Option<Vec<u8>> {
    let mut pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut painted = false;
    for pixel in 0..TILE_SIZE * TILE_SIZE {
        pixels[pixel * 4 + 3] = 255;
        for channel in 0..GENERA_PER_TILE {
            let genus = base + channel;
            if genus >= GENUS_BINS {
                continue;
            }
            let value = density[pixel * GENUS_BINS + genus];
            if value > 0.0 {
                let byte = (value / DENSITY_FULL * 255.0).round().clamp(0.0, 255.0) as u8;
                pixels[pixel * 4 + channel] = byte;
                painted |= byte > 0;
            }
        }
    }
    painted.then_some(pixels)
}

/// Render one tile position: accumulate every member city's crowns once, then split the shared
/// density buffer into the `LAYERS` packed RGBA tiles. A layer that lands on nothing is written as the
/// shared blank so the client never 404s.
fn render(
    fields: &[Option<Field>],
    blank: &[u8],
    directories: &[PathBuf],
    tile: &Tile,
) -> Fallible<Stats> {
    let mut density = vec![0f32; TILE_SIZE * TILE_SIZE * GENUS_BINS];
    for member in &tile.members {
        if let Some(field) = &fields[*member] {
            accumulate(&mut density, field, tile);
        }
    }

    let mut stats = Stats::default();
    for (layer, directory) in directories.iter().enumerate() {
        let packed = pack_layer(&density, layer * GENERA_PER_TILE);
        let painted = packed.is_some();
        let encoded = packed.map(|pixels| encode_webp_lossless(&pixels));
        let webp = encoded.as_deref().unwrap_or(blank);
        fs::write(
            directory
                .join(tile.zoom.to_string())
                .join(tile.x.to_string())
                .join(format!("{}.webp", tile.y)),
            webp,
        )?;
        stats = stats
            + Stats {
                tiles: 1,
                painted: usize::from(painted),
                bytes: webp.len(),
            };
    }
    Ok(stats)
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;

    let fields: Vec<Option<Field>> = manifest
        .cities
        .iter()
        .map(|city| read_field(city, &args.data))
        .collect::<Fallible<Vec<Option<Field>>>>()?;
    if fields.iter().all(Option::is_none) {
        eprintln!("no city has a genus layer; nothing to render");
        return Ok(());
    }
    for (city, field) in manifest.cities.iter().zip(&fields) {
        if let Some(field) = field {
            eprintln!("{}: {} trees", city.id, field.tree_count);
        }
    }

    // One lossless pyramid per packed layer under public/tiles/genus-field/{0,1,2}.
    let directories: Vec<PathBuf> = (0..LAYERS)
        .map(|layer| args.tiles.join(layer.to_string()))
        .collect();

    let plan = plan_tiles(&manifest.cities, GENUS_MAX_ZOOM);
    for directory in &directories {
        for tile in &plan {
            fs::create_dir_all(
                directory
                    .join(tile.zoom.to_string())
                    .join(tile.x.to_string()),
            )?;
        }
    }
    let blank = encode_webp_lossless(&OPAQUE_ZERO.repeat(TILE_SIZE * TILE_SIZE));

    eprintln!(
        "rendering {} genus-field tiles ({} positions x {LAYERS} layers) across {} threads",
        plan.len() * LAYERS,
        plan.len(),
        rayon::current_num_threads()
    );
    let stats = plan
        .par_iter()
        .map(|tile| render(&fields, &blank, &directories, tile))
        .try_reduce(Stats::default, |left, right| Ok(left + right))?;

    eprintln!(
        "wrote {} genus-field tiles (z{MIN_ZOOM}-z{GENUS_MAX_ZOOM}, {} painted, {:.1} MiB) in {:.1}s",
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
/// (the size the overlay draws its dot at) and its genus id, in bucket order.
struct TreeIndex {
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
    fn new(trees: &Trees, projection: &Projection) -> Self {
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

    fn max_crown_m(&self) -> f64 {
        self.max_crown_m
    }

    /// Every tree whose metre-space position lies within `reach` of the box, handed to `visit` as
    /// (x, y, crown_radius_m, genus_id). `reach` is the largest dot radius in metres, so a tree just
    /// outside the tile whose dot still spills into it is included. The bucket scan overshoots the
    /// box by up to a bucket, so each tree is tested against the grown box before it is visited.
    fn for_each_in_box(
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
