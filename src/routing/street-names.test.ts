import { expect, test } from "bun:test";
import { prettifyStreetName } from "./street-names";

const CASES: ReadonlyArray<[string, string]> = [
  ["W 60 ST", "West 60th Street"],
  ["E 23 ST", "East 23rd Street"],
  ["AVE N", "Avenue N"],
  ["5 AVE", "5th Avenue"],
  ["1 AVE", "1st Avenue"],
  ["W 4 ST", "West 4th Street"],
  ["GRAND ARMY PLZ", "Grand Army Plaza"],
  ["OCEAN PKWY", "Ocean Parkway"],
  ["FLATBUSH AVE", "Flatbush Avenue"],
  ["BEEKMAN PL", "Beekman Place"],
  ["BOARDWALK", "Boardwalk"],
  ["E 21 ST", "East 21st Street"],
  ["ST MARKS PL", "Saint Marks Place"],
  ["AVENUE OF THE AMERICAS", "Avenue of the Americas"],
];

test("prettifyStreetName expands types, leading directionals, and ordinals", () => {
  for (const [raw, pretty] of CASES) {
    expect(prettifyStreetName(raw)).toBe(pretty);
  }
});
