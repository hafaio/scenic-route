//! The varint coordinate codec every `.bin` is written with, and the readers for the four
//! source files. TypeScript writes these; Rust only reads them (and patches the street
//! density blob back in place). Layouts are documented in scripts/README.md.

use std::fs;
use std::path::Path;

use crate::Fallible;

pub const TREE_FORMAT: u16 = 3; // v3 adds a genus byte per tree; v2 added the crown byte
pub const CANOPY_FORMAT: u16 = 1; // the measured 2017 LiDAR canopy, the shared polygon layout under magic CNPY
pub const LAND_FORMAT: u16 = 1;
pub const STREET_FORMAT: u16 = 5;
pub const PATH_FORMAT: u16 = 1; // OSM pedestrian/park ways: STRT v5's layout, magic "PATH"
pub const FERRY_FORMAT: u16 = 2; // the time-independent NYC ferry graph, magic "FERR"; v2 adds a route name id
pub const LANDMARK_FORMAT: u16 = 1; // scenic POI points, the shared point layout, magic "LMRK"
pub const ART_FORMAT: u16 = 1; // public-art POI points, the shared point layout, magic "ARTW"
pub const HIGHWAY_FORMAT: u16 = 1; // highway/elevated-rail nuisance lines, the LAND polygon layout, magic "HWAY"

pub const SIDES: usize = 2; // the two sidewalks a density blob carries per vertex, left then right
pub const DECIMETERS_PER_METER: f64 = 10.0; // the crown byte's unit: a decimetre of crown radius

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

fn i32_at(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"))
}

fn f32_at(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"))
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

/// The tree inventory: a point per tree, the radius of the crown disc it shades the ground with
/// (decoded from the trailing crown byte, decimetres to metres), and its genus id (0..12, from the
/// genus byte block after the crowns). The three arrays are parallel — index `i` is one tree.
pub struct Trees {
    pub coords: Vec<Coord>,
    pub crown_radii_m: Vec<f64>,
    pub genus_ids: Vec<u8>,
}

/// The points, then the `count` crown bytes, then the `count` genus bytes — each a fixed-size
/// trailing region in the same sorted order, so index `i` is one tree across all three. TREE v3.
pub fn read_trees(path: &Path) -> Fallible<Trees> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, "TREE", TREE_FORMAT, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };

    let mut coords = Vec::with_capacity(head.count);
    let mut x: i64 = 0;
    let mut y: i64 = 0;
    for _ in 0..head.count {
        x += i64::from(cursor.varint());
        y += i64::from(cursor.varint());
        coords.push(Coord {
            lng: head.origin_lng + x as f64 * head.scale,
            lat: head.origin_lat + y as f64 * head.scale,
        });
    }
    // The crown bytes then the genus bytes are the two fixed-size trailing regions, one byte each
    // per point, written after the variable-length coordinate stream the cursor just walked.
    let crowns = cursor.offset;
    let genera = crowns + head.count;
    let end = genera + head.count;
    if bytes.len() < end {
        return Err(format!(
            "{} is truncated: {} bytes, {} needed for {} crown and genus bytes",
            path.display(),
            bytes.len(),
            end,
            head.count
        )
        .into());
    }
    let crown_radii_m = bytes[crowns..genera]
        .iter()
        .map(|byte| f64::from(*byte) / DECIMETERS_PER_METER)
        .collect();
    let genus_ids = bytes[genera..end].to_vec();
    Ok(Trees {
        coords,
        crown_radii_m,
        genus_ids,
    })
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

/// A bare point set (the scenic POI sources: `LMRK` landmarks, `ARTW` public art). The shared
/// point layout — the header, then `count` (lng, lat) varint deltas, no trailing payload. `tiler
/// graph` snaps each to the nearest walking node and fans it out into a per-edge discount.
pub fn read_points(path: &Path, magic: &str, format: u16) -> Fallible<Vec<Coord>> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, magic, format, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };
    let mut coords = Vec::with_capacity(head.count);
    let mut x: i64 = 0;
    let mut y: i64 = 0;
    for _ in 0..head.count {
        x += i64::from(cursor.varint());
        y += i64::from(cursor.varint());
        coords.push(Coord {
            lng: head.origin_lng + x as f64 * head.scale,
            lat: head.origin_lat + y as f64 * head.scale,
        });
    }
    Ok(coords)
}

