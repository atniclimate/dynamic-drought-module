import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Closing the Impact Briefing returns focus to the control that opened it,
 * never the page body (the look at 1589964, 10.05: open Washington from the
 * sidebar's "See what this means", close by the button or Escape, and focus
 * sat on the body). Hard close retires the panel-owned selection, which hides
 * that door when the region menu reads "Selected place", so the opener
 * cannot take focus back; a popup's door has left with its popup.
 *
 * Drives the REAL shell open and close in src/ui/impact-panel.ts against
 * stand-in elements: `focus()` moves the stand-in document's activeElement
 * only for a shown, connected element, as a browser does. The mobile sheet,
 * loading overlay, share link and Tribal Nations action are inert stubs.
 * Red on 1589964: the hidden region door leaves focus where the close found
 * it (the browser then drops it to the body).
 */

const STUBS = {
  '/ui/mobile-sheet':
    'export const isSheetActive = () => false, getSheetDetent = () => null, sheetAllowsAutoRaise = () => false, sheetReportHost = () => null; export function onSheetDetentSettle() { return () => {}; } export function driveSheetForReport() {} export function restoreSheetDetent() {} export function setSheetBriefing() {} export function setSheetBriefingOpener() {} export function setSheetBriefingCloser() {} export function setSheetDetent() {}',
  '/ui/overlay': 'export function hideLoading() {} export function showLoading() { return 0; }',
  '/ui/share': 'export function buildShareLink() { return ""; }',
  '/ui/tribal-nations-action': 'export function buildTribalNationsBriefAction() { return null; }',
  '/state/view-mode': 'export function getViewMode() { return "brief"; }'
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

let active = null;
function el(name, { inPopup = false } = {}) {
  const attrs = new Map();
  const classes = new Set();
  const parts = new Map();
  const node = {
    name,
    id: '',
    hidden: false,
    isConnected: true,
    parentElement: null,
    style: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    addEventListener() {},
    contains: () => false,
    appendChild(child) { child.parentElement = node; },
    focus() { if (!node.hidden && node.isConnected) active = node; },
    closest: (selector) => (inPopup && selector === '.maplibregl-popup' ? {} : null),
    // The panel's header controls and body, one stand-in per selector.
    querySelector(selector) {
      if (!parts.has(selector)) parts.set(selector, el(selector));
      return parts.get(selector);
    }
  };
  return node;
}

const body = el('body');
const search = el('place search');
const canvas = el('map canvas');
globalThis.window = { setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, print() {} };
globalThis.document = {
  body,
  get activeElement() { return active ?? body; },
  createElement: (tag) => el(tag),
  getElementById: () => null,
  contains: (node) => node.isConnected,
  querySelector: (selector) =>
    ({ '#brief-search [data-ddm-search]': search, '.maplibregl-canvas': canvas })[selector] ?? null
};

const { openImpactPanelShell, closeImpactPanelShell } = await import('../src/ui/impact-panel.ts');

function openThenClose(opener, closeHides) {
  opener.focus();
  openImpactPanelShell(() => {}, opener);
  assert.equal(document.activeElement.name, '.impact-panel-close', 'the open puts focus on Close');
  closeHides(opener);
  closeImpactPanelShell();
  return document.activeElement;
}

test('a trigger still shown after the close takes focus back', () => {
  const region = el('region briefing door');
  assert.equal(openThenClose(region, () => {}), region);
});

test('a door the close hid (the cleared selection) hands focus to the place search, not the body', () => {
  const region = el('region briefing door');
  region.id = 'region-briefing-btn';
  assert.equal(openThenClose(region, (door) => { door.hidden = true; }).name, 'place search');
});

test('the Brief report link, hidden the same way, still lands on the place search', () => {
  const link = el('report link');
  link.id = 'brief-full-report-link';
  assert.equal(openThenClose(link, (door) => { door.hidden = true; }).name, 'place search');
});

test('outside Brief the place search is hidden too, so the hidden region door hands focus to the map', () => {
  const region = el('region briefing door');
  region.id = 'region-briefing-btn';
  search.hidden = true; // #brief-head is hidden in every mode but Brief
  try {
    assert.equal(openThenClose(region, (door) => { door.hidden = true; }).name, 'map canvas');
  } finally {
    search.hidden = false;
  }
});

test('a map popup door, removed with its popup, hands focus to the map', () => {
  const door = el('popup door', { inPopup: true });
  assert.equal(openThenClose(door, (d) => { d.isConnected = false; }).name, 'map canvas');
});
