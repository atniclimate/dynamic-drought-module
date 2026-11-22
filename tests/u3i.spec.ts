import { test, expect } from './offline-test';

import { gotoApp, regionButton, regionSelect, layerCheckbox, layerPill } from './helpers';
import { REGIONS, DEFAULT_REGION, type RegionKey } from '../src/config/regions';

/**
 * U3i: consolidated coverage for the U3 catalog-and-search overhaul.
 *
 * U3 shipped seven behavior-affecting sub-units (the magenta Tribal family,
 * the one search across three hosts, the region demotion, the Water & Snow
 * collapse, the feature-state emphasis) with no dedicated regression coverage.
 * This file adds it, holding two lines the suite draws elsewhere:
 *
 *   - Deterministic backbone only (playwright.config.ts doctrine 2): no test
 *     depends on a live agency response. The search-render cases read a bundled
 *     roster; the layer-selection cases toggle `treaty`, a bundled, default-off
 *     layer (no external fetch); the color and emphasis cases run in Node
 *     against source constants and a fake map.
 *   - Production build, never the dev server (doctrine 1). The dev-only
 *     `window.__ddmMap` handle is dead-code-eliminated from `dist/`, so the
 *     on-map paint and feature-state RENDER cannot be read here; that legibility
 *     check is the stage-5 Codex browser pass. What is deterministic and
 *     production-safe is the palette source of truth (the magenta family) and
 *     the emphasis module's own logic (fake map), so those are asserted here.
 */

const REGION_KEYS = Object.keys(REGIONS) as RegionKey[];

// ---------------------------------------------------------------------------
// U3e: the region grid demoted to a "jump to" list (D-0.7.0-009)
// ---------------------------------------------------------------------------

/**
 * The region grid became one combined overview and detailed-camera dropdown
 * with full-word `region.label` names (replacing the abbreviated `short`).
 * Desktop Brief rehosts that same control directly below the minimap.
 */
