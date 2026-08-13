import { test, expect } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  urlLayers,
  waitForLayerSettled,
  openTribalNationsDetails,
  ROLE_GROUPS,
  SURFACE_KEYS
} from './helpers';

/**
 * UX-1 (CHANGES.md 2026-07-01): the map distinguishes place from state
 * structurally. Layers are grouped by role, and condition surfaces are
 * mutually exclusive.
 *
 * These assertions are network-independent: role-group rendering, checkbox
 * exclusivity, and old-link resolution are all client-side. The one surface
 * driven here (heatrisk) catches its own data failures and resolves per the
 * ratified stay-on contract, so it stays checked even when its upstream is
 * unreachable from a CI runner.
 */
test.describe('UX-1 role groups and exclusive surfaces', () => {
  test('the four role groups render in order with their hints', async ({ page }) => {
    await gotoApp(page);

    const groups = page.locator('#layer-toggles .layer-group');
    await expect(groups).toHaveCount(ROLE_GROUPS.length);

    for (let i = 0; i < ROLE_GROUPS.length; i++) {
      const { title, hint } = ROLE_GROUPS[i]!;
      const heading = groups.nth(i).locator('.layer-group-title');
      await expect(heading).toContainText(title);

      const hintEl = groups.nth(i).locator('.layer-group-hint');
      if (hint) {
        await expect(hintEl).toHaveText(hint);
      } else {
        await expect(hintEl).toHaveCount(0);
      }
    }
  });

  test('checking a surface deactivates the surface that was on (one at a time)', async ({ page }) => {
    // Console boot: this spec drives catalog checkboxes, and E1 deliverable 1
    // hides the Brief-mode catalog behind the console door.
    await gotoApp(page, '?view=console');

    // Default-on surface is the North American Drought Monitor. Let its initial activation
    // settle before toggling, so the exclusivity removal is not racing NADM's
    // own in-flight boot activation.
    await expect(layerCheckbox(page, 'nadm-drought')).toBeChecked();
    await waitForLayerSettled(page, 'nadm-drought');

    // Turning on HeatRisk must turn NADM off.
    await layerCheckbox(page, 'heatrisk').check();
    await expect(layerCheckbox(page, 'nadm-drought')).not.toBeChecked();
    await expect(layerCheckbox(page, 'heatrisk')).toBeChecked();

    // Exactly one surface is checked, and it is heatrisk.
    for (const key of SURFACE_KEYS) {
      const cb = layerCheckbox(page, key);
      if (key === 'heatrisk') await expect(cb).toBeChecked();
      else await expect(cb).not.toBeChecked();
    }

    // The URL tracks exactly one surface: NADM dropped, heatrisk present.
    // heatrisk enters the URL only after its activate() resolves, which on a
    // slow-upstream day legitimately exceeds the default 10-second expect
    // ceiling (its metadata fetch alone carries a 10-second budget before the
    // stay-on contract resolves it); 25 seconds matches waitForLayerSettled.
    // (This exact poll flaked in CI on 2026-07-03 under the default ceiling.)
    await expect
      .poll(async () => (await urlLayers(page)).has('nadm-drought'), { timeout: 25_000 })
      .toBe(false);
    await expect
      .poll(async () => (await urlLayers(page)).has('heatrisk'), { timeout: 25_000 })
      .toBe(true);
  });

  test('an old multi-surface link keeps the first surface named (usdm before heatrisk)', async ({ page }) => {
    await gotoApp(page, '?layers=usdm,heatrisk,tribal,telemetry');

    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();
    await expect(layerCheckbox(page, 'tribal')).toBeChecked();
    await expect(layerCheckbox(page, 'telemetry')).toBeChecked();
  });

  test('an old multi-surface link keeps the first surface named (heatrisk before usdm)', async ({ page }) => {
    await gotoApp(page, '?layers=heatrisk,usdm,tribal');

    await expect(layerCheckbox(page, 'heatrisk')).toBeChecked();
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(layerCheckbox(page, 'tribal')).toBeChecked();
  });

  test('a surface deactivated by the exclusivity rule clears its status pill', async ({ page }) => {
    // Console boot: drives a catalog checkbox (E1 deliverable 1 hides the
    // Brief-mode catalog behind the console door).
    await gotoApp(page, '?view=console');

    // NADM is on and, once settled, carries a terminal status pill.
    await waitForLayerSettled(page, 'nadm-drought');
    await expect(layerPill(page, 'nadm-drought')).not.toBeEmpty();

    // Turning on another surface deactivates NADM; an off layer has no load
    // status, so its pill returns to the empty pre-activation state.
    await layerCheckbox(page, 'heatrisk').check();
    await expect(layerPill(page, 'nadm-drought')).toBeEmpty();
  });
});

