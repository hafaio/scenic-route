# The tree-cover pipeline

This is the reference: what each stage does and what every artifact contains. The reasoning behind
the design — the alternatives that were measured and rejected, and the traps — is in DESIGN.md.

Two scripts, run in order:

```sh
bun run build-tree-data   # sources -> data/**/*.bin + src/tree-cover/manifest.json
bun run build-tiles       # those -> public/tiles/ + public/streets/
bun run build-tiles:half  # the same, on half the cores
bun run build-tiles:graph # half the cores, and only the graph pass
bun run build-tiles:shade # half the cores, and only the shade pyramid
```

`build-tree-data` is the slow one (a few minutes of paging, mostly network) and only
needs re-running when the sources are refreshed; its binaries are committed. `build-tiles`
is the expensive one in CPU, its output is gitignored, and `bun dev` / `bun export` run it
automatically. **It does only the work its inputs imply**: freshness is decided a pass at a time
(and, inside the two most expensive passes, a sun bin at a time) over what that pass actually reads,
so a re-run with nothing moved is seconds and a re-ingested source costs the passes that read it and
no others. Only a first build, or one after an edit to the tiler, pays for everything — see *The
build plan* for what that is and *Where the tile build spends its time* for what it costs.

It renders on every core it can find, which leaves the machine it is running on unusable for as long
as that takes. `build-tiles:half` passes `--jobs half` to size rayon's pool at half the cores
instead; `--jobs <n>` takes a count, and the tiler reports which it settled on before the first
stage. Nothing about the output moves with the thread count. `build-tiles:{graph,shade}` are the two
passes worth naming on their own, each on half the cores — see *Building one pass:* `--only` *and*
`--force`.

## Who does what: TypeScript fetches, Rust computes

**All of the model math lives in `crates/tiler`**, a Rust binary with four subcommands. The
scripts fetch and encode; they compute nothing about trees, and they orchestrate nothing — **no
TypeScript spawns cargo**, anywhere. package.json sequences every cargo run there is, and the
scripts either side of one hand their work over as files.

| | |
| --- | --- |
| `scripts/` | Socrata paging, the Overpass mirror rotation, the disk cache, the `.bin` encoders, the manifest, and the colour ramp |
| `crates/tiler` | the canopy convolution and the cover it yields, the sidewalk offsets and their cover, the Monte-Carlo cover distribution, the per-polygon canopy heights, the genus-dot overlay, the tile pyramids, the WebPs, the street and caster chunks, and the routing graph |

```sh
tiler build --plan <file.json> [--jobs <count|half>]          # the nine passes that make a tile build, in one process
            [--only <pass>[:<city>],…] [--force]              # …or only some of them, stamps ignored or not
tiler ingest --params <file.json> --report <file.json>        # fills the canopy crown heights and the street & path density blobs, in place
tiler key-probe --report <file.json>                          # the graph pipeline over a fixture, for the durable key hash the shed gate stamps
tiler graph-inputs --plan <file.json> --report <file.json>    # the other half of that gate: the plan's sources decision, and the bytes it names
```

There were ten. Seven of them were argv wrappers over the module function `tiler build` already
calls directly, so they are gone: what this document calls the chunks, caster-chunks, shade,
elevation, canopy, genus-field and graph **passes** are those functions, called in order inside
`build`. Running one on its own is `build --only <pass>`, so it is still the driver that decides
what a pass reads and what it records. The commercial pass is not among them — it was a script
run by hand, which no build invoked, and it became a pass rather than losing a subcommand. `heights` and `densities` merged into `ingest`,
which is the order they always ran in over one city. `key-probe`'s fixture paths and its throwaway
`--out` default, so the package.json line carries only where to leave the report.

`cargo run --release` no-ops once the binary is built, so `bun dev` and `bun export` need no extra
step. **The shed gate's two commands alone run on the debug profile**: `key-probe` and
`graph-inputs` run on every push and pull request rather than on a deploy, the release profile is
lto + one codegen unit and takes minutes to link, and between them they read a 268 KB fixture and
sha256 six files, so the optimizer buys them nothing. Both profiles give that fixture the same key hash — nothing on the key path is float-derived
in a way rustc is free to reassociate — and the recorded stamp and the checked one are computed the
same way regardless. `bun lint` and `bun fmt` cover the crate too.

The split is not only for speed. The Gaussian kernel, its 3σ truncation and the
renormalization constant are the *model*; if the tiler were ported and the ingest were not,
they would live in two languages and have to be kept in step. One home.

Two things cross the boundary in the other direction, and both are deliberate:

- **The manifest carries the per-city structure the tiler reads with serde** — each city's
  bounds and which layer files and overlays it has, which the canopy, genus-field and
  chunks passes read. The numeric model constants (σ_fill, σ_tight, the sidewalk inset, the
  cover sample count and seed) ride to `tiler ingest` in its params JSON instead: the ingest
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

The cover field is measured, not inferred from the tree points — but the points are still drawn, as
the **genus overlay** (`components/genus-gl-layer.tsx`, `components/tree-dots-layer.tsx`): each tree
a disc coloured by its genus and *sized by its crown*. That crown radius comes from a **published**
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

Two inputs are cleaned before the curve sees them, in `scripts/tree-data-fetch.ts`:

- **Outliers.** `max(dbh)` is 2427 in, nonsense. Trunks past **60 in** (already a very large
  street tree) are clamped there; ~200 rows are affected. The ingest logs the count.
- **Missing dbh.** ~740 trees carry `dbh = 0`. They are given the **median (9 in)** rather than
  a zero crown. The ingest logs that count too, and the manifest records both.

The allometry lives only in the ingest: it writes a **crown-radius byte per tree** (decimetres,
0–25.5 m) into the `TREE` file, and the genus overlay reads it back as the radius to draw each dot
at — clamped to [1.5, 16] px so a distant crown still shows and a lone giant does not swell into a
blob. So the model constant sits in one place, and the renderer does geometry, not botany.

### Anti-aliasing the fill

A canopy polygon has a hard edge — 1 under it, 0 outside — and the fill pyramid (the canopy pass)
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
| canopy heights | the 1 m LiDAR canopy height model of Ma et al. 2023, figshare doi `10.6084/m9.figshare.20522895` (`NY_CHM_10Int260m.tif`, CC BY 4.0) | a 243 MiB uint16 GeoTIFF of decimetres over UTM 18N, cached but never committed; `tiler ingest` samples it per canopy polygon and writes the result *into* the `CNPY` file — see below |
| paths | OSM pedestrian/park ways (footway/path/pedestrian/steps/cycleway/bridleway/track) plus park drives (roads closed to through motor traffic), via Overpass | the park, greenway and car-free-drive network CSCL lacks; a separate committed source, magic `PATH` — see below and "Binary layouts" |
| sidewalks | OSM `footway=sidewalk`/`crossing`/`traffic_island` ways via Overpass, plus the NYC planimetric SIDEWALK polygons, Socrata `52n9-sdep` (`sub_code` 380000 = street right-of-way) | the ways are a committed source, magic `SWLK`; both together settle the four per-side sidewalk bits of every offsetted `STRT` record, and the ways themselves are the walking network wherever they exist — see below and "Binary layouts" |
| ferries | the two NYC ferry GTFS feeds — Staten Island Ferry (NYC DOT) and NYC Ferry (Hornblower, via Connexionz) | consolidated to a time-independent ferry graph, a committed source, magic `FERR` — OSM- and canopy-independent, read by a later phase's routing graph, not the cover pipeline; see below and "Binary layouts" |
| subway | the MTA's subway GTFS feed, `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip` | the 29 routes as 93 polylines (every shape variant the feed runs that draws track nothing else does) and the 496 stations, with the colours and names the MTA publishes for each route and, per station, the set of routes that genuinely serve it and the complex `transfers.txt` puts it in; a committed source, magic `SBWY` — **display only**, it enters no routing input (this is a walking router and nobody walks the subway); see below and "Binary layouts" |
| transit (San Francisco) | SFMTA's Muni GTFS, `https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip`, and BART's, `https://www.bart.gov/dev/schedules/google_transit.zip` — both keyless | Muni's rail (the six Metro lines, the F streetcar, the three cable cars) and the four BART lines that run through the city, as 42 polylines clipped to the city's land, and the 268 stations (no complexes: neither feed publishes a transfer between two of its stations), in the **same `SBWY`** blob New York's subway ships as; **display only**, it enters no routing input; see below |
| landmarks | NYC LPC Individual Landmark Sites, Socrata `buis-pvji` | ~1.5k designated historic/touristy sites, taken at their WGS84 centroid; a committed POI source, magic `LMRK` — fanned out into a per-edge routing discount, not the cover pipeline; see "Binary layouts" |
| art | NYC PDC Outdoor Public Art Inventory (Socrata `2pg3-gcaa`) + OSM `tourism=artwork` via Overpass | public art and murals (OSM carries the murals the PDC set is thin on), deduped by proximity; a committed POI source, magic `ARTW` — its own routing discount, distinct scenery from landmarks; see "Binary layouts" |
| highways | OSM limited-access highways (`motorway`/`trunk` + ramps) and above-ground rail (surface, open cut, or elevated — anything not `tunnel`), via Overpass | the lines walking near is unpleasant, as polylines; a committed source, magic `HWAY` — proximity to it is a per-edge routing *penalty*; never itself routed; see "Binary layouts" |
| buildings | NYC Building Footprints, Socrata `5zhs-2jue` (`feature_code=2100` with a positive `height_roof`, feet→metres) | 867,920 footprints with their roof heights; a committed source, magic `BLDG` — the walls the **building-shade** factor raises to cast shadows, for both the shade overlay pyramid and the signed per-edge shade routing bake; see "Binary layouts" |
| landuse | NYC PLUTO, Socrata `64uk-42ks` (lots with `landuse` 1..5) | 788,591 tax lots, each with a land-use class byte; a committed source, magic `PLUT` — the commercial-vs-residential signal for the **commercial-area** overlay; see "Binary layouts" |
| industrial | **NYC**: PLUTO's tax-lot polygons, DCP's MAPPLUTO ArcGIS FeatureServer (`services5.arcgis.com/.../MAPPLUTO/FeatureServer/0`), `LandUse = '06'`. **SF**: DataSF Land Use `c5ge-t6pj` + Zoning `3i4a-hu95`, the rule in `scripts/sf.ts` | industrial land as **polygons** — 9,295 lots in New York, 2,574 parcels in San Francisco; a committed source, magic `INDL` — drawn as an overlay so the city's industrial land can be seen, and sampled per edge into the graph's industrial-frontage penalty (GRPH byte 36). New York's geometry has to come from ArcGIS: the Socrata copy of PLUTO is lot centroids and its `geom` column is null on every row. See "Binary layouts" |
| historic | **NYC**: LPC **Historic Districts** ArcGIS FeatureServer (`services5.arcgis.com/Oos4pNA2538iVFA1/.../Historic_Districts/FeatureServer/0`). **SF**: DataSF **Historic Districts** `63x5-g3m4`, filtered to `a10='Listed' OR a11='Listed'` | the designated historic districts as **polygons** — whole landmarked neighbourhoods (Park Slope, Brooklyn Heights, Greenwich Village …; Jackson Square, Telegraph Hill, Alamo Square …), not the individual buildings `landmarks` carries; 159 districts in New York, 23 in San Francisco; a committed source, magic `HDST` — drawn as an overlay, and sampled per edge into the graph's historic-district discount (GRPH byte 37). Each city's obvious Socrata copy is a decoy: see "Binary layouts" |
| dining | NYC Dining Out `fpeh-f7ci` + OSM `outdoor_seating` via Overpass | outdoor-dining points; a committed source, magic `DINE` — a "cute" signal for the commercial overlay |
| openstreets | NYC DOT Open Streets `uiay-nctu` (non-school), sampled every ~10 m | Open Streets corridor points; a committed source, magic `OSTR` — a "cute" signal for the commercial overlay |

The commercial overlay's per-segment signals are then precomputed at **build time** by the commercial pass (run after the chunks pass): it snaps `landuse`/`buildings`/`dining`/`openstreets` onto each street segment by *frontage* (perpendicular, projection in-span) and writes `public/commercial/{x}/{y}.bin` (magic `CMRC`, 3 bytes/segment: commercial fraction, median roof height, flags for open-street/seating), one file per `STCK` chunk, gitignored. The overlay reads those and applies the gate (>50% commercial AND low-rise AND (open-street OR seating)) client-side, so its thresholds stay tunable without a rebuild. The **same gate** also runs at build time to emit the qualifying blocks' centrelines as `public/commercial-lines/<id>.bin` (magic `CMLN`, the `HWAY` single-ring-polygon layout, gitignored), which the graph pass proximity-bakes into the per-edge commercial routing discount (GRPH byte 27).

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

This is the **cover source itself**: `tiler ingest` convolves the canopy indicator with a Gaussian
and samples it at each sidewalk offset, so the byte in every street and path density blob — and,
through them, the graph pass and the routing cost — is the blurred measured canopy. There is no
separate point-KDE lifting park interiors; the ForMS points now drive only the genus overlay (see
`crates/tiler/src/genus_field.rs`), not the cover field. Its area on land is ~a fifth of the city
(the published all-canopy figure is ~22%), recorded in the manifest as `field.canopy.squareKm`.

The canopy pass renders it into the cover **fill pyramid**, `public/tiles/canopy/{z}/{x}/{y}.webp`,
over the z9–z15 plan and coloured by the **same ramp LUT** — canopy is a covered fraction in
[0, 1), the very quantity the ramp is defined over. A coarse grid over the ~1.08 M polygons
(CSR-style, like the tree index) hands each tile only the polygons it touches; each pixel's canopy
fraction is a 4× supersampled even-odd polygon fill averaged back down (so multipolygon holes
punch through and edges antialias), clipped to the land mask so nothing bleeds over water. A tile
with no canopy is the shared blank WebP. The client draws it with `components/canopy-layer.tsx`, a
bare `TileLayer` with no street-line companion — canopy is areal, not per-street.
`tiler build` runs it after the `chunks` pass; the pyramid is gitignored build output
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
`tiler ingest` reads it off disk: it projects every polygon vertex into the raster's UTM grid with
Snyder's transverse Mercator series (a round trip measures 0.06 mm, and a ±4 m registration sweep
peaks at no offset), fills each polygon even-odd at cell centres, and stores the **75th percentile**
of the cells it caught, in decimetres, in the file's trailing height region. It rewrites the `.bin`
in place, exactly as the density pass that follows it fills the density blobs — one `tiler ingest`
run does both, over the files scripts/tree-data-fetch.ts has just written.

San Francisco has no equivalent product, and takes its heights from **band 2 of the same 3DEP
topographic tiles the terrain overlay is built from** — the surface model less the terrain model,
which is height above ground. Same pass, two differences: the tiles are a *mosaic* of 651 separate
rasters rather than one file, so `ingest.json`'s `chm` names the list and its band and the tiler
lays a single virtual grid over their union (they share a projection, 1 m cells, and whole-metre
origins, all three checked rather than assumed); and the band is not a canopy product at all. It
measures whatever stood there — the Salesforce Tower reads 324 m in it. What makes it a crown height
is the masking, and only the masking: the polygons are measured canopy, so a cell is read only where
a tree was already mapped. **Never sample that band unmasked.** Cells still reading above 65 m,
taller than any tree in either city, are dropped rather than clamped — a clamp would keep a 200 m
tower and call it a 65 m tree — so a polygon straying onto a roof falls back to its real crown
cells, and one with none keeps the 0 that means unknown. Measured: that rejects 0.05% of the city's
canopy area, all of it downtown and along roof edges, and the run reports the upper tail
(p95/p99/max and the share above the cut) for exactly this reason.

The two cities' numbers are not comparable as like for like, and the difference is the product, not
the trees: New York measures 46% of its polygons, median 15.2 m, IQR 8.2 m; San Francisco measures
75% of them, median 16.6 m, IQR 16.9 m. A crown-core threshold drops low canopy, which lifts the
floor and tightens the spread; a raw height-above-ground inside a polygon keeps the shrubs.

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

**Everything under a bin index is per city.** A bin's key is `(declination band, hour angle)`, which
is latitude-free — that is what makes a clock scrub jitter-free — but the sun position that key
resolves to is not, and neither is the sunrise cut deciding which keys exist at all: a city further
south has winter bins a northern one does not. So the shade pass renders one city at a time, and the
pyramids, `buckets.json` and the `SHDB` directory all carry the city in their path. Two cities can
share neither a bin index nor a file.

The shade pass reads them alongside the building footprints and bakes a **second shadow pyramid**,
`public/tiles/tree-shade/<city>/<bin>/{z}/{x}/{y}.webp`, mirroring the building one
(`public/tiles/shade/<city>/<bin>/{z}/{x}/{y}.webp`) tile for tile: the same bin indices off the same
`buckets.json`, the same z9–z15 plan, the same lossless WebP of one flat slate where only alpha
varies, the same `MAX_SHADE_ALPHA * intensity * fraction` scale and 8-step quantisation, and a tile
with nothing painted in it is not written at all — the client reads the 404 as transparent.

