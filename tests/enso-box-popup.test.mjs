import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ENSO B1: the Nino 3.4 box popup model, built from a trimmed copy of the
 * bundled snapshot's shape (public/data/enso-indices.json), and checked
 * through the popup frame's own serializer. No DOM, no map.
 */

// Extensionless relative specifiers between .ts modules (tests/popup-frame.test.mjs, the same hook).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const {
  buildEnsoBoxPopupModel,
  readEnsoBoxSnapshot,
  loadEnsoBoxSnapshot,
  startEnsoBoxRead,
  cancelEnsoBoxRead,
  currentEnsoBoxRead
} = await import('../src/ui/enso-box-popup.ts');
const { ENSO_INDICES_SHARED_KEY, invalidateSharedJsonRequest, pendingSharedTransportCount } = await import('../src/util/fetch.ts');
const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');
const { sparklineSvg } = await import('../src/ui/charts.ts');
const { setPlaceSelection } = await import('../src/state/place-selection.ts');
const { setCurrentRegion } = await import('../src/state/region-store.ts');

const seasonal = (name, file, anoms, preliminary) => ({
  source: `NOAA CPC ${name}`,
  sourceUrl: `https://www.cpc.ncep.noaa.gov/data/indices/${file}`,
  published: '2026-10-03',
  method: { basePeriod: '1991-2020' },
  latest: { seas: 'JAS', year: 2026, anom: anoms[anoms.length - 1], preliminary },
  values: anoms.map((anom, i) => ({ seas: ['MJJ', 'JJA', 'JAS'][i], year: 2026, anom }))
});

function snapshot(overrides = {}) {
  return {
    retrieved: '2026-10-12',
    roni: seasonal('Relative Oceanic Nino Index (RONI)', 'RONI.ascii.txt', [1.1, 1.36, 1.69], true),
    oni: seasonal('Oceanic Nino Index (ONI)', 'oni.ascii.txt', [1.5, 1.8, 2.16], false),
    nino34Weekly: {
      published: '2026-10-12',
      basePeriod: '1991-2020',
      dateMeaning: 'week centre',
      latest: { year: 2026, month: 10, day: 7, total: 30, anom: 3.3 },
      values: []
    },
    soi: { published: '2026-10-05', block: 'standardized', latest: { year: 2026, month: 9, value: -2 }, values: [] },
    ...overrides
  };
}

const ready = (json) => buildEnsoBoxPopupModel({ kind: 'ready', snapshot: readEnsoBoxSnapshot(json) });

test('the ready model lists RONI, ONI, weekly Nino 3.4 and SOI in order', () => {
  const model = ready(snapshot());
  assert.equal(model.title, 'Nino 3.4 (the ENSO index region)');
  assert.deepEqual(
    model.value.map((r) => r.label),
    [
      'Relative Oceanic Nino Index (RONI)',
      'Oceanic Nino Index (ONI)',
      'Weekly Nino 3.4 sea surface temperature',
      'Southern Oscillation Index (SOI)'
    ]
  );
  assert.match(model.value[0].text, /^\+1\.69 .C, JAS 2026 \(preliminary\)$/);
  assert.doesNotMatch(model.value[1].text, /preliminary/);
  assert.match(model.value[2].text, /30\.0 .C, anomaly \+3\.3 .C, 7 Oct 2026/);
  assert.equal(model.value[3].text, '-2.0, Sep 2026');
  assert.equal(model.value[0].clock.at.date, '2026-10-03');
  assert.equal(model.clocks[0].at.date, '2026-10-12');
  assert.deepEqual(model.qualifications, [
    'RONI base period: 1991-2020',
    'Weekly Nino 3.4 base period: 1991-2020',
    'Weekly Nino 3.4 date: week centre'
  ]);
  assert.equal(model.issuer.productKey, 'ensoIndex');
  assert.equal(model.source.link.href, 'https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt');
});

test('the chart carries the whole RONI series with the +/-0.5 guides', () => {
  const [chart] = ready(snapshot()).details;
  assert.equal(chart.kind, 'chart');
  assert.equal(chart.data.length, 3);
  assert.deepEqual(chart.options.guides, [0.5, -0.5]);
  const svg = sparklineSvg(chart.data, chart.options);
  assert.equal((svg.match(/stroke-dasharray/g) ?? []).length, 2);
});

