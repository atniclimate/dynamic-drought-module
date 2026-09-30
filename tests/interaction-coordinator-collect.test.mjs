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
  impactPanel: 'export function openImpactPanel() { throw new Error("stub openImpactPanel"); }',
  mobileSheet: 'export function isSheetActive() { return false; }',
  studioRoute: 'export function getStudioRoute() { return null; } export function onStudioRouteChange() { return () => {}; }'
};

const stubUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTs = typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts');
    if (specifier === 'maplibre-gl' && fromTs) return { url: stubUrl(STUBS['maplibre-gl']), shortCircuit: true };
    if (fromTs && /\/ui\/impact-panel$/.test(specifier)) return { url: stubUrl(STUBS.impactPanel), shortCircuit: true };
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
globalThis.document = {
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
