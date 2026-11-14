import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A report opened from inside a pressed phone window shows (the review of the
 * full-screen windows, 2026-11-13). On a phone in Layers with a region picked,
 * "See what this means" opens the briefing, whose console host calls
 * `driveSheetForReport('full')`. The window is already full, so before the fix
 * nothing moved: `data-sheet-tab` stayed 'layers', the stylesheet kept the
 * Layers list and #sheet-report stayed hidden while focus went to "Back to map".
 *
 * Drives the REAL src/ui/mobile-sheet.ts against stand-in elements; its
 * neighbours are inert stubs.
 */

const STUBS = {
  '/impact/brief-narrative-selector': 'export const selectBriefNarrativeLine = () => null;',
  '/impact/horizon-chrome': 'export const SHELL_HAZARD_KEY = {};',
  '/state/cluster-service': 'export const getCommittedSnapshot = () => ({ selectedHazard: "drought" });',
  '/state/view-mode': 'let m = "brief"; export const getViewMode = () => m; export const setViewMode = (v) => { m = v; };',
  '/util/escape': 'export const escapeHtml = (s) => s;',
  '/config/layer-groups': 'export const TRIBAL_NATIONS_GROUP = { label: "Tribal Nations" };',
  '/state/place-selection': 'export const getPlaceSelection = () => null; export const onPlaceSelectionChange = () => () => {};',
  '/state/studio-route': 'export const enterPlaceStudio = () => {};',
  '/util/chunk-retry': 'export const createChunkLoader = () => () => new Promise(() => {});',
  '/ui/tribal-nations-action':
    'export const toggleTribalNationsGroup = () => {}; export const wireTribalNationsHealth = () => {}; export const wireTribalNationsToggle = () => {};',
  '/ui/search-chunk': 'export const loadSearchController = () => new Promise(() => {});'
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTs = typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts');
    const target = fromTs && specifier.startsWith('.') ? new URL(`${specifier}.ts`, context.parentURL).pathname : '';
    const stub = Object.entries(STUBS).find(([suffix]) => target.endsWith(`/src${suffix}.ts`));
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && fromTs &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

function el() {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    addEventListener: (type, fn) => listeners.set(type, fn),
    click: () => listeners.get('click')?.(),
    contains: () => false,
    appendChild() {},
    focus() {},
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

const app = el();
const sidebar = el();
const footer = el();
const layersDoor = el();
layersDoor.dataset.tab = 'layers';
footer.querySelectorAll = () => [layersDoor];
const byId = { app, sidebar, 'mobile-footer-nav': footer };

// The phone band's query: a test turns the phone on its side by flipping it.
const phoneBand = {
  matches: true,
  change: () => {},
  addEventListener(type, fn) {
    if (type === 'change') this.change = fn;
  }
};
globalThis.window = {
  matchMedia: () => phoneBand,
  addEventListener() {},
  setTimeout: () => 0,
  clearTimeout() {}
};
globalThis.document = {
  body: el(),
  documentElement: { dataset: {} },
  activeElement: null,
  createElement: () => el(),
  getElementById: (id) => byId[id] ?? null,
  querySelector: () => null,
  querySelectorAll: () => [layersDoor],
  addEventListener() {}
};
globalThis.MutationObserver = class { observe() {} };
globalThis.HTMLButtonElement = class {};

const { initMobileSheet, driveSheetForReport, getSheetDetent, restoreSheetDetent, setSheetBriefingCloser } =
  await import('../src/ui/mobile-sheet.ts');
const map = { resize() {}, isMoving: () => false, jumpTo() {}, once() {} };
initMobileSheet(map);

test('a report opened in the full Layers window releases the door, so the report shows', () => {
  layersDoor.click();
  assert.equal(getSheetDetent(), 'full');
  assert.equal(app.getAttribute('data-sheet-tab'), 'layers', 'the pressed door gates the window');

  driveSheetForReport('full');
  assert.equal(getSheetDetent(), 'full');
  assert.equal(app.getAttribute('data-sheet-tab'), null, 'the report leads: no door gates it away');

  // The report's close leaves the window open where it was, never lowered or closed.
  restoreSheetDetent();
  assert.equal(getSheetDetent(), 'full');
});

// The look of 2026-11-13: Back to map closed the phone window, the phone turned to landscape (the desktop
// layout), and the briefing came back over the map the reader had gone back to. What was closed stays closed.
test('turning the phone to the desktop layout closes only a briefing whose window was closed', () => {
  let closes = 0;
  setSheetBriefingCloser(() => closes++);
  const turn = (phone) => {
    phoneBand.matches = phone;
    phoneBand.change();
  };

  turn(false); // the window is open (full, from the test above): the reader is still reading
  assert.equal(getSheetDetent(), null);
  assert.equal(closes, 0, 'an open window carries its briefing to the desktop layout');

  turn(true); // the phone shell comes back with its window closed
  assert.equal(getSheetDetent(), 'closed');
  turn(false);
  assert.equal(closes, 1, 'a closed window leaves its briefing closed');
});
