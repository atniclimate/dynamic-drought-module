import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The minimap reads what its mode loaded, at the horizon the person is on
 * (the owner's acceptance sentence of 2026-09-25; the table is
 * src/config/minimap-readings.ts, the new rule src/state/minimap-outlook.ts).
 *
 *  1. Every mode and horizon, enumerated from the mode table, resolves to a
 *     reading or to navigation-only, and no row names a product its horizon
 *     does not load.
 *  2. The shipped readings (Drought and Wildfire at Current) are unchanged,
 *     and every Current clause is the mode's own words.
 *  3. Every new row is DRAFT and off: off, its horizon is navigation-only and
 *     names nothing it does not show; on, it reads its product and names it.
 *  4. The classes-drawn rule on fixtures, and its words.
 *  5. The stub swap: the stubbed upstream swapped between two fixtures moves
 *     the reading, for the shipped Wildfire reading (on its own refresh) and
 *     for each new row with its flag on, through the REAL layer module that
 *     loads that row's product onto a fake map.
 *  6. The "fire seems static" finding, pinned: the shipped Wildfire reading
 *     re-reads on its own five-minute timer only, never on the perimeter
 *     layer's reload.
 *
 * Plain `node --test` (Node 24 strips types). `fetch` is stubbed; no network.
 */

// The drought outlook layer caches a read for an hour on a clock it takes
// when its module loads, so this clock is installed before that import.
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

// The SPC layer's refresh timer runs on `window`; this one is fired by hand.
const windowTimers = [];
globalThis.window = {
  setTimeout(fn, ms) {
    windowTimers.push({ fn, ms });
    return windowTimers.length;
  },
  clearTimeout(id) {
    const timer = windowTimers[id - 1];
    if (timer) timer.fn = null;
  }
};

// DOM-facing modules the layers call, answered with no-ops.
const STUBS = {
  '/map/interaction-coordinator': 'export function registerClickTarget() {}',
  '/ui/popups': 'export function buildSpcFireWeatherPopupModel() { return {}; }',
  '/ui/time-bar': 'export function setTimeBar() {} export function clearTimeBar() {}',
  '/ui/overlay': 'export function showLoading() { return 1; } export function hideLoading() {}',
  '/ui/legend-registry':
    'export const LEGEND_ORDER = { surface: 0, event: 1 }; export function showLegend() { return null; } export function hideLegend() {} export function renderSwatchLegend() {}'
};
// The perimeter layer's MapLibre graph cannot load in Node; the minimap reads
// only its `loadedNifcCollection`, which answers nothing here (count POSTs).
const NIFC_LAYER_MODULE = '/src/layers/nifc-fires.ts';
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(STUBS).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
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
  },
  load(url, context, nextLoad) {
    if (url.endsWith(NIFC_LAYER_MODULE)) {
      return { format: 'module', shortCircuit: true, source: 'export function loadedNifcCollection() { return null; }' };
    }
    return nextLoad(url, context);
  }
});

const {
  MINIMAP_READINGS,
  minimapIndexLabel,
  minimapProductName,
  minimapProvenanceAt,
  minimapReading,
  outlookFramingWords,
  outlookScaleText
} = await import('../src/config/minimap-readings.ts');
const { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS, TEMPORAL_HORIZON_KEYS } = await import('../src/config/clusters.ts');
const { FRAMING_KEYS, framingMinimapProvenance } = await import('../src/config/framings.ts');
const { CPC_EXTENDED_COLORS, CPC_SEASONAL_COLORS, DROUGHT_COLORS, OUTLOOK_LEGEND, SPC_FIREWX_CATEGORIES } = await import(
  '../src/config/palette.ts'
);
const { deriveClassesDrawn, outlookColors, outlookLabels, watchMinimapOutlook } = await import(
  '../src/state/minimap-outlook.ts'
);
const { registry } = await import('../src/state/registry.ts');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Points each inside exactly one framing's authored rings (checked by the rule test below). */
const PACIFIC = [-122.5, 45.5];
const ARID = [-112, 36];
const GULF = [-86, 33];
const HAWAII = [-157.9, 21.4];

