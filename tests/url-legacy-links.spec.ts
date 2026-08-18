import { test, expect } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  regionButton,
  regionSelect,
  urlLayers,
  search,
  waitForLayerSettled,
  DEFAULT_ON
} from './helpers';

/**
 * The URL-schema stability policy (unit A1):
 * a link ever shared must keep working as the parameter schema grows.
 * This spec asserts the tolerant-reading half of that contract, which
 * url-state.spec.ts does not cover (that spec covers the happy-path
 * round trip and the embed contract). Everything here is
 * network-independent: parsing, fallback, and forward-mapping are all
 * client-side, so the assertions never couple to a live agency value
 * (smoke-suite doctrine: assert the deterministic backbone, never exact
 * live values). Where a test also checks the WRITE half (that syncUrl
 * canonicalizes the URL), it first settles a default-on layer so the
 * boot-time rewrite has run; a terminal pill is network-independent in
 * outcome, matching the established pattern in url-state.spec.ts.
 */
test.describe('URL legacy links and tolerant reading', () => {
  test('an unknown parameter is ignored, never fatal (policy rule 1)', async ({ page }) => {
    // A future or third-party parameter the current build does not know.
    await gotoApp(page, '?region=central_oregon&flavor=chocolate&v=2');

    // The known parameter still resolves and the app boots normally
    // (gotoApp already asserted the sidebar built).
    await expect(regionSelect(page)).toHaveValue('region:central_oregon');
  });

  test('an unknown region value falls back to the default region (policy rule 2)', async ({ page }) => {
    await gotoApp(page, '?region=atlantis');

    // Unknown region resolves to DEFAULT_REGION (washington_state), never
    // a blank map, and no phantom region button is invented.
    await expect(regionSelect(page)).toHaveValue('region:washington_state');
    await expect(regionButton(page, 'atlantis')).toHaveCount(0);
  });

  test('an unknown layer key is dropped and never enters the URL (policy rule 2)', async ({ page }) => {
    await gotoApp(page, '?layers=usdm,notalayer');

    // The known layer activates; the unknown key has no control (toggles
    // are built only from LAYER_DEFS).
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'notalayer')).toHaveCount(0);

    // Write half: after the canonical rewrite, usdm is in the URL and the
    // unknown key has been dropped (it never reaches the active set).
    await waitForLayerSettled(page, 'usdm');
    await expect
      .poll(async () => (await urlLayers(page)).has('usdm'), { timeout: 25_000 })
      .toBe(true);
    await expect
      .poll(async () => (await urlLayers(page)).has('notalayer'), { timeout: 25_000 })
      .toBe(false);
  });

  test('embed=1 is accepted as an alias for embed=true (policy rule 7)', async ({ page }) => {
    // url-state.spec.ts covers embed=true; the numeric alias is the
    // tolerant-reading case the policy commits to.
    await gotoApp(page, '?embed=1');
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    expect(await search(page)).toContain('embed=true'); // canonical write-back
  });

  test('embed is disabled for a non-truthy value and when absent (registry embed row)', async ({ page }) => {
    // The registry says embed is enabled only for `true` or `1`; any other
    // value (and absence) reads as disabled. `?embed=false` must NOT enter
    // embed mode.
    await gotoApp(page, '?embed=false');
    await expect(page.locator('#app')).not.toHaveClass(/\bembed\b/);
    expect(await search(page)).not.toContain('embed=');
  });

  test('whitespace around layer keys is tolerated and canonicalized away (policy rule 7)', async ({ page }) => {
    // `?layers=usdm, tribal` (a comma-plus-space a human might type).
    await gotoApp(page, '?layers=usdm%2C%20tribal');

    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'tribal')).toBeChecked();

    // Write half: the canonical rewrite carries no whitespace (the comma
    // percent-encodes to %2C; a literal space would be %20).
    await waitForLayerSettled(page, 'usdm');
    await expect
      .poll(async () => (await search(page)).includes('%20'), { timeout: 25_000 })
      .toBe(false);
  });

  test('layer list order carries no meaning, and no state hides in the fragment (policy rules 6, 9)', async ({ page }) => {
    // Same set, listed in a non-default order; all three resolve.
    await gotoApp(page, '?layers=telemetry,tribal,usdm');

    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'tribal')).toBeChecked();
    await expect(layerCheckbox(page, 'telemetry')).toBeChecked();

    // Rule 9: state lives in the query string, never the fragment.
    expect(await page.evaluate(() => window.location.hash)).toBe('');
  });

  test('an explicit empty layer list means all layers off and round-trips as empty (policy registry)', async ({ page }) => {
    // `?layers=` is the distinct all-off signal (a missing parameter would
    // instead yield the default-on set); it must round-trip as empty.
    await gotoApp(page, '?layers=');

    for (const key of DEFAULT_ON) {
      await expect(layerCheckbox(page, key)).not.toBeChecked();
    }

    // Write half: syncUrl re-emits an explicit empty `layers=` (not a
    // missing parameter), which is what preserves all-off across a reload.
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('layers'), { timeout: 25_000 })
      .toBe('');
  });

  test('L1: a legacy multi-surface link keeps the first surface and drops the rest from the URL (retired-form table)', async ({ page }) => {
    // The project's first retired form: `layers` naming more than one
    // condition surface, from before surfaces became mutually exclusive.
    // The forward map keeps the first surface (usdm) and drops the later
    // one (heatrisk); non-surface layers (tribal) are unaffected.
    await gotoApp(page, '?layers=usdm,heatrisk,tribal');

    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();
    await expect(layerCheckbox(page, 'tribal')).toBeChecked();

    // Canonicalize-on-write angle (distinct from ux1-surfaces.spec.ts,
    // which asserts checkbox state only): the dropped surface must not
    // survive in the rewritten URL, while the kept surface does.
    await waitForLayerSettled(page, 'usdm');
    await expect
      .poll(async () => (await urlLayers(page)).has('usdm'), { timeout: 25_000 })
      .toBe(true);
    await expect
      .poll(async () => (await urlLayers(page)).has('heatrisk'), { timeout: 25_000 })
      .toBe(false);
  });

  test('a malformed select parameter is ignored, never fatal (policy rule 2 / registry select row)', async ({ page }) => {
    // `select` is a one-shot deep-link command; a malformed value parses
    // to null and is skipped, and the app boots normally.
    await gotoApp(page, '?select=garbage');
    await expect(regionSelect(page)).toHaveValue('region:washington_state');
  });

  test('the one-shot select parameter is not re-emitted into the URL (policy rule 8)', async ({ page }) => {
    // A valid deep link is applied once at boot and must never persist in
    // the URL (the link must not keep claiming a briefing the user closed).
    // Settling a default-on layer guarantees several syncUrl writes have
    // run; select must be gone from the URL afterward. This is a
    // client-side guarantee, independent of the deep-link fetch outcome.
    // The usdm-in-URL assertion relies on usdm.activate() reporting an
    // error status rather than throwing (the ratified stay-on contract),
    // so the layer stays registered and in the URL even on a bad-network
    // day. Both polls carry the doctrine's 25s ceiling.
    await gotoApp(page, '?select=state:WA');
    await waitForLayerSettled(page, 'nadm-drought');
    await expect
      .poll(async () => (await search(page)).includes('select='), { timeout: 25_000 })
      .toBe(false);
    await expect
      .poll(async () => (await urlLayers(page)).has('nadm-drought'), { timeout: 25_000 })
      .toBe(true);
  });
});
