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

const encoder = new TextEncoder();

/**
 * A fetch stub whose settlement is entirely under the test's control, and
 * which honors the caller's `signal` the way a real `fetch` does: an abort
 * while the promise is still pending rejects it with `AbortError`, which is
 * what lets `invalidateSharedJsonRequest`'s internal `controller.abort()`
 * actually settle a held stub rather than hang forever.
 */
function deferredFetchStub(bodyText) {
  let settled = false;
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const fetchImpl = (_url, init) => {
    if (init?.signal) {
      if (init.signal.aborted) {
        settled = true;
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      init.signal.addEventListener(
        'abort',
        () => {
          if (settled) return;
          settled = true;
          rejectFn(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    }
    return promise;
  };
  const release = () => {
    if (settled) return;
    settled = true;
    resolveFn(
      new Response(bodyText, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  };
  return { fetchImpl, release };
}

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
    pendingTransportCount: 0,
    pendingTransportKeys: {}
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

test('a budget miss names each pending shared transport key with its count', async () => {
  const seam = globalThis.window.__ddm;
  const originalFetch = globalThis.fetch;
  const held = deferredFetchStub('{"keyed":true}');
  globalThis.fetch = held.fetchImpl;
  try {
    const consumer = new AbortController();
    const transport = fetchUtil.fetchSharedJsonWithBudget(
      'seam-keyed',
      'https://example.invalid/keyed.json',
      null,
      consumer.signal,
      60_000
    );
    assert.deepEqual(seam.snapshot().pendingTransportKeys, { 'seam-keyed': 1 });
    assert.deepEqual(fetchUtil.pendingSharedTransportKeys(), { 'seam-keyed': 1 });
    await assert.rejects(seam.whenQuiescent(30), (error) => {
      assert.match(error.message, /seam-keyed\D{0,4}1/);
      return true;
    });
    held.release();
    await transport;
    assert.deepEqual(seam.snapshot().pendingTransportKeys, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a timed-out shared request settles the count exactly once', async () => {
  const seam = globalThis.window.__ddm;
  const originalFetch = globalThis.fetch;
  const held = deferredFetchStub('{"held":true}');
  globalThis.fetch = (url, init) => {
    if (String(url).includes('timeout-target')) {
      const body = new ReadableStream({
        start(controller) {
          // Headers arrive; the body stalls forever (models a server that
          // answered 200 and went silent), so only the budget timer ends it.
          controller.enqueue(encoder.encode('{"partial":'));
        }
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    }
    return held.fetchImpl(url, init);
  };
  try {
    const consumerA = new AbortController();
    const timedOut = fetchUtil.fetchSharedJsonWithBudget(
      'seam-timeout',
      'https://example.invalid/timeout-target.json',
      null,
      consumerA.signal,
      20
    );
    const consumerB = new AbortController();
    const heldTransport = fetchUtil.fetchSharedJsonWithBudget(
      'seam-timeout-held',
      'https://example.invalid/held-target.json',
      null,
      consumerB.signal,
      60_000
    );
    assert.deepEqual(fetchUtil.pendingSharedTransportKeys(), {
      'seam-timeout': 1,
      'seam-timeout-held': 1
    });

    await assert.rejects(timedOut, { name: 'AbortError' });
    assert.equal(seam.pendingTransportCount(), 1, 'the timed-out entry settled exactly once');
    assert.deepEqual(fetchUtil.pendingSharedTransportKeys(), { 'seam-timeout-held': 1 });

    held.release();
    assert.deepEqual(await heldTransport, { held: true });
    assert.equal(seam.pendingTransportCount(), 0);
    assert.deepEqual(fetchUtil.pendingSharedTransportKeys(), {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an invalidated shared request settles once, and its same-key re-request is a separate pending entry with no stale key left behind', async () => {
  const seam = globalThis.window.__ddm;
  const originalFetch = globalThis.fetch;
  const gen1 = deferredFetchStub('{"gen":1}');
  const gen2 = deferredFetchStub('{"gen":2}');
  let call = 0;
  globalThis.fetch = (url, init) => {
    call += 1;
    return (call === 1 ? gen1 : gen2).fetchImpl(url, init);
  };
  try {
    const consumer1 = new AbortController();
    const first = fetchUtil.fetchSharedJsonWithBudget(
      'seam-invalidate',
      'https://example.invalid/invalidate.json',
      null,
      consumer1.signal,
      60_000
    );
    assert.deepEqual(seam.snapshot().pendingTransportKeys, { 'seam-invalidate': 1 });

    fetchUtil.invalidateSharedJsonRequest('seam-invalidate');
    const consumer2 = new AbortController();
    const second = fetchUtil.fetchSharedJsonWithBudget(
      'seam-invalidate',
      'https://example.invalid/invalidate.json',
      null,
      consumer2.signal,
      60_000
    );
    // The invalidated entry has not settled yet (its rejection is async): two
    // in-flight entries for one key is exactly the case a string-keyed map
    // would under-count.
    assert.equal(seam.pendingTransportCount(), 2);
    assert.deepEqual(seam.snapshot().pendingTransportKeys, { 'seam-invalidate': 2 });

    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(seam.pendingTransportCount(), 1, 'the invalidated entry settled exactly once');
    assert.deepEqual(seam.snapshot().pendingTransportKeys, { 'seam-invalidate': 1 });

    gen2.release();
    assert.deepEqual(await second, { gen: 2 });
    assert.equal(seam.pendingTransportCount(), 0);
    assert.deepEqual(seam.snapshot().pendingTransportKeys, {}, 'no stale key remains');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the shared transport key stays pending until the response body completes, not just the headers', async () => {
  const seam = globalThis.window.__ddm;
  const originalFetch = globalThis.fetch;
  let bodyController;
  globalThis.fetch = () => {
    const body = new ReadableStream({
      start(controller) {
        bodyController = controller;
        controller.enqueue(encoder.encode('{"body":'));
      }
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  };
  try {
    const consumer = new AbortController();
    const transport = fetchUtil.fetchSharedJsonWithBudget(
      'seam-body-held',
      'https://example.invalid/body-held.json',
      null,
      consumer.signal,
      60_000
    );
    // Let the mocked fetch's Response resolve and the first chunk get read;
    // a settle keyed on header arrival rather than the body would already
    // have cleared the key by this point.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      seam.pendingTransportCount(),
      1,
      'still pending after headers arrive, before the body completes'
    );
    assert.deepEqual(seam.snapshot().pendingTransportKeys, { 'seam-body-held': 1 });

    bodyController.enqueue(encoder.encode('true}'));
    bodyController.close();
    assert.deepEqual(await transport, { body: true });
    assert.equal(seam.pendingTransportCount(), 0);
    assert.deepEqual(seam.snapshot().pendingTransportKeys, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a sole consumer\'s abort settles its shared key exactly once', async () => {
  const originalFetch = globalThis.fetch;
  const held = deferredFetchStub('{"solo":true}');
  const other = deferredFetchStub('{"other":true}');
  let call = 0;
  globalThis.fetch = (url, init) => {
    call += 1;
    return (call === 1 ? held : other).fetchImpl(url, init);
  };
  try {
    const before = fetchUtil.pendingSharedTransportCount();
    const consumer = new AbortController();
    const transport = fetchUtil.fetchSharedJsonWithBudget(
      'seam-abort-sole',
      'https://example.invalid/abort-sole.json',
      null,
      consumer.signal,
      60_000
    );
    assert.equal(fetchUtil.pendingSharedTransportCount(), before + 1);
    assert.deepEqual(fetchUtil.pendingSharedTransportKeys()['seam-abort-sole'], 1);

    // A second, unrelated held key is pending AT THE SAME TIME as the one
    // about to be aborted, so a settle that decrements a shared count rather
    // than removing its own entry would wrongly clear this one too.
    const otherConsumer = new AbortController();
    const otherTransport = fetchUtil.fetchSharedJsonWithBudget(
      'seam-abort-other',
      'https://example.invalid/abort-other.json',
      null,
      otherConsumer.signal,
      60_000
    );
    assert.equal(fetchUtil.pendingSharedTransportCount(), before + 2);

    consumer.abort();
    await assert.rejects(transport, { name: 'AbortError' });
    // Let any further settle-chain hops (a natural settle racing the abort
    // path) finish before reading the count, so a double settle is caught
    // regardless of which microtask tick it lands on.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      fetchUtil.pendingSharedTransportCount(),
      before + 1,
      'the abort settled only its own key, never a neighbor, exactly once'
    );
    assert.equal(fetchUtil.pendingSharedTransportKeys()['seam-abort-sole'], undefined);
    assert.equal(fetchUtil.pendingSharedTransportKeys()['seam-abort-other'], 1, 'the unrelated key is still pending');

    other.release();
    assert.deepEqual(await otherTransport, { other: true });
    assert.equal(fetchUtil.pendingSharedTransportCount(), before);

    // A later settle of the already-aborted stub (a late response arriving
    // after supersession) must not decrement the count a second time.
    held.release();
    assert.equal(
      fetchUtil.pendingSharedTransportCount(),
      before,
      'a late settle after abort does not double-decrement'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one consumer aborting while another still waits keeps the key pending', async () => {
  const originalFetch = globalThis.fetch;
  const held = deferredFetchStub('{"shared":true}');
  globalThis.fetch = held.fetchImpl;
  try {
    const consumerA = new AbortController();
    const consumerB = new AbortController();
    const transportA = fetchUtil.fetchSharedJsonWithBudget(
      'seam-abort-shared',
      'https://example.invalid/abort-shared.json',
      null,
      consumerA.signal,
      60_000
    );
    const transportB = fetchUtil.fetchSharedJsonWithBudget(
      'seam-abort-shared',
      'https://example.invalid/abort-shared.json',
      null,
      consumerB.signal,
      60_000
    );
    assert.equal(fetchUtil.pendingSharedTransportKeys()['seam-abort-shared'], 1);

    consumerA.abort();
    await assert.rejects(transportA, { name: 'AbortError' });
    assert.equal(
      fetchUtil.pendingSharedTransportKeys()['seam-abort-shared'],
      1,
      'the second consumer still waiting keeps the shared entry pending'
    );

    held.release();
    assert.deepEqual(await transportB, { shared: true });
    assert.equal(fetchUtil.pendingSharedTransportKeys()['seam-abort-shared'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('whenQuiescent rejects a budget that is not a positive finite number', async () => {
  const seam = globalThis.window.__ddm;
  await assert.rejects(seam.whenQuiescent(0), RangeError);
  await assert.rejects(seam.whenQuiescent(Number.NaN), RangeError);
});
