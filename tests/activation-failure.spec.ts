import { expect, test, type Page } from '@playwright/test';

import { gotoApp, layerCheckbox, layerPill, urlLayers, waitForLayerSettled, PILL } from './helpers';

/**
 * DDM-P1-T03 (`docs/ROADMAP.yaml:180`): "A thrown and a non-thrown activation
 * failure both leave the checkbox and URL self-corrected and the unavailable
 * state visible and announced once."
 *
 * Before this task the two failure tails in `activateWithIndicator`
 * (`src/state/layer-controller.ts`) ran the same four steps in a DIFFERENT
 * order. The non-thrown branch cleared the checkbox and intent, called
 * `registry.deactivate` (which clears the key's stored status as a side
 * effect, `src/state/registry.ts`), and only THEN re-asserted `'error'`. The
 * thrown branch asserted `'error'` FIRST and called `registry.deactivate`
 * LAST, so its `'error'` was wiped and never re-asserted: a later
 * `registry.getStatus()` read `undefined` (off), not `'error'`
 * (unavailable). Both branches now call one shared `failActivation` helper,
 * in the non-thrown branch's order, so the two paths cannot diverge again.
 *
 * `tests/url-state.spec.ts` ("a layer whose activation fails without
 * throwing never enters the share URL") already proves the checkbox, pill
 * and URL clauses for the non-thrown path; this file re-proves those three
 * clauses for BOTH paths side by side and adds the "announced once" clause,
 * which no existing spec checks.
 *
 * The live region is `#layer-status-live` (`src/ui/sidebar.ts`); a
 * `MutationObserver` installed before the toggle records every write to it,
 * so "announced" counts actual `status-change` events carrying the word the
 * app uses for `'error'` (`PILL.unavailable`, `src/ui/island/pill-text.ts`),
 * not just the final DOM text a single read would show. Both tests below
 * assert EXACTLY one announcement: `failActivation`
 * (`src/state/layer-controller.ts`) now reads `registry.getStatus(key)`
 * before deactivating, and when a module already self-reported `'error'`
 * (the non-thrown path; for example usdm.ts:794 `reportStatus('error');
 * return`) it calls `registry.deactivate(key, { keepStatus: true })` and
 * does NOT call `setStatus` again, instead of unconditionally re-asserting
 * `'error'` after `registry.deactivate` wiped it and double-announcing
 * (DDM-P1-T03 correction, 2026-09-08).
 */

/** Start recording every write to the polite live region's text. */
async function watchAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('layer-status-live');
    const w = window as unknown as { __ddmAnnouncements?: string[] };
    w.__ddmAnnouncements = [];
    if (!el) return;
    const observer = new MutationObserver(() => {
      w.__ddmAnnouncements!.push(el.textContent ?? '');
    });
    observer.observe(el, { childList: true, characterData: true, subtree: true });
  });
}

/** Every live-region write recorded since the matching `watchAnnouncements` call. */
async function recordedAnnouncements(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __ddmAnnouncements?: string[] }).__ddmAnnouncements ?? []
  );
}

test.describe('DDM-P1-T03: activation failure, thrown and non-thrown, self-correct identically', () => {
  test('a thrown activation failure (a layer chunk that fails to import) self-corrects and announces "unavailable" once', async ({
    page
  }) => {
    // Ecoregions is off by default and, on first toggle, fetches nothing but
    // its own chunk, so aborting that chunk request throws before the
    // module is ever obtained: `loadLayerModule` (src/config/layers.ts)
    // rejects, and `activateWithIndicator`'s `catch (err)` branch runs with
    // `mod` never assigned -- the genuinely thrown path.
    await page.route(/ecoregions-[^/]*\.js(\?.*)?$/, (route) => route.abort());
    await gotoApp(page, '?layers=');
    await watchAnnouncements(page);

    // `.click()`, not `.check()`: the aborted chunk import (a single hop,
    // no module ever loaded to make a second request from) can fail and
    // self-correct fast enough that `.check()`'s own post-click "did it
    // become checked" verification sometimes samples after the checkbox
    // has already been unchecked again by failActivation, reporting
    // "Clicking the checkbox did not change its state" for behavior this
    // test means to exercise. `waitForLayerSettled` below is the real
    // synchronization point.
    await layerCheckbox(page, 'ecoregions').click();
    await waitForLayerSettled(page, 'ecoregions');

    await expect(layerCheckbox(page, 'ecoregions')).not.toBeChecked();
    await expect(layerPill(page, 'ecoregions')).toHaveText(PILL.unavailable);
    expect((await urlLayers(page)).has('ecoregions')).toBe(false);

    const seen = await recordedAnnouncements(page);
    expect(seen.filter((text) => text.includes(PILL.unavailable)).length).toBe(1);
  });

  test('a non-thrown activation failure (a module that reports its own error) self-corrects and is announced', async ({
    page
  }) => {
    // USDM's own fetch failure is caught inside usdm.ts's activateUsdm
    // (reportStatus('error'); return), so mod.activate resolves normally:
    // the controller's non-thrown branch
    // (`registry.getStatus(def.key) === 'error'`) runs, never the
    // `catch (err)` branch above. Same regression as tests/url-state.spec.ts's
    // "never enters the share URL" test; this test adds the live-region
    // check that one does not make.
    await page.route('**/USDM_current/**', (route) => route.abort());
    await gotoApp(page, '?layers=');
    await watchAnnouncements(page);

    await layerCheckbox(page, 'usdm').check();
    await waitForLayerSettled(page, 'usdm');

    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(layerPill(page, 'usdm')).toHaveText(PILL.unavailable);
    expect((await urlLayers(page)).has('usdm')).toBe(false);

    // usdm.ts's own `reportStatus('error')` (usdm.ts:794) sets the stored
    // status to 'error' before returning; failActivation
    // (src/state/layer-controller.ts) sees that status already recorded and
    // calls `registry.deactivate(key, { keepStatus: true })` instead of
    // deactivating plain and calling `setStatus` again, so only usdm.ts's
    // own status-change announces "unavailable": exactly once.
    const seen = await recordedAnnouncements(page);
    expect(seen.filter((text) => text.includes(PILL.unavailable)).length).toBe(1);
  });

  // A third shape -- a module that self-reports 'error' and THEN throws
  // (drought.ts:527-529, `reportStatus('error'); throw err;`) -- is not
  // added here: reaching that catch block requires ensureHatchImages,
  // map.addSource, or map.addLayer (drought.ts:477-514) to throw, and none
  // of those depend on a network request a Playwright `page.route` abort
  // can reach; forcing one deterministically would need patching MapLibre
  // internals from the test, which this brief's owned files do not cover.
});
