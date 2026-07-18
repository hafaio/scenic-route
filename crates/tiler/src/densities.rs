//! `tiler densities`: the covered fraction at both sidewalks of every street vertex, and the
//! cover distribution the manifest records. Run by scripts/build-tree-data.ts once the source
//! `.bin`s are written — the street file arrives with a zeroed density blob and leaves with it
//! filled, in place.
//!
//! Cover is the measured 2017 LiDAR canopy, lightly blurred: a Gaussian convolution of the
//! canopy indicator, sampled at each sidewalk offset. The street kernel is oriented — broad
//! along the road so the colour runs smooth, tight across it so the two sidewalks stay distinct
//! — while the reported land distribution reads the isotropic fill kernel, the field the pyramid
//! renders. The value is in [0, 1] by construction, and the byte it quantizes to is clamped to
//! 254 so a closed-canopy sidewalk never reads a routing-free 255.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::Fallible;
use crate::binfmt::{self, LAND_FORMAT};
use crate::geometry::{
    PolygonGrid, PolygonIndex, PolygonSet, blurred_cover, flatten, round_half_up,
};
use crate::kde::{Bearing, Projection, reach_bounds};
use crate::manifest::{Bounds, Distribution};
use crate::sidewalks;

const MAX_REJECTION_RATIO: usize = 100; // draws per accepted sample before the land is called empty

/// Everything the ingest knows and the model needs. The paths are passed rather than derived
/// so the binary has no opinion about where the repo's data lives.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    canopy: PathBuf, // the measured LiDAR canopy polygons the field convolves
    land: PathBuf,
    streets: PathBuf,
    paths: Option<PathBuf>, // the OSM path network, sampled with the same loop when present
    source_box: Bounds,     // the raw extent of the streets and canopy, before the kernel's reach
    land_box: Bounds, // the land polygons' own box, which the cover distribution is drawn over
    fill_sigma_meters: f64, // the isotropic blur the pyramid renders and the land mean reads
    tight_sigma_along_meters: f64, // the street kernel, down the road: the colour stays smooth
    tight_sigma_across_meters: f64, // and over it: the far sidewalk falls away, keeping sides apart
    sidewalk_inset_meters: f64, // curb to the centre of the sidewalk
    cover_samples: usize, // land points the reported cover distribution is estimated from
    cover_seed: u64,  // and the seed they are drawn with, so the mean does not churn
    percentiles: Vec<u32>, // the labels the reported distributions are cut at
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    bounds: Bounds,
    draws: usize,
    land_density: Distribution,
    street_density: Distribution,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_density: Option<Distribution>, // only when the params carried a paths file
}

/// Points drawn uniformly over the city's *ground area* and kept if they land on it — the
/// population the reported cover distribution is taken over. Latitude is drawn uniform in
/// sin(lat) rather than in degrees, so a degree at the top of the city is not worth more than
/// one at the bottom.
struct LandPoints {
    lngs: Vec<f64>,
    lats: Vec<f64>,
    draws: usize, // including the ones that missed the land
}

