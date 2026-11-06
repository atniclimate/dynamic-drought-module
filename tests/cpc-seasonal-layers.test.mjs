import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cpcSeasonalPolygons } from './cpc-seasonal-polygon-fixtures.mjs';

/**
 * The CPC seasonal outlook maps in ENSO mode, against their acceptance
 * sentence (2026-09-25, amended 2026-09-26): the two shipped layers resolve
 * with an issuer and a clock, a failed read is unavailable, the two outlooks
 * on together keep two legends and no combined class, and an in-session
 * entry into ENSO opens on Season ahead while a link without `horizon=`
 * stays Current. The DDM-P16-T09 composite the sentence also names is not
 * built, so its clause is proven between the two outlooks instead.
 *
 * The REAL shipped modules (src/layers/cpc-seasonal-precip.ts and
 * -temp.ts), the real legend registry over a small fake legend panel, and
 * the real cluster service with the sidebar's reconcile wiring. `fetch` is
 * stubbed: no live host decides a result.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

// The legend registry's two hosts (index.html #legend-panel, #legend-sections).
const sections = [];
const panel = { hidden: true };
const container = {
  get children() { return sections; },
  get childElementCount() { return sections.length; },
  querySelector(selector) {
    const key = /data-legend="([^"]+)"/.exec(selector)?.[1];
    return sections.find((section) => section.dataset.legend === key) ?? null;
  },
  insertBefore(node, ref) { sections.splice(sections.indexOf(ref), 0, node); },
  appendChild(node) { sections.push(node); }
};
globalThis.document = {
  getElementById: (id) => (id === 'legend-sections' ? container : id === 'legend-panel' ? panel : null),
  createElement: () => {
    const element = { className: '', dataset: {}, innerHTML: '', remove() {
      const at = sections.indexOf(element);
      if (at >= 0) sections.splice(at, 1);
    } };
    return element;
  }
};

const { LAYER_DEFS, getLayerDef } = await import('../src/config/layers.ts');
const { PRODUCTS } = await import('../src/config/products.ts');
const { URLS } = await import('../src/config/urls.ts');
const { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } = await import('../src/config/clusters.ts');
const { MOBILE_HAZARD_PRESETS } = await import('../src/config/presets.ts');
const { CPC_SEASONAL_COLORS } = await import('../src/config/palette.ts');
const { registry } = await import('../src/state/registry.ts');
const { resolveStatusPillText } = await import('../src/ui/island/pill-text.ts');
const { CPC_SEASONAL_PRODUCTION } = await import('../src/layers/cpc-seasonal-outlook.ts');
const precip = await import('../src/layers/cpc-seasonal-precip.ts');
const temp = await import('../src/layers/cpc-seasonal-temp.ts');

const LAYERS = [
  { key: 'cpc-seasonal-precip', variable: 'precipitation', module: precip, service: 'cpc_sea_precip_outlk', product: 'cpc-seasonal-precip', name: 'Seasonal Precipitation Outlook' },
  { key: 'cpc-seasonal-temp', variable: 'temperature', module: temp, service: 'cpc_sea_temp_outlk', product: 'cpcSeasonalTemp', name: 'Seasonal Temperature Outlook' }
];

function fakeMap() {
  const sources = new Map(), layers = new Map();
  return { sources, layers,
    getSource: (id) => sources.get(id), getLayer: (id) => layers.get(id),
    addSource(id, source) { sources.set(id, { ...source, setData(data) { this.data = data; } }); },
    addLayer(layer) { layers.set(layer.id, layer); },
    removeLayer(id) { layers.delete(id); },
    removeSource(id) { sources.delete(id); }
  };
}

/** One body per service; `clock` restamps every feature's issuer clock. */
function bodyFor(clock) {
  const body = cpcSeasonalPolygons();
  if (clock) for (const feature of body.features) Object.assign(feature.properties, clock);
  return body;
}

