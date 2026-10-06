import { continueLocalRoute } from './offline-test';
import { test, expect } from './offline-test';
import type { Page } from './offline-test';
import { URLS } from '../src/config/urls';
import { gotoApp } from './helpers';

/**
 * A minimal NWS point-heat stub, the same fixture shape
 * `tests/impact-panel-a11y.spec.ts` uses for the M19 disclosure-state
 * cases (kept local rather than shared across spec files): answers the
 * Worker-wrapped NWS proxy route with a fixed office/grid and three
 * populated grid metrics, so the print test below has real, deterministic
 * `.point-heat-series` disclosures (M19: closed by default) beside the
 * always-present Technical information one, with no live network.
 */
const NWS_PROXY_ROUTE_PRINT = new RegExp(
  `^${URLS.workerProxy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/proxy\\?url=${encodeURIComponent(
    `${URLS.nwsApi}/`
  )}`
);

function nwsPrintUpstreamUrl(requestUrl: string): string {
  const request = new URL(requestUrl);
  const worker = new URL(URLS.workerProxy);
  const upstream = request.searchParams.get('url');
  if (
    request.origin !== worker.origin ||
    request.pathname !== '/proxy' ||
    upstream === null ||
    !upstream.startsWith(`${URLS.nwsApi}/`)
  ) {
    throw new Error(`Expected a Worker-wrapped NWS URL, received ${requestUrl}`);
  }
  return upstream;
}

async function stubGridGuidance(page: Page): Promise<void> {
  await page.route(NWS_PROXY_ROUTE_PRINT, (route) => {
    const url = new URL(nwsPrintUpstreamUrl(route.request().url()));
    let body: unknown;
    if (url.pathname.startsWith('/points/')) {
      body = {
        properties: {
          forecastGridData: 'https://api.weather.gov/gridpoints/TOP/31,80',
          observationStations:
            'https://api.weather.gov/gridpoints/TOP/31,80/stations',
          forecast: 'https://api.weather.gov/gridpoints/TOP/31,80/forecast',
          cwa: 'TOP',
          gridId: 'TOP'
        }
      };
    } else if (url.pathname === '/gridpoints/TOP/31,80/stations') {
      body = { type: 'FeatureCollection', features: [] };
    } else if (url.pathname === '/gridpoints/TOP/31,80/forecast') {
      body = {
        properties: { updateTime: '2026-07-29T11:00:00+00:00', periods: [] }
      };
    } else if (url.pathname === '/gridpoints/TOP/31,80') {
      body = {
        properties: {
          updateTime: '2026-07-29T10:00:00+00:00',
          temperature: {
            uom: 'wmoUnit:degC',
            values: [{ validTime: '2026-07-29T00:00:00+00:00/P2D', value: 31 }]
          },
          apparentTemperature: {
            uom: 'wmoUnit:degC',
            values: [
              { validTime: '2026-07-30T12:00:00+00:00/PT3H', value: 34 }
            ]
          },
          heatIndex: {
            uom: 'wmoUnit:degC',
            values: [
              { validTime: '2026-07-30T12:00:00+00:00/PT3H', value: 36 }
            ]
          }
        }
      };
    } else if (url.pathname === '/alerts/active') {
      body = { type: 'FeatureCollection', features: [] };
    } else {
      return route.abort();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(body)
    });
  });
}

/**
 * The report in print (U1, D-0.7.0-017): with a briefing open, printing
 * prints THE REPORT (the panel as a static document) and none of the
 * interactive chrome; with no briefing open, printing is untouched
 * browser default. Asserted by emulating print media, not by generating
 * a PDF: the display rules ARE the contract, and they are what a
 * council-packet print-to-PDF consumes.
 */
