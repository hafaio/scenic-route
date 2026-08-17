// The client's view of the routing graph baked by the graph pass. Layout: scripts/README.md
// (magic GRPH, v6 — the sidewalk graph with inert ferry edges). Fixed sections are viewed in place
// over the fetched buffer; the strided edge records are copied once into parallel typed arrays so
// the search loop touches only flat arrays.

import type { FerryTimetable } from "./ferry-schedule";
import type { ShadeField } from "./shade";
import type { ShedField } from "./sheds";

// A no-geometry edge (a crossing, a link, or a straight ferry) stores this sentinel in its geometry
// offset; its polyline is the straight line between its two node coordinates.
export const NO_GEOMETRY = 0xffffffff;
const NAME_NONE = 0xffff;
// Edge kind lives in bits 0-2 of the kind+side byte; the side in bits 3-5.
const KIND_MASK = 0x7;
const SIDE_SHIFT = 3;
const SIDE_MASK = 0x7;
const KIND_CROSSING = 1;
const KIND_FERRY = 4;
// flags byte bit 2 marks a sidewalk that lies to the right of its stored geometry direction.
const GEOMETRY_RIGHT_FLAG = 0x4;

// An edge with no durable identity — a crossing, a link or a ferry, none of which comes from a
// source segment. Its source-id slot carries this sentinel.
export const NO_SOURCE_ID = 0xffffffff;
// The durable key packs (source id, side, ordinal) into one number: the ordinal is a u8 and the side
// fits three bits, so a source id up to a u32 still lands well inside an exact double.
const DURABLE_SIDE_STRIDE = 256;
const DURABLE_SOURCE_STRIDE = 2048;

// The rebuild-surviving name of one edge, as `sheds.ts` and the SHED artifact spell it. Positional
// edge ids all shift when the graph is rebuilt; this does not, because the source id is CSCL's own
// `physicalid` (or an OSM way id for a path), the side is the sidewalk's N/E/S/W label, and the
// ordinal only separates the several edges one source segment can become.
export function durableKey(
  sourceId: number,
  side: number,
  ordinal: number,
): number {
  return (
    sourceId * DURABLE_SOURCE_STRIDE + side * DURABLE_SIDE_STRIDE + ordinal
  );
}

// One edge's durable key, or -1 when it has no durable identity.
export function edgeDurableKey(graph: RoutingGraph, edge: number): number {
  const sourceId = graph.edgeSourceId[edge];
  if (sourceId === NO_SOURCE_ID) {
    return -1;
  } else {
    return durableKey(
      sourceId,
      (graph.edgeKindSide[edge] >> SIDE_SHIFT) & SIDE_MASK,
      graph.edgeOrdinal[edge],
    );
  }
}

// The nodes standing in a roadway rather than on pavement: those whose every edge is a crossing. A
// marked crossing of a divided street is drawn as several ways chained through the islands between
// them, so these are the joints inside one crossing. Charging a wait per crossing EDGE would bill a
// wide avenue two or three times for a single wait.
export function markMidRoadwayNodes(
  nodeCount: number,
  csr: Uint32Array,
  adjacency: Uint32Array,
  edgeKindSide: Uint8Array,
): Uint8Array {
  const midRoadway = new Uint8Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) {
    const from = csr[node];
    const to = csr[node + 1];
    let allCrossings = to > from;
    for (let slot = from; slot < to && allCrossings; slot += 1) {
      allCrossings =
        (edgeKindSide[adjacency[slot]] & KIND_MASK) === KIND_CROSSING;
    }
    midRoadway[node] = allCrossings ? 1 : 0;
  }
  return midRoadway;
}

export type EdgeKind = "sidewalk" | "crossing" | "link" | "path" | "ferry";
export type SideLabel = "north" | "east" | "south" | "west" | null;

const EDGE_KINDS: readonly EdgeKind[] = [
  "sidewalk",
  "crossing",
  "link",
  "path",
  "ferry",
];
const SIDE_LABELS: readonly SideLabel[] = [
  null,
  "north",
  "east",
  "south",
  "west",
];

