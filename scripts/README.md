# The tree-cover pipeline

This is the reference: what each stage does and what every artifact contains. The reasoning behind
the design — the alternatives that were measured and rejected, and the traps — is in DESIGN.md.

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

**All of the model math lives in `crates/tiler`**, a Rust binary with eight subcommands. The
scripts fetch, encode and orchestrate; they compute nothing about trees.

| | |
| --- | --- |
| `scripts/` | Socrata paging, the Overpass mirror rotation, the disk cache, the `.bin` encoders, the manifest, and the colour ramp |
| `crates/tiler` | the canopy convolution and the cover it yields, the sidewalk offsets and their cover, the Monte-Carlo cover distribution, the per-polygon canopy heights, the genus-dot overlay, the tile pyramids, the WebPs, the street and caster chunks, and the routing graph |

```sh
tiler densities --params <file.json>                          # fills the street & path density blobs, in place
tiler heights --canopy <file.bin> --chm <file.tif>            # fills the canopy file's crown-height region, in place
tiler canopy --manifest … --ramp … --data … --tiles …         # the LiDAR-canopy cover fill pyramid
tiler genus  --manifest … --palette … --data … --tiles …      # the genus-dot raster pyramid
tiler shade  --manifest … --data … --tiles … --params …       # the building- and tree-shadow pyramids
tiler chunks --manifest … --data … --chunks … [--paths …]     # slices STRT (+PATH) into the client's street chunks
tiler caster-chunks --manifest … --data … --chunks … --params …  # slices BLDG+CNPY+TREE into the client's shadow-caster chunks
tiler graph  --streets <in.bin> --out <out.bin> [--paths …] [--ferries …] [--canopy …]  # contracts STRT (+PATH, +FERR) into the GRPH routing graph
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
  into each tree's crown byte, and the canopy's seasonal opacity stays in the client
  (`src/shade/phenology.ts`, applied when the shade overlay composites the two shadow pyramids), so
  the tiler does geometry, not botany.
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
| canopy heights | the 1 m LiDAR canopy height model of Ma et al. 2023, figshare doi `10.6084/m9.figshare.20522895` (`NY_CHM_10Int260m.tif`, CC BY 4.0) | a 243 MiB uint16 GeoTIFF of decimetres over UTM 18N, cached but never committed; `tiler heights` samples it per canopy polygon and writes the result *into* the `CNPY` file — see below |
| paths | OSM pedestrian/park ways (footway/path/pedestrian/steps/cycleway/bridleway/track) plus park drives (roads closed to through motor traffic), via Overpass | the park, greenway and car-free-drive network CSCL lacks; a separate committed source, magic `PATH` — see below and "Binary layouts" |
| ferries | the two NYC ferry GTFS feeds — Staten Island Ferry (NYC DOT) and NYC Ferry (Hornblower, via Connexionz) | consolidated to a time-independent ferry graph, a committed source, magic `FERR` — OSM- and canopy-independent, read by a later phase's routing graph, not the cover pipeline; see below and "Binary layouts" |
| landmarks | NYC LPC Individual Landmark Sites, Socrata `buis-pvji` | ~1.5k designated historic/touristy sites, taken at their WGS84 centroid; a committed POI source, magic `LMRK` — fanned out into a per-edge routing discount, not the cover pipeline; see "Binary layouts" |
| art | NYC PDC Outdoor Public Art Inventory (Socrata `2pg3-gcaa`) + OSM `tourism=artwork` via Overpass | public art and murals (OSM carries the murals the PDC set is thin on), deduped by proximity; a committed POI source, magic `ARTW` — its own routing discount, distinct scenery from landmarks; see "Binary layouts" |
| highways | OSM limited-access highways (`motorway`/`trunk` + ramps) and above-ground rail (surface, open cut, or elevated — anything not `tunnel`), via Overpass | the lines walking near is unpleasant, as polylines; a committed source, magic `HWAY` — proximity to it is a per-edge routing *penalty*; never itself routed; see "Binary layouts" |
| buildings | NYC Building Footprints, Socrata `5zhs-2jue` (`feature_code=2100` with a positive `height_roof`, feet→metres) | 867,920 footprints with their roof heights; a committed source, magic `BLDG` — the walls the **building-shade** factor raises to cast shadows, for both the shade overlay pyramid and the signed per-edge shade routing bake; see "Binary layouts" |
| landuse | NYC PLUTO, Socrata `64uk-42ks` (lots with `landuse` 1..5) | 788,591 tax lots, each with a land-use class byte; a committed source, magic `PLUT` — the commercial-vs-residential signal for the **commercial-area** overlay; see "Binary layouts" |
| dining | NYC Dining Out `fpeh-f7ci` + OSM `outdoor_seating` via Overpass | outdoor-dining points; a committed source, magic `DINE` — a "cute" signal for the commercial overlay |
| openstreets | NYC DOT Open Streets `uiay-nctu` (non-school), sampled every ~10 m | Open Streets corridor points; a committed source, magic `OSTR` — a "cute" signal for the commercial overlay |

The commercial overlay's per-segment signals are then precomputed at **build time** by `scripts/build-commercial.ts` (run after `tiler chunks`): it snaps `landuse`/`buildings`/`dining`/`openstreets` onto each street segment by *frontage* (perpendicular, projection in-span) and writes `public/commercial/{x}/{y}.bin` (magic `CMRC`, 3 bytes/segment: commercial fraction, median roof height, flags for open-street/seating), one file per `STCK` chunk, gitignored. The overlay reads those and applies the gate (>50% commercial AND low-rise AND (open-street OR seating)) client-side, so its thresholds stay tunable without a rebuild. The **same gate** also runs at build time to emit the qualifying blocks' centrelines as `public/commercial-lines/<id>.bin` (magic `CMLN`, the `HWAY` single-ring-polygon layout, gitignored), which `tiler graph --commercial` proximity-bakes into the per-edge commercial routing discount (GRPH byte 27).

Only walkable road types are kept. Highways, ramps, driveways, ferry routes, u-turns and
non-physical segments are not part of the network a person walks. Bridges and tunnels come in
only when they carry pedestrians (`rw_type` 3/4 with `nonped != 'V'`) — that is what restores the
East River crossings — and every kept row is flagged (record byte 23) so a router can drop the
vehicular-only streets the overlay still draws.

### The measured LiDAR canopy (`CNPY` v2)

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
polygon service disappears; the GeoTIFF crate it needs is now in the tree for the height model
below, so what keeps the polygon service preferred is only that it is the far smaller read.

#### How tall each polygon is

The polygons are a footprint — flat. Their **crown height** comes from a second, independent LiDAR
product: the 1 m canopy height model of Ma et al. 2023 (figshare doi `10.6084/m9.figshare.20522895`,
CC BY 4.0), a 47008 × 47697 uint16 GeoTIFF of **decimetres** over NAD83(2011) UTM 18N.
`scripts/chm.ts` downloads it once into `.cache/` (243 MiB, checksum-verified, never committed) and
`tiler heights` reads it off disk: it projects every polygon vertex into the raster's UTM grid with
Snyder's transverse Mercator series (a round trip measures 0.06 mm, and a ±4 m registration sweep
peaks at no offset), fills each polygon even-odd at cell centres, and stores the **75th percentile**
of the cells it caught, in decimetres, in the file's trailing height region. It rewrites the `.bin`
in place, exactly as `tiler densities` fills the density blobs, and the ingest calls it right after
writing the canopy file.

The CHM is a **thresholded crown-core product, not a canopy surface**: 95% of its cells are nodata
and its lowest real reading is 2.1 m, because everything shorter (and everything taller than 60 m,
to keep buildings out) was masked away. So a polygon can be real canopy and still catch no cell —
1.98% of them cover no cell centre at all, and the thin fringes of a crown are masked. Those keep a
height of **0, meaning unknown**, which no real reading can collide with given that 2.1 m floor; a
reader must treat 0 as "no measurement", not as "flat". For NYC 46.15% of polygons carry a measured
height; because the ones that miss are overwhelmingly the tiny ones, those 46% are **96.56% of the
canopy area**. Area-weighted, the measured height runs 11.2–19.4 m across the interquartile range
with a median of 15.2 m, and 21.8% of the canopy area stands above 20 m.

372 of the raster's 137,264 internal tiles carry an LZW stream that will not decode; they sit in the
last 32-pixel column, east of the city, and hold no polygon cell at all, so the pass reports the
count and carries on rather than failing the build.

#### What the heights are for: the tree-shadow pyramid, and routing

`tiler shade` reads them alongside the building footprints and bakes a **second shadow pyramid**,
`public/tiles/tree-shade/<bin>/{z}/{x}/{y}.webp`, mirroring the building one
(`public/tiles/shade/<bin>/{z}/{x}/{y}.webp`) tile for tile: the same bin indices off the same
`buckets.json`, the same z9–z15 plan, the same lossless WebP of one flat slate where only alpha
varies, the same `MAX_SHADE_ALPHA * intensity * fraction` scale and 8-step quantisation, and a tile
with nothing painted in it is not written at all — the client reads the 404 as transparent.

Two things differ from a building. A crown **floats in the air**, so its shadow is the polygon simply
TRANSLATED by `CROWN_BASE_FRACTION * height / tan(elevation)` (clipped to the same 500 m) — there is
no wall connecting it to the ground, so there is nothing to sweep, which is both cheaper and more
correct than the building's swept hull. The **0.4** is the crown BASE: the LiDAR outline is the
crown's widest cross-section, which on the half-ellipsoid and ovoid crowns urban broadleaves take
sits at or near the base, so casting from the polygon's own height would model the crown as a flat
sheet at the top of the tree and throw the shadow about a crown radius too far — far enough at a low
sun to detach it from its tree. It is an assumption anchored on crown ratio (0.39–0.60 for hardwoods,
Russell & Weiskittel 2011 Table 1), not a measured height to largest crown width; the published HLCW
work is all conifer. `src/tiles/sweep.ts` translates by the same fraction, or the client's swept
tiles and the baked pyramid would disagree at the handoff. And it is cast from the bin's **centre
sun-disk sample alone**: a 10 m crown's
penumbra is ~5 cm against a 3.6 m pixel at z15, so the other five samples would paint the same
picture at six times the cost. Building footprints are punched out of the tree shadow exactly as they
are out of their own — shade landing on a roof is not ground shade — but canopy footprints are **not**
punched out of theirs, because the ground under a tree is where you stand and the shadiest place
there is. A polygon carrying the 0 unknown-height sentinel casts nothing, which leaves 3.44% of the
canopy area throwing no shadow.

The pyramid is **pure geometry**: no leaf-on/leaf-off opacity is baked into it. How much light a crown
stops is seasonal, and only the client knows the date, so the shade overlay's tile worker fetches both
pyramids for a tile and composites them per pixel,
`alpha_b + tau*alpha_t - tau*alpha_b*alpha_t/(MAX_SHADE_ALPHA*intensity)` — which is
`MAX*intensity*(1 - (1 - b)(1 - tau*t))`, the light that gets past a building AND past a crown, in
baked-alpha terms — with tau from `src/shade/phenology.ts` (0.814 in leaf, 0.40 leaf-off, ramped
across April and across October–November). Drawing them as two stacked Leaflet layers would
source-over instead, which double-scales the cross term and comes out ~25% too dark where both fall.

The same crowns cast the same shadows across the **routing** edges, in the SHDB artifact below, and
the client composites them there with the same tau — so a shade-seeking route walks the tree line,
not just the north side of the street.

### The pedestrian and park paths (`PATH` v1)

CSCL is a *street* centerline: it carries almost none of the interior of a park. Central Park is
21 km of CSCL path against 89 km in OSM; Prospect Park is 1.3 km against 51 km — the router
cannot enter their interiors at all. So OSM's pedestrian and park ways are ingested as a second
committed network, `data/paths/nyc.bin`, magic `PATH`. Its byte layout is **STRT v5's exactly**,
so `binfmt.rs` reads it with the same code (`read_paths`) and `tiler densities` samples it with
the same loop; only a few record fields are reinterpreted (see "Binary layouts").

The Overpass filter is a union of two kinds of clause: the walking net, and park drives.

The **walking net** is the dedicated foot and park ways:

    way["highway"~"^(footway|path|pedestrian|steps|cycleway|bridleway|track)$"]
       ["footway"!~"^(sidewalk|crossing|traffic_island)$"]["access"!~"^(no|private)$"]
       ["area"!="yes"]["indoor"!="yes"]["foot"!~"^(no|private)$"]

`footway`/`path`/`pedestrian`/`steps` are the core; `cycleway` brings the greenways (a bike-only
segment carries `foot=no` and drops out); `bridleway` is the Central Park bridle path; `track` is
park maintenance road. Bridge and tunnel promenades already ride in here — the East River bridges'
paths are `footway`/`cycleway`, so Brooklyn/Manhattan/Williamsburg/Queensboro are captured (the
Verrazzano is not: every one of its ways is `highway=motorway`, `foot=no`, `bicycle=no` — there is
no shared-use path on it in OSM). **`footway=sidewalk`/`crossing`/`traffic_island` are excluded** —
GRPH already derives sidewalks and crossings from CSCL, and ingesting OSM's would double the
network; `area=yes` (plazas) is not an edge; `access`/`foot` `no`/`private` and `indoor=yes` are
not walkable.

**Park drives** are roads open on foot but closed to through motor traffic — Central Park's East /
West / Terrace Drives, Prospect Park's loop. The signal is `motor_vehicle`=`no`|`private` on an
ordinary road class (`unclassified`/`service`/`residential`/`tertiary`/`living_street`), minus
`service`=`driveway` and its kin (the private stubs). A merely-`private` road must also carry an
affirmative pedestrian signal — a `foot`=`yes`|`designated` grant, or a `name` — so gated driveways
lacking one stay out. This is why `highway=service` is not excluded wholesale: West Drive is a
`service` road. Whatever still leaks through and coincides with a real street is deduped against
CSCL by the graph conflation, so double-counting a named residential block is self-correcting.

The ways are land-clipped against the borough polygons — a
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

### The ferry network (`FERR` v2)

CSCL and OSM carry the *piers*, but not the crossings over the water between them, so a route can
walk to a terminal and no further. The two NYC ferry GTFS feeds fill that in as a third committed
network, `data/ferries/nyc.bin`, magic `FERR`. This is a data-ingest step only: it neither snaps
stops to the routing graph nor touches the tree-cover manifest — a later phase reads it into the
graph and prices the crossings.

The feeds (`scripts/gtfs.ts` downloads and parses them, `scripts/ferries.ts` consolidates and
encodes):

- **Staten Island Ferry**, NYC DOT — `https://www.nyc.gov/html/dot/downloads/misc/siferry-gtfs.zip`.
  Its Akamai edge 403s a non-browser client, so the fetch sends a browser `User-Agent`; its files
  are nested under a `siferry-gtfs_<version>/` folder, matched by basename.
