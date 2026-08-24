// biome-ignore-all lint/correctness/useHookAtTopLevel: gl.useProgram is WebGL, not a React hook

import { type Channel, type Ramp, STOPS_LIMIT } from "../theme/palette";
import { type Patch, draw as resample } from "./magnify";

// The one place a value tile becomes a coloured one.
//
// The raster overlays ship data — canopy cover, height and relief, the fraction of light lost to a
// shadow — and the palette (src/theme/palette.ts) says what that data looks like. Every one of them
// is doing the same thing to its pixels, so they all do it here, through one shader with the ramp as
// its uniforms. That is what makes a theme a value: changing it is a redraw, never a rebuild.
//
// ONE context serves every tile: they are expensive and browsers cap a document at around 16. The
// tile arrives as an OffscreenCanvas already committed to a 2D context, so the pixels are shaded on
// this module's own canvas and composed onto the tile, exactly as ./sweep-gl.ts does.

const TILE_SIZE = 256;

// Which texture channel a `Channel` is, as the shader indexes them.
const CHANNELS: Record<Channel, number> = { red: 0, green: 1, alpha: 3 };

const VERTEX = `#version 300 es
in vec2 point;
void main() { gl_Position = vec4(point, 0.0, 1.0); }`;

// The value tile read through the ramp. `size - 1 - y` because gl_FragCoord counts up from the
// bottom while the staging canvas's rows count down from the top, and the drawing buffer is
// presented the same way round as the canvas it is composed onto.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform int size;
uniform vec3 stops[${STOPS_LIMIT}];
uniform int stopCount;
uniform int valueChannel;
uniform int alphaChannel;
uniform int reliefChannel; // negative where the layer carries no relief
uniform float valueFull;
uniform float alphaFull;
uniform float alphaCurve;
uniform float maxAlpha;
uniform float reliefScale;
out vec4 colour;

float channel(vec4 pixel, int which) {
  return which == 0 ? pixel.r : which == 1 ? pixel.g : which == 2 ? pixel.b : pixel.a;
}

