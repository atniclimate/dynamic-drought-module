import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The look at 4237781, R1-1: a briefing opened from a map response turned off
 * the lit boundary. While the facade's open waited (the runtime chunk cold, or
 * a containing state to resolve, always so for a BIA or Census AIANNH click)
 * nothing set a new selection, so the popup's close, run right after the door
 * opened the briefing, still saw its own selection as current and cleared it,
 * and the emphasis went with it.
 *
 * Drives the REAL facade open in src/ui/impact-panel.ts with the REAL
 * place-selection store and emphasis seam; the runtime chunk is a stand-in
 * that loads only when the case releases it. Red on 4237781: the popup's
 * close clears the selection and the emphasis stamp.
 */

let release;
globalThis.__runtimeGate = new Promise((resolve) => { release = resolve; });
globalThis.__runtimeOpens = [];

const RUNTIME = [
  'await globalThis.__runtimeGate;',
  'export function setImpactPanelCloseHook(fn) { globalThis.__closeHook = fn; }',
  'export function openImpactPanel(context) { globalThis.__runtimeOpens.push(context); return 1; }',
  'export function isCurrentBriefing() { return true; }',
  'export function closeImpactPanel() { globalThis.__closeHook?.(); }'
].join('\n');

const STUBS = {
  '/ui/mobile-sheet':
    'export const isSheetActive = () => false, getSheetDetent = () => null, sheetAllowsAutoRaise = () => false, sheetReportHost = () => null; export function onSheetDetentSettle() { return () => {}; } export function driveSheetForReport() {} export function restoreSheetDetent() {} export function setSheetBriefing() {} export function setSheetDetent() {}',
  '/ui/overlay': 'export function hideLoading() {} export function showLoading() { return 0; }',
  '/ui/share': 'export function buildShareLink() { return ""; }',
  '/ui/tribal-nations-action': 'export function buildTribalNationsBriefAction() { return null; }',
  '/ui/impact-panel-runtime-primary': RUNTIME,
  '/ui/impact-panel-runtime-recovery': RUNTIME,
  '/impact/containing-state': 'export async function enrichContainingState(context) { return context; }'
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

globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
globalThis.HTMLElement = class {};
globalThis.document = {
  body: {},
  activeElement: null,
  documentElement: { dataset: {} },
  querySelector: () => null,
  getElementById: () => null
};

const { openImpactPanel, closeImpactPanel } = await import('../src/ui/impact-panel.ts');
const { getPlaceSelection, setPlaceSelection } = await import('../src/state/place-selection.ts');
const { emphasizePlaces, initPlaceEmphasis } = await import('../src/state/place-emphasis.ts');

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a door that opens a briefing while it loads keeps the place selected and lit, and its close releases it', async () => {
  const map = { getSource: () => ({}), setFeatureState() {} };
  initPlaceEmphasis(map);
  const context = {
    kind: 'bia-reservation',
    title: 'Fixture Nation',
    properties: null,
    lngLat: { lng: -120, lat: 46 },
    regionKey: 'washington_state',
    containing: { state: null, basis: 'none' }
  };
  // The response the door sits on: its selection and its emphasis (the commit's writes).
  const popupSelection = { label: 'Fixture Nation', context };
  setPlaceSelection(popupSelection);
  emphasizePlaces(map, [{ source: 'bia-reservations', id: 1 }]);
  const lit = document.documentElement.dataset.ddmEmphasis;
  assert.ok(lit, 'the clicked place is lit');

  // The door: open the briefing, then dismiss the popup, whose close clears its own selection only if still current.
  openImpactPanel(context);
  if (getPlaceSelection() === popupSelection) setPlaceSelection(null);
  assert.equal(getPlaceSelection()?.context, context, 'the waiting open holds the place');
  assert.equal(document.documentElement.dataset.ddmEmphasis, lit, 'the place stays lit while its briefing loads');

  // Closed before it loads: the held selection goes, and the emphasis with it.
  closeImpactPanel();
  assert.equal(getPlaceSelection(), null, 'a close during the wait releases the held selection');
  assert.ok(!document.documentElement.dataset.ddmEmphasis, 'and the emphasis');
  release();
  await settle();
  await settle();
  assert.deepEqual(globalThis.__runtimeOpens, [], 'the closed open never paints');

  // A later open, the runtime warm: the open still waits on its containing state, and the held selection stands until it lands.
  openImpactPanel(context);
  assert.equal(getPlaceSelection()?.context, context);
  await settle();
  await settle();
  assert.deepEqual(globalThis.__runtimeOpens, [context], 'the runtime opened the place');
});
