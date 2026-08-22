//! `tiler build`: a tile build end to end in ONE process — which passes to run at all, the output
//! directories, every pass, and the stamp each one records for itself — driven by a plan file.
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
//! the same expressions rather than from a second reading of the plan somewhere else. The keys that
//! pass caches its topology and its attribute columns under (graph_cache.rs) are computed here for
//! that reason too — they ARE its stamp, so what it thinks is current and what it reads back off
//! the disk cannot come apart.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::dem::Dem;
use crate::manifest::{City, Manifest};
use crate::{
    Fallible, canopy, caster_chunks, chunks, commercial, elevation, genus_field, graph,
    graph_cache, heights, shade,
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
    Industrial,
    Historic,
    Buildings,
}

impl Source {
    /// Every variant, so `key_space_files` can decide about each one by name and a new source
    /// cannot slip past it.
    const ALL: [Source; 8] = [
        Source::Sidewalks,
        Source::Ferries,
        Source::Landmarks,
        Source::Art,
        Source::Highways,
        Source::Industrial,
        Source::Historic,
        Source::Buildings,
    ];

    fn directory(self) -> &'static str {
        match self {
            Source::Sidewalks => "sidewalks",
            Source::Ferries => "ferries",
            Source::Landmarks => "landmarks",
            Source::Art => "art",
            Source::Highways => "highways",
            Source::Industrial => "industrial",
            Source::Historic => "historic",
            Source::Buildings => "buildings",
        }
    }
}

/// Where the plan's code map names the crate's modules, its keys being repo-relative.
const SRC: &str = "crates/tiler/src";

/// The modules the shade pyramid is a function of: shade.rs, and everything it reads through. The
/// list is the transitive closure of its imports and nothing wider, because the pyramid is most of
/// the build's twenty minutes and an edit to the graph is no reason to render it again — which is
/// the whole reason this pass declines the whole-crate epoch every other pass folds in.
const SHADE_CODE: [&str; 6] = [
    "shade.rs",
    "crown.rs",
    "raster.rs",
    "geometry.rs",
    "binfmt.rs",
    "manifest.rs",
];

/// The rest of the crate. No other pass names its own modules yet, so these reach every stamp
/// through the whole-crate epoch and this list decides nothing — it exists so that the two together
/// are the directory, which a test asserts. A module added to neither would otherwise be a module
/// no scope is a function of, and the one edit that leaves a stale pyramid standing. Nothing but
/// that test reads it, since the epoch these belong to is every file the plan carries.
#[cfg(test)]
const OUTSIDE_SHADE: [&str; 25] = [
    "association.rs",
    "build.rs",
    "canopy.rs",
    "caster_chunks.rs",
    "chunks.rs",
    "commercial.rs",
    "conflate.rs",
    "corners.rs",
    "dem.rs",
    "densities.rs",
    "direct_canopy.rs",
    "elevation.rs",
    "genus_field.rs",
    "graph.rs",
    "graph_cache.rs",
    "heights.rs",
    "historic.rs",
    "industrial.rs",
    "ingest.rs",
    "invariants.rs",
    "main.rs",
    "relief.rs",
    "sampling.rs",
    "scenic.rs",
    "sidewalks.rs",
];

/// In every scope beside the modules: a dependency's bytes can move the geometry without a line of
/// this crate changing, a feature flag can move what the compiler does with it, and a compiler bump
/// can move a low bit of `sin` through std or libm — which is a shadow in a different place.
const BUILD_FILES: [&str; 4] = [
    "Cargo.toml",
    "Cargo.lock",
    "crates/tiler/Cargo.toml",
    "rust-toolchain.toml",
];

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

/// One module hashed by its token stream: `proc_macro2` drops ordinary `//` and `/* */` comments and
/// normalizes whitespace, so what is left is what the compiler is handed. `None` for a file that
/// cannot be read or lexed, whose caller keeps the hash of its bytes.
fn token_oid(path: &Path) -> Option<String> {
    let source = fs::read_to_string(path).ok()?;
    let stream = proc_macro2::TokenStream::from_str(&source).ok()?;
    let mut digest = Sha256::new();
    field(&mut digest, stream.to_string().as_bytes());
    Some(hex(&digest.finalize()))
}

/// The whole build, as the driver states it. Unknown fields are rejected: a driver that misspells a
/// directory would otherwise write a pyramid nothing serves and report success.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    /// The tiler crate file by file — its sources, both Cargo.tomls and the workspace lockfile,
    /// each under its repo-relative path — hashed by scripts/write-plan.ts over the same file list
    /// this binary is compiled from. Whole, it is what every pass but one folds into its stamp, so
    /// any edit to the tiler invalidates them: they declare no modules of their own, and an output
    /// whose format changed would otherwise go on being served from the last build's bytes. It
    /// arrives file by file rather than as one hash because the shade pass DOES name the modules it
    /// is a function of, and can only hash those if the plan carries them apart. The `.rs` entries
    /// are rehashed here over their token streams before anything folds them — `hash_source_tokens`.
    code: BTreeMap<String, String>,
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
    /// `.build/graph-cache`: the graph pass's own cache, one `<city>` directory of content-keyed
    /// entries under it. Gitignored build glue rather than output — a build that finds it empty
    /// computes everything, which is what every build did before it existed.
    graph_cache: PathBuf,
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

    /// Every `.rs` entry of the code map, rehashed over the module's TOKEN stream in place of its
    /// bytes, before a single stamp is folded. A comment or a `cargo fmt` run then moves nothing:
    /// the epoch reaches nearly every pass, so an edit that cannot change what the tiler produces
    /// used to cost a rebake of the per-sun-position shade rows.
    ///
    /// Sound only while nothing that produces an artifact is a function of its own source layout —
    /// no `line!`, `file!`, `column!` or `#[track_caller]`, and no `include_str!`/`include_bytes!`
    /// of a file the code map does not carry. Neither appears anywhere in the crate today.
    ///
    /// Doc comments survive as `#[doc]` tokens and go on counting, since filtering them means
    /// walking attribute groups and over-invalidation is the safe direction. A file that will not
    /// read or lex keeps the byte hash it arrived with for the same reason — it is never skipped.
    ///
    /// The modules are read from the crate this binary was compiled from rather than from the
    /// plan's repo-relative keys, which would be resolved against whatever the cwd happens to be.
    fn hash_source_tokens(&mut self) {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let prefix = format!("{SRC}/");
        for (path, oid) in &mut self.code {
            let Some(module) = path.strip_prefix(&prefix).filter(|m| m.ends_with(".rs")) else {
                continue;
            };
            if let Some(hashed) = token_oid(&src.join(module)) {
                *oid = hashed;
            }
        }
    }

    /// The whole crate as one hash, which is what a pass that names no modules of its own is a
    /// function of.
    fn code_epoch(&self) -> String {
        let mut digest = Sha256::new();
        for (path, oid) in &self.code {
            field(&mut digest, path.as_bytes());
            field(&mut digest, oid.as_bytes());
        }
        hex(&digest.finalize())
    }

    /// One pass's own scope as a hash: the modules it reads through, and the crate's build inputs.
    /// A named file the plan does not carry is an error rather than a field quietly left out — the
    /// scope is only worth anything if it is the code that ran.
    fn code_scope(&self, modules: &[&str]) -> Fallible<String> {
        let mut named: Vec<String> = modules
            .iter()
            .map(|module| format!("{SRC}/{module}"))
            .chain(BUILD_FILES.iter().map(|file| (*file).to_owned()))
            .collect();
        named.sort();
        let mut digest = Sha256::new();
        for path in named {
            let oid = self
                .code
                .get(&path)
                .ok_or_else(|| format!("the plan carries no hash for {path}"))?;
            field(&mut digest, path.as_bytes());
            field(&mut digest, oid.as_bytes());
        }
        Ok(hex(&digest.finalize()))
    }

    /// The pyramids written one `<name>/<city>` at a time under `public/tiles`, so no pass ever
    /// sees the whole directory.
    const PYRAMIDS: [&'static str; 3] = ["shade", "tree-shade", "elevation"];

    /// Output no pass of this build claims: a city the manifest dropped, a pyramid a city stopped
    /// rendering. Every pass now clears only its own roots, so a directory belonging to a city the
    /// plan no longer names is a directory nothing would ever look at again — it used to be swept
    /// away by emptying every root before the first pass, and that sweep is what this replaces.
    ///
    /// Only what a pass would have written is considered. An unrecognised name under `routing` is
    /// left alone rather than guessed about: `public/routing` is a directory this build shares with
    /// whatever a later one decides to put there.
    fn reconcile(&self, manifest: &Manifest) -> Fallible<()> {
        let claimed: HashSet<&str> = manifest
            .cities
            .iter()
            .map(|city| city.id.as_str())
            .collect();
        for pyramid in Self::PYRAMIDS {
            for entry in listing(&self.tiles.join(pyramid))? {
                if !claimed.contains(city_of(&entry).as_str()) {
                    discard(&entry)?;
                }
            }
        }
        for entry in listing(&self.routing.join("shade"))? {
            if !claimed.contains(city_of(&entry).as_str()) {
                discard(&entry)?;
            }
        }
        for entry in listing(&self.graph_cache)? {
            if !claimed.contains(city_of(&entry).as_str()) {
                discard(&entry)?;
            }
        }
        for entry in listing(&self.routing)? {
            let name = file_name(&entry);
            // <id>.bin, <id>.stranded.bin, <id>.version.json and the pass's own .stamp-<id>; the
            // shade bake is a directory of its own, swept above.
            let named = name
                .strip_prefix(".stamp-")
                .map(str::to_owned)
                .or_else(|| name.ends_with(".bin").then(|| city_of(&entry)))
                .or_else(|| name.ends_with(".version.json").then(|| city_of(&entry)));
            if let Some(city) = named
                && !claimed.contains(city.as_str())
            {
                discard(&entry)?;
            }
        }
        Ok(())
    }
}

/// What a pass's claim is called wherever it lives inside a directory it owns.
const STAMP: &str = ".stamp";

/// One pass's freshness, and the output it owns the lifecycle of.
///
/// The stamp covers everything the pass reads — the plan values it acts on, the content of every
/// input file, and the stamps of the passes whose output it consumes — and it lives INSIDE that
/// pass's own output, so a directory restored from a cache carries the claim that describes it and
/// a directory that was never restored carries none.
struct Pass {
    stamp: String,
    /// Written only once the pass has succeeded, so a run killed halfway through leaves no claim
    /// that its half-written directory is current — and leaves every earlier pass's claim intact.
    stamp_file: PathBuf,
    /// A whole-build directory this pass owns outright: emptied and recreated before it reruns, so
    /// a bin, a chunk or a tile the new run does not write cannot survive from the last one. Absent
    /// for a pass that writes into a directory other cities also write into.
    root: Option<PathBuf>,
    /// One city's share of such a directory, or one city's graph blob. Removed before the pass
    /// reruns and NOT recreated: a city with no buildings bakes no shade and one with no DEM bakes
    /// no terrain, so absence is how the client tells "no such layer here" from "an empty layer".
    pieces: Vec<PathBuf>,
    /// What must be on disk for the stamp to be believed. The stamp says the inputs have not moved,
    /// not that the output is still there, and a hand-deleted directory or a cache that restored
    /// only some of them has to rebuild. Existence, not completeness — an empty directory still
    /// passes, which is the limit of doing this without hashing the output.
    witnesses: Vec<PathBuf>,
}

impl Pass {
    /// A pass that owns one whole-build directory, whose being there is what says it ran.
    fn whole(stamp: String, root: &Path) -> Pass {
        Pass {
            stamp,
            stamp_file: root.join(STAMP),
            root: Some(root.to_path_buf()),
            pieces: Vec::new(),
            witnesses: vec![root.to_path_buf()],
        }
    }

    fn is_fresh(&self) -> bool {
        let Ok(recorded) = fs::read_to_string(&self.stamp_file) else {
            return false;
        };
        recorded.trim() == self.stamp && self.witnesses.iter().all(|path| path.exists())
    }

