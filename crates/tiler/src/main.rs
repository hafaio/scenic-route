//! The tree-cover model, end to end: the crown-weighted kernel density estimate, the cover
//! transform, the Monte-Carlo cover distribution, the woodland mask, the tile pyramid and the
//! street chunks. TypeScript fetches the sources, encodes the `.bin`s and owns the manifest and
//! the colour ramp; everything numeric is here.
//! See scripts/README.md.

mod binfmt;
mod canopy;
mod chunks;
mod conflate;
mod corners;
mod densities;
mod genus;
mod geometry;
mod graph;
mod kde;
mod manifest;
mod raster;
mod sidewalks;

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::process::ExitCode;

pub type Fallible<T> = Result<T, Box<dyn Error + Send + Sync>>;

const USAGE: &str = "usage:
  tiler densities --params <file.json>
  tiler chunks --manifest <file.json> --data <dir> --chunks <dir> [--paths <file.bin>]
  tiler canopy --manifest <file.json> --ramp <file.bin> --data <dir> --tiles <dir>
  tiler genus --manifest <file.json> --palette <file.bin> --data <dir> --tiles <dir>
  tiler graph --streets <file.bin> [--paths <file.bin>] --out <file.bin>
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
    flags
        .get(name)
        .map(PathBuf::from)
        .ok_or_else(|| format!("--{name} is required").into())
}

fn run() -> Fallible<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let flags = flags(args)?;
    match command.as_str() {
        "densities" => densities::run(&path(&flags, "params")?),
        "chunks" => chunks::run(&chunks::Args {
            manifest: path(&flags, "manifest")?,
            data: path(&flags, "data")?,
            chunks: path(&flags, "chunks")?,
            paths: flags.get("paths").map(PathBuf::from),
        }),
        "canopy" => canopy::run(&canopy::Args {
            manifest: path(&flags, "manifest")?,
            ramp: path(&flags, "ramp")?,
            data: path(&flags, "data")?,
            tiles: path(&flags, "tiles")?,
        }),
        "genus" => genus::run(&genus::Args {
            manifest: path(&flags, "manifest")?,
            palette: path(&flags, "palette")?,
            data: path(&flags, "data")?,
            tiles: path(&flags, "tiles")?,
        }),
        "graph" => graph::run(&graph::Args {
            streets: path(&flags, "streets")?,
            paths: flags.get("paths").map(PathBuf::from),
            out: path(&flags, "out")?,
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
