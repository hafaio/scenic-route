//! `tiler densities`: the covered fraction at both sidewalks of every street vertex, and the
//! cover distribution the manifest records. Run by scripts/build-tree-data.ts once the four
//! `.bin`s are written — the street file arrives with a zeroed density blob and leaves with it
//! filled, in place.
//!
//! Cover is `1 - exp(-CAI)`, the Boolean-canopy covered fraction of the crown-area index the KDE
//! sums. It lives in [0, 1) by construction, so there is no saturation constant to fit — the
//! model constants the ingest passes in are the kernels, the crown floor and the woodland floor.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::Fallible;
use crate::binfmt::{self, LAND_FORMAT, Polygon, WOODLAND_FORMAT};
use crate::geometry::{self, PolygonIndex, PolygonSet, round_half_up};
use crate::kde::{Projection, TreeIndex, cover, reach_bounds, sample_land};
use crate::manifest::{Bounds, Distribution};
use crate::sidewalks;

const CANOPY_METERS: f64 = 20.0; // the mask raster; a 30 m feather has no detail below this

/// Everything the ingest knows and the model needs. The paths are passed rather than derived
/// so the binary has no opinion about where the repo's data lives.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    trees: PathBuf,
    woodland: PathBuf,
    land: PathBuf,
    streets: PathBuf,
    paths: Option<PathBuf>, // the OSM path network, sampled with the same loop when present
    source_box: Bounds, // the raw extent of the trees and the streets, before the kernel's reach
    land_box: Bounds,   // the land polygons' own box, which the cover distribution is drawn over
    broad_sigma_meters: f64,
    tight_sigma_along_meters: f64, // the street kernel, down the road: the colour stays smooth
    tight_sigma_across_meters: f64, // and over it: the far sidewalk falls away, but only gently
    sidewalk_inset_meters: f64,    // curb to the centre of the sidewalk
    woodland_floor: f64,           // the cover a wood is treated as: a forest is ~90% canopy
    woodland_feather_meters: f64,
    woodland_plateau: f64,
    cover_samples: usize, // land points the reported cover distribution is estimated from
    cover_seed: u64,      // and the seed they are drawn with, so the mean does not churn
    percentiles: Vec<u32>, // the labels the reported distributions are cut at
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    bounds: Bounds,
    woodland_square_km: f64,
    draws: usize,
    land_density: Distribution,
    street_density: Distribution,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_density: Option<Distribution>, // only when the params carried a paths file
}

/// The canopy mask, rasterized in the local metre space and Gaussian-feathered. This is a
/// mask, not a field: its resolution limits how sharply a park edge can be drawn, and nothing
/// else. The trees themselves never touch a grid.
struct Canopy {
    feathered: Vec<f32>,
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
    cells: usize, // wooded cells, before the feather
}

// woodland AND land, feathered. The AND is what keeps New Jersey's forests and Westchester's
// out of a mask the city's bounding box otherwise reaches straight into.
fn build_canopy(
    params: &Params,
    bounds: &Bounds,
    projection: &Projection,
    woodland: &[Polygon],
    land: &[Polygon],
) -> Canopy {
    let min_x = projection.x(bounds.west);
    let min_y = projection.y(bounds.south);
    let cols = ((projection.x(bounds.east) - min_x) / CANOPY_METERS).ceil() as usize;
    let rows = ((projection.y(bounds.north) - min_y) / CANOPY_METERS).ceil() as usize;
    let to_col = |lng: f64| (projection.x(lng) - min_x) / CANOPY_METERS;
    let to_row = |lat: f64| (projection.y(lat) - min_y) / CANOPY_METERS;

    let fill = |set: &PolygonSet| -> Vec<u8> {
        let mut mask = vec![0u8; cols * rows];
        geometry::fill_polygons(&mut mask, cols, rows, set, bounds, to_col, to_row);
        mask
    };
    let mut wooded = fill(&geometry::flatten(woodland));
    let on_land = fill(&geometry::flatten(land));

    let mut cells = 0;
    for (cell, land) in wooded.iter_mut().zip(&on_land) {
        *cell &= land;
        cells += usize::from(*cell);
    }
    Canopy {
        feathered: geometry::feather(
            &wooded,
            cols,
            rows,
            params.woodland_feather_meters / CANOPY_METERS,
        ),
        cols,
        rows,
        min_x,
        min_y,
        cells,
    }
}

