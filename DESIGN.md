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

## Repository traps

These came out of the scaffolding work and neither is about scaffolding. They apply to any file that
is rebuilt rather than authored.

**Packed git deltas a rewritten binary; LFS does not.** The shed artifact is 1.1 MB rebuilt every
morning, and "git keeps a whole copy of every version of a binary" is the sentence that kept it off
`main`. Measured over 177 real successive days, one commit each, repacked from scratch: **1.7 KB a
day** at `--aggressive`, 22 KB at git's default `pack.window=10` — 44× to 550× under the naive figure.
`closed.bin` is append-only but for two header bytes, so it deltas to **86 B a day** for a 940 KB
file; the churn is nearly all `open.bin`, whose job-number order scatters the day's new permits
through it, and git's own commits and trees add 385 B a day. Packfile size is not a reason to keep a
daily artifact off `main`, and it no longer keeps this one off: `public/sheds/` is committed and the
daily job pushes a commit there, which the client then reads off `main` through
raw.githubusercontent.com. `main` always exists, so nothing has to be bootstrapped before the first
read, and the read is as fresh as the job rather than as the last deploy.

**The same sentence is exactly true of LFS**, which stores each version whole and deltas nothing:
1.1 MB × 365 = **401 MB a year**, charged to the account's quota rather than the repo's. That is what
picked `public/sheds/` over `data/sheds/` for the committed copy. `.gitattributes` tracks
`data/<name>/*.bin` per directory, so a fifteenth directory under `data/` sits one habitual line away
from being tracked — and the line would read as restoring an oversight rather than as signing up for
400 MB a year. Outside `data/` there is no line to restore, and that is the whole of the reason: the
deploy copies `public/sheds/` out with the rest of `public/`, but the client does not read it there.

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

**Crown geometry.** A crown is a **spheroid spanning 0.4h to h**: a point where it meets the trunk,
widest at the middle of that span, a point at the top. Nothing is cast from the polygon's own height —
that would model the crown as a flat sheet at the top of the tree and overshoot by about a crown
radius, putting the whole of a median crown's shadow 35.8 m out at a 12° sun, visibly detached from
its own tree, where the crown it stands for reaches from 14.3 m. The 0.4 is an assumption, but crown ratio is the quantity that means
it: crown length over tree height is 0.39–0.60 for hardwoods (Russell & Weiskittel 2011 Table 1), which
puts the base near 0.4h. What has no source is where *within* that span the crown is widest — "height
to largest crown width" (Hann 1999), for which no published urban-broadleaf figure exists — and the
midpoint, 0.7h, is the assumption standing in for it. Cast crowns with **one** sun-disk sample where
buildings get six: a 10 m crown's penumbra is ~5 cm against 3.6 m pixels.

The crown is a sheet at no single height: its shadow is the union over the whole 0.4h–h span, which at
a 5° sun is a smear tens of metres long. So `crates/tiler/src/crown.rs` cuts each crown into
`CROWN_SEGMENTS` = 4 nested **slices**, slice `j` being the outline inset to the radius the crown keeps
`j/3·0.99` of the way up its own half-height, and each is *swept* between the ground displacements of
the two heights where the crown draws in to that radius.
Those two heights straddle 0.7h, so the bands **nest outward from the middle** rather than stacking up
from the base: the full-radius outline spans a single height and sweeps nothing, while the innermost
ring spans nearly the whole crown and sweeps nearly the whole smear. The union is therefore a **lens** —
the shadow narrows at the end nearest its tree as well as at its tip — which is what a crown that is
not a bar casts. Sweeping between two airborne cross-sections is the crown volume's own projection, and
does not contradict translating rather than sweeping *to the ground*, where there is no wall.

Four choices carry that:

- **The rings are cut by polygon offset with round joins.** An inward offset with round joins *is*
  Euclidean erosion — a concave corner opens into an arc of the offset's own depth — and it is the one
  detail a mitred or squared join would get wrong, cutting the corner off where the two offset edges
  cross and losing `(1 − π/4)·d²` of it at a right angle. A blob that pinches in two on the way in
  comes back as two rings, which is ordinary output for a merged canopy rather than a failure. The
  outline is simplified *before* it is offset, not after: a raw trace is a 1-foot raster staircase, and
  an offset opens every one of its concave steps into an arc, so the staircase bites a metre or two out
  of a ring it should not touch — clearing the steps first is the difference between losing 1.7% and
  3.3% of area at the deepest inset, and it makes the inner rings genuine offsets of the ring shipped
  as slice 0 rather than of a curve nobody ships. What kept the simplification last before was the
  curvature estimate, which is read off the raw trace and still is.
- **The slice radius comes from boundary curvature, not area.** A merged canopy blob's edge is
  scalloped by the crowns standing along it, so the local radius of curvature of that edge *is* the
  radius of those trees — and a lone crown's outline is one circle, so the same measurement gives its
  own radius. The estimate is the turning-weighted median of the circle through a chord pair, over the
  convex samples only. A *signed* mean would collapse to `perimeter/2π` for any closed ring (its total
  turning is exactly one revolution), and a plain mean of radii is unbounded, since a stretch that
  happens to run straight has `dθ → 0` and pours its whole length in.
- **Slices are spaced by equal height, not equal inset**: slice `j` is the cross-section at
  `u_j = j/3·0.99` of the way from the widest section to the crown's point, so its band is
  `0.7h ± 0.3h·u_j` and its radius `r·√(1 − u_j²)` — 100%, 94%, 75% and 14% of the outline's. The 0.99
  rather than 1 is what stops the innermost ring degenerating to a point, where it would cast nothing
  over the band it is the only slice covering, while still reaching 99% of the smear. Spacing by equal
  inset instead — rings at `d_j = j·r/4` — samples the spheroid where its profile is flat and misses
  where it is not: three of the four rings land within 25% of each other in width, pinning two thirds
  of the shadow's length at one width and capping the widest swept section at `r·√(1 − 1/16)` = 75% of
  true. For a 10 m tree with a 5 m crown radius at an 11.6° sun, whose true shadow is 29.2 m long and
  10.0 m wide, that is 28.3 m and 7.50 m with 68.3% of the length at the maximum; at equal height it is
  28.9 m and 9.44 m with 33.4% at the maximum, for the same four sweeps.
- **Sweeping, not translating copies.** Translated copies leave along-sun gaps unless they overlap, and
  avoiding banding by translation alone needs ~57 copies at z17 with a 5° sun. A sweep is gapless at
  any altitude, and the residual is a step in WIDTH wherever one ring gives way to the next —
  independent of the sun. Along the shadow the innermost ring stops at `u = 0.99` rather than at the
  crown's two points, leaving the union 0.5% of the smear short at each end.

