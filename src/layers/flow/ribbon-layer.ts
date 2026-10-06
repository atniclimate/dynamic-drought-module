/**
 * The moving form (design/moving-paths.md sections 3, 4 and 14; DR-116;
 * block E1 unit E1-3): one WebGL2 MapLibre custom layer, `renderingMode
 * '2d'`, drawing instanced, tapered, cased ribbons for wind and crest marks
 * for waves with one fragment shader. Particle state lives on the CPU
 * (`advect.ts`); each fixed step uploads one ring slot.
 *
 * - Colours are premultiplied: MapLibre draws custom layers with
 *   blendFunc(ONE, ONE_MINUS_SRC_ALPHA).
 * - The layer binds its own vertex array and unbinds it before returning,
 *   so MapLibre's own VAO state is never disturbed.
 * - Positions are uploaded relative to an origin near the view, and the
 *   matrix is translated to that origin in double precision each frame, so
 *   float32 holds at every zoom.
 * - On `webglcontextlost` every GL handle is dropped and the CPU field and
 *   particles are kept; the next render after the restore rebuilds programs,
 *   textures and buffers from that CPU state, with no refetch.
 * - It never calls triggerRepaint: the motion loop owns the clock. While not
 *   running it draws nothing (the still form shows instead).
 *
 * No code is copied from mapbox/webgl-wind or cambecc/earth.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import type { FlowField } from './field';
import {
  type ViewQuad, CrestMarks, FlowClock, MAX_MARKS, PAST_GRID_CELL_PX, Particles, SLOTS, cellPx, markCount,
  paceFor, particleCount, viewCenter, viewQuadFromCorners
} from './advect';
import { FLOW_CASING_ALPHA, FLOW_CASING_WIDTH_PX, FLOW_CORE_WIDTH_PX, FLOW_HEAD_ALPHA, FLOW_INK, type FlowInkName, inkRgb } from './ink';

/** Widest ring texture row; WebGL2 guarantees MAX_TEXTURE_SIZE of at least 2048. */
const MAX_RING_WIDTH = 1024;
const ZOOM_RESET = 0.25;

