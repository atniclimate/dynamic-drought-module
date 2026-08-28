import { expect, test } from '@playwright/test';

import {
  NIFC_GEOMETRY_PRECISION,
  NIFC_MAX_ALLOWABLE_OFFSET_DEG,
  NIFC_OUT_FIELDS
} from '../src/config/wildfire-presentation';
import { gotoApp, waitForLayerSettled } from './helpers';
import { stubWildfireFeeds } from './wildfire-fixtures';

/**
 * FE-16 (2026-08-28): the NIFC WFIGS perimeters query must stay inside the
 * layer's 15 s budget. The shipped query (`outFields=*`, full-precision
 * geometry) measured 42.75 MB in 41.6 s for 243 perimeters, so the Fire
 * view's primary evidence read `unavailable` on every boot. This spec pins
 * the query shape that measured 1.83 MB in 4.5 s: a schema-exact field list
 * and server-side display generalization. It also pins the qualification
 * that makes the generalized edge an honest representation: the legend and
 * the map key both say the outline is generalized and by how much.
 */
test.describe('NIFC WFIGS query scope', () => {
  test('the perimeters query names its fields and asks the service to generalize', async ({
    page
  }) => {
    const queries: string[] = [];
    await stubWildfireFeeds(page);
    // The minimap's per-region wildfire counts hit the same service with
    // returnCountOnly; only the layer's GeoJSON query is under test here.
    await page.route(
      (url) =>
        url.href.includes('WFIGS_Interagency_Perimeters_Current') &&
        url.pathname.endsWith('/query') &&
        url.searchParams.get('f') === 'geojson',
      async (route) => {
        queries.push(route.request().url());
        await route.fallback();
      }
    );

    await gotoApp(page, '?cluster=wildfire&view=console');
    await waitForLayerSettled(page, 'nifc-fires');

    expect(queries.length, 'exactly one perimeters query per activation').toBe(1);
    const params = new URL(queries[0]!).searchParams;
    expect(params.get('where')).toBe('1=1');
    expect(params.get('f')).toBe('geojson');
    expect(params.get('outSR')).toBe('4326');
    expect(params.get('outFields')).toBe(NIFC_OUT_FIELDS.join(','));
    expect(params.get('outFields')).not.toContain('*');
    expect(params.get('geometryPrecision')).toBe(String(NIFC_GEOMETRY_PRECISION));
    expect(params.get('maxAllowableOffset')).toBe(String(NIFC_MAX_ALLOWABLE_OFFSET_DEG));
    // The runtime reads no attribute the query does not request, except the
    // legacy IncidentName fallbacks that older responses and fixtures carry.
    for (const field of [
      'attr_IncidentName',
      'attr_IncidentTypeCategory',
      'attr_UniqueFireIdentifier',
      'attr_IrwinID',
      'attr_IncidentSize',
      'attr_FireDiscoveryDateTime',
      'attr_POOState'
    ]) {
      expect(params.get('outFields')).toContain(field);
    }
    expect(params.get('outFields')).not.toContain('attr_DailyAcres');
  });

  test('the legend and the map key state the generalization', async ({ page }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?cluster=wildfire&view=console');
    await waitForLayerSettled(page, 'nifc-fires');

    const legend = page.locator('#legend, .legend, [data-legend]').first();
    await expect(legend).toContainText('0.0005 degree');
    await expect(legend).toContainText('not the full-resolution source geometry');

    const key = page.locator('#map-key [data-nifc-perimeter-key]');
    await expect(key).toBeVisible();
    await expect(key.locator('[data-nifc-generalization]')).toContainText('0.0005 degree');
    await expect(key.locator('.map-key-item')).toHaveCount(3);
  });
});