/// The street network, plus the file it came from: `tiler densities` patches the trailing
/// density blob back into `bytes` and rewrites it, so the blob is not decoded away.
pub struct Streets {
    pub bytes: Vec<u8>,
    pub lngs: Vec<f64>, // every vertex of every segment, concatenated
    pub lats: Vec<f64>,
    pub starts: Vec<u32>, // segments + 1 entries; segment i owns [starts[i], starts[i + 1])
    pub road_types: Vec<u8>, // per segment: 1 street, 3 bridge, 4 tunnel, 5 boardwalk, 6 path, 7 step, 10 alley
    pub width_feet: Vec<u8>, // curb to curb, 0 unknown — what the sidewalk offset is derived from
    pub flags: Vec<u8>, // per segment: bit0 vehicular-only, bit1 non-vehicular deck, bit2 structure
    pub name_ids: Vec<u16>, // per segment: index into `names`, 0xFFFF when the row carried no label
    pub names: Vec<String>, // the distinct street names, decoded from the trailing name blob
    pub lengths_m: Vec<f32>, // per segment: the stored geodesic length; the graph sums, never recomputes
    pub origin_lng: f64, // the quantized deltas' reference, so `tiler graph` can recover the ints
    pub origin_lat: f64,
    pub scale: f64, // degrees per quantized unit (1e-6)
    density_offset: usize,
}

impl Streets {
    pub fn segments(&self) -> usize {
        self.starts.len() - 1
    }

    pub fn vertices(&self) -> usize {
        self.lngs.len()
    }

    /// The left and right densities of every vertex, interleaved.
    pub fn densities(&self) -> &[u8] {
        &self.bytes[self.density_offset..self.density_offset + SIDES * self.vertices()]
    }

    pub fn densities_mut(&mut self) -> &mut [u8] {
        let (from, to) = (
            self.density_offset,
            self.density_offset + SIDES * self.lngs.len(),
        );
        &mut self.bytes[from..to]
    }
}

/// STRT v5: the CSCL street network. `road_types` is rw_type, `width_feet` the curb-to-curb
/// width, `flags` the vehicular/deck/structure bits.
pub fn read_streets(path: &Path) -> Fallible<Streets> {
    read_network(path, "STRT", STREET_FORMAT)
}

/// PATH v1: the OSM pedestrian/park network. Same byte layout, reinterpreted per the PATH table
/// (scripts/README.md) — `road_types` is the kind (6 path, 7 steps), `width_feet` is 0 (a path
/// has no roadway, so `half_offset_meters` returns 0 and one sample stands for both sides), and
/// `flags` carries only bit2 structure.
pub fn read_paths(path: &Path) -> Fallible<Streets> {
    read_network(path, "PATH", PATH_FORMAT)
}

