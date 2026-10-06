import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Exercise the actual private stamp writer with a recording dataset. The load
// hook exposes it only in this test process; no production export or predicate
// is copied. Renderer output and CSS remain the flow-wire cases' responsibility.
const target = new URL('../src/layers/enso-flow.ts', import.meta.url).href;
const stub = (source) => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('.ts')) {
      if (specifier.endsWith('.css')) return stub('export {};');
      if (specifier === '../map/layer-order') return stub('export function reassertThematicOrder() { throw new Error("unexpected map use"); }');
      if (specifier === '../state/enso-flow') return stub('export function parseEnsoFlowParams() { throw new Error("unexpected URL use"); } export function syncEnsoFlowParams() { throw new Error("unexpected URL use"); }');
      if (specifier === '../util/fetch') return stub('export function fetchJsonWithBudget() { throw new Error("unexpected network"); }');
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) &&
          existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== target) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
    return { ...loaded, source: `${source}\nexport function testStampForm(state, kind, node) { panel = node; stampForm(state, kind); }\n` };
  }
});

globalThis.fetch = () => { throw new Error('unexpected network'); };
const { testStampForm } = await import('../src/layers/enso-flow.ts');

for (const form of ['still', 'arrows']) {
  test(`${form} with no native features does not claim a drawn form or kind`, () => {
    const node = { dataset: {} };
    testStampForm({ form, features: 0, motion: 'paused' }, 'wind', node);
    assert.deepEqual(node.dataset, { flowForm: 'none', flowMotion: 'paused', flowFeatures: '0', flowDrawn: '' });
  });

  test(`${form} with native features retains its drawn form and kind`, () => {
    const node = { dataset: {} };
    testStampForm({ form, features: 3, motion: 'paused' }, 'waves', node);
    assert.deepEqual(node.dataset, { flowForm: form, flowMotion: 'paused', flowFeatures: '3', flowDrawn: 'waves' });
  });
}

test('the moving GPU form remains drawn with zero native GeoJSON features', () => {
  const node = { dataset: {} };
  testStampForm({ form: 'moving', features: 0, motion: 'moving' }, 'wind', node);
  assert.deepEqual(node.dataset, { flowForm: 'moving', flowMotion: 'moving', flowFeatures: '0', flowDrawn: 'wind' });
});

test('clearing a prior drawn form removes both diagnostic claims', () => {
  const node = { dataset: {} };
  testStampForm({ form: 'arrows', features: 3, motion: 'none' }, 'waves', node);
  testStampForm(null, 'off', node);
  assert.deepEqual(node.dataset, { flowForm: 'none', flowMotion: 'none', flowFeatures: '0', flowDrawn: '' });
});
