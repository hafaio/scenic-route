"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { GENUS_COLORS } from "../src/tree-cover/genus";
import {
  getEnabledGenera,
  subscribeGenusFilter,
} from "../src/tree-cover/genus-filter";
import manifest from "../src/tree-cover/manifest.json";
import TreeDotsLayer from "./tree-dots-layer";

// The low-zoom genus overlay: a client-shaded dominance texture. The raster half (z9-z14) is a stack
// of DATA tiles baked by `tiler genus-field` — four lossless tiles per position, each carrying three
// genera's local crown density in its R/G/B (12 genera / 3 = 4 tiles). One shared WebGL2 context reads
// the enabled channels per pixel and shades them: the dominant genus, dithered against its runner-up
// in proportion, faded by the total density so it reads like thinning-and-thickening tree cover rather
// than a filled map. Toggling a genus is a uniform write and a redraw, so the dominance renormalises
// live (a region hands off to its runner-up) with no refetch — which a stack of pre-coloured tiles,
// which can only add ink, structurally could not do. From z15 up TreeDotsLayer draws crisp live dots.
const TILE_URL = "tiles/genus-field/{layer}/{z}/{x}/{y}.webp";
const LAYERS = 4; // 12 genera packed three-per-tile (R,G,B); see tiler genus-field
const TILE_SIZE = 256;
const MIN_NATIVE_ZOOM = 9;
const MAX_NATIVE_ZOOM = 14; // the data pyramid's finest zoom; from z15 TreeDotsLayer draws instead
const PANE_NAME = "genus-gl";
const PANE_Z_INDEX = 250; // above the basemap tilePane (~200), below the overlayPane (400); see genus-layer

// The vertical flip lives here, deterministically: negate aPos.y before mapping to UV so the tile's
// top samples the image's top row (north). Doing it in the shader rather than via UNPACK_FLIP_Y_WEBGL
// because that pixelStore flag is unreliable — in practice ignored — for ImageBitmap texture uploads.
const VERTEX_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x, -aPos.y) * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// The look lives here, so tuning is a shader edit (instant HMR), not a rebake. Reads the enabled
// genera's densities per pixel, colours the dominant, dithers it against the runner-up in proportion
// to their split, and fades the whole by total density: sparse cover stays faint, a dense stand goes
// near-opaque. Toggling a genus off drops its channel from the max scan, so the region falls to
// whatever it's next-densest in — the live renormalisation.
const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uData0;
uniform sampler2D uData1;
uniform sampler2D uData2;
uniform sampler2D uData3;
uniform uint uMask;
uniform vec3 uPalette[12];

// Density (a channel byte / 255, so coverage / 2.5) mapped to alpha: gain lifts the whole, gamma
// pulls faint cover up so a lightly treed block still reads, and the ceiling keeps the basemap
// showing through the densest stands.
const float DENSITY_GAIN = 1.6;
const float DENSITY_GAMMA = 0.7;
const float MAX_ALPHA = 0.85;

bool enabled(int id) { return (uMask & (1u << uint(id))) != 0u; }

// A cheap per-pixel hash standing in for a blue-noise texture; its speckle repeats every tile, which
// is invisible in noise. (A large per-tile world offset would overflow float32 and go constant.)
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

