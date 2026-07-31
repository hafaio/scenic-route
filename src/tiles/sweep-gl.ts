// biome-ignore-all lint/correctness/useHookAtTopLevel: gl.useProgram is WebGL, not a React hook

import type { ShadeParams, TileCoords } from "./protocol";
import {
  castBases,
  castBuildings,
  castCrowns,
  castSheds,
  castTrunks,
  frameFor,
  MAX_SHADE_ALPHA,
  type PolygonSink,
  SHADE_RGB,
  type SweptGround,
  TILE_SIZE,
} from "./sweep";

// The swept shade of src/tiles/sweep.ts, rasterized on the GPU. The geometry and the model are that
// file's — this only changes what the polygons are handed to. Canvas2D spends ~1.1 µs per moveTo/lineTo
// binding into Skia, which over a park tile's ~50k vertices is 70% of the tile; the same loops writing
// into a Float32Array cost 1.2 ms for all of them, so the fix is to stop feeding Canvas2D vertex by
// vertex and union the polygons with stencil-then-cover instead of a nonzero fill.
//
// ONE context serves every tile: they are expensive and browsers cap a document at around 16. The tile
// arrives as an OffscreenCanvas already committed to a 2D context, so the layer is drawn on this
// module's own canvas and composed onto the tile. Where WebGL2 is missing or the context is lost,
// `drawSweepGl` says so and src/tiles/shade.ts falls back to the Canvas2D sweep, which stays the
// reference for both.

// Samples the shadow edges are resolved from. Stencil-then-cover paints whole pixels, so without
// multisampling every edge comes out hard where a Canvas2D fill feathers it; 4 already leaves p50 |Δ|
// against Canvas2D at 0, with the whole difference in the edge pixels.
const SAMPLES = 4;

// Consecutive context losses before the layer gives up and stays on Canvas2D. A GPU reset is worth
// rebuilding through; a driver that cannot hold a context is not worth retrying every tile.
const REBUILDS = 3;

// The shade colour the fills carry, on the 0..1 the shaders want.
const SLATE = SHADE_RGB.map((channel) => channel / 255);

// Terminates a polygon in the index buffer, so one drawElements covers a whole layer.
const RESTART = 0xffffffff;

// The Path2D stand-in the cast* loops write into: coordinates go straight into a flat array and each
// subpath becomes one restart-separated triangle fan, whose nonzero winding the stencil counts.
class Geometry implements PolygonSink {
  points = new Float32Array(1 << 12);
  indices = new Uint32Array(1 << 11);
  pointsAt = 0;
  indicesAt = 0;

  reset(): void {
    this.pointsAt = 0;
    this.indicesAt = 0;
  }

  // Room for one more vertex and the restart index that may precede it. The buffers start small and
  // settle after a handful of tiles: the busiest layer over a park screenful is 25k vertices, which
  // doubles its way to 256 KiB and stops.
  private room(): void {
    if (this.pointsAt + 2 > this.points.length) {
      const wider = new Float32Array(this.points.length * 2);
      wider.set(this.points);
      this.points = wider;
    }
    if (this.indicesAt + 2 > this.indices.length) {
      const wider = new Uint32Array(this.indices.length * 2);
      wider.set(this.indices);
      this.indices = wider;
    }
  }

  private push(x: number, y: number): void {
    this.indices[this.indicesAt++] = this.pointsAt / 2;
    this.points[this.pointsAt++] = x;
    this.points[this.pointsAt++] = y;
  }

  moveTo(x: number, y: number): void {
    this.room();
    if (this.indicesAt > 0) {
      this.indices[this.indicesAt++] = RESTART;
    }
    this.push(x, y);
  }

  lineTo(x: number, y: number): void {
    this.room();
    this.push(x, y);
  }

  closePath(): void {
    // A triangle fan closes itself; the restart index is written by the next moveTo.
  }
}

const COVER_VERTEX = `#version 300 es
in vec2 point;
void main() { gl_Position = vec4(point, 0.0, 1.0); }`;

// The cast* loops work in tile pixels whatever the device ratio is, so the tile's own size is the
// divisor and the viewport does the rest.
const PATH_VERTEX = `#version 300 es
in vec2 point;
const float tile = ${TILE_SIZE}.0;
void main() {
  gl_Position = vec4(point.x / tile * 2.0 - 1.0, 1.0 - point.y / tile * 2.0, 0.0, 1.0);
}`;