Two things differ from a building. A crown **floats in the air**, so no wall connects it to the ground
and its shadow is not a swept footprint but the union of its own **slices**, each swept between two
airborne cross-sections of itself. The crown is a spheroid spanning `CROWN_BASE_FRACTION * height` to
the full height — a point at the trunk, widest at the middle of that span, a point at the top — so
slice `j`, the outline inset by `j / 4` of the crown radius, is swept between the ground displacements
of the two heights where the crown draws in to that radius (each clipped to the same 500 m). Those
heights straddle the widest section, so the union comes out a lens: the shadow narrows at the end
nearest the tree as well as at its tip. The **0.4** is the crown BASE, an assumption anchored on crown
ratio (0.39–0.60 for hardwoods, Russell & Weiskittel 2011 Table 1) — crown length over tree height,
which is the quantity that means it. Where the crown is WIDEST inside that span is the unsourced half:
the published height-to-largest-crown-width work is all conifer, so the midpoint is taken. Casting the
whole crown from the polygon's own height instead would model it as a flat sheet at the top of the tree
and throw the shadow about a crown radius too far — far enough at a low sun to detach it from its tree.
`src/tiles/sweep.ts` cuts the same slices, or the client's swept
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
committed network, `data/paths/nyc.bin`, magic `PATH`. Its byte layout is **STRT's exactly**,
so `binfmt.rs` reads it with the same code (`read_paths`) and `tiler ingest` samples it with
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
no shared-use path on it in OSM). **`footway=sidewalk`/`crossing`/`traffic_island` are excluded here**
and fetched as their own extract instead (`SWLK`, below), because the graph reads them under a
different rule — they are the sidewalk network, not walks beside it, so none of the dedup bands the
paths go through may touch them. `area=yes` (plazas) is not an edge; `access`/`foot` `no`/`private`
and `indoor=yes` are not walkable.

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
Bridge". `tiler ingest` fills their density blob from the same canopy field the streets use: a
path is its own walking surface, so it is sampled once on its line and that one value stands for
both sides.

The paths carry honest cover and are conflated into the network: the graph pass reads them into the
GRPH routing graph and the chunks pass appends their segments to the street chunks the client draws,
so a route can follow a greenway or step street rather than only the CSCL centerlines.

Overpass — which fetches both the paths and the OSM trees — is the flakiest thing in the pipeline:
the query rotates over three mirrors, backs off in minutes rather than seconds, and must send a
`User-Agent` (an anonymous client gets a 429 on sight). Everything is cached, so this is a one-time
cost.

### The sidewalks (`SWLK` v1)

The clause above's exact complement, fetched as a fourth committed network,
`data/sidewalks/nyc.bin`, magic `SWLK` — the same highway classes and the same walkability
filters, keeping the three `footway` values the walking net drops:

    way["highway"~"^(footway|path|pedestrian|steps|cycleway|bridleway|track)$"]
       ["footway"~"^(sidewalk|crossing|traffic_island)$"]["access"!~"^(no|private)$"]
       ["area"!="yes"]["indoor"!="yes"]["foot"!~"^(no|private)$"]

Traffic islands come along because crossings chain through them: leave the islands out and every
median crossing is cut in two. Clipping, densification and name-uppercasing are the paths'
exactly, and the layout is STRT's, so one reader serves it.

