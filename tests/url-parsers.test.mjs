import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// url.ts imports its config extensionless (the flow-mode-url.test.mjs loader).
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
const { installFakeBrowser } = await import('./map-harness.ts');
const { deriveViewMode } = await import('../src/state/view-mode.ts');

/** Audit 4 item 9: each URL parser's accepted and rejected values, as a table. */
const P = (search) => new URLSearchParams(search);
const TABLE = [
  ['parseStudioParam', (s) => url.parseStudioParam(s), [
    ['layers', 'layers'], ['place', 'place'], [null, null], ['', null], ['Layers', null], ['place ', null]
  ]],
  ['parseEmbedParam', (s) => url.parseEmbedParam(P(s)), [
    ['embed=true', true], ['embed=1', true], ['', false], ['embed=yes', false], ['embed=TRUE', false],
    ['embed=1&embed=0', true], ['embed=0&embed=1', false]
  ]],
  ['parseSidebarParam', (s) => url.parseSidebarParam(P(s)), [
    ['sidebar=closed', true], ['', false], ['sidebar=open', false], ['sidebar=Closed', false],
    ['sidebar=closed&sidebar=closed', false]
  ]],
  ['parseHeatRiskDayParam', (s) => url.parseHeatRiskDayParam(P(s)), [
    ['heatday=1', 1], ['heatday=7', 7], ['', null], ['heatday=0', null], ['heatday=01', null], ['heatday=-2', null],
    ['heatday=2.5', null], ['heatday=x', null], ['heatday=2&heatday=3', null], ['heatday=99999999999999999999', null]
  ]],
  ['parseSpiWindowParam', (s) => url.parseSpiWindowParam(P(s)), [
    ['spi=30', 30], ['spi=60', 60], ['spi=180', 180], ['spi=365', 365], ['spi=90', null], ['', null],
    ['spi=45', null], ['spi=030', null], ['spi=30&spi=60', null]
  ]],
  ['parseFire3dParam', (s) => url.parseFire3dParam(P(s)), [
    ['fire3d=true', true], ['', false], ['fire3d=1', false], ['fire3d=True', false], ['fire3d=true&fire3d=true', false]
  ]],
  ['parseSelectParam', (s) => {
    const browser = installFakeBrowser({ search: s });
    try { return url.parseSelectParam(); } finally { browser.restore(); }
  }, [
    ['?select=state:WA', { kind: 'state', id: 'WA' }], ['?select=STATE: or ', { kind: 'state', id: 'or' }],
    ['', null], ['?select=state:', null], ['?select=state:WAS', null], ['?select=state:W1', null],
    ['?select=:WA', null], ['?select=county:WA', null], ['?select=WA', null], ['?select=state:<b>hi</b>', null]
  ]],
  // Brief unless view=console; only an embed keeps the display-link rule (owner, 2026-10-19).
  ['deriveViewMode', (s) => deriveViewMode(P(s)), [
    ['', 'brief'], ['?cluster=wildfire', 'brief'], ['?cluster=enso&ocean=pacific', 'brief'],
    ['?framing=arid-west', 'brief'], ['?region=washington_state&layers=states', 'brief'],
    ['?select=state:WA&cluster=wildfire', 'brief'], ['?view=console&cluster=heat', 'console'],
    ['?view=brief&cluster=heat', 'brief'], ['?view=bogus&layers=usdm', 'brief'],
    ['?embed=true&layers=usdm', 'console'], ['?embed=1&cluster=wildfire', 'console'],
    ['?embed=true&select=state:WA&layers=states', 'brief'], ['?embed=true', 'brief'],
    ['?embed=yes&layers=usdm', 'brief']
  ]]
];

// A mode's optional layer beyond its recipe (Fuel risk over Wildfire) is not
// the mode's link: the link writes `layers=` beside the mode token, so a share
// or reload keeps the layer, the mode and the mode's base map.
test('a mode plus an optional layer beyond its recipe round-trips the mode, the layers and the base map', async () => {
  const { HAZARD_CLUSTERS } = await import('../src/config/clusters.ts');
  const { getLayerDef } = await import('../src/config/layers.ts');
  const { composeClusterIntent } = await import('../src/state/cluster-service.ts');
  const { defaultBasemapFor } = await import('../src/state/basemap-store.ts');
  const sync = (cluster, horizon, layers) => {
    const browser = installFakeBrowser({ search: '' });
    try {
      url.syncUrl({ region: null, layers, embed: false, view: 'console', cluster, horizon, basemap: defaultBasemapFor(cluster) });
      return new URLSearchParams(browser.search());
    } finally { browser.restore(); }
  };
  const reload = (params) => {
    const browser = installFakeBrowser({ search: `?${params}` });
    try { return url.parseUrlParams(); } finally { browser.restore(); }
  };
  let checked = 0;
  for (const [cluster, def] of Object.entries(HAZARD_CLUSTERS)) {
    if (def.urlToken === null) continue;
    for (const [horizon, recipe] of Object.entries(def.recipes)) {
      const base = composeClusterIntent(cluster, horizon);
      assert.equal(sync(cluster, horizon, new Set(base)).get('cluster'), def.urlToken, `${cluster} ${horizon} clean`);
      for (const extra of def.optionalLayers ?? []) {
        if (recipe.includes(extra)) continue;
        // The optional surface stands in for the recipe's surface (one-surface rule).
        const shown = new Set([
          ...base.filter((key) => getLayerDef(extra)?.role !== 'surface' || getLayerDef(key)?.role !== 'surface'),
          extra
        ]);
        const params = sync(cluster, horizon, shown);
        const label = `${cluster} ${horizon} + ${extra}`;
        assert.equal(params.get('cluster'), def.urlToken, label);
        assert.deepEqual(new Set(params.get('layers')?.split(',')), shown, label);
        const back = reload(params);
        assert.equal(back.cluster, cluster, `${label} reload`);
        assert.equal(back.horizon, horizon, `${label} reload`);
        assert.deepEqual(back.layers, shown, `${label} reload`);
        assert.equal(back.basemap, defaultBasemapFor(cluster), `${label} reload`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'some mode has an optional layer outside a recipe');
});

for (const [name, parse, rows] of TABLE) {
  test(`${name} accepts and rejects its table`, () => {
    for (const [input, expected] of rows) {
      assert.deepEqual(parse(input), expected, `${name}(${JSON.stringify(input)})`);
    }
  });
}
