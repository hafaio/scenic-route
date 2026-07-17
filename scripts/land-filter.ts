// A point-in-land test over the borough polygons, the same banded even-odd scheme the Rust
// Monte-Carlo sampler uses (crates/tiler/src/geometry.rs). The path ingest asks it up to three
// times per OSM way, so a query has to look only at the edges its own latitude can cross — every
// edge is bucketed into the horizontal bands it spans, and a point tests just its own band's.

import type { Polygon } from "./overpass";
import type { Coord } from "./socrata";

const LAT_BANDS = 512; // horizontal strips, matching the Rust index

// Even-odd is counted per polygon and only the polygons a query touched are cleared, so two
// overlapping borough parts do not cancel each other out and a query does not pay to reset a
// parity array the size of the whole set.
export function buildLandTest(polygons: Polygon[]): (coord: Coord) => boolean {
  const fromLat: number[] = [];
  const fromLng: number[] = [];
  const toLat: number[] = [];
  const toLng: number[] = [];
  const owner: number[] = [];
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (let polygon = 0; polygon < polygons.length; polygon++) {
    for (const ring of polygons[polygon]) {
      let previous = ring.length - 1;
      for (let point = 0; point < ring.length; point++) {
        fromLat.push(ring[previous].lat);
        fromLng.push(ring[previous].lng);
        toLat.push(ring[point].lat);
        toLng.push(ring[point].lng);
        owner.push(polygon);
        south = Math.min(south, ring[point].lat);
        north = Math.max(north, ring[point].lat);
        previous = point;
      }
    }
  }

  const bandsPerDegree = LAT_BANDS / Math.max(north - south, 1e-9);
  const bandOf = (lat: number): number =>
    Math.min(
      LAT_BANDS - 1,
      Math.max(0, Math.floor((lat - south) * bandsPerDegree)),
    );

  const edges = owner.length;
  const starts = new Uint32Array(LAT_BANDS + 1);
  for (let edge = 0; edge < edges; edge++) {
    const low = bandOf(Math.min(fromLat[edge], toLat[edge]));
    const high = bandOf(Math.max(fromLat[edge], toLat[edge]));
    for (let band = low; band <= high; band++) {
      starts[band + 1] += 1;
    }
  }
  for (let band = 0; band < LAT_BANDS; band++) {
    starts[band + 1] += starts[band];
  }
  const items = new Uint32Array(starts[LAT_BANDS]);
  const cursors = starts.slice();
  for (let edge = 0; edge < edges; edge++) {
    const low = bandOf(Math.min(fromLat[edge], toLat[edge]));
    const high = bandOf(Math.max(fromLat[edge], toLat[edge]));
    for (let band = low; band <= high; band++) {
      items[cursors[band]] = edge;
      cursors[band] += 1;
    }
  }

  const parity = new Uint8Array(polygons.length);
  const touched: number[] = [];
  return ({ lat, lng }: Coord): boolean => {
    if (lat < south || lat > north) {
      return false;
    }
    const band = bandOf(lat);
    touched.length = 0;
    for (let slot = starts[band]; slot < starts[band + 1]; slot++) {
      const edge = items[slot];
      if (fromLat[edge] > lat !== toLat[edge] > lat) {
        const at =
          fromLng[edge] +
          ((lat - fromLat[edge]) / (toLat[edge] - fromLat[edge])) *
            (toLng[edge] - fromLng[edge]);
        if (lng < at) {
          const polygon = owner[edge];
          if (parity[polygon] === 0) {
            touched.push(polygon);
          }
          parity[polygon] ^= 1;
        }
      }
    }
    let inside = false;
    for (const polygon of touched) {
      inside = inside || parity[polygon] === 1;
      parity[polygon] = 0;
    }
    return inside;
  };
}
