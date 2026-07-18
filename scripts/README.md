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

**All of the model math lives in `crates/tiler`**, a Rust binary with five subcommands. The
scripts fetch, encode and orchestrate; they compute nothing about trees.

| | |
| --- | --- |
| `scripts/` | Socrata paging, the Overpass mirror rotation, the disk cache, the `.bin` encoders, the manifest, and the colour ramp |
| `crates/tiler` | the canopy convolution and the cover it yields, the sidewalk offsets and their cover, the Monte-Carlo cover distribution, the genus-dot overlay, the tile pyramids, the WebPs, the street chunks, and the routing graph |

```sh
tiler densities --params <file.json>                          # fills the street & path density blobs, in place
tiler canopy --manifest … --ramp … --data … --tiles …         # the LiDAR-canopy cover fill pyramid
tiler genus  --manifest … --palette … --data … --tiles …      # the genus-dot raster pyramid
tiler chunks --manifest … --data … --chunks … [--paths …]     # slices STRT (+PATH) into the client's street chunks
tiler graph  --streets <in.bin> --out <out.bin> [--paths …]   # contracts STRT (+PATH) into the GRPH routing graph
```

Both scripts shell out with `cargo run --release`, which no-ops once the binary is built, so
`bun dev` and `bun export` need no extra step. `bun lint` and `bun fmt` cover the crate too.

The split is not only for speed. The Gaussian kernel, its 3σ truncation and the
renormalization constant are the *model*; if the tiler were ported and the ingest were not,
they would live in two languages and have to be kept in step. One home.

Two things cross the boundary in the other direction, and both are deliberate:

- **The manifest carries the per-city structure the tiler reads with serde** — each city's
  bounds and which layer files and overlays it has, which `tiler canopy`, `tiler genus` and
  `tiler chunks` read. The numeric model constants (σ_fill, σ_tight, the sidewalk inset, the
  cover sample count and seed) ride to `tiler densities` in its params JSON instead: densities
  runs *before* the manifest is finished — it is what *reports* the cover distribution that goes
  into it — so it cannot read them back from it. The crown allometry stays in the ingest, baked
  into each tree's crown byte, so the tiler does geometry, not botany.
- **The colour ramp stays in TypeScript** (`src/tree-cover/ramp.ts`), because the client's
  street layer imports the same module. That shared import is what guarantees the block fill
  and the street lines are one colour function. `build-tiles` evaluates it over the 256 density
  steps and hands the tiler a 1024-byte RGBA lookup table; Rust loads it as data and never
  defines a ramp of its own.

Because the estimator now sits *behind* the encoders, it reads the coordinates that actually
ship: the cover at a street vertex is sampled at the quantized position in
`data/streets/<id>.bin`, not at the raw source coordinate 0.05 m away, and the canopy the cover
convolves is read from the polygons in `data/canopy/<id>.bin` rather than from the floats they
were rounded from.

## The model

The map shows **one quantity: the fraction of ground under tree canopy** — not a tree count and
not a score per road. It is the **measured 2017 LiDAR tree canopy**, lightly blurred; it lives in
[0, 1] *by construction*, so there is nothing to clip and no saturation constant to fit. Both
overlays — the block fill and the street lines — are that same field at two scales, which is what
lets them be read against each other, and the router walks on it too.

**Why a fraction, not a count.** A tree count has no natural ceiling, so turning it into a colour
needs a saturation constant — and any constant tight enough to show a nice street pins a
spectacular one at the same maximum green, because a leafy block already carries far more trees
than the constant allows for. A covered fraction has none to saturate against: 40% under canopy is
40%, and full green is kept for ground that is genuinely near-closed. And because the source is the
*measured* LiDAR canopy — every tree the airborne scan saw, park and backyard included — the field
carries no holes where a street-tree register would have them.

