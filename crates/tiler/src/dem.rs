//! The ground surface, as a mosaic of GeoTIFF tiles that can be sampled at a longitude and latitude.
//!
//! A canopy height model arrives as one large raster and a 3DEP campaign arrives as several hundred
//! small ones, so the thing both have in common is not a file but a set of georeferenced grids. This
//! reads a set, indexes it by ground extent, and resamples it onto a regular longitude/latitude
//! grid — the `Field` everything downstream actually reads.
//!
//! A set can be several MOSAICS rather than one. A city is not obliged to lie inside a single
//! survey: the Bay Area's ground is San Francisco's five-band 3DEP product on the city's own
//! state-plane zone plus the East Bay's staged bare-earth DEM on UTM 10N, published years apart on
//! grids that share no origin. So a `Dem` holds a list of mosaics, each with its own projection,
//! band and spatial index, over one shared list of tiles.
//!
//! Only one decoded tile is held at a time, because a city of float32 at one metre is gigabytes. So
//! the resample visits points GROUPED BY TILE rather than in grid order, and decodes each tile
//! exactly once per resample; the same sweep in row order re-decodes every tile on every row.
//!
//! A build resamples TWICE — the elevation pass at the pyramid's finest zoom and the graph pass at a
//! finer one for the relief bake — because the two want different grids over different bounds and
//! neither field is written down. What `tiler build` shares is the OPEN: it hands the same `Dem` to
//! both, so San Francisco's 1.77 GB of tiles are georeferenced and indexed once rather than twice.
//! The pixels are not — only one decoded tile is ever held, and `release` drops it between passes.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use tiff::decoder::{Decoder, DecodingResult, Limits};
use tiff::tags::Tag;

use crate::Fallible;
use crate::heights::Tmerc;
use crate::manifest::Bounds;
use crate::raster::{lat_to_pixel_y, lng_to_pixel_x};

/// A value at or below this is the nodata of every product read here — 3DEP writes -9999 and the
/// canopy models write their own large sentinel, and no real ground or crown height comes near it.
const NODATA_BELOW: f32 = -9000.0;

const METERS_PER_DEGREE_LAT: f64 = 111_320.0;

/// One tile's georeferencing and pixel extent, read from its own tags.
pub struct TileGrid {
    pub path: PathBuf,
    pub width: usize,
    pub height: usize,
    /// Ground coordinate of the upper-left *corner* of pixel (0, 0), in the mosaic's projection.
    pub origin_x: f64,
    pub origin_y: f64,
    pub cell: f64,
    pub bands: usize,
    /// Which of a `Dem`'s mosaics this tile came from, and so which projection its ground
    /// coordinates are in and which band of it carries the surface. A tile read on its own belongs
    /// to the only mosaic there is.
    pub mosaic: usize,
}

impl TileGrid {
    pub fn min_x(&self) -> f64 {
        self.origin_x
    }
    pub fn max_x(&self) -> f64 {
        self.origin_x + self.width as f64 * self.cell
    }
    pub fn max_y(&self) -> f64 {
        self.origin_y
    }
    pub fn min_y(&self) -> f64 {
        self.origin_y - self.height as f64 * self.cell
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.min_x() && x < self.max_x() && y > self.min_y() && y <= self.max_y()
    }
}

pub fn read_tile_grid(path: &Path) -> Fallible<TileGrid> {
    let mut decoder = Decoder::new(BufReader::new(File::open(path)?))?;
    let (width, height) = decoder.dimensions()?;
    let scale = decoder.get_tag_f64_vec(Tag::ModelPixelScaleTag)?;
    let tie = decoder.get_tag_f64_vec(Tag::ModelTiepointTag)?;
    if scale.len() < 2 || tie.len() < 6 || tie[..3] != [0.0, 0.0, 0.0] || scale[0] != scale[1] {
        return Err(format!(
            "{}: not an axis-aligned raster tied at its origin (scale {scale:?}, tie {tie:?})",
            path.display()
        )
        .into());
    }
    let bands = decoder
        .get_tag_u32_vec(Tag::SamplesPerPixel)
        .map_or(1, |values| values.first().copied().unwrap_or(1) as usize);
    Ok(TileGrid {
        path: path.to_path_buf(),
        width: width as usize,
        height: height as usize,
        origin_x: tie[3],
        origin_y: tie[4],
        cell: scale[0],
        bands,
        mosaic: 0,
    })
}

/// A mosaic as a caller hands it over: the tiles of one survey, the projection they are published
/// on, and which band of them carries the surface to read.
pub struct MosaicTiles {
    pub projection: Tmerc,
    pub band: usize,
    pub paths: Vec<PathBuf>,
}

/// A mosaic as an open `Dem` holds it. Its tiles live in the `Dem`'s one list, so what is left here
/// is how to get onto its grid and how to find a tile on it.
struct Mosaic {
    projection: Tmerc,
    band: usize,
    /// A coarse grid over this mosaic's extent, so finding the tile under a point is a lookup rather
    /// than a scan of several hundred boxes.
    ///
    /// One index per mosaic rather than one keyed by (mosaic, x, y), because the keys are PROJECTED
    /// METRES and two projections are two different spaces: San Francisco's CS13 puts its origin
    /// under Twin Peaks and UTM 10N puts its own on the equator, so the same ground falls in cells
    /// thousands apart and a cell that is one tile wide on one grid is meaningless on the other.
    /// Keying by mosaic as well would keep the spaces apart but would still leave one `index_cell`
    /// for both, sized to whichever survey stages the bigger tiles — 10 km squares against 2 km
    /// ones here. A lookup then costs one probe per mosaic, of which a city has one or two.
    index: HashMap<(i64, i64), Vec<usize>>,
    index_cell: f64,
}

