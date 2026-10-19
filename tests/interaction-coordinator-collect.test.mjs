import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D D1 M23 repair round 1 (the Codex ultra diff review of 2026-09-30,
 * finding 4; the N2 brief correction C6): the collection seam tested at the
 * REAL ingress. This drives src/map/interaction-coordinator.ts itself, its
 * `collectHits` and `commit`, through the one map click handler it binds,
 * with a group-capable target registered the way D2 will register one. A
 * test of an extracted helper alone does not count (C6).
 *
 * No DOM: every respond below records what it was handed and answers null
 * where the case needs the fallback, so the decline chain runs to its end
 * without a render. Where a case needs an answer to WIN, the answer reaches
 * `renderPopup`, whose first DOM call is stubbed to throw RENDER_REACHED;
 * the case asserts that throw and what had been asked before it.
 *
 * The resolve hook maps `maplibre-gl`, the impact panel facade, the mobile
 * sheet and the studio route (which reads window.location and history at
 * module level through ../state/url) to inert stubs; every other import is
 * the real module.
 */

const STUBS = {
  // The popup the coordinator would construct: its options are recorded
  // (the framed class says whether takeFrame accepted the content), then
  // the render stops here.
  'maplibre-gl':
    'export class Popup { constructor(options) { globalThis.__ddmPopupOptions = options; throw new Error("RENDER_REACHED at Popup"); } }',
  impactPanel:
    'export function openImpactPanel() { throw new Error("stub openImpactPanel"); } export function nextBriefingIntent() { return 0; } export function isCurrentBriefingIntent() { return false; } export function openTechnicalInformation() { throw new Error("stub openTechnicalInformation"); }',
  deepLink: 'export function openStateBriefing() { throw new Error("stub openStateBriefing"); }',
  mobileSheet: 'export function isSheetActive() { return false; }',
  studioRoute: 'export function studioOwnsScreen() { return false; } export function onStudioRouteChange() { return () => {}; }'
};

const stubUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTs = typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts');
    if (specifier === 'maplibre-gl' && fromTs) return { url: stubUrl(STUBS['maplibre-gl']), shortCircuit: true };
    if (fromTs && /\/ui\/impact-panel$/.test(specifier)) return { url: stubUrl(STUBS.impactPanel), shortCircuit: true };
    if (fromTs && /\/state\/deep-link$/.test(specifier)) return { url: stubUrl(STUBS.deepLink), shortCircuit: true };
    if (fromTs && /\/ui\/mobile-sheet$/.test(specifier)) return { url: stubUrl(STUBS.mobileSheet), shortCircuit: true };
    if (fromTs && /\/state\/studio-route$/.test(specifier)) return { url: stubUrl(STUBS.studioRoute), shortCircuit: true };
    // The extensionless relative specifiers the bundler resolves
    // (tests/boot-idle-seam.test.mjs, the same hook).
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && fromTs) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const RENDER_REACHED = 'RENDER_REACHED';
globalThis.window = { matchMedia: () => ({ matches: false }) };
/** A fake `#map-container`: the census stamp's only DOM surface. */
const mapContainer = {
  attributes: new Map(),
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  },
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  },
  removeAttribute(name) {
    this.attributes.delete(name);
  }
};
/**
 * A minimal DOM, enough for renderPopup to reach its Popup construction
 * with an element response: child nodes, text, attributes, classes and the
 * attribute selectors takeFrame uses. `querySelector` finds nothing (the
 * fixtures carry no legacy class names). Off unless a case turns it on, so
 * the other cases stop at the first createElement.
 */