**How.** The canopy is published as polygons (the `CNPY` source, below); treat them as a **0/1
ground indicator** — a point is under canopy or it is not. Convolve that indicator with a
normalized Gaussian and the value at a point is the Gaussian-weighted fraction of its
neighbourhood that is wooded: a weighted average of 0s and 1s, so it is in [0, 1] with nothing to
normalize against. The work happens in a local metre space with the city's bounding-box centre as
the origin (one reference latitude for the whole city — across NYC's 0.42° of span that costs about
0.7% in the east-west scale). The convolution is a Gauss quadrature: the indicator is rasterized
onto a grid of nodes spaced σ/4 apart out to **±2.5σ** on each axis, and the covered nodes'
weights — normalized to sum to one — are added up. No crowns and no tuning: the field *is* the
measurement, blurred.

Two scales, the same field:

- **fill** (isotropic, σ = 15 m) — the block fill, the map's background green.
- **street** — what a given *sidewalk* is lined with, from an oriented anisotropic kernel
  evaluated at both sidewalks of every street vertex; see below.

The mean cover over land is reported in the manifest (`meanCoverOverLand`), estimated over the
seeded million-point land sample the fill's percentiles are drawn from. For NYC it lands at
**~22%** — the LiDAR all-canopy figure, as it must, since the field simply *is* that canopy.

### The streets: two sidewalks, and a kernel that knows which way the road runs

Nobody walks down the middle of the road, and a street has *two* sidewalks, which can differ
completely: a block with a full canopy on the north side and bare pavement on the south is not
one averaged line. So the street cover is sampled **twice per vertex**, once either side.

The two sidewalks are only ~14 m apart, so telling them apart wants a kernel that is not too wide
across the street; but a kernel tight in every direction makes the colour lurch from patch to
patch along the road. The demands conflict only if the kernel is isotropic, so the street uses an
**oriented anisotropic Gaussian**, aligned to the local street bearing θ — broad *along* the road
so the line runs smooth, tight *across* it so the two sides stay distinct:

    u =  dx·cosθ + dy·sinθ                       // along the road,  σ = 15 m
    v = -dx·sinθ + dy·cosθ                       // across it,       σ =  4 m
    cover(p) = Σ_nodes  w(u) · w(v) · canopy(p + node)      // normalized weights, Σ w = 1

The same σ/4 quadrature as the fill, stretched to σ_along × σ_across and rotated to θ; it reaches
±2.5σ on each axis, and because the weights are normalized the street value lands on the very same
[0, 1] scale as the fill. The tight across-street σ (4 m) is what keeps a one-sided street honest:
a park-bounding avenue holds its dark park side and its pale building side rather than blurring to
their mean, which a wider kernel would.

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

The cover field is measured, not inferred from the tree points — but the points are still drawn,
as the **genus overlay** (`tiler genus`, `components/tree-dots-layer.tsx`): each tree a disc
coloured by its genus and *sized by its crown*. That crown radius comes from a **published**
relation, not an invented one: **McPherson, van Doorn & Peper 2016, *Urban Tree Database and
Allometric Equations*, USDA Forest Service GTR-PSW-253** (data archive RDS-2016-0005). Its "NoEast"
reference city is Queens, so this is literally NYC street-tree data; the **London planetree**
log-log curve — the city's most abundant street species, R² 0.94 — stands in for every species,
since the ingest does not read species. With dbh in cm and diameter in metres,

    crown_diameter = exp( -0.752 + 2.414·ln(ln(dbh_cm + 1)) + 0.00988 )
    crown_radius   = crown_diameter / 2

At the NYC median dbh (~10 in) this is an ~8.4 m crown; at the mean (~11.7 in) ~9.4 m. The curve
is **not** fitted to any target — it only sets how big a tree's dot draws, so a mature London
plane reads as a broad disc and a sapling as a speck.

Two inputs are cleaned before the curve sees them, in `scripts/build-tree-data.ts`:

- **Outliers.** `max(dbh)` is 2427 in, nonsense. Trunks past **60 in** (already a very large
  street tree) are clamped there; ~200 rows are affected. The ingest logs the count.