/// A ground surface: one or more mosaics, each on its own projection and band, sampled at a
/// longitude and latitude.
pub struct Dem {
    mosaics: Vec<Mosaic>,
    /// Every mosaic's tiles in one list, each carrying the index of the mosaic it came from, so a
    /// tile position means the same thing to every reader here and to every caller holding one.
    tiles: Vec<TileGrid>,
    /// The tile whose samples are currently decoded, and its values. Only one is held: a caller that
    /// sweeps in raster order never revisits, and holding a whole city of float32 would be gigabytes.
    loaded: Option<(usize, Vec<f32>)>,
    pub decoded: usize,
}

impl Dem {
    /// One mosaic, which is what a caller reading a single survey's tiles wants.
    pub fn open(paths: &[PathBuf], projection: Tmerc, band: usize) -> Fallible<Dem> {
        Dem::open_mosaics(&[MosaicTiles {
            projection,
            band,
            paths: paths.to_vec(),
        }])
    }

    /// Reads every tile's georeferencing up front — a few hundred header reads — and indexes them,
    /// mosaic by mosaic. No pixels are decoded until a resample asks for them.
    pub fn open_mosaics(mosaics: &[MosaicTiles]) -> Fallible<Dem> {
        if mosaics.is_empty() {
            return Err("an elevation source with no mosaics".into());
        }
        let mut tiles: Vec<TileGrid> = Vec::new();
        let mut opened: Vec<Mosaic> = Vec::new();
        for (position, mosaic) in mosaics.iter().enumerate() {
            let first = tiles.len();
            for path in &mosaic.paths {
                let mut tile = read_tile_grid(path)?;
                if mosaic.band >= tile.bands {
                    return Err(format!(
                        "{}: band {} asked for, {} in the file",
                        tile.path.display(),
                        mosaic.band,
                        tile.bands
                    )
                    .into());
                }
                tile.mosaic = position;
                tiles.push(tile);
            }
            let own = &tiles[first..];
            if own.is_empty() {
                return Err("an elevation mosaic with no tiles".into());
            }
            // One index cell per tile-sized square of ground, taken from the largest tile so no tile
            // spans more cells than it has to.
            let index_cell = own
                .iter()
                .map(|tile| (tile.max_x() - tile.min_x()).max(tile.max_y() - tile.min_y()))
                .fold(1.0_f64, f64::max);
            let mut index: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
            for (offset, tile) in own.iter().enumerate() {
                let x0 = (tile.min_x() / index_cell).floor() as i64;
                let x1 = (tile.max_x() / index_cell).floor() as i64;
                let y0 = (tile.min_y() / index_cell).floor() as i64;
                let y1 = (tile.max_y() / index_cell).floor() as i64;
                for x in x0..=x1 {
                    for y in y0..=y1 {
                        index.entry((x, y)).or_default().push(first + offset);
                    }
                }
            }
            opened.push(Mosaic {
                projection: mosaic.projection,
                band: mosaic.band,
                index,
                index_cell,
            });
        }
        Ok(Dem {
            mosaics: opened,
            tiles,
            loaded: None,
            decoded: 0,
        })
    }

    /// Which tile covers a longitude and latitude, without decoding anything. Every mosaic is asked,
    /// since they are on different grids: the point is projected once per mosaic, and each answer is
    /// compared only against that mosaic's own tiles. Two surveys that overlap on the ground — the
    /// bay is flown from both sides — are settled by the plan's order, first mosaic wins.
    pub fn tile_of(&mut self, lng: f64, lat: f64) -> Option<usize> {
        for mosaic in &self.mosaics {
            let (x, y) = mosaic.projection.forward(lng, lat);
            let key = (
                (x / mosaic.index_cell).floor() as i64,
                (y / mosaic.index_cell).floor() as i64,
            );
            let found = mosaic.index.get(&key).and_then(|nearby| {
                nearby
                    .iter()
                    .copied()
                    .find(|&position| self.tiles[position].contains(x, y))
            });
            if found.is_some() {
                return found;
            }
        }
        None
    }

    /// The reading at a point that is known to fall in `position`, decoding that tile if it is not
    /// the one already held. Callers that visit points grouped by tile pay one decode per tile.
    pub fn sample_in(&mut self, position: usize, lng: f64, lat: f64) -> Fallible<Option<f32>> {
        self.load(position)?;
        let (x, y) = self.mosaics[self.tiles[position].mosaic]
            .projection
            .forward(lng, lat);
        Ok(self.read(position, x, y))
    }

