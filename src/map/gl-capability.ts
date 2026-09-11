/**
 * Renderer capability probe and GPU-loss watch (DR-035a, DR-025a).
 *
 * MapLibre 6 requires WebGL 2 and has no WebGL 1 fallback, so "can this
 * browser render the map at all" became a real, answerable question at boot
 * instead of an assumption. This module answers it once, in one place, so
 * the boot path (`src/main.ts`) and the 3D entry gate (`src/map/fire3d.ts`)
 * agree about what the device can do.
 *
 * FOUNDATION NOTE. The owner's DR-025 expansion makes 3D terrain a MAP-WIDE
 * capability across all four hazard views, not a fire-only feature. This
 * probe is the intended foundation for that tier. Nothing here builds
 * map-wide terrain, and nothing here should grow a terrain dependency: it
 * reports what the device can do and says nothing about what is drawn.
 *
 * Deliberately free of any value import from `maplibre-gl`: the pure probe
 * and the error classifier are exercised by a Node spec
 * (`tests/gl-capability.spec.ts`), and pulling the renderer into a Node
 * process to answer a boolean would be a heavier contract than the answer.
 */

import type * as maplibregl from 'maplibre-gl';

/** What the probe observed. `reason` is present only when `webgl2` is false. */
export interface WebGl2Capability {
  readonly webgl2: boolean;
  /** Honest, short, observation-only; never a guess at the cause. */
  readonly reason?: string;
}

/**
 * Create a throwaway WebGL 2 context for the probe, then release it.
 *
 * Browsers cap the number of live WebGL contexts per document (16 is the
 * common ceiling), and the map is about to ask for one, so the probe hands
 * its context straight back through `WEBGL_lose_context`. A lost context is
 * still a non-null return, which is all the probe reads.
 */