class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((n) => n.textContent).join('');
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
}
class FakeElement extends FakeNode {
  constructor(attrs = {}) {
    super(1);
    this.attrs = new Map(Object.entries(attrs));
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach((c) => classes.add(c)), contains: (c) => classes.has(c) };
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
  matches(selector) {
    const m = /^\[([\w-]+)(?:=([\w-]+))?\]$/.exec(selector);
    return m !== null && this.attrs.has(m[1]) && (m[2] === undefined || this.attrs.get(m[1]) === m[2]);
  }
  querySelector() {
    return null;
  }
}
const fakeDom = { on: false };
/** Document keydown listeners, so a case can press a key on the page. */
const keydownListeners = new Set();
const pressKey = (key) => [...keydownListeners].forEach((listener) => listener({ key }));
globalThis.document = {
  addEventListener: (type, listener) => type === 'keydown' && keydownListeners.add(listener),
  removeEventListener: (type, listener) => type === 'keydown' && keydownListeners.delete(listener),
  getElementById: (id) => (id === 'map-container' ? mapContainer : null),
  createElement: () => {
    if (fakeDom.on) return new FakeElement();
    throw new Error(RENDER_REACHED);
  }
};

const coordinator = await import('../src/map/interaction-coordinator.ts');
const { assembleSections } = await import('../src/map/response-sections.ts');

const name = (feature) => feature.properties.name;
const F = (layer, featureName, groupKey) => ({
  layer: { id: layer },
  source: layer,
  properties: { name: featureName, ...(groupKey ? { groupKey } : {}) }
});

/**
 * One coordinator with a group-capable fire target and an ordinary boundary
 * target, both answering from `answers`; returns the click and the call log.
 */
function harness(rendered, answers) {
  coordinator.resetInteractionCoordinatorForTest();
  const calls = [];
  let onClick = null;
  const layers = ['fires', 'fires-prescribed', 'boundary'];
  const map = {
    on(type, handler) {
      if (type === 'click') onClick = handler;
    },
    getLayer: (id) => (layers.includes(id) ? { id } : undefined),
    queryRenderedFeatures: () => rendered
  };
  coordinator.registerClickTarget({
    kind: 'point-event',
    layerIds: ['fires', 'fires-prescribed'],
    label: name,
    respond(feature) {
      calls.push(['single', name(feature)]);
      return answers.single;
    },
    group: {
      // The target's own lazy adapter assembles and dedupes by group key.
      respond(features) {
        const sections = assembleSections(features, (f) => f.properties.groupKey ?? null);
        calls.push(['group', features.map(name), sections.map((s) => [s.key, s.features.map(name)])]);
        return answers.group;
      }
    }
  });
  coordinator.registerClickTarget({
    kind: 'reservation-boundary',
    layerIds: ['boundary'],
    label: name,
    respond(feature) {
      calls.push(['other', name(feature)]);
      return answers.other;
    }
  });
  coordinator.initInteractionCoordinator(map);
  assert.equal(typeof onClick, 'function', 'the coordinator bound one map click handler');
  const click = () => onClick({ point: { x: 10, y: 10 }, lngLat: { lng: -120, lat: 47 } });
  return { calls, click };
}

const RESPONSE = { content: 'fixture' };

test('the ingress keeps every feature of a group-capable target and makes one section per group key', () => {
  const { calls, click } = harness(
    [F('fires', 'f1', 'g-b'), F('boundary', 'b1'), F('fires-prescribed', 'f2', 'g-a'), F('fires', 'f3', 'g-b'), F('boundary', 'b2'), F('fires', 'f4')],
    { group: null, single: null, other: null }
  );
  click();
  assert.deepEqual(calls[0], [
    'group',
    ['f1', 'f2', 'f3', 'f4'],
    [
      ['g-a', ['f2']],
      ['g-b', ['f1', 'f3']]
    ]
  ], 'every feature reached the group side; two hits with one group key make ONE section, different keys two, ordered by key');
  assert.deepEqual(calls.slice(1), [['single', 'f1'], ['other', 'b1']], 'an ordinary target keeps its first feature');
});