function square([lon, lat], half = 0.2) {
  return {
    type: 'Polygon',
    coordinates: [[[lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half], [lon - half, lat + half], [lon - half, lat - half]]]
  };
}

/** One small square per [properties, point] pair, in the order given. */
function collection(...pairs) {
  return {
    type: 'FeatureCollection',
    features: pairs.map(([properties, point]) => ({ type: 'Feature', properties, geometry: square(point) }))
  };
}

/** The fake map the cpc-seasonal-layers test uses, plus MapLibre's own `getData`. */
function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    sources,
    getSource: (id) => sources.get(id),
    getLayer: (id) => layers.get(id),
    addSource(id, spec) {
      sources.set(id, {
        ...spec,
        setData(data) { this.data = data; },
        getData() { return Promise.resolve(this.data); }
      });
    },
    addLayer(layer) { layers.set(layer.id, layer); },
    removeLayer(id) { layers.delete(id); },
    removeSource(id) { sources.delete(id); }
  };
}

let answer = () => {
  throw new TypeError('no route in this case');
};
globalThis.fetch = async (input, init) => {
  const outcome = answer(String(input instanceof Request ? input.url : input), init);
  return outcome instanceof Response ? outcome : new Response(JSON.stringify(outcome));
};

async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function until(predicate, label) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`never settled: ${label}`);
}

/** The table's new rows: every classes-drawn reading, wherever it sits. */
function draftRows() {
  return HAZARD_CLUSTER_KEYS.flatMap((mode) =>
    TEMPORAL_HORIZON_KEYS.flatMap((horizon) => {
      const reading = MINIMAP_READINGS[mode][horizon].reading;
      return reading?.rule === 'classes-drawn' ? [{ mode, horizon, reading }] : [];
    })
  );
}

/** Switch one row's flag on for a case (the owner's switch), and off again after. */
async function withRowOn(mode, horizon, run) {
  const row = MINIMAP_READINGS[mode][horizon].reading;
  row.on = true;
  try {
    const reading = minimapReading(mode, horizon);
    assert.equal(reading, row, `${mode} ${horizon} reads its row once it is on`);
    await run(reading);
  } finally {
    row.on = false;
  }
}

const labelsIn = (reading, snapshot, keys) =>
  Object.fromEntries(keys.map((key) => [key, [...outlookLabels(reading.outlook, snapshot, key)]]));

// ---------------------------------------------------------------------------
// 1-3. The table
// ---------------------------------------------------------------------------

test('every mode and horizon of the mode table resolves to a reading or to navigation-only, and no row names a product its horizon does not load', () => {
  assert.deepEqual(Object.keys(MINIMAP_READINGS).sort(), [...HAZARD_CLUSTER_KEYS].sort());
  for (const mode of HAZARD_CLUSTER_KEYS) {
    assert.deepEqual(Object.keys(MINIMAP_READINGS[mode]).sort(), [...TEMPORAL_HORIZON_KEYS].sort(), mode);
    for (const horizon of TEMPORAL_HORIZON_KEYS) {
      const row = MINIMAP_READINGS[mode][horizon].reading;
      const resolved = minimapReading(mode, horizon);
      assert.ok(resolved === null || resolved === row, `${mode} ${horizon} resolves to its own row or to navigation-only`);
      if (row !== undefined) {
        assert.ok(
          HAZARD_CLUSTERS[mode].recipes[horizon].includes(row.product),
          `${mode} ${horizon} reads ${row.product}, which that horizon's recipe loads`
        );
      }
    }
  }
});