- **Missing dbh.** ~740 trees carry `dbh = 0`. They are given the **median (9 in)** rather than
  a zero crown. The ingest logs that count too, and the manifest records both.

The allometry lives only in the ingest: it writes a **crown-radius byte per tree** (decimetres,
0–25.5 m) into the `TREE` file, and `tiler genus` reads it back as the radius to draw each dot at
— clamped to [1.5, 16] px so a distant crown still shows and a lone giant does not swell into a
blob. So the model constant sits in one place, and the renderer does geometry, not botany.

### Anti-aliasing the fill

A canopy polygon has a hard edge — 1 under it, 0 outside — and the fill pyramid (`tiler canopy`)
turns those polygons into a smooth green in two steps. First the polygon fill is **supersampled
4×**: each pixel is rasterized as a 4 × 4 block of sub-pixels and averaged back down, so a pixel
half under canopy reads 0.5 rather than a jagged 0/1 boundary. Then the fraction is **convolved
with an isotropic Gaussian at σ = 15 m** — the same blur, at the same σ, the sidewalk sampler
uses — because raw polygon coverage is too concentrated to read as shade (a hard 1 under a crown,
0 in the gap between two) and because shade physically reaches a little past a crown's edge.

The blur runs in pixel space, so its width is `σ_pixels = 15 m / (ground metres per pixel at that
tile's zoom and latitude)`. That shrinks as the map zooms out: at z15 (`p` ≈ 3.6 m) it is ~4 px
and does real work; at z9 (`p` ≈ 232 m) it is ~0.06 px, below the **half-pixel floor** at which it
is skipped entirely — a 15 m kernel has nothing left to say through a 232 m pixel, and the
supersample average already *is* the field there. So the fill antialiases at every zoom but only
blurs where the blur is visible.

Because the kernel truncates at 3σ, a tile blurred at its own edge would lose mass and seam against
its neighbour, so each tile is rendered with a **halo** of ⌈3·σ_pixels⌉ pixels of surrounding
canopy that is cropped off afterwards. The result is clipped to the land mask so no green bleeds
over water. A sidewalk, sampled at a single point rather than over a raster, is convolved directly
and needs neither the supersample nor the halo.

### The cover distribution, by Monte Carlo

There is no saturation constant to estimate anymore — cover is bounded by construction — but the
manifest still records **what the cover actually is** over the city, so the ramp can be tuned
against a real distribution and the mean can be sanity-checked. It is measured from a million
points drawn uniformly over the city's *ground area*: longitude uniform, latitude uniform in
`sin(lat)` (a degree of latitude at the top of the city is not worth more than one at the
bottom), rejected against the land polygons, and the isotropic fill cover (σ = 15 m) evaluated
exactly at each one that lands. The draw is seeded from a fixed constant, so the reported mean does
not churn between runs; the manifest records the sample count, the seed, the mean and the full set
of percentiles.

Point-in-polygon against a shoreline of ~200k edges, a million times over, needs an index:
every edge is bucketed into the horizontal bands it spans, and a query only tests the edges
in its own band.

## The sources

| what | source | notes |
| --- | --- | --- |
| trees | NYC ForMS "Forestry Tree Points", Socrata `hn5i-inap` | ~899k rows at `tpstructure='Full'` — standing trees only, no stumps or empty pits; `dbh` (trunk inches) is read to size each crown |
| streets | NYC CSCL street centerline, Socrata `inkn-q76z` | `rw_type` in 1, 5, 6, 7, 10 = street, boardwalk, path/trail, step street, alley, plus pedestrian bridges/tunnels (3, 4) where `nonped != 'V'` |
| land | NYC borough boundaries (water areas excluded), Socrata `gthc-hcne` | the population the cover distribution is taken over, and the clip that drops New Jersey |
| canopy | NYC's 2017 LiDAR tree canopy, ArcGIS `TreeCanopy2017_Simplified_1ft` | the *measured* canopy footprint the cover field is blurred from, a committed source, magic `CNPY` — feeds the density blobs and, through them, routing; see below |
| paths | OSM pedestrian/park ways (`highway` footway/path/pedestrian/steps/cycleway/bridleway/track), via Overpass | the park and greenway network CSCL lacks; a separate committed source, magic `PATH` — see below and "Binary layouts" |

