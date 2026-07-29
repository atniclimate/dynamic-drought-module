import { test, expect } from '@playwright/test';
import { gotoApp, stationValues, PILL } from './helpers';

/**
 * Telemetry honesty backbone (T1 through T3 and the 0.2.1 Tier A pass,
 * CHANGES.md). The manual ddm-ui-verifier lane asserts the exact live values
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
    await gotoApp(page);

    // Telemetry is default-on, so value hydration starts at boot. Wait until
    // no row is still loading. The longest fetch budget in play is the CWMS
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
});