The extract does two jobs. It is what the **per-side STRT bits** are matched from (a side counts as
mapped when a sidewalk runs alongside it over most of the block), beside the second source those bits
carry — the NYC planimetric **SIDEWALK polygons** (`52n9-sdep`, `sub_code` 380000 = street
right-of-way), probed at the derived sidewalk position to say whether the city's survey drew a
sidewalk there. The sibling *"Sidewalk Centerline"* layer (`a9xv-vek9`) is **not** that source and is
not read: its capture rules take interior-campus walkways and explicitly exclude right-of-way
sidewalks, so it cannot answer the sidedness question at all. And it is the geometry itself:
the graph pass makes these ways the walking network wherever they exist ("the sidewalk
network", below), which is why the extract is committed and frozen rather than four bits derived
from it.

Measured over the 10,521 km of offsetted CSCL centerline the bits cover: OSM maps sidewalks on
both sides of 70.0% of it, one side of 13.4%, neither of 16.6% — but that is far from uniform
(Brooklyn 7.6% unmapped against the Bronx's 40.5%, in contiguous neighbourhoods that do have
sidewalks), which is exactly why the survey bit is carried alongside rather than OSM's absence
being read as absence: OSM's silence is ambiguous — a mapping gap or no sidewalk — where the
survey's is authoritative. The survey draws both sides of 72.3%, one of 16.2%, neither of 11.5%.

**The survey probe's stations are the centres of equal pieces of the segment**, not every 15 m from
its start: a CSCL segment ends at a junction, so a station on an end vertex probes across the cross
street's roadway, and a segment under one step is decided by that one station alone. **And the fan
at each station is wider where CSCL records no `streetwidth`**, since the offset it fans around is
then the 30 ft citywide median standing in for an unknown rather than a measured width. Neither
makes the probe's false negatives uniform — DESIGN.md, "Whether there is pavement at all", carries
what is left of them by segment length and by whether a width was recorded.

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

One berthing manoeuvre is trimmed by hand. A published shape includes the boat's move into its
berth, and at **Wall St/Pier 11** four of the seven shapes calling there run 186 m north-west past
the slip, reverse (178.9-179.9 degrees) and come back the last 70 m into the pier — which draws as a
spike over South Street. Those four vertices are dropped, so the line runs from its last approach
vertex (115 m out) straight into the pier; the polyline still begins and ends at its two stop
coordinates, which the graph pass depends on. This is one named place, not a rule: the sharpest
genuine course change near a terminal anywhere in either feed is 127.5 degrees at 100 m out (the
East River line swinging into Dumbo/Fulton Ferry), so a threshold would have little room and could
trim a route that doubles back to serve two piers on one shore. The next pier that draws badly gets
its own line.

### The subway route lines and stations (`SBWY` v3)

`scripts/subway.ts` (`bun run build-subway`) reads the MTA's one subway GTFS zip — 5.3 MiB, cached
by `cachedFile` — and writes `data/subway/nyc.bin`, the route geometry and the station markers the
map draws the system with. **Display only.** Nothing here reaches the routing graph, the key space or the tile build: the
app routes a person on foot, and no walking route rides a train. `serve-sources.ts` copies it to
`public/subway/<id>.bin` for the client, and it is not in the manifest — the same place `FERR`,
`LMRK`, `ARTW` and `HWAY` sit, all of them committed sources that no cover-pipeline layer owns.

**Colours and names come from `routes.txt` and nowhere else.** `route_color` is the hex the MTA
publishes and it is *not* the palette people remember: at the 2026-05-26 feed the 1/2/3 are
`D82233`, not the old `EE352E`, and the A/C/E are `0062CF`, not `0039A6`. The file also carries
`route_text_color` (the colour of the letter inside the bullet), `route_short_name` (the "1", "A",
"S" a rider says) and `route_long_name` (the corridor). All three shuttles are short-named `S`, so
only the long name — "42 St Shuttle", "Franklin Avenue Shuttle", "Rockaway Park Shuttle" —
distinguishes them.

**Which services.** `route_type` 1 is the subway, 28 routes. The feed also carries the Staten Island
Railway as `route_type` 2, and it is **kept**: it is drawn on the MTA's own subway map, it is inside
the fare system, and this map covers Staten Island, so leaving it out would blank a whole borough
while every other borough drew its lines. That makes 29 routes. The diamond expresses (`6X`, `7X`,
`FX`) and the `Z` are separate routes in the feed and stay separate here — they retrace their
parent's track, so a renderer that wants one line per corridor can skip them by short name.

**The stations.** GTFS models a station as a *parent* stop (`location_type` 1) with one child
platform per direction sitting at the same coordinate, so the parents are what a marker wants:
drawing the platforms would put two markers a few metres apart at every station. That gives **496
stations** — 475 subway plus the SIR's 21 — and this feed leaves none of its 992 platforms
parentless, so the fall-back to a platform standing in for itself has never fired. Each station
carries the set of routes serving it, taken from the trips of a kept route that stop at it, in both
directions and on every shape variant — which routes call at a station is a fact about the schedule,
not about what got drawn.

**A route that runs once is not a route that serves the station.** A raw count of callers labels 96
St-2 Av with three routes, as though the N and the R belonged there beside the Q, when the schedule
says Q 859 trips, N 12, R **one trip in the whole feed**. So a route enters a station's mask only
when it clears a floor on the *share of that route's trips* that stop there. The 2026-05-26 feed
splits the two kinds of service apart cleanly: of the 1,028 station-route pairs, **956 stand at
10.09% of the route's trips or more and the other 72 at 3.38% or less, with nothing in between**.
Any floor from 3.4% to 10.1% therefore keeps exactly the same 956 pairs; the constant, `5.8%`, is the
geometric middle of that empty band. What it removes is rush-hour put-ins and reroutes: the W's 24
Brooklyn stations, 2–5 trips each, from DeKalb Av down Fourth Avenue and out the Sea Beach and West
End lines; the 5's 10 in Brooklyn (1–24 trips) and 9 up White Plains Rd (22–27); the 2's 10 to New
Lots Av (9); the R's 7, one trip apiece, four of them the Second Avenue stations; the A's 4 to
Rockaway Park (10); the E's 4 out to 179 St (2–14); and the N's 4 up Second Avenue (12). No station
loses every route, so the count stays at 496; the widest mask drops from six routes to five (DeKalb
Av loses the W's five trips) and 199 stations are left with a single route.

**Which stations are one place: the MTA's own answer, not ours.** The map draws one marker per
*complex*, not per station record — Times Sq is one marker, not five — and which records make a
complex comes from `transfers.txt`, the table the agency uses to say a rider may walk from one stop
to another. The 2026-05-26 feed carries **613 rows: 463 of them a station to itself** (its in-station
transfer time, which says nothing about complexes) and **150 between two different stations**, which
after resolving both ends to their parent station — the rows are keyed on stop ids that may be
platforms — are **75 distinct pairs**. Their connected components are the complexes: **444 over the
496 stations**, 35 of them holding more than one station and the largest holding five (the four Times
Sq records plus 42 St-Port Authority Bus Terminal). Each station record carries its component's id,
numbered from 1; `0` means the feed published no station-to-station transfer at all.

The client merges on that id and on nothing else where it is set (`src/subway/format.ts`), which
changes 17 places against the distance-and-name rule it replaces:

- **It splits Rector St.** The 1's station (`139`) and the N/R/W's (`R26`) are **49.5 m apart under
  one name with no passage between them**, and no transfer row pairs them. Nothing else in the file
  could tell that pair from Fulton St, and the old rule merged it.
- **It joins sixteen complexes the geometry could not reach**, because a complex is a passage, not a
  distance: Cortlandt St, World Trade Center, Park Place and Chambers St as one marker over **435 m**;
  Times Sq-42 St to 42 St-Port Authority Bus Terminal (386 m); 59 St, Lexington Av/59 St and
  Lexington Av/63 St; 14 St, 6 Av and the L's own 14 St; Court St to Borough Hall; Court Sq to Court
  Sq-23 St; Broadway-Lafayette St to Bleecker St; Lorimer St to Metropolitan Av; 5 Av to 42
  St-Bryant Pk; 51 St to Lexington Av/53 St; Brooklyn Bridge-City Hall to Chambers St; Botanic Garden
  to Franklin Av-Medgar Evers College; New Utrecht Av to 62 St; Livonia Av to Junius St.

That is **463 markers before and 444 after**, and it leaves Fulton St (four records), Times Sq, and
Jackson Hts-Roosevelt Av with 74 St-Broadway one marker each, and the three Canal St stations — the
J/N/Q/R/W/Z/6 complex, the 1 at Varick St and the A/C/E at Sixth Av — the three separate stations
they were.

**The floor is on the masks and nothing else.** Every shape a route runs is still drawn, so a line
that passes through a station whose mask no longer names that route is correct and expected: the
track is there, the service is not.

**Every station sits on a line of every route that serves it.** The check measures the whole
geometry — the true perpendicular distance from the station to the nearest segment of any drawn line
of that route — and all **956 pairs are within 8.5 m**, all but one within 4.3 m. The one is 96 St-2
Av on the Q: all nine of the MTA's Q shapes stop 103 m short of the terminal platform, so no variant
of the route reaches it and none can be swapped in. Instead both drawn Q lines are **run on 103 m
along the heading their own last segment arrives on**, up Second Avenue, which leaves the platform
8.5 m off the axis (that heading is 4.6° off the bearing to the platform). That is the only
extension in the file, and the rule that made it is deliberately narrow: at most 250 m of run-on, at
most 25 m of offset, and the station must lie *ahead* of the line's end. Anything else is reported
and left alone — track that bends towards a marker is invented track.

Stations are sorted south to north, then west to east, then by name — the order the point sources
are written in.

**Which shapes — all of them.** A route runs up to 35 shape variants (35 for the 5 alone): each
direction, express and late-night patterns, rush-hour put-ins, reroutes. **Every one is drawn.** A
variant is real service on real track, and thinning them to a representative set is a rendering
decision the ingest has no business making — several variants of a route sharing a trunk is the
renderer's problem, solved with an offset, and it cannot be solved at all with data that was thrown
away. Two things are dropped, and only two:

- **Exact duplicates.** A variant whose vertices are identical to one already taken adds nothing a
  renderer can see. Variants that merely *share* track are all kept.
- **Reverse-direction variants that retrace.** Every `direction_id` 0 shape is taken first; a
  `direction_id` 1 shape is then taken only if it covers track no shape of that route already
  covers. Coverage is measured on a ~30 m grid dilated by one cell — deliberately coarser than the
  two rails of a track are apart, so a shape running the opposite rail of one already drawn reads as
  covered — and the shape must add at least **20 cells, about 600 m**. That is above the few metres
  the two directions wobble apart at terminals and relay tracks and far below a branch, so a variant
  that shares a whole trunk and branches once is kept for the branch. Anything from 5 to 30 cells
  selects the same shapes out of this feed, so the number sits in the middle of a wide plateau
  rather than on an edge that decides anything.

Over the 2026-05-26 feed that is 133 direction-0 shapes, of which 42 are byte-identical duplicates,
plus **2 of the 124 direction-1 shapes** — the R's and W's West End line patterns, which run
southbound only and which nothing else in the file draws. That leaves **93 lines and 54,908
vertices** — 54,906 from the feed's shapes plus the one vertex each of the two Q lines gains from
the terminal extension above. Within a route they are ordered forward-direction first and busiest-first within a
direction, so a renderer that wants a single representative line can take the first of a route's
run.

#### San Francisco: Muni and BART (`SBWY` again, not a new format)

`scripts/subway-sf.ts` (`bun run build-subway:sf`) writes `data/subway/sf.bin` in the **same SBWY v3
layout** — same magic, same tables, no field added — from two feeds rather than one, because Muni and
BART are two agencies. The encoder, the variant selection and the transfer reading all live in
`scripts/subway-format.ts`, which both ingests write through.

| feed | url | key |
| --- | --- | --- |
| Muni | `https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip` | none — the zip SFMTA's own GTFS page links, 10.0 MiB, feed of 2026-07-23 |
| BART | `https://www.bart.gov/dev/schedules/google_transit.zip` | none — 0.9 MiB, redirects to whichever dated zip is current (`google_transit_20260810-20270108_v02.zip` at the last read), so the cache key is on the stable URL |

**No key, deliberately.** 511.org's regional feed carries both agencies in one file and is the
obvious thing to reach for, but it needs an API key this pipeline does not hold — the same wall that
keeps San Francisco's ferries unbuilt — so the two publishers' own feeds are read directly. BART's
*other* endpoint, `api.bart.gov/gtfs/google_transit.zip`, is keyless too and serves a **2013** feed;
it is not used.

**What Muni contributes.** Its rail, and only its rail. `route_type` 0 is the six Metro lines (J, K,
L, M, N, T) plus the **F historic streetcar**, which runs the same Market Street rails and is on
Muni's own system map; `route_type` 5 is the three **cable car** lines (Powell-Hyde, Powell-Mason,
California St), kept for the same reason — scheduled rail service with published colours and shapes,
and a San Francisco transit map without the cable cars is not one. The feed's other 58 routes are
buses, which are not drawn here any more than they are in New York, and which alone would overflow
the station mask's 32 routes. That is **10 Muni routes**.

**What BART contributes.** The feed splits every line into two `route_id`s — `Yellow-S` (route 1) and
`Yellow-N` (route 2) — which are the two directions of one line down one pair of rails. They are
folded into one route per colour, named by that colour, exactly as `direction_id` 0 and 1 are folded
within a Muni route: the lower-numbered `route_id`'s shapes are the primary ones and the other's have
to reach track they do not already cover. Drawing them apart would put every BART line on the map
twice, in one colour, under two names no station sign uses.

**Lines that leave the city are clipped, not dropped — unless nothing is left.** Every shape is cut
against the **same land polygons every other source here is clipped with**, the crossing found by
bisection, so BART stops at the shoreline where the streets and the canopy do rather than running out
over the bay to the corner of a bounding box. A piece shorter than 50 m is dropped as a graze. What
survives is 13.05 km of each BART line, Embarcadero to Balboa Park; **Orange** (Richmond to Berryessa)
and **Grey** (the Oakland airport connector) never enter San Francisco at all and are dropped whole,
as is anything of Muni's that leaves — nothing does. Neither feed has a shape that leaves the city and
comes back, so every drawn line is one contiguous piece. That leaves **14 routes**.

**Colours, names and order.** All from `routes.txt`: Muni publishes a colour and text colour per
route (the Metro lines' own hues, `B49A36` for the F and all three cable cars) and long names in caps
("JUDAH", "MARKET & WHARVES"); BART's colours are the line colours, and a merged line takes its
primary route's long name ("Antioch to SF Int'l Airport SFO/Millbrae"). Neither feed publishes
`route_sort_order`, so the display order is built here and recorded in that field: Muni's rail and
the F, then the cable cars, alphabetically within each, then BART's lines in BART's own `route_id`
order (Yellow, Green, Red, Blue).

**The stations.** Muni's feed has no `parent_station` column *at all* — the column New York's ingest
collapses a station's platforms with — and it publishes one stop per kerb, so an intersection served
both ways is two stops of the same name a median apart. Stops that **share a name and lie within
100 m** of one another therefore become one marker at their centroid carrying every route that calls
at any of them: 149 of the 152 same-named rail pairs are inside 100 m (76 inside 25 m), and the three
left out are genuinely different stops sharing a name (19th Ave & Randolph St is three stops spread
over 245 m). The rule runs over both agencies together; BART's own `parent_station` collapse happens
first, and its entrances (`location_type` 2) never appear in `stop_times` and so never reach it.
That is **268 stations** — 260 Muni, 8 BART (Embarcadero, Montgomery, Powell, Civic Center, 16th St,
24th St, Glen Park, Balboa Park; Daly City is in San Mateo County and outside the city).

**Neither feed publishes a complex.** Muni ships no `transfers.txt` at all, and BART's 40 rows are
all platform-to-platform *inside* one station (`K10-1` to `K10-2` at MacArthur), so neither agency
says anywhere that two of its stations are one place. Every San Francisco station record therefore
carries complex id **0**, and the client falls back to the geometric rule for the whole city — the
one New York no longer needs: records within 60 m, or within 160 m under the same canonical name.
That is 268 records down to **217 markers**, unchanged by the transfer work.

What the merge does *not* fold is a place the feed gives two different names — the Metro's
underground stations are named per direction ("Metro Powell Station/Downtown" and
"…/Outbound", 20-50 m apart), and Muni names a corner both ways round ("Church St & Market St",
"Market St & Church St"). 63 pairs of markers sit within 60 m of another, and picking a winning name
for them would be inventing one.

**A trap, since it cost a debugging pass:** a `route_id` is unique within a feed and **nowhere else**.
Muni's bus routes are named 1, 2, 5, 6, 7, 8 and 12; BART's `route_id`s for Yellow, Green, Red and
Blue are 1/2, 5/6, 7/8 and 11/12. Building the station masks against both feeds' routes at once hangs
a BART bit on every stop of seven bus lines — 689 stations instead of 268, with the Red line calling
at 172 of them. Each feed's trips are resolved against that feed's routes only.

Over these feeds, 84 shape variants have any geometry inside the city — 41 primary, 43
reverse-direction — and **42 lines with 6,182 vertices** are drawn from them: every primary shape but
the one byte-identical duplicate (BART's `001E_shp`), plus **2 of the 43 reverse shapes** — the F's
Jefferson Street loop at Fisherman's Wharf and the Powell-Hyde cable car's Washington Street leg, the
two places a Muni line genuinely runs back down a different street. The threshold that picks them up
is 5 grid cells of new track (~150 m) rather than New York's 20: San Francisco's reverse shapes
measure 0-4 fresh cells each except three, at 7, 8 and 10 (two of which are the same Washington
Street leg, so taking the first leaves the second retracing it), so anything from 5 to 7 selects the
same set — and 5 is inside the 5-to-30 plateau New York's own feed has. Drawing those two cuts the
stations sitting more than 100 m from a line of a route they are on from 12 of 367 station-route
pairs to 5, and the five left are terminal loops and a mezzanine entrance. The file is **32.5 KiB**.


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
bun run build-tree-data                  # every city; uses .cache/ if warm
bun run build-tree-data:sf               # one city
REFRESH=1 bun run build-tree-data:sf     # bypass .cache/, go back to the network
bun run build-buildings sf               # the other ingests take a city the same way
bun run build-tiles                      # every city's pyramids and graphs
```

The city is a script entry rather than an argument, and the refresh an environment variable rather
than a flag, for the same reason: the ingest is a three-command chain — fetch, `tiler ingest`,
manifest — and `bun run x -- args` appends to the LAST command in a chain, where both have to reach
the first. `bun run scripts/tree-data-fetch.ts --city sf --refresh` takes the flag directly.

Raw source reads are cached in `.cache/` (gitignored), keyed by the request itself — **including the
Socrata host**, since two cities can publish the same 4x4 dataset id and an entry serving one city's
rows for the other's read would parse and count as if it were right — and never expire on their own — including the rasters, which are kept as files rather than as JSON
because the tiler reads them off disk itself: New York's 243 MiB canopy height model, and San
Francisco's 651 3DEP tiles at 1.77 GB. The sources move about once a year, so a re-run wants whatever it
read last time — not a fresher copy it did not ask for.

`SOCRATA_APP_TOKEN`, when set, buys a request budget of its own. It only matters on a host whose
address is shared with strangers, so CI has one and a workstation does not need one.

### The ingest chain: `tiler ingest --params <file.json>`

`build-tree-data:<city>` is three commands sequenced by package.json, exactly as the tile build is:

```sh
bun run scripts/tree-data-fetch.ts --city nyc   # sources -> data/**/<id>.bin, + .build/{ingest,tree-data}.json
cargo run --release --bin tiler -- ingest --params .build/ingest.json --report .build/ingest-report.json
bun run scripts/tree-data-manifest.ts           # -> src/tree-cover/manifest.json
```

The fetch half pages the sources, encodes every `.bin` and writes two JSON files: `ingest.json`, the
model constants and file paths the tiler needs, and `tree-data.json`, the sidecar carrying what the
manifest half needs from the fetch half — the genus table, the credits and the counts. The blobs
themselves need no sidecar: the tiler fills a region of each committed file **in place**, so the
canopy's crown heights and the street and path density blobs travel by disk, and the manifest half
reads the finished bytes back for their sizes and hashes.

Which is why the two passes are one command. They ran back to back over one city and neither
returned anything the other needed; the ingest was spawning cargo only to read a number off its
stdout mid-pipeline. Now the numbers land in `ingest-report.json`, which is what a later link in a
package.json chain can read. The height pass is conditional on the city naming a canopy height model
(`ingest.json`'s `chm`, null for a city with none) rather than on TypeScript deciding whether to run
a command.

### The build plan: `tiler build --plan <file.json>`

`build-tiles` is three commands sequenced by package.json, and **no TypeScript spawns cargo**:

```sh
bun run scripts/serve-sources.ts   # data/<kind>/<id>.bin -> public/<kind>/<id>.bin, verbatim
bun run scripts/write-plan.ts      # -> .build/plan.json, and nothing else
cargo run --release --bin tiler -- build --plan .build/plan.json
```

`serve-sources.ts` copies the point/line overlays and the TREE blob the genus dots are drawn from;
it is independent of the render, so it runs every time and empties each directory it serves first.
`write-plan.ts` is a pure emitter. Everything after that — whether to render at all, the output
directories, the nine passes — is the tiler's, so the decision to do nothing is made in the same
place as the work. `.build/` is gitignored build glue: a package.json script can name no temporary
directory of the machine's, so the handoff lands at the repo root. `write-plan.ts --key-space` emits
the same plan without the elevation block, to `.build/key-space-plan.json`, which is what the shed
gate stamps its inputs off — see *What the stamp covers*.

**The freshness check is per pass.** Each of the nine computes a SHA-256 over what *it* reads: the
plan values it acts on, the content of every input file it opens, and the stamps of the passes whose
output it consumes — a hash DAG, sound because the passes are deterministic. Folded into all of them
are the manifest and a **code epoch**, the hash of `crates/tiler/src/**`, both `Cargo.toml`s,
`Cargo.lock` and `rust-toolchain.toml`; so any edit to the tiler invalidates every pass, including
one whose output *format* changed, which no input file would have moved. The toolchain is in there
because a compiler bump can move a low bit of `sin` through std or libm, and that is a shadow in a
different place. `write-plan.ts` hashes those files one at a time and the plan carries them as the
`code` map, which is what lets a pass name a scope of its own — the shade pass does, below. Content,
not mtime — a fresh checkout (CI) or a `touch` rewrites mtimes without moving a byte.

**A `.rs` file enters by its token stream, not by its bytes.** The tiler rehashes every module of
the code map through `proc_macro2` before it folds a single stamp (`Plan::hash_source_tokens`),
which drops ordinary `//` and `/* */` comments and normalizes whitespace — so a comment or a
`cargo fmt` run moves nothing, where it used to invalidate every graph column and cost a
twenty-five-minute rebake of the per-sun-position shade rows. Doc comments survive as `#[doc]`
tokens and go on counting, and a file that will not read or lex keeps the hash of its bytes: both
are the over-invalidating direction, which is the safe one. It holds only while nothing that
produces an artifact is a function of its own source layout — no `line!`, `file!`, `column!` or
`#[track_caller]`, and no `include_str!`/`include_bytes!` of a file the code map does not carry.

**The shade pass is stamped finer than a pass: one key per sun bin.** A cold one is twenty minutes,
and a bin's tiles are a pure function of that city's buildings and canopy, of *that*
bin's samples and intensity, of `maxZoom`/`maxShadowMeters` and of the shade code — not of the other
bins, and not of the schedule's shape. The key lives at `public/tiles/shade/<city>/<bin>/.stamp` and
claims the `tree-shade` twin beside it, which comes out of the same render over the same casters.

The catch is that `<bin>` is a **position** in a schedule that sorts stably by (season, hour angle),
so inserting one bin shifts the index of every later one. So the driver matches directories to bins
**by their content key, never by position**: a directory whose key is still wanted is *renamed* into
its new index — through a `.moving-<n>` staging name, since one bin's new index is usually another's
old one — a bin no directory claimed is rendered, a directory nothing claimed is deleted, and
`buckets.json` is written again from the grid on every build. It is written *before* a tile is
rendered, because the renames have already moved the tiles and a schedule naming the old indices
would send the client to another bin's; a bin the render has not reached yet is a directory of 404s,
which it reads as no shade at all. So a schedule that gains a bin costs one bin's render plus the
renames, one that loses a bin costs the renames alone, and a re-ingested `data/buildings/<id>.bin`
correctly re-renders every bin, that file being opaque and city-wide. Each bin records its key as it
finishes, so a build killed inside the pyramid keeps every bin that completed.

**Shade also names the modules it is a function of** — `shade.rs`, `crown.rs`, `raster.rs`,
`geometry.rs`, `binfmt.rs` and `manifest.rs`, the transitive closure of what `shade.rs` imports, plus
the build files — instead of folding in the whole-crate epoch, under which any
unrelated tiler edit would re-render the whole pyramid. No other pass names a scope yet, so the rest
of the crate is listed as the complement and a test asserts that the two lists together ARE
`crates/tiler/src/`: a module claimed by neither would be one no stamp is a function of, and the one
edit that leaves a stale pyramid being served.

**The graph pass is split finer still: a base topology, a column per attribute, and a cheap
assemble.** Everything through the name compaction — node identity and the renumber, the walking
sort, the ferries appended onto the finished walking node set, the ordinals over the order that
leaves — is inherently sequential, and is a function of the streets, the paths, the OSM sidewalks,
the ferries and the alley flag alone. What comes after is not: the landmark, art, highway and
commercial fan-outs, the relief bytes, the direct canopy, the industrial frontage, the historic
share and the per-bin SHDE bake are each one byte per edge over an edge list that was final before
any of them ran. So the
base is cached as one entry, each column as another, and the pass lays the blob out of whichever it
actually had to compute. Measured here on New York: 17 s of topology, 0.6 s for the four scenic
bakes, 140 s for the direct canopy, 2.4 s for the industrial frontage and around 25 minutes for the
58-bin shade bake — so a re-ingested `data/industrial/nyc.bin`, which used to cost all of that, now
costs the 2.4 s and the write.

The entries live in `.build/graph-cache/<city>/`, one file per key, named `<column>-<key>.bin`.
**Every column's key folds the base's**, and that is the whole correctness argument for merging a
column back in by POSITION: a base that moved renames every column with it, so a row can never be
read back beside an edge list it was not baked over. Ferry bytes are part of the base — ferries are
appended edges — so a ferry re-ingest correctly takes the columns with it. The SHDE bake is keyed one
sun bin at a time, exactly as the pyramid is, so an inserted bin bakes the one bin. What a build did
not ask for is pruned as that city finishes, leaving one generation, a couple of hundred megabytes a
city. None of it is output and no pass's stamp claims it: `.build/` is gitignored build glue, and a
build that finds the directory empty computes everything, which is what every build did before it
existed. The durable key space is untouched by all of this — the base is what a key comes out of, and
the same base gives the same `keyHash`, so a committed shed artifact resolves exactly as before.

**The caster chunks are keyed on `maxShadowMeters` and not on the grid.** They carry no sun position
at all; what they take from the schedule is the halo radius a viewport has to gather casters over,
which rides in their manifest. Between that and the two per-bin keys, adding a bin to a city's
schedule now costs one bucket rendered, one bin baked and some renames — where it used to cost the
262 s caster pass and the whole per-edge bake besides.

Each stamp is written **inside that pass's own output** — `public/streets/.stamp` and
`.stamp-stranded`, `public/commercial/.stamp`, `public/casters/.stamp`,
`public/tiles/canopy/.stamp`, `public/tiles/genus-field/.stamp`,
`public/tiles/shade/<city>/<bin>/.stamp`, `public/tiles/elevation/<city>/.stamp`,
`public/routing/.stamp-<city>` — and only once that pass (or, for shade, that bin) succeeds, so a
run killed halfway keeps every pass that finished and claims nothing for the one that did not. A
pass is skipped when its stamp matches **and** its own output is still there: the
stamp says the inputs have not moved, not that the output is on disk, and a hand-deleted directory
or a CI cache that restored only part of the tree has to rebuild. Existence, not completeness — an
empty directory still passes.

`scripts/*.ts` is no longer hashed at all: everything the scripts contribute reaches the stamps as
plan values (the ramp bytes, the sun grid, the resolved DEM) or as `data/**` bytes, so an
ingest-script edit alone is correctly not a rebuild until it changes what it ingests. The DEM mosaic
enters as its sorted tile names and byte sizes rather than 1.77 GB of pixels, the 3DEP tiles being
immutable upstream products in content-named cache entries. Measured: a build with nothing changed
reaches the shade pass in 0.7 s where a cold one took 278 s, and adding one source only the
commercial pass reads reran that pass alone, leaving the 262 s of caster chunks untouched.

A tile build is nine passes — chunks, commercial, caster-chunks, shade, elevation, canopy,
genus-field, graph, and the chunks again — and three of the orderings between them are
load-bearing: the commercial signals are keyed on the segment order *inside* the chunks, the
graph's commercial discount is baked from the lines that pass writes, and the chunks have to be cut
a second time once the graph has said which walks its island drop stranded. `tiler build` runs all
nine in **one process**, where each pass is a function over values, so the stranded set cannot
reach the chunk pass before the graph that computes it has run. It also opens each city's DEM
**once** and hands it to both readers — the terrain overlay and the graph's relief bytes resample
different grids over different bounds, but San Francisco's 1.77 GB of tiles are then indexed once.

The plan file carries what the nine argv lists carried, including the two things that have to come
from TypeScript because the client imports the very same modules: the colour ramp
(`src/tree-cover/ramp.ts`) and the per-city sun-position grid (`scripts/shade-schedule.ts`).
**Unknown keys are rejected** — a misspelled directory would otherwise write a pyramid nothing
serves and report success.

```jsonc
{
  "code": {                                   // the tiler's own sources, file by file, repo-relative
    "Cargo.lock": "1d8b…",                    // the whole map is folded into every pass's stamp;
    "rust-toolchain.toml": "4c71…",           // the shade pass hashes the six modules it reads.
    "crates/tiler/src/shade.rs": "9f2c…"      // .rs bytes here, token stream once the tiler has it
  },
  "manifest": "src/tree-cover/manifest.json", // every pass reads the city list from here
  "data": "data",                             // the committed sources; each pass resolves its own files under it
  "chunks": "public/streets",                 // STCK street chunks
  "casters": "public/casters",                // CSTR shadow-caster chunks
  "commercialSignals": "public/commercial",   // CMRC per-chunk signals (the pass clears this itself)
  "commercialLines": "public/commercial-lines", // CMLN qualifying-block lines, one per city
  "tiles": "public/tiles",                    // the shade, tree-shade and elevation pyramids write <name>/<city> under it
  "canopyTiles": "public/tiles/canopy",
  "genusFieldTiles": "public/tiles/genus-field",
  "routing": "public/routing",                // <id>.bin, <id>.stranded.bin, and the per-edge bake under shade/<id>
  "graphCache": ".build/graph-cache",         // the graph pass's own cache: <city>/<column>-<key>.bin
  "ramp": [0, 0, 0, 0, "…"],                  // exactly 1024 bytes: RGBA for each of 256 density steps
  "cities": [
    {
      "id": "sf",             // must name a manifest city; every manifest city needs an entry
      "alleys": false,        // does the centreline classify alleys? (default true — New York's meaning)
      "sources": ["sidewalks", "ferries", "landmarks", "art", "highways", "industrial", "historic", "buildings"],
      "shade": {              // omit for a city whose year yields no above-horizon bin
        "maxZoom": 14,
        "maxShadowMeters": 500,
        "buckets": [
          {
            "season": 0, "hourAngle": -30, "elevation": 20, "azimuth": 120, "intensity": 0.34,
            "samples": [{ "east": 0.5, "north": 0.5, "shadowPerHeight": 2.7 }]
          }
        ]
      },
      "elevation": {          // omit for a city with no elevation product: flat edges, no terrain overlay
        "crs": "sf-cs13",     // "sf-cs13" or "utm18n" — a GeoTIFF names an EPSG code, not the parameters
        "band": 0,            // which band carries the ground (default 0)
        "tiles": ["/…/x30y415.tif", "…"] // the mosaic, listed rather than pathed through a temp file
      }
    }
  ]
}
```

`sources` names the **by-convention** files, each read as `<data>/<kind>/<id>.bin`: they sit
outside the manifest because its versioned city schema would throw for existing cities if bumped,
so the driver states which of them it actually has on disk. Everything else per city — the streets,
paths, land and canopy files, the bounds, whether a genus layer exists — is read from the manifest.
A kind no pass reads is rejected.

**Each pass owns the lifecycle of its own output.** Nothing is emptied before the first pass any
more: a pass clears its own directories immediately before it reruns, so a fresh pass's output
survives a neighbour rebuilding — which is the whole point. `public/{streets,casters,tiles/canopy,
tiles/genus-field}` are emptied and recreated by the pass that owns them, and
`public/commercial{,-lines}` by the commercial pass, which has always cleared its own two.
`public/tiles/elevation/<city>`,
`public/routing/<city>.{bin,stranded.bin,version.json}` and `public/routing/shade/<city>` are
removed and left for their pass to remake, since a city that renders nothing must leave no directory
at all — a city that lost its buildings would otherwise keep serving the old bins. The two shade
pyramids are the same rule one level down: `public/tiles/{shade,tree-shade}/<city>` go outright for a
city that stops casting a shadow, and for a city that goes on casting, every bin directory the
schedule no longer claims goes instead — as does anything else under the pyramid, a staging name a
killed run left or a stamp an older build wrote at the top of it. A pass that renders nothing this
build clears its root and records no stamp, which is how
a layer that stops being produced stops being served and costs nothing to decide again. Before the
passes, the driver sweeps what no city claims: a pyramid or a routing artifact for a city the
manifest dropped. `public/trees` is nobody's here — `serve-sources.ts` owns it. The
gates are the same as they were under the nine subcommands, and follow from the plan: caster chunks
are cut once over every city (any
city's `shade` carries the halo) when something can cast a shadow at all; a city gets a shade
pyramid and a per-edge shade bake only with both `shade` and a `buildings` source; the canopy and
genus-field pyramids run when any manifest city carries that layer; and the second chunk pass runs
only when some city has paths.

### Building one pass: `--only` and `--force`

```sh
bun run build-tiles:graph                          # --jobs half --only graph
bun run build-tiles:shade                          # --jobs half --only shade
bun run build-tiles:half -- --only commercial,graph # anything else, appended to the tiler
bun run build-tiles:half -- --only graph:nyc --force
```

`--only` names the passes this build may run, comma-separated, each optionally narrowed to one city
as `<pass>:<city>`. The nine names are `chunks`, `commercial`, `caster-chunks`, `shade`,
`elevation`, `canopy`, `genus-field`, `graph` and `chunks-stranded`; the three that are stamped one
city at a time — `shade`, `elevation`, `graph` — are the three a city can be named for, and a city
on any of the others is rejected rather than quietly ignored, as is a pass name or a city id nothing
answers to. `--force` runs the selected passes whether or not their stamps hold. With no `--only`
that is all nine, which is a build from scratch.

What it is for is the one thing the stamps are deliberately coarse about: the **code epoch** is the
whole crate, so an edit anywhere in the tiler invalidates all eight passes that name no scope of
their own, and iterating on one pass's code would otherwise re-render everything each time. `--only graph` then reruns the pass being worked on
and leaves the rest of the last build standing. The two named scripts are the two passes that are
worth minutes rather than seconds and so the two anyone iterates on; anything else is cheap enough
to reach through `build-tiles:half -- --only …`, which appends to the tiler because it is the last
command in that chain.

**This is what supersedes hand-editing `.build/plan.json`** — copying the plan, deleting the `shade`
block and running the tiler against the mutilated copy, which is what people did under the
whole-build stamp. The two are not the same power. Deleting a block took that pass's inputs out of
what the build hashed, so the build then recorded a stamp claiming everything was current over
inputs it had never read, and the staleness was invisible from then on. `--only` cannot forge
freshness that way, because it restricts which passes may run **and nothing else**:

- a pass it leaves out does not run, **records no stamp**, and **clears no directory** — whatever
  claim that pass already held stands, stale if it was stale, and the next full build reruns it;
- no stamp is ever written that a full build would not have written the same;
- a selected pass whose upstream output is **missing** is an error naming the pass to run first —
  `--only graph` with no `public/commercial-lines` says so before the first pass rather than baking
  a graph with no commercial discount and stamping it as though it had one. Output that is merely
  *stale* is fine and is the point;
- a selected pass whose upstream is not running folds the stamp that upstream **actually recorded**,
  not the one it would record if it ran. So `--only graph` over stale commercial lines records a
  graph stamp describing the lines it really read, and the next full build — which reruns the
  commercial pass and so moves that stamp — reruns the graph with it. Fold the computed stamp
  instead and the partial build would claim to have been built over output nobody had produced yet,
  and the full build afterwards would find the graph current and leave it standing on stale bytes
  for good;
- `--force` reaches only the selected passes: a stamp set aside for one is not a stamp set aside for
  all of them. A forced pass recomputes rather than reading back what it cached, so a forced `shade`
  re-renders every bin and a forced `graph` discards that city's `.build/graph-cache/<city>` entries;
- a partial build sweeps nothing. The reconcile that takes away output for a city the manifest
  dropped reaches into directories belonging to passes `--only` may not have selected, so it is left
  to the next full build.

CI never passes either flag.

### Where the tile build spends its time

**These are the costs of computing each thing once.** Every one of them is now behind a stamp, so
what a given build actually pays is whichever of them its inputs moved. Measured on the real two-city
plan: a cold build is 3893 s, a re-run with nothing changed is 0.2 s with all nine passes up to date,
and adding San Francisco's historic districts — a source only the graph reads — was 0.3 s, taking
that city's topology from cache and baking the one new column. A build stopped inside the pyramid
keeps the bins that finished: killed after nine, the next run reported 49 of 58 left to render.

(The smaller figures quoted while this was being built — a 0.4 s cached graph against 255 s from
scratch, 262 s of caster chunks — came from reduced scratch plans with a few sun bins over a small
window, and are not comparable to the whole-city costs below.) Read the figures below as what a first
build, or an edit to the tiler, has to pay for — not as what a re-run costs.

The pyramid is a few thousand webp tiles across z9–z15, rendered across the rayon pool a tile
at a time. Two rasterizers dominate, and both lean on a spatial index so a tile touches only the
sources that can reach it, and both send a tile with nothing in it straight to the one shared
blank webp:

- **The canopy fill (the canopy pass).** The ~1.08 M LiDAR polygons are far too many to test per
  tile, so a uniform grid over their bounding boxes (CSR-style) hands each tile only the few
  hundred whose box overlaps its haloed extent. Those are rasterized even-odd at **4× supersample**
  and averaged back down for edge anti-aliasing, then an **isotropic Gaussian** (σ_fill in pixel
  space, skipped below half a pixel, haloed by 3σ so tiles do not seam) grades the shade out past
  a crown before the land clip and the ramp.
- **The genus dots (the genus-field pass).** A uniform **60 m index over the trees**, flat arrays,
  CSR-style: a tile scans only the buckets a dot can reach, and a tile with no tree whose disc
  spills into it goes straight to the blank webp. Each tree is a single anti-aliased disc, so this
  pass is cheap next to the polygon fill.
- **The shadows (the shade pass).** A cold one runs the whole plan once per sun-position bin (58 of
  them), around twenty minutes: 25–31 s a bin over New York's 3616-tile plan for the buildings' six
  sun-disk samples and the crowns' single one together, plus a one-time 20–23 s to slice every crown
  — the per-bin figures are measured in DESIGN.md, *Shade* → *Known gaps* → *The stretched crown
  shadow*, which is where to look rather than here. The tree pyramid comes out at ~88% of the building pyramid's bytes and
  paints about the same fraction of the plan (43.7% against 42.5%), so it roughly doubles what the
  shade tiles cost the deploy. It is stamped a bin at a time, so a schedule tweak costs one bin and
  unmoved footprints cost nothing.

- **The graph (pass 8) is the longest pass**, ~28 minutes for New York, and almost all of it is the
  per-edge shade bake: the same sweep once per sun bin against every edge's polyline rather than
  against a tile, 58 bins over 628k edges for around 25 minutes. The sequential topology under it —
  everything through the name compaction — is **16.7 s**, and the direct-canopy integration beside
  the bake is **139.8 s**. That ratio is why the pass caches a base and a column per attribute, and
  keys the shade column one bin at a time.

`tiler ingest` is heavy in the same way, though it is not one of the nine passes: it convolves the
same canopy indicator at both sidewalks of every street and path vertex, and draws a seeded
million-point land sample for the reported distribution (below). Each pass prints its own tile,
painted-tile and byte counts as it finishes.

## Committing the binaries: `sl` will silently corrupt them

`data/**/*.bin` are build *inputs*, tracked in **Git LFS** (see `.gitattributes`) — every one of
them but `data/historic/*.bin`, which is tens of kilobytes and committed plainly. They are
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

The genus overlay renders this file two ways: the genus-field pass bakes each tree's disc into
lossless DATA tiles of per-genus crown density (`public/tiles/genus-field`, z9–14, the zoomed-out
view, shaded client-side by `components/genus-gl-layer.tsx`), and the blob itself is served at
`public/trees/<id>.bin` so the client (`components/tree-dots-layer.tsx`) draws the dots live as
crisp canvas discs from z15 up, where an upscaled raster tile would blur.

So the legend can toggle one genus at a time, the density is kept per genus rather than pre-coloured:
three genera ride in one tile's R/G/B, four tiles cover all twelve, and the shader reads only the
enabled channels. Toggling a genus is a uniform write, so a region hands off to its runner-up instead
of going blank; the live dots (`components/tree-dots-layer.tsx`) filter by the same selection.

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
zeroed and `tiler ingest` fills it in place from the separate canopy height model (above); **0
means unknown**, not flat. Read the geometry alone with the generic `read_polygons(path, "CNPY", 2)`
— which is what `tiler ingest` (convolving and sampling it into the streets/paths density blobs),
the canopy pass (rasterizing it into the fill pyramid) and the graph pass (integrating it *unblurred*
along each sidewalk into the direct-canopy edge byte) do — or with the heights through `read_canopy`.

### `data/landmarks/<id>.bin` and `data/art/<id>.bin` — the scenic POIs, magic `LMRK` / `ARTW` (v1)

The **point layout**: the 40-byte header, then `count` (longitude, latitude) varint-delta pairs,
sorted by quantized (latitude, longitude) so a delta steps along a row, then a **trailing name
blob** — per point, in that same sorted order, a `u16` UTF-8 byte length and its bytes (empty when
the source named none). Written by the shared `encodePoints` encoder. Two sources share it under
their own magic: `LMRK` (LPC landmarks, named by `lpc_name`) and `ARTW` (public art, named by the
PDC `title` or the OSM `name`). The graph pass snaps each point to the nearest walking node, fans a
bounded shortest-path tree out from it, and deposits a network-distance-decaying discount on the
edges it reaches — so the router mildly prefers routes that pass near them; it reads only `count`
points from the header and **ignores the name blob**, which is client-only (the map overlay draws
the names as labels). The blobs are served verbatim to `public/{landmarks,art}/<id>.bin` for the
overlay.

**`data/dining/<id>.bin` (`DINE`)** and **`data/openstreets/<id>.bin` (`OSTR`)** use the same point
layout (name blob empty), for the commercial overlay's "cute" signals. **`data/landuse/<id>.bin`
(`PLUT`)** is the point layout with a **trailing class byte per point** (the land-use digit 1..5) in
place of the name blob, via `encodeClassifiedPoints` — mirroring how `TREE` appends parallel per-point
bytes. All three are consumed only at build time by the commercial pass (see "The sources").

### `data/highways/<id>.bin` — the nuisance lines, magic `HWAY` (v1)

The **`LAND` polygon layout** exactly, under its own magic: each highway or above-ground-rail polyline
is one **open ring of a single-ring polygon** record, so the shared `encodePolygons` encoder and
the generic polygon reader carry it with no new format. Unlike the walking network these are never
routed — a later phase rasterizes them into an areal proximity field and turns nearness into a
per-edge routing *penalty* (the mirror of the POI discount). Nuisance is areal, not path-bound, so
the geometry is raw (undensified); the field's kernel does the smoothing.

### `data/industrial/<id>.bin` — the industrial tax lots, magic `INDL` (v1)

The **`LAND` polygon layout** exactly, under its own magic: the same 40-byte header, then `count`
even-odd polygons of varint-delta rings, and nothing after them. Written by the shared
`encodePolygons`, read by `src/tiles/industrial.ts`.

A lot whose footprint is a multi-part MultiPolygon expands to several polygon records, as `BLDG`
splits a multi-part building. Lots are clipped to the coastline by whether **any vertex** is on land
rather than by their centroid — the city boundaries cut the water away, and a waterfront lot reaching
past the bulkhead tests as land only where it meets the shore. Neither city lost a lot entirely at
the last read.

The two cities do not share a source, because no two cities record land use the same way, and the
file is the whole of what they have in common: the graph pass reads polygons and never asks where
they came from.

**New York** is PLUTO's `LandUse = '06'` (industrial & manufacturing) and nothing else: at the
2026-08-19 read, 9,295 lots are 9,310 records, 0.31 MiB.

**San Francisco** publishes no per-parcel land-use code, so its industry is assembled from two
DataSF datasets (`scripts/sf.ts`, `fetchSfIndustrial`). Land Use `c5ge-t6pj` carries floor area per
category rather than a class, and **PDR** — Production, Distribution & Repair — is the city's own
name for industry, so a parcel whose PDR floor area beats every other category is industrial by use.
That only sees buildings, though: a truck yard or a vacant industrial block has no floor area at all.
Zoning `3i4a-hu95` (`gen = 'Industrial'` — PDR-1-G, PDR-2, M-1, SALI …) does see those, and is the
**fallback, not the filter** — only about half the PDR-dominant parcels sit inside industrial zoning,
so requiring it would discard the other half. A parcel is therefore industrial if it is
**PDR-dominant**, OR it has **no recorded use of any kind and its centroid is inside industrial
zoning**. The parcel table's `geography_type = 'analytical'` rows are dropped first: they are named
analysis districts (the whole Presidio, all of Treasure Island, the blocks of Mission Bay South)
carrying modelled floor areas over polygons up to 2.1 km², and the real industrial land under them is
in the table as ordinary parcels anyway. At the 2026-08-20 read, 2,085 parcels qualify by use and 489
by zoning: 2,574 parcels, 2,577 records, 0.12 MiB.

Two things read it. The client, served verbatim as `public/industrial/<id>.bin` by
`serve-sources.ts`, fills every lot in one colour for the overlay. And the **graph pass** samples it
into the per-edge industrial byte (GRPH byte 36, `crates/tiler/src/industrial.rs`): every edge's own
polyline is walked a metre at a time and each sample probes 15 m to either side, a side scoring half
where its probe lands in a lot or within 12 m of one, so the byte is the length-fraction of the walk
fronting industrial land and a street with yards on both sides reads exactly twice one with yards on
one. A bridge or tunnel deck reads 0 whatever is under it. Deliberately not the commercial pipeline's
gate-then-`line_proximity` route: a Gaussian's tail reaches the residential street T-ing into a yard,
and its peak is a distance where what a walker minds is an amount.

### `data/historic/<id>.bin` — the designated historic districts, magic `HDST` (v1)

The **`LAND` polygon layout** exactly, under its own magic: the same 40-byte header, then `count`
even-odd polygons of varint-delta rings, and nothing after them. Written by the shared
`encodePolygons`. Both cities have one; a city with no source writes no file, and every edge of its
graph then reads 0 and the slider gates itself off, so the factor lights up from the file's
existence alone — the only thing it does not light up by itself is the hand-authored per-city
overlay list in `src/cities.ts`.

A district whose boundary is a multi-part MultiPolygon expands to several polygon records, as `INDL`
splits a multi-part lot. Districts are clipped to the coastline by whether **any vertex** is on land
rather than by their centroid, for the reason the industrial lots are: a boundary drawn around a
waterfront block runs out over the water, and the harbour districts (Governors Island, Ellis Island,
South Street Seaport; Northeast Waterfront) meet the coastline only at the shore. At the 2026-08-22
read no district in either city missed entirely: New York's 159 districts are 187 records, 23,002
vertices, 59.4 KiB, and San Francisco's 23 are 30 records, 1,558 vertices, 4.7 KiB. Small enough to
commit plainly — these are the one `data/*.bin` **not** tracked by git-LFS.

New York's geometry comes from the **LPC's own ArcGIS FeatureServer**, not from Socrata. The
dataset the city catalogues as "Historic Districts (Map)" (`xbvj-gfnw`) is a map *visualization*,
not a table:
its SODA rows come back as `{}` and its GeoJSON geometry as `null`, though `count(*)` passes through
to the table underneath. That table, `skyk-mpzq`, does carry geometry — but in **state-plane feet
(EPSG:2263)** rather than lon/lat, and it is **missing 18 designated districts**, among them the Park
Slope, Upper East Side, SoHo-Cast Iron and Greenwich Village extensions and Murray Hill, Carnegie
Hill, Vinegar Hill and East Village / Lower East Side outright — about a third of Park Slope's
landmarked area would simply not draw. DoITT's `HistoricDistrict_view` mirror is likewise stale (157
features, nothing designated after 2024-06-25). The LPC service is a strict superset of both, serves
`outSR=4326` on request, and is the table the copies are cut from. It is designated-only —
`STATUS_OF_BOUNDARY`, `LAST_ACTIO` and `CURRENT_STATUS` read DESIGNATED/DESIGNATED/Yes on every row —
so the read needs no `where` clause; calendared and proposed districts are a separate service.

Extensions are their own rows (25 of the 159), sitting flush against their parents, so a plain fill
draws a parent and its extensions as one continuous area. Four pairs genuinely **overlap**, each an
older small district later enclosed by a larger one — Carnegie Hill inside Expanded Carnegie Hill,
the two Central Park West block districts inside Upper West Side/Central Park West, and DUMBO against
Fulton Ferry. They are left undissolved, so those four patches paint twice and read darker.

San Francisco's comes from **DataSF `63x5-g3m4`**, "Historic Districts", which is Planning's own
table and holds every district anything has recognised — 204 rows, real WGS84 MultiPolygons on all
of them. What narrows it to a designation is `a10` and `a11`, the two Planning Code articles:
**Article 10** landmark districts (16) and **Article 11** downtown conservation districts (7), 23
together. The remaining 180 are National- and California-Register or survey districts carrying no
local designation, and a district can appear under several programmes at once — Jackson Square is
three rows, one per programme, of which only the Article 10 one is a city designation. The flag's
value is the string `Listed`, so `a10='Yes'` matches nothing and would write an empty artifact.

Two decoys sit beside it. "Map of Historic Districts" (`y75h-nbt2`) is the same trap `xbvj-gfnw` is:
a map visualization over the same table, `count(*)` passing through while every row reads back `{}`.
And the dedicated "Landmark Districts" table (`knm6-5ej6`) looks like the obvious answer and is not:
last updated 2023, only 14 of the 16 Article 10 districts (missing both adopted 2026-02-13), no
Article 11 at all, names uppercased, and multi-part districts split across rows. Planning's ArcGIS
`Preservation_Districts_All` mirror is stale the same way (187 features against Socrata's 204).
The two articles do not overlap each other, and the only intersections anywhere in the 23 are
digitizing noise — South End against Clyde and Crooks is under 2 m². Individually landmarked
BUILDINGS are elsewhere, as in New York: Article 10 landmarks in `97yj-54sx`, Article 11 building
ratings in `6m3x-8fu4`.

Two things read it. The client, served verbatim as `public/historic/<id>.bin` by
`serve-sources.ts`, which fills every district in one colour for the overlay. And the graph pass,
which bakes it into the per-edge historic byte (GRPH byte 37, `crates/tiler/src/historic.rs`): every
edge's own polyline is walked a metre at a time and each sample is tested UNDERFOOT, so the byte is
the length-fraction of the walk that falls inside a designated district. Deliberately not
`industrial.rs`'s sideways probes, though both read polygons — those exist because a walker is never
*in* a tax lot, where a district outline covers the street bed the walk is on, and probing would
smear the discount one street-width past a boundary the designation drew where it did on purpose.
A bridge or tunnel deck counts, unlike industrial's: a yard passes under a viaduct, where a viaduct
through a district is still amid its fabric. Overlapping districts need no dissolve —
`PolygonSet::contains_point` ORs its candidates, so an overlap reads as the union it is.

### `data/buildings/<id>.bin` — the footprints and their heights, magic `BLDG` (v1)

The **`LAND` polygon layout** (the same 40-byte header, then `count` even-odd polygons via the shared
`encodePolygons` body), followed by **two parallel trailing regions**, each one `u16` little-endian per
polygon in the same polygon order — mirroring how `TREE` appends its parallel crown/genus bytes. First
the **roof height** in **decimetres**; then the **base (ground) elevation** in decimetres, stored
biased by `+ELEVATION_BIAS_METERS` (100 m) so the shoreline's slightly-negative bases stay in the
unsigned range — recover it as `decimetres / 10 − 100`. A building whose footprint is a multi-part
MultiPolygon expands to several polygon records, each repeating that building's height and base, so both
regions stay parallel to the polygons. Written by `encodeBuildings`. The shade pass reads the heights
for the shadow pyramid and the graph pass for the per-edge shade bake (the `SHDB` artifact, not the
GRPH edge record); the base elevations are still unread — folding them in would make the casters
terrain-aware, and bare-earth self-shadowing (hills/parks with no buildings) would need the separate
1-ft LiDAR DEM.

### `data/streets/<id>.bin` — the network, magic `STRT` (v6)

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
| 23 | u8 | flags: bit0 vehicular-only (`nonped='V'`), bit1 non-vehicular deck (`trafdir='NV'`), bit2 structure (a bridge or tunnel), bits 3-6 the per-side sidewalk bits below |

`nonped='V'` streets are drawn by the overlay but a router must never walk them, so the router
drops any segment with bit0 set. **Bridges and tunnels (rw_type 3/4) are included only when they
carry pedestrians** — the ingest's `$where` keeps `rw_type in (3,4)` rows only where `nonped` is
null or not `'V'`, so the Brooklyn Bridge promenade and the six other walkable East River decks
come in while the vehicular-only spans stay out. A non-vehicular deck (bit1) is itself the walking
surface and gets no sidewalk offset; a vehicular bridge or tunnel has sidewalks like a street and
is offset by its width.

**The per-side sidewalk bits (v6, flags bits 3-6)** say what each of the segment's two sides
actually carries, from the two sources `scripts/sidewalks.ts` reads:

| bit | set when |
| --- | --- |
| 3 | an OSM `footway=sidewalk` way flanks the **left** side |
| 4 | the same on the **right** side |
| 5 | the NYC planimetric ROW-sidewalk polygons draw one on the **left** side |
| 6 | the same on the **right** side |

Left and right are the digitization direction's — left is 90° counter-clockwise of travel, the
same convention the density blob's two bytes a vertex are ordered by and the one
`crates/tiler/src/sidewalks.rs` offsets the left sidewalk along. A side is *mapped* when the
corridor matcher finds an OSM sidewalk at ≥ 50% of the samples it takes every 20 m (perpendicular
distance in [2 m, half-offset + 12 m], bearing within 30° mod 180°, side by cross product), and
*surveyed* when a probe every 15 m — each fanned across the sidewalk's own width, ±1.5 m where CSCL
records a `streetwidth` and −3 to +6 m in 1.5 m steps where it records none and the half-offset is
the citywide median standing in for it — lands inside a `sub_code` 380000 polygon at ≥ 50% of its
stations. "Surveyed", not "paved": the layer
says the city's aerial survey drew a sidewalk there, and says nothing about its material. All four
bits are **zero unless the segment is offsetted** (not `nonped='V'`, and a non-zero half-offset),
since a street with no derived sidewalks has no sides to ask about.

The graph pass reads them as the **existence gate**: a side has pavement at all if OSM maps a sidewalk
there **or** the survey draws one, and a street both of whose sides come back silent is **demoted to
its centreline** as a path edge. Existing is not the same as being *derived* — where OSM maps the
pavement, OSM's own way is the sidewalk edge, and the per-stretch exclusivity under
`public/routing/<id>.bin` cuts the derived offset back out of exactly the stretches it covers, so a
side OSM maps end to end gets no derived edge at all. Both sources are needed and neither alone will
do — OSM's silence is ambiguous (a mapping gap or genuinely no pavement: 40.5% of Bronx km is
unmapped where only 24.0% is really bare), the survey's is authoritative. Demotion is never deletion:
an alley has no sidewalk, but you walk the alley. Measured, the gate's own bits leave **15.4% of the
two-sides-a-street an unconditional derivation would place** with no pavement from either source
(Manhattan 11.0%, Brooklyn 11.1%, Queens 14.9%, the Bronx 17.2%, Staten Island 24.7%) and demote
**98.7% of alley km**; an OSM-only gate would have taken 48.4% of the Bronx. What the build reports
as `droppedSidewalkFraction` is a shade lower — 14.4%, and 97.2% of alley km demoted — because it
scores the gate's bits **or** a stretch OSM covers, which is the pavement the corner fan actually
works from: a run OSM maps is evidence the pavement is there whether or not it is enough of the side
to set the bit. Two build guards stand behind that number, both catching the rule being wrong rather
than the data being unusual: over 30% dropped citywide is an error (a STRT file whose bits were never
stamped reads as a city with no pavement), and so is under 95% of alley km demoting (the rule the
wrong way round).

Then the **coordinate blob**: per segment, `vertex count` (longitude, latitude) varint-delta
pairs, the first from the origin.

Then the **density blob**: the canopy cover at each vertex, a covered fraction of 0..1 quantized
to 0..255 — **two bytes per vertex**, the left sidewalk then the right, in the vertex order of the
coordinate blob. It is a fixed-size trailing region, and the ingest is the only writer that
leaves it empty: scripts/tree-data-fetch.ts writes the file with the blob zeroed, then `tiler ingest`
offsets the sidewalks from the coordinates it just read back and fills the blob in place.

Finally the **name blob**: a `u32` count of distinct names, then each name as a `u16` byte length
and that many UTF-8 bytes, back to back. The names are CSCL's normalized `stname_label` ("W 60
ST"), trimmed, deduped and sorted; a segment's record points at one by index (record offset 10),
or carries `0xFFFF` where the row had no label. Read once, sequentially — a build input for the
graph, not shipped to the client, so an offsets table would be ceremony.

### `data/paths/<id>.bin` — the OSM pedestrian/park network, magic `PATH` (v1)

**Byte-for-byte the STRT layout above** — the same 64-byte header, 24-byte records, coordinate
blob, zeroed density blob (filled in place by `tiler ingest`) and trailing name blob — so one
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
ways' **uppercased** `name` tags, deduped and sorted, in PATH's own index space; the graph pass
concatenates them after the street names and offsets the path name-ids by the street name count.
This is a committed **ODbL** source: it is an extract of OSM geometry, so its share-alike terms
follow it (see `data/README.md`).

### `data/sidewalks/<id>.bin` — the OSM sidewalk extract, magic `SWLK` (v1)

**Byte-for-byte the STRT layout too** — the same header, records, coordinate blob, density blob and
name blob, so the same reader serves it. It holds the OSM ways that describe a *street's own*
pavement, the exact set the PATH ingest excludes: `footway=sidewalk`, `footway=crossing` and
`footway=traffic_island` (crossings chain through median islands, so leaving the islands out would
cut every median crossing in two). Per 24-byte record, where it differs from STRT:

| offset | type | STRT meaning | SWLK meaning |
| --- | --- | --- | --- |
| 0 | u32 | physicalid | **OSM way id** (the ingest drops any way whose id exceeds a u32) |
| 10 | u16 | name id | index into SWLK's own name blob (`0xFFFF` unnamed — 98.7% of them) |
| 20 | u8 | rw_type | **kind: 20 = sidewalk, 21 = crossing, 22 = traffic island** |
| 21 | u8 | street width | **0** — these have no roadway of their own |
| 22 | u8 | posted speed | **0** |
| 23 | u8 | flags | **bit2 structure** only (a bridge/tunnel deck or a non-zero `layer`) |

The kinds sit outside CSCL's `rw_type` range (1..10) and PATH's 6/7 on purpose: a reader pointed at
the wrong file gets a kind it cannot mistake for a road type. Geometry is land-clipped and
densified at 25 m exactly as PATH's is, but the density blob stays zeroed and **no pass fills it**:
`tiler ingest` never samples this file. A sidewalk edge takes the cover byte of the street side
the association matched it to instead, and one with no street beside it carries 0. This is a
committed **ODbL** source, like PATH (see `data/README.md`).

### `data/ferries/<id>.bin` — the ferry network, magic `FERR` (v2)

The time-independent ferry graph consolidated from the two NYC ferry GTFS feeds (above). Little-
endian; coordinates quantized to `COORD_SCALE` (1e-6°) about the south-west origin, exactly the
shared codec. Read by a later phase's routing graph; it carries no density blob (the ferry cost is
`rawTimeSeconds`, not canopy) and does not enter the manifest.

Header, 56 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `FERR` |
| 4 | u16 | format version = 3 |
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

### `data/subway/<id>.bin` — the subway route lines and stations, magic `SBWY` (v3)

The subway system's route geometry and its station markers, each route with its published colour and
names and each station with the set of routes serving it, so a renderer can draw one route at a
time — and one marker per station, or a bullet per line at it — without opening a second file. The
polyline body is the `HWAY` polyline idea (varint-delta vertices about a south-west origin) with an
explicit line table in front of it, and the station record is `FERR`'s stop record plus a route mask.
Little-endian throughout; coordinates quantized to `COORD_SCALE` (1e-6°), exactly the shared codec.
Never routed and never in the manifest; served verbatim to `public/subway/<id>.bin`.

Header, 60 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `SBWY` |
| 4 | u16 | format version = 3 |
| 6 | u16 | header bytes = 60 |
| 8 | u32 | route count R |
| 12 | u32 | line count L |
| 16 | f64 | origin longitude, degrees |
| 24 | f64 | origin latitude, degrees |
| 32 | f64 | coordinate scale, degrees per quantized unit |
| 40 | u32 | station count S |
| 44 | u32 | geometry blob offset, from the start of the file |
| 48 | u32 | geometry blob length |
| 52 | u32 | name blob offset, from the start of the file |
| 56 | u32 | name blob length |

Then the **route table** (R × 16 bytes), the **line table** (L × 8 bytes) and the **station table**
(S × 20 bytes), back to back after the header, so their offsets are implicit (`60`, `60 + 16·R` and
`60 + 16·R + 8·L`); the geometry and name blobs carry explicit offsets because they are
variable-length.

Route record, 16 bytes — routes are in the MTA's own `route_sort_order`, so walking the table builds
a legend in map order:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[3] | `route_color`, RGB — the line's colour, straight from the feed |
| 3 | u8[3] | `route_text_color`, RGB — the colour of the letter inside the bullet |
| 6 | u16 | short name id, an index into the name blob (the "1", "A", "S" a rider says) |
| 8 | u16 | long name id (the corridor; the only thing telling the three `S` shuttles apart) |
| 10 | u16 | index of this route's first line in the line table |
| 12 | u16 | how many lines this route owns — they are contiguous, so one route is one slice |
| 14 | u16 | `route_sort_order`, the MTA's display order (`0xFFFF` when the feed gives none) |

Line record, 8 bytes — one polyline:

| offset | type | field |
| --- | --- | --- |
| 0 | u32 | geometry offset within the geometry blob |
| 4 | u16 | vertex count, at least 2 |
| 6 | u16 | owning route index, so a line read on its own still knows its colour |

Station record, 20 bytes — `FERR`'s stop record with a route mask and a complex id on the end.
Stations are sorted south to north, then west to east, then by name, so a renderer can rely on the
order:

| offset | type | field |
| --- | --- | --- |
| 0 | i32 | longitude, quantized |
| 4 | i32 | latitude, quantized |
| 8 | u32 | station name id, an index into the name blob |
| 12 | u32 | route mask — **bit *i* set means route *i* of the route table serves this station** |
| 16 | u32 | complex id, from 1 — the component of the feed's own `transfers.txt` this station is in, or **0** where the feed publishes no station-to-station transfer |

The mask is a bitmask rather than a per-station list because 29 routes fit one word with room to
spare, which makes "does this route stop here" a single test and the whole set one read; the encoder
refuses to write a 30th route rather than silently dropping the ones that no longer fit. A bit is
set only where the route clears the service floor above, so a route whose track passes through is
not necessarily in the mask. Five routes is the widest mask in the city — nine stations reach it,
DeKalb Av and W 4 St-Wash Sq among them — and 199 stations are served by exactly one route.

Then the **geometry blob**: per line, `vertex count` (longitude, latitude) zigzag-LEB128 varint delta
pairs. The **first pair is the absolute quantized position** (delta from the origin) and the rest are
from the previous vertex — the `FERR`/`GRPH` geometry convention. Zero-padded to a 4-byte boundary
so the name blob starts aligned.

Finally the **name blob**: a `u32` count of distinct names, then each name as a `u16` byte length
and that many UTF-8 bytes — the `FERR`/`GRPH` trailing-name-blob layout. Route short names, route
long names and station names share the one deduped, sorted table, so every name id in the file
indexes it. There is no unnamed sentinel: a name the feed leaves empty gets the index of the empty
name.

The complex id is what the client merges records into markers on: two records sharing a non-zero id
are one place however far apart they lie, and a pair where either carries 0 falls back to distance
and name. New York's 496 records make **444 markers**, San Francisco's 268 make **217**.

At the 2026-05-26 feed: **29 routes, 93 lines, 54,908 vertices, 496 stations in 444 complexes, 956
station-route pairs, 429 distinct names, 171,667 bytes.**

v2 is the same file with a 16-byte station record and no complex id, which the client merged records
by distance and name alone; nothing that reads it is deployed, so v2 is not accepted.

### `public/ferry-schedule/` — the ferry timetable, magic `FSCH` (v1, derived, **committed**)

FERR above flattens the whole timetable into one crossing-plus-average-wait figure per stop pair,
because a time-independent cost has nowhere to put anything else, and the graph pass bakes that
figure into the routing graph. This is the timetable itself, kept out of the graph so it can be
refreshed without one. Baking it in would mean rebuilding `public/routing/<id>.bin`, which is the
graph pass — 28 minutes for New York from cold, and a deploy only reruns it at all when that city's
graph stamp fails. `scripts/ferry-schedule.ts` writes it,
`src/routing/ferry-schedule.ts` reads it, and the router falls back to the baked figure whenever it
is missing.

Two files per city, both **committed and never LFS-tracked** (raw.githubusercontent serves an LFS
file's pointer text, which would break the client fetch — the same rule as `public/sheds/`):

- **`<id>.bin`** — the one FSCH record in effect now.
- **`<id>-past.bin`** — every superseded record, appended whole and never rewritten. Each carries the
  day range it was in effect for, so a route planned on a past day is planned against the timetable
  that actually ran that day. Walked front to back by record length; only a day before the standing
  record's first day is worth fetching it for.

The daily job (`.github/workflows/sheds.yml`) re-reads both GTFS feeds and compares everything past
the header. That part is a **pure function of the two zips** — lanes, services and exceptions are all
sorted before they are written — so an unchanged feed produces identical bytes and the job's
"nothing to commit" path fires. A change closes the standing record the day before, appends it to
the history file, and opens a new one from today.

Header, 40 bytes, little-endian:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `FSCH` |
| 4 | u16 | format version = 1 |
| 6 | u16 | header bytes = 40 |
| 8 | u32 | first day in effect, `YYYYMMDD` |
| 12 | u32 | last day in effect, `YYYYMMDD`; **0 while this is the standing record** |
| 16 | u32 | service count |
| 20 | u32 | exception count |
| 24 | u32 | lane count |
| 28 | u32 | departure blob length |
| 32 | u32 | name table offset, from the start of **this record** |
| 36 | u32 | record bytes, padding included — what walks the history file |

Then the sections back to back, each 4-byte aligned, their offsets implicit from the counts above.

1. **Services** (count × 12): `u32 start day`, `u32 end day` (both `YYYYMMDD`), `u8 weekday mask`
   (bit 0 Monday … bit 6 Sunday), 3 pad bytes. Straight out of `calendar.txt`. A service named only
   by `calendar_dates.txt` gets a zero mask over a zero range, which never matches a weekday — which
   is exactly what an exceptions-only service is.
2. **Exceptions** (count × 8): `u32 day`, `u16 service index`, `u8 type` (1 = added, 2 = removed),
   1 pad byte. `calendar_dates.txt`, and it applies **whatever the calendar range says** — a service
   is active on a day when its mask matches inside its range, then these override.
3. **Lanes** (count × 16): `u16 from-stop name id`, `u16 to-stop name id`, `u16 route name id`
   (`0xFFFF` = none), `u16 service index`, `u16 departure count`, 2 pad bytes, `u32 offset into the
   departure blob`. A lane is **directional** — the sailings out of one terminal toward the other —
   and split by route as well, so the client can name the boat without a route id per departure. It
   is keyed by stop **name** because that is the only thing about a ferry edge that survives a graph
   rebuild (GRPH's byte-60 endpoint side table); the build fails loudly if two ferry stops share one.
4. **Departure blob**: per lane, its sailings in order, each a pair of plain LEB128 varints — the
   gap in seconds from the previous departure (the first absolute, from midnight of the service day,
   so a GTFS `25:10:00` reads as 90600) then that sailing's own crossing seconds. Both non-negative,
   so no zigzag. Zero-padded to 4 bytes.
5. **Name table**: `u32 count`, then (count+1) × `u32` byte offsets into the following UTF-8 blob —
   the GRPH name-table layout, so a name is an O(1) read. Stop names and route names share it.

The client resolves a record against a departure instant in `resolveTimetable`: the services running
on each of the **three** days around it, then per ferry edge the sailings out of each of its two
terminals, merged across routes and shifted into seconds from midnight of the routed day. Three days
because a walk beginning near midnight catches a boat on the next service day, and because GTFS
writes an after-midnight sailing as the previous day's 25:10.

### `public/streets/{x}/{y}.bin` — the chunks (derived, gitignored)

The segments touching one z12 tile. A segment goes into every z12 tile its bounding box
touches; segments are short, so the few tiles it lands in beyond the ones it truly crosses
cost nothing and cannot leave a gap at a seam. Each chunk's origin is its own tile's
north-west corner, which keeps the first delta of every segment small.

When a city carries a PATH layer, the chunks pass appends the OSM path segments to the
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
| 12 | u32 | byte offset of the stranded bitmap |
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

Then `ceil(segment count / 8)` bitmap bytes, one bit per segment in the same order, LSB first: set
when the segment is an OSM path whose whole component the graph pass dropped as an unanchored island.
The overlay skips those, since a green line is an offer to walk somewhere the router can in fact
take you. The bits live in their own trailing region rather than in each segment's header so that
the two passes over a chunk — the chunks pass before the graph, and the second one after
it — differ only there, leaving `public/commercial/{x}/{y}.bin` keyed on the segment index aligned.

Decoded by `components/street-score-layer.tsx`, which applies the offset in *pixels*.

### `public/casters/{x}/{y}.bin` — the shadow casters, magic `CSTR` (v3, derived, gitignored)

The footprints, crowns and trunks that touch one **z15** tile, so the client can generate their
shadows itself past where the baked pyramid stops — the pyramid's z15 level alone is two thirds of
its bytes, and geometry the client sweeps costs a fraction of that. The caster-chunks pass writes
them from the same `data/buildings/<id>.bin` and `data/canopy/<id>.bin` that the shade pass
rasterizes, dropping exactly what that drops: a footprint with no roof height, and a crown carrying
the canopy file's **0 unknown-height sentinel** (496,604 of 1,076,146 crowns survive), plus the
census trunks of `data/trees/<id>.bin`. A city with only some of the three sources chunks the ones
it has. `src/tiles/casters.ts` decodes and caches them and `src/tiles/sweep.ts` sweeps them; the
shade layer reads the pyramid below z15 and the sweep at and above it.

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

Then the `building record count` buildings, each:

- `varint` height, **decimetres** — a roof height
- `varint` ring count, the outer ring first
- per ring, a `varint` vertex count and that many (longitude, latitude) pairs as zigzag LEB128
  varint deltas. The delta chain runs on **across a record's rings**, so an inner ring starts from
  the outer ring's last vertex rather than from the chunk origin again.

Then the `crown record count` crowns. A crown ships as its **slices** — the nested rings
`crates/tiler/src/crown.rs` cuts it into, one per band of its height — so v3 gives it a level of
nesting a building does not have:

- `varint` height, **decimetres** — the measured crown height
- `varint` slice count (4 today, `CROWN_SEGMENTS`), outermost first
- per slice, a `varint` ring count and that many rings, each a `varint` vertex count and its zigzag
  deltas, on the same chain, which runs across the whole record

A slice can hold **several** rings or none: eroding a blob splits it long before it vanishes, and the
chunk clip splits it again. Which slice a ring is in is what says how far down the shadow it is swept,
which is why a crown stays ONE record where a building splits into one per clipped piece — a record is
what carries the slice structure. Slice 0 is the outline and slice `j` is that outline inset by
`j / 4` of the crown radius; `src/tiles/casters.ts` decodes them into a per-ring `levels` array and
`src/tiles/sweep.ts` sweeps slice `j` between the two heights, straddling the crown's widest section,
where the crown draws in to that radius.

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

Which section a record came from is what it casts by, exactly as in the shade pass: a footprint is
**swept** (its ring together with its translate, since a wall joins the roof to the ground) and a
crown is swept **slice by slice**, each between two airborne cross-sections of itself — there is still
no wall under it, but a crown spans `0.4h..h` and its shadow is the union over that range, which at a
5° sun is a smear tens of metres long. A **trunk** is swept like a footprint, and
swept **opaquely, with the buildings rather than with the crowns**: the crown layer is thinned by the
season's tau (`src/shade/phenology.ts`), where wood blocks the sun in February as well as in July.
Its swept circle is a capsule, drawn as the quad without the two round caps — the median trunk is
0.34 m across against a 0.91 m z17 pixel, so the caps are a hundredth of a pixel — and the quad is
floored at one device pixel of width, since a sliver thinner than the sample grid dashes or drops out
of the rasterizer instead of reading as the faint line it is.

A trunk's **diameter** is the dbh its crown was grown from, recovered by inverting the
`CROWN_ALLOMETRY` of `scripts/tree-data-fetch.ts` (`dbh_cm = exp(exp((ln(2r) + 0.742) / 2.414)) - 1`,
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
vertices across the city. A crown ships its outer ring alone — it is never punched, the shade pass
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

### `public/tiles/elevation/<city>/{z}/{x}/{y}.webp` — the terrain overlay (derived, gitignored)

The city's ground, tinted by height and relief-shaded, baked by the elevation pass from the DEM
mosaic. z9-z16; a tile with no ground under it is not written and the client reads the 404 as
transparent.

The DEM is several hundred one-metre GeoTIFFs on the city's own projected grid — for San Francisco
the 3DEP campaign `CA_SanFrancisco_1_B23`, 651 five-band float32 COGs (DTM, DSM, canopy height,
slope, aspect), CC0, enumerated from a STAC collection and cached whole (1.7 GB) but never shipped.
`crates/tiler/src/dem.rs` reads a set of such tiles as one surface and resamples it into a regular
longitude/latitude field, which is what the pyramid and the graph's relief bake each read rather than
the mosaic itself. Within one resample every tile is decoded exactly once — the cells are visited
grouped by tile, and visiting them in grid order instead re-decodes every tile on every row, which
measured 37,204 decodes of 651 tiles against 616. Two readers want it, though, and neither field is
written down: the elevation pass at z14 and the graph pass at z15, over different grids and different
bounds. So a build resamples it twice, once, or not at all — a city's mosaic is opened only for the
readers that are actually going to run, and the graph's relief column is cached, so a build whose
terrain and graph are both current opens nothing. What the one process buys is the open: when both
do run, `build` indexes the 1.77 GB of tiles once and hands the same `Dem` to both.

The tint is hypsometric — greens through tans to browns — stretched over the city's own height range
rather than an absolute scale, because what the layer is for is showing which of *these* streets are
the hills. The hillshade is lit from the north-west, the direction a printed relief map lights from.

### `public/routing/{id}.bin` — the routing graph, magic `GRPH` (v10, derived, gitignored)

The graph pass contracts STRT into the graph the client routes on, then expands it into the edges a
walker actually uses. For a city carrying a PATH layer it first **conflates** the OSM pedestrian/park
network (`PATH`) into the CSCL edges (`conflate.rs`). Step 0 nodes **CSCL against itself**: the
contraction below nodes segments by their endpoints alone, which is all it takes wherever the city
splits both lines at their junction — and is not how the city draws an alley. An alley's mouth is a
T onto the *interior* of the street it opens off; measured, **3,795 alley ends stand on a street
centreline (p50 0.00 m) with no node of their own**, against 63 street ends and 108 path ends that
do the same, and the next-nearest alley end is 5 m away, so the 1 m tolerance is a coincidence test
and not a weld. Each such end cuts the street there and moves onto the cut (`csclTSplits`, 3,597).
Without it the alley lattice behind a block is a walkable island nothing on the street reaches:
**269 of 312 km of alley sat off the main component, and the graph had 2,002 components against
162** — the mouths then join the pavement through the ordinary corner fan, as any other CSCL T does.
Then the paths are deduped against CSCL, noded
among themselves, deduped a second time in a wider band (a *named* way that shares no node with any
other OSM way and parallels a CSCL segment of the same name is a re-mapping of that street, not a
walk beside it), welded at at-grade crossings, their dangling entrances snapped to the nearest
**walking line**, the CSCL splits applied, and finally any dangling end left within 8 m of another
node but more than 60 m from it through the network pulled onto it — so a greenway or step street
joins the routable network, and a second mapping of an alley does not sit on top of the first as a
dead-end spur. A last pass then nodes each component nothing anchors onto the routable line it is
already standing on, within 1 m and never across a bridge or tunnel deck, so the island drop below
judges only what is genuinely out of reach. The entrance snap's continuation guard is waived below 8 m: inside the street's own
right-of-way half-width there is nothing for it to guard against, and rejecting there costs a
whole-block detour. Conflated edges carry the OSM flag (byte-23 bit3), and the pass reports
`osmPathEdges`, `weldedVertices`, `entranceSnaps` (with `entranceSnapsKerb` and
`shortEntranceSnaps`, the shares that reached a sidewalk and that the waiver accepted),
`osmTSplits`, `csclTSplits`, `dedupedOrphanWays`, `mergedDanglingEnds`, `islandTouchCuts`,
`mergedNearNodes` and `droppedOsmIslands`. The sidewalk pass reports `sidewalkWays`, `osmSidewalkEdges`/`osmSidewalkKm`,
`derivedSidewalkKm`, `osmSideKm` (the street-side length OSM owns), `osmCoveredStreets`,
`streetlessSidewalkKm`, `seamCorners`, `seamLinks`, `kerbCuts`, `suppressedCrossings` and the
repair's `seamRepairLinks`/`seamRepairMeters`/`seamRepairLongest`/`seamGaps`.

**The sidewalk network (a city's `sidewalks` source) goes through the same conflation but skips
three of its steps.** OSM's `footway=sidewalk`/`crossing`/`traffic_island` ways are noded among
themselves and against the paths — which is what makes a park entrance meet the pavement at the node
OSM already shares between them, rather than being re-invented — but they are exempt from the 6 m
dedup band, the orphan band and the weld. The dedup band was tuned to shed on-street bike lanes and
a narrow street's sidewalk sits at ~5.7 m, inside it; and welding a crossing onto the centreline it
crosses would shatter that street and hang the walk off a node in the roadbed, which is the defect
the whole swap exists to remove.

**The entrance snap targets pavement, never a centreline with sidewalks beside it.** Its candidates
are a street's sidewalk line on each side the gate found **pavement** on — the existence mask, not
the derived one, so a block OSM maps end to end still offers its near kerb rather than leaving an
entrance to find nothing or reach across the roadway for the far one — or the street's own centreline
where that line *is* the walking surface: a boardwalk, a path, a step street, a street the existence
gate demoted. Snapping
to a sidewalked centreline was a live defect at Pearl and Water St: the walk turned 90° into the
middle of the roadway and back out to reach a plaza path, because the sidewalks are offset off that
centreline only *afterwards*, so the join was placed where nobody walks. A kerb join still records
its split on the centreline — that is what cuts, and its corner node is where the walk arrives — and
`graph.rs` binds the OSM end to that corner instead of to a path node. The guard and its waiver stay
measured to the centreline, so moving the far end of the connector does not also change which
entrances are accepted. A way's own terminal endpoint is likewise no longer welded to a centreline
when it is the only way end there: nothing crosses where a way merely stops, so it is an entrance
too. Measured, mid-block joins that dead-end inside a roadway fell from **13,588 to 878** on OSM
paths, and the link edges those detours were drawn as from 22,942 to 6,143. The CSCL half of the same
defect — 1,863 nodes where a **CSCL** pathlike segment, a boardwalk or walkway CSCL digitizes as
meeting a road at its centreline, ends mid-roadway — is closed by the lone-path-end rule above, since
the snap only ever runs on OSM ways and could not reach it.

Steps 1–7 are the v1 contraction: vehicular-only segments (`nonped='V'`, flag
bit 0) are dropped; endpoints are noded by exact quantized equality then near-misses within 1 m are
union-found together; degree-2 shape joints are contracted where the two edges share a half-offset
byte, GRPH flags **and street name** (a name change mid-block is kept, so a sidewalk edge never
spans two names — reported as `nameBreakJoints`) **and their surviving sidewalk sides** (read
mirrored where the two halves are digitized in opposite directions, so a block with pavement to the
north only never contracts into one that has it to the south); polylines are pruned of collinear
vertices (endpoints kept). Then every street becomes the things a walker uses:

- At each node the incident street-ends are ordered by departure bearing; between consecutive ends
  sits a **corner node** on the gap bisector, one half-offset out (radius clamped to [1, 30] m).
- **Where OSM maps the sidewalk, OSM's way is the sidewalk edge.** `association.rs` matches every
  SWLK way against the CSCL street it flanks — 2 m to half-offset + 12 m off it, within 30° of its
  bearing, side by cross product — and cuts the way where that match changes, absorbing any stretch
  under 8 m into its longer neighbour so a corner wrap does not shed a sliver. Each stretch keeps its
  own geometry and takes from the street its **name**, its **N/S/E/W side label**, its **half-offset
  byte**, that side's **cover byte** and its **physicalid**: OSM way ids churn ~1.5–2%/yr and the shed
  artifact hangs off these keys, so identity comes from the association, not the way. It also
  measures which side of the way the roadway is on, since a mapper draws a way either way round, and
  writes that as the record's geometry-right flag — the shed placement reads it to know which of the
  two things flanking a pavement is the lot. A stretch with no street beside it (an esplanade, a
  bridge walk, the FDR walks: ~155 km) stays a **path edge** under its own OSM way id.
- **Per stretch, exclusivity**: the derived offset is cut back out of exactly the stretches OSM
  covers, and that subtraction is the only thing keeping the network from doubling. It is per stretch
  and not per side — a side is not all one thing, and no fraction of one is a threshold anywhere in
  this path: the street is cut at every change in the mask, so a side OSM maps the first 40 m of
  still carries a derived edge over the other 60. Each stretch OSM leaves alone becomes **one derived
  sidewalk edge** per side the existence gate found pavement on (the STRT bits above: usually both,
  one where the street is genuinely one-sided, and none where it demoted to a centreline path edge
  instead), with its **own baked geometry** — the centreline offset perpendicular to its side by the
  half-offset, with the two end vertices replaced by the corner nodes so it runs corner-to-corner with
  no overshoot into the intersection — carrying opposite N/S/E/W side labels, each its own side's
  cover byte. Its length is that offset polyline's geodesic sum.
- **The seam.** A corner is placed wherever the side beside it has pavement, however that pavement is
  drawn. Where OSM's own network already stands at one — its nearest unclaimed sidewalk node within
  12 m — the corner **is** that node, so the mapped pavement and the derived pavement meet at one
  point rather than a few metres apart with nothing between them (`seamCorners`). A corner the fan
  still had to invent reaches 20 m and **links** to the mapped network instead (`seamLinks`).
- **The kerb cut**, which is what gives the seam a node to find. Both halves above bind a corner to
  a *node* of OSM's network, and where OSM draws a whole block as one unbroken way there is none:
  the alley mouths off 49 ST in Sunnyside stand 5 m from a single 299 m sidewalk edge whose nearest
  node is at the end of the block, so the walk went round it. So before the fans resolve, a corner
  **cuts** the OSM sidewalk way it stands beside, at its own projection (`kerbCuts`, 21,134). A cut
  is only a node — nothing else downstream changes — and it is bounded by the seam's own two
  reaches rather than by numbers of its own: the corner must be inside the 12 m it would have to
  resolve onto the cut, and the way's own nearest node must be further than the 20 m the seam
  reaches, measured **along the pavement**, which is a lower bound on the walk the cut removes since
  every route onto that way enters through one of its ends. Two further guards keep a line that
  merely passes close from being welded to. The projection must fall inside the corner's own angular
  gap: pavement across a roadway lies beyond one of the two street-ends bounding that gap, never
  inside it, and 462 of the 21,388 corners in range were refused on exactly that. And neither the
  way nor anything at the node may be a bridge or tunnel deck. A node with one street-end is skipped
  outright — its single corner wraps the whole circle, so the gap test would have nothing to say.
  Measured, 21,150 of the 21,593 cuts (97.9%) landed on pavement carrying the name of one of the two
  streets bounding their own corner. Citywide the cut turns 20,929 seam links into seam corners, and
  the walk from an alley mouth to the pavement it faces falls from a median of 32 m (p90 307 m, 1,074
  mouths over 30 m) to a median of 0 m (p90 6 m, 13 mouths over 30 m); stranded alley falls from 6.0
  to 0.4 of 312.8 km and the graph from 162 components to 80.
- A node with total degree ≥ 3 and ≥ 2 street-ends emits one **crossing edge** per street, joining
  the two corners that flank it — no geometry, length the corner-to-corner great-circle distance,
  cover the mean of the crossed street's two side bytes, the crossed street's name. **OSM's crossings
  are the crossings where OSM maps them**: a synthesized crossing whose two termini a mapped crossing
  path already joins within 1.5× its own length is dropped (`suppressedCrossings`; the slack lets a
  crossing that chains through a traffic island count). Every corner pair OSM does *not* serve keeps
  its synthesized crossing, or the router would refuse the legal unmarked crossing and detour.
- Path surfaces (boardwalks, paths, step streets, non-vehicular decks) stay single **path edges** on
  their own geometry, tied into a corner fan by geometry-less **link edges**. One that merely *ends*
  at a street — the only path end at that node — binds straight to the corner in the gap it departs
  into, since CSCL digitizes a boardwalk as meeting the road at its centreline and the walk arrives at
  the kerb, not in the roadbed.

Before that, a backstop leaves **one crossing per pair of nodes** whoever drew them
(`collapsedCrossings`): a mapped crossing beats a synthesized one, and between two of the same
provenance the shorter wins. Parallel edges are never the only path between their own two ends, so
collapsing them cannot disconnect anything. A final mop-up adds a crossing at any isolated deg-2
ring whose two sidewalk sides would otherwise be separate components (`mopupCrossings`). Then the
**seam repair**: the swap makes the v1 component count a ceiling rather than a target — joining
OSM's sidewalk network to the streets it flanks merges v1 components that only the mapped pavement
connected — so what is asserted is that no v1 component's image *split*. Where OSM owns a side but
its ways stop short of the block, the two halves stand apart with nothing between them; every such
gap is inside one v1 component, which is what makes it repairable without inventing connectivity,
and a link edge to the nearest peer within 60 m closes it (`seamRepairLinks`, `seamRepairMeters`,
`seamRepairLongest`). The residue OSM's patchiness leaves is counted (`seamGaps`) rather than
asserted away, and capped. Once every pass that places an edge has run, a second backstop drops each
edge that runs from a node back to itself (`selfLoopEdges`) — a way the 1 m node merge folded into
one node, an end an entrance snap bound to the node the other end already sat on, or a closed way
OSM drew — and compacts the geometry the dropped edges owned. Taking such an edge pays its length
and returns the walker to where they started, so no search can use it and dropping it cannot
disconnect anything either. Nodes are sorted by (component, latitude, longitude) and renumbered,
edges by (component, min node id).

Then the **whole-city invariants** (`invariants.rs`), run over the finished edges before the artifact
is written. Each is a pure function of a plain edge view, so each is unit-tested on a hand-built
network and then run once over the real city — the same shape as the existence gate's two guards, and
for the same reason: they are the failures a fixture cannot see, because they are about how the whole
network hangs together rather than about any one rule. Five carry a bound, and every bound sits in a
gap measured from both sides — the finished city on one, and a build of the same city with the fix
that closed the defect taken back out on the other:

| invariant | stats | city | bound | without its fix |
| --- | --- | --- | --- | --- |
| alley km off the main component | `alleyKm`, `alleyOffComponentKm` | 0.42 of 303.1 km (0.14%) | 1% | 87.1% unnoded, 2.0% uncut |
| alley mouth's walk to mapped pavement | `alleyMouthWalk*`, `alleyMouthsStranded` | p50 0 m, p90 37 m, 0 of 3,813 stranded | 10 m / 120 m / 10 | p50 108 m, p90 349 m, 94 stranded |
| one-sided streets carrying both sides | `phantomSidewalks`, `oneSidedKeys` | 25 of 14,961 | 200 | — |
| link edge lengths | `linkEdgesScored`, `linkP99M`, `linkLongestM` | p99 32 m, longest 56.8 m over 15,539 links | 50 m / `SEAM_REPAIR_METERS` | — |
| worst neighbourhood's unpaved share | `pavementCell*` | p90 9.4% over 2,877 half-km cells | 30% | — |

Each bound is held over a population the build classifies for itself, so each would pass on the empty
set — stop the alley classifier matching and there is no stranded alley km to be over a ceiling. So
every population carries a floor of its own, checked first and reported as its own failure: 50 km of
alley (`MIN_ALLEY_KM`), 600 mouths, 2,500 one-sided keys, 500 scored cells and 2,500 link edges, each
roughly a sixth of what the city measures.

Two more are recorded and left unbounded, because each is dominated by a shape that is correct: the
crossings whose far end has nothing on it (`crossingsToNowhere`, 5,784 — mostly crossing stubs OSM
drew short), and the degree-2 derived-to-mapped hand-offs that turn past a right angle
(`seamHairpins`, 113 — about half of them cul-de-sacs wrapping round their own head). The whole pass
costs ~200 ms, against the 16.7 s of sequential topology it checks.

When the city hands over its ferries (`data/ferries/<id>.bin`, magic `FERR`, referenced by
convention — not the manifest), a final stage adds the ferry network **after** that walking
assertion and renumber, so neither is disturbed. Each FERR terminal snaps to the nearest walking
node within 250 m (a linear scan; a stop with none in range drops its segments,
`ferryStopsUnsnapped`); a segment whose two stops snap to one node is dropped, and segments snapping
to the same unordered node pair are deduped to the smaller raw time. Each survivor becomes a **ferry
edge** (`ferryEdges`) whose geometry, when the FERR leg carries a shape, runs node-a → the shape's
interior vertices → node-b (a straight leg carries no geometry). The edge's name is its FERR
primary-route name, and its two terminal stop names are recorded in the byte-60 endpoint side table
(below). Connectivity is then recomputed over **walking ∪ ferry** edges and the component labels
(and count) overwritten with that merge, so Staten Island and Governors Island join the main
component. Components are labelled by size descending (0 = largest). Every edge length is at least
its straight-line node distance (clamped up if not; `lengthClamped`). Everything little-endian.

Header, 64 bytes:

| offset | type | field |
| --- | --- | --- |
| 0 | u8[4] | magic `GRPH` |
| 4 | u16 | format version = 10 |
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
6. **Edge records**: E × 40 bytes:

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
| 34 | u8 | **ascent**, 0-254: the height this edge CLIMBS walking it a→b, summed along its polyline and divided by its length, as a fraction of 35%. That span clears the steepest street anyone walks (San Francisco's worst blocks reach about 31.5%), so nothing saturates; v7 spanned only 12%, which made every serious hill identical. 0 for a ferry and for a city with no elevation source |
| 35 | u8 | **descent**, 0-254: the height it DROPS over the same walk, on the same scale. Walking the edge b→a swaps the two. Their SUM is the absolute grade the hill penalty reads — direction-free, because a route that avoids a hill avoids it both ways — and the two apart are what makes a descent quicker than the climb back (v9; v8 carried only the sum, in one byte). Because each clamps on its own, an edge that crests and drops can carry 70% of grade in total where the single byte pinned the pair at 35% |

| 36 | u8 | **industrial frontage**, 0–254 (a penalty attribute; 0 for a ferry and for an edge on a bridge or tunnel deck): the share of the edge's length running past industrial land, each side of the walk counted for half, so both sides reads twice one side. Baked from `INDL` by `crates/tiler/src/industrial.rs`; 0 across a city with no industrial source, which is what drops that city's slider |
| 37 | u8 | **historic district**, 0–254 (a discount attribute; 0 for a ferry): the share of the edge's length falling inside a designated historic district, tested underfoot rather than probed sideways. Baked from `HDST` by `crates/tiler/src/historic.rs`; 0 across a city with no district source, which is what drops that city's slider. It took the first of byte 36's three reserved zeros **without a version bump** — an older v10 graph reads it back as 0 everywhere, which gates the slider off rather than mispricing anything |
| 38 | u8[2] | reserved, zero. The record grew to 40 for byte 36 and the next per-edge attribute rides here without a v11 |

The record is 40 bytes, a multiple of the 4-byte boundary every section starts on, so the name
table that follows it needs no padding.

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
two sides share a source id). The ordinal therefore needs a whole byte, and the graph pass fails
rather than truncating if one ever passes 255.

Bytes 24–27 are the **scenic-factor attributes** baked by `scenic.rs` (v5). The landmark and art
bytes are a network **discount**: each POI (`LMRK`/`ARTW`) snaps to the nearest walking node and a
bounded Dijkstra fan-out deposits a distance-decaying contribution on the edges it reaches, summed
across POIs and saturated `1 − e^{−k·field}` (so a dense cluster stops stacking); the kernel is
per-mood (landmarks wide, art tight). The highway byte is an areal **penalty**: a Gaussian of the
edge's metre distance to the nearest highway or above-ground-rail line (`HWAY`). The commercial byte
is the same proximity Gaussian over the qualifying commercial-block lines (`CMLN`, derived by
the commercial pass), read instead as a **discount** with a tight σ so the reward lands on the
block's own street and sidewalks. All four quantize to a 0–254 ceiling so the client's
`maxLandmark`/`maxArt`/`maxCommercial` stay `< 1` (the cost model's admissibility invariant, as
`maxCover` already relies on); a later phase reads the discounts as `1 − w·attr` and the penalty as
`1 + w·attr`. A ferry carries none.

Byte 28 is the **direct canopy** (v6, `direct_canopy.rs`, baked when the city carries a canopy
layer): the fraction of the edge's own baked polyline that lies **directly under a `CNPY` polygon**,
on the same 0–254 ceiling and read the same `1 − w·attr` way — the canopy half of the shelter
factor. It is *not* a second cover byte. Cover (byte 20) is the deliberately **smoothed** field the
overlay is coloured from — the oriented anisotropic Gaussian, σ 15 m along the road and 4 m across,
reaching ±37.5 m — which answers "is this a leafy stretch"; a walker under the rain is asking "is
there anything over my head *here*", and a kernel reaching most of the block cannot say. So this is
the raw 0/1 canopy indicator integrated along the edge by arc length with **no kernel and no blur**:
a sample every metre, midpoints of equal sub-lengths, each tested even-odd against the polygons the
existing canopy grid index hands the edge. It samples the **sidewalk** geometry, not the centreline,
so the two sides of a one-sided street differ: Central Park West reads 203 on its park side against
53 on its building side, where the blurred cover only manages 138 against 97.

The two bytes come out related but far apart — over NYC they correlate **0.71**. The direct byte
averages 0.222 over the edges against cover's 0.257 (0.291 against 0.262 weighted by edge length),
and **47.3% of edges have nothing overhead at all** where only 4.9% read zero cover: a sidewalk in
the gap between two crowns is 0 here and still green there. Its length-weighted 0.291 sits above the
city's ~22% canopy over land, as it should — street trees are planted in the sidewalk, and the
walking network runs through the parks. The integration costs **139.8 s** and ~1.8 GB over NYC's
1.08 M polygons and 628k edges, which is why it is a cached column of its own
(`.build/graph-cache/<city>/canopy-<key>.bin`): nothing but a re-ingested canopy pays for it twice.

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
   the graph pass adds them to the kept-name set and remaps them alongside the edge names. A later
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

### `public/routing/<city>.version.json` — what the deployed graph is (derived, gitignored)

Written by the graph pass, beside the `.bin` it just produced, so a job holding
nothing but the live site can tell whether the graph it last snapped against is still the one being
served — and so the client, which fetches it with the graph, can tell whether an artifact placed
against a graph is the one it is holding:

```json
{"graph":"nyc.bin","hash":"7e8a6417abd7ed45","keyHash":"efb0f19bed045be2","edges":628693,"bytes":37417012,"generatedUnixSeconds":1785814737}
```

`hash` is FNV-1a 64 over the GRPH file's own bytes, hex — it detects a rebuild, it does not defend
against one, so a hand-rolled hash beats a crypto dependency here.

`keyHash` is the narrower figure the SHED artifact is gated on: the same FNV over the count of
**durable edges** and then every durable key ascending, eight little-endian bytes each, a key being
`(source id, side, ordinal)` packed as `source << 11 | side << 8 | ordinal`. That is the whole of
what a shed span resolves through, and it is integers all the way down — where `hash` covers the f32
edge lengths, which macOS and Linux land a ulp apart on the same inputs, so no artifact placed on one
could ever pass a gate on a graph built by the other. `hash` was left alone rather than redefined:
it names these exact bytes, and it is what tells two builds of the same graph apart at all.

Both are written by `write_version`/`key_space_hash` in crates/tiler/src/graph.rs and recomputed by
`graphHashOf`/`graphKeyHashOf` in scripts/shed-encode.ts, which `bun run check-sheds` runs against
each other on every deploy.

It is only worth reading because the bake is **reproducible**: identical inputs give identical bytes.
Two places had to be pinned for that. The link edges and the deduped ferry edges are emitted in key
order rather than in their hash map's per-process iteration order — the edge sort breaks ties only on
the smaller node id, so without it a hundred-odd edge ids shuffled between two runs over the same
files, and the SHDE rows, which are keyed by edge index, shuffled with them.

### `public/routing/<city>.stranded.bin` — the walks the graph dropped, magic `STRD` (v1, derived, gitignored)

The graph pass writes the OSM way ids of the paths its **island drop** takes away entirely
— a way every edge of which sat in a component nothing CSCL anchored, so no route can enter or leave
it. 4,036 ways, of which 3,979 are `PATH` records covering 204.5 km. The header is the magic, a
`u16` format, a `u16` header size (12) and a `u32` count, then that many `u32` way ids, ascending.

It exists because the overlay and the router are built from different sets. The chunks pass draws
straight from `data/paths/<id>.bin`, which never sees the drop, so without the list the tree-cover
overlay paints a green, tree-lined walk over trail networks the router has no edge for — every one of
those records has no graph geometry anywhere along it (Floyd Bennett Field's North Forty, the Staten
Island Greenbelt, Ferry Point Park, Alley Pond). The second chunks pass sets each drawn segment's
stranded bit from the same ids — taken straight from the graph pass that computed them, not read
back off this file — and `src/tiles/street-score.ts` skips them. The file is the record of what was
dropped, for anyone asking outside a build.

Conflation's step 7 (DESIGN.md, "The order conflation runs in") is what keeps the list to the
components that are genuinely out of reach rather than merely unnoded: it took 668 ways — 656
records, 31.5 km — off this list by cutting the routable line each of them was already standing on.

The list says nothing about whether those trails are walkable on the ground — most are. It records
only that *this* graph cannot route them, which is what the overlay must not contradict.

### `public/routing/shade/<city>/` — the per-edge occlusion fractions, magic `SHDB` (v2, derived, gitignored)

The graph pass itself, for a city with both a `buildings` source and a sun-position grid (the same
one the shade pass bakes from), bakes for every GRPH edge and every sun-position bin how much
of that edge's polyline a **building** shadow covers and how much a **crown** shadow covers — the
same shadow geometry the two tile pyramids cast, from the bin's centre sun-disk sample alone (so an
edge is cleanly in or out), probed every 5 m along the edge against a 5 m rasterized coverage grid of
the bin's ~867k hulls. The city's `CNPY` layer supplies the crowns; without one, or where a crown
carries the 0 unknown-height sentinel, the tree fractions are simply 0 and the router costs buildings
alone.

The bins run in parallel, one grid alive per thread. NYC's 58 bins over 628k edges are around **25
minutes**, almost all of the graph pass, and the artifact is 59 MB — twice what the single signed row
cost, since the tree row ships whether or not a crown covers anything. Each bin is cached under its
own key (`.build/graph-cache/<city>/shade-<key>.bin`), keyed on that bin alone, so a schedule that
gained a bin bakes the one bin.

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

### `public/sheds/` — the sidewalk-shed history, magic `SHED` (v3, derived, **committed**)

Every scaffolding permit New York has issued since **2017-12-28**, placed on the GRPH edges it stands
over. Not baked by `tiler`: `bun run build-sheds` (`scripts/build-sheds.ts`) does the whole pipeline
and writes these three files; `bun run update-sheds` keeps them current without ever running it
again. It reads `public/routing/nyc.bin`, so it runs **after** `bun run build-tiles`, which bakes
that graph and never touches this directory. Nothing empties `public/routing` any more either: the
graph pass removes exactly its own per-city pieces when that city's stamp fails, and the driver's
sweep only takes away names belonging to a city the manifest dropped. All dates are
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
shed-map.ts` puts the two together — the connected stretch of lot boundary nearest a sidewalk that
carries the permit's street name is the measured frontage, and a permit longer than that runs on
around the corner as a bounded walk over the sidewalk network. What a permit resolves to there depends on that
permit alone and never on the company it was fetched in: the parts of a multi-part lot are sorted
before they are unioned, because Socrata's row order shifts with the batch, and the lot a permit's BIN
*reports* — the fallback when the tax map has no polygon for the permit's own BBL — is run through the
same condominium resolution as the permits' own lots, because otherwise it found geometry only when
some unrelated permit happened to name the same BBL. Each placement carries a confidence, the product
of six ways it can be wrong; `scripts/shed-streets.ts` is the DOB-to-CSCL street-name comparison the
first of those factors reads.

**The git half of that walk is package.json's, not TypeScript's.** `bun run build-sheds` clones the
DOB repo if `.cache/ActiveShedPermits` is not there, has `git log` name each commit's two candidate
snapshot paths, resolves them all in one `git cat-file --batch-check` into `.build/shed-index.txt`,
and pipes the distinct blobs — 2,614 of them behind 3,623 snapshot-carrying commits — through
`git cat-file --batch` into the walk's stdin. `bun run update-sheds` is the same chain with a
`--shallow-since` clone and a fetch in front of it, bounded by the day `scripts/shed-window.ts` reads
off the artifact. Nothing spawns git; a script at the end of one of those pipes checks the sha on
every record it is handed, because a shell pipeline reports only its last command's failure.

**`bun run shed-drill` is that claim measured**, because nothing else can see it: it builds
the record set from every permit, builds it again with one permit dropped, and compares every
surviving record's `(first, close, confidence, spans)`, which is the whole of what the artifact
stores. Only the dropped permit's own records may differ — one that moved because an unrelated permit
left the run is one the daily job would have written differently from a full rebuild, and then
`closed.bin` could not be appended to at all. It drops one permit per shape (a corner lot, a mid-block
lot, a superblock run, one declaring far more length than its lot can hold), preferring permits naming
a BIN and a BBL no other permit names, since those are the drops that actually take a key out of the
sorted lists `fetchKeyed` batches and so re-compose every batch after it. It reads the built graph and
the DOB clone, so it is a by-hand check beside `check-sheds` rather than part of `bun test src`.

**Run it against a same-day `.cache/`.** Entries never expire and are keyed by the batch they were
fetched in, so a drop that shifts a batch boundary re-fetches part of the key space — and the city
republishes the tax map often enough that the two runs then read different *sources*. That reads as
records moving when nothing in this repo moved: 17 of 39,918 lots and 2 of 40,229 footprints came back
different between 30 July and 2 August 2026, which was 58 records. `REFRESH=1` pins the vintage, and
the drill counts the readings whose parcel geometry differed between its own two runs and says so
rather than letting it pass for a placement that shifted.

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
| 4 | u16 | format version = 3 |
| 6 | u16 | header bytes, and so where the records start: 32 plus whatever the block below runs to |
| 8 | u32 | records in this file |
| 12 | u32 | spans in this file |
| 16 | u64 | graph key-space hash — the `keyHash` `routing/<city>.version.json` carries |
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

A key survives a rebuild; it does not promise to still name the same edge across one. A conflation
fix that stopped a second OSM mapping of a street becoming a spur left 2,284 of 302,985 keys naming
an edge a **median 26 m** from the one they had named. So the header's key-space hash is a **gate**,
not a note: the client reads its own graph's `keyHash` out of `routing/<city>.version.json` — recomputing it
is a 368k-element sort and an FNV over 3 MB, to arrive at a number the deploy already wrote down —
and an artifact naming any other key space resolves **nothing at all**. The band, the router and the
shadow caster all resolve through the one call, so they go quiet together: a day of bare pavement is
a failure anyone can see, scaffolding down the wrong street is not.

The whole **set**, not the individual key, and not the graph's bytes. Ordinals are handed out 0..n-1
within a `(source id, side)`, so a source segment that splits into a different number of edges — the
shape every conflation and re-noding change takes — moves the set and fires the gate, while a
rebuild that only landed some f32 lengths a ulp elsewhere does not. `SHED` v2 named the graph's
bytes here, which meant an artifact placed on a laptop could never match a graph the deploy's Linux
built; v3 is the same file with this field's meaning changed, so the version bump is what stops a v2
artifact being read as if it named a key space.

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

#### Refreshing the sources — the re-place rides with it

Everything the graph reads is a deliberate refresh, roughly annual: `.cache/` never expires on its
own, so a re-run reads whatever it read last time and only `--refresh` goes back to the network. The
mapping campaign is the reason to do it at all — OSM's sidewalk network tripled between 2022 and
2026, and the Bronx frontier is where the derived offsets are still standing in for pavement nobody
has mapped yet.

**Every refresh re-places the whole shed history, in the same push.** A span names its edge by a
durable key, but the ordinal in that key is a within-build disambiguator with no cross-build duty, so
a rebuilt graph is usually a rebuilt key space — which is why the header carries the hash of that key
space and why `shedsOn` resolves *nothing at all* against any graph that does not carry it. When the
OSM-primary sidewalk network landed, the committed artifact resolved 14,402 of 14,402 standing spans
against the graph it named and **0** against the new one.

The **key space** and not the graph's bytes, which the gate compared until 2026-08. Those carry an
f32 length per edge, and the geodesic and offset maths land a few of them a ulp apart between
macOS/aarch64 and the deploy's Linux/x86_64 — the same inputs, the same code, 95 stats agreeing to
the last digit but one (`osmSideKm` 15519.703943263898 against 15519.703943263896, two nanometres
over the whole city). An artifact placed by hand on a laptop could therefore never match a graph CI
built, and the deploy failed on a difference no shed can feel. Nothing in the key space is
float-derived, so it is bit-identical wherever it is computed.

What that does and does not cover. It covers a source segment that splits into a different number of
edges, or splits onto a different side, or disappears: ordinals are handed out 0..n-1 within a
`(source id, side)`, so any of those moves the set. It does **not** cover a rebuild that keeps every
key and moves the pavement under it — the same street re-digitized in place, or two edges of one
source swapping ordinals. That is what step 3 below is unconditional for: a refresh re-places the
whole history whether or not the gate would have fired, and the gate is the backstop for the refresh
someone forgot, not a licence to skip one.

1. Re-fetch and commit the sources — `REFRESH=1 bun run build-tree-data:<city>`, plus whichever of
   `build-buildings`, `build-dining`, `build-landuse`, `build-openstreets` the refresh covers. These
   are LFS blobs: commit them with **git**, not `sl`, and push the objects (above).
2. `bun run build-tiles` — the graph, its `version.json` hashes, the SHDB bake and every pyramid.
3. `bun run build-sheds` — re-derives all 72,020 records against the new graph from the DOB history
   and the tax lots. Two minutes, deterministic, disk-cached; it is not a migration and keeps no
   state from the old artifact.
4. Commit `public/sheds/*.bin` (plain git — **never** LFS) alongside the sources, one push.
5. `bun run check-sheds`, then dispatch the deploy.

`check-sheds` compares the key space of the graph `build-tiles` wrote against the one the committed
artifact names — recomputing it in TypeScript from the graph Rust wrote, so the two implementations
check each other on every deploy — and `.github/workflows/build.yml` runs it between `bun export` and
the Pages upload — so a refresh
that forgets step 3 fails its deploy instead of shipping a map with no scaffolding on it. Nothing
catches it earlier than that: a push or a PR builds no graph, so there is nothing there to compare
against.

Afterwards, three things say it worked: `check-sheds` passing in the deploy's own log, scaffolding
actually drawn on the deployed site (the client blanks silently, so this is the only visual check),
and the next morning's `sheds.yml` run going green — `update-sheds` refuses a graph the artifact was
not placed against rather than re-stamping the header, so a red run the day after a refresh means the
pairing, not the feed.

**And a push that forgets step 3 is caught before any of that.** `check-sheds` needs a graph, so it
can only run inside a deploy — by which time the artifact has been on `main`, and in front of the
client, for however long it took someone to dispatch one. So `bun run check-shed-inputs`
(`scripts/check-shed-inputs.ts`) runs on every push and pull request instead, over what the graph is
built *from* rather than the graph itself: the tiler stamps that in two halves,
`scripts/graph-inputs.ts` reads the two reports, `build-sheds` records them in
`public/sheds/inputs.json` beside the artifact it places, and the two are compared. A change without
a re-place fails the run and says which half moved.

### What the stamp covers, and why it is so small

It covers what can move a **durable key**, and nothing else. Not what can change the graph — the two
are very different sets. A shed span resolves through `(source id, side, ordinal)` and through
nothing else (`resolveSpans` is a set-membership lookup and consults no other field), so an input
that only writes a per-edge attribute *byte* cannot misplace a shed, because the edge it is written
onto was final before the bake ran. The set was 43 files once — every data blob on the chain plus the
whole tiler crate and `Cargo.lock` — and that cost a full re-place for an edit to `shade.rs`. The one
that provoked the narrowing touched `graph.rs`, went stale, and re-placed to a **byte-identical**
artifact.

**The data half** is three committed files per city — six today — hashed as bytes:

| in | why |
| --- | --- |
| `data/streets/<city>.bin` | the source ids themselves (CSCL physicalid), and how each record is cut sets its ordinals |
| `data/paths/<city>.bin` | the same, for OSM way ids |
| `data/sidewalks/<city>.bin` | a mapped sidewalk matched to a street is keyed by that street, and `trim_derived` cuts the derived pavement out wherever one exists — so it decides which keys exist and how many edges a source is split across |

and everything else the graph pass reads is out, each for a reason that has to be refuted before it
goes back in:

| out | what it feeds | why it cannot move a key |
| --- | --- | --- |
| `data/ferries` | the KIND_FERRY edges | they carry `NO_SOURCE_ID`, and are appended after the walking sort and the node renumber onto nodes that already exist — `assign_ordinals` skips them and an append moves no earlier edge |
| `data/landmarks`, `data/art`, `data/highways` | one scenic attribute byte each | read at `graph.rs:3501-3535`, after the last `v2_edges.push`, over a `scenic::Network` built from the finished edges |
| `data/industrial` | one scenic attribute byte | read after the last `v2_edges.push` like the three above, but probed per metre against the lot polygons in `industrial.rs` rather than through a `scenic::Network` |
| `data/historic` | one scenic attribute byte | the same, sampled underfoot against the district polygons in `historic.rs` |
| `data/landuse`, `data/buildings`, `data/openstreets`, `data/dining` → `public/commercial-lines` | the commercial attribute byte | one more such byte, read at `graph.rs:3542`. the chunks and commercial passes are on this branch and nowhere else |
| `data/canopy` | the direct-canopy byte, and the crowns of the SHDE bake | integrated along edge polylines that are already final |
| `data/buildings` + the shade params (`shade-schedule.ts`, `src/shade/sun.ts`) | the per-edge SHDE bake | it runs *after* `fs::write(&args.out)`; it cannot move a key in the file it is written beside |
| the DEM mosaic (`elevation.tiles`) | the per-edge ascent and descent bytes | sampled at `graph.rs:3627`, over those same finished edges |
| `data/land`, `data/trees` | the canopy and genus pyramids | nothing on the graph's chain reads either |

**Which of those three a city actually gets is in the stamp as well**, because a source withheld puts
no key in the space. That decision was TypeScript's for a while — the import closure of
`scripts/write-plan.ts` minus a list of leaves argued out — because it lived in code with no artifact
to point at. It has one now: the plan carries each city's resolved `sources` list, and
`tiler graph-inputs` digests that decision together with the oid of every file it names
(`key_space_stamp`, `crates/tiler/src/build.rs`). The three paths it hashes are built by the same
expressions the build hands to `graph::run` a few lines above, so a source that stops being handed
over cannot go unnoticed — and an edit to the script that reaches the same decision costs no
re-place, which the closure charged for. The per-city `alleys` flag rides along: it only gates the
whole-city invariants, so it steers no edge, but it is the plan's statement about what the network
*is* and a city flips it about once ever.

**What is deliberately not in it is the plan verbatim.** The data root, the manifest's own path and
the DEM's `.cache` tiles are all where a checkout happens to keep things, and a stamp that moved with
them could never be compared against one another machine recorded; each file enters as its path
*relative to the data root* instead. Nor are the manifest's bytes: all it contributes to the key
space is which streets and paths file each city names, and that is in the stamp — the graph's
sidewalk inset is a constant in `graph.rs`, not the manifest's `sidewalkInsetMeters`, which only
the chunks pass and `tiler ingest` read.

The guard needs a plan and cannot afford the one a build writes, so `bun run graph-inputs` runs
`write-plan.ts --key-space`: the same plan, to `.build/key-space-plan.json`, with the elevation block
left out. Resolving San Francisco's mosaic is a 1.77 GB download, and it describes a block the table
above rules out of the key space. It gets its own path so a plan with no DEM can never be mistaken
for one a build should render from.

**The code half is not the crate's source text.** `crates/tiler/**` and `Cargo.lock` are out of the
set entirely; in their place `tiler key-probe` runs the graph pipeline over
`crates/tiler/fixtures/key-probe/` — nine 0.01° slices of the real city, 268 KB of plain committed
bytes, 4,226 durable keys, 0.09 s — and the stamp records the `keyHash` it lands on. package.json
runs the probe (`bun run key-probe`) ahead of every script that needs it and it leaves its report at
`.build/key-probe.json`; `scripts/graph-inputs.ts` reads that file, and spawns nothing. That is a stamp
of what the key assignment **does**, which is the only thing that separates a change to `graph.rs`
that moves keys from a comment in the same file that cannot. The probe skips the whole-city bounds
(alley reach, pavement cells, the existence gate's two shares); every one of them is held over a
city's population and says nothing about a fixture. Nothing else is skipped.

The fixture is real geometry and not a drawn network because what the probe must be sensitive to is
the pipeline's *near-threshold* decisions, and only real data has them in quantity. Measured, one
constant at a time:

| perturbation | probe |
| --- | --- |
| `MERGE_RADIUS_METERS` 1.0 → 1.05 | fires |
| `SIDEWALK_INSET_METERS` 2.0 → 2.05 | fires |
| `SEAM_RADIUS_METERS` (= the kerb cut) 12.0 → 12.1 | fires |
| `SEAM_LINK_METERS` 20.0 → 20.5 | fires |
| `SPLIT_MERGE_METERS` 2.0 → 2.05 / → 2.2 | silent / fires |
| `SHORT_CHORD_METERS` 10.0 → 10.5 / → 40.0 | silent / fires |
| `PRUNE_DEVIATION_UNITS`, `SUPPRESSION_SLACK`, `SEAM_REPAIR_METERS`, `GRID_METERS`, at any size | silent, and correctly: interior vertices, suppressed crossings, repair links and an index bucket size are all either not edges or not keyed |

**The hole this leaves**, stated plainly: a threshold nudge too small to change any decision *in the
fixture* while changing one somewhere in the city passes the gate silently. `SHORT_CHORD_METERS`
10.0 → 10.5 is a real example — no street in the fixture has a whole-edge chord in that band. The
consequence is not a blank map: the change lands, and `check-sheds` — which compares the real graph's
key space, exactly — fails the next deploy with the same instruction. The land-time gate is the early
warning; `check-sheds` is the guarantee. Widening the fixture narrows the hole; widening the *stamp*
back to the crate's source text closes it only by charging a re-place for every comment.

It costs nothing on the fast path. Nearly every blob under `data/` is LFS-tracked, and what the
repository holds for those is a pointer whose oid *is* the sha256 of the object — so `input_oid`
hashes the pointer when it finds one and the bytes when it does not, which is also what makes the
plainly-committed `data/historic/*.bin` need no special case. Both kinds of checkout land on the same
stamp, and the
push/PR job keeps `lfs: false` and downloads not one byte to check this. The fixture is under `crates/`, which no `.gitattributes` rule reaches, so it arrives as
bytes; the probe builds the tiler in the **debug** profile, since the release profile is lto with one
codegen unit and the optimizer buys a 0.09 s run nothing. Both profiles give the fixture the same
key hash.

**The live map is blank between the push and the deploy.** The artifact is committed before the
deploy that catches the graph up, and the client fetches it off `main` while the graph comes from
Pages, so for that window the two disagree and every shed goes quiet — as does the daily job, which
refuses inside it and catches up the next day. Deploying first only moves the window and gives up the
guarantee that the end state is consistent; keep the two close together instead.

## Adding a city

The client does not change. It reads `src/tree-cover/manifest.json` and the tile pyramid;
another entry in the manifest is another `TileLayer` and another `GridLayer`, and the tiles
of two cities that share a low-zoom tile are painted into the same buffer rather than
overwriting each other.

What has to change is the ingest in `scripts/tree-data-fetch.ts`, which is currently one
hard-coded `CITY` constant plus four NYC-specific fetchers. A new city needs:

1. **A measured tree-canopy source** — polygons of the canopy footprint (NYC uses its 2017 LiDAR
   canopy). This *is* the cover field: without it `tiler ingest` has nothing to convolve and the
   map has no cover at all. A canopy height model to run `tiler ingest` against is optional: with
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
city. The estimator, the encoders and the tiler are all city-agnostic; only the source fetchers and
the crown allometry are not.

San Francisco is the second city, and what it took is in `scripts/sf.ts`. DataSF is a Socrata
deployment, so the reading is shared and most of the work was a field remap; three things were not,
and each is the kind of thing a third city should expect to hit:

- **The walkability filter has no counterpart.** CSCL has `rw_type`, one code per kind of way. SF's
  centreline has `classcode`, which is only a road hierarchy and says nothing about whether a person
  may walk. The field that does is `layer` — and it names the PAPER layers, streets that exist on
  the map and not on the ground. `PAPER_WATER` would have put walking edges out in the bay.
- **The width is published from the other side.** NYC gives a kerb-to-kerb `streetwidth` and the
  pavement is offset half of it. SF gives the width of the *sidewalk*, so the roadway is recovered
  as the right-of-way polygon's area over its centreline's length, less two sidewalks — a median of
  26 ft against New York's 30.
- **The survey is a table, not polygons.** The existence gate needs an authoritative per-side answer
  to "is there pavement here", because OSM's silence is ambiguous. NYC probes planimetric polygons;
  SF publishes a `side` column. So `sidewalks.ts` takes a `Survey` function and each city supplies
  its own.

And two traps worth stating plainly. The land mask must be the **shoreline-clipped** polygons, not
the county's legal boundary — San Francisco County reaches 45 km offshore to the Farallon Islands,
and `boxOf(land)` feeds the manifest bounds, every Overpass query and the whole tile plan. And a
tree register's coordinates are only as good as its geocoder: 55 SF street trees carry a placeholder
in the north Pacific, which is why the ingest land-clips the points before taking the city's bounds
over them.