    /// Clear this pass's output and make the directory its stamp will land in: a pass that writes
    /// only row directories under its root still has a manifest to put at the top of it, so the
    /// root has to be there before the pass runs and not only when it records.
    fn restart(&self) -> Fallible<()> {
        self.clear()?;
        if let Some(parent) = self.stamp_file.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    /// Take away what the last build left without claiming anything for this one: a whole-build root
    /// goes back to the empty directory it was before its first render, a per-city piece goes away
    /// outright. Also what a pass that renders nothing this time does INSTEAD of `restart` — it then
    /// records no stamp, and reaching the same decision again next build costs nothing.
    fn clear(&self) -> Fallible<()> {
        for path in self.root.iter().chain(&self.pieces) {
            discard(path)?;
        }
        if let Some(root) = &self.root {
            fs::create_dir_all(root)?;
        }
        Ok(())
    }

    fn record(&self) -> Fallible<()> {
        if let Some(parent) = self.stamp_file.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(fs::write(&self.stamp_file, &self.stamp)?)
    }
}

/// One city's shade pyramid, whose freshness is decided a sun bucket at a time.
///
/// A bucket's tiles are a pure function of what casts a shadow in that city, of where the sun stands
/// in THAT bucket, and of how deep and how far the pyramid is rendered — not of the other buckets,
/// and not of the schedule's shape. So the pass that costs most of the build reruns a bucket at a
/// time, and a schedule that gained a bin has not moved the other fifty-odd.
///
/// The trap is that a bucket's directory is named after its POSITION in the schedule, which sorts
/// stably by (season, hour angle): insert one bin and every later index shifts by one. Matching
/// directories to buckets by position would then re-render the whole pyramid for the one schedule
/// tweak this exists to make cheap. So nothing here matches by position — each directory records its
/// own content key, the keys are matched against the buckets wanted, and a directory that matched is
/// RENAMED into its new index.
struct ShadePyramid {
    /// `<tiles>/shade/<city>`, where the bucket directories and their keys live.
    buildings: PathBuf,
    /// `<tiles>/tree-shade/<city>`, which the same key claims: the twin comes out of the same render
    /// over the same casters. Whether it is produced at all turns on the canopy carrying a measured
    /// height, which only the pass finds out, so a bucket claims it without asking for it.
    trees: PathBuf,
    /// One content key per bucket the schedule wants, in schedule order.
    keys: Vec<String>,
}

/// Where a directory that is moving between indices waits. Inside the pyramid, so the moves stay
/// renames within the one filesystem.
const MOVING: &str = ".moving-";

impl ShadePyramid {
    /// Take both pyramids away, for a city that casts no shadow this build. Not recreated: absence
    /// is how the client tells "no shade layer here" from "an empty one".
    fn clear(&self) -> Fallible<()> {
        discard(&self.buildings)?;
        discard(&self.trees)
    }

    fn bucket(root: &Path, index: usize) -> PathBuf {
        root.join(index.to_string())
    }