test('a declined collection falls back to the single response, then to the next hit', () => {
  const rendered = [F('fires', 'f1', 'g-a'), F('fires', 'f2', 'g-b'), F('boundary', 'b1')];
  const grouped = harness(rendered, { group: RESPONSE, single: RESPONSE, other: RESPONSE });
  assert.throws(grouped.click, new RegExp(RENDER_REACHED));
  assert.deepEqual(grouped.calls, [['group', ['f1', 'f2'], [['g-a', ['f1']], ['g-b', ['f2']]]]], 'a collection answer is the response');

  const single = harness(rendered, { group: null, single: RESPONSE, other: RESPONSE });
  assert.throws(single.click, new RegExp(RENDER_REACHED));
  assert.deepEqual(single.calls.map((c) => c.slice(0, 2)), [['group', ['f1', 'f2']], ['single', 'f1']], 'a declined collection falls back to the first feature');

  const next = harness(rendered, { group: null, single: null, other: RESPONSE });
  assert.throws(next.click, new RegExp(RENDER_REACHED));
  assert.deepEqual(next.calls.map((c) => c.slice(0, 2)), [['group', ['f1', 'f2']], ['single', 'f1'], ['other', 'b1']], 'both declined: the next hit answers');

  const none = harness(rendered, { group: null, single: null, other: null });
  none.click();
  assert.deepEqual(none.calls.map((c) => c[0]), ['group', 'single', 'other'], 'nothing answers: no response, no render');
});