test('the shipped readings are unchanged: Drought and Wildfire at Current read their products, and every Current clause is the mode\'s own words', () => {
  assert.deepEqual(minimapReading('drought', 'current'), { rule: 'nadm-framing-summary', product: 'nadm-drought', on: true });
  assert.deepEqual(minimapReading('wildfire', 'current'), { rule: 'nifc-perimeter-count', product: 'nifc-fires', on: true });
  for (const mode of HAZARD_CLUSTER_KEYS) {
    for (const key of [null, ...FRAMING_KEYS]) {
      assert.equal(minimapProvenanceAt(key, mode, 'current'), framingMinimapProvenance(key, mode), `${mode} ${key} at Current`);
    }
  }
  // ENSO at Current keeps the basin-wide index in its scale slot (EF-6).
  assert.equal(minimapIndexLabel('enso', 'current'), 'roni');
});

test('a navigation-only clause names only what its horizon loads: no Drought Monitor, NIFC or HeatRisk clause where that product is not drawn', () => {
  const named = [
    [/Drought Monitor|drought summary/, 'nadm-drought'],
    [/NIFC/, 'nifc-fires'],
    [/HeatRisk/, 'heatrisk']
  ];
  for (const mode of HAZARD_CLUSTER_KEYS) {
    for (const horizon of TEMPORAL_HORIZON_KEYS) {
      for (const key of [null, ...FRAMING_KEYS]) {
        const clause = minimapProvenanceAt(key, mode, horizon);
        if (clause === undefined) continue;
        for (const [pattern, product] of named) {
          if (pattern.test(clause)) {
            assert.ok(HAZARD_CLUSTERS[mode].recipes[horizon].includes(product), `${mode} ${horizon} ${key} names ${product}, which it does not load`);
          }
        }
      }
    }
  }
  // The cases the defect was about, said outright.
  for (const horizon of ['weeks-ahead', 'season-ahead']) {
    assert.equal(minimapReading('drought', horizon), null);
    assert.equal(minimapReading('wildfire', horizon), null);
    for (const key of FRAMING_KEYS) {
      assert.equal(minimapProvenanceAt(key, 'drought', horizon), undefined, `drought ${horizon} ${key}`);
      assert.equal(minimapProvenanceAt(key, 'wildfire', horizon), undefined, `wildfire ${horizon} ${key}`);
    }
  }
  // Extreme Heat at Season ahead draws nothing, so even its HeatRisk clause is gone.
  assert.equal(minimapProvenanceAt('arid-west', 'heat', 'season-ahead'), undefined);
  assert.match(minimapProvenanceAt('arid-west', 'heat', 'weeks-ahead'), /HeatRisk/);
});

test('every new row is DRAFT and off, so its horizon ships navigation-only and names nothing it does not show', () => {
  const drafts = draftRows();
  assert.deepEqual(
    drafts.map(({ mode, horizon, reading }) => `${mode} ${horizon} ${reading.product}`),
    [
      'drought weeks-ahead drought',
      'drought season-ahead drought',
      'wildfire weeks-ahead spc-fire-weather',
      'enso weeks-ahead cpc-814-precip',
      'enso season-ahead cpc-seasonal-precip'
    ]
  );
  for (const { mode, horizon, reading } of drafts) {
    assert.equal(reading.on, false, `${mode} ${horizon} ships off until the owner turns it on`);
    assert.equal(minimapReading(mode, horizon), null, `${mode} ${horizon} is navigation-only`);
    const name = minimapProductName(reading.product);
    for (const key of [null, ...FRAMING_KEYS]) {
      const clause = minimapProvenanceAt(key, mode, horizon) ?? '';
      assert.ok(!clause.includes(name), `${mode} ${horizon} ${key} names ${name} while it is off`);
    }
  }
  // Off, ENSO's outlook horizons keep the shipped index label and its clause.
  for (const horizon of ['weeks-ahead', 'season-ahead']) {
    assert.equal(minimapIndexLabel('enso', horizon), 'roni');
    assert.equal(minimapProvenanceAt('pacific-coast', 'enso', horizon), framingMinimapProvenance('pacific-coast', 'enso'));
  }
});