async function withFetch(answer, run) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(new URL(url)); return answer(String(url)); };
  try { await run(urls); } finally {
    globalThis.fetch = original;
    for (const { key } of LAYERS) registry.deactivate(key);
  }
}

/** A legend section's rows: the class pair, the swatch fill and outline, the label. */
function legendRows(html) {
  return [...html.matchAll(/<li data-cpc-class="([^"]+)"><span class="swatch" style="background:([^;]+);border-color:([^"]+)"><\/span>([^<]+)<\/li>/g)]
    .map(([, pair, fill, outline, label]) => ({ pair, fill, outline, label }));
}
const clockText = (html) => [...html.matchAll(/<p class="legend-note" data-cpc-clock>([^<]*)<\/p>/g)].map((m) => m[1]);
const section = (key) => sections.find((entry) => entry.dataset.legend === key);

test('both outlooks are registered layers, each a products.ts entry with an issuer and a clock', () => {
  for (const layer of LAYERS) {
    const def = getLayerDef(layer.key);
    assert.ok(def, `${layer.key} is registered`);
    assert.equal(def.name, layer.name);
    assert.equal(def.source, 'NOAA CPC · MapServer');
    // An overlay: the SST surface stays on beside it, and the two stack.
    assert.equal(def.role, 'event');
    assert.equal(def.defaultOn, false);
    assert.equal(def.product, layer.product);
    const product = PRODUCTS[layer.product];
    assert.equal(product.layerKey, layer.key);
    assert.match(product.issuer, /\S/);
    assert.equal(product.clock.register, 'outlook');
    assert.match(product.clock.cadence, /\S/);
    assert.ok(URLS[product.endpointKey].endsWith(`/outlooks/${layer.service}/MapServer`), product.endpointKey);
    // The shipped module is the LayerModule namespace the chunk loader returns.
    for (const name of ['activate', 'deactivate', 'cancelActivation']) assert.equal(typeof layer.module[name], 'function', name);
    assert.deepEqual([...layer.module.fadeLayerIds], [`${layer.key}-fill`, `${layer.key}-line`]);
  }
  assert.deepEqual(CPC_SEASONAL_PRODUCTION, {
    limits: { timeoutMs: 10_000, maxDecodedBytes: 1_000_000, maxFeatures: 200, maxAllowableOffset: 0.05 },
    fillOpacity: 0.48
  });
});

test('the national request is the measured generalized Lead 1 query, one per outlook', async () => {
  await withFetch(() => new Response(JSON.stringify(bodyFor())), async (urls) => {
    for (const layer of LAYERS) {
      const map = fakeMap();
      await layer.module.activate(map);
      layer.module.deactivate(map);
    }
    assert.deepEqual(urls.map((u) => u.pathname), LAYERS.map((l) => `/vector/rest/services/outlooks/${l.service}/MapServer/0/query`));
    for (const url of urls) {
      assert.equal(url.searchParams.get('where'), '1=1');
      assert.equal(url.searchParams.get('returnGeometry'), 'true');
      assert.equal(url.searchParams.get('maxAllowableOffset'), '0.05');
      assert.equal(url.searchParams.get('outFields'), 'cat,prob,valid_seas,fcst_date');
      assert.equal(url.searchParams.has('geometry'), false, 'national, not a point read');
    }
  });
});

