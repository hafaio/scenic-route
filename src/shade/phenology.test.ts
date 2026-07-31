import { expect, test } from "bun:test";
import { canopyTau, rainTau } from "./phenology";

// The two endpoints are what the sources give; the curve between them only has to be monotone and to
// sit at the sourced dates.

const IN_LEAF = 0.814;
const LEAF_OFF = 0.4;

test("holds the sourced endpoints through winter and summer", () => {
  for (const [month, day] of [
    [1, 15],
    [3, 31],
    [12, 20],
  ]) {
    expect(canopyTau(new Date(2026, month - 1, day))).toBeCloseTo(LEAF_OFF, 6);
  }
  for (const [month, day] of [
    [5, 15],
    [7, 4],
    [9, 30],
  ]) {
    expect(canopyTau(new Date(2026, month - 1, day))).toBeCloseTo(IN_LEAF, 6);
  }
});

test("is half leafed out in the last week of April", () => {
  const middle = (IN_LEAF + LEAF_OFF) / 2;
  expect(canopyTau(new Date(2026, 3, 24))).toBeCloseTo(middle, 2);
});

test("rises through the spring and falls through the autumn, never backwards", () => {
  const days = (from: Date, to: Date): Date[] => {
    const dates: Date[] = [];
    for (let at = from; at <= to; at = new Date(at.getTime() + 86_400_000)) {
      dates.push(at);
    }
    return dates;
  };
  for (const window of [
    { dates: days(new Date(2026, 3, 1), new Date(2026, 4, 10)), rising: true },
    {
      dates: days(new Date(2026, 9, 1), new Date(2026, 11, 10)),
      rising: false,
    },
  ]) {
    const taus = window.dates.map(canopyTau);
    for (const [index, tau] of taus.slice(1).entries()) {
      expect(window.rising ? tau >= taus[index] : tau <= taus[index]).toBe(
        true,
      );
    }
  }
});

// Rain is a different question from light, and the two must not share coefficients: bare branches
// block far less rain than they block light, and a leafed crown blocks far less rain than sun.
const RAIN_IN_LEAF = 0.35;
const RAIN_LEAF_OFF = 0.15;

test("rain tau holds its own endpoints on the same seasonal curve", () => {
  expect(rainTau(new Date(2026, 6, 4))).toBeCloseTo(RAIN_IN_LEAF, 6);
  expect(rainTau(new Date(2026, 0, 15))).toBeCloseTo(RAIN_LEAF_OFF, 6);
  // Half leafed out on the same date the light tau is, since the curve is shared.
  const middle = (RAIN_IN_LEAF + RAIN_LEAF_OFF) / 2;
  expect(rainTau(new Date(2026, 3, 24))).toBeCloseTo(middle, 2);
  // And nowhere near the light tau, in either season — that is the point of the second pair.
  for (const date of [new Date(2026, 6, 4), new Date(2026, 0, 15)]) {
    expect(rainTau(date)).toBeLessThan(canopyTau(date) / 2);
  }
});
