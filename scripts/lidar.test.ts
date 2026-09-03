import { expect, test } from "bun:test";

// The grid the staged DEM names its tiles on is the one thing this fetcher has to know for itself:
// the tiler is handed the tiles that were fetched, so it cannot be asked which ones to fetch. That
// makes the projection here a second implementation of the one in crates/tiler/src/heights.rs, and
// these pin both halves of it — the arithmetic against PROJ, and the naming against a tile the
// survey actually stages.
import {
  type DemSquare,
  demSquaresOf,
  EAST_BAY_WINDOW,
  OAKLAND_TEST_WINDOW,
  PROJECTIONS,
  project,
} from "./lidar";

const named = ({ name }: DemSquare): string => name;

test("the grid agrees with PROJ", () => {
  // The corner the staged tile USGS_1M_10_x56y419 ties its upper-left pixel to, (559994, 4190006),
  // placed at this longitude and latitude by PROJ's own EPSG:26910 — the same pair
  // crates/tiler/src/heights.rs checks its projection against.
  const [easting, northing] = project(
    PROJECTIONS.utm10n,
    -122.3180159208427,
    37.85553821693455,
  );
  expect(easting).toBeCloseTo(559_994, 2);
  expect(northing).toBeCloseTo(4_190_006, 2);
});

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