// The cover the woodland mask raises a point to, whatever the street trees there say: a wood is
// simply ~90% canopy, a measurement rather than a special case. The mask carries no crowns of
// its own, so it is applied after the cover transform, as a floor.
fn floor_at(canopy: &Canopy, params: &Params, x: f64, y: f64) -> f64 {
    let col = ((x - canopy.min_x) / CANOPY_METERS - 0.5)
        .max(0.0)
        .min(canopy.cols as f64 - 1.5);
    let row = ((y - canopy.min_y) / CANOPY_METERS - 0.5)
        .max(0.0)
        .min(canopy.rows as f64 - 1.5);
    let along_col = col.fract();
    let along_row = row.fract();
    let bottom = row.floor() as usize * canopy.cols + col.floor() as usize;
    let top = bottom + canopy.cols;
    let at = |cell: usize| f64::from(canopy.feathered[cell]);
    let covered = (at(bottom) * (1.0 - along_col) + at(bottom + 1) * along_col) * (1.0 - along_row)
        + (at(top) * (1.0 - along_col) + at(top + 1) * along_col) * along_row;
    params.woodland_floor * (covered / params.woodland_plateau).min(1.0)
}

fn round(value: f64) -> f64 {
    round_half_up(value * 1000.0) / 1000.0
}

fn percentile_of(sorted: &[f64], percentile: u32) -> f64 {
    let last = (sorted.len() - 1) as f64;
    sorted[round_half_up(f64::from(percentile) / 100.0 * last).clamp(0.0, last) as usize]
}

fn distribution_of(values: &[f64], percentiles: &[u32]) -> Distribution {
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let sum: f64 = sorted.iter().sum();
    Distribution {
        min: round(sorted[0]),
        max: round(sorted[sorted.len() - 1]),
        mean: round(sum / sorted.len() as f64),
        median: round(percentile_of(&sorted, 50)),
        percentiles: percentiles
            .iter()
            .map(|cut| (format!("p{cut}"), round(percentile_of(&sorted, *cut))))
            .collect::<BTreeMap<String, f64>>(),
    }
}

// The covered fraction at both sidewalks of every vertex of one network, in the vertex order of
// its coordinate blob (left then right). A street is offset to its two sidewalks; a path, a
// boardwalk or a step street has offset 0, so `half_offset_meters` returns 0 and the single
// sample on the line stands for both of its sides. Shared by the street and path passes.
fn cover_at_vertices(
    network: &binfmt::Streets,
    projection: &Projection,
    index: &TreeIndex,
    canopy: &Canopy,
    params: &Params,
) -> Vec<f64> {
    (0..network.segments())
        .into_par_iter()
        .flat_map(|segment| {
            let from = network.starts[segment] as usize;
            let to = network.starts[segment + 1] as usize;
            let xs: Vec<f64> = network.lngs[from..to]
                .iter()
                .map(|lng| projection.x(*lng))
                .collect();
            let ys: Vec<f64> = network.lats[from..to]
                .iter()
                .map(|lat| projection.y(*lat))
                .collect();
            let offset = sidewalks::half_offset_meters(
                network.road_types[segment],
                network.flags[segment],
                network.width_feet[segment],
                params.sidewalk_inset_meters,
            );

            let mut sampled = Vec::with_capacity(binfmt::SIDES * (to - from));
            for (vertex, bearing) in sidewalks::bearings(&xs, &ys).into_iter().enumerate() {
                let at = |x: f64, y: f64| {
                    cover(index.evaluate_oriented(
                        x,
                        y,
                        bearing,
                        params.tight_sigma_along_meters,
                        params.tight_sigma_across_meters,
                    ))
                    .max(floor_at(canopy, params, x, y))
                };
                let (normal_x, normal_y) = sidewalks::left_normal(bearing);
                let left = at(
                    xs[vertex] + normal_x * offset,
                    ys[vertex] + normal_y * offset,
                );
                let right = if offset == 0.0 {
                    left
                } else {
                    at(
                        xs[vertex] - normal_x * offset,
                        ys[vertex] - normal_y * offset,
                    )
                };
                sampled.push(left);
                sampled.push(right);
            }
            sampled
        })
        .collect()
}

