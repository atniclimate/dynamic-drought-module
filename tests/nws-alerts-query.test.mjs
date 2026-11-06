import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });

const { buildNwsAlertPopupModel, buildQueryUrl, parseMapPayload } = await import('../src/layers/nws-alerts.ts');
const { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS, HEAT_FIRE_ALERTS, TEMPORAL_HORIZON_KEYS } = await import('../src/config/clusters.ts');
const { TROPICAL_WW_CLASSES } = await import('../src/config/tropical-presentation.ts');
const { getLayerDef } = await import('../src/config/layers.ts');
const { NWS_ALERT_COLORS, NWS_ALERT_LEGEND } = await import('../src/config/palette.ts');
const { getHazardCluster, setHazardCluster } = await import('../src/state/cluster-store.ts');

// The heat and fire weather query exactly as the layer sent it before modes named their own products
// (recorded from 10c9690, 2026-11-05): heat, wildfire and every custom layer set must keep sending it.
const HEAT_FIRE_QUERY =
  'https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=prod_type+IN+%28%27Extreme+Heat+Warning%27%2C%27Excessive+Heat+Warning%27%2C%27Extreme+Heat+Watch%27%2C%27Excessive+Heat+Watch%27%2C%27Heat+Advisory%27%2C%27Red+Flag+Warning%27%2C%27Fire+Weather+Watch%27%29&outFields=prod_type%2Conset%2Cends%2Cexpiration%2Cwfo&outSR=4326&returnGeometry=true&f=geojson&maxAllowableOffset=0.002&geometryPrecision=5';

// The flood, storm, wind and coastal Warnings and Watches, each a prod_type value of the service's own renderer
// (MapServer/1?f=json, read 2026-11-06), in group order and the NWS priority order within a group.
const ENSO_PRODUCTS = [
  'Flash Flood Warning', 'Flood Warning', 'Flash Flood Watch', 'Flood Watch',
  'Typhoon Warning', 'Blizzard Warning', 'Ice Storm Warning', 'Winter Storm Warning', 'Typhoon Watch', 'Winter Storm Watch',
  'Extreme Wind Warning', 'High Wind Warning', 'High Wind Watch',
  'Storm Surge Warning', 'Coastal Flood Warning', 'Lakeshore Flood Warning', 'High Surf Warning',
  'Storm Surge Watch', 'Coastal Flood Watch', 'Lakeshore Flood Watch'
];
const ENSO = HAZARD_CLUSTERS.enso.alerts.events;

/** The product names a query's `where` clause asks for, in order. */
function askedFor(url) {
  const where = new URL(url).searchParams.get('where') ?? '';
  const listed = /^prod_type IN \((.*)\)$/.exec(where);
  assert.ok(listed, where);
  return listed[1].split(',').map((quoted) => quoted.replace(/^'|'$/g, ''));
}

test('heat, wildfire and every custom layer set (Drought) send the heat and fire weather query byte for byte', () => {
  for (const mode of ['heat', 'wildfire', 'drought']) {
    assert.equal(HAZARD_CLUSTERS[mode].alerts, HEAT_FIRE_ALERTS, mode);
    assert.equal(buildQueryUrl(HAZARD_CLUSTERS[mode].alerts.events), HEAT_FIRE_QUERY, mode);
  }
});

test('the ENSO query asks for exactly its flood, storm, wind and coastal Warnings and Watches, and nothing else changes', () => {
  const url = buildQueryUrl(ENSO);
  assert.deepEqual(askedFor(url), ENSO_PRODUCTS);
  assert.ok(ENSO_PRODUCTS.every((name) => / (Warning|Watch)$/.test(name)), 'no advisory or statement');
  const enso = new URL(url);
  const heat = new URL(HEAT_FIRE_QUERY);
  assert.equal(enso.origin + enso.pathname, heat.origin + heat.pathname);
  for (const key of ['outFields', 'outSR', 'returnGeometry', 'f', 'maxAllowableOffset', 'geometryPrecision']) {
    assert.equal(enso.searchParams.get(key), heat.searchParams.get(key), key);
  }
  // ENSO's storm layer already keys the hurricane center's own watches and warnings; the alert set never repeats a name.
  for (const { label } of TROPICAL_WW_CLASSES) assert.equal(ENSO.includes(label), false, label);
});