test('a row switched on reads its product and names it; switched off again it is navigation-only', async () => {
  for (const { mode, horizon, reading } of draftRows()) {
    await withRowOn(mode, horizon, async () => {
      const clause = `The ${minimapProductName(reading.product)} informs this minimap.`;
      assert.equal(minimapProvenanceAt('arid-west', mode, horizon), clause);
      assert.equal(minimapProvenanceAt(null, mode, horizon), clause);
      assert.equal(minimapIndexLabel(mode, horizon), undefined, `${mode} ${horizon}: the reading takes the scale slot`);
    });
    assert.equal(minimapReading(mode, horizon), null);
  }
});

// ---------------------------------------------------------------------------
// 4. The classes-drawn rule and its words
// ---------------------------------------------------------------------------

test('each new row names the issuer\'s own classes, verbatim and in the issuer\'s legend order, with the issuer\'s colours', () => {
  const rows = Object.fromEntries(draftRows().map(({ mode, horizon, reading }) => [`${mode} ${horizon}`, reading.outlook]));
  const cpc = (palette) => palette.map(({ label, color: [r, g, b, a] }) => ({ label, color: `rgba(${r},${g},${b},${a / 255})` }));
  assert.deepEqual(rows['enso weeks-ahead'].classes, cpc(CPC_EXTENDED_COLORS.precipitation));
  assert.deepEqual(rows['enso season-ahead'].classes, cpc(CPC_SEASONAL_COLORS.precipitation));
  assert.equal(rows['enso season-ahead'].classes.at(-1).label, 'Equal Chances');
  assert.deepEqual(rows['wildfire weeks-ahead'].classes, SPC_FIREWX_CATEGORIES);
  assert.deepEqual(rows['drought weeks-ahead'].classes, OUTLOOK_LEGEND);
  assert.equal(rows['drought season-ahead'], rows['drought weeks-ahead']);
  // The drawn outlook values land on their own legend rows (src/layers/drought.ts's colour pairs).
  const droughtOutlook = rows['drought weeks-ahead'];
  for (const [value, colorKey] of [['Persistence', 'PERSISTS'], ['Development', 'DEVELOPS'], ['Improvement', 'IMPROVES'], ['Removal', 'REMOVAL']]) {
    assert.equal(droughtOutlook.classes[droughtOutlook.classOf({ outlook: value })].color, DROUGHT_COLORS[colorKey], value);
  }
  assert.equal(droughtOutlook.classOf({ outlook: 'No_Drought' }), -1, 'the layer never draws No_Drought');
  assert.equal(rows['wildfire weeks-ahead'].classOf({ dn: 8 }), 1);
  assert.equal(rows['wildfire weeks-ahead'].classOf({ dn: '10' }), 2, 'the layer reads dn as a number either way');
  assert.equal(rows['enso weeks-ahead'].classOf({ cat: 'EC', prob: 33 }), -1, 'the day-range renderer has no Equal Chances class');
});

/** A drawn feature's properties for the product's class at a legend index, as each layer's upstream sends it. */
const PROPERTIES_OF = {
  drought: (index) => ({ outlook: ['Persistence', 'Development', 'Improvement', 'Removal'][index] }),
  'spc-fire-weather': (index) => ({ dn: SPC_FIREWX_CATEGORIES[index].dn }),
  'cpc-814-precip': (index) => ({ cat: CPC_EXTENDED_COLORS.precipitation[index].cat, prob: CPC_EXTENDED_COLORS.precipitation[index].prob }),
  'cpc-seasonal-precip': (index) => ({ cat: CPC_SEASONAL_COLORS.precipitation[index].cat, prob: CPC_SEASONAL_COLORS.precipitation[index].prob })
};

