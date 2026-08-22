//! The graph pass's own disk cache: one city's finished topology, and one file per attribute column
//! baked over it. A cache and not an output — `.build/graph-cache/<city>/` is gitignored build glue,
//! and a build that finds none of it is a build that computes everything, exactly as before.
//!
//! Why the pass needs one at all: the topology is a few seconds and the columns over it are most of
//! an hour — New York's direct-canopy integration is 140 s and its per-bin shade bake is twenty-odd
//! minutes — so a re-ingested landmark file, which moves one 0.2 s column, has been re-running all
//! of it. The stamp beside the graph blob is what decides whether the pass runs at all; these keys
//! decide what it does once it has to.
//!
//! Every entry is named by a content key the driver computes (crates/tiler/src/build.rs), and every
//! column's key folds the base's. That is the whole correctness argument for merging a column into
//! the graph by POSITION: a column entry is only ever read back beside the very base it was baked
//! over, because a base that moved renames every column with it.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::Fallible;

/// The finished edge list: nodes, edges, geometry, names and the durable keys.
pub const BASE: &str = "base";
pub const LANDMARKS: &str = "landmarks";
pub const ART: &str = "art";
pub const HIGHWAYS: &str = "highways";
pub const COMMERCIAL: &str = "commercial";
/// The ascent and descent rows, cached as one entry: they come out of one pass over the DEM field.
pub const RELIEF: &str = "relief";
pub const CANOPY: &str = "canopy";
pub const INDUSTRIAL: &str = "industrial";
/// One entry per sun bin, keyed on that bin alone — so a schedule that gained a bin bakes one bin.
pub const SHADE: &str = "shade";

/// What this city's entries are called this build: the base's content key, and one per column, each
/// of which folds `base`.
///
/// The keys are computed by the driver rather than here, because it is the driver that knows what
/// the pass is a function of — the same expressions its stamps come from, so the pass's own
/// freshness and the cache it hits cannot disagree about what an input is.
#[derive(Clone)]
pub struct Keys {
    pub dir: PathBuf,
    pub base: String,
    pub landmarks: String,
    pub art: String,
    pub highways: String,
    pub commercial: String,
    pub relief: String,
    pub canopy: String,
    pub industrial: String,
    /// In schedule order, and empty for a city that bakes no per-edge shade.
    pub shade: Vec<String>,
}

/// Whether an entry is on disk, asked without opening it. The driver asks about the relief column
/// before the passes run: a graph whose relief is cached reads no DEM, and opening San Francisco's
/// is 651 files of georeferencing.
pub fn holds(dir: &Path, name: &str, key: &str) -> bool {
    entry(dir, name, key).is_file()
}

fn entry(dir: &Path, name: &str, key: &str) -> PathBuf {
    dir.join(format!("{name}-{key}.bin"))
}

/// One city's entries, and what this build asked for.
pub struct Cache {
    dir: PathBuf,
    /// Every entry read or written this build, so `prune` can take away the rest: a re-ingest leaves
    /// the base it moved off behind, and nothing will ever read that one again.
    claimed: HashSet<String>,
}

impl Cache {
    pub fn new(dir: &Path) -> Cache {
        Cache {
            dir: dir.to_path_buf(),
            claimed: HashSet::new(),
        }
    }

    /// The bytes this key names, if they are there and there are `expect` of them. A length that
    /// does not match is a half-written entry a killed build left, which is a miss rather than an
    /// error — the graph would otherwise be assembled out of a truncated column.
    pub fn load(&mut self, name: &str, key: &str, expect: usize) -> Fallible<Option<Vec<u8>>> {
        self.claimed.insert(file_name(name, key));
        let path = entry(&self.dir, name, key);
        match fs::read(&path) {
            Ok(bytes) if bytes.len() == expect => Ok(Some(bytes)),
            Ok(_) => {
                fs::remove_file(&path)?;
                Ok(None)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("{}: {error}", path.display()).into()),
        }
    }

    /// The same, for the base, whose length nothing knows in advance.
    pub fn load_base(&mut self, key: &str) -> Fallible<Option<Vec<u8>>> {
        self.claimed.insert(file_name(BASE, key));
        match fs::read(entry(&self.dir, BASE, key)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Written through a temporary name and renamed into place, so a build killed mid-write leaves
    /// no entry a later one would read as whole.
    pub fn store(&mut self, name: &str, key: &str, bytes: &[u8]) -> Fallible<()> {
        self.claimed.insert(file_name(name, key));
        fs::create_dir_all(&self.dir)?;
        let staged = self.dir.join(format!(".writing-{name}"));
        fs::write(&staged, bytes)?;
        Ok(fs::rename(&staged, entry(&self.dir, name, key))?)
    }

    /// Take away every entry this build did not ask for. One generation is what the cache is worth:
    /// a base is a hundred megabytes and a re-ingest is not a thing anyone goes back from.
    pub fn prune(&self) -> Fallible<()> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let path = entry?.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if !self.claimed.contains(&name) {
                fs::remove_file(&path)?;
            }
        }
        Ok(())
    }
}

