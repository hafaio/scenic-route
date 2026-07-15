# The tree-cover pipeline

Two scripts, run in order:

```sh
bun run build-tree-data   # sources -> data/**/*.bin + src/tree-cover/manifest.json
bun run build-tiles       # those -> public/tiles/ + public/streets/
```

`build-tree-data` is the slow one (a few minutes of paging, mostly network) and only
needs re-running when the sources are refreshed; its binaries are committed. `build-tiles`
is the expensive one in CPU, its output is gitignored, and `bun dev` / `bun export` run it
automatically whenever an input is newer than the last run.

## Who does what: TypeScript fetches, Rust computes

**All of the model math lives in `crates/tiler`**, a Rust binary with two subcommands. The
scripts fetch, encode and orchestrate; they compute nothing about trees.

| | |
| --- | --- |
| `scripts/` | Socrata paging, the Overpass mirror rotation, the disk cache, the `.bin` encoders, the manifest, and the colour ramp |
| `crates/tiler` | the kernel density estimate, the Monte-Carlo saturation, the street-vertex densities, the woodland mask and feather, the tile pyramid, the PNGs, the street chunks |

```sh
tiler densities --params <file.json>   # fills the streets file's density blob, in place
tiler tiles --manifest … --ramp … --data … --tiles … --chunks …
```

Both scripts shell out with `cargo run --release`, which no-ops once the binary is built, so
`bun dev` and `bun export` need no extra step. `bun lint` and `bun fmt` cover the crate too.

The split is not only for speed. The Gaussian kernel, its 3σ truncation and the
renormalization constant are the *model*; if the tiler were ported and the ingest were not,
they would live in two languages and have to be kept in step. One home.

Two things cross the boundary in the other direction, and both are deliberate:

- **The manifest is the single source of the model constants** (σ_broad, σ_tight, the woodland
  floor, feather and plateau, the saturation). `tiler tiles` reads them with serde rather than
  redeclaring them. `tiler densities` cannot — it is what *computes* the saturation the
  manifest records — so the ingest passes it those constants as arguments.
- **The colour ramp stays in TypeScript** (`src/tree-cover/ramp.ts`), because the client's
  street layer imports the same module. That shared import is what guarantees the block fill
  and the street lines are one colour function. `build-tiles` evaluates it over the 256 density
  steps and hands the tiler a 1024-byte RGBA lookup table; Rust loads it as data and never
  defines a ramp of its own.

Because the estimator now sits *behind* the encoders, it reads the coordinates that actually
ship: the tight field at a street vertex is sampled at the quantized position in
`data/streets/<id>.bin`, not at the raw source coordinate 0.05 m away, and the canopy mask is
rasterized from the polygons in `data/woodland/<id>.bin` rather than from the floats they were
rounded from.

## The model

The map shows **one quantity: tree density per unit area** — not a score per road. Both
overlays are that same quantity, estimated at two scales from the same points, which is
what lets them be read against each other.

The estimate is a **kernel density estimate, evaluated exactly wherever it is wanted**:
once per output pixel when a tile is painted, once per street vertex when a road is
annotated. There is no field raster and no grid. Working in a local metre space with the
city's bounding-box centre as the origin (one reference latitude for the whole city — across
NYC's 0.42° of span that costs about 0.7% in the east-west scale), the field in trees per
square metre is

    f_σ(p) = Σ_{i : d_i < 3σ}  exp(-d_i² / (2σ²))  /  (2πσ² · (1 - e^{-4.5}))

over every tree *i* in the inventory, with `d_i` the distance in metres. The kernel is
truncated at 3σ and renormalized by `1 - e^{-4.5}` so it still integrates to one — without
that the field would read low by 1.1% and mean something slightly other than what it says.

Two scales, same points:

- **broad** (σ = 70 m) — neighbourhood leafiness. This is the background fill.
- **tight** (σ = 20 m) — what a given street is actually lined with. Evaluated at every
  street vertex (streets are densified to ≤ 25 m first, so the colour varies along a road
  rather than in one flat block).

