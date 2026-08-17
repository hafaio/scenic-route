//! The tree-cover model, end to end: the blurred measured-canopy cover field, the Monte-Carlo
//! cover distribution, the tile pyramids and the street chunks. TypeScript fetches the sources,
//! encodes the `.bin`s and owns the manifest and the colour ramp; everything numeric is here.
//! See scripts/README.md.

// graph.rs's stats object is one `serde_json::json!` literal with more keys than the default 128
// expansion steps allow, and the whole-city invariants added another dozen.
#![recursion_limit = "512"]

mod association;
mod binfmt;
mod canopy;
mod caster_chunks;
mod chunks;
mod commercial;
mod conflate;
mod corners;
mod crown;
mod dem;
mod densities;
mod direct_canopy;
mod elevation;
mod genus_field;
mod geometry;
mod graph;
mod heights;
mod invariants;
mod manifest;
mod raster;
mod relief;
mod scenic;
mod shade;
mod sidewalks;

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::process::ExitCode;

pub type Fallible<T> = Result<T, Box<dyn Error + Send + Sync>>;

const USAGE: &str = "usage:
  tiler densities --params <file.json>
  tiler heights --canopy <file.bin> --chm-crs <sf-cs13|utm18n> (--chm <file.tif> | --chm-mosaic <file.txt> --chm-band <n>)
  tiler chunks --manifest <file.json> --data <dir> --chunks <dir> [--stranded-dir <dir>]
  tiler caster-chunks --manifest <file.json> --data <dir> --chunks <dir> --params <file.json>
  tiler commercial --manifest <file.json> --data <dir> --chunks <dir> --signals <dir> --lines <dir>
  tiler canopy --manifest <file.json> --ramp <file.bin> --data <dir> --tiles <dir>
  tiler shade --manifest <file.json> --data <dir> --tiles <dir> --params <file.json> --city <id>
  tiler elevation --manifest <file.json> --tiles <dir> --city <id> --dem <file.txt> --elevation-crs <sf-cs13|utm18n> --land <file.bin> [--band <n>]
  tiler genus-field --manifest <file.json> --data <dir> --tiles <dir>
  tiler graph [--alleys <true|false>] [--elevation <file.txt> --elevation-crs <sf-cs13|utm18n> --elevation-bounds <json> [--elevation-band <n>]] --streets <file.bin> [--paths <file.bin>] [--sidewalks <file.bin>] [--ferries <file.bin>] [--landmarks <file.bin>] [--art <file.bin>] [--highways <file.bin>] [--commercial <file.bin>] [--canopy <file.bin>] [--buildings <file.bin> --shade-params <file.json> --shade-dir <dir>] [--stranded-out <file.bin>] --out <file.bin>
  tiler key-probe --streets <file.bin> [--paths <file.bin>] [--sidewalks <file.bin>] --out <file.bin>
";

fn flags(mut args: impl Iterator<Item = String>) -> Fallible<HashMap<String, String>> {
    let mut flags = HashMap::new();
    while let Some(flag) = args.next() {
        let name = flag
            .strip_prefix("--")
            .ok_or_else(|| format!("expected a --flag, got \"{flag}\""))?;
        let value = args
            .next()
            .ok_or_else(|| format!("--{name} needs a value"))?;
        flags.insert(name.to_owned(), value);
    }
    Ok(flags)
}

fn path(flags: &HashMap<String, String>, name: &str) -> Fallible<PathBuf> {
    Ok(PathBuf::from(flag(flags, name)?))
}

/// The five numbers a `--elevation-crs` name stands for. One table, because two of them disagreeing
/// means a city whose graph bakes correct relief and whose terrain overlay is silently absent.
fn projection(name: Option<&str>) -> Fallible<Option<heights::Tmerc>> {
    match name {
        Some("sf-cs13") => Ok(Some(heights::SF_CS13)),
        Some("utm18n") => Ok(Some(heights::UTM_18N)),
        Some(other) => Err(format!("unknown --elevation-crs {other}").into()),
        None => Ok(None),
    }
}

fn flag(flags: &HashMap<String, String>, name: &str) -> Fallible<String> {
    flags
        .get(name)
        .cloned()
        .ok_or_else(|| format!("--{name} is required").into())
}

