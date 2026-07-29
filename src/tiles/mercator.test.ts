import { expect, test } from "bun:test";
import { projectX, projectY, unproject } from "./mercator";

// The worker draws tiles with its own transcription of leaflet's projection, because leaflet cannot
// load in a worker. A drift of even a fraction of a pixel would show up as seams between overlays,
// so these pin the transcription to leaflet's CRS itself, bit for bit.

// leaflet sniffs the browser at import, so it needs just enough of one to get through that.
Object.assign(globalThis, {
  document: {
    documentElement: { style: {} },
    createElement: () => ({ style: {} }),
    createElementNS: () => ({ style: {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  window: globalThis,
  devicePixelRatio: 1,
  screen: { deviceXDPI: 1, logicalXDPI: 1 },
});
const L = (await import("leaflet")).default;

// Every zoom the overlays use, over a full grid of latitudes against longitudes — independent axes,
// so an error in one that a matching error in the other would mask still shows.
function* samples(): Generator<{ lat: number; lng: number; zoom: number }> {
  for (let zoom = 0; zoom <= 22; zoom++) {
    for (let latStep = 0; latStep < 16; latStep++) {
      for (let lngStep = 0; lngStep < 16; lngStep++) {
        yield {
          lat: -89 + (178 * latStep) / 15,
          lng: -180 + (360 * lngStep) / 15,
          zoom,
        };
      }
    }
  }
}

// The corners the draws actually unproject: a tile's origin and its opposite corner, as the whole
// pixel numbers `coords.{x,y} * TILE_SIZE` yields rather than anything round-tripped through project.
function* tileCorners(): Generator<{ x: number; y: number; zoom: number }> {
  for (let zoom = 0; zoom <= 22; zoom++) {
    const tiles = 2 ** zoom;
    for (const fraction of [0, 0.13, 0.5, 0.87, 1]) {
      const tile = Math.min(tiles - 1, Math.floor(tiles * fraction));
      for (const corner of [0, 256]) {
        yield { x: tile * 256 + corner, y: tile * 256 + corner, zoom };
      }
    }
  }
}

test("projects exactly as leaflet's EPSG:3857 does", () => {
  for (const { lat, lng, zoom } of samples()) {
    const expected = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lng), zoom);
    expect(projectX(lng, zoom)).toBe(expected.x);
    expect(projectY(lat, zoom)).toBe(expected.y);
  }
});

test("unprojects exactly as leaflet's EPSG:3857 does", () => {
  for (const { lat, lng, zoom } of samples()) {
    const { x, y } = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lng), zoom);
    const expected = L.CRS.EPSG3857.pointToLatLng(L.point(x, y), zoom);
    const actual = unproject(x, y, zoom);
    expect(actual.lat).toBe(expected.lat);
    expect(actual.lng).toBe(expected.lng);
  }
});

test("unprojects tile corners exactly as leaflet's EPSG:3857 does", () => {
  for (const { x, y, zoom } of tileCorners()) {
    const expected = L.CRS.EPSG3857.pointToLatLng(L.point(x, y), zoom);
    const actual = unproject(x, y, zoom);
    expect(actual.lat).toBe(expected.lat);
    expect(actual.lng).toBe(expected.lng);
  }
});
