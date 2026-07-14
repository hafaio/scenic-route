//! The parts of src/tree-cover/manifest.json the tiler reads. The manifest is the single
//! source of the model constants: they are never redeclared here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Bounds {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

#[derive(Deserialize)]
pub struct SourceFile {
    pub file: String,
    pub count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldLayer {
    pub trees: SourceFile,
    pub woodland: SourceFile,
    pub land: SourceFile,
    pub broad_sigma_meters: f64,
    pub saturation_trees_per_hectare: f64,
    pub woodland_floor: f64,
    pub woodland_feather_meters: f64,
    pub woodland_plateau: f64,
}

#[derive(Deserialize)]
pub struct StreetLayer {
    pub file: String,
}

#[derive(Deserialize)]
pub struct City {
    pub id: String,
    pub bounds: Bounds,
    pub field: FieldLayer,
    pub streets: StreetLayer,
}

#[derive(Deserialize)]
pub struct Manifest {
    pub cities: Vec<City>,
}

/// What `tiler densities` reports back for the manifest, in the shape scripts/manifest.ts
/// declares. The percentile labels are the ingest's; this only fills them in.
#[derive(Serialize)]
pub struct Distribution {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub median: f64,
    pub percentiles: BTreeMap<String, f64>,
}
