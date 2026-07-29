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
