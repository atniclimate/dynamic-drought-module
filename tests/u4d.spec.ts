import { test, expect } from '@playwright/test';

import { gotoApp, layerCheckbox, search, waitForLayerSettled } from './helpers';

/**
 * U4d: the basemap switcher and the `basemap=` URL parameter
 * (D-0.7.0-031 CONFIRMED 2026-07-14; D-0.7.0-028 rules the imagery).
 *
 * ADDITIVE specs only: the existing url-state and embed suites are
 * UNMODIFIED (the D-031 spec posture). These pin the parameter's edge
 * cases (unknown, empty, duplicate first-wins), the default-omission
 * canonical write, embed stickiness, and the honesty chip: the vintage
 * notice is visible exactly when the satellite basemap is selected.
 */

const SWITCHER = '.basemap-switcher-btn';
const VINTAGE_CHIP = '#basemap-vintage';

test.describe('U4d: the basemap= parameter', () => {
  test('absent parameter stays absent through the boot canonical write', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    // The boot write has already run (gotoApp settles on built chrome).
    expect(await search(page)).not.toContain('basemap=');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
  });

  test('basemap=satellite seeds the mode and survives an unrelated sync', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=satellite');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'true');
    expect(await search(page)).toContain('basemap=satellite');

    // An unrelated durable-state change (a layer toggle) re-emits the URL;
    // the basemap token must ride along (invariant 2 stickiness).
    await waitForLayerSettled(page, 'states');
    await layerCheckbox(page, 'states').uncheck();
    await expect.poll(async () => search(page)).toContain('basemap=satellite');
  });

  test('unknown and empty tokens read as the default and canonicalize away', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=bogus');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('basemap=');

    await gotoApp(page, '?view=console&basemap=');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('basemap=');
  });

  test('a duplicated parameter is malformed and pins to the default, both orders', async ({
    page
  }) => {
    // D-0.7.0-031 edge-case rule (re-pinned by the stage-5 adversarial
    // major 5): ambiguity is rejected, never resolved by position.
    await gotoApp(page, '?view=console&basemap=satellite&basemap=bogus');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('basemap=');

    await gotoApp(page, '?view=console&basemap=bogus&basemap=satellite');
    await expect(page.locator(SWITCHER)).toHaveAttribute('aria-pressed', 'false');
    expect(await search(page)).not.toContain('basemap=');
  });

  test('embeds honor basemap=satellite and keep it sticky', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true&view=console&basemap=satellite');
    await expect(page.locator('#app')).toHaveClass(/embed/);
    expect(await search(page)).toContain('basemap=satellite');
    expect(await search(page)).toContain('embed=true');
  });
});

test.describe('U4d: the switcher control and the honesty chip', () => {
  test('the switcher toggles satellite on and off with real button semantics', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    const btn = page.locator(SWITCHER);
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveAccessibleName(/satellite/i);

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => search(page)).toContain('basemap=satellite');
    // The vintage notice appears with the imagery (the D-028 honesty
    // split: a plain statement, not just the legal attribution).
    await expect(page.locator(VINTAGE_CHIP)).toBeVisible();

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect(page.locator(VINTAGE_CHIP)).toBeHidden();
  });

  test('a satellite deep link shows the vintage notice without a click', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=satellite');
    await expect(page.locator(VINTAGE_CHIP)).toBeVisible();
    // The notice names the mosaic year and its context-only framing.
    await expect(page.locator(VINTAGE_CHIP)).toContainText(/20\d\d/);
    await expect(page.locator(VINTAGE_CHIP)).toContainText(/not current conditions/i);
  });

  test('the ruled EOX attribution renders VERBATIM as visible text (D-028 condition 2)', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&basemap=satellite');
    const attrib = page.locator('.maplibregl-ctrl-attrib');
    // The exact legal string from EVIDENCE_EOX_2026-07-14.md, including the
    // visible URL (the stage-5 adversarial major 1: a hidden href is not
    // the unchanged visible string the ruling requires).
    await expect(attrib).toContainText(
      'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH ' +
        '(Contains modified Copernicus Sentinel data 2016 & 2017)'
    );
    await expect(attrib).not.toContainText('OpenStreetMap');
  });

  test('a dead satellite tile host reverts the mode honestly (D-028 failure custody)', async ({
    page
  }) => {
    // Kill every EOX request before boot: the URL must not keep claiming a
    // satellite view that cannot render (invariant 6; the stage-5
    // adversarial major 6).
    await page.route('**tiles.maps.eox.at**', (route) => route.abort());
    await gotoApp(page, '?view=console&basemap=satellite');

    const btn = page.locator(SWITCHER);
    await expect(btn).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    await expect.poll(async () => search(page)).not.toContain('basemap=');
    await expect(page.locator(VINTAGE_CHIP)).toBeHidden();
    // The default basemap is back on screen (its attribution returns).
    await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap');
  });
});