const VERT_COMMON = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_dpr;
uniform vec3 u_core_w;
uniform float u_casing_w;
out float v_across;
out float v_half_core;
out float v_half_all;
out float v_alpha;
flat out int v_cls;
void emit(vec2 a, vec2 b, int cls, float tOld, float tNew, float alpha) {
  int corner = gl_VertexID;
  float along = float(corner & 1);
  float side = (corner >> 1) == 0 ? -1.0 : 1.0;
  vec4 ca = u_matrix * vec4(a, 0.0, 1.0);
  vec4 cb = u_matrix * vec4(b, 0.0, 1.0);
  vec2 hv = 0.5 * u_viewport;
  vec2 sa = ca.xy / ca.w * hv;
  vec2 sb = cb.xy / cb.w * hv;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float t = mix(tOld, tNew, along);
  float core = (cls == 0 ? u_core_w.x : cls == 1 ? u_core_w.y : u_core_w.z) * u_dpr * t;
  float casing = u_casing_w * u_dpr * t;
  float halfAll = 0.5 * core + casing + 1.0;
  vec2 s = mix(sa, sb, along) + n * side * halfAll + dir * (along * 2.0 - 1.0) * 0.5 * core;
  vec4 c = along > 0.5 ? cb : ca;
  gl_Position = vec4(s / hv * c.w, c.z, c.w);
  v_across = side * halfAll;
  v_half_core = 0.5 * core;
  v_half_all = 0.5 * core + casing;
  v_alpha = alpha * t;
  v_cls = cls;
}
`;

// Instance = (particle, segment); segment 0 is the newest. A slot pair joins
// only when both are written and share a generation.
const VERT_RING = `${VERT_COMMON}
uniform highp sampler2D u_ring;
uniform int u_head;
uniform int u_width;
uniform int u_rows;
uniform float u_head_alpha;
const int SLOTS = ${SLOTS};
const int SEGS = ${SLOTS - 1};
vec4 fetchSlot(int p, int slot) { return texelFetch(u_ring, ivec2(p % u_width, slot * u_rows + p / u_width), 0); }
void main() {
  int p = gl_InstanceID / SEGS;
  int k = gl_InstanceID - p * SEGS;
  vec4 a = fetchSlot(p, (u_head - k - 1 + 2 * SLOTS) % SLOTS);
  vec4 b = fetchSlot(p, (u_head - k + 2 * SLOTS) % SLOTS);
  if (a.w < 0.0 || b.w < 0.0 || a.z != b.z) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int cls = int(floor(b.w * 0.5));
  float life = b.w - float(cls) * 2.0;
  float segs = float(SEGS);
  emit(a.xy, b.xy, cls, 1.0 - (float(k) + 1.0) / segs, 1.0 - float(k) / segs, u_head_alpha * life);
}
`;

const VERT_MARKS = `${VERT_COMMON}
uniform float u_head_alpha;
in vec4 a_seg;
in vec2 a_meta;
void main() { emit(a_seg.xy, a_seg.zw, int(a_meta.x), 1.0, 1.0, u_head_alpha * a_meta.y); }
`;

const FRAG = `#version 300 es
precision highp float;
uniform vec3 u_ink0;
uniform vec3 u_ink1;
uniform vec3 u_ink2;
uniform vec3 u_casing;
uniform float u_casing_alpha;
in float v_across;
in float v_half_core;
in float v_half_all;
in float v_alpha;
flat in int v_cls;
out vec4 fragColor;
void main() {
  float d = abs(v_across);
  float cover = clamp(v_half_all + 0.5 - d, 0.0, 1.0);
  float core = clamp(v_half_core + 0.5 - d, 0.0, 1.0);
  vec3 ink = v_cls == 0 ? u_ink0 : v_cls == 1 ? u_ink1 : u_ink2;
  float a = v_alpha * mix(u_casing_alpha, 1.0, core) * cover;
  fragColor = vec4(mix(u_casing, ink, core) * a, a);
}
`;

export const RIBBON_SHADERS = { VERT_RING, VERT_MARKS, FRAG } as const;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('flow ribbon: createProgram failed');
  try {
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('flow ribbon: createShader failed');
      try {
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'flow ribbon: compile failed');
        gl.attachShader(program, shader);
      } finally {
        gl.deleteShader(shader);
      }
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'flow ribbon: link failed');
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  }
}

/** The view of a MapLibre map as a ViewQuad, x unwrapped near `nearX`. */
export function viewQuadOf(map: MlMap, nearX?: number): ViewQuad {
  const el = map.getCanvas();
  const w = el.clientWidth;
  const h = el.clientHeight;
  const corners = ([[0, 0], [w, 0], [w, h], [0, h]] as const).map(([sx, sy]) => {
    const ll = map.unproject([sx, sy]);
    return [ll.lng, ll.lat] as const;
  });
  const center = map.getCenter();
  return viewQuadFromCorners(corners, map.getZoom(), w, h, nearX ?? (center.lng + 180) / 360);
}

/**
 * u_matrix = mainMatrix * translate(ox, oy, 0), in double precision, as
 * float32. `m` is column-major.
 */
export function originMatrix(m: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const out = Float32Array.from(m);
  for (let r = 0; r < 4; r++) {
    out[12 + r] = (m[r] as number) * ox + (m[4 + r] as number) * oy + (m[12 + r] as number);
  }
  return out;
}

export interface RibbonLayerOptions {
  readonly id: string;
  readonly field: FlowField;
  readonly ink?: FlowInkName;
  /** Density factor from planForm (1 = Standard). */
  readonly densityFactor?: number;
  /** Clock in seconds; defaults to performance.now() / 1000. */
  readonly now?: () => number;
  /**
   * Called once if rebuilding the programs after a context restore throws
   * (moving-paths section 14): the layer stops for good and draws nothing,
   * so the caller shows the still form and says why.
   */
  readonly onRebuildFailed?: (error: unknown) => void;
}

export interface RibbonStats {
  steps: number;
  renders: number;
  /** CPU ms of the last advection step (excluding upload). */
  lastStepMs: number;
}

interface GpuState {
  readonly gl: WebGL2RenderingContext;
  readonly ringProgram: WebGLProgram;
  readonly markProgram: WebGLProgram;
  readonly ringVao: WebGLVertexArrayObject;
  readonly markVao: WebGLVertexArrayObject;
  readonly markBuffer: WebGLBuffer;
  ringTexture: WebGLTexture | null;
  ringCapacity: number;
  readonly uniforms: Map<string, WebGLUniformLocation | null>;
}

export class FlowRibbonLayer implements CustomLayerInterface {
  // Fields are `declare`d and set in the constructor, so the es2020 build
  // lowers no class field and bundles no class-field helper (block E2 E2-1;
  // see grib2.ts GribError).
  declare readonly id: string;
  declare readonly type: 'custom';
  declare readonly renderingMode: '2d';
  declare readonly field: FlowField;
  declare readonly particles: Particles | null;
  declare readonly marks: CrestMarks | null;
  declare readonly stats: RibbonStats;
  /** Bumped on each context loss; a rebuild happens once per epoch. */
  declare gpuEpoch: number;
  declare private ink: FlowInkName;
  declare private densityFactor: number;
  declare private readonly now: () => number;
  declare private readonly clock: FlowClock;
  declare private map: MlMap | null;
  declare private gpu: GpuState | null;
  declare private view: ViewQuad | null;
  declare private lastZoom: number;
  declare private running: boolean;
  declare private needsReset: boolean;
  /** Set once a rebuild after a context restore throws; the layer then stays still for good. */
  declare private failed: boolean;
  declare private readonly onRebuildFailed: ((error: unknown) => void) | undefined;
  declare private readonly onLost: () => void;

  constructor(options: RibbonLayerOptions) {
    this.id = options.id;
    this.type = 'custom';
    this.renderingMode = '2d';
    this.field = options.field;
    this.stats = { steps: 0, renders: 0, lastStepMs: 0 };
    this.gpuEpoch = 0;
    this.ink = options.ink ?? 'light';
    this.densityFactor = options.densityFactor ?? 1;
    this.now = options.now ?? ((): number => performance.now() / 1000);
    this.clock = new FlowClock();
    this.map = null;
    this.gpu = null;
    this.view = null;
    this.lastZoom = Number.NaN;
    this.running = false;
    this.needsReset = true;
    this.failed = false;
    this.onRebuildFailed = options.onRebuildFailed;
    this.onLost = (): void => {
      // The context is gone: drop handles without deleting (deletes would fail), keep CPU state.
      this.gpu = null;
      this.gpuEpoch++;
    };
    const pace = paceFor(this.field.kind);
    this.particles = this.field.kind === 'wind' ? new Particles(this.field, pace) : null;
    this.marks = this.field.kind === 'waves' ? new CrestMarks(this.field) : null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** True once a rebuild after a context restore threw: the still form stands instead. */
  get rebuildFailed(): boolean {
    return this.failed;
  }

  /** Start or stop motion. Starting resets ages and the clock, so nothing bursts. */
  setRunning(on: boolean): void {
    if (on && this.failed) return;
    if (on && !this.running) {
      this.needsReset = true;
      this.clock.resume();
    }
    this.running = on;
  }

  setInk(ink: FlowInkName): void {
    this.ink = ink;
  }

  setDensity(densityFactor: number): void {
    this.densityFactor = densityFactor;
    this.needsReset = true;
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    const canvas = map.getCanvas();
    canvas.addEventListener('webglcontextlost', this.onLost);
    try {
      this.build(gl);
    } catch (error) {
      canvas.removeEventListener('webglcontextlost', this.onLost);
      this.map = null;
      throw error;
    }
    this.needsReset = true;
  }

  /**
   * Let go of `map` without MapLibre's onRemove: for a layer MapLibre has
   * already dropped from its style (a lost context destroys the style, and
   * custom layers are not restored) or never finished adding. It removes the
   * canvas listener, so nothing on the map keeps this layer or its field
   * alive, and drops the GL handles without deleting them (the context that
   * owned them is gone or not ours to touch).
   */
  detach(map: MlMap): void {
    map.getCanvas().removeEventListener('webglcontextlost', this.onLost);
    this.running = false;
    this.gpu = null;
    this.map = null;
  }

  onRemove(map: MlMap, gl: WebGL2RenderingContext): void {
    map.getCanvas().removeEventListener('webglcontextlost', this.onLost);
    if (this.gpu && this.gpu.gl === gl && !gl.isContextLost()) {
      const g = this.gpu;
      gl.deleteProgram(g.ringProgram);
      gl.deleteProgram(g.markProgram);
      gl.deleteVertexArray(g.ringVao);
      gl.deleteVertexArray(g.markVao);
      gl.deleteBuffer(g.markBuffer);
      if (g.ringTexture) gl.deleteTexture(g.ringTexture);
    }
    this.gpu = null;
    this.map = null;
  }

  /** Programs, VAOs and buffers from scratch; the ring texture follows the particle capacity. */
  private build(gl: WebGL2RenderingContext): void {
    let ringProgram: WebGLProgram | null = null;
    let markProgram: WebGLProgram | null = null;
    let ringVao: WebGLVertexArrayObject | null = null;
    let markVao: WebGLVertexArrayObject | null = null;
    let markBuffer: WebGLBuffer | null = null;
    try {
      ringProgram = compile(gl, VERT_RING, FRAG);
      markProgram = compile(gl, VERT_MARKS, FRAG);
      ringVao = gl.createVertexArray();
      markVao = gl.createVertexArray();
      markBuffer = gl.createBuffer();
      if (!ringVao || !markVao || !markBuffer) throw new Error('flow ribbon: GL allocation failed');
      gl.bindVertexArray(markVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, markBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, MAX_MARKS * 2 * 6 * 4, gl.DYNAMIC_DRAW);
      const aSeg = gl.getAttribLocation(markProgram, 'a_seg');
      const aMeta = gl.getAttribLocation(markProgram, 'a_meta');
      gl.enableVertexAttribArray(aSeg);
      gl.vertexAttribPointer(aSeg, 4, gl.FLOAT, false, 24, 0);
      gl.vertexAttribDivisor(aSeg, 1);
      gl.enableVertexAttribArray(aMeta);
      gl.vertexAttribPointer(aMeta, 2, gl.FLOAT, false, 24, 16);
      gl.vertexAttribDivisor(aMeta, 1);
      this.gpu = {
        gl, ringProgram, markProgram, ringVao, markVao, markBuffer,
        ringTexture: null, ringCapacity: 0, uniforms: new Map()
      };
      // A rebuilt context starts with an empty texture: send the whole CPU ring.
      if (this.particles) this.particles.ringDirty = true;
      if (this.marks) this.uploadMarks(gl);
    } catch (error) {
      // Until build finishes, these handles are owned here, including when the
      // second program or the initial buffer upload fails.
      this.gpu = null;
      if (!gl.isContextLost()) {
        if (ringProgram) gl.deleteProgram(ringProgram);
        if (markProgram) gl.deleteProgram(markProgram);
        if (ringVao) gl.deleteVertexArray(ringVao);
        if (markVao) gl.deleteVertexArray(markVao);
        if (markBuffer) gl.deleteBuffer(markBuffer);
      }
      throw error;
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  private uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const g = this.gpu as GpuState;
    const key = `${program === g.ringProgram ? 'r' : 'm'}:${name}`;
    if (!g.uniforms.has(key)) g.uniforms.set(key, gl.getUniformLocation(program, name));
    return g.uniforms.get(key) ?? null;
  }

  private ringShape(capacity: number): { width: number; rows: number } {
    const width = Math.min(capacity, MAX_RING_WIDTH);
    return { width, rows: capacity / width };
  }

  private uploadRing(gl: WebGL2RenderingContext, slotOnly: number | null): void {
    const p = this.particles;
    const g = this.gpu;
    if (!p || !g || p.capacity === 0) return;
    const { width, rows } = this.ringShape(p.capacity);
    if (!g.ringTexture || g.ringCapacity !== p.capacity) {
      if (g.ringTexture) gl.deleteTexture(g.ringTexture);
      g.ringTexture = gl.createTexture();
      g.ringCapacity = p.capacity;
      gl.bindTexture(gl.TEXTURE_2D, g.ringTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, rows * SLOTS, 0, gl.RGBA, gl.FLOAT, p.ring);
      p.ringDirty = false;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, g.ringTexture);
    if (p.ringDirty || slotOnly === null) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, rows * SLOTS, gl.RGBA, gl.FLOAT, p.ring);
      p.ringDirty = false;
      return;
    }
    const start = slotOnly * p.capacity * 4;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, slotOnly * rows, width, rows, gl.RGBA, gl.FLOAT,
      p.ring.subarray(start, start + p.capacity * 4));
  }

  private uploadMarks(gl: WebGL2RenderingContext): void {
    const g = this.gpu;
    if (!g || !this.marks) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.markBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.marks.segs, 0, this.marks.segCount * 6);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private resetState(map: MlMap): void {
    this.view = viewQuadOf(map);
    this.lastZoom = map.getZoom();
    if (this.particles) {
      this.particles.setCount(this.view, this.densityFactor);
      this.particles.reset(this.view);
    }
    if (this.marks) {
      this.marks.setCount(this.view, this.densityFactor);
      this.marks.reset(this.view);
    }
    this.needsReset = false;
  }

  /** Fixed steps due by the clock (at most 2 of catch-up); false past the grid. */
  private advance(gl: WebGL2RenderingContext, map: MlMap): boolean {
    if (this.needsReset || Math.abs(map.getZoom() - this.lastZoom) > ZOOM_RESET) this.resetState(map);
    const origin = this.particles ? this.particles.originX : this.marks ? this.marks.originX : undefined;
    const view = viewQuadOf(map, origin);
    this.view = view;
    // Past the grid, node arrows draw instead and nothing advects.
    if (cellPx(this.field, view) > PAST_GRID_CELL_PX) return false;
    if (this.particles && this.particles.count !== particleCount(view, this.densityFactor)) this.particles.setCount(view, this.densityFactor);
    if (this.marks && this.marks.count !== markCount(view, this.densityFactor)) this.marks.setCount(view, this.densityFactor);
    const due = this.clock.due(this.now());
    for (let i = 0; i < due; i++) {
      const t0 = performance.now();
      if (this.particles) {
        this.particles.step(view);
        this.stats.lastStepMs = performance.now() - t0;
        this.uploadRing(gl, this.particles.head);
      } else if (this.marks) {
        this.marks.step(view);
        this.stats.lastStepMs = performance.now() - t0;
        this.uploadMarks(gl);
      }
      this.stats.steps++;
    }
    if (this.particles?.ringDirty) this.uploadRing(gl, null);
    return true;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    this.stats.renders++;
    const map = this.map;
    if (!map || !this.running || this.failed || gl.isContextLost()) return;
    if (!this.gpu || this.gpu.gl !== gl) {
      // Restored context: rebuild from CPU state. A throw here must not
      // escape into MapLibre's render: the layer stops and reports it once.
      try {
        this.build(gl);
      } catch (error) {
        this.failed = true;
        this.running = false;
        this.gpu = null;
        this.onRebuildFailed?.(error);
        return;
      }
    }
    const g = this.gpu as GpuState;
    if (!this.advance(gl, map)) return;
    const ringMode = this.particles !== null;
    const program = ringMode ? g.ringProgram : g.markProgram;
    const [ox, oy] = this.particles
      ? [this.particles.originX, this.particles.originY]
      : this.marks ? [this.marks.originX, this.marks.originY] : viewCenter(this.view as ViewQuad);
    const ink = FLOW_INK[this.ink];
    gl.useProgram(program);
    gl.uniformMatrix4fv(this.uniform(gl, program, 'u_matrix'), false,
      originMatrix(options.defaultProjectionData.mainMatrix as ArrayLike<number>, ox, oy));
    gl.uniform2f(this.uniform(gl, program, 'u_viewport'), gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uniform(gl, program, 'u_dpr'), gl.drawingBufferWidth / (map.getCanvas().clientWidth || 1));
    gl.uniform3f(this.uniform(gl, program, 'u_core_w'), FLOW_CORE_WIDTH_PX[0], FLOW_CORE_WIDTH_PX[1], FLOW_CORE_WIDTH_PX[2]);
    gl.uniform1f(this.uniform(gl, program, 'u_casing_w'), FLOW_CASING_WIDTH_PX);
    gl.uniform1f(this.uniform(gl, program, 'u_casing_alpha'), FLOW_CASING_ALPHA);
    gl.uniform1f(this.uniform(gl, program, 'u_head_alpha'), FLOW_HEAD_ALPHA);
    gl.uniform3fv(this.uniform(gl, program, 'u_ink0'), inkRgb(ink.core[0]));
    gl.uniform3fv(this.uniform(gl, program, 'u_ink1'), inkRgb(ink.core[1]));
    gl.uniform3fv(this.uniform(gl, program, 'u_ink2'), inkRgb(ink.core[2]));
    gl.uniform3fv(this.uniform(gl, program, 'u_casing'), inkRgb(ink.casing));
    if (this.particles) {
      const { width, rows } = this.ringShape(this.particles.capacity);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, g.ringTexture);
      gl.uniform1i(this.uniform(gl, program, 'u_ring'), 0);
      gl.uniform1i(this.uniform(gl, program, 'u_head'), this.particles.head);
      gl.uniform1i(this.uniform(gl, program, 'u_width'), width);
      gl.uniform1i(this.uniform(gl, program, 'u_rows'), rows);
      gl.bindVertexArray(g.ringVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.particles.count * (SLOTS - 1));
    } else if (this.marks) {
      gl.bindVertexArray(g.markVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.marks.segCount);
    }
    gl.bindVertexArray(null);
  }
}
