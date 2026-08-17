//! `tiler build`: a tile build end to end in ONE process — whether to render at all, the output
//! directories, every pass, and the stamp that records the result — driven by a plan file.
//!
//! The TypeScript half spawns nothing: scripts/serve-sources.ts puts the verbatim sources where the
//! client can fetch them, scripts/write-plan.ts emits the plan, and package.json sequences the three.
//! So everything after the inputs are on disk is decided here, including the decision to do nothing.
//!
//! The driver used to spawn eight subcommand invocations in sequence, and one of the orderings
//! between them was load-bearing and enforced by nothing but a comment: the chunks have to be cut a
//! second time once the graph has said which walks its island drop stranded. Two more orderings are
//! new, because the commercial signals used to be built by a script nobody's build ran — they are
//! keyed on the segment order INSIDE the chunks, and the graph's commercial discount is baked from
//! the lines that pass writes. Here each stage is a function over values, so a stranded set cannot
//! be handed to the chunk pass before the graph that computes it has run.
//!
//! The plan carries what those argv lists carried, including the two things that must come from
//! TypeScript because the client imports the very same modules — the colour ramp
//! (src/tree-cover/ramp.ts) and the per-city sun-position grid (scripts/shade-schedule.ts). Its
//! schema is documented in scripts/README.md.
//!
//! `tiler graph-inputs` is here for the same reason: which sources a city hands `graph::run`, and
//! under which flags, is decided in this file, so the stamp the shed guard gates on is taken from
//! the same expressions rather than from a second reading of the plan somewhere else.

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::dem::Dem;
use crate::manifest::{City, Manifest};
use crate::{
    Fallible, canopy, caster_chunks, chunks, commercial, elevation, genus_field, graph, heights,
    shade,
};

/// The by-convention sources: `data/<kind>/<id>.bin`, listed rather than pathed because the passes
/// that read them resolve the same convention themselves. They are outside the manifest because its
/// versioned city schema would throw for existing cities if bumped, so the driver states which of
/// them it actually has on disk.
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Source {
    Sidewalks,
    Ferries,
    Landmarks,
    Art,
    Highways,
    Buildings,
}

impl Source {
    /// Every variant, so `key_space_files` can decide about each one by name and a new source
    /// cannot slip past it.
    const ALL: [Source; 6] = [
        Source::Sidewalks,
        Source::Ferries,
        Source::Landmarks,
        Source::Art,
        Source::Highways,
        Source::Buildings,
    ];

    fn directory(self) -> &'static str {
        match self {
            Source::Sidewalks => "sidewalks",
            Source::Ferries => "ferries",
            Source::Landmarks => "landmarks",
            Source::Art => "art",
            Source::Highways => "highways",
            Source::Buildings => "buildings",
        }
    }
}

/// One city's DEM. The mosaic is several hundred tiles, so the plan lists them; the projection is
/// named because a GeoTIFF carries an EPSG code and not the parameters, so something has to know
/// what 7131 is.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Elevation {
    crs: String,
    #[serde(default)]
    band: usize,
    tiles: Vec<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanCity {
    id: String,
    /// Whether this city's centreline classifies alleys, for the graph's alley invariants. New
    /// York's meaning, so a city that says nothing is asked about it.
    #[serde(default = "classifies_alleys")]
    alleys: bool,
    #[serde(default)]
    sources: Vec<Source>,
    /// The sun-position grid, absent for a city whose year yields no above-horizon bin.
    #[serde(default)]
    shade: Option<shade::Params>,
    /// Absent for a city with no elevation product; then every edge is flat and no terrain overlay
    /// is rendered.
    #[serde(default)]
    elevation: Option<Elevation>,
}

fn classifies_alleys() -> bool {
    true
}

impl PlanCity {
    fn source(&self, data: &Path, kind: Source) -> Option<PathBuf> {
        self.sources
            .contains(&kind)
            .then(|| data.join(kind.directory()).join(format!("{}.bin", self.id)))
    }
}

/// The whole build, as the driver states it. Unknown fields are rejected: a driver that misspells a
/// directory would otherwise write a pyramid nothing serves and report success.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    /// The content hash of every input a pass reads, computed by scripts/write-plan.ts. Recorded in
    /// `canopy_tiles/.stamp` after a build succeeds and compared against it before the next one, so
    /// a run whose inputs are all byte-identical to the last does nothing.
    stamp: String,
    manifest: PathBuf,
    /// The committed sources, `data/`: every pass resolves its own files under it.
    data: PathBuf,
    chunks: PathBuf,
    casters: PathBuf,
    commercial_signals: PathBuf,
    commercial_lines: PathBuf,
    /// The tile pyramid root, `public/tiles`: the shade, tree-shade and elevation passes each write
    /// their own `<name>/<city>` under it.
    tiles: PathBuf,
    canopy_tiles: PathBuf,
    genus_field_tiles: PathBuf,
    /// `public/routing`: each city's graph, its stranded list beside it, and the per-edge shade bake
    /// under `shade/<city>`.
    routing: PathBuf,
    /// The 256-step RGBA table of src/tree-cover/ramp.ts, 1024 bytes.
    ramp: Vec<u8>,
    cities: Vec<PlanCity>,
}

