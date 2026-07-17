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

**All of the model math lives in `crates/tiler`**, a Rust binary with three subcommands. The
scripts fetch, encode and orchestrate; they compute nothing about trees.

| | |
| --- | --- |
| `scripts/` | Socrata paging, the Overpass mirror rotation, the disk cache, the `.bin` encoders, the manifest, and the colour ramp |
| `crates/tiler` | the crown-weighted kernel density estimate, the cover transform, the Monte-Carlo cover distribution, the sidewalk offsets and their cover, the woodland mask and feather, the tile pyramid, the PNGs, the street chunks, and the routing graph |

```sh
tiler densities --params <file.json>   # fills the streets file's density blob, in place
tiler tiles --manifest … --ramp … --data … --tiles … --chunks …
tiler graph --streets <in.bin> --out <out.bin>   # contracts STRT into the GRPH routing graph
```

Both scripts shell out with `cargo run --release`, which no-ops once the binary is built, so
`bun dev` and `bun export` need no extra step. `bun lint` and `bun fmt` cover the crate too.

The split is not only for speed. The Gaussian kernel, its 3σ truncation and the
renormalization constant are the *model*; if the tiler were ported and the ingest were not,
they would live in two languages and have to be kept in step. One home.

Two things cross the boundary in the other direction, and both are deliberate:

- **The manifest is the single source of the model constants** (σ_broad, σ_tight, the crown
  allometry, the woodland floor, feather and plateau). `tiler tiles` reads them with serde
  rather than redeclaring them. `tiler densities` runs before the manifest is finished — it is
  what *reports* the cover distribution that goes into it — so the ingest passes it those
  constants as arguments.
- **The colour ramp stays in TypeScript** (`src/tree-cover/ramp.ts`), because the client's
  street layer imports the same module. That shared import is what guarantees the block fill
  and the street lines are one colour function. `build-tiles` evaluates it over the 256 density
  steps and hands the tiler a 1024-byte RGBA lookup table; Rust loads it as data and never
  defines a ramp of its own.

Because the estimator now sits *behind* the encoders, it reads the coordinates that actually
ship: the cover at a street vertex is sampled at the quantized position in
`data/streets/<id>.bin`, not at the raw source coordinate 0.05 m away, and the canopy mask is
rasterized from the polygons in `data/woodland/<id>.bin` rather than from the floats they were
rounded from.

## The model

The map shows **one quantity: the fraction of ground under tree canopy** — not a tree count and
not a score per road. It lives in [0, 1] *by construction*, so there is nothing to clip and no
saturation constant to fit. Both overlays are that same quantity, estimated at two scales from
the same points, which is what lets them be read against each other.

**Why cover, not count.** Street trees are a *line*, not a field. Estimate an areal density with
a kernel of width σ on that line and the estimate scales like 1/σ — the tighter you look, the
denser it reads (σ = 70 m fill: ~12–30 trees/ha; a 20 m centreline kernel: ~39; an 8 m kernel at
the sidewalk: ~64). Any kernel tight enough to resolve two sidewalks 14 m apart reads 2–3× the
fill, so a count normalized by one saturation constant pinned every leafy street at maximum
green: p70, p80 and p90 of the street distribution were all exactly 1.0, and you could not tell a
nice street from a spectacular one. Cover has no such constant to saturate against.

**How.** Give every tree a crown disc of area `A_i = π·r_i²`, with `r_i` from its trunk diameter
(the allometry, below). The **canopy-area index** at a point is the kernel density estimate with
each tree weighted by its crown area instead of by 1 — crown area per unit ground area, which may
exceed 1 where crowns overlap:

    CAI_σ(p) = Σ_{i : d_i < 3σ}  exp(-d_i² / (2σ²)) · A_i  /  (2πσ² · (1 - e^{-4.5}))

and the covered fraction follows from the standard Boolean (Poisson) canopy model, which handles
overlapping crowns without double-counting:

    cover(p) = 1 − exp(−CAI(p))              // in [0, 1), monotone, never clips

