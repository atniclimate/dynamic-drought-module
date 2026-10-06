import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * found-128 (B6-HILLSHADE-LAYERSET): `applyLayerSet` is the URL/default boot
 * path and is boot-only. It skips every key a command has ever set
 * (`desiredOn` is only ever added to), so a second caller would silently skip
 * every layer a person had touched. The rule was a comment; it is now
 * enforced: a second call on the same controller is refused with a rejected
 * promise and changes nothing.
 *
 * The REAL `createLayerController` runs; its peripheral modules (the layer
 * catalog, the DOM overlay, the fade and order helpers, the cluster service)
 * are replaced by recorders, the same approach as
 * tests/layer-activation-cancel.test.mjs.
 */

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

const activated = [];
globalThis.bootOnlyActivated = activated;
globalThis.bootOnlyDefs = ['alpha', 'beta', 'gamma'].map((key) => ({
  key,
  name: key,
  role: 'overlay'
}));
globalThis.bootOnlyModules = new Map(
  globalThis.bootOnlyDefs.map((def) => [
    def.key,
    {
      fadeLayerIds: [],
      async activate() {
        globalThis.bootOnlyActivated.push(def.key);
      },
      deactivate() {}
    }
  ])
);

const stubs = {
  'maplibre-gl': 'export const stub = true;',
  '/config/layers': `export const LAYER_DEFS=globalThis.bootOnlyDefs;
    export const getLayerDef=key=>LAYER_DEFS.find(d=>d.key===key);
    export const getLoadedLayerModule=key=>globalThis.bootOnlyModules.get(key);
    export const loadLayerModule=async def=>globalThis.bootOnlyModules.get(def.key);`,
  './cluster-service': 'export function isCommittedCompositionKey(){ return false; }',
  '/map/layer-order': 'export function reassertLabelOrder(){} export function reassertThematicOrder(){}',
  '/util/layer-fade': 'export function fadeInLayers(){} export async function fadeOutLayers(){}',
  '/ui/overlay': 'export function showLoading(){ return 1; } export function hideLoading(){}'
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) {
      return {
        url: `data:text/javascript,${encodeURIComponent(stub[1])}`,
        shortCircuit: true
      };
    }
    return nextResolve(specifier, context);
  }
});

const { createLayerController } = await import('../src/state/layer-controller.ts');
const { registry } = await import('../src/state/registry.ts');

function harness() {
  const checked = new Set();
  const view = {
    setCheckbox(key, on) {
      if (on) checked.add(key);
      else checked.delete(key);
    },
    isCheckboxChecked: (key) => checked.has(key),
    clearLayerStatus() {},
    announce() {}
  };
  return { controller: createLayerController({}, view), checked };
}

function reset() {
  activated.length = 0;
  for (const key of registry.getActiveKeys()) registry.deactivate(key);
}

test('applyLayerSet activates the boot set on its first call', async () => {
  reset();
  const { controller, checked } = harness();
  await controller.applyLayerSet(['alpha', 'beta']);
  assert.deepEqual([...activated].sort(), ['alpha', 'beta']);
  assert.deepEqual([...checked].sort(), ['alpha', 'beta']);
});

test('a second applyLayerSet on the same controller is refused and changes nothing', async () => {
  reset();
  const { controller, checked } = harness();
  await controller.applyLayerSet(['alpha']);
  assert.deepEqual(activated, ['alpha'], 'setup: the boot call did not activate its key');

  await assert.rejects(
    () => controller.applyLayerSet(['beta']),
    /boot-only/,
    'a second applyLayerSet call was not refused'
  );
  assert.deepEqual(activated, ['alpha'], 'the refused call still activated a layer');
  assert.equal(checked.has('beta'), false, 'the refused call still checked a layer');
});

test('an empty boot set still consumes the one boot call', async () => {
  reset();
  const { controller } = harness();
  await controller.applyLayerSet([]);
  await assert.rejects(() => controller.applyLayerSet(['gamma']), /boot-only/);
  assert.deepEqual(activated, [], 'a refused call activated a layer');
});

test('the boot-only guard is per controller: a fresh controller may boot once', async () => {
  reset();
  const first = harness();
  await first.controller.applyLayerSet(['alpha']);
  const second = harness();
  await second.controller.applyLayerSet(['gamma']);
  assert.deepEqual([...activated].sort(), ['alpha', 'gamma']);
});
