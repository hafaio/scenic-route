import { expect, test } from "bun:test";
import {
  CITIES,
  cityById,
  containsPoint,
  DEFAULT_CITY,
  metersFromCity,
  nearestCity,
} from "./cities";

test("every city offers overlays and a centre inside its own bounds", () => {
  expect(CITIES.length).toBeGreaterThan(0);
  for (const city of CITIES) {
    expect(city.overlays.length).toBeGreaterThan(0);
    expect(containsPoint(city, city.center)).toBe(true);
  }
});

test("a point in the city is zero from it, one outside is its ground distance", () => {
  const timesSquare = { lat: 40.758, lng: -73.9855 };
  expect(metersFromCity(DEFAULT_CITY, timesSquare)).toBe(0);
  expect(containsPoint(DEFAULT_CITY, timesSquare)).toBe(true);

  // Due north of the bounds by a tenth of a degree, so the gap is latitude alone.
  const north = { lat: DEFAULT_CITY.bounds.north + 0.1, lng: timesSquare.lng };
  expect(metersFromCity(DEFAULT_CITY, north)).toBeCloseTo(11_132, 0);
  expect(containsPoint(DEFAULT_CITY, north)).toBe(false);
});

// A degree of longitude is shorter than a degree of latitude away from the equator, so an east-west
// gap must not be measured in raw degrees.
test("an east-west gap is scaled by latitude", () => {
  const { bounds } = DEFAULT_CITY;
  const lat = (bounds.north + bounds.south) / 2;
  const east = metersFromCity(DEFAULT_CITY, { lat, lng: bounds.east + 0.1 });
  expect(east).toBeLessThan(11_132);
  expect(east).toBeCloseTo(11_132 * Math.cos((lat * Math.PI) / 180), 0);
});

test("a point far outside every city still resolves to the nearest one", () => {
  const sanFrancisco = { lat: 37.7749, lng: -122.4194 };
  expect(containsPoint(DEFAULT_CITY, sanFrancisco)).toBe(false);
  expect(CITIES).toContain(nearestCity(sanFrancisco));
});

test("an unknown or absent city id resolves to nothing rather than a default", () => {
  expect(cityById(DEFAULT_CITY.id)).toBe(DEFAULT_CITY);
  expect(cityById("atlantis")).toBeNull();
  expect(cityById(null)).toBeNull();
});