Both fields are then divided by the **same** constant: the p97 of the broad field over
land. That shared normalization is the whole point. A tree-lined street reads as a darker
line on the green it sits in; a bare street reads as a pale gap through it. If each field
were normalized against its own distribution the two would be incomparable and the streets
would say nothing the fill did not.

The p97 is taken over the *land* mask (shoreline-clipped borough boundaries) so the harbour
does not drag the distribution down. For NYC it lands at ~30 trees/ha.

### Anti-aliasing the fill

A pixel is an area, not a point. What the fill wants is the field averaged over the pixel's
footprint, and a box of side *p* has variance `p²/12`, so the kernel is widened to absorb it:

    σ_eff = sqrt(σ_broad² + p² / 12)

with `p` the ground metres per pixel at that tile's zoom and latitude. At z15 (`p` ≈ 3.6 m)
this is nothing; at z9 (`p` ≈ 232 m) it is most of the kernel, and without it the tile would
be point-sampling a 70 m field through a 232 m pixel and aliasing badly. This applies only to
the fill — a street vertex is a point, and is evaluated at plain σ_tight.

### Saturation, by Monte Carlo

With no grid there are no land cells to sort, so the p97 is estimated from a million points
drawn uniformly over the city's *ground area*: longitude uniform, latitude uniform in
`sin(lat)` (a degree of latitude at the top of the city is not worth more than one at the
bottom), rejected against the land polygons, and the broad field evaluated exactly at each
one that lands. The draw is seeded from a fixed constant, so the number the entire ramp hangs
on is reproducible and does not churn between runs; the manifest records the sample count and
the seed alongside it.

Point-in-polygon against a shoreline of ~200k edges, a million times over, needs an index:
every edge is bucketed into the horizontal bands it spans, and a query only tests the edges
in its own band.

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
edge is feathered (Gaussian, σ = 30 m) so a park boundary is not a hard cut, and because a
blurred mask sags in the middle of anything narrower than the blur — OSM maps a wood like the
Ramble as a scatter of small polygons around its paths and clearings — the feather is divided
by a plateau constant (0.5) and clamped, so ground the blur calls half-covered is fully
wooded and only the outer half of the kernel tapers:

    feather = gaussian_30m(woodland ∧ land)
    floor   = 0.85 * min(1, feather / 0.5)
    value   = max( min(1, f / saturation), floor )

The **woodland ∧ land** is what keeps New Jersey's forests and Westchester's out: the
bounding box an Overpass query needs runs straight over both. This is the one place a raster
survives, and it is a *mask*, not a field — its resolution bounds how sharply a park edge can
be drawn and nothing else, so it costs the tree kernel nothing. The tiler rasterizes it per
tile at the tile's own resolution, into a haloed buffer so the feather has its mass at the
edges; the ingest rasterizes it once over the city at 20 m to floor the street vertices.

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

### Where the tile build spends its time

The pyramid is ~3,800 tiles and ~247 M pixels, and a 3σ disc at σ_broad holds ~160 trees, so
a full build is on the order of 36 billion kernel evaluations. Three things keep that
tractable and all are load-bearing:

- **An exp lookup table.** The kernel only ever wants `t = d²/2σ²` on `[0, 4.5)`, so it is
  tabulated over exactly that range; the nearest entry is within 3e-4 of the exact weight.
- **A uniform 60 m index over the trees**, flat arrays, CSR-style. A query scans only the
  buckets its 3σ disc reaches; an empty neighbourhood is *exactly* zero, and a tile with no
  tree within 3σ of its bounding box and no woodland in it goes straight to the shared blank
  PNG.
- **A kernel loop that neither branches nor stalls.** A row of buckets overshoots the disc by
  a fifth of its area, so the 3σ test is a coin flip the branch predictor loses: the table
  index is masked into range instead, which turns the test into a select. And the weights are
  summed into four accumulators rather than one, because a single one serializes the whole
  scan on the latency of an add — three times what the rest of a tree costs.

