import { expect, test } from "bun:test";
import { encodePolygons } from "../../scripts/geometry";
import type { Polygon } from "../../scripts/overpass";
import { decodeIndustrial, industrialRenderer } from "./industrial";
import { projectX, projectY } from "./mercator";
import type { IndustrialParams } from "./protocol";

// INDL rides the shared polygon layout, so these run the real encoder (scripts/geometry.ts) into the
// real decoder (./industrial.ts): a change to one that the other did not follow fails here rather
// than painting a city wrong.

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

const LOTS: readonly Polygon[] = [
  square(-73.93, 40.72, 0.002),
  square(-73.925, 40.723, 0.001),
  // Two rings: the second is a hole punched in the first by the even-odd fill.
  [...square(-74.01, 40.67, 0.004), ...square(-74.009, 40.671, 0.001)],
];

function encoded(): ArrayBuffer {
  const bytes = encodePolygons("INDL", 1, LOTS);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

test("every lot comes back with its rings", () => {
  const { lots } = decodeIndustrial(encoded());
  expect(lots.length).toBe(LOTS.length);
  for (let index = 0; index < LOTS.length; index++) {
    const source = LOTS[index];
    const rings = lots[index];
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
  rect: number[] | null; // the min-size square, for a lot too small to fill as a path
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

const PARAMS: IndustrialParams = { kind: "industrial", url: "industrial.bin" };

test("a tile fills only the lots that reach it", () => {
  const lots = decodeIndustrial(encoded());
  const fills: Fill[] = [];
  industrialRenderer.draw(
    recordingContext(fills),
    lots,
    tileOf(-73.929, 40.721, 16),
    PARAMS,
    1,
  );
  // Maspeth's two lots, not the Red Hook one two buckets west.
  expect(fills.length).toBe(2);
  for (const { color, alpha, rect } of fills) {
    expect(color).toBe(fills[0].color);
    expect(alpha).toBeLessThan(1);
    expect(rect).toBeNull();
  }
});

test("a lot smaller than a pixel is drawn as a square rather than fading out", () => {
  const lots = decodeIndustrial(encoded());
  const fills: Fill[] = [];
  industrialRenderer.draw(
    recordingContext(fills),
    lots,
    tileOf(-73.929, 40.721, 10),
    PARAMS,
    1,
  );
  // At z10 the ~220 m lot is still taller than a pixel and fills as a path; the ~110 m one is not.
  expect(fills.filter(({ rect }) => rect !== null).length).toBe(1);
  expect(fills.length).toBe(2);
});
