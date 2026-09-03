import { expect, test } from "bun:test";
import { googleMapsWalkingUrl, MAX_WAYPOINTS } from "./google-maps";

const point = (lat: number, lng: number) => ({ lat, lng });

test("a walking link carries the endpoints, the mode and the waypoints in order", () => {
  const url = new URL(
    googleMapsWalkingUrl(point(40.7128, -74.006), point(40.7484, -73.9857), [
      point(40.72, -74.0),
      point(40.73, -73.99),
    ]),
  );
  expect(`${url.origin}${url.pathname}`).toBe(
    "https://www.google.com/maps/dir/",
  );
  expect(url.searchParams.get("api")).toBe("1");
  expect(url.searchParams.get("travelmode")).toBe("walking");
  expect(url.searchParams.get("origin")).toBe("40.712800,-74.006000");
  expect(url.searchParams.get("destination")).toBe("40.748400,-73.985700");
  expect(url.searchParams.get("waypoints")).toBe(
    "40.720000,-74.000000|40.730000,-73.990000",
  );
});

test("a route with no waypoints leaves the parameter off entirely", () => {
  const url = new URL(
    googleMapsWalkingUrl(point(40.7128, -74.006), point(40.7484, -73.9857), []),
  );
  expect(url.searchParams.has("waypoints")).toBe(false);
});

test("more waypoints than Google takes are cut rather than silently ignored", () => {
  // Over the limit Google drops waypoints itself, without saying so, degrading the link to a plain
  // walk from one end to the other — so the cut has to happen here, where the first nine are kept.
  const many = Array.from({ length: MAX_WAYPOINTS + 4 }, (_unused, index) =>
    point(40.7 + index / 1000, -74),
  );
  const url = new URL(
    googleMapsWalkingUrl(
      point(40.7128, -74.006),
      point(40.7484, -73.9857),
      many,
    ),
  );
  const waypoints = (url.searchParams.get("waypoints") as string).split("|");
  expect(waypoints).toHaveLength(MAX_WAYPOINTS);
  expect(waypoints[0]).toBe("40.700000,-74.000000");
  expect(waypoints[MAX_WAYPOINTS - 1]).toBe("40.708000,-74.000000");
});
