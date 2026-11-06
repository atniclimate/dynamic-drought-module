import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit round 3, lane H: the person's hazard everywhere, and in the link. A
 * custom set keeps the hazard it was made from (getSelectedHazard) while the
 * cluster store reads Drought. Before this, the link carried no word for that
 * hazard and the boot seeded Drought, so a shared or reloaded custom set made
 * in another mode drew Drought's alert products, key and strip; and a brief
 * embed never initialized the service at all. The link now carries `hazard=`
 * beside `layers=`, the boot seeds the service from it, and Back from a studio
 * keeps the additive keys the live map holds.
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
const url = await import('../src/state/url.ts');
const { syncEnsoFlowParams } = await import('../src/state/enso-flow.ts');
const { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } = await import('../src/config/clusters.ts');
const { DEFAULT_ON_KEYS } = await import('../src/config/layers.ts');
const service = await import('../src/state/cluster-service.ts');
const { getHazardCluster, setHazardCluster } = await import('../src/state/cluster-store.ts');
const { installFakeBrowser } = await import('./map-harness.ts');

/** Every mode with a link token: N modes from the config, never a literal list. */
const TOKENED = HAZARD_CLUSTER_KEYS.filter((key) => HAZARD_CLUSTERS[key].urlToken !== null);

function synced(state) {
  const browser = installFakeBrowser({ search: '' });
  try {
    url.syncUrl({ region: null, embed: false, view: 'console', ...state });
    return new URLSearchParams(browser.search());
  } finally { browser.restore(); }
}

function reloaded(params) {
  const browser = installFakeBrowser({ search: `?${params}` });
  try { return url.parseUrlParams(); } finally { browser.restore(); }
}

test('a custom set made in any mode writes hazard= beside layers= and reloads with that hazard', () => {
  assert.ok(TOKENED.length > 0);
  for (const key of TOKENED) {
    const layers = new Set([...service.composeClusterIntent(key, 'current'), 'places']);
    const params = synced({ layers, cluster: 'drought', hazard: key });
    assert.equal(params.get('cluster'), null, key);
    assert.equal(params.get('hazard'), HAZARD_CLUSTERS[key].urlToken, key);
    const back = reloaded(params);
    assert.equal(back.cluster, 'drought', `${key}: layers= still outranks, the display is the list`);
    assert.equal(back.hazard, key, `${key}: the person's hazard survives`);
    assert.deepEqual(back.layers, layers, key);
  }
});

test('a clean mode and a Drought custom set write no hazard=', () => {
  for (const key of TOKENED) {
    const params = synced({ layers: new Set(service.composeClusterIntent(key, 'current')), cluster: key, hazard: key });
    assert.equal(params.get('cluster'), HAZARD_CLUSTERS[key].urlToken, key);
    assert.equal(params.get('hazard'), null, key);
    assert.equal(reloaded(params).hazard, key, `${key}: a clean link's hazard is its cluster`);
  }
  const drought = synced({ layers: new Set(['places']), cluster: 'drought', hazard: 'drought' });
  assert.equal(drought.get('hazard'), null);
  assert.equal(reloaded(drought).hazard, 'drought');
});

test('hazard= is one exact token beside a layers= list no mode claims; anything else reads the cluster', () => {
  const key = TOKENED[0];
  const token = HAZARD_CLUSTERS[key].urlToken;
  const other = TOKENED.find((k) => k !== key) ?? key;
  const otherToken = HAZARD_CLUSTERS[other].urlToken;
  const P = (s) => url.parseShellParams(new URLSearchParams(s));
  assert.equal(P(`layers=places&hazard=${token}`).hazard, key);
  assert.equal(P(`hazard=${token}`).hazard, 'drought', 'no layers=: the default display');
  assert.equal(P(`cluster=${otherToken}&hazard=${token}`).hazard, other, 'a surviving cluster is the hazard');
  assert.equal(P(`layers=places&hazard=${token}&hazard=${token}`).hazard, 'drought', 'a duplicate is rejected');
  assert.equal(P(`layers=places&hazard=${token.toUpperCase()}`).hazard, 'drought', 'the token is exact');
  assert.equal(P('layers=places&hazard=bogus').hazard, 'drought');
  assert.equal(
    P(`layers=${[...DEFAULT_ON_KEYS].join(',')}&hazard=${token}`).hazard,
    'drought',
    'the default display is Drought\'s, whatever hazard= says'
  );
  // Additive: the display, the ocean and the camera keys parse as before.
  const custom = P(`layers=places&hazard=${token}&ocean=pacific&framing=all`);
  assert.equal(custom.cluster, 'drought');
  assert.equal(custom.ocean, null);
  assert.equal(custom.framing, 'all');
});