const FLAT_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 tint;
out vec4 colour;
void main() { colour = tint; }`;

const BLIT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform float alpha;
out vec4 colour;
void main() { colour = texelFetch(source, ivec2(gl_FragCoord.xy), 0) * alpha; }`;

function compile(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
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
    throw new Error(gl.getProgramInfoLog(program) ?? "shade shader failed");
  }
  return program;
}

class Sweeper {
  readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly pathProgram: WebGLProgram;
  private readonly coverProgram: WebGLProgram;
  private readonly blitProgram: WebGLProgram;
  private readonly tint: WebGLUniformLocation | null;
  private readonly alpha: WebGLUniformLocation | null;
  private readonly pathArray: WebGLVertexArrayObject;
  private readonly quadArray: WebGLVertexArrayObject;
  private readonly pathBuffer: WebGLBuffer;
  private readonly indexBuffer: WebGLBuffer;
  // One multisampled colour+stencil target serves both layers in turn, and the crowns are parked in
  // the resolve texture while the buildings reuse it.
  private readonly target: WebGLFramebuffer;
  private readonly resolved: WebGLFramebuffer;
  private readonly texture: WebGLTexture;
  private readonly shadows = new Geometry();
  private readonly crowns = new Geometry();
  private readonly sheds = new Geometry();
  private readonly bases = new Geometry();

