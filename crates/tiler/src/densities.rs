//! `tiler densities`: the tight field at every street vertex, and the saturation the whole
//! ramp hangs on. Run by scripts/build-tree-data.ts once the four `.bin`s are written — the
//! street file arrives with a zeroed density blob and leaves with it filled, in place.
//!
//! The saturation is what the manifest's model constants are *derived from*, so unlike the
//! tiler this cannot read them from the manifest: the ingest passes them in.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::Fallible;
use crate::binfmt::{self, LAND_FORMAT, Polygon, TREE_FORMAT, WOODLAND_FORMAT};
use crate::geometry::{self, PolygonIndex, PolygonSet, round_half_up};
use crate::kde::{Projection, TreeIndex, reach_bounds, sample_land};
use crate::manifest::{Bounds, Distribution};

const CANOPY_METERS: f64 = 20.0; // the mask raster; a 30 m feather has no detail below this
const SQUARE_METERS_PER_HECTARE: f64 = 10_000.0;

/// Everything the ingest knows and the model needs. The paths are passed rather than derived
/// so the binary has no opinion about where the repo's data lives.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    trees: PathBuf,
    woodland: PathBuf,
    land: PathBuf,
    streets: PathBuf,
    source_box: Bounds, // the raw extent of the trees and the streets, before the kernel's reach
    land_box: Bounds,   // the land polygons' own box, which the saturation samples are drawn over
    broad_sigma_meters: f64,
    tight_sigma_meters: f64,
    woodland_floor: f64,
    woodland_feather_meters: f64,
    woodland_plateau: f64,
    saturation_percentile: u32, // 97, the cut of the broad field both fields divide by
    saturation_samples: usize,
    saturation_seed: u64,
    percentiles: Vec<u32>, // the labels the reported distributions are cut at
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    bounds: Bounds,
    saturation_trees_per_hectare: f64,
    woodland_square_km: f64,
    draws: usize,
    land_density: Distribution,
    street_density: Distribution,
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

// The normalized value the canopy raises a point to, whatever the trees there say.
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

pub fn run(params: &Path) -> Fallible<()> {
    let params: Params = serde_json::from_slice(&fs::read(params)?)?;
    let trees = binfmt::read_points(&params.trees, "TREE", TREE_FORMAT)?;
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
        "estimating the p{} of the broad field from {} land samples",
        params.saturation_percentile, params.saturation_samples
    );
    let samples = sample_land(
        &index,
        &projection,
        &mut PolygonIndex::new(&land),
        &params.land_box,
        params.broad_sigma_meters,
        params.saturation_samples,
        params.saturation_seed,
    )?;
    let mut sorted = samples.field.clone();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let percentile = percentile_of(&sorted, params.saturation_percentile);
    // Both fields divide by it, so a city with no trees under its land mask would otherwise
    // come out entirely NaN rather than empty.
    if !percentile.is_finite() || percentile <= 0.0 {
        return Err(format!(
            "the p{} of the broad field over {} land samples is {percentile}: there is nothing to normalize against",
            params.saturation_percentile, params.saturation_samples
        )
        .into());
    }
    // The tiler reads the rounded figure out of the manifest, so the ingest normalizes by that
    // same figure rather than by a constant only it can see.
    let saturation_trees_per_hectare = round(percentile * SQUARE_METERS_PER_HECTARE);
    let saturation = saturation_trees_per_hectare / SQUARE_METERS_PER_HECTARE;
    eprintln!(
        "saturation is {saturation_trees_per_hectare} trees/ha, from {} draws",
        samples.draws
    );

    let land_densities: Vec<f64> = (0..samples.field.len())
        .map(|sample| {
            (samples.field[sample] / saturation).min(1.0).max(floor_at(
                &canopy,
                &params,
                samples.xs[sample],
                samples.ys[sample],
            ))
        })
        .collect();

    eprintln!(
        "sampling the tight field at {} street vertices",
        streets.vertices()
    );
    let street_densities: Vec<f64> = (0..streets.vertices())
        .into_par_iter()
        .map(|vertex| {
            let x = projection.x(streets.lngs[vertex]);
            let y = projection.y(streets.lats[vertex]);
            (index.evaluate(x, y, params.tight_sigma_meters) / saturation)
                .min(1.0)
                .max(floor_at(&canopy, &params, x, y))
        })
        .collect();
    for (byte, density) in streets.densities_mut().iter_mut().zip(&street_densities) {
        *byte = round_half_up(density * 255.0) as u8;
    }
    fs::write(&params.streets, &streets.bytes)?;

    let report = Report {
        bounds,
        saturation_trees_per_hectare,
        woodland_square_km: round(woodland_square_km),
        draws: samples.draws,
        land_density: distribution_of(&land_densities, &params.percentiles),
        street_density: distribution_of(&street_densities, &params.percentiles),
    };
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
