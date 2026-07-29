import { test, expect } from '@playwright/test';

import { gotoApp, layerCheckbox, urlLayers } from './helpers';
import { getLayerDef, DEFAULT_ON_KEYS } from '../src/config/layers';

/**
 * E1, the calm-the-page slice (D-0.7.0-041 part 2; D-0.7.0-043 parts 3 and
 * 4; the 2026-07-16 design review section E1; the handoff
 * docs/prompts/HANDOFF_E1_2026-07-16.md).
 *
 * Deliverable 1 (interim progressive disclosure), deliverable 4 (hillshade
 * default-on), and the never-narrow-the-sovereign-set fence are pinned
 * here; deliverable 2 (the deterministic thematic chain) is pinned in
 * layer-order.spec.ts, deliverable 6 (the retired off-state tiles) in
 * conditions-strip.spec.ts, and deliverables 3 and 5 (paint and the one
 * Tribal color family) ride the stewardship visual review plus the u3i
 * palette-band guard.
 */
test.describe('E1 deliverable 1: Brief-mode progressive disclosure', () => {
  test('Brief hides the console instrumentation; the console door restores it', async ({
    page
  }) => {
    await gotoApp(page); // a bare URL boots Brief

    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);

    // Hidden in Brief: Quick views, the Layers catalog, Water & Snow, and
    // the persistent footer (review E1.2). CSS-first: the DOM stays
    // mounted, so counts still resolve while nothing displays.
    await expect(page.locator('#panel-quick-views')).toBeHidden();
    await expect(page.locator('#panel-layers')).toBeHidden();
    await expect(page.locator('#panel-telemetry')).toBeHidden();
    await expect(page.locator('.sidebar-footer')).toBeHidden();
    await expect(page.locator('#layer-toggles .layer-group')).toHaveCount(4);

    // SUPERSESSION (D-0.7.0-055 via D-0.7.0-062): the interim console
    // door retired when the minimal LAYERS studio landed. The Brief head
    // now carries the real LAYERS studio entry, and the header mode
    // switch is the honest console escape that restores the instrument.
    const entry = page.locator('#layers-studio-entry');
    await expect(entry).toBeVisible();
    await expect(entry).toHaveText('LAYERS');
    await page.locator('.view-switch [data-view="console"]').click();

    await expect(page.locator('#app')).toHaveClass(/\bview-console\b/);
    await expect(page.locator('#panel-quick-views')).toBeVisible();
    await expect(page.locator('#panel-layers')).toBeVisible();
    await expect(page.locator('#panel-telemetry')).toBeVisible();
    await expect(page.locator('.sidebar-footer')).toBeVisible();
  });

  test('the Brief head is worded around map selection, and console mode is untouched', async ({
    page
  }) => {
    await gotoApp(page);
    // The reworded lede leads with selecting on the map, not with an
    // already-open report (review E1.2).
    await expect(page.locator('.brief-head-lede')).toContainText('Select a Tribal land area');

    await gotoApp(page, '?view=console');
    await expect(page.locator('#panel-quick-views')).toBeVisible();
    await expect(page.locator('#panel-layers')).toBeVisible();
    await expect(page.locator('.sidebar-footer')).toBeVisible();
  });
});

test.describe('E1 deliverable 4: hillshade default-on (D-0.7.0-043 part 3)', () => {
  test('the config flag is on (node-level pin)', () => {
    expect(getLayerDef('hillshade')?.defaultOn).toBe(true);
    expect(DEFAULT_ON_KEYS.has('hillshade')).toBe(true);
  });

  test('a bare console boot activates terrain shading', async ({ page }) => {
    await gotoApp(page, '?view=console');
    await expect(layerCheckbox(page, 'hillshade')).toBeChecked();
    await expect
      .poll(async () => (await urlLayers(page)).has('hillshade'), { timeout: 25_000 })
      .toBe(true);
  });
});

test.describe('E1 hard fence: the sovereign default set never narrows', () => {
  test('the two present-day Tribal-geography layers stay default-on', () => {
    // A stewardship decision (D-0.7.0-032/033, narrowed only by
    // D-0.7.0-038): E1 tunes paint and order, never membership.
    expect(getLayerDef('aiannh')?.defaultOn).toBe(true);
    expect(getLayerDef('bia-reservations')?.defaultOn).toBe(true);
    expect(getLayerDef('usdm')?.defaultOn).toBe(true);
    expect(getLayerDef('states')?.defaultOn).toBe(true);
  });
});
