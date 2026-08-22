import { expect, test } from "bun:test";
import { encodePolygons } from "../../scripts/geometry";
import type { Polygon } from "../../scripts/overpass";
import { decodeHistoric, historicRenderer } from "./historic";
import { projectX, projectY } from "./mercator";
import type { HistoricParams } from "./protocol";

// HDST rides the shared polygon layout, so these run the real encoder (scripts/geometry.ts) into the
// real decoder (./historic.ts): a change to one that the other did not follow fails here rather than
// painting a city wrong.

const TILE_SIZE = 256;
const QUANTIZATION_DEG = 2e-6; // a coordinate survives the 1e-6 quantization to within a step

function square(west: number, south: number, size: number): Polygon {
  return [
    [
      { lng: west, lat: south },
      { lng: west + size, lat: south },
      { lng: west + size, lat: south + size },
      { lng: west, lat: south + size },
    ],
  ];
}

// A parent district and one of its extensions, straddling a bucket boundary so both are gathered by
// the tile that spans them, then a third district far enough north to be in neither bucket.
const DISTRICTS: readonly Polygon[] = [
  square(-73.9825, 40.671, 0.002),
  square(-73.9795, 40.6715, 0.001),
  // Two rings: the second is a hole punched in the first by the even-odd fill.
  [...square(-74.005, 40.732, 0.005), ...square(-74.004, 40.733, 0.001)],
];

function encoded(): ArrayBuffer {
  const bytes = encodePolygons("HDST", 1, DISTRICTS);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

test("every district comes back with its rings", () => {
  const { districts } = decodeHistoric(encoded());
  expect(districts.length).toBe(DISTRICTS.length);
  for (let index = 0; index < DISTRICTS.length; index++) {
    const source = DISTRICTS[index];
    const rings = districts[index];
    expect(rings.length).toBe(source.length);
    for (let ring = 0; ring < source.length; ring++) {
      const { lngs, lats } = rings[ring];
      expect(lngs.length).toBe(source[ring].length);
      for (let vertex = 0; vertex < lngs.length; vertex++) {
        const point = source[ring][vertex];
        expect(lngs[vertex]).toBeCloseTo(point.lng, 5);
        expect(lats[vertex]).toBeCloseTo(point.lat, 5);
        expect(Math.abs(lats[vertex] - point.lat)).toBeLessThan(
          QUANTIZATION_DEG,
        );
      }
    }
  }
});

interface Fill {
  color: string;
  alpha: number;
  rect: number[] | null; // the min-size square, for a district too small to fill as a path
}

function recordingContext(fills: Fill[]): OffscreenCanvasRenderingContext2D {
  const context = {
    globalAlpha: 1,
    fillStyle: "",
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: () => {
      fills.push({
        color: String(context.fillStyle),
        alpha: context.globalAlpha,
        rect: null,
      });
    },
    fillRect: (...rect: number[]) => {
      fills.push({
        color: String(context.fillStyle),
        alpha: context.globalAlpha,
        rect,
      });
    },
  } as unknown as OffscreenCanvasRenderingContext2D;
  return context;
}

function tileOf(lng: number, lat: number, zoom: number) {
  return {
    x: Math.floor(projectX(lng, zoom) / TILE_SIZE),
    y: Math.floor(projectY(lat, zoom) / TILE_SIZE),
    z: zoom,
  };
}

const PARAMS: HistoricParams = { kind: "historic", url: "historic.bin" };

test("a tile fills only the districts that reach it", () => {
  const districts = decodeHistoric(encoded());
  const fills: Fill[] = [];
  historicRenderer.draw(
    recordingContext(fills),
    districts,
    tileOf(-73.979, 40.671, 16),
    PARAMS,
    1,
  );
  // The parent district and its extension, not the one twelve buckets north.
  expect(fills.length).toBe(2);
  for (const { color, alpha, rect } of fills) {
    expect(color).toBe(fills[0].color);
    expect(alpha).toBeLessThan(1);
    expect(rect).toBeNull();
  }
});

test("a district smaller than a pixel is drawn as a square rather than fading out", () => {
  const districts = decodeHistoric(encoded());
  const fills: Fill[] = [];
  historicRenderer.draw(
    recordingContext(fills),
    districts,
    tileOf(-73.979, 40.671, 10),
    PARAMS,
    1,
  );
  // At z10 the ~220 m parent district still fills as a path; the ~110 m extension is under a pixel.
  expect(fills.filter(({ rect }) => rect !== null).length).toBe(1);
  expect(fills.length).toBe(2);
});
