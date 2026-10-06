import assert from 'node:assert/strict';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * found-131 (B6-HILLSHADE-LAYERSET, the found-117 shape): `activate(map,
 * activation?)` linked no controller signal, so the archive read was aborted
 * only by `deactivate`, at the queued teardown behind the 10 s probe budget,
 * and not at the moment the layer controller recorded off intent. The
 * controller-owned attempt signal now joins the private controller for the
 * length of the read and is unlinked in a `finally` (plan rule 5, the same
 * link as heatrisk, hms-smoke, aiannh).
 *
 * Runs under plain `node --test` (Node 24 strips types), with the same
 * resolve hook as tests/hillshade-reactivation.test.mjs.
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

/**
 * A fetch whose archive read hangs until its own signal aborts, recording the
 * signals it was handed; or, with `hang: false`, answers the committed header.
 */
function installFetch({ hang }) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (!url.endsWith('hillshade-dem-pnw.pmtiles')) {
      return Promise.reject(new Error(`unexpected egress from a node test: ${url}`));
    }
    const signal = init?.signal;
    seen.push(signal);
    if (!hang) return Promise.resolve(hillshadeHeaderResponse());
    return new Promise((_resolve, reject) => {
      const fail = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
  };
  return {
    seen,
    restore() {
      globalThis.fetch = original;
    }
  };
}

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

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const { registry } = await import('../src/state/registry.ts');
const mod = await import('../src/layers/hillshade.ts');

test('an off intent aborts the hillshade archive read before any deactivate', async () => {
  const fetchStub = installFetch({ hang: true });
  const map = new FakeMap();
  registry.deactivate('hillshade');
  const attempt = new AbortController();
  try {
    const pending = mod.activate(map, { signal: attempt.signal, generation: 1 });
    await settle();
    assert.equal(fetchStub.seen.length, 1, 'setup: the archive probe did not start');
    assert.equal(fetchStub.seen[0].aborted, false, 'setup: the read was aborted before the off intent');

    // The controller's off intent: abort the attempt signal. Nothing calls
    // `deactivate` (that is the queued teardown behind the probe budget).
    attempt.abort();
    await settle();

    assert.equal(
      fetchStub.seen[0].aborted,
      true,
      'the archive read was still held after the controller aborted the attempt signal'
    );
    await pending;
    assert.equal(map.getSource('hillshade-dem'), undefined, 'an aborted activation added the source');
    assert.notEqual(
      registry.getStatus('hillshade'),
      'error',
      'an aborted activation reported error instead of standing down'
    );
  } finally {
    mod.deactivate(map);
    registry.deactivate('hillshade');
    fetchStub.restore();
  }
});

test('a hillshade activation that began after its attempt was aborted starts no archive read', async () => {
  const fetchStub = installFetch({ hang: true });
  const map = new FakeMap();
  registry.deactivate('hillshade');
  const attempt = new AbortController();
  attempt.abort();
  try {
    await mod.activate(map, { signal: attempt.signal, generation: 2 });
    await settle();
    assert.equal(map.getSource('hillshade-dem'), undefined, 'an already-aborted activation added the source');
    assert.equal(
      fetchStub.seen.length,
      0,
      'an already-aborted activation still started an archive read'
    );
  } finally {
    mod.deactivate(map);
    registry.deactivate('hillshade');
    fetchStub.restore();
  }
});

test('the attempt signal link is released when the activation settles', async () => {
  const fetchStub = installFetch({ hang: false });
  const map = new FakeMap();
  registry.deactivate('hillshade');
  const attempt = new AbortController();
  let added = 0;
  let removed = 0;
  const addOriginal = attempt.signal.addEventListener.bind(attempt.signal);
  const removeOriginal = attempt.signal.removeEventListener.bind(attempt.signal);
  attempt.signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') added += 1;
    return addOriginal(type, listener, options);
  };
  attempt.signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') removed += 1;
    return removeOriginal(type, listener, options);
  };
  try {
    await mod.activate(map, { signal: attempt.signal, generation: 3 });
    await settle();
    assert.equal(registry.getStatus('hillshade'), 'ready', 'setup: the activation did not reach ready');
    assert.ok(added >= 1, 'setup: the attempt signal was never linked');
    assert.equal(removed, added, 'the attempt signal link outlived the activation');
  } finally {
    mod.deactivate(map);
    registry.deactivate('hillshade');
    fetchStub.restore();
  }
});