All of one crown layer's slices go through **one** union — one `accumulate` in the bake, one Path2D or
one stencil-cover pass on the client. They overlap almost entirely, and `1 − (1−b)(1−τ·t)` must never
see `t > 1`. τ is still applied once to the finished crown layer, so the pyramid stays geometry-only.

### Known gaps

- The per-edge routing bake stays binned server-side, so above the cutoff the overlay shows the true
  sun while the router costs edges at the nearest bin.
- A whole park shares one 75th-percentile height. 69.85% of census trunks fall inside a canopy
  polygon, so a Voronoi split could give each tree its own — untested, and less urgent since casting
  from 0.4h cut the leverage of any height error by 60%.
- The transition dates in `src/shade/phenology.ts` are sourced but the ramp between them is a chosen
  curve, and NYC leaf-out is drifting ~0.43 d/yr later.
- `rainTau` (0.35 in leaf, 0.15 leaf-off) rides that same curve for the shelter factor, and it is the
  weakest number in the file: the light tau rests on 149 taxa, this one on about four studied trees.
  It sits at the low end of its 0.20-0.55 bracket on purpose, because it carries most of the shelter
  slider's signal on the least evidence. The scaffolding half of that factor is not a heuristic — a
  plywood deck stops essentially all vertical rain — which is why the slider is labelled a preference
  and shows no percentage.
- The CSTR tests do not cross-check the two implementations: the TS reader is tested against a
  hand-rolled TS writer and the Rust writer against a hand-rolled Rust reader, so a mistake mirrored
  into both would pass. The two agree today.
- **The stretched crown shadow is built but not visually verified.** Both halves are implemented — the
  bake (`crown_segments`/`append_sweep` in `shade.rs`), the CSTR v3 artifact, and the client
  (`castCrowns`/`traceRunSweep` in `src/tiles/sweep.ts`) — and `cargo test`, `bun test src` and
  `bun run lint` pass. What has *not* happened: nobody has looked at a render. An attempt used
  `?at=…&layers=shade` against the dev server and the camera parameter did not apply, so the
  screenshots were of the wrong place with the wrong overlay and were discarded. Nothing about the
  smear's appearance is confirmed — in particular whether the tip shows a stepped taper (too few
  slices) and whether the z14/z15 seam is continuous. That, and a K=3 vs K=4 comparison, is the next
  step, and it wants driving the map through the UI rather than the URL.
  - What *is* measured: `crown.rs`'s disc-calibration test exists and passes — discs of R = 3, 5, 8 m
    rasterized at 1 m read back 3.00, 5.00 and 7.91 m — and two merged 5 m discs read 5 m, which is the
    self-calibration the whole estimator rests on. It fixed two constants the hard way. The turning has
    to be read across a **chord** spanning twice the smoothing window, not between neighbouring
    samples: a traced outline concentrates its turning at a handful of samples and leaves the rest dead
    straight, and per-sample turning reads a 5 m disc at 3.4 m. And the radius has to be the exact
    circle through the three points, `chord / 2sin(θ/2)`, not `arc/θ`, which is 20% low on a small
    crown. With ±2 m smoothing and that chord, the `r̂` histogram over all 496,604 shipped NYC crowns
    is `<1.25: 14,540 · <2: 64,797 · <3: 110,067 · <4: 146,904 · <6: 152,446 · <8: 7,750 · <12: 100 ·
    ≥12: 0` — a peak across 3–6 m, 2.9% against the lower guard rail and nothing against the upper.
  - Cost, measured on this machine over NYC, one bin at a time (the brief's "6.2 s/bin, 0.5 GB" does
    not match what HEAD actually does here): baseline 19.4 / 20.2 / 18.7 s and 3.7–4.1 GB peak RSS for
    the 5.6°, 11.6° and 23.6° bins; after, 31 / 31 / 25 s of render plus a **one-time** 20–23 s to slice
    every crown, at 3.8–4.1 GB. So per-bin render is ~1.5× and peak memory is unchanged. CSTR goes
    53.4 → 109.2 MiB (+55.8, above the +20–40 the design expected), which is why `CACHE_BYTES` in
    `src/tiles/casters.ts` went 64 → 160 MiB.
  - Two approaches were tried and rejected on cost, both worth not rediscovering. Sweeping a concave
    crown as the ring, its translate and one parallelogram **per edge** — what `append_shadow` does for
    buildings — gives 24.5 M polygons and 153.8 M vertices for one low bin, 6.7 GB and 78 s, because
    `PolygonSet` costs ~200 bytes of `Vec` overhead per polygon. Emitting one strip per front-facing
    **run** instead fixed the memory but cost *more* time (119 s), because a run along a park boundary
    is a strip hundreds of metres long and every tile its bounding box touches walks all of it. Both
    together — runs, capped at `MAX_SWEEP_RUN` = 16 vertices — are what land at 31 s.
  - The 0.6 m Douglas-Peucker simplification moved out of `caster_chunks.rs` and into `crown.rs`, so it
    now applies to the pyramid's rings too. That is not a cost dodge: the design requires both halves
    to build slices from the same rings, and before this the chunks were simplified and the pyramid was
    not, leaving the two halves half a metre apart at the zoom they hand over.
  - `MAX_SWEEP_RUN` (16) is chosen, not measured.
  - The rings were cut by raster erosion before — a 0.5 m grid, an exact distance transform,
    thresholded and contoured — and are now `cavalier_contours`' polyline offset. Over all 1,076,146
    NYC outlines the offset has no failures and no degenerate output, runs the whole pass in 7.2 s
    against the erosion's 16.9 s, and comes back 1.7–6.5% smaller by level. The erosion was the larger
    of the two: it traces cell *corners* around the cells whose *centres* pass the threshold, which
    dilates every ring by a half-cell, and against an analytic disc the offset is the closer of the two.
    Where the two disagree about whether a ring exists at all it is mostly the erosion's 0.5 m grid
    failing to resolve one the offset finds — 61,695 crowns to 19,215 at the deepest inset.
  - The adaptive slice count is a divisor of 4 — 1, 2 or 4, not the design's `clamp(⌈smearPx/2⌉,1,4)`.
    The slices ship at fixed inset levels, so taking every stride-th of them is the only way both
    halves can cut the same rings; 3 has no stride.
  - **The pyramid and SHDB must ship from the same build.** Both read crown geometry through
    `crown.rs`, so a pyramid baked before this change and a SHDB baked after would disagree about
    sunset tree shade — the overlay would show a smear the router does not cost. The routing delta
    itself is unmeasured: `|attr| < 1` still holds by construction (`attr = intensity·(1−2·shaded)`
    with `intensity = sin(elevation) < 1`), and tree fractions can only grow, but the per-bin
    distribution of edges whose tree fraction moves by more than 10/255 has not been computed.

