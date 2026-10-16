import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The popup clamp re-clamps a MUTATED popup at once (src/ui/popup-viewport.ts,
 * wirePopup). MapLibre re-anchors an open popup on its own 'idle' and 'move'
 * events, inside its render frame, from the card's CLAMPED size; the telemetry
 * repaint swaps the frame root in a later task. A re-clamp deferred to the
 * next animation frame left one painted frame, and a window any reader could
 * see, with the card at MapLibre's unclamped placement: the 2026-10-14 CI run
 * read the telemetry popup's top at -1.16 px (popup-viewport.spec.ts DEF-4),
 * 13 px outside where the clamp keeps it.
 *
 * No DOM: one popup anchored 'bottom' at (195, 430) in a 390x844 viewport,
 * its card height driven by `model.naturalH` and the clamp's inline caps.
 * requestAnimationFrame only queues, so a case passes only if the clamp ran
 * inside the observer callback itself.
 */

const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
const observers = [];
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(target, options) { observers.push({ target, options, cb: this.cb, mo: this }); }
  disconnect() {}
};
globalThis.HTMLElement = class {};
globalThis.window = {
  addEventListener() {},
  visualViewport: null,
  matchMedia: () => ({ matches: true })
};
globalThis.document = {
  body: {},
  documentElement: { clientHeight: 844, clientWidth: 390 },
  getElementById: () => null,
  querySelectorAll: () => []
};

const model = { anchorX: 195, anchorY: 430, tip: 10, naturalW: 200, naturalH: 300 };
const px = (v) => (v ? Number.parseFloat(v) : Infinity);
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
const classList = (initial) => {
  const set = new Set(initial);
  return {
    contains: (c) => set.has(c),
    toggle: (c, force) => { if (force ?? !set.has(c)) set.add(c); else set.delete(c); },
    remove: (c) => set.delete(c),
    add: (c) => set.add(c)
  };
};

const content = Object.assign(new HTMLElement(), {
  style: { maxHeight: '', maxWidth: '', transform: '' },
  classList: classList(['maplibregl-popup-content']),
  getBoundingClientRect() {
    const h = Math.min(model.naturalH, px(this.style.maxHeight));
    const w = Math.min(model.naturalW, px(this.style.maxWidth));
    return rect(model.anchorX - w / 2, model.anchorY - model.tip - h, w, h);
  }
});
const popup = Object.assign(new HTMLElement(), {
  isConnected: true,
  classList: classList(['maplibregl-popup', 'maplibregl-popup-anchor-bottom']),
  addEventListener() {},
  closest: () => null,
  querySelector: (sel) => (sel === '.maplibregl-popup-content' ? content : null),
  getBoundingClientRect() {
    const c = content.getBoundingClientRect();
    return rect(c.left, c.top, c.width, c.height + model.tip);
  }
});

const { installPopupViewportContainment } = await import(new URL('../src/ui/popup-viewport.ts', import.meta.url).href);

const fire = (node, records) => observers.filter((o) => o.target === node).forEach((o) => o.cb(records, o.mo));

installPopupViewportContainment();
fire(document.body, [{ type: 'childList', addedNodes: [popup] }]);

test('the opened card fits, so the first clamp writes no cap', () => {
  assert.equal(content.style.maxHeight, '');
  assert.ok(popup.getBoundingClientRect().top >= 12);
});

test('a MapLibre re-anchor that puts the card above the screen is clamped before any frame', () => {
  model.naturalH = 421.16; // the container's top at -1.16 px, the CI reading
  assert.ok(popup.getBoundingClientRect().top < -1);
  fire(popup, [{ type: 'attributes', attributeName: 'class' }]);
  const top = popup.getBoundingClientRect().top;
  assert.ok(top >= 11, `the card's top is ${top} px until the next frame`);
});

test('a repaint that grows the card is clamped before any frame', () => {
  content.style.maxHeight = '';
  model.naturalH = 300;
  for (const run of frames.splice(0)) run(0);
  assert.equal(content.style.maxHeight, '');
  model.naturalH = 460;
  fire(content, [{ type: 'childList' }]);
  const top = popup.getBoundingClientRect().top;
  assert.ok(top >= 11, `the card's top is ${top} px until the next frame`);
});