fn file_name(name: &str, key: &str) -> String {
    format!("{name}-{key}.bin")
}

/// A little-endian writer for the base entry. The entry carries no format version of its own: its
/// key folds the tiler's code, so a build whose layout changed asks for a name no earlier build
/// wrote.
#[derive(Default)]
pub struct Writer {
    pub bytes: Vec<u8>,
}

impl Writer {
    pub fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    pub fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn usize(&mut self, value: usize) {
        self.u32(value as u32);
    }

    pub fn i32(&mut self, value: i32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn f32(&mut self, value: f32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn f64(&mut self, value: f64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn bytes(&mut self, value: &[u8]) {
        self.usize(value.len());
        self.bytes.extend_from_slice(value);
    }
}

/// The reader for what `Writer` wrote. Every read is bounds-checked: the entry is a file on disk,
/// and one truncated by a full filesystem must fail rather than index past its end.
pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes, at: 0 }
    }

    fn take(&mut self, count: usize) -> Fallible<&'a [u8]> {
        let end = self
            .at
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or("a cached graph base ends in the middle of a field")?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    pub fn u8(&mut self) -> Fallible<u8> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Fallible<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }

    pub fn u32(&mut self) -> Fallible<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }

    pub fn u64(&mut self) -> Fallible<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into()?))
    }

    pub fn usize(&mut self) -> Fallible<usize> {
        Ok(self.u32()? as usize)
    }

    pub fn i32(&mut self) -> Fallible<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into()?))
    }

    pub fn f32(&mut self) -> Fallible<f32> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into()?))
    }

    pub fn f64(&mut self) -> Fallible<f64> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into()?))
    }

    pub fn bytes(&mut self) -> Fallible<&'a [u8]> {
        let count = self.usize()?;
        self.take(count)
    }

    /// That every field was read, which is what says the two sides of the format agree.
    pub fn finish(&self) -> Fallible<()> {
        if self.at == self.bytes.len() {
            Ok(())
        } else {
            Err("a cached graph base carries bytes nothing read".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tiler-graph-cache-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::remove_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn an_entry_comes_back_under_its_own_key_and_no_other() {
        let dir = scratch("keys");
        let mut cache = Cache::new(&dir);
        cache.store(LANDMARKS, "abc", b"column").expect("a store");

        assert_eq!(
            cache.load(LANDMARKS, "abc", 6).expect("a load").as_deref(),
            Some(&b"column"[..])
        );
        assert!(
            cache.load(LANDMARKS, "def", 6).expect("a load").is_none(),
            "a key nothing wrote is a miss, not another key's bytes"
        );
        assert!(cache.load(ART, "abc", 6).expect("a load").is_none());
    }

    /// A killed build leaves a column shorter than the edge list it was baked over; assembling a
    /// graph out of it would write another column's bytes into the record.
    #[test]
    fn an_entry_of_the_wrong_length_is_a_miss() {
        let dir = scratch("truncated");
        let mut cache = Cache::new(&dir);
        cache.store(INDUSTRIAL, "abc", b"short").expect("a store");

        assert!(cache.load(INDUSTRIAL, "abc", 40).expect("a load").is_none());
        assert!(!holds(&dir, INDUSTRIAL, "abc"), "and it is taken away");
    }

    #[test]
    fn what_this_build_did_not_ask_for_is_pruned() {
        let dir = scratch("prune");
        let mut cache = Cache::new(&dir);
        cache.store(BASE, "old", b"a base").expect("a store");
        cache.store(CANOPY, "old", b"a column").expect("a store");

        let mut next = Cache::new(&dir);
        next.store(BASE, "new", b"a base").expect("a store");
        next.load(CANOPY, "new", 8).expect("a load");
        next.prune().expect("a pruning");

        assert!(holds(&dir, BASE, "new"));
        assert!(!holds(&dir, BASE, "old"));
        assert!(!holds(&dir, CANOPY, "old"), "a column of a base nobody has");
    }

    #[test]
    fn the_reader_reads_back_what_the_writer_wrote() {
        let mut writer = Writer::default();
        writer.f64(-73.9);
        writer.u32(7);
        writer.i32(-3);
        writer.f32(1.5);
        writer.u64(0xdead_beef_cafe);
        writer.bytes(b"nostrand av");

        let mut reader = Reader::new(&writer.bytes);
        assert_eq!(reader.f64().expect("a float"), -73.9);
        assert_eq!(reader.u32().expect("a count"), 7);
        assert_eq!(reader.i32().expect("a coordinate"), -3);
        assert_eq!(reader.f32().expect("a length"), 1.5);
        assert_eq!(reader.u64().expect("a hash"), 0xdead_beef_cafe);
        assert_eq!(reader.bytes().expect("a name"), b"nostrand av");
        reader.finish().expect("every field read");
    }

    #[test]
    fn a_truncated_entry_is_an_error_rather_than_a_panic() {
        let mut writer = Writer::default();
        writer.u64(1);
        let mut reader = Reader::new(&writer.bytes[..5]);

        assert!(reader.u64().is_err());
    }
}