test.describe('U1 the report in print', () => {
  test('with a briefing open, print media shows the report and hides the chrome', async ({
    page
  }) => {
    // The briefing is opened by the select= deep link: since S2
    // (D-0.7.0-041) a bare boot never opens one unsolicited, and the
    // deep link is the boot-time explicit opener.
    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    await page.emulateMedia({ media: 'print' });

    // The app shell never prints while a report is open; the report does.
    await expect(page.locator('#app')).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-close')).toBeHidden();

    // Back on screen media the app returns; nothing was destroyed.
    await page.emulateMedia({ media: 'screen' });
    await expect(page.locator('#app')).toBeVisible();
    await expect(panel).toBeVisible();
  });

  test('with no briefing open, print media leaves the app alone', async ({ page }) => {
    // No boot auto-opens a briefing since S2 (D-0.7.0-041); a console
    // boot is the sharpest case (it never did).
    await gotoApp(page, '?region=washington_state&layers=usdm');
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#app')).toBeVisible();
  });

  test('Print calls window.print once and every briefing disclosure prints open with dark ink', async ({
    page
  }) => {
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubGridGuidance(page);
    // Stub window.print with a counter: the real print flow needs OS
    // integration this harness does not have, so beforeprint/afterprint
    // are dispatched by hand below, exactly as a native Print would.
    await page.addInitScript(() => {
      (window as unknown as { __ddmPrintCalls: number }).__ddmPrintCalls = 0;
      window.print = () => {
        (window as unknown as { __ddmPrintCalls: number }).__ddmPrintCalls += 1;
      };
    });
    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const series = panel.locator('.point-heat-series');
    await expect(series.first()).toBeVisible();

    // The reader opens one disclosure by hand before printing; the print
    // pass must leave it exactly as they left it (open), and must never
    // toggle it closed on afterprint since it was never one of print's
    // own opens.
    const heatIndexSeries = panel.locator('.point-heat-series', { hasText: 'Heat index' });
    await heatIndexSeries.locator('summary').click();
    await expect(heatIndexSeries).toHaveAttribute('open', '');
    // Read `closedBefore` only once the briefing has settled: the F3
    // resource-catalog rehydrate (`rehydrateResourcesFromCatalog` in
    // src/ui/impact-panel-runtime.ts) lands asynchronously and calls
    // `refreshOpenBriefing` again on its own schedule; waiting for its known
    // WA fixture row (a fresh DOM read, not a sleep) proves that refresh has
    // already landed, so none is still pending to race the print pass below.
    await expect(
      panel.getByRole('link', { name: 'Agricultural drought relief information' })
    ).toBeVisible();
    const closedBefore = await panel.locator('details:not([open])').count();
    expect(closedBefore).toBeGreaterThan(0);

    await panel.locator('.impact-panel-action-print').click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __ddmPrintCalls: number }).__ddmPrintCalls
        )
      )
      .toBe(1);

    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });

    await expect(panel.locator('details:not([open])')).toHaveCount(0);
    await expect(heatIndexSeries.locator('summary')).toHaveCSS('color', 'rgb(0, 0, 0)');

    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });

    // The reader's own open disclosure is untouched; every disclosure
    // print opened is back to exactly its pre-print closed state.
    await expect(heatIndexSeries).toHaveAttribute('open', '');
    const closedAfter = await panel.locator('details:not([open])').count();
    expect(closedAfter).toBe(closedBefore);

    // window.print() was called exactly once across the whole press.
    expect(
      await page.evaluate(
        () => (window as unknown as { __ddmPrintCalls: number }).__ddmPrintCalls
      )
    ).toBe(1);
  });

  test('a briefing refresh between beforeprint and afterprint keeps every disclosure open for print and still restores the reader\'s own state after', async ({
    page
  }) => {
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubGridGuidance(page);
    await page.addInitScript(() => {
      (window as unknown as { __ddmPrintCalls: number }).__ddmPrintCalls = 0;
      window.print = () => {
        (window as unknown as { __ddmPrintCalls: number }).__ddmPrintCalls += 1;
      };
    });

    // Hold the F3 resource-catalog rehydrate request so its landing (and the
    // `refreshOpenBriefing` call inside `rehydrateResourcesFromCatalog`,
    // src/ui/impact-panel-runtime.ts) happens exactly when this test
    // releases it, deterministically between beforeprint and afterprint,
    // rather than racing the print pass: `tests/impact-panel-a11y.spec.ts`
    // holds this same request the same way for its own "survives a briefing
    // refresh" case, and that call is the one landing that both
    // `loadFederalResources` and `resourcesForIdentity` await before calling
    // `refreshOpenBriefing`.
    let releaseResources: () => void = () => {};
    const resourcesHeld = new Promise<void>((resolve) => {
      releaseResources = resolve;
    });
    await page.route(/\/data\/resources\//, async (route) => {
      await resourcesHeld;
      await continueLocalRoute(route);
    });

    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const series = panel.locator('.point-heat-series');
    await expect(series.first()).toBeVisible();

    // The reader opens one disclosure by hand before printing.
    const heatIndexSeries = panel.locator('.point-heat-series', { hasText: 'Heat index' });
    await heatIndexSeries.locator('summary').click();
    await expect(heatIndexSeries).toHaveAttribute('open', '');
    const closedBefore = await panel.locator('details:not([open])').count();
    expect(closedBefore).toBeGreaterThan(0);

    await panel.locator('.impact-panel-action-print').click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __ddmPrintCalls: number }).__ddmPrintCalls
        )
      )
      .toBe(1);

    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    await expect(panel.locator('details:not([open])')).toHaveCount(0);

    // Release the held resource-catalog request now that print has started:
    // its landing replaces the whole briefing body mid-print.
    releaseResources();
    // A fresh DOM read, not a sleep: this known WA fixture row appears only
    // once the resource-catalog refresh has actually landed and re-rendered.
    await expect(
      panel.getByRole('link', { name: 'Agricultural drought relief information' })
    ).toBeVisible();

    // The refresh replaced every disclosure node; every one of them must
    // still be open for print, including the ones it just re-rendered.
    await expect(panel.locator('details:not([open])')).toHaveCount(0);

    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });

    // The reader's own open disclosure survives the mid-print refresh and
    // afterprint untouched; every disclosure print force-opened, including
    // the ones the refresh re-rendered after beforeprint, is back closed.
    await expect(heatIndexSeries).toHaveAttribute('open', '');
    const closedAfter = await panel.locator('details:not([open])').count();
    expect(closedAfter).toBe(closedBefore);
  });
});
