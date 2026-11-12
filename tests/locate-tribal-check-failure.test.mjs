/**
 * A Tribal lands check that fails ends its checking state (src/ui/locate-runtime.ts
 * checkTribal). Before the fix the check's promise had no rejection handler,
 * so a thrown check left the card reading "Checking Tribal lands near you"
 * for as long as the position stood. Drives the real createLocate with the
 * browser-facing modules stubbed: the device answers one good fix, the
 * bundled outlines name one state, and the check rejects.
 *
 * It registers no Playwright tests: it runs under `node --test`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stubs = {
  '/styles/locate.css': 'export {};',
  '/map/locate-marker': 'export function showLocateMarker(){ return { remove(){} }; }',
  '/util/chunk-stylesheets': 'export function requireStylesheetMark(){}',
  '/state/locate-preference': `export function readLaunchPreference(){ return 'no'; }
    export function writeLaunchPreference(){ return true; }`,
  '/config/layer-groups': `export const TRIBAL_NATIONS_GROUP = { label: 'Tribal Nations', actionDescription: 'd' };`,
  '/ui/tribal-nations-action': 'export function activateTribalNationsGroup(){}',
  '/ui/mobile-sheet': `export function getSheetDetent(){ return 'closed'; } export function isSheetActive(){ return false; }
    export function setSheetDetent(){} export function sheetCameraInset(){ return 0; }`,
  '/ui/locate-card': `export function createLocateCard(){
      return { shown: false, show(view){ this.shown = true; globalThis.__view = view; },
        hide(){ this.shown = false; globalThis.__view = null; }, hasFocus(){ return false; }, focusTitle(){} }; }`,
  '/ui/locate-place': `export function agenciesAsked(){ return []; }
    export function checkTribalLands(){ return Promise.reject(new Error('boundary read failed')); }
    export async function openStateBriefingFor(){}
    export async function openTribalBriefingFor(){}
    export async function resolveStates(){ return { kind: 'in', state: { code: 'OR', name: 'Oregon' } }; }
    export function tribalLayerName(){ return 'Tribal Lands'; }
    export function tribalLayerReadings(){ return []; }
    export function tribalLayersActive(){ return true; }
    export async function tribalPlaceWords(){ return null; }`
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Only the runtime's own imports are stubbed; the modules it reaches through stay real.
    const fromRuntime = String(context.parentURL).endsWith('/ui/locate-runtime.ts');
    const stub = fromRuntime && Object.entries(stubs).find(([suffix]) => specifier.endsWith(suffix.split('/').pop()));
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub[1])}`, shortCircuit: true };
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

const element = () => ({ setAttribute() {}, removeAttribute() {}, focus() {}, closest: () => ({}), textContent: '' });
globalThis.window = globalThis;
globalThis.isSecureContext = true;
globalThis.MutationObserver = class { observe() {} };
globalThis.document = { activeElement: null, getElementById: () => element() };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    permissions: { query: async () => ({ state: 'granted' }) },
    geolocation: {
      watchPosition(onFix) {
        queueMicrotask(() => onFix({ coords: { longitude: -122.6, latitude: 45.5, accuracy: 20 } }));
        return 1;
      },
      clearWatch() {}
    }
  }
});
console.warn = () => {};

const { createLocate } = await import('../src/ui/locate-runtime.ts');

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const actions = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.items);

test('a Tribal lands check that fails ends the checking state and says the check could not be completed', async () => {
  const status = element();
  const locate = createLocate({}, element(), status);
  locate.press();
  await settle();
  const start = actions(globalThis.__view).find((a) => a.id === 'tribal');
  assert.ok(start, 'the located card offers the Tribal lands check');
  start.run();
  assert.equal(globalThis.__view.title, 'Checking Tribal lands near you');
  await settle();
  const view = globalThis.__view;
  assert.notEqual(view.title, 'Checking Tribal lands near you', 'the card leaves the checking state');
  const line = view.lines.join(' ');
  assert.match(line, /Tribal lands not checked: the check could not be completed\./);
  assert.ok(actions(view).some((a) => a.id === 'tribal' && a.label === 'Check again'), 'the check can be run again');
  assert.match(status.textContent, /could not be completed/);
  locate.press();
});