Working in a local metre space with the city's bounding-box centre as the origin (one reference
latitude for the whole city — across NYC's 0.42° of span that costs about 0.7% in the east-west
scale), `d_i` is the distance in metres. The kernel is truncated at 3σ and renormalized by
`1 - e^{-4.5}` so it still integrates to one — so a tree's crown area is spread over the ground
exactly, and the index is a true crown-per-ground fraction rather than one off by the truncated
tail. The `1 − e^{−x}` is a plain `exp` once per pixel, not the tabulated kernel: a different
domain, and cheap where it sits.

Two scales, same points:

- **broad** (σ = 70 m) — neighbourhood leafiness. This is the background fill.
- **tight** — what a given *sidewalk* is actually lined with. Evaluated at both sidewalks of
  every street vertex, from an oriented anisotropic kernel; see below.

Because both are the same cover fraction at different scales, they are comparable without any
shared-constant argument: a tree-lined street reads as a darker line on the green it sits in, a
bare one as a pale gap through it. **Whether a tree across the road counts is no longer a σ we
invented — it is decided by how big that tree actually is.** A mature London plane reaches over
the road; a sapling does not.

The mean cover over land is reported in the manifest (`meanCoverOverLand`), estimated over the
same seeded million-point land sample that the fill's percentiles are drawn from. For NYC's
street trees it lands at **~6–8%** — far below the ~22% all-sources canopy figure from LiDAR,
exactly as it must, since ForMS is a street-tree register and carries no park or backyard trees.

### The streets: two sidewalks, and a kernel that knows which way the road runs

Nobody walks down the middle of the road, and a street has *two* sidewalks, which can differ
completely: a block with a full canopy on the north side and bare pavement on the south is not
one averaged line. So the street cover is sampled **twice per vertex**, once either side.

The two sidewalks are only ~14 m apart, so telling them apart wants a kernel that is not too wide
across the street; but a kernel tight in every direction makes the colour lurch from tree to tree
along the road. The demands conflict only if the kernel is isotropic, so the street uses an
**oriented anisotropic Gaussian**, aligned to the local street bearing θ:

    u =  dx·cosθ + dy·sinθ                       // along the road,  σ = 15 m
    v = -dx·sinθ + dy·cosθ                       // across it,       σ =  8 m
    CAI(p) = Σ exp(-(u²/2σ_along² + v²/2σ_across²)) · A_i / (2π·σ_along·σ_across·(1 - e^-4.5))

truncated at 3σ in the *rotated* metric (`u²/σ_along² + v²/σ_across² < 9`), whose unit ellipse
holds exactly the mass a 3σ disc does — so the **same** renormalization applies and the street
index lands on the very same scale as the broad one.

The across-street σ is **deliberately loose** (8 m, not the old 5 m). With the crown discs doing
the physical work of reaching over the road, the kernel no longer has to separate the sides by
brute tightness, and it *should not*: a 5 m σ_across is a hard cut in disguise. At the real
geometry (a ~6.5 m half-offset, so the far sidewalk is ~13 m across) a same-size tree on the far
side now contributes `exp(-13.1²/(2·8²)) = 0.26` of a near one — a genuine reach-over — against
0.03 at σ_across = 5 m. It is still clearly near-dominated, and a *large* far tree, carrying a
far larger crown area, can now legitimately colour the near sidewalk, which is the whole point.

The **bearing** at a vertex is the central difference of its neighbours (one-sided at the ends);
the geometry is densified to ≤ 25 m, so that is a good local tangent.

**Where the sidewalks are.** Derived by offsetting the centerline — *no usable sidewalk dataset
exists*. NYC's "Sidewalk Centerline" layer is interior paths only (parks, NYCHA, campuses) and
explicitly excludes the ones in the street ROW; the planimetric sidewalk polygons carry no street
linkage and wrap around block corners. `streetwidth` (curb to curb, feet) is populated on 98% of
streets and alleys, so

    offsetMeters = streetwidth · 0.3048 / 2 + sidewalkInsetMeters      // inset 2 m, curb to sidewalk centre

