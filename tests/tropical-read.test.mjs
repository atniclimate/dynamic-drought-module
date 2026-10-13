import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ENSO block B3: the tropical cyclones slot sweep and its six-state mapping
 * (admission planning/2026-09-25-desktop-pass/admissions/noaa-tropical-cyclones.md,
 * lines 5, 6 and 8), driven in Node against tests/tropical-fixtures.ts.
 *
 * The REAL reader (src/layers/tropical-read.ts) and the REAL layer module
 * (src/layers/tropical-cyclones.ts) run against a stubbed `fetch` that serves
 * the fixture arms; no request reaches the network (an unknown URL throws).
 * The layer's peripheral modules (MapLibre, the click coordinator, the URL
 * catalog) are replaced by recorders, as tests/layer-activation-cancel.test.mjs
 * does.
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

const BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
globalThis.tropicalTestBase = BASE;
const stubs = {
  'maplibre-gl': 'export const stub = true;',
  '/map/interaction-coordinator': 'export function registerClickTarget(){}',
  '/config/urls': 'export const URLS = { nhcTropicalMapServer: globalThis.tropicalTestBase };'
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

const events = [];
globalThis.window = globalThis;
globalThis.dispatchEvent = (event) => {
  events.push(event);
  return true;
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const fixtures = await import('./tropical-fixtures.ts');
const reader = await import('../src/layers/tropical-read.ts');
const { registry } = await import('../src/state/registry.ts');
const layer = await import('../src/layers/tropical-cyclones.ts');
const { TROPICAL_SLOTS, TROPICAL_POINT_INK, TROPICAL_POINT_PAPER } = await import('../src/config/tropical-presentation.ts');

const { tropicalAnswer, tropicalLayerId, EP5_LAYERS } = fixtures;
const { readTropicalSweep, pendingTropicalReads } = reader;
const POINT_IDS = TROPICAL_SLOTS.map((slot) => slot.base + 2);

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A fetch over one fixture arm. `hold` lists layer ids answered only on
 * `release()`; a held request rejects on abort unless `ignoreAbort` models an
 * answer that raced past it. `stall` lists layer ids whose body sends its
 * first bytes and then never ends. A URL outside the service throws: an
 * unexpected egress fails the test.
 */
function installFetch(arm, { hold = [], ignoreAbort = false, stall = [] } = {}) {
  const calls = [];
  const held = [];
  globalThis.fetch = (url, options) => {
    const href = String(url);
    if (!href.startsWith(`${BASE}/`)) throw new Error(`unexpected egress: ${href}`);
    const layerId = tropicalLayerId(href);
    assert.notEqual(layerId, null, `not a layer query: ${href}`);
    const signal = options?.signal ?? null;
    calls.push({ url: href, layerId, signal });
    const answer = tropicalAnswer(arm, layerId);
    const respond = () => new Response(answer.body, { status: answer.status, headers: { 'Content-Type': answer.contentType } });
    if (stall.includes(layerId)) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(answer.body.slice(0, 10)));
        }
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    if (!hold.includes(layerId)) return Promise.resolve(respond());
    return new Promise((resolve, reject) => {
      held.push(() => resolve(respond()));
      if (!ignoreAbort) signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  return {
    calls,
    release() {
      for (const go of held.splice(0, held.length)) go();
    }
  };
}

const parts = (sweep, part) => sweep.features.filter((f) => f.properties.ddmPart === part);

test('the sweep reads the Forecast Points layer of all fifteen slots first, at base 4 + 26n + 2', async () => {
  const net = installFetch('allEmpty');
  await readTropicalSweep(BASE, new AbortController().signal);
  assert.deepEqual(net.calls.map((c) => c.layerId), POINT_IDS);
  assert.equal(POINT_IDS[9], EP5_LAYERS.points, 'EP5 is slot 9');
  for (const call of net.calls) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get('f'), 'geojson');
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('where'), '1=1');
  }
});

test('every slot a valid empty collection reads no data, and nothing is drawn', async () => {
  installFetch('allEmpty');
  const sweep = await readTropicalSweep(BASE, new AbortController().signal);
  assert.equal(sweep.state, 'no data');
  assert.deepEqual(sweep.features, []);
  assert.deepEqual(sweep.storms, []);
});

