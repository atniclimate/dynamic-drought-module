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

/**
 * Like `deferredFetchStub`, but `release()` carries no `settled` guard of
 * its own: it always calls the underlying `resolve`, exactly what a
 * network body finishing after the fetch layer's own `AbortController`
 * already rejected the same promise would look like. `deferredFetchStub`'s
 * guard makes a post-abort `release()` a same-file no-op before it ever
 * reaches the executor; this variant lets that call genuinely race the
 * abort so a test can prove safety comes from the Promise settling once,
 * not from stub bookkeeping (Codex round-1 review, finding C14).
 */
function racingFetchStub(bodyText) {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const fetchImpl = (_url, init) => {
    if (init?.signal) {
      if (init.signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      init.signal.addEventListener(
        'abort',
        () => rejectFn(new DOMException('Aborted', 'AbortError')),
        { once: true }
      );
    }
    return promise;
  };
  const release = () =>
    resolveFn(
      new Response(bodyText, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  return { fetchImpl, release };
}

/**
 * Like `racingFetchStub`, but the abort listener does not reject at once:
 * it rejects through a chain of `hops` `setTimeout(..., 0)` macrotasks, the
 * way a real network stack may surface its cancellation a task or more
 * after `abort()` returns (Codex round-3 review, finding C14).
 *
 * One hop is NOT late enough to expose a `setTimeout(resolve, 0)` wait: the
 * listener's timer is queued synchronously inside `abort()`, ahead of the
 * test's own timer, and Node drains the microtask queue (the whole
 * `fetch.ts:321-333` settle chain) between timer callbacks, so the entry is
 * already settled when the test's timer fires. Two hops land exactly one
 * macrotask AFTER the test's timer, which is the smallest delay that makes
 * the old wait read the count before settlement (measured 2026-09-26: one
 * hop read 0, two hops read 1 against an expected 0).
 *
 * `rejectAttempted` resolves right after the stub calls its `reject`, so a
 * test that let `release()` win the race can wait for the losing rejection
 * to have actually been attempted instead of guessing a delay.
 */
function delayedRacingFetchStub(bodyText, hops) {
  let resolveFn;
  let rejectFn;
  let markRejectAttempted;
  const rejectAttempted = new Promise((resolve) => {
    markRejectAttempted = resolve;
  });
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const deferReject = (remaining) => {
    setTimeout(() => {
      if (remaining > 1) {
        deferReject(remaining - 1);
        return;
      }
      rejectFn(new DOMException('Aborted', 'AbortError'));
      markRejectAttempted();
    }, 0);
  };
  const fetchImpl = (_url, init) => {
    if (init?.signal) {
      if (init.signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      init.signal.addEventListener('abort', () => deferReject(hops), { once: true });
    }
    return promise;
  };
  const release = () =>
    resolveFn(
      new Response(bodyText, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  return { fetchImpl, release, rejectAttempted };
}

/**
 * Wait on REAL shared-transport settlement through the module's own
 * `onSharedTransportSettled` callback (fetch.ts:272), which
 * `settleSharedTransport` (fetch.ts:243-246) fires only after it removed an
 * entry, never on a no-op second settle. Subscribe BEFORE the action that
 * settles, so a settlement that lands inside the action's own microtasks is
 * counted rather than missed.
 *
 * `until(predicate, label)` resolves at the first moment `predicate()` holds,
 * checked at call time and after every settlement event; the predicate should
 * require at least one event, so the wait is gated on a settlement that
 * really happened. The timer is a failure bound only (it rejects with the
 * event count), never the thing the wait relies on.
 */
function watchSharedSettlements() {
  let events = 0;
  let wake = null;
  const unsubscribe = fetchUtil.onSharedTransportSettled(() => {
    events += 1;
    wake?.();
  });
  const until = (predicate, label, budgetMs = 2_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wake = null;
        reject(
          new Error(
            `no shared-transport settlement satisfied "${label}" within ${budgetMs} ms (settlement events seen: ${events})`
          )
        );
      }, budgetMs);
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      wake = check;
      check();
    });
  return { events: () => events, until, dispose: unsubscribe };
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

    // Read the count only once the module reports the aborted key's entry
    // settled (not after a guessed macrotask hop, Codex round-3 C14).
    const settlements = watchSharedSettlements();
    try {
      consumer.abort();
      await assert.rejects(transport, { name: 'AbortError' });
      await settlements.until(
        () =>
          settlements.events() >= 1 &&
          fetchUtil.pendingSharedTransportKeys()['seam-abort-sole'] === undefined,
        'seam-abort-sole settled'
      );
      assert.equal(settlements.events(), 1, 'exactly one settlement for the aborted key');
    } finally {
      settlements.dispose();
    }
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

    // `held`'s underlying stub already settled (rejected) when `consumer`
    // aborted above; `deferredFetchStub.release()` guards on its own
    // `settled` flag and returns before ever calling the executor, so this
    // is a same-stub no-op, not a genuine late completion racing the
    // abort (Codex round-1 review, finding C14). It still guards a
    // regression where releasing an already-superseded stub disturbs an
    // unrelated pending count. The next test builds the actual race this
    // comment used to claim.
    held.release();
    assert.equal(
      fetchUtil.pendingSharedTransportCount(),
      before,
      'releasing an already-settled stub is a no-op and leaves the count untouched'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a naive per-listener settle counter double-decrements under a genuine late completion racing abort; the real shared-transport tracker settles exactly once', async () => {
  // First, a local reproduction of the "counter-clamp" shape the shared
  // transport tracker replaced (fetch.ts:243's comment): a naive tracker
  // decrements once from the CONSUMER's own abort listener, and
  // independently decrements again from the underlying fetch promise's
  // own settle reaction. Both listeners are attached to `racingFetchStub`,
  // whose `release()` has no `settled` guard, so a subsequent late
  // completion attempt genuinely reaches the same, already-rejected
  // promise executor rather than being skipped by stub bookkeeping. This
  // proves the racing construction here is capable of exposing a real
  // double-decrement before checking that the real tracker resists it.
  function naiveTracker() {
    let count = 1;
    return {
      onConsumerAbort: () => {
        count -= 1;
      },
      onUnderlyingSettle: () => {
        count -= 1;
      },
      count: () => count
    };
  }

  const naive = naiveTracker();
  const naiveStub = racingFetchStub('{"solo":true}');
  const naiveConsumer = new AbortController();
  const naivePromise = naiveStub
    .fetchImpl('https://example.invalid/naive.json', { signal: naiveConsumer.signal })
    .catch(() => undefined);
  naiveConsumer.signal.addEventListener('abort', naive.onConsumerAbort, { once: true });
  void naivePromise.finally(naive.onUnderlyingSettle);

  naiveConsumer.abort();
  await naivePromise;
  // The late completion: `naiveStub`'s promise already rejected above, so
  // this reaches an already-settled executor, same as the real check
  // below. A naive tracker with no dedup already went to -1 from the two
  // independent listeners on the single abort event; this call proves it
  // does not fall further, because a promise's reactions run only once.
  naiveStub.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    naive.count(),
    -1,
    'the naive per-listener tracker double-decremented for one logical request: the consumer-abort listener and the settled promise both fired'
  );

  // Now the real transport under the identical forced completion order:
  // one sole consumer aborts, then the SAME already-rejected stub promise
  // is genuinely resolved (not skipped by a stub-side guard).
  const originalFetch = globalThis.fetch;
  const realStub = racingFetchStub('{"solo":true}');
  globalThis.fetch = realStub.fetchImpl;
  const settlements = watchSharedSettlements();
  try {
    const before = fetchUtil.pendingSharedTransportCount();
    const consumer = new AbortController();
    const transport = fetchUtil.fetchSharedJsonWithBudget(
      'seam-race-real',
      'https://example.invalid/race-real.json',
      null,
      consumer.signal,
      60_000
    );
    assert.equal(fetchUtil.pendingSharedTransportCount(), before + 1);

    consumer.abort();
    await assert.rejects(transport, { name: 'AbortError' });
    // Gate the read on the module's own settlement callback, not on a
    // guessed `setTimeout(0)` hop (Codex round-3 C14; the next test proves
    // a hop can read the count before settlement).
    await settlements.until(
      () =>
        settlements.events() >= 1 &&
        fetchUtil.pendingSharedTransportKeys()['seam-race-real'] === undefined,
      'seam-race-real settled'
    );
    assert.equal(
      fetchUtil.pendingSharedTransportCount(),
      before,
      'the abort settled the shared entry exactly once'
    );
    assert.equal(settlements.events(), 1, 'one settlement event for one logical request');

    // The genuine late completion: `realStub`'s underlying promise already
    // rejected via the abort listener above; this call still reaches its
    // executor's `resolve` (no `settled` guard), modeling a body that
    // finishes after the network layer's own cancellation. A promise
    // settles at most once, so `next.promise`'s single `.then` in
    // `fetchSharedJsonWithBudget` cannot run a second time for it.
    //
    // Pinned microtask depth, zero: the only route to `settleSharedTransport`
    // is that single `.then(onFulfilled, onRejected)` at fetch.ts:321-333,
    // reached only through the stub promise. That promise is already
    // rejected, so its resolve function returns at once on its
    // [[AlreadyResolved]] flag (ECMA-262 CreateResolvingFunctions) and
    // enqueues NO job. Nothing is pending after `release()` returns, so the
    // synchronous read below IS the settled read; a guessed hop would add no
    // information. The event count proves no second settlement fired.
    realStub.release();
    assert.equal(
      fetchUtil.pendingSharedTransportCount(),
      before,
      'a genuine late completion racing the abort does not double-decrement the real tracker'
    );
    assert.equal(settlements.events(), 1, 'the late completion fired no second settlement');
  } finally {
    settlements.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('a post-abort count read waits on onSharedTransportSettled: a stub whose abort rejection lands one macrotask late fools a setTimeout(0) hop and not the settlement callback', async () => {
  const originalFetch = globalThis.fetch;
  const lateStub = delayedRacingFetchStub('{"late":true}', 2);
  const raceStub = delayedRacingFetchStub('{"race":true}', 2);
  let call = 0;
  globalThis.fetch = (url, init) => {
    call += 1;
    return (call === 1 ? lateStub : raceStub).fetchImpl(url, init);
  };
  try {
    const before = fetchUtil.pendingSharedTransportCount();

    // NEGATIVE CONTROL: the old wait. The consumer's own promise rejects at
    // once on abort (fetch.ts:357-358), but the shared entry settles only
    // when the underlying fetch rejects, here one macrotask after the
    // test's own `setTimeout(0)` hop fires. The hop therefore reads the
    // count BEFORE settlement: the stale reading is asserted, so this line
    // fails the day the stub stops being late enough to prove anything.
    const late = watchSharedSettlements();
    try {
      const consumer = new AbortController();
      const transport = fetchUtil.fetchSharedJsonWithBudget(
        'seam-late-abort',
        'https://example.invalid/late-abort.json',
        null,
        consumer.signal,
        60_000
      );
      consumer.abort();
      await assert.rejects(transport, { name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        fetchUtil.pendingSharedTransportCount(),
        before + 1,
        'negative control: the setTimeout(0) hop reads the count before the late rejection settles the entry'
      );
      assert.equal(late.events(), 0, 'negative control: no settlement has fired yet');

      // The new wait: the module's own settlement callback.
      await late.until(
        () =>
          late.events() >= 1 &&
          fetchUtil.pendingSharedTransportKeys()['seam-late-abort'] === undefined,
        'seam-late-abort settled'
      );
      assert.equal(
        fetchUtil.pendingSharedTransportCount(),
        before,
        'gated on onSharedTransportSettled, the read sees the settled count'
      );
      assert.equal(late.events(), 1, 'exactly one settlement for the late-aborted entry');
    } finally {
      late.dispose();
    }

    // The genuine race the delayed stub makes possible: the body arrives
    // (`release()`) AFTER the abort but BEFORE the stub's late rejection.
    // The resolve wins the stub promise; `fetchJsonWithBudget` then finds
    // its signal aborted in `readBodyBytes` (fetch.ts:91-93) and rejects, so
    // the entry settles once through the rejection branch (fetch.ts:327-333).
    const race = watchSharedSettlements();
    try {
      const consumer = new AbortController();
      const transport = fetchUtil.fetchSharedJsonWithBudget(
        'seam-late-race',
        'https://example.invalid/late-race.json',
        null,
        consumer.signal,
        60_000
      );
      consumer.abort();
      raceStub.release();
      await assert.rejects(transport, { name: 'AbortError' });
      await race.until(
        () =>
          race.events() >= 1 &&
          fetchUtil.pendingSharedTransportKeys()['seam-late-race'] === undefined,
        'seam-late-race settled'
      );
      assert.equal(fetchUtil.pendingSharedTransportCount(), before);

      // Wait for the losing rejection to have really been attempted (the
      // stub's own signal, not a guessed delay). It hit an already-resolved
      // promise, which enqueues no job (the zero-depth pin in the previous
      // test), so the read right after it is the settled read.
      await raceStub.rejectAttempted;
      assert.equal(
        fetchUtil.pendingSharedTransportCount(),
        before,
        'the losing late rejection does not double-decrement'
      );
      assert.equal(race.events(), 1, 'one settlement for one logical request');
    } finally {
      race.dispose();
    }
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
