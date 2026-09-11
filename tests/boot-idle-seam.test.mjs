import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * DDM-P1-T09 step 1: the `window.__ddm` test seam exposes what holds a boot
 * (or any later wait) open, read from the same module state the boot-idle
 * tracker evaluates, so a failure can NAME the pending layer keys and the
 * shared-transport count instead of inferring them from the DOM.
 *
 * Runs under plain `node --test` (Node 24 strips the types): the seam's
 * module graph (registry, checkbox bridge, fetch helpers) has no DOM at
 * module level, so a two-line `window` / `document` stub is the whole
 * environment. The modules are process-wide singletons, so the cases run in
 * order and each one leaves the registry and bridge quiescent behind it.
 *
 * What is proved here, in the acceptance's own words:
 *   - the seam is installed by `markBooting()` on `window.__ddm`, next to
 *     the existing `ready` promise, and each getter returns a fresh value;
 *   - a checked, not-yet-terminal layer is a pending key; an active layer
 *     that is re-loading is a pending key; a terminal status clears it;
 *   - a deliberately held shared request raises the transport count to 1
 *     and holds `whenQuiescent` open; its settlement lowers the count to 0
 *     and releases the wait (a count of 0 and a count of 1 are
 *     distinguishable, which the popup-viewport re-baseline depends on);
 *   - a budget miss rejects with a message that names BOTH the pending
 *     layer keys and the shared-transport count.
 */

globalThis.window = globalThis;
globalThis.document = { documentElement: { dataset: {} } };

// The product modules import each other without extensions (`./registry`),
// which the bundler resolves and Node's type stripping does not. This hook
// appends `.ts` to a relative, extensionless specifier whose parent is a
// `.ts` module and whose `.ts` target exists; nothing else is touched.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const bootIdle = await import('../src/state/boot-idle.ts');
const { registry } = await import('../src/state/registry.ts');
const bridge = await import('../src/ui/island/bridge.ts');
const fetchUtil = await import('../src/util/fetch.ts');

const seamFunctions = ['pendingLayerKeys', 'pendingTransportCount', 'snapshot', 'whenQuiescent'];

test('markBooting installs the seam next to the ready promise', () => {
  bootIdle.markBooting();
  const seam = globalThis.window.__ddm;
  assert.ok(seam, 'window.__ddm is installed by markBooting');
  assert.ok(seam.ready instanceof Promise, 'the ready promise survives on the seam');
  for (const name of seamFunctions) {
    assert.equal(typeof seam[name], 'function', `window.__ddm.${name} is a function`);
  }
  assert.equal(document.documentElement.dataset.ddmBoot, 'booting');
  assert.equal(seam.snapshot().phase, 'booting');
  assert.deepEqual(seam.pendingLayerKeys(), []);
  assert.equal(seam.pendingTransportCount(), 0);
});

test('a checked layer without a terminal status is a pending key, and a terminal status clears it', () => {
  const seam = globalThis.window.__ddm;
  bridge.setChecked('alpha', true);
  assert.deepEqual(seam.pendingLayerKeys(), ['alpha']);
  // The getter hands out a copy: a caller cannot reach the tracker's state.
  seam.pendingLayerKeys().push('smuggled');
  assert.deepEqual(seam.pendingLayerKeys(), ['alpha']);
  registry.setStatus('alpha', 'loading');
  assert.deepEqual(seam.pendingLayerKeys(), ['alpha']);
  registry.setStatus('alpha', 'ready');
  assert.deepEqual(seam.pendingLayerKeys(), []);
  assert.deepEqual(seam.snapshot(), {
    phase: 'booting',
    pendingLayerKeys: [],
    pendingTransportCount: 0
  });
});

test('an active layer that is re-loading is a pending key whether or not it is checked', () => {
  const seam = globalThis.window.__ddm;
  registry.activate('beta');
  registry.setStatus('beta', 'loading');
  assert.deepEqual(seam.pendingLayerKeys(), ['beta']);
  registry.setStatus('beta', 'ready');
  assert.deepEqual(seam.pendingLayerKeys(), []);
  registry.deactivate('beta');
});

test('whenQuiescent resolves on the layer transition that empties the pending set', async () => {
  const seam = globalThis.window.__ddm;
  bridge.setChecked('gamma', true);
  const wait = seam.whenQuiescent(2_000);
  registry.setStatus('gamma', 'loading');
  registry.setStatus('gamma', 'ready');
  const snapshot = await wait;
  assert.deepEqual(snapshot.pendingLayerKeys, []);
  assert.equal(snapshot.pendingTransportCount, 0);
});

test('a budget miss names the pending layer keys and the transport count in its own message', async () => {
  const seam = globalThis.window.__ddm;
  bridge.setChecked('delta', true);
  await assert.rejects(seam.whenQuiescent(30), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'DdmQuiescenceTimeout');
    assert.match(error.message, /30 ms/);
    assert.match(error.message, /pending layer keys = \["delta"\]/);
    assert.match(error.message, /pending shared transports = 0/);
    return true;
  });
  registry.setStatus('delta', 'ready');
});

test('a held shared request keeps the count at 1 and holds quiescence open; its settlement releases both', async () => {
  const seam = globalThis.window.__ddm;
  const originalFetch = globalThis.fetch;
  let releaseFetch;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      releaseFetch = () =>
        resolve(
          new Response('{"held":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
    });
  try {
    const consumer = new AbortController();
    const transport = fetchUtil.fetchSharedJsonWithBudget(
      'seam-held',
      'https://example.invalid/held.json',
      null,
      consumer.signal,
      60_000
    );
    assert.equal(seam.pendingTransportCount(), 1, 'the held request is counted once');
    assert.equal(fetchUtil.pendingSharedTransportCount(), 1);
    await assert.rejects(seam.whenQuiescent(30), (error) => {
      assert.match(error.message, /pending layer keys = \[\]/);
      assert.match(error.message, /pending shared transports = 1/);
      return true;
    });

    const wait = seam.whenQuiescent(2_000);
    releaseFetch();
    assert.deepEqual(await transport, { held: true });
    const snapshot = await wait;
    assert.equal(snapshot.pendingTransportCount, 0, 'success settles the count exactly once');
    assert.equal(seam.pendingTransportCount(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a rejected shared request settles the count too', async () => {
  const seam = globalThis.window.__ddm;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError('network down'));
  try {
    const consumer = new AbortController();
    const transport = fetchUtil.fetchSharedJsonWithBudget(
      'seam-failed',
      'https://example.invalid/failed.json',
      null,
      consumer.signal,
      60_000
    );
    assert.equal(seam.pendingTransportCount(), 1);
    await assert.rejects(transport, /network down/);
    const snapshot = await seam.whenQuiescent(2_000);
    assert.equal(snapshot.pendingTransportCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('whenQuiescent rejects a budget that is not a positive finite number', async () => {
  const seam = globalThis.window.__ddm;
  await assert.rejects(seam.whenQuiescent(0), RangeError);
  await assert.rejects(seam.whenQuiescent(Number.NaN), RangeError);
});
