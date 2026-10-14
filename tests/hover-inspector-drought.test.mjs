import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// hover-inspector.ts imports `../config/palette` extensionless.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

/**
 * Audit 7 finding 1: the hover readout named the drought category only from the
 * USDM frame fills, so the default view (NADM) read nothing. Drives the shipped
 * initHoverInspector with a fake map and a one-element fake DOM.
 */
const el = { hidden: true, innerHTML: '' };
globalThis.document = { getElementById: (id) => (id === 'hover-inspector' ? el : null) };
globalThis.window = { requestAnimationFrame: (fn) => fn() };
const { initHoverInspector } = await import(new URL('../src/ui/hover-inspector.ts', import.meta.url).href);

function hoverText(layers) {
  let move;
  initHoverInspector({
    on: (_event, fn) => (move = fn),
    getCanvas: () => ({ addEventListener() {} }),
    getLayer: (id) => (id in layers ? {} : undefined),
    queryRenderedFeatures: (_box, opts) => layers[opts.layers[0]] ?? []
  });
  move({ point: { x: 10, y: 10 } });
  return el.hidden ? '' : el.innerHTML.replace(/<[^>]+>/g, '|');
}

test('the default NADM fill names the drought category under the cursor', () => {
  const text = hoverText({ 'nadm-drought-fill': [{ properties: { DROUGHTCAT: 'D1' } }, { properties: { DROUGHTCAT: 'D3' } }] });
  assert.match(text, /Drought\|D3 Extreme drought/, 'the highest category in the box, as the popup picks it');
});

test('NADM wins over USDM when both answer; USDM alone still reads', () => {
  const both = hoverText({
    'nadm-drought-fill': [{ properties: { DROUGHTCAT: 'D0' } }],
    'usdm-frame-a-fill': [{ properties: { DM: 2 } }]
  });
  assert.match(both, /D0 Abnormally dry/);
  assert.doesNotMatch(both, /D2/);
  assert.match(hoverText({ 'usdm-frame-a-fill': [{ properties: { DM: 2 } }] }), /D2 /);
});