Only walkable road types are kept. Highways, ramps, driveways, ferry routes, u-turns and
non-physical segments are not part of the network a person walks. Bridges and tunnels come in
only when they carry pedestrians (`rw_type` 3/4 with `nonped != 'V'`) — that is what restores the
East River crossings — and every kept row is flagged (record byte 23) so a router can drop the
vehicular-only streets the overlay still draws.

### The measured LiDAR canopy (`CNPY` v1)

The map's cover is the **measured 2017 LiDAR tree canopy**, lightly blurred — not a point-KDE
inferred from the ForMS register. NYC Parks publishes the canopy as ~1.08 M simplified polygons on
a public ArcGIS feature service (`TreeCanopy2017_Simplified_1ft`), which `scripts/canopy.ts` pages
(2000 rows a page, ordered by `OBJECTID` so the `resultOffset` paging is stable) into lon/lat
rings, each page disk-cached like every other source read. It is land-clipped against the borough
polygons (the same ring-midpoint test the paths use, though the service is NYC-only and spills
essentially nothing), and encoded to `data/canopy/<id>.bin` in the **shared polygon byte-format**
(the `LAND` polygon header and varint-delta rings, see "Binary layouts") — the shared
`encodePolygons` encoder, under its own magic **`CNPY`** so a canopy blob self-identifies rather
than masquerading as another polygon source. `binfmt.rs::read_polygons` is already generic over the
magic, so nothing in the tiler changes to read it.

This is the **cover source itself**: `tiler densities` convolves the canopy indicator with a
Gaussian and samples it at each sidewalk offset, so the byte in every street and path density blob
— and, through them, `tiler graph` and the routing cost — is the blurred measured canopy. There is
no separate point-KDE lifting park interiors; the ForMS points now drive only the genus overlay
(see `crates/tiler/src/genus.rs`), not the cover field. Its area on land is ~a fifth of the city (the
published all-canopy figure is ~22%), recorded in the manifest as `field.canopy.squareKm`.

`tiler canopy` renders it into the cover **fill pyramid**, `public/tiles/canopy/{z}/{x}/{y}.webp`,
over the z9–z15 plan and coloured by the **same ramp LUT** — canopy is a covered fraction in
[0, 1), the very quantity the ramp is defined over. A coarse grid over the ~1.08 M polygons
(CSR-style, like the tree index) hands each tile only the polygons it touches; each pixel's canopy
fraction is a 4× supersampled even-odd polygon fill averaged back down (so multipolygon holes
punch through and edges antialias), clipped to the land mask so nothing bleeds over water. A tile
with no canopy is the shared blank WebP. The client draws it with `components/canopy-layer.tsx`, a
bare `TileLayer` with no street-line companion — canopy is areal, not per-street.
`build-street-tiles.ts` runs it after the `chunks` pass; the pyramid is gitignored build output
like the rest of `public/tiles/`, rebuilt by `bun dev`/`bun export`.

**License:** NYC-public (NYC OTI / NYC Parks, 2017 LiDAR) — no ODbL entanglement, unlike the OSM
sources. Attribution: "Tree canopy © NYC OTI / NYC Parks (2017 LiDAR)". The authoritative 6-inch
land-cover raster (`he6d-2qns`, 1.33 GB, class 1 = Tree Canopy) is the documented fallback if the
polygon service disappears; it needs a GeoTIFF crate, so the std-only polygon service is preferred.

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
Bridge". `tiler densities` fills their density blob from the same canopy field the streets use: a
path is its own walking surface, so it is sampled once on its line and that one value stands for
both sides.

