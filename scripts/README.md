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
tiler graph  --streets <in.bin> --out <out.bin> [--paths …] [--ferries …]   # contracts STRT (+PATH, +FERR) into the GRPH routing graph
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
| paths | OSM pedestrian/park ways (footway/path/pedestrian/steps/cycleway/bridleway/track) plus park drives (roads closed to through motor traffic), via Overpass | the park, greenway and car-free-drive network CSCL lacks; a separate committed source, magic `PATH` — see below and "Binary layouts" |
| ferries | the two NYC ferry GTFS feeds — Staten Island Ferry (NYC DOT) and NYC Ferry (Hornblower, via Connexionz) | consolidated to a time-independent ferry graph, a committed source, magic `FERR` — OSM- and canopy-independent, read by a later phase's routing graph, not the cover pipeline; see below and "Binary layouts" |
| landmarks | NYC LPC Individual Landmark Sites, Socrata `buis-pvji` | ~1.5k designated historic/touristy sites, taken at their WGS84 centroid; a committed POI source, magic `LMRK` — a later phase fans them out into a per-edge routing discount, not the cover pipeline; see "Binary layouts" |
| art | NYC PDC Outdoor Public Art Inventory (Socrata `2pg3-gcaa`) + OSM `tourism=artwork` via Overpass | public art and murals (OSM carries the murals the PDC set is thin on), deduped by proximity; a committed POI source, magic `ARTW` — its own routing discount, distinct scenery from landmarks; see "Binary layouts" |
| highways | OSM limited-access highways (`motorway`/`trunk` + ramps) and above-ground rail (surface, open cut, or elevated — anything not `tunnel`), via Overpass | the lines walking near is unpleasant, as polylines; a committed source, magic `HWAY` — a later phase turns proximity into a routing *penalty*; never routed; see "Binary layouts" |
| buildings | NYC Building Footprints, Socrata `5zhs-2jue` (`feature_code=2100` with a positive `height_roof`, feet→metres) | 867,920 footprints with their roof heights; a committed source, magic `BLDG` — the input a later **building-shade** factor will raise walls from and cast shadows with; not yet read by routing; see "Binary layouts" |
| landuse | NYC PLUTO, Socrata `64uk-42ks` (lots with `landuse` 1..5) | 788,591 tax lots, each with a land-use class byte; a committed source, magic `PLUT` — the commercial-vs-residential signal for the **commercial-area** overlay; see "Binary layouts" |
| dining | NYC Dining Out `fpeh-f7ci` + OSM `outdoor_seating` via Overpass | outdoor-dining points; a committed source, magic `DINE` — a "cute" signal for the commercial overlay |
| openstreets | NYC DOT Open Streets `uiay-nctu` (non-school), sampled every ~10 m | Open Streets corridor points; a committed source, magic `OSTR` — a "cute" signal for the commercial overlay |

The commercial overlay's per-segment signals are then precomputed at **build time** by `scripts/build-commercial.ts` (run after `tiler chunks`): it snaps `landuse`/`buildings`/`dining`/`openstreets` onto each street segment by *frontage* (perpendicular, projection in-span) and writes `public/commercial/{x}/{y}.bin` (magic `CMRC`, 3 bytes/segment: commercial fraction, median roof height, flags for open-street/seating), one file per `STCK` chunk, gitignored. The overlay reads those and applies the gate (>50% commercial AND low-rise AND (open-street OR seating)) client-side, so its thresholds stay tunable without a rebuild.

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
regions stay parallel to the polygons. Written by `encodeBuildings`. Not yet read by the tiler: it is
the committed input for a future building-shade factor, which will raise each wall from its base
elevation, project its shadow by the sun position, and bake a time-bucketed per-edge shade attribute
(a separate artifact, not the GRPH edge record). The base elevation makes the casters terrain-aware;
bare-earth self-shadowing (hills/parks with no buildings) would need the separate 1-ft LiDAR DEM.

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

### `public/routing/{id}.bin` — the routing graph, magic `GRPH` (v4, derived, gitignored)

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
be separate components (`mopupCrossings`), and the build asserts the walking component count equals
the v1 count. Nodes are sorted by (component, latitude, longitude) and renumbered, edges by
(component, min node id).

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
| 4 | u16 | format version = 4 |
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
6. **Edge records**: E × 28 bytes:

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
| 27 | u8 | reserved (0) |

Bytes 24–26 are the **scenic-factor attributes** baked by `scenic.rs` (v4). The landmark and art
bytes are a network **discount**: each POI (`LMRK`/`ARTW`) snaps to the nearest walking node and a
bounded Dijkstra fan-out deposits a distance-decaying contribution on the edges it reaches, summed
across POIs and saturated `1 − e^{−k·field}` (so a dense cluster stops stacking); the kernel is
per-mood (landmarks wide, art tight). The highway byte is an areal **penalty**: a Gaussian of the
edge's metre distance to the nearest highway or above-ground-rail line (`HWAY`). All three quantize to a
0–254 ceiling so the client's `maxLandmark`/`maxArt` stay `< 1` (the cost model's admissibility
invariant, as `maxCover` already relies on); a later phase reads the discounts as `1 − w·attr` and
the penalty as `1 + w·attr`. A ferry carries none.

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