fn run() -> Fallible<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let flags = flags(args)?;
    match command.as_str() {
        "densities" => densities::run(&path(&flags, "params")?),
        "heights" => heights::run(&heights::Args {
            canopy: path(&flags, "canopy")?,
            // One raster or a list of them, never both — a city states which product it has.
            raster: match (flags.get("chm"), flags.get("chm-mosaic")) {
                (Some(_), Some(_)) => {
                    return Err("--chm and --chm-mosaic are alternatives".into());
                }
                (Some(chm), None) => heights::Source::Single(PathBuf::from(chm)),
                (None, Some(list)) => heights::Source::Mosaic {
                    paths: std::fs::read_to_string(list)?
                        .lines()
                        .filter(|line| !line.trim().is_empty())
                        .map(PathBuf::from)
                        .collect(),
                    band: flag(&flags, "chm-band")?.parse()?,
                },
                (None, None) => return Err("--chm or --chm-mosaic is required".into()),
            },
            projection: projection(flags.get("chm-crs").map(String::as_str))?
                .ok_or("--chm-crs is required")?,
        }),
        "chunks" => chunks::run(&chunks::Args {
            manifest: path(&flags, "manifest")?,
            data: path(&flags, "data")?,
            chunks: path(&flags, "chunks")?,
            stranded_dir: flags.get("stranded-dir").map(PathBuf::from),
        }),
        "commercial" => commercial::run(&commercial::Args {
            manifest: path(&flags, "manifest")?,
            data: path(&flags, "data")?,
            chunks: path(&flags, "chunks")?,
            signals: path(&flags, "signals")?,
            lines: path(&flags, "lines")?,
        }),
        "caster-chunks" => caster_chunks::run(&caster_chunks::Args {
            manifest: path(&flags, "manifest")?,
            data: path(&flags, "data")?,
            chunks: path(&flags, "chunks")?,
            params: path(&flags, "params")?,
        }),
        "canopy" => canopy::run(&canopy::Args {
            manifest: path(&flags, "manifest")?,
            ramp: path(&flags, "ramp")?,
            data: path(&flags, "data")?,
            tiles: path(&flags, "tiles")?,
        }),
        "shade" => shade::run(&shade::Args {
            manifest: path(&flags, "manifest")?,
            data: path(&flags, "data")?,
            tiles: path(&flags, "tiles")?,
            params: path(&flags, "params")?,
            city: flag(&flags, "city")?,
        }),
        "elevation" => elevation::run(&elevation::Args {
            manifest: path(&flags, "manifest")?,
            tiles: path(&flags, "tiles")?,
            city: flag(&flags, "city")?,
            dem: path(&flags, "dem")?,
            band: flags
                .get("band")
                .map(|value| value.parse::<usize>())
                .transpose()?
                .unwrap_or(0),
            projection: projection(Some(flag(&flags, "elevation-crs")?.as_str()))?
                .ok_or("--elevation-crs is required")?,
            land: path(&flags, "land")?,
        }),
        "genus-field" => genus_field::run(&genus_field::Args {
            manifest: path(&flags, "manifest")?,
            data: path(&flags, "data")?,
            tiles: path(&flags, "tiles")?,
        }),
        "graph" => graph::run(&graph::Args {
            streets: path(&flags, "streets")?,
            paths: flags.get("paths").map(PathBuf::from),
            sidewalks: flags.get("sidewalks").map(PathBuf::from),
            ferries: flags.get("ferries").map(PathBuf::from),
            landmarks: flags.get("landmarks").map(PathBuf::from),
            art: flags.get("art").map(PathBuf::from),
            highways: flags.get("highways").map(PathBuf::from),
            commercial: flags.get("commercial").map(PathBuf::from),
            out: path(&flags, "out")?,
            stranded_out: flags.get("stranded-out").map(PathBuf::from),
            buildings: flags.get("buildings").map(PathBuf::from),
            shade_params: flags.get("shade-params").map(PathBuf::from),
            shade_dir: flags.get("shade-dir").map(PathBuf::from),
            canopy: flags.get("canopy").map(PathBuf::from),
            elevation: flags.get("elevation").map(PathBuf::from),
            // The DEM's projection is named by the city rather than read off the tiles: a GeoTIFF
            // carries an EPSG code and not the parameters, so something has to know what 7131 is.
            elevation_projection: projection(flags.get("elevation-crs").map(String::as_str))?,
            elevation_band: flags
                .get("elevation-band")
                .map(|value| value.parse::<usize>())
                .transpose()?
                .unwrap_or(0),
            elevation_bounds: flags
                .get("elevation-bounds")
                .map(|value| serde_json::from_str(value))
                .transpose()?,
            alleys: flags.get("alleys").map(String::as_str) != Some("false"),
            probe: false,
        }),
        // The durable-key probe: the graph pipeline over a committed fixture, reported as the
        // `keyHash` of its stats line. It is handed only the three sources that can put a key in the
        // space at all — everything else `graph` takes bakes a per-edge attribute byte over edges
        // already final, and moves no key — so what comes back is a stamp of the key assignment's
        // BEHAVIOUR, which is what scripts/graph-inputs.ts wants and what a hash of the crate's
        // source text can only stand in for. Every field is written out rather than defaulted: a new
        // graph input then fails to compile here until someone says which side of the line it is on.
        "key-probe" => graph::run(&graph::Args {
            streets: path(&flags, "streets")?,
            paths: flags.get("paths").map(PathBuf::from),
            sidewalks: flags.get("sidewalks").map(PathBuf::from),
            ferries: None,
            landmarks: None,
            art: None,
            highways: None,
            commercial: None,
            out: path(&flags, "out")?,
            stranded_out: None,
            buildings: None,
            shade_params: None,
            shade_dir: None,
            elevation: None,
            elevation_projection: None,
            elevation_band: 0,
            elevation_bounds: None,
            alleys: true,
            canopy: None,
            probe: true,
        }),
        _ => Err(format!("unknown command \"{command}\"\n{USAGE}").into()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("tiler: {error}");
            ExitCode::FAILURE
        }
    }
}