The paths carry honest cover and are conflated into the network: `tiler graph --paths` reads them
into the GRPH routing graph and `tiler chunks --paths` appends their segments to the street chunks
the client draws, so a route can follow a greenway or step street rather than only the CSCL
centerlines.

Overpass — which fetches both the paths and the OSM trees — is the flakiest thing in the pipeline:
the query rotates over three mirrors, backs off in minutes rather than seconds, and must send a
`User-Agent` (an anonymous client gets a 429 on sight). Everything is cached, so this is a one-time
cost.

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

The pyramid is a few thousand webp tiles across z9–z15, rendered across the rayon pool a tile
at a time. Two rasterizers dominate, and both lean on a spatial index so a tile touches only the
sources that can reach it, and both send a tile with nothing in it straight to the one shared
blank webp:

- **The canopy fill (`tiler canopy`).** The ~1.08 M LiDAR polygons are far too many to test per
  tile, so a uniform grid over their bounding boxes (CSR-style) hands each tile only the few
  hundred whose box overlaps its haloed extent. Those are rasterized even-odd at **4× supersample**
  and averaged back down for edge anti-aliasing, then an **isotropic Gaussian** (σ_fill in pixel
  space, skipped below half a pixel, haloed by 3σ so tiles do not seam) grades the shade out past
  a crown before the land clip and the ramp.
- **The genus dots (`tiler genus`).** A uniform **60 m index over the trees**, flat arrays,
  CSR-style: a tile scans only the buckets a dot can reach, and a tile with no tree whose disc
  spills into it goes straight to the blank webp. Each tree is a single anti-aliased disc, so this
  pass is cheap next to the polygon fill.

`tiler densities` is the third heavy pass: it convolves the same canopy indicator at both
sidewalks of every street and path vertex, and draws a seeded million-point land sample for the
reported distribution (below). Each pass prints its own tile, painted-tile and byte counts as it
finishes.

## Committing the binaries: `sl` will silently corrupt them

`data/**/*.bin` are build *inputs*, tracked in **Git LFS** (see `.gitattributes`). They are
never shipped to the client — only the tiles and chunks rendered from them are.

> **`sl commit` does not run git-lfs clean filters.** It commits the raw multi-megabyte blob
> into the repo and says nothing.

Commit these files with git, and push the objects explicitly:

```sh
git commit -- data/trees/nyc.bin data/canopy/nyc.bin data/land/nyc.bin data/streets/nyc.bin data/paths/nyc.bin
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

### `data/trees/<id>.bin` — the points, their crowns and their genus, magic `TREE` (v3)

`count` (longitude, latitude) pairs, each a varint delta from the previous point — the first
from the origin. The points are **sorted by quantized (latitude, longitude)** before they are
written, so a delta carries a step along a row rather than a jump across the city.

Then two fixed-size trailing regions in that same sorted order, so byte *i* of each describes
point *i*:

- `count` **crown bytes** — the crown radius in **decimetres** (0–25.5 m; the allometry never
  approaches the ceiling), the size the genus overlay draws each tree's dot at.
- `count` **genus bytes** — the genus id 0–11: 0–10 index the manifest's `field.genus.table` (the
  11 most abundant genera, descending count), and 11 is "Other" (tail genera, unknown genus, and
  every OSM tree).

v1 was points only; v2 added the crown byte; v3 appends the genus byte.

The genus overlay renders this file two ways: `tiler genus` bakes a raster pyramid of
genus-coloured dots (`public/tiles/genus`, z9–14, the zoomed-out view), and the blob itself is
served at `public/trees/<id>.bin` so the client (`components/tree-dots-layer.tsx`) draws the dots
live as crisp canvas discs from z15 up, where an upscaled raster tile would blur.

### `data/land/<id>.bin` — the land mask, magic `LAND`

This is the canonical **polygon layout**, shared by every polygon source (`LAND`, `CNPY`) under its
own magic. After the 40-byte header, `count` polygons, each:

- `u16` ring count
- per ring: `u32` vertex count, then that many (longitude, latitude) varint-delta pairs, the
  first from the origin and the rest from the previous vertex

Filled even-odd, so a multipolygon's inner rings punch holes; the polygons are filled one at
a time, so two overlapping polygons do not cancel each other out. The land mask is needed at
ingest (the population the cover distribution is taken over) and at tile time (the clip that keeps
canopy from bleeding over water), so it is committed rather than fused into anything.

### `data/canopy/<id>.bin` — the measured LiDAR canopy, magic `CNPY` (v1)

The **`LAND` polygon layout** exactly — the same 40-byte header, then `count` even-odd polygons of
varint-delta rings — under its own magic so it self-identifies. It is NYC's 2017 LiDAR tree-canopy
footprint (~1.08 M polygons, land-clipped), the *measured* field the cover is blurred from. Read
with the generic `read_polygons(path, "CNPY", 1)`; `tiler densities` convolves and samples it to
fill the streets/paths density blobs, and `tiler canopy` rasterizes it into the fill pyramid.

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
ways' **uppercased** `name` tags, deduped and sorted, in PATH's own index space; `tiler graph`
concatenates them after the street names and offsets the path name-ids by the street name count.
This is a committed **ODbL** source: it is an extract of OSM geometry, so its share-alike terms
follow it (see `data/README.md`).

### `public/streets/{x}/{y}.bin` — the chunks (derived, gitignored)

The segments touching one z12 tile. A segment goes into every z12 tile its bounding box
touches; segments are short, so the few tiles it lands in beyond the ones it truly crosses
cost nothing and cannot leave a gap at a seam. Each chunk's origin is its own tile's
north-west corner, which keeps the first delta of every segment small.

When a city carries a PATH layer, `tiler chunks --paths …` appends the OSM path segments to the
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
walker actually uses. When `--paths` is supplied it first **conflates** the OSM pedestrian/park
network (`PATH`) into the CSCL edges (`conflate.rs`): the paths are deduped against CSCL, noded
among themselves, welded at at-grade crossings, their dangling entrances snapped to the nearest
street, and the CSCL splits applied — so a greenway or step street joins the routable network.
Conflated edges carry the OSM flag (byte-23 bit3), and the pass reports `osmPathEdges`,
`weldedVertices`, `entranceSnaps`, `osmTSplits`, `mergedNearNodes` and `droppedOsmIslands`.

Steps 1–7 are the v1 contraction: vehicular-only segments (`nonped='V'`, flag
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
| 23 | u8 | flags: bit0 structure, bit1 steps, bit2 **geometry-right** (this sidewalk lies right of its stored geometry direction; clear = left), bit3 **OSM** (this edge came from the conflated OSM path network) |

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
hard-coded `CITY` constant plus four NYC-specific fetchers. A new city needs:

1. **A measured tree-canopy source** — polygons of the canopy footprint (NYC uses its 2017 LiDAR
   canopy). This *is* the cover field: without it `tiler densities` has nothing to convolve and the
   map has no cover at all.
2. **A tree inventory** — points, ideally with a standing/removed flag and a trunk diameter to
   size the crowns (without one, a city would need its own way to a crown radius). This feeds the
   **genus overlay**, not the cover. It is the part with no standard: every city publishes its own.
3. **A street centerline** — line geometry plus some road classification, so the non-walkable
   types can be dropped.
4. **A land mask** — a polygon to take the cover distribution over and to clip the canopy and OSM
   sources against (otherwise a bounding-box query pulls in the neighbouring state's canopy and
   paths).
5. Its expected row counts, which the Socrata reader uses as a floor to catch a page the
   server quietly cut short.

The **OSM sources already work anywhere** — Overpass is queried by bounding box, not by
city. The estimator, the encoders and the tiler are all city-agnostic; only
the source fetchers, the crown allometry and the `CITY` constant are not.
