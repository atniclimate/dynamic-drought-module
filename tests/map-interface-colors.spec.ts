import type { Map as MlMap } from 'maplibre-gl';
import { test, expect } from './offline-test';
import { gotoApp, waitForLayerSettled } from './helpers';

test('D3 M5 actual map ground, place label and state outline use adopted neutrals', async ({ page }) => {
  // Existing flow-wire constructor observation seam; no production hook or
  // replacement renderer. Read the actual style created by the adapters.
  await page.addInitScript(() => {
    const maps: MlMap[] = [];
    (window as unknown as { __interfaceMaps: MlMap[] }).__interfaceMaps = maps;
    Object.defineProperty(Object.prototype, '_onWindowOnline', {
      configurable: true,
      set(this: MlMap, value: unknown) {
        Object.defineProperty(this, '_onWindowOnline', { configurable: true, enumerable: true, writable: true, value });
        maps.push(this);
      }
    });
  });
  await gotoApp(page, '?view=console&region=washington_state&layers=states,places&flow=off');
  for (const key of ['states', 'places']) {
    await waitForLayerSettled(page, key);
    await expect(page.locator(`[data-layer-status="${key}"]`)).toHaveClass(/\bready\b/);
  }
  const colors = await page.evaluate(() => {
    const map = (window as unknown as { __interfaceMaps: MlMap[] }).__interfaceMaps.find(map => map.getContainer().id === 'map')!;
    return {
      ground: map.getPaintProperty('background', 'background-color'),
      label: map.getPaintProperty('us-places-labels', 'text-color'),
      halo: map.getPaintProperty('us-places-labels', 'text-halo-color'),
      haloWidth: map.getPaintProperty('us-places-labels', 'text-halo-width'),
      haloBlur: map.getPaintProperty('us-places-labels', 'text-halo-blur'),
      state: map.getPaintProperty('us-states-outline', 'line-color'),
      cssGround: getComputedStyle(document.documentElement).getPropertyValue('--surface-base').trim().toUpperCase(),
      cssShade: getComputedStyle(document.documentElement).getPropertyValue('--surface-overlay').trim().toUpperCase()
    };
  });
  // The Places layer's names match the base map's city names: brighter text on a soft cushion, no drawn
  // outline (owner, 2026-11-22; src/config/interface-tokens.ts BASE_PLACE_LABEL_COLOR, MAP_LABEL_CUSHION).
  expect(colors).toEqual({ ground: '#010B13', label: '#E8ECF0', halo: 'rgba(1, 11, 19, 0.8)',
    haloWidth: 1.4, haloBlur: 1, state: '#8A94A6', cssGround: '#010B13', cssShade: '#1E242C' });
});
