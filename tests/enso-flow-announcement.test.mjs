import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
    if (fromTs && specifier === '../state/enso-flow') return stub(`
      export function parseEnsoFlowParams(params) { return { kind: params.get('flow') ?? 'off', ink: 'light' }; }
      export function syncEnsoFlowParams() {}
    `);
    if (fromTs && specifier === './flow/index') return stub(`
      export const MAX_CYCLE_TRIES = 1;
      export const candidateCycle = () => globalThis.__field.meta.cycle;
      export const forecastHourFor = () => 6;
      export const isStale = () => false;
      export const readFlowFrame = async () => {
        if (globalThis.__readError) throw globalThis.__readError;
        return globalThis.__field;
      };
      // A scalar field mounts as a still shade: no state callback, only the 24-hour limit.
      export function mountShadeView(map, field, options) {
        globalThis.__shadeStale = options.onStale;
        globalThis.__mounts.push(field);
        return { field, dispose() { globalThis.__shadeDisposed = (globalThis.__shadeDisposed ?? 0) + 1; }, halt() {} };
      }
      // The committed currents frame: the read is held open by the test, and the grid is picked by latitude.
      export const readCurrentsFrame = ({ signal }) => globalThis.__flowRead(signal);
      export const fieldNearestLatitude = (fields, lat) => fields[lat > 39.5 ? 1 : 0];
      export function mountFlowView(map, field, options) {
        globalThis.__fieldState = options.onState;
        globalThis.__mounts.push(field);
        return { state: globalThis.__state, field, dispose() {}, halt() {}, setInk() {} };
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
const mapEvents = new Map();
let centreLatitude = 20;
const map = {
  on: (event, listener) => mapEvents.set(event, listener),
  off: (event, listener) => { if (mapEvents.get(event) === listener) mapEvents.delete(event); },
  getCenter: () => ({ lng: -150, lat: centreLatitude })
};
// The page clock: 3 days and 11 hours after the currents frame's valid instant. Each boot moves it past the
// panel's ten-minute hold of a read frame, so every case reads the frame itself.
const RUN = Date.UTC(2026, 9, 13);
const VALID = RUN + 3_600_000;
let clock = Date.UTC(2026, 9, 16, 12);
Date.now = () => clock;
/** The frame's two grids as the reader hands them over (src/layers/flow/currents.ts), tropics first. */
const CURRENTS = [
  { lon0: 130, lat0: 39, dlon: 1, dlat: 1, nx: 120, ny: 80, wrapsLon: false },
  { lon0: 140, lat0: 84.7, dlon: 0.3, dlat: 0.3, nx: 350, ny: 150, wrapsLon: false }
].map((grid) => ({ kind: 'currents', grid, meta: { cycle: RUN, forecastHour: 1, validTime: VALID, staleAfter: null } }));
let held;
let reads = 0;
globalThis.__flowRead = (signal) => new Promise((resolve, reject) => { reads++; held = { signal, resolve, reject }; });
globalThis.__mounts = [];
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
  clock += 11 * 60 * 1000;
  centreLatitude = 20;
  globalThis.__mounts.length = 0;
  window.location.search = `?flow=${kind}`;
  flow.activateEnsoFlow(map);
}
/** Boot on currents and wait for the panel to ask for the committed frame. */
async function bootCurrents() {
  boot();
  await until(() => held !== null);
}
const answer = () => held.resolve(CURRENTS);

test.afterEach(() => flow.deactivateEnsoFlow());

test('the body announcer receives the actual loading words exactly once', () => {
  boot();
  assert.equal(panel().dataset.status, 'loading');
  assert.equal(line().textContent, 'loading · NOAA RTOFS surface currents');
  assert.deepEqual(live.writes, [`Ocean currents · ${line().textContent}`]);
});

test('loading then live are announced once; Key snapshot replay adds no writes', async () => {
  await bootCurrents();
  const loading = line().textContent;
  answer();
  await until(() => panel().dataset.status === 'live');
  replay();
  replay();
  assert.deepEqual(live.writes, [`Ocean currents · ${loading}`, `Ocean currents · ${line().textContent}`]);
});

test('a failed read announces unavailable exactly once', async () => {
  await bootCurrents();
  const loading = line().textContent;
  held.reject(new Error('synthetic offline failure'));
  await until(() => panel().dataset.status === 'unavailable');
  replay();
  assert.equal(line().textContent, 'unavailable · NOAA RTOFS surface currents did not load');
  assert.deepEqual(live.writes, [`Ocean currents · ${loading}`, `Ocean currents · ${line().textContent}`]);
});

test('the visible panel is plain text rather than a competing live region', () => {
  boot();
  assert.equal(line().getAttribute('role'), null);
  assert.equal(line().getAttribute('aria-live'), null);
});

test('a late answer after cancellation does not announce or restore a live panel', async () => {
  await bootCurrents();
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

/** Boot on currents, answer the read, and collect every snapshot the key would get. */
async function liveCurrents(snapshots) {
  const record = (event) => snapshots.push(event.detail);
  window.addEventListener('ddm:enso-flow-snapshot', record);
  await bootCurrents();
  answer();
  await until(() => panel().dataset.status === 'live');
  return () => window.removeEventListener('ddm:enso-flow-snapshot', record);
}

test('a live currents frame is dated: run, valid instant and age in the line, bins and the RTOFS credit for the key', async () => {
  const snapshots = [];
  const stop = await liveCurrents(snapshots);
  try {
    const drawn = snapshots.at(-1);
    assert.equal(drawn.label, 'Ocean currents');
    assert.equal(drawn.line, 'live · NOAA RTOFS surface currents · Model run Oct 13, 12:00 AM UTC · Model valid Oct 13, 1:00 AM UTC · frame 3 days old');
    assert.deepEqual(drawn.notes, ['Line width and brightness: under 0.25, 0.25 to 0.5, 0.5 or more m/s.']);
    assert.equal(drawn.provenance, 'NOAA Global RTOFS, re-encoded by DDM');
    assert.equal(drawn.motion, 'moving');
    assert.ok(host.textContent.includes('NOAA Global RTOFS surface currents; ocean model output, one dated frame.'));
    assert.doesNotMatch(host.textContent, /navigation|never joined/i, 'the briefing explains and disclaims; the panel does not');
    // The frame never falls stale (its reader refuses one past 14 days): a state that says stale (a NODD frame's 24 hours) does not take it down.
    globalThis.__fieldState({ ...globalThis.__state, stale: true });
    assert.equal(panel().dataset.status, 'live');
  } finally {
    stop();
  }
});

test('the grid under the view centre draws; a pan across the seam swaps grids without a read', async () => {
  const stop = await liveCurrents([]);
  try {
    assert.deepEqual(globalThis.__mounts, [CURRENTS[0]], 'the tropical grid under a centre at 20 N');
    const readsBefore = reads;
    mapEvents.get('moveend')();
    assert.equal(globalThis.__mounts.length, 1, 'a pan inside the grid mounts nothing');
    centreLatitude = 50;
    mapEvents.get('moveend')();
    assert.deepEqual(globalThis.__mounts, [CURRENTS[0], CURRENTS[1]], 'the northern grid, never both at once');
    centreLatitude = 10;
    mapEvents.get('moveend')();
    assert.equal(globalThis.__mounts.at(-1), CURRENTS[0]);
    assert.equal(reads, readsBefore, 'panning never fetches');
    assert.equal(panel().dataset.status, 'live');
  } finally {
    stop();
  }
});

test('a currents view the grid does not fill says so: partial, all land, and outside the grid', async () => {
  const snapshots = [];
  const stop = await liveCurrents(snapshots);
  // The grid boxes read in Technical information (tests/terrain-coverage.test.mjs), never in the key.
  const bins = 'Line width and brightness: under 0.25, 0.25 to 0.5, 0.5 or more m/s.';
  try {
    globalThis.__fieldState({ ...globalThis.__state, coverage: 'partial' });
    assert.match(snapshots.at(-1).line, /^live \(partial\) · NOAA RTOFS surface currents · Model run .+ · Model valid .+ · frame 3 days old$/);
    assert.deepEqual(snapshots.at(-1).notes, [bins]);
    globalThis.__fieldState({ ...globalThis.__state, coverage: 'masked', form: 'none', motion: 'none' });
    assert.equal(snapshots.at(-1).line, 'no data · No ocean values in this view');
    assert.deepEqual(snapshots.at(-1).notes, ['No marks within one grid cell of the coast or where the model has no water value; no marks does not mean calm water.']);
    globalThis.__fieldState({ ...globalThis.__state, coverage: 'outside', form: 'none', motion: 'none' });
    assert.equal(snapshots.at(-1).line, 'no data · This view is outside the area this ocean current grid covers');
    assert.deepEqual(snapshots.at(-1).notes, []);
    assert.equal(snapshots.at(-1).provenance, 'NOAA Global RTOFS, re-encoded by DDM');
    // The northern grid is partial in the same words.
    centreLatitude = 55;
    mapEvents.get('moveend')();
    globalThis.__fieldState({ ...globalThis.__state, coverage: 'partial' });
    assert.deepEqual(snapshots.at(-1).notes, [bins]);
  } finally {
    stop();
  }
});

test('a held currents frame is read once: a second choice inside ten minutes asks for nothing', async () => {
  const stop = await liveCurrents([]);
  try {
    const readsBefore = reads;
    flow.deactivateEnsoFlow();
    held = null;
    window.location.search = '?flow=currents';
    flow.activateEnsoFlow(map);
    await until(() => panel().dataset.status === 'live');
    assert.equal(reads, readsBefore);
    assert.equal(held, null);
  } finally {
    stop();
  }
});

test('with the overlay off the panel carries no credit and no arrow colour', () => {
  boot('off');
  assert.equal(host.querySelector('.enso-flow-credit'), null);
  assert.equal(host.querySelector('.enso-flow-toolbar').hidden, true, 'nothing is drawn, so there are no arrows to colour');
  // True of every kind: the shade is no direction overlay.
  assert.equal(line().textContent, 'Overlay off');
  assert.deepEqual(live.writes, ['Overlay off']);
});

test('the control lists every kind by its label, with jet-level wind beside the 10 m wind', () => {
  boot('off');
  assert.deepEqual(
    host.querySelectorAll('[data-flow-kind]').map((button) => [button.dataset.flowKind, button.textContent]),
    [
      ['off', 'Off'], ['currents', 'Ocean currents'], ['wind', 'Atmospheric currents'], ['jet', 'Jet-level wind'], ['waves', 'Ocean waves'],
      ['pwat', 'Precipitable water']
    ]
  );
  assert.equal(panel().getAttribute('aria-label'), 'Ocean and atmosphere overlays');
});

test('live precipitable water is a still shade: a state line and bins for the key, nothing to pause, no arrow colour', async () => {
  const snapshots = [];
  const record = (event) => snapshots.push(event.detail);
  window.addEventListener('ddm:enso-flow-snapshot', record);
  const wind = globalThis.__field;
  // A ScalarField as the reader hands it over (src/layers/flow/shade.ts): values, no direction.
  const water = { kind: 'pwat', values: new Float32Array(4), meta: wind.meta };
  globalThis.__field = water;
  globalThis.__shadeDisposed = 0;
  try {
    boot('pwat');
    assert.deepEqual(live.writes, ['Precipitable water · loading · NOAA GFS precipitable water']);
    assert.equal(host.querySelector('.enso-flow-toolbar').hidden, true, 'a shade has no arrows to colour');
    await until(() => panel().dataset.status === 'live');
    assert.deepEqual(globalThis.__mounts, [water], 'one shade, mounted once');
    const drawn = snapshots.at(-1);
    assert.equal(drawn.label, 'Precipitable water');
    assert.match(drawn.line, /^live · NOAA GFS precipitable water · Model run .+ UTC · Model valid .+ UTC$/);
    assert.deepEqual(drawn.notes, ['Shade deepens in steps: none under 15, then 15 to 30, 30 to 45, 45 or more kg m-2.']);
    assert.equal(drawn.provenance, 'derived from NOAA GFS precipitable water');
    // The key offers Pause only where `motion` says something can move (src/ui/map-key.ts syncFlowPause).
    assert.equal(drawn.motion, 'none');
    assert.equal(live.writes.at(-1), `Precipitable water · ${drawn.line}`);
    assert.deepEqual({ ...panel().dataset }, { status: 'live', flowForm: 'shade', flowMotion: 'none', flowFeatures: '0', flowDrawn: 'pwat' });
    // The source line names the issuer's field; the sentences about lines, direction and navigation do not apply.
    assert.ok(host.textContent.includes(
      'NOAA GFS precipitable water (entire atmosphere); global model output, updated every six hours. This is model context, independently timed from the observed SST map.'
    ));
    for (const words of [host.textContent, ...live.writes, ...snapshots.flatMap((s) => [s.label, s.line, ...s.notes])]) {
      assert.doesNotMatch(words, /navigation|calm|hold still|atmospheric river|forecast|transport|warning|\bmm\b/i, words);
    }
    // A pan reads and mounts nothing: the image was made once from the frame.
    mapEvents.get('moveend')();
    assert.deepEqual(globalThis.__mounts, [water]);
    // Past cycle + 24 h while mounted, the shade leaves and the panel says which frame it held.
    globalThis.__shadeStale();
    assert.equal(panel().dataset.status, 'unavailable');
    assert.match(snapshots.at(-1).line, /^unavailable · The held NOAA GFS frame from .+ UTC is past its 24-hour limit$/);
    assert.deepEqual(snapshots.at(-1).notes, ['No moist or dry condition is inferred from a failed request.']);
    assert.equal(panel().dataset.flowDrawn, '');
    assert.ok(globalThis.__shadeDisposed >= 1, 'the shade is taken down');
  } finally {
    window.removeEventListener('ddm:enso-flow-snapshot', record);
    globalThis.__field = wind;
  }
});

test('a failed precipitable water read says so in words fit for a field with no direction', async () => {
  const snapshots = [];
  const record = (event) => snapshots.push(event.detail);
  window.addEventListener('ddm:enso-flow-snapshot', record);
  globalThis.__readError = new Error('synthetic refusal');
  try {
    boot('pwat');
    await until(() => panel().dataset.status === 'unavailable');
    assert.equal(line().textContent, 'unavailable · NOAA GFS precipitable water did not load');
    assert.deepEqual(snapshots.at(-1).notes, ['No moist or dry condition is inferred from a failed request.']);
    assert.equal(snapshots.at(-1).motion, undefined);
    assert.deepEqual(globalThis.__mounts, [], 'nothing is drawn from a failed read');
    // A line kind keeps its own sentence.
    boot('wind');
    await until(() => panel().dataset.status === 'unavailable');
    assert.deepEqual(snapshots.at(-1).notes, ['No direction or calm condition is inferred from a failed request.']);
  } finally {
    window.removeEventListener('ddm:enso-flow-snapshot', record);
    globalThis.__readError = null;
  }
});

for (const [kind, label, source, bins] of [
  ['wind', 'Atmospheric currents', 'NOAA GFS 10 m wind', 'Line width and brightness: under 5, 5 to 10, 10 or more m/s.'],
  ['jet', 'Jet-level wind', 'NOAA GFS 250 hPa wind', 'Line width and brightness: under 20, 20 to 40, 40 or more m/s.'],
  ['waves', 'Ocean waves', 'NOAA GFS-Wave', 'Mark length and brightness: under 2, 2 to 4, 4 or more m significant wave height.']
]) {
  test(`a live ${kind} frame gives the key its state line and its bins, and no explanation`, async () => {
    const snapshots = [];
    const record = (event) => snapshots.push(event.detail);
    window.addEventListener('ddm:enso-flow-snapshot', record);
    const field = globalThis.__field;
    globalThis.__field = { ...field, kind };
    try {
      boot(kind);
      assert.deepEqual(live.writes, [`${label} · loading · ${source}`]);
      assert.equal(host.querySelector('.enso-flow-toolbar').hidden, false, 'the arrow colour shows for the line kinds');
      await until(() => panel().dataset.status === 'live');
      const drawn = snapshots.at(-1);
      assert.equal(drawn.label, label);
      // The live line and the credit name the kind's own source, as the loading line does.
      assert.ok(drawn.line.startsWith(`live · ${source} · Model run `) && drawn.line.includes(' · Model valid '), drawn.line);
      assert.deepEqual(drawn.notes, [bins]);
      assert.equal(drawn.provenance, `derived from ${source}`);
      assert.equal(host.querySelector('.enso-flow-credit').textContent, drawn.provenance);
      // The navigation disclaimer reads in the Impact Briefing, for the ocean kinds only (tests/terrain-coverage.test.mjs).
      assert.doesNotMatch(host.textContent, /navigation/i);
      // No kind is sampled by hand any more: the panel offers its kinds and nothing else to press.
      assert.deepEqual(host.querySelectorAll('button').filter((button) => button.dataset.flowKind === undefined), []);
      if (kind === 'jet') assert.ok(host.textContent.includes('NOAA GFS 250 hPa wind; global model output, updated every six hours.'));
      // The still form keeps the sentence that says why the lines hold still, ahead of the bins.
      globalThis.__fieldState({ ...globalThis.__state, form: 'still', motion: 'reduced' });
      assert.deepEqual(snapshots.at(-1).notes, ['The lines hold still because this device asks for reduced motion.', bins]);
    } finally {
      window.removeEventListener('ddm:enso-flow-snapshot', record);
      globalThis.__field = field;
    }
  });
}

test('the key motion button is named for what a press does, in both states', () => {
  const key = readFileSync(new URL('../src/ui/map-key.ts', import.meta.url), 'utf8');
  const button = key.slice(key.indexOf('function buildFlowPauseButton('), key.indexOf('function formatHeatRiskDate('));
  // Lines that hold still (a pause, or reduced motion) offer Play; moving or held lines offer Pause.
  assert.ok(button.includes("const paused = motion === 'paused' || motion === 'reduced';"));
  assert.ok(button.includes("paused ? 'Play motion' : 'Pause motion'"));
  // A name that changes with the state carries no aria-pressed beside it (APG button pattern).
  assert.ok(!button.includes('aria-pressed'));
});
