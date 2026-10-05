import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D P1-FRAME (2026-10-04): the InteractionCoordinator is the popup frame's
 * one caller. This drives src/map/interaction-coordinator.ts itself, through
 * the one map click handler it binds (tests/interaction-coordinator-collect
 * .test.mjs is the precedent), with targets that answer a MODEL:
 *
 *   - the coordinator hands the popup path exactly `serializePopupFrame(model)`;
 *   - a response carrying both `content` and `model`, or neither, is a builder
 *     bug, declined like a null answer (the next hit answers);
 *   - a model the frame refuses throws its PopupFrameError (as a builder's own
 *     serializer call did), before any selection or emphasis is written;
 *   - a commit that lands before the frame chunk has resolved waits, and a
 *     later commit, a dismissal, a studio route change, a reset, the mobile
 *     Brief sheet taking over, the map's removal or an adopted station
 *     popup's close wins: the stale commit never paints, never writes
 *     selection or emphasis, never opens the briefing;
 *   - a model the frame refuses AFTER the wait is reported once on the
 *     console and dismisses, never an unhandled rejection; that catch covers
 *     the serialization only, never the rendering after it;
 *   - Escape during the wait retires the waiting commit, and the handler the
 *     wait installs is gone when the wait ends, however it ends;
 *   - the mobile Brief sheet route needs no frame, so it never waits.
 *
 * The resolve hook maps `maplibre-gl` to a recording Popup, and the impact
 * panel facade, the mobile sheet and the studio route to recording stubs;
 * every other import is the real module, the frame included (its dynamic
 * import resolves to the real src/ui/popup-frame.ts). The DOM is a minimal
 * fake: `raw.innerHTML` is recorded (the string the coordinator renders),
 * never parsed, so a framed string takes the unframed fallback here; the
 * framed regions get their proof in tests/coordinator-frame-model.spec.ts.
 * The fake does what the DOM does where the coordinator relies on it (a
 * `textContent` setter, listener binding, appendChild refusing a non-node),
 * so a case reds at its own assertion rather than inside the fake; a click
 * that throws is returned by `tryClick` and asserted clean last. The mobile
 * sheet becoming active WITHOUT a view-mode change (a resize) is proved in
 * the browser, against the real sheet, not by flipping this stub.
 *
 * A COLD commit is made by `resetInteractionCoordinatorForTest`, which forgets
 * the loaded frame: the next registration warms it again, and the cached
 * module resolves a few microtasks later, after the synchronous click.
 */

const STUBS = {
  'maplibre-gl': [
    'export class Popup {',
    '  constructor(options) { this.options = options; this.closers = []; this.removed = false; globalThis.__ddmPopups.push(this); }',
    '  setLngLat() { return this; }',
    '  setDOMContent(node) { this.content = node; return this; }',
    '  addTo() { return this; }',
    '  on(type, fn) { if (type === "close") this.closers.push(fn); return this; }',
    '  remove() { this.removed = true; const closers = this.closers; this.closers = []; for (const fn of closers) fn(); return this; }',
    '  getElement() { return null; }',
    '}'
  ].join('\n'),
  impactPanel: 'export function openImpactPanel(context) { globalThis.__ddmPanelOpens.push(context); }',
  mobileSheet: 'export function isSheetActive() { return globalThis.__ddmSheetActive === true; }',
  studioRoute:
    'export function getStudioRoute() { return null; } export function onStudioRouteChange(fn) { globalThis.__ddmStudioListeners.push(fn); return () => {}; }'
};

const stubUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTs = typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts');
    if (specifier === 'maplibre-gl' && fromTs) return { url: stubUrl(STUBS['maplibre-gl']), shortCircuit: true };
    if (fromTs && /\/ui\/impact-panel$/.test(specifier)) return { url: stubUrl(STUBS.impactPanel), shortCircuit: true };
    if (fromTs && /\/ui\/mobile-sheet$/.test(specifier)) return { url: stubUrl(STUBS.mobileSheet), shortCircuit: true };
    if (fromTs && /\/state\/studio-route$/.test(specifier)) return { url: stubUrl(STUBS.studioRoute), shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && fromTs) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.__ddmPopups = [];