test('one occupied slot reads live: its points, track, cone and watch-warning lines are drawn', async () => {
  const net = installFetch('occupiedOne');
  const sweep = await readTropicalSweep(BASE, new AbortController().signal);
  assert.equal(sweep.state, 'live');
  assert.equal(net.calls.length, 18, 'fifteen presence reads, then three for the one occupied slot');
  assert.deepEqual(net.calls.slice(15).map((c) => c.layerId).sort(), [241, 242, 243]);
  assert.equal(parts(sweep, 'points').length, 9);
  assert.equal(parts(sweep, 'track').length, 1);
  assert.equal(parts(sweep, 'cone').length, 1);
  assert.deepEqual(parts(sweep, 'ww').map((f) => f.properties.tcww), ['TWA', 'HWA', 'HWR']);
  assert.deepEqual(sweep.storms, [
    { bin: 'EP5', name: 'Hurricane Simon', basin: 'EP', advisory: '24', issued: '200 AM MST Tue Oct 13 2026' }
  ]);
});

test('a 503 on one sublayer reads live (partial); the other sublayers still draw', async () => {
  installFetch('oneSublayer503');
  const sweep = await readTropicalSweep(BASE, new AbortController().signal);
  assert.equal(sweep.state, 'live (partial)');
  assert.equal(parts(sweep, 'cone').length, 0);
  assert.equal(parts(sweep, 'points').length, 9);
  assert.equal(parts(sweep, 'ww').length, 3);
});

for (const arm of ['arcgisError', 'lbEnvelope', 'emptyBody', 'emptyObject', 'noFeatures', 'truncatedJson', 'htmlAt200']) {
  test(`${arm} on the presence reads is unavailable, never no data`, async () => {
    installFetch(arm);
    const sweep = await readTropicalSweep(BASE, new AbortController().signal);
    assert.equal(sweep.state, 'unavailable');
    assert.deepEqual(sweep.features, []);
  });
}

