import { expect, test } from "bun:test";

// The street, caster and commercial chunk pyramids are keyed by x/y with no city in the path, so two
// cities sharing a chunk would interleave their segments in one file with no error anywhere. That
// held for New York and San Francisco by luck of geography; these pin it as a checked invariant
// rather than a comment, because the city that breaks it is the one nobody thought about.
import { overlappingCities } from "./manifest";

const city = (
  id: string,
  south: number,
  west: number,
  north: number,
  east: number,
) => ({ id, bounds: { south, west, north, east } }) as never;

test("nyc and sf do not share a chunk", () => {
  expect(
    overlappingCities([
      city("nyc", 40.4968, -74.2555, 40.9155, -73.6975),
      city("sf", 37.7068, -122.5141, 37.8325, -122.3607),
    ]),
  ).toBeNull();
});

test("a neighbour that shares the grid is caught", () => {
  // Oakland, immediately across the bay from San Francisco.
  expect(
    overlappingCities([
      city("sf", 37.7068, -122.5141, 37.8325, -122.3607),
      city("oakland", 37.7, -122.355, 37.885, -122.114),
    ]),
  ).toEqual(["sf", "oakland"]);
});
