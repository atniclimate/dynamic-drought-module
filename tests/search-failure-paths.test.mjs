import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { foldSearchText, matchesTokens, prefixFirst } from '../src/util/search-fold.ts';

/**
 * The search controller's failure paths (the 2026-10-19 live-review block,
 * findings 6 and 8), run against the REAL src/ui/search-controller.ts and the
 * REAL body-bounded fetch helper and the REAL roster module reading the
 * bundled public/data/tribal-roster.json, with only `fetch` and the
 * controller's map and panel neighbours replaced by in-memory stand-ins.
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
  toasts: [],
  lazyLoads: 0
});

const STUBS = {
  '../config/layers': 'export const LAYER_DEFS = [];',
  '../config/urls':
    'export const URLS = { usPlacesLocal: "https://stub.test/us-places.json",' +
    ' biaLarFeatureServer: "https://stub.test/lar", censusAiannhMapServer: "https://stub.test/census" };',
  '../impact/resources': 'export const STATE_LABEL = {};',
  '../impact/context':
    'export const buildBoundaryContext = (_k, _p, _g, _l, t) => ({ title: t || "Located area" });',
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
  './mobile-sheet': 'export const isSheetActive = () => false;',
  './layer-toggle-command': 'export const requestLayerOn = () => {};',
  './impact-panel':
    'let n = 0; export const nextBriefingIntent = () => ++n;' +
    ' export const isCurrentBriefingIntent = (i) => i === n; export const openImpactPanel = () => {};',
  './overlay': 'export const showToast = (t) => globalThis.__sfp.toasts.push(t);',
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
const fetchUrls = [];
globalThis.fetch = async (url, init) => {
  const key = String(url).split('?')[0];
  fetchCalls.push(key);
  fetchUrls.push(String(url));
  const answer = answers.get(key);
  if (!answer) throw new TypeError(`no stub for ${key}`);
  return answer(init);
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CITY_URL = 'https://stub.test/us-places.json';
const LAR_URL = 'https://stub.test/lar/query';
const CENSUS_URL = 'https://stub.test/census/47/query';
const flush = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(predicate) {
  for (let i = 0; i < 200 && !predicate(); i += 1) await flush();
  assert.ok(predicate(), 'condition reached');
}

// The roster module's same-origin URL outside Vite (src/state/tribal-roster.ts ROSTER_URL).
const ROSTER = readFileSync(new URL('../public/data/tribal-roster.json', import.meta.url));
answers.set('/dynamic-drought-module/data/tribal-roster.json', () => new Response(ROSTER, { status: 200 }));

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

test('a census: result locates against the Census service; an HTTP 200 error envelope is unavailable', async () => {
  const censusItem = {
    kind: 'tribal',
    id: 'census:5620',
    label: 'The Muscogee (Creek) Nation',
    haystack: 'muscogee'
  };
  answers.set(CENSUS_URL, () => json(fc));
  S.selections.length = 0;
  S.highlights.length = 0;
  const callsBefore = fetchCalls.length;
  const heldBefore = S.held.length;
  wiring.onSelect(censusItem);
  await waitFor(() => S.held.length > heldBefore);
  S.held.at(-1)();
  await waitFor(() => S.highlights.length === 1);
  const sent = fetchUrls.slice(callsBefore);
  assert.equal(sent.length, 1, 'one boundary query');
  assert.equal(sent[0].split('?')[0], CENSUS_URL, 'routed to the Census service');
  assert.equal(new URL(sent[0]).searchParams.get('where'), "AIANNH='5620'");
  assert.ok(!fetchCalls.slice(callsBefore).includes(LAR_URL), 'the BIA LAR service is never asked');
  assert.equal(S.selections.length, 1);

  answers.set(CENSUS_URL, () => json({ error: { code: 400, message: 'Invalid query' } }));
  S.selections.length = 0;
  S.highlights.length = 0;
  S.toasts.length = 0;
  wiring.onSelect(censusItem);
  await waitFor(() => S.toasts.length === 1);
  assert.match(S.toasts[0], /^Could not reach/, 'an error envelope reads as unavailable, not as no boundary');
  assert.equal(S.selections.length, 0, 'no selection from an error envelope');
  assert.equal(S.highlights.length, 0);
});

test('a search pick titles its selection with the row label and keeps the area name as its source label', async () => {
  answers.set(CENSUS_URL, () => json(fc));
  S.selections.length = 0;
  S.highlights.length = 0;
  let heldBefore = S.held.length;
  wiring.onSelect({
    kind: 'tribal',
    id: 'census:5620',
    label: 'The Muscogee (Creek) Nation',
    sublabel: 'Census area: Creek OTSA',
    haystack: 'muscogee'
  });
  await waitFor(() => S.held.length > heldBefore);
  S.held.at(-1)();
  await waitFor(() => S.selections.length === 1);
  assert.equal(S.selections[0].label, 'The Muscogee (Creek) Nation', 'the formal name, never the Census short name');
  assert.equal(S.selections[0].context.areaLabel, 'Census area: Creek OTSA');

  // A row whose label is the land area's own name carries no separate source label.
  answers.set(LAR_URL, () => json(fc));
  S.selections.length = 0;
  heldBefore = S.held.length;
  wiring.onSelect(tribalItem);
  await waitFor(() => S.held.length > heldBefore);
  S.held.at(-1)();
  await waitFor(() => S.selections.length === 1);
  assert.equal(S.selections[0].label, 'Alpha Land Area');
  assert.equal(S.selections[0].context.areaLabel, undefined);
});

test('a formal Oklahoma Nation name lists its Census area first, never a land area in another state', async () => {
  // The real loadTribal items (haystacks included), filtered and ranked as search.tsx
  // does (tribal-census-search.test.mjs pins the filter line there).
  const items = (await wiring.loadTribal()).filter((i) => i.kind === 'tribal');
  const hits = (q) => {
    const folded = foldSearchText(q);
    const tokens = folded.split(' ');
    return prefixFirst(
      items.filter((i) => matchesTokens(i.haystack, tokens, i.id.startsWith('census:'))),
      folded
    );
  };
  const census = JSON.parse(String(ROSTER)).censusAreas;
  const code = (name) => census.find((a) => a.name === name).aiannh;
  const kickapoo = hits('Kickapoo Tribe of Oklahoma');
  assert.equal(kickapoo[0]?.id, `census:${code('Kickapoo OTSA')}`);
  assert.ok(!kickapoo.some((i) => i.label.startsWith('Kickapoo Traditional')), 'the Texas Tribe is not listed');
  const choctaw = hits('Choctaw Nation of Oklahoma');
  assert.equal(choctaw[0]?.id, `census:${code('Choctaw OTSA')}`);
  assert.ok(!choctaw.some((i) => i.label.includes('Jena Band')), 'the Louisiana Band is not listed');
  assert.equal(hits('Sac and Fox Nation')[0]?.id, `census:${code('Sac and Fox OTSA')}`);
  assert.equal(hits('Iowa Tribe of Oklahoma')[0]?.id, `census:${code('Iowa OTSA')}`);
  assert.equal(hits('Cherokee Nation')[0]?.id, `census:${code('Cherokee OTSA')}`);

  // Opening that row asks the Census service for the Kickapoo OTSA's AIANNH code.
  answers.set(CENSUS_URL, () => json(fc));
  const callsBefore = fetchUrls.length;
  const heldBefore = S.held.length;
  wiring.onSelect(kickapoo[0]);
  await waitFor(() => S.held.length > heldBefore);
  S.held.at(-1)();
  await waitFor(() => fetchUrls.length > callsBefore);
  const sent = fetchUrls.slice(callsBefore);
  assert.equal(sent[0].split('?')[0], CENSUS_URL);
  assert.equal(new URL(sent[0]).searchParams.get('where'), `AIANNH='${code('Kickapoo OTSA')}'`);
});

// The REAL src/ui/island/search.tsx, transpiled by the installed rolldown (oxc) and
// rendered as a plain function: preact/hooks and the JSX runtime are in-memory
// stand-ins (state lives in globalThis.__sh; a "render" is one call of Search).
const H = (globalThis.__sh = { slots: [], i: 0 });
const SEARCH_STUBS = {
  'preact/hooks':
    'const H = globalThis.__sh;' +
    ' export function useState(init) { const i = H.i++; if (!(i in H.slots)) H.slots[i] = init;' +
    ' return [H.slots[i], (v) => { H.slots[i] = typeof v === "function" ? v(H.slots[i]) : v; }]; }' +
    ' export function useRef(init) { const i = H.i++; if (!(i in H.slots)) H.slots[i] = { current: init }; return H.slots[i]; }' +
    ' export const useId = () => "s";',
  'preact/jsx-runtime':
    'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = "f";'
};
const { transformSync } = await import('rolldown/utils');
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = typeof context.parentURL === 'string' ? context.parentURL : '';
    if (!parent.endsWith('/src/ui/island/search.tsx')) return nextResolve(specifier, context);
    if (specifier in SEARCH_STUBS) return { url: dataUrl(SEARCH_STUBS[specifier]), shortCircuit: true };
    return nextResolve(specifier.startsWith('.') ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('/src/ui/island/search.tsx')) return nextLoad(url, context);
    const { code } = transformSync(url, readFileSync(fileURLToPath(url), 'utf8'), {
      jsx: { runtime: 'automatic', importSource: 'preact' }
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
});
const { Search } = await import('../src/ui/island/search.tsx');

function walk(node, visit) {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object' && node.props) {
    visit(node);
    walk(node.props.children, visit);
  }
}


const WA = { kind: 'place', id: 'WA', label: 'Washington', haystack: 'washington' };
const WASHOE = [{ kind: 'tribal', id: 'Washoe', label: 'Washoe', haystack: 'washoe' }];

/** A loader whose every call waits until the test settles it. */
function heldLoader() {
  const l = { calls: 0, pending: [] };
  l.load = () => {
    l.calls += 1;
    return new Promise((resolve, reject) => l.pending.push({ resolve, reject }));
  };
  return l;
}

