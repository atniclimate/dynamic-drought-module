import { expect, test } from '@playwright/test';

import {
  classifyRendererString,
  isGpuInitializationError,
  mapRendererClass,
  probeWebGl2,
  readRendererString,
  type WebGl2Capability
} from '../src/map/gl-capability';
import { shouldFire3DBeActive } from '../src/map/fire3d';
import { FIRE3D_MIN_HEIGHT_PX } from '../src/config/fire3d-presentation';

/**
 * Pure cases for the renderer capability probe (DR-035a) and the extended
 * 3D entry gate (DR-025a). No `page`: every decision under test is a
 * function of its inputs, which is the point of injecting the context
 * factory and of passing the probe result and the viewport height into the
 * gate rather than reading them from a global.
 */

// ---------------------------------------------------------------------------
// probeWebGl2
// ---------------------------------------------------------------------------

/** A stand-in context: the probe reads only whether one came back. */
const fakeContext = (): WebGL2RenderingContext =>
  ({}) as WebGL2RenderingContext;

test('the probe reports capable, with no reason, when a context comes back', () => {
  const result: WebGl2Capability = probeWebGl2(() => fakeContext());
  expect(result.webgl2).toBe(true);
  // A capability report carries a reason only when it is reporting a
  // failure; an unexplained "reason" beside a success would be noise the
  // interface could quote.
  expect(result.reason).toBeUndefined();
});

test('the probe reports not capable, with a reason, when no context comes back', () => {
  const result = probeWebGl2(() => null);
  expect(result.webgl2).toBe(false);
  expect(result.reason).toBe('No WebGL 2 context was returned.');
});

test('a throwing context factory is a not-capable report, not a boot failure', () => {
  const result = probeWebGl2(() => {
    throw new Error('canvas is disabled by policy');
  });
  expect(result.webgl2).toBe(false);
  expect(result.reason).toBe('canvas is disabled by policy');
});

test('a thrown non-Error still yields a capability report', () => {
  const result = probeWebGl2(() => {
    throw 'no canvas';
  });
  expect(result.webgl2).toBe(false);
  expect(result.reason).toBe('The WebGL 2 probe threw.');
});

// ---------------------------------------------------------------------------
// The renderer class (decision A, owner 2026-09-11)
// ---------------------------------------------------------------------------

test('software renderer strings classify as software', () => {
  // The strings the three named CPU rasterisers actually report.
  for (const renderer of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Software Adapter'
  ]) {
    expect(classifyRendererString(renderer), renderer).toBe('software');
  }
});

test('a hardware renderer string classifies as hardware', () => {
  expect(
    classifyRendererString(
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x0000A7A0) Direct3D11 vs_5_0 ps_5_0, D3D11)'
    )
  ).toBe('hardware');
  expect(classifyRendererString('Apple M2')).toBe('hardware');
});

test('a withheld, empty or masked renderer string is unknown, never hardware', () => {
  expect(classifyRendererString(null)).toBe('unknown');
  expect(classifyRendererString(undefined)).toBe('unknown');
  expect(classifyRendererString('')).toBe('unknown');
  expect(classifyRendererString('   ')).toBe('unknown');
  expect(classifyRendererString('WebKit WebGL')).toBe('unknown');
  expect(classifyRendererString('Mozilla')).toBe('unknown');
});

