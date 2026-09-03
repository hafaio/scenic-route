import { expect, test } from "bun:test";

// The grid the staged DEM names its tiles on is the one thing this fetcher has to know for itself:
// the tiler is handed the tiles that were fetched, so it cannot be asked which ones to fetch. These
// pin the naming against tiles the survey actually stages; the projection underneath it is
// scripts/canopy-raster.ts's, and its own test pins the arithmetic against PROJ.
import {
  type DemSquare,
  demSquaresOf,
  EAST_BAY_WINDOW,
  OAKLAND_TEST_WINDOW,
} from "./lidar";

const named = ({ name }: DemSquare): string => name;

test("the downtown window falls in the one tile it was measured on", () => {
  expect(demSquaresOf(OAKLAND_TEST_WINDOW, "utm10n").map(named)).toEqual([
    "x56y419",
  ]);
});

test("both cities reach the squares the survey staged nothing for", () => {
  const squares = demSquaresOf(EAST_BAY_WINDOW, "utm10n").map(named);
  expect(squares).toContain("x56y419");
  // The bay-dominated southwest, which holds Oakland airport and Bay Farm Island. The project
  // stages no tile for any of the three, and the ground under them comes from the point cloud.
  expect(squares).toContain("x55y417");
  expect(squares).toContain("x55y418");
  expect(squares).toContain("x56y417");
});