## The walking network

Where OSM maps a sidewalk, that way *is* the sidewalk edge. CSCL's centrelines supply a per-side
offset only on the sides OSM leaves, and only where OSM or the city's planimetric survey says there
is pavement there at all — a street both of whose sides come back silent is demoted to its own
centreline rather than deleted, because you walk an alley. `scripts/README.md` says how it is built.
This is why the seam between the two datasets is cut where it is.

### Whether there is pavement at all

Two sources answer it and neither alone can. **OSM's silence is ambiguous** — a mapping gap or a
genuinely bare kerb — and it is worst exactly where it would do most damage: OSM is silent on both
sides of 40.5% of Bronx street km, and only 24.0% of that is really bare, against 82.1% of the 7.6%
it is silent on in Brooklyn. The gaps fall in contiguous neighbourhoods
(Williamsbridge, Wakefield, Soundview, Mott Haven) that plainly have sidewalks. The city's
planimetric ROW-sidewalk polygons are an aerial trace of what is on the ground, so *their* silence
means something. A side has pavement when OSM maps a sidewalk there **or** the survey draws one; only
a side both come back silent on is bare. Where both call a street one-sided they name the same side
**96.8%** of the time — 11,177 of the 11,546 streets they both call one-sided, or 97.9% by kilometre.

**The survey layer is `52n9-sdep`, `sub_code` 380000, and its sibling is a trap.** "Sidewalk
Centerline" (`a9xv-vek9`) looks like the obvious dataset and is not: it captures interior-campus
walkways and explicitly excludes the street right-of-way, so it cannot answer the sidedness question
at all. The polygon layer can, and it is NYC Open Data rather than ODbL.

Both sources are read the same way — a side counts when half its samples hit, not when one lucky
point does — so a driveway or a corner cannot decide a whole segment. The stations are the **centres
of equal pieces** of the segment rather than every step from its start: a CSCL segment ends at a
junction, so a station standing on an end vertex takes its perpendicular offset into the *cross*
street's roadway, and on the corner slivers the city is full of that one station is the whole answer.
The point probe's own false negatives are then beaten down by a cross-street fan at each station
rather than by loosening the half rule. Where CSCL carries no `streetwidth` at all the fan is
**wider**, because there the offset it is fanning around is the citywide median standing in for a
width nobody recorded rather than a measured one off by half a metre.

**Those false negatives are not evenly spread, and the gate's budget must not be read as if they
were.** Against "OSM maps both sides" as the independent check, the survey confirms 94.7% of the
streets it gets eight or more stations on and 26.8% of the ones it gets one; both sides come back
silent on 55.4% of sub-15 m segments against 9.6% of blocks over 120 m, and on 57.5% of the 1,602
offsetted segments with no recorded width against 16.0% of those that have one. Part of that is real
— a sliver inside a junction has no pavement beside it to draw — and the rest is the probe's, so a
short or width-less street is markedly likelier than a long one to be demoted to its centreline. The
figures above are after both fixes; from the start of the segment and with one fan for every street
they read 20.6%, 61.2% and 66.9%.

### The existence gate

A side keeps its derived sidewalk edge only where the two sources above say there is pavement on it:
OSM maps a sidewalk there, or the survey draws one. A street both of whose sides come back silent
keeps no sidewalk at all and is **demoted to its centreline as a path edge, never deleted** — an
alley has no sidewalk, but you walk the alley, and so do the people on any street the city never
paved a side of. Alleys fall out of the rule with no special case of their own, which is the check
the build asserts on: a run where the gate does not take them has the rule the wrong way round.
About 15–20% of the derived sidewalk length the ungated network carried had no pavement under it.

The gate is guarded in both directions because it reads bits another program stamped. A STRT file
whose per-side bits were never written reads as "no sidewalk anywhere", which would silently strip
the city of pavement, so an implausible drop is a build error rather than a graph.

### The centreline dogleg

Observed live at Pearl and Water Street: a route walks the sidewalk, turns 90° **into the middle of
the roadway**, and turns back out to reach a plaza path. It is a seam defect, not a coverage or a
sidedness one — a dangling OSM endpoint snapped to its projection on the CSCL *centreline*, that
projection became a graph node, and the sidewalks were offset off the centreline only afterwards, so
the join landed where nobody walks. Citywide there were **13,636 such entrance snaps**, each costing
twice the street's half-offset: a median 13.1 m of detour, 19.2 m at p90.

So an entrance snaps to the nearest *walking* line — the sidewalk position of a side that has
pavement, or a centreline only where the street is itself the walking surface — and splits that. A
sidewalked street's centreline is never a snap target again. Both the continuation guard and its
right-of-way waiver stay measured to the centreline, because either question asks whether the way is
heading for this street and the street is where its centreline is: moving the far end of the
connector onto the pavement must not also change which entrances are accepted.

**A side offers its line when pavement *exists* there, not when this build derives an edge for it.**
Those are different masks: the derived one is zeroed wherever OSM maps the pavement itself, so
keying the targets to it would offer no line along a fully mapped block — and an entrance reaching
for one would find nothing and be dropped with its island, or take the far side's line and cross the
roadway to reach it under the 8 m waiver, which is the dogleg again. The corner these snaps bind to
is materialized off the existence mask for the same reason.

**Another OSM way is a walking polyline too, and is deliberately not a candidate.** Joining two OSM
ways is the dangling-end merge's job, and that pass asks a second question this one cannot — how far
apart they are through the network. A 20 m way-to-way snap here would quietly override it.

### OSM is the pavement, CSCL is the label

The dogleg is what makes OSM primary rather than supplementary. It is a seam defect, so it is not
answered by better coverage or better sidedness, and it is fixed *by construction* wherever OSM has
mapped the block: the sidewalk way is in the graph, the entrance footway meets it at a node the
mappers already shared, and the centreline never enters into it. **86% of the dangling entrance
endpoints have an OSM sidewalk mapped within 30 m**, so most of that join was there all along and the
old build discarded it by excluding sidewalks from the ingest and then re-invented it badly.

The cost of ingesting `footway=sidewalk` is that the network doubles unless something takes the
derived offset away, and **the exclusivity has to be per stretch, not per side**: a side is not all
one thing, and gating it on a per-side threshold left every partly-mapped side carrying its OSM way
and a full-length offset over the same ground. So the association measures which stretches of a side
OSM covers, and the derived offset is cut back out of exactly those. **It has to be its own corridor
test and not a widening of the conflation's 6 m dedup band**, which was tuned to shed on-street
protected bike lanes: a narrow street's sidewalk sits at ~5.7 m, inside that band, so widening it
would eat the pavement the swap exists to keep.