    /// The mosaic's readings over a regular grid in the mosaic's OWN projection: the upper-left
    /// corner of cell (0, 0) at (`origin_x`, `origin_y`), cells `cell` metres square, row-major, NaN
    /// where no tile covers a cell.
    ///
    /// The other readers take a longitude and latitude, which a caller already working in projected
    /// metres cannot supply — nothing here inverts the projection. Filled tile by tile for the same
    /// reason `resample` buckets by tile: a grid a kilometre wide crosses tiles on every row, and
    /// sweeping in row order would decode each of them once per row.
    ///
    /// Refused outright on a `Dem` of several mosaics: "projected metres" would then name more than
    /// one space, and the tiles of the wrong one would be picked up by a box comparison that is
    /// arithmetically fine and geographically nonsense. A caller in projected metres has one grid in
    /// mind and has to open the mosaic it belongs to.
    pub fn sample_grid(
        &mut self,
        origin_x: f64,
        origin_y: f64,
        cell: f64,
        width: usize,
        height: usize,
    ) -> Fallible<Vec<f32>> {
        if self.mosaics.len() > 1 {
            return Err(format!(
                "a grid in projected metres sampled from a DEM of {} mosaics, which are on {} \
                 different projections",
                self.mosaics.len(),
                self.mosaics.len()
            )
            .into());
        }
        let east = origin_x + width as f64 * cell;
        let south = origin_y - height as f64 * cell;
        let reaching: Vec<usize> = (0..self.tiles.len())
            .filter(|&position| {
                let tile = &self.tiles[position];
                tile.min_x() < east
                    && tile.max_x() > origin_x
                    && tile.min_y() < origin_y
                    && tile.max_y() > south
            })
            .collect();
        let mut values = vec![f32::NAN; width * height];
        for position in reaching {
            self.load(position)?;
            let tile = &self.tiles[position];
            let span = |from: f64, to: f64, limit: usize| {
                (from.floor().clamp(0.0, limit as f64) as usize)
                    ..(to.ceil().clamp(0.0, limit as f64) as usize)
            };
            let columns = span(
                (tile.min_x() - origin_x) / cell,
                (tile.max_x() - origin_x) / cell,
                width,
            );
            let rows = span(
                (origin_y - tile.max_y()) / cell,
                (origin_y - tile.min_y()) / cell,
                height,
            );
            for row in rows {
                let y = origin_y - (row as f64 + 0.5) * cell;
                for column in columns.clone() {
                    let x = origin_x + (column as f64 + 0.5) * cell;
                    // Tiles overlap by a few pixels, so a cell two of them cover keeps whichever
                    // carried a reading rather than the last one visited.
                    if let Some(value) = self.read(position, x, y) {
                        values[row * width + column] = value;
                    }
                }
            }
        }
        Ok(values)
    }

    /// The cell at a projected point in an already-decoded tile.
    fn read(&self, position: usize, x: f64, y: f64) -> Option<f32> {
        let tile = &self.tiles[position];
        let column = ((x - tile.origin_x) / tile.cell).floor() as isize;
        let row = ((tile.origin_y - y) / tile.cell).floor() as isize;
        if column < 0 || row < 0 || column as usize >= tile.width || row as usize >= tile.height {
            return None;
        }
        let (_, values) = self.loaded.as_ref()?;
        let band = self.mosaics[tile.mosaic].band;
        let index = (row as usize * tile.width + column as usize) * tile.bands + band;
        let value = values.get(index).copied().unwrap_or(f32::NAN);
        if value.is_finite() && value > NODATA_BELOW {
            Some(value)
        } else {
            None
        }
    }

    fn load(&mut self, position: usize) -> Fallible<()> {
        if self
            .loaded
            .as_ref()
            .is_some_and(|(held, _)| *held == position)
        {
            return Ok(());
        }
        let tile = &self.tiles[position];
        // The decoder's default ceiling is half a gigabyte of decoded image and it rejects anything
        // over it outright. San Francisco's tiles are 2.7 MB each and never came near it; the staged
        // 1 m DEM is 10012 x 10012 float32, 401 MB a tile, and every one of them failed to open.
        // Holding one is what this already promises to do.
        let mut decoder =
            Decoder::new(BufReader::new(File::open(&tile.path)?))?.with_limits(Limits::unlimited());
        let values = match decoder.read_image()? {
            DecodingResult::F32(values) => values,
            DecodingResult::U16(values) => values.iter().map(|&v| f32::from(v)).collect(),
            DecodingResult::I16(values) => values.iter().map(|&v| f32::from(v)).collect(),
            _ => {
                return Err(format!(
                    "{}: unsupported sample type in an elevation tile",
                    tile.path.display()
                )
                .into());
            }
        };
        self.loaded = Some((position, values));
        self.decoded += 1;
        Ok(())
    }

    pub fn tiles(&self) -> usize {
        self.tiles.len()
    }

    /// Drops the decoded tile. A caller that has finished resampling but is still holding the `Dem`
    /// for a later pass — `tiler build` hands one mosaic to both readers — would otherwise keep a
    /// tile of float32 alive across the tile render that follows.
    pub fn release(&mut self) {
        self.loaded = None;
    }
}

/// The resampled ground surface: a regular longitude/latitude grid over the city's bounds, at the
/// resolution the deepest baked zoom draws at.
pub struct Field {
    west: f64,
    north: f64,
    step_lng: f64,
    step_lat: f64,
    width: usize,
    height: usize,
    /// NaN where the DEM had nothing, which is most of the water and the odd gap.
    meters: Vec<f32>,
    low: f32,
    high: f32,
}