void main() {
  vec4 pixel = texelFetch(
    source, ivec2(int(gl_FragCoord.x), size - 1 - int(gl_FragCoord.y)), 0);
  float alpha = maxAlpha
    * pow(clamp(channel(pixel, alphaChannel) / alphaFull, 0.0, 1.0), alphaCurve);
  if (alpha <= 0.0) {
    colour = vec4(0.0);
    return;
  }
  vec3 tint = stops[0];
  if (stopCount > 1) {
    float position =
      clamp(channel(pixel, valueChannel) / valueFull, 0.0, 1.0) * float(stopCount - 1);
    int low = clamp(int(floor(position)), 0, stopCount - 2);
    tint = mix(stops[low], stops[low + 1], position - float(low));
  }
  if (reliefChannel >= 0) {
    tint *= channel(pixel, reliefChannel) * reliefScale;
  }
  colour = vec4(clamp(tint, 0.0, 1.0) * alpha, alpha); // premultiplied, matching the canvas
}`;

function compile(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error("no shader");
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.bindAttribLocation(program, 0, "point");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "theme shader failed");
  }
  return program;
}

// The ramp's stops as the shader's uniform array: RGB on 0..1, padded to its fixed length.
function stopsOf(ramp: Ramp): Float32Array {
  const packed = new Float32Array(STOPS_LIMIT * 3);
  for (const [index, { red, green, blue }] of ramp.stops.entries()) {
    packed.set([red / 255, green / 255, blue / 255], index * 3);
  }
  return packed;
}

class Painter {
  // The value pixels, resampled to the tile's own device pixels before they are coloured. The
  // resample runs on the VALUES rather than on a picture of them, which is the point of shipping
  // values: the ramp is applied to what the interpolation actually produced.
  readonly stage: OffscreenCanvas;
  readonly stageContext: OffscreenCanvasRenderingContext2D;
  readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  constructor(readonly size: number) {
    this.stage = new OffscreenCanvas(size, size);
    const stageContext = this.stage.getContext("2d");
    if (!stageContext) {
      throw new Error("no 2d context");
    }
    this.stageContext = stageContext;

    this.canvas = new OffscreenCanvas(size, size);
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true, // the compose reads it back after the draw has returned
    });
    if (!gl) {
      throw new Error("no webgl2");
    }
    this.gl = gl;
    this.program = compile(gl);
    this.locate();

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), // one oversized triangle covering the clip square
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // The staging canvas's backing store is premultiplied, as every 2D canvas's is, so this flag is
    // what makes the browser UNDO that on the way to the card and hand the shader the values back.
    // Colour conversion is off for the same reason: these are data, not a picture.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
      gl.NONE as unknown as number,
    );
  }

  private locate(): void {
    const { gl, program } = this;
    gl.useProgram(program);
    this.uniforms = Object.fromEntries(
      [
        "source",
        "size",
        "stops",
        "stopCount",
        "valueChannel",
        "alphaChannel",
        "reliefChannel",
        "valueFull",
        "alphaFull",
        "alphaCurve",
        "maxAlpha",
        "reliefScale",
      ].map((name) => [name, gl.getUniformLocation(program, name)]),
    );
    gl.uniform1i(this.uniforms.source, 0);
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  // Browsers cap a document at around 16 live contexts and reclaim the oldest when a new one takes
  // it past that, so a painter replaced for a new device ratio gives its own up rather than waiting
  // to be collected.
  dispose(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // Colour whatever is on the staging canvas, leaving it on this painter's own canvas.
  paint(ramp: Ramp): void {
    const { gl, size, uniforms } = this;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.stage,
    );
    gl.uniform1i(uniforms.size, size);
    gl.uniform3fv(uniforms.stops, stopsOf(ramp));
    gl.uniform1i(uniforms.stopCount, ramp.stops.length);
    gl.uniform1i(uniforms.valueChannel, CHANNELS[ramp.value]);
    gl.uniform1i(uniforms.alphaChannel, CHANNELS[ramp.alpha]);
    gl.uniform1i(
      uniforms.reliefChannel,
      ramp.relief ? CHANNELS[ramp.relief] : -1,
    );
    gl.uniform1f(uniforms.valueFull, ramp.valueFull);
    gl.uniform1f(uniforms.alphaFull, ramp.alphaFull);
    gl.uniform1f(uniforms.alphaCurve, ramp.alphaCurve);
    gl.uniform1f(uniforms.maxAlpha, ramp.maxAlpha);
    gl.uniform1f(uniforms.reliefScale, ramp.reliefScale);
    gl.viewport(0, 0, size, size);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

let painter: Painter | null = null;

// The shared painter at this tile size, rebuilt when the device ratio changes under it or its
// context was lost. Unlike the swept shade there is no second path to fall back to — an overlay whose
// values were never coloured has nothing to show — so a card that cannot do this throws, and the
// tile reaches Leaflet as an error the layers menu can report.
function painterFor(size: number): Painter {
  if (painter?.lost) {
    painter = null; // a lost context cannot be revived, only replaced
  }
  if (painter?.size !== size) {
    painter?.dispose();
    painter = new Painter(size);
  }
  return painter;
}

// One tile's values cut out of a baked pyramid, resampled, coloured through the ramp, and composed
// onto the tile. A null patch is a pyramid with nothing over this ground, which draws as nothing.
export function drawRamped(
  context: OffscreenCanvasRenderingContext2D,
  source: Patch | null,
  ramp: Ramp,
  ratio: number,
): void {
  if (!source) {
    return;
  }
  const size = Math.round(TILE_SIZE * ratio);
  const painted = painterFor(size);
  painted.stageContext.reset();
  painted.stageContext.scale(ratio, ratio);
  resample(painted.stageContext, source);
  painted.paint(ramp);
  // Checked after the draw as well as before it. A context can go away mid-tile — a driver reset, or
  // the browser reclaiming the oldest one when the document passes its cap — and every call in
  // `paint` is then a silent no-op. Left unchecked the tile would be composed from an empty drawing
  // buffer and reported as drawn, and Leaflet never asks for a tile twice: the shade layer in
  // particular would show no shade at all, which is the one answer it must never give.
  if (painted.lost) {
    throw new Error("theme shader: the graphics context was lost mid-tile");
  }
  context.drawImage(painted.canvas, 0, 0, TILE_SIZE, TILE_SIZE);
}