test('an error envelope at HTTP 200 is tested before features (the observed bodies carry no features key)', () => {
  assert.equal(tropicalAnswer('arcgisError', 240).status, 200);
  assert.match(tropicalAnswer('arcgisError', 240).body, /^\{"error":/);
});

test('mixed advisory numbers read live (partial) and are never drawn as one advisory', async () => {
  installFetch('occupiedMixedAdvisory');
  const sweep = await readTropicalSweep(BASE, new AbortController().signal);
  assert.equal(sweep.state, 'live (partial)');
  assert.equal(parts(sweep, 'ww').length, 0, 'the 24A watch-warning lines are not drawn under advisory 24');
  assert.deepEqual([...new Set(sweep.features.map((f) => f.properties.advisnum))], ['24']);
});

test('a cone with a null geometry reads live (partial) and the cone is not drawn', async () => {
  installFetch('badGeometry');
  const sweep = await readTropicalSweep(BASE, new AbortController().signal);
  assert.equal(sweep.state, 'live (partial)');
  assert.equal(parts(sweep, 'cone').length, 0);
});

test('a response at the 2000-record cap or flagged exceededTransferLimit reads live (partial)', async () => {
  installFetch('recordCapPage');
  const sweep = await readTropicalSweep(BASE, new AbortController().signal);
  assert.equal(sweep.state, 'live (partial)');
});

test('a basin outside the whitelist is drawn, not hidden (off coverage)', async () => {
  installFetch('offCoverage');
  const sweep = await readTropicalSweep(BASE, new AbortController().signal);
  assert.equal(sweep.state, 'live');
  assert.equal(parts(sweep, 'points').length, 9);
  assert.equal(sweep.storms[0].basin, 'WP');
});

test('a stalled presence read is cut by the sweep deadline: the rest draws as live (partial)', async () => {
  installFetch('occupiedOne', { hold: [POINT_IDS[0]] });
  const sweep = await readTropicalSweep(BASE, new AbortController().signal, {
    requestTimeoutMs: 10_000,
    sweepDeadlineMs: 50,
    maxDecodedBytes: 1_048_576
  });
  assert.equal(sweep.state, 'live (partial)');
  assert.equal(parts(sweep, 'points').length, 9);
  assert.ok(sweep.problems.includes('AT1 points: no answer before the 50 ms sweep deadline'), 'the console names the deadline');
  assert.equal(pendingTropicalReads(), 0);
});

test('cancel during the presence reads: the reader resolves null, issues nothing more, and leaves no pending work', async () => {
  const net = installFetch('occupiedOne', { hold: POINT_IDS });
  const master = new AbortController();
  const pending = readTropicalSweep(BASE, master.signal);
  await settle();
  assert.equal(net.calls.length, 15);
  master.abort();
  assert.ok(net.calls.every((c) => c.signal.aborted), 'every held request aborts at the moment of cancel');
  assert.equal(await pending, null);
  await settle();
  assert.equal(net.calls.length, 15);
  assert.equal(pendingTropicalReads(), 0);
});

test('a late answer after cancel writes nothing (the reader resolves null)', async () => {
  const net = installFetch('occupiedOne', { hold: [EP5_LAYERS.cone], ignoreAbort: true });
  const master = new AbortController();
  const pending = readTropicalSweep(BASE, master.signal);
  await settle();
  master.abort();
  net.release();
  assert.equal(await pending, null);
  assert.equal(pendingTropicalReads(), 0);
});

test('abort during the body read cancels the stalled body', async () => {
  installFetch('occupiedOne', { stall: [EP5_LAYERS.points] });
  const master = new AbortController();
  const pending = readTropicalSweep(BASE, master.signal);
  await settle();
  master.abort();
  assert.equal(await pending, null);
  assert.equal(pendingTropicalReads(), 0);
});

// ---------------------------------------------------------------------------
// The popups: frame models the frame accepts, in the issuer's words
// ---------------------------------------------------------------------------

const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');
const popup = await import('../src/ui/tropical-popup.ts');

test('popup: the tau 0 point names the storm, class, category, advisory, issue time and the issuer link', () => {
  const html = serializePopupFrame(popup.buildTropicalPointPopupModel(fixtures.EP5_POINTS.features[0].properties));
  for (const text of ['Hurricane Simon', 'Hurricane, Category 1', 'Advisory Number', '24', '200 AM MST Tue Oct 13 2026', 'Eastern North Pacific', 'Maximum Wind', '80 knots', '977 mb', 'Storm Direction', '315 degrees', 'NOAA National Hurricane Center', 'https://www.nhc.noaa.gov/']) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
});

test('popup: a forecast point states its hour and drops the issuer 9999 sentinels', () => {
  const html = serializePopupFrame(popup.buildTropicalPointPopupModel(fixtures.EP5_POINTS.features[1].properties));
  assert.ok(html.includes('Forecast position, 12 h, at'));
  assert.ok(html.includes('2026-10-13 11:00 AM Tue MST'));
  assert.ok(!html.includes('9999'));
  assert.ok(!html.includes('Mean Sea Level Pressure'));
});

test('popup: a watch-warning line carries the renderer label and colour; an unknown code is raw, unswatched', () => {
  const known = popup.buildTropicalAreaPopupModel({ ...fixtures.EP5_WW.features[2].properties, ddmPart: 'ww' });
  assert.equal(known.value[0].text, 'Hurricane Warning');
  assert.equal(known.value[0].swatch.color, '#ff0000');
  serializePopupFrame(known);
  const unknown = popup.buildTropicalAreaPopupModel({ ...fixtures.EP5_WW.features[0].properties, tcww: 'XYZ', ddmPart: 'ww' });
  assert.equal(unknown.value[0].text, 'XYZ (code not recognised)');
  assert.equal(unknown.value[0].swatch, undefined);
  const cone = serializePopupFrame(popup.buildTropicalAreaPopupModel({ ...fixtures.EP5_CONE.features[0].properties, ddmPart: 'cone' }));
  assert.ok(cone.includes('Forecast Cone') && cone.includes('Simon'));
});

test('popup: the point, cone and watch-warning popups of one storm share the points layer title', async () => {
  installFetch('occupiedOne');
  const sweep = await readTropicalSweep(BASE, new AbortController().signal);
  const point = popup.buildTropicalPointPopupModel(parts(sweep, 'points')[0].properties);
  const cone = popup.buildTropicalAreaPopupModel(parts(sweep, 'cone')[0].properties);
  const ww = popup.buildTropicalAreaPopupModel(parts(sweep, 'ww')[0].properties);
  assert.deepEqual([point.title, cone.title, ww.title], ['Hurricane Simon', 'Hurricane Simon', 'Hurricane Simon']);
});

test('popup: the advisory position has no forecast-hour row; a later point keeps it', () => {
  const now = serializePopupFrame(popup.buildTropicalPointPopupModel(fixtures.EP5_POINTS.features[0].properties));
  const later = serializePopupFrame(popup.buildTropicalPointPopupModel(fixtures.EP5_POINTS.features[1].properties));
  assert.ok(!now.includes('Forecast hour'), 'tau 0 is the advisory position, not a forecast hour');
  assert.ok(later.includes('Forecast hour'));
});

test('popup: no qualification; the issuer-wording time note lives in the Impact Briefing', () => {
  for (const model of [
    popup.buildTropicalPointPopupModel(fixtures.EP5_POINTS.features[1].properties),
    popup.buildTropicalAreaPopupModel({ ...fixtures.EP5_CONE.features[0].properties, ddmPart: 'cone' })
  ]) {
    assert.equal(model.qualifications, undefined);
    assert.ok(!serializePopupFrame(model).includes('DDM does not read them as full dates'));
    for (const clock of model.clocks) if (clock.kind === 'point') assert.equal(clock.at.explanation, '(as stated)');
  }
});

test('popup: a CP slot is issued by the Central Pacific Hurricane Center', () => {
  const model = popup.buildTropicalPointPopupModel({ ...fixtures.EP5_POINTS.features[0].properties, binnumber: 'CP2' });
  assert.equal(model.issuer.name, 'NOAA Central Pacific Hurricane Center');
});

const MAP_KEY_SOURCE = readFileSync(new URL('../src/ui/map-key.ts', import.meta.url), 'utf8');

test('key: the point circles are ink on a paper chip that reads on the dark key panel', () => {
  const circle = MAP_KEY_SOURCE.slice(MAP_KEY_SOURCE.indexOf('function tropicalCircle('), MAP_KEY_SOURCE.indexOf('function tropicalGroup('));
  assert.ok(circle.includes('TROPICAL_POINT_PAPER'), 'the key circle has no paper chip behind its ink');
  const luminance = (rgb) =>
    rgb
      .map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const hex = (color) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  // The key panel is --glass-read, rgba(1,11,19,0.72); a white map behind it is its brightest case.
  const panel = [1, 11, 19].map((v) => v * 0.72 + 255 * 0.28);
  assert.ok(contrast(hex(TROPICAL_POINT_PAPER), panel) >= 3, 'the chip does not read on the key panel');
  assert.ok(contrast(hex(TROPICAL_POINT_INK), hex(TROPICAL_POINT_PAPER)) >= 3, 'the ink does not read on its chip');
});

test('key: the filled and hollow swatches carry their own labels, with no sentence under them', () => {
  assert.ok(!MAP_KEY_SOURCE.includes('data-tropical-icons'));
  assert.ok(!/Filled: /.test(MAP_KEY_SOURCE));
});

test('popup: the one door names the selected place, else the place the region briefing describes; with neither there is no door', async () => {
  const { setPlaceSelection } = await import('../src/state/place-selection.ts');
  const { setCurrentRegion } = await import('../src/state/region-store.ts');
  const doors = (model) => serializePopupFrame(model).match(/<button[^>]*data-ddm-impact-trigger[^>]*>[^<]*<\/button>/g) ?? [];
  const models = () => [
    popup.buildTropicalPointPopupModel(fixtures.EP5_POINTS.features[0].properties),
    popup.buildTropicalAreaPopupModel({ ...fixtures.EP5_CONE.features[0].properties, ddmPart: 'cone' }),
    popup.buildTropicalAreaPopupModel({ ...fixtures.EP5_WW.features[2].properties, ddmPart: 'ww' })
  ];
  try {
    // The national view has no briefing of its own and no place is selected: nothing to open.
    setCurrentRegion('national');
    for (const model of models()) assert.deepEqual(doors(model), []);

    // No place selected: the regional briefing, named by the place it describes.
    setCurrentRegion('washington_state');
    for (const model of models()) {
      assert.deepEqual(model.actions, [{ kind: 'briefing', place: 'Washington' }]);
      assert.deepEqual(doors(model), [
        '<button type="button" class="popup-impact-btn" data-ddm-impact-trigger>Open the Impact Briefing for Washington</button>'
      ]);
    }

    // A selected place wins over the region.
    setPlaceSelection({
      label: 'Fixture Place',
      context: { kind: 'state', title: 'Fixture Place', properties: null, lngLat: { lng: -120, lat: 47 }, regionKey: 'washington_state', containing: { state: null, basis: 'none' } }
    });
    for (const model of models()) {
      assert.deepEqual(doors(model), [
        '<button type="button" class="popup-impact-btn" data-ddm-impact-trigger>Open the Impact Briefing for Fixture Place</button>'
      ]);
    }
  } finally {
    setPlaceSelection(null);
    setCurrentRegion('national');
  }
});

// ---------------------------------------------------------------------------
// The layer module: what reaches the map, the registry and the key
// ---------------------------------------------------------------------------

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  const added = { sources: [], layers: [] };
  return {
    added,
    on() {},
    off() {},
    getCanvas: () => ({ style: {} }),
    getStyle: () => ({ layers: [...layers.values()] }),
    moveLayer() {},
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    addSource(id, spec) {
      added.sources.push(id);
      sources.set(id, { spec, data: spec.data, setData(data) { this.data = data; } });
    },
    addLayer(spec) {
      added.layers.push(spec.id);
      layers.set(spec.id, spec);
    },
    removeLayer: (id) => layers.delete(id),
    removeSource: (id) => sources.delete(id)
  };
}