either side, falling back to the 30 ft median where the width is missing. **Boardwalks, paths,
step streets and non-vehicular bridge/tunnel decks are not offset**: they *are* the walking
surface, so they are sampled once, on the line, and both their sides carry that one value. A
*vehicular* bridge or tunnel does have sidewalks, so it is offset by its width like a street.
Left and right follow the digitization direction
(left = 90° CCW), which is CSCL's own `l_`/`r_` convention.

The two sidewalks are ~14 m apart, which at z13 is a single pixel — so the client draws the
offset in **pixels**, floored at a stroke width and dissolving into the true geometry as the map
zooms in. It is never baked into the data.

### The allometry: trunk to crown

ForMS carries `dbh` (trunk diameter at breast height, in whole inches) on 99.9% of standing
trees. The crown radius each tree is weighted by comes from a **published** relation, not an
invented one: **McPherson, van Doorn & Peper 2016, *Urban Tree Database and Allometric
Equations*, USDA Forest Service GTR-PSW-253** (data archive RDS-2016-0005). Its "NoEast"
reference city is Queens, so this is literally NYC street-tree data; the **London planetree**
log-log curve — the city's most abundant street species, R² 0.94 — stands in for every species,
since the ingest does not read species. With dbh in cm and diameter in metres,

    crown_diameter = exp( -0.752 + 2.414·ln(ln(dbh_cm + 1)) + 0.00988 )
    crown_radius   = crown_diameter / 2 ;  crown_area = π·crown_radius²

At the NYC median dbh (~10 in) this is an ~8.4 m crown (~55 m²); at the mean (~11.7 in) ~9.4 m
(~70 m²). The constant is **not** fitted to hit a canopy target — the mean cover it produces is
reported and read against reality, not tuned to it.

Two inputs are cleaned before the curve sees them, in `scripts/build-tree-data.ts`:

- **Outliers.** `max(dbh)` is 2427 in, nonsense. Trunks past **60 in** (already a very large
  street tree) are clamped there; ~200 rows are affected. The ingest logs the count.
- **Missing dbh.** ~734 trees carry `dbh = 0`. They are given the **median (9 in)** rather than
  a zero crown. The ingest logs that count too, and the manifest records both.

The allometry lives only in the ingest: it writes a **crown-radius byte per tree** (decimetres,
0–25.5 m) into the `TREE` file, and Rust reads the radius and squares it. So the model constants
sit in one place, and the estimator does geometry, not botany.

### Anti-aliasing the fill

A pixel is an area, not a point. What the fill wants is the field averaged over the pixel's
footprint, and a box of side *p* has variance `p²/12`, so the kernel is widened to absorb it:

    σ_eff = sqrt(σ_broad² + p² / 12)

with `p` the ground metres per pixel at that tile's zoom and latitude. At z15 (`p` ≈ 3.6 m)
this is nothing; at z9 (`p` ≈ 232 m) it is most of the kernel, and without it the tile would
be point-sampling a 70 m field through a 232 m pixel and aliasing badly. This applies only to
the fill — a sidewalk is sampled at a point, and gets the street kernel unwidened.

### The cover distribution, by Monte Carlo

There is no saturation constant to estimate anymore — cover is bounded by construction — but the
manifest still records **what the cover actually is** over the city, so the ramp can be tuned
against a real distribution and the mean can be sanity-checked. It is measured from a million
points drawn uniformly over the city's *ground area*: longitude uniform, latitude uniform in
`sin(lat)` (a degree of latitude at the top of the city is not worth more than one at the
bottom), rejected against the land polygons, and the broad cover evaluated exactly at each one
that lands. The draw is seeded from a fixed constant, so the reported mean does not churn between
runs; the manifest records the sample count, the seed, the mean and the full set of percentiles.

