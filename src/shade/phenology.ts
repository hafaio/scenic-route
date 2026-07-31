// Tau: the fraction of direct sunlight a crown blocks on a given date. The baked tree-shade pyramid is
// pure geometry — every crown throws a solid shadow — so this is what turns that shadow into what a
// real canopy does, and it is why the seasonality is NOT baked: the client knows the date, and a
// January crown blocks about half what a July one does.
//
// IN LEAF, tau = 0.814. i-Tree's shading coefficients, shade = 0.615 + 0.0617*ln(dbh_cm) + c_species
// (Nowak 2024, Understanding i-Tree Appendix 3, doi 10.2737/NRS-GTR-200-2023-Appendix3, after
// McPherson et al. 2018, "Shade factors for 149 taxa of in-leaf urban trees in the USA"), evaluated at
// our median 22.9 cm trunk and count-weighted over the 11 genera we ship.
//
// LEAF-OFF, tau = 0.40. Heisler 1986 (Urban Ecology 9:337-359, measured at 40°48'N on London plane,
// Norway maple and sugar maple) gives leafless/in-leaf ratios of 0.53, 0.44, 0.46 and 0.51 — ~0.49,
// and 0.49 * 0.814 = 0.40. His direct leafless whole-crown densities, 34-44%, agree.
const IN_LEAF = 0.814;
const LEAF_OFF = 0.4;

// The same two seasons for RAIN, which is a different question and a much weaker number: how much of
// the rain falling on a sidewalk a crown keeps off it. 0.35 in leaf, from Zabret & Sraj's isolated
// urban birch (11 gauges, 113 events, a full year under ~78% canopy): annual volume-weighted shelter
// 0.27, and 0.38 over the events above 28 mm. 0.15 leaf-off, the same ~0.4 leafless ratio Heisler
// measures for light. NOT the light tau above — reusing it would overvalue a tree by more than 2x,
// because a walker mid-storm is almost always past the 1.5-4 mm that saturates a crown, where
// throughfall runs 0.80-0.86 of open rainfall whatever the genus. The defensible bracket is 0.20-0.55
// and this sits at its low end on purpose: the term carries most of the shelter slider's signal on
// the least evidence (~4 studied trees), and the one paired-catchment study gives the lowest number
// of all. Scaffolding, the other half of that slider, is 1.0 and is not a heuristic.
const RAIN_IN_LEAF = 0.35;
const RAIN_LEAF_OFF = 0.15;

type Transition = [start: [number, number], end: [number, number]];

// The two transitions, as [month, day] endpoints. Leaf-out ramps across the second half of April,
// half done in its last week and complete in the first days of May; senescence runs from early October
// to bare by early December, its half-way point falling in the late-October-to-mid-November peak.
// Sources for the DATES: USDA FS RB-NRS-117 treats May-September as NYC's leaf-on season; the Central
// Park Conservancy and NYC Parks put leaf-out in the last week of April and peak foliage from late
// October to mid November. NYC leaf-out is drifting ~0.43 d/yr later (Environ. Res. Lett. 2025, doi
// 10.1088/1748-9326/adf1b9), so these will age.
const LEAF_OUT: Transition = [
  [4, 12],
  [5, 6],
];
const LEAF_FALL: Transition = [
  [10, 5],
  [12, 5],
];

// How far a transition has run on `day`, in [0, 1]. Smoothstep only because a curve has to be picked
// and this one is monotone with no kink at either end: the ENDPOINTS and the DATES are sourced, the
// shape between them is not measured.
function ramp(day: number, year: number, [start, end]: Transition): number {
  const from = Date.UTC(year, start[0] - 1, start[1]);
  const to = Date.UTC(year, end[0] - 1, end[1]);
  const fraction = Math.min(1, Math.max(0, (day - from) / (to - from)));
  return fraction * fraction * (3 - 2 * fraction);
}

// Leaf-out and leaf-fall never overlap, so their difference is 0 through the winter, 1 through the
// summer, and back to 0 in December — every tau follows it between its two endpoints.
function leafed(date: Date): number {
  const year = date.getFullYear();
  const day = Date.UTC(year, date.getMonth(), date.getDate());
  return ramp(day, year, LEAF_OUT) - ramp(day, year, LEAF_FALL);
}

export function canopyTau(date: Date): number {
  return LEAF_OFF + (IN_LEAF - LEAF_OFF) * leafed(date);
}

// The share of the rain falling on a stretch of sidewalk that a crown directly over it keeps off, on
// this date. Same curve, its own endpoints.
export function rainTau(date: Date): number {
  return RAIN_LEAF_OFF + (RAIN_IN_LEAF - RAIN_LEAF_OFF) * leafed(date);
}