test('classes-drawn: a class counts in a framing when one of its drawn polygons overlaps the framing\'s rings, listed in legend order; nothing else is computed', () => {
  for (const { mode, horizon, reading } of draftRows()) {
    const { outlook } = reading;
    const known = PROPERTIES_OF[reading.product];
    // Listed out of legend order on purpose; two features of one class in one framing count once.
    const body = collection([known(2), ARID], [known(0), ARID], [known(0), PACIFIC], [known(0), PACIFIC], [known(1), HAWAII]);
    const drawn = deriveClassesDrawn(body, outlook);
    assert.ok(drawn, `${mode} ${horizon} names every class drawn`);
    assert.deepEqual(drawn['arid-west'], [0, 2], `${mode} ${horizon}: legend order`);
    assert.deepEqual(drawn['pacific-coast'], [0]);
    assert.deepEqual(drawn.hawaii, [1], 'the multi-island Hawaii framing');
    for (const key of FRAMING_KEYS.filter((k) => !['arid-west', 'pacific-coast', 'hawaii'].includes(k))) {
      assert.deepEqual(drawn[key], [], `${mode} ${horizon}: nothing drawn over ${key}`);
    }
    const empty = deriveClassesDrawn({ type: 'FeatureCollection', features: [] }, outlook);
    assert.ok(FRAMING_KEYS.every((key) => empty[key].length === 0), 'an empty outlook draws no class anywhere');
    // A drawn feature whose class the legend does not name leaves the reading unsaid.
    assert.equal(deriveClassesDrawn(collection([known(0), ARID], [{ cat: 'Odd', prob: 1, outlook: 'Odd', dn: 99 }, GULF]), outlook), null);
    // The fill is the drawn classes' issuer colours; a framing with none drawn is unshaded.
    const live = { status: 'live', drawn };
    assert.deepEqual(outlookColors(outlook, live, 'arid-west'), [outlook.classes[0].color, outlook.classes[2].color]);
    assert.equal(outlookColors(outlook, live, 'mexico'), undefined);
    assert.equal(outlookColors(outlook, { status: 'loading', drawn }, 'arid-west'), undefined, 'only a live read shades');
  }
});

test('classes-drawn words: the product\'s own name, then the issuer\'s class words or the read state', () => {
  assert.equal(
    outlookFramingWords('8-14 Day Precipitation Outlook', 'live', ['Above, 50%', 'Near Normal']),
    '8-14 Day Precipitation Outlook in this framing: Above, 50%; Near Normal.'
  );
  assert.equal(outlookFramingWords('Drought Outlook (CPC)', 'live', []), 'Drought Outlook (CPC) in this framing: no area drawn.');
  assert.equal(outlookFramingWords('Drought Outlook (CPC)', 'loading', []), 'Drought Outlook (CPC) in this framing: loading.');
  assert.equal(outlookFramingWords('Drought Outlook (CPC)', 'idle', []), 'Drought Outlook (CPC) in this framing: loading.');
  assert.equal(outlookFramingWords('Drought Outlook (CPC)', 'unavailable', ['x']), 'Drought Outlook (CPC) in this framing: unavailable.');
  assert.equal(outlookScaleText('Seasonal Precipitation Outlook', 'live'), 'Seasonal Precipitation Outlook');
  assert.equal(outlookScaleText('Seasonal Precipitation Outlook', 'idle'), 'Seasonal Precipitation Outlook · loading');
  assert.equal(outlookScaleText('Seasonal Precipitation Outlook', 'unavailable'), 'Seasonal Precipitation Outlook · unavailable');
  // The product names are the layer catalog's own.
  assert.deepEqual(draftRows().map(({ reading }) => minimapProductName(reading.product)), [
    'Drought Outlook (CPC)',
    'Drought Outlook (CPC)',
    'Fire Weather Outlook (Day 1)',
    '8-14 Day Precipitation Outlook',
    'Seasonal Precipitation Outlook'
  ]);
});

// ---------------------------------------------------------------------------
// 5. The stub swap, through the real layer modules
// ---------------------------------------------------------------------------