// STRT v5's reader, shared by both networks: the two files are byte-identical in shape, so only
// the magic and format version differ. The field meanings above are the caller's to know.
fn read_network(path: &Path, magic: &str, format: u16) -> Fallible<Streets> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, magic, format, path)?;
    let header_bytes = usize::from(u16_at(&bytes, 6));
    let record_bytes = usize::from(u16_at(&bytes, 8));
    let count = u32_at(&bytes, 12) as usize;
    let origin_lng = f64_at(&bytes, 16);
    let origin_lat = f64_at(&bytes, 24);
    let scale = f64_at(&bytes, 32);
    let coord_offset = u32_at(&bytes, 40) as usize;
    let density_offset = u32_at(&bytes, 48) as usize;
    let density_bytes = u32_at(&bytes, 52) as usize;
    let name_offset = u32_at(&bytes, 56) as usize;
    let name_bytes = u32_at(&bytes, 60) as usize;
    // The name blob is the final region, so this covers the records, coordinates and densities
    // before it too.
    if bytes.len() < name_offset + name_bytes {
        return Err(format!(
            "{} is truncated: {} bytes, {} needed for {count} segments",
            path.display(),
            bytes.len(),
            name_offset + name_bytes
        )
        .into());
    }

    let vertices = density_bytes / SIDES;
    let mut lngs = Vec::with_capacity(vertices);
    let mut lats = Vec::with_capacity(vertices);
    let mut starts = Vec::with_capacity(count + 1);
    let mut road_types = Vec::with_capacity(count);
    let mut width_feet = Vec::with_capacity(count);
    let mut flags = Vec::with_capacity(count);
    let mut name_ids = Vec::with_capacity(count);
    let mut lengths_m = Vec::with_capacity(count);
    for segment in 0..count {
        let record = header_bytes + segment * record_bytes;
        let mut cursor = Cursor {
            bytes: &bytes,
            offset: coord_offset + u32_at(&bytes, record + 4) as usize,
        };
        let length = usize::from(u16_at(&bytes, record + 8));
        starts.push(lngs.len() as u32);
        road_types.push(bytes[record + 20]);
        width_feet.push(bytes[record + 21]);
        flags.push(bytes[record + 23]);
        name_ids.push(u16_at(&bytes, record + 10));
        lengths_m.push(f32::from_le_bytes(
            bytes[record + 12..record + 16].try_into().expect("4 bytes"),
        ));

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
    // Two densities a vertex, and the blob is sized from the records the coordinates were just
    // decoded against: a disagreement means the two halves of the file are not the same network.
    if density_bytes != SIDES * lngs.len() {
        return Err(format!(
            "{} carries {density_bytes} density bytes for {} vertices, not {}",
            path.display(),
            lngs.len(),
            SIDES * lngs.len()
        )
        .into());
    }
    // The name blob: a u32 count, then each name as a u16 byte length and its UTF-8 bytes.
    let mut names = Vec::new();
    let mut name_cursor = name_offset;
    let name_count = u32_at(&bytes, name_cursor) as usize;
    name_cursor += 4;
    names.reserve(name_count);
    for _ in 0..name_count {
        let len = usize::from(u16_at(&bytes, name_cursor));
        name_cursor += 2;
        names.push(String::from_utf8_lossy(&bytes[name_cursor..name_cursor + len]).into_owned());
        name_cursor += len;
    }

    Ok(Streets {
        bytes,
        lngs,
        lats,
        starts,
        road_types,
        width_feet,
        flags,
        name_ids,
        names,
        lengths_m,
        origin_lng,
        origin_lat,
        scale,
        density_offset,
    })
}

/// One ferry stop, in final geographic coordinates with its GTFS name — unsnapped in the file;
/// `tiler graph` snaps it to the nearest walking node.
pub struct FerryStop {
    pub lng: f64,
    pub lat: f64,
    pub name: String,
}

/// One ferry segment: an unordered stop pair (`stop_a` is the lexicographically smaller key), the
/// combined crossing-plus-wait time the later phase costs it by, the primary route's display name
/// ("Staten Island Ferry", "East River"; empty when the feed named none), and the drawing polyline
/// oriented A -> B (first and last vertices are the two stops' own coordinates, else `None` for a
/// straight leg).
pub struct FerrySegment {
    pub stop_a: u32,
    pub stop_b: u32,
    pub raw_time_seconds: f32,
    pub route_name: String,
    pub geometry: Option<Vec<Coord>>,
}

pub struct Ferries {
    pub stops: Vec<FerryStop>,
    pub segments: Vec<FerrySegment>,
}

