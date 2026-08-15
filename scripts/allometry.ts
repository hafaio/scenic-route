// The crown a tree shades the ground with, from its trunk diameter.
//
// Published relations, not invented: McPherson, van Doorn & Peper 2016, "Urban Tree Database and
// Allometric Equations" (USDA Forest Service GTR-PSW-253, archive RDS-2016-0005). That work fitted
// each of ~20 abundant species in each of sixteen CLIMATE REGIONS separately, and the region matters
// as much as the species — so a city takes the curve fitted nearest to it, and the equation FORM
// changes between regions too, which is why this is a tagged union rather than three coefficients.
//
// Each city's register carries no species (or too many to model), so its single most abundant street
// species stands in for all of them. That is a real approximation and it only sizes the dots the
// genus overlay draws; the cover field comes from measured canopy polygons and never from these.

// dbh is recorded in whole inches by both cities' registers, and every published equation takes
// centimetres.
export const CM_PER_INCH = 2.54;

export type CrownAllometry =
  | {
      // GTR-PSW-253's `loglogw1`: exp(a + b*ln(ln(dbh_cm + 1)) + mse/2). The trailing term is the
      // Baskerville correction for the bias a log-space fit carries back into metres.
      readonly form: "loglog";
      readonly a: number;
      readonly b: number;
      readonly logBiasCorrection: number;
      readonly source: string;
    }
  | {
      // GTR-PSW-253's `quad`: a + b*dbh_cm + c*dbh_cm^2. Not monotonic — the fitted curve turns over
      // past the trunk sizes it was fitted on — so a caller must clamp dbh before asking.
      readonly form: "quad";
      readonly a: number;
      readonly b: number;
      readonly c: number;
      readonly source: string;
    };

export function crownDiameterMeters(
  allometry: CrownAllometry,
  dbhInches: number,
): number {
  const cm = dbhInches * CM_PER_INCH;
  if (allometry.form === "loglog") {
    return Math.exp(
      allometry.a +
        allometry.b * Math.log(Math.log(cm + 1)) +
        allometry.logBiasCorrection,
    );
  } else {
    // Held at the vertex past it, because a downward quadratic starts SHRINKING the crown as the
    // trunk grows. San Francisco's turns over at 101.5 cm — 40 inches — which is well inside the
    // range of real street trees, so without this a 60 in London planetree was given the same 14.6 m
    // of crown as a 20 in one. The fit says nothing about trunks past its own turning point; the
    // honest reading of it is that the crown stops growing there, not that it reverses.
    const vertex = -allometry.b / (2 * allometry.c);
    const held = allometry.c < 0 ? Math.min(cm, vertex) : cm;
    return Math.max(
      0,
      allometry.a + allometry.b * held + allometry.c * held * held,
    );
  }
}

// New York: the NoEast region, whose reference city is Queens, so this is literally the city's own
// street trees. London planetree, its most abundant street species, R² 0.94 over 53 trees.
export const NOEAST_LONDON_PLANE: CrownAllometry = {
  form: "loglog",
  a: -0.75195,
  b: 2.41418,
  logBiasCorrection: 0.01977 / 2,
  source:
    "McPherson, van Doorn & Peper 2016 (USDA GTR-PSW-253), NoEast London planetree",
};

// San Francisco: the NoCalC region, fitted on Berkeley's street trees — across the bay, and the same
// species. London planetree again, its most abundant, R² 0.95 over 69 trees. Checked against those
// 69 measurements, this curve's median error is 1.26 m where New York's is 1.50 m, and the two
// diverge most on big trunks: at 52 cm dbh it gives 14.9 m of crown against New York's 13.3 m.
export const NOCALC_LONDON_PLANE: CrownAllometry = {
  form: "quad",
  a: 0.69918,
  b: 0.36544,
  c: -0.0018,
  source:
    "McPherson, van Doorn & Peper 2016 (USDA GTR-PSW-253), NoCalC London planetree",
};
