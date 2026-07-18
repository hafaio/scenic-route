//! `tiler chunks`: renders data/{streets,paths}/<id>.bin into the vector chunks the client draws
//! over the basemap — one z12 tile at public/streets/{x}/{y}.bin, carrying every street and path
//! that touches it with the per-sidewalk cover bytes densities baked in. See scripts/README.md.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::Fallible;
use crate::binfmt::{self, SIDES, Streets, write_varint, zigzag};
use crate::geometry::round_half_up;
use crate::manifest::Manifest;
use crate::raster::{
    TILE_SIZE, lat_to_pixel_y, lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat, tile_index,
};
use crate::sidewalks;

// layouts: scripts/README.md
const CHUNK_FORMAT: u16 = 3;
const CHUNK_HEADER_BYTES: usize = 40;
const CHUNK_COORD_SCALE: f64 = 1e-6; // degrees per quantized unit, ~0.1 m
const CHUNK_ZOOM: u32 = 12;
const DECIMETERS_PER_METER: f64 = 10.0; // the chunk's unit for the sidewalk offset

pub struct Args {
    pub manifest: PathBuf,
    pub data: PathBuf,
    pub chunks: PathBuf,
    pub paths: Option<PathBuf>, // the OSM path network, drawn into the same z12 street chunks
}

/// A chunk member: which network it came from and its segment index there. Streets and paths
/// share a z12 chunk, so they are bucketed and encoded together; a path is a single centreline,
/// so it lands with sidewalk offset 0 and the client draws it as the one line it is.
enum Member {
    Street(u32),
    Path(u32),
}

// The client has no access to the records, so the sidewalk offset the two lines are drawn either
// side of travels with the geometry. A path member points into `paths` and always carries offset
// 0 — it is one centreline, not a curb-to-curb road. layout: scripts/README.md
fn encode_chunk(
    streets: &Streets,
    paths: Option<&Streets>,
    members: &[Member],
    inset_meters: f64,
    origin_lng: f64,
    origin_lat: f64,
) -> Vec<u8> {
    let mut bytes = vec![0u8; CHUNK_HEADER_BYTES];
    for member in members {
        let (network, segment, offset) = match member {
            Member::Street(segment) => {
                let segment = *segment as usize;
                let offset = sidewalks::half_offset_meters(
                    streets.road_types[segment],
                    streets.flags[segment],
                    streets.width_feet[segment],
                    inset_meters,
                );
                (streets, segment, offset)
            }
            Member::Path(segment) => (
                paths.expect("a paths network for a path member"),
                *segment as usize,
                0.0,
            ),
        };
        let densities = network.densities();
        let from = network.starts[segment] as usize;
        let to = network.starts[segment + 1] as usize;
        bytes.extend_from_slice(&((to - from) as u16).to_le_bytes());
        bytes.push(round_half_up(offset * DECIMETERS_PER_METER) as u8);
        let mut previous_x = 0i64;
        let mut previous_y = 0i64;
        for vertex in from..to {
            let x = round_half_up((network.lngs[vertex] - origin_lng) / CHUNK_COORD_SCALE) as i64;
            let y = round_half_up((network.lats[vertex] - origin_lat) / CHUNK_COORD_SCALE) as i64;
            write_varint(&mut bytes, zigzag(x - previous_x));
            write_varint(&mut bytes, zigzag(y - previous_y));
            previous_x = x;
            previous_y = y;
        }
        bytes.extend_from_slice(&densities[SIDES * from..SIDES * to]);
    }

    bytes[0..4].copy_from_slice(b"STCK");
    bytes[4..6].copy_from_slice(&CHUNK_FORMAT.to_le_bytes());
    bytes[6..8].copy_from_slice(&(CHUNK_HEADER_BYTES as u16).to_le_bytes());
    bytes[8..12].copy_from_slice(&(members.len() as u32).to_le_bytes());
    bytes[16..24].copy_from_slice(&origin_lng.to_le_bytes());
    bytes[24..32].copy_from_slice(&origin_lat.to_le_bytes());
    bytes[32..40].copy_from_slice(&CHUNK_COORD_SCALE.to_le_bytes());
    bytes
}

