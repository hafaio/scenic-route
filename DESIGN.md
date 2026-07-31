# Design notes

Why things are the way they are. `scripts/README.md` is the reference — pipeline stages, binary
layouts, what each artifact contains. This is the reasoning behind them, including the alternatives
that were measured and rejected, so nobody spends a day rediscovering a dead end.

## Rendering and measurement traps

These bit the shade work but none of them are about shade. They apply to any layer.

**Headless Chromium falls back to SwiftShader.** A WebGL perf harness then silently measures the
*software* rasterizer and reproduces pre-GPU numbers exactly — one re-measurement "reproduced" an
already-fixed stall entirely this way. Launch with `--use-angle=metal --use-gl=angle` and assert the
renderer string before trusting a number. Headless also drops layers the real GPU renders, so a
headless screenshot test can pass while testing nothing. This applies to `genus-gl-layer` too, which
predates any of this.

**In Canvas2D the cost is the Path2D binding, not the arithmetic.** Measured at **1079 ns per
`moveTo`/`lineTo`** — a JS↔C++ call per vertex. The same loops writing a `Float32Array` took 1.16 ms
for the 50,785 vertices that cost 58.7 ms through `Path2D`; one `addPath` copies 14,000 in 0.1 ms.
So the lever for a slow canvas layer is to stop feeding it a vertex at a time, not to simplify the
geometry and not to reduce resolution. Two things that look like fixes and are not: rendering at
half resolution bought **2%**, and halving a layer's vertex count bought **12%**. `street-score` is
currently the most expensive renderer for exactly this reason and has not been converted.

**Bake time does not scale with tile count.** Dropping a pyramid's deepest level removed 70% of the
tiles and 18% of the time, because building the shadow hulls is per-bin and independent of depth.
Estimating a bake from tile counts will be wrong by 3×.

**Leaflet strands parent tiles.** `_updateOpacity` marks `willPrune` only when it sees a tile that
was *already* opaque, so a screenful crossing the fade line in one pass prunes nothing and ends the
rAF chain — leaving every overlay drawn twice under its own children. Patched globally onto
`L.GridLayer` in `src/tiles/prune.ts`, which covers the basemap and route grid as well as ours.
Prune when the fade settles, not per frame: `_pruneTiles` walks five levels up and two down per
tile, and zooming out is exactly when the upward walk misses.

**Two stacked layers cannot composite pre-scaled alphas.** Source-over gives `αt + αb(1−αt)`, which
equals `1 − (1−b)(1−t)` only if the alphas *are* the fractions. If they are already scaled by
anything, the cross term is scaled twice: a pixel fully shaded by both comes out 238/255 where it
should be 190/255, ~25% too dark, worst where the overlap is densest.

## Shade

The map shades ground the sun cannot reach: buildings, and tree canopy.

### The two halves