**CSCL labels the geometry OSM draws.** OSM's sidewalk ways are 98.7% unnamed — 1,813 of 137,014
carry a name — so a matched way takes its street's name, its N/E/S/W side label, its half-offset byte
and its cover byte from the CSCL side it flanks. That side label is the nearest cardinal to the
side's outward normal, with an exact diagonal resolved to N/S. The half-offset has to keep meaning
"half the roadway plus the inset of the street I flank", because the shed depth measurement infers
the kerb from it. The cover byte transfers because the OSM line sits a median 0.78 m from where that
byte was sampled, which is noise against the density kernel's 4 m across-street σ.

`footway=traffic_island` comes in with the crossings and is costed as part of one: a crossing chains
through the island in the middle of it, so an island read as anything else leaves the two halves of
every divided street's crossing joined to nothing.

### Named by the street it flanks, not by the way id

The durable edge key is `(source id, side, ordinal)` — see *Named by its source, not its position*
under sheds for why an edge cannot be keyed on its position. An OSM sidewalk way could supply its own
way id as that source id, and must not. Measured against Overpass attic snapshots joined to today's
extract, **10.65% of the 2022 sidewalk way ids and 3.13% of the 2024 ids are dead now** — about
1.5–2% a year, concentrated exactly where mapping is active, which is now the Bronx frontier.
`closed.bin` is append-only history whose spans are never re-placed, so those losses would be silent
and permanent between full rebuilds. The association already computed for the labels mints the key
instead: a mapped sidewalk edge is keyed on the CSCL `physicalid` it flanks, stable however mappers
split or redraw the way. Way-id keys survive only on the ~155 km of street-less ways — esplanades,
bridge decks — where scaffolding is rare and 1.5–2% a year is an acceptable exposure.

**The ordinal carries no cross-build meaning**, and two schemes that tried to give it one were
measured and rejected. An along-street *index* shifts every later sibling down one when a piece is
removed, so a span keyed to ordinal 2 silently resolves to what was ordinal 3 — the adjacent piece of
the same street and side. Plausible, undetectable, wrong. A **position-derived** ordinal, the piece's
start offset along the centreline quantised into the u8's 255 buckets, cannot pick a quantum: the
buckets must span a `physicalid` row that runs to 2,505 m, while the pieces the ordinal has to
separate are corner and crossing slivers — cutting the 137k sidewalk ways at their junction nodes
gives 293,797 pieces of **median length 4.2 m**, 52.3% of them under 8 m. At any workable quantum
about half collide with a neighbour at build time, and the geometry drifts underneath: 3.1% of way
start nodes moved more than 8 m in two years, so a vacated bucket gets reoccupied by a drifted one.
Both schemes turn a removal into a neighbour match, which is the one failure this artifact may not
have. What makes them unnecessary is the key-space gate — the artifact resolves nothing at all
against a graph carrying a different set of keys — so an ordinal never has to survive a rebuild.

### The seam

Two networks meeting is where gaps and duplicates hide, and there are four joins to make.

*Inside a mapped block* there is nothing to invent: OSM's own shared nodes carry the walk, and
mid-block crossings and plaza connections come along free — connectivity the derived graph could not
express at all.

*At a mixed intersection*, where some legs are mapped and some derived, the corner fan is still built
from the CSCL street-ends. Every street-side slot resolves to exactly one **terminus**: the derived
corner node where the side is derived, the nearest incident OSM sidewalk node within the corner
radius where it is mapped. Crossings and fan joins then connect termini pairwise, whichever kind each
is. Exactly one, in both directions — a slot with no terminus leaves the two networks passing within
metres of each other and never meeting, and a slot with two leaves a corner standing beside a corner.

*Where the mapping ends mid-block* — uncommon, since sidewalks are mapped block-wise — the OSM end
and the derived edge on the same side splice end to end.

*Where OSM draws a whole block as one unbroken way* there is no node for the seam to bind to at all,
so a corner standing metres from that pavement reaches nothing and the walk goes round the block. The
corner cuts the way at its own projection, which gives the seam the node it was missing; nothing
downstream changes, because a cut is only a node. It is guarded, because a line passing close is not
by itself pavement this corner opens onto — `cut_sidewalks_at_corners` states the three guards and
what each one is measured against.

### Crossings

Where OSM maps a crossing it is the crossing, at its true position, including the marked mid-block
ones. A crossing is still **synthesized at every corner pair OSM does not serve**, suppressed only
where an OSM crossing already joins that pair: without the supplement the router would refuse the
legal unmarked corner crossing and detour around it, so mapped areas would come out worse than
unmapped ones. Differences remain where OSM maps a crossing on one arm of an intersection and not
another.

This is also what carries a walk from one block face to the next. A block face's mapped pavement
stops at every kerb — see *Where a shed actually stands* for the 152,629 sidewalk ends this produced
against 54 in the derived network — so a walk that steps only from sidewalk to sidewalk stops dead at
the first corner.

### An OSM refresh is a deploy decision

OSM's NYC sidewalk network tripled between 2022 and 2026 and the mapping campaign is still running,
mostly on the Bronx frontier. So a refresh is deliberate and roughly annual rather than continuous,
and it always carries `build-sheds` in the same deploy — see *A source refresh and its re-place are
one deploy*. Under the existence gate a refresh is monotone improvement, sides upgrading from derived
to OSM, but route diffs between deploys now include OSM edits, which they did not before.

### The order conflation runs in

Every pass is a rule about that seam and the order is the design: node the CSCL network against
itself, dedup OSM against CSCL, node the paths among themselves, dedup the named orphans a second
time in a wider band, weld at-grade crossings, snap dangling entrances, apply the accumulated CSCL
splits, merge the dangling ends the network says are a block from what they touch, then node the
components nothing anchors onto the network they stand on. Every tolerance in it is a named constant
carrying the Central Park measurement that chose it, so none of them should be moved by eye.

**The first pass exists because the city does not node an alley's mouth.** `graph.rs` nodes protos by
their endpoints alone, which is all it takes wherever the city splits both lines at their junction —
and an alley is a T onto the *interior* of the street it opens off. **3,795 alley ends citywide stand
on a street centreline** at p50 0.00 m with no node of their own, against 63 street ends and 108 path
ends that do the same. With no cut there the alley lattice behind a block is a walkable island
nothing on the street can reach: 269 of 312 km of alley, measured before the pass existed. So a
street endpoint standing on another street's interior cuts it there and moves onto the cut, and the
noding then sees one point.