test('a null SOI omits its row; a malformed weekly block is dropped', () => {
  const model = ready(
    snapshot({
      soi: { latest: { year: 2026, month: 9, value: null }, values: [] },
      nino34Weekly: { latest: { year: 2026, month: 13, day: 7, total: 30, anom: 3.3 } }
    })
  );
  assert.deepEqual(model.value.map((r) => r.label), ['Relative Oceanic Nino Index (RONI)', 'Oceanic Nino Index (ONI)']);
});

test('the frame serializer accepts the ready, loading and unavailable models', () => {
  const html = serializePopupFrame(ready(snapshot()));
  assert.match(html, /data-popup-chart="enso-box-roni"/);
  assert.match(html, /Relative Oceanic Nino Index \(RONI\)/);
  for (const kind of ['loading', 'unavailable']) {
    const model = buildEnsoBoxPopupModel({ kind });
    assert.equal(model.value[0].state, kind);
    assert.match(serializePopupFrame(model), new RegExp(`<span data-state>${kind}</span>`));
  }
});

test('the one door names the selected place, else the place the region briefing describes; with neither there is no door', () => {
  const doors = (model) => serializePopupFrame(model).match(/<button[^>]*data-ddm-impact-trigger[^>]*>[^<]*<\/button>/g) ?? [];
  const models = () => [ready(snapshot()), buildEnsoBoxPopupModel({ kind: 'loading' }), buildEnsoBoxPopupModel({ kind: 'unavailable' })];
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

test('a blank or corrupt snapshot reads as unreadable, never as data', () => {
  assert.equal(readEnsoBoxSnapshot(null), null);
  assert.equal(readEnsoBoxSnapshot({}), null);
  assert.equal(readEnsoBoxSnapshot(snapshot({ roni: { latest: {} } })), null);
  assert.equal(readEnsoBoxSnapshot(snapshot({ roni: { ...snapshot().roni, sourceUrl: 'http://x.test/' } })), null);
});

test('the loader reads through the shared transport and honours an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadEnsoBoxSnapshot(controller.signal), { name: 'AbortError' });

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
    await assert.rejects(loadEnsoBoxSnapshot(new AbortController().signal));
    globalThis.fetch = async () => new Response(JSON.stringify({ retrieved: 'x' }), { status: 200 });
    assert.deepEqual(await loadEnsoBoxSnapshot(new AbortController().signal), { kind: 'unavailable' });
  } finally {
    globalThis.fetch = realFetch;
    invalidateSharedJsonRequest(ENSO_INDICES_SHARED_KEY);
  }
});

test('the popup read: cancel leaves no pending work, a late answer writes nothing, a ready read is kept', async () => {
  const realFetch = globalThis.fetch;
  const held = [];
  globalThis.fetch = (_url, init) =>
    new Promise((resolve, reject) => {
      held.push({ resolve, signal: init.signal });
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  try {
    startEnsoBoxRead();
    assert.equal(currentEnsoBoxRead().kind, 'loading');
    assert.equal(held.length, 1);

    cancelEnsoBoxRead();
    await settle();
    assert.equal(held[0].signal.aborted, true);
    assert.equal(pendingSharedTransportCount(), 0);
    // The superseded request answering late changes nothing.
    held[0].resolve(new Response(JSON.stringify(snapshot()), { status: 200 }));
    await settle();
    assert.equal(currentEnsoBoxRead().kind, 'loading');

    startEnsoBoxRead();
    assert.equal(held.length, 2);
    held[1].resolve(new Response(JSON.stringify(snapshot()), { status: 200 }));
    await settle();
    await settle();
    assert.equal(currentEnsoBoxRead().kind, 'ready');

    cancelEnsoBoxRead();
    startEnsoBoxRead();
    assert.equal(currentEnsoBoxRead().kind, 'ready');
    assert.equal(held.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    invalidateSharedJsonRequest(ENSO_INDICES_SHARED_KEY);
  }
});