- **NYC Ferry** (Hornblower), served through Connexionz —
  `https://nycferry.connexionz.net/rtt/public/utility/gtfs.aspx`.

`scripts/gtfs.ts` is dependency-light: it parses the zip's central directory by hand and inflates
each entry with `node:zlib`, and parses the CSV tables (RFC 4180 quoting, CRLF, a stripped BOM)
itself — no zip or csv package. Each download is disk-cached (base64, keyed on the URL) like every
other source read, and the ingest also **freezes the two raw feed zips** under `data/ferries/`
(`siferry-gtfs.zip`, `nycferry-gtfs.zip`, both LFS-tracked) so a future time-of-day pass can
re-derive from the exact feeds a build read.

**Time-independent consolidation.** The whole schedule collapses to one representative value per
segment:

- **Active services only.** A `service_id` counts if `calendar.txt`'s date range covers the build
  date *and* it runs at least one regular weekday — which drops an expired feed and the all-zero-mask
  services (SI Ferry's `holiday`/`threeboat`) that `calendar_dates.txt` only substitutes in on
  specific dates. `calendar_dates.txt` is read to confirm it adds no otherwise-inactive regular
  service (for both current feeds it does not); `frequencies.txt` is honoured if present, but SI
  Ferry's is empty and NYC Ferry ships none.
- **Ferries only.** Only `route_type` 4 (ferry) trips are kept; the NYC Ferry feed also carries its
  free shuttle-bus routes (`route_type` 3, the Rockaway East/West shuttles), whose street-corner
  stops are not crossings and are dropped. The **Rockaway** ferry terminal is also excluded for now
  — the peninsula is not connected to the routable walking network, so a ferry-only stub there would
  route nowhere; revisit once that connection is modelled.
- **Segments.** Every active trip is cut into consecutive-stop pairs (stop *i* → *i+1* by
  `stop_sequence`), keyed by the *unordered* pair (so both directions fold together). Stops from the
  two feeds are namespaced by feed, so the two St. George berths are **not** fused — that
  cross-feed conflation is the routing graph's job.
- **Route name.** Each segment records the display name of its **primary route** — the `route_id`
  serving the most of its trips (ties broken deterministically), read as `route_long_name` (else
  `route_short_name`). Both feeds put the real name in `route_long_name` ("Staten Island Ferry",
  "East River"; `route_short_name` is the bare code "AS"/"ER" or empty). A later phase labels a
  ferry maneuver with it ("Take the East River ferry to Wall St/Pier 11").
- **Crossing time** = the median over all trips of (arrival at the next stop − departure at this
  one).
- **Headway** = the median gap between successive departures serving the segment. Gaps are taken
  *within* one service and one direction (a weekday gap is never differenced against a weekend one),
  then pooled across both. A segment served only by single trips has no gap, so its wait falls to the
  cap.
- **`rawTimeSeconds = medianCrossing + min(headway/2, 600)`** — the crossing plus half a headway of
  expected wait, capped at ten minutes. This single combined value is the only time the artifact
  carries; a later phase's discount multiplies it whole.

**Geometry.** Each segment carries the ferry path polyline for drawing: the sub-path of the trip's
`shapes.txt` shape between the two stops. `shape_dist_traveled` is empty in both feeds, so each stop
is projected to its nearest shape vertex (forced monotonic along the trip) and the shape slice
between them is taken, capped by the two stop coordinates; a segment with no shape falls back to a
straight line (no stored geometry). Stops stay in geographic lng/lat with their GTFS name.

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
never expire on their own — including the 243 MiB canopy height raster, which is kept as a file
rather than as JSON because the tiler reads it off disk itself. The sources move about once a year, so a re-run wants whatever it
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
- **The shadows (`tiler shade`).** By far the longest pass, because it runs the whole plan once per
  sun-position bin (58 of them): the buildings' six sun-disk samples measure 17.5 s a bin over a
  3616-tile plan, and the crowns' single sample adds 6.2 s and ~0.5 GB of peak memory on top. The
  tree pyramid comes out at ~88% of the building pyramid's bytes and paints about the
  same fraction of the plan (43.7% against 42.5%), so it roughly doubles what the shade tiles cost
  the deploy.

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

The genus overlay renders this file two ways: `tiler genus` bakes raster pyramids of
genus-coloured dots (`public/tiles/genus`, z9–14, the zoomed-out view), and the blob itself is
served at `public/trees/<id>.bin` so the client (`components/tree-dots-layer.tsx`) draws the dots
live as crisp canvas discs from z15 up, where an upscaled raster tile would blur.

So the legend can toggle one genus at a time, the pyramid is split by genus: `public/tiles/genus/<id>`
(id 0–11) holds only that genus's trees on a transparent tile. The client stacks one layer per
enabled genus, so the standard all-genera view is all twelve stacked and toggling a genus adds or
removes a single layer; the live dots (`components/tree-dots-layer.tsx`) filter by the same selection.

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

### `data/canopy/<id>.bin` — the measured LiDAR canopy, magic `CNPY` (v2)

The **`LAND` polygon layout** — the same 40-byte header, then `count` even-odd polygons of
varint-delta rings — under its own magic so it self-identifies, followed by **one trailing region**
of a `u16` little-endian per polygon in the same polygon order: the **crown height in decimetres**,
as `BLDG` carries its roof heights. It is NYC's 2017 LiDAR tree-canopy footprint (~1.08 M polygons,
land-clipped), the *measured* field the cover is blurred from. `encodeCanopy` writes the region
zeroed and `tiler heights` fills it in place from the separate canopy height model (above); **0
means unknown**, not flat. Read the geometry alone with the generic `read_polygons(path, "CNPY", 2)`
— which is what `tiler densities` (convolving and sampling it into the streets/paths density blobs),
`tiler canopy` (rasterizing it into the fill pyramid) and `tiler graph` (integrating it *unblurred*
along each sidewalk into the direct-canopy edge byte) do — or with the heights through `read_canopy`.