impl Plan {
    /// Each manifest city beside its plan entry, in manifest order. Both directions are checked:
    /// a plan naming a city the manifest does not carry is a typo, and a manifest city the plan
    /// leaves out would otherwise be silently skipped by every per-city stage while the whole-
    /// manifest ones (chunks, commercial, canopy) rendered it anyway.
    fn pair<'a>(&'a self, manifest: &'a Manifest) -> Fallible<Vec<(&'a City, &'a PlanCity)>> {
        let mut seen: HashSet<&str> = HashSet::new();
        for city in &self.cities {
            if !seen.insert(city.id.as_str()) {
                return Err(format!("the plan names {} twice", city.id).into());
            }
            if !manifest.cities.iter().any(|entry| entry.id == city.id) {
                return Err(
                    format!("the plan names {}, which the manifest does not", city.id).into(),
                );
            }
        }
        manifest
            .cities
            .iter()
            .map(|city| {
                let planned = self
                    .cities
                    .iter()
                    .find(|entry| entry.id == city.id)
                    .ok_or_else(|| format!("the plan has no entry for {}", city.id))?;
                Ok((city, planned))
            })
            .collect()
    }

    fn check_ramp(&self) -> Fallible<()> {
        if self.ramp.len() == 256 * 4 {
            Ok(())
        } else {
            Err(format!(
                "the plan's ramp is {} bytes, not the 1024 of a 256-step RGBA table",
                self.ramp.len()
            )
            .into())
        }
    }

    /// Written only once a build has succeeded, so a run killed halfway through leaves no claim that
    /// its half-written directories are current.
    fn stamp_file(&self) -> PathBuf {
        self.canopy_tiles.join(".stamp")
    }

    /// Whether the last build's output is still what this plan describes. The stamp alone is not
    /// enough: it says the inputs have not moved, not that the output is still on disk, and a
    /// hand-deleted directory or a CI cache that restored only some of them has to rebuild.
    ///
    /// Every directory a build always writes, which is `rebuilt()` plus the two the commercial pass
    /// clears for itself — the earlier list left out the canopy tiles and the commercial lines, so a
    /// restore that dropped either read as complete. The per-city pyramids under `tiles` are NOT
    /// here: a city with no buildings bakes no shade and one with no DEM bakes no terrain, so their
    /// absence is not evidence of anything. Existence, not completeness — an empty directory still
    /// passes, which is the limit of doing this without hashing the output.
    fn is_fresh(&self) -> bool {
        let Ok(recorded) = fs::read_to_string(self.stamp_file()) else {
            return false;
        };
        recorded.trim() == self.stamp
            && self
                .rebuilt()
                .into_iter()
                .chain([
                    self.commercial_signals.as_path(),
                    self.commercial_lines.as_path(),
                ])
                .all(Path::is_dir)
    }

    /// Emptied and recreated before the first pass: no pass carries a directory lifecycle, so a
    /// layer that stops rendering — a dropped city, a source that is no longer ingested — leaves
    /// nothing of its last build behind to be served. The commercial directories are absent because
    /// that pass clears its own, and `public/trees` because scripts/serve-sources.ts owns it.
    fn rebuilt(&self) -> [&Path; 5] {
        [
            &self.canopy_tiles,
            &self.genus_field_tiles,
            &self.chunks,
            &self.casters,
            &self.routing,
        ]
    }

    /// The pyramids written per city under `public/tiles`, so the pass that writes one never sees
    /// the whole directory and cannot clear it: a shrunk sun schedule or a dropped city would
    /// otherwise keep serving the bins of the last build. Cleared wholesale here, not recreated —
    /// each pass makes its own `<name>/<city>`.
    fn cleared(&self) -> [PathBuf; 3] {
        ["shade", "tree-shade", "elevation"].map(|pyramid| self.tiles.join(pyramid))
    }

    fn prepare(&self) -> Fallible<()> {
        for dir in self.rebuilt() {
            fs::remove_dir_all(dir).or_else(absent)?;
        }
        for dir in self.cleared() {
            fs::remove_dir_all(&dir).or_else(absent)?;
        }
        for dir in self.rebuilt() {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

fn absent(error: std::io::Error) -> std::io::Result<()> {
    if error.kind() == std::io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

/// The nine passes, in the order the build has always run them.
const STAGES: usize = 9;

fn stage(number: usize, name: &str, started: &Instant) {
    eprintln!(
        "[{number}/{STAGES}] {name} ({:.1}s in)",
        started.elapsed().as_secs_f64()
    );
}

/// A build, on `jobs` rayon threads or on rayon's own default of one per core when that is `None`.
/// Every pass parallelises through the global pool and none builds one of its own, so sizing it here
/// — before the first parallel iterator, which would otherwise build the default pool and leave
/// `build_global` with nothing left to size — sizes the whole build.
pub fn run(plan_file: &Path, jobs: Option<usize>) -> Fallible<()> {
    let started = Instant::now();
    if let Some(threads) = jobs {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build_global()?;
    }
    let threads = rayon::current_num_threads();
    eprintln!(
        "building on {threads} thread{}",
        if threads == 1 { "" } else { "s" }
    );
    let plan: Plan = serde_json::from_slice(&fs::read(plan_file)?)?;
    if plan.is_fresh() {
        eprintln!("street overlays are up to date");
        return Ok(());
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(&plan.manifest)?)?;
    let cities = plan.pair(&manifest)?;
    plan.check_ramp()?;
    plan.prepare()?;

    // Every mosaic is opened here, before the first pass: the tiles are read for their
    // georeferencing alone, so this is seconds, and a mistyped projection or a missing DEM tile then
    // fails in those seconds rather than twenty minutes later when the graph reaches its relief
    // bake. One `Dem` per city, shared by the terrain overlay and that bake — they resample
    // different grids over different bounds and decode their own pixels, but San Francisco's
    // 1.77 GB of tiles are georeferenced and indexed once rather than twice.
    let mut dems: HashMap<&str, Dem> = HashMap::new();
    for (_, planned) in &cities {
        if let Some(elevation) = &planned.elevation {
            let dem = Dem::open(
                &elevation.tiles,
                heights::projection(&elevation.crs)?,
                elevation.band,
            )
            .map_err(|error| format!("{}'s DEM: {error}", planned.id))?;
            dems.insert(planned.id.as_str(), dem);
        }
    }

    let chunk_args = chunks::Args {
        manifest: plan.manifest.clone(),
        data: plan.data.clone(),
        chunks: plan.chunks.clone(),
    };
    stage(1, "chunks", &started);
    let chunk_files = chunks::run(&chunk_args, &chunks::Stranded::default())?;

    // The commercial overlay's per-segment signals are snapped onto the chunks just written and
    // keyed on their segment index, which is why this takes the chunks themselves.
    stage(2, "commercial", &started);
    let lines = commercial::run(
        &commercial::Args {
            manifest: plan.manifest.clone(),
            data: plan.data.clone(),
            signals: plan.commercial_signals.clone(),
            lines: plan.commercial_lines.clone(),
        },
        &chunk_files,
    )?;

    // The caster chunks are geometry on a shared x/y grid and carry no sun position, so they are cut
    // once over every city; any city's grid carries the halo the client gathers them over.
    let sun = cities
        .iter()
        .find_map(|(_, planned)| planned.shade.as_ref());
    let any_casters = cities.iter().any(|(city, planned)| {
        planned.source(&plan.data, Source::Buildings).is_some() || city.field.canopy.is_some()
    });
    stage(3, "caster-chunks", &started);
    match sun {
        Some(params) if any_casters => caster_chunks::run(&caster_chunks::Args {
            manifest: plan.manifest.clone(),
            data: plan.data.clone(),
            chunks: plan.casters.clone(),
            params: params.clone(),
        })?,
        _ => eprintln!("no sun grid or nothing to cast a shadow; no caster chunks"),
    }

    // One shade pyramid per city, because a bin's sun position is synthesised at the city's own
    // latitude: two cities share neither a bin index nor a pyramid.
    stage(4, "shade", &started);
    for (city, planned) in &cities {
        let footprints = planned.source(&plan.data, Source::Buildings).is_some();
        if let Some(params) = &planned.shade
            && footprints
        {
            shade::run(&shade::Args {
                manifest: plan.manifest.clone(),
                data: plan.data.clone(),
                tiles: plan.tiles.clone(),
                params: params.clone(),
                city: city.id.clone(),
            })?;
        }
    }

    stage(5, "elevation", &started);
    for (city, _) in &cities {
        if let Some(dem) = dems.get_mut(city.id.as_str()) {
            elevation::run(
                &elevation::Args {
                    manifest: plan.manifest.clone(),
                    tiles: plan.tiles.clone(),
                    city: city.id.clone(),
                    // The DEM answers over water too, so the overlay is clipped to the city's own
                    // land.
                    land: plan.data.join("land").join(&city.field.land.file),
                },
                dem,
            )?;
        }
    }

    // Both pyramid passes render every manifest city that carries the layer, so each runs once when
    // any city does.
    stage(6, "canopy", &started);
    if manifest
        .cities
        .iter()
        .any(|city| city.field.canopy.is_some())
    {
        canopy::run(&canopy::Args {
            manifest: plan.manifest.clone(),
            ramp: plan.ramp.clone(),
            data: plan.data.clone(),
            tiles: plan.canopy_tiles.clone(),
        })?;
    }

    stage(7, "genus-field", &started);
    if manifest
        .cities
        .iter()
        .any(|city| city.field.genus.is_some())
    {
        genus_field::run(&genus_field::Args {
            manifest: plan.manifest.clone(),
            data: plan.data.clone(),
            tiles: plan.genus_field_tiles.clone(),
        })?;
    }

    stage(8, "graph", &started);
    let mut stranded = chunks::Stranded::default();
    for (city, planned) in &cities {
        // The per-edge shade bake rides on the same invocation as the graph and needs both the
        // footprints and the sun grid: all three of these or none of them.
        let (buildings, shade_params, shade_dir) = match (
            planned.source(&plan.data, Source::Buildings),
            &planned.shade,
        ) {
            (Some(buildings), Some(params)) => (
                Some(buildings),
                Some(params.clone()),
                Some(plan.routing.join("shade").join(&city.id)),
            ),
            _ => (None, None, None),
        };
        let dem = dems.get_mut(city.id.as_str());
        let ways = graph::run(
            &graph::Args {
                streets: plan.data.join("streets").join(&city.streets.file),
                paths: city
                    .paths
                    .as_ref()
                    .map(|layer| plan.data.join("paths").join(&layer.file)),
                sidewalks: planned.source(&plan.data, Source::Sidewalks),
                ferries: planned.source(&plan.data, Source::Ferries),
                landmarks: planned.source(&plan.data, Source::Landmarks),
                art: planned.source(&plan.data, Source::Art),
                highways: planned.source(&plan.data, Source::Highways),
                // Derived by the commercial pass rather than committed, so it is the value that pass
                // returned and not a path assembled here.
                commercial: lines.get(&city.id).map(Path::to_path_buf),
                out: plan.routing.join(format!("{}.bin", city.id)),
                // Written for the record — public/routing/<city>.stranded.bin is a documented
                // artifact — while the re-chunk below reads the same ids straight out of memory.
                stranded_out: Some(plan.routing.join(format!("{}.stranded.bin", city.id))),
                buildings,
                shade_params,
                shade_dir,
                // The measured canopy does two jobs here: integrated along every sidewalk into the
                // per-edge direct-canopy byte, and occluding the edges alongside the buildings.
                canopy: city
                    .field
                    .canopy
                    .as_ref()
                    .map(|layer| plan.data.join("canopy").join(&layer.file)),
                elevation_bounds: dem.is_some().then_some(city.bounds),
                alleys: planned.alleys,
                probe: false,
                report: None,
            },
            dem,
        )?;
        stranded.insert(&city.id, ways);
    }

    // The chunks above were cut before the graph existed, so they still offer every OSM path the
    // source network carries — including the ones the island drop took away, which the overlay would
    // draw as a tree-lined walk no route can follow. Re-cut over the same inputs with the graph's
    // answer: only the trailing stranded bitmap changes, so the commercial signals keyed on the
    // segment index stay aligned and need no rebuild.
    stage(9, "chunks (stranded)", &started);
    if manifest.cities.iter().any(|city| city.paths.is_some()) {
        chunks::run(&chunk_args, &stranded)?;
    }

    fs::write(plan.stamp_file(), &plan.stamp)?;
    eprintln!(
        "build: {STAGES} passes in {:.1}s",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// A Git LFS pointer's first line.
const LFS_POINTER: &str = "version https://git-lfs.github.com/spec/v1";
/// A pointer is ~130 bytes; this reads its head without decoding a blob.
const POINTER_HEAD: usize = 512;
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|byte| {
            [
                HEX_DIGITS[usize::from(byte >> 4)],
                HEX_DIGITS[usize::from(byte & 0xf)],
            ]
        })
        .map(char::from)
        .collect()
}

/// The oid an LFS pointer names, or `None` for bytes that are not one.
fn pointer_oid(bytes: &[u8]) -> Fallible<Option<String>> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(POINTER_HEAD)]);
    if head.starts_with(LFS_POINTER) {
        match head
            .lines()
            .find_map(|line| line.strip_prefix("oid sha256:"))
            .filter(|oid| oid.len() == 64 && oid.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            Some(oid) => Ok(Some(oid.to_owned())),
            None => Err("an LFS pointer with no sha256 oid to name its object".into()),
        }
    } else {
        Ok(None)
    }
}