// The two figures routing/<city>.version.json names a graph by, both FNV-1a 64 in hex.
export interface GraphIdentity {
  // What this graph IS: the hash of the GRPH file's own bytes. It changes on any rebuild at all,
  // including one that only moved an f32 length, so nothing an artifact is gated on rides on it.
  hash: string;
  // What a placed artifact resolves THROUGH: the hash of the durable key space — every
  // `(source id, side, ordinal)` the graph carries, ascending. `sheds.ts` gates on this one.
  keyHash: string;
}

export interface RoutingGraph extends GraphIdentity {
  nodeCount: number;
  edgeCount: number;
  originLng: number;
  originLat: number;
  scale: number; // degrees per quantized unit; degrees = origin + q * scale
  nodeQx: Int32Array;
  nodeQy: Int32Array;
  nodeComponent: Uint16Array;
  csr: Uint32Array; // nodeCount + 1; node n owns half-edges [csr[n], csr[n + 1])
  adjacency: Uint32Array; // 2 * edgeCount edge ids; the neighbour is the edge's other endpoint
  edgeNodeA: Uint32Array;
  edgeNodeB: Uint32Array;
  edgeLength: Float32Array; // geodesic metres
  edgeGeomOffset: Uint32Array; // byte offset into the geometry blob; NO_GEOMETRY = straight a -> b
  edgeGeomCount: Uint16Array; // geometry vertices, 0 when no geometry
  edgeCover: Uint8Array; // 0..254, this edge's own single value; 0 for a ferry
  edgeNameId: Uint16Array; // index into names, or NAME_NONE
  edgeKindSide: Uint8Array; // bits 0-2 kind, bits 3-5 side
  edgeSourceId: Uint32Array; // the CSCL physicalid or OSM way id; NO_SOURCE_ID for a crossing, link or ferry
  edgeOrdinal: Uint8Array; // which edge of the several one source segment becomes; both feed `edgeDurableKey`
  // 1 where every edge on the node is a crossing, i.e. a traffic island: a walker standing there is
  // mid-roadway, part way through one crossing rather than at the start of another.
  nodeMidRoadway: Uint8Array;
  maxCover: number; // the greatest per-edge cover in the graph, 0..1; sets the cost clip floor

  edgeLandmark: Uint8Array; // 0..254, this edge's landmark-amenity discount attribute; 0 for a ferry
  edgeArt: Uint8Array; // 0..254, this edge's public-art discount attribute; 0 for a ferry
  edgeHighway: Uint8Array; // 0..254, this edge's highway/rail nuisance penalty attribute; 0 for a ferry
  edgeCommercial: Uint8Array; // 0..254, this edge's nice-commercial-frontage discount attribute; 0 for a ferry
  maxLandmark: number; // the greatest per-edge landmark amenity, 0..1; sets that discount's clip floor
  maxArt: number; // the greatest per-edge art amenity, 0..1; sets that discount's clip floor
  maxCommercial: number; // the greatest per-edge commercial amenity, 0..1; sets that discount's clip floor

  // The share of the edge that lies DIRECTLY under a crown, unblurred — what edgeCover, the smoothed
  // field the overlay is coloured from, cannot answer.
  edgeDirectCanopy: Uint8Array; // 0..254; 0 for a ferry
  // 0..254: the average grade along this edge — the height it climbs and drops over its length,
  // absolute, so it reads the same in either direction — as a fraction of 35%. That span clears the
  // steepest street anyone walks, so nothing saturates. 0 for a ferry and for a city with no DEM.
  edgeRelief: Uint8Array;
  // The largest relief attribute present. NOT a heuristic bound — hill is a penalty, whose
  // minimum factor is 1, so it never loosens the A* lower bound. This is read to tell a city with no
  // elevation source (every edge 0) from one that has it, which is what greys the slider out.
  maxRelief: number;
  maxDirectCanopy: number; // the greatest per-edge direct canopy, 0..1; that factor's clip-floor input