// Quantizes the sampled fractions into the file's density blob, in place: a covered fraction of
// 0..1 to a byte of 0..255, left then right per vertex.
fn fill_densities(network: &mut binfmt::Streets, densities: &[f64]) {
    for (byte, density) in network.densities_mut().iter_mut().zip(densities) {
        *byte = round_half_up(density * 255.0) as u8;
    }
}

pub fn run(params: &Path) -> Fallible<()> {
    let params: Params = serde_json::from_slice(&fs::read(params)?)?;
    let trees = binfmt::read_trees(&params.trees)?;
    let woodland = binfmt::read_polygons(&params.woodland, "WOOD", WOODLAND_FORMAT)?;
    let land = binfmt::read_polygons(&params.land, "LAND", LAND_FORMAT)?;
    let mut streets = binfmt::read_streets(&params.streets)?;

    let bounds = reach_bounds(&params.source_box, params.broad_sigma_meters);
    let projection = Projection::new(&bounds);
    let index = TreeIndex::new(&trees, &projection);
    let canopy = build_canopy(&params, &bounds, &projection, &woodland, &land);
    let woodland_square_km = canopy.cells as f64 * CANOPY_METERS * CANOPY_METERS / 1e6;
    eprintln!("canopy mask covers {woodland_square_km:.1} km2 of land");

    eprintln!(
        "estimating the cover distribution from {} land samples",
        params.cover_samples
    );
    let samples = sample_land(
        &index,
        &projection,
        &mut PolygonIndex::new(&land),
        &params.land_box,
        params.broad_sigma_meters,
        params.cover_samples,
        params.cover_seed,
    )?;

    // The broad canopy-area index becomes a covered fraction, then the woodland floor raises the
    // wooded points a street-tree register cannot see. This is the mean cover over land the
    // sanity check reads against the ~22% all-sources figure: street trees alone must land well
    // below it.
    let land_densities: Vec<f64> = (0..samples.field.len())
        .map(|sample| {
            cover(samples.field[sample]).max(floor_at(
                &canopy,
                &params,
                samples.xs[sample],
                samples.ys[sample],
            ))
        })
        .collect();

    eprintln!(
        "sampling the tight field at both sidewalks of {} street vertices",
        streets.vertices()
    );
    let street_densities = cover_at_vertices(&streets, &projection, &index, &canopy, &params);
    fill_densities(&mut streets, &street_densities);
    fs::write(&params.streets, &streets.bytes)?;

    // The OSM path network, when the ingest committed one: sampled with the identical loop (its
    // records carry offset 0, so one line sample stands for both sides) and its own zeroed
    // density blob filled in place, exactly as the streets file's was.
    let path_density = match &params.paths {
        Some(path) => {
            let mut paths = binfmt::read_paths(path)?;
            eprintln!(
                "sampling the tight field on {} path vertices",
                paths.vertices()
            );
            let path_densities = cover_at_vertices(&paths, &projection, &index, &canopy, &params);
            fill_densities(&mut paths, &path_densities);
            fs::write(path, &paths.bytes)?;
            Some(distribution_of(&path_densities, &params.percentiles))
        }
        None => None,
    };

    let report = Report {
        bounds,
        woodland_square_km: round(woodland_square_km),
        draws: samples.draws,
        land_density: distribution_of(&land_densities, &params.percentiles),
        street_density: distribution_of(&street_densities, &params.percentiles),
        path_density,
    };
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