/// What one input is, in the form both kinds of checkout agree on: an LFS pointer's oid IS the
/// sha256 of the object it stands for, so the pointer and the object hash to the same string. Every
/// blob under `data/` is LFS-tracked, and this is what lets the push/PR job that runs the shed guard
/// keep `lfs: false` and download not one byte of them.
fn input_oid(path: &Path) -> Fallible<String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    match pointer_oid(&bytes)? {
        Some(oid) => Ok(oid),
        None => Ok(hex(&Sha256::digest(&bytes))),
    }
}

/// What the graph's DURABLE KEY SPACE is a function of, stamped for the committed shed artifact.
///
/// A shed is pinned to an edge by `(source id, side, ordinal)` and resolves through nothing else, so
/// the question is not what can change the graph — it is what can change the SET OF KEYS, and most
/// of what a graph is built from cannot. An input that only bakes a per-edge attribute byte moves no
/// key, because the edge it is written onto was final before the bake ran.
///
/// This is the half a hash of the data answers. The other half is `tiler key-probe`, which reports
/// what the key assignment DOES rather than what its source text says. scripts/README.md has both.
impl Plan {
    /// The files handed to `graph::run` that can put a key in the space. These are three of the
    /// arguments the build assembles above, built here by the same expressions, and everything else
    /// that call takes is argued out:
    ///
    /// - ferries carry `NO_SOURCE_ID` and are appended after the walking sort and the node renumber,
    ///   so `assign_ordinals` skips them and no earlier edge moves;
    /// - landmarks, art, highways and the commercial lines are each one per-edge attribute byte,
    ///   read after the last edge is pushed;
    /// - the buildings and the sun grid drive the SHDE bake, which runs after the graph blob is
    ///   written, and the DEM the relief byte, baked over the same finished edges.
    ///
    /// The match over `Source` is exhaustive on purpose, and the arms that decline are written out
    /// rather than swept up by a wildcard. `key-probe` is protected the same way, by building a
    /// `graph::Args` literal that will not compile until a new field is given a value; without the
    /// match, a source added later could be wired into the graph and reach the keys while both
    /// halves of the guard stayed silent about it, which is the one failure this whole file exists
    /// to make impossible.
    fn key_space_files(&self, city: &City, planned: &PlanCity) -> Vec<PathBuf> {
        let mut files = vec![
            Some(self.data.join("streets").join(&city.streets.file)),
            city.paths
                .as_ref()
                .map(|layer| self.data.join("paths").join(&layer.file)),
        ];
        for source in Source::ALL {
            files.push(match source {
                Source::Sidewalks => planned.source(&self.data, source),
                Source::Ferries
                | Source::Landmarks
                | Source::Art
                | Source::Highways
                | Source::Buildings => None,
            });
        }
        files.into_iter().flatten().collect()
    }