### `data/landmarks/<id>.bin` and `data/art/<id>.bin` — the scenic POIs, magic `LMRK` / `ARTW` (v1)

The **point layout**: the 40-byte header, then `count` (longitude, latitude) varint-delta pairs,
sorted by quantized (latitude, longitude) so a delta steps along a row, then a **trailing name blob**
— per point, in that same sorted order, a `u16` UTF-8 byte length and its bytes (empty when the source
named none). Written by the shared `encodePoints` encoder. Two sources share it under their own magic:
`LMRK` (LPC landmarks, named by `lpc_name`) and `ARTW` (public art, named by the PDC `title` or the OSM
`name`). `tiler graph` snaps each point to the nearest walking node, fans a bounded shortest-path tree
out from it, and deposits a network-distance-decaying discount on the edges it reaches — so the router
mildly prefers routes that pass near them; it reads only `count` points from the header and **ignores
the name blob**, which is client-only (the map overlay draws the names as labels). The blobs are served
verbatim to `public/{landmarks,art}/<id>.bin` for the overlay.

**`data/dining/<id>.bin` (`DINE`)** and **`data/openstreets/<id>.bin` (`OSTR`)** use the same point
layout (name blob empty), for the commercial overlay's "cute" signals. **`data/landuse/<id>.bin`
(`PLUT`)** is the point layout with a **trailing class byte per point** (the land-use digit 1..5) in
place of the name blob, via `encodeClassifiedPoints` — mirroring how `TREE` appends parallel per-point
bytes. All three are consumed only at build time by `scripts/build-commercial.ts` (see "The sources").

### `data/highways/<id>.bin` — the nuisance lines, magic `HWAY` (v1)

The **`LAND` polygon layout** exactly, under its own magic: each highway or above-ground-rail polyline
is one **open ring of a single-ring polygon** record, so the shared `encodePolygons` encoder and
the generic polygon reader carry it with no new format. Unlike the walking network these are never
routed — a later phase rasterizes them into an areal proximity field and turns nearness into a
per-edge routing *penalty* (the mirror of the POI discount). Nuisance is areal, not path-bound, so
the geometry is raw (undensified); the field's kernel does the smoothing.

### `data/buildings/<id>.bin` — the footprints and their heights, magic `BLDG` (v1)

The **`LAND` polygon layout** (the same 40-byte header, then `count` even-odd polygons via the shared
`encodePolygons` body), followed by **two parallel trailing regions**, each one `u16` little-endian per
polygon in the same polygon order — mirroring how `TREE` appends its parallel crown/genus bytes. First
the **roof height** in **decimetres**; then the **base (ground) elevation** in decimetres, stored
biased by `+ELEVATION_BIAS_METERS` (100 m) so the shoreline's slightly-negative bases stay in the
unsigned range — recover it as `decimetres / 10 − 100`. A building whose footprint is a multi-part
MultiPolygon expands to several polygon records, each repeating that building's height and base, so both
regions stay parallel to the polygons. Written by `encodeBuildings`. `tiler shade` reads the heights
for the shadow pyramid and `tiler graph` for the per-edge shade bake (the `SHDB` artifact, not the
GRPH edge record); the base elevations are still unread — folding them in would make the casters
terrain-aware, and bare-earth self-shadowing (hills/parks with no buildings) would need the separate
1-ft LiDAR DEM.

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

### `data/ferries/<id>.bin` — the ferry network, magic `FERR` (v2)

The time-independent ferry graph consolidated from the two NYC ferry GTFS feeds (above). Little-
endian; coordinates quantized to `COORD_SCALE` (1e-6°) about the south-west origin, exactly the
shared codec. Read by a later phase's routing graph; it carries no density blob (the ferry cost is
`rawTimeSeconds`, not canopy) and does not enter the manifest.

Header, 56 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `FERR` |
| 4 | u16 | format version = 2 |
| 6 | u16 | header bytes = 56 |
| 8 | u32 | stop count S |
| 12 | u32 | segment count E |
| 16 | f64 | origin longitude, degrees |
| 24 | f64 | origin latitude, degrees |
| 32 | f64 | coordinate scale, degrees per quantized unit |
| 40 | u32 | geometry blob offset, from the start of the file |
| 44 | u32 | geometry blob length |
| 48 | u32 | name blob offset, from the start of the file |
| 52 | u32 | name blob length |

Then the sections, back to back. The **stop table** (S × 12 bytes) and the **segment table**
(E × 20 bytes) follow the header directly, so their offsets are implicit (`56` and `56 + 12·S`); the
geometry and name blobs carry explicit offsets because they are variable-length.

Stop record, 12 bytes — a stop in geographic coordinates, unsnapped:

| offset | type | field |
| --- | --- | --- |
| 0 | i32 | longitude, quantized |
| 4 | i32 | latitude, quantized |
| 8 | u32 | stop name id, an index into the name blob |

Segment record, 20 bytes — one unordered stop pair:

| offset | type | field |
| --- | --- | --- |
| 0 | u32 | stop A index (the lexicographically smaller stop key) |
| 4 | u32 | stop B index |
| 8 | f32 | `rawTimeSeconds` — median crossing + `min(headway/2, 600)` |
| 12 | u32 | geometry offset within the geometry blob; **0xFFFFFFFF = no geometry** (straight A→B) |
| 16 | u16 | geometry vertex count (0 when straight) |
| 18 | u16 | primary route's name id, an index into the name blob (`0xFFFF` = no route name) |

Then the **geometry blob**: per segment that has a polyline, `vertex count` (longitude, latitude)
zigzag-LEB128 varint delta pairs oriented A→B. The **first pair is the absolute quantized position**
(delta from the origin); the rest are from the previous vertex — the GRPH geometry convention. The
first and last vertices are the two stops' own coordinates. The blob is zero-padded to a 4-byte
boundary so the name blob starts aligned.

Finally the **name blob**: a `u32` count of distinct names, then each name as a `u16` byte length
and that many UTF-8 bytes, back to back — the GRPH/STRT trailing-name-blob layout. It holds the GTFS
`stop_name`s **and** the route display names together, deduped and sorted; a stop record's name id
and a segment's routeNameId both index it.

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

### `public/casters/{x}/{y}.bin` — the shadow casters, magic `CSTR` (v2, derived, gitignored)

