# The tree-cover pipeline

Two scripts, run in order:

```sh
bun run build-tree-data   # sources -> data/**/*.bin + src/tree-cover/manifest.json
bun run build-tiles       # those -> public/tiles/ + public/streets/
```

`build-tree-data` is the slow one (a few minutes of paging, mostly network) and only
needs re-running when the sources are refreshed; its binaries are committed. `build-tiles`
is fast, its output is gitignored, and `bun dev` / `bun export` run it automatically
whenever an input is newer than the last run.

## The model

The map shows **one quantity: tree density per unit area** — not a score per road. Both
overlays are that same quantity, estimated at two scales from the same points, which is
what lets them be read against each other.

Every standing tree in the city inventory is splatted onto a 20 m grid, and that grid is
Gaussian-blurred twice:

- **broad** (σ ≈ 70 m) — neighbourhood leafiness. This is the background fill.
- **tight** (σ ≈ 20 m) — what a given street is actually lined with. Sampled bilinearly at
  every street vertex (streets are densified to ≤ 25 m first, so the colour varies along a
  road rather than in one flat block).

Both fields are then divided by the **same** constant: the p97 of the broad field over
land. That shared normalization is the whole point. A tree-lined street reads as a darker
line on the green it sits in; a bare street reads as a pale gap through it. If each field
were normalized against its own distribution the two would be incomparable and the streets
would say nothing the fill did not.

The p97 is taken over the *land* mask (shoreline-clipped borough boundaries) so the harbour
does not drag the distribution down. For NYC it lands at ~30 trees/ha.

## The sources

| what | source | notes |
| --- | --- | --- |
| trees | NYC ForMS "Forestry Tree Points", Socrata `hn5i-inap` | 898,618 rows at `tpstructure='Full'` — standing trees only, no stumps or empty pits |
| streets | NYC CSCL street centerline, Socrata `inkn-q76z` | `rw_type` in 1, 5, 6, 7, 10 = street, boardwalk, path/trail, step street, alley |
| land | NYC borough boundaries (water areas excluded), Socrata `gthc-hcne` | the population the p97 is taken over, and the clip that drops New Jersey |
| woodland | OSM `natural=wood` + `landuse=forest`, via Overpass | see below |

Only walkable road types are kept. Highways, ramps, bridges, tunnels, driveways, ferry
routes, u-turns and non-physical segments are not part of the network a person walks.

### Why woodland is a separate source

**ForMS is a street/managed-tree register. It contains no woodland at all.** The Central
Park Ramble is *zero* trees in it, not sparse ones; Van Cortlandt's forest is the same.
Ingesting only ForMS therefore paints exactly the leafiest ground in the city as bare.

So OSM `natural=wood` and `landuse=forest` polygons are filled into a canopy mask, and
inside that mask both fields are raised to a floor (0.85 normalized). The mask has no tree
count to contribute, so it is combined *after* normalization: woodland is simply treed. Its
edge is feathered (30 m) so a park boundary is not a hard cut, and because a blurred mask
sags in the middle of anything narrower than the blur — OSM maps a wood like the Ramble as
a scatter of small polygons around its paths and clearings — the feather is divided by a
plateau constant and clamped, so a cell the blur calls half-covered is fully wooded and
only the outer half of the kernel tapers.

`leisure=park` is **deliberately excluded**. A park is not canopy: the Great Lawn, the
ballfields and the Reservoir are all `leisure=park` and none of them is a tree.

Overpass is the flakiest thing in the pipeline — the query rotates over three mirrors, backs
off in minutes rather than seconds, and must send a `User-Agent` (an anonymous client gets a
429 on sight). Everything is cached, so this is a one-time cost.

## The colour scale

`src/tree-cover/ramp.ts` — a single-hue emerald sequential ramp, monotonic in lightness, so
more green always means more trees. Only the light ramp exists; dark mode inverts the whole
tile pane in CSS.

The low end is carried by **transparency, not by a pale green**. Half the city's land sits
below 0.4 of saturation, so an alpha rising linearly with density would tint essentially
everything and wash the map out. Alpha is therefore cubed: 0.4 density comes out at an alpha
of ~0.04 — a haze — and the opacity is spent on ground that is genuinely leafy.

Street lines get a small opacity multiplier (`ROAD_OPACITY`, 1.2). Same colour function, same
quantity — but a 2 px line has far less area to make its colour with than the field beneath
it, so it needs a little more opacity to hold its own.

## Running it

```sh
bun run build-tree-data              # uses .cache/ if warm
bun run build-tree-data -- --refresh # bypass .cache/, go back to the network
bun run build-tiles
```

Raw source reads are cached in `.cache/` (gitignored), keyed by the request itself, and
never expire on their own. The sources move about once a year, so a re-run wants whatever it
read last time — not a fresher copy it did not ask for.

`build-tiles` skips its work entirely if its output is newer than the manifest, the ramp, the
`.bin` inputs and the script itself.

## Committing the binaries: `sl` will silently corrupt them

`data/**/*.bin` are build *inputs*, tracked in **Git LFS** (see `.gitattributes`). They are
never shipped to the client — only the tiles and chunks rendered from them are.

