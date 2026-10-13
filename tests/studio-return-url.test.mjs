import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit finding 8: the Place studio sets the map's hazard and event layers
 * aside, and the URL writer then wrote the trimmed set (and dropped
 * `cluster=`), so a reload or a shared PLACE link came back with no hazard
 * layers. While the saved copy is held, the writer writes the copy's layers,
 * cluster and ocean; the studio's own display is untouched.
 */
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
const { syncUrl, holdStudioReturnDisplay } = await import('../src/state/url.ts');
const { installFakeBrowser } = await import('./map-harness.ts');

function synced(state) {
  const browser = installFakeBrowser({ search: '?studio=place' });
  document.querySelector = () => null;
  try {
    syncUrl({ region: null, layers: new Set(['aiannh']), embed: false, view: 'console', studio: 'place', ...state });
    return new URLSearchParams(browser.search());
  } finally { browser.restore(); }
}

test('a held copy writes its granular layers for the studio entry', () => {
  holdStudioReturnDisplay({ intentKeys: new Set(['usdm', 'nifc-fires']), cluster: 'drought', ocean: null });
  try {
    const params = synced({});
    assert.equal(params.get('layers'), 'usdm,nifc-fires');
    assert.equal(params.get('studio'), 'place');
  } finally { holdStudioReturnDisplay(null); }
});

test('a held clean cluster copy writes the cluster token, not the trimmed list', () => {
  holdStudioReturnDisplay({ intentKeys: new Set(['usdm', 'nifc-fires']), cluster: 'wildfire', ocean: null });
  try {
    const params = synced({ cluster: 'drought' });
    assert.equal(params.get('cluster'), 'wildfire');
    assert.equal(params.get('layers'), null);
  } finally { holdStudioReturnDisplay(null); }
});

test('with no copy held the writer writes what it is given', () => {
  const params = synced({});
  assert.equal(params.get('layers'), 'aiannh');
  assert.equal(params.get('cluster'), null);
});