The footprints, crowns and trunks that touch one **z15** tile, so the client can generate their
shadows itself past where the baked pyramid stops — the pyramid's z15 level alone is two thirds of
its bytes, and geometry the client sweeps costs a fraction of that. `tiler caster-chunks` writes them
from the same `data/buildings/<id>.bin` and `data/canopy/<id>.bin` that `tiler shade` rasterizes,
dropping exactly what that drops: a footprint with no roof height, and a crown carrying the canopy
file's **0 unknown-height sentinel** (496,604 of 1,076,146 crowns survive), plus the census trunks of
`data/trees/<id>.bin`. A city with only some of the three sources chunks the ones it has.
`src/tiles/casters.ts` decodes and caches them and `src/tiles/sweep.ts` sweeps them; the shade layer
reads the pyramid below z15 and the sweep at and above it.

A caster goes into every z15 tile it reaches, so it lands where it **stands**, not where its shadow
falls. A shadow reaches up to `maxShadowMeters` (500 m, ~0.54 of a 927 m chunk) into a view from
outside it, so the client gathers a halo of chunks around its viewport; `manifest.json` carries that
radius, the chunk zoom, the coordinate scale and the list of chunks that exist — the last so a
halo's worth of empty tiles is not a stampede of 404s.

**A caster is clipped to the chunk it ships in**, to the tile's exact rectangle, so a canopy blob
spanning fifty tiles costs its own area once instead of fifty whole copies — one 100,431-vertex
crown alone spans 48 chunks, and shipping it whole into each cost 9.2 MiB of the artifact against
the 197 KiB its pieces cost. That is lossless for both things the client does with a caster: a
Minkowski sweep distributes over a union, so sweeping the pieces and unioning is the shadow of the
whole, and the pieces union back to the whole footprint for the base punch-out. The clip is
Weiler-Atherton rather than Sutherland-Hodgman, which would join a ring that leaves the chunk and
comes back with a zero-area bridge along the seam — invisible to a fill, but the sweep would drag
it into a shadow that is not there. Winding is preserved through the clip, and a caster that never
leaves its chunk is passed through untouched, so the common case is byte-for-byte what it was.

Header, 44 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `CSTR` |
| 4 | u16 | format version |
| 6 | u16 | header bytes |
| 8 | u32 | building record count |
| 12 | u32 | crown record count |
| 16 | f64 | origin longitude, degrees (the tile's north-west corner, and the chunk's own west clip edge) |
| 24 | f64 | origin latitude, degrees (also its north clip edge) |
| 32 | f64 | coordinate scale, degrees per quantized unit (1e-6, ~0.1 m — the grid both sources are stored on) |
| 40 | u32 | trunk count |

Then the `building record count` buildings, then the `crown record count` crowns, back to back, each:

- `varint` height, **decimetres** — a roof height or a measured crown height
- `varint` ring count, the outer ring first
- per ring, a `varint` vertex count and that many (longitude, latitude) pairs as zigzag LEB128
  varint deltas. The delta chain runs on **across a record's rings**, so an inner ring starts from
  the outer ring's last vertex rather than from the chunk origin again.

Then the `trunk count` trunks, each four varints — a zigzag (longitude, latitude) step from the
previous trunk on the same quantized grid, a **radius in centimetres** and a **height in
decimetres**. Their delta chain is its own, starting at the chunk origin, and runs in the chunk's
row-major order rather than the city's, which is what keeps the steps short; a trunk is a point, so
nothing here is clipped and there is no ring count to carry. That is 5.0 bytes a trunk.

A record is one clipped **piece**, not one caster: clipping a ring to the chunk can leave several
disjoint pieces (a U reaching in, out and in again), which one record's ring list — an outer ring
and its holes — cannot express, so each piece ships as its own record at the same height. The
client already unions the shadows and the bases of two overlapping casters, and the pieces union to
the whole, so nothing has to know they were once one polygon. NYC ships 1.42 M records for 1.36 M
casters. The one shape with nowhere to put a hole is a footprint that both splits and has inner
rings, since nothing in the format says which piece a hole belongs to; it ships whole into that
chunk, as everything did before, which is still exact because the pieces it duplicates are subsets
of it. That happens 37 times in the city.

Which section a record came from is what it casts by, exactly as in `tiler shade`: a footprint is
**swept** (its ring together with its translate, since a wall joins the roof to the ground) and a
crown is only **translated**, floating free of the ground. A **trunk** is swept like a footprint, and
swept **opaquely, with the buildings rather than with the crowns**: the crown layer is thinned by the
season's tau (`src/shade/phenology.ts`), where wood blocks the sun in February as well as in July.
Its swept circle is a capsule, drawn as the quad without the two round caps — the median trunk is
0.34 m across against a 0.91 m z17 pixel, so the caps are a hundredth of a pixel — and the quad is
floored at one device pixel of width, since a sliver thinner than the sample grid dashes or drops out
of the rasterizer instead of reading as the faint line it is.

A trunk's **diameter** is the dbh its crown was grown from, recovered by inverting the
`CROWN_ALLOMETRY` of `scripts/build-tree-data.ts` (`dbh_cm = exp(exp((ln(2r) + 0.742) / 2.414)) - 1`,
exact, since the crown byte is a monotone function of dbh alone) and clamped to the same 1..60 inch
range the forward pass clamps to — which is also what stops an OSM tree, whose crown byte came from a
*recorded* crown diameter and never from a dbh, from inverting into a metre-thick trunk. A tree whose
dbh was missing carries the imputed median (crown byte 39, 7.07% of the city), so its trunk is the
median trunk.

A trunk's **height is the crown base of the canopy polygon it stands under**, `CROWN_BASE_FRACTION`
(0.4) of that polygon's measured height — the very height the crown's own shadow is cast from, so the
trunk's shadow runs from the tree to the crown shadow with nothing between. It is found by a
point-in-polygon join against the crowns bucketed into the trunk's own z15 tile. A census tree under
no measured crown is **dropped**: with no crown shadow overhead there is nothing to join, and the
sliver would be shade the model never casts. NYC ships **582,719 of 925,338** census trees (63.0%),
at a median 0.17 m of radius and 4.8 m of height.

A footprint also ships its **inner rings**, because the display path punches a building's base back
out of the shade and without them a courtyard would punch as though it were roof; they cost 21k
vertices across the city. A crown ships its outer ring alone — it is never punched, `tiler shade`
translates its outer ring alone, and the canopy's inner rings are a staircase of LiDAR gaps that
would be a quarter of everything here. Trunks exist only where the **census** does, and the baked
pyramid below z15 has none at all, so they appear at the z15 handoff — where a trunk is a tenth of a
pixel wide and the two halves still agree to within 0.3/255 of mean alpha.

**A crown's outline is simplified before it ships, by Douglas-Peucker at 0.6 m; a footprint's is
not.** The canopy is traced from a 1-foot LiDAR raster, so a crown's ring is a staircase of ~0.3 m
steps, and those rings were 25.6 M of the 34.2 M vertices shipped. Nothing this feeds can resolve
them: the vector path stops at **z17**, where a pixel is 0.91 m. The tolerance is measured in
**metres**, on a local projection — a degree is 24 % looser east-west than north-south at this
latitude — and it is a true bound, distance to the segment rather than to its infinite line, so the
outline moves by at most 0.6 m, **two thirds of a z17 pixel** (the worst deviation anywhere in the
city measures 0.5999999 m; the codec's own quantization already costs 0.05 m). Sweeping the
tolerance over the city removes 5.7 % of the crown vertices at 0.30 m, 34 % at 0.45 m, **52 % at
0.60 m** and 70 % at 1.00 m: the cliff between 0.30 and 0.45 is the staircase's own step going all
at once, and past 0.60 m the return flattens while the error crosses a whole pixel (1.00 m is also
where four rings first simplify into self-intersection). Footprints are left alone — they average
9.6 vertices, so there is nothing to win, and they carry the base punch-out, which must stay exact.

This is a **display-only** simplification: `data/canopy/<id>.bin` is untouched, and the routing
field and the baked pyramid go on reading the exact rings. It runs **before the bucketing and the
clip**, on whole polygons, because two chunks that simplified their own side of a shared seam
afterwards could leave a gap or an overlap along it; simplifying first leaves every seam decided by
the exact tile rectangle, exactly as the clip alone decided it before.

NYC comes out at **1121 chunks, 53.4 MiB (46.0 MiB gzipped)**, a chunk running 52 KiB raw /
44 KiB gzipped at the median and 92 / 79 KiB at the p95, of which the trunks are 2.8 MiB raw
(2.5 gzipped) — **+5.5 % on the artifact**. The simplification runs in the same time as unsimplified
— the recursion costs about what the vertices it drops cost to encode. 34.0 M source vertices ship as
21.0 M, of which 12.5 M are crowns. The clip is what took the 34.2 M unsimplified from 47.1 M
copies, the 0.5 % over the source being the seam vertices it adds where a caster crosses.

Where that lands: a screenful of z15 tiles costs ~19 ms a tile over midtown and **65 ms over
Prospect Park**, down from 73, and a Prospect Park viewport with its halo fetches 3.35 MiB against
4.75. Deeper in it is a fraction of that (~5-6 ms at z17), because a tile that small is reached by
few casters. See `src/tiles/sweep.ts`. **The level of detail used to be deliberately the client's**
— it is the half that knows its zoom and its frame budget, and detail dropped in the bake cannot be
recovered there — but the staircase is not detail at any zoom the client can ask for, so what that
bought was a payload and a path-building cost no viewport could ever use. LOD past this is still
the client's to take.

### `public/routing/{id}.bin` — the routing graph, magic `GRPH` (v6, derived, gitignored)

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

Before that, a backstop leaves **one crossing per pair of nodes** whoever drew them
(`collapsedCrossings`): a mapped crossing beats a synthesized one, and between two of the same
provenance the shorter wins. Parallel edges are never the only path between their own two ends, so
collapsing them cannot disconnect anything. A final mop-up adds a crossing at any isolated deg-2
ring whose two sidewalk sides would otherwise be separate components (`mopupCrossings`), and the
build asserts the walking component count equals the v1 count. Once every pass that places an edge
has run, a second backstop drops each edge that runs from a node back to itself (`selfLoopEdges`) —
a way the 1 m node merge folded into one node, an end an entrance snap bound to the node the other
end already sat on, or a closed way OSM drew — and compacts the geometry the dropped edges owned.
Taking such an edge pays its length and returns the walker to where they started, so no search can
use it and dropping it cannot disconnect anything either. Nodes are sorted by (component, latitude,
longitude) and renumbered, edges by (component, min node id).

When `--ferries` is supplied (`data/ferries/<id>.bin`, magic `FERR`, referenced by convention — not
the manifest), a final stage adds the ferry network **after** that walking assertion and renumber,
so neither is disturbed. Each FERR terminal snaps to the nearest walking node within 250 m (a linear
scan; a stop with none in range drops its segments, `ferryStopsUnsnapped`); a segment whose two stops
snap to one node is dropped, and segments snapping to the same unordered node pair are deduped to the
smaller raw time. Each survivor becomes a **ferry edge** (`ferryEdges`) whose geometry, when the FERR
leg carries a shape, runs node-a → the shape's interior vertices → node-b (a straight leg carries no
geometry). The edge's name is its FERR primary-route name, and its two terminal stop names are
recorded in the byte-60 endpoint side table (below). Connectivity is then recomputed over **walking ∪ ferry** edges and the component labels
(and count) overwritten with that merge, so Staten Island and Governors Island join the main
component. Components are labelled by size descending (0 = largest). Every edge length is at least its
straight-line node distance (clamped up if not; `lengthClamped`). Everything little-endian.

