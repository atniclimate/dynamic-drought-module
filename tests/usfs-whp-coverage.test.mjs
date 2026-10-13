import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit finding 15: the WHP raster covers the conterminous United States only,
 * and the service answers a transparent 200 tile everywhere else, so a reader
 * framed on Alaska, Hawaii or Canada read "ready" over a blank map. Drives the
 * REAL layer module with a fake map: no browser, no network.
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

const STUBS = {
  '/ui/time-bar': 'export function setTimeBar() {} export function clearTimeBar() {}',
  '/layers/whp-image-shade-protocol': 'export function registerWhpImageShadeProtocol() {}'
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(STUBS).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) {
      return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
    }
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { registry } = await import('../src/state/registry.ts');
const whp = await import('../src/layers/usfs-whp.ts');

class FakeMap {
  center = { lng: -120.5, lat: 44 };
  sources = new Map();
  layers = new Map();
  listeners = new Map();
  getCenter() {
    return this.center;
  }
  getTerrain() {
    return null;
  }
  getSource(id) {
    return this.sources.get(id);
  }
  addSource(id, spec) {
    this.sources.set(id, { ...spec });
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
  emit(event, payload = {}) {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(payload);
  }
  /** One transparent 200 tile, then the map settling. */
  loadEmptyTile() {
    const tile = { tileID: { key: 't1' } };
    this.emit('sourcedataloading', { sourceId: 'usfs-whp', dataType: 'source', tile });
    this.emit('sourcedata', { sourceId: 'usfs-whp', dataType: 'source', tile });
    this.emit('idle');
  }
  moveTo(lng, lat) {
    this.center = { lng, lat };
    this.emit('moveend');
  }
}

async function withMap(body) {
  const map = new FakeMap();
  registry.deactivate('usfs-whp');
  registry.setStatus('usfs-whp', 'loading');
  try {
    await whp.activate(map);
    await body(map);
  } finally {
    whp.deactivate(map);
    registry.deactivate('usfs-whp');
  }
}

test('a view centred in the contiguous United States still reads ready', async () => {
  await withMap((map) => {
    map.loadEmptyTile();
    assert.equal(registry.getStatus('usfs-whp'), 'ready');
  });
});

test('a view centred on Alaska reads no-data over its empty tiles, and ready again on return', async () => {
  await withMap((map) => {
    map.moveTo(-150, 64);
    map.loadEmptyTile();
    assert.equal(registry.getStatus('usfs-whp'), 'no-data');
    map.moveTo(-120.5, 44);
    assert.equal(registry.getStatus('usfs-whp'), 'ready');
    map.moveTo(-157.8, 21.3);
    assert.equal(registry.getStatus('usfs-whp'), 'no-data');
  });
});

test('deactivate drops the move listener', async () => {
  const map = new FakeMap();
  await whp.activate(map);
  whp.deactivate(map);
  registry.deactivate('usfs-whp');
  const left = [...map.listeners.values()].reduce((n, set) => n + set.size, 0);
  assert.equal(left, 0);
});