    /// The stamp, and how many files it covers: the plan's own resolved decision — which sources
    /// this city gets, under which flags — plus the bytes of each file that decision names.
    ///
    /// Deliberately NOT the plan verbatim. The data root, the manifest's location and the DEM's
    /// `.cache` tiles are all where this checkout happens to keep things; a stamp that moved with
    /// them could never be compared against one a different machine recorded. So each file enters as
    /// its path relative to the data root, which every checkout agrees on, and the cities come in
    /// `pair`'s manifest order rather than in whatever order the plan happened to list them.
    fn key_space_stamp(&self, cities: &[(&City, &PlanCity)]) -> Fallible<(String, usize)> {
        let mut digest = Sha256::new();
        let mut files = 0;
        for (city, planned) in cities {
            digest.update(planned.id.as_bytes());
            digest.update([0]);
            // Only the whole-city invariants read this, so it steers no edge — but it is the plan's
            // statement about what this city's network IS, which is the kind of thing the stamp is
            // for, and a city flips it about once ever.
            digest.update(if planned.alleys { "alleys" } else { "none" });
            digest.update([0]);
            for path in self.key_space_files(city, planned) {
                let name = path
                    .strip_prefix(&self.data)
                    .map_err(|_| format!("{} is not under the plan's data root", path.display()))?;
                digest.update(name.to_string_lossy().as_bytes());
                digest.update([0]);
                digest.update(input_oid(&path)?.as_bytes());
                digest.update([0]);
                files += 1;
            }
        }
        Ok((hex(&digest.finalize()), files))
    }
}