/** A stand-in GL context that answers only the two renderer questions. */
function fakeRendererGl(options: {
  readonly standard: string;
  readonly unmasked: string | null;
}): { readonly gl: WebGL2RenderingContext; readonly calls: string[] } {
  const calls: string[] = [];
  const RENDERER = 0x1f01;
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const gl = {
    RENDERER,
    getParameter: (name: number) => {
      calls.push(`getParameter:${name.toString(16)}`);
      if (name === RENDERER) return options.standard;
      if (name === UNMASKED_RENDERER_WEBGL) return options.unmasked;
      return null;
    },
    getExtension: (name: string) => {
      calls.push(`getExtension:${name}`);
      return options.unmasked === null ? null : { UNMASKED_RENDERER_WEBGL };
    }
  } as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

test('the renderer string is read from the standard parameter first, then the debug extension when masked', () => {
  // Firefox answers RENDERER with the real renderer: the debug extension,
  // which Firefox deprecates with a console warning, is never asked.
  const firefox = fakeRendererGl({
    standard: 'llvmpipe (LLVM 15.0.7, 256 bits)',
    unmasked: 'llvmpipe (LLVM 15.0.7, 256 bits)'
  });
  expect(readRendererString(firefox.gl)).toBe('llvmpipe (LLVM 15.0.7, 256 bits)');
  expect(firefox.calls).toEqual(['getParameter:1f01']);

  // Chromium masks RENDERER as "WebKit WebGL" and answers the extension.
  const chromium = fakeRendererGl({
    standard: 'WebKit WebGL',
    unmasked: 'Google SwiftShader'
  });
  expect(readRendererString(chromium.gl)).toBe('Google SwiftShader');

  // No extension: the masked string comes back, and it classifies unknown.
  const masked = fakeRendererGl({ standard: 'WebKit WebGL', unmasked: null });
  expect(classifyRendererString(readRendererString(masked.gl))).toBe('unknown');

  // A context that throws is a null answer, not an exception.
  const throwing = {
    RENDERER: 0x1f01,
    getParameter: () => {
      throw new Error('context lost');
    },
    getExtension: () => null
  } as unknown as WebGL2RenderingContext;
  expect(readRendererString(throwing)).toBeNull();
});

test('the map renderer class reads the map\'s own context once and never creates one', () => {
  const swiftshader = fakeRendererGl({
    standard: 'WebKit WebGL',
    unmasked: 'Google SwiftShader'
  });
  let canvasContextRequests = 0;
  const map = {
    painter: { context: { gl: swiftshader.gl } },
    getCanvas: () => ({
      getContext: () => {
        canvasContextRequests += 1;
        return null;
      }
    })
  } as unknown as Parameters<typeof mapRendererClass>[0];

  expect(mapRendererClass(map)).toBe('software');
  const callsAfterFirstRead = swiftshader.calls.length;
  expect(mapRendererClass(map)).toBe('software');
  expect(mapRendererClass(map)).toBe('software');
  // Memoised: the second and third answers asked the context nothing.
  expect(swiftshader.calls).toHaveLength(callsAfterFirstRead);
  expect(canvasContextRequests).toBe(0);

  // A map with no painter yet (or a double) is unknown and is not pinned:
  // once its context exists, the next read measures it.
  const late = { painter: undefined } as {
    painter: { context: { gl: WebGL2RenderingContext } } | undefined;
  };
  const lateMap = late as unknown as Parameters<typeof mapRendererClass>[0];
  expect(mapRendererClass(lateMap)).toBe('unknown');
  late.painter = {
    context: {
      gl: fakeRendererGl({
        standard: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        unmasked: null
      }).gl
    }
  };
  expect(mapRendererClass(lateMap)).toBe('hardware');

  // A painter getter that throws is unknown, not a thrown boot.
  const hostile = Object.defineProperty({}, 'painter', {
    get: () => {
      throw new Error('torn down');
    }
  }) as unknown as Parameters<typeof mapRendererClass>[0];
  expect(mapRendererClass(hostile)).toBe('unknown');
});

// ---------------------------------------------------------------------------
// isGpuInitializationError
// ---------------------------------------------------------------------------

test('MapLibre 6 GPU initialization errors are identified by name and by shape', () => {
  // What MapLibre actually constructs: an Error whose `name` is assigned as
  // a string literal in the class body, so it survives minification.
  const byName = new Error('WebGL2 is required to display this map.');
  byName.name = 'GPUInitializationError';
  expect(isGpuInitializationError(byName)).toBe(true);

  // The same error identified by its two own fields, in case a future
  // bundler or a re-thrown copy loses the name.
  const byShape = Object.assign(new Error('context creation failed'), {
    requestedAttributes: { alpha: true },
    statusMessage: null
  });
  expect(isGpuInitializationError(byShape)).toBe(true);
});

test('routine map errors are not GPU initialization errors', () => {
  // This is the load-bearing negative: tile and source failures travel the
  // same `error` event, and a renderer notice raised on one of those would
  // be a false claim about the browser.
  expect(isGpuInitializationError(new Error('Failed to fetch tile'))).toBe(
    false
  );
  expect(isGpuInitializationError({ name: 'GPUInitializationError' })).toBe(
    false
  );
  expect(isGpuInitializationError(null)).toBe(false);
  expect(isGpuInitializationError('GPUInitializationError')).toBe(false);
});

// ---------------------------------------------------------------------------
// The extended 3D entry gate (DR-025a)
// ---------------------------------------------------------------------------

const gateBase = {
  preference: true,
  desktopViewport: true,
  committedCluster: 'wildfire' as const,
  activeLayerKeys: new Set<string>(['nifc-fires', 'hms-smoke']),
  currentlyActive: false
};

test('a device without WebGL 2 never enters the 3D scene', () => {
  expect(shouldFire3DBeActive({ ...gateBase, webgl2: true })).toBe(true);
  expect(shouldFire3DBeActive({ ...gateBase, webgl2: false })).toBe(false);
  // An active scene exits too: the same gate governs staying in.
  expect(
    shouldFire3DBeActive({ ...gateBase, currentlyActive: true, webgl2: false })
  ).toBe(false);
});

test('the height floor admits tablets and excludes landscape phones', () => {
  // A tablet in the DR-036 band, portrait and landscape: both enter.
  expect(
    shouldFire3DBeActive({ ...gateBase, webgl2: true, viewportHeight: 1024 })
  ).toBe(true);
  expect(
    shouldFire3DBeActive({ ...gateBase, webgl2: true, viewportHeight: 768 })
  ).toBe(true);

  // A landscape phone is wide enough for the width query and far too short
  // for the tilted camera: 844 by 390 and 932 by 430 are both excluded.
  expect(
    shouldFire3DBeActive({ ...gateBase, webgl2: true, viewportHeight: 390 })
  ).toBe(false);
  expect(
    shouldFire3DBeActive({ ...gateBase, webgl2: true, viewportHeight: 430 })
  ).toBe(false);

  // The floor itself is inclusive, and one pixel under it is not.
  expect(
    shouldFire3DBeActive({
      ...gateBase,
      webgl2: true,
      viewportHeight: FIRE3D_MIN_HEIGHT_PX
    })
  ).toBe(true);
  expect(
    shouldFire3DBeActive({
      ...gateBase,
      webgl2: true,
      viewportHeight: FIRE3D_MIN_HEIGHT_PX - 1
    })
  ).toBe(false);
});

test('the floor sits clear of both device classes it separates', () => {
  // The number is a DDM convention, not a device constant, so what is
  // pinned here is the margin on each side rather than the value.
  expect(FIRE3D_MIN_HEIGHT_PX).toBeGreaterThan(440);
  expect(FIRE3D_MIN_HEIGHT_PX).toBeLessThan(768);
});

test('an unmeasured caller is not told the device failed', () => {
  // Both new inputs are optional and permissive when absent: a caller that
  // has not probed or measured gets the pre-DR-025a answer, never a silent
  // exclusion.
  expect(shouldFire3DBeActive(gateBase)).toBe(true);
  expect(shouldFire3DBeActive({ ...gateBase, desktopViewport: false })).toBe(
    false
  );
});