impl Field {
    pub fn low(&self) -> f32 {
        self.low
    }

    pub fn high(&self) -> f32 {
        self.high
    }

    pub fn step_lng(&self) -> f64 {
        self.step_lng
    }

    pub fn step_lat(&self) -> f64 {
        self.step_lat
    }

    pub fn at(&self, column: usize, row: usize) -> f32 {
        self.meters[row * self.width + column]
    }

    /// Drops every cell the predicate rejects, and answers how many it dropped. The range is
    /// recomputed from what survives, which is the point of doing this on the field rather than at
    /// render time: the tint is stretched over `low..high`, and water sitting at sea level anchors
    /// the low end to 0 for a city whose ground never gets there.
    ///
    /// The predicate takes the cell's centre, and is `&mut` because a polygon index carries scratch
    /// state between queries.
    /// A cell outside the mask survives when the mask lies within `reach_meters` of it AND its
    /// surface stands at least `deck_meters` up, which is what tells a pier from the water it is
    /// built over.
    ///
    /// A shoreline polygon set stops at the natural shore. San Francisco's does, and the ground it
    /// leaves out is not water: the port's piers, the fill along the Embarcadero and the built edges
    /// of Treasure Island are all surveyed surface with no polygon under them, and masking them off
    /// punched holes through the middle of the city. Widening the polygons instead would drag the
    /// tint out over the bay everywhere, which is the thing the mask exists to stop — hence the two
    /// conditions rather than one. The height test is what keeps the reach honest: the bay's own
    /// returns sit at the water plane, a pier deck stands several metres over it.
    pub fn retain(
        &mut self,
        reach_meters: f64,
        deck_meters: f32,
        mut keep: impl FnMut(f64, f64) -> bool,
    ) -> usize {
        let mut inside = vec![false; self.width * self.height];
        for row in 0..self.height {
            let lat = self.north - (row as f64 + 0.5) * self.step_lat;
            for column in 0..self.width {
                let lng = self.west + (column as f64 + 0.5) * self.step_lng;
                inside[row * self.width + column] = keep(lng, lat);
            }
        }
        let cell_meters = self.step_lat * METERS_PER_DEGREE_LAT;
        let radius = (reach_meters / cell_meters.max(0.01)).round() as usize;
        let reached = dilate(&inside, self.width, self.height, radius);

        let mut dropped = 0;
        for cell in 0..self.meters.len() {
            if !self.meters[cell].is_finite() {
                continue;
            }
            // Inside the polygons the height is not asked about at all: a beach and a tidal flat are
            // ground the city walks on and both sit below any deck.
            let keep_cell = inside[cell] || (reached[cell] && self.meters[cell] >= deck_meters);
            if !keep_cell {
                self.meters[cell] = f32::NAN;
                dropped += 1;
            }
        }
        self.low = f32::INFINITY;
        self.high = f32::NEG_INFINITY;
        for value in &self.meters {
            if value.is_finite() {
                self.low = self.low.min(*value);
                self.high = self.high.max(*value);
            }
        }
        dropped
    }

    /// How much of the ground around a point is ground at all, 0 to 1, bilinear over the same four
    /// cells `sample` blends.
    ///
    /// `sample` deliberately refuses to blend across a missing corner — averaging real land with
    /// absent sea would drag the coast out over the water — so the height it returns steps from
    /// "land" to "nothing" over one cell and the coastline comes out as a staircase of whole cells,
    /// which magnifies into visible blocks. This gives the renderer a soft edge to fade the tint out
    /// over instead, without moving where the land is: the value stays whatever `sample` says, only
    /// its opacity follows the coverage.
    pub fn coverage(&self, lng: f64, lat: f64) -> f32 {
        let x = (lng - self.west) / self.step_lng - 0.5;
        let y = (self.north - lat) / self.step_lat - 0.5;
        let at = |column: f64, row: f64| -> f32 {
            if column < 0.0 || row < 0.0 {
                return 0.0;
            }
            let (column, row) = (column as usize, row as usize);
            if column >= self.width || row >= self.height {
                0.0
            } else if self.at(column, row).is_finite() {
                1.0
            } else {
                0.0
            }
        };
        let column = x.floor();
        let row = y.floor();
        let fx = (x - column) as f32;
        let fy = (y - row) as f32;
        let top = at(column, row) + (at(column + 1.0, row) - at(column, row)) * fx;
        let bottom =
            at(column, row + 1.0) + (at(column + 1.0, row + 1.0) - at(column, row + 1.0)) * fx;
        top + (bottom - top) * fy
    }