/// What `bun run check-shed-inputs` compares against `public/sheds/inputs.json`, beside the key
/// probe's own report. The count is carried so a set that quietly shrank shows up in the diff rather
/// than only inside a digest.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphInputs {
    stamp: String,
    files: usize,
}

/// `tiler graph-inputs`: stamp the key space of the plan's sources decision, without building
/// anything. The plan is the artifact that decision lands in, so this reads what `tiler build` would
/// act on rather than the TypeScript that worked it out.
pub fn graph_inputs(plan_file: &Path, report: &Path) -> Fallible<()> {
    let plan: Plan = serde_json::from_slice(&fs::read(plan_file)?)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(&plan.manifest)?)?;
    let cities = plan.pair(&manifest)?;
    let (stamp, files) = plan.key_space_stamp(&cities)?;
    eprintln!("graph inputs: {files} files stamped {stamp}");
    crate::write_report(report, &GraphInputs { stamp, files })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A manifest of two cities, one of which carries neither a canopy nor a genus layer, in the
    /// shape crates/tiler/src/manifest.rs reads.
    const MANIFEST: &str = r#"{
      "cities": [
        {
          "id": "nyc",
          "bounds": {"south": 40.5, "west": -74.3, "north": 40.9, "east": -73.7},
          "field": {
            "trees": {"file": "nyc.bin"},
            "land": {"file": "nyc.bin"},
            "canopy": {"file": "nyc.bin"},
            "genus": {}
          },
          "streets": {"file": "nyc.bin", "sidewalkInsetMeters": 2},
          "paths": {"file": "nyc.bin"}
        },
        {
          "id": "sf",
          "bounds": {"south": 37.7, "west": -122.5, "north": 37.8, "east": -122.3},
          "field": {"trees": {"file": "sf.bin"}, "land": {"file": "sf.bin"}},
          "streets": {"file": "sf.bin", "sidewalkInsetMeters": 2}
        }
      ]
    }"#;

    /// A plan over that manifest. `ramp` is written short here and padded by `plan`, since a literal
    /// 1024 numbers says nothing a length check does not.
    fn plan_json(cities: &str) -> String {
        format!(
            r#"{{
              "stamp": "5eaf00d",
              "manifest": "src/tree-cover/manifest.json",
              "data": "data",
              "chunks": "public/streets",
              "casters": "public/casters",
              "commercialSignals": "public/commercial",
              "commercialLines": "public/commercial-lines",
              "tiles": "public/tiles",
              "canopyTiles": "public/tiles/canopy",
              "genusFieldTiles": "public/tiles/genus-field",
              "routing": "public/routing",
              "ramp": [],
              "cities": {cities}
            }}"#
        )
    }

    fn plan(cities: &str) -> Plan {
        let mut plan: Plan = serde_json::from_str(&plan_json(cities)).expect("a plan");
        plan.ramp = vec![0u8; 256 * 4];
        plan
    }

    fn manifest() -> Manifest {
        serde_json::from_str(MANIFEST).expect("a manifest")
    }

    const BOTH: &str = r#"[{"id": "nyc"}, {"id": "sf"}]"#;

    #[test]
    fn a_plan_entry_carries_the_sun_grid_and_the_dem_the_argv_lists_used_to() {
        let plan = plan(
            r#"[
              {"id": "nyc", "sources": ["sidewalks", "ferries", "buildings"], "alleys": true,
               "shade": {"maxZoom": 14, "maxShadowMeters": 500,
                         "buckets": [{"season": 0, "hourAngle": -30.0, "elevation": 20.0,
                                      "azimuth": 120.0, "intensity": 0.34,
                                      "samples": [{"east": 0.5, "north": 0.5,
                                                   "shadowPerHeight": 2.7}]}]}},
              {"id": "sf", "alleys": false,
               "elevation": {"crs": "sf-cs13", "band": 0, "tiles": ["a.tif", "b.tif"]}}
            ]"#,
        );

        let nyc = &plan.cities[0];
        let shade = nyc.shade.as_ref().expect("new york's sun grid");
        assert_eq!(shade.max_zoom, 14);
        assert_eq!(shade.buckets.len(), 1);
        assert_eq!(
            nyc.source(Path::new("data"), Source::Ferries),
            Some(PathBuf::from("data/ferries/nyc.bin"))
        );
        assert_eq!(nyc.source(Path::new("data"), Source::Art), None);
        let sf = &plan.cities[1];
        assert!(!sf.alleys);
        assert_eq!(sf.elevation.as_ref().expect("a dem").tiles.len(), 2);
    }

    #[test]
    fn a_city_that_says_nothing_about_alleys_gets_new_yorks_meaning() {
        assert!(plan(BOTH).cities[0].alleys);
    }

    #[test]
    fn a_source_kind_no_stage_reads_is_rejected() {
        let error = serde_json::from_str::<Plan>(&plan_json(
            r#"[{"id": "nyc", "sources": ["parks"]}, {"id": "sf"}]"#,
        ))
        .err()
        .expect("an unknown source kind");

        assert!(error.to_string().contains("parks"), "{error}");
    }

    #[test]
    fn a_misspelled_key_is_rejected_rather_than_skipping_its_stage() {
        let error = serde_json::from_str::<Plan>(&plan_json(BOTH).replace("casters", "castors"))
            .err()
            .expect("an unknown plan key");

        assert!(error.to_string().contains("castors"), "{error}");
    }

    #[test]
    fn a_ramp_that_is_not_a_256_step_table_is_rejected() {
        let mut plan = plan(BOTH);
        plan.ramp = vec![0u8; 3 * 256];

        assert!(plan.check_ramp().is_err());
    }

    #[test]
    fn the_manifest_and_the_plan_are_paired_in_manifest_order() {
        let manifest = manifest();
        let out_of_order = plan(r#"[{"id": "sf"}, {"id": "nyc"}]"#);
        let paired = out_of_order.pair(&manifest).expect("a pairing");

        let ids: Vec<&str> = paired.iter().map(|(city, _)| city.id.as_str()).collect();
        assert_eq!(ids, ["nyc", "sf"]);
        assert_eq!(paired[0].1.id, "nyc");
    }

    #[test]
    fn a_plan_city_the_manifest_does_not_carry_is_rejected() {
        let manifest = manifest();
        let error = plan(r#"[{"id": "nyc"}, {"id": "sf"}, {"id": "boston"}]"#)
            .pair(&manifest)
            .err()
            .expect("a city the manifest has never heard of");

        assert!(error.to_string().contains("boston"), "{error}");
    }

    #[test]
    fn a_manifest_city_the_plan_leaves_out_is_rejected() {
        let manifest = manifest();
        let error = plan(r#"[{"id": "nyc"}]"#)
            .pair(&manifest)
            .err()
            .expect("a city with no plan entry");

        assert!(error.to_string().contains("sf"), "{error}");
    }

    /// An empty directory of this test's own, so what it asks about is a state it set up rather than
    /// whatever the last real build left.
    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "tiler-build-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::remove_dir_all(&root)
            .or_else(absent)
            .expect("a clearing");
        root
    }

    /// A plan whose output directories are a scratch tree, so freshness can be asked about it.
    fn planted(name: &str) -> Plan {
        let root = scratch(name);
        let mut plan = plan(BOTH);
        plan.canopy_tiles = root.join("tiles/canopy");
        plan.genus_field_tiles = root.join("tiles/genus-field");
        plan.tiles = root.join("tiles");
        plan.chunks = root.join("streets");
        plan.casters = root.join("casters");
        plan.commercial_signals = root.join("commercial");
        plan.commercial_lines = root.join("commercial-lines");
        plan.routing = root.join("routing");
        plan
    }

    #[test]
    fn a_build_whose_inputs_have_not_moved_is_fresh() {
        let plan = planted("fresh");
        plan.prepare().expect("the output directories");
        // The commercial pass makes its own, so `prepare` does not.
        for dir in [&plan.commercial_signals, &plan.commercial_lines] {
            fs::create_dir_all(dir).expect("the commercial directories");
        }
        assert!(!plan.is_fresh(), "nothing has recorded a stamp yet");

        fs::write(plan.stamp_file(), &plan.stamp).expect("the stamp");

        assert!(plan.is_fresh());
    }

    #[test]
    fn a_moved_input_or_a_missing_directory_rebuilds() {
        let mut plan = planted("stale");
        plan.prepare().expect("the output directories");
        for dir in [&plan.commercial_signals, &plan.commercial_lines] {
            fs::create_dir_all(dir).expect("the commercial directories");
        }
        fs::write(plan.stamp_file(), &plan.stamp).expect("the stamp");

        // The stamp digests the inputs, so any of them moving lands on another hex string.
        let stamp = std::mem::replace(&mut plan.stamp, "deadbeef".to_owned());
        assert!(!plan.is_fresh());

        // And the stamp says only that the inputs held, never that the output is still there.
        plan.stamp = stamp;
        fs::remove_dir_all(&plan.casters).expect("a removal");
        assert!(!plan.is_fresh());
    }

    #[test]
    fn preparing_empties_the_directories_a_dropped_layer_would_leave_behind() {
        let plan = planted("prepare");
        for dir in plan.rebuilt() {
            fs::create_dir_all(dir).expect("a directory");
            fs::write(dir.join("last-build.bin"), b"stale").expect("a stale file");
        }
        for dir in plan.cleared() {
            fs::create_dir_all(dir.join("boston")).expect("a dropped city's pyramid");
        }

        plan.prepare().expect("the output directories");

        for dir in plan.rebuilt() {
            assert!(dir.is_dir(), "{dir:?} is recreated");
            assert_eq!(fs::read_dir(dir).expect("a listing").count(), 0, "{dir:?}");
        }
        for dir in plan.cleared() {
            assert!(!dir.exists(), "{dir:?} is left for its pass to make");
        }
    }

    #[test]
    fn a_city_named_twice_is_rejected() {
        let manifest = manifest();
        let error = plan(r#"[{"id": "nyc"}, {"id": "nyc"}, {"id": "sf"}]"#)
            .pair(&manifest)
            .err()
            .expect("a city named twice");

        assert!(error.to_string().contains("twice"), "{error}");
    }

    /// The two cities as the shed guard's plan states them: New York hands over its sidewalks and
    /// three sources that only bake an attribute byte, San Francisco its sidewalks alone, and the
    /// two disagree about alleys.
    const KEY_SPACE: &str = r#"[
      {"id": "nyc", "alleys": true, "sources": ["sidewalks", "ferries", "buildings"]},
      {"id": "sf", "alleys": false, "sources": ["sidewalks"]}
    ]"#;

    /// Every file the manifest above and a plan that hands over both sidewalk extracts can name,
    /// with its own path as its contents so a file read in another's place is caught.
    const SOURCES: [(&str, &str); 5] = [
        ("streets", "nyc.bin"),
        ("streets", "sf.bin"),
        ("paths", "nyc.bin"),
        ("sidewalks", "nyc.bin"),
        ("sidewalks", "sf.bin"),
    ];

    fn planted_data(name: &str) -> PathBuf {
        let root = scratch(name);
        for (kind, file) in SOURCES {
            fs::create_dir_all(root.join(kind)).expect("a source directory");
            fs::write(root.join(kind).join(file), format!("{kind}/{file}")).expect("a source");
        }
        root
    }

    fn key_space_plan(data: &Path, cities: &str) -> Plan {
        let mut plan = plan(cities);
        plan.data = data.to_path_buf();
        plan
    }

    fn stamped(plan: &Plan) -> (String, usize) {
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        plan.key_space_stamp(&cities).expect("a stamp")
    }

    /// What a checkout that took the LFS pointers holds in place of the object.
    fn pointer_for(bytes: &[u8]) -> String {
        format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize {}\n",
            hex(&Sha256::digest(bytes)),
            bytes.len()
        )
    }

    #[test]
    fn the_stamp_is_the_files_a_durable_key_can_come_out_of_and_no_others() {
        let data = planted_data("stamp");
        let (_, files) = stamped(&key_space_plan(&data, KEY_SPACE));

        // New York's streets, paths and sidewalks; San Francisco's streets and sidewalks, its
        // manifest entry carrying no OSM paths. The ferries and the buildings are not among them.
        assert_eq!(files, 5);
    }

    /// The property the whole arrangement rests on: the recorded stamp is compared against one
    /// another machine computes, so nothing about where this checkout keeps its files may enter it.
    #[test]
    fn two_checkouts_holding_the_same_sources_stamp_alike() {
        let here = planted_data("stamp-here");
        let there = planted_data("stamp-there");

        assert_eq!(
            stamped(&key_space_plan(&here, KEY_SPACE)),
            stamped(&key_space_plan(&there, KEY_SPACE))
        );
    }

    #[test]
    fn a_checkout_that_took_the_lfs_pointers_stamps_what_one_that_smudged_them_does() {
        let smudged = planted_data("stamp-smudged");
        let pointers = planted_data("stamp-pointers");
        for (kind, file) in SOURCES {
            let object = fs::read(smudged.join(kind).join(file)).expect("an object");
            fs::write(pointers.join(kind).join(file), pointer_for(&object)).expect("a pointer");
        }

        // The pointer's oid IS the object's sha256, so the fast CI job — which checks out data/**
        // with `lfs: false` and never downloads a byte of it — computes the stamp a laptop does.
        assert_eq!(
            stamped(&key_space_plan(&smudged, KEY_SPACE)),
            stamped(&key_space_plan(&pointers, KEY_SPACE))
        );
    }

    #[test]
    fn a_source_whose_bytes_moved_moves_the_stamp() {
        let data = planted_data("stamp-moved");
        let before = stamped(&key_space_plan(&data, KEY_SPACE));
        fs::write(data.join("sidewalks").join("nyc.bin"), "re-ingested").expect("a source");

        assert_ne!(stamped(&key_space_plan(&data, KEY_SPACE)), before);
    }

    /// A source withheld puts no key in the space, so the decision to hand one over is as much of
    /// the stamp as the file's bytes are.
    #[test]
    fn a_city_that_stops_handing_over_its_sidewalks_moves_the_stamp() {
        let data = planted_data("stamp-withheld");
        let before = stamped(&key_space_plan(&data, KEY_SPACE));
        let withheld = key_space_plan(
            &data,
            r#"[{"id": "nyc", "alleys": true, "sources": ["ferries", "buildings"]},
                {"id": "sf", "alleys": false, "sources": ["sidewalks"]}]"#,
        );

        let (stamp, files) = stamped(&withheld);
        assert_ne!(stamp, before.0);
        assert_eq!(files, 4);
    }

    #[test]
    fn a_city_that_changes_its_mind_about_alleys_moves_the_stamp() {
        let data = planted_data("stamp-alleys");
        let before = stamped(&key_space_plan(&data, KEY_SPACE));

        assert_ne!(
            stamped(&key_space_plan(&data, &KEY_SPACE.replace("false", "true"))),
            before
        );
    }

    /// The exclusions, which are the point of the stamp being this small: each of these is a source
    /// `graph::run` genuinely reads, and each is baked onto edges that were final before it ran.
    #[test]
    fn the_sources_that_only_bake_an_attribute_byte_are_not_in_the_stamp() {
        let data = planted_data("stamp-attributes");
        let before = stamped(&key_space_plan(&data, KEY_SPACE));

        assert_eq!(
            stamped(&key_space_plan(
                &data,
                r#"[{"id": "nyc", "alleys": true,
                     "sources": ["sidewalks", "landmarks", "art", "highways"]},
                    {"id": "sf", "alleys": false, "sources": ["sidewalks", "buildings"],
                     "elevation": {"crs": "sf-cs13", "band": 0, "tiles": ["a.tif"]}}]"#
            )),
            before
        );
    }

    /// A file the plan names and the disk lacks is the hole this all exists to close, so it is an
    /// error rather than an input quietly left out of the digest.
    #[test]
    fn a_source_the_plan_names_and_the_checkout_lacks_is_rejected() {
        let data = planted_data("stamp-missing");
        fs::remove_file(data.join("paths").join("nyc.bin")).expect("a removal");
        let manifest = manifest();
        let plan = key_space_plan(&data, KEY_SPACE);
        let error = plan
            .key_space_stamp(&plan.pair(&manifest).expect("a pairing"))
            .err()
            .expect("a source that is not there");

        assert!(error.to_string().contains("paths/nyc.bin"), "{error}");
    }

    #[test]
    fn bytes_that_are_not_a_pointer_are_hashed_as_themselves() {
        let object = b"not a pointer";

        assert_eq!(pointer_oid(object).expect("a verdict"), None);
        assert_eq!(
            pointer_oid(pointer_for(object).as_bytes()).expect("a verdict"),
            Some(hex(&Sha256::digest(object)))
        );
    }

    #[test]
    fn a_pointer_with_no_oid_is_an_error() {
        let truncated = "version https://git-lfs.github.com/spec/v1\nsize 12\n";

        assert!(pointer_oid(truncated.as_bytes()).is_err());
    }
}
