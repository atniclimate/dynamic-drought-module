import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Drive the real panel lifecycle and status writer. As in the coordinator's
// Node tests, the DOM records text and roles; browser CSS/AT exposure belongs
// to the paired browser cases. No geometry or accessibility tree is mocked.
const stub = (source) => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTs = context.parentURL?.endsWith('.ts');
    if (fromTs && specifier.endsWith('.css')) return stub('export {};');
    if (fromTs && specifier === '../map/layer-order') return stub('export function reassertThematicOrder() {}');
    if (fromTs && specifier === '../state/enso-flow') return stub(`
      export function parseEnsoFlowParams(params) { return { kind: params.get('flow') ?? 'off', ink: 'light' }; }
      export function syncEnsoFlowParams() {}
    `);
    if (fromTs && specifier === '../util/fetch') return stub(`
      export function fetchJsonWithBudget(url, options, signal) { return globalThis.__flowRead(url, signal); }
    `);
    if (fromTs && specifier === './flow/index') return stub(`
      export const MAX_CYCLE_TRIES = 1;
      export const candidateCycle = () => globalThis.__field.meta.cycle;
      export const forecastHourFor = () => 6;
      export const isStale = () => false;
      export const readFlowFrame = async () => globalThis.__field;
      export function mountFlowView(map, field, options) {
        globalThis.__fieldState = options.onState;
        return { state: globalThis.__state, dispose() {}, halt() {}, setInk() {} };
      }
    `);
    if (fromTs && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

class Element extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.hidden = false;
    this.rendered = true;
    this.visibility = 'visible';
    this.writes = [];
    this.text = '';
  }
  set textContent(value) { this.text = String(value); this.writes.push(this.text); }
  get textContent() { return this.text + this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  closest(selector) {
    assert.equal(selector, '[inert], [aria-hidden="true"]');
    for (let node = this; node; node = node.parentNode) {
      if (node.attributes.has('inert') || node.getAttribute('aria-hidden') === 'true') return node;
    }
    return null;
  }
  getClientRects() { return this.rendered && !this.hidden ? [{}] : []; }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node !== 'string') { node.remove(); node.parentNode = this; }
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) if (typeof child !== 'string') child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    this.parentNode = null;
  }
  before(node) {
    const parent = this.parentNode;
    if (!parent) return;
    node.remove();
    parent.children.splice(parent.children.indexOf(this), 0, node);
    node.parentNode = parent;
  }
  after(node) {
    const parent = this.parentNode;
    if (!parent) return;
    node.remove();
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
    node.parentNode = parent;
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      if (selector === '[data-flow-kind]' ? child.dataset.flowKind !== undefined
        : selector.startsWith('.') ? child.className === selector.slice(1) : child.tagName === selector) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const body = new Element('body');
globalThis.getComputedStyle = (element) => ({ visibility: element.visibility });
const host = new Element();
const live = new Element();
live.id = 'layer-status-live';
live.setAttribute('role', 'status');
live.setAttribute('aria-live', 'polite');
body.append(host, live);
const events = new EventTarget();
globalThis.document = {
  body,
  createElement: (tag) => new Element(tag),
  createComment: () => new Element('#comment'),
  getElementById: (id) => id === 'enso-flow-controls' ? host : id === 'layer-status-live' ? live : null
};
globalThis.window = {
  location: { search: '?flow=currents' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener: (...args) => events.addEventListener(...args),
  removeEventListener: (...args) => events.removeEventListener(...args),
  dispatchEvent: (event) => events.dispatchEvent(event)
};
globalThis.fetch = () => { throw new Error('unexpected network'); };
const sources = new Map();
const layers = new Map();
const mapEvents = new Map();
let longitude = -150;
const map = {
  on: (event, listener) => mapEvents.set(event, listener),
  off: (event, listener) => { if (mapEvents.get(event) === listener) mapEvents.delete(event); },
  getCanvas: () => ({ clientWidth: 390, clientHeight: 844 }),
  unproject: ([x, y]) => ({ lng: longitude + x / 1000, lat: 20 + y / 1000 }),
  project: ([lng, lat]) => ({ x: lng * 100, y: lat * 100 }),
  getBearing: () => 0,
  getSource: (id) => sources.get(id),
  getLayer: (id) => layers.get(id),
  addSource: (id, source) => sources.set(id, { ...source, setData(data) { this.data = data; } }),
  addLayer: (layer) => layers.set(layer.id, layer),
  removeSource: (id) => sources.delete(id),
  removeLayer: (id) => layers.delete(id),
  setPaintProperty() {}
};
let held;
globalThis.__flowRead = (url, signal) => new Promise((resolve, reject) => { held = { url, signal, resolve, reject }; });
globalThis.__field = { kind: 'wind', meta: { cycle: Date.now(), forecastHour: 6, validTime: Date.now() } };
globalThis.__state = { form: 'moving', motion: 'moving', coverage: 'covered', features: 3, stale: false };
const flow = await import('../src/layers/enso-flow.ts');

const panel = () => host.querySelector('.enso-flow');
const line = () => host.querySelector('.enso-flow-status');
const replay = () => window.dispatchEvent(new Event('ddm:enso-flow-snapshot-request'));
async function until(predicate) {
  for (let turn = 0; turn < 40; turn++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('the actual flow lifecycle did not reach its expected state');
}
function boot(kind = 'currents') {
  flow.deactivateEnsoFlow();
  live.text = '';
  live.writes = [];
  held = null;
  longitude += 1; // a distinct source URL keeps each case independent of the real cache
  window.location.search = `?flow=${kind}`;
  flow.activateEnsoFlow(map);
}
function answer() {
  const url = new URL(held.url);
  const lat = url.searchParams.get('latitude').split(',').map(Number);
  const lon = url.searchParams.get('longitude').split(',').map(Number);
  held.resolve(lat.map((latitude, i) => ({
    latitude, longitude: lon[i],
    current_units: { time: 'unixtime', ocean_current_velocity: 'm/s', ocean_current_direction: '°' },
    current: { time: Math.floor(Date.now() / 900_000) * 900, ocean_current_velocity: 0.4, ocean_current_direction: 90 }
  })));
}

test.afterEach(() => flow.deactivateEnsoFlow());

test('the body announcer receives the actual loading words exactly once', () => {
  boot();
  assert.equal(panel().dataset.status, 'loading');
  assert.deepEqual(live.writes, [`Ocean currents · ${line().textContent}`]);
});

test('loading then live are announced once; Key snapshot replay adds no writes', async () => {
  boot();
  const loading = line().textContent;
  answer();
  await until(() => panel().dataset.status === 'live');
  replay();
  replay();
  assert.deepEqual(live.writes, [`Ocean currents · ${loading}`, `Ocean currents · ${line().textContent}`]);
});

test('a failed read announces unavailable exactly once', async () => {
  boot();
  const loading = line().textContent;
  held.reject(new Error('synthetic offline failure'));
  await until(() => panel().dataset.status === 'unavailable');
  replay();
  assert.deepEqual(live.writes, [`Ocean currents · ${loading}`, `Ocean currents · ${line().textContent}`]);
});

test('the visible panel is plain text rather than a competing live region', () => {
  boot();
  assert.equal(line().getAttribute('role'), null);
  assert.equal(line().getAttribute('aria-live'), null);
});

test('a late answer after cancellation does not announce or restore a live panel', async () => {
  boot();
  const before = [...live.writes];
  flow.deactivateEnsoFlow();
  assert.equal(held.signal.aborted, true);
  answer();
  for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(live.writes, before);
  assert.equal(panel(), null);
});

test('motion-only updates and repeated state callbacks do not repeat the live announcement', async () => {
  boot('wind');
  await until(() => panel().dataset.status === 'live');
  assert.equal(live.writes.length, 2, 'loading and live each use the shared route');
  const before = [...live.writes];
  globalThis.__fieldState({ ...globalThis.__state, motion: 'paused', form: 'still' });
  globalThis.__fieldState({ ...globalThis.__state, motion: 'paused', form: 'still' });
  replay();
  assert.deepEqual(live.writes, before);
});

test('a pan preserves the existing resample announcement when its control is shown, once per changed line', async () => {
  boot();
  answer();
  await until(() => panel().dataset.status === 'live');
  const before = [...live.writes];
  mapEvents.get('moveend')();
  assert.match(line().textContent, /Update area to resample$/);
  mapEvents.get('moveend')();
  replay();
  assert.deepEqual(live.writes, [...before, `Ocean currents · ${line().textContent}`]);
});

test('a pan does not announce a resample instruction while its control is hidden', async () => {
  boot();
  answer();
  await until(() => panel().dataset.status === 'live');
  const before = [...live.writes];
  // This only supplies the existing visibility predicate's result; actual CSS
  // exposure on the desktop/phone/embed surfaces is checked in the browser.
  host.querySelectorAll('button').find((button) => button.textContent === 'Update area').rendered = false;
  mapEvents.get('moveend')();
  assert.match(line().textContent, /Update area to resample$/);
  assert.deepEqual(live.writes, before);
});

for (const visibility of ['hidden', 'collapse']) {
  test(`a pan does not announce a resample instruction through CSS visibility ${visibility}`, async () => {
    boot();
    answer();
    await until(() => panel().dataset.status === 'live');
    const before = [...live.writes];
    // A visibility-hidden control still has layout rectangles. Supply the
    // computed value here; browser cases cover the actual inherited CSS.
    host.querySelectorAll('button').find((button) => button.textContent === 'Update area').visibility = visibility;
    mapEvents.get('moveend')();
    assert.match(line().textContent, /Update area to resample$/);
    assert.deepEqual(live.writes, before);
  });
}

for (const [attribute, value] of [['inert', ''], ['aria-hidden', 'true']]) {
  test(`a pan does not announce a resample instruction through an ${attribute} ancestor`, async () => {
    boot();
    answer();
    await until(() => panel().dataset.status === 'live');
    const before = [...live.writes];
    host.setAttribute(attribute, value);
    try {
      mapEvents.get('moveend')();
      assert.match(line().textContent, /Update area to resample$/);
      assert.deepEqual(live.writes, before);
    } finally {
      host.removeAttribute(attribute);
    }
  });
}
