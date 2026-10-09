import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D P3-STALE (REGISTER found-124): the stale-generation drop, proved
 * against the REAL `createLayerController` (src/state/layer-controller.ts)
 * and the REAL cluster service, with only the peripheral modules replaced.
 *
 * Why this file exists. `tests/cluster-service.spec.ts` drives the cluster
 * service against a fake controller that carries its own stale drop, so it
 * cannot fail when the production guard breaks, and the browser case in
 * `tests/cluster-controller-integration.spec.ts` cannot either on its own:
 * a held response is aborted at off intent, so the stale response never
 * arrives. Here every defence between a stale activation and the settled
 * display is exercised with a stub layer module whose activation the case
 * settles by hand, out of order, AFTER the supersession.
 *
 * The four defences, and the case that defends each (a break of the named
 * line reds that case for its own reason; see the report):
 *
 *   1. the abort at off intent (`abortAttempt`, layer-controller.ts, called
 *      from `deactivateInternal`): the stale module's signal is aborted, so
 *      its late-response guard drops the answer and writes no status.
 *      Defended by "the stale settle writes no status ...".
 *   2. the per-key operation chain (`enqueueLayerOp`): the fresh activation
 *      does not start until the stale one has settled, so a module never has
 *      two activations of one key in flight. Defended by "a fresh
 *      activation never overlaps ...".
 *   3. the intent generation (`ownsIntent`): a stale op that settles after
 *      the boolean intent aliased back to on still registers nothing.
 *      Defended by "the stale settle registers nothing ...".
 *   4. each module's own late-response guard is the stub's one line
 *      `if (activation.signal.aborted) return`; it is the module's, not the
 *      controller's, so it is exercised by the module's own tests.
 *
 * The stub module is HONEST in the way the real ones are (hms-smoke.ts,
 * nifc-fires.ts): it reports `loading`, holds until the case releases it
 * (the late response), drops its answer when the controller's signal was
 * aborted meanwhile, and otherwise adds "its source" (a duplicate source is
 * an error, as for the real map) and reports `ready`.
 */

// The product modules import each other without extensions; this hook appends
// `.ts` to a relative, extensionless specifier whose parent is a `.ts` module
// (tests/briefing-truth.test.mjs and tests/popup-frame.test.mjs, the same
// hook).
registerHooks({
  resolve(specifier, context, nextResolve) {
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

// Load the real configuration BEFORE the stub hook so the stub can re-export
// it. Only `loadLayerModule` and `getLoadedLayerModule` differ (they answer
// the stub modules a case registers on `globalThis.__staleModules`).
const realLayers = await import('../src/config/layers.ts');
globalThis.__staleRealLayers = realLayers;
globalThis.__staleModules = new Map();

const CONTROLLER = '/state/layer-controller.ts';
const stubs = {
  '/config/layers': `const r = globalThis.__staleRealLayers;
    export const LAYER_DEFS = r.LAYER_DEFS;
    export const getLayerDef = r.getLayerDef;
    export const getLoadedLayerModule = (key) => globalThis.__staleModules.get(key);
    export const loadLayerModule = async (def) => globalThis.__staleModules.get(def.key);`,
  'maplibre-gl': 'export {};',
  '/map/layer-order': 'export function reassertLabelOrder(){} export function reassertThematicOrder(){}',
  '/util/layer-fade': 'export function fadeInLayers(){} export async function fadeOutLayers(){ await globalThis.__staleFade?.(); }',
  '/ui/overlay': 'export function showLoading(){ return 1; } export function hideLoading(){}'
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith(CONTROLLER)
    ) {
      const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
      if (stub) {
        return {
          url: `data:text/javascript,${encodeURIComponent(stub[1])}`,
          shortCircuit: true
        };
      }
    }
    return nextResolve(specifier, context);
  }
});