Header, 64 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `GRPH` |
| 4 | u16 | format version = 6 |
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
| 60 | u32 | ferry endpoint-stop-name side-table offset, from the start of the file (0-length table when the build carried no ferries) |

Then the sections, back to back, each starting 4-byte aligned (zero-padded as needed so the client
can view them as typed arrays without copying):

1. **Node longitudes**: N × i32, quantized.
2. **Node latitudes**: N × i32, quantized.
3. **Node components**: N × u16 (+2 pad bytes when N is odd).
4. **CSR offsets**: (N+1) × u32 — node n owns half-edges `[csr[n], csr[n+1])`.
5. **Adjacency**: 2E × u32 — each entry an **edge id** (the neighbour is the edge's other
   endpoint, one indirection).
6. **Edge records**: E × 34 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u32 | node a |
| 4 | u32 | node b |
| 8 | f32 | length, metres (≥ the straight-line node distance) |
| 12 | u32 | geometry offset within the blob; **0xFFFFFFFF = no geometry** (straight a→b) |
| 16 | u16 | geometry vertex count (0 when no geometry) |
| 18 | u16 | street name id into the name table (0xFFFF = unnamed) |
| 20 | u8 | cover, 0–254, this edge's own single value (**ferry**: low byte of the u16 duration at 20–21) |
| 21 | u8 | half-offset to the sidewalk, decimetres (sidewalk kind only; else 0) (**ferry**: high byte of the duration) |
| 22 | u8 | kind and side: bits 0–2 kind (0 sidewalk, 1 crossing, 2 link, 3 path, 4 ferry); bits 3–5 side (0 none, 1 N, 2 E, 3 S, 4 W) |
| 23 | u8 | flags: bit0 structure, bit1 steps, bit2 **geometry-right** (this sidewalk lies right of its stored geometry direction; clear = left), bit3 **OSM** (this edge came from the conflated OSM path network) |
| 24 | u8 | landmark amenity, 0–254 (a discount attribute; 0 for a ferry) |
| 25 | u8 | public-art amenity, 0–254 (a discount attribute; 0 for a ferry) |
| 26 | u8 | highway/rail nuisance, 0–254 (a penalty attribute; 0 for a ferry) |
| 27 | u8 | commercial frontage, 0–254 (a discount attribute; 0 for a ferry) |
| 28 | u8 | direct canopy, 0–254 (the shelter factor's input; 0 for a ferry) |
| 29 | u32 | **source id**: the CSCL physicalid, or the OSM way id for a conflated path; `0xFFFFFFFF` = no durable identity |
| 33 | u8 | **ordinal**: how many earlier edges share this edge's (source id, side) pair; 0 where there is no source id |

The record is 34 bytes, so the name table that follows it is zero-padded back to the 4-byte
boundary every section starts on.

Bytes 29–33 carry the **durable edge key** (v6). Node and edge ids are positional — nodes are
renumbered by (component, latitude, longitude) and edges by (component, min node id) — so every id
in the file shifts when the graph is rebuilt, and nothing outside it can name an edge across two
builds. `(source id, side, ordinal)` can: the source id is the id of the CSCL row or OSM way the
edge's geometry came from, the side is the label already in byte 22, and the ordinal disambiguates
within that pair. A sidewalk takes the source id of the contracted street it was offset from and its
own N/E/S/W label; a path edge (CSCL-derived or OSM-conflated) takes its contracted edge's source id
with side `none`. Degree-2 contraction merges several source records into one edge, and the key
keeps the **minimum** source id over the merged set, so a chain traced from either end names the
same record. Ordinals are assigned over the final edge order, which makes the triple unique by
construction (that also disposes of a small OSM way id colliding with a CSCL physicalid). It is a
key, not a hash — a rebuilt graph that still contains the same stretch of pavement gives it the same
triple, and one that split or merged the stretch does not pretend otherwise.

**Crossings, links and ferry edges carry `0xFFFFFFFF` and ordinal 0.** They are derived topology,
not source geometry: a crossing exists because two sidewalks meet, a link because a path reaches a
corner, and a ferry leg comes from `FERR`, which carries no CSCL id at all. Over NYC 299,623 of the
531,520 edges (56.4%) carry a durable id — every sidewalk and every path edge. 79.6% of those are
ordinal 0, 9.7% ordinal 1, 4.1% ordinal 2 and 6.5% higher; the maximum is **102**, an OSM greenway
welded to every street it crosses (the busiest sidewalk key reaches only 25, since only a street's
two sides share a source id). The ordinal therefore needs a whole byte, and `tiler graph` fails
rather than truncating if one ever passes 255.

Bytes 24–27 are the **scenic-factor attributes** baked by `scenic.rs` (v5). The landmark and art
bytes are a network **discount**: each POI (`LMRK`/`ARTW`) snaps to the nearest walking node and a
bounded Dijkstra fan-out deposits a distance-decaying contribution on the edges it reaches, summed
across POIs and saturated `1 − e^{−k·field}` (so a dense cluster stops stacking); the kernel is
per-mood (landmarks wide, art tight). The highway byte is an areal **penalty**: a Gaussian of the
edge's metre distance to the nearest highway or above-ground-rail line (`HWAY`). The commercial byte
is the same proximity Gaussian over the qualifying commercial-block lines (`CMLN`, derived by
`build-commercial.ts`), read instead as a **discount** with a tight σ so the reward lands on the
block's own street and sidewalks. All four quantize to a 0–254 ceiling so the client's
`maxLandmark`/`maxArt`/`maxCommercial` stay `< 1` (the cost model's admissibility invariant, as
`maxCover` already relies on); a later phase reads the discounts as `1 − w·attr` and the penalty as
`1 + w·attr`. A ferry carries none.

Byte 28 is the **direct canopy** (v6, `direct_canopy.rs`, baked when `--canopy` is given): the
fraction of the edge's own baked polyline that lies **directly under a `CNPY` polygon**, on the same
0–254 ceiling and read the same `1 − w·attr` way — the canopy half of the shelter factor. It is
*not* a second cover byte. Cover (byte 20) is the deliberately **smoothed** field the overlay is
coloured from — the oriented anisotropic Gaussian, σ 15 m along the road and 4 m across, reaching
±37.5 m — which answers "is this a leafy stretch"; a walker under the rain is asking "is there
anything over my head *here*", and a kernel reaching most of the block cannot say. So this is the raw
0/1 canopy indicator integrated along the edge by arc length with **no kernel and no blur**: a sample
every metre, midpoints of equal sub-lengths, each tested even-odd against the polygons the existing
canopy grid index hands the edge. It samples the **sidewalk** geometry, not the centreline, so the
two sides of a one-sided street differ: Central Park West reads 203 on its park side against 53 on
its building side, where the blurred cover only manages 138 against 97.

The two bytes come out related but far apart — over NYC they correlate **0.71**. The direct byte
averages 0.222 over the edges against cover's 0.257 (0.291 against 0.262 weighted by edge length),
and **47.3% of edges have nothing overhead at all** where only 4.9% read zero cover: a sidewalk in
the gap between two crowns is 0 here and still green there. Its length-weighted 0.291 sits above the
city's ~22% canopy over land, as it should — street trees are planted in the sidewalk, and the
walking network runs through the parks. The pass costs ~48 s and ~1.8 GB over NYC's 1.08 M polygons
and 531,520 edges.

A **ferry edge** (kind 4) has no tree cover and no sidewalk half-offset, so bytes 20–21 instead carry
a little-endian **u16 of crossing-plus-wait seconds** (`rawTimeSeconds`, ≤ ~2200). Its **name id**
(byte 18) is its FERR primary-route display name, so `edgeName` labels the maneuver ("East River"),
and its two terminal stop names ride in the byte-60 side table below. The client zeroes its cover (so
it never lifts `maxCover`) and derives `minFerrySecPerMetre` (min over ferry edges of duration ÷
length) at decode; its terminals are ordinary walking nodes, and the merged component labels let a
route cross it.

9. **Ferry endpoint-stop-name side table** (at the byte-60 offset, 4-aligned after the geometry
   blob): `u32 count`, then per ferry edge a (`u32 edge id`, `u16 a-stop name id`, `u16 b-stop name
   id`) triple, both ids into the name table (7). The two ids are the terminal names at the edge's
   node-a and node-b ends, aligned to its `node a`/`node b`. These ids are **not** edge name_ids, so
   `tiler graph` adds them to the kept-name set and remaps them alongside the edge names. A later
   phase reads the destination terminal from here (`node b` when the ferry is ridden a → b).

7. **Name table**: `u32 count`, then (count+1) × u32 byte offsets into the following UTF-8 blob,
   then the blob. Only the names the kept edges reference, re-indexed; offsets make client access
   O(1).
8. **Geometry blob**: one entry per sidewalk edge (its own baked corner-to-corner offset), per path
   edge, and per shape-carrying ferry edge — `vertex count` (longitude, latitude) zigzag-LEB128
   varint delta pairs. The **first pair is the absolute quantized position** (delta from the graph
   origin); the rest are from the previous vertex. Crossings, links, and straight ferry edges carry
   none.

A pure degree-2 cycle is emitted as a self-loop on the one node it retains. GRPH edge flags are
distinct from the STRT record flags: a step street is bit1, and bit2 on a **sidewalk** marks the
geometry-right side (v1's "path-like" bit is gone — the kind field carries that now).

### `public/routing/version.json` — what the deployed graph is (derived, gitignored)

Written by the same `tiler graph` invocation, beside the `.bin` it just produced, so a job holding
nothing but the live site can tell whether the graph it last snapped against is still the one being
served:

```json
{"graph":"nyc.bin","hash":"08da264f5836fa95","edges":531520,"bytes":27423072,"generatedUnixSeconds":1785384926}
```

`hash` is FNV-1a 64 over the GRPH file's own bytes, hex — it detects a rebuild, it does not defend
against one, so a hand-rolled hash beats a crypto dependency here.

It is only worth reading because the bake is **reproducible**: identical inputs give identical bytes.
Two places had to be pinned for that. The link edges and the deduped ferry edges are emitted in key
order rather than in their hash map's per-process iteration order — the edge sort breaks ties only on
the smaller node id, so without it a hundred-odd edge ids shuffled between two runs over the same
files, and the SHDE rows, which are keyed by edge index, shuffled with them.

### `public/routing/shade/` — the per-edge occlusion fractions, magic `SHDB` (v2, derived, gitignored)

The same `tiler graph` invocation, given `--buildings` and `--shade-params` (the sun-position file
`tiler shade` reads) and `--shade-dir`, bakes for every GRPH edge and every sun-position bin how much
of that edge's polyline a **building** shadow covers and how much a **crown** shadow covers — the
same shadow geometry the two tile pyramids cast, from the bin's centre sun-disk sample alone (so an
edge is cleanly in or out), probed every 5 m along the edge against a 5 m rasterized coverage grid of
the bin's ~867k hulls. `--canopy` supplies the crowns; without it, or where a crown carries the 0
unknown-height sentinel, the tree fractions are simply 0 and the router costs buildings alone.

The bins run in parallel, one grid alive per thread. NYC's 58 bins over 531,520 edges take ~48 s from
the buildings alone and ~105 s with the crowns as well, and the artifact is 59 MB either way — twice
what the single signed row cost, since the tree row ships whether or not a crown covers anything.

`bins.json` holds `edgeCount` and the bins — `index`, `season`, `hourAngle`, `elevation`, `azimuth`,
the same (declination, hourAngle) keys `buckets.json` carries, so the router lands on the bin the
overlay draws. `<index>.bin` is a 12-byte header (magic `SHDB`, u16 version = 2, u16 pad, u32
`edgeCount`) then **two** `edgeCount`-byte rows, buildings then trees, each `fraction = byte / 255`.

Neither the sun's strength nor the season is baked, because neither survives being folded in. The
client derives the bin's intensity from its elevation (`max(0, sin(elevation))`, what the bake itself
uses) and composites the rows into one signed i8 row per bin — once, on first use, cached, since A*
reads an edge's attribute in its innermost loop — with the same tau the overlay composites its
pyramids with:

    shaded = 1 - (1 - buildings) * (1 - tau * trees)
    attr   = intensity * (1 - 2 * shaded)   as round(attr * 128) clamped to +-127

