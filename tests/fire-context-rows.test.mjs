import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit round 5 (R5-17): in Wildfire 3D the perimeter-masked drape
 * (`whp-2023`) draws nothing inside a current perimeter, so the perimeter
 * popup's fuels row must not point at a class "beneath this perimeter" or
 * ask for a layer whose white ground is already on screen. The issuer
 * colours row (`usfs-whp-classes`) stands the drape down and draws unmasked,
 * so with it on the row still points beneath.
 */

// Same extensionless-specifier hook as tests/briefing-truth.test.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { readFireContext } = await import('../src/impact/fire-context.ts');

function fuelsText(layers) {
  const map = { getLayer: (id) => (layers.includes(id) ? { id } : undefined), queryRenderedFeatures: () => [] };
  const { details } = readFireContext(map, [10, 10], { lng: -120, lat: 46 });
  const row = details.find((d) => d.label === 'Fuels and hazard');
  return row.text;
}

test('Wildfire 3D with the masked drape says fuel risk is not drawn inside the perimeter', () => {
  assert.equal(fuelsText(['whp-2023']), 'In Wildfire 3D, fuel risk is not drawn inside current fire perimeters (NIFC).');
  assert.equal(fuelsText(['whp-2023', 'usfs-whp']), 'In Wildfire 3D, fuel risk is not drawn inside current fire perimeters (NIFC).');
});

test('the issuer colours row draws unmasked, so it still points beneath, in 3D or not', () => {
  assert.match(fuelsText(['whp-2023', 'usfs-whp-classes']), /read the class from the shaded surface beneath this perimeter/);
  assert.match(fuelsText(['usfs-whp']), /read the class from the shaded surface beneath this perimeter/);
  assert.match(fuelsText([]), /^Turn on Wildfire Hazard Potential/);
});