test('a failed read is unavailable with nothing drawn and no key, never an empty outlook', async () => {
  const oversize = bodyFor();
  oversize.features[0].properties.padding = 'x'.repeat(CPC_SEASONAL_PRODUCTION.limits.maxDecodedBytes);
  const failures = {
    'HTTP 500': () => new Response('upstream failure', { status: 500 }),
    'ArcGIS error envelope': () => new Response(JSON.stringify({ error: { code: 500, message: 'Fixture failure' } })),
    'network rejection': () => { throw new TypeError('Failed to fetch'); },
    'body over the decoded cap': () => new Response(JSON.stringify(oversize))
  };
  for (const [name, answer] of Object.entries(failures)) {
    for (const layer of LAYERS) {
      await withFetch(answer, async () => {
        const map = fakeMap();
        await layer.module.activate(map);
        assert.equal(registry.getStatus(layer.key), 'error', `${layer.key}: ${name}`);
        assert.equal(resolveStatusPillText('error', getLayerDef(layer.key).noDataLabel), 'unavailable');
        assert.equal(map.sources.size, 0, `${layer.key}: ${name} draws nothing`);
        assert.equal(section(layer.key), undefined, `${layer.key}: ${name} shows no key`);
        layer.module.deactivate(map);
      });
    }
  }
  // The issuer answering with no polygons is a different state, never a failure.
  await withFetch(() => new Response(JSON.stringify({ type: 'FeatureCollection', features: [] })), async () => {
    const map = fakeMap();
    await precip.activate(map);
    assert.equal(registry.getStatus('cpc-seasonal-precip'), 'no-data');
    assert.equal(section('cpc-seasonal-precip'), undefined);
    precip.deactivate(map);
  });
});

test('both outlooks on together keep two legends, each its own 17 issuer classes and clock, and no combined class', async () => {
  const clocks = {
    cpc_sea_precip_outlk: { valid_seas: 'NDJ 2026-2027', fcst_date: Date.UTC(2026, 9, 15) },
    cpc_sea_temp_outlk: { valid_seas: 'DJF 2026-2027', fcst_date: Date.UTC(2026, 10, 19) }
  };
  await withFetch((url) => new Response(JSON.stringify(bodyFor(url.includes('precip') ? clocks.cpc_sea_precip_outlk : clocks.cpc_sea_temp_outlk))), async () => {
    const map = fakeMap();
    await precip.activate(map);
    await temp.activate(map);
    assert.equal(registry.getStatus('cpc-seasonal-precip'), 'ready');
    assert.equal(registry.getStatus('cpc-seasonal-temp'), 'ready');
    assert.equal(panel.hidden, false);
    assert.deepEqual(sections.map((entry) => entry.dataset.legend), ['cpc-seasonal-precip', 'cpc-seasonal-temp']);
    for (const layer of LAYERS) {
      const html = section(layer.key).innerHTML;
      assert.match(html, new RegExp(`<h3 class="legend-section-title">${layer.name}</h3>`));
      const rows = legendRows(html);
      const issuer = CPC_SEASONAL_COLORS[layer.variable];
      // The renderer's 17 classes, in its order, labels verbatim, nothing else.
      assert.equal(rows.length, 17);
      assert.equal((html.match(/<li/g) ?? []).length, 17);
      assert.deepEqual(rows.map((row) => row.label), issuer.map((row) => row.label));
      assert.deepEqual(rows.map((row) => row.pair), issuer.map((row) => `${row.cat},${row.prob}`));
      // Each swatch is its own issuer colour at the map's fill alpha, inside the issuer outline.
      assert.deepEqual(rows.map((row) => row.fill), issuer.map(({ color: [r, g, b, a] }) => `rgba(${r},${g},${b},${(a / 255) * 0.48})`));
      assert.ok(rows.every((row) => row.outline === 'rgb(110,110,110)'));
      // Equal Chances: the issuer's transparent fill inside that outline.
      const ec = rows.find((row) => row.label === 'Equal Chances');
      assert.match(ec.fill, /,0\)$/);
      // Keyed by this outlook's own valid season and product date, never the other's.
      const own = clocks[layer.service];
      assert.deepEqual(clockText(html), [`Valid Season ${own.valid_seas} · Forecast Date ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(own.fcst_date)}`]);
      // The fill reads only this outlook's source and matches only its own 17 pairs.
      const fill = map.layers.get(`${layer.key}-fill`);
      assert.equal(fill.source, layer.key);
      assert.equal(fill.paint['fill-opacity'], 0.48);
      const match = fill.paint['fill-color'];
      const pairs = match.slice(2, -1).filter((_, i) => i % 2 === 0);
      assert.deepEqual(pairs, issuer.map((row) => `${row.cat},${row.prob}`));
      assert.deepEqual(map.layers.get(`${layer.key}-line`).paint, { 'line-color': 'rgb(110,110,110)', 'line-width': 1 });
    }
    // Two products, two clocks: the colours differ where the issuer's do, and no
    // section names the other's season.
    assert.doesNotMatch(section('cpc-seasonal-precip').innerHTML, /DJF 2026-2027/);
    assert.doesNotMatch(section('cpc-seasonal-temp').innerHTML, /NDJ 2026-2027/);
    // Off again: each takes only its own key away.
    temp.deactivate(map);
    assert.deepEqual(sections.map((entry) => entry.dataset.legend), ['cpc-seasonal-precip']);
    precip.deactivate(map);
    assert.equal(sections.length, 0);
    assert.equal(panel.hidden, true);
  });
});