**The two dedup bands are one rule split by how much evidence it has.** Between 6 and 10 m geometry
alone cannot tell a re-mapped street from a path that merely runs beside one — at 10 m a single band
would take the Jamaica Bay and Marine Park greenways with it — so the wider band asks for two more
witnesses: the way must carry the same street name as the CSCL segment it parallels, OSM labelling
it as the street it duplicates, and it must share no node with any other OSM way. A path network's
members meet each other, and Central Park's interior paths, the tuning set for the 6 m band, are a
connected net. What passes both tests is a second drawing of one named street lying inside its own
right-of-way.

**A gap and a network distance are different questions, and the last pass needs both.** A degree-1
endpoint a couple of metres from another node, and a whole block from it *through the network*, is a
seam between two mappings of the same place — the second OSM drawing of an alley ending 1.7 m from
the corner the first one already reaches. The gap alone cannot say that: a pier tip, a cul-de-sac
path and a fenced-off stub all sit metres from something. That is why this is a pass of its own and
not a loosening of `graph.rs`'s 1 m near-miss union, which is a CSCL digitization sliver with no
topology in it and stays as tight as it is. The end that moves is always OSM's: CSCL geometry feeds
the corner and crossing construction downstream and is left exactly where the city drew it.

**The last pass is the first one again, read over the walking network.** Step 0 exists because the
city does not node an alley's mouth; step 7 exists because OSM does not node a trail that crosses a
lane it drew separately. The defect looks identical from the graph's side — a walkable lattice all
present, all internally connected and all unreachable — and the evidence has the same shape. Of the
2,233 components the island drop would take, **437 come within 1 m of a component it keeps**, at p50
0.02 m and with 369 of them inside 0.1 m; the next band, 1 to 4 m, holds 34, and past 4 m the count
climbs again. Below 1 m the two lines cross in plan view and only the node is missing; above 4 m the
distance is a gap in what OSM drew, and a pass that reached across it would be inventing a walk
rather than repairing a noding. So a vertex of an unanchored component standing within 1 m of an
anchored line cuts it there and moves onto the cut, and the island drop below is left judging only
what is genuinely out of reach. It runs last because it can only ask its question of a network every
other pass has finished with, and it runs to a fixed point because joining one component can bring a
second within reach of the first. **The island takes one join, not one per touch**: reachability
needs a single node, and a second would invent a second junction OSM never drew. Neither side may be
a bridge or tunnel deck — a trail under a viaduct is a metre from it in plan and a storey below it on
the ground — which is the same grade-separation guard the weld and the dangling-end merge carry, and
it is what keeps a trail net from being welded to the highway or rail cut it passes beneath.

What the pass deliberately does not do is close the gaps above 4 m, and the measurement is why.
Conditioned on parkland, on the connector continuing the way's exit direction within
`CONTINUATION_DEGREES`, and on the connector crossing no other line, the distribution past 4 m stays
a smooth continuum with no trough anywhere in it — 4 to 8 m holds 89 components, 8 to 20 m holds 402,
20 to 50 m holds 521. There is no bound in that range a measurement can defend, so none is taken.

### What the whole city is held to

The defects the swap produced were all of one kind: every local rule held and the network still did
not hang together. A stranded alley lattice is all present, all internally connected and all useless;
a crossing that loses its traffic island keeps both halves and joins neither; a phantom sidewalk puts
a walker on ground the road runs over. A fixture cannot see any of them, and neither can the app —
the router answers a trip onto a stranded alley by silently snapping to the nearest street. So the
build runs a handful of whole-city properties over the finished graph and fails on them.

**Each bound is measured from both sides**: the finished city on one, and a build of the same city
with the fix that closed the defect taken back out on the other. A ceiling then sits in a gap that is
known to be a gap — several times what the city measures, and an order or two under what the
regression measures — rather than at a number somebody liked the look of. Where there is no far side
to measure, the bound says so. And a property that cannot separate a real defect from correct
topology, like the hairpin at a cul-de-sac head, is counted and reported rather than asserted:
inventing a join over an arbitrary distance would be a worse lie than the honest break.

**One caller runs the pipeline and holds none of them.** `tiler key-probe` builds a graph out of nine
slices of the city so the shed gate can stamp what the key assignment *does* rather than what its
source text says (`scripts/README.md`, "What the stamp covers"). Every bound above is held over a
whole city's population — a fixture has 17 km of alley where the floor is 50, and seven scored cells
where it is 500 — so on that path they are reported and not asserted. It is the one place a fixture
*is* the point: what is being measured is the key space, not the network.

**A walk has properties no edge can answer**, and four of the same campaign's findings are of that
kind: how far a route goes against the straight line, whether it doubles back over a street it has
just crossed, whether it threads roadway to roadway, and whether it arrives at all. None of them
shows up until thousands of walks have been asked for, so `tests/route-sampling.test.ts` routes 400
trips in each borough between real PLUTO tax lots — addressed parcels, where random lat/lngs would
land in the harbour and manufacture a routing failure — and holds the distributions rather than any
one route. It cannot run beside the unit tests: it reads the built graph, which is gitignored, and
two LFS files standard CI checks out as pointers, so it runs on the manual deploy path beside the
shed pairing check.

Those bounds are calibrated against a floor and a ceiling the app itself imposes: the floor is a
plain shortest path with every scenic weight at zero, which no cost-model change can go below, and
the ceiling is the strongest bias one slider can ask for. At n = 400 a borough on the graph of
2026-08-02 (628,693 edges), over Manhattan, the Bronx, Brooklyn, Queens and Staten Island, the app's
defaults give a **detour ratio** median of 1.305/1.325/1.333/1.327/1.415 and a p90 of
1.451/1.539/1.652/1.547/1.873, a **reversal share** of 2.0/6.8/26.0/22.8/3.3% of which
0.0/0.0/0.3/0.0/0.0% are avoidable, a **longest crossing run** of 4/5/5/6/4, and no routing failure
anywhere. Flat weights move the detour median to 1.221/1.250/1.272/1.268/1.344, its p90 to
1.375/1.422/1.549/1.447/1.737 and the reversal share to 1.3/4.5/12.5/12.0/2.0%, with the avoidable
share **0.0% in every borough** — which is what says that bound measures the cost model rather than
the network, since an avoidable reversal is strictly extra distance and a shortest path would never
buy one. The tree slider at maximum reaches a median 1.354/1.365/1.368/1.369/1.476, a p90 of
1.568/1.670/1.763/1.683/2.188 and 3.0/9.0/31.0/27.5/4.3% reversing, of which 0.0/0.0/0.3/0.0/0.3%
avoidable.

### The overlay may not offer a walk the router cannot give