    /// The key a bucket directory records, or none for one that holds no claim — a render killed
    /// before it recorded leaves a directory of half a bucket's tiles.
    fn key_of(directory: &Path) -> Fallible<Option<String>> {
        match fs::read_to_string(directory.join(STAMP)) {
            Ok(key) => Ok(Some(key.trim().to_owned())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Bring what is on disk in line with the schedule, and say which buckets are left to render:
    /// the matched directories are moved into their new indices, the unclaimed ones go away, and
    /// what no directory claimed is what the pass renders.
    fn reconcile(&self) -> Fallible<Vec<shade::Render>> {
        let mut held: Vec<(usize, Option<String>)> = Vec::new();
        for entry in listing(&self.buildings)? {
            match file_name(&entry).parse::<usize>() {
                Ok(index) if entry.is_dir() => held.push((index, Self::key_of(&entry)?)),
                // Everything else under a directory this pass owns outright: a staging name a killed
                // run left behind, a stamp an older build wrote at the top of the pyramid, and
                // buckets.json itself, which is written again from the schedule the moment this
                // returns — an old one would name the indices the renames below are about to move.
                _ => discard(&entry)?,
            }
        }

        let mut by_key: HashMap<&str, usize> = HashMap::new();
        for (index, key) in &held {
            if let Some(key) = key {
                by_key.entry(key.as_str()).or_insert(*index);
            }
        }
        let mut claimed: HashSet<usize> = HashSet::new();
        let mut moves: Vec<(usize, usize)> = Vec::new();
        let mut render: Vec<shade::Render> = Vec::new();
        for (index, key) in self.keys.iter().enumerate() {
            // Taken rather than read, so two buckets that hashed alike cannot both be answered by
            // the one directory that holds their tiles.
            match by_key.remove(key.as_str()) {
                Some(from) => {
                    claimed.insert(from);
                    if from != index {
                        moves.push((from, index));
                    }
                }
                None => render.push(shade::Render {
                    index,
                    stamp: Self::bucket(&self.buildings, index).join(STAMP),
                    key: key.clone(),
                }),
            }
        }

        for (index, _) in &held {
            if !claimed.contains(index) {
                discard(&Self::bucket(&self.buildings, *index))?;
            }
        }
        // The twin is claimed by its bucket's key and holds none of its own, so an index the
        // buildings' pyramid no longer keeps is one nothing would ever look at again.
        for entry in listing(&self.trees)? {
            let index = file_name(&entry).parse::<usize>();
            if !index.is_ok_and(|index| claimed.contains(&index)) {
                discard(&entry)?;
            }
        }
        for root in [&self.buildings, &self.trees] {
            shift(root, &moves)?;
        }
        Ok(render)
    }
}

/// Move each bucket directory that matched into its new index. In two passes through a staging
/// name, because one bucket's new index is very often another's old one, and a rename onto a
/// directory that has not moved out of the way yet would carry the wrong tiles into it.
fn shift(root: &Path, moves: &[(usize, usize)]) -> Fallible<()> {
    for (from, to) in moves {
        let source = ShadePyramid::bucket(root, *from);
        if source.is_dir() {
            fs::rename(&source, root.join(format!("{MOVING}{to}")))?;
        }
    }
    for (_, to) in moves {
        let staged = root.join(format!("{MOVING}{to}"));
        if staged.is_dir() {
            fs::rename(&staged, ShadePyramid::bucket(root, *to))?;
        }
    }
    Ok(())
}

fn absent(error: std::io::Error) -> std::io::Result<()> {
    if error.kind() == std::io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

/// Remove a path whether it is a directory or a file, and say nothing about one that is not there.
fn discard(path: &Path) -> Fallible<()> {
    if path.is_dir() {
        fs::remove_dir_all(path).or_else(absent)?;
    } else {
        fs::remove_file(path).or_else(absent)?;
    }
    Ok(())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// Which city an output path belongs to: the pyramids name a directory after the city, and the
/// routing artifacts prefix theirs with it.
fn city_of(path: &Path) -> String {
    let name = file_name(path);
    name.split_once('.')
        .map_or(name.clone(), |(id, _)| id.to_owned())
}

/// A directory's entries, or none at all when the directory has never been made.
fn listing(dir: &Path) -> Fallible<Vec<PathBuf>> {
    match fs::read_dir(dir) {
        Ok(entries) => {
            let mut paths: Vec<PathBuf> = entries
                .map(|entry| Ok(entry?.path()))
                .collect::<Fallible<Vec<PathBuf>>>()?;
            paths.sort();
            Ok(paths)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

/// One field of a stamp, NUL-terminated so two values that abut cannot read as the same digest
/// under a different split between them.
fn field(digest: &mut Sha256, bytes: &[u8]) {
    digest.update(bytes);
    digest.update([0]);
}

/// A mosaic's identity: which tiles, how big, and how they are georeferenced — not 1.77 GB of
/// pixels. The 3DEP tiles are immutable upstream products fetched into content-named cache entries,
/// so hashing them every build would buy nothing for the ten seconds of reading.
fn dem_identity(digest: &mut Sha256, elevation: Option<&Elevation>) -> Fallible<()> {
    let Some(elevation) = elevation else {
        field(digest, b"no elevation");
        return Ok(());
    };
    field(digest, elevation.crs.as_bytes());
    field(digest, &elevation.band.to_le_bytes());
    let mut tiles: Vec<(String, u64)> = elevation
        .tiles
        .iter()
        .map(|tile| {
            let bytes = fs::metadata(tile)
                .map_err(|error| format!("{}: {error}", tile.display()))?
                .len();
            Ok((file_name(tile), bytes))
        })
        .collect::<Fallible<Vec<(String, u64)>>>()?;
    tiles.sort();
    for (name, bytes) in tiles {
        field(digest, name.as_bytes());
        field(digest, &bytes.to_le_bytes());
    }
    Ok(())
}

/// The per-pass stamps, computed from the plan and the inputs on disk.
///
/// Each is a SHA-256 over which pass it is, the tiler's own code, the manifest, the plan values
/// that pass acts on, the content of every file it reads, and the stamps of the passes whose output
/// it consumes. That last part makes the set a hash DAG, which is sound because the passes are
/// deterministic — the same property the commercial signals already rest on, keyed as they are on
/// the segment order inside the chunks.
///
/// Deliberately NOT the plan verbatim, for `key_space_stamp`'s reason: the data root, the
/// manifest's location and the DEM's `.cache` tiles are all where this checkout happens to keep
/// things, and a stamp that moved with them could never be compared against one CI recorded. So a
/// file enters as its path relative to the data root, and the cities in `pair`'s manifest order.
struct Stamps<'a> {
    plan: &'a Plan,
    /// The whole crate, hashed once: what a pass that names no modules of its own is a function of.
    code: String,
    /// The shade pass's own scope, which is what keeps an edit to the graph from re-rendering
    /// twenty minutes of pyramid.
    shade_code: String,
    manifest_oid: String,
    /// Each input hashed once: the commercial pass, the shade pass and the graph all read the same
    /// buildings, and `data/` is 168 MB.
    oids: HashMap<PathBuf, String>,
}

impl<'a> Stamps<'a> {
    fn new(plan: &'a Plan) -> Fallible<Stamps<'a>> {
        Ok(Stamps {
            code: plan.code_epoch(),
            shade_code: plan.code_scope(&SHADE_CODE)?,
            plan,
            manifest_oid: input_oid(&plan.manifest)?,
            oids: HashMap::new(),
        })
    }

    /// A digest seeded with what every pass shares. Folding the whole manifest into all of them is
    /// coarse — one city's bounds moving re-renders another city's pyramid — and cheap, because the
    /// manifest changes about as often as the code beside it does.
    fn open(&self, pass: &str) -> Sha256 {
        self.scoped(pass, &self.code)
    }

    /// The same, for a pass that is a function of some of the crate rather than all of it.
    fn scoped(&self, pass: &str, code: &str) -> Sha256 {
        let mut digest = Sha256::new();
        field(&mut digest, pass.as_bytes());
        field(&mut digest, code.as_bytes());
        field(&mut digest, self.manifest_oid.as_bytes());
        digest
    }

    /// One input as the pass will find it: its path relative to the data root, then its content —
    /// or the fact that it is not there, since most of these are read only if they exist and a
    /// source appearing has to rebuild as surely as one changing.
    fn file(&mut self, digest: &mut Sha256, path: &Path) -> Fallible<()> {
        let name = path
            .strip_prefix(&self.plan.data)
            .map_err(|_| format!("{} is not under the plan's data root", path.display()))?;
        field(digest, name.to_string_lossy().as_bytes());
        if path.is_file() {
            if !self.oids.contains_key(path) {
                let oid = input_oid(path)?;
                self.oids.insert(path.to_path_buf(), oid);
            }
            field(digest, self.oids[path].as_bytes());
        } else {
            field(digest, b"absent");
        }
        Ok(())
    }

    fn files(&mut self, digest: &mut Sha256, paths: &[PathBuf]) -> Fallible<()> {
        for path in paths {
            self.file(digest, path)?;
        }
        Ok(())
    }

    /// Pass 1. The densities the overlay draws are baked into these files by the ingest, so nothing
    /// about the tree model reaches this pass except through their bytes.
    fn chunks(&mut self, cities: &[(&City, &PlanCity)]) -> Fallible<String> {
        let mut digest = self.open("chunks");
        for (city, _) in cities {
            let mut inputs = vec![self.plan.data.join("streets").join(&city.streets.file)];
            inputs.extend(
                city.paths
                    .as_ref()
                    .map(|layer| self.plan.data.join("paths").join(&layer.file)),
            );
            self.files(&mut digest, &inputs)?;
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 2, over pass 1's stamp because its signals are keyed on the segment order inside the
    /// chunks. It reads whichever of its four sources are on disk rather than what the plan's
    /// `sources` decision names, so presence is asked of the disk here too.
    fn commercial(&mut self, cities: &[(&City, &PlanCity)], chunks: &str) -> Fallible<String> {
        let mut digest = self.open("commercial");
        field(&mut digest, chunks.as_bytes());
        for (city, _) in cities {
            let inputs: Vec<PathBuf> = ["landuse", "buildings", "openstreets", "dining"]
                .iter()
                .map(|kind| self.plan.data.join(kind).join(format!("{}.bin", city.id)))
                .collect();
            self.files(&mut digest, &inputs)?;
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 3. The chunks carry no sun position at all: what they take from the grid is
    /// `maxShadowMeters` alone, the halo radius a viewport gathers casters over, which rides in
    /// their manifest. So that is what enters here and not the grid — an inserted bin moves every
    /// bin index and not one of these 166 MB of chunks, and the pass is four minutes.
    fn casters(
        &mut self,
        cities: &[(&City, &PlanCity)],
        sun: Option<&shade::Params>,
    ) -> Fallible<String> {
        let mut digest = self.open("caster-chunks");
        match sun {
            Some(params) => field(&mut digest, &params.max_shadow_meters.to_le_bytes()),
            None => field(&mut digest, b"no sun"),
        }
        for (city, _) in cities {
            let mut inputs = vec![
                self.plan
                    .data
                    .join("buildings")
                    .join(format!("{}.bin", city.id)),
                self.plan.data.join("trees").join(&city.field.trees.file),
            ];
            inputs.extend(
                city.field
                    .canopy
                    .as_ref()
                    .map(|layer| self.plan.data.join("canopy").join(&layer.file)),
            );
            self.files(&mut digest, &inputs)?;
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 4, one city and ONE of its sun buckets: what casts a shadow there, where the sun stands
    /// in this bucket, and how deep and how far the pyramid is rendered. Both pyramids the bucket
    /// writes, the buildings' and the trees', come out of this.
    ///
    /// What is deliberately absent is the rest of the schedule: a bucket rendered under a grid of
    /// fifty-eight bins is the same tiles as one rendered under a grid of fifty-nine, so an inserted
    /// bin costs one render and the moving of some directory names. The city's buildings are in it
    /// whole, since a footprint file is opaque and city-wide — a re-ingest correctly re-renders
    /// every bucket.
    fn shade_bucket(
        &mut self,
        city: &City,
        params: &shade::Params,
        bucket: &shade::Bucket,
    ) -> Fallible<String> {
        let mut digest = self.scoped("shade-bucket", &self.shade_code);
        field(&mut digest, city.id.as_bytes());
        field(&mut digest, &params.max_zoom.to_le_bytes());
        field(&mut digest, &params.max_shadow_meters.to_le_bytes());
        // Serialized rather than walked field by field, so a bin that gained a sun-disk sample
        // cannot slip past.
        field(&mut digest, &serde_json::to_vec(bucket)?);
        let mut inputs = vec![
            self.plan
                .data
                .join("buildings")
                .join(format!("{}.bin", city.id)),
        ];
        inputs.extend(
            city.field
                .canopy
                .as_ref()
                .map(|layer| self.plan.data.join("canopy").join(&layer.file)),
        );
        self.files(&mut digest, &inputs)?;
        Ok(hex(&digest.finalize()))
    }

    /// Pass 5, one city: the mosaic, and the land the overlay is clipped to.
    fn elevation(&mut self, city: &City, planned: &PlanCity) -> Fallible<String> {
        let mut digest = self.open("elevation");
        field(&mut digest, city.id.as_bytes());
        dem_identity(&mut digest, planned.elevation.as_ref())?;
        let land = self.plan.data.join("land").join(&city.field.land.file);
        self.file(&mut digest, &land)?;
        Ok(hex(&digest.finalize()))
    }

    /// Pass 6. The colour ramp is a TypeScript module the client imports, so it reaches the tiler
    /// as the 1024 bytes the plan carries and reaches this stamp the same way.
    fn canopy(&mut self, cities: &[(&City, &PlanCity)]) -> Fallible<String> {
        let mut digest = self.open("canopy");
        field(&mut digest, &self.plan.ramp);
        for (city, _) in cities {
            if let Some(layer) = &city.field.canopy {
                let inputs = vec![
                    self.plan.data.join("canopy").join(&layer.file),
                    self.plan.data.join("land").join(&city.field.land.file),
                ];
                self.files(&mut digest, &inputs)?;
            }
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 7.
    fn genus_field(&mut self, cities: &[(&City, &PlanCity)]) -> Fallible<String> {
        let mut digest = self.open("genus-field");
        for (city, _) in cities {
            if city.field.genus.is_some() {
                let trees = self.plan.data.join("trees").join(&city.field.trees.file);
                self.file(&mut digest, &trees)?;
            }
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 8's keys, one city: the topology's own, and one per attribute column baked over it.
    ///
    /// The base is what the sequential half of `graph::run` is a function of — the streets, the
    /// paths, the OSM sidewalks, the ferries and the alley flag — and nothing else, because nothing
    /// else can move an edge. Every column key folds it, which is what makes merging a column back
    /// in by position sound: a base that moved renames every column with it, so a row can never be
    /// read back beside an edge list it was not baked over.
    ///
    /// The match over `Source` is exhaustive for `key_space_files`'s reason: a source wired into the
    /// graph later must reach these keys without anyone remembering to add it, and every one of them
    /// is genuinely read by `graph::run`. The commercial lines are pass 2's output rather than a
    /// committed source, so that pass's whole stamp stands in for them.
    fn graph_keys(
        &mut self,
        city: &City,
        planned: &PlanCity,
        commercial: &str,
        bakes_shade: bool,
    ) -> Fallible<graph_cache::Keys> {
        let mut digest = self.open("graph-base");
        field(&mut digest, city.id.as_bytes());
        field(
            &mut digest,
            if planned.alleys { b"alleys" } else { b"none" },
        );
        let mut inputs = vec![self.plan.data.join("streets").join(&city.streets.file)];
        inputs.extend(
            city.paths
                .as_ref()
                .map(|layer| self.plan.data.join("paths").join(&layer.file)),
        );
        for source in Source::ALL {
            let topology = match source {
                Source::Sidewalks | Source::Ferries => true,
                // Each of these bakes one column over edges that were final before it ran, so it
                // keys that column and stays out of the base.
                Source::Landmarks
                | Source::Art
                | Source::Highways
                | Source::Industrial
                | Source::Historic
                | Source::Buildings => false,
            };
            if topology {
                inputs.extend(planned.source(&self.plan.data, source));
            }
        }
        self.files(&mut digest, &inputs)?;
        let base = hex(&digest.finalize());

        let canopy_file = city
            .field
            .canopy
            .as_ref()
            .map(|layer| self.plan.data.join("canopy").join(&layer.file));
        let buildings = planned.source(&self.plan.data, Source::Buildings);
        let mut shade = Vec::new();
        if let Some(params) = &planned.shade
            && bakes_shade
        {
            for bucket in &params.buckets {
                let mut digest = self.open("graph-shade");
                field(&mut digest, base.as_bytes());
                field(&mut digest, &params.max_zoom.to_le_bytes());
                field(&mut digest, &params.max_shadow_meters.to_le_bytes());
                // Serialized rather than walked field by field, so a bin that gained a sun-disk
                // sample cannot slip past. Deliberately this bin alone — a schedule that gained one
                // bakes the one, exactly as the pyramid renders the one.
                field(&mut digest, &serde_json::to_vec(bucket)?);
                let files: Vec<PathBuf> = buildings.iter().chain(&canopy_file).cloned().collect();
                self.files(&mut digest, &files)?;
                shade.push(hex(&digest.finalize()));
            }
        }

        let mut relief = self.open("graph-relief");
        field(&mut relief, base.as_bytes());
        dem_identity(&mut relief, planned.elevation.as_ref())?;
        let mut commercial_key = self.open("graph-commercial");
        field(&mut commercial_key, base.as_bytes());
        field(&mut commercial_key, commercial.as_bytes());
        Ok(graph_cache::Keys {
            dir: self.plan.graph_cache.join(&city.id),
            landmarks: self.graph_column(
                &base,
                "graph-landmarks",
                planned.source(&self.plan.data, Source::Landmarks).as_ref(),
            )?,
            art: self.graph_column(
                &base,
                "graph-art",
                planned.source(&self.plan.data, Source::Art).as_ref(),
            )?,
            highways: self.graph_column(
                &base,
                "graph-highways",
                planned.source(&self.plan.data, Source::Highways).as_ref(),
            )?,
            industrial: self.graph_column(
                &base,
                "graph-industrial",
                planned.source(&self.plan.data, Source::Industrial).as_ref(),
            )?,
            historic: self.graph_column(
                &base,
                "graph-historic",
                planned.source(&self.plan.data, Source::Historic).as_ref(),
            )?,
            canopy: self.graph_column(&base, "graph-canopy", canopy_file.as_ref())?,
            commercial: hex(&commercial_key.finalize()),
            relief: hex(&relief.finalize()),
            base,
            shade,
        })
    }

    /// One column's key: the base it was baked over, and the one file it reads.
    fn graph_column(
        &mut self,
        base: &str,
        name: &str,
        input: Option<&PathBuf>,
    ) -> Fallible<String> {
        let mut digest = self.open(name);
        field(&mut digest, base.as_bytes());
        match input {
            Some(path) => self.file(&mut digest, path)?,
            None => field(&mut digest, b"no source"),
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 8's stamp: its keys, and nothing besides. They are between them everything the pass
    /// reads, so the artifacts it writes are current exactly when none of them has moved — and when
    /// one has, the cache those same keys name is what keeps the rerun to the part that did.
    fn graph(&self, keys: &graph_cache::Keys) -> String {
        let mut digest = self.open("graph");
        for key in [
            &keys.base,
            &keys.landmarks,
            &keys.art,
            &keys.highways,
            &keys.commercial,
            &keys.relief,
            &keys.canopy,
            &keys.industrial,
            // Nothing but this line makes a re-ingested district file rerun the pass: the cache is
            // asked what to recompute only once the STAMP has said the pass is stale at all.
            &keys.historic,
        ] {
            field(&mut digest, key.as_bytes());
        }
        // The count as well as the keys, so a city that stopped baking shade at all moves it.
        field(&mut digest, &keys.shade.len().to_le_bytes());
        for key in &keys.shade {
            field(&mut digest, key.as_bytes());
        }
        hex(&digest.finalize())
    }

    /// Pass 9: pass 1's answer, plus what the graph decided to strand. The stranded set rather than
    /// the graph's stamp, so a graph that reran and landed on the same islands leaves the chunks
    /// alone — which is most of what a graph rerun does.
    fn stranded_chunks(
        &mut self,
        cities: &[(&City, &PlanCity)],
        chunks: &str,
        stranded: &chunks::Stranded,
    ) -> Fallible<String> {
        let mut digest = self.open("chunks-stranded");
        field(&mut digest, chunks.as_bytes());
        for (city, _) in cities {
            field(&mut digest, city.id.as_bytes());
            for way in stranded.ways(&city.id) {
                digest.update(way.to_le_bytes());
            }
        }
        Ok(hex(&digest.finalize()))
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

/// One pass, as `--only` names it on the command line, in the order the build runs them.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum PassName {
    Chunks,
    Commercial,
    CasterChunks,
    Shade,
    Elevation,
    Canopy,
    GenusField,
    Graph,
    ChunksStranded,
}

impl PassName {
    const ALL: [PassName; STAGES] = [
        PassName::Chunks,
        PassName::Commercial,
        PassName::CasterChunks,
        PassName::Shade,
        PassName::Elevation,
        PassName::Canopy,
        PassName::GenusField,
        PassName::Graph,
        PassName::ChunksStranded,
    ];

    fn name(self) -> &'static str {
        match self {
            PassName::Chunks => "chunks",
            PassName::Commercial => "commercial",
            PassName::CasterChunks => "caster-chunks",
            PassName::Shade => "shade",
            PassName::Elevation => "elevation",
            PassName::Canopy => "canopy",
            PassName::GenusField => "genus-field",
            PassName::Graph => "graph",
            PassName::ChunksStranded => "chunks-stranded",
        }
    }

    /// Whether the pass is stamped one city at a time, and so can be narrowed to one. The rest are
    /// cut or rendered over every city at once, so a `chunks:nyc` would name work that does not
    /// exist.
    fn per_city(self) -> bool {
        matches!(
            self,
            PassName::Shade | PassName::Elevation | PassName::Graph
        )
    }
}

/// Which cities one `--only` term left in for its pass.
enum Cities {
    All,
    Named(HashSet<String>),
}

/// Which passes this build may run, and whether it believes their stamps.
///
/// `--only` is what supersedes hand-editing the plan to delete a pass's block. It restricts which
/// passes may run and nothing else: a pass it leaves out does not run, records no stamp and clears
/// no directory, so whatever claim that pass already held stands — stale if it was stale — and the
/// next full build reruns it. Deleting a block could not do that. It took the pass's inputs out of
/// what the build hashed, so the build recorded a stamp saying everything was current over inputs
/// it had never looked at, and the staleness was then invisible for good. Nothing here writes a
/// stamp a full build would not have written, which is why this cannot forge freshness the same way.
pub struct Selection {
    /// `None` for every pass, which is what a build with no `--only` is.
    only: Option<HashMap<PassName, Cities>>,
    force: bool,
}

impl Selection {
    /// `--only` as it was typed: pass names, each optionally narrowed to one city as `<pass>:<city>`.
    /// An empty list is a build of all nine.
    pub fn new(only: &[String], force: bool) -> Fallible<Selection> {
        if only.is_empty() {
            Ok(Selection { only: None, force })
        } else {
            let mut passes: HashMap<PassName, Cities> = HashMap::new();
            for term in only {
                let (name, city) = match term.split_once(':') {
                    Some((name, city)) => (name, Some(city)),
                    None => (term.as_str(), None),
                };
                let pass = PassName::ALL
                    .into_iter()
                    .find(|pass| pass.name() == name)
                    .ok_or_else(|| {
                        let names: Vec<&str> =
                            PassName::ALL.iter().map(|pass| pass.name()).collect();
                        format!("--only {term}: no pass is called {name}; they are {names:?}")
                    })?;
                match city {
                    Some(_) if !pass.per_city() => {
                        return Err(format!(
                            "--only {term}: the {name} pass is run over every city at once, so it takes no city"
                        )
                        .into());
                    }
                    Some(city) => match passes
                        .entry(pass)
                        .or_insert_with(|| Cities::Named(HashSet::new()))
                    {
                        Cities::All => (),
                        Cities::Named(named) => {
                            named.insert(city.to_owned());
                        }
                    },
                    None => {
                        passes.insert(pass, Cities::All);
                    }
                }
            }
            Ok(Selection {
                only: Some(passes),
                force,
            })
        }
    }

    fn partial(&self) -> bool {
        self.only.is_some()
    }

    /// Every city a term narrowed a pass to, checked against the manifest: a typo would otherwise
    /// select no work at all and report the build that did none as a success.
    fn check(&self, manifest: &Manifest) -> Fallible<()> {
        let known: HashSet<&str> = manifest
            .cities
            .iter()
            .map(|city| city.id.as_str())
            .collect();
        for (pass, cities) in self.only.iter().flatten() {
            if let Cities::Named(named) = cities {
                for city in named {
                    if !known.contains(city.as_str()) {
                        return Err(format!(
                            "--only {}:{city}: the manifest has no city called {city}",
                            pass.name()
                        )
                        .into());
                    }
                }
            }
        }
        Ok(())
    }

    /// Whether `--only` left this pass in. Asked without a city of a per-city pass, whether it left
    /// the pass in for any city at all.
    fn selected(&self, pass: PassName, city: Option<&str>) -> bool {
        match &self.only {
            None => true,
            Some(only) => match only.get(&pass) {
                None => false,
                Some(Cities::All) => true,
                Some(Cities::Named(named)) => city.is_none_or(|city| named.contains(city)),
            },
        }
    }

    /// Whether this pass is one whose stamp `--force` set aside. Only ever the selected ones: the
    /// flag is about the passes this build is running, and cannot reach across to the others.
    fn forces(&self, pass: PassName, city: Option<&str>) -> bool {
        self.force && self.selected(pass, city)
    }

    /// Whether a selected pass would run over output whose writer this build is not running. The
    /// city is the consumer's and the producer's alike, so a graph narrowed to New York is not taken
    /// for one that is going to write San Francisco's stranded set.
    fn handoff(&self, consumer: PassName, producer: PassName, city: Option<&str>) -> bool {
        self.selected(consumer, city) && !self.selected(producer, city)
    }

    fn verdict(&self, pass: PassName, city: Option<&str>, fresh: bool) -> Verdict {
        if !self.selected(pass, city) {
            Verdict::Excluded
        } else if fresh && !self.force {
            Verdict::Current
        } else {
            Verdict::Run
        }
    }
}

/// What this build does about one pass.
#[derive(Clone, Copy)]
enum Verdict {
    /// `--only` left it out. It does not run, and neither what it wrote last build nor what it would
    /// have swept away is touched.
    Excluded,
    /// Its stamp matched and its output is still there.
    Current,
    Run,
}

impl Verdict {
    fn runs(self) -> bool {
        matches!(self, Verdict::Run)
    }

    /// What a pass prints instead of running. Named for a city on the passes that are stamped one
    /// city at a time; silent for a pass that is running, which does its own talking.
    fn announce(self, city: Option<&str>) {
        let why = match self {
            Verdict::Excluded => Some("not selected"),
            Verdict::Current => Some("up to date"),
            Verdict::Run => None,
        };
        if let Some(why) = why {
            match city {
                Some(city) => eprintln!("{city}: {why}"),
                None => eprintln!("{why}"),
            }
        }
    }
}

/// The stamp a pass downstream of this one has to fold: the one this build will leave behind.
///
/// A pass `--only` selected leaves the stamp just computed, since it is going to run if that stamp
/// does not already hold. A pass it left out leaves whatever it recorded last time — which is the
/// claim over the output the selected pass is actually about to read — or, if it has recorded
/// nothing at all, `UNRECORDED`. Folding the computed stamp regardless is the hole this closes: a
/// partial build would then record a downstream claim saying it had been built over output nobody
/// has produced yet, and the next full build, having reran the upstream onto exactly that stamp,
/// would find the downstream current and leave it standing over the stale bytes for good.
fn upstream(selection: &Selection, name: PassName, pass: &Pass) -> Fallible<String> {
    if selection.selected(name, None) {
        Ok(pass.stamp.clone())
    } else {
        match fs::read_to_string(&pass.stamp_file) {
            Ok(recorded) => Ok(recorded.trim().to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(UNRECORDED.to_owned()),
            Err(error) => Err(format!("{}: {error}", pass.stamp_file.display()).into()),
        }
    }
}

/// What an upstream pass that has claimed nothing enters a downstream stamp as. Not a stamp any pass
/// could compute — those are 64 hex digits — so a downstream keyed on it is rerun by the first build
/// that records a real one.
const UNRECORDED: &str = "unrecorded";

/// What a pass `--only` selected needs an earlier pass to have written, checked before the first of
/// them runs rather than when the read fails.
///
/// A partial build deliberately runs over output that is STALE — that is what it is for — but never
/// over output that is not there at all. The graph would otherwise be baked from commercial lines
/// nobody has written, carry no commercial discount, and then record a stamp saying it had one.
fn handoffs(plan: &Plan, cities: &[(&City, &PlanCity)], selection: &Selection) -> Fallible<()> {
    let mut wanted: Vec<(PassName, PassName, PathBuf)> = Vec::new();
    if selection.handoff(PassName::Commercial, PassName::Chunks, None) {
        wanted.push((PassName::Commercial, PassName::Chunks, plan.chunks.clone()));
    }
    if selection.handoff(PassName::ChunksStranded, PassName::Chunks, None) {
        wanted.push((
            PassName::ChunksStranded,
            PassName::Chunks,
            plan.chunks.clone(),
        ));
    }
    if selection.handoff(PassName::Graph, PassName::Commercial, None) {
        wanted.push((
            PassName::Graph,
            PassName::Commercial,
            plan.commercial_lines.clone(),
        ));
    }
    for (city, _) in cities {
        if selection.handoff(PassName::ChunksStranded, PassName::Graph, Some(&city.id)) {
            wanted.push((
                PassName::ChunksStranded,
                PassName::Graph,
                plan.routing.join(format!("{}.stranded.bin", city.id)),
            ));
        }
    }
    match wanted.into_iter().find(|(_, _, path)| !path.exists()) {
        Some((consumer, producer, path)) => Err(format!(
            "the {} pass reads {}, which is not there; run --only {} first",
            consumer.name(),
            path.display(),
            producer.name()
        )
        .into()),
        None => Ok(()),
    }
}

/// A build, on `jobs` rayon threads or on rayon's own default of one per core when that is `None`.
/// Every pass parallelises through the global pool and none builds one of its own, so sizing it here
/// — before the first parallel iterator, which would otherwise build the default pool and leave
/// `build_global` with nothing left to size — sizes the whole build.
pub fn run(plan_file: &Path, jobs: Option<usize>, selection: &Selection) -> Fallible<()> {
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
    let mut plan: Plan = serde_json::from_slice(&fs::read(plan_file)?)?;
    plan.hash_source_tokens();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&plan.manifest)?)?;
    let cities = plan.pair(&manifest)?;
    plan.check_ramp()?;
    selection.check(&manifest)?;
    handoffs(&plan, &cities, selection)?;
    // A partial build sweeps nothing. What the reconcile takes away is output for a city the
    // manifest dropped, and every directory it reaches for belongs to some pass — which `--only` may
    // not have selected, and which owns the lifecycle of its own output.
    if !selection.partial() {
        plan.reconcile(&manifest)?;
    }

    // The caster chunks are geometry on a shared x/y grid and carry no sun position, so they are cut
    // once over every city; any city's grid carries the halo the client gathers them over.
    let sun = cities
        .iter()
        .find_map(|(_, planned)| planned.shade.as_ref());
    let any_casters = cities.iter().any(|(city, planned)| {
        planned.source(&plan.data, Source::Buildings).is_some() || city.field.canopy.is_some()
    });
    // The per-edge shade bake rides on the same invocation as the graph and needs both the
    // footprints and the sun grid, so a city gets all of it or none of it.
    let baked: Vec<Option<PathBuf>> = cities
        .iter()
        .map(|(city, planned)| {
            (planned.source(&plan.data, Source::Buildings).is_some() && planned.shade.is_some())
                .then(|| plan.routing.join("shade").join(&city.id))
        })
        .collect();

    // Every stamp before the first pass runs, because what the build does next depends on which of
    // them are stale — the mosaics below are opened for the passes that will read them, and that
    // decision cannot wait until pass five.
    let mut stamps = Stamps::new(&plan)?;
    let chunk_pass = Pass::whole(stamps.chunks(&cities)?, &plan.chunks);
    // The two handovers between passes enter the downstream stamp as what THIS build will leave, so
    // a partial build never claims to have been built over output it has not produced.
    let chunks_upstream = upstream(selection, PassName::Chunks, &chunk_pass)?;
    let commercial_pass = Pass {
        stamp: stamps.commercial(&cities, &chunks_upstream)?,
        stamp_file: plan.commercial_signals.join(STAMP),
        // That pass empties both of its own directories, since it is the one that knows a city with
        // no served chunk writes no file at all.
        root: None,
        pieces: Vec::new(),
        witnesses: vec![
            plan.commercial_signals.clone(),
            plan.commercial_lines.clone(),
        ],
    };
    let caster_pass = Pass::whole(stamps.casters(&cities, sun)?, &plan.casters);
    // Alone among the passes, shade is stamped below itself: one key per sun bucket rather than one
    // for the city, since the pyramid is most of the build and no bucket is a function of another.
    let shade_pyramids: Vec<ShadePyramid> = cities
        .iter()
        .map(|(city, planned)| {
            Ok(ShadePyramid {
                buildings: plan.tiles.join("shade").join(&city.id),
                trees: plan.tiles.join("tree-shade").join(&city.id),
                keys: match &planned.shade {
                    Some(params) => params
                        .buckets
                        .iter()
                        .map(|bucket| stamps.shade_bucket(city, params, bucket))
                        .collect::<Fallible<Vec<String>>>()?,
                    None => Vec::new(),
                },
            })
        })
        .collect::<Fallible<Vec<ShadePyramid>>>()?;
    let elevation_passes: Vec<Pass> = cities
        .iter()
        .map(|(city, planned)| {
            let root = plan.tiles.join("elevation").join(&city.id);
            Ok(Pass {
                stamp: stamps.elevation(city, planned)?,
                stamp_file: root.join(STAMP),
                root: None,
                pieces: vec![root.clone()],
                witnesses: vec![root],
            })
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    let canopy_pass = Pass::whole(stamps.canopy(&cities)?, &plan.canopy_tiles);
    let genus_pass = Pass::whole(stamps.genus_field(&cities)?, &plan.genus_field_tiles);
    // The graph's keys before its stamp, because the stamp IS its keys: the base's, and one per
    // attribute column over it. What the pass rebuilds when it reruns is decided by the same set.
    let commercial_upstream = upstream(selection, PassName::Commercial, &commercial_pass)?;
    let graph_keys: Vec<graph_cache::Keys> = cities
        .iter()
        .zip(&baked)
        .map(|((city, planned), bake)| {
            stamps.graph_keys(city, planned, &commercial_upstream, bake.is_some())
        })
        .collect::<Fallible<Vec<graph_cache::Keys>>>()?;
    let graph_passes: Vec<Pass> = cities
        .iter()
        .zip(&baked)
        .enumerate()
        .map(|(index, ((city, _), bake))| {
            let blob = plan.routing.join(format!("{}.bin", city.id));
            let stranded = plan.routing.join(format!("{}.stranded.bin", city.id));
            Ok(Pass {
                stamp: stamps.graph(&graph_keys[index]),
                stamp_file: plan.routing.join(format!(".stamp-{}", city.id)),
                root: None,
                pieces: vec![
                    blob.clone(),
                    plan.routing.join(format!("{}.version.json", city.id)),
                    stranded.clone(),
                    plan.routing.join("shade").join(&city.id),
                ],
                witnesses: [blob, stranded].into_iter().chain(bake.clone()).collect(),
            })
        })
        .collect::<Fallible<Vec<Pass>>>()?;

    // Every mosaic a stale pass will read is opened here, before the first pass: the tiles are read
    // for their georeferencing alone, so this is seconds, and a mistyped projection or a missing DEM
    // tile then fails in those seconds rather than twenty minutes later when the graph reaches its
    // relief bake. One `Dem` per city, shared by the terrain overlay and that bake — they resample
    // different grids over different bounds and decode their own pixels, but San Francisco's 1.77 GB
    // of tiles are georeferenced and indexed once rather than twice. A build whose terrain and graph
    // are both current opens nothing, which is what makes a no-op build a matter of milliseconds.
    let mut dems: HashMap<&str, Dem> = HashMap::new();
    for (index, (_, planned)) in cities.iter().enumerate() {
        // A stale graph that already holds its relief column reads no DEM: the bake is what wants
        // the pixels, and its column is keyed on the mosaic's identity.
        let keys = &graph_keys[index];
        let city = cities[index].0.id.as_str();
        // A forced graph recomputes the columns it would otherwise have read back, the relief among
        // them, so it opens the mosaic a cached one leaves alone.
        let graph_reads_dem = selection
            .verdict(PassName::Graph, Some(city), graph_passes[index].is_fresh())
            .runs()
            && (selection.forces(PassName::Graph, Some(city))
                || !graph_cache::holds(&keys.dir, graph_cache::RELIEF, &keys.relief));
        let terrain_runs = selection
            .verdict(
                PassName::Elevation,
                Some(city),
                elevation_passes[index].is_fresh(),
            )
            .runs();
        if let Some(elevation) = &planned.elevation
            && (terrain_runs || graph_reads_dem)
        {
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
    // Nothing of the first pass's answer but the directory it filled, which the commercial pass
    // reads back file by file — so a skipped pass 1 hands over the same value a run of it would.
    let chunks_verdict = selection.verdict(PassName::Chunks, None, chunk_pass.is_fresh());
    let chunk_files = if chunks_verdict.runs() {
        chunk_pass.restart()?;
        let cut = chunks::run(&chunk_args, &chunks::Stranded::default())?;
        chunk_pass.record()?;
        cut
    } else {
        chunks_verdict.announce(None);
        chunks::Chunks {
            dir: plan.chunks.clone(),
        }
    };

    // The commercial overlay's per-segment signals are snapped onto the chunks just written and
    // keyed on their segment index, which is why this takes the chunks themselves.
    stage(2, "commercial", &started);
    let commercial_verdict =
        selection.verdict(PassName::Commercial, None, commercial_pass.is_fresh());
    let lines = if !commercial_verdict.runs() {
        commercial_verdict.announce(None);
        commercial::Lines::written(&plan.commercial_lines, &manifest)
    } else {
        commercial_pass.restart()?;
        let written = commercial::run(
            &commercial::Args {
                manifest: plan.manifest.clone(),
                data: plan.data.clone(),
                signals: plan.commercial_signals.clone(),
                lines: plan.commercial_lines.clone(),
            },
            &chunk_files,
        )?;
        commercial_pass.record()?;
        written
    };

    stage(3, "caster-chunks", &started);
    let casters_verdict = selection.verdict(PassName::CasterChunks, None, caster_pass.is_fresh());
    match sun {
        Some(params) if any_casters => {
            if casters_verdict.runs() {
                caster_pass.restart()?;
                caster_chunks::run(&caster_chunks::Args {
                    manifest: plan.manifest.clone(),
                    data: plan.data.clone(),
                    chunks: plan.casters.clone(),
                    params: params.clone(),
                })?;
                caster_pass.record()?;
            } else {
                casters_verdict.announce(None);
            }
        }
        _ if !selection.selected(PassName::CasterChunks, None) => casters_verdict.announce(None),
        _ => {
            caster_pass.clear()?;
            eprintln!("no sun grid or nothing to cast a shadow; no caster chunks");
        }
    }

    // One shade pyramid per city, because a bin's sun position is synthesised at the city's own
    // latitude: two cities share neither a bin index nor a pyramid.
    stage(4, "shade", &started);
    for ((city, planned), pyramid) in cities.iter().zip(&shade_pyramids) {
        let footprints = planned.source(&plan.data, Source::Buildings).is_some();
        let selected = selection.selected(PassName::Shade, Some(&city.id));
        match &planned.shade {
            Some(params) if footprints && selected => {
                // A forced pyramid comes down before it is reconciled, so every key the schedule
                // wants is one nothing on disk claims and every bin is rendered again.
                if selection.forces(PassName::Shade, Some(&city.id)) {
                    pyramid.clear()?;
                }
                let render = pyramid.reconcile()?;
                // Written before a tile is rendered rather than after: the reconcile has already
                // moved the kept buckets into their new indices, and a schedule naming the old ones
                // would send the client to another bin's tiles. A bucket the render has not reached
                // yet is a directory of 404s, which it reads as no shade at all.
                shade::write_schedule(&pyramid.buildings, params)?;
                if render.is_empty() {
                    Verdict::Current.announce(Some(&city.id));
                } else {
                    eprintln!(
                        "{}: {} of {} buckets to render",
                        city.id,
                        render.len(),
                        params.buckets.len()
                    );
                    shade::run(&shade::Args {
                        manifest: plan.manifest.clone(),
                        data: plan.data.clone(),
                        tiles: plan.tiles.clone(),
                        params: params.clone(),
                        city: city.id.clone(),
                        render,
                    })?;
                }
            }
            _ if !selected => Verdict::Excluded.announce(Some(&city.id)),
            _ => pyramid.clear()?,
        }
    }

    stage(5, "elevation", &started);
    for ((city, planned), pass) in cities.iter().zip(&elevation_passes) {
        let verdict = selection.verdict(PassName::Elevation, Some(&city.id), pass.is_fresh());
        if !selection.selected(PassName::Elevation, Some(&city.id)) {
            verdict.announce(Some(&city.id));
        } else if planned.elevation.is_none() {
            pass.clear()?;
        } else if !verdict.runs() {
            verdict.announce(Some(&city.id));
        } else {
            let dem = dems
                .get_mut(city.id.as_str())
                .ok_or_else(|| format!("{}'s DEM was never opened", city.id))?;
            pass.restart()?;
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
            pass.record()?;
        }
    }

    // Both pyramid passes render every manifest city that carries the layer, so each runs once when
    // any city does.
    stage(6, "canopy", &started);
    let canopy_verdict = selection.verdict(PassName::Canopy, None, canopy_pass.is_fresh());
    if !selection.selected(PassName::Canopy, None) {
        canopy_verdict.announce(None);
    } else if manifest
        .cities
        .iter()
        .any(|city| city.field.canopy.is_some())
    {
        if !canopy_verdict.runs() {
            canopy_verdict.announce(None);
        } else {
            canopy_pass.restart()?;
            canopy::run(&canopy::Args {
                manifest: plan.manifest.clone(),
                ramp: plan.ramp.clone(),
                data: plan.data.clone(),
                tiles: plan.canopy_tiles.clone(),
            })?;
            canopy_pass.record()?;
        }
    } else {
        canopy_pass.clear()?;
    }

    stage(7, "genus-field", &started);
    let genus_verdict = selection.verdict(PassName::GenusField, None, genus_pass.is_fresh());
    if !selection.selected(PassName::GenusField, None) {
        genus_verdict.announce(None);
    } else if manifest
        .cities
        .iter()
        .any(|city| city.field.genus.is_some())
    {
        if !genus_verdict.runs() {
            genus_verdict.announce(None);
        } else {
            genus_pass.restart()?;
            genus_field::run(&genus_field::Args {
                manifest: plan.manifest.clone(),
                data: plan.data.clone(),
                tiles: plan.genus_field_tiles.clone(),
            })?;
            genus_pass.record()?;
        }
    } else {
        genus_pass.clear()?;
    }

    stage(8, "graph", &started);
    let mut stranded = chunks::Stranded::default();
    for (index, (city, planned)) in cities.iter().enumerate() {
        let pass = &graph_passes[index];
        let stranded_file = plan.routing.join(format!("{}.stranded.bin", city.id));
        let verdict = selection.verdict(PassName::Graph, Some(&city.id), pass.is_fresh());
        if !verdict.runs() {
            verdict.announce(Some(&city.id));
            // The re-chunk below wants this city's stranded ways whether or not the graph that
            // computed them ran, and the artifact beside the graph is where they were written. Read
            // only when that pass is going to run: `--only graph:nyc` has no business opening San
            // Francisco's.
            if selection.selected(PassName::ChunksStranded, None) {
                stranded.insert(&city.id, graph::read_stranded(&stranded_file)?);
            }
            continue;
        }
        // A forced graph recomputes what it cached rather than reading it back, so the entries go
        // the way the stamp does. Only this city's: the cache directory is per city, and a pass
        // narrowed to one has no business in another's.
        if selection.forces(PassName::Graph, Some(&city.id)) {
            discard(&graph_keys[index].dir)?;
        }
        let (buildings, shade_params, shade_dir) = match &baked[index] {
            Some(dir) => (
                planned.source(&plan.data, Source::Buildings),
                planned.shade.clone(),
                Some(dir.clone()),
            ),
            None => (None, None, None),
        };
        let dem = dems.get_mut(city.id.as_str());
        pass.restart()?;
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
                industrial: planned.source(&plan.data, Source::Industrial),
                historic: planned.source(&plan.data, Source::Historic),
                out: plan.routing.join(format!("{}.bin", city.id)),
                // Written for the record — public/routing/<city>.stranded.bin is a documented
                // artifact — while the re-chunk below reads the same ids straight out of memory.
                stranded_out: Some(stranded_file),
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
                elevation_bounds: planned.elevation.is_some().then_some(city.bounds),
                alleys: planned.alleys,
                cache: Some(graph_keys[index].clone()),
                probe: false,
                report: None,
            },
            dem,
        )?;
        pass.record()?;
        stranded.insert(&city.id, ways);
    }

    // The chunks above were cut before the graph existed, so they still offer every OSM path the
    // source network carries — including the ones the island drop took away, which the overlay would
    // draw as a tree-lined walk no route can follow. Re-cut over the same inputs with the graph's
    // answer: only the trailing stranded bitmap changes, so the commercial signals keyed on the
    // segment index stay aligned and need no rebuild.
    stage(9, "chunks (stranded)", &started);
    // It rewrites what pass 1 wrote, in place, so it clears nothing: its stamp sits beside that
    // pass's own inside the same directory.
    let stranded_pass = Pass {
        stamp: stamps.stranded_chunks(&cities, &chunks_upstream, &stranded)?,
        stamp_file: plan.chunks.join(".stamp-stranded"),
        root: None,
        pieces: Vec::new(),
        witnesses: vec![plan.chunks.clone()],
    };
    let stranded_verdict =
        selection.verdict(PassName::ChunksStranded, None, stranded_pass.is_fresh());
    if !selection.selected(PassName::ChunksStranded, None) {
        stranded_verdict.announce(None);
    } else if manifest.cities.iter().any(|city| city.paths.is_some()) {
        if !stranded_verdict.runs() {
            stranded_verdict.announce(None);
        } else {
            chunks::run(&chunk_args, &stranded)?;
            stranded_pass.record()?;
        }
    }

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
    /// - landmarks, art, highways, the commercial lines, the industrial lots and the historic
    ///   districts are each one per-edge attribute byte, read after the last edge is pushed;
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
                | Source::Industrial
                | Source::Historic
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
    use proc_macro2::{Delimiter, TokenStream, TokenTree};

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
              "code": {{}},
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
              "graphCache": ".build/graph-cache",
              "ramp": [],
              "cities": {cities}
            }}"#
        )
    }

    fn plan(cities: &str) -> Plan {
        let mut plan: Plan = serde_json::from_str(&plan_json(cities)).expect("a plan");
        plan.ramp = vec![0u8; 256 * 4];
        plan.code = code_map();
        plan
    }

    /// The crate as the plan carries it: every file some scope claims, hashed to its own name, so a
    /// test can move one module and ask which scopes noticed.
    fn code_map() -> BTreeMap<String, String> {
        SHADE_CODE
            .iter()
            .chain(&OUTSIDE_SHADE)
            .map(|module| format!("{SRC}/{module}"))
            .chain(BUILD_FILES.iter().map(|file| (*file).to_owned()))
            .map(|path| (path.clone(), format!("the bytes of {path}")))
            .collect()
    }

    /// New York with a two-bin sun grid and the footprints to cast it, since the shade pass is now
    /// stamped one bin at a time and has nothing to say about a city with no grid.
    const SUNNY: &str = r#"[
      {"id": "nyc", "sources": ["buildings", "landmarks", "industrial", "historic"],
       "shade": {"maxZoom": 14, "maxShadowMeters": 500,
                 "buckets": [
                   {"season": 0, "hourAngle": -30.0, "elevation": 20.0, "azimuth": 120.0,
                    "intensity": 0.34, "samples": [{"east": 0.5, "north": 0.5,
                                                    "shadowPerHeight": 2.7}]},
                   {"season": 0, "hourAngle": 30.0, "elevation": 22.0, "azimuth": 240.0,
                    "intensity": 0.37, "samples": [{"east": -0.5, "north": 0.5,
                                                    "shadowPerHeight": 2.5}]}]}},
      {"id": "sf"}
    ]"#;

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
        plan.graph_cache = root.join("graph-cache");
        plan
    }

    #[test]
    fn a_pass_is_fresh_only_when_its_stamp_and_its_output_both_hold() {
        let root = scratch("fresh");
        let pass = Pass::whole("5eaf00d".to_owned(), &root.join("streets"));
        assert!(!pass.is_fresh(), "nothing has recorded a stamp yet");

        pass.restart().expect("the output directory");
        pass.record().expect("the stamp");
        assert!(pass.is_fresh());

        // The stamp says only that the inputs held, never that the output is still there — a
        // hand-deleted directory or a cache that restored only some of them has to rebuild.
        fs::remove_dir_all(root.join("streets")).expect("a removal");
        assert!(!pass.is_fresh());
    }

    #[test]
    fn a_pass_that_reruns_clears_its_own_output_and_leaves_its_neighbours_alone() {
        let root = scratch("clearing");
        let mine = Pass::whole("a".to_owned(), &root.join("streets"));
        let theirs = Pass::whole("b".to_owned(), &root.join("casters"));
        for pass in [&mine, &theirs] {
            pass.restart().expect("a directory");
            fs::write(pass.stamp_file.with_file_name("last-build.bin"), b"stale")
                .expect("a stale file");
            pass.record().expect("a stamp");
        }

        mine.restart().expect("a clearing");

        assert!(root.join("streets").is_dir(), "the root is recreated");
        assert!(!root.join("streets").join("last-build.bin").exists());
        assert!(!mine.is_fresh(), "its own stamp went with its output");
        assert!(root.join("casters").join("last-build.bin").is_file());
        assert!(
            theirs.is_fresh(),
            "a neighbour rerunning is not this pass's business"
        );
    }

    /// A pyramid or a graph blob is removed and NOT recreated: a city that renders nothing must
    /// leave no directory at all, since absence is how the client tells "no such layer here" from
    /// "an empty layer".
    #[test]
    fn a_city_that_stops_rendering_leaves_no_directory_behind() {
        let root = scratch("pieces");
        let overlay = root.join("tiles/elevation/nyc");
        let pass = Pass {
            stamp: "a".to_owned(),
            stamp_file: overlay.join(STAMP),
            root: None,
            pieces: vec![overlay.clone(), root.join("routing/shade/nyc")],
            witnesses: vec![overlay.clone()],
        };
        pass.restart().expect("the overlay");
        fs::create_dir_all(root.join("routing/shade/nyc")).expect("the per-edge bake");
        pass.record().expect("a stamp");
        assert!(pass.is_fresh());

        pass.clear().expect("a clearing");

        assert!(!overlay.exists());
        assert!(!root.join("routing/shade/nyc").exists());
    }

    #[test]
    fn output_a_dropped_city_left_behind_is_deleted() {
        let plan = planted("reconcile");
        for pyramid in Plan::PYRAMIDS {
            for city in ["nyc", "sf", "boston"] {
                fs::create_dir_all(plan.tiles.join(pyramid).join(city)).expect("a pyramid");
            }
        }
        for city in ["nyc", "sf", "boston"] {
            fs::create_dir_all(plan.routing.join("shade").join(city)).expect("a per-edge bake");
            fs::create_dir_all(plan.graph_cache.join(city)).expect("a cache directory");
            for suffix in ["bin", "stranded.bin", "version.json"] {
                fs::write(plan.routing.join(format!("{city}.{suffix}")), b"stale")
                    .expect("a routing artifact");
            }
            fs::write(plan.routing.join(format!(".stamp-{city}")), b"stale").expect("a stamp");
        }

        plan.reconcile(&manifest()).expect("a reconciliation");

        for pyramid in Plan::PYRAMIDS {
            assert!(plan.tiles.join(pyramid).join("nyc").is_dir(), "{pyramid}");
            assert!(
                !plan.tiles.join(pyramid).join("boston").exists(),
                "{pyramid}"
            );
        }
        for kept in [
            "nyc.bin",
            "nyc.stranded.bin",
            "nyc.version.json",
            ".stamp-nyc",
        ] {
            assert!(plan.routing.join(kept).is_file(), "{kept}");
        }
        for dropped in [
            "boston.bin",
            "boston.stranded.bin",
            "boston.version.json",
            ".stamp-boston",
        ] {
            assert!(!plan.routing.join(dropped).exists(), "{dropped}");
        }
        assert!(plan.routing.join("shade").join("nyc").is_dir());
        assert!(!plan.routing.join("shade").join("boston").exists());
        assert!(plan.graph_cache.join("nyc").is_dir());
        assert!(!plan.graph_cache.join("boston").exists(), "its cache too");
    }

    /// `--only` as the command line hands it over.
    fn only(terms: &[&str]) -> Selection {
        let terms: Vec<String> = terms.iter().map(|term| (*term).to_owned()).collect();
        Selection::new(&terms, false).expect("a selection")
    }

    #[test]
    fn a_pass_only_named_runs_and_one_it_left_out_does_not() {
        let selection = only(&["graph", "shade"]);

        assert!(
            selection
                .verdict(PassName::Graph, Some("nyc"), false)
                .runs()
        );
        assert!(selection.verdict(PassName::Shade, Some("sf"), false).runs());
        assert!(matches!(
            selection.verdict(PassName::Canopy, None, false),
            Verdict::Excluded
        ));
    }

    /// A term narrowed to a city selects that city's share of the pass and no other's.
    #[test]
    fn a_pass_narrowed_to_a_city_leaves_the_other_cities_out() {
        let selection = only(&["graph:nyc"]);

        assert!(
            selection
                .verdict(PassName::Graph, Some("nyc"), false)
                .runs()
        );
        assert!(matches!(
            selection.verdict(PassName::Graph, Some("sf"), false),
            Verdict::Excluded
        ));
    }

    /// The whole-build passes are cut or rendered over every city at once, so a city named for one
    /// would name work that does not exist.
    #[test]
    fn a_city_on_a_pass_that_has_no_cities_is_rejected() {
        let error = Selection::new(&["chunks:nyc".to_owned()], false)
            .err()
            .expect("a pass with no cities to narrow to");

        assert!(error.to_string().contains("every city"), "{error}");
    }

    #[test]
    fn a_pass_name_no_stage_answers_to_is_rejected() {
        let error = Selection::new(&["pyramid".to_owned()], false)
            .err()
            .expect("a name no pass answers to");

        assert!(error.to_string().contains("pyramid"), "{error}");
    }

    /// A misspelled city would otherwise select no work at all and report the build that did none
    /// as a success.
    #[test]
    fn a_city_the_manifest_does_not_carry_is_rejected() {
        let error = only(&["graph:bosotn"])
            .check(&manifest())
            .err()
            .expect("a city the manifest has never heard of");

        assert!(error.to_string().contains("bosotn"), "{error}");
    }

    /// The property that makes `--only` safe where a hand-edited plan was not: a pass it left out is
    /// not run, records nothing, and clears nothing — so the claim it already held stands, stale, and
    /// the next full build reruns it.
    #[test]
    fn a_pass_left_out_keeps_its_stale_stamp_for_the_next_full_build() {
        let root = scratch("only-untouched");
        let last = Pass::whole("what the last build read".to_owned(), &root.join("casters"));
        last.restart().expect("a directory");
        fs::write(last.stamp_file.with_file_name("chunk.bin"), b"last build").expect("a chunk");
        last.record().expect("a stamp");
        // The same pass this build, over an input that moved.
        let now = Pass::whole("what this one reads".to_owned(), &root.join("casters"));
        assert!(!now.is_fresh(), "its inputs moved");

        let partial = only(&["graph"]);
        assert!(matches!(
            partial.verdict(PassName::CasterChunks, None, now.is_fresh()),
            Verdict::Excluded
        ));

        assert_eq!(
            fs::read_to_string(&now.stamp_file).expect("the stamp"),
            "what the last build read",
            "nothing of this build was recorded for it"
        );
        assert!(root.join("casters").join("chunk.bin").is_file());
        assert!(
            only(&[])
                .verdict(PassName::CasterChunks, None, now.is_fresh())
                .runs(),
            "and the next full build catches it"
        );
    }

    #[test]
    fn force_reruns_a_selected_pass_whose_stamp_holds() {
        let forced = Selection::new(&["shade".to_owned()], true).expect("a selection");

        assert!(forced.verdict(PassName::Shade, Some("nyc"), true).runs());
        assert!(forced.forces(PassName::Shade, Some("nyc")));
    }

    /// `--force` is about the passes this build is running and cannot reach across to the others: a
    /// stamp it set aside for one pass is not a stamp set aside for all of them.
    #[test]
    fn force_does_not_reach_a_pass_only_left_out() {
        let forced = Selection::new(&["shade".to_owned()], true).expect("a selection");

        assert!(matches!(
            forced.verdict(PassName::Graph, Some("nyc"), true),
            Verdict::Excluded
        ));
        assert!(!forced.forces(PassName::Graph, Some("nyc")));
    }

    /// A selected pass runs over output that is STALE — that is what `--only` is for — but not over
    /// output that is not there at all: a graph baked from commercial lines nobody has written would
    /// carry no commercial discount and then stamp itself as though it had.
    #[test]
    fn a_selected_pass_whose_upstream_output_is_missing_says_which_pass_to_run_first() {
        let plan = planted("handoff-graph");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let partial = only(&["graph"]);

        let error = handoffs(&plan, &cities, &partial)
            .err()
            .expect("lines no pass has written");
        assert!(error.to_string().contains("commercial"), "{error}");

        fs::create_dir_all(&plan.commercial_lines).expect("the lines");
        handoffs(&plan, &cities, &partial).expect("lines that are there, however old");
    }

    #[test]
    fn the_re_chunk_will_not_run_over_a_stranded_set_no_graph_has_written() {
        let plan = planted("handoff-stranded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let partial = only(&["chunks-stranded"]);
        fs::create_dir_all(&plan.chunks).expect("the chunks");

        let error = handoffs(&plan, &cities, &partial)
            .err()
            .expect("a stranded set no graph has written");

        assert!(error.to_string().contains("nyc.stranded.bin"), "{error}");
        assert!(error.to_string().contains("--only graph"), "{error}");
    }

    /// A partial build never claims to have been built over output nobody has produced: a pass keyed
    /// on an upstream stamp this build is not going to write folds the one recorded on disk, so the
    /// full build that later reruns that upstream reruns this pass with it.
    #[test]
    fn a_selected_pass_folds_the_upstream_stamp_that_is_actually_on_disk() {
        let root = scratch("upstream");
        let chunks = Pass::whole("what the chunks will be".to_owned(), &root.join("streets"));
        chunks.restart().expect("a directory");
        fs::write(&chunks.stamp_file, "what the chunks are").expect("a stamp");

        assert_eq!(
            upstream(&only(&["commercial"]), PassName::Chunks, &chunks).expect("a stamp"),
            "what the chunks are",
            "the claim over the chunks the commercial pass is about to read"
        );
        assert_eq!(
            upstream(&only(&["chunks", "commercial"]), PassName::Chunks, &chunks).expect("a stamp"),
            "what the chunks will be",
            "a pass this build is running leaves the stamp it just computed"
        );
        assert_eq!(
            upstream(&only(&[]), PassName::Chunks, &chunks).expect("a stamp"),
            "what the chunks will be",
            "and so does every pass of a full build"
        );

        fs::remove_file(&chunks.stamp_file).expect("a removal");
        assert_eq!(
            upstream(&only(&["commercial"]), PassName::Chunks, &chunks).expect("a stamp"),
            UNRECORDED
        );
    }

    /// A pass narrowed to one city writes only that city's share, so it does not stand in for the
    /// cities it left out.
    #[test]
    fn a_graph_narrowed_to_one_city_does_not_answer_for_the_others() {
        let plan = planted("handoff-narrowed");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        fs::create_dir_all(&plan.chunks).expect("the chunks");
        // The graph reads these too, and that handoff is checked first, so without them the error
        // would be about the commercial lines rather than the city this test is narrowing to.
        fs::create_dir_all(&plan.commercial_lines).expect("the commercial lines");
        fs::create_dir_all(&plan.routing).expect("the routing directory");
        fs::write(plan.routing.join("nyc.stranded.bin"), b"a stranded set")
            .expect("new york's stranded set");

        let error = handoffs(&plan, &cities, &only(&["chunks-stranded", "graph:nyc"]))
            .err()
            .expect("san francisco's stranded set");

        assert!(error.to_string().contains("sf.stranded.bin"), "{error}");
    }

    /// A full build asks nothing of the disk up front: every pass it consumes is a pass it is also
    /// running, and one that has nothing to read simply reruns.
    #[test]
    fn a_full_build_needs_no_handoff() {
        let plan = planted("handoff-full");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");

        handoffs(&plan, &cities, &only(&[])).expect("nothing to ask for");
    }

    /// A pyramid over a scratch tree, wanting the buckets these keys stand for.
    fn planted_pyramid(name: &str, keys: &[&str]) -> ShadePyramid {
        let root = scratch(name);
        ShadePyramid {
            buildings: root.join("tiles/shade/nyc"),
            trees: root.join("tiles/tree-shade/nyc"),
            keys: keys.iter().map(|key| (*key).to_owned()).collect(),
        }
    }

    /// A bucket directory as a finished render left it: a tile named after the bin it came from, so
    /// a directory can be followed across a move, and the key that render recorded. `None` for the
    /// key is a render killed before it recorded one.
    fn plant_bucket(root: &Path, index: usize, key: Option<&str>) {
        let directory = root.join(index.to_string());
        fs::create_dir_all(&directory).expect("a bucket");
        fs::write(directory.join("tile.webp"), format!("bin {index}")).expect("a tile");
        if let Some(key) = key {
            fs::write(directory.join(STAMP), key).expect("a key");
        }
    }

    /// Which render a bucket directory's tiles came out of, by the marker `plant_bucket` left.
    fn tile_of(root: &Path, index: usize) -> Option<String> {
        fs::read_to_string(root.join(index.to_string()).join("tile.webp")).ok()
    }

    /// The whole point of matching by content key. The schedule sorts by (season, hour angle), so a
    /// bin inserted at the front shifts every later index — and every later bin is nonetheless the
    /// same tiles, so it is moved into its new index rather than rendered again.
    #[test]
    fn a_bucket_the_schedule_kept_is_moved_into_its_new_index_rather_than_rendered() {
        let pyramid = planted_pyramid("shade-insert", &["new", "morning", "noon"]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        plant_bucket(&pyramid.buildings, 1, Some("noon"));

        let render = pyramid.reconcile().expect("a reconciliation");

        assert_eq!(render.len(), 1, "only the bin nothing on disk claimed");
        assert_eq!(render[0].index, 0);
        assert_eq!(render[0].key, "new");
        assert_eq!(render[0].stamp, pyramid.buildings.join("0").join(STAMP));
        assert_eq!(tile_of(&pyramid.buildings, 1).as_deref(), Some("bin 0"));
        assert_eq!(tile_of(&pyramid.buildings, 2).as_deref(), Some("bin 1"));
        assert!(!pyramid.buildings.join("0").exists(), "the bin to render");
    }

    /// The mirror case: a bin taken out of the schedule costs the moves and no render at all.
    #[test]
    fn a_bucket_the_schedule_dropped_costs_moves_and_nothing_else() {
        let pyramid = planted_pyramid("shade-drop", &["morning", "noon"]);
        plant_bucket(&pyramid.buildings, 0, Some("dawn"));
        plant_bucket(&pyramid.buildings, 1, Some("morning"));
        plant_bucket(&pyramid.buildings, 2, Some("noon"));

        let render = pyramid.reconcile().expect("a reconciliation");

        assert!(render.is_empty());
        assert_eq!(tile_of(&pyramid.buildings, 0).as_deref(), Some("bin 1"));
        assert_eq!(tile_of(&pyramid.buildings, 1).as_deref(), Some("bin 2"));
        assert!(!pyramid.buildings.join("2").exists());
    }

    /// A bin whose key nothing wants is a directory no build would ever look at again — and, since
    /// the pyramid is served as it stands, one the client would otherwise go on reading.
    #[test]
    fn a_bucket_nothing_claims_is_deleted() {
        let pyramid = planted_pyramid("shade-zombie", &["morning"]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        plant_bucket(
            &pyramid.buildings,
            1,
            Some("a bin the sun grid no longer has"),
        );
        plant_bucket(&pyramid.trees, 0, None);
        plant_bucket(&pyramid.trees, 1, None);

        let render = pyramid.reconcile().expect("a reconciliation");

        assert!(render.is_empty());
        assert!(!pyramid.buildings.join("1").exists());
        assert!(!pyramid.trees.join("1").exists(), "the twin goes with it");
    }

    /// The trees' pyramid records no key of its own: it is written by the same render over the same
    /// casters, so it is claimed by the buildings' bucket and moves with it.
    #[test]
    fn the_tree_twin_moves_with_its_bucket() {
        let pyramid = planted_pyramid("shade-twin", &["new", "morning"]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        plant_bucket(&pyramid.trees, 0, None);

        let render = pyramid.reconcile().expect("a reconciliation");

        assert_eq!(render.len(), 1);
        assert_eq!(tile_of(&pyramid.trees, 1).as_deref(), Some("bin 0"));
        assert!(!pyramid.trees.join("0").exists());
    }

    /// A build killed inside a bin leaves its tiles and no key, and the tiles are half a bin's — so
    /// the directory claims nothing and is rendered again.
    #[test]
    fn a_bucket_left_half_written_claims_nothing() {
        let pyramid = planted_pyramid("shade-killed", &["morning"]);
        plant_bucket(&pyramid.buildings, 0, None);

        let render = pyramid.reconcile().expect("a reconciliation");

        assert_eq!(render.len(), 1);
        assert_eq!(render[0].index, 0);
        assert!(!pyramid.buildings.join("0").exists());
    }

    /// The schedule names which directory holds which sun position, and the reconcile has just
    /// moved the directories, so the one on disk is wrong the moment a bin shifts. It is swept and
    /// written again from the grid every build, whether or not anything was rendered.
    #[test]
    fn the_schedule_is_written_again_every_build() {
        let pyramid = planted_pyramid("shade-schedule", &["morning"]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        let schedule = pyramid.buildings.join("buckets.json");
        fs::write(&schedule, b"[{\"index\": 7}]").expect("a stale schedule");

        let render = pyramid.reconcile().expect("a reconciliation");

        assert!(render.is_empty());
        assert!(
            !schedule.exists(),
            "the stale one does not outlive the moves"
        );
        let params: shade::Params = serde_json::from_str(
            r#"{"maxZoom": 14, "maxShadowMeters": 500,
                "buckets": [{"season": 0, "hourAngle": -30.0, "elevation": 20.0, "azimuth": 120.0,
                             "intensity": 0.34, "samples": []}]}"#,
        )
        .expect("a sun grid");
        shade::write_schedule(&pyramid.buildings, &params).expect("a schedule");
        assert!(schedule.is_file());
    }

    /// A city that stops casting a shadow leaves neither pyramid behind, since absence is how the
    /// client tells "no shade here" from "an empty layer".
    #[test]
    fn a_city_that_stops_casting_leaves_neither_pyramid_behind() {
        let pyramid = planted_pyramid("shade-cleared", &[]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        plant_bucket(&pyramid.trees, 0, None);

        pyramid.clear().expect("a clearing");

        assert!(!pyramid.buildings.exists());
        assert!(!pyramid.trees.exists());
    }

    /// Every file a pass of this build could name, given the manifest above and a plan that hands
    /// over both sidewalk extracts, each with its own path as its contents so a file read in
    /// another's place is caught. What is missing is deliberate: the commercial pass's dining and
    /// open-streets sources are read only if they exist, and the stamps have to say so.
    const INPUTS: [(&str, &str); 15] = [
        ("streets", "nyc.bin"),
        ("streets", "sf.bin"),
        ("paths", "nyc.bin"),
        ("sidewalks", "nyc.bin"),
        ("sidewalks", "sf.bin"),
        ("land", "nyc.bin"),
        ("land", "sf.bin"),
        ("trees", "nyc.bin"),
        ("trees", "sf.bin"),
        ("canopy", "nyc.bin"),
        ("landuse", "nyc.bin"),
        ("buildings", "nyc.bin"),
        ("landmarks", "nyc.bin"),
        ("industrial", "nyc.bin"),
        ("historic", "nyc.bin"),
    ];

    /// A plan whose data root and manifest are a scratch tree of this test's own, so the per-pass
    /// stamps answer about inputs it controls.
    fn stamping_plan(name: &str) -> Plan {
        let root = scratch(name);
        let data = root.join("data");
        for (kind, file) in INPUTS {
            fs::create_dir_all(data.join(kind)).expect("a source directory");
            fs::write(data.join(kind).join(file), format!("{kind}/{file}")).expect("a source");
        }
        fs::write(root.join("manifest.json"), MANIFEST).expect("a manifest");
        let mut plan = plan(SUNNY);
        plan.data = data;
        plan.manifest = root.join("manifest.json");
        plan.graph_cache = root.join("graph-cache");
        plan
    }

    /// One stamp per pass, so a test can say which passes a change would rerun. The per-city ones
    /// are New York's, the city the manifest above gives every layer to.
    struct Stamped {
        chunks: String,
        commercial: String,
        casters: String,
        /// One key per sun bin, in schedule order.
        buckets: Vec<String>,
        elevation: String,
        canopy: String,
        genus_field: String,
        graph: String,
        /// Pass 8 one level down: the topology's key, and one per attribute column over it.
        keys: graph_cache::Keys,
    }

    /// New York's bucket keys, in schedule order.
    fn bucket_keys(plan: &Plan) -> Vec<String> {
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(plan).expect("the stamps");
        let (city, planned) = cities[0];
        let params = planned.shade.as_ref().expect("a sun grid");
        params
            .buckets
            .iter()
            .map(|bucket| {
                stamps
                    .shade_bucket(city, params, bucket)
                    .expect("a bucket key")
            })
            .collect()
    }

    fn stamped_passes(plan: &Plan) -> Stamped {
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(plan).expect("the stamps");
        let chunks = stamps.chunks(&cities).expect("the chunks stamp");
        let commercial = stamps
            .commercial(&cities, &chunks)
            .expect("the commercial stamp");
        let (city, planned) = cities[0];
        let keys = stamps
            .graph_keys(city, planned, &commercial, true)
            .expect("the graph keys");
        Stamped {
            casters: stamps
                .casters(&cities, planned.shade.as_ref())
                .expect("the caster-chunks stamp"),
            buckets: bucket_keys(plan),
            elevation: stamps
                .elevation(city, planned)
                .expect("the elevation stamp"),
            canopy: stamps.canopy(&cities).expect("the canopy stamp"),
            genus_field: stamps.genus_field(&cities).expect("the genus-field stamp"),
            graph: stamps.graph(&keys),
            keys,
            chunks,
            commercial,
        }
    }

    #[test]
    fn a_build_over_inputs_that_have_not_moved_stamps_every_pass_the_same() {
        let plan = stamping_plan("stamps-still");
        let before = stamped_passes(&plan);
        let again = stamped_passes(&plan);

        assert_eq!(again.chunks, before.chunks);
        assert_eq!(again.commercial, before.commercial);
        assert_eq!(again.casters, before.casters);
        assert_eq!(again.buckets, before.buckets);
        assert_eq!(again.elevation, before.elevation);
        assert_eq!(again.canopy, before.canopy);
        assert_eq!(again.genus_field, before.genus_field);
        assert_eq!(again.graph, before.graph);
    }

    /// The whole point: one re-ingested source reruns the passes that read it and nothing else. The
    /// lots are read by the commercial pass alone, and the graph follows only because it bakes its
    /// commercial discount from the lines that pass writes.
    #[test]
    fn a_re_ingested_source_moves_only_the_stamps_of_the_passes_that_read_it() {
        let plan = stamping_plan("stamps-moved");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("landuse").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.commercial, before.commercial);
        assert_ne!(after.graph, before.graph);
        assert_eq!(after.chunks, before.chunks);
        assert_eq!(after.casters, before.casters);
        assert_eq!(after.buckets, before.buckets, "the twenty-minute pass");
        assert_eq!(after.elevation, before.elevation);
        assert_eq!(after.canopy, before.canopy);
        assert_eq!(after.genus_field, before.genus_field);
    }

    /// A pass reruns when the pass it consumes reruns, even though nothing it reads for itself
    /// moved: the commercial signals are keyed on the segment order inside the chunks.
    #[test]
    fn a_pass_reruns_when_the_pass_it_consumes_does() {
        let plan = stamping_plan("stamps-upstream");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("streets").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.chunks, before.chunks);
        assert_ne!(after.commercial, before.commercial);
        assert_ne!(after.graph, before.graph);
        assert_eq!(after.buckets, before.buckets);
        assert_eq!(after.canopy, before.canopy);
    }

    /// A source appearing has to rebuild as surely as one changing, which is why absence is stamped
    /// rather than left out of the digest.
    #[test]
    fn a_source_that_was_not_there_last_build_moves_the_stamp_by_appearing() {
        let plan = stamping_plan("stamps-appeared");
        let before = stamped_passes(&plan);

        fs::create_dir_all(plan.data.join("dining")).expect("a source directory");
        fs::write(plan.data.join("dining").join("nyc.bin"), b"ingested").expect("a source");

        assert_ne!(stamped_passes(&plan).commercial, before.commercial);
    }

    /// A module edited, as the plan would carry it.
    fn edited(plan: &mut Plan, module: &str) {
        plan.code
            .insert(format!("{SRC}/{module}"), "a different tiler".to_owned());
    }

    /// Every pass but shade declares no modules of its own, so any edit to the tiler invalidates all
    /// of them — an output whose FORMAT changed moves no input file.
    #[test]
    fn a_new_tiler_reruns_every_pass_that_names_no_modules() {
        let mut plan = stamping_plan("stamps-epoch");
        let before = stamped_passes(&plan);
        edited(&mut plan, "shade.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.chunks, before.chunks);
        assert_ne!(after.commercial, before.commercial);
        assert_ne!(after.casters, before.casters);
        assert_ne!(after.elevation, before.elevation);
        assert_ne!(after.canopy, before.canopy);
        assert_ne!(after.genus_field, before.genus_field);
        assert_ne!(after.graph, before.graph);
        assert_ne!(
            after.buckets, before.buckets,
            "the pass that reads shade.rs"
        );
    }

    /// What the shade pass's own scope is for: the pyramid is most of the build, and an edit to the
    /// graph is not a reason to render it a second time.
    #[test]
    fn an_edit_the_shade_pass_does_not_read_leaves_the_pyramid_standing() {
        let mut plan = stamping_plan("stamps-scope");
        let before = stamped_passes(&plan);
        edited(&mut plan, "graph.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.graph, before.graph);
        assert_ne!(after.chunks, before.chunks);
        assert_eq!(after.buckets, before.buckets);
    }

    /// What the token hash buys: a comment and a reformat are not a new tiler, and the epoch they
    /// used to move is folded into nearly every pass. Doc comments are counted on purpose.
    #[test]
    fn a_comment_moves_no_module_hash_and_a_line_of_code_does() {
        let root = scratch("token-hash");
        fs::create_dir_all(&root).expect("a scratch tree");
        let module = root.join("module.rs");
        let write = |body: &str| fs::write(&module, body).expect("a module");

        write("/// doc\nfn area(side: f64) -> f64 {\n    // a comment\n    side * side\n}\n");
        let before = token_oid(&module).expect("a hash");
        write("/// doc\nfn area( side : f64 )->f64{ /* moved */ side*side }\n");
        assert_eq!(token_oid(&module).as_ref(), Some(&before), "a comment");
        write("/// doc\nfn area(side: f64) -> f64 {\n    side * 2.0\n}\n");
        assert_ne!(token_oid(&module).as_ref(), Some(&before), "an edit");
        write("/// other\nfn area(side: f64) -> f64 {\n    side * side\n}\n");
        assert_ne!(token_oid(&module).as_ref(), Some(&before), "a doc comment");
    }

    /// The substitution reaches the map the stamps are folded from, and only its modules: a
    /// lockfile has no token stream to hash.
    #[test]
    fn the_code_map_carries_token_hashes_for_its_modules_alone() {
        let mut plan = plan(BOTH);
        let lockfile = plan.code["Cargo.lock"].clone();
        plan.hash_source_tokens();

        assert_ne!(
            plan.code[&format!("{SRC}/shade.rs")],
            "the bytes of shade.rs"
        );
        assert_eq!(plan.code["Cargo.lock"], lockfile);
    }

    /// A bucket is stamped on its own bin and not on the schedule's shape, which is what makes an
    /// inserted bin cost one render rather than fifty-eight.
    #[test]
    fn a_bucket_key_says_nothing_about_the_rest_of_the_schedule() {
        let plan = stamping_plan("stamps-bucket");
        let before = bucket_keys(&plan);
        let after = bucket_keys(&grown("stamps-bucket-grown"));

        assert_eq!(after.len(), before.len() + 1);
        assert_eq!(after[1..], before[..], "the bins that did not move");
    }

    /// A schedule that gained a bin, as the plan would carry it: the driver's own grid with one more
    /// bin at the front, which is where a (season, hour angle) sort puts an earlier hour.
    fn grown(name: &str) -> Plan {
        let mut plan = stamping_plan(name);
        let inserted = r#"{"season": 0, "hourAngle": 0.0, "elevation": 30.0, "azimuth": 180.0,
                           "intensity": 0.5, "samples": [{"east": 0.0, "north": 1.0,
                                                          "shadowPerHeight": 1.7}]},"#;
        plan.cities = serde_json::from_str(
            &SUNNY.replace(r#""buckets": ["#, &format!(r#""buckets": [{inserted}"#)),
        )
        .expect("a grown schedule");
        plan
    }

    /// What the split is for: a re-ingested attribute source keys ITS column anew and nothing else,
    /// so the pass reruns to bake one byte per edge over a topology it reads back whole.
    #[test]
    fn a_re_ingested_attribute_moves_one_column_and_leaves_the_topology_standing() {
        let plan = stamping_plan("keys-column");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("industrial").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.keys.industrial, before.keys.industrial);
        assert_ne!(after.graph, before.graph, "so the pass reruns at all");
        assert_eq!(after.keys.base, before.keys.base, "the sequential half");
        assert_eq!(after.keys.landmarks, before.keys.landmarks);
        assert_eq!(after.keys.historic, before.keys.historic);
        assert_eq!(after.keys.canopy, before.keys.canopy);
        assert_eq!(after.keys.relief, before.keys.relief, "the DEM decode");
        assert_eq!(
            after.keys.shade, before.keys.shade,
            "the twenty-minute bake"
        );
    }

    /// The one touchpoint of a new column that nothing else enforces. The struct literal, the
    /// exhaustive matches and the args list all stop compiling until a column is wired in, but the
    /// key reaching pass 8's own STAMP is enforced by this test alone — and it is the stamp, not the
    /// cache, that decides whether the pass runs at all. Leave it out and a re-ingested district
    /// file keys a cache entry no build ever asks for: the bake simply never reruns.
    #[test]
    fn a_re_ingested_historic_source_moves_the_graph_stamp() {
        let plan = stamping_plan("keys-historic");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("historic").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.keys.historic, before.keys.historic);
        assert_ne!(after.graph, before.graph, "so the pass reruns at all");
        assert_eq!(after.keys.base, before.keys.base, "the sequential half");
        assert_eq!(after.keys.industrial, before.keys.industrial);
        assert_eq!(after.keys.canopy, before.keys.canopy);
        assert_eq!(
            after.keys.shade, before.keys.shade,
            "the twenty-minute bake"
        );
    }

    /// And the other way about, which is the whole correctness argument for merging a column back in
    /// by position: a street input moves the base, so every column is keyed anew and none of them
    /// can be read back beside an edge list it was not baked over.
    #[test]
    fn a_street_that_moved_moves_the_base_and_every_column_with_it() {
        let plan = stamping_plan("keys-base");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("streets").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.keys.base, before.keys.base);
        for (moved, held) in [
            (&after.keys.landmarks, &before.keys.landmarks),
            (&after.keys.art, &before.keys.art),
            (&after.keys.highways, &before.keys.highways),
            (&after.keys.commercial, &before.keys.commercial),
            (&after.keys.relief, &before.keys.relief),
            (&after.keys.canopy, &before.keys.canopy),
            (&after.keys.industrial, &before.keys.industrial),
            (&after.keys.historic, &before.keys.historic),
        ] {
            assert_ne!(moved, held);
        }
        assert!(
            after
                .keys
                .shade
                .iter()
                .zip(&before.keys.shade)
                .all(|(after, before)| after != before)
        );
    }

    /// The per-edge shade bake is keyed a bin at a time, exactly as the pyramid's buckets are: an
    /// inserted bin bakes the one bin, where the whole grid in the key used to bake all fifty-eight.
    #[test]
    fn an_inserted_sun_bin_leaves_the_other_bins_shade_columns_alone() {
        let before = stamped_passes(&stamping_plan("keys-bins")).keys.shade;
        let after = stamped_passes(&grown("keys-bins-grown")).keys.shade;

        assert_eq!(after.len(), before.len() + 1);
        assert_eq!(after[1..], before[..], "the bins that did not move");
    }

    /// A city that stops baking shade at all — its footprints gone — moves the pass's stamp even
    /// though every column key it still has is where it was.
    #[test]
    fn a_city_that_stops_baking_shade_moves_the_graph_stamp() {
        let plan = stamping_plan("keys-unshaded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(&plan).expect("the stamps");
        let (city, planned) = cities[0];
        let baked = stamps
            .graph_keys(city, planned, "commercial", true)
            .expect("the graph keys");
        let unbaked = stamps
            .graph_keys(city, planned, "commercial", false)
            .expect("the graph keys");

        assert_eq!(baked.base, unbaked.base);
        assert!(unbaked.shade.is_empty());
        assert_ne!(stamps.graph(&baked), stamps.graph(&unbaked));
    }

    /// The caster chunks carry no sun position: what they take from the grid is the halo radius a
    /// viewport gathers them over. So an inserted bin leaves the four-minute pass alone, and a
    /// changed halo does not.
    #[test]
    fn the_caster_chunks_follow_the_halo_and_not_the_schedule() {
        let plan = stamping_plan("casters-halo");
        let before = stamped_passes(&plan).casters;

        assert_eq!(
            stamped_passes(&grown("casters-halo-grown")).casters,
            before,
            "one more bin is the same 166 MB of chunks"
        );

        let mut widened = stamping_plan("casters-halo-wider");
        widened.cities = serde_json::from_str(
            &SUNNY.replace(r#""maxShadowMeters": 500"#, r#""maxShadowMeters": 600"#),
        )
        .expect("a wider halo");
        assert_ne!(stamped_passes(&widened).casters, before);
    }

    /// The footprints are one opaque city-wide file, so a re-ingest correctly re-renders the whole
    /// pyramid — the coarseness this stops at, and the reason per-tile diffing was not attempted.
    #[test]
    fn a_building_re_ingest_moves_every_bucket_key() {
        let plan = stamping_plan("stamps-buildings");
        let before = bucket_keys(&plan);
        fs::write(plan.data.join("buildings").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = bucket_keys(&plan);

        assert!(
            after
                .iter()
                .zip(&before)
                .all(|(after, before)| after != before)
        );
    }

    /// A module claimed by no scope is a module no stamp is a function of: edit it and the pyramid
    /// it renders differently goes on being served. The lists are checked against the DIRECTORY
    /// rather than against each other, so a module added later fails here until someone says which
    /// side of the shade pass's line it is on.
    #[test]
    fn every_module_of_the_tiler_is_claimed_by_a_code_scope() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found: Vec<String> = Vec::new();
        let mut pending = vec![src.clone()];
        while let Some(directory) = pending.pop() {
            for entry in listing(&directory).expect("the crate's modules") {
                if entry.is_dir() {
                    pending.push(entry);
                } else {
                    let name = entry.strip_prefix(&src).expect("a module inside the crate");
                    found.push(name.to_string_lossy().into_owned());
                }
            }
        }
        let mut claimed: Vec<String> = SHADE_CODE
            .iter()
            .chain(&OUTSIDE_SHADE)
            .map(|module| (*module).to_owned())
            .collect();
        found.sort();
        claimed.sort();

        assert_eq!(found, claimed);
    }

    /// Every module a `crate::` path in these tokens names — the head of the path, and each head
    /// inside a `use crate::{…}` group. Tokens rather than lines, so that `pub use`, the second and
    /// later modules of a brace group, and a fully-qualified `crate::foo::bar` written with no `use`
    /// at all are all counted; each of the three used to read as no import, which is the direction
    /// that passes a scope that is not closed.
    fn crate_heads(stream: TokenStream, found: &mut Vec<String>) {
        let trees: Vec<TokenTree> = stream.into_iter().collect();
        let colon = |tree: Option<&TokenTree>| matches!(tree, Some(TokenTree::Punct(punct)) if punct.as_char() == ':');
        for (index, tree) in trees.iter().enumerate() {
            match tree {
                TokenTree::Group(group) => crate_heads(group.stream(), found),
                TokenTree::Ident(ident)
                    if ident == "crate"
                        && colon(trees.get(index + 1))
                        && colon(trees.get(index + 2)) =>
                {
                    match trees.get(index + 3) {
                        Some(TokenTree::Ident(name)) => found.push(name.to_string()),
                        // `use crate::{a, b::c}`: the head of every path the group lists, the
                        // nested groups of which this loop reaches on its own.
                        Some(TokenTree::Group(group)) if group.delimiter() == Delimiter::Brace => {
                            let mut head = true;
                            for tree in group.stream() {
                                match tree {
                                    TokenTree::Ident(name) if head => {
                                        found.push(name.to_string());
                                        head = false;
                                    }
                                    TokenTree::Punct(punct) if punct.as_char() == ',' => {
                                        head = true;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    /// SHADE_CODE has to be CLOSED under what those modules import, not merely a list someone
    /// believed was closed. It is the one scope narrower than the whole crate, so a module that
    /// slipped into it unnamed — `crown.rs` reaching for the DEM to sample terrain under a canopy,
    /// say — would be a module the pyramid is a function of and its stamp cannot see, and the
    /// pyramid would stand stale with nothing to catch it.
    #[test]
    fn the_shade_scope_is_closed_under_its_own_imports() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut reached: Vec<String> = vec![SHADE_CODE[0].to_owned()];
        let mut pending = vec![SHADE_CODE[0].to_owned()];
        while let Some(module) = pending.pop() {
            let body = fs::read_to_string(src.join(&module)).expect("a module of the crate");
            let mut named = Vec::new();
            crate_heads(
                TokenStream::from_str(&body).expect("a module that lexes"),
                &mut named,
            );
            for name in named {
                let file = format!("{name}.rs");
                // `use crate::Fallible` and friends name an item of lib.rs, not a module of its own.
                if !src.join(&file).is_file() || reached.contains(&file) {
                    continue;
                }
                reached.push(file.clone());
                pending.push(file);
            }
        }
        reached.sort();
        let mut declared: Vec<String> = SHADE_CODE.iter().map(|m| (*m).to_owned()).collect();
        declared.sort();

        assert_eq!(reached, declared);
    }

    /// The second chunks pass is stamped on what the graph STRANDED rather than on the graph's own
    /// stamp, so a graph that reran and landed on the same islands leaves the chunks alone.
    #[test]
    fn the_second_chunks_pass_follows_the_stranded_set_and_not_the_graph() {
        let plan = stamping_plan("stamps-stranded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(&plan).expect("the stamps");
        let chunks = stamps.chunks(&cities).expect("the chunks stamp");
        let mut islands = chunks::Stranded::default();
        islands.insert("nyc", vec![30, 31]);
        let before = stamps
            .stranded_chunks(&cities, &chunks, &islands)
            .expect("a stamp");

        let mut same = chunks::Stranded::default();
        same.insert("nyc", vec![30, 31]);
        assert_eq!(
            stamps
                .stranded_chunks(&cities, &chunks, &same)
                .expect("a stamp"),
            before
        );

        let mut moved = chunks::Stranded::default();
        moved.insert("nyc", vec![30]);
        assert_ne!(
            stamps
                .stranded_chunks(&cities, &chunks, &moved)
                .expect("a stamp"),
            before
        );
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
