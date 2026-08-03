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
- `rainTau` (0.35 in leaf, 0.15 leaf-off) rides that same curve for the shelter factor, and it is the
  weakest number in the file: the light tau rests on 149 taxa, this one on about four studied trees.
  It sits at the low end of its 0.20-0.55 bracket on purpose, because it carries most of the shelter
  slider's signal on the least evidence. The scaffolding half of that factor is not a heuristic — a
  plywood deck stops essentially all vertical rain — which is why the slider is labelled a preference
  and shows no percentage.
- The CSTR tests do not cross-check the two implementations: the TS reader is tested against a
  hand-rolled TS writer and the Rust writer against a hand-rolled Rust reader, so a mistake mirrored
  into both would pass. The two agree today.

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
have. What makes them unnecessary is the hash gate — the artifact resolves nothing at all against any
other graph — so an ordinal never has to survive a rebuild.

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
splits, then merge the dangling ends the network says are a block from what they touch. Every
tolerance in it is a named constant carrying the Central Park measurement that chose it, so none of
them should be moved by eye.

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
2026-08-02 (627,106 edges), over Manhattan, the Bronx, Brooklyn, Queens and Staten Island, the app's
defaults give a **detour ratio** median of 1.305/1.325/1.333/1.327/1.415 and a p90 of
1.451/1.539/1.652/1.547/1.873, a **reversal share** of 2.0/6.8/26.0/22.8/3.3% of which
0.0/0.0/0.3/0.0/0.0% are avoidable, a **longest crossing run** of 4/5/5/6/4, and no routing failure
anywhere. Flat weights move the detour median to 1.221/1.250/1.272/1.268/1.344, its p90 to
1.375/1.422/1.549/1.447/1.737 and the reversal share to 1.3/4.5/12.5/12.0/2.0%, with the avoidable
share **0.0% in every borough** — which is what says that bound measures the cost model rather than
the network, since an avoidable reversal is strictly extra distance and a shortest path would never
buy one. The tree slider at maximum reaches a median 1.354/1.365/1.368/1.369/1.476, a p90 of
1.568/1.670/1.763/1.683/2.188 and 3.0/8.8/31.0/27.5/4.3% reversing, of which 0.0/0.0/0.3/0.0/0.3%
avoidable.

### Known gaps

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

- **19.8% of placed coverage sits on an edge whose street name does not match the permit.** Much of it
  is legitimate corner wrap and nothing separates the two, so that is an upper bound on the error and
  not a measurement of it. A further 1.28% sits more than 20 m from the permit's own lot.
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