An edge reads positive when net sunlit and negative when net shaded; the clamp is what keeps
`|attr| <= 127/128 < 1`, and with it the cost model's `1 - w*attr` positive for `|w| <= 1`. A ferry
edge has no polyline and reads 0 in both rows — its cost never consults the attribute.

### `public/sheds/` — the sidewalk-shed history, magic `SHED` (v2, derived, **committed**)

Every scaffolding permit New York has issued since **2017-12-28**, placed on the GRPH edges it stands
over. Not baked by `tiler`: `bun run build-sheds` (`scripts/build-sheds.ts`) does the whole pipeline
and writes these three files; `bun run update-sheds` keeps them current without ever running it
again. It reads `public/routing/nyc.bin`, so it runs **after** `bun run build-tiles` — which bakes
that graph and clears `public/routing` on its way, and never touches this directory. All dates are
**day numbers from 2017-12-28**, which a u16 holds until 2197.

Derived but committed, which nothing else under `public/` is: this is the one artifact rebuilt by a
daily job rather than by a deploy, so it has to survive a checkout that has run no build. The client
does not read it out of the deploy — it fetches these three files off `main` through
raw.githubusercontent.com, so what it draws is as fresh as the job rather than as the last deploy.
**Nothing shed-related is in Git LFS and none of it may ever be** — LFS is the one store that keeps
each rewrite whole, and a megabyte a day really would cost ~400 MB a year there (DESIGN.md). Packed
git deltas it to 1.7-22 KB a day.

Three sources feed it. What stood when comes from the DOB's own daily CSV snapshots, which survive
only as the git history of `NYCDOB/ActiveShedPermits` — `scripts/shed-permits.ts` walks every commit,
turns a permit's appearances and disappearances into presence intervals (runs less than a fortnight
apart are one shed, and a snapshot far below its neighbours' row count is a truncated write, not a
day the city took every shed down), and recovers the Block/Lot the permit claimed. Where it stood
comes from the DOF digital tax map and the building footprints (`scripts/shed-parcels.ts`): a shed
runs along the property line, so the **tax lot** is the geometry, and the footprint only picks which
part of a multi-part lot is in use and anchors a permit shorter than its frontage. `scripts/
shed-map.ts` puts the two together — the stretch of lot boundary facing a sidewalk that carries the
permit's street name is the measured frontage, and a permit longer than that runs on around the
corner as a bounded walk over the sidewalk network. What a permit resolves to there depends on that
permit alone and never on the company it was fetched in: the parts of a multi-part lot are sorted
before they are unioned, because Socrata's row order shifts with the batch, and the lot a permit's BIN
*reports* — the fallback when the tax map has no polygon for the permit's own BBL — is run through the
same condominium resolution as the permits' own lots, because otherwise it found geometry only when
some unrelated permit happened to name the same BBL. Each placement carries a confidence, the product
of six ways it can be wrong; `scripts/shed-streets.ts` is the DOB-to-CSCL street-name comparison the
first of those factors reads.

Almost every query is "what is up today", so the records are split by whether they still are.
`open.bin` (138 KB) holds the sheds still standing and answers that query on its own; `closed.bin`
(961 KB) holds the ones that have come down, **sorted by the day they did**, so a query for a past day
seeks into it with `index.bin` and decodes only the suffix that could still have been standing. A
permit that came down and went back up is **two records with their own geometry** — its intervals
are disjoint, so no day sees it twice, and each is placed from the attributes the feed carried on the
day it ended rather than from the ones the feed carries now.

The split is not "in the newest snapshot" but "could still be extended". Runs less than a fortnight
apart are one shed, so an interval whose last sighting is within `MERGE_TOLERANCE_DAYS` of the newest
usable snapshot is **provisional**: a reappearance would lengthen it. Those go in `open.bin` with no
close day; everything else is final and goes in `closed.bin`. The feed drops and re-adds 40-70 permits
a day around a renewal, so about 400 of `open.bin`'s records are a shed the newest snapshot happens
not to carry. That is also what makes `closed.bin` **append-only**: nothing in it can ever change, so
the daily job appends the day's closures rather than revisiting the file. Nothing, including a
correction — the DOB goes on fixing a permit's geocode and length years after its shed came down, and
a record placed from the reading in force *now* would have to move with them.