  constructor(readonly size: number) {
    this.canvas = new OffscreenCanvas(size, size);
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false, // the layer resolves its own multisampled target into this one
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true, // the compose reads it back after the draw has returned
    });
    if (!gl) {
      throw new Error("no webgl2");
    }
    this.gl = gl;
    this.pathProgram = compile(gl, PATH_VERTEX, FLAT_FRAGMENT);
    this.coverProgram = compile(gl, COVER_VERTEX, FLAT_FRAGMENT);
    this.blitProgram = compile(gl, COVER_VERTEX, BLIT_FRAGMENT);
    this.tint = gl.getUniformLocation(this.coverProgram, "tint");
    this.alpha = gl.getUniformLocation(this.blitProgram, "alpha");
    gl.useProgram(this.blitProgram);
    gl.uniform1i(gl.getUniformLocation(this.blitProgram, "source"), 0);

    this.pathBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.pathArray = gl.createVertexArray();
    gl.bindVertexArray(this.pathArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    this.quadArray = gl.createVertexArray();
    gl.bindVertexArray(this.quadArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.resolved = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolved);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0,
    );

    const samples = Math.min(
      SAMPLES,
      gl.getParameter(gl.MAX_SAMPLES) as number,
    );
    this.target = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    for (const [format, attachment] of [
      [gl.RGBA8, gl.COLOR_ATTACHMENT0],
      [gl.STENCIL_INDEX8, gl.STENCIL_ATTACHMENT],
    ] as const) {
      const buffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        samples,
        format,
        size,
        size,
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        attachment,
        gl.RENDERBUFFER,
        buffer,
      );
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("shade framebuffer incomplete");
    }
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.viewport(0, 0, size, size);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  // One polygon set unioned by its nonzero winding and painted once: the fans go into the stencil with
  // wrapping increments, then a full-screen triangle paints wherever the count came out non-zero and
  // zeroes it again on the way past.
  private stencilCover(
    geometry: Geometry,
    tint: [number, number, number, number],
  ): void {
    const { gl } = this;
    if (geometry.indicesAt === 0) {
      return;
    }
    gl.bindVertexArray(this.pathArray);
    // The element buffer comes back with the array object, but the ARRAY_BUFFER binding point is not
    // its state: without this the upload would land in whichever buffer was bound last.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      geometry.points,
      gl.STREAM_DRAW,
      0,
      geometry.pointsAt,
    );
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      geometry.indices,
      gl.STREAM_DRAW,
      0,
      geometry.indicesAt,
    );

    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
    gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
    gl.useProgram(this.pathProgram);
    gl.drawElements(gl.TRIANGLE_FAN, geometry.indicesAt, gl.UNSIGNED_INT, 0);

    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
    gl.useProgram(this.coverProgram);
    gl.uniform4f(this.tint, tint[0], tint[1], tint[2], tint[3]);
    gl.bindVertexArray(this.quadArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.STENCIL_TEST);
  }

  // The bases punched out of whatever is on the target: shade on a roof is not ground shade.
  private punch(): void {
    this.gl.blendFunc(this.gl.ZERO, this.gl.ONE_MINUS_SRC_ALPHA);
    this.stencilCover(this.bases, [0, 0, 0, 1]);
  }

  // One tile onto the shared canvas, at the pyramid's own scale. Each sun sample's shadows are unioned
  // by one stencil-then-cover and the samples accumulate at 1/n opacity, so the layer's alpha IS the
  // shaded fraction; the crowns then compose over that at the canopy's tau. False when nothing reached
  // the tile, which leaves it as untouched as the Canvas2D sweep leaves it.
  draw(ground: SweptGround, coords: TileCoords, { tau }: ShadeParams): boolean {
    const { gl } = this;
    const { chunks, decks, samples, maxShadowMeters } = ground;
    const frame = frameFor(coords);
    const devicePixel = TILE_SIZE / this.size;
    const [red, green, blue] = SLATE;

    this.crowns.reset();
    // Trunks ride with the crowns; see the note in src/tiles/sweep.ts.
    const crowns =
      castCrowns(this.crowns, chunks, samples[0], maxShadowMeters, frame) +
      castTrunks(
        this.crowns,
        chunks,
        samples[0],
        maxShadowMeters,
        frame,
        devicePixel,
      );
    this.sheds.reset();
    const sheds = castSheds(
      this.sheds,
      decks,
      samples[0],
      maxShadowMeters,
      frame,
      devicePixel,
    );
    this.bases.reset();
    castBases(this.bases, chunks, frame);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    if (crowns > 0) {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      gl.blendFunc(gl.ONE, gl.ZERO);
      this.stencilCover(this.crowns, [red, green, blue, 1]);
      this.punch();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.target);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolved);
      this.resolve();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    }

    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE); // the "lighter" the samples accumulate under
    const share = 1 / samples.length;
    let drawn = 0;
    for (const sample of samples) {
      this.shadows.reset();
      drawn += castBuildings(
        this.shadows,
        chunks,
        sample,
        maxShadowMeters,
        frame,
      );
      this.stencilCover(this.shadows, [
        red * share,
        green * share,
        blue * share,
        share,
      ]);
    }
    if (drawn === 0 && crowns === 0 && sheds === 0) {
      return false;
    }
    // The decks compose over the samples rather than accumulating with them; the note in
    // src/tiles/sweep.ts says why.
    if (sheds > 0) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.stencilCover(this.sheds, [red, green, blue, 1]);
    }
    this.punch();

    if (crowns > 0) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.blitProgram);
      gl.uniform1f(this.alpha, tau);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.bindVertexArray(this.quadArray);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.target);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    this.resolve();
    return true;
  }

  // Hands the context back rather than waiting for the GC to notice it: a browser caps a document at
  // around 16, and a display change that rebuilds at a new size would otherwise strand this one.
  dispose(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  private resolve(): void {
    const { gl, size } = this;
    gl.blitFramebuffer(
      0,
      0,
      size,
      size,
      0,
      0,
      size,
      size,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
  }
}

let sweeper: Sweeper | null = null;
// Losses and outright failures left before the layer stays on Canvas2D for good: a GPU reset is worth
// rebuilding through, a driver that cannot hold a context is not worth retrying every tile. Resizing
// for a new device ratio is not one of these.
let attempts = REBUILDS;

// The shared sweeper at this tile size, rebuilt when the device ratio changes under it or the context
// was lost. Null once WebGL2 has been counted out.
function sweeperFor(size: number): Sweeper | null {
  if (sweeper?.lost) {
    sweeper = null;
    attempts -= 1;
  }
  if (sweeper?.size === size) {
    return sweeper;
  }
  if (attempts <= 0) {
    return null;
  }
  try {
    sweeper?.dispose();
    sweeper = new Sweeper(size);
  } catch {
    sweeper = null;
    attempts = 0;
  }
  return sweeper;
}

// One tile swept on the GPU and composed onto its canvas. False where the GPU could not do it and the
// Canvas2D sweep has to: no WebGL2, or a context that went away mid-tile.
export function drawSweepGl(
  context: OffscreenCanvasRenderingContext2D,
  ground: SweptGround,
  coords: TileCoords,
  params: ShadeParams,
  ratio: number,
): boolean {
  const swept = sweeperFor(Math.round(TILE_SIZE * ratio));
  if (!swept) {
    return false;
  }
  const painted = swept.draw(ground, coords, params);
  if (swept.lost) {
    return false;
  }
  if (painted) {
    context.globalAlpha = (MAX_SHADE_ALPHA * ground.intensity) / 255;
    context.drawImage(swept.canvas, 0, 0, TILE_SIZE, TILE_SIZE);
    context.globalAlpha = 1;
  }
  return true;
}
