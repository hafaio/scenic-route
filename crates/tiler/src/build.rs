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
    Industrial,
    Buildings,
}

impl Source {
    /// Every variant, so `key_space_files` can decide about each one by name and a new source
    /// cannot slip past it.
    const ALL: [Source; 7] = [
        Source::Sidewalks,
        Source::Ferries,
        Source::Landmarks,
        Source::Art,
        Source::Highways,
        Source::Industrial,
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
    /// The tiler crate as one hash — its sources, its Cargo.toml and the workspace lockfile —
    /// computed by scripts/write-plan.ts over the same file list this binary is compiled from. It
    /// enters every pass's stamp, so any edit to the tiler invalidates every pass: no pass declares
    /// which modules it is a function of, and an output whose format changed would otherwise go on
    /// being served from the last build's bytes.
    code_epoch: String,
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
            stamp_file: root.join(".stamp"),
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

/// The sun grid as the pass will act on it, serialized rather than walked field by field so a bin
/// that gained a sample cannot slip past.
fn sun_bytes(params: Option<&shade::Params>) -> Fallible<Vec<u8>> {
    match params {
        Some(params) => Ok(serde_json::to_vec(params)?),
        None => Ok(Vec::new()),
    }
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
    manifest_oid: String,
    /// Each input hashed once: the commercial pass, the shade pass and the graph all read the same
    /// buildings, and `data/` is 168 MB.
    oids: HashMap<PathBuf, String>,
}

impl<'a> Stamps<'a> {
    fn new(plan: &'a Plan) -> Fallible<Stamps<'a>> {
        Ok(Stamps {
            plan,
            manifest_oid: input_oid(&plan.manifest)?,
            oids: HashMap::new(),
        })
    }

    /// A digest seeded with what every pass shares. Folding the whole manifest into all of them is
    /// coarse — one city's bounds moving re-renders another city's pyramid — and cheap, because the
    /// manifest changes about as often as the code epoch beside it does.
    fn open(&self, pass: &str) -> Sha256 {
        let mut digest = Sha256::new();
        field(&mut digest, pass.as_bytes());
        field(&mut digest, self.plan.code_epoch.as_bytes());
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

    /// Pass 3. The chunks carry no sun position, so they are cut over every city from whichever
    /// grid the driver found first — that grid, not the city it came from, is what they depend on.
    fn casters(
        &mut self,
        cities: &[(&City, &PlanCity)],
        sun: Option<&shade::Params>,
    ) -> Fallible<String> {
        let mut digest = self.open("caster-chunks");
        field(&mut digest, &sun_bytes(sun)?);
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

    /// Pass 4, one city: what casts a shadow there and where its sun stands. Both pyramids it
    /// writes, the buildings' and the trees', come out of this.
    fn shade(&mut self, city: &City, planned: &PlanCity) -> Fallible<String> {
        let mut digest = self.open("shade");
        field(&mut digest, city.id.as_bytes());
        field(&mut digest, &sun_bytes(planned.shade.as_ref())?);
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

    /// Pass 8, one city. The match over `Source` is exhaustive for `key_space_files`'s reason: a
    /// source wired into the graph later must reach this stamp without anyone remembering to add
    /// it, and every one of them is genuinely read by `graph::run`. The commercial lines are not
    /// among the files because they are pass 2's output rather than a committed source, so that
    /// pass's whole stamp stands in for them.
    fn graph(&mut self, city: &City, planned: &PlanCity, commercial: &str) -> Fallible<String> {
        let mut digest = self.open("graph");
        field(&mut digest, commercial.as_bytes());
        field(&mut digest, city.id.as_bytes());
        field(
            &mut digest,
            if planned.alleys { b"alleys" } else { b"none" },
        );
        field(&mut digest, &sun_bytes(planned.shade.as_ref())?);
        dem_identity(&mut digest, planned.elevation.as_ref())?;
        let mut inputs = vec![self.plan.data.join("streets").join(&city.streets.file)];
        inputs.extend(
            city.paths
                .as_ref()
                .map(|layer| self.plan.data.join("paths").join(&layer.file)),
        );
        inputs.extend(
            city.field
                .canopy
                .as_ref()
                .map(|layer| self.plan.data.join("canopy").join(&layer.file)),
        );
        for source in Source::ALL {
            inputs.extend(planned.source(&self.plan.data, source));
        }
        self.files(&mut digest, &inputs)?;
        Ok(hex(&digest.finalize()))
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

/// What a pass prints instead of running: its stamp matched and its output is still there. Named
/// for a city on the passes that are stamped one city at a time.
fn current(city: Option<&str>) {
    match city {
        Some(city) => eprintln!("{city}: up to date"),
        None => eprintln!("up to date"),
    }
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
    let manifest: Manifest = serde_json::from_slice(&fs::read(&plan.manifest)?)?;
    let cities = plan.pair(&manifest)?;
    plan.check_ramp()?;
    plan.reconcile(&manifest)?;

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
    let commercial_pass = Pass {
        stamp: stamps.commercial(&cities, &chunk_pass.stamp)?,
        stamp_file: plan.commercial_signals.join(".stamp"),
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
    let shade_passes: Vec<Pass> = cities
        .iter()
        .map(|(city, planned)| {
            Ok(Pass {
                stamp: stamps.shade(city, planned)?,
                stamp_file: plan.tiles.join("shade").join(&city.id).join(".stamp"),
                root: None,
                pieces: vec![
                    plan.tiles.join("shade").join(&city.id),
                    plan.tiles.join("tree-shade").join(&city.id),
                ],
                // Only the buildings' pyramid: whether the trees' twin is produced at all turns on
                // the canopy carrying a measured height, which only the pass finds out.
                witnesses: vec![plan.tiles.join("shade").join(&city.id)],
            })
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    let elevation_passes: Vec<Pass> = cities
        .iter()
        .map(|(city, planned)| {
            let root = plan.tiles.join("elevation").join(&city.id);
            Ok(Pass {
                stamp: stamps.elevation(city, planned)?,
                stamp_file: root.join(".stamp"),
                root: None,
                pieces: vec![root.clone()],
                witnesses: vec![root],
            })
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    let canopy_pass = Pass::whole(stamps.canopy(&cities)?, &plan.canopy_tiles);
    let genus_pass = Pass::whole(stamps.genus_field(&cities)?, &plan.genus_field_tiles);
    let graph_passes: Vec<Pass> = cities
        .iter()
        .zip(&baked)
        .map(|((city, planned), bake)| {
            let blob = plan.routing.join(format!("{}.bin", city.id));
            let stranded = plan.routing.join(format!("{}.stranded.bin", city.id));
            Ok(Pass {
                stamp: stamps.graph(city, planned, &commercial_pass.stamp)?,
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
        if let Some(elevation) = &planned.elevation
            && (!elevation_passes[index].is_fresh() || !graph_passes[index].is_fresh())
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
    let chunk_files = if chunk_pass.is_fresh() {
        current(None);
        chunks::Chunks {
            dir: plan.chunks.clone(),
        }
    } else {
        chunk_pass.restart()?;
        let cut = chunks::run(&chunk_args, &chunks::Stranded::default())?;
        chunk_pass.record()?;
        cut
    };

    // The commercial overlay's per-segment signals are snapped onto the chunks just written and
    // keyed on their segment index, which is why this takes the chunks themselves.
    stage(2, "commercial", &started);
    let lines = if commercial_pass.is_fresh() {
        current(None);
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
    match sun {
        Some(params) if any_casters => {
            if caster_pass.is_fresh() {
                current(None);
            } else {
                caster_pass.restart()?;
                caster_chunks::run(&caster_chunks::Args {
                    manifest: plan.manifest.clone(),
                    data: plan.data.clone(),
                    chunks: plan.casters.clone(),
                    params: params.clone(),
                })?;
                caster_pass.record()?;
            }
        }
        _ => {
            caster_pass.clear()?;
            eprintln!("no sun grid or nothing to cast a shadow; no caster chunks");
        }
    }

    // One shade pyramid per city, because a bin's sun position is synthesised at the city's own
    // latitude: two cities share neither a bin index nor a pyramid.
    stage(4, "shade", &started);
    for ((city, planned), pass) in cities.iter().zip(&shade_passes) {
        let footprints = planned.source(&plan.data, Source::Buildings).is_some();
        match &planned.shade {
            Some(params) if footprints => {
                if pass.is_fresh() {
                    current(Some(&city.id));
                } else {
                    pass.restart()?;
                    shade::run(&shade::Args {
                        manifest: plan.manifest.clone(),
                        data: plan.data.clone(),
                        tiles: plan.tiles.clone(),
                        params: params.clone(),
                        city: city.id.clone(),
                    })?;
                    pass.record()?;
                }
            }
            _ => pass.clear()?,
        }
    }

    stage(5, "elevation", &started);
    for ((city, planned), pass) in cities.iter().zip(&elevation_passes) {
        if planned.elevation.is_none() {
            pass.clear()?;
        } else if pass.is_fresh() {
            current(Some(&city.id));
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
    if manifest
        .cities
        .iter()
        .any(|city| city.field.canopy.is_some())
    {
        if canopy_pass.is_fresh() {
            current(None);
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
    if manifest
        .cities
        .iter()
        .any(|city| city.field.genus.is_some())
    {
        if genus_pass.is_fresh() {
            current(None);
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
        if pass.is_fresh() {
            current(Some(&city.id));
            // The re-chunk below wants this city's stranded ways whether or not the graph that
            // computed them ran, and the artifact beside the graph is where they were written.
            stranded.insert(&city.id, graph::read_stranded(&stranded_file)?);
            continue;
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
                elevation_bounds: dem.is_some().then_some(city.bounds),
                alleys: planned.alleys,
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
        stamp: stamps.stranded_chunks(&cities, &chunk_pass.stamp, &stranded)?,
        stamp_file: plan.chunks.join(".stamp-stranded"),
        root: None,
        pieces: Vec::new(),
        witnesses: vec![plan.chunks.clone()],
    };
    if manifest.cities.iter().any(|city| city.paths.is_some()) {
        if stranded_pass.is_fresh() {
            current(None);
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
    /// - landmarks, art, highways, the commercial lines and the industrial lots are each one
    ///   per-edge attribute byte, read after the last edge is pushed;
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
              "codeEpoch": "5eaf00d",
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
        let pyramid = root.join("tiles/shade/nyc");
        let pass = Pass {
            stamp: "a".to_owned(),
            stamp_file: pyramid.join(".stamp"),
            root: None,
            pieces: vec![pyramid.clone(), root.join("tiles/tree-shade/nyc")],
            witnesses: vec![pyramid.clone()],
        };
        pass.restart().expect("the pyramid");
        fs::create_dir_all(root.join("tiles/tree-shade/nyc")).expect("the tree pyramid");
        pass.record().expect("a stamp");
        assert!(pass.is_fresh());

        pass.clear().expect("a clearing");

        assert!(!pyramid.exists());
        assert!(!root.join("tiles/tree-shade/nyc").exists());
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
    }

    /// Every file a pass of this build could name, given the manifest above and a plan that hands
    /// over both sidewalk extracts, each with its own path as its contents so a file read in
    /// another's place is caught. What is missing is deliberate: the commercial pass's dining and
    /// open-streets sources are read only if they exist, and the stamps have to say so.
    const INPUTS: [(&str, &str); 12] = [
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
        let mut plan = plan(BOTH);
        plan.data = data;
        plan.manifest = root.join("manifest.json");
        plan
    }

    /// One stamp per pass, so a test can say which passes a change would rerun. The per-city ones
    /// are New York's, the city the manifest above gives every layer to.
    struct Stamped {
        chunks: String,
        commercial: String,
        casters: String,
        shade: String,
        elevation: String,
        canopy: String,
        genus_field: String,
        graph: String,
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
        Stamped {
            casters: stamps
                .casters(&cities, planned.shade.as_ref())
                .expect("the caster-chunks stamp"),
            shade: stamps.shade(city, planned).expect("the shade stamp"),
            elevation: stamps
                .elevation(city, planned)
                .expect("the elevation stamp"),
            canopy: stamps.canopy(&cities).expect("the canopy stamp"),
            genus_field: stamps.genus_field(&cities).expect("the genus-field stamp"),
            graph: stamps
                .graph(city, planned, &commercial)
                .expect("the graph stamp"),
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
        assert_eq!(again.shade, before.shade);
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
        assert_eq!(after.shade, before.shade, "the twenty-minute pass");
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
        assert_eq!(after.shade, before.shade);
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

    /// No pass declares which modules it is a function of, so any edit to the tiler invalidates all
    /// of them — an output whose FORMAT changed moves no input file.
    #[test]
    fn a_new_tiler_reruns_every_pass() {
        let mut plan = stamping_plan("stamps-epoch");
        let before = stamped_passes(&plan);
        plan.code_epoch = "a different tiler".to_owned();
        let after = stamped_passes(&plan);

        assert_ne!(after.chunks, before.chunks);
        assert_ne!(after.commercial, before.commercial);
        assert_ne!(after.casters, before.casters);
        assert_ne!(after.shade, before.shade);
        assert_ne!(after.elevation, before.elevation);
        assert_ne!(after.canopy, before.canopy);
        assert_ne!(after.genus_field, before.genus_field);
        assert_ne!(after.graph, before.graph);
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