Shade is baked as a raster pyramid at shallow zooms and **generated on the client at deep ones**. The
costs run opposite ways: a raster level is 4× the tiles of the one above (z15 alone was 68% of the
pyramid's bytes), while client-side casting costs whatever is in view, so it is cheapest zoomed in
and hopeless zoomed out — a z13 viewport is 18 km across and holds most of the city's 1.36 M casters.

They cross at **z14**. z13 stayed rejected even after the GPU made it fast, and not for speed:
caster chunks are indexed by z15 tile, so each level out pulls four times the ground — a screenful
costs 1.5 MiB of geometry at z15, 4.2 at z14, 13.6 at z13 — while a screenful of raster is a flat
~0.5 MiB at any zoom. Raster is refetched per sun bin and geometry once, so the break-even is how
many times of day you look at: ~4 bins at z15, 9 at z14, 28 at z13, against 11 bins in a whole day.
At z13 the geometry can never pay for itself.

### Why seasons are not baked

Bins are keyed on `(declination, hourAngle)`, which fixes the sun exactly and lets the clock scrub
without jitter. But **declination is symmetric about the solstices** — mid-April and late-August
share a bin. That is fine for geometry, since the shadows really are identical, and fatal for
anything seasonal, because one date is bare and the other in full leaf. So the pyramids store
geometry only, buildings and canopy separately, and the client composites them with the season's
transmittance:

    alpha = MAX_SHADE_ALPHA × intensity × [ 1 − (1−b)·(1−τ·t) ]

Not a sum (exceeds 1 where they overlap), not a max (understates a pixel shaded by both). See the
compositing trap above for why this must not be two Leaflet layers.

### Where the numbers come from

**Crown heights** are sampled from the 1 m LiDAR canopy height model of the *Scientific Data*
six-million-trees paper (figshare `10.6084/m9.figshare.20522895`, CC BY 4.0), the same 2017 flight as
the canopy polygons, so they co-register. It is not a canopy *surface*: 95% of cells are nodata and
its floor is 2.1 m, because it is thresholded crown cores. It covers 56% of polygon area directly but
**96.56% of area lands in a polygon with at least one cell**, which is what matters since a polygon
takes the 75th percentile of the cells under it. Height 0 is the unknown sentinel and casts nothing.

Two rejected alternatives, both measured. The 6 M TreeSeg crowns are the same measurement in a harder
container — 106.7 km² against the CHM's 108.33 — with heights only in a 660 MB CSV joined per borough
and per-borough schemas that differ. Imputing height from crown radius gives R² 0.097 and is
non-monotone: height falls from 1 m to 5 m of crown radius before rising. Genus adds 0.139 m of RMSE
improvement. Both noise.

**Transmittance.** In leaf τ = 0.814, from i-Tree's shading coefficients
(`0.615 + 0.0617·ln(dbh_cm) + c_species`, Nowak 2024 App. 3 after McPherson et al. 2018) at our median
22.9 cm trunk, count-weighted over the eleven genera we ship. Leaf-off τ = 0.40, from Heisler 1986
(Urban Ecology 9:337–359, measured at 40°48′N on London plane, Norway and sugar maple), whose
leafless/in-leaf ratios of 0.53/0.44/0.46/0.51 give ~0.49. Genus spans only 0.076 across our genera
while trunk size spans 0.154 — size matters twice as much as species, which is why neither is
modelled per tree.

**Crown geometry.** A crown is not swept like a building; its shadow is the polygon *translated*, and
translated from the **crown base at ~0.4h, not the top**. The LiDAR outline is the crown's widest
cross-section, and for the half-ellipsoid and ovoid shapes urban trees take that sits near the base;
casting from the top overshot by about a crown radius, putting a median crown's shadow 35.8 m out
instead of 14.3 m at a 12° sun and visibly detaching it from its own tree. 0.4 is an assumption
anchored on crown ratio (0.39–0.60 for hardwoods, Russell & Weiskittel 2011 Table 1); "height to
largest crown width" is the parameter it wants (Hann 1999) but no published figure exists for urban
broadleaves. Cast crowns with **one** sun-disk sample where buildings get six: a 10 m crown's
penumbra is ~5 cm against 3.6 m pixels.

### Known gaps

- The per-edge routing bake stays binned server-side, so above the cutoff the overlay shows the true
  sun while the router costs edges at the nearest bin.
- A whole park shares one 75th-percentile height. 69.85% of census trunks fall inside a canopy
  polygon, so a Voronoi split could give each tree its own — untested, and less urgent since casting
  from 0.4h cut the leverage of any height error by 60%.
- The transition dates in `src/shade/phenology.ts` are sourced but the ramp between them is a chosen
  curve, and NYC leaf-out is drifting ~0.43 d/yr later.
- The CSTR tests do not cross-check the two implementations: the TS reader is tested against a
  hand-rolled TS writer and the Rust writer against a hand-rolled Rust reader, so a mistake mirrored
  into both would pass. The two agree today.

## Sidewalk sheds

Scaffolding is the one thing on the map whose source changes every morning, so it is the one artifact
rebuilt by a daily job rather than by a deploy — and therefore the one committed thing under
`public/`, since a job that runs no build has to be able to read the last one out of the checkout.
The client does not read it out of the deploy either: Pages ships on `workflow_dispatch` and the
artifact changes every morning, so it is fetched off `main` through raw.githubusercontent.com and is
as fresh as the job. `scripts/README.md` says what it holds; this is why.

### The feed is a git repo with four traps in it

There is no scaffolding *history* dataset. What exists is DOB's own daily CSV of active sheds,
committed to a public repo since 2017-12-28, so eight and a half years of history is a walk over
commits rather than a reconstruction. Every trap in that walk multiplies the interval count, and none
of them announces itself:

- **1,369 of 4,840 commits carry no CSV at all.** Read as empty snapshots, every shed in the city
  closes and reopens that day.
- **The `(BIS)` suffix was a mass rename**, not a new id — on 2018-01-30 the whole file went
  `104416464` → `104416464(BIS)`, which is 7,208 phantom closures on one date.
- **103 snapshots are truncated writes**, including a fortnight in mid-2019 at a fifth of the usual
  row count. A ±5-day median filter cannot see a run that long. A 30-day *backward* window can, and
  backward is also what makes a day's verdict final the moment it is made.
- **The header has taken seven distinct shapes**, not the three it looks like: 16, 19, 20, 22, 23, 24
  and 25 columns, the two oldest carrying no borough digit at all.

The ids do not reconcile across DOB's own systems either: only 0.9% of BIS jobs have a plausible
handoff to a DOB NOW id within ±7 days and 662 same-address pairs overlap in time, so same address is
not same shed and nothing tries to stitch them. And the Open Data view that looks like this dataset
(`2jy7-cddj`) has returned HTTP 400 on every query for years, over a parent that dropped a column —
its timestamp still ticks daily, so the portal looks healthy.

### Where a shed actually stands

The feed gives a point, a BIN and a length — no line, no side of the street, no cross streets.

**Tax lots, not building footprints**, and it is not close. Measured head to head over the standing
set once, when the choice was made — the footprint-derived path no longer exists, so this is a
historical measurement rather than one a run today could reproduce. Sheds assigned 90.3% → **99.7%**,
sheds with no geometry at all 624 → **19**, total coverage 294 mi → **321 mi** against the 334.7 mi
DOB's own linear-feet column sums to, and — the actual point — length laid along measured frontage
rather than invented 125 mi → **261 mi**, which is the same length reclassified rather than more of
it. Side of street did not move: 56/56 on the blind audit either way. A shed runs along the property
line, and on a superblock — NYCHA, Stuy Town, a school campus — the building can sit a hundred metres
inside its lot, so footprint-derived frontage invents a wrap onto streets it never touched. What lots
cost is placement ambiguity, which grew with them (slide room p90 5.8 m → 46.5 m): a lot puts the
right length on the correct block face and lets it slide along it, which is what the per-placement
confidence exists to record. Footprints still come in per BBL from Socrata, to pick which part of a
multi-part lot is in use — so the 32 MB LFS building blob is never touched by this pipeline.

**A permit longer than its frontage genuinely wraps corners**, so the walk that spends the overrun has
to be bounded rather than forbidden: 80 Pine Street really does run onto Pearl, Maiden and Water. The
bound is a 10 m budget for coverage that is off both the permit's street and the lot's own frontage.
At 0 m the 80 Pine wrap breaks; past 15 m the walk buys more off-lot error than placed length. The
exchange rate turns over somewhere in that interval and the constant sits in the middle of it. Every
constant in `shed-map.ts` was picked by scoring the whole 61,331-permit feed against it, so none of
them should be tuned by eye.

**How deep the deck is, measured rather than assumed.** A shed spans the pavement from the building
face out to roughly the kerb, and no dataset New York publishes carries a sidewalk width. Two lines
pin it. The kerb falls out of the graph: a sidewalk's baked polyline is the centreline offset by half
the CSCL kerb-to-kerb roadway plus a fixed `sidewalkInsetMeters`, so the kerb is always exactly that
inset inboard of the line — the offset byte measures the ROADWAY and stops there, and knows nothing
about the pavement beyond it. The building line is the tax lot the frontage is already measured
against, taken as the median SIGNED offset of the lot's street-wall samples from the polyline, signed
off the graph's own geometry-right flag rather than off the wall's normal, which is unreliable
exactly where the baked line lands inside the lot.

Over the whole feed that comes out as a clean bell around **3.7 m** — a 12 ft sidewalk, which is what
New York builds — which is why the flat 4 m it replaced looked defensible in aggregate and was wrong
in every particular place: a Midtown avenue reads 6 m and a Queens side street 2.5 m. The artifact
stores it clamped into **[0.1 m, 8 m]**. The ceiling is where the distribution stops falling and goes
flat out to 32 m — 3.7% of spans, and superblocks, forecourts and plazas rather than pavement, where
the lot line is not the building line at all. The floor is the encoding's alone: a depth rounds to
decimetres and zero decimetres is the byte that means "not measured".

**What cannot be built is corrected by the reader, at 2.4 m.** The code wants 5 ft of clear path
under a shed (BC 3307.6.2; BC 3307.6.3 has the deck cover the whole pavement bar 18 in at the kerb),
the frame's posts and bracing stand outside that path either side, and 8 ft is where the standard
shed frame starts — so a measurement under 2.4 m is a lot line or a kerb estimate that is off rather
than a sliver of a shed. **23% of spans** are under it. The correction belongs to the measurement,
not to the drawing: `deckDepth` in `src/routing/sheds.ts` raises the number the band, the shadow it
throws and `shedShade`'s falloff all read. It goes on the KERB side — the lot line is evidence and
the kerb is a fixed inset off a CSCL centreline — so a floored deck keeps the building line it was
measured from and reaches further over what the graph took for roadway. 18% of spans overhang the
kerb that way, by a median 0.8 m and at most 2 m; the 3.7% measured under 0.5 m had their building
line inside the roadway to begin with, and those bands sit over it entirely.

### Named by its source, not its position

GRPH edge ids are positional — nodes renumber by `(component, latitude, longitude)` and edges by
`(component, min node id)` — so a rebuild moves all of them, and an artifact keyed on them does not
fail loudly, it puts scaffolding on other streets. Each span is therefore keyed on
`(source id, side, ordinal)`, built on the CSCL `physicalid` the graph now carries through.

Two cheaper-looking identities were measured and rejected. **Endpoints do not identify an edge**:
48,279 of 531,520 edges (9.1%) share an unordered node pair with another, still 8.5% after adding kind
and side, and 1,910 are self-loops. **Endpoints also move**: sidewalk edges run corner to corner and a
corner sits on the bisector between consecutive street ends, so adding one street to an intersection
shifts every sidewalk edge touching it. The key is also carried whole rather than hashed — a u32 hash
over 531,520 keys is expected to collide about 33 times, which is 33 sheds silently on the wrong
street. A rebuild settled it: 13,666 of 13,671 standing spans landed on a different edge id, not one
changed street, and the 7 that moved more than 5 m were the same source row contracted differently.

### A function of its end date, and nothing else

The daily job has to land on the bytes a full rebuild would write, however far back the chain started,
or "what stood on 12 March 2021" depends on the deploy history rather than on 12 March 2021. Rewinding
six months and replaying broke that, and the obvious suspects were innocent: both chains agreed record
for record on which permit stood on which days, so neither the truncation filter nor the fortnight
merge was involved. What differed was where 27 records were **placed**.

`build-sheds` placed a permit once, from the last snapshot that carried it. DOB goes on correcting a
permit's geocode, length and BBL for years, including on permits whose earlier stints closed long ago
— so a full build placed a 2018 record from the attributes the feed carries *now*, and two full builds
six months apart disagreed with **each other** before any incremental update existed. An update cannot
do that at all: `closed.bin` is append-only, so it freezes a record when it closes.

The fix is to make the full build behave like the incremental one, placing each interval from the
reading its own interval ended under. It is also the better history — the shed that stood in 2024 was
the length the feed gave in 2024 — and it costs 6%, not the tripling it was assumed to cost: 65,026
placements for 61,331 permits and 72,020 records, because a correction is rare enough that almost
every permit still needs exactly one reading.

Verifying the fix turned up a quieter version of the same defect: the fallback resolving a condominium
billing lot to the base lots under it ran only over the permits' own BBLs, so whether a shed found its
lot depended on whether some *other* permit in the batch happened to name that BBL. A placement has to
be a function of its own permit — anything read out of the batch it was fetched in is this bug wearing
different clothes.

### Known gaps

- **19.8% of placed coverage sits on an edge whose street name does not match the permit.** Much of it
  is legitimate corner wrap and nothing separates the two, so that is an upper bound on the error and
  not a measurement of it. A further 1.28% sits more than 20 m from the permit's own lot.
- The feed has 74 gaps totalling 392 days, worst a 66-day hole in early 2021. A date inside one is
  interpolated rather than observed, and nothing in the UI says so.
