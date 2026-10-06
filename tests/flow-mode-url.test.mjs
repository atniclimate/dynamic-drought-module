import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) &&
        context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

globalThis.fetch = () => { throw new Error('unexpected network in URL unit test'); };
const { HAZARD_CLUSTERS } = await import('../src/config/clusters.ts');
const { syncUrl } = await import('../src/state/url.ts');
const { installFakeBrowser } = await import('./map-harness.ts');

function synced(search, state, panelMounted = false) {
  const browser = installFakeBrowser({ search });
  document.querySelector = () => panelMounted ? {} : null;
  try {
    syncUrl({ region: null, layers: new Set(), embed: false, view: 'console', ...state });
    return new URLSearchParams(browser.search());
  } finally { browser.restore(); }
}

for (const kind of ['off', 'waves', 'currents']) {
  test(`a newly configured flow mode preserves explicit ${kind} before its surface mounts`, () => {
    const key = 'test-future-flow-mode';
    HAZARD_CLUSTERS[key] = { ...HAZARD_CLUSTERS.enso, urlToken: key, flowDefault: 'wind' };
    try {
      const params = synced(`?flow=${kind}&flowink=dark`, { cluster: key });
      assert.equal(params.get('cluster'), key);
      assert.equal(params.get('flow'), kind);
      assert.equal(params.get('flowink'), kind === 'off' ? null : 'dark');
    } finally { delete HAZARD_CLUSTERS[key]; }
  });
}

test('every configured flow default enters with its default absent from the URL', () => {
  for (const [cluster, definition] of Object.entries(HAZARD_CLUSTERS)) {
    if (definition.flowDefault === undefined) continue;
    const params = synced('?view=console', { cluster });
    assert.equal(params.get('flow'), null, cluster);
    assert.equal(params.get('flowink'), null, cluster);
  }
});

test('every configured mode without flow support drops flow preferences after SST leaves', () => {
  for (const [cluster, definition] of Object.entries(HAZARD_CLUSTERS)) {
    if (definition.flowDefault !== undefined) continue;
    const params = synced('?cluster=enso&flow=waves&flowink=dark', { cluster });
    assert.equal(params.get('flow'), null, cluster);
    assert.equal(params.get('flowink'), null, cluster);
  }
});

test('a custom SST display retains its mounted flow preference independently of a mode', () => {
  const params = synced('?layers=sst-anomaly&flow=waves&flowink=dark', { layers: new Set(['sst-anomaly']) }, true);
  assert.equal(params.get('cluster'), null);
  assert.equal(params.get('flow'), 'waves');
  assert.equal(params.get('flowink'), 'dark');
});