/** Watch one row on a fake map; `latest()` is the newest reading. */
function watchRow(map, reading) {
  const seen = [];
  const stop = watchMinimapOutlook(map, reading.product, reading.outlook, (next) => seen.push(next));
  return { seen, stop, latest: () => seen.at(-1) };
}

// Each case's third class and the arid-west labels it yields, in that renderer's legend order.
for (const [horizon, layerKey, third, aridLabels] of [
  ['weeks-ahead', 'cpc-814-precip', { cat: 'Normal', prob: 36 }, ['Near Normal', 'Below, 40%']],
  ['season-ahead', 'cpc-seasonal-precip', { cat: 'EC', prob: 33 }, ['Below, 40%', 'Equal Chances']]
]) {
  test(`ENSO ${horizon}, flag on: the ${layerKey} upstream swapped between two fixtures moves the reading, and the layer going off clears it`, async () => {
    const layer = await import(`../src/layers/${layerKey}.ts`);
    await withRowOn('enso', horizon, async (reading) => {
      let body = collection([{ cat: 'Above', prob: 50 }, PACIFIC], [{ cat: 'Below', prob: 40 }, ARID], [third, ARID]);
      answer = () => body;
      const map = fakeMap();
      registry.activate(layerKey);
      const watch = watchRow(map, reading);
      try {
        assert.equal(watch.latest().status, 'idle', 'nothing read before the layer reports');
        await layer.activate(map);
        await settle();
        assert.equal(watch.latest().status, 'live');
        assert.deepEqual(labelsIn(reading, watch.latest(), ['pacific-coast', 'arid-west', 'southeast-gulf']), {
          'pacific-coast': ['Above, 50%'],
          'arid-west': aridLabels,
          'southeast-gulf': []
        });
        // The upstream answers another issuance; the layer reads it again on activation.
        body = collection([{ cat: 'Below', prob: 40 }, PACIFIC], [{ cat: 'Above', prob: 33 }, GULF]);
        await layer.activate(map);
        await settle();
        assert.deepEqual(labelsIn(reading, watch.latest(), ['pacific-coast', 'arid-west', 'southeast-gulf']), {
          'pacific-coast': ['Below, 40%'],
          'arid-west': [],
          'southeast-gulf': ['Above, 33%']
        });
        // A failed read is unavailable, never an empty outlook.
        answer = () => new Response('upstream failure', { status: 500 });
        await layer.activate(map);
        await settle();
        assert.equal(watch.latest().status, 'unavailable');
        // Off the map: nothing to read.
        layer.deactivate(map);
        registry.deactivate(layerKey);
        await settle();
        assert.equal(watch.latest().status, 'idle');
      } finally {
        watch.stop();
        layer.deactivate(map);
        registry.deactivate(layerKey);
      }
    });
  });
}

test('Wildfire Weeks ahead, flag on: the SPC Day 1 upstream swapped between fixtures moves the reading on the layer\'s own refresh, down to no area outlined', async () => {
  const layer = await import('../src/layers/spc-fire-weather.ts');
  await withRowOn('wildfire', 'weeks-ahead', async (reading) => {
    let body = collection([{ dn: 8 }, ARID], [{ dn: 5 }, ARID]);
    answer = () => body;
    const map = fakeMap();
    registry.activate('spc-fire-weather');
    const watch = watchRow(map, reading);
    const fireRefresh = async () => {
      const timer = windowTimers.findLast((t) => t.ms === 30 * 60 * 1000 && t.fn !== null);
      assert.ok(timer, 'the layer scheduled its own refresh');
      const fn = timer.fn;
      timer.fn = null;
      fn();
      await settle();
    };
    try {
      await layer.activate(map);
      await settle();
      assert.deepEqual(labelsIn(reading, watch.latest(), ['arid-west', 'pacific-coast']), {
        'arid-west': ['Elevated', 'Critical'],
        'pacific-coast': []
      });
      body = collection([{ dn: 10 }, PACIFIC]);
      await fireRefresh();
      assert.deepEqual(labelsIn(reading, watch.latest(), ['arid-west', 'pacific-coast']), {
        'arid-west': [],
        'pacific-coast': ['Extremely Critical']
      });
      // The issuer outlines no area today: a live read with no class drawn anywhere.
      body = { type: 'FeatureCollection', features: [] };
      await fireRefresh();
      assert.equal(watch.latest().status, 'live');
      assert.ok(FRAMING_KEYS.every((key) => outlookLabels(reading.outlook, watch.latest(), key).length === 0));
    } finally {
      watch.stop();
      layer.deactivate(map);
      registry.deactivate('spc-fire-weather');
    }
  });
});

