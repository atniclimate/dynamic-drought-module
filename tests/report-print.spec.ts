import { continueLocalRoute } from './offline-test';
import { test, expect } from './offline-test';
import type { Page } from './offline-test';
import { URLS } from '../src/config/urls';
import { gotoApp } from './helpers';
import { oniLineSvg, ensoPlumeSvg, cpcOutlookBarsSvg, trendLineSvg } from '../src/ui/charts';

test('D3 chart helpers print readable neutral series and preserve issuer colors', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page, '?select=state:WA');
  const panel = page.locator('#impact-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole('link', { name: 'Agricultural drought relief information' })).toBeVisible();
  const phases = [{ seas: 'DJF', year: 2025, anom: -0.7 }, { seas: 'JFM', year: 2025, anom: 0.6 }];
  const charts = [
    oniLineSvg(phases, { title: 'ONI fixture', source: 'Offline fixture', compare: { label: 'RONI', values: phases } }),
    ensoPlumeSvg([{ seas: 'DJF', elNino: 20, neutral: 30, laNina: 50 }, { seas: 'JFM', elNino: 30, neutral: 40, laNina: 30 }],
      { title: 'Plume fixture', source: 'Offline fixture' }),
    cpcOutlookBarsSvg({ variable: 'temperature', cat: 'Above', prob: 70, window: '6-10 day' }),
    trendLineSvg([{ t: 1, v: 10 }, { t: 2, v: 20 }], { title: 'Trend fixture', yMax: 500, yLabel: 'DSCI' })
  ];
  // Real chart helpers in real report CSS, not a source-ingestion claim.
  await panel.evaluate((element, markup) => {
    const specimen = document.createElement('section');
    specimen.id = 'print-chart-specimens';
    specimen.innerHTML = markup.map(svg => `<div class="impact-claim-chart">${svg}</div>`).join('');
    element.append(specimen);
  }, charts);
  const specimen = panel.locator('#print-chart-specimens');
  const invariantColors = [
    ['line[stroke="#ff0000"]', 'stroke', 'rgb(255, 0, 0)'],
    ['line[stroke="#0000ff"]', 'stroke', 'rgb(0, 0, 255)'],
    ['line[stroke="#f59e0b"],polyline[stroke="#f59e0b"]', 'stroke', 'rgb(245, 158, 11)'],
    ['line[stroke="#06b6d4"],polyline[stroke="#06b6d4"]', 'stroke', 'rgb(6, 182, 212)'],
    ['rect[fill="#B32E05"]', 'fill', 'rgb(179, 46, 5)']
  ] as const;
  const assertInvariantColors = async () => {
    for (const [selector, property, expected] of invariantColors) {
      const marks = specimen.locator(selector);
      expect(await marks.count(), selector).toBeGreaterThan(0);
      for (const mark of await marks.all()) await expect(mark).toHaveCSS(property, expected);
    }
  };
  const assertSeries = async (paper: boolean) => {
    for (const [role, screen, print] of [
      ['primary', 'rgb(241, 245, 249)', 'rgb(0, 0, 0)'],
      ['comparison', 'rgb(148, 163, 184)', 'rgb(68, 68, 68)']
    ] as const) {
      const marks = specimen.locator(`[data-index-series="${role}"]`);
      await expect(marks).toHaveCount(3); // legend line, data polyline, last-value dot
      for (const mark of await marks.all()) {
        const property = await mark.evaluate(element => element.tagName.toLowerCase() === 'circle' ? 'fill' : 'stroke');
        await expect(mark).toHaveCSS(property, paper ? print : screen);
      }
      const strokes = specimen.locator(`[data-index-series="${role}"][stroke]`);
      for (const stroke of await strokes.all()) {
        await expect(stroke).toHaveCSS('stroke-dasharray', role === 'primary' ? 'none' : '4px, 2px');
      }
    }
  };
  await assertInvariantColors();
  await assertSeries(false);
  const assertGuideCasings = async (paper: boolean) => {
    const casings = specimen.locator('[data-index-guide-casing]');
    await expect(casings).toHaveCount(2);
    for (const casing of await casings.all()) {
      await expect(casing).toHaveCSS('stroke', paper ? 'rgb(0, 0, 0)' : 'rgb(198, 203, 212)');
      await expect(casing).toHaveCSS('stroke-dasharray', '3px, 3px');
    }
  };
  await assertGuideCasings(false);
  const geometry = () => specimen.locator('[data-index-series],[data-index-guide],[data-index-guide-casing]').evaluateAll(elements =>
    elements.map(element => ['x1', 'x2', 'y1', 'y2', 'points', 'cx', 'cy', 'r'].map(name => element.getAttribute(name))));
  const before = await geometry();
  await page.emulateMedia({ media: 'print' });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('#app')).toBeHidden();
  await assertInvariantColors();
  await assertSeries(true);
  await assertGuideCasings(true);
  expect(await geometry()).toEqual(before);
  // Both chosen neutral inks exceed3:1 against actual white paper; colors
  // differ and the comparison remains dashed independently of color.
  const contrast = await specimen.locator('[data-index-series],[data-index-guide-casing]').evaluateAll(elements => elements.map(element => {
    const rgb = getComputedStyle(element)[element.tagName.toLowerCase() === 'circle' ? 'fill' : 'stroke'].match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const linear = rgb.map(byte => byte / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 1.05 / (linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722 + 0.05);
  }));
  for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(3);
  const words = specimen.locator('svg text');
  expect(await words.count()).toBeGreaterThan(0);
  for (const word of await words.all()) await expect(word).toHaveCSS('fill', 'rgb(0, 0, 0)');
  const grid = specimen.locator('svg [stroke="var(--line)"]');
  expect(await grid.count()).toBeGreaterThan(0);
  for (const line of await grid.all()) await expect(line).toHaveCSS('stroke', 'rgb(153, 153, 153)');
  await page.emulateMedia({ media: 'screen' });
  await assertInvariantColors();
  await assertSeries(false);
  await assertGuideCasings(false);
});

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
  for (const width of [1440, 390]) {
    test(`actual briefing prints on paper without a clipped host at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
      await stubGridGuidance(page);
      await gotoApp(page, '?view=brief&select=state:WA&flow=off');
      if (width === 390) {
        await page.locator('#sheet-report-door').click();
        await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'full');
      }
      const panel = page.locator('#impact-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByRole('link', { name: 'Agricultural drought relief information' })).toBeVisible();
      await expect(panel.locator('.point-heat-card').first()).toBeVisible();
      if (width === 390) await expect(panel).toHaveClass(/sheet-hosted/);

      // This case checks print CSS, including expanded real report content.
      // The separate native-PDF regression owns native event/lifecycle proof.
      await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
      await page.emulateMedia({ media: 'print' });
      await expect(panel.locator('details:not([open])')).toHaveCount(0);
      const surfaces = panel.locator([
        '.impact-land-caveat', '.impact-landscape-card', '.point-heat',
        '.point-heat-card', '.point-heat-synthesis', '.impact-horizon',
        '.impact-hazard-active', '.impact-resource'
      ].join(', '));
      expect(await surfaces.count()).toBeGreaterThan(5);
      for (const surface of await surfaces.all()) {
        await expect(surface).toHaveCSS('background-color', 'rgb(255, 255, 255)');
        await expect(surface).toHaveCSS('color', 'rgb(0, 0, 0)');
      }
      const brand = panel.locator('.impact-print-brand');
      await expect(brand).toBeVisible();
      const hosts = width === 390
        ? ['html', 'body', '#app', '.sidebar', '.sidebar-scroll', '.sheet-report', '.impact-panel-body']
        : ['html', 'body', '.impact-panel-body'];
      for (const selector of hosts) {
        const host = page.locator(selector);
        await expect(host).toHaveCSS('overflow-y', 'visible');
        // The root element's clientHeight is the viewport by definition.
        if (selector !== 'html') {
          expect(await host.evaluate((node) => node.scrollHeight - node.clientHeight), selector).toBeLessThanOrEqual(1);
        }
      }
      if (width === 390) {
        const bounds = await page.evaluate(() => ({
          host: document.querySelector('#app')!.getBoundingClientRect().bottom,
          end: document.querySelector('.impact-print-brand')!.getBoundingClientRect().bottom
        }));
        expect(bounds.end).toBeLessThanOrEqual(bounds.host + 1);
      }
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await page.emulateMedia({ media: 'screen' });
    });
  }

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