const snapshots = () => events.filter((e) => e.type === 'ddm:tropical-snapshot').map((e) => e.detail.status);

test('layer: one occupied slot draws the source and five layers, reports ready and tells the key live', async (t) => {
  events.length = 0;
  installFetch('occupiedOne');
  const map = fakeMap();
  t.after(() => layer.deactivate(map));
  await layer.activate(map);
  assert.deepEqual(map.added.sources, ['tropical-cyclones']);
  assert.deepEqual([...map.added.layers].sort(), [...layer.fadeLayerIds].sort());
  assert.equal(map.getSource('tropical-cyclones').data.features.length, 14);
  assert.equal(registry.getStatus('tropical-cyclones'), 'ready');
  assert.deepEqual(snapshots(), ['loading', 'live']);
});

test('layer: an empty season reports no-data and tells the key no data', async (t) => {
  events.length = 0;
  installFetch('allEmpty');
  const map = fakeMap();
  t.after(() => layer.deactivate(map));
  await layer.activate(map);
  assert.equal(registry.getStatus('tropical-cyclones'), 'no-data');
  assert.deepEqual(snapshots(), ['loading', 'no data']);
});

test('layer: a late answer after deactivate draws nothing, sets no status and leaves no timer', async () => {
  events.length = 0;
  const net = installFetch('occupiedOne', { hold: POINT_IDS, ignoreAbort: true });
  const map = fakeMap();
  const statuses = [];
  const unsubscribe = registry.on('status-change', (key, status) => {
    if (key === 'tropical-cyclones') statuses.push(status);
  });
  const activation = new AbortController();
  const pending = layer.activate(map, { signal: activation.signal, generation: 1 });
  await settle();
  activation.abort();
  layer.deactivate(map);
  net.release();
  await pending;
  await settle();
  unsubscribe();
  assert.deepEqual(map.added.sources, []);
  assert.deepEqual(map.added.layers, []);
  assert.deepEqual(statuses, ['loading'], 'no terminal status is written for the superseded sweep');
  assert.deepEqual(snapshots(), ['loading', 'inactive']);
  assert.equal(net.calls.length, 15, 'no sublayer read follows the late presence answers');
  assert.equal(pendingTropicalReads(), 0);
  assert.equal(layer.pendingRefresh(), false, 'no refresh is scheduled after deactivate');
});

test('layer: a sweep cancelled mid-flight by its activation publishes nothing and leaves zero pending work', async (t) => {
  events.length = 0;
  const net = installFetch('occupiedOne', { hold: [EP5_LAYERS.track, EP5_LAYERS.cone, EP5_LAYERS.ww] });
  const map = fakeMap();
  t.after(() => layer.deactivate(map));
  const statuses = [];
  const unsubscribe = registry.on('status-change', (key, status) => {
    if (key === 'tropical-cyclones') statuses.push(status);
  });
  const activation = new AbortController();
  const pending = layer.activate(map, { signal: activation.signal, generation: 1 });
  await settle();
  assert.equal(net.calls.length, 18, 'cancelled while the sublayer reads are open');
  activation.abort();
  await pending;
  await settle();
  unsubscribe();
  assert.deepEqual(statuses, ['loading'], 'the cancelled sweep writes no terminal status');
  assert.deepEqual(snapshots(), ['loading'], 'and tells the key nothing');
  assert.deepEqual(map.added.sources, []);
  assert.equal(pendingTropicalReads(), 0);
  assert.equal(layer.pendingRefresh(), false);
});