**`open.bin` names its records**, in job-number order, and every permit gets a record even when the
placement could put it nowhere. The job numbers ride in its header, so which record is which permit is
something the artifact **states** rather than something the daily job has to re-derive; the feed's own
answer — the permits still provisional on the day the file reached, sorted the same way — is then a
check on it, and a disagreement stops the run. Sorting `open.bin` by day instead would have made its
first-day deltas monotone and saved a byte a record; the byte buys the job numbers a delta chain to
ride on. `closed.bin` is that same order stably re-sorted by close day, so records closing on one day
stay in job order, and it carries no job numbers at all — nothing ever has to ask a closed record
which permit it was.

Header, 32 bytes plus each file's own trailing block, both record files:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `SHED` |
| 4 | u16 | format version = 2 |
| 6 | u16 | header bytes, and so where the records start: 32 plus whatever the block below runs to |
| 8 | u32 | records in this file |
| 12 | u32 | spans in this file |
| 16 | u64 | graph hash — the FNV-1a 64 of the GRPH bytes `routing/version.json` carries |
| 24 | u16 | the day the file's delta chain starts from: its first record's own day |
| 26 | u8 | flags: bit0 set in `closed.bin` |
| 27 | u8 | reserved, zero |
| 28 | u16 | the newest usable DOB snapshot the artifact was built through |
| 30 | u8[2] | reserved, zero |
| 32 | u16[n] | `closed.bin` only: the truncation window, n ≤ 30 row counts |
| 32 | varint pairs | `open.bin` only: one job number per record, in record order |

Both blocks are state for the daily job rather than anything a reader of the records needs, which is
why they sit in front of the records instead of inside them: the client takes the record offset from
the header-bytes field and walks straight past them, and never decodes a byte of either.

The window is there so the daily job does not have to rediscover it: the truncated-snapshot rule
judges a day against the row counts of the 30 published days before it, and a run that picks the feed
up a fortnight back has none of them in hand. Thirty exactly, not a round number with slack — the
whole feed is re-walkable from the DOB's git history whenever the rule is retuned, so there is nothing
to be gained by carrying counts the rule does not ask for.

A job number is stored as **two varints, not a string**: the delta from the previous record's key,
then a suffix code. The key is the nine digits of a BIS number as they stand, or a DOB NOW one's
borough letter and eight digits as 1e9 + borough × 1e8 + digits, with the borough indexed over
`BMQSX` — digits sort below letters, so both run in the order the strings themselves sort in, the
file's own order, and the deltas are non-negative. The suffix code is 0 for a BIS number and
1 + 10 × (job-type letter − `A`) + its digit otherwise, which is the part with no order to exploit
and the one the delta would otherwise be multiplied by. That costs **2.60 bytes a record** against
the 12 or 13 a string does: `open.bin` 117 KB → 138 KB raw, over 7,940 records. A job number of a third shape is a code change and a full rebuild, so the encoder throws on
one rather than storing something that will not read back as itself — and likewise on a block that
would overrun the header-bytes u16, which would take about 21,000 standing sheds against a set that
has sat near 7,500 for eight years.

A record in `closed.bin` is a varint **close-day delta** from the previous record's close day, a
varint **duration** (`close - first`), a u8 confidence, a varint span count, and then per span a
varint **source-id delta**, a varint packing the **side** in its low three bits and the **ordinal**
above them, and the three bytes `t0`, `t1`, `depth`. A record in `open.bin` is the same without the duration, and
its first field is a **zigzag first-day delta** instead — an open shed has no close day, so there is
nothing for a duration to be measured from, and the file is in job order rather than day order, so
that delta takes either sign. Both day chains start from the header's day, so the first record's
delta is 0.

A span names its edge by the graph's **durable key** — `(source id, side, ordinal)`, the GRPH edge
record's bytes 29–33 (v6) — not by the edge's position. Edge ids are positional and every one of them
moves when the graph is rebuilt, so an artifact keyed on positions does not fail on a rebuild, it
quietly puts scaffolding on other streets. The client turns keys back into positions in one pass over
the graph's key column, per query: a day's standing set is ~13k spans against 531k edges, so a map of
the keys that day wants is a hundredth of the size of a map of every edge. A key this graph has no
edge for — a source segment the rebuild dropped, or one whose contraction changed enough to break the
key — contributes no coverage, which is the correct answer rather than a silent misplacement.

`t0`/`t1` are how far along the edge the shed runs, as `round(fraction * 255)`. Confidence is
`round(value * 255)` capped at 254, as the graph's cover and scenic bytes are. `depth` is how deep
the deck runs ACROSS the pavement, in **decimetres**, and **0 means the placement could not measure
one** rather than a deck of no depth — the client turns that into its own 4 m fallback, in one place.

Depth is per SPAN rather than per shed, at a byte a span (~91 KB over the whole history, ~13 KB of
`open.bin`), because a shed that turns a corner off a Midtown avenue onto a side street really does
stand on two pavements of different widths, and both the band and the shadow are drawn per span.

**How it is measured**, all of it in `scripts/shed-map.ts`, since no dataset New York publishes
carries a sidewalk width:

- The **kerb** comes out of the graph. A sidewalk's baked polyline is its centreline offset by the
  half-offset byte, which is half the CSCL kerb-to-kerb roadway plus the manifest's
  `sidewalkInsetMeters` — so the kerb sits exactly that inset inboard of the polyline. The byte says
  nothing else about the pavement: it measures the ROADWAY and stops at the kerb, and the polyline is
  where the inset assumes the middle of the sidewalk is, not where it is.
- The **building line** is the tax lot the placement already measures its frontage against. For each
  candidate sidewalk the lot's street wall — the boundary samples within 2 m of the closest the lot
  comes, facing the line rather than running back off it — is projected onto the polyline and taken
  as a SIGNED offset, positive away from the roadway, its side read off the graph's own
  geometry-right flag rather than guessed from the wall's normal. The median of those samples is the
  wall; a stoop or a bay reaches a metre past it and a shed follows the wall.
- **Depth** is then `sidewalkInsetMeters + offset − 0.3 m`, the 0.3 being what the deck stops short
  of the kerb by.
- A span with no lot boundary behind it — the wrap walk stepped onto a street the lot does not front
  — takes the median of the same shed's other spans, and a shed with none at all writes 0. Over the
  whole history 113,248 of 115,573 spans (98.0%) measure their own, 2,325 take their shed's median,
  and none write 0. The fallback path is the client's belt and braces, not a load-bearing one.

Over the whole feed that comes out as a clean bell around **3.7 m** (a 12 ft sidewalk, which is what
New York builds), running p90 6.5 m on the avenues, which is why the flat 4 m assumption it replaced
was not obviously wrong and why it was wrong everywhere in particular. It is clamped into
**[0.1 m, 8 m]**: 3.7% of spans measure above the ceiling, where the distribution stops falling and
goes flat all the way out to 32 m — superblocks, forecourts and plazas, where the lot line is not the
building line at all. The floor is the format's own, since a depth rounds to decimetres and zero
decimetres is the byte for "not measured". What cannot be BUILT — 5 ft of clear path plus the frame
either side of it, so 2.4 m — is floored by the reader instead (`deckDepth`, `src/routing/sheds.ts`),
which is the only side that knows where the kerb was put and so the only one that can widen a deck
outward over the roadway rather than into the building the measurement found.

**The source-id chain restarts at every record.** A chain running across records would make the
suffix read below impossible and drift the ids silently instead of failing — the bug that cost a day
in the `CSTR` work. Spans within a record are ascending by durable key, which keeps those deltas
non-negative and puts the two sidewalks of one street next to each other at a delta of zero. The
close-day chain does run across records, because the file is sorted and the deltas are tiny; a suffix
read re-bases it from the index.

`index.bin` is a bare array of 8-byte entries, one per calendar month that has a record in
`closed.bin`, ascending: a u16 month (as the day number of its first day, clamped at the epoch), the
u32 byte offset of the first record closing on or after it, and that record's u16 **absolute** close
day. The third field is the whole point — a reader seeking to a month starts its close-day chain from
that value rather than replaying the file to rebuild it.

The sheds standing on day `D` are everything in `open.bin` with `first <= D` — the whole file is
walked, since it is in job order — plus the suffix of `closed.bin` from the first record with
`close >= D`, filtered to `first <= D`. Coverage per edge is
the sum of `t1 - t0` over its spans, clamped to 1: concurrent permits overlap, and about a tenth of
the touched edges are covered past their own length before the clamp.