/** A mounted Search over the State "Washington" and the given lazy loaders. */
function mountSearch(loaders) {
  H.slots = [];
  const h = { selected: [] };
  const props = {
    items: [WA],
    ...loaders,
    onSelect: (item) => h.selected.push(item),
    placeholder: 'Search'
  };
  h.render = () => {
    H.i = 0;
    const out = { input: undefined, rows: [], loading: 0, unavailable: false, live: '' };
    walk(Search(props), (n) => {
      if (n.type === 'input') out.input = n.props;
      if (n.props.class === 'ddm-search-loading') out.loading += 1;
      if (n.props.class === 'ddm-search-unavailable') out.unavailable = true;
      if (n.props.class === 'ddm-search-live') out.live = n.props.children;
      if (n.props['data-search-kind']) out.rows.push(`${n.props['data-search-kind']}:${n.props['data-search-id']}`);
    });
    return out;
  };
  h.type = (value) => h.render().input.onInput({ currentTarget: { value } });
  h.focus = () => h.render().input.onFocus();
  h.key = (key) => h.render().input.onKeyDown({ key, preventDefault() {} });
  return h;
}

test('while either list loads, the results show one loading line and no rows', async () => {
  const tribal = heldLoader();
  const cities = heldLoader();
  const h = mountSearch({ loadTribal: tribal.load, loadCities: cities.load });
  h.type('wash');
  let shown = h.render();
  assert.equal(shown.loading, 1, 'one loading line');
  assert.deepEqual(shown.rows, [], 'no row is on screen to move');
  assert.equal(shown.live, 'Loading search results.');
  h.key('Enter');
  assert.deepEqual(h.selected, [], 'Enter opens nothing while the lists load');

  tribal.pending[0].resolve(WASHOE);
  await flush();
  shown = h.render();
  assert.deepEqual(shown.rows, [], 'one list landed, the other still loads: still no rows');
  assert.equal(shown.loading, 1);

  cities.pending[0].resolve([]);
  await flush();
  shown = h.render();
  assert.deepEqual(shown.rows, ['tribal:Washoe', 'place:WA'], 'both groups show at once');
  assert.equal(shown.loading, 0);
  assert.equal(shown.live, '2 results.');
});