> **`sl commit` does not run git-lfs clean filters.** It commits the raw multi-megabyte blob
> into the repo and says nothing.

Commit these files with git, and push the objects explicitly:

```sh
git commit -- data/tree-cover/nyc.bin data/streets/nyc.bin
git lfs push --object-id origin <oid>
```

`build-tiles` checks the magic bytes of every `.bin` it opens, which also catches the other
half of this footgun: an *unresolved* LFS pointer file (~130 bytes of text) that would
otherwise decode into nonsense.

## Binary layouts

All little-endian.

### `data/tree-cover/<id>.bin` — the field

The normalized broad field, one byte per cell, row-major from the grid's north-west corner.
Cell (col, row) covers `[west + col*degreesPerCol, +1)` by `[north - row*degreesPerRow, -1)`,
and its centre sits half a cell in from that corner.

Header, 48 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `TFLD` |
| 4 | u16 | format version |
| 6 | u16 | header bytes |
| 8 | u32 | columns |
| 12 | u32 | rows |
| 16 | f64 | west, degrees |
| 24 | f64 | north, degrees |
| 32 | f64 | degrees per column |
| 40 | f64 | degrees per row |

Then `columns * rows` bytes: the normalized density, 0 for none and 255 at the saturation
point the manifest records.

### `data/streets/<id>.bin` — the network

Header, 56 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `STRT` |
| 4 | u16 | format version |
| 6 | u16 | header bytes |
| 8 | u16 | record bytes |
| 10 | u16 | reserved |
| 12 | u32 | segment count |
| 16 | f64 | origin longitude, degrees |
| 24 | f64 | origin latitude, degrees |
| 32 | f64 | coordinate scale, degrees per quantized unit |
| 40 | u32 | coordinate blob offset, from the start of the file |
| 44 | u32 | coordinate blob length |
| 48 | u32 | density blob offset, from the start of the file |
| 52 | u32 | density blob length, one byte per vertex |

Then one 24-byte record per segment, starting at the end of the header:

| offset | type | field |
| --- | --- | --- |
| 0 | u32 | physicalid (CSCL id; repeated if one row contributed several parts) |
| 4 | u32 | offset of this segment's vertices within the coordinate blob |
| 8 | u16 | vertex count, at least 2 |
| 10 | u16 | reserved |
| 12 | f32 | geodesic length, metres |
| 16 | u32 | index of this segment's first vertex within the density blob |
| 20 | u8 | rw_type: 1 street, 5 boardwalk, 6 path, 7 step street, 10 alley |
| 21 | u8 | street width, feet (0 unknown) |
| 22 | u8 | posted speed, mph (0 unknown) |
| 23 | u8 | reserved |

Then the **coordinate blob**: per segment, `vertex count` (longitude, latitude) pairs, each
the zigzag LEB128 varint delta from the previous vertex — the first from the origin. Degrees
are `origin + unit * scale`, quantized to about 0.1 m.

Then the **density blob**: the normalized tight field at each vertex, on the same 0..255
scale as the field grid, in the same vertex order as the coordinate blob.

### `public/streets/{x}/{y}.bin` — the chunks (derived, gitignored)

The segments touching one z12 tile. A segment goes into every z12 tile its bounding box
touches; segments are short, so the few tiles it lands in beyond the ones it truly crosses
cost nothing and cannot leave a gap at a seam. Each chunk's origin is its own tile's
north-west corner, which keeps the first delta of every segment small.

Header, 40 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `STCK` |
| 4 | u16 | format version |
| 6 | u16 | header bytes |
| 8 | u32 | segment count |
| 12 | u32 | reserved |
| 16 | f64 | origin longitude, degrees |
| 24 | f64 | origin latitude, degrees |
| 32 | f64 | coordinate scale, degrees per quantized unit |

Then `segment count` segments, back to back, each:

- `u16` vertex count, at least 2
- `vertex count` (longitude, latitude) pairs, zigzag LEB128 varint deltas as above
- `vertex count` density bytes, so the line is stroked as a gradient rather than one flat
  colour

Decoded by `components/street-score-layer.tsx`.

## Adding a city

The client does not change. It reads `src/tree-cover/manifest.json` and the tile pyramid;
another entry in the manifest is another `TileLayer` and another `GridLayer`, and the tiles
of two cities that share a low-zoom tile are painted into the same buffer rather than
overwriting each other.

What has to change is the ingest in `scripts/build-tree-data.ts`, which is currently one
hard-coded `CITY` constant plus two NYC-specific fetchers. A new city needs:

1. **A tree inventory** — points, ideally with a standing/removed flag. This is the part with
   no standard: every city publishes its own.
2. **A street centerline** — line geometry plus some road classification, so the non-walkable
   types can be dropped.
3. **A land mask** — a polygon to take the p97 over and to clip the OSM woodland against
   (otherwise a bounding-box Overpass query pulls in the neighbouring state's forests).
4. Its expected row counts, which the Socrata reader uses as a floor to catch a page the
   server quietly cut short.

The **woodland source already works anywhere** — Overpass is queried by bounding box, not by
city. The grid, the blurs, the normalization, the encoders and the tiler are all
city-agnostic; only the three source fetchers and the `CITY` constant are not.