void main() {
  float density[12];
  vec3 s0 = texture(uData0, vUv).rgb;
  vec3 s1 = texture(uData1, vUv).rgb;
  vec3 s2 = texture(uData2, vUv).rgb;
  vec3 s3 = texture(uData3, vUv).rgb;
  density[0] = s0.r; density[1] = s0.g; density[2] = s0.b;
  density[3] = s1.r; density[4] = s1.g; density[5] = s1.b;
  density[6] = s2.r; density[7] = s2.g; density[8] = s2.b;
  density[9] = s3.r; density[10] = s3.g; density[11] = s3.b;

  int dom = -1;
  float domValue = 0.0;
  int sec = -1;
  float secValue = 0.0;
  float total = 0.0;
  for (int id = 0; id < 12; id++) {
    if (!enabled(id)) { continue; }
    float value = density[id];
    total += value;
    if (value > domValue) {
      sec = dom; secValue = domValue;
      dom = id; domValue = value;
    } else if (value > secValue) {
      sec = id; secValue = value;
    }
  }
  if (dom < 0 || total <= 0.0) {
    frag = vec4(0.0);
    return;
  }

  int pick = dom;
  if (sec >= 0 && secValue > 0.0) {
    float share = domValue / (domValue + secValue);
    pick = hash21(gl_FragCoord.xy) < share ? dom : sec;
  }

  float alpha = clamp(pow(total * DENSITY_GAIN, DENSITY_GAMMA), 0.0, MAX_ALPHA);
  frag = vec4(uPalette[pick] * alpha, alpha); // premultiplied, matching the canvas
}`;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("could not create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(
      `genus-gl shader failed to compile: ${gl.getShaderInfoLog(shader)}`,
    );
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("could not create program");
  }
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(
      `genus-gl program failed to link: ${gl.getProgramInfoLog(program)}`,
    );
  }
  return program;
}

// The genus palette as a flat RGB-in-0..1 array, uploaded once as the shader's colour lookup.
const PALETTE = new Float32Array(
  GENUS_COLORS.flatMap(({ red, green, blue }) => [
    red / 255,
    green / 255,
    blue / 255,
  ]),
);

function maskFromEnabled(enabled: ReadonlySet<number>): number {
  let mask = 0;
  for (const id of enabled) {
    mask |= 1 << id;
  }
  return mask >>> 0;
}

// The tile bounds: the union of every city that carries a genus layer, so Leaflet never requests a
// tile outside the baked pyramid (a 404 the decoder would choke on).
function genusBounds(): L.LatLngBounds | undefined {
  const boxes = manifest.cities
    .filter((city) => city.field.genus)
    .map((city) => city.bounds);
  if (boxes.length === 0) {
    return undefined;
  }
  const south = Math.min(...boxes.map((box) => box.south));
  const west = Math.min(...boxes.map((box) => box.west));
  const north = Math.max(...boxes.map((box) => box.north));
  const east = Math.max(...boxes.map((box) => box.east));
  return L.latLngBounds([south, west], [north, east]);
}

interface TileEntry {
  canvas: HTMLCanvasElement;
  textures: WebGLTexture[]; // one per packed layer, empty until loaded
  coords: L.Coords;
  controller: AbortController;
}

export default function GenusGlLayer() {
  const map = useMap();

  useEffect(() => {
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    // One offscreen canvas + context shared by every tile: each tile renders here, then blits into
    // its own 2D canvas. A context per tile would exhaust the browser's ~8-16 live-context budget.
    const glCanvas = document.createElement("canvas");
    glCanvas.width = TILE_SIZE;
    glCanvas.height = TILE_SIZE;
    const gl = glCanvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) {
      throw new Error("genus-gl prototype needs WebGL2");
    }

    let program = linkProgram(gl);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), // one oversized triangle covering the clip square
      gl.STATIC_DRAW,
    );

    const locations = {
      position: gl.getAttribLocation(program, "aPos"),
      mask: gl.getUniformLocation(program, "uMask"),
      palette: gl.getUniformLocation(program, "uPalette"),
    };
    // The four data samplers read from texture units 0..3, bound once — a tile's layers upload into
    // those units and the program keeps pointing at them.
    const bindSamplers = (): void => {
      // biome-ignore lint/correctness/useHookAtTopLevel: gl.useProgram is a WebGL call, not a hook
      gl.useProgram(program);
      for (let layer = 0; layer < LAYERS; layer += 1) {
        gl.uniform1i(gl.getUniformLocation(program, `uData${layer}`), layer);
      }
    };
    bindSamplers();

    // Orientation is handled in the vertex shader (it flips reliably); this flag is unreliable for
    // ImageBitmap and left at its default. Premultiply off so the RGB density bytes decode intact.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
      gl.NONE as unknown as number,
    );

    const tiles = new Map<string, TileEntry>();
    let mask = maskFromEnabled(getEnabledGenera());

    const uploadBitmap = (bitmap: ImageBitmap): WebGLTexture => {
      const texture = gl.createTexture();
      if (!texture) {
        throw new Error("could not create texture");
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bitmap,
      );
      return texture;
    };

    const draw = (entry: TileEntry): void => {
      if (entry.textures.length < LAYERS) {
        return; // not fully loaded yet
      }
      gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
      // biome-ignore lint/correctness/useHookAtTopLevel: gl.useProgram is a WebGL call, not a hook
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(locations.position);
      gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0);
      for (let layer = 0; layer < LAYERS; layer += 1) {
        gl.activeTexture(gl.TEXTURE0 + layer);
        gl.bindTexture(gl.TEXTURE_2D, entry.textures[layer]);
      }
      gl.uniform1ui(locations.mask, mask);
      gl.uniform3fv(locations.palette, PALETTE);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const ctx = entry.canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
        ctx.drawImage(glCanvas, 0, 0);
      }
    };

    // Fetch the four data tiles for a position, decode them WITHOUT the browser premultiplying or
    // colour-converting (they're data, not colour), upload each as a texture, then draw and report.
    const load = (entry: TileEntry, done: (error?: Error) => void): void => {
      const { z, x, y } = entry.coords;
      const urls = Array.from({ length: LAYERS }, (_unused, layer) =>
        TILE_URL.replace("{layer}", String(layer))
          .replace("{z}", String(z))
          .replace("{x}", String(x))
          .replace("{y}", String(y)),
      );
      Promise.all(
        urls.map((url) =>
          fetch(url, { signal: entry.controller.signal })
            .then((response) => response.blob())
            .then((blob) =>
              createImageBitmap(blob, {
                premultiplyAlpha: "none",
                colorSpaceConversion: "none",
              }),
            ),
        ),
      )
        .then((bitmaps) => {
          if (entry.controller.signal.aborted) {
            return;
          }
          entry.textures = bitmaps.map(uploadBitmap);
          draw(entry);
          done();
        })
        .catch((error: Error) => {
          if (!entry.controller.signal.aborted) {
            done(error);
          }
        });
    };

    const deleteTextures = (entry: TileEntry): void => {
      for (const texture of entry.textures) {
        gl.deleteTexture(texture);
      }
      entry.textures = [];
    };

    const GlGrid = L.GridLayer.extend({
      createTile(
        coords: L.Coords,
        done: (error?: Error, tile?: HTMLElement) => void,
      ) {
        const canvas = document.createElement("canvas");
        canvas.width = TILE_SIZE;
        canvas.height = TILE_SIZE;
        const entry: TileEntry = {
          canvas,
          textures: [],
          coords,
          controller: new AbortController(),
        };
        tiles.set(`${coords.z}/${coords.x}/${coords.y}`, entry);
        load(entry, (error) => done(error, canvas));
        return canvas;
      },
    });

    const GlGridCtor = GlGrid as new (
      options: L.GridLayerOptions,
    ) => L.GridLayer;
    const layer = new GlGridCtor({
      pane: PANE_NAME,
      tileSize: TILE_SIZE,
      bounds: genusBounds(),
      minNativeZoom: MIN_NATIVE_ZOOM,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      maxZoom: MAX_NATIVE_ZOOM, // hand off to TreeDotsLayer above
      updateWhenZooming: false,
      keepBuffer: 2,
    });

    layer.on("tileunload", (event: L.TileEvent) => {
      const key = `${event.coords.z}/${event.coords.x}/${event.coords.y}`;
      const entry = tiles.get(key);
      if (entry) {
        entry.controller.abort();
        deleteTextures(entry);
        tiles.delete(key);
      }
    });

    const redrawAll = (): void => {
      for (const entry of tiles.values()) {
        draw(entry);
      }
    };

    const unsubscribe = subscribeGenusFilter(() => {
      mask = maskFromEnabled(getEnabledGenera());
      redrawAll();
    });

    // iOS Safari drops the GL context under memory pressure / when backgrounded; without this the
    // overlay silently goes blank. Preventing the default keeps it recoverable; on restore we relink
    // the program and re-load every live tile (its textures died with the context).
    const onLost = (event: Event): void => {
      event.preventDefault();
    };
    const onRestored = (): void => {
      program = linkProgram(gl);
      locations.position = gl.getAttribLocation(program, "aPos");
      locations.mask = gl.getUniformLocation(program, "uMask");
      locations.palette = gl.getUniformLocation(program, "uPalette");
      bindSamplers();
      for (const entry of tiles.values()) {
        entry.textures = [];
        entry.controller = new AbortController();
        load(entry, () => undefined);
      }
    };
    glCanvas.addEventListener("webglcontextlost", onLost);
    glCanvas.addEventListener("webglcontextrestored", onRestored);

    layer.addTo(map);

    return () => {
      unsubscribe();
      glCanvas.removeEventListener("webglcontextlost", onLost);
      glCanvas.removeEventListener("webglcontextrestored", onRestored);
      map.removeLayer(layer);
      for (const entry of tiles.values()) {
        entry.controller.abort();
        deleteTextures(entry);
      }
      tiles.clear();
    };
  }, [map]);

  return <TreeDotsLayer />;
}