    /// The value under a longitude and latitude, or NaN outside the field. Bilinear between the four
    /// cells around the point, not the cell it falls in.
    ///
    /// The difference matters because the cells are metres across and the things that read this are
    /// far smaller than a cell. Nearest-cell hands a sub-metre edge the whole height step between two
    /// neighbouring cells — the TERRAIN's slope charged as that EDGE's climb — and on a hillside that
    /// saturates it. Measured over San Francisco it saturated 6,396 edges, the shortest of them 0.9 m
    /// long. Interpolating makes a short edge's climb proportional to its length, which is the only
    /// answer that means anything.
    pub fn sample(&self, lng: f64, lat: f64) -> f32 {
        // Cell centres sit at half-steps, so shift by half a cell before flooring: a point at a
        // centre has to come back as that cell's own value, not a blend with its neighbour.
        let x = (lng - self.west) / self.step_lng - 0.5;
        let y = (self.north - lat) / self.step_lat - 0.5;
        let at = |column: f64, row: f64| -> f32 {
            if column < 0.0 || row < 0.0 {
                return f32::NAN;
            }
            let (column, row) = (column as usize, row as usize);
            if column >= self.width || row >= self.height {
                f32::NAN
            } else {
                self.at(column, row)
            }
        };
        let column = x.floor();
        let row = y.floor();
        let top_left = at(column, row);
        let top_right = at(column + 1.0, row);
        let bottom_left = at(column, row + 1.0);
        let bottom_right = at(column + 1.0, row + 1.0);
        // A blend is only as good as its corners. At a shoreline three of the four are NaN and the
        // fourth is real land; averaging what is there would drag the coast out over the water, so a
        // missing corner falls back to the cell the point is actually in — NOT to the nearest cell
        // that exists. Clamping the index to zero here, as this did, read every point west or north
        // of the field as its edge column at any distance, while east and south correctly came back
        // NaN: a border tile could smear the outermost strip of terrain out to the tile plan's edge.
        if !top_left.is_finite()
            || !top_right.is_finite()
            || !bottom_left.is_finite()
            || !bottom_right.is_finite()
        {
            return at(x.round(), y.round());
        }
        let fx = (x - column) as f32;
        let fy = (y - row) as f32;
        let top = top_left + (top_right - top_left) * fx;
        let bottom = bottom_left + (bottom_right - bottom_left) * fx;
        top + (bottom - top) * fy
    }
}

/// Resamples a mosaic onto a regular longitude/latitude grid over `bounds`, at the resolution one
/// web-mercator pixel covers at `zoom`. One pass over the tiles: a caller that then queries the grid
/// pays nothing per query, where querying the mosaic directly would decode a tile per stray point.
/// How far a fill may reach into a gap, **in metres of ground**, so the widest hole it closes is
/// twice this. Bounded rather than run to convergence because the field's largest missing region is
/// the ocean, and an unbounded fill would march across the whole bay inventing terrain; small enough
/// that the shore creeps less than a block, which the land mask then clips away.
///
/// In metres and not in cells, which is what it was and what broke it. A ring is one cell, so a
/// fixed ring count means a reach that shrinks as the field gets finer: at the z14 field four rings
/// spanned about 38 m and closed the inland ponds and reservoirs the LiDAR gets no return from, and
/// at z16 the same four rings spanned 9.6 m and every one of those holes came back.
const FILL_REACH_METERS: f64 = 40.0;

/// A hard cap on the rings that reach converts to, so a pathologically fine field cannot turn this
/// into hundreds of full passes over tens of millions of cells.
const MAX_FILL_RINGS: usize = 24;

/// Closes small gaps in the sampled field, in place, and answers how many cells it filled.
///
/// The 3DEP mosaic has scattered cells its returns never resolved — single pixels and short runs,
/// mostly over water-adjacent ground and building interiors. They matter out of proportion to their
/// number because the hillshade reads the field's own slope: one missing cell blanks a pixel and
/// puts a false edge in each of its four neighbours' gradients.
///
/// Each ring averages the valid 8-neighbours of every still-missing cell. Written to a scratch copy
/// per ring so the result cannot depend on the order cells are visited — filling in place would let
/// a cell read a neighbour this same ring had just invented, and the gap would fill directionally.
/// Every cell within `radius` cells of a set one, as a square rather than a disc — separable, so it
/// costs two linear passes over the grid instead of one per ring, and the corners it adds over a
/// disc are a fraction of a cell at the reaches this is called with.
fn dilate(set: &[bool], width: usize, height: usize, radius: usize) -> Vec<bool> {
    if radius == 0 {
        return set.to_vec();
    }
    // A running count of set cells in the window, so each pass is one add and one subtract per cell.
    let mut spread = vec![false; set.len()];
    for row in 0..height {
        let mut count = 0usize;
        for column in 0..(radius + 1).min(width) {
            count += usize::from(set[row * width + column]);
        }
        for column in 0..width {
            spread[row * width + column] = count > 0;
            if let Some(leaving) = column.checked_sub(radius) {
                count -= usize::from(set[row * width + leaving]);
            }
            let entering = column + radius + 1;
            if entering < width {
                count += usize::from(set[row * width + entering]);
            }
        }
    }
    let mut out = vec![false; set.len()];
    for column in 0..width {
        let mut count = 0usize;
        for row in 0..(radius + 1).min(height) {
            count += usize::from(spread[row * width + column]);
        }
        for row in 0..height {
            out[row * width + column] = count > 0;
            if let Some(leaving) = row.checked_sub(radius) {
                count -= usize::from(spread[leaving * width + column]);
            }
            let entering = row + radius + 1;
            if entering < height {
                count += usize::from(spread[entering * width + column]);
            }
        }
    }
    out
}

