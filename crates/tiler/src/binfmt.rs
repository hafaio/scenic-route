//! The varint coordinate codec every `.bin` is written with, and the readers for the four
//! source files. TypeScript writes these; Rust only reads them (and patches the street
//! density blob back in place). Layouts are documented in scripts/README.md.

use std::fs;
use std::path::Path;

use crate::Fallible;

pub const TREE_FORMAT: u16 = 1;
pub const WOODLAND_FORMAT: u16 = 1;
pub const LAND_FORMAT: u16 = 1;
pub const STREET_FORMAT: u16 = 2;

#[derive(Clone, Copy)]
pub struct Coord {
    pub lng: f64,
    pub lat: f64,
}

pub type Ring = Vec<Coord>;
pub type Polygon = Vec<Ring>;

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Cursor<'_> {
    // Zigzag LEB128. The shift is masked to five bits, as JavaScript's is, so a corrupt file
    // decodes to nonsense rather than panicking on the shift itself; the magic check is what
    // is meant to catch it.
    fn varint(&mut self) -> i32 {
        let mut value: u32 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = self.bytes[self.offset];
            self.offset += 1;
            value |= u32::from(byte & 0x7f).wrapping_shl(shift);
            shift += 7;
            if byte & 0x80 == 0 {
                return ((value >> 1) as i32) ^ -((value & 1) as i32);
            }
        }
    }
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("2 bytes"))
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"))
}

fn f64_at(bytes: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("8 bytes"))
}

// Also the guard against an unresolved Git LFS pointer file, which is ~130 bytes of text and
// would otherwise decode into nonsense.
fn check_magic(bytes: &[u8], expected: &str, format: u16, path: &Path) -> Fallible<()> {
    let magic = bytes
        .get(..4)
        .map(String::from_utf8_lossy)
        .unwrap_or_default();
    let version = if bytes.len() >= 6 {
        u16_at(bytes, 4)
    } else {
        0
    };
    if magic != expected || version != format {
        Err(format!(
            "{} is not a v{format} \"{expected}\" file (magic \"{magic}\", version {version})",
            path.display()
        )
        .into())
    } else {
        Ok(())
    }
}

// A header the three source layouts share: count, then the origin and scale the varint
// deltas are relative to.
struct Header {
    count: usize,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
    body: usize,
}

fn header(bytes: &[u8]) -> Header {
    Header {
        count: u32_at(bytes, 8) as usize,
        origin_lng: f64_at(bytes, 16),
        origin_lat: f64_at(bytes, 24),
        scale: f64_at(bytes, 32),
        body: usize::from(u16_at(bytes, 6)),
    }
}

pub fn read_points(path: &Path, magic: &str, format: u16) -> Fallible<Vec<Coord>> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, magic, format, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };

    let mut points = Vec::with_capacity(head.count);
    let mut x: i64 = 0;
    let mut y: i64 = 0;
    for _ in 0..head.count {
        x += i64::from(cursor.varint());
        y += i64::from(cursor.varint());
        points.push(Coord {
            lng: head.origin_lng + x as f64 * head.scale,
            lat: head.origin_lat + y as f64 * head.scale,
        });
    }
    Ok(points)
}

pub fn read_polygons(path: &Path, magic: &str, format: u16) -> Fallible<Vec<Polygon>> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, magic, format, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };

    let mut polygons = Vec::with_capacity(head.count);
    for _ in 0..head.count {
        let rings = usize::from(u16_at(cursor.bytes, cursor.offset));
        cursor.offset += 2;
        let mut polygon: Polygon = Vec::with_capacity(rings);
        for _ in 0..rings {
            let vertices = u32_at(cursor.bytes, cursor.offset) as usize;
            cursor.offset += 4;
            let mut ring: Ring = Vec::with_capacity(vertices);
            let mut x: i64 = 0;
            let mut y: i64 = 0;
            for _ in 0..vertices {
                x += i64::from(cursor.varint());
                y += i64::from(cursor.varint());
                ring.push(Coord {
                    lng: head.origin_lng + x as f64 * head.scale,
                    lat: head.origin_lat + y as f64 * head.scale,
                });
            }
            polygon.push(ring);
        }
        polygons.push(polygon);
    }
    Ok(polygons)
}

/// The street network, plus the file it came from: `tiler densities` patches the trailing
/// density blob back into `bytes` and rewrites it, so the blob is not decoded away.
pub struct Streets {
    pub bytes: Vec<u8>,
    pub lngs: Vec<f64>, // every vertex of every segment, concatenated
    pub lats: Vec<f64>,
    pub starts: Vec<u32>, // segments + 1 entries; segment i owns [starts[i], starts[i + 1])
    density_offset: usize,
}

impl Streets {
    pub fn segments(&self) -> usize {
        self.starts.len() - 1
    }

    pub fn vertices(&self) -> usize {
        self.lngs.len()
    }

    pub fn densities(&self) -> &[u8] {
        &self.bytes[self.density_offset..self.density_offset + self.vertices()]
    }

    pub fn densities_mut(&mut self) -> &mut [u8] {
        let (from, to) = (self.density_offset, self.density_offset + self.lngs.len());
        &mut self.bytes[from..to]
    }
}

pub fn read_streets(path: &Path) -> Fallible<Streets> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, "STRT", STREET_FORMAT, path)?;
    let header_bytes = usize::from(u16_at(&bytes, 6));
    let record_bytes = usize::from(u16_at(&bytes, 8));
    let count = u32_at(&bytes, 12) as usize;
    let origin_lng = f64_at(&bytes, 16);
    let origin_lat = f64_at(&bytes, 24);
    let scale = f64_at(&bytes, 32);
    let coord_offset = u32_at(&bytes, 40) as usize;
    let density_offset = u32_at(&bytes, 48) as usize;
    let vertices = u32_at(&bytes, 52) as usize;
    // The density blob is last, so this covers the records and the coordinates before it.
    if bytes.len() < density_offset + vertices {
        return Err(format!(
            "{} is truncated: {} bytes, {} needed for {count} segments",
            path.display(),
            bytes.len(),
            density_offset + vertices
        )
        .into());
    }

    let mut lngs = Vec::with_capacity(vertices);
    let mut lats = Vec::with_capacity(vertices);
    let mut starts = Vec::with_capacity(count + 1);
    for segment in 0..count {
        let record = header_bytes + segment * record_bytes;
        let mut cursor = Cursor {
            bytes: &bytes,
            offset: coord_offset + u32_at(&bytes, record + 4) as usize,
        };
        let length = usize::from(u16_at(&bytes, record + 8));
        starts.push(lngs.len() as u32);

        let mut x: i64 = 0;
        let mut y: i64 = 0;
        for _ in 0..length {
            x += i64::from(cursor.varint());
            y += i64::from(cursor.varint());
            lngs.push(origin_lng + x as f64 * scale);
            lats.push(origin_lat + y as f64 * scale);
        }
    }
    starts.push(lngs.len() as u32);
    Ok(Streets {
        bytes,
        lngs,
        lats,
        starts,
        density_offset,
    })
}

pub fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

pub fn write_varint(bytes: &mut Vec<u8>, value: u64) {
    let mut remaining = value;
    while remaining >= 0x80 {
        bytes.push((remaining as u8 & 0x7f) | 0x80);
        remaining >>= 7;
    }
    bytes.push(remaining as u8);
}
