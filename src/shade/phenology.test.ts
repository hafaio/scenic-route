import { expect, test } from "bun:test";
import { canopyTau } from "./phenology";

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
