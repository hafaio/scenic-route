// The client's view of the routing graph baked by `tiler graph`. Layout: scripts/README.md
// (magic GRPH, v3 — the sidewalk graph with inert ferry edges). Fixed sections are viewed in place
// over the fetched buffer; the strided edge records are copied once into parallel typed arrays so
// the search loop touches only flat arrays.

// A no-geometry edge (a crossing, a link, or a straight ferry) stores this sentinel in its geometry
// offset; its polyline is the straight line between its two node coordinates.
export const NO_GEOMETRY = 0xffffffff;
const NAME_NONE = 0xffff;
// Edge kind lives in bits 0-2 of the kind+side byte; the side in bits 3-5.
const KIND_MASK = 0x7;
const SIDE_SHIFT = 3;
const SIDE_MASK = 0x7;
const KIND_FERRY = 4;
// flags byte bit 2 marks a sidewalk that lies to the right of its stored geometry direction.
const GEOMETRY_RIGHT_FLAG = 0x4;

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

export interface RoutingGraph {
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
  maxCover: number; // the greatest per-edge cover in the graph, 0..1; sets the cost clip floor

  edgeLandmark: Uint8Array; // 0..254, this edge's landmark-amenity discount attribute; 0 for a ferry
  edgeArt: Uint8Array; // 0..254, this edge's public-art discount attribute; 0 for a ferry
  edgeHighway: Uint8Array; // 0..254, this edge's highway/rail nuisance penalty attribute; 0 for a ferry
  maxLandmark: number; // the greatest per-edge landmark amenity, 0..1; sets that discount's clip floor
  maxArt: number; // the greatest per-edge art amenity, 0..1; sets that discount's clip floor

  edgeHalfOffsetDm: Uint8Array; // decimetres to a sidewalk; 0 for crossings/links/paths/ferries
  edgeDurationSeconds: Float32Array; // a ferry edge's crossing-plus-wait seconds; 0 for every other kind
  ferryEdges: Uint32Array; // ids of the ferry edges, for the A* ferry-credit heuristic
  minFerrySecPerMetre: number; // min over ferry edges of duration/length, Infinity when there are none
  edgeFlags: Uint8Array; // bit0 structure, bit1 steps, bit2 geometry-right (sidewalks)
  names: string[];
  geometry: Uint8Array;
  // Per ferry edge, its two terminal stop names at the node-a and node-b ends (aligned to
  // edgeNodeA/edgeNodeB). The route name is the edge's own name (`edgeName`).
  ferryEndpointNames: Map<number, { a: string; b: string }>;
}

const MAGIC = "GRPH";
const FORMAT_VERSION = 4;
const HEADER_BYTES = 64;
const EDGE_RECORD_BYTES = 28;
const GRAPH_URL = "routing/nyc.bin"; // relative, so it picks up the deploy basePath
const PATH_CACHE_LIMIT = 512;

function fourByteAlign(offset: number): number {
  return (offset + 3) & ~3;
}

export function decodeGraph(buffer: ArrayBuffer): RoutingGraph {
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
  const ferryEdges: number[] = [];
  let maxCoverByte = 0;
  let maxLandmarkByte = 0;
  let maxArtByte = 0;
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
    // The scenic-factor bytes are their own record slot, so a ferry's duration in bytes 20-21 does
    // not collide; a ferry carries 0 in all three, so it never lifts a discount's max.
    edgeLandmark[edge] = bytes[record + 24];
    edgeArt[edge] = bytes[record + 25];
    edgeHighway[edge] = bytes[record + 26];
    maxLandmarkByte = Math.max(maxLandmarkByte, edgeLandmark[edge]);
    maxArtByte = Math.max(maxArtByte, edgeArt[edge]);
  }
  const maxCover = maxCoverByte / 255;
  const maxLandmark = maxLandmarkByte / 255;
  const maxArt = maxArtByte / 255;

  const names = decodeNames(buffer, nameTableOffset);
  const geometry = new Uint8Array(buffer, geometryOffset, geometryLength);
  const ferryEndpointNames = decodeFerryEndpointNames(
    buffer,
    ferryNameTableOffset,
    names,
  );

  return {
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
    maxCover,
    edgeLandmark,
    edgeArt,
    edgeHighway,
    maxLandmark,
    maxArt,
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

let graphPromise: Promise<RoutingGraph> | null = null;

export function loadGraph(): Promise<RoutingGraph> {
  if (!graphPromise) {
    graphPromise = fetch(GRAPH_URL)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `${GRAPH_URL}: ${response.status} ${response.statusText}`,
          );
        }
        return decodeGraph(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        graphPromise = null; // a failed load must not be memoized
        throw error;
      });
  }
  return graphPromise;
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

export function otherEnd(
  graph: RoutingGraph,
  edge: number,
  node: number,
): number {
  return graph.edgeNodeA[edge] === node
    ? graph.edgeNodeB[edge]
    : graph.edgeNodeA[edge];
}