test('polygons stamped with two issuer clocks list both, never one joined issuance', async () => {
  const body = bodyFor({ valid_seas: 'NDJ 2026-2027', fcst_date: Date.UTC(2026, 9, 15) });
  Object.assign(body.features[0].properties, { valid_seas: 'DJF 2026-2027', fcst_date: null });
  await withFetch(() => new Response(JSON.stringify(body)), async () => {
    const map = fakeMap();
    await precip.activate(map);
    assert.deepEqual(clockText(section('cpc-seasonal-precip').innerHTML), ['Valid Season DJF 2026-2027', 'Valid Season NDJ 2026-2027 · Forecast Date Oct 15, 2026']);
    precip.deactivate(map);
  });
});

test('ENSO Season ahead turns the precipitation outlook on over the SST and storms; temperature is the mode\'s, off until chosen', () => {
  const enso = HAZARD_CLUSTERS.enso;
  assert.deepEqual(enso.recipes['season-ahead'], ['sst-anomaly', 'cpc-seasonal-precip', 'tropical-cyclones']);
  for (const horizon of ['current', 'weeks-ahead']) assert.ok(!enso.recipes[horizon].includes('cpc-seasonal-precip'));
  assert.deepEqual(enso.optionalLayers, ['cpc-seasonal-temp', 'nws-alerts']);
  for (const key of HAZARD_CLUSTER_KEYS) {
    for (const recipe of Object.values(HAZARD_CLUSTERS[key].recipes)) assert.ok(!recipe.includes('cpc-seasonal-temp'));
  }
  // Every mode-level read is N-mode: only ENSO declares an entry horizon today.
  assert.deepEqual(HAZARD_CLUSTER_KEYS.filter((key) => HAZARD_CLUSTERS[key].entryHorizon), ['enso']);
  assert.equal(enso.entryHorizon, 'season-ahead');
  // The phone rail names its mode; the ENSO face shows the outlook it commits.
  const rail = MOBILE_HAZARD_PRESETS.find((preset) => preset.mode === 'enso');
  assert.deepEqual(rail.layers, ['sst-anomaly', 'cpc-seasonal-precip', 'aiannh']);
  assert.deepEqual(MOBILE_HAZARD_PRESETS.map((preset) => preset.mode).sort(), [...HAZARD_CLUSTER_KEYS].sort());
  assert.ok(LAYER_DEFS.filter((def) => def.key.startsWith('cpc-seasonal')).every((def) => def.role !== 'surface'));
});