The build prints its own breakdown — `kde`, `mask`, `png`, `write`, `other`, as core-seconds
summed across the rayon pool.

## Committing the binaries: `sl` will silently corrupt them

`data/**/*.bin` are build *inputs*, tracked in **Git LFS** (see `.gitattributes`). They are
never shipped to the client — only the tiles and chunks rendered from them are.

> **`sl commit` does not run git-lfs clean filters.** It commits the raw multi-megabyte blob
> into the repo and says nothing.

Commit these files with git, and push the objects explicitly:

```sh
git commit -- data/trees/nyc.bin data/woodland/nyc.bin data/land/nyc.bin data/streets/nyc.bin
git lfs push --object-id origin <oid>
```

`build-tiles` checks the magic bytes of every `.bin` it opens, which also catches the other
half of this footgun: an *unresolved* LFS pointer file (~130 bytes of text) that would
otherwise decode into nonsense.

## Binary layouts

All little-endian. The three source files below share one header and one coordinate codec:
coordinates are quantized to 1e-6° (~0.1 m) and written as zigzag LEB128 varint deltas from
the previous coordinate, which is what keeps ~900k points inside a few megabytes.

Header, 40 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic |
| 4 | u16 | format version |
| 6 | u16 | header bytes |
| 8 | u32 | count |
| 12 | u32 | reserved |
| 16 | f64 | origin longitude, degrees |
| 24 | f64 | origin latitude, degrees |
| 32 | f64 | coordinate scale, degrees per quantized unit |

### `data/trees/<id>.bin` — the points, magic `TREE`

`count` (longitude, latitude) pairs, each a varint delta from the previous point — the first
from the origin. The points are **sorted by quantized (latitude, longitude)** before they are
written, so a delta carries a step along a row rather than a jump across the city.

### `data/woodland/<id>.bin` — the canopy mask, magic `WOOD`

`count` polygons, each:

- `u16` ring count
- per ring: `u32` vertex count, then that many (longitude, latitude) varint-delta pairs, the
  first from the origin and the rest from the previous vertex

Filled even-odd, so a multipolygon's inner rings punch holes; the polygons are filled one at
a time, so two overlapping woods do not cancel each other out.

### `data/land/<id>.bin` — the land mask, magic `LAND`

Identical layout to `WOOD`. Needed at ingest (the population the p97 is taken over) and at
tile time (the AND against the woodland), so it is committed rather than fused into anything.

### `data/streets/<id>.bin` — the network, magic `STRT`

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

Then the **coordinate blob**: per segment, `vertex count` (longitude, latitude) varint-delta
pairs, the first from the origin.

Then the **density blob**: the normalized tight field at each vertex, quantized to 0..255,
in the same vertex order as the coordinate blob. It is a fixed-size trailing region, and the
ingest is the only writer that leaves it empty: `build-tree-data` writes the file with the
blob zeroed, then `tiler densities` samples the field at the coordinates it just read back
and fills the blob in place.

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
hard-coded `CITY` constant plus three NYC-specific fetchers. A new city needs:

1. **A tree inventory** — points, ideally with a standing/removed flag. This is the part with
   no standard: every city publishes its own.
2. **A street centerline** — line geometry plus some road classification, so the non-walkable
   types can be dropped.
3. **A land mask** — a polygon to take the p97 over and to clip the OSM woodland against
   (otherwise a bounding-box Overpass query pulls in the neighbouring state's forests).
4. Its expected row counts, which the Socrata reader uses as a floor to catch a page the
   server quietly cut short.

The **woodland source already works anywhere** — Overpass is queried by bounding box, not by
city. The estimator, the normalization, the encoders and the tiler are all city-agnostic;
only the three source fetchers and the `CITY` constant are not.
