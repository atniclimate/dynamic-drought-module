import { expect, test, type Route } from './offline-test';

import { gotoApp } from './helpers';

/**
 * DDM-P1-T09 step 2 parts b and d (S30D C4 M4): `gotoApp`'s own boot-idle
 * diagnostic, and the deterministic NADM fixture every routine boot now
 * claims unconditionally.
 *
 * Neither case belongs in `helpers.ts` itself (that file is the thing under
 * test), and neither is a pure-lane case: both drive a real boot through
 * `gotoApp`, so this file requests the `page` fixture and runs in the
 * default `chromium` project like any other browser spec.
 */

/**
 * A sentinel NADM body distinguishable from `TEST_NADM_SNAPSHOT`
 * (`tests/helpers.ts`) by its consensus month alone: 1990-01, a month no
 * fixture or product code would ever author on purpose.
 */
const SENTINEL_NADM_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { DROUGHTCAT: 'd1', YEAR_MONTH: '199001' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-140, 20], [-50, 20], [-50, 75], [-140, 75], [-140, 20]]]
      }
    }
  ]
} as const;

function yearMonthOf(body: unknown): string | undefined {
  const collection = body as { features?: Array<{ properties?: { YEAR_MONTH?: string } }> };
  return collection.features?.[0]?.properties?.YEAR_MONTH;
}

test.describe('gotoApp boot-idle diagnostic and the deterministic NADM fixture', () => {
  test("gotoApp's boot-idle failure names the pending layer keys and each pending shared transport key", async ({
    page
  }) => {
    // The shared 'us-states-geojson' transport never settles, so the
    // boot-idle seam can never see the 'states' layer, or the transport
    // it is waiting on, leave the pending set. No `route.fulfill` and no
    // `route.abort` ever runs; the request simply hangs for the test's
    // whole life, which is the point.
    await page.route('**/data/us-states.geojson', () => new Promise<void>(() => undefined));

    let thrown: unknown;
    try {
      await gotoApp(page, '?view=console&layers=states');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Both readings come from the same `window.__ddm` snapshot: the pending
    // layer key ("states") and the pending shared-transport key
    // ("us-states-geojson") with its in-flight count (1).
    expect(message).toMatch(/"states"/);
    expect(message).toMatch(/us-states-geojson\D{0,4}1/);
  });

  test('a routine gotoApp boot with layers= or cluster= answers NADM from the deterministic fixture, and an opted-out boot reaches the NADM route unstubbed', async ({
    page
  }) => {
    // A CONTEXT-level backstop registered BEFORE any `gotoApp` call, exactly
    // like a spec that wants a custom NADM body would register its own. It
    // never wins while `gotoApp`'s own fixture is active (a context route
    // registered later is checked first), but it is exactly what answers
    // once the opt-out below stops `gotoApp` from installing its own.
    let sentinelFulfillments = 0;
    await page.context().route('**/NADM-current.geojson', (route: Route) => {
      sentinelFulfillments += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(SENTINEL_NADM_FC)
      });
    });

    const bodies: unknown[] = [];
    page.on('requestfinished', (request) => {
      if (!request.url().includes('NADM-current.geojson')) return;
      void request
        .response()
        .then((response) => response?.json())
        .then((body) => {
          if (body !== undefined) bodies.push(body);
        })
        .catch(() => undefined);
    });

    // Routine boot: a query naming `layers=` used to skip gotoApp's default
    // stub entirely (helpers.ts:270-272 before this change); it must now
    // claim the deterministic fixture just the same as a bare boot would.
    await gotoApp(page, '?view=console&layers=nadm-drought');
    await expect.poll(() => bodies.length, {
      message: 'no NADM-current.geojson response was recorded for the routine boot'
    }).toBeGreaterThanOrEqual(1);
    expect(yearMonthOf(bodies[0])).toBe('202606');
    expect(sentinelFulfillments).toBe(0);

    // The explicit opt-out: this switches the EXISTING context route (the
    // one the routine boot above already registered) to 'live' mode, whose
    // handler now calls `route.fallback()` (helpers.ts near :59-66), so the
    // context backstop registered above (the stand-in for a spec's own
    // handler, or the live agency) is what answers.
    await gotoApp(page, '?view=console&layers=nadm-drought&region=british_columbia', {
      nadm: 'live'
    });
    await expect.poll(() => bodies.length, {
      message: 'no NADM-current.geojson response was recorded for the opted-out boot'
    }).toBeGreaterThanOrEqual(2);
    expect(yearMonthOf(bodies[1])).toBe('199001');
    expect(sentinelFulfillments).toBeGreaterThanOrEqual(1);
  });
});