  // The route-time signed shade field, filled from the SHDE artifact by computeEdgeShade: the per-edge
  // sun/shade attribute as a function of elapsed walking time, so a metre is costed against the sun at
  // the moment it is reached. Null when no artifact is loaded or the sun is below the horizon for the
  // whole walk (no shade to bias); its maxAbs (0..1) is the shade factor's clip-floor input.
  shade: ShadeField | null;

  // The picked day's sidewalk sheds, filled from the SHED artifact by computeEdgeSheds: per edge, how
  // much of it stands under a deck. A deck is opaque and dry, so it feeds the shade composite, the
  // shelter factor and the avoid penalty. Null until that resolves, and the cost model reads no
  // scaffolding at all while it is.
  sheds: ShedField | null;

  // The departure date's ferry timetable, filled from the FSCH artifact by computeFerrySchedule: per
  // ferry edge, the sailings out of each of its two terminals. Null until that resolves and on any day
  // no record covers, and every ferry then costs the baked `edgeDurationSeconds` below instead.
  ferries: FerryTimetable | null;

  edgeHalfOffsetDm: Uint8Array; // decimetres to a sidewalk; 0 for crossings/links/paths/ferries
  // A ferry edge's crossing-plus-average-wait seconds, the whole timetable flattened to one number;
  // 0 for every other kind. What a ferry costs when `ferries` is null.
  edgeDurationSeconds: Float32Array;
  ferryEdges: Uint32Array; // ids of the ferry edges, for the A* ferry-credit heuristic
  minFerrySecPerMetre: number; // min over ferry edges of duration/length, Infinity when there are none
  edgeFlags: Uint8Array; // bit0 structure, bit1 steps, bit2 geometry-right (sidewalks), bit3 OSM-sourced
  names: string[];
  geometry: Uint8Array;
  // Per ferry edge, its two terminal stop names at the node-a and node-b ends (aligned to
  // edgeNodeA/edgeNodeB). The route name is the edge's own name (`edgeName`).
  ferryEndpointNames: Map<number, { a: string; b: string }>;
}

const MAGIC = "GRPH";
// Exported so a fixture cannot drift from it: a test writing its own header must write this one.
export const FORMAT_VERSION = 8;
const HEADER_BYTES = 64;
const EDGE_RECORD_BYTES = 35;
// relative, so both pick up the deploy basePath
// Written by the same pass as the graph itself, and named after it: one directory holds
// every city's, so a shared name would describe whichever built last.
const versionUrl = (cityId: string): string => `routing/${cityId}.version.json`;
const PATH_CACHE_LIMIT = 512;

function fourByteAlign(offset: number): number {
  return (offset + 3) & ~3;
}

