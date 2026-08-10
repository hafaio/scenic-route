import { expect, test } from "bun:test";
import { DECK_HEIGHT_METERS } from "../routing/sheds";
import type { SunSample } from "../shade/sun";
import { projectX, projectY } from "./mercator";
import { packRuns, pixelsPerMeter, type ShedDecks } from "./shed-decks";
import { castSheds, crownSegments, frameFor, type PolygonSink } from "./sweep";

// A shed deck is the one caster the client carries that no baked pyramid has a copy of, so nothing
// else can catch it being thrown the wrong length, the wrong way round, or wound so that it subtracts
// from the shadows it overlaps.

const DEGREES = Math.PI / 180;
const MAX_SHADOW_METERS = 500;
const CENTRE = { lat: 40.75, lng: -73.98 }; // midtown, where the sheds are

// The tile the decks sit in, deep enough that a 4 m deck is several pixels across.
const ZOOM = 17;
const FRAME = frameFor({
  x: Math.floor(projectX(CENTRE.lng, ZOOM) / 256),
  y: Math.floor(projectY(CENTRE.lat, ZOOM) / 256),
  z: ZOOM,
});

// The sun as a sample states it: the ground direction the shadow runs in, and its length per metre of
// caster height. Azimuth is a compass bearing, so the shadow runs the opposite way.
function sunAt(elevationDeg: number, azimuthDeg: number): SunSample {
  return {
    east: -Math.sin(azimuthDeg * DEGREES),
    north: -Math.cos(azimuthDeg * DEGREES),
    shadowPerHeight: 1 / Math.tan(elevationDeg * DEGREES),
  };
}

// A deck's depth here is the caster's input rather than a constant, so a case that cares states one;
// this is the middle of what the placement measures and what an unmeasured span falls back to.
const DEPTH_METERS = 4;

// One deck along a run of coordinates, ringed and packed by the production geometry so that what is
// cast here is what the display draws — the band centred on the run rather than pinned to a kerb,
// since there is no graph under these to say which side the building is.
function deckAlong(
  path: { lat: number; lng: number }[],
  depth = DEPTH_METERS,
): ShedDecks {
  const half = (depth / 2) * pixelsPerMeter(0);
  const edges = new Float64Array(path.length - 1);
  return packRuns([
    {
      xs: Float64Array.from(path, ({ lng }) => projectX(lng, 0)),
      ys: Float64Array.from(path, ({ lat }) => projectY(lat, 0)),
      building: edges.fill(half),
      kerb: new Float64Array(path.length - 1).fill(-half),
      closed: false,
    },
  ]);
}

// Every polygon the cast emitted, in tile pixels.
class Recorder implements PolygonSink {
  readonly rings: [number, number][][] = [];

  moveTo(x: number, y: number): void {
    this.rings.push([[x, y]]);
  }

  lineTo(x: number, y: number): void {
    this.rings[this.rings.length - 1].push([x, y]);
  }

  closePath(): void {}
}

// Twice the area a ring encloses, positive for the winding a nonzero fill has to see everywhere.
function signedDoubleArea(ring: [number, number][]): number {
  let sum = 0;
  for (let vertex = 0; vertex < ring.length; vertex++) {
    const [x, y] = ring[vertex];
    const [nextX, nextY] = ring[(vertex + 1) % ring.length];
    sum += x * nextY - nextX * y;
  }
  return sum;
}