The tree-cover overlay and the routing graph are built from different sets. `tiler chunks` draws
straight from `data/paths/<id>.bin`; `tiler graph` conflates that same file against CSCL and then
**drops whole OSM path components nothing anchors** — 1,815 islands, 211.2 km, once step 7 above has
noded onto the network everything that was standing on it — as unreachable. So the map paints 4,036
ways green and tree-lined that no route can enter or leave, covering 3,979 `PATH` records and 204.5
km: Floyd Bennett Field's North Forty, the Staten Island Greenbelt, Ferry Point Park, Alley Pond.
Asked for a walk between two ends of one of those trails, the app answers with a 2.3 mi road detour
while drawing the trail underneath it. Step 7 took 668 ways (656 records, 31.5 km) out of that set —
the grave-row lattices of the Cypress Hills and Mount Judah cemeteries are the largest of them — and
the overlay drew those again with no change to any of the code below, which is what the
one-directional reconciliation is for.

**The overlay is the side that gives way.** A green line is an offer, and the graph is the only thing
that can honour one, so the graph now writes the ways it stranded (`public/routing/stranded.bin`) and
the second chunk pass marks them undrawn. That is not a claim the trails are unwalkable — most plainly
are. It is that a layer must not advertise what the router will refuse.

The reconciliation is one-directional and deliberately so: the drawn set is filtered down to the
routable one, not the other way round. Making those components *routable* is a different and larger
question, below.

### Known gaps

- **204.5 km of walkable trail is still drawn nowhere and routable nowhere, and no measurement says
  where to join it.** Step 7 above closed the half of this that was a noding defect: 384 components,
  34.3 km, that were standing on the routable network with no node there. What is left is not that.
  Measured over all 2,233 components the drop would take, the distance from the nearest one to the
  network it would join is a continuum from 4 m out with no trough in it at any conditioning tried —
  parkland, the entrance snap's continuation guard, or a connector that crosses no other line. Floyd
  Bennett Field's North Forty, the worst single case, is **36.3 m** from anything anchored; the
  premise that OSM merely leaves out the last few metres does not hold there, and a bound wide enough
  to reach it welds 882 further components (127.6 km) that no evidence vouches for.
  Closing this needs evidence the graph's own inputs do not carry — a parkland boundary, an OSM
  `barrier`/`entrance` tag, or a survey of where park entrances actually are — not a wider tolerance.
  Until then the overlay's silence is honest and those trails are missing from both. **Worth doing,
  not urgent**: nothing is wrong on the map today, the router simply cannot offer a trail nobody has
  drawn a way onto, so this waits for whoever wants to bring an entrance source to it.
- **The per-borough drop criterion was waived in the Bronx, and nobody has checked it by eye.** The
  criterion was that no borough lose much more derived sidewalk than the city as a whole, and the
  Bronx came in 2.8 pp above it (25.7% against 22.9%), which is a fail. It was waived on the
  judgement that the number is measuring OSM's thinner coverage there rather than pavement the graph
  is missing, and the evidence for that is a browser pass over the finished network: **zero routing
  failures in 700 sampled trips**, a median detour ratio of 1.38 against Manhattan's 1.32, and worst
  cases that are all genuine terrain — the Van Cortlandt trails, the Bronx Community College bluff,
  the Botanical Garden. That is a judgement rather than a measurement of pavement, so it is left open
  until someone drives Bronx routing in the app and confirms it.

## Sidewalk sheds

Scaffolding is the one thing on the map whose source changes every morning, so it is the one artifact
rebuilt by a daily job rather than by a deploy — and therefore the one committed thing under
`public/`, since a job that runs no build has to be able to read the last one out of the checkout.
The client does not read it out of the deploy either: Pages ships on `workflow_dispatch` and the
artifact changes every morning, so anything read same-origin would be exactly as fresh as the last
manual deploy — ~16 new permits a day against ~13k standing, so a month between deploys is ~4% of the
standing set wrong. It is fetched off `main` through raw.githubusercontent.com instead, which is as
fresh as the job: `raw` serves any branch with `access-control-allow-origin: *`, gzip, an etag, a
five-minute cache and range requests. `main` rather than a side branch because that is where the
artifact is committed and because `main` always exists — there is no branch to bootstrap before the
client can read anything. It is also why this is the one store that may never move to LFS (above):
`raw` would serve a pointer's text rather than its bytes. A dev server reads the local `public/sheds/`
like every other artifact. `scripts/README.md` says what it holds; this is why.

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

**A shed stands on the frontage of the lot its permit was pulled for, and on nothing else.** A corner
lot fronts two streets and both frontages are its own, so a run wraps its own corner — 80 Pine Street
really does run onto Pearl, Maiden and Water, because 80 Pine is the whole block. The pavement in
front of the next building along is not the lot's, however much length the permit declares, so the
overrun is DROPPED rather than run on down the block. The declared linear feet is a ceiling on the
run and never a target for it: it is a number on a permit, and nothing about it entitles a structure
to stand in front of a building whose permit it is not.

*A frontage is the boundary a lot sweeps along one pavement, not the span between its two ends.* It
was read as the interval from the first facing boundary sample to the last, which is a different
thing wherever a lot reaches the same pavement twice: a through-block lot with an arcade arm either
side of a neighbour's building, a U around a rear yard, a corner arm projecting onto the far end of
the same edge. The span between them covers the neighbour, and it is not a rounding — **414 of
108,803 spans, 8,214 m in all, stood off their own lot**, up to 193 m of one edge at a time. The
frontage is now walked out from the lot's closest approach to that pavement, sample by sample, and
stopped where the boundary leaves — including where it leaves by running past the end of the edge,
which a projection reports as the end rather than as a gap. **0 of 108,457 spans** are off their lot
after it.

That is a hard constraint with no tolerance, so it costs placed length and is meant to. Against
declared length the placement falls from **96.37% to 83.52%** — corner lots 95.48% → 89.03%,
mid-block lots 99.38% → 64.72% — and **439.1 of 2,483.1 declared miles** now have nowhere legitimate
to go. Against the denominator that means something, the lot's own frontage, it rises to **99.51%**
(corner 99.45%, mid-block 99.83%): the shed uses what its property has. 56.93% of permits declare
more than their lot's frontage holds, by a median of 2.2 m and a p99 of 100.4 m, and that excess is
now a printed diagnostic — a permit declaring far more than its lot can hold is usually a bad
geocode — rather than something the placement chases.

What the old rule cost is easiest to see span by span. Measured back to the lot it was placed for,
placed length used to sit a median **6.78 m** away and **49.39% of it was more than 7 m off** — half
the scaffolding in the city was in front of somebody else's building. It now sits a median 1.89 m
off, p95 5.11 m, with 2.63% beyond 7 m. The corroboration falls out of an unrelated number: 121,057
of 121,058 spans now measure their own deck depth against a lot boundary standing behind them, where
6,069 of 118,014 had no frontage behind them to measure at all.