fn close_holes(meters: &mut [f32], width: usize, height: usize, cell_meters: f64) -> usize {
    let rings =
        ((FILL_REACH_METERS / cell_meters.max(0.01)).round() as usize).clamp(1, MAX_FILL_RINGS);
    let mut patched = 0;
    for _ in 0..rings {
        let mut filled: Vec<(usize, f32)> = Vec::new();
        for row in 0..height {
            for column in 0..width {
                let cell = row * width + column;
                if meters[cell].is_finite() {
                    continue;
                }
                let mut total = 0.0f32;
                let mut count = 0u32;
                for delta_row in -1i64..=1 {
                    for delta_column in -1i64..=1 {
                        let neighbour_row = row as i64 + delta_row;
                        let neighbour_column = column as i64 + delta_column;
                        if neighbour_row < 0
                            || neighbour_column < 0
                            || neighbour_row >= height as i64
                            || neighbour_column >= width as i64
                        {
                            continue;
                        }
                        let value =
                            meters[neighbour_row as usize * width + neighbour_column as usize];
                        if value.is_finite() {
                            total += value;
                            count += 1;
                        }
                    }
                }
                // Three of eight, so a reading is interpolated from a neighbourhood rather than
                // copied off a single cell. It does NOT stop the fill reaching open water — along a
                // straight coast a seaward cell has three valid neighbours like any other — and
                // nothing here does. What bounds the sea is MAX_FILL_RINGS, and after that the land
                // mask the overlay renders through.
                if count >= 3 {
                    filled.push((cell, total / count as f32));
                }
            }
        }
        if filled.is_empty() {
            break;
        }
        for (cell, value) in filled {
            meters[cell] = value;
            patched += 1;
        }
    }
    patched
}

pub fn resample(bounds: &Bounds, zoom: u32, dem: &mut Dem) -> Fallible<Field> {
    // The ground a pixel covers at the deepest baked zoom, expressed back in degrees so the field
    // lines up with the tiles that will read it.
    let west = bounds.west;
    let east = bounds.east;
    let south = bounds.south;
    let north = bounds.north;
    let pixels_x = lng_to_pixel_x(east, zoom) - lng_to_pixel_x(west, zoom);
    let pixels_y = lat_to_pixel_y(south, zoom) - lat_to_pixel_y(north, zoom);
    let width = pixels_x.ceil().max(1.0) as usize;
    let height = pixels_y.ceil().max(1.0) as usize;
    let step_lng = (east - west) / width as f64;
    let step_lat = (north - south) / height as f64;

    let mut meters = vec![f32::NAN; width * height];
    let mut low = f32::INFINITY;
    let mut high = f32::NEG_INFINITY;
    let mut filled = 0usize;

    // Grouped by DEM tile, not swept in field order. A field row crosses tens of tiles, so a
    // row-major sweep re-decodes every one of them on every row — measured over San Francisco that
    // was 37,204 decodes of 651 tiles and six minutes. Bucketing first costs one cheap forward
    // projection per cell and decodes each tile exactly once.
    let mut by_tile: HashMap<usize, Vec<usize>> = HashMap::new();
    for row in 0..height {
        let lat = north - (row as f64 + 0.5) * step_lat;
        for column in 0..width {
            let lng = west + (column as f64 + 0.5) * step_lng;
            if let Some(position) = dem.tile_of(lng, lat) {
                by_tile
                    .entry(position)
                    .or_default()
                    .push(row * width + column);
            }
        }
    }
    let mut positions: Vec<usize> = by_tile.keys().copied().collect();
    positions.sort_unstable();
    for position in positions {
        for &cell in &by_tile[&position] {
            let row = cell / width;
            let column = cell % width;
            let lat = north - (row as f64 + 0.5) * step_lat;
            let lng = west + (column as f64 + 0.5) * step_lng;
            if let Some(value) = dem.sample_in(position, lng, lat)? {
                meters[cell] = value;
                low = low.min(value);
                high = high.max(value);
                filled += 1;
            }
        }
    }
    if filled == 0 {
        return Err("the DEM covered none of the city".into());
    }
    // The field's own cell size on the ground, so the fill's reach is the same distance whatever
    // zoom the field was built at.
    let cell_meters = step_lat * METERS_PER_DEGREE_LAT;
    let patched = close_holes(&mut meters, width, height, cell_meters);
    eprintln!(
        "  field {width} x {height}, {filled} cells with ground ({:.0} m to {:.0} m), {patched} holes closed, {} tiles decoded",
        low, high, dem.decoded
    );
    Ok(Field {
        west,
        north,
        step_lng,
        step_lat,
        width,
        height,
        meters,
        low,
        high,
    })
}

