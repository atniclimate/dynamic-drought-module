/**
 * The selected-point HeatRisk sequence (src/ui/heatrisk-sequence.ts):
 *
 * - An arrow key chooses the next day, and the redraw for that day keeps
 *   keyboard focus on its cell instead of dropping it to the page body.
 * - A new selection object for the SAME point (a popup, then its briefing)
 *   keeps the finished seven-day read instead of sending seven identifies
 *   again; a different point, or a cleared selection, still reads afresh.
 *
 * Fake elements stand in for the DOM: setting the host's innerHTML replaces
 * its cells and, like a browser, drops focus to the body when the focused
 * cell goes. It registers no Playwright tests: it runs under `node --test`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const seen = { identifies: 0, selectionListener: null, current: null };
globalThis.hrSeen = seen;

const stubs = {
  '/state/place-selection':
    'export function getPlaceSelection(){ return globalThis.hrSeen.current; } ' +
    'export function onPlaceSelectionChange(fn){ globalThis.hrSeen.selectionListener = fn; return () => {}; }',
  '/util/fetch':
    'export async function fetchJsonWithBudget(url){ globalThis.hrSeen.identifies += 1; ' +
    'const time = Number(/[?&]time=(\\d+)/.exec(url)[1]); ' +
    "return { value: '1', catalogItems: { features: [{ attributes: { idp_validtime: time } }] } }; }",
  '/map-control-seat': 'export function watchDesktopMapSeat(){}',
  '/detail-section-hosts': 'export function getDetailSectionHost(){ return null; }'
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix));
    if (stub) {
      return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
    }
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
  }
});

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = dataset;
  }
  focus() {
    globalThis.document.activeElement = this;
  }
}
class FakeButton extends FakeElement {
  matches(selector) {
    return selector === '[data-heatrisk-sequence-day]';
  }
}
class FakeHost extends FakeElement {
  hidden = true;
  cells = [];
  listeners = {};
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  setAttribute() {}
  removeAttribute() {}
  contains(node) {
    return this.cells.includes(node);
  }
  set innerHTML(html) {
    const lost = this.cells.includes(globalThis.document.activeElement);
    this.cells = [...html.matchAll(/data-heatrisk-sequence-day="(\d+)"/g)].map(
      ([, day]) => new FakeButton({ heatriskSequenceDay: day })
    );
    if (lost) globalThis.document.activeElement = body;
  }
  querySelector(selector) {
    const day = /^\[data-heatrisk-sequence-day="(\d+)"\]$/.exec(selector)?.[1];
    return this.cells.find((cell) => cell.dataset.heatriskSequenceDay === day) ?? null;
  }
  querySelectorAll() {
    return this.cells;
  }
}
globalThis.HTMLElement = FakeElement;
globalThis.HTMLButtonElement = FakeButton;

const body = new FakeElement();
const host = new FakeHost();
const foot = {};
const dock = { querySelector: () => foot, insertBefore() {} };
globalThis.document = {
  body,
  activeElement: body,
  createElement: () => host,
  getElementById: (id) => (id === 'map-bottom-dock' ? dock : null)
};
let onFrames = null;
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => {
  if (type === 'ddm:heatrisk-frames') onFrames = fn;
};
globalThis.dispatchEvent = () => true;

const { mountHeatRiskSequence } = await import('../src/ui/heatrisk-sequence.ts');

const DAY_MS = 24 * 60 * 60 * 1000;
const FRAMES = Array.from({ length: 7 }, (_, index) => ({
  day: index + 1,
  validTime: 1_785_153_600_000 + index * DAY_MS,
  name: `HeatRisk_${index + 1}_Mercator`
}));
const point = (lng, lat) => ({ label: 'Washington', context: { lngLat: { lng, lat } } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const frames = (selectedDay) => ({
  detail: { status: 'ready', frames: FRAMES, selectedDay, hasCoverage: true }
});

test('an arrow key keeps focus on the newly chosen day after the redraw', async () => {
  seen.current = point(-120.5, 47.3);
  mountHeatRiskSequence(frames(3).detail);
  await settle();
  assert.equal(host.cells.length, 7);
  assert.equal(seen.identifies, 7);

  const day3 = host.querySelector('[data-heatrisk-sequence-day="3"]');
  day3.focus();
  host.listeners.keydown({ key: 'ArrowRight', target: day3, preventDefault() {} });
  // The layer answers the day choice with a frames event for day 4.
  onFrames(frames(4));
  assert.equal(document.activeElement?.dataset.heatriskSequenceDay, '4');
});

test('a new selection object for the same point reuses the finished read', async () => {
  const before = seen.identifies;
  seen.selectionListener(point(-120.5, 47.3));
  await settle();
  assert.equal(seen.identifies, before);
  assert.equal(host.hidden, false);

  seen.selectionListener(point(-121, 47.3));
  await settle();
  assert.equal(seen.identifies, before + 7);

  seen.selectionListener(null);
  await settle();
  seen.selectionListener(point(-121, 47.3));
  await settle();
  assert.equal(seen.identifies, before + 14);
});
