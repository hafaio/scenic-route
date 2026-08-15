import { expect, test } from "bun:test";
import {
  type CrownAllometry,
  crownDiameterMeters,
  NOCALC_LONDON_PLANE,
  NOEAST_LONDON_PLANE,
} from "./allometry";

const CM_PER_INCH = 2.54;

// A downward quadratic has a turning point, and San Francisco's sits at 40 inches of trunk — inside
// the range of real street trees, not past it. Read literally past that point the curve says a
// bigger trunk carries a smaller crown, which is the fit running out rather than a fact about trees.
test("a quadratic crown never shrinks as the trunk grows", () => {
  let previous = 0;
  for (let inches = 1; inches <= 60; inches++) {
    const crown = crownDiameterMeters(NOCALC_LONDON_PLANE, inches);
    expect(crown).toBeGreaterThanOrEqual(previous - 1e-9);
    previous = crown;
  }
});

test("past the turning point the crown holds at its peak rather than falling away", () => {
  const { b, c } = NOCALC_LONDON_PLANE as Extract<
    CrownAllometry,
    { form: "quad" }
  >;
  const vertexInches = -b / (2 * c) / CM_PER_INCH;
  expect(vertexInches).toBeGreaterThan(20); // precondition: the turn is inside the real range
  expect(vertexInches).toBeLessThan(60); // and inside the dbh clamp, which is why this matters
  const peak = crownDiameterMeters(NOCALC_LONDON_PLANE, vertexInches);
  expect(crownDiameterMeters(NOCALC_LONDON_PLANE, 60)).toBeCloseTo(peak, 6);
});

// New York's is a different form with no turning point, so it must be left alone by the hold above.
test("the log-log form still grows over the whole range", () => {
  expect(crownDiameterMeters(NOEAST_LONDON_PLANE, 60)).toBeGreaterThan(
    crownDiameterMeters(NOEAST_LONDON_PLANE, 40),
  );
});