/**
 * U3a: the catalog regroup (the corpus "group by user question with active
 * counts, not provider names"). Keeps the UX-1 role grouping and the
 * data-layer-key / data-layer-status contracts; adds a per-group active
 * count and collapses the provider attribution behind a per-group
 * disclosure. Driven in console view so the catalog is interactive.
 */
test.describe('U3a catalog regroup', () => {
  // The Place group is located via the always-rendered states row (the
  // deployer slot rows left the default catalog with Unit I, D-0.7.0-038).
  const placeGroup = (page: import('@playwright/test').Page) =>
    page.locator('.layer-group').filter({ has: page.locator('input[data-layer-key="states"]') });

  test('group headings carry an active count that tracks toggles', async ({ page }) => {
    await gotoApp(page, '?view=console');
    const place = placeGroup(page);

    // The default-on reference set is the two present-day Tribal Nations
    // layers (Tribal Lands, Reservation Boundaries; Unit I narrowed the
    // umbrella default, D-0.7.0-038) plus State Boundaries (U4c) and
    // Terrain Shading (E1: hillshade default-on, D-0.7.0-043 part 3),
    // so Place reads "4 on".
    await expect(place.locator('.layer-group-count')).toHaveText('4 on');

    // The count follows the checkbox intent (no network needed): another
    // reference layer lights it to "5 on".
    await layerCheckbox(page, 'ecoregions').check();
    await expect(place.locator('.layer-group-count')).toHaveText('5 on');
  });

  test('the provider source collapses behind a per-group disclosure', async ({ page }) => {
    await gotoApp(page, '?view=console');
    const place = placeGroup(page);

    // Open the Tribal Nations details first (Unit F): the umbrella member
    // rows are natively hidden until then, and this spec's visibility
    // assertions expect every Place row on screen.
    await openTribalNationsDetails(page);

    // Collapsed by default: no source attribution is rendered.
    await expect(place.locator('.layer-toggle-source')).toHaveCount(0);
    const toggle = place.locator('.layer-group-sources-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Expanding reveals a source line for every row in the group.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rowCount = await place.locator('.layer-toggle').count();
    await expect(place.locator('.layer-toggle-source')).toHaveCount(rowCount);
    await expect(place.locator('.layer-toggle-source').first()).toBeVisible();
    await expect(place.locator('.layer-toggle-status + .layer-toggle-source')).toHaveCount(rowCount);

    // Per-group isolation: expanding Place opens exactly one group's sources
    // (a regression to a single shared flag would open all four).
    await expect(page.locator('.layer-group-sources-toggle[aria-expanded="true"]')).toHaveCount(1);

    // Collapsing hides them again.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(place.locator('.layer-toggle-source')).toHaveCount(0);
  });

  test('a group with no active layers shows no count until one turns on', async ({ page }) => {
    await gotoApp(page, '?view=console');
    // Events are all default-off, so the group renders no count element.
    const eventsGroup = page
      .locator('.layer-group')
      .filter({ has: page.locator('input[data-layer-key="nws-alerts"]') });
    await expect(eventsGroup.locator('.layer-group-count')).toHaveCount(0);

    // Turning one on (nws-alerts co-activates nothing) lights the count to "1 on".
    await layerCheckbox(page, 'nws-alerts').check();
    await expect(eventsGroup.locator('.layer-group-count')).toHaveText('1 on');
  });
});