const { createLayerController } = await import('../src/state/layer-controller.ts');
const service = await import('../src/state/cluster-service.ts');
const { LAYER_DEFS } = realLayers;
const { HAZARD_CLUSTERS } = await import('../src/config/clusters.ts');
const { registry } = await import('../src/state/registry.ts');
const { timeline } = await import('../src/state/timeline.ts');
const { setHazardCluster, getHazardCluster } = await import('../src/state/cluster-store.ts');
const { setFraming } = await import('../src/state/framing-store.ts');
const bridge = await import('../src/ui/island/bridge.ts');
const toggle = await import('../src/ui/layer-toggle-command.ts');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Let every queued microtask and the controller's op chains drain. */
async function flush(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A stub layer module per catalog key. `hold` keys keep their activation
 * pending until the case releases the call (the late response); every other
 * key settles at once. `record` is what the case observes: calls (with the
 * controller's signal), the maximum number of activations in flight at once,
 * and the generation whose data is "on the map" (`source`).
 */
function installModules(holdKeys) {
  const records = new Map();
  globalThis.__staleModules.clear();
  for (const def of LAYER_DEFS) {
    const key = def.key;
    const record = { calls: [], inflight: 0, maxInflight: 0, source: null, hold: holdKeys.has(key) };
    records.set(key, record);
    globalThis.__staleModules.set(key, {
      fadeLayerIds: [],
      async activate(_map, activation) {
        const call = { n: record.calls.length + 1, signal: activation.signal };
        record.calls.push(call);
        record.inflight += 1;
        record.maxInflight = Math.max(record.maxInflight, record.inflight);
        registry.setStatus(key, 'loading');
        if (record.hold) await new Promise((resolve) => (call.release = resolve));
        record.inflight -= 1;
        // The module's own late-response guard, keyed on the controller's
        // signal: an answer to a superseded request writes nothing.
        if (activation.signal.aborted) return;
        if (record.source !== null) throw new Error(`duplicate source for ${key}`);
        record.source = call.n;
        registry.setStatus(key, 'ready');
      },
      deactivate() {
        record.source = null;
      }
    });
  }
  return records;
}

function checkedKeys() {
  const out = new Set();
  for (const [key, on] of bridge.checkedSnapshot()) if (on) out.add(key);
  return out;
}

const fakeMap = { on() {}, off() {}, getSource() {}, getLayer() {} };

/** The real controller over a view that mirrors the sidebar's wiring: the
 * checkbox state is the island bridge's. */
function bindRealController() {
  const view = {
    setCheckbox: (key, on) => bridge.setChecked(key, on),
    isCheckboxChecked: (key) => bridge.isChecked(key),
    clearLayerStatus() {},
    announce() {}
  };
  const controller = createLayerController(fakeMap, view);
  toggle.bindLayerToggleController(controller);
  return controller;
}

/** Boot the world on Drought at the current horizon with the real controller,
 * every module settling at once. */
async function bootDrought(holdKeys) {
  for (const def of LAYER_DEFS) {
    if (checkedKeys().has(def.key)) bridge.setChecked(def.key, false);
  }
  // registry.deactivate also clears a key's status.
  for (const def of LAYER_DEFS) registry.deactivate(def.key);
  timeline.reset();
  setFraming(null);
  setHazardCluster('drought', null);
  const records = installModules(new Set());
  bindRealController();
  service.requestCluster('drought');
  await flush();
  // From here only the named keys hold.
  for (const key of holdKeys) records.get(key).hold = true;
  return records;
}

/** Wire the sidebar's reconcile subscription, init the service, and record
 * every published snapshot. Returns a teardown. */
function startService() {
  const off1 = bridge.onCheckedChange(() => {
    service.reconcileClusterWithLayerIntent(checkedKeys());
  });
  const disposeService = service.initClusterService();
  const published = [];
  const off2 = service.onCommittedSnapshotChange(() => {
    const s = service.getCommittedSnapshot();
    published.push({ cluster: s.cluster, statuses: new Map(s.statuses), intended: new Set(s.intendedKeys) });
  });
  return {
    published,
    stop() {
      off2();
      disposeService();
      off1();
    }
  };
}

function release(record, n) {
  const call = record.calls[n - 1];
  assert.ok(call?.release, `call ${n} is held`);
  call.release();
  call.release = undefined;
}

const WILDFIRE_PAIR = HAZARD_CLUSTERS.wildfire.recipes.current;

test('a fade-out failure still removes resources and allows reactivation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const key = 'tribal';
  registry.deactivate(key);
  const records = installModules(new Set());
  const record = records.get(key);
  const controller = bindRealController();
  await controller.activate(key);
  globalThis.__staleFade = async () => { throw new Error('paint failed'); };
  try {
    controller.deactivate(key);
    await flush();
    assert.equal(record.source, null, 'teardown ran despite the paint failure');
    assert.equal(registry.getActiveKeys().has(key), false);
    await controller.activate(key);
    assert.equal(record.source, 2);
    assert.equal(registry.getActiveKeys().has(key), true);
  } finally {
    delete globalThis.__staleFade;
    controller.deactivate(key);
    await flush();
  }
});

test('a thrown activation removes partial resources before a retry', async (t) => {
  t.mock.method(console, 'error', () => {});
  const key = 'tribal';
  registry.deactivate(key);
  const records = installModules(new Set());
  const record = records.get(key);
  const module = globalThis.__staleModules.get(key);
  const activate = module.activate;
  module.activate = async (map, activation) => {
    await activate(map, activation);
    if (record.calls.length === 1) throw new Error('setup failed after adding a source');
  };
  const controller = bindRealController();
  await controller.activate(key);
  assert.equal(record.source, null, 'the failed activation left no source');
  assert.equal(registry.getActiveKeys().has(key), false);
  assert.equal(registry.getStatus(key), 'error');
  await controller.activate(key);
  assert.equal(record.source, 2, 'retry installed its own source');
  assert.equal(registry.getStatus(key), 'ready');
  assert.equal(registry.getActiveKeys().has(key), true);
  controller.deactivate(key);
  await flush();
});

test('a superseded activation that throws cleans up before the latest on intent', async (t) => {
  t.mock.method(console, 'error', () => {});
  const key = 'tribal';
  registry.deactivate(key);
  const records = installModules(new Set());
  const record = records.get(key);
  const module = globalThis.__staleModules.get(key);
  const activate = module.activate;
  let rejectSetup;
  module.activate = async (map, activation) => {
    await activate(map, activation);
    if (record.calls.length === 1) {
      await new Promise((_resolve, reject) => { rejectSetup = reject; });
    }
  };
  const controller = bindRealController();
  const first = controller.activate(key);
  await flush();
  controller.deactivate(key);
  bridge.setChecked(key, true);
  const latest = controller.activate(key);
  rejectSetup(new Error('superseded setup failed'));
  await Promise.all([first, latest]);
  assert.equal(record.source, 2, 'partial stale resources did not block the latest source');
  assert.equal(registry.getStatus(key), 'ready');
  assert.equal(bridge.isChecked(key), true);
  assert.equal(registry.getActiveKeys().has(key), true);
  controller.deactivate(key);
  await flush();
});

test('off/on of an active layer replaces its aborted signal and keeps viewport refreshes live', async () => {
  const key = 'hydrography';
  registry.deactivate(key);
  const records = installModules(new Set());
  const controller = bindRealController();
  await controller.activate(key);
  const record = records.get(key);
  controller.deactivate(key);
  await controller.activate(key);
  assert.equal(record.calls.length, 2);
  assert.equal(record.calls[0].signal.aborted, true);
  assert.equal(record.calls[1].signal.aborted, false);
  assert.equal(record.source, 2);
  assert.equal(registry.getActiveKeys().has(key), true);
  controller.deactivate(key);
  await flush();
});

test('a preset returning during fade-out restores the checkbox and reactivates the layer', async () => {
  for (const def of LAYER_DEFS) {
    registry.deactivate(def.key);
    bridge.setChecked(def.key, false);
  }
  const key = 'nadm-drought';
  const records = installModules(new Set());
  const controller = bindRealController();
  const preset = { label: 'Test', layers: [key] };
  controller.applyPreset(preset);
  await flush();
  let finishFade;
  globalThis.__staleFade = () => new Promise((resolve) => { finishFade = resolve; });
  try {
    controller.applyPreset({ label: 'Empty', layers: [] });
    await flush();
    assert.equal(typeof finishFade, 'function');
    controller.applyPreset(preset);
    finishFade();
    await flush();
    assert.equal(bridge.isChecked(key), true);
    assert.equal(registry.getActiveKeys().has(key), true);
    assert.equal(records.get(key).calls.length, 2);
    assert.equal(records.get(key).calls[1].signal.aborted, false);
    assert.equal(records.get(key).source, 2);
  } finally {
    delete globalThis.__staleFade;
    controller.deactivate(key);
    await flush();
  }
});

test('a rejected old import cannot uncheck or cancel the latest on intent', async () => {
  const records = installModules(new Set());
  const key = 'usdm';
  const module = globalThis.__staleModules.get(key);
  let rejectImport;
  globalThis.__staleModules.set(key, new Promise((_resolve, reject) => { rejectImport = reject; }));
  registry.deactivate(key);
  const controller = bindRealController();
  bridge.setChecked(key, true);
  const first = controller.activate(key);
  await flush();
  controller.deactivate(key);
  bridge.setChecked(key, true);
  const latest = controller.activate(key);
  globalThis.__staleModules.set(key, module);
  rejectImport(new Error('superseded import failed'));
  await Promise.all([first, latest]);
  assert.equal(records.get(key).calls.length, 1);
  assert.equal(bridge.isChecked(key), true);
  assert.equal(registry.getActiveKeys().has(key), true);
  controller.deactivate(key);
  await flush();
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test('the stale settle writes no status: A -> B -> A, the aborted first generation answers late and the fresh generation is still loading (the abort at off intent)', async () => {
  const records = await bootDrought([...WILDFIRE_PAIR, 'nadm-drought']);
  const live = startService();
  try {
    service.requestCluster('wildfire');
    await flush();
    for (const key of WILDFIRE_PAIR) {
      assert.equal(records.get(key).calls.length, 1, `${key}: generation 1 is in flight`);
    }
    assert.equal(registry.getActiveKeys().has('nadm-drought'), false, 'nadm-drought is off under Wildfire');

    // Boot activated nadm-drought once (call 1); the Drought press starts a
    // second, held generation of it (call 2).
    const nadm = records.get('nadm-drought');
    assert.equal(nadm.calls.length, 1, 'boot activated nadm-drought once');
    service.requestCluster('drought');
    await flush();
    assert.equal(nadm.calls.length, 2, 'a Drought generation of nadm-drought is in flight');
    service.requestCluster('wildfire');
    await flush();

    // Supersession aborted every first-generation signal at off intent.
    for (const key of WILDFIRE_PAIR) {
      assert.equal(records.get(key).calls[0].signal.aborted, true, `${key}: generation 1 is aborted`);
    }
    assert.equal(nadm.calls[1].signal.aborted, true, 'the Drought generation of nadm-drought is aborted');

    // The stale answers arrive LATE, after the same keys became intended
    // again (nifc-fires and hms-smoke) or stayed dropped (nadm-drought).
    release(nadm, 2);
    for (const key of WILDFIRE_PAIR) release(records.get(key), 1);
    await flush();

    // The fresh generation of each Wildfire key has now STARTED (the chain
    // let it through), and no stale answer wrote a status: the pair still
    // reads loading, never ready.
    for (const key of WILDFIRE_PAIR) {
      assert.equal(records.get(key).calls.length, 2, `${key}: generation 3 started once the stale op settled`);
      assert.equal(registry.getStatus(key), 'loading', `${key}: no stale status landed`);
      assert.equal(records.get(key).source, null, `${key}: no stale data is on the map`);
    }
    for (const rev of live.published) {
      for (const key of WILDFIRE_PAIR) {
        assert.notEqual(rev.statuses.get(key), 'ready', `no published snapshot claimed ${key} ready`);
      }
    }
    // The dropped surface made no claim at all: no data, no status.
    assert.equal(registry.getStatus('nadm-drought'), undefined, 'the dropped surface holds no status');
    assert.equal(records.get('nadm-drought').source, null);
  } finally {
    live.stop();
  }
});

test('a fresh activation never overlaps the stale one: the per-key chain holds the newest generation until the stale op settled (the operation chain)', async () => {
  const records = await bootDrought(WILDFIRE_PAIR);
  const live = startService();
  try {
    service.requestCluster('wildfire');
    await flush();
    service.requestCluster('drought');
    await flush();
    service.requestCluster('wildfire');
    await flush();

    // The stale generation is still in flight (the case has not released it).
    // The newest generation waits behind it: ONE activation per key at a
    // time, so a module that throws on a duplicate source never sees two.
    for (const key of WILDFIRE_PAIR) {
      const record = records.get(key);
      assert.equal(record.calls.length, 1, `${key}: the fresh activation has not started`);
      assert.equal(record.maxInflight, 1, `${key}: never two activations in flight`);
    }

    // Release the stale op; the fresh one starts, and settles with ITS data.
    for (const key of WILDFIRE_PAIR) release(records.get(key), 1);
    await flush();
    for (const key of WILDFIRE_PAIR) {
      assert.equal(records.get(key).calls.length, 2, `${key}: the fresh activation started`);
      assert.equal(records.get(key).maxInflight, 1, `${key}: still never two in flight`);
    }
  } finally {
    live.stop();
  }
});

test('the stale settle registers nothing: the newest generation alone makes the layer active, with its own data on the map (the intent generation)', async () => {
  const records = await bootDrought(WILDFIRE_PAIR);
  const live = startService();
  try {
    service.requestCluster('wildfire');
    await flush();
    service.requestCluster('drought');
    await flush();
    service.requestCluster('wildfire');
    await flush();

    // The stale answer arrives; the boolean intent has aliased back to on,
    // so only the generation tells the controller it is stale.
    for (const key of WILDFIRE_PAIR) release(records.get(key), 1);
    await flush();
    for (const key of WILDFIRE_PAIR) {
      assert.equal(
        registry.getActiveKeys().has(key),
        false,
        `${key}: not registered active by the stale settle`
      );
      assert.equal(records.get(key).calls.length, 2, `${key}: the fresh generation was not starved`);
    }

    // Now the fresh generation settles: display, intent, and claim converge
    // on ITS data (call 2), the dropped surface stays off.
    for (const key of WILDFIRE_PAIR) release(records.get(key), 2);
    await flush();
    for (const key of WILDFIRE_PAIR) {
      assert.equal(registry.getActiveKeys().has(key), true, `${key}: active`);
      assert.equal(registry.getStatus(key), 'ready', `${key}: ready`);
      assert.equal(records.get(key).source, 2, `${key}: the newest generation's data is on the map`);
    }
    assert.equal(registry.getActiveKeys().has('nadm-drought'), false);
    assert.equal(registry.getStatus('nadm-drought'), undefined, 'the dropped surface holds no status');
    assert.equal(checkedKeys().has('nadm-drought'), false);
    assert.equal(service.getCommittedSnapshot().statuses.has('nadm-drought'), false);
    assert.equal(service.getCommittedSnapshot().cluster, 'wildfire');
    assert.equal(getHazardCluster(), 'wildfire');
  } finally {
    live.stop();
  }
});

test('an abort at off intent frees the key at once: a held activation that honours its signal settles on the Drought press and the fresh generation starts without a release (the abort at off intent)', async () => {
  const records = await bootDrought([]);
  for (const key of WILDFIRE_PAIR) {
    // A module whose held request ends when its signal aborts, as a real
    // fetch does.
    const record = records.get(key);
    record.hold = true;
    const original = globalThis.__staleModules.get(key).activate;
    globalThis.__staleModules.get(key).activate = (map, activation) => {
      const done = original(map, activation);
      activation.signal.addEventListener('abort', () => record.calls.at(-1)?.release?.(), { once: true });
      return done;
    };
  }
  const live = startService();
  try {
    service.requestCluster('wildfire');
    await flush();
    service.requestCluster('drought');
    await flush();
    service.requestCluster('wildfire');
    await flush();
    for (const key of WILDFIRE_PAIR) {
      assert.equal(
        records.get(key).calls.length,
        2,
        `${key}: the abort ended the stale request, so the fresh generation started`
      );
    }
  } finally {
    live.stop();
  }
});