test('after a failed Tribal load, further keystrokes do not retry and the shown rows stay', async () => {
  const tribal = heldLoader();
  const h = mountSearch({ loadTribal: tribal.load });
  h.type('wash');
  tribal.pending[0].reject(new Error('timed out'));
  await flush();
  let shown = h.render();
  assert.deepEqual(shown.rows, ['place:WA'], 'States show under the failure line');
  assert.ok(shown.unavailable, 'the unavailable line, never "No matches"');

  h.type('washi');
  h.type('washin');
  assert.equal(tribal.calls, 1, 'a keystroke into a list on screen does not retry');
  shown = h.render();
  assert.deepEqual(shown.rows, ['place:WA']);
  assert.ok(shown.unavailable);
  assert.equal(shown.loading, 0);
});

test('clearing the box and typing again retries, shows loading, then the rows with no failure line', async () => {
  const tribal = heldLoader();
  const h = mountSearch({ loadTribal: tribal.load });
  h.type('wash');
  tribal.pending[0].reject(new Error('timed out'));
  await flush();
  assert.ok(h.render().unavailable);

  h.type('');
  assert.equal(tribal.calls, 1, 'clearing alone does not retry');
  h.type('w');
  assert.equal(tribal.calls, 2, 'the new search retries');
  let shown = h.render();
  assert.equal(shown.loading, 1);
  assert.deepEqual(shown.rows, []);
  assert.equal(shown.unavailable, false);

  tribal.pending[1].resolve(WASHOE);
  await flush();
  shown = h.render();
  assert.deepEqual(shown.rows, ['tribal:Washoe', 'place:WA'], 'no other action needed');
  assert.equal(shown.unavailable, false);
  assert.equal(shown.loading, 0);
});

test('focus with a query in the box does not retry; focus on an empty box does', async () => {
  const tribal = heldLoader();
  const h = mountSearch({ loadTribal: tribal.load });
  h.type('wash');
  tribal.pending[0].reject(new Error('timed out'));
  await flush();

  h.focus();
  assert.equal(tribal.calls, 1, 'focus on a list on screen does not retry');
  assert.deepEqual(h.render().rows, ['place:WA']);

  h.type('');
  h.focus();
  assert.equal(tribal.calls, 2, 'focus on an empty box begins a search');
});