Every constant in `shed-map.ts` was picked by scoring the whole 61,331-permit feed against it, so
none of them should be tuned by eye. What tells a lot's own pavement from the pavement across a road
is the same side band that already told the permit's street from its opposite side, measured from the
lot's closest approach to its own street: over the feed, pavement the lot fronts is within 4.0 m of it
at p95, and pavement across a street is never nearer than 7.2 m.

**Pavement is continuous; the edges it is cut into are not.** The walk has to be written against the
first and never against the second, because a graph rebuild re-cuts one kerb into different edges
wherever anything nearby changes, and two places took an edge for the pavement.

*Where along the frontage the shed sits.* A permit shorter than its lot's frontage is one run anchored
on the building, and the anchor used to be a position along whichever candidate edge came nearest the
lot — so a rebuild that split that edge in two handed the anchor to the other half and clamped it to
the new edge's end, sliding the shed tens of metres down its own block face with its street, its side
and its length all unchanged. It is now the point of the measured frontage nearest the building's
centre, and the edge holding that point follows from it. The distances the old choice ranked are as
close as they sound: the gap between the nearest candidate edge and the runner-up is under a
centimetre for 1,438 of 59,773 placements and under a metre for 9,824, while the same gap measured to
the next distinct *pavement* — the (source id, side) group — is an order of magnitude wider at the
same quantiles. What is left is an exact tie, the anchor landing on the node two pieces of one
pavement share, and that is settled on the arcs' own coordinates rather than on edge ids.

*Getting past a corner, and the step across that was rejected.* A block face's pavement now stops at
every kerb: **152,629 sidewalk ends have no other sidewalk on them, against 54** in the derived
network this replaced, and what carries the pavement to the next block face is a crossing edge over
the roadway. A walk that steps only from sidewalk to sidewalk therefore stops dead at the first
corner — 57.2% of runs ended with nothing to continue on to, against none at all before.

Letting the walk step over one crossing or link to a sidewalk of the same street and the same side
was built and measured against the whole feed. It works, on the number it was aimed at: placed
against claimed length on corner lots went **94.67%** on the old network, **86.33%** when the network
moved, **95.28%** with the step across, and 97.31% if a crossed continuation is also allowed to beat
a direct one on straightness. It is rejected anyway, and the reason is what the step physically is:
crossing a side street's roadway and resuming on the NEXT BLOCK, in front of buildings whose permit
this is not. No amount of recovered length buys that. The graph no longer indexes crossings at all,
so the walk cannot take one.

What the step was reaching for is met inside the lot instead. The lot's own frontage is a **single
walkable piece for 98.40%** of lots, so those kerbs almost never cut one lot's frontage in two — and
where they do (0.95% rejoined only across a crossing, 0.65% not rejoined at all), and at the corners
the network fails to node, the recovery pass spends the stranded run on the lot's own unreached
frontage without walking to it. That is why the corner wrap does not depend on the step across:
**68.70%** of corner lots can reach their second frontage sidewalk to sidewalk, only 2.40% need a
crossing to, and the remaining 28.90% could never have been walked to at all. Recovered length is
discounted in the confidence, because which piece of its own lot the structure occupies is inferred
from the length rather than traced on foot.

**How deep the deck is, measured rather than assumed.** A shed spans the pavement from the building
face out to roughly the kerb, and no dataset New York publishes carries a sidewalk width. Two lines
pin it. The kerb falls out of the graph: a sidewalk's baked polyline is the centreline offset by half
the CSCL kerb-to-kerb roadway plus a fixed `sidewalkInsetMeters`, so the kerb is always exactly that
inset inboard of the line — the offset byte measures the ROADWAY and stops there, and knows nothing
about the pavement beyond it, so the baked line is where the inset says the middle of the pavement is
rather than where it is. The building line is the tax lot the frontage is already measured against,
taken as the median SIGNED offset of the lot's street-wall samples from the polyline, signed
off the graph's own geometry-right flag rather than off the wall's normal, which is unreliable
exactly where the baked line lands inside the lot.

Over the whole feed that comes out as a clean bell around **3.7 m** — a 12 ft sidewalk, which is what
New York builds — which is why the flat 4 m it replaced looked defensible in aggregate and was wrong
in every particular place: a Midtown avenue reads 6 m and a Queens side street 2.5 m. The artifact
stores it clamped into **[0.1 m, 8 m]**. The ceiling is 26 ft, wider than a Midtown avenue's pavement,
and is where the distribution stops falling and goes flat out to 32 m — 3.7% of spans, and
superblocks, forecourts and plazas rather than pavement, where the lot line is not the building line
at all. Those are clamped rather than discarded because clamping is the honest drawing: the deck runs
out from the kerb over as much pavement as there can be, and the ground between it and a tower set
20 m back is not decked by anyone. The floor is the encoding's alone: a depth rounds to decimetres and
zero decimetres is the byte that means "not measured".

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

### A source refresh and its re-place are one deploy

A durable key survives a rebuild without promising to still name the same edge across one — the
ordinal in it is a within-build disambiguator and nothing more. So the artifact's header carries the
hash of the graph's whole **key space**, and `shedsOn` resolves nothing at all against a graph that
does not carry the same one. That is the fail-safe direction: bare pavement is a failure anyone can
see, scaffolding down the wrong street is not. What it costs is a deploy discipline the rest of the
site does not have, because every shed vanishing is also invisible until someone looks at the map.

The gate is on the key space rather than on the graph's bytes, which is where it started and where it
could not stay. The bytes carry an f32 length per edge, and the geodesic and offset maths land a few
of them a ulp apart between a macOS laptop and the deploy's Linux — 95 build statistics agreeing to
the last digit but one — so an artifact placed by hand could never match a graph CI built, and the
deploy failed on a difference no shed can feel. The key space is `(source id, side, ordinal)` per
durable edge, sorted and hashed: integers all the way down, and the only thing a span resolves
through. Ordinals run 0..n-1 within a `(source id, side)`, so a source segment that splits into a
different number of edges moves the set, which is the shape every conflation and re-noding change
takes. What it cannot see is a rebuild that keeps every key and moves the pavement under it — the
same street re-digitized in place — and that is why the re-place below is unconditional rather than
conditional on the gate.