test('Drought Weeks ahead and Season ahead, flag on: the CPC Drought Outlook upstream swapped between fixtures moves the reading, by data and by horizon', async () => {
  const layer = await import('../src/layers/drought.ts');
  const { timeline } = await import('../src/state/timeline.ts');
  const weeksRow = MINIMAP_READINGS.drought['weeks-ahead'].reading;
  const seasonRow = MINIMAP_READINGS.drought['season-ahead'].reading;
  seasonRow.on = true;
  await withRowOn('drought', 'weeks-ahead', async (weeks) => {
    let monthly = new Response('upstream failure', { status: 500 });
    const seasonal = collection([{ outlook: 'Development' }, ARID], [{ outlook: 'Removal' }, PACIFIC]);
    // MapServer/1 is the Monthly register, MapServer/4 the Seasonal one (src/layers/drought.ts).
    answer = (url) => (/\/MapServer\/1\/query/.test(url) ? monthly : /\/MapServer\/4\/query/.test(url) ? seasonal : null);
    timeline.setHorizon('weeks-ahead');
    const map = fakeMap();
    registry.activate('drought');
    let watch = watchRow(map, weeks);
    try {
      await layer.activate(map);
      await settle();
      assert.equal(watch.latest().status, 'unavailable', 'a failed read says so');
      // The issuer answers; the controller re-activates the layer.
      monthly = collection([{ outlook: 'Improvement' }, PACIFIC], [{ outlook: 'Persistence' }, PACIFIC]);
      layer.deactivate(map);
      await layer.activate(map);
      await settle();
      assert.deepEqual(labelsIn(weeks, watch.latest(), ['pacific-coast', 'southeast-gulf']), {
        'pacific-coast': ['Drought persists', 'Drought improves'],
        'southeast-gulf': []
      });
      // A reissue, read once the layer's own one-hour cache has lapsed.
      monthly = collection([{ outlook: 'Development' }, GULF]);
      clockOffset += 2 * 60 * 60 * 1000;
      layer.deactivate(map);
      await layer.activate(map);
      await settle();
      assert.deepEqual(labelsIn(weeks, watch.latest(), ['pacific-coast', 'southeast-gulf']), {
        'pacific-coast': [],
        'southeast-gulf': ['Drought develops']
      });
      // The horizon: Season ahead is its own cell, and the layer follows the register.
      watch.stop();
      assert.equal(minimapReading('drought', 'season-ahead'), seasonRow);
      watch = watchRow(map, seasonRow);
      timeline.setHorizon('season-ahead');
      await until(() => watch.latest().status === 'live' && outlookLabels(seasonRow.outlook, watch.latest(), 'arid-west').length > 0, 'the seasonal register');
      assert.deepEqual(labelsIn(seasonRow, watch.latest(), ['pacific-coast', 'arid-west', 'southeast-gulf']), {
        'pacific-coast': ['Drought removal likely'],
        'arid-west': ['Drought develops'],
        'southeast-gulf': []
      });
      assert.equal(weeksRow.outlook, seasonRow.outlook);
    } finally {
      watch.stop();
      layer.deactivate(map);
      registry.deactivate('drought');
      timeline.reset();
      clockOffset = 0;
      seasonRow.on = false;
    }
  });
});