Point-in-polygon against a shoreline of ~200k edges, a million times over, needs an index:
every edge is bucketed into the horizontal bands it spans, and a query only tests the edges
in its own band.

## The sources

| what | source | notes |
| --- | --- | --- |
| trees | NYC ForMS "Forestry Tree Points", Socrata `hn5i-inap` | ~899k rows at `tpstructure='Full'` — standing trees only, no stumps or empty pits; `dbh` (trunk inches) is read to size each crown |
| streets | NYC CSCL street centerline, Socrata `inkn-q76z` | `rw_type` in 1, 5, 6, 7, 10 = street, boardwalk, path/trail, step street, alley, plus pedestrian bridges/tunnels (3, 4) where `nonped != 'V'` |
| land | NYC borough boundaries (water areas excluded), Socrata `gthc-hcne` | the population the cover distribution is taken over, and the clip that drops New Jersey |
| woodland | OSM `natural=wood` + `landuse=forest`, via Overpass | see below |
| paths | OSM pedestrian/park ways (`highway` footway/path/pedestrian/steps/cycleway/bridleway/track), via Overpass | the park and greenway network CSCL lacks; a separate committed source, magic `PATH` — see below and "Binary layouts" |

Only walkable road types are kept. Highways, ramps, driveways, ferry routes, u-turns and
non-physical segments are not part of the network a person walks. Bridges and tunnels come in
only when they carry pedestrians (`rw_type` 3/4 with `nonped != 'V'`) — that is what restores the
East River crossings — and every kept row is flagged (record byte 23) so a router can drop the
vehicular-only streets the overlay still draws.

### Why woodland is a separate source

**ForMS is a street/managed-tree register. It contains no woodland at all.** The Central
Park Ramble is *zero* trees in it, not sparse ones; Van Cortlandt's forest is the same.
Ingesting only ForMS therefore paints exactly the leafiest ground in the city as bare.

So OSM `natural=wood` and `landuse=forest` polygons are filled into a canopy mask, and inside
that mask the cover is raised to a floor. A forest is simply **~90% canopy cover** — a
measurement, not an arbitrary constant, and the old normalized-density hack is gone: the floor is
a cover value now, applied after the `1 − e^{−CAI}` transform, because the mask carries no crowns
of its own. Its edge is feathered (Gaussian, σ = 30 m) so a park boundary is not a hard cut, and
because a blurred mask sags in the middle of anything narrower than the blur — OSM maps a wood
like the Ramble as a scatter of small polygons around its paths and clearings — the feather is
divided by a plateau constant (0.5) and clamped, so ground the blur calls half-covered is fully
wooded and only the outer half of the kernel tapers:

    feather = gaussian_30m(woodland ∧ land)
    floor   = 0.90 * min(1, feather / 0.5)
    value   = max( 1 − e^{−CAI}, floor )

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

### The pedestrian and park paths (`PATH` v1)

CSCL is a *street* centerline: it carries almost none of the interior of a park. Central Park is
21 km of CSCL path against 89 km in OSM; Prospect Park is 1.3 km against 51 km — the router
cannot enter their interiors at all. So OSM's pedestrian and park ways are ingested as a second
committed network, `data/paths/nyc.bin`, magic `PATH`. Its byte layout is **STRT v5's exactly**,
so `binfmt.rs` reads it with the same code (`read_paths`) and `tiler densities` samples it with
the same loop; only a few record fields are reinterpreted (see "Binary layouts").

The Overpass filter (decision 1 of the park-paths plan) keeps the walking net and nothing else:

    way["highway"~"^(footway|path|pedestrian|steps|cycleway|bridleway|track)$"]
       ["footway"!~"^(sidewalk|crossing|traffic_island)$"]
       ["area"!="yes"]["access"!~"^(no|private)$"]["foot"!~"^(no|private)$"]["indoor"!="yes"]