/// FERR v2: the consolidated NYC ferry graph. A 56-byte header, a stop table (quantized lng/lat and
/// a name id), a segment table (a stop pair, the raw time, a geometry pointer, and a route name id),
/// a varint geometry blob, and a trailing name blob that holds the stop names and the route names
/// together — the shared codec, coordinates quantized about the south-west origin. Layout:
/// scripts/README.md.
pub fn read_ferries(path: &Path) -> Fallible<Ferries> {
    const STOP_BYTES: usize = 12;
    const SEGMENT_BYTES: usize = 20;
    const NO_GEOMETRY: u32 = 0xFFFF_FFFF; // a segment's geometry offset when it is a straight A -> B
    const NO_ROUTE_NAME: u16 = 0xFFFF; // a segment's route name id when the feed named no route

    let bytes = fs::read(path)?;
    check_magic(&bytes, "FERR", FERRY_FORMAT, path)?;
    let header_bytes = usize::from(u16_at(&bytes, 6));
    let stop_count = u32_at(&bytes, 8) as usize;
    let segment_count = u32_at(&bytes, 12) as usize;
    let origin_lng = f64_at(&bytes, 16);
    let origin_lat = f64_at(&bytes, 24);
    let scale = f64_at(&bytes, 32);
    let geometry_offset = u32_at(&bytes, 40) as usize;
    let name_offset = u32_at(&bytes, 48) as usize;
    let name_bytes = u32_at(&bytes, 52) as usize;
    if bytes.len() < name_offset + name_bytes {
        return Err(format!(
            "{} is truncated: {} bytes, {} needed for {stop_count} stops and {segment_count} segments",
            path.display(),
            bytes.len(),
            name_offset + name_bytes
        )
        .into());
    }

    // The name blob: a u32 count, then each name as a u16 byte length and its UTF-8 bytes.
    let mut names: Vec<String> = Vec::new();
    let mut name_cursor = name_offset;
    let name_count = u32_at(&bytes, name_cursor) as usize;
    name_cursor += 4;
    names.reserve(name_count);
    for _ in 0..name_count {
        let len = usize::from(u16_at(&bytes, name_cursor));
        name_cursor += 2;
        names.push(String::from_utf8_lossy(&bytes[name_cursor..name_cursor + len]).into_owned());
        name_cursor += len;
    }

    let stop_table = header_bytes;
    let mut stops = Vec::with_capacity(stop_count);
    for index in 0..stop_count {
        let record = stop_table + index * STOP_BYTES;
        let x = i32_at(&bytes, record);
        let y = i32_at(&bytes, record + 4);
        let name_id = u32_at(&bytes, record + 8) as usize;
        stops.push(FerryStop {
            lng: origin_lng + f64::from(x) * scale,
            lat: origin_lat + f64::from(y) * scale,
            name: names.get(name_id).cloned().unwrap_or_default(),
        });
    }

    let segment_table = stop_table + stop_count * STOP_BYTES;
    let mut segments = Vec::with_capacity(segment_count);
    for index in 0..segment_count {
        let record = segment_table + index * SEGMENT_BYTES;
        let stop_a = u32_at(&bytes, record);
        let stop_b = u32_at(&bytes, record + 4);
        let raw_time_seconds = f32_at(&bytes, record + 8);
        let geom_offset = u32_at(&bytes, record + 12);
        let vertex_count = usize::from(u16_at(&bytes, record + 16));
        let route_name_id = u16_at(&bytes, record + 18);
        let route_name = if route_name_id == NO_ROUTE_NAME {
            String::new()
        } else {
            names
                .get(usize::from(route_name_id))
                .cloned()
                .unwrap_or_default()
        };
        let geometry = if geom_offset == NO_GEOMETRY {
            None
        } else {
            let mut cursor = Cursor {
                bytes: &bytes,
                offset: geometry_offset + geom_offset as usize,
            };
            let mut polyline = Vec::with_capacity(vertex_count);
            let mut x: i64 = 0;
            let mut y: i64 = 0;
            for _ in 0..vertex_count {
                x += i64::from(cursor.varint());
                y += i64::from(cursor.varint());
                polyline.push(Coord {
                    lng: origin_lng + x as f64 * scale,
                    lat: origin_lat + y as f64 * scale,
                });
            }
            Some(polyline)
        };
        segments.push(FerrySegment {
            stop_a,
            stop_b,
            raw_time_seconds,
            route_name,
            geometry,
        });
    }

    Ok(Ferries { stops, segments })
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
