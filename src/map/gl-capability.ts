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
