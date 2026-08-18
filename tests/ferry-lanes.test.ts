// New York's ferry routes never swap lanes over the water they share, measured on the real artifact
// rather than a fixture: src/tiles/lines.test.ts pins the RULE on synthetic geometry, and this holds
// the CITY to it, so a route pair that lies against each other in some way the rule did not
// anticipate is caught.
//
// WHERE THIS RUNS. Not in `bun test src`. It reads data/ferries/nyc.bin, an LFS file that standard
// CI deliberately checks out as a pointer (see .github/workflows/build.yml — the LFS payload burned
// the account's whole bandwidth budget), so it runs on the manual deploy path beside
// route-sampling.test.ts. `bun run test-routes` runs it.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeLines, drawTile } from "../src/tiles/lines";
import { METERS_PER_DEGREE_LAT, metersPerLng } from "../src/tiles/polylines";

test("no two of New York's ferry routes swap lanes over the water they share", () => {
  const CELL_M = 60; // LANE_CELL_M, the grid ./lines counts a crossing's company over
  const file = readFileSync(`${import.meta.dir}/../data/ferries/nyc.bin`);
  const data = decodeLines(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    "ferr",
  );
  // The same grid the layer laid the lanes out on, down to where its cells fall: a grid a fraction
  // of a cell out would compare two routes' lanes across the step between one cell and the next.
  const midLat =
    data.polylines.reduce((sum, { lats }) => sum + lats[0], 0) /
    data.polylines.length;
  const cellLat = CELL_M / METERS_PER_DEGREE_LAT;
  const cellLng = CELL_M / metersPerLng(midLat);

  // Per cell, the lanes each route holds at the vertices it has there. Routes are told apart by
  // their colour, which in this file is one per route.
  const cells = new Map<string, Map<string, number[]>>();
  data.polylines.forEach(({ lngs, lats }, index) => {
    const ribbon = data.ribbons?.[index];
    const route = ribbon?.color;
    for (let vertex = 0; vertex < lngs.length && route && ribbon; vertex++) {
      const key = `${Math.floor(lngs[vertex] / cellLng)},${Math.floor(lats[vertex] / cellLat)}`;
      const cell = cells.get(key) ?? new Map<string, number[]>();
      cells.set(
        key,
        cell.set(route, [...(cell.get(route) ?? []), ribbon.lanes[vertex]]),
      );
    }
  });

  const sides = new Map<string, Set<number>>();
  let shared = 0;
  for (const cell of cells.values()) {
    const routes = [...cell].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [first, [route, lanes]] of routes.entries()) {
      for (const [other, others] of routes.slice(first + 1)) {
        shared++;
        const gap = Math.min(...others) - Math.max(...lanes);
        const pair = `${route} ${other}`;
        sides.set(pair, (sides.get(pair) ?? new Set()).add(Math.sign(gap)));
        // Not merely ordered: a route is fully present in a cell it runs through, so the two are a
        // whole lane apart wherever they meet, and neither is drawn over the other.
        expect(Math.abs(gap)).toBeGreaterThanOrEqual(1);
      }
    }
  }
  expect(shared).toBeGreaterThan(50); // 71 in the committed file, so this cannot pass on nothing
  for (const [pair, taken] of sides) {
    expect([pair, taken.size]).toEqual([pair, 1]);
  }
});
