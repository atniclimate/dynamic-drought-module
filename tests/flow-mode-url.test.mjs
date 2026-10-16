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
const { syncUrl, parseSelectParam } = await import('../src/state/url.ts');
const { installFakeBrowser } = await import('./map-harness.ts');

function synced(search, state, panelMounted = false) {
  const browser = installFakeBrowser({ search });
  document.querySelector = () => panelMounted ? {} : null;
  try {
    syncUrl({ region: null, layers: new Set(), embed: false, view: 'console', ...state });
    return new URLSearchParams(browser.search());
  } finally { browser.restore(); }
}

const { ENSO_FLOW_KINDS, parseEnsoFlowParams, writeEnsoFlowParams } = await import('../src/state/enso-flow.ts');

test('every flow kind is its own flow= token, read and written back unchanged', () => {
  assert.deepEqual(ENSO_FLOW_KINDS.slice(0, 1), ['off']);
  assert.ok(ENSO_FLOW_KINDS.includes('jet'), 'jet-level wind is a kind');
  assert.ok(ENSO_FLOW_KINDS.includes('pwat'), 'precipitable water is a kind');
  assert.equal(parseEnsoFlowParams(new URLSearchParams('flow=PWAT'), 'wind').kind, 'off', 'the token is matched exactly');
  for (const kind of ENSO_FLOW_KINDS) {
    assert.deepEqual(parseEnsoFlowParams(new URLSearchParams(`flow=${kind}`), 'off'), { kind, ink: 'light' });
    const params = new URLSearchParams('flow=stale');
    writeEnsoFlowParams(params, { kind, ink: 'dark' }, 'off');
    assert.equal(params.get('flow'), kind === 'off' ? null : kind);
    assert.equal(params.get('flowink'), kind === 'off' ? null : 'dark');
  }
  assert.equal(parseEnsoFlowParams(new URLSearchParams('flow=jetstream'), 'wind').kind, 'off', 'an unknown token is off');
  assert.equal(parseEnsoFlowParams(new URLSearchParams('flow=jet&flow=wind'), 'wind').kind, 'off', 'a duplicate is off');
  assert.equal(parseEnsoFlowParams(new URLSearchParams(), 'jet').kind, 'jet', 'no key reads the mode default');
});

for (const kind of ENSO_FLOW_KINDS.filter((kind) => kind !== 'wind')) {
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

test('select=state takes only a two-letter code, so a link cannot set the toast text', () => {
  const read = (search) => {
    const browser = installFakeBrowser({ search });
    try { return parseSelectParam(); } finally { browser.restore(); }
  };
  assert.deepEqual(read('?select=state:WA'), { kind: 'state', id: 'WA' });
  assert.deepEqual(read('?select=State: or '), { kind: 'state', id: 'or' });
  for (const bad of ['state:WAS', 'state:W', `state:${'A'.repeat(2000)}`, 'state:W1', 'state:Your account is locked']) {
    assert.equal(read(`?select=${encodeURIComponent(bad)}`), null, bad.slice(0, 30));
  }
});
