import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CPC_EXTENDED_CLASSES, CPC_EXTENDED_RENDERER, cpcExtendedPolygons, cpcSeasonalPolygons } from './cpc-seasonal-polygon-fixtures.mjs';

/**
 * The CPC outlook maps in ENSO mode. The seasonal pair answers its acceptance
 * sentence (2026-09-25, amended 2026-09-26); the 6-10 and 8-14 day four are
 * built to the same terms (no sentence of their own was ratified): each
 * shipped layer resolves with an issuer and a clock, a failed read is
 * unavailable, any of them on together keep their own legends and no combined
 * class, and an in-session entry into ENSO opens on Season ahead while a link
 * keeps its own horizon. The DDM-P16-T09 composite the seasonal sentence also
 * names is not built, so its clause is proven between the outlooks instead.
 *
 * The REAL shipped modules (src/layers/cpc-*.ts), the real legend registry
 * over a small fake legend panel, and the real cluster service with the
 * sidebar's reconcile wiring. `fetch` is stubbed: no live host decides a result.
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
const { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS, TEMPORAL_HORIZON_KEYS } = await import('../src/config/clusters.ts');
const { MOBILE_HAZARD_PRESETS } = await import('../src/config/presets.ts');
const { CPC_EXTENDED_COLORS, CPC_SEASONAL_COLORS } = await import('../src/config/palette.ts');
const { registry } = await import('../src/state/registry.ts');
const { resolveStatusPillText } = await import('../src/ui/island/pill-text.ts');
const { clusterHorizonReason } = await import('../src/ui/horizon-reason.ts');
const { CPC_SEASONAL_PRODUCTION } = await import('../src/layers/cpc-seasonal-outlook.ts');

const SEASONAL_FIELDS = 'cat,prob,valid_seas,fcst_date';
const EXTENDED_FIELDS = 'cat,prob,fcst_date,start_date,end_date';
const LAYERS = [
  { key: 'cpc-seasonal-precip', variable: 'precipitation', seasonal: true, service: 'cpc_sea_precip_outlk', layer: 0, product: 'cpc-seasonal-precip', lane: null, name: 'Seasonal Precipitation Outlook' },
  { key: 'cpc-seasonal-temp', variable: 'temperature', seasonal: true, service: 'cpc_sea_temp_outlk', layer: 0, product: 'cpcSeasonalTemp', lane: 'cpcSeasonalTemp', name: 'Seasonal Temperature Outlook' },
  { key: 'cpc-610-precip', variable: 'precipitation', seasonal: false, service: 'cpc_6_10_day_outlk', layer: 1, product: 'cpc-610-precip', lane: 'cpcExtended', name: '6-10 Day Precipitation Outlook' },
  { key: 'cpc-610-temp', variable: 'temperature', seasonal: false, service: 'cpc_6_10_day_outlk', layer: 0, product: 'cpc-610-temp', lane: 'cpcExtended', name: '6-10 Day Temperature Outlook' },
  { key: 'cpc-814-precip', variable: 'precipitation', seasonal: false, service: 'cpc_8_14_day_outlk', layer: 1, product: 'cpc-814-precip', lane: 'cpcExtended', name: '8-14 Day Precipitation Outlook' },
  { key: 'cpc-814-temp', variable: 'temperature', seasonal: false, service: 'cpc_8_14_day_outlk', layer: 0, product: 'cpc-814-temp', lane: 'cpcExtended', name: '8-14 Day Temperature Outlook' }
];
for (const layer of LAYERS) {
  layer.module = await import(`../src/layers/${layer.key}.ts`);
  layer.path = `/vector/rest/services/outlooks/${layer.service}/MapServer/${layer.layer}/query`;
  layer.issuer = (layer.seasonal ? CPC_SEASONAL_COLORS : CPC_EXTENDED_COLORS)[layer.variable];
}
const byKey = (key) => LAYERS.find((layer) => layer.key === key);
const layerFor = (url) => LAYERS.find((layer) => new URL(url).pathname === layer.path);
const day = (time) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(time);

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

/** One body per layer: its own renderer's classes; `clock` restamps every feature's issuer clock. */
function bodyFor(layer, clock) {
  const body = layer.seasonal ? cpcSeasonalPolygons() : cpcExtendedPolygons();
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

test('every outlook is a registered layer, each a products.ts entry with an issuer, a clock and its lane', () => {
  for (const layer of LAYERS) {
    const def = getLayerDef(layer.key);
    assert.ok(def, `${layer.key} is registered`);
    assert.equal(def.name, layer.name);
    assert.equal(def.source, 'NOAA CPC · MapServer');
    // An overlay: the SST surface stays on beside it, and any two stack.
    assert.equal(def.role, 'event');
    assert.equal(def.defaultOn, false);
    assert.equal(def.product, layer.product);
    const product = PRODUCTS[layer.product];
    assert.equal(product.layerKey, layer.key);
    assert.equal(product.lane, layer.lane);
    assert.match(product.issuer, /\S/);
    assert.equal(product.clock.register, 'outlook');
    assert.equal(product.clock.cadence, layer.seasonal ? 'monthly' : 'daily');
    assert.ok(URLS[product.endpointKey].endsWith(`/outlooks/${layer.service}/MapServer`), product.endpointKey);
    // The shipped module is the LayerModule namespace the chunk loader returns.
    for (const name of ['activate', 'deactivate', 'cancelActivation']) assert.equal(typeof layer.module[name], 'function', name);
    assert.deepEqual([...layer.module.fadeLayerIds], [`${layer.key}-fill`, `${layer.key}-line`]);
  }
  // The briefing lane's own product still names the two day-range services.
  assert.equal(PRODUCTS.cpcExtended.lane, 'cpcExtended');
  assert.deepEqual(CPC_SEASONAL_PRODUCTION, {
    limits: { timeoutMs: 10_000, maxDecodedBytes: 1_000_000, maxFeatures: 200, maxAllowableOffset: 0.05 },
    fillOpacity: 0.48
  });
});

test('a product a layer draws names that layer\'s source line as its issuer (audit R2-32)', () => {
  // cpcSeasonalTemp is the briefing lane's product and names the agency in full on purpose.
  const drawn = LAYER_DEFS.filter((def) => PRODUCTS[def.product]?.layerKey === def.key && def.product !== 'cpcSeasonalTemp');
  assert.ok(drawn.length >= 29, `only ${drawn.length} layer products compared`);
  for (const def of drawn) assert.equal(PRODUCTS[def.product].issuer, def.source, def.key);
});

test('the day-range palette is the two services\' renderers verbatim, outline widths included', () => {
  for (const [variable, fixture] of [['precipitation', 'precip'], ['temperature', 'temp']]) {
    const rows = CPC_EXTENDED_COLORS[variable];
    assert.deepEqual(rows.map(({ cat, prob, label }) => ({ cat, prob, label })), CPC_EXTENDED_CLASSES);
    assert.deepEqual(rows.map((row) => [...row.color]), CPC_EXTENDED_RENDERER[fixture].colors);
    assert.deepEqual(rows.map((row) => row.outline), CPC_EXTENDED_RENDERER[fixture].widths);
    assert.ok(!rows.some((row) => row.cat === 'EC'), 'the day-range renderers draw no Equal Chances class');
  }
});

test('each national request is the measured generalized query of its own REST layer', async () => {
  await withFetch((url) => new Response(JSON.stringify(bodyFor(layerFor(url)))), async (urls) => {
    for (const layer of LAYERS) {
      const map = fakeMap();
      await layer.module.activate(map);
      assert.equal(registry.getStatus(layer.key), 'ready', layer.key);
      layer.module.deactivate(map);
    }
    assert.deepEqual(urls.map((u) => u.pathname), LAYERS.map((l) => l.path));
    for (const [i, url] of urls.entries()) {
      assert.equal(url.searchParams.get('where'), '1=1');
      assert.equal(url.searchParams.get('returnGeometry'), 'true');
      assert.equal(url.searchParams.get('maxAllowableOffset'), '0.05');
      assert.equal(url.searchParams.get('outFields'), LAYERS[i].seasonal ? SEASONAL_FIELDS : EXTENDED_FIELDS);
      assert.equal(url.searchParams.has('geometry'), false, 'national, not a point read');
    }
  });
});

test('a failed read is unavailable with nothing drawn and no key, never an empty outlook', async () => {
  const failures = {
    'HTTP 500': () => new Response('upstream failure', { status: 500 }),
    'ArcGIS error envelope': () => new Response(JSON.stringify({ error: { code: 500, message: 'Fixture failure' } })),
    'network rejection': () => { throw new TypeError('Failed to fetch'); },
    'body over the decoded cap': (url) => {
      const oversize = bodyFor(layerFor(url));
      oversize.features[0].properties.padding = 'x'.repeat(CPC_SEASONAL_PRODUCTION.limits.maxDecodedBytes);
      return new Response(JSON.stringify(oversize));
    }
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
  for (const key of ['cpc-seasonal-precip', 'cpc-814-precip']) {
    await withFetch(() => new Response(JSON.stringify({ type: 'FeatureCollection', features: [] })), async () => {
      const map = fakeMap();
      await byKey(key).module.activate(map);
      assert.equal(registry.getStatus(key), 'no-data');
      assert.equal(section(key), undefined);
      byKey(key).module.deactivate(map);
    });
  }
});

test('a day-range class outside the issuer\'s renderer is not drawn and reads partial; an answer with nothing inside it is unavailable', async () => {
  // The day-range renderers carry no Equal Chances row and one Near Normal pair (Normal,36).
  for (const key of ['cpc-610-temp', 'cpc-814-precip']) {
    const layer = byKey(key);
    for (const outside of [{ cat: 'EC', prob: 33 }, { cat: 'Normal', prob: 40 }]) {
      const mixed = bodyFor(layer);
      const total = mixed.features.length;
      Object.assign(mixed.features[0].properties, outside);
      await withFetch(() => new Response(JSON.stringify(mixed)), async () => {
        const map = fakeMap();
        await layer.module.activate(map);
        assert.equal(registry.getStatus(key), 'degraded', `${key}: ${outside.cat},${outside.prob}`);
        assert.equal(map.sources.get(key).data.features.length, total - 1, 'the pair outside the renderer is not drawn');
        layer.module.deactivate(map);
      });
      const alone = bodyFor(layer);
      alone.features = [{ ...alone.features[0], properties: { ...alone.features[0].properties, ...outside } }];
      await withFetch(() => new Response(JSON.stringify(alone)), async () => {
        const map = fakeMap();
        await layer.module.activate(map);
        assert.equal(registry.getStatus(key), 'error', `${key}: only ${outside.cat},${outside.prob}`);
        assert.equal(map.sources.size, 0);
        layer.module.deactivate(map);
      });
    }
  }
});

test('all six outlooks on together keep six legends, each its own issuer classes and clock, and no combined class', async () => {
  const clocks = {
    cpc_sea_precip_outlk: { valid_seas: 'NDJ 2026-2027', fcst_date: Date.UTC(2026, 9, 15) },
    cpc_sea_temp_outlk: { valid_seas: 'DJF 2026-2027', fcst_date: Date.UTC(2026, 10, 19) },
    cpc_6_10_day_outlk: { fcst_date: Date.UTC(2026, 10, 5), start_date: Date.UTC(2026, 10, 11), end_date: Date.UTC(2026, 10, 15) },
    cpc_8_14_day_outlk: { fcst_date: Date.UTC(2026, 10, 6), start_date: Date.UTC(2026, 10, 14), end_date: Date.UTC(2026, 10, 20) }
  };
  const clockLine = (layer) => {
    const own = clocks[layer.service];
    return layer.seasonal
      ? `Valid Season ${own.valid_seas} · Forecast Date ${day(own.fcst_date)}`
      : `Start Date ${day(own.start_date)} · End Date ${day(own.end_date)} · Forecast Date ${day(own.fcst_date)}`;
  };
  await withFetch((url) => new Response(JSON.stringify(bodyFor(layerFor(url), clocks[layerFor(url).service]))), async () => {
    const map = fakeMap();
    for (const layer of LAYERS) await layer.module.activate(map);
    for (const layer of LAYERS) assert.equal(registry.getStatus(layer.key), 'ready', layer.key);
    assert.equal(panel.hidden, false);
    assert.deepEqual(sections.map((entry) => entry.dataset.legend), LAYERS.map((layer) => layer.key));
    for (const layer of LAYERS) {
      const html = section(layer.key).innerHTML;
      assert.match(html, new RegExp(`<h3 class="legend-section-title">${layer.name}</h3>`));
      const rows = legendRows(html);
      // The renderer's classes, in its order, labels verbatim, nothing else.
      assert.equal(rows.length, layer.seasonal ? 17 : 15);
      assert.equal((html.match(/<li/g) ?? []).length, rows.length);
      assert.deepEqual(rows.map((row) => row.label), layer.issuer.map((row) => row.label));
      assert.deepEqual(rows.map((row) => row.pair), layer.issuer.map((row) => `${row.cat},${row.prob}`));
      // Each swatch is its own issuer colour at the map's fill alpha, inside the issuer outline.
      assert.deepEqual(rows.map((row) => row.fill), layer.issuer.map(({ color: [r, g, b, a] }) => `rgba(${r},${g},${b},${(a / 255) * 0.48})`));
      assert.ok(rows.every((row) => row.outline === 'rgb(110,110,110)'));
      if (layer.seasonal) assert.match(rows.find((row) => row.label === 'Equal Chances').fill, /,0\)$/);
      // Keyed by this outlook's own issuer clock fields, never another's.
      assert.deepEqual(clockText(html), [clockLine(layer)]);
      for (const other of LAYERS) {
        if (other.service !== layer.service) assert.ok(!clockText(html).includes(clockLine(other)), `${layer.key} names ${other.key}'s clock`);
      }
      // The fill reads only this outlook's source and matches only its own pairs.
      const fill = map.layers.get(`${layer.key}-fill`);
      assert.equal(fill.source, layer.key);
      assert.equal(fill.paint['fill-opacity'], 0.48);
      const pairs = fill.paint['fill-color'].slice(2, -1).filter((_, i) => i % 2 === 0);
      assert.deepEqual(pairs, layer.issuer.map((row) => `${row.cat},${row.prob}`));
      // The outline is the renderer's colour at its own width per class.
      const line = map.layers.get(`${layer.key}-line`);
      assert.equal(line.source, layer.key);
      assert.equal(line.paint['line-color'], 'rgb(110,110,110)');
      const width = line.paint['line-width'];
      if (layer.seasonal) assert.equal(width, 1);
      else assert.deepEqual(width.slice(2), [...layer.issuer.flatMap((row) => [`${row.cat},${row.prob}`, row.outline]), 1]);
    }
    // Off again: each takes only its own key away.
    byKey('cpc-610-temp').module.deactivate(map);
    assert.deepEqual(sections.map((entry) => entry.dataset.legend), LAYERS.map((layer) => layer.key).filter((key) => key !== 'cpc-610-temp'));
    for (const layer of LAYERS) layer.module.deactivate(map);
    assert.equal(sections.length, 0);
    assert.equal(panel.hidden, true);
  });
});

test('polygons stamped with two issuer clocks list both, never one joined issuance', async () => {
  const body = bodyFor(byKey('cpc-seasonal-precip'), { valid_seas: 'NDJ 2026-2027', fcst_date: Date.UTC(2026, 9, 15) });
  Object.assign(body.features[0].properties, { valid_seas: 'DJF 2026-2027', fcst_date: null });
  const days = bodyFor(byKey('cpc-814-precip'));
  Object.assign(days.features[0].properties, { start_date: Date.UTC(2026, 10, 13), end_date: Date.UTC(2026, 10, 19) });
  await withFetch((url) => new Response(JSON.stringify(layerFor(url).seasonal ? body : days)), async () => {
    const map = fakeMap();
    await byKey('cpc-seasonal-precip').module.activate(map);
    await byKey('cpc-814-precip').module.activate(map);
    assert.deepEqual(clockText(section('cpc-seasonal-precip').innerHTML), ['Valid Season DJF 2026-2027', 'Valid Season NDJ 2026-2027 · Forecast Date Oct 15, 2026']);
    assert.deepEqual(clockText(section('cpc-814-precip').innerHTML), [
      'Start Date Nov 13, 2026 · End Date Nov 19, 2026 · Forecast Date Nov 5, 2026',
      'Start Date Nov 11, 2026 · End Date Nov 15, 2026 · Forecast Date Nov 5, 2026'
    ]);
    for (const layer of LAYERS) layer.module.deactivate(map);
  });
});

test('ENSO draws the 8-14 day precipitation outlook at Weeks ahead and the seasonal one at Season ahead; the other four are the mode\'s, off until chosen', () => {
  const enso = HAZARD_CLUSTERS.enso;
  assert.deepEqual(enso.recipes.current, ['sst-anomaly', 'tropical-cyclones']);
  assert.deepEqual(enso.recipes['weeks-ahead'], ['sst-anomaly', 'cpc-814-precip', 'tropical-cyclones']);
  assert.deepEqual(enso.recipes['season-ahead'], ['sst-anomaly', 'cpc-seasonal-precip', 'tropical-cyclones']);
  assert.deepEqual(enso.optionalLayers, ['cpc-seasonal-temp', 'cpc-610-precip', 'cpc-610-temp', 'cpc-814-temp', 'nws-alerts']);
  for (const key of HAZARD_CLUSTER_KEYS) {
    for (const recipe of Object.values(HAZARD_CLUSTERS[key].recipes)) {
      // The alert layer is ENSO-optional too, but it is the heat recipe's own member.
      for (const optional of enso.optionalLayers.filter((k) => k.startsWith('cpc-'))) assert.ok(!recipe.includes(optional), `${key} recipe holds ${optional}`);
    }
  }
  // Every ENSO horizon is now its own map, so no chip of it is a duplicate.
  for (const horizon of TEMPORAL_HORIZON_KEYS) assert.equal(clusterHorizonReason('enso', horizon), null, horizon);
  // Every mode-level read is N-mode: only ENSO declares an entry horizon today.
  assert.deepEqual(HAZARD_CLUSTER_KEYS.filter((key) => HAZARD_CLUSTERS[key].entryHorizon), ['enso']);
  assert.equal(enso.entryHorizon, 'season-ahead');
  // The phone rail names its mode; the ENSO face shows the outlook it commits.
  const rail = MOBILE_HAZARD_PRESETS.find((preset) => preset.mode === 'enso');
  assert.deepEqual(rail.layers, ['sst-anomaly', 'cpc-seasonal-precip', 'aiannh']);
  assert.deepEqual(MOBILE_HAZARD_PRESETS.map((preset) => preset.mode).sort(), [...HAZARD_CLUSTER_KEYS].sort());
  assert.ok(LAYER_DEFS.filter((def) => def.key.startsWith('cpc-')).every((def) => def.role !== 'surface'));
});

test('an in-session entry into ENSO commits Season ahead and leaving undoes it; a re-press, an ocean change and a horizon change keep the person\'s horizon; a link keeps its own', async () => {
  const { installFakeBrowser } = await import('./map-harness.ts');
  const service = await import('../src/state/cluster-service.ts');
  const { parseUrlParams } = await import('../src/state/url.ts');
  const { timeline } = await import('../src/state/timeline.ts');
  const { setHazardCluster } = await import('../src/state/cluster-store.ts');
  const { checkedSnapshot, onCheckedChange, setChecked } = await import('../src/ui/island/bridge.ts');
  const { bindLayerToggleController, requestLayerOff, requestLayerOn, requestLayerOnExact } = await import('../src/ui/layer-toggle-command.ts');
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
    assert.ok(!snap.intendedKeys.has('cpc-seasonal-temp') && !snap.intendedKeys.has('cpc-814-precip'));
    assert.ok(registry.getActiveKeys().has('cpc-seasonal-precip'));
    // Weeks ahead: the 8-14 day precipitation outlook replaces the seasonal one.
    service.requestHorizon('weeks-ahead');
    snap = service.getCommittedSnapshot();
    assert.equal(snap.horizon, 'weeks-ahead');
    assert.ok(snap.intendedKeys.has('cpc-814-precip') && !snap.intendedKeys.has('cpc-seasonal-precip'));
    assert.ok(registry.getActiveKeys().has('cpc-814-precip') && !registry.getActiveKeys().has('cpc-seasonal-precip'));
    // Another day-range outlook on top keeps the mode pressed.
    requestLayerOn('cpc-610-temp');
    snap = service.getCommittedSnapshot();
    assert.equal(snap.cluster, 'enso');
    assert.ok(snap.intendedKeys.has('cpc-610-temp') && snap.intendedKeys.has('cpc-814-precip'));
    // The person's own horizon inside ENSO holds through a re-press and an ocean change.
    service.requestHorizon('current');
    assert.equal(service.getCommittedSnapshot().horizon, 'current');
    assert.ok(!registry.getActiveKeys().has('cpc-814-precip') && !registry.getActiveKeys().has('cpc-610-temp'));
    service.requestCluster('enso');
    service.requestOcean('pacific');
    snap = service.getCommittedSnapshot();
    assert.equal(snap.horizon, 'current');
    assert.ok(!snap.intendedKeys.has('cpc-seasonal-precip') && !snap.intendedKeys.has('cpc-814-precip'));
    // The seasonal temperature outlook on top keeps the mode pressed.
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

    // Leaving undoes the horizon the entry imposed, for every mode with no entry horizon of its own.
    for (const dest of HAZARD_CLUSTER_KEYS.filter((key) => !HAZARD_CLUSTERS[key].entryHorizon)) {
      reset();
      service.requestCluster('enso');
      service.requestCluster('enso');
      assert.equal(timeline.horizon, 'season-ahead', 'a re-press keeps the horizon');
      service.requestCluster(dest);
      assert.equal(timeline.horizon, 'current', dest);
      assert.equal(service.getCommittedSnapshot().horizon, 'current', dest);
      assert.deepEqual([...service.getCommittedSnapshot().intendedKeys], service.composeClusterIntent(dest, 'current'), dest);
    }
    // The horizon picked before entering comes back.
    reset();
    service.requestHorizon('weeks-ahead');
    service.requestCluster('enso');
    assert.equal(timeline.horizon, 'season-ahead');
    service.requestCluster('drought');
    assert.equal(service.getCommittedSnapshot().horizon, 'weeks-ahead');
    // A horizon picked inside ENSO carries out of it.
    reset();
    service.requestHorizon('weeks-ahead');
    service.requestCluster('enso');
    service.requestHorizon('current');
    service.requestCluster('drought');
    assert.equal(service.getCommittedSnapshot().horizon, 'current');
    reset();
    service.requestCluster('enso');
    service.requestHorizon('weeks-ahead');
    assert.equal(timeline.horizon, 'weeks-ahead');
    service.requestCluster('drought');
    assert.equal(service.getCommittedSnapshot().horizon, 'weeks-ahead');
    // A pick back to the entry horizon is still the person's.
    reset();
    service.requestCluster('enso');
    service.requestHorizon('weeks-ahead');
    service.requestHorizon('season-ahead');
    service.requestCluster('wildfire');
    assert.equal(service.getCommittedSnapshot().horizon, 'season-ahead');
    // A link's Season ahead was never imposed by an entry, so it carries.
    reset();
    timeline.setHorizon('season-ahead');
    setHazardCluster('enso', null);
    service.requestCluster('drought');
    assert.equal(service.getCommittedSnapshot().horizon, 'season-ahead');
    // A reference layer demotes the entry to a custom set, which keeps the held horizon.
    reset();
    requestLayerOn('places');
    service.requestCluster('enso');
    snap = service.getCommittedSnapshot();
    assert.equal(snap.cluster, 'custom');
    assert.equal(timeline.horizon, 'current', 'no horizon= in the link');
    assert.ok(snap.intendedKeys.has('sst-anomaly') && snap.intendedKeys.has('places'));
    assert.ok(!snap.intendedKeys.has('cpc-seasonal-precip'));
    service.requestCluster('enso');
    assert.equal(timeline.horizon, 'current');
    // The phone rail: an ENSO preset commits Season ahead, a later preset of another mode undoes it.
    const tapPreset = (mode) => {
      const preset = MOBILE_HAZARD_PRESETS.find((entry) => entry.mode === mode);
      for (const key of on()) if (!preset.layers.includes(key)) requestLayerOff(key);
      for (const key of preset.layers) requestLayerOnExact(key);
      service.requestPresetHorizon(mode);
    };
    reset();
    for (const mode of HAZARD_CLUSTER_KEYS.filter((key) => !HAZARD_CLUSTERS[key].entryHorizon)) {
      tapPreset('enso');
      assert.equal(timeline.horizon, 'season-ahead');
      tapPreset('enso');
      assert.equal(timeline.horizon, 'season-ahead');
      tapPreset(mode);
      assert.equal(timeline.horizon, 'current', mode);
      assert.equal(service.getCommittedSnapshot().cluster, 'custom');
    }
    // Otherwise a preset leaves the horizon where it is.
    service.requestHorizon('weeks-ahead');
    tapPreset('heat');
    assert.equal(timeline.horizon, 'weeks-ahead');
  } finally {
    unsubscribe();
    dispose();
    reset();
  }
  // An inbound link keeps its URL's horizon; absent means Current, on the SST anomaly.
  const old = boot('?cluster=enso');
  assert.equal(old.horizon, 'current');
  assert.ok(old.layers.has('sst-anomaly'));
  assert.ok(!old.layers.has('cpc-seasonal-precip') && !old.layers.has('cpc-814-precip'));
  const shared = boot('?cluster=enso&horizon=season-ahead');
  assert.equal(shared.horizon, 'season-ahead');
  assert.ok(shared.layers.has('cpc-seasonal-precip'));
  const weeks = boot('?cluster=enso&horizon=weeks-ahead');
  assert.equal(weeks.horizon, 'weeks-ahead');
  assert.ok(weeks.layers.has('cpc-814-precip') && !weeks.layers.has('cpc-seasonal-precip'));
});
