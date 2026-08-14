// The street network as the encoders and the tiler want it, independent of the city it came from.
// Each city's centreline publishes its own columns under its own names, but what a STRT record needs
// is the same everywhere: a durable id, a walkability kind, a kerb-to-kerb width to offset the
// pavement by, and a densified polyline. A city ingest maps its rows onto this and nothing below it
// knows which city it read.

import type { Coord } from "./socrata";

// The kinds a segment can be, numbered as NYC's CSCL `rw_type` because that is what the tiler reads
// and what `scripts/README.md` documents: street, bridge, tunnel, boardwalk, path, step street,
// alley. A second city maps its own classification onto these rather than adding numbers, so
// `graph.rs`'s alley and step-street rules keep meaning one thing.
export type RoadType = 1 | 3 | 4 | 5 | 6 | 7 | 10;

export const ROAD_STREET: RoadType = 1;
export const ROAD_BRIDGE: RoadType = 3;
export const ROAD_TUNNEL: RoadType = 4;
export const ROAD_BOARDWALK: RoadType = 5;
export const ROAD_PATH: RoadType = 6;
export const ROAD_STEPS: RoadType = 7;
export const ROAD_ALLEY: RoadType = 10;

export const ROAD_TYPES: readonly RoadType[] = [1, 3, 4, 5, 6, 7, 10];

// STRT record byte 23, bits 0-2. A router reads these; the overlay ignores them. Bits 3-6 are the
// per-side sidewalk bits, stamped in place by ingestSidewalks — scripts/sidewalks.ts owns them.
export const FLAG_VEHICULAR_ONLY = 1 << 0; // drawn, never routed
export const FLAG_NON_VEHICULAR = 1 << 1; // a dedicated ped/bike deck, offset 0
export const FLAG_STRUCTURE = 1 << 2; // a bridge or tunnel deck

export interface Segment {
  physicalId: number; // the city's own durable id for the row (CSCL physicalid, SF cnn)
  roadType: RoadType;
  streetWidth: number; // feet, kerb to kerb, 0 unknown — the sidewalk offset comes from this
  postedSpeed: number; // mph, 0 unknown
  flags: number; // FLAG_* bits
  name: string; // trimmed, "" when the row carries none
  nameId: number; // index into the name table, UNNAMED_ID until buildNameTable assigns it
  points: Coord[]; // densified, so the field is sampled at least every DENSIFY_METERS
  lengthMeters: number;
}

export function toInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
