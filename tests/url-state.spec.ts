import { test, expect } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  regionSelect,
  urlLayers,
  search,
  waitForLayerSettled,
  DEFAULT_ON,
  PILL
} from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  syntheticAiannhBody,
  syntheticBiaBody
} from './tribal-fixtures';

/**
 * URL-as-state (CLAUDE.md section 6 invariant 2): region selection, layer
 * toggles, and the embed flag round-trip through `window.location.search`.
 * A shared or embedded link must restore the view it encodes, and every
 * toggle must be reflected back into the URL.
 *
 * The layer driven for the round trip is `places` (City & Town Labels), a
 * bundled artifact that loads same-origin and fast, so its activation
 * resolves without depending on any live agency endpoint.
 */
test.describe('URL as state', () => {
  test('a bare boot never publishes an empty or partial layers value while the live defaults load (boot layer intent)', async ({ page }) => {
    // Hold both live Tribal-geography responses open so the boot layer
    // set cannot settle, then prove every boot-window URL write carries the
    // FULL default set (the parsed boot intent), never `layers=` and never
    // a completion-order partial set: a reload or share during boot must
    // reproduce the default view (URL policy rules 5 and 7; bootLayerIntent
    // in src/ui/sidebar.ts). Synthetic fixtures only; no real polygon
    // touches the repo.
    const releases: Array<() => void> = [];
    const hold = async (pattern: string, body: unknown): Promise<void> => {
      const gate = new Promise<void>((resolve) => releases.push(resolve));
      await page.route(pattern, async (route) => {
        await gate;
        await route.fulfill({
          contentType: 'application/geo+json',
          body: JSON.stringify(body)
        });
      });
    };
    await hold(AIANNH_ROUTE, syntheticAiannhBody());
    await hold(BIA_ROUTE, syntheticBiaBody());

    await gotoApp(page);

    const isFullDefaultSet = async (): Promise<boolean> => {
      const layers = await urlLayers(page);
      return (
        layers.size === DEFAULT_ON.length &&
        (DEFAULT_ON as readonly string[]).every((key) => layers.has(key))
      );
    };

    // The first canonical write lands promptly and already carries the full
    // default set (the boot intent), while the live responses are held.
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('layers') !== null, {
        timeout: 15_000
      })
      .toBe(true);
    // Sampled over a real window: it never degrades to empty or partial.
    for (let i = 0; i < 5; i++) {
      expect(await isFullDefaultSet(), 'boot-window layers must stay the full default set').toBe(
        true
      );
      await page.waitForTimeout(200);
    }

    // Release the held responses; the post-settle write keeps the full set
    // (everything activated), nothing less and nothing more.
    for (const release of releases) release();
    await expect.poll(isFullDefaultSet, { timeout: 25_000 }).toBe(true);
  });

  test('a deep link restores the region and the exact layer set', async ({ page }) => {
    await gotoApp(page, '?region=central_oregon&layers=usdm,tribal');

    // Region restored.
    await expect(regionSelect(page)).toHaveValue('region:central_oregon');

    // Exactly the named layers are on; an explicit layer list overrides the
    // default-on set, so an unnamed layer (telemetry) is off here.
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await expect(layerCheckbox(page, 'tribal')).toBeChecked();
    await expect(layerCheckbox(page, 'telemetry')).not.toBeChecked();
  });

  test('toggling a layer round-trips through the URL', async ({ page }) => {
    // Console boot (E1 deliverable 1, 2026-07-16): this test drives a
    // catalog checkbox, and Brief mode now hides the catalog behind the
    // console door. Boot mode only; every URL assertion is unchanged.
    await gotoApp(page, '?view=console');

    // Places (City & Town Labels) is off by default and loads a bundled,
    // same-origin artifact, so the round trip does not couple to any live
    // agency endpoint. (The old driver, the `treaty` deployer slot, left
    // the visible catalog with Unit I, D-0.7.0-038 part 3; the placeholder
    // pill honesty it also probed is covered by the legacy ?layers=tribal
    // landing spec in tribal-live-layers.spec.ts.)
    await expect(layerCheckbox(page, 'places')).not.toBeChecked();

    // Toggle a bundled reference layer on: it appears in the URL.
    await layerCheckbox(page, 'places').check();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(true);
    await waitForLayerSettled(page, 'places');
    await expect(layerPill(page, 'places')).toHaveText('live');

    // Toggle it back off: it leaves the URL and its pill clears.
    await layerCheckbox(page, 'places').uncheck();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(false);
    await expect(layerPill(page, 'places')).toBeEmpty();

    // Toggle it on AGAIN: the second activation reuses the cached layer
    // module (CLAUDE.md section 6 invariant 3: subsequent toggles flip a
    // cached source/layer set; the chunk import happened on the first
    // toggle) and must land in the same honest terminal state. This is the
    // cheapest deterministic probe of the lazy-load re-activation path.
    await layerCheckbox(page, 'places').check();
    await expect.poll(async () => (await urlLayers(page)).has('places')).toBe(true);
    await waitForLayerSettled(page, 'places');
    await expect(layerPill(page, 'places')).toHaveText('live');
  });

  test('a layer whose activation fails without throwing never enters the share URL', async ({ page }) => {
    // Regression for docs/ddm-critical-review-2026-07-07.md #2: a non-throwing
    // activate() failure (the module catches its own fetch error, calls
    // reportStatus('error'), and returns) used to resolve normally, so the
    // spine ran registry.activate and the failed key was counted in the pill
    // and written to the share URL, corrupting URL-as-state (invariant 2).
    //
    // Force USDM's FeatureServer query to fail at the network layer. The fetch
    // rejects, usdm.ts's own signal is not aborted, so it takes exactly the
    // reportStatus('error'); return path under test (not the thrown-error path
    // the catch block already handled).
    await page.route('**/USDM_current/**', (route) => route.abort());

    // Start all-off (explicit empty ?layers=) so nothing auto-activates, then
    // drive a single user toggle: the cleanest one-activation reproduction.
    await gotoApp(page, '?layers=');
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();

    await layerCheckbox(page, 'usdm').check();
    await waitForLayerSettled(page, 'usdm');

    // The failed layer reports its honest terminal pill, not a fake "live"...
    await expect(layerPill(page, 'usdm')).toHaveText(PILL.unavailable);
    // ...and is scrubbed from the two places the bug corrupted: the checkbox
    // reverts to unchecked, and the key never lands in the share URL.
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect.poll(async () => (await urlLayers(page)).has('usdm')).toBe(false);
  });

  test('expanding the sidebar in embed mode deliberately exits embed', async ({ page }) => {
    await gotoApp(page, '?embed=true');
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);

    // In embed mode the sidebar is hidden and the floating expand button is
    // the escape hatch back to the full chrome (CLAUDE.md section 4 rule 8:
    // collapse/expand and the embed contract are first-class).
    const expand = page.locator('#sidebar-expand');
    await expect(expand).toBeVisible();
    await expand.click();

    // Expanding always exits embed mode (src/ui/sidebar.ts): the embed class
    // clears and the flag leaves the URL so a refresh holds the full view.
    await expect(page.locator('#app')).not.toHaveClass(/\bembed\b/);
    await expect(page.locator('#app')).not.toHaveClass(/\bsidebar-collapsed\b/);
    await expect.poll(async () => (await search(page)).includes('embed=true')).toBe(false);
  });

  test('embed mode sets the embed class and preserves the flag across syncUrl', async ({ page }) => {
    await gotoApp(page, '?embed=true');

    // The embed flag drives the app-shell class the embed CSS keys off.
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    expect(await search(page)).toContain('embed=true');

    // Boot fires syncUrl repeatedly (the region fit, then each default-on
    // layer as it activates). The embed flag must survive every one of those
    // rewrites (CLAUDE.md section 6 invariant 2: embed preservation is
    // mandatory). The settle signal is the layer key ENTERING the URL: that
    // write only happens after the activation's registry change fires
    // syncUrl, so several rewrites are guaranteed to have run by then.
    // (Mechanism note, U1: this used to settle on the catalog status pill,
    // but a bare ?embed=true boots the BRIEF door since D-ARCH-002, and a
    // brief embed never mounts the catalog island at all (headroom C1), so
    // no pill DOM exists here. The assertions are unchanged.)
    await expect
      .poll(async () => (await urlLayers(page)).has('nadm-drought'), { timeout: 25_000 })
      .toBe(true);
    expect(await search(page)).toContain('embed=true');
  });
});
