/**
 * A GPU initialization failure that arrives before the boot bound keeps its
 * notice and its disabled controls once the bound expires (src/main.ts boot,
 * DR-035a). The style can finish loading with no painter, so "style loaded"
 * alone must not wire the map-dependent chrome, which hides the notice.
 * Runs the actual tail of `boot` with stand-ins for its collaborators.
 *
 * It registers no Playwright tests: it runs under `node --test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tail = main.match(
  /  let gpuInitializationFailed = false;[\s\S]*?\n  map\.once\('load', \(\) => \{\n    wireMapDependentChrome\(map\);\n  \}\);/
)?.[0];

async function runBootTail({ gpuErrorBeforeBound }) {
  assert.ok(tail, 'run the actual boot tail from src/main.ts');
  const calls = [];
  const gpuError = new Error('GPUInitializationError');
  let onError = null;
  const bindings = {
    map: {
      on: (type, handler) => {
        if (type === 'error') onError = handler;
      },
      once: () => {},
      isStyleLoaded: () => true
    },
    MAP_LOAD_BOUND_MS: 8000,
    waitForMapLoad: async () => {
      if (gpuErrorBeforeBound) onError({ error: gpuError });
      return false;
    },
    isGpuInitializationError: (err) => err === gpuError,
    failWithoutRenderer: () => calls.push('fail'),
    showRendererNotice: (kind) => calls.push(`notice:${kind}`),
    hideRendererNotice: () => calls.push('hide'),
    bootMapFreeChrome: () => calls.push('chrome'),
    wireMapDependentChrome: () => calls.push('wire'),
    setSidebarControlReason: (reason) => calls.push(`reason:${reason}`)
  };
  const run = Function(
    ...Object.keys(bindings),
    `return ${stripTypeScriptTypes(`(async () => {\n${tail}\n})()`)};`
  );
  await run(...Object.values(bindings));
  return calls;
}

test('a GPU failure before the bound keeps its notice and disabled controls', async () => {
  const calls = await runBootTail({ gpuErrorBeforeBound: true });
  assert.deepEqual(calls, ['fail', 'notice:no-webgl2', 'chrome', 'reason:no-map']);
});

test('a stalled paint with the style in hand still wires the full interface', async () => {
  const calls = await runBootTail({ gpuErrorBeforeBound: false });
  assert.deepEqual(calls, ['notice:not-rendering', 'chrome', 'wire']);
});