`footway`/`path`/`pedestrian`/`steps` are the core; `cycleway` brings the greenways (a bike-only
segment carries `foot=no` and drops out); `bridleway` is the Central Park bridle path; `track` is
park maintenance road. **`footway=sidewalk`/`crossing`/`traffic_island` are excluded** — GRPH
already derives sidewalks and crossings from CSCL, and ingesting OSM's would double the network;
`area=yes` (plazas) is not an edge; `access`/`foot` `no`/`private` and `indoor=yes` are not
walkable. `highway=service` is left out wholesale (driveways and parking aisles; CSCL's rw_type 10
already carries the walkable alleys). The ways are land-clipped against the borough polygons — a
way is kept if its midpoint or either endpoint is on land, which drops the New Jersey and
Westchester spill the bounding box reaches — densified to 25 m, degenerate ways under a metre
dropped, and their names **uppercased** so the client's prettifier renders "BOW BRIDGE" as "Bow
Bridge". `tiler densities` fills their density blob from the same tree field the streets use: a
path is its own walking surface, so it is sampled once on its line and that one value stands for
both sides.

This is **Phase 1** of the park-paths plan: the source exists and carries honest cover, but it is
not yet in the routing graph or the tiles (`tiler graph` and `tiler tiles` do not read `PATH`
this phase, so their output is unchanged). Conflation into GRPH is Phase 2.

## The colour scale

`src/tree-cover/ramp.ts` — a single-hue emerald sequential ramp, monotonic in lightness, so
more green always means more canopy. Its input is the covered fraction, in [0, 1). Only the light
ramp exists; dark mode inverts the whole tile pane in CSS.

Cover is a fraction, and most of the city lands low — mean cover over land is single digits, a
leafy street ~30–60%. So the ramp is **stretched over the part of [0, 1] the city actually
occupies** rather than the whole of it: at and above `COVER_FULL` (0.55) the green is fully
saturated. Cover past ~55% is already a spectacular street, so pinning full green there keeps the
gradient among leafy streets visible — which is the whole point of this phase — instead of
spending it on cover nobody reaches. It is a *display* choice, tuned by eye against the reported
cover distribution, and it is single-sourced: the client's street layer imports the same module,
and `build-tiles` bakes its 256 steps into the LUT the tiler reads.

The low end is carried by **transparency, not by a pale green**. Most of the city sits well below
full cover, so an alpha rising linearly would tint essentially everything and wash the map out.
Alpha is therefore cubed in the stretched value, holding the crowded low end down to a haze and
spending the opacity on ground that is genuinely leafy.

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

### `data/trees/<id>.bin` — the points and their crowns, magic `TREE` (v2)

`count` (longitude, latitude) pairs, each a varint delta from the previous point — the first
from the origin. The points are **sorted by quantized (latitude, longitude)** before they are
written, so a delta carries a step along a row rather than a jump across the city.

Then, as a fixed-size trailing region, `count` **crown bytes** in that same sorted order — byte
*i* sizes point *i*. Each is the crown radius in **decimetres** (0–25.5 m; the allometry never
approaches the ceiling), so the estimator reads a radius and squares it to a crown area. v1 was
points only; the ingest bumps the format to v2 when it starts writing crowns.

### `data/woodland/<id>.bin` — the canopy mask, magic `WOOD`

`count` polygons, each:

- `u16` ring count
- per ring: `u32` vertex count, then that many (longitude, latitude) varint-delta pairs, the
  first from the origin and the rest from the previous vertex

Filled even-odd, so a multipolygon's inner rings punch holes; the polygons are filled one at
a time, so two overlapping woods do not cancel each other out.

### `data/land/<id>.bin` — the land mask, magic `LAND`

Identical layout to `WOOD`. Needed at ingest (the population the cover distribution is taken
over) and at tile time (the AND against the woodland), so it is committed rather than fused into
anything.

### `data/streets/<id>.bin` — the network, magic `STRT` (v5)

Header, 64 bytes:

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
| 52 | u32 | density blob length, two bytes per vertex |
| 56 | u32 | name blob offset, from the start of the file |
| 60 | u32 | name blob length |

Then one 24-byte record per segment, starting at the end of the header:

| offset | type | field |
| --- | --- | --- |
| 0 | u32 | physicalid (CSCL id; repeated if one row contributed several parts) |
| 4 | u32 | offset of this segment's vertices within the coordinate blob |
| 8 | u16 | vertex count, at least 2 |
| 10 | u16 | street name id, an index into the name blob (`0xFFFF` = unnamed) |
| 12 | f32 | geodesic length, metres |
| 16 | u32 | index of this segment's first vertex within the density blob |
| 20 | u8 | rw_type: 1 street, 3 bridge, 4 tunnel, 5 boardwalk, 6 path, 7 step street, 10 alley |
| 21 | u8 | street width, feet, curb to curb (0 unknown) — the sidewalk offset comes from this |
| 22 | u8 | posted speed, mph (0 unknown) |
| 23 | u8 | flags: bit0 vehicular-only (`nonped='V'`), bit1 non-vehicular deck (`trafdir='NV'`), bit2 structure (a bridge or tunnel) |

`nonped='V'` streets are drawn by the overlay but a router must never walk them, so the router
drops any segment with bit0 set. **Bridges and tunnels (rw_type 3/4) are included only when they
carry pedestrians** — the ingest's `$where` keeps `rw_type in (3,4)` rows only where `nonped` is
null or not `'V'`, so the Brooklyn Bridge promenade and the six other walkable East River decks
come in while the vehicular-only spans stay out. A non-vehicular deck (bit1) is itself the walking
surface and gets no sidewalk offset; a vehicular bridge or tunnel has sidewalks like a street and
is offset by its width.

Then the **coordinate blob**: per segment, `vertex count` (longitude, latitude) varint-delta
pairs, the first from the origin.

Then the **density blob**: the canopy cover at each vertex, a covered fraction of 0..1 quantized
to 0..255 — **two bytes per vertex**, the left sidewalk then the right, in the vertex order of the
coordinate blob. It is a fixed-size trailing region, and the ingest is the only writer that
leaves it empty: `build-tree-data` writes the file with the blob zeroed, then `tiler densities`
offsets the sidewalks from the coordinates it just read back and fills the blob in place.

Finally the **name blob**: a `u32` count of distinct names, then each name as a `u16` byte length
and that many UTF-8 bytes, back to back. The names are CSCL's normalized `stname_label` ("W 60
ST"), trimmed, deduped and sorted; a segment's record points at one by index (record offset 10),
or carries `0xFFFF` where the row had no label. Read once, sequentially — a build input for the
graph, not shipped to the client, so an offsets table would be ceremony.

### `data/paths/<id>.bin` — the OSM pedestrian/park network, magic `PATH` (v1)

**Byte-for-byte the STRT v5 layout above** — the same 64-byte header, 24-byte records, coordinate
blob, zeroed density blob (filled in place by `tiler densities`) and trailing name blob — so one
reader and one sampler serve both files. Only the magic (`PATH`), the format version (1) and the
meaning of a few record fields differ. Per 24-byte record:

| offset | type | STRT meaning | PATH meaning |
| --- | --- | --- | --- |
| 0 | u32 | physicalid | **OSM way id** (the ingest drops any way whose id exceeds a u32) |
| 4 | u32 | coordinate blob offset | same |
| 8 | u16 | vertex count | same |
| 10 | u16 | name id | index into PATH's own name blob (`0xFFFF` unnamed) |
| 12 | f32 | geodesic length, metres | same |
| 16 | u32 | first vertex in the density blob | same |
| 20 | u8 | rw_type | **kind: 6 = path, 7 = steps** (the two the model distinguishes) |
| 21 | u8 | street width | **0** — a path has no roadway, so it is sampled once on its line |
| 22 | u8 | posted speed | **0** |
| 23 | u8 | flags | **bit2 structure** only (a bridge/tunnel deck or a non-zero `layer`); bits 0/1 are zero |