function createProbeContext(): WebGL2RenderingContext | null {
  if (
    typeof document === 'undefined' ||
    typeof document.createElement !== 'function'
  ) {
    return null;
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2');
  context?.getExtension('WEBGL_lose_context')?.loseContext();
  return context;
}

/**
 * Report whether this browser can give MapLibre the WebGL 2 context it
 * needs. Pure with respect to its injected factory: pass `create` to test
 * the decision in Node without a canvas.
 *
 * A throw from the factory counts as "no context" rather than propagating,
 * because a boot must not fail on the question of whether it can boot.
 */
export function probeWebGl2(
  create: () => WebGL2RenderingContext | null = createProbeContext
): WebGl2Capability {
  let context: WebGL2RenderingContext | null;
  try {
    context = create();
  } catch (err) {
    return {
      webgl2: false,
      reason:
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'The WebGL 2 probe threw.'
    };
  }
  if (!context) {
    return { webgl2: false, reason: 'No WebGL 2 context was returned.' };
  }
  return { webgl2: true };
}

/**
 * The device's answer, measured once per page and shared.
 *
 * The boot path, the 3D entry gate, and the 3D control each need the same
 * boolean, and each used to run its own probe, which allocates a real GL
 * context every time. The answer cannot change for a page (actual context
 * LOSS is a separate, watched event, not a change of capability), so one
 * measurement serves all readers. The injectable `probeWebGl2` above stays
 * pure for the Node spec; this is the runtime door in front of it.
 */
let measured: WebGl2Capability | null = null;
export function webGl2Capability(): WebGl2Capability {
  measured ??= probeWebGl2();
  return measured;
}

/**
 * What kind of renderer draws the map, as far as the browser will say.
 *
 * `unknown` is the honest answer whenever the browser withholds or masks
 * the renderer string; it is never promoted to `hardware`. The only reader
 * today is the wildfire pulse's paint cadence (decision A, owner
 * 2026-09-11, docs/design/fire3d-entry.md), which slows further on a known
 * software renderer. Session-local: the class is kept in memory for this
 * page, never transmitted, and never shown to the user.
 */
export type RendererClass = 'software' | 'hardware' | 'unknown';

/**
 * Renderer strings that name a CPU rasteriser: Chromium's SwiftShader (the
 * renderer the headless browser suite runs on), Mesa's llvmpipe, Windows'
 * Microsoft Basic Render Driver, and anything that calls itself software.
 */
const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|microsoft basic render driver|software/i;

/**
 * Placeholder strings browsers return instead of the real renderer: the
 * generic `RENDERER` answers of WebKit, Chromium and older Firefox, and
 * Firefox's privacy fallback.
 */
const MASKED_RENDERER_PATTERN = /^(?:webkit webgl|mozilla|generic renderer)$/i;

/**
 * Classify a WebGL renderer string. Pure, for the Node spec.
 *
 * Null, empty and masked strings are `unknown`, never `hardware`: a browser
 * that declined to say is not a browser that said it has a GPU.
 */
export function classifyRendererString(
  renderer: string | null | undefined
): RendererClass {
  if (typeof renderer !== 'string') return 'unknown';
  const trimmed = renderer.trim();
  if (trimmed.length === 0 || MASKED_RENDERER_PATTERN.test(trimmed)) {
    return 'unknown';
  }
  return SOFTWARE_RENDERER_PATTERN.test(trimmed) ? 'software' : 'hardware';
}

/**
 * The map's OWN WebGL context, or null. Read from the painter MapLibre
 * already holds (`Map.painter.context.gl`, declared in maplibre-gl.d.ts);
 * never through `canvas.getContext`, which on a canvas without a context
 * would create one. Never throws: a map double, a map torn down, or a
 * renamed internal all read as null.
 */
function existingMapContext(map: maplibregl.Map): WebGL2RenderingContext | null {
  try {
    const loose = map as unknown as {
      painter?: { context?: { gl?: unknown } } | null;
    };
    const gl = loose.painter?.context?.gl;
    if (
      gl === null ||
      typeof gl !== 'object' ||
      typeof (gl as WebGL2RenderingContext).getParameter !== 'function' ||
      typeof (gl as WebGL2RenderingContext).getExtension !== 'function'
    ) {
      return null;
    }
    return gl as WebGL2RenderingContext;
  } catch {
    return null;
  }
}

/**
 * The renderer string from an existing context, or null. The standard
 * `RENDERER` parameter is asked first, because Firefox answers it with the
 * real (sanitised) renderer and logs a deprecation warning for the debug
 * extension; only when that answer is masked is `WEBGL_debug_renderer_info`
 * asked for `UNMASKED_RENDERER_WEBGL` (Chromium and WebKit mask `RENDERER`
 * as "WebKit WebGL"). Never throws.
 */
export function readRendererString(gl: WebGL2RenderingContext): string | null {
  try {
    const standard: unknown = gl.getParameter(gl.RENDERER);
    if (
      typeof standard === 'string' &&
      classifyRendererString(standard) !== 'unknown'
    ) {
      return standard;
    }
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    if (!extension) return typeof standard === 'string' ? standard : null;
    const unmasked: unknown = gl.getParameter(
      extension.UNMASKED_RENDERER_WEBGL
    );
    return typeof unmasked === 'string' ? unmasked : null;
  } catch {
    return null;
  }
}

/** One answer per map, measured once; the renderer cannot change for a page. */
const rendererClassByMap = new WeakMap<object, RendererClass>();

/**
 * The renderer class of the context this map draws with, read once and
 * memoised per map. Before the map has a context (or for a map double)
 * the answer is `unknown` and is NOT memoised, so an early reader cannot
 * pin `unknown` for the rest of the session. Creates no context and never
 * throws.
 */
export function mapRendererClass(map: maplibregl.Map): RendererClass {
  const memo = rendererClassByMap.get(map);
  if (memo !== undefined) return memo;
  const gl = existingMapContext(map);
  if (!gl) return 'unknown';
  const answer = classifyRendererString(readRendererString(gl));
  rendererClassByMap.set(map, answer);
  return answer;
}

/**
 * True when `err` is MapLibre 6's `GPUInitializationError`.
 *
 * MapLibre fires this through the map's `error` event (it does not throw
 * from the constructor): `Map._setupPainter` requests a `webgl2` context
 * and, on null, fires an `ErrorEvent` carrying a `GPUInitializationError`
 * (`node_modules/maplibre-gl/dist/maplibre-gl.mjs`, `_setupPainter`; the
 * class is declared at `maplibre-gl.d.ts` "src/util/gpu_initialization_error").
 *
 * Identified by `name` and shape rather than `instanceof`, both because the
 * v6 migration guide asks consumers to stop branching on identity across the
 * event surface and because `name` is assigned as a string literal in the
 * class body, so it survives minification while the class binding does not.
 */
export function isGpuInitializationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'GPUInitializationError') return true;
  return 'requestedAttributes' in err && 'statusMessage' in err;
}

/**
 * Watch the map canvas for GPU context loss and restoration.
 *
 * `webglcontextlost` is the honest exit signal for anything that put the
 * camera in a state the user cannot leave (the 3D scene above all): the
 * viewport freezes at whatever the last frame was, and without this the
 * interface keeps claiming a live view of nothing. Returns a disposer;
 * returns a no-op disposer when the map has no canvas (a test double).
 */
export function watchContextLoss(
  map: maplibregl.Map,
  onLost: () => void,
  onRestored?: () => void
): () => void {
  const canvas =
    typeof map.getCanvas === 'function' ? map.getCanvas() : null;
  if (!canvas || typeof canvas.addEventListener !== 'function') {
    return () => {
      /* nothing was attached */
    };
  }
  const lost = (): void => {
    onLost();
  };
  const restored = (): void => {
    onRestored?.();
  };
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}