#[cfg(test)]
impl Field {
    /// A field built straight from values instead of from a mosaic. Row-major, `width * height`,
    /// NaN where there is no ground.
    pub fn from_grid(
        west: f64,
        north: f64,
        step_lng: f64,
        step_lat: f64,
        width: usize,
        height: usize,
        meters: Vec<f32>,
    ) -> Field {
        let mut low = f32::INFINITY;
        let mut high = f32::NEG_INFINITY;
        for value in &meters {
            if value.is_finite() {
                low = low.min(*value);
                high = high.max(*value);
            }
        }
        Field {
            west,
            north,
            step_lng,
            step_lat,
            width,
            height,
            meters,
            low,
            high,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FILL_REACH_METERS, close_holes, dilate};

    /// A cell size that makes the reach exactly four rings, which is what these fixtures are sized for.
    const FOUR_RINGS: f64 = FILL_REACH_METERS / 4.0;
    const MAX_FILL_RINGS: usize = 4;

    const NAN: f32 = f32::NAN;

    #[test]
    fn a_single_missing_cell_takes_the_mean_of_its_neighbours() {
        let mut field = vec![
            10.0, 10.0, 10.0, //
            10.0, NAN, 10.0, //
            10.0, 10.0, 10.0,
        ];
        assert_eq!(close_holes(&mut field, 3, 3, FOUR_RINGS), 1);
        assert_eq!(field[4], 10.0);
    }

    #[test]
    fn a_hole_fills_from_the_ground_around_it_not_across_it() {
        // A step: 0 m on the left, 100 m on the right, one missing cell in the middle of the seam.
        // The fill has to land between them, not take either side's value whole.
        let mut field = vec![
            0.0, 0.0, 100.0, 100.0, //
            0.0, 0.0, NAN, 100.0, //
            0.0, 0.0, 100.0, 100.0,
        ];
        close_holes(&mut field, 4, 3, FOUR_RINGS);
        assert!(field[6] > 0.0 && field[6] < 100.0, "got {}", field[6]);
    }

    #[test]
    fn the_fill_reaches_open_water_by_no_more_than_its_ring_bound() {
        // A coast: ground down the left column, open sea to the right. The fill does creep seaward —
        // one ring per pass, since a cell against the shore has three valid neighbours like any
        // other — so what is asserted is the bound, which is the only thing that holds it. Raising
        // MAX_FILL_RINGS marches the coastline further out to sea by exactly that much.
        let width = 12;
        let height = 5;
        let mut field = vec![NAN; width * height];
        for row in 0..height {
            field[row * width] = 5.0;
        }
        close_holes(&mut field, width, height, FOUR_RINGS);
        for row in 0..height {
            for column in 0..width {
                if column > MAX_FILL_RINGS {
                    assert!(
                        field[row * width + column].is_nan(),
                        "invented ground {column} cells out to sea at row {row}"
                    );
                }
            }
        }
        // It does creep — the cell against the shore fills — so the bound is what holds the sea
        // back, not some property of the coastline. The frontier narrows as it goes (each ring needs
        // three valid neighbours, and the ring behind it is one cell shorter at each end), so how
        // far it actually reaches depends on how wide the shore is; only the bound is guaranteed.
        assert!(field[(height / 2) * width + 1].is_finite());
    }

    #[test]
    fn a_hole_wider_than_the_fill_can_reach_keeps_a_missing_core() {
        // Ground all round a 20-cell-wide void: the rings close in from every side but stop, so the
        // bound is what it claims to be rather than convergence by another name.
        let width = 24;
        let height = 24;
        let mut field = vec![NAN; width * height];
        for row in 0..height {
            for column in 0..width {
                let edge = row < 2 || column < 2 || row >= height - 2 || column >= width - 2;
                if edge {
                    field[row * width + column] = 7.0;
                }
            }
        }
        close_holes(&mut field, width, height, FOUR_RINGS);
        assert!(field[(height / 2) * width + width / 2].is_nan());
    }
    // The reach that lets a pier survive a shoreline mask: square, symmetric, and bounded — a mask
    // that grew without bound would put the tint out over open water, which is what it exists to
    // prevent.
    #[test]
    fn the_reach_spreads_one_cell_by_its_radius_and_stops() {
        let width = 11;
        let height = 11;
        let mut set = vec![false; width * height];
        set[5 * width + 5] = true;
        let reached = dilate(&set, width, height, 2);
        assert!(reached[5 * width + 7]);
        assert!(reached[3 * width + 3]); // the corner of the square, two out on each axis
        assert!(!reached[5 * width + 8]);
        assert_eq!(reached.iter().filter(|&&hit| hit).count(), 25);
    }

    #[test]
    fn a_zero_reach_leaves_the_mask_exactly_as_it_was() {
        let set = vec![false, true, false, false];
        assert_eq!(dilate(&set, 2, 2, 0), set);
    }
}

#[cfg(test)]
mod mosaic_tests {
    use std::fs::{self, File};
    use std::io::BufWriter;
    use std::path::{Path, PathBuf};

    use tiff::encoder::{TiffEncoder, colortype};
    use tiff::tags::Tag;

    use super::{Dem, MosaicTiles};
    use crate::heights::{SF_CS13, UTM_10N};

    /// A point in each survey's own ground: the CS13 origin under Twin Peaks, and downtown Oakland.
    const IN_SAN_FRANCISCO: (f64, f64) = (-122.45, 37.75);
    const IN_THE_EAST_BAY: (f64, f64) = (-122.27, 37.80);

    const SIDE: usize = 40;

    /// A tile file of this test's own. The tests run at once, and one of them truncating a tile
    /// another is part way through reading is an end-of-file error with nothing to say about the
    /// code under it.
    fn scratch(test: &str, name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("tiler-dem-test-{}", std::process::id()))
            .join(test);
        fs::create_dir_all(&dir).expect("a scratch directory");
        dir.join(name)
    }