Kind 6/7 both drive `half_offset_meters` to 0, so — exactly like a boardwalk or a CSCL path — the
one sample taken on the centerline fills both density bytes of the vertex. The name blob holds the
ways' **uppercased** `name` tags, deduped and sorted, in PATH's own index space (the graph will
concatenate it after the street names in Phase 2). This is a committed **ODbL** source: it is an
extract of OSM geometry, so its share-alike terms follow it (see `data/README.md`).

### `public/streets/{x}/{y}.bin` — the chunks (derived, gitignored)

The segments touching one z12 tile. A segment goes into every z12 tile its bounding box
touches; segments are short, so the few tiles it lands in beyond the ones it truly crosses
cost nothing and cannot leave a gap at a seam. Each chunk's origin is its own tile's
north-west corner, which keeps the first delta of every segment small.

When a city carries a PATH layer, `tiler tiles --paths …` appends the OSM path segments to the
same chunks, back to back with the streets. A path is a single centreline, so it lands with
**half-offset 0** and its own sampled cover — the client draws an offset-0 segment as the one
line it is, so no client change is needed and park paths appear as cover-coloured lines.

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
- `u8` half-offset to a sidewalk, in **decimetres** (0 = a path or a boardwalk, drawn as a
  single line on its centreline). The client has no access to the records, so the offset it
  draws the two lines either side of travels with the geometry.
- `vertex count` (longitude, latitude) pairs, zigzag LEB128 varint deltas as above
- `2 · vertex count` density bytes, left sidewalk then right, so each line is stroked as a
  gradient rather than one flat colour

Decoded by `components/street-score-layer.tsx`, which applies the offset in *pixels*.

### `public/routing/{id}.bin` — the routing graph, magic `GRPH` (v2, derived, gitignored)

`tiler graph` contracts STRT into the graph the client routes on, then expands it into the edges a
walker actually uses. Steps 1–7 are the v1 contraction: vehicular-only segments (`nonped='V'`, flag
bit 0) are dropped; endpoints are noded by exact quantized equality then near-misses within 1 m are
union-found together; degree-2 shape joints are contracted where the two edges share a half-offset
byte, GRPH flags **and street name** (a name change mid-block is kept, so a sidewalk edge never
spans two names — reported as `nameBreakJoints`); polylines are pruned of collinear vertices
(endpoints kept). Then every street becomes the things a walker uses:

- At each node the incident street-ends are ordered by departure bearing; between consecutive ends
  sits a **corner node** on the gap bisector, one half-offset out (radius clamped to [1, 30] m).
- A street becomes **two sidewalk edges** (left and right of the centreline), each with its **own
  baked geometry** — the centreline offset perpendicular to its side by the half-offset, with the two
  end vertices replaced by the corner nodes so it runs corner-to-corner with no overshoot into the
  intersection — carrying opposite N/S/E/W side labels, each its own side's cover byte. Its length is
  that offset polyline's geodesic sum.
- A node with total degree ≥ 3 and ≥ 2 street-ends emits one **crossing edge** per street, joining
  the two corners that flank it — no geometry, length the corner-to-corner great-circle distance,
  cover the mean of the crossed street's two side bytes, the crossed street's name.
- Path surfaces (boardwalks, paths, step streets, non-vehicular decks) stay single **path edges** on
  their own geometry, tied into a corner fan by geometry-less **link edges**.

A final mop-up adds a crossing at any isolated deg-2 ring whose two sidewalk sides would otherwise
be separate components (`mopupCrossings`), and the build asserts the v2 component count equals the
v1 count. Nodes are sorted by (component, latitude, longitude) and renumbered, edges by (component,
min node id); components are labelled by size descending (0 = largest). Every edge length is at
least its straight-line node distance (clamped up if not; `lengthClamped`). Everything
little-endian.