// The middle of everything the cast emitted, in tile pixels.
function centre(rings: [number, number][][]): { x: number; y: number } {
  const xs = rings.flatMap((ring) => ring.map(([x]) => x));
  const ys = rings.flatMap((ring) => ring.map(([, y]) => y));
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

// The middle of a deck's own box, in tile pixels.
function deckCentre({ boxes }: ShedDecks, deck = 0): { x: number; y: number } {
  return {
    x:
      ((boxes[deck * 4] + boxes[deck * 4 + 2]) / 2) * FRAME.scale -
      FRAME.originX,
    y:
      ((boxes[deck * 4 + 1] + boxes[deck * 4 + 3]) / 2) * FRAME.scale -
      FRAME.originY,
  };
}

// A deck running east-west through the tile's centre, and where its own middle lands in tile pixels.
const STRAIGHT = deckAlong([
  { lat: CENTRE.lat, lng: CENTRE.lng - 0.0004 },
  { lat: CENTRE.lat, lng: CENTRE.lng + 0.0004 },
]);
const STRAIGHT_CENTRE = deckCentre(STRAIGHT);

function cast(decks: ShedDecks, sample: SunSample, clamp: number): Recorder {
  const recorder = new Recorder();
  expect(castSheds(recorder, decks, sample, clamp, FRAME, 1)).toBe(1);
  return recorder;
}

test("throws the deck its own depth wide, at the deck's own height", () => {
  const elevation = 30;
  const rings = cast(STRAIGHT, sunAt(elevation, 180), MAX_SHADOW_METERS).rings;
  const xs = rings.flatMap((ring) => ring.map(([x]) => x));
  const ys = rings.flatMap((ring) => ring.map(([, y]) => y));
  // A sun due south throws north, which is up the screen: the east-west run is the deck's own, the
  // north-south one is its depth, and the whole thing sits a shadow's length above the deck.
  expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(
    (STRAIGHT.boxes[2] - STRAIGHT.boxes[0]) * FRAME.scale,
    6,
  );
  // The band's own metres, which src/tiles/shed-decks.ts measures at the city's reference latitude
  // rather than at this tile's.
  expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(
    DEPTH_METERS * pixelsPerMeter(ZOOM),
    6,
  );
  expect(STRAIGHT_CENTRE.y - centre(rings).y).toBeCloseTo(
    (DECK_HEIGHT_METERS / Math.tan(elevation * DEGREES)) * FRAME.pixelsPerMeter,
    6,
  );
});

test("runs the shadow the way the sun points, however far it reaches", () => {
  for (const azimuth of [0, 75, 180, 250]) {
    for (const elevation of [12, 45, 75]) {
      const sample = sunAt(elevation, azimuth);
      const moved = centre(cast(STRAIGHT, sample, MAX_SHADOW_METERS).rings);
      const reach =
        DECK_HEIGHT_METERS * sample.shadowPerHeight * FRAME.pixelsPerMeter;
      expect(moved.x - STRAIGHT_CENTRE.x).toBeCloseTo(reach * sample.east, 6);
      expect(moved.y - STRAIGHT_CENTRE.y).toBeCloseTo(-reach * sample.north, 6);
    }
  }
});

test("stops at the shadow clamp", () => {
  // A sun on the horizon would otherwise throw the deck out of the world.
  const moved = centre(cast(STRAIGHT, sunAt(0.05, 180), 10).rings);
  expect(STRAIGHT_CENTRE.y - moved.y).toBeCloseTo(10 * FRAME.pixelsPerMeter, 6);
});

test("winds every polygon positively, bends included", () => {
  const bent = deckAlong([
    { lat: CENTRE.lat - 0.0003, lng: CENTRE.lng - 0.0003 },
    { lat: CENTRE.lat, lng: CENTRE.lng },
    { lat: CENTRE.lat - 0.0003, lng: CENTRE.lng + 0.0003 },
    { lat: CENTRE.lat - 0.0003, lng: CENTRE.lng + 0.0008 },
  ]);
  for (const azimuth of [0, 45, 120, 200, 300]) {
    const { rings } = cast(bent, sunAt(25, azimuth), MAX_SHADOW_METERS);
    // The deck's own ring, displaced: one polygon however many bends it turns through.
    expect(rings.length).toBe(1);
    expect(rings[0].length).toBe(8);
    for (const ring of rings) {
      expect(signedDoubleArea(ring)).toBeGreaterThan(0);
    }
  }
});

test("throws a deck that closes on itself as the annulus it is", () => {
  // A wrap all the way round a block: the shadow has to keep the hole in the middle, which is the
  // ring's own two loops rather than one polygon per bend.
  const block = 0.0004;
  const ringed = packRuns([
    {
      xs: Float64Array.from([0, 1, 1, 0], (corner) =>
        projectX(CENTRE.lng + corner * block, 0),
      ),
      ys: Float64Array.from([0, 0, 1, 1], (corner) =>
        projectY(CENTRE.lat - corner * block, 0),
      ),
      building: new Float64Array(4).fill(2 * pixelsPerMeter(0)),
      kerb: new Float64Array(4).fill(-2 * pixelsPerMeter(0)),
      closed: true,
    },
  ]);
  const { rings } = cast(ringed, sunAt(25, 200), MAX_SHADOW_METERS);
  expect(rings.length).toBe(1);
  const ring = rings[0];
  expect(signedDoubleArea(ring)).toBeGreaterThan(0);
  // The band around a ~34 m block at 4 m deep, not the block itself.
  const area = signedDoubleArea(ring) / 2 / FRAME.pixelsPerMeter ** 2;
  expect(area).toBeGreaterThan(400);
  expect(area).toBeLessThan(700);
});

test("skips a deck whose shadow never reaches the tile", () => {
  const away = deckAlong([
    { lat: CENTRE.lat + 0.05, lng: CENTRE.lng + 0.05 },
    { lat: CENTRE.lat + 0.05, lng: CENTRE.lng + 0.051 },
  ]);
  const recorder = new Recorder();
  expect(
    castSheds(recorder, away, sunAt(30, 180), MAX_SHADOW_METERS, FRAME, 1),
  ).toBe(0);
  expect(recorder.rings.length).toBe(0);
});

test("each deck is thrown at its own depth, not at the set's first", () => {
  // Two straight runs twenty-odd metres apart in latitude, so their bands cannot be confused, cast in
  // one call: a caster reading one depth for the whole set would throw both the same width.
  const NARROW = 2.5;
  const WIDE = 6;
  const decks = packRuns(
    [NARROW, WIDE].map((depth, deck) => {
      const half = (depth / 2) * pixelsPerMeter(0);
      const lat = CENTRE.lat - deck * 0.0002;
      return {
        xs: Float64Array.of(
          projectX(CENTRE.lng - 0.0005, 0),
          projectX(CENTRE.lng + 0.0005, 0),
        ),
        ys: Float64Array.of(projectY(lat, 0), projectY(lat, 0)),
        building: Float64Array.of(half),
        kerb: Float64Array.of(-half),
        closed: false,
      };
    }),
  );

  const recorder = new Recorder();
  expect(
    castSheds(recorder, decks, sunAt(45, 180), MAX_SHADOW_METERS, FRAME, 1),
  ).toBe(2);
  const heights = recorder.rings
    .map((ring) => {
      const ys = ring.map(([, y]) => y);
      return (Math.max(...ys) - Math.min(...ys)) / pixelsPerMeter(ZOOM);
    })
    .sort((left, right) => left - right);
  expect(heights[0]).toBeCloseTo(NARROW, 6);
  expect(heights[1]).toBeCloseTo(WIDE, 6);
});

// A crown's slices are the other thing only this side can be caught on. The bands here are the ones
// crates/tiler/src/crown.rs cuts, and the pyramid it bakes hands over to this sweep at one zoom.

test("nests a crown's slices around its widest section", () => {
  // A 10 m crown at a 5 degree sun: 0.6 * 10 * 11.43 = 68.6 m of smear over 3.6 m pixels.
  const low = crownSegments(10, 11.43, MAX_SHADOW_METERS, 3.6);
  const middle = 0.7 * 10 * 11.43;
  expect(low.map(({ level }) => level)).toEqual([0, 1, 2, 3]);
  expect(low[0].fromM).toBeCloseTo(middle, 9);
  expect(low[0].toM).toBeCloseTo(middle, 9);
  for (const [slice, { fromM, toM }] of low.entries()) {
    expect((fromM + toM) / 2).toBeCloseTo(middle, 9);
    if (slice > 0) {
      expect(fromM).toBeLessThan(low[slice - 1].fromM);
      expect(toM).toBeGreaterThan(low[slice - 1].toM);
    }
  }
  // Every band is inside the crown, and the innermost one all but spans it.
  expect(low[3].fromM).toBeGreaterThan(0.4 * 10 * 11.43);
  expect(low[3].toM).toBeLessThan(10 * 11.43);
  expect(low[3].toM - low[3].fromM).toBeGreaterThan(0.96 * 0.6 * 10 * 11.43);

  // The same crown at a 60 degree sun smears 3.5 m, under a pixel: one translated outline.
  const high = crownSegments(10, 0.577, MAX_SHADOW_METERS, 3.6);
  expect(high.map(({ level }) => level)).toEqual([0]);
  expect(high[0].toM).toBeCloseTo(high[0].fromM, 9);
});

test("cuts the bands the tiler cuts", () => {
  // (height, shadow per height, metres per pixel) and the slices they have to cut, in metres of
  // shadow displacement. Duplicated verbatim in `cuts_the_bands_the_client_cuts` in
  // crates/tiler/src/crown.rs: a table on each side is what catches either half drifting from the
  // other at the zoom they hand over.
  const cases: [number, number, number, [number, number, number][]][] = [
    [
      10,
      5,
      0.91,
      [
        [0, 35.0, 35.0],
        [1, 30.05, 39.95],
        [2, 25.1, 44.9],
        [3, 20.15, 49.85],
      ],
    ],
    [
      18,
      2,
      0.91,
      [
        [0, 25.2, 25.2],
        [1, 21.636, 28.764],
        [2, 18.072, 32.328],
        [3, 14.508, 35.892],
      ],
    ],
    [
      7,
      11.43,
      3.6,
      [
        [0, 56.007, 56.007],
        [1, 48.08601, 63.92799],
        [2, 40.16502, 71.84898],
        [3, 32.24403, 79.76997],
      ],
    ],
  ];
  for (const [heightM, shadowPerHeight, metersPerPixel, expected] of cases) {
    const cut = crownSegments(
      heightM,
      shadowPerHeight,
      MAX_SHADOW_METERS,
      metersPerPixel,
    );
    expect(cut.length).toBe(expected.length);
    for (const [slice, [level, fromM, toM]] of expected.entries()) {
      expect(cut[slice].level).toBe(level);
      expect(cut[slice].fromM).toBeCloseTo(fromM, 6);
      expect(cut[slice].toM).toBeCloseTo(toM, 6);
    }
  }
});