/// Buckets one network's segments into every z12 tile their bounding box touches, tagging each
/// with `tag` so a chunk can carry both streets and paths. Bounding-box membership overshoots
/// slightly but cannot leave a gap at a tile seam.
fn bucket_network(
    network: &Streets,
    tag: fn(u32) -> Member,
    buckets: &mut HashMap<(u32, u32), Vec<Member>>,
) {
    for segment in 0..network.segments() {
        let from = network.starts[segment] as usize;
        let to = network.starts[segment + 1] as usize;
        let lngs = &network.lngs[from..to];
        let lats = &network.lats[from..to];
        let west = lngs.iter().copied().fold(f64::INFINITY, f64::min);
        let east = lngs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let south = lats.iter().copied().fold(f64::INFINITY, f64::min);
        let north = lats.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let min_x = tile_index(lng_to_pixel_x(west, CHUNK_ZOOM), CHUNK_ZOOM);
        let max_x = tile_index(lng_to_pixel_x(east, CHUNK_ZOOM), CHUNK_ZOOM);
        let min_y = tile_index(lat_to_pixel_y(north, CHUNK_ZOOM), CHUNK_ZOOM);
        let max_y = tile_index(lat_to_pixel_y(south, CHUNK_ZOOM), CHUNK_ZOOM);
        for tile_x in min_x..=max_x {
            for tile_y in min_y..=max_y {
                buckets
                    .entry((tile_x, tile_y))
                    .or_default()
                    .push(tag(segment as u32));
            }
        }
    }
}

/// Streets, then the OSM paths when present, into per-z12-tile chunks. Both networks land in the
/// same chunk file so a tile the client fetches carries everything drawn over it.
fn write_chunks(
    streets: &Streets,
    paths: Option<&Streets>,
    inset_meters: f64,
    chunks: &Path,
) -> Fallible<(usize, usize)> {
    let mut buckets: HashMap<(u32, u32), Vec<Member>> = HashMap::new();
    bucket_network(streets, Member::Street, &mut buckets);
    if let Some(paths) = paths {
        bucket_network(paths, Member::Path, &mut buckets);
    }

    let mut bytes = 0;
    for ((tile_x, tile_y), members) in &buckets {
        let origin_lng = pixel_x_to_lng(f64::from(*tile_x) * TILE_SIZE as f64, CHUNK_ZOOM);
        let origin_lat = pixel_y_to_lat(f64::from(*tile_y) * TILE_SIZE as f64, CHUNK_ZOOM);
        let encoded = encode_chunk(
            streets,
            paths,
            members,
            inset_meters,
            origin_lng,
            origin_lat,
        );
        let path = chunks
            .join(tile_x.to_string())
            .join(format!("{tile_y}.bin"));
        fs::create_dir_all(path.parent().expect("a chunk row directory"))?;
        fs::write(path, &encoded)?;
        bytes += encoded.len();
    }
    Ok((buckets.len(), bytes))
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;

    // One optional paths file rides along with the single-city manifest. Cities write disjoint
    // z12 tiles, so the paths land in whichever tiles their bbox touches without contending.
    let paths = match &args.paths {
        Some(file) => Some(binfmt::read_paths(file)?),
        None => None,
    };

    let mut chunks = 0;
    let mut chunk_bytes = 0;
    for city in &manifest.cities {
        let streets = binfmt::read_streets(&args.data.join("streets").join(&city.streets.file))?;
        eprintln!(
            "{}: {} segments, {} path segments",
            city.id,
            streets.segments(),
            paths.as_ref().map_or(0, Streets::segments),
        );
        let (city_chunks, city_bytes) = write_chunks(
            &streets,
            paths.as_ref(),
            city.streets.sidewalk_inset_meters,
            &args.chunks,
        )?;
        chunks += city_chunks;
        chunk_bytes += city_bytes;
    }

    eprintln!(
        "wrote {chunks} street chunks (z{CHUNK_ZOOM}, {:.1} MiB) in {:.1}s",
        chunk_bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}