// `identity` is what these bytes hash to and what their key space hashes to, neither of which the
// bytes themselves can carry — a file cannot hold its own FNV, and walking 600k keys to recover the
// second is work the graph pass already did. The deploy writes both beside the graph and the pipeline
// recomputes them; either way the caller is the one that knows.
export function decodeGraph(
  buffer: ArrayBuffer,
  identity: GraphIdentity,
): RoutingGraph {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} routing graph`);
  }

  const nodeCount = view.getUint32(8, true);
  const edgeCount = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const nameTableOffset = view.getUint32(44, true);
  const geometryOffset = view.getUint32(52, true);
  const geometryLength = view.getUint32(56, true);
  const ferryNameTableOffset = view.getUint32(60, true);

  // Fixed sections run back to back after the header, each starting 4-byte aligned. They are
  // viewed in place; the quantized coordinates, components, and CSR need no copy.
  let offset = HEADER_BYTES;
  const nodeQx = new Int32Array(buffer, offset, nodeCount);
  offset += nodeCount * 4;
  const nodeQy = new Int32Array(buffer, offset, nodeCount);
  offset += nodeCount * 4;
  const nodeComponent = new Uint16Array(buffer, offset, nodeCount);
  offset = fourByteAlign(offset + nodeCount * 2);
  const csr = new Uint32Array(buffer, offset, nodeCount + 1);
  offset += (nodeCount + 1) * 4;
  const adjacency = new Uint32Array(buffer, offset, 2 * edgeCount);
  offset += 2 * edgeCount * 4;

  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeGeomOffset = new Uint32Array(edgeCount);
  const edgeGeomCount = new Uint16Array(edgeCount);
  const edgeCover = new Uint8Array(edgeCount);
  const edgeNameId = new Uint16Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const edgeHalfOffsetDm = new Uint8Array(edgeCount);
  const edgeDurationSeconds = new Float32Array(edgeCount);
  const edgeFlags = new Uint8Array(edgeCount);
  const edgeLandmark = new Uint8Array(edgeCount);
  const edgeArt = new Uint8Array(edgeCount);
  const edgeHighway = new Uint8Array(edgeCount);
  const edgeCommercial = new Uint8Array(edgeCount);
  const edgeDirectCanopy = new Uint8Array(edgeCount);
  const edgeSourceId = new Uint32Array(edgeCount);
  const edgeOrdinal = new Uint8Array(edgeCount);
  const edgeRelief = new Uint8Array(edgeCount);
  const ferryEdges: number[] = [];
  let maxCoverByte = 0;
  let maxLandmarkByte = 0;
  let maxArtByte = 0;
  let maxCommercialByte = 0;
  let maxDirectCanopyByte = 0;
  let maxReliefByte = 0;
  let minFerrySecPerMetre = Number.POSITIVE_INFINITY;
  for (let edge = 0; edge < edgeCount; edge++) {
    const record = offset + edge * EDGE_RECORD_BYTES;
    edgeNodeA[edge] = view.getUint32(record, true);
    edgeNodeB[edge] = view.getUint32(record + 4, true);
    edgeLength[edge] = view.getFloat32(record + 8, true);
    edgeGeomOffset[edge] = view.getUint32(record + 12, true);
    edgeGeomCount[edge] = view.getUint16(record + 16, true);
    edgeNameId[edge] = view.getUint16(record + 18, true);
    const kindSide = bytes[record + 22];
    edgeKindSide[edge] = kindSide;
    edgeFlags[edge] = bytes[record + 23];
    if ((kindSide & KIND_MASK) === KIND_FERRY) {
      // A ferry carries no cover and no half-offset; bytes 20-21 are a u16 crossing-plus-wait
      // duration. Cover stays 0 so it never lifts maxCover (the cost heuristic's floor).
      const duration = view.getUint16(record + 20, true);
      edgeDurationSeconds[edge] = duration;
      ferryEdges.push(edge);
      const length = edgeLength[edge];
      if (length > 0) {
        minFerrySecPerMetre = Math.min(minFerrySecPerMetre, duration / length);
      }
    } else {
      edgeCover[edge] = bytes[record + 20];
      edgeHalfOffsetDm[edge] = bytes[record + 21];
      maxCoverByte = Math.max(maxCoverByte, edgeCover[edge]);
    }
    // The attribute bytes are their own record slots, so a ferry's duration in bytes 20-21 does not
    // collide; a ferry carries 0 in all five, so it never lifts a discount's max.
    edgeLandmark[edge] = bytes[record + 24];
    edgeArt[edge] = bytes[record + 25];
    edgeHighway[edge] = bytes[record + 26];
    edgeCommercial[edge] = bytes[record + 27];
    edgeDirectCanopy[edge] = bytes[record + 28];
    edgeSourceId[edge] = view.getUint32(record + 29, true);
    edgeOrdinal[edge] = bytes[record + 33];
    edgeRelief[edge] = bytes[record + 34];
    maxReliefByte = Math.max(maxReliefByte, edgeRelief[edge]);
    maxLandmarkByte = Math.max(maxLandmarkByte, edgeLandmark[edge]);
    maxArtByte = Math.max(maxArtByte, edgeArt[edge]);
    maxCommercialByte = Math.max(maxCommercialByte, edgeCommercial[edge]);
    maxDirectCanopyByte = Math.max(maxDirectCanopyByte, edgeDirectCanopy[edge]);
  }
  const maxRelief = maxReliefByte / 255;
  const maxCover = maxCoverByte / 255;
  const maxLandmark = maxLandmarkByte / 255;
  const maxArt = maxArtByte / 255;
  const maxCommercial = maxCommercialByte / 255;
  const maxDirectCanopy = maxDirectCanopyByte / 255;

  const names = decodeNames(buffer, nameTableOffset);
  const geometry = new Uint8Array(buffer, geometryOffset, geometryLength);
  const ferryEndpointNames = decodeFerryEndpointNames(
    buffer,
    ferryNameTableOffset,
    names,
  );

  const nodeMidRoadway = markMidRoadwayNodes(
    nodeCount,
    csr,
    adjacency,
    edgeKindSide,
  );

  return {
    ...identity,
    nodeCount,
    edgeCount,
    originLng,
    originLat,
    scale,
    nodeQx,
    nodeQy,
    nodeComponent,
    csr,
    adjacency,
    edgeNodeA,
    edgeNodeB,
    edgeLength,
    edgeGeomOffset,
    edgeGeomCount,
    edgeCover,
    edgeNameId,
    edgeKindSide,
    edgeSourceId,
    edgeOrdinal,
    nodeMidRoadway,
    maxCover,
    edgeLandmark,
    edgeArt,
    edgeHighway,
    edgeCommercial,
    maxLandmark,
    maxArt,
    maxCommercial,
    edgeDirectCanopy,
    maxDirectCanopy,
    edgeRelief,
    maxRelief,
    shade: null, // populated lazily once the SHDE artifact loads, keyed on the departure instant
    sheds: null, // populated lazily once the SHED artifact loads, keyed on the picked day
    ferries: null, // populated lazily once the FSCH artifact loads, keyed on the departure day
    edgeHalfOffsetDm,
    edgeDurationSeconds,
    ferryEdges: Uint32Array.from(ferryEdges),
    minFerrySecPerMetre,
    edgeFlags,
    names,
    geometry,
    ferryEndpointNames,
  };
}

// The name table: a u32 count, (count + 1) u32 byte offsets into the trailing UTF-8 blob, then
// the blob. The offsets bracket each name, so access is O(1) and the strings are decoded once.
function decodeNames(buffer: ArrayBuffer, tableOffset: number): string[] {
  const view = new DataView(buffer);
  const count = view.getUint32(tableOffset, true);
  const offsetsAt = tableOffset + 4;
  const blobAt = offsetsAt + (count + 1) * 4;
  const decoder = new TextDecoder();
  const names: string[] = new Array(count);
  for (let index = 0; index < count; index++) {
    const start = view.getUint32(offsetsAt + index * 4, true);
    const end = view.getUint32(offsetsAt + (index + 1) * 4, true);
    names[index] = decoder.decode(
      new Uint8Array(buffer, blobAt + start, end - start),
    );
  }
  return names;
}

// The ferry endpoint-stop-name side table (byte-60 offset): a u32 count, then per ferry edge a
// (u32 edge id, u16 a-stop name id, u16 b-stop name id) triple, both ids into the name table. The
// route name rides on the edge itself, so only the two terminal names live here.
function decodeFerryEndpointNames(
  buffer: ArrayBuffer,
  tableOffset: number,
  names: string[],
): Map<number, { a: string; b: string }> {
  const map = new Map<number, { a: string; b: string }>();
  if (tableOffset === 0 || tableOffset + 4 > buffer.byteLength) {
    return map;
  }
  const view = new DataView(buffer);
  const count = view.getUint32(tableOffset, true);
  let at = tableOffset + 4;
  for (let index = 0; index < count; index++) {
    const edge = view.getUint32(at, true);
    const aId = view.getUint16(at + 4, true);
    const bId = view.getUint16(at + 6, true);
    at += 8;
    map.set(edge, { a: names[aId] ?? "", b: names[bId] ?? "" });
  }
  return map;
}

export function edgeKind(graph: RoutingGraph, edge: number): EdgeKind {
  return EDGE_KINDS[graph.edgeKindSide[edge] & KIND_MASK];
}

export function edgeSideLabel(graph: RoutingGraph, edge: number): SideLabel {
  return SIDE_LABELS[(graph.edgeKindSide[edge] >> SIDE_SHIFT) & SIDE_MASK];
}

export function edgeName(graph: RoutingGraph, edge: number): string | null {
  const nameId = graph.edgeNameId[edge];
  return nameId === NAME_NONE ? null : graph.names[nameId];
}

// True when this sidewalk lies to the right of its stored geometry direction (flags bit 2).
export function edgeGeometryRight(graph: RoutingGraph, edge: number): boolean {
  return (graph.edgeFlags[edge] & GEOMETRY_RIGHT_FLAG) !== 0;
}

// Keyed by city: switching city loads a different graph, and coming back must not refetch the first.
const graphPromises = new Map<string, Promise<RoutingGraph>>();

// How the graph beside it names itself, read out of the deploy's own record rather than recomputed
// here: FNV-1a over 30 MB of graph is ~0.5 s of blocked main thread on a laptop and several times
// that on a phone, and the key space would want a 600k-element sort on top, to arrive at two numbers
// the graph pass already wrote down. The two files are written by one pass, so they cannot skew. An
// unreadable version file leaves both unknown, which no artifact then matches — the graph itself
// still loads, so only what is placed against it goes quiet. A version file from before `keyHash`
// existed is the same case.
async function fetchGraphIdentity(cityId: string): Promise<GraphIdentity> {
  const url = versionUrl(cityId);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const version = (await response.json()) as Partial<GraphIdentity>;
    return { hash: version.hash ?? "", keyHash: version.keyHash ?? "" };
  } catch (error: unknown) {
    console.error(`${url} is unreadable:`, error);
    return { hash: "", keyHash: "" };
  }
}

export function loadGraph(cityId: string): Promise<RoutingGraph> {
  const pending = graphPromises.get(cityId);
  if (pending) {
    return pending;
  }
  const url = `routing/${cityId}.bin`;
  const request = Promise.all([fetch(url), fetchGraphIdentity(cityId)])
    .then(async ([response, identity]) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return decodeGraph(await response.arrayBuffer(), identity);
    })
    .catch((error: unknown) => {
      graphPromises.delete(cityId); // a failed load must not be memoized
      throw error;
    });
  graphPromises.set(cityId, request);
  return request;
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

export interface EdgePath {
  lngs: Float64Array;
  lats: Float64Array;
}

// Bounded most-recently-used cache: a route decodes an edge's geometry once for the search and
// again while stitching, and adjacent queries revisit the same corridor. Production runs one graph,
// so keying on the edge id alone is safe; tests that build several synthetic graphs reusing edge ids
// call clearEdgePathCache between them so a stale polyline never leaks across graphs.
const pathCache = new Map<number, EdgePath>();

export function clearEdgePathCache(): void {
  pathCache.clear();
}

export function edgePath(graph: RoutingGraph, edge: number): EdgePath {
  const cached = pathCache.get(edge);
  if (cached) {
    pathCache.delete(edge);
    pathCache.set(edge, cached);
    return cached;
  }

  let path: EdgePath;
  if (graph.edgeGeomOffset[edge] === NO_GEOMETRY) {
    // Crossings and links carry no geometry: the polyline is the straight line between the two
    // node coordinates, in a -> b order.
    const nodeA = graph.edgeNodeA[edge];
    const nodeB = graph.edgeNodeB[edge];
    path = {
      lngs: Float64Array.of(
        graph.originLng + graph.nodeQx[nodeA] * graph.scale,
        graph.originLng + graph.nodeQx[nodeB] * graph.scale,
      ),
      lats: Float64Array.of(
        graph.originLat + graph.nodeQy[nodeA] * graph.scale,
        graph.originLat + graph.nodeQy[nodeB] * graph.scale,
      ),
    };
  } else {
    const count = graph.edgeGeomCount[edge];
    const lngs = new Float64Array(count);
    const lats = new Float64Array(count);
    const cursor = { offset: graph.edgeGeomOffset[edge] };
    // Geometry entries are origin-anchored: the first pair is the absolute quantized position (a
    // delta from the graph origin) and the rest are previous-vertex deltas.
    let quantizedX = 0;
    let quantizedY = 0;
    for (let vertex = 0; vertex < count; vertex++) {
      quantizedX += readVarint(graph.geometry, cursor);
      quantizedY += readVarint(graph.geometry, cursor);
      lngs[vertex] = graph.originLng + quantizedX * graph.scale;
      lats[vertex] = graph.originLat + quantizedY * graph.scale;
    }
    path = { lngs, lats };
  }

  pathCache.set(edge, path);
  if (pathCache.size > PATH_CACHE_LIMIT) {
    const oldest = pathCache.keys().next().value;
    if (oldest !== undefined) {
      pathCache.delete(oldest);
    }
  }
  return path;
}

// The edge's polyline between two along-distances, in a -> b order, with the two boundaries
// interpolated. Along-distance is measured in the same scaled metric as Snap.metersFromA — the
// polyline's own planar arc length rescaled to the edge's geodesic length — so a fraction of the
// edge's length is the same fraction of its polyline.
export function subEdgePath(
  graph: RoutingGraph,
  edge: number,
  fromMeters: number,
  toMeters: number,
): { lngs: number[]; lats: number[] } {
  const { lngs, lats } = edgePath(graph, edge);
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(lats[0] * toRad);
  const cumulative = new Float64Array(lngs.length);
  for (let vertex = 1; vertex < lngs.length; vertex++) {
    const deltaX = (lngs[vertex] - lngs[vertex - 1]) * cosLat;
    const deltaY = lats[vertex] - lats[vertex - 1];
    cumulative[vertex] = cumulative[vertex - 1] + Math.hypot(deltaX, deltaY);
  }
  const total = cumulative[lngs.length - 1];
  const scale = total > 0 ? graph.edgeLength[edge] / total : 0;

  const at = (distance: number): { lng: number; lat: number } => {
    if (scale === 0) {
      return { lng: lngs[0], lat: lats[0] };
    }
    const raw = distance / scale;
    let vertex = 1;
    while (vertex < lngs.length - 1 && cumulative[vertex] < raw) {
      vertex += 1;
    }
    const span = cumulative[vertex] - cumulative[vertex - 1];
    const param = span > 0 ? (raw - cumulative[vertex - 1]) / span : 0;
    return {
      lng: lngs[vertex - 1] + param * (lngs[vertex] - lngs[vertex - 1]),
      lat: lats[vertex - 1] + param * (lats[vertex] - lats[vertex - 1]),
    };
  };

  const start = at(fromMeters);
  const outLngs = [start.lng];
  const outLats = [start.lat];
  for (let vertex = 0; vertex < lngs.length; vertex++) {
    const along = cumulative[vertex] * scale;
    if (along > fromMeters && along < toMeters) {
      outLngs.push(lngs[vertex]);
      outLats.push(lats[vertex]);
    }
  }
  const end = at(toMeters);
  outLngs.push(end.lng);
  outLats.push(end.lat);
  return { lngs: outLngs, lats: outLats };
}

export function otherEnd(
  graph: RoutingGraph,
  edge: number,
  node: number,
): number {
  return graph.edgeNodeA[edge] === node
    ? graph.edgeNodeB[edge]
    : graph.edgeNodeA[edge];
}