/// The mean cover the draw reports is a committed manifest value, so the draw is seeded: ChaCha8
/// because `rand` documents it as reproducible across releases, which `SmallRng` — and `StdRng`
/// across a major — explicitly are not.
fn sample_land_points(
    land: &mut PolygonIndex,
    box_: &Bounds,
    samples: usize,
    seed: u64,
) -> Fallible<LandPoints> {
    let mut random = ChaCha8Rng::seed_from_u64(seed);
    let radians = std::f64::consts::PI / 180.0;
    let sin_south = (box_.south * radians).sin();
    let sin_north = (box_.north * radians).sin();
    let mut points = LandPoints {
        lngs: Vec::with_capacity(samples),
        lats: Vec::with_capacity(samples),
        draws: 0,
    };
    let limit = samples * MAX_REJECTION_RATIO;

    while points.lngs.len() < samples {
        if points.draws >= limit {
            return Err(format!(
                "only {} of {samples} samples landed on the city in {} draws: the land mask is empty or does not overlap its own bounding box",
                points.lngs.len(),
                points.draws
            )
            .into());
        }
        points.draws += 1;
        let lng = random.random_range(box_.west..box_.east);
        let lat = random.random_range(sin_south..sin_north).asin() / radians;
        if land.contains(lng, lat) {
            points.lngs.push(lng);
            points.lats.push(lat);
        }
    }
    Ok(points)
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
    canopy: &PolygonSet,
    grid: &PolygonGrid,
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
                // The offset is placed in metre space, then handed back to the lng/lat field; the
                // kernel is oriented to the street's bearing, tight across it so the two sidewalks
                // do not blur into one.
                let at = |x: f64, y: f64| {
                    blurred_cover(
                        canopy,
                        grid,
                        projection,
                        projection.lng(x),
                        projection.lat(y),
                        bearing,
                        params.tight_sigma_along_meters,
                        params.tight_sigma_across_meters,
                    )
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
// 0..1 to a byte of 0..254, left then right per vertex. The 254 ceiling is load-bearing — a
// closed-canopy sidewalk that reached 255 would leave routing (`cost.ts`) with a free edge, its
// `maxCover < 1` invariant broken.
fn fill_densities(network: &mut binfmt::Streets, densities: &[f64]) {
    for (byte, density) in network.densities_mut().iter_mut().zip(densities) {
        *byte = round_half_up(density * 255.0).min(254.0) as u8;
    }
}

pub fn run(params: &Path) -> Fallible<()> {
    let params: Params = serde_json::from_slice(&fs::read(params)?)?;
    let canopy_polygons = binfmt::read_polygons(&params.canopy, "CNPY", binfmt::CANOPY_FORMAT)?;
    let land_polygons = binfmt::read_polygons(&params.land, "LAND", LAND_FORMAT)?;
    let mut streets = binfmt::read_streets(&params.streets)?;

    let bounds = reach_bounds(&params.source_box, params.fill_sigma_meters);
    let projection = Projection::new(&bounds);
    let canopy = flatten(&canopy_polygons);
    let grid = PolygonGrid::new(&canopy);

    eprintln!(
        "estimating the cover distribution from {} land samples",
        params.cover_samples
    );
    let mut land_test = PolygonIndex::new(&land_polygons);
    let points = sample_land_points(
        &mut land_test,
        &params.land_box,
        params.cover_samples,
        params.cover_seed,
    )?;

    // The reported cover over land is the field the pyramid renders — the isotropic fill kernel,
    // not the street's oriented one — so `meanCoverOverLand` is the map's own mean. This is the
    // figure the sanity check reads against the ~22% all-sources measurement.
    let isotropic = Bearing {
        along_x: 1.0,
        along_y: 0.0,
    };
    let land_densities: Vec<f64> = (0..points.lngs.len())
        .into_par_iter()
        .map(|sample| {
            blurred_cover(
                &canopy,
                &grid,
                &projection,
                points.lngs[sample],
                points.lats[sample],
                isotropic,
                params.fill_sigma_meters,
                params.fill_sigma_meters,
            )
        })
        .collect();

    eprintln!(
        "sampling the blurred canopy at both sidewalks of {} street vertices",
        streets.vertices()
    );
    let street_densities = cover_at_vertices(&streets, &projection, &canopy, &grid, &params);
    fill_densities(&mut streets, &street_densities);
    fs::write(&params.streets, &streets.bytes)?;

    // The OSM path network, when the ingest committed one: sampled with the identical loop (its
    // records carry offset 0, so one line sample stands for both sides) and its own zeroed
    // density blob filled in place, exactly as the streets file's was.
    let path_density = match &params.paths {
        Some(path) => {
            let mut paths = binfmt::read_paths(path)?;
            eprintln!(
                "sampling the blurred canopy on {} path vertices",
                paths.vertices()
            );
            let path_densities = cover_at_vertices(&paths, &projection, &canopy, &grid, &params);
            fill_densities(&mut paths, &path_densities);
            fs::write(path, &paths.bytes)?;
            Some(distribution_of(&path_densities, &params.percentiles))
        }
        None => None,
    };

    let report = Report {
        bounds,
        draws: points.draws,
        land_density: distribution_of(&land_densities, &params.percentiles),
        street_density: distribution_of(&street_densities, &params.percentiles),
        path_density,
    };
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