Header, 64 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `GRPH` |
| 4 | u16 | format version = 2 |
| 6 | u16 | header bytes = 64 |
| 8 | u32 | node count N |
| 12 | u32 | edge count E |
| 16 | f64 | origin longitude, degrees |
| 24 | f64 | origin latitude, degrees |
| 32 | f64 | coordinate scale, degrees per quantized unit (1e-6) |
| 40 | u32 | component count |
| 44 | u32 | name table offset, from the start of the file |
| 48 | u32 | name table length |
| 52 | u32 | geometry blob offset, from the start of the file |
| 56 | u32 | geometry blob length |
| 60 | u32 | reserved (zero) |

Then the sections, back to back, each starting 4-byte aligned (zero-padded as needed so the client
can view them as typed arrays without copying):

1. **Node longitudes**: N × i32, quantized.
2. **Node latitudes**: N × i32, quantized.
3. **Node components**: N × u16 (+2 pad bytes when N is odd).
4. **CSR offsets**: (N+1) × u32 — node n owns half-edges `[csr[n], csr[n+1])`.
5. **Adjacency**: 2E × u32 — each entry an **edge id** (the neighbour is the edge's other
   endpoint, one indirection).
6. **Edge records**: E × 24 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u32 | node a |
| 4 | u32 | node b |
| 8 | f32 | length, metres (≥ the straight-line node distance) |
| 12 | u32 | geometry offset within the blob; **0xFFFFFFFF = no geometry** (straight a→b) |
| 16 | u16 | geometry vertex count (0 when no geometry) |
| 18 | u16 | street name id into the name table (0xFFFF = unnamed) |
| 20 | u8 | cover, 0–255, this edge's own single value |
| 21 | u8 | half-offset to the sidewalk, decimetres (sidewalk kind only; else 0) |
| 22 | u8 | kind and side: bits 0–1 kind (0 sidewalk, 1 crossing, 2 link, 3 path); bits 2–4 side (0 none, 1 N, 2 E, 3 S, 4 W) |
| 23 | u8 | flags: bit0 structure, bit1 steps, bit2 **geometry-right** (this sidewalk lies right of its stored geometry direction; clear = left) |

7. **Name table**: `u32 count`, then (count+1) × u32 byte offsets into the following UTF-8 blob,
   then the blob. Only the names the kept edges reference, re-indexed; offsets make client access
   O(1).
8. **Geometry blob**: one entry per sidewalk edge (its own baked corner-to-corner offset) and per
   path edge — `vertex count` (longitude, latitude) zigzag-LEB128 varint delta pairs. The **first
   pair is the absolute quantized position** (delta from the graph origin); the rest are from the
   previous vertex. Crossings and links carry none.

A pure degree-2 cycle is emitted as a self-loop on the one node it retains. GRPH edge flags are
distinct from the STRT record flags: a step street is bit1, and bit2 on a **sidewalk** marks the
geometry-right side (v1's "path-like" bit is gone — the kind field carries that now).

## Adding a city

The client does not change. It reads `src/tree-cover/manifest.json` and the tile pyramid;
another entry in the manifest is another `TileLayer` and another `GridLayer`, and the tiles
of two cities that share a low-zoom tile are painted into the same buffer rather than
overwriting each other.

What has to change is the ingest in `scripts/build-tree-data.ts`, which is currently one
hard-coded `CITY` constant plus three NYC-specific fetchers. A new city needs:

1. **A tree inventory** — points, ideally with a standing/removed flag and a trunk diameter to
   size the crowns (without one, a city would need its own way to a crown radius). This is the
   part with no standard: every city publishes its own.
2. **A street centerline** — line geometry plus some road classification, so the non-walkable
   types can be dropped.
3. **A land mask** — a polygon to take the cover distribution over and to clip the OSM woodland
   against (otherwise a bounding-box Overpass query pulls in the neighbouring state's forests).
4. Its expected row counts, which the Socrata reader uses as a floor to catch a page the
   server quietly cut short.

The **woodland source already works anywhere** — Overpass is queried by bounding box, not by
city. The estimator, the cover transform, the encoders and the tiler are all city-agnostic; only
the three source fetchers, the crown allometry and the `CITY` constant are not.