globalThis.__ddmPanelOpens = [];
globalThis.__ddmStudioListeners = [];
globalThis.__ddmSheetActive = false;
/** Every string the coordinator set as `innerHTML`, in order: what it rendered. */
const rendered = [];

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  /** As the DOM does: the children are replaced by one text node (none for ''). */
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    const text = String(value ?? '');
    if (text === '') return;
    const node = new FakeText(text);
    node.parentNode = this;
    this.childNodes.push(node);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
}
class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
}
class FakeElement extends FakeNode {
  constructor() {
    super(1);
    this.attrs = new Map();
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach((c) => classes.add(c)), contains: (c) => classes.has(c) };
  }
  set innerHTML(value) {
    rendered.push(value);
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  appendChild(node) {
    // The DOM's own refusal of a non-node (an answer whose content is absent).
    if (!(node instanceof FakeNode)) {
      throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
    }
    node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  matches() {
    return false;
  }
  querySelector() {
    return null;
  }
  // The disclosure's buttons and the briefing door bind clicks; nothing here dispatches one.
  addEventListener() {}
  removeEventListener() {}
}
const mapContainer = new FakeElement();
/** The document's listeners by event type, as the DOM keeps them (P1-FRAME repair round 2: Escape). */
const documentListeners = new Map();
globalThis.document = {
  documentElement: { dataset: {} },
  getElementById: (id) => (id === 'map-container' ? mapContainer : null),
  createElement: () => new FakeElement(),
  addEventListener(type, fn) {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]);
  },
  removeEventListener(type, fn) {
    documentListeners.set(type, (documentListeners.get(type) ?? []).filter((f) => f !== fn));
  }
};
const keydownListeners = () => (documentListeners.get('keydown') ?? []).length;
/** A key press reaching the document: every keydown listener, in order; reports whether any swallowed it. */
function press(key) {
  const swallowed = [];
  const event = {
    key,
    preventDefault: () => swallowed.push('preventDefault'),
    stopPropagation: () => swallowed.push('stopPropagation'),
    stopImmediatePropagation: () => swallowed.push('stopImmediatePropagation')
  };
  for (const fn of [...(documentListeners.get('keydown') ?? [])]) fn(event);
  return swallowed;
}

const coordinator = await import('../src/map/interaction-coordinator.ts');
const FRAME_URL = new URL('../src/ui/popup-frame.ts', import.meta.url).href;
const { serializePopupFrame } = await import(FRAME_URL);
const { getPlaceSelection, setPlaceSelection } = await import('../src/state/place-selection.ts');
const { clearEmphasis, getEmphasisTargets } = await import('../src/state/place-emphasis.ts');
const { setViewMode } = await import('../src/state/view-mode.ts');

/** The frame import has resolved and every continuation queued on it has run. */
async function settle() {
  await import(FRAME_URL);
  await new Promise((resolve) => setImmediate(resolve));
}

const MODEL = {
  kind: 'surface',
  title: 'Fixture Node Surface',
  issuer: { role: 'issued-by', name: 'Fixture issuer', productKey: 'usdm' },
  value: [{ text: 'Fixture value' }],
  clocks: [{ kind: 'point', meaning: 'map-date', label: 'Fixture map date', at: { precision: 'date', date: '2026-09-29' } }],
  source: { link: { label: 'Fixture source', href: 'https://droughtmonitor.unl.edu/' } }
};
const SECOND_MODEL = { ...MODEL, title: 'Fixture Node Second Surface' };
/** A model the frame refuses (a blank title is a caller bug, PopupFrameError). */
const REFUSED_MODEL = { ...MODEL, title: ' ' };

const context = (title) => ({
  kind: 'bia-reservation',
  title,
  properties: null,
  lngLat: { lng: -120, lat: 47 },
  regionKey: 'washington_state',
  containing: { state: null, basis: 'none' }
});

const F = (layer, name) => ({ layer: { id: layer }, source: layer, properties: { name } });

/**
 * A fresh coordinator (the frame forgotten, so the first commit after the
 * registration is COLD unless the caller settles first) with one target per
 * entry of `layers`, each answering from its queue (the last answer repeats).
 */