test('the alert popup describes only the heat and fire weather products; an end the alert leaves open reads not stated', () => {
  const red = buildNwsAlertPopupModel({ event: 'Red Flag Warning', onset: '2026-08-11T08:00:00-07:00', ends: '2026-08-12T20:00:00-07:00' });
  assert.equal(red.qualifications.length, 1);
  assert.match(red.qualifications[0], /for extreme heat or fire weather\. Polygons are NWS forecast-zone shapes/);
  assert.deepEqual(red.moreLinks, [{ label: 'NWS Heat Safety', href: 'https://www.weather.gov/safety/heat' }]);
  assert.deepEqual(red.clocks.map((clock) => clock.label), ['From', 'Until']);
  const flood = buildNwsAlertPopupModel({ event: 'Flash Flood Warning', onset: '2026-11-05T20:09:00-06:00', ends: null, issuer: 'KDVN' });
  assert.deepEqual(flood.qualifications, []);
  assert.deepEqual(flood.moreLinks, []);
  assert.deepEqual(flood.clocks.at(-1), { kind: 'not-stated', label: 'End', reason: 'not stated' });
  assert.deepEqual(buildNwsAlertPopupModel({ event: 'Red Flag Warning' }).clocks, [{ kind: 'not-stated', label: 'End', reason: 'not stated' }]);
});

