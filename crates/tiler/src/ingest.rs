//! `tiler ingest`: the numeric half of the tree-data ingest, in one process — the crown heights of
//! the measured-canopy polygons, then the density blobs and the cover distribution the manifest
//! records.
//!
//! It was two subcommands the ingest script spawned back to back and read reports off the pipe of.
//! Nothing between them belonged to TypeScript: they run in the same order over the same city, and
//! the blobs already travel by disk — both passes fill a region of a committed file in place. So
//! package.json sequences scripts/tree-data-fetch.ts, this, and scripts/tree-data-manifest.ts, and
//! the reports land in a file the manifest step reads rather than on a stdout someone has to
//! capture.
//!
//! The height pass is conditional on the params naming a canopy height model, which is the shape a
//! city with none states: San Francisco reads a band of its 3DEP tiles, New York a purpose-built
//! CHM, and a third city may have neither — then every polygon keeps the 0 that reads as an unknown
//! height and no tree-shade pyramid is baked.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{Fallible, densities, heights};

/// The canopy height model, as a city states it. One raster or a mosaic of them: several hundred
/// tiles are more than a command line carries, which is why this arrives as JSON rather than argv.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Chm {
    paths: Vec<PathBuf>,
    /// The band carrying height above ground, for a mosaic. Absent for a single-raster product,
    /// whose only band is the heights themselves.
    #[serde(default)]
    band: Option<usize>,
    crs: String,
}

impl Chm {
    fn source(&self) -> Fallible<heights::Source> {
        match self.band {
            Some(band) => Ok(heights::Source::Mosaic {
                paths: self.paths.clone(),
                band,
            }),
            None => match self.paths.as_slice() {
                [path] => Ok(heights::Source::Single(path.clone())),
                paths => Err(format!(
                    "a single-raster canopy height model names {} rasters; a mosaic needs its band",
                    paths.len()
                )
                .into()),
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    /// Null for a city with no height model, which is then simply not measured.
    #[serde(default)]
    chm: Option<Chm>,
    #[serde(flatten)]
    densities: densities::Params,
}

#[derive(Serialize)]
struct Report {
    #[serde(skip_serializing_if = "Option::is_none")]
    heights: Option<heights::Report>,
    #[serde(flatten)]
    densities: densities::Report,
}

pub fn run(params_file: &Path, report_file: &Path) -> Fallible<()> {
    let params: Params = serde_json::from_slice(&fs::read(params_file)?)?;
    let heights = match &params.chm {
        Some(chm) => Some(heights::run(&heights::Args {
            canopy: params.densities.canopy().to_path_buf(),
            raster: chm.source()?,
            projection: heights::projection(&chm.crs)?,
        })?),
        None => {
            eprintln!("no canopy height model; every polygon keeps an unknown height");
            None
        }
    };
    let densities = densities::run(&params.densities)?;
    crate::write_report(report_file, &Report { heights, densities })
}