test('the coordinator imports neither assembleSections nor groupedOrSingle (they ride the lazy group adapter)', () => {
  const source = readFileSync(new URL('../src/map/interaction-coordinator.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  assert.equal(/\bassembleSections\b/.test(code), false, 'the coordinator names assembleSections outside a comment');
  assert.equal(/\bgroupedOrSingle\b/.test(code), false, 'the coordinator names groupedOrSingle outside a comment');
});

test('the census stamp follows the registry through a test reset (never a stale or duplicate token)', () => {
  const stamp = () => mapContainer.getAttribute('data-ddm-click-targets');
  const target = (id) => ({ kind: 'condition-surface', layerIds: [id], label: () => id, respond: () => null });
  coordinator.resetInteractionCoordinatorForTest();
  coordinator.registerClickTarget(target('layer-a'));
  assert.equal(stamp(), 'condition-surface:layer-a');
  coordinator.resetInteractionCoordinatorForTest();
  assert.equal(stamp(), null, 'the reset clears the stamp with the registry');
  coordinator.registerClickTarget(target('layer-a'));
  assert.equal(stamp(), 'condition-surface:layer-a', 'register, reset, register: exactly one token');
  coordinator.resetInteractionCoordinatorForTest();
  coordinator.registerClickTarget(target('layer-b'));
  assert.equal(stamp(), 'condition-surface:layer-b', 'a reset leaves no stale token behind');
});

test('takeFrame accepts a frame root holding only its two regions, and refuses root text outside them', () => {
  /** A framed element as the frame module emits it, optionally with extra root text. */
  const frame = (extraText) => {
    const root = new FakeElement({ 'data-popup-frame': '' });
    const headRegion = root.appendChild(new FakeElement({ 'data-popup-region': 'head' }));
    headRegion.appendChild(new FakeText('Fixture title'));
    const bodyRegion = root.appendChild(new FakeElement({ 'data-popup-region': 'body' }));
    bodyRegion.appendChild(new FakeText('Fixture body'));
    if (extraText !== undefined) root.appendChild(new FakeText(extraText));
    return root;
  };
  const classNameFor = (content) => {
    coordinator.resetInteractionCoordinatorForTest();
    let onClick = null;
    coordinator.registerClickTarget({ kind: 'condition-surface', layerIds: ['surface'], label: () => 'Surface', respond: () => ({ content }) });
    coordinator.initInteractionCoordinator({
      on(type, handler) {
        if (type === 'click') onClick = handler;
      },
      getLayer: (id) => (id === 'surface' ? { id } : undefined),
      queryRenderedFeatures: () => [F('surface', 'Surface')]
    });
    globalThis.__ddmPopupOptions = undefined;
    fakeDom.on = true;
    try {
      assert.throws(() => onClick({ point: { x: 1, y: 1 }, lngLat: { lng: -120, lat: 47 } }), /RENDER_REACHED at Popup/);
    } finally {
      fakeDom.on = false;
    }
    return globalThis.__ddmPopupOptions.className;
  };
  assert.equal(classNameFor(frame()), 'ddm-coordinated-popup ddm-popup-framed', 'a frame root with its two regions is framed');
  assert.equal(
    classNameFor(frame('Fixture unframed visible text')),
    'ddm-coordinated-popup',
    'visible text under the frame root, outside both regions, is not accepted as a frame'
  );
});

/**
 * I16 named doors: `identifyAt` takes the click path at a known position for
 * one target (a map key button), so the popup it opens is that target's own
 * even where a click there would rank another hit first.
 */
function doorHarness({ center = -150, inView = true, rendered }) {
  coordinator.resetInteractionCoordinatorForTest();
  const calls = [];
  // The pending one-time listeners by type; `off` removes one as MapLibre's does.
  const once = new Map();
  const eased = [];
  const projected = [];
  const map = {
    once: (type, handler) => once.set(type, handler),
    off: (type, handler) => {
      if (once.get(type) === handler) once.delete(type);
    },
    getLayer: (id) => (['door', 'event'].includes(id) ? { id } : undefined),
    queryRenderedFeatures: () => rendered(),
    getCenter: () => ({ lng: center, lat: 0 }),
    getCanvas: () => ({ clientWidth: 100, clientHeight: 100 }),
    project: (ll) => {
      projected.push(ll);
      return inView ? { x: 50, y: 50 } : { x: -10, y: 50 };
    },
    unproject: () => ({ lng: 0, lat: 0 }),
    easeTo: (options) => {
      eased.push(options);
      inView = true;
    }
  };
  for (const [kind, id] of [['condition-surface', 'door'], ['point-event', 'event']]) {
    coordinator.registerClickTarget({
      kind,
      layerIds: [id],
      label: name,
      respond(feature) {
        calls.push(name(feature));
        return null;
      }
    });
  }
  return { map, calls, once, eased, projected };
}

test('a named door asks its own target first, even when a click there would rank another hit first', () => {
  const h = doorHarness({ rendered: () => [F('event', 'e1'), F('door', 'd1')] });
  coordinator.identifyAt(h.map, ['door'], -145, 0);
  assert.deepEqual(h.calls, ['d1', 'e1'], 'the door target leads; the other hit stays next in line');
  assert.deepEqual(h.eased, [], 'a target already in view moves no camera');
});

test('a named door out of view eases there first and identifies only once the move ends', () => {
  const h = doorHarness({ inView: false, rendered: () => [F('door', 'd1')] });
  coordinator.identifyAt(h.map, ['door'], -145, 0);
  assert.deepEqual(h.calls, [], 'nothing is identified mid-move');
  assert.equal(h.eased.length, 1);
  assert.deepEqual(h.eased[0].center, [-145, 0]);
  h.once.get('moveend')();
  assert.deepEqual(h.calls, ['d1']);
});

test('a named door wraps to the world copy nearest the view (the Pacific across the antimeridian)', () => {
  const h = doorHarness({ center: 170, rendered: () => [F('door', 'd1')] });
  coordinator.identifyAt(h.map, ['door'], -145, 0);
  assert.deepEqual(h.projected[0], { lng: 215, lat: 0 });
});

test('a named door never opens another target in its place, and retries a miss for a bounded time only', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let rendered = [F('event', 'e1')];
  const still = doorHarness({ rendered: () => rendered });
  coordinator.identifyAt(still.map, ['door'], -145, 0);
  assert.deepEqual(still.calls, [], 'no door target under the point: nothing else is opened');
  assert.equal(still.once.has('idle'), false, 'no wait on a global idle a moving flow can withhold');
  t.mock.timers.tick(5000);
  const looks = still.projected.length;
  t.mock.timers.tick(5000);
  assert.equal(still.projected.length, looks, 'the retry ends (in a dismissal) once its bound passes');
  assert.deepEqual(still.calls, [], 'and nothing else was opened meanwhile');

  const moved = doorHarness({ inView: false, rendered: () => rendered });
  coordinator.identifyAt(moved.map, ['door'], -145, 0);
  moved.once.get('moveend')();
  assert.deepEqual(moved.calls, [], 'the tiles there are not drawn yet');
  rendered = [F('door', 'd1')];
  t.mock.timers.tick(500);
  assert.deepEqual(moved.calls, ['d1'], 'the tiles settle within the bound: the door target answers');
});

test('a named door opens exactly the feature it names among overlapping hits of its own target', () => {
  const later = F('door', 'later');
  const named = F('door', 'named');
  const h = doorHarness({ rendered: () => [later, named, F('event', 'e1')] });
  coordinator.identifyAt(h.map, ['door'], -145, 0, (f) => f === named);
  assert.deepEqual(h.calls, ['named', 'e1'], 'the named feature leads, never the first rendered feature of its target');
});

test('a named door whose named feature is absent opens nothing, even with its target under the point', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = doorHarness({ rendered: () => [F('door', 'other storm'), F('event', 'e1')] });
  coordinator.identifyAt(h.map, ['door'], -145, 0, (f) => name(f) === 'named');
  t.mock.timers.tick(10000);
  assert.deepEqual(h.calls, [], 'another feature of the same target is never opened in its place');
});