function harness(layers, { warm = false } = {}) {
  coordinator.resetInteractionCoordinatorForTest();
  setPlaceSelection(null);
  clearEmphasis({ getSource: () => undefined });
  globalThis.__ddmPopups.length = 0;
  globalThis.__ddmPanelOpens.length = 0;
  globalThis.__ddmStudioListeners.length = 0;
  globalThis.__ddmSheetActive = false;
  rendered.length = 0;
  // A popup an earlier case left open keeps its own Escape handler; a fresh
  // harness starts with none, so a case sees only the handlers it caused.
  documentListeners.clear();
  const calls = [];
  /** Every map event handler the coordinator bound, by type (MapLibre's `map.on`). */
  const handlers = new Map();
  const map = {
    on(type, handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    getLayer: (id) => (id in layers ? { id } : undefined),
    getSource: () => undefined,
    queryRenderedFeatures: () => Object.keys(layers).map((id) => F(id, id))
  };
  const kinds = ['reservation-boundary', 'tribal-lands'];
  for (const [index, [id, queue]] of Object.entries(layers).entries()) {
    let n = 0;
    coordinator.registerClickTarget({
      kind: kinds[index] ?? 'condition-surface',
      layerIds: [id],
      label: () => id,
      respond() {
        calls.push(id);
        const answer = queue[Math.min(n, queue.length - 1)];
        n += 1;
        return answer;
      }
    });
  }
  coordinator.initInteractionCoordinator(map);
  assert.equal(handlers.get('click')?.length, 1, 'the coordinator bound one map click handler');
  const click = () => handlers.get('click')[0]({ point: { x: 10, y: 10 }, lngLat: { lng: -120, lat: 47 } });
  /**
   * A click whose throw is RETURNED, not raised, so a case asserts its
   * intended outcome first and the clean click last (on a coordinator that
   * cannot take a model, the DOM's own appendChild refusal is the throw).
   */
  const tryClick = () => {
    try {
      click();
      return null;
    } catch (err) {
      return err;
    }
  };
  /** Fire a map event the way MapLibre's `fire` does: every bound handler, in order. */
  const fire = (type) => {
    for (const handler of handlers.get(type) ?? []) handler({ type });
  };
  return { calls, click, tryClick, fire, ready: warm ? settle() : Promise.resolve() };
}

test('a model answer hands the popup path exactly the frame serialization', async () => {
  const { tryClick, ready } = harness({ surface: [{ model: MODEL }] }, { warm: true });
  await ready;
  const thrown = tryClick();
  assert.deepEqual(rendered, [serializePopupFrame(MODEL)], 'the warm commit rendered the serializer output, synchronously');
  assert.equal(globalThis.__ddmPopups.length, 1, 'one popup');
  assert.equal(thrown, null, 'the click threw nothing');
});

test('a response with both content and model, or with neither, is declined and the next hit answers', async () => {
  for (const [name, invalid] of [
    ['both', { content: 'fixture both', model: MODEL }],
    ['neither', { popupOptions: {} }]
  ]) {
    const { calls, tryClick, ready } = harness({ first: [invalid], next: [{ content: 'fixture next' }] }, { warm: true });
    await ready;
    const thrown = tryClick();
    assert.deepEqual(calls, ['first', 'next'], `${name}: the invalid answer fell through to the next hit`);
    assert.deepEqual(rendered, ['fixture next'], `${name}: only the next hit rendered`);
    assert.equal(thrown, null, `${name}: the click threw nothing`);
  }
});

test('a model the frame refuses throws its PopupFrameError before any selection or emphasis is written', async () => {
  const { click, ready } = harness(
    { refused: [{ model: REFUSED_MODEL, selection: context('Refused'), emphasis: [{ source: 'refused', id: 1 }] }] },
    { warm: true }
  );
  await ready;
  assert.throws(click, (err) => err?.name === 'PopupFrameError', 'the caller bug surfaces, as a builder serializer call did');
  assert.deepEqual(rendered, [], 'nothing rendered');
  assert.equal(getPlaceSelection(), null, 'the refused place answer wrote no selection');
  assert.deepEqual(getEmphasisTargets(), [], 'the refused place answer wrote no emphasis');
});

test('a cold commit writes nothing until the frame resolves, then paints once with its selection', async () => {
  const selection = context('Cold');
  const { tryClick } = harness({ place: [{ model: MODEL, selection, emphasis: [{ source: 'place', id: 7 }] }] });
  const thrown = tryClick();
  assert.deepEqual(rendered, [], 'nothing rendered before the frame resolved');
  assert.equal(getPlaceSelection(), null, 'no selection before the wait ends');
  assert.deepEqual(getEmphasisTargets(), [], 'no emphasis before the wait ends');
  await settle();
  assert.deepEqual(rendered, [serializePopupFrame(MODEL)], 'painted once after the wait');
  assert.equal(getPlaceSelection()?.context, selection, 'the selection was written after the wait');
  assert.deepEqual(getEmphasisTargets(), [{ source: 'place', id: 7 }]);
  assert.equal(thrown, null, 'the click threw nothing');
});

const STALE = { model: MODEL, selection: context('Stale'), emphasis: [{ source: 'stale', id: 1 }] };

for (const [name, supersede, expectRendered] of [
  ['a dismissal', () => coordinator.dismissResponse(), []],
  ['a studio route change', () => globalThis.__ddmStudioListeners.forEach((fn) => fn('place')), []],
  ['a reset', () => coordinator.resetInteractionCoordinatorForTest(), []]
]) {
  test(`${name} during the wait wins: the stale commit never paints nor writes selection or emphasis`, async () => {
    const { tryClick } = harness({ place: [STALE] });
    const thrown = tryClick();
    supersede();
    await settle();
    assert.deepEqual(rendered, expectRendered);
    assert.equal(globalThis.__ddmPopups.length, 0, 'no popup');
    assert.equal(getPlaceSelection(), null, 'the superseded commit wrote no selection');
    assert.deepEqual(getEmphasisTargets(), [], 'the superseded commit wrote no emphasis');
    assert.equal(thrown, null, 'the click threw nothing');
  });
}

test('a later commit during the wait wins: only it paints, and only its selection and emphasis are written', async () => {
  const later = context('Later');
  const { tryClick } = harness({ place: [STALE, { model: SECOND_MODEL, selection: later, emphasis: [{ source: 'later', id: 2 }] }] });
  const thrown = [tryClick(), tryClick()];
  await settle();
  assert.deepEqual(rendered, [serializePopupFrame(SECOND_MODEL)], 'the later commit painted once; the stale one never');
  assert.equal(globalThis.__ddmPopups.length, 1);
  assert.equal(getPlaceSelection()?.context, later);
  assert.deepEqual(getEmphasisTargets(), [{ source: 'later', id: 2 }]);
  assert.deepEqual(thrown, [null, null], 'neither click threw');
});

test('a later click whose builder throws still retires the waiting commit', async () => {
  let n = 0;
  const { click, tryClick } = harness({ place: [STALE] });
  // Swap the target for one whose second answer throws (a builder bug); the
  // reset keeps the harness map's click handler bound.
  coordinator.resetInteractionCoordinatorForTest();
  coordinator.registerClickTarget({
    kind: 'reservation-boundary',
    layerIds: ['place'],
    label: () => 'place',
    respond() {
      n += 1;
      if (n > 1) throw new Error('fixture builder bug');
      return STALE;
    }
  });
  const thrown = tryClick();
  assert.throws(click, /fixture builder bug/);
  await settle();
  assert.deepEqual(rendered, [], 'the waiting commit never painted');
  assert.equal(getPlaceSelection(), null, 'the waiting commit wrote no selection');
  assert.deepEqual(getEmphasisTargets(), [], 'the waiting commit wrote no emphasis');
  assert.equal(thrown, null, 'the first click threw nothing');
});

test('the mobile Brief sheet taking over during the wait wins: the stale commit neither paints nor opens the briefing', async () => {
  setViewMode('console');
  try {
    const { tryClick } = harness({ place: [STALE] });
    const thrown = tryClick();
    globalThis.__ddmSheetActive = true;
    setViewMode('brief');
    await settle();
    assert.deepEqual(rendered, []);
    assert.deepEqual(globalThis.__ddmPanelOpens, [], 'the stale commit never opened the briefing');
    assert.equal(getPlaceSelection(), null, 'the stale commit wrote no selection');
    assert.equal(thrown, null, 'the click threw nothing');
  } finally {
    setViewMode('brief');
    globalThis.__ddmSheetActive = false;
  }
});

test('the mobile Brief sheet route needs no frame: a cold place-bearing model answer opens the briefing at once', () => {
  const selection = context('Sheet');
  const { click } = harness({ place: [{ model: MODEL, selection, emphasis: [] }] });
  globalThis.__ddmSheetActive = true;
  try {
    click();
    assert.deepEqual(globalThis.__ddmPanelOpens, [selection], 'the sheet took the response synchronously');
    assert.deepEqual(rendered, [], 'no popup markup was rendered');
    assert.equal(getPlaceSelection()?.context, selection);
  } finally {
    globalThis.__ddmSheetActive = false;
  }
});

// S30D P1-FRAME repair round 1 (2026-10-04): the two lifecycle routes the
// Codex diff review found open, and the adopted station popup's close.

test('removing the map during the wait retires the commit even with no popup on screen', async () => {
  const { tryClick, fire } = harness({ place: [STALE] });
  const presented = [];
  coordinator.setResponseSink({
    present: (response) => {
      presented.push(response);
      return true;
    },
    dismiss() {}
  });
  const thrown = tryClick();
  // MapLibre's Map#remove fires 'remove' once torn down; no popup exists yet,
  // so no popup close can retire the waiting commit for it.
  fire('remove');
  await settle();
  assert.deepEqual(rendered, [], 'the commit waiting when the map was removed never rendered');
  assert.equal(presented.length, 0, 'nothing reached the sink after the map was removed');
  assert.equal(globalThis.__ddmPopups.length, 0, 'no popup');
  assert.equal(getPlaceSelection(), null, 'no selection written after the map was removed');
  assert.deepEqual(getEmphasisTargets(), [], 'no emphasis written after the map was removed');
  assert.equal(thrown, null, 'the click threw nothing');
});

test('closing an adopted station popup during the wait retires the commit', async () => {
  const { tryClick } = harness({ place: [STALE] });
  const closers = [];
  // The shape adoptExternalResponse reads; MapLibre's close control calls
  // remove(), which fires the popup's 'close'.
  const station = {
    once(type, fn) {
      if (type === 'close') closers.push(fn);
      return station;
    },
    getElement: () => null,
    remove() {
      for (const fn of closers.splice(0)) fn();
      return station;
    }
  };
  coordinator.adoptExternalResponse(station);
  const thrown = tryClick();
  station.remove();
  await settle();
  assert.deepEqual(rendered, [], 'the commit waiting when the station popup closed never rendered');
  assert.equal(globalThis.__ddmPopups.length, 0, 'no popup');
  assert.equal(getPlaceSelection(), null, 'no selection');
  assert.deepEqual(getEmphasisTargets(), [], 'no emphasis');
  assert.equal(thrown, null, 'the click threw nothing');
});

test('a model the frame refuses after the wait is reported once and dismisses, writes nothing, and the next click paints', async () => {
  const reported = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  const consoleError = console.error;
  process.on('unhandledRejection', onUnhandled);
  console.error = (...args) => reported.push(args);
  try {
    const { tryClick } = harness({
      place: [
        { content: 'fixture open' },
        { model: REFUSED_MODEL, selection: context('Refused'), emphasis: [{ source: 'refused', id: 1 }] },
        { model: MODEL }
      ]
    });
    // Legacy content needs no frame: it paints at once, cold or warm.
    const thrown = [tryClick()];
    assert.equal(globalThis.__ddmPopups.length, 1, 'the open response painted');
    // The refused model, cold: it waits for the frame, which then refuses it.
    thrown.push(tryClick());
    await settle();
    assert.deepEqual(unhandled, [], 'the refusal after the wait is no unhandled rejection');
    assert.equal(reported.length, 1, 'the refusal after the wait is reported once');
    assert.equal(reported[0]?.[0], '[coordinator] the popup frame could not paint this response:');
    assert.equal(reported[0]?.[1]?.name, 'PopupFrameError', 'the report carries the frame error');
    assert.equal(globalThis.__ddmPopups[0].removed, true, 'the open response was dismissed (no stale response)');
    assert.equal(getPlaceSelection(), null, 'the refused place answer wrote no selection');
    assert.deepEqual(getEmphasisTargets(), [], 'the refused place answer wrote no emphasis');
    // No pending record survives: the next click, now warm, paints at once.
    thrown.push(tryClick());
    assert.deepEqual(rendered, ['fixture open', serializePopupFrame(MODEL)], 'the next click painted');
    assert.deepEqual(thrown, [null, null, null], 'no click threw');
  } finally {
    console.error = consoleError;
    process.off('unhandledRejection', onUnhandled);
  }
});

// S30D P1-FRAME repair round 2 (2026-10-04): the reviewer's confirmation,
// items 7 and 5.

test('Escape during the wait retires the waiting commit, swallows nothing, and its handler is gone once the wait ends', async () => {
  // Nothing is on screen: a person clicked, sees nothing yet, presses Escape.
  const { tryClick } = harness({ place: [STALE] });
  const thrown = [tryClick()];
  const swallowed = press('Escape');
  await settle();
  assert.deepEqual(rendered, [], 'Escape during the wait retired the commit before it could paint');
  assert.equal(globalThis.__ddmPopups.length, 0, 'no popup');
  assert.equal(getPlaceSelection(), null, 'the retired commit wrote no selection');
  assert.deepEqual(getEmphasisTargets(), [], 'the retired commit wrote no emphasis');
  assert.deepEqual(swallowed, [], 'the Escape was not swallowed: another surface still sees it');
  assert.equal(keydownListeners(), 0, 'the wait\'s Escape handler was removed when the wait ended');

  // A wait that ends by painting removes its handler too, and another key
  // during the wait retires nothing.
  const second = harness({ place: [STALE] });
  thrown.push(second.tryClick());
  assert.equal(keydownListeners(), 1, 'a waiting commit listens for Escape');
  assert.deepEqual(press('Enter'), [], 'another key is not swallowed');
  await settle();
  assert.deepEqual(rendered, [serializePopupFrame(MODEL)], 'another key during the wait retired nothing');
  assert.equal(keydownListeners(), 1, 'only the painted response\'s own Escape handler remains');

  // A wait whose commit was retired by another route removes its handler
  // too, and an Escape meanwhile, with nothing pending, is not swallowed.
  const third = harness({ place: [STALE] });
  thrown.push(third.tryClick());
  coordinator.dismissResponse();
  assert.deepEqual(press('Escape'), [], 'with nothing pending, the Escape is not swallowed');
  await settle();
  assert.deepEqual(rendered, [], 'the dismissed commit never painted');
  assert.equal(keydownListeners(), 0, 'a retired wait\'s Escape handler was removed when the wait ended');
  assert.deepEqual(thrown, [null, null, null], 'no click threw');
});

test('after the wait, the refusal catch covers serialization only: a sink callback that commits a newer response and then throws leaves the newer response alone', async () => {
  const reported = [];
  const consoleError = console.error;
  console.error = (...args) => reported.push(args);
  // The sink's own throw escapes the continuation, as it escapes a warm
  // click to its caller; it is captured here so the runner does not fail
  // the file on it, and restored after.
  const runnerHandlers = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const escaped = [];
  const onUnhandled = (reason) => escaped.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { click, tryClick } = harness({ place: [STALE, { model: SECOND_MODEL }] });
    const sinkError = new Error('fixture sink failed after committing a newer response');
    let presented = 0;
    coordinator.setResponseSink({
      present() {
        presented += 1;
        // Synchronous re-entry: a newer (non-place, warm) commit paints its
        // popup, then the sink fails.
        click();
        throw sinkError;
      },
      dismiss() {}
    });
    const thrown = tryClick();
    await settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(presented, 1, 'the older place commit reached the sink after its wait');
    assert.equal(globalThis.__ddmPopups.length, 1, 'the newer commit painted one popup');
    assert.equal(globalThis.__ddmPopups[0].removed, false, 'the older wait\'s failure cleanup left the newer response on screen');
    assert.deepEqual(reported, [], 'a downstream throw is not reported as the frame failing to paint');
    assert.deepEqual(escaped, [sinkError], 'the sink\'s own error surfaces unchanged');
    assert.equal(thrown, null, 'the click threw nothing');
  } finally {
    console.error = consoleError;
    process.off('unhandledRejection', onUnhandled);
    for (const handler of runnerHandlers) process.on('unhandledRejection', handler);
  }
});