Proving an individual key still means what it meant would take the re-placement it would be trying to
avoid, so a refresh that moved nothing near any shed blanks exactly as one that moved everything
does. Re-placement is the rectification: it
re-derives all 72,020 records from the DOB history and the tax lots against the new graph, keeping
nothing from the old artifact, which is why a forgotten re-place cannot corrupt anything and the next
`build-sheds` heals it. A graph-change table that migrated the old keys was evaluated and declined —
it would make `closed.bin` a function of the chain of graphs it migrated through, the exact property
the 27-record replay bug was fixed to remove, and it buys only the two minutes a cached re-place
costs.

**Enforcement sits at the deploy, because that is the only place holding both halves.** The graph is
built by the deploy and never committed; the artifact is committed and never built by one. A push or
a PR therefore has nothing to compare — `build.yml` runs `check-sheds` between the tile build and the
Pages upload, and a refresh that forgot `build-sheds` fails there rather than shipping. That is late,
but it is not after the fact: nothing reaches the site.

**The daily job has to refuse rather than re-stamp**, which is the sharper edge of the same rule. It
carries every held record forward untouched and writes the header itself, so stamping the deployed
graph's key space over an artifact placed against another one would hand the client old keys wearing
the new graph's name — turning the blank map into a wrong one within a day of the mistake, and healing
the one symptom anybody would have noticed. It reads the deployed graph first and stops on the
disagreement instead, leaving the map blank until the pairing is fixed.

What is left is a window rather than a hole: the artifact is committed before the deploy that catches
the graph up, so the live map draws no sheds between the two, and the daily job refuses inside it.
`scripts/README.md` has the procedure.

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
different clothes. `scripts/shed-drill.ts` is what holds it to that: drop one permit, rebuild, and no
surviving record may have moved. Run it after anything that moves the graph, since placement snaps
against the graph and the artifact outlives it.

### How it casts, and how it shelters

A shed deck is geometrically a crown: an opaque slab floating clear of the ground, so its shadow is
its footprint *translated* and there is no wall to sweep — which is what `castCrowns` already does for
canopy. `castSheds` is that same translate at a fixed 4 m rather than at 0.4 of the caster's own
height, DOB requiring 8 ft of clearance and typical decks running 12–15 ft, and with plywood passing
nothing, so decks join the buildings' layer rather than the canopy's τ.

They enter only the **generated** half of the pipeline. At z14 a pixel is 7.24 m and a deck is 3.7 m
deep at the median, so it is sub-pixel in the baked pyramid and its shadow spans 0–2.6 px; everything legible about
scaffolding lives at z15+, which is exactly where the client is already casting. That is what keeps
sheds out of the bake, and so what keeps the daily permit update free of a deploy. Their geometry is
the display overlay's own (`src/tiles/shed-decks.ts`), handed to the worker whenever the picked date
moves the standing set — the one caster that is not baked, because which sheds are up is a property of
the day. It is the same ring through the same call: the caster displaces the polygon the band is
filled from, so a shadow cannot leave a corner the display drew differently, or one it never drew.

**Under the deck is not shaded at every sun position**, which is what the first version assumed. A
deck is a slab, not a tunnel: trace a ray back toward the sun from a point beneath one and the point is
lit as soon as that ray has moved further *across* the sidewalk than the deck is deep. Only the
across-street component of the translate counts, so a sun running along the street slides the shadow
down tens of metres of the shed's own length while a sun across it clears the pavement's width within
a few degrees of elevation. No single elevation threshold can say that; the angle between the sun and
the street is what decides it — and how far the shadow has to slide is the edge's own measured DEPTH,
the mean of its spans' weighted by the length each covers, so the falloff a 6 m avenue deck gets is
not the one a 2.5 m side-street deck gets and the router agrees with the band on screen. Depth reaches
neither of the other two terms: shelter is a roof either over you or not, and the avoid penalty is
charged per decked metre of length.

Shelter reads the same coverage number, but `shed` and `directCanopy` are **fractions of an edge's
length, not transmittances at a point**, so they combine as a union of coverage rather than a stack of
opacities. The canopy half could not reuse GRPH's existing cover byte: that is the *smoothed* field,
an oriented anisotropic Gaussian at σ 15 m along the road and 4 m across, built that way on purpose so
the overlay does not lurch block to block. It answers "is this a leafy stretch"; shelter needs "is
there canopy directly overhead here", which is the raw indicator integrated along the sidewalk with no
kernel at all. One more baked byte, and the reason GRPH went to v6. `rainTau` is in the shade notes
above.

### Known gaps

- **32.0% of placed coverage sits on an edge whose street name does not match the permit**, and the
  undifferentiated figure reads as a defect when most of it is not one. It splits: **30.8 points** are
  runs whose permit DID find its own street on the lot and wrapped onto the lot's other one, which is
  the corner rule working; **1.2 points** are permits naming a street nothing near the lot spells the
  same way, where the placement falls back to the nearest frontage there is — a misspelling ("AUDOBON
  AVENUE"), a form the city does not use ("WEST WASHINGTON PLACE" against WASHINGTON PL), or a street
  renamed since the permit ("7 AVENUE" against ADAM CLAYTON POWELL JR BLVD). Real error lives inside
  the first figure and nothing separates it out, so that is still an upper bound rather than a
  measurement.
- 1.5% of the backfill places nowhere at all, against 26 of today's 7,535; the commonest reason by
  some way is a permit naming a street no sidewalk near its lot matches. Confidence is below 0.4 for
  4.2% of permits, and nothing costs on it — it is a diagnostic in the artifact, not a routing input.
  A synthetic score is not evidence the deck is elsewhere, and a shed that might be there is a reason
  to avoid the block rather than a reason to charge less for walking under it.
- **Deck height is 4 m and is an assumption**, not data — the permit carries none, and it sets the
  cast shadow's length directly. Depth is measured per span now, but through the tax lot and the
  graph's own kerb estimate rather than through anything that surveyed a pavement, and 23% of spans
  are held up off the floor by what a shed can be built at rather than by what was measured — which
  hangs 18% of them out over the kerb, by 2 m at the tail.
- Shed shadows appear on the z14 → z15 step, the only layer with such a discontinuity. Measured over
  a downtown screenful they darken 0.28% of it, against a step that redraws the whole layer from a
  magnified raster to swept vectors, so nothing about the crossing reads as scaffolding arriving.
- The cast shed shadow is not a routing term. It falls mostly on the roadway, and reaches the
  opposite sidewalk only below ~15° sun, where the buildings have shaded everything anyway.
- Shelter assumes shed and canopy coverage are independent along an edge. Both are per-edge fractions,
  so the real overlap is measurable rather than assumable — it just has not been measured.
- The feed has 74 gaps totalling 392 days, worst a 66-day hole in early 2021. A date inside one is
  interpolated rather than observed, and nothing in the UI says so.