test('a newer door, a map click or a dismissal cancels a pending door', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let rendered = [];
  const h = doorHarness({ inView: false, rendered: () => rendered });
  h.map.easeTo = () => {}; // every door stays pending on its move
  const pending = (door) => {
    coordinator.identifyAt(h.map, ['door'], -145, 0, (f) => name(f) === door);
    return h.once.get('moveend');
  };

  const first = pending('a');
  const second = pending('b');
  assert.notEqual(first, second);
  rendered = [F('door', 'a'), F('door', 'b')];
  first();
  assert.deepEqual(h.calls, [], 'the superseded door does nothing, even if its move ends');
  second();
  assert.deepEqual(h.calls, ['b'], 'the newer door opens its own feature');

  h.calls.length = 0;
  rendered = [];
  pending('a')();
  coordinator.dismissResponse();
  rendered = [F('door', 'a')];
  t.mock.timers.tick(5000);
  assert.deepEqual(h.calls, [], 'a dismissal during the retry cancels it');
  pending('a');
  coordinator.dismissResponse();
  assert.equal(h.once.has('moveend'), false, 'a dismissal during the move leaves no listener behind');

  let onClick = null;
  coordinator.initInteractionCoordinator({ ...h.map, on: (type, handler) => type === 'click' && (onClick = handler) });
  pending('a');
  rendered = [];
  onClick({ point: { x: 10, y: 10 }, lngLat: { lng: -120, lat: 47 } });
  assert.equal(h.once.has('moveend'), false, 'a map click cancels the pending door');
});

test('Escape while a door waits on its move or its retry cancels it, and the door leaves no key listener behind', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let rendered = [F('door', 'd1')];
  const h = doorHarness({ inView: false, rendered: () => rendered });
  h.map.easeTo = () => {};
  coordinator.identifyAt(h.map, ['door'], -145, 0);
  const moveEnd = h.once.get('moveend');
  pressKey('Tab');
  assert.equal(h.once.has('moveend'), true, 'another key leaves the door pending');
  pressKey('Escape');
  assert.equal(h.once.has('moveend'), false, 'Escape during the move cancels the door');
  moveEnd();
  assert.deepEqual(h.calls, [], 'nothing commits after Escape, even if the move ends');
  assert.equal(keydownListeners.size, 0, 'the cancelled door removed its Escape listener');

  rendered = [];
  coordinator.identifyAt(h.map, ['door'], -145, 0);
  h.once.get('moveend')();
  pressKey('Escape');
  rendered = [F('door', 'd1')];
  t.mock.timers.tick(5000);
  assert.deepEqual(h.calls, [], 'Escape during the retry cancels it');

  coordinator.identifyAt(h.map, ['door'], -145, 0);
  h.once.get('moveend')();
  assert.deepEqual(h.calls, ['d1'], 'a door that is not cancelled still opens');
  assert.equal(keydownListeners.size, 0, 'a door that commits removes its Escape listener');
});
