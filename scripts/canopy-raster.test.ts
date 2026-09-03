import { expect, test } from "bun:test";
import {
  encodeFloatTiff,
  forwardTmerc,
  inverseTmerc,
  polygonsOfMask,
  ringDoubleArea,
  simplifyRing,
  traceRings,
  UTM_10N,
} from "./canopy-raster";

// A mask laid out as rows of a string, "#" set, so a test reads as the shape it is about.
function maskOf(rows: string[]): {
  mask: Uint8Array;
  width: number;
  height: number;
} {
  const width = rows[0].length;
  const mask = new Uint8Array(width * rows.length);
  rows.forEach((row, index) => {
    for (let column = 0; column < width; column++) {
      mask[index * width + column] = row[column] === "#" ? 1 : 0;
    }
  });
  return { mask, width, height: rows.length };
}

test("a single cell traces as its own square, wound the outer way", () => {
  const { mask, width, height } = maskOf([".....", ".#...", "....."]);
  const rings = traceRings(mask, width, height);
  expect(rings.length).toBe(1);
  expect(ringDoubleArea(rings[0])).toBe(2); // twice the one cell it encloses
  expect(rings[0].length).toBe(8); // four corners, unclosed
});

// The union of what comes out has to be the mask itself, so a ring's area is the cell count.
test("a ring encloses exactly the cells it was traced from", () => {
  const { mask, width, height } = maskOf([
    "......",
    ".####.",
    ".####.",
    ".##...",
    "......",
  ]);
  const rings = traceRings(mask, width, height);
  expect(rings.length).toBe(1);
  expect(ringDoubleArea(rings[0]) / 2).toBe(10);
});

test("a hole comes back with the opposite winding and nests into its ring", () => {
  const { mask, width, height } = maskOf([
    "#####",
    "#...#",
    "#.#.#",
    "#...#",
    "#####",
  ]);
  const { polygons, cells } = polygonsOfMask(mask, width, height, 0, 0);
  expect(polygons.length).toBe(2); // the frame and the pip inside its hole
  const frame = polygons.find((polygon) => polygon.length === 2);
  expect(frame).toBeDefined();
  expect(ringDoubleArea((frame as Float64Array[])[1])).toBeLessThan(0);
  expect(cells).toBe(17); // 16 of frame, 1 of pip: the hole is not counted as canopy
});

// Two crowns that touch only at a corner are two crowns. Traced the other way round they would come
// back as one polygon pinched to a point, which an even-odd fill has to guess at.
test("cells meeting at a corner trace as two rings, not one bowtie", () => {
  const { mask, width, height } = maskOf(["#..", ".#.", "..."]);
  const rings = traceRings(mask, width, height);
  expect(rings.length).toBe(2);
  expect(rings.every((ring) => ringDoubleArea(ring) === 2)).toBe(true);
});

test("a diagonal staircase simplifies to its diagonal", () => {
  const { mask, width, height } = maskOf([
    "########",
    "#######.",
    "######..",
    "#####...",
    "####....",
  ]);
  const rings = traceRings(mask, width, height);
  expect(rings.length).toBe(1);
  const simplified = simplifyRing(rings[0], 1);
  expect(simplified.length / 2).toBeLessThanOrEqual(4);
  // and it still covers what it covered, to within the tolerance it was given
  expect(Math.abs(ringDoubleArea(simplified) / 2 - 30)).toBeLessThan(4);
});

test("simplifying leaves a small ring alone", () => {
  const { mask, width, height } = maskOf([".....", ".##..", ".##..", "....."]);
  const simplified = simplifyRing(traceRings(mask, width, height)[0], 1);
  expect(ringDoubleArea(simplified) / 2).toBe(4);
});

test("specks below the minimum are dropped, with their area counted out", () => {
  const { mask, width, height } = maskOf([
    "##....",
    "##....",
    "....#.",
    "......",
  ]);
  const { polygons, cells, dropped, droppedCells } = polygonsOfMask(
    mask,
    width,
    height,
    0.5,
    4,
  );
  expect(polygons.length).toBe(1);
  expect(cells).toBe(5);
  expect(dropped).toBe(1);
  expect(droppedCells).toBe(1);
});

// Checked against a publisher's own georeferencing rather than against this code, and against the
// same tile crates/tiler/src/heights.rs checks its forward projection with: the staged DEM tile
// USGS_1M_10_x56y419 ties its upper-left pixel to UTM 10N (559994, 4190006), which PROJ places at
// this longitude and latitude.
test("the inverse projection agrees with a published tile", () => {
  const { lat, lng } = inverseTmerc(UTM_10N, 559_994, 4_190_006);
  expect(lng).toBeCloseTo(-122.3180159208427, 7);
  expect(lat).toBeCloseTo(37.85553821693455, 7);
});

test("the height tile is a float32 GeoTIFF tied at its own origin", () => {
  const values = Float32Array.of(1, 2, 3, 4, 5, 6);
  const bytes = encodeFloatTiff(values, 3, 2, 561_000, 4_190_000, 1);
  const view = new DataView(bytes.buffer);
  expect(view.getUint16(0, true)).toBe(0x4949);
  expect(view.getUint16(2, true)).toBe(42);
  const directory = view.getUint32(4, true);
  const count = view.getUint16(directory, true);
  const tags = new Map<number, number>();
  for (let entry = 0; entry < count; entry++) {
    const at = directory + 2 + entry * 12;
    tags.set(view.getUint16(at, true), view.getUint32(at + 8, true));
  }
  expect(tags.get(256)).toBe(3); // width
  expect(tags.get(257)).toBe(2); // height
  expect(tags.get(339)).toBe(3); // IEEE floating point samples
  expect(tags.get(279)).toBe(24); // one strip of 6 float32 samples
  const tie = tags.get(33922) as number;
  expect(view.getFloat64(tie + 24, true)).toBe(561_000);
  expect(view.getFloat64(tie + 32, true)).toBe(4_190_000);
  const strip = tags.get(273) as number;
  expect(view.getFloat32(strip, true)).toBe(1);
  expect(view.getFloat32(strip + 20, true)).toBe(6);
});

// The box a raster window is cut from goes through the forward projection and the rings that come
// back out of it go through the inverse, so the two have to be each other's undoing.
test("the projection round-trips over the East Bay", () => {
  for (const [lng, lat] of [
    [-122.355, 37.632],
    [-122.114, 37.906],
    [-122.2711, 37.8044], // downtown Oakland
  ]) {
    const { x, y } = forwardTmerc(UTM_10N, lng, lat);
    const back = inverseTmerc(UTM_10N, x, y);
    expect(back.lng).toBeCloseTo(lng, 9);
    expect(back.lat).toBeCloseTo(lat, 9);
  }
});

test("the forward projection agrees with the published tile too", () => {
  const { x, y } = forwardTmerc(UTM_10N, -122.3180159208427, 37.85553821693455);
  expect(x).toBeCloseTo(559_994, 3);
  expect(y).toBeCloseTo(4_190_006, 3);
});