    fn georeference<Colour: colortype::ColorType, Writer: std::io::Write + std::io::Seek>(
        image: &mut tiff::encoder::ImageEncoder<
            '_,
            Writer,
            Colour,
            tiff::encoder::TiffKindStandard,
        >,
        origin_x: f64,
        origin_y: f64,
    ) {
        image
            .encoder()
            .write_tag(Tag::ModelPixelScaleTag, &[1.0, 1.0, 0.0][..])
            .expect("the pixel scale");
        image
            .encoder()
            .write_tag(
                Tag::ModelTiepointTag,
                &[0.0, 0.0, 0.0, origin_x, origin_y, 0.0][..],
            )
            .expect("the tiepoint");
    }

    /// One metre cells, `SIDE` of them a side, every cell reading `value`.
    fn write_flat(path: &Path, origin_x: f64, origin_y: f64, value: f32) {
        let mut encoder =
            TiffEncoder::new(BufWriter::new(File::create(path).expect("a tile"))).expect("a tiff");
        let mut image = encoder
            .new_image::<colortype::Gray32Float>(SIDE as u32, SIDE as u32)
            .expect("an image");
        georeference(&mut image, origin_x, origin_y);
        image
            .write_data(&vec![value; SIDE * SIDE])
            .expect("the samples");
    }

    /// The same, three bands a pixel — the shape of the 3DEP product, whose ground is one band of
    /// five.
    fn write_three_band(path: &Path, origin_x: f64, origin_y: f64, bands: [f32; 3]) {
        let mut encoder =
            TiffEncoder::new(BufWriter::new(File::create(path).expect("a tile"))).expect("a tiff");
        let mut image = encoder
            .new_image::<colortype::RGB32Float>(SIDE as u32, SIDE as u32)
            .expect("an image");
        georeference(&mut image, origin_x, origin_y);
        let samples: Vec<f32> = std::iter::repeat_n(bands, SIDE * SIDE).flatten().collect();
        image.write_data(&samples).expect("the samples");
    }

    /// San Francisco on CS13 reading its only band, the East Bay on UTM 10N reading its third: two
    /// surveys whose metres are thousands apart and whose bands are not the same number.
    fn two_surveys(test: &str) -> Dem {
        let (sf_x, sf_y) = SF_CS13.forward(IN_SAN_FRANCISCO.0, IN_SAN_FRANCISCO.1);
        let (east_x, east_y) = UTM_10N.forward(IN_THE_EAST_BAY.0, IN_THE_EAST_BAY.1);
        let west = scratch(test, "cs13.tif");
        let east = scratch(test, "utm10n.tif");
        write_flat(&west, sf_x - 20.0, sf_y + 20.0, 110.0);
        write_three_band(&east, east_x - 20.0, east_y + 20.0, [1.0, 2.0, 33.0]);
        Dem::open_mosaics(&[
            MosaicTiles {
                projection: SF_CS13,
                band: 0,
                paths: vec![west],
            },
            MosaicTiles {
                projection: UTM_10N,
                band: 2,
                paths: vec![east],
            },
        ])
        .expect("a two-mosaic dem")
    }

    #[test]
    fn a_point_is_read_through_its_own_survey_s_projection_and_band() {
        let mut dem = two_surveys("own-projection-and-band");
        let west = dem
            .tile_of(IN_SAN_FRANCISCO.0, IN_SAN_FRANCISCO.1)
            .expect("san francisco's tile");
        let east = dem
            .tile_of(IN_THE_EAST_BAY.0, IN_THE_EAST_BAY.1)
            .expect("the east bay's tile");
        assert_ne!(west, east);
        // One projection for both would put each point in the other grid's empty quarter of the
        // world, and neither tile would be found at all.
        assert_eq!(
            dem.sample_in(west, IN_SAN_FRANCISCO.0, IN_SAN_FRANCISCO.1)
                .expect("a reading"),
            Some(110.0)
        );
        assert_eq!(
            dem.sample_in(east, IN_THE_EAST_BAY.0, IN_THE_EAST_BAY.1)
                .expect("a reading"),
            Some(33.0)
        );
    }

    #[test]
    fn a_grid_in_projected_metres_is_refused_when_the_mosaics_disagree_on_the_metre() {
        let test = "mosaics-disagree";
        let (east_x, east_y) = UTM_10N.forward(IN_THE_EAST_BAY.0, IN_THE_EAST_BAY.1);
        let error = two_surveys(test)
            .sample_grid(east_x - 20.0, east_y + 20.0, 1.0, SIDE, SIDE)
            .expect_err("a refusal");
        assert!(error.to_string().contains("mosaics"), "{error}");

        // The same grid off the same tile, opened as the one mosaic it belongs to, is answered.
        let east = scratch(test, "utm10n.tif");
        let mut alone = Dem::open(&[east], UTM_10N, 2).expect("the east bay's mosaic on its own");
        let values = alone
            .sample_grid(east_x - 20.0, east_y + 20.0, 1.0, SIDE, SIDE)
            .expect("a grid");
        assert!(values.iter().all(|&value| value == 33.0));
    }
}
