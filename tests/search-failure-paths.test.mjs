import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The search controller's failure paths (the 2026-10-19 live-review block,
 * findings 6 and 8), run against the REAL src/ui/search-controller.ts and the
 * REAL body-bounded fetch helper, with only `fetch` and the controller's
 * map, panel and roster neighbours replaced by in-memory stand-ins.
 *
 *   6. A failed or malformed city index is a failure, never a cached empty
 *      success: the city loader rejects, a later call retries, and the Tribal
 *      list never waits on the city fetch.
 *   8. The shared Tribal locator commits its selection and highlight only if
 *      it is still the current intent after its last await (the lazy
 *      point-in-polygon import).
 */

const S = (globalThis.__sfp = {
  selections: [],
  highlights: [],
  held: [],
  lazyLoads: 0
});

const STUBS = {
  '../config/layers': 'export const LAYER_DEFS = [];',
  '../config/urls':
    'export const URLS = { usPlacesLocal: "https://stub.test/us-places.json",' +
    ' biaLarFeatureServer: "https://stub.test/lar", censusAiannhMapServer: "https://stub.test/census" };',
  '../impact/resources': 'export const STATE_LABEL = {};',
  '../impact/context': 'export const buildBoundaryContext = () => ({ title: "Located area" });',
  '../util/bbox':
    'export const bboxCenter = () => ({ lng: 0, lat: 0 }); export const bboxToContinuousBounds = (b) => b;',
  '../util/antimeridian': 'export const geometryBboxAcrossAntimeridian = () => [0, 0, 1, 1];',
  '../state/deep-link': 'export const openStateBriefing = async () => {};',
  '../state/located-boundary':
    'export const showLocatedBoundary = (_m, g) => globalThis.__sfp.highlights.push(g);',
  '../state/view-mode': 'export const getViewMode = () => "brief";',
  '../state/place-selection':
    'export const onPlaceSelectionChange = () => () => {};' +
    ' export const setPlaceSelection = (s) => globalThis.__sfp.selections.push(s);',
  '../state/tribal-roster':
    'export const loadTribalRoster = async () => [{ larName: "Alpha Land Area" }];' +
    ' export const loadTribalCensusAreas = async () => [];' +
    ' export const gatedDisplayName = (a) => a.larName; export const gatedCensusName = (a) => a.name;',
  './mobile-sheet': 'export const isSheetActive = () => false;',
  './layer-toggle-command': 'export const requestLayerOn = () => {};',
  './impact-panel':
    'let n = 0; export const nextBriefingIntent = () => ++n;' +
    ' export const isCurrentBriefingIntent = (i) => i === n; export const openImpactPanel = () => {};',
  './overlay': 'export const showToast = () => {};',
  './island/search': 'export const Search = () => null;'
};
const HELD_PIP =
  'await new Promise((release) => globalThis.__sfp.held.push(release));' +
  ' export const representativePoint = () => ({ lng: 0.5, lat: 0.5 });';
const dataUrl = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = typeof context.parentURL === 'string' ? context.parentURL : '';
    if (parent.endsWith('/src/ui/search-controller.ts')) {
      if (specifier === '../util/point-in-polygon') {
        S.lazyLoads += 1;
        return { url: `${dataUrl(HELD_PIP)}#${S.lazyLoads}`, shortCircuit: true };
      }
      if (specifier in STUBS) return { url: dataUrl(STUBS[specifier]), shortCircuit: true };
    }
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && parent.endsWith('.ts')) {
      const candidate = new URL(`${specifier}.ts`, parent);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

/** Per-URL answers: a function returning a Response (or a never-settling promise). */
const answers = new Map();
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  const key = String(url).split('?')[0];
  fetchCalls.push(key);
  const answer = answers.get(key);
  if (!answer) throw new TypeError(`no stub for ${key}`);
  return answer(init);
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CITY_URL = 'https://stub.test/us-places.json';
const LAR_URL = 'https://stub.test/lar/query';
const flush = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(predicate) {
  for (let i = 0; i < 200 && !predicate(); i += 1) await flush();
  assert.ok(predicate(), 'condition reached');
}

const map = { fitBounds() {}, easeTo() {}, getZoom: () => 3 };
const { buildSearchWiring } = await import('../src/ui/search-controller.ts');
const wiring = buildSearchWiring(map);

test('the Tribal list resolves without fetching or waiting on the city index', async () => {
  // A city fetch that never answers until aborted.
  answers.set(CITY_URL, (init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  let timer;
  const items = await Promise.race([
    wiring.loadTribal(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the Tribal list waited on the city index')), 1000);
    })
  ]).finally(() => clearTimeout(timer));
  assert.ok(items.some((i) => i.kind === 'tribal'));
  assert.ok(!items.some((i) => i.kind === 'city'));
  assert.ok(!fetchCalls.includes(CITY_URL), 'the Tribal loader never touches the city index');
  assert.equal(typeof wiring.loadCities, 'function', 'cities load through their own loader');
});

test('a malformed or failed city index rejects, is not cached, and a later call retries', async () => {
  answers.set(CITY_URL, () => json({ places: 'not a list' }));
  await assert.rejects(wiring.loadCities(), 'a malformed payload is a failure');
  answers.set(CITY_URL, () => json({ error: 'gone' }, 503));
  await assert.rejects(wiring.loadCities(), 'an HTTP failure is a failure');

  answers.set(CITY_URL, () =>
    json({ places: [{ name: 'Seattle', lon: -122.3, lat: 47.6, rank: 1 }] })
  );
  const cities = await wiring.loadCities();
  assert.deepEqual(
    cities.map((c) => [c.kind, c.id]),
    [['city', 'Seattle']]
  );
  const before = fetchCalls.length;
  assert.equal(await wiring.loadCities(), cities, 'a success is cached');
  assert.equal(fetchCalls.length, before, 'the cached success does not refetch');
});

const tribalItem = { kind: 'tribal', id: 'Alpha Land Area', label: 'Alpha Land Area', haystack: 'alpha' };
const fc = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { LARNAME: 'Alpha Land Area' },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
    }
  ]
};

test('a locate still current after the lazy import commits its selection and highlight', async () => {
  answers.set(LAR_URL, () => json(fc));
  S.selections.length = 0;
  S.highlights.length = 0;
  const heldBefore = S.held.length;
  wiring.onSelect(tribalItem);
  await waitFor(() => S.held.length > heldBefore);
  S.held.at(-1)();
  await waitFor(() => S.highlights.length === 1);
  assert.equal(S.selections.length, 1);
});

test('a city chosen during the lazy import wins: the earlier locate commits nothing', async () => {
  answers.set(LAR_URL, () => json(fc));
  S.selections.length = 0;
  S.highlights.length = 0;
  const heldBefore = S.held.length;
  wiring.onSelect(tribalItem);
  await waitFor(() => S.held.length > heldBefore);
  wiring.onSelect({ kind: 'city', id: 'Seattle', label: 'Seattle', haystack: 'seattle' });
  S.held.at(-1)();
  for (let i = 0; i < 20; i += 1) await flush();
  assert.equal(S.selections.length, 0, 'no stale selection');
  assert.equal(S.highlights.length, 0, 'no stale highlight');
});
