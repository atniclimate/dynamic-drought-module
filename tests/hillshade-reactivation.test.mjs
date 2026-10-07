import assert from 'node:assert/strict';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * DDM-P14-T04 / review finding C6 (2026-09-26_s30d-c4-session-codex-r1.md):
 * `activate` returned immediately when the hillshade source already existed
 * on the map, without writing a terminal status. A caller that set `loading`
 * before reusing an existing source (the layer controller only skips a
 * re-activation for keys already in its own active set, not for a module
 * whose source is already on the map by some other route) left the pill
 * stuck at `loading` forever. This is the exception's own re-activation
 * guard, alongside the two cases in tests/raster-readiness-contract.test.mjs
 * ("hillshade reports ready on source add..." and "...removes its map error
 * listener"), which this file does not duplicate or edit.
 *
 * Runs under plain `node --test` (Node 24 strips types). The resolve hook
 * mirrors tests/raster-readiness-contract.test.mjs so hillshade.ts's
 * extensionless relative imports resolve to their .ts files.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const HILLSHADE_ARCHIVE = join(ROOT, 'public/data/hillshade-dem-pnw.pmtiles');

/** The committed archive's own 127-byte header, answered as a ranged read. */
function hillshadeHeaderResponse() {
  const fd = openSync(HILLSHADE_ARCHIVE, 'r');
  const head = Buffer.alloc(127);
  try {
    readSync(fd, head, 0, 127, 0);
  } finally {
    closeSync(fd);
  }
  return new Response(new Uint8Array(head), {
    status: 206,
    headers: { 'Content-Range': `bytes 0-126/${statSync(HILLSHADE_ARCHIVE).size}` }
  });
}

function installFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('hillshade-dem-pnw.pmtiles')) return hillshadeHeaderResponse();
    throw new Error(`unexpected egress from a node test: ${url}`);
  };
  return {
    restore() {
      globalThis.fetch = original;
    }
  };
}

/** The narrow fake map surface hillshade.ts touches. */
class FakeMap {
  constructor() {
    this.sources = new Map();
    this.layers = new Map();
    this.listeners = new Map();
  }
  getSource(id) {
    return this.sources.get(id);
  }
  addSource(id, spec) {
    this.sources.set(id, spec);
  }
  removeSource(id) {
    this.sources.delete(id);
  }
  getLayer(id) {
    return this.layers.get(id);
  }
  addLayer(spec) {
    this.layers.set(spec.id, spec);
  }
  removeLayer(id) {
    this.layers.delete(id);
  }
  getStyle() {
    return { layers: [...this.layers.values()] };
  }
  on(event, handler) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
    return this;
  }
  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
    return this;
  }
}

/** Let the probe's awaited fetch and stream work finish. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const { registry } = await import('../src/state/registry.ts');
const mod = await import('../src/layers/hillshade.ts');

test('re-activating hillshade over an existing source reports its terminal status', async () => {
  const fetchStub = installFetch();
  const map = new FakeMap();
  registry.deactivate('hillshade');
  try {
    // First activation: the normal boot path, source absent.
    registry.setStatus('hillshade', 'loading');
    await mod.activate(map);
    await settle();
    assert.ok(map.getSource('hillshade-dem'), 'setup: the first activation did not add the source');
    assert.equal(registry.getStatus('hillshade'), 'ready', 'setup: the first activation did not report ready');

    // Re-activation: the layer controller sets `loading` again and calls
    // activate a second time while the source is still on the map (its own
    // active-key check does not cover this module's source state).
    registry.setStatus('hillshade', 'loading');
    await mod.activate(map);
    await settle();

    assert.notEqual(
      registry.getStatus('hillshade'),
      'loading',
      're-activation over an existing source left the status unwritten'
    );
    assert.equal(
      registry.getStatus('hillshade'),
      'ready',
      're-activation over an existing source did not report its terminal status'
    );
  } finally {
    mod.deactivate(map);
    registry.deactivate('hillshade');
    fetchStub.restore();
  }
});

test('re-activating hillshade with the source present but the layer missing restores the layer', async () => {
  const fetchStub = installFetch();
  const map = new FakeMap();
  registry.deactivate('hillshade');
  try {
    // First activation: the normal boot path, source and layer both absent.
    registry.setStatus('hillshade', 'loading');
    await mod.activate(map);
    await settle();
    assert.ok(map.getSource('hillshade-dem'), 'setup: the first activation did not add the source');
    assert.ok(map.getLayer('hillshade'), 'setup: the first activation did not add the layer');
    assert.equal(map.getLayer('hillshade').paint['hillshade-shadow-color'], '#1E242C');
    assert.equal(map.getLayer('hillshade').paint['hillshade-highlight-color'], '#F4F7FB');
    assert.equal(map.getLayer('hillshade').paint['hillshade-exaggeration'], 0.22);

    // Drop only the layer, the way a style reset or a stray removeLayer
    // call can: the source survives, the layer does not.
    map.removeLayer('hillshade');
    assert.ok(!map.getLayer('hillshade'), 'setup: the layer removal did not take');
    assert.ok(map.getSource('hillshade-dem'), 'setup: the source must still be present for this case');

    registry.setStatus('hillshade', 'loading');
    await mod.activate(map);
    await settle();

    assert.ok(
      map.getLayer('hillshade'),
      're-activation over a source with no layer left the layer missing on the map'
    );
    assert.equal(map.getLayer('hillshade').paint['hillshade-shadow-color'], '#1E242C');
    assert.equal(map.getLayer('hillshade').paint['hillshade-highlight-color'], '#F4F7FB');
    assert.equal(
      registry.getStatus('hillshade'),
      'ready',
      're-activation that restored the layer did not report its terminal status'
    );
  } finally {
    mod.deactivate(map);
    registry.deactivate('hillshade');
    fetchStub.restore();
  }
});