test('an in-session entry into ENSO commits Season ahead; a re-press, an ocean change and a horizon change keep the person\'s horizon; a link keeps its own', async () => {
  const { installFakeBrowser } = await import('./map-harness.ts');
  const service = await import('../src/state/cluster-service.ts');
  const { parseUrlParams } = await import('../src/state/url.ts');
  const { timeline } = await import('../src/state/timeline.ts');
  const { setHazardCluster } = await import('../src/state/cluster-store.ts');
  const { checkedSnapshot, onCheckedChange, setChecked } = await import('../src/ui/island/bridge.ts');
  const { bindLayerToggleController, requestLayerOn } = await import('../src/ui/layer-toggle-command.ts');
  // The tests/cluster-service.spec.ts harness: registry effects only, and the
  // sidebar's reconcile on every checkbox flip.
  bindLayerToggleController({
    activate(key) { registry.setStatus(key, 'loading'); registry.activate(key); registry.setStatus(key, 'ready'); return Promise.resolve(); },
    deactivate(key) { registry.deactivate(key); },
    applyPreset() { throw new Error('not on this path'); },
    applyLayerSet() { throw new Error('not on this path'); }
  });
  const on = () => new Set([...checkedSnapshot()].filter(([, checked]) => checked).map(([key]) => key));
  const unsubscribe = onCheckedChange(() => service.reconcileClusterWithLayerIntent(on()));
  const boot = (search) => {
    const browser = installFakeBrowser({ search });
    try { return parseUrlParams(); } finally { browser.restore(); }
  };
  const reset = () => {
    for (const key of on()) setChecked(key, false);
    for (const key of registry.getActiveKeys()) registry.deactivate(key);
    timeline.reset();
    setHazardCluster('drought', null);
    service.requestCluster('drought');
  };
  const dispose = service.initClusterService();
  try {
    // The mode switcher, from Drought at Current.
    reset();
    service.requestCluster('enso');
    let snap = service.getCommittedSnapshot();
    assert.equal(snap.cluster, 'enso');
    assert.equal(snap.horizon, 'season-ahead');
    assert.equal(timeline.horizon, 'season-ahead');
    assert.ok(snap.intendedKeys.has('cpc-seasonal-precip') && snap.intendedKeys.has('sst-anomaly'));
    assert.ok(!snap.intendedKeys.has('cpc-seasonal-temp'));
    assert.ok(registry.getActiveKeys().has('cpc-seasonal-precip'));
    // The person's own horizon inside ENSO holds through a re-press and an ocean change.
    service.requestHorizon('current');
    assert.equal(service.getCommittedSnapshot().horizon, 'current');
    assert.ok(!registry.getActiveKeys().has('cpc-seasonal-precip'));
    service.requestCluster('enso');
    service.requestOcean('pacific');
    snap = service.getCommittedSnapshot();
    assert.equal(snap.horizon, 'current');
    assert.ok(!snap.intendedKeys.has('cpc-seasonal-precip'));
    // The temperature outlook on top keeps the mode pressed.
    service.requestHorizon('season-ahead');
    requestLayerOn('cpc-seasonal-temp');
    snap = service.getCommittedSnapshot();
    assert.equal(snap.cluster, 'enso');
    assert.ok(snap.intendedKeys.has('cpc-seasonal-temp') && snap.intendedKeys.has('cpc-seasonal-precip'));
    // The minimap ocean door, from Wildfire at Current.
    reset();
    service.requestCluster('wildfire');
    service.requestOcean('atlantic');
    snap = service.getCommittedSnapshot();
    assert.equal(snap.cluster, 'enso');
    assert.equal(snap.horizon, 'season-ahead');
    assert.ok(snap.intendedKeys.has('cpc-seasonal-precip'));
    // Leaving ENSO keeps the DR-190 rule for the destination.
    service.requestCluster('heat');
    assert.equal(service.getCommittedSnapshot().horizon, 'current');
  } finally {
    unsubscribe();
    dispose();
    reset();
  }
  // An inbound link keeps its URL's horizon; absent means Current, on the SST anomaly.
  const old = boot('?cluster=enso');
  assert.equal(old.horizon, 'current');
  assert.ok(old.layers.has('sst-anomaly'));
  assert.ok(!old.layers.has('cpc-seasonal-precip'));
  const shared = boot('?cluster=enso&horizon=season-ahead');
  assert.equal(shared.horizon, 'season-ahead');
  assert.ok(shared.layers.has('cpc-seasonal-precip'));
});
