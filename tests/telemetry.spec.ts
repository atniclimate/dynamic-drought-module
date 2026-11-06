import { test, expect } from './offline-test';
import { gotoApp, layerCheckbox, stationValues, PILL } from './helpers';

/**
 * Telemetry honesty backbone (T1 through T3 and the 0.2.1 Tier A
 * pass). The manual ddm-ui-verifier lane asserts the exact live values
 * ("Forebay 75.4 ft"); those are flaky against live upstreams and do not
 * belong in an every-push gate. What IS deterministic, and what this suite
 * guards, is the honest-status contract:
 *
 *   - Every wired station row reaches a TERMINAL state. It never hangs on
 *     `loading...`, because every fetcher carries a timeout that resolves to
 *     a value or to the honest "values unavailable" fallback.
 *   - The one link-only station (Puget Sound Vital Signs) keeps an empty
 *     slot: nothing was attempted, so nothing is claimed.
 *
 * A row stuck on `loading...` after a generous budget is itself the finding
 * this spec exists to catch (a fetcher with no timeout, or a hung promise).
 */
test.describe('telemetry status honesty', () => {
  test('no wired station row is stuck on loading; the link-only station stays empty', async ({
    page
  }) => {
    // The station layer left the default-on set (H4), so name it: value
    // hydration starts on the first telemetry activation, and since DR-008a
    // the featured-station list itself is built on that activation (or on
    // the Water & Snow reveal) rather than at boot. Before 2026-09-03 this
    // spec booted without the layer and passed against an unhydrated list.
    await gotoApp(page, '?layers=telemetry');
    await expect
      .poll(() => page.locator('.telemetry-item').count(), {
        message: 'the featured-station list never arrived after activation'
      })
      .toBeGreaterThan(0);
    // And that hydration has actually begun: at least one wired slot has
    // left its empty initial state, so the "nothing loading" poll below
    // cannot pass on a list that no fetcher ever touched.
    await expect
      .poll(
        () =>
          page.$$eval('.telemetry-values', (slots) =>
            slots.some((s) => (s.textContent ?? '').trim().length > 0)
          ),
        { message: 'no station slot ever left its empty state after activation' }
      )
      .toBe(true);

    // Wait until no row is still loading. The longest fetch budget in play is the CWMS
    // discovery path (src/util/cwms.ts): up to three sequential fetches at a
    // 12-second budget each (~36 seconds worst case), taken by the Bonneville
    // Dam station in production. Give the slowest fetcher room to resolve or
    // to fall back to its honest failure text.
    await expect
      .poll(
        async () => {
          return page.$$eval(
            '.telemetry-values',
            (slots, loading) => slots.every((s) => s.textContent?.trim() !== loading),
            PILL.loading
          );
        },
        {
          message: 'a telemetry row was still on "loading..." past the fetch budget',
          timeout: 45_000
        }
      )
      .toBe(true);

    // The link-only station (no wired source) keeps an empty value slot: it is
    // an indicator program, not a station, so nothing is fetched or claimed.
    await expect(stationValues(page, 'ps_vital_signs')).toBeEmpty();

    // The skeleton-shimmer (0.4.0 A4) is a loading-only affordance: it rides
    // the sidebar value slot while the network fetch is in flight and every
    // terminal branch reassigns className without it. Once nothing is loading,
    // no slot may still carry the shimmer. This guards the auto-clear contract
    // (a shimmer stuck on a settled row would misread as perpetual loading).
    await expect(page.locator('.telemetry-values.skeleton-shimmer')).toHaveCount(0);
  });

  // Audit round 2 (R2-6): a layer-off during the value reads aborted them and
  // left every unresolved row shimmering "loading..." for good.
  test('turning telemetry off while values load empties the rows still loading', async ({ page }) => {
    await page.route('**/cwms-data.usace.army.mil/**', () => {}); // held: never answers
    await gotoApp(page, '?region=washington_state&view=console&layers=telemetry');
    await expect(stationValues(page, 'ihr')).toHaveText(PILL.loading);
    await layerCheckbox(page, 'telemetry').uncheck();
    await expect(page.locator('.telemetry-values.loading')).toHaveCount(0);
    await expect(page.locator('.telemetry-values.skeleton-shimmer')).toHaveCount(0);
    await expect(stationValues(page, 'ihr')).toBeEmpty();
  });

  // Audit round 2 (R2-7): a read that answered with no recent value says the
  // station popup's state word, not the failed-read "values unavailable".
  test('a station whose read answers with no recent value reads no data, and a failed read stays values unavailable', async ({ page }) => {
    // Ice Harbor answers an empty series and an empty catalog (src/util/cwms.ts
    // returns null); Bonneville's read fails outright.
    await page.route('**/cwms-data.usace.army.mil/**', (route) => {
      const url = route.request().url();
      if (url.includes('BON.')) return route.fulfill({ status: 500, contentType: 'text/plain', body: 'Synthetic outage' });
      const body = url.includes('/catalog/') ? { entries: [] } : { units: 'ft', values: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await gotoApp(page, '?region=washington_state&view=console&layers=telemetry');
    await expect(stationValues(page, 'ihr')).toHaveText('no data');
    await expect(stationValues(page, 'ihr')).toHaveClass(/\bunavailable\b/);
    await expect(stationValues(page, 'bono3')).toHaveText('values unavailable');
  });
});