// ---------------------------------------------------------------------------
// 5 (shipped) and 6. The Wildfire reading at Current
// ---------------------------------------------------------------------------

const FIVE_MINUTES = 5 * 60_000;

/** Retain the shipped Wildfire feed with the count upstream stubbed by framing, first answering `counts`. */
async function retainWildfire(counts, run) {
  const wildfire = await import('../src/state/minimap-wildfire.ts');
  const byGeometry = new Map(FRAMING_KEYS.map((key) => [wildfire.buildMinimapWildfireQueryBody(key).get('geometry'), key]));
  const state = { counts, posts: 0, refresh: null, seen: [] };
  answer = (_url, init) => {
    state.posts += 1;
    const key = byGeometry.get(new URLSearchParams(String(init?.body ?? '')).get('geometry'));
    return { count: state.counts[key] ?? 0 };
  };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === FIVE_MINUTES) {
      state.refresh = fn;
      return 0;
    }
    return realSetTimeout(fn, ms, ...args);
  };
  const release = wildfire.retainMinimapWildfire((next) => state.seen.push(next));
  try {
    await run(state, () => state.seen.at(-1));
  } finally {
    release();
    globalThis.setTimeout = realSetTimeout;
    registry.deactivate('nifc-fires');
  }
}

test('the shipped Wildfire reading at Current: the count upstream swapped between two fixtures moves it on its own five-minute refresh', async () => {
  await retainWildfire({ 'pacific-coast': 2 }, async (state, latest) => {
    await until(() => latest()?.checkedAtUtc != null, 'the first read');
    const first = latest();
    assert.equal(first.summaries['pacific-coast'].condition, 'mapped-wildfire');
    assert.equal(first.summaries['pacific-coast'].mappedWildfirePerimeterCount, 2);
    assert.notEqual(first.summaries['arid-west'].condition, 'mapped-wildfire');
    state.counts = { 'arid-west': 12 };
    assert.equal(typeof state.refresh, 'function', 'the refresh is scheduled after a completed read');
    state.refresh();
    await until(() => latest() !== first && latest()?.checkedAtUtc != null, 'the refresh');
    const second = latest();
    assert.equal(second.summaries['pacific-coast'].mappedWildfirePerimeterCount, 0);
    assert.notEqual(second.summaries['pacific-coast'].condition, 'mapped-wildfire');
    assert.equal(second.summaries['arid-west'].condition, 'mapped-wildfire');
    assert.equal(second.summaries['arid-west'].mappedWildfirePerimeterCount, 12);
  });
});

test('finding ("fire seems static"): the shipped Wildfire reading follows only its own timer; a reload of the perimeter layer does not re-read it', async () => {
  await retainWildfire({ 'pacific-coast': 1 }, async (state, latest) => {
    await until(() => latest()?.checkedAtUtc != null, 'the first read');
    const first = latest();
    assert.equal(first.summaries['pacific-coast'].mappedWildfirePerimeterCount, 1);
    assert.equal(state.posts, FRAMING_KEYS.length, 'one count POST per framing');
    // The perimeter layer reloads (a pan out of its envelope, or its own refresh)
    // with different perimeters; the minimap does not hear it.
    state.counts = { 'arid-west': 4 };
    registry.activate('nifc-fires');
    registry.setStatus('nifc-fires', 'loading');
    registry.setStatus('nifc-fires', 'ready');
    await settle();
    assert.equal(latest(), first, 'no new reading');
    assert.equal(state.posts, FRAMING_KEYS.length, 'no new read');
    // Only its five-minute timer reads again.
    state.refresh();
    await until(() => latest() !== first, 'the refresh');
    assert.equal(latest().summaries['arid-west'].mappedWildfirePerimeterCount, 4);
  });
});
