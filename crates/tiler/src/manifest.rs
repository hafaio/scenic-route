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
}

/// The measured LiDAR canopy source, when a city has one. Only the file is read here — the
/// tiler rasterizes the polygons themselves; the counts and provenance stay in the JSON.
#[derive(Deserialize)]
pub struct CanopyLayer {
    pub file: String,
}

/// Presence marks a city the genus overlay renders; the tiler reads the trees blob and the shared
/// palette, not this, so nothing inside is needed here.
#[derive(Deserialize)]
pub struct GenusLayer {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldLayer {
    pub trees: SourceFile,
    pub land: SourceFile,
    pub canopy: Option<CanopyLayer>,
    pub genus: Option<GenusLayer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreetLayer {
    pub file: String,
    pub sidewalk_inset_meters: f64, // curb to the centre of the sidewalk, either side
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
