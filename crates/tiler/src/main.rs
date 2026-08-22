//! The tree-cover model, end to end: the blurred measured-canopy cover field, the Monte-Carlo
//! cover distribution, the tile pyramids and the street chunks. TypeScript fetches the sources,
//! encodes the `.bin`s and owns the manifest and the colour ramp; everything numeric is here.
//! See scripts/README.md.
//!
//! Four subcommands, and package.json is the only thing that runs any of them — no TypeScript
//! spawns cargo. The nine passes a tile build is made of used to be subcommands too, each an argv
//! wrapper over the module function `build` now calls directly.

// graph.rs's stats object is one `serde_json::json!` literal with more keys than the default 128
// expansion steps allow, and the whole-city invariants added another dozen.
#![recursion_limit = "512"]

mod association;
mod binfmt;
mod build;
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
mod graph_cache;
mod heights;
mod industrial;
mod ingest;
mod invariants;
mod manifest;
mod raster;
mod relief;
mod scenic;
mod shade;
mod sidewalks;

use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use serde::Serialize;

pub type Fallible<T> = Result<T, Box<dyn Error + Send + Sync>>;

/// A pass's report, as a file rather than as stdout: what reads it is the next command in a
/// package.json chain, which holds no pipe. The directory is created because `.build/` is
/// gitignored build glue that need not exist yet.
pub fn write_report<T: Serialize>(path: &Path, report: &T) -> Fallible<()> {
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    Ok(std::fs::write(path, serde_json::to_string(report)?)?)
}

/// `--jobs`: how many rayon threads the build runs on, a positive integer or `half` for half the
/// machine's cores. Absent, rayon keeps its own default of one per core, which for the twenty
/// minutes a full build takes leaves nothing of the machine to work on.
fn jobs(value: &str) -> Result<usize, String> {
    if value == "half" {
        let cores = std::thread::available_parallelism()
            .map_err(|error| format!("the machine's cores: {error}"))?
            .get();
        Ok((cores / 2).max(1))
    } else {
        match value.parse::<usize>() {
            Ok(0) | Err(_) => Err(format!(
                "expected a positive integer or \"half\", got {value:?}"
            )),
            Ok(threads) => Ok(threads),
        }
    }
}

#[derive(Parser)]
#[command(
    name = "tiler",
    about = "the scenic-route model: tiles, chunks and the routing graph"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Render a whole tile build from a plan file: every pass, in one process.
    Build {
        #[arg(long)]
        plan: PathBuf,
        #[arg(long, value_parser = jobs)]
        jobs: Option<usize>,
    },
    /// Fill the canopy file's crown heights and the street and path density blobs, in place, and
    /// report the cover distribution the manifest records.
    Ingest {
        #[arg(long)]
        params: PathBuf,
        #[arg(long)]
        report: PathBuf,
    },
    /// Stamp what the graph's durable key space is a function of — the plan's own per-city sources
    /// decision, and the bytes of the files it names — for the shed guard. Builds nothing.
    GraphInputs {
        #[arg(long)]
        plan: PathBuf,
        #[arg(long)]
        report: PathBuf,
    },
    /// Run the graph pipeline over the committed fixture and report the durable key hash the shed
    /// gate stamps. The fixture paths default so the package.json line carries only its report.
    KeyProbe {
        #[arg(long, default_value = "crates/tiler/fixtures/key-probe/streets.bin")]
        streets: PathBuf,
        #[arg(long, default_value = "crates/tiler/fixtures/key-probe/paths.bin")]
        paths: PathBuf,
        #[arg(long, default_value = "crates/tiler/fixtures/key-probe/sidewalks.bin")]
        sidewalks: PathBuf,
        /// The graph the probe has to write somewhere and nothing reads.
        #[arg(long, default_value_os_t = std::env::temp_dir().join("scenic-route-key-probe.bin"))]
        out: PathBuf,
        #[arg(long)]
        report: PathBuf,
    },
}

fn run() -> Fallible<()> {
    match Cli::parse().command {
        Command::Build { plan, jobs } => build::run(&plan, jobs),
        Command::Ingest { params, report } => ingest::run(&params, &report),
        Command::GraphInputs { plan, report } => build::graph_inputs(&plan, &report),
        // The durable-key probe: the graph pipeline over a committed fixture, reported as the
        // `keyHash` of its stats line. It is handed only the three sources that can put a key in the
        // space at all — everything else `graph::run` takes bakes a per-edge attribute byte over
        // edges already final, and moves no key — so what comes back is a stamp of the key
        // assignment's BEHAVIOUR, which is what scripts/graph-inputs.ts wants and what a hash of the
        // crate's source text can only stand in for. Every field is written out rather than
        // defaulted: a new graph input then fails to compile here until someone says which side of
        // the line it is on.
        Command::KeyProbe {
            streets,
            paths,
            sidewalks,
            out,
            report,
        } => graph::run(
            &graph::Args {
                streets,
                paths: Some(paths),
                sidewalks: Some(sidewalks),
                ferries: None,
                landmarks: None,
                art: None,
                highways: None,
                commercial: None,
                industrial: None,
                out,
                stranded_out: None,
                buildings: None,
                shade_params: None,
                shade_dir: None,
                elevation_bounds: None,
                alleys: true,
                canopy: None,
                cache: None,
                probe: true,
                report: Some(report),
            },
            None,
        )
        .map(drop),
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

#[cfg(test)]
mod tests {
    use super::jobs;

    #[test]
    fn a_count_is_taken_verbatim() {
        assert_eq!(jobs("3").expect("a count"), 3);
    }

    #[test]
    fn half_the_cores_is_never_none_of_them() {
        let cores = std::thread::available_parallelism()
            .expect("the machine's cores")
            .get();
        let threads = jobs("half").expect("half");

        assert_eq!(threads, (cores / 2).max(1));
        assert!(threads >= 1);
    }

    #[test]
    fn zero_and_nonsense_are_rejected() {
        for value in ["0", "-1", "1.5", "all", ""] {
            assert!(jobs(value).is_err(), "--jobs {value}");
        }
    }
}