test('the boot seeds the service with the link\'s hazard, not the store\'s Drought', () => {
  const key = TOKENED[0];
  const before = getHazardCluster();
  setHazardCluster('drought');
  const stop = service.initClusterService(key);
  try {
    assert.equal(service.getSelectedHazard(), key);
    assert.equal(service.getCommittedSnapshot().selectedHazard, key);
    assert.equal(service.initClusterService(), stop, 'a later call (mountShell) is a no-op');
    assert.equal(service.getSelectedHazard(), key);
  } finally {
    service.restoreCommittedCluster(before, null);
    stop();
  }
});

test('the sidebar boot initializes the service from the link before its first write, embed or not', () => {
  const src = readFileSync(new URL('../src/ui/sidebar.ts', import.meta.url), 'utf8');
  const boot = src.slice(src.indexOf('function applyUrlStateSync('));
  const seed = boot.indexOf('setHazardCluster(params.cluster, params.ocean);');
  const init = boot.indexOf('initClusterService(params.hazard);');
  const firstWrite = boot.indexOf('selectRegion(map, params.region, true);');
  assert.ok(seed > 0 && seed < init && init < firstWrite, 'store seed, then the service, then the first write');
  // A custom set boots flat (the Fire3D gate admits no custom boot), so the link drops fire3d= rather than ask for 3D on a flat map.
  assert.ok(boot.includes("params.fire3d && params.cluster === 'wildfire'"), 'DR-122 keeps fire3d= only on a Wildfire boot');
  assert.ok(src.includes('hazard: getSelectedHazard(),'), 'every canonical write carries the hazard');
});

test('Back from a studio keeps the additive keys the live map holds', () => {
  const browser = installFakeBrowser({ search: '?layers=heatrisk&fire3d=true&view=console&studio=layers' });
  try {
    // Written on the studio entry (src/state/studio-route.ts marks it).
    window.history.state = { ddmStudioEntry: true };
    url.syncHeatRiskDayParam(4);
    url.syncFire3dParam(false);
    // Back: the browser already shows the older map entry when the map's state is written back.
    window.history.state = null;
    window.location.search = '?layers=heatrisk&fire3d=true&view=console';
    url.syncUrl({ region: null, layers: new Set(['heatrisk']), embed: false, view: 'console' });
    const back = new URLSearchParams(browser.search());
    assert.equal(back.get('heatday'), '4');
    assert.equal(back.get('fire3d'), null);
    // That write was on the map entry, so the next write reads the location again.
    window.location.search = '?layers=heatrisk&view=console&heatday=2';
    url.syncUrl({ region: null, layers: new Set(['heatrisk']), embed: false, view: 'console' });
    assert.equal(new URLSearchParams(browser.search()).get('heatday'), '2');
  } finally { browser.restore(); }
});

test('every cloning writer keeps its neighbours and normalizes sidebar=', () => {
  const writers = [
    ['heatday', '3', () => url.syncHeatRiskDayParam(3)],
    ['spi', '30', () => url.syncSpiWindowParam(30)],
    ['fire3d', 'true', () => url.syncFire3dParam(true)],
    ['flow', 'wind', () => syncEnsoFlowParams({ kind: 'wind', ink: 'light' })]
  ];
  for (const [key, value, write] of writers) {
    for (const [inbound, kept] of [['sidebar=closed', ['closed']], ['sidebar=open', []], ['embed=true&sidebar=closed', []]]) {
      const browser = installFakeBrowser({ search: `?cluster=wildfire&${inbound}` });
      try {
        write();
        const params = new URLSearchParams(browser.search());
        assert.equal(params.get(key), value, `${key} over ${inbound}`);
        assert.equal(params.get('cluster'), 'wildfire', `${key} over ${inbound}`);
        assert.deepEqual(params.getAll('sidebar'), kept, `${key} over ${inbound}`);
      } finally { browser.restore(); }
    }
  }
});
