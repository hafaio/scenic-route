// The client's view of the routing graph baked by `tiler graph`. Layout: scripts/README.md
// (magic GRPH, v1). Fixed sections are viewed in place over the fetched buffer; the strided
// edge records are copied once into parallel typed arrays so the search loop touches only flat
// arrays.

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
  edgeGeomOffset: Uint32Array; // byte offset into the geometry blob
  edgeGeomCount: Uint16Array; // vertices, >= 2
  edgeCoverLeft: Uint8Array; // 0..255, left side of a -> b travel
  edgeCoverRight: Uint8Array;
  maxCover: number; // the greatest per-edge cover in the graph, 0..1; sets the cost clip floor

  edgeHalfOffsetDm: Uint8Array; // decimetres to a sidewalk; 0 = drawn/walked on the line
  edgeFlags: Uint8Array; // 1 structure, 2 steps, 4 path-like
  geometry: Uint8Array;
}

const MAGIC = "GRPH";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 64;
const EDGE_RECORD_BYTES = 24;
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
  const geometryOffset = view.getUint32(44, true);
  const geometryLength = view.getUint32(48, true);

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
  const edgeCoverLeft = new Uint8Array(edgeCount);
  const edgeCoverRight = new Uint8Array(edgeCount);
  const edgeHalfOffsetDm = new Uint8Array(edgeCount);
  const edgeFlags = new Uint8Array(edgeCount);
  let maxCoverByte = 0;
  for (let edge = 0; edge < edgeCount; edge++) {
    const record = offset + edge * EDGE_RECORD_BYTES;
    edgeNodeA[edge] = view.getUint32(record, true);
    edgeNodeB[edge] = view.getUint32(record + 4, true);
    edgeLength[edge] = view.getFloat32(record + 8, true);
    edgeGeomOffset[edge] = view.getUint32(record + 12, true);
    edgeGeomCount[edge] = view.getUint16(record + 16, true);
    edgeCoverLeft[edge] = bytes[record + 18];
    edgeCoverRight[edge] = bytes[record + 19];
    edgeHalfOffsetDm[edge] = bytes[record + 20];
    edgeFlags[edge] = bytes[record + 21];
    maxCoverByte = Math.max(
      maxCoverByte,
      edgeCoverLeft[edge],
      edgeCoverRight[edge],
    );
  }
  const maxCover = maxCoverByte / 255;

  const geometry = new Uint8Array(buffer, geometryOffset, geometryLength);

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
    edgeCoverLeft,
    edgeCoverRight,
    maxCover,
    edgeHalfOffsetDm,
    edgeFlags,
    geometry,
  };
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
// again while stitching, and adjacent queries revisit the same corridor.
const pathCache = new Map<number, EdgePath>();

export function edgePath(graph: RoutingGraph, edge: number): EdgePath {
  const cached = pathCache.get(edge);
  if (cached) {
    pathCache.delete(edge);
    pathCache.set(edge, cached);
    return cached;
  }

  const count = graph.edgeGeomCount[edge];
  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  const cursor = { offset: graph.edgeGeomOffset[edge] };
  // The first delta is taken from node a's quantized position, so it is always (0, 0).
  let quantizedX = graph.nodeQx[graph.edgeNodeA[edge]];
  let quantizedY = graph.nodeQy[graph.edgeNodeA[edge]];
  for (let vertex = 0; vertex < count; vertex++) {
    quantizedX += readVarint(graph.geometry, cursor);
    quantizedY += readVarint(graph.geometry, cursor);
    lngs[vertex] = graph.originLng + quantizedX * graph.scale;
    lats[vertex] = graph.originLat + quantizedY * graph.scale;
  }

  const path: EdgePath = { lngs, lats };
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