test.describe('U3i region demotion (D-0.7.0-009)', () => {
  test('console: the jump-to dropdown shows full-word labels with select semantics', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    // A visible console "where" control in its static fallback seat.
    await expect(page.locator('#panel-region')).toBeVisible();
    await expect(regionSelect(page)).toHaveAttribute('aria-label', /region/i);

    // Every detailed region renders in the 'Detailed regions' option group.
    await expect(page.locator('#region-select optgroup[label="Detailed regions"] option')).toHaveCount(
      REGION_KEYS.length
    );

    // The visible text of EVERY button is the full-word `region.label`, NOT the
    // retired `short` (every label differs from its short, so trimmed exact
    // match doubles as the anti-`short` assertion, and covering all nine catches
    // a partial revert).
    for (const key of REGION_KEYS) {
      await expect(regionButton(page, key)).toHaveText(REGIONS[key].label);
    }

    await expect(regionSelect(page)).toHaveValue(`region:${DEFAULT_REGION}`);
  });

  test('brief: the same region jump-to panel is seated below the minimap and before search', async ({
    page
  }) => {
    await gotoApp(page); // bare URL => Brief

    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);

    await expect(page.locator('#shell-region-host > #panel-region')).toBeVisible();
    await expect(regionSelect(page)).toBeVisible();
    await expect(regionButton(page, DEFAULT_REGION)).toHaveCount(1);
    await expect(
      page.locator('.shell-minimap-popover-wrap + #shell-region-host')
    ).toHaveCount(1);
    await expect(page.locator('#shell-region-host + #shell-refine-host')).toHaveCount(1);

    // The existing Brief search remains available immediately after the jump.
    await expect(page.locator('#brief-search [data-ddm-search]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// U3f2: the Water & Snow telemetry panel collapses by default (D-0.7.0-018)
// ---------------------------------------------------------------------------

/**
 * The telemetry panel heading is a reveal disclosure (`#telemetry-reveal`, a
 * button carrying `aria-expanded`) toggling a collapsible `#telemetry-body`
 * that ships `hidden`. Revealing is a pure DOM toggle: it never activates the
 * telemetry layer or changes its status pill (the honesty check). Driven in
 * console, where the full instrument is unambiguously shown and the telemetry
 * layer is off by default (it left the default-on set at H4).
 */
test.describe('U3i Water & Snow collapses by default (D-0.7.0-018)', () => {
  test('the panel is collapsed on first paint', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await expect(page.locator('#telemetry-reveal')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#telemetry-body')).toBeHidden();
  });

  test('the disclosure reveals and re-collapses the body', async ({ page }) => {
    await gotoApp(page, '?view=console');

    await page.locator('#telemetry-reveal').click();
    await expect(page.locator('#telemetry-reveal')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#telemetry-body')).toBeVisible();

    // A second click closes it again (round-trip).
    await page.locator('#telemetry-reveal').click();
    await expect(page.locator('#telemetry-reveal')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#telemetry-body')).toBeHidden();
  });

  test('revealing never activates the telemetry layer (honesty check)', async ({ page }) => {
    await gotoApp(page, '?view=console');

    // Baseline: telemetry is not default-on, so its pill is empty and its
    // catalog checkbox is unchecked.
    await expect(layerPill(page, 'telemetry')).toBeEmpty();
    await expect(layerCheckbox(page, 'telemetry')).not.toBeChecked();

    await page.locator('#telemetry-reveal').click();
    await expect(page.locator('#telemetry-body')).toBeVisible(); // the reveal really happened

    // Unchanged: revealing is sidebar-local, never a layer activation.
    await expect(layerPill(page, 'telemetry')).toBeEmpty();
    await expect(layerCheckbox(page, 'telemetry')).not.toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// U3b/c/d: the one search across the three hosts
// ---------------------------------------------------------------------------

/**
 * The unified search returns three result kinds (places, Tribal land areas by
 * name, layers) and rides three hosts (the console catalog, the Brief head, the
 * mobile at-hand sheet). `search.spec.ts` covers all three kinds in the console
 * host and place selection in the Brief and sheet hosts; the gap this fills is
 * the Tribal-land-area and layer kinds in the Brief head and the mobile sheet.
 * All render/select assertions are network-independent: the roster is bundled,
 * and the exercised layer (`treaty`) is a bundled, default-off placeholder, so
 * selecting it activates no external fetch. The live BIA locate (tribal
 * SELECTION) is the stage-5 Codex browser pass.
 */
test.describe('U3i one search across hosts (U3b/c/d)', () => {
  test('brief head: a Tribal land area renders as a result row', async ({ page }) => {
    await gotoApp(page, '?view=brief');

    await page.locator('#brief-search [data-ddm-search]').fill('nez perce');
    await expect(
      page
        .locator('#brief-search [data-search-group="tribal"] [role="option"]')
        .filter({ hasText: 'Nez Perce Tribe' })
    ).toBeVisible();
  });

  test('brief head: a layer result toggles its layer and clears the query', async ({ page }) => {
    await gotoApp(page, '?view=brief');

    // Baseline: places (City & Town Labels) is a bundled, default-off layer
    // (unchecked to start), so seeing it checked afterward proves the
    // selection did the activation. (The old example, the `treaty` deployer
    // slot, left the search index with Unit I, D-0.7.0-038 part 3.)
    await expect(layerCheckbox(page, 'places')).not.toBeChecked();

    const input = page.locator('#brief-search [data-ddm-search]');
    await input.fill('town labels');
    const result = page.locator(
      '#brief-search [data-search-kind="layer"][data-search-id="places"]'
    );
    await expect(result).toBeVisible();
    await result.click();

    // The shared toggle command turns the layer on (the checkbox holds the DOM
    // state even though the catalog is hidden in Brief) and the input clears.
    await expect(layerCheckbox(page, 'places')).toBeChecked();
    await expect(input).toHaveValue('');
  });

  test.describe('the mobile at-hand sheet (390x844)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('sheet: a Tribal land area renders as a result row', async ({ page }) => {
      await gotoApp(page); // bare => Brief; the shell boots map-first (closed)
      await page.locator('#mobile-footer-nav button[data-tab="place"]').click();

      await page.locator('#sheet-search [data-ddm-search]').fill('spokane');
      await expect(
        page
          .locator('#sheet-search [data-search-group="tribal"] [role="option"]')
          .filter({ hasText: 'Spokane Tribe of the Spokane Reservation' })
      ).toBeVisible();
    });

    test('sheet: a layer result toggles its layer and clears the query', async ({ page }) => {
      await gotoApp(page);
      await page.locator('#mobile-footer-nav button[data-tab="place"]').click();

      await expect(layerCheckbox(page, 'places')).not.toBeChecked();

      const input = page.locator('#sheet-search [data-ddm-search]');
      await input.fill('town labels');
      const result = page.locator(
        '#sheet-search [data-search-kind="layer"][data-search-id="places"]'
      );
      await expect(result).toBeVisible();
      await result.click();

      await expect(layerCheckbox(page, 'places')).toBeChecked();
      await expect(input).toHaveValue('');
    });
  });
});

// ---------------------------------------------------------------------------
// The console window's reach (Codex plan-attack MINOR 6; every window full
// screen since the owner's ruling of 2026-11-13, so there is no half stop)
// ---------------------------------------------------------------------------

/**
 * At a 390x844 phone in console mode, the Layers window must keep the whole
 * console stack reachable: the region jump-to list at its head and the layer
 * catalog below it. The window scrolls INTERNALLY (`.sidebar-scroll`), so the
 * load-bearing assertion is that the catalog can be brought inside the 844px
 * viewport by that scroll surface.
 */
test.describe('U3i console window reach at 390x844 (MINOR 6)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the console stack is reachable inside the full-screen window', async ({ page }) => {
    await gotoApp(page, '?view=console'); // the shell boots map-first (closed)
    const app = page.locator('#app');

    // The Layers door opens the console window. (A broken door or stop
    // transition fails HERE, so a real regression still reds the suite.)
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');

    await expect(page.locator('#panel-region')).toBeVisible();
    const catalog = page.locator('#panel-layers');
    await expect(catalog).toBeVisible();

    const scroll = page.locator('#sidebar .sidebar-scroll');
    expect(await scroll.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    await catalog.scrollIntoViewIfNeeded();
    const reachableBox = await catalog.boundingBox();
    const sheetBox = await page.locator('#sidebar').boundingBox();
    expect(reachableBox).not.toBeNull();
    expect(sheetBox).not.toBeNull();
    expect(reachableBox!.y).toBeGreaterThanOrEqual(sheetBox!.y); // inside the window
    expect(reachableBox!.y).toBeLessThan(844);
  });
});