test('the WWA alerts query asks the service for simplified, rounded shapes', () => {
  const params = new URL(buildQueryUrl(HEAT_FIRE_ALERTS.events)).searchParams;
  // Measured 2026-10-15: 1.88 MB gzipped at full detail, 224 KB with these two.
  assert.equal(params.get('maxAllowableOffset'), '0.002');
  assert.equal(params.get('geometryPrecision'), '5');
  assert.equal(params.get('outSR'), '4326');
  assert.equal(params.get('f'), 'geojson');
  assert.match(params.get('where') ?? '', /^prod_type IN \(/);
});

test('every mode that names alert products gives each an issuer colour and its own key rows, in event order', () => {
  for (const mode of HAZARD_CLUSTER_KEYS) {
    const set = HAZARD_CLUSTERS[mode].alerts;
    if (set === undefined) continue;
    assert.ok(set.name.length > 0 && set.events.length > 0, mode);
    for (const event of set.events) assert.ok(Object.hasOwn(NWS_ALERT_COLORS, event), `${mode}: ${event} has no colour`);
    // The retired Excessive Heat names share their current name's row.
    assert.deepEqual(
      NWS_ALERT_LEGEND.filter(({ label }) => set.events.includes(label)).map(({ label }) => label),
      set.events.filter((event) => !event.startsWith('Excessive ')),
      mode
    );
  }
});

test('ENSO offers the alert layer off by default at every horizon: in no recipe, an optional layer, never default-on', () => {
  for (const horizon of TEMPORAL_HORIZON_KEYS) {
    assert.equal(HAZARD_CLUSTERS.enso.recipes[horizon].includes('nws-alerts'), false, horizon);
  }
  assert.deepEqual(HAZARD_CLUSTERS.enso.optionalLayers, ['cpc-seasonal-temp', 'cpc-610-precip', 'cpc-610-temp', 'cpc-814-temp', 'nws-alerts']);
  assert.equal(getLayerDef('nws-alerts').defaultOn, false);
});

test('the layer carries the committed mode\'s name', () => {
  const before = getHazardCluster();
  try {
    for (const mode of HAZARD_CLUSTER_KEYS) {
      setHazardCluster(mode);
      assert.equal(getLayerDef('nws-alerts').name, (HAZARD_CLUSTERS[mode].alerts ?? HEAT_FIRE_ALERTS).name, mode);
    }
    setHazardCluster('heat');
    assert.equal(getLayerDef('nws-alerts').name, 'Heat & Fire Weather Alerts');
    setHazardCluster('enso');
    assert.equal(getLayerDef('nws-alerts').name, 'Flood, Storm, Wind & Coastal Alerts');
  } finally {
    setHazardCluster(before);
  }
});

const SQUARE = { type: 'Polygon', coordinates: [[[-123, 46], [-122, 46], [-122, 47], [-123, 47], [-123, 46]]] };
const wwa = (properties, geometry = SQUARE) => ({ type: 'Feature', properties, geometry });
const collection = (features, extra = {}) => ({ type: 'FeatureCollection', features, ...extra });

test('the reader hands on one shape, event, onset, ends, geometry and issuer, with unknown times left unknown', () => {
  const payload = parseMapPayload(collection([
    // As the service answered on 2026-11-06: ISO text with the office's offset, an open end sent as one space.
    wwa({ prod_type: 'Flood Warning', onset: '2026-11-05T20:36:00-06:00', ends: '2026-11-08T02:16:00-06:00', expiration: '2026-11-06T20:45:00-06:00', wfo: 'KDVN' }),
    wwa({ prod_type: 'Flood Warning', onset: '2026-11-05T20:09:00-06:00', ends: ' ', expiration: '2026-11-06T20:45:00-06:00', wfo: ' ' }),
    // No onset at all, and epoch milliseconds (the browser stubs send them).
    wwa({ prod_type: 'High Wind Watch', ends: Date.UTC(2026, 10, 7, 12), expiration: Date.UTC(2026, 10, 7, 12) })
  ]), ENSO);
  assert.ok(payload);
  assert.equal(payload.truncated, false);
  const alerts = payload.held.map(({ alert }) => alert);
  for (const alert of alerts) assert.deepEqual(Object.keys(alert).sort(), ['ends', 'event', 'geometry', 'issuer', 'onset']);
  assert.deepEqual(alerts[0], {
    event: 'Flood Warning', onset: '2026-11-05T20:36:00-06:00', ends: '2026-11-08T02:16:00-06:00', geometry: SQUARE, issuer: 'KDVN'
  });
  // The open end stays unknown: it is not filled from the product's expiration.
  assert.deepEqual(alerts[1], { event: 'Flood Warning', onset: '2026-11-05T20:09:00-06:00', ends: null, geometry: SQUARE, issuer: null });
  assert.deepEqual(alerts[2], { event: 'High Wind Watch', onset: null, ends: '2026-11-07T12:00:00.000Z', geometry: SQUARE, issuer: null });
  // The product's own expiration says only when to stop drawing it between reads.
  assert.deepEqual(payload.held.map(({ expiresAt }) => expiresAt), [
    Date.parse('2026-11-06T20:45:00-06:00'), Date.parse('2026-11-06T20:45:00-06:00'), Date.UTC(2026, 10, 7, 12)
  ]);
});

test('a malformed answer is unreadable, never zero alerts', () => {
  const good = { prod_type: 'Flood Warning', onset: '2026-11-05T20:36:00-06:00', ends: '2026-11-08T02:16:00-06:00', expiration: '2026-11-06T20:45:00-06:00', wfo: 'KDVN' };
  for (const [why, body] of [
    ['no features array', { type: 'FeatureCollection' }],
    ['an ArcGIS error body', { error: { code: 400, message: 'Invalid query' } }],
    ['a product not asked for', collection([wwa({ ...good, prod_type: 'Red Flag Warning' })])],
    ['an unreadable time', collection([wwa({ ...good, ends: 'Tonight' })])],
    ['no window at all', collection([wwa({ ...good, ends: ' ', expiration: null })])],
    ['a point, not a polygon', collection([wwa(good, { type: 'Point', coordinates: [-122, 47] })])],
    ['an office that is not text', collection([wwa({ ...good, wfo: 7 })])],
    ['a transfer flag that is not a boolean', collection([], { exceededTransferLimit: 'yes' })]
  ]) {
    assert.equal(parseMapPayload(body, ENSO), null, why);
  }
  assert.deepEqual(parseMapPayload(collection([]), ENSO), { held: [], truncated: false });
  assert.equal(parseMapPayload(collection([], { exceededTransferLimit: true }), ENSO).truncated, true);
});