`components/shed-layer.tsx` draws the standing set: a span becomes the stretch of its edge's own
baked polyline between `t0` and `t1`, and `src/tiles/shed-decks.ts` turns a chain of them into the
POLYGON the deck covers — the band's two edges are that polyline offset to the kerb, a fixed
`sidewalkInsetMeters − 0.3` toward the roadway, and to the building, the span's own measured depth
beyond that. A band centred on the polyline left a visible strip of sunlight between a shed and its
building on every wide pavement in Midtown; a band drawn as a stroked line could carry only one width
per path, so a chain had to break wherever the depth changed — at exactly the corners a shed turns.
The ring walks out along the building edge and back along the kerb edge, and a corner is where the
two offset lines cross, which mitres it by construction and lets one deck narrow from an avenue onto
a side street. Where two offset lines meet more than twice the deck's depth out, or are parallel at
different offsets, the corner is cut square across both edges instead: a chamfer at a hairpin, and
the step across a change of depth. The date comes from the route-time store, which is why the date
picker now reaches back to the epoch rather than one year.

`computeEdgeSheds` (`src/routing/sheds.ts`) turns the standing set into one per-edge byte on the same
0-254 ceiling the graph's own attributes use — the share of the edge standing under a deck — which
three cost terms read. A placement's confidence is not one of the inputs: it stays in the artifact as
a diagnostic, but nothing in the client weights by it, because being unsure whether a deck is there is
a reason to steer clear of it rather than to discount it.

- **Shade.** A deck is opaque, so its share of the edge is shaded whatever the sun is doing:
  `1 - (1 - bakedShade)(1 - shed)`, written on the signed attribute as `attr(1 - shed) - shed*i` for
  the field's sun strength `i`. Composited, not summed — a shed inside a building's shadow cannot
  push the attribute past fully shaded. What `shed` is falls off as the sun slides the deck's shadow
  sideways off the pavement it stands over, and it is the edge's own DEPTH that decides how fast —
  the mean of its spans', weighted by the length each covers, so a 6 m avenue deck holds its shade to
  a lower sun than a 2.5 m side-street one and the router and the map agree on which. Depth reaches
  nothing else: shelter is a roof either over you or not, and the avoid penalty is charged per decked
  metre of LENGTH.
- **Shelter**, a slider of its own, for rain: `shed + rainTau*directCanopy*(1 - shed)`, with `rainTau`
  0.35 in leaf and 0.15 leaf-off (`src/shade/phenology.ts`, the light curve's shape and its own
  endpoints). Both terms are length fractions, so this is a union of coverage, not a stack of
  opacities. Labelled a preference, and shown without a percentage: the deck half is solid, the tree
  half is extrapolated from about four studied trees.
- **Avoid**, a toggle: the decked share is priced at an undiscounted metre plus `SHED_AVOID_PENALTY`
  (20) extra walked metres per metre of deck. Per metre rather than per edge, because a shed over a
  tenth of an edge must not price the whole of it, and finite rather than infeasible, so a start or
  destination under scaffolding stays routable. The two terms above are *not* switched off by it: a
  deck you were told to avoid still shelters and still shades the ground it stands over, and the route
  summary reports it that way. The penalty is what has to dominate what they earn — the flat metre
  alone does not, since the shade axis and the highway penalty can both push a multiplier above 1.

#### Keeping it current — the daily commit

The DOB publishes a new snapshot every morning, so this is the one artifact rebuilt by a job rather
than by a deploy. `.github/workflows/sheds.yml` runs `bun run update-sheds` at 15:00 UTC, which reads
the three committed files out of the checkout, rewrites them, and pushes one ordinary commit to
`main`. `build.yml`'s push trigger ignores `public/sheds/**`, so that commit does not fire a lint+test
run; `paths-ignore` is not on the `pull_request` trigger, so a person editing the pipeline still gets
one. The push is never forced — not even `--force-with-lease`, whose lease is checked against the tip
this checkout fetched, which is exactly the human push it would be overwriting. A rejected push
re-reads `main`, re-stages the same three files on the new tip and commits again, up to three times;
nothing else is ever staged, so there is nothing for a retry to conflict with.

That commit is what the client reads. It fetches
`raw.githubusercontent.com/hafaio/scenic-route/main/public/sheds/{open,closed,index}.bin` — `raw`
serves any branch with `access-control-allow-origin: *`, gzip, an etag, a five-minute cache and range
requests — **so the scaffolding on the map is as fresh as the job, not as the last deploy**, which
matters because Pages ships on `workflow_dispatch` only. A dev server reads its own `public/sheds/`
instead, as it does every other artifact; `NEXT_PUBLIC_SHED_BASE` overrides the base either way. Set
`SHED_ARTIFACT` to point the *job* at another copy — a directory, or a URL to read one over HTTP.

**Nothing shed-related is in Git LFS and none of it may ever be.** LFS keeps every rewrite whole, so a
megabyte a day really does cost ~400 MB a year there, charged to the account. Packed git does not:
1.7-22 KB a day depending on the repack window (DESIGN.md has the measurement), which is why the
artifact is committed at all — and why it is committed under `public/` rather than beside the LFS
directories in `data/`.

**A format bump needs a full rebuild before the job can run again.** The artifact is rebuilt outside
any deploy, so the client and the artifact are versioned independently and a `SHED` version bump
breaks both directions at once: the new reader rejects the files the job last committed, and the new
`update-sheds` rejects them too. The move is `bun run build-sheds`, commit, then deploy — there is
no in-place migration and none is wanted, since a full rebuild is two minutes and reproduces the
artifact exactly.

**The job keeps nothing of its own between runs.** The artifact's header says which day it was built
through and which permit each of its standing records is, the DOB's CSV history says what stood on
that day and every day since, and the difference is the update — no side file, no clock. The feed's
own answer to the identity question, the permits still provisional on that day in job order, is
checked against the stored one on every run, and a disagreement stops the job rather than shifting
every shed onto its neighbour's street.

**And it never assumes it ran yesterday.** Cron is best-effort, a scheduled workflow on a public repo
is switched off after sixty days of repository quiet, a run can fail unnoticed for a week, and the
feed itself has 74 gaps totalling 392 days (the worst a 66-day hole in early 2021). So it reads the
artifact's own day and replays every snapshot published since — one or three hundred, the same code
either way. It is `scripts/shed-permits.ts`'s own walk over a window rather than a second
implementation, over exactly the days whose intervals could still change and not one day more.
Running after a month idle produces what running every morning would have, running twice in a day
writes the same bytes, and — the property the other two are corollaries of — the artifact is a
function of the day it was built through and of nothing else, so a chain of updates lands on the
bytes a full `build-sheds` at the same day writes however far back the chain started
(`src/routing/shed-update.test.ts`).

Four properties of the rest of the pipeline are what let it be this small:

- **The truncated-snapshot rule looks only backwards, and its window travels in the artifact.** A day
  is judged against the row counts of the 30 published days *before* it, so its verdict is final the
  moment it is made and no later run can disagree with an earlier one about a day both have seen. A
  two-sided window cannot say that, which is why the job used to need a separate settled-day clock; a
  30-day backward window still outvotes the longest degraded run the feed has had, a fortnight in
  mid-2019. Those 30 counts ride in `closed.bin`'s header, so the run judges its first day exactly as
  a walk over the whole history would without reading a day of history to find out how.
- **A record is placed from the reading its own interval ended under.** The feed keeps correcting a
  permit's geocode and length, and the walk swaps a permit's attributes only when they actually
  change, so an interval that closed before a correction keeps the object the walk held then. A full
  rebuild places one reading per permit plus one per correction an older interval predates — 65,026
  placements against 61,331 permits and 72,020 records, so 6% more work, not the tripling this used
  to warn of.
- **Spans are keyed by the graph's durable edge id.** A rebuilt graph invalidates no record, so
  nothing has to be stored in order to place anything again, and the job re-places only what is new.
- **`closed.bin` is append-only.** Nothing whose last sighting is more than a renewal old can change,
  so the window the job reads is exactly the renewal tolerance plus however far behind it is.

The only thing it fetches fresh is the tax lot for a permit the artifact has never placed: the day's
~16 new sheds, plus the ~28 whose length or geocode the feed has corrected inside the window, which
`ShedPermit.corrected` reports. One Socrata batch per dataset.

**It used to reproduce all but one thing, and that one thing was the bug.** A permit whose length the
feed corrected *after* an earlier stint of its had closed kept that stint's old placement, where a
full rebuild gave every one of its intervals today's number — so what the artifact held depended on
where the replay that produced it started, not only on the day it reached. Rewinding six months and
catching up left 27 of 64,080 closed records disagreeing, and a 92-byte `closed.bin`. The fix is the
second property above, and it settled the argument the other way from what this used to guess: the
shed that stood in 2024 was the length the feed gave in 2024, and a full rebuild now says so too.

## Adding a city

The client does not change. It reads `src/tree-cover/manifest.json` and the tile pyramid;
another entry in the manifest is another `TileLayer` and another `GridLayer`, and the tiles
of two cities that share a low-zoom tile are painted into the same buffer rather than
overwriting each other.

What has to change is the ingest in `scripts/build-tree-data.ts`, which is currently one
hard-coded `CITY` constant plus four NYC-specific fetchers. A new city needs:

1. **A measured tree-canopy source** — polygons of the canopy footprint (NYC uses its 2017 LiDAR
   canopy). This *is* the cover field: without it `tiler densities` has nothing to convolve and the
   map has no cover at all. A canopy height model to run `tiler heights` against is optional: with
   none, every polygon keeps the 0 that reads as an unknown height.
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
