import { expect, test } from './offline-test';
import type { Locator, Page } from './offline-test';

import { URLS } from '../src/config/urls';
import { stubCpcDroughtOutlook } from './cpc-outlook-fixtures';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  showFullDetail,
  stubCpcSeasonalTempOutlook,
  stubHeatRiskCatalog as stubHeatRiskCatalogShared,
  waitForLayerSettled
} from './helpers';
import {
  FORECAST_PAYLOAD,
  GRID_PAYLOAD,
  NEAR_STATION_URL,
  OBSERVATION_PAYLOAD,
  POINT_PAYLOAD,
  nwsUpstreamUrl
} from './point-heat-fixtures';

const NWS_PROXY_ROUTE = new RegExp(
  `^${URLS.workerProxy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/proxy\\?url=${encodeURIComponent(
    `${URLS.nwsApi}/`
  )}`
);

async function stubBrowserNwsHeat(page: Page): Promise<void> {
  await page.route(NWS_PROXY_ROUTE, (route) => {
    const url = new URL(nwsUpstreamUrl(route.request().url()));
    let body: unknown;
    if (url.pathname.startsWith('/points/')) {
      body = POINT_PAYLOAD;
    } else if (url.pathname === '/gridpoints/TOP/31,80/stations') {
      body = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [-120.5, 47.5]
            },
            properties: {
              stationIdentifier: 'KNEAR',
              name: 'Near Station',
              '@id': NEAR_STATION_URL
            }
          }
        ]
      };
    } else if (url.pathname === '/stations/KNEAR/observations/latest') {
      body = OBSERVATION_PAYLOAD;
    } else if (url.pathname === '/gridpoints/TOP/31,80/forecast') {
      body = FORECAST_PAYLOAD;
    } else if (url.pathname === '/gridpoints/TOP/31,80') {
      body = GRID_PAYLOAD;
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

test.describe('H2 critical-first surfaces', () => {
  async function expectReadPill(
    pill: Locator,
    state: 'loading' | 'ready' | 'partial' | 'unavailable' | 'no-data'
  ): Promise<void> {
    const labels = {
      loading: 'loading', ready: 'live', partial: 'live (partial)',
      unavailable: 'unavailable', 'no-data': 'no data'
    };
    const ink = state === 'unavailable' ? 'rgb(255, 255, 255)'
      : state === 'ready' || state === 'partial' ? 'rgb(232, 236, 240)'
      : 'rgb(198, 203, 212)';
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(labels[state]);
    await expect(pill).toHaveCSS('color', ink);
    await expect(pill).toHaveCSS('border-top-color', ink);
    await expect(pill).toHaveCSS('font-style', state === 'no-data' ? 'italic' : 'normal');
    if (state === 'unavailable') await expect(pill).toHaveCSS('font-weight', '700');
    const readGlyph = () => pill.evaluate((node) => {
      const style = getComputedStyle(node, '::before');
      const box = node.getBoundingClientRect();
      const header = node.parentElement!.getBoundingClientRect();
      return {
        content: style.content, width: style.width, height: style.height,
        border: style.borderTopWidth, color: style.borderTopColor,
        background: style.backgroundColor, image: style.backgroundImage,
        size: style.backgroundSize, animation: style.animationName,
        left: box.left - header.left, right: header.right - box.right,
        overflow: node.scrollWidth - node.clientWidth
      };
    });
    // A settling hydration lane re-renders the panel body (refreshOpenBriefing), which can
    // detach the node resolved for this read; a detached node computes every style as "".
    let glyph = await readGlyph();
    await expect.poll(async () => (glyph = await readGlyph())).toMatchObject({ content: '""', width: '8px', height: '8px', border: '1px', color: ink, animation: 'none' });
    expect(glyph.left).toBeGreaterThanOrEqual(-1);
    expect(glyph.right).toBeGreaterThanOrEqual(-1);
    expect(glyph.overflow).toBeLessThanOrEqual(1);
    if (state === 'ready') expect(glyph.background).toBe(ink);
    if (state === 'loading') {
      expect(glyph.background).toBe('rgba(0, 0, 0, 0)');
      expect(glyph.image).toBe('none');
    }
    if (state === 'partial') {
      expect(glyph.image).toMatch(/linear-gradient\((?:to right|90deg),/);
      expect(glyph.image).toContain(`${ink} 50%`);
      expect(glyph.image).toContain('rgba(0, 0, 0, 0) 50%');
    }
    if (state === 'unavailable') {
      expect(glyph.image).toContain('135deg');
      expect(glyph.image).toContain(`${ink} 40%`);
      expect(glyph.image).toContain(`${ink} 60%`);
    }
    if (state === 'no-data') expect(glyph.size).toBe('4px 1px');
  }

  for (const width of [1440, 390]) {
    for (const outcome of ['ready', 'partial', 'no-data', 'unavailable'] as const) {
      test(`D3 actual report read pills ${outcome} at ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
        await stubBrowserNwsHeat(page);
        let release = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        await page.route(NWS_PROXY_ROUTE, async (route) => {
          const url = new URL(nwsUpstreamUrl(route.request().url()));
          if (url.pathname.startsWith('/points/') || url.pathname === '/alerts/active') await held;
          if (outcome === 'unavailable' && url.pathname.startsWith('/points/')) {
            await route.fulfill({ status: 503, body: 'unavailable' });
          } else if (outcome === 'partial' && url.pathname === '/gridpoints/TOP/31,80') {
            await route.fulfill({ status: 503, body: 'unavailable' });
          } else if (outcome === 'no-data' && url.pathname === '/gridpoints/TOP/31,80/stations') {
            await route.fulfill({ json: { type: 'FeatureCollection', features: [] } });
          } else if (outcome === 'no-data' && url.pathname === '/gridpoints/TOP/31,80') {
            await route.fulfill({ json: { properties: { temperature: { uom: 'wmoUnit:degC', values: [] } } } });
          } else {
            await route.fallback();
          }
        });
        try {
          await gotoApp(page, '?select=state:WA');
          const panel = page.locator('#impact-panel');
          const fullDetail = panel.locator('.briefing-view-btn[data-briefing-view="matrix"]');
          // The phone's shared link opens the report in its full-screen window at once (owner, 2026-11-13).
          if (width === 390) await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'full');
          // Every shell opens the briefing on the priority view; Full detail is the explicit step.
          await expect(fullDetail).toHaveAttribute('aria-pressed', 'false');
          await fullDetail.click();
          await expect(fullDetail).toHaveAttribute('aria-pressed', 'true');
          const point = panel.locator('.point-heat[aria-label="Heat at selected point"] > .impact-horizon-head .point-heat-pill');
          const currentHeat = panel.locator('.impact-hazard[data-horizon="current"][data-hazard="heat"] .impact-hazard-pill');
          await expectReadPill(point, 'loading');
          await expectReadPill(currentHeat, 'loading');
          release();
          await expectReadPill(point, outcome);
          await expectReadPill(currentHeat, 'ready');
          await expectReadPill(panel.locator('.impact-hazard[data-horizon="longRange"][data-hazard="fire"] .impact-hazard-pill'), 'unavailable');
          // This horizon has answered seasonal guidance beside the explicitly
          // unavailable PDF-only fire cell: it must stay live (partial).
          await expectReadPill(panel.locator('.impact-horizon').filter({ has: page.locator('.impact-hazard[data-horizon="longRange"]') }).locator(':scope > .impact-horizon-head > .impact-horizon-pill'), 'partial');
          // Reduced motion changes neither the words nor the static glyph.
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await expectReadPill(point, outcome);
        } finally {
          release();
        }
      });
    }
  }

  test('mobile at-hand and full report lead with point heat', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubBrowserNwsHeat(page);
    // Point heat leads the at-hand line in Heat, its own mode; in any other mode that
    // mode's own current claim leads (src/impact/brief-narrative-selector.ts). Before
    // DR-270 this case booted Drought and passed only because no drought read answered.
    await gotoApp(page, '?cluster=heat&select=state:WA');
    // The shared link opens the report full screen (owner, 2026-11-13); the
    // at-hand summary is the Place window's, one Back to map away.
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'full');
    await expect(page.locator('#sheet-report .impact-panel')).toBeVisible();
    await page.locator('#sheet-close').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();

    // R5-27: the station's distance from the selected point sits between its name and its reading.
    await expect(page.locator('.sheet-at-hand-headline')).toBeVisible();
    await expect(page.locator('.sheet-at-hand-headline')).toContainText(
      /Heat at the selected point: Near Station, [\d.]+ mi \([\d.]+ km\) from the selected point, reports temperature 90 °F \(32 °C\), heat index 95 °F \(35 °C\)/
    );
    await page.locator('#sheet-report-door').click();
    // The briefing opens on the priority view; point heat leads the full detail.
    const fullDetail = page.locator('#sheet-report .briefing-view-btn[data-briefing-view="matrix"]');
    await expect(fullDetail).toHaveAttribute('aria-pressed', 'false');
    await fullDetail.click();
    await expect(fullDetail).toHaveAttribute('aria-pressed', 'true');
    // In Heat the priority view carries the same section as its lead detail
    // (DESIGN B6), hidden under Full detail; read the matrix's own copy.
    const pointHeat = page.locator(
      '#sheet-report .impact-horizons .point-heat[aria-label="Heat at selected point"]'
    );
    await expect(pointHeat).toBeVisible();
    await expect(pointHeat.locator('.point-heat-station')).toContainText(
      'Near Station'
    );
    // M19: every NWS grid guidance disclosure starts closed, so the series
    // this case reads from must be opened first (a reader action) rather
    // than assumed to be the panel's own default-open choice.
    const heatIndexSeries = pointHeat.locator('.point-heat-series', {
      hasText: 'Heat index'
    });
    await heatIndexSeries.locator('summary').click();
    await expect(heatIndexSeries).toHaveAttribute('open', '');
    const openInterval = heatIndexSeries.locator('time').first();
    await expect(openInterval).toHaveAttribute(
      'title',
      '2026-07-30T12:00:00+00:00/PT3H'
    );
    await expect(openInterval).toContainText('Jul 30');
    await expect(pointHeat).not.toContainText('wmoUnit');
    await expect(
      page.locator('#sheet-report .impact-capability-unavailable')
    ).toHaveCount(0);
  });

  test('the grid identity line names the NWS office and grid in words', async ({
    page
  }) => {
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubBrowserNwsHeat(page);
    await gotoApp(page, '?select=state:WA');

    const pointHeat = page.locator(
      '#impact-panel .point-heat[aria-label="Heat at selected point"]'
    );
    await showFullDetail(page);
    await expect(pointHeat).toBeVisible();
    const identity = pointHeat.locator(
      '.point-heat-card[aria-label="NWS grid guidance"] .point-heat-meta'
    );
    // found-023: the office and grid are named in words, never joined by a
    // bare slash that a reader could mistake for a time zone ('TOP / TOP');
    // the grid is its cell (the points gridX, gridY), not the office again.
    await expect(identity).toHaveText('NWS office TOP, grid 31,80');
    await expect(identity).not.toHaveText(/^[A-Z]+ \/ [A-Z]+$/);
  });

  test('a station URL carrying userinfo names the station and the heat read as text, never as a link', async ({
    page
  }) => {
    // R1-22: the station URL is agency text; one link rule (src/util/escape.ts
    // checkPopupHref) refuses userinfo where a bare https prefix passed it.
    const userinfoStation = 'https://user:pw@api.weather.gov/stations/KNEAR';
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubBrowserNwsHeat(page);
    await page.route(NWS_PROXY_ROUTE, (route) => {
      if (new URL(nwsUpstreamUrl(route.request().url())).pathname !== '/gridpoints/TOP/31,80/stations') {
        return route.fallback();
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [-120.5, 47.5] },
              properties: { stationIdentifier: 'KNEAR', name: 'Near Station', '@id': userinfoStation }
            }
          ]
        })
      });
    });
    // The latest observation is read from the station URL itself, which the
    // shared NWS route pattern (an api.weather.gov prefix) does not match.
    await page.route(
      (url) => url.searchParams.get('url') === `${userinfoStation}/observations/latest`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(OBSERVATION_PAYLOAD)
        })
    );
    await gotoApp(page, '?select=state:WA');

    const pointHeat = page.locator(
      '#impact-panel .point-heat[aria-label="Heat at selected point"]'
    );
    await expect(pointHeat.locator('.point-heat-station')).toHaveText('Near Station');
    await expect(
      pointHeat.locator('.point-heat-synthesis li strong', {
        hasText: 'NWS point observation and grid guidance'
      })
    ).toHaveCount(1);
    await expect(pointHeat.locator('.point-heat-station a')).toHaveCount(0);
    await expect(page.locator('#impact-panel a[href*="user:pw"]')).toHaveCount(0);
  });

  test('embed report exposes the same point heat model without adding URL state', async ({
    page
  }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubBrowserNwsHeat(page);
    await gotoApp(page, '?embed=true&select=state:WA');

    const pointHeat = page.locator(
      '#impact-panel .point-heat[aria-label="Heat at selected point"]'
    );
    await showFullDetail(page);
    await expect(pointHeat).toBeVisible();
    await expect(
      pointHeat.locator(
        ':scope > .impact-horizon-head .point-heat-pill-ready'
      )
    ).toHaveText('live');
    const search = new URL(page.url()).searchParams;
    expect(search.get('embed')).toBe('true');
    expect([...search.keys()]).not.toContain('heatpoint');
  });

  test('a place change aborts the old point read and keeps the newer briefing current', async ({
    page
  }) => {
    // The observation fixtures are 2026-07-29 12:05 UTC; a later clock reads them as a station that stopped reporting.
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    let pointsRequestCount = 0;
    // A typed holder, not a bare `let`: the assignment happens inside the
    // Promise executor closure below, which TypeScript cannot see from the
    // read sites further down, and would otherwise narrow to `null`.
    const oldPoint: { release: (() => void) | null } = { release: null };
    const oldPointReleased = new Promise<void>((resolve) => {
      oldPoint.release = resolve;
    });
    await page.route(NWS_PROXY_ROUTE, async (route) => {
      const url = new URL(nwsUpstreamUrl(route.request().url()));
      let body: unknown;
      if (url.pathname.startsWith('/points/')) {
        pointsRequestCount += 1;
        const generation = pointsRequestCount === 1 ? 'OLD' : 'NEW';
        if (generation === 'OLD') await oldPointReleased;
        body = {
          properties: {
            forecastGridData:
              `https://api.weather.gov/gridpoints/${generation}/1,1`,
            observationStations:
              `https://api.weather.gov/gridpoints/${generation}/1,1/stations`,
            forecast:
              `https://api.weather.gov/gridpoints/${generation}/1,1/forecast`,
            cwa: generation,
            gridId: generation
          }
        };
      } else if (/\/gridpoints\/(OLD|NEW)\/1,1\/stations$/.test(url.pathname)) {
        const generation = url.pathname.includes('/OLD/') ? 'OLD' : 'NEW';
        body = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [-120.5, 47.5] },
              properties: {
                stationIdentifier: `K${generation}`,
                name: `${generation === 'OLD' ? 'Old' : 'New'} Station`,
                '@id': `https://api.weather.gov/stations/K${generation}`
              }
            }
          ]
        };
      } else if (/\/stations\/K(OLD|NEW)\/observations\/latest$/.test(url.pathname)) {
        const generation = url.pathname.includes('KOLD') ? 'OLD' : 'NEW';
        body = {
          properties: {
            timestamp: '2026-07-29T12:05:00+00:00',
            temperature: {
              unitCode: 'wmoUnit:degC',
              value: generation === 'OLD' ? 10 : 32
            },
            relativeHumidity: {
              unitCode: 'wmoUnit:percent',
              value: 48
            },
            heatIndex: {
              unitCode: 'wmoUnit:degC',
              value: generation === 'OLD' ? 10 : 35
            }
          }
        };
      } else if (/\/gridpoints\/(OLD|NEW)\/1,1\/forecast$/.test(url.pathname)) {
        body = FORECAST_PAYLOAD;
      } else if (/\/gridpoints\/(OLD|NEW)\/1,1$/.test(url.pathname)) {
        body = GRID_PAYLOAD;
      } else if (url.pathname === '/alerts/active') {
        body = { type: 'FeatureCollection', features: [] };
      } else {
        return route.abort();
      }
      try {
        return await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(body)
        });
      } catch {
        return undefined;
      }
    });

    try {
      await gotoApp(page, '?view=brief&select=state:WA');
      await expect(page.locator('#impact-panel')).toBeVisible();
      await page.locator('#impact-panel .impact-panel-close').click();

      const search = page.locator('#brief-search [data-ddm-search]');
      await search.fill('oregon');
      await page
        .locator(
          '#brief-search [data-search-kind="place"][data-search-id="OR"]'
        )
        .click();
      // The pick opens the chosen place's briefing (owner 2026-11-13).
      await expect(page.locator('.point-heat-station')).toContainText(
        'New Station'
      );

      oldPoint.release?.();
      await page.waitForTimeout(100);
      await expect(page.locator('.point-heat-station')).not.toContainText(
        'Old Station'
      );
      await expect(page.locator('#impact-panel-title')).toHaveText('Oregon');
    } finally {
      oldPoint.release?.();
    }
  });

  test('reopening the same briefing reuses completed NWS responses', async ({
    page
  }) => {
    let requestCount = 0;
    page.on('request', (request) => {
      if (NWS_PROXY_ROUTE.test(request.url())) {
        requestCount += 1;
      }
    });
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00'); // the observation fixture's own hour
    await stubBrowserNwsHeat(page);
    await gotoApp(page, '?region=washington_state&view=console');

    const trigger = page.locator('#region-briefing-btn');
    await trigger.click();
    await expect(page.locator('.point-heat-station')).toContainText(
      'Near Station'
    );
    expect(requestCount).toBe(6);
    await page.locator('#impact-panel .impact-panel-close').click();

    await trigger.click();
    await expect(page.locator('.point-heat-station')).toContainText(
      'Near Station'
    );
    await page.waitForTimeout(100);
    expect(requestCount).toBe(6);
  });
});

test.describe('H2 near-term HeatRisk claim independent of the map layer (DR-014 a)', () => {
  const HEATRISK_PATH = '/experimental/rest/services/NWS_HeatRisk/ImageServer';
  const HEATRISK_ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  // idp_validtime is in ascending order, so index 0 is the catalog's earliest
  // advertised granule ("day 1 of 7 of the catalog") whether or not the map
  // layer ever asks for it. Its value is deliberately null so the same
  // rendered branch (sources.ts fetchHeatRiskClaims, the `identified.value
  // === null` arm) exercises the "for day 1 of 7 of the catalog" / "for the
  // selected frame" wording.
  //
  // These times are FIXED 2026 literals, not built relative to the test
  // clock, and this suite runs with the real system clock (no
  // `page.clock.setFixedTime` in this describe block): every period below
  // has therefore ENDED by the time this runs (DR-070 amended 2026-09-08,
  // DR-071's phase rule, mirrored by heatRiskClaimRegister in
  // src/ui/heatrisk-sequence.ts), so the register assertions below read
  // `observed`, not `outlook`. That is deliberate: it is this fixture's one
  // proof of the ended-period branch. The paired in-force case lives in its
  // own test below, built relative to Date.now() instead of moving this
  // fixture (moving it would also force every `Valid ...` UTC-moment
  // assertion in this describe block onto computed, rather than literal,
  // strings, for no honesty gain over the dedicated case).
  const CATALOG_TIMES = [
    1785240000000,
    1785326400000,
    1785412800000,
    1785499200000,
    1785585600000,
    1785672000000,
    1785758400000
  ] as const;
  const CATALOG_VALUES = [null, 1, 0, 3, 4, 2, 2] as const;

  interface HeatRiskCatalogReceipt {
    /** Every `/identify` request's `time` param, in call order. */
    readonly identifyCalls: number[];
  }

  interface StubHeatRiskCatalogOptions {
    readonly catalogTimes?: readonly number[];
    readonly catalogValues?: readonly (number | null)[];
  }

  async function stubHeatRiskCatalog(
    page: Page,
    options: StubHeatRiskCatalogOptions = {}
  ): Promise<HeatRiskCatalogReceipt> {
    const times = options.catalogTimes ?? CATALOG_TIMES;
    const values = options.catalogValues ?? CATALOG_VALUES;
    const identifyCalls: number[] = [];
    await page.route(
      (url) => url.pathname.startsWith(HEATRISK_PATH),
      async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.pathname.endsWith('/query')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              features: times.map((validTime, index) => ({
                attributes: {
                  name: `HeatRisk_${index + 1}_Mercator`,
                  idp_validtime: validTime
                }
              }))
            })
          });
          return;
        }
        if (requestUrl.pathname.endsWith('/identify')) {
          const time = Number(requestUrl.searchParams.get('time'));
          identifyCalls.push(time);
          const index = times.indexOf(time);
          const value = index < 0 ? undefined : values[index];
          if (value === undefined) {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: 'unknown time' } })
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              value: value === null ? 'NoData' : String(value),
              catalogItems: {
                features:
                  value === null
                    ? []
                    : [{ attributes: { idp_validtime: time } }]
              }
            })
          });
          return;
        }
        if (requestUrl.pathname.endsWith('/exportImage')) {
          await route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: HEATRISK_ONE_PIXEL_PNG
          });
          return;
        }
        // Service metadata: reached by the map layer's own activation AND by
        // the briefing's independent-catalog fallback
        // (src/ui/heatrisk-sequence.ts identifyHeatRiskForBriefing), which
        // reads it whether or not the map layer ever activates (DDM-P7-T05
        // F8 correction: this comment previously said the opposite).
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            timeInfo: { timeExtent: [times[0], times.at(-1)] }
          })
        });
      }
    );
    return { identifyCalls };
  }

  /** Copies heat-h1-heatrisk.spec.ts's own counting-fixture toggle helper. */
  async function setLayerChecked(
    page: Page,
    key: string,
    checked: boolean
  ): Promise<void> {
    await layerCheckbox(page, key).evaluate((element, next) => {
      if (!(element instanceof HTMLInputElement)) {
        throw new Error('layerCheckbox did not resolve to an <input>');
      }
      element.checked = next;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, checked);
  }

  test('layer off: the claim is present with its source and validity, naming day 1 of 7 of the catalog', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    await expect(page.locator('#heatrisk-sequence')).toBeHidden();
    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'no data at the selected point for Washington for day 1 of 7 of the catalog'
    );
    await expect(heatClaim).toContainText(
      'Valid Jul 28, 2026, 12:00 UTC to Jul 29, 2026, 12:00 UTC'
    );
    await expect(heatClaim.locator('.impact-claim-badge')).toHaveText(
      'Classified'
    );
    // DR-070 amended 2026-09-08, DR-071: HeatRisk stays Classified evidence,
    // but its register follows the SAME phase the time bar draws
    // (heatRiskClaimRegister in src/ui/heatrisk-sequence.ts): this
    // fixture's day 1 period (Jul 28 to Jul 29, 2026) has long since ended
    // by the real clock this suite runs under, so it reads observed, not
    // outlook (an ended period is "the spent claim the doctrine forbids"
    // as an outlook). The in-force case is proven separately below.
    await expect(heatClaim.locator('.impact-claim-register')).toHaveText(
      'observed'
    );
  });

  test('layer on selecting the same frame: the claim carries the same source and validity, naming the selected frame', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalog(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=1&select=state:WA'
    );
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'no data at the selected point for Washington for the selected frame'
    );
    await expect(heatClaim).toContainText(
      'Valid Jul 28, 2026, 12:00 UTC to Jul 29, 2026, 12:00 UTC'
    );
    await expect(heatClaim.locator('.impact-claim-badge')).toHaveText(
      'Classified'
    );
    // DR-070 amended 2026-09-08, DR-071: same ended-period reasoning as the
    // layer-off case above; the selected frame is the same day 1 period.
    await expect(heatClaim.locator('.impact-claim-register')).toHaveText(
      'observed'
    );
  });

  test('a frame whose 24-hour period has not ended reads the outlook register', async ({
    page
  }) => {
    // Built relative to THIS test's own clock (real time, no
    // page.clock.setFixedTime in this describe block), three hours into day
    // 1, so day 1 is in force at the moment the briefing boots below. This
    // is the paired proof for the two ended-period cases immediately above:
    // heatRiskClaimRegister reads BOTH directions of the same boundary.
    const day1Start = Date.now() - 3 * 60 * 60 * 1000;
    const inForceTimes = Array.from(
      { length: 7 },
      (_, index) => day1Start + index * 24 * 60 * 60 * 1000
    );
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalog(page, {
      catalogTimes: inForceTimes,
      catalogValues: [2, 1, 0, 3, 4, null, 2]
    });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'value 2, Moderate, at the selected point for Washington'
    );
    await expect(heatClaim.locator('.impact-claim-badge')).toHaveText(
      'Classified'
    );
    await expect(heatClaim.locator('.impact-claim-register')).toHaveText(
      'outlook'
    );
  });

  test('toggling the layer off then on with the briefing open costs no extra identify request', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    const receipt = await stubHeatRiskCatalog(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=1&select=state:WA'
    );
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(CATALOG_TIMES.length);

    // A toggle off then quickly on must cost only the layer's own two
    // seven-frame reads (activation, then reactivation); the briefing's
    // independent-catalog fallback (src/ui/heatrisk-sequence.ts
    // identifyHeatRiskForBriefing) must settle through the toggle without
    // firing a request of its own (the RACE correction, DDM-P7-T05 brief 2).
    await setLayerChecked(page, 'heatrisk', false);
    await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();
    await setLayerChecked(page, 'heatrisk', true);
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(CATALOG_TIMES.length * 2);

    // Give the fallback's settle window (about 500 ms) time to fully elapse;
    // it must still make no request once it does.
    await page.waitForTimeout(700);
    expect(receipt.identifyCalls.length).toBe(CATALOG_TIMES.length * 2);
  });

  test('toggling the layer off and LEAVING it off: the fallback answers once, past the settle window', async ({
    page
  }) => {
    // DDM-P7-T05 F5: the case DR-014 a is actually about. Unlike the test
    // above (toggled back on quickly, the fallback never runs), this leaves
    // the layer off, so the fallback's own settle-then-fetch sequence
    // (src/ui/heatrisk-sequence.ts identifyHeatRiskForBriefing) runs to
    // completion: the layer's own seven /identify calls (activation) plus
    // the fallback's own one.
    await stubBrowserNwsHeat(page);
    const receipt = await stubHeatRiskCatalog(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=1&select=state:WA'
    );
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');
    await expect
      .poll(() => receipt.identifyCalls.length)
      .toBe(CATALOG_TIMES.length);

    await setLayerChecked(page, 'heatrisk', false);
    await expect(layerCheckbox(page, 'heatrisk')).not.toBeChecked();

    // Past the ~500 ms deactivation settle window: the fallback's own
    // catalog read and single /identify have had time to complete.
    await page.waitForTimeout(800);

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'no data at the selected point for Washington for day 1 of 7 of the catalog'
    );
    await expect(heatClaim).toContainText(
      'Valid Jul 28, 2026, 12:00 UTC to Jul 29, 2026, 12:00 UTC'
    );
    expect(receipt.identifyCalls.length).toBe(CATALOG_TIMES.length + 1);
  });

  test('with HeatRisk on day 4, every heat claim states the product and valid time it read', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalog(page);
    await gotoApp(
      page,
      '?embed=true&view=console&layers=heatrisk&heatday=4&select=state:WA'
    );
    await expect(layerPill(page, 'heatrisk')).toHaveText('live');

    const heatClaim = page.locator(
      '#impact-panel .impact-claim-classified',
      { hasText: 'HeatRisk (Experimental)' }
    );
    await expect(heatClaim).toContainText(
      'value 3, Major, at the selected point for Washington'
    );
    await expect(heatClaim).toContainText(
      'Valid Jul 31, 2026, 12:00 UTC to Aug 1, 2026, 12:00 UTC'
    );

    // DR-091 (DDM-P2-T11 M2b): every claim in the Heat nearTerm cell (the
    // only cell HeatRisk and the NWS point forecast may fill, matrix.ts
    // LANE_PLACEMENT) states the product date it read, through the ONE
    // shared date line every claim carries (claimDateLine,
    // src/impact/evidence.ts). A retrieval date alone ("Retrieved ...") only
    // proves DDM fetched something at some moment; it is not a claim about
    // when the product it read was itself valid, issued or published, so a
    // claim that reads a product must show one of those, not Retrieved alone.
    const cell = page.locator(
      '.impact-hazard[data-horizon="nearTerm"][data-hazard="heat"]'
    );
    const claims = cell.locator('.impact-claim');
    const claimCount = await claims.count();
    expect(claimCount).toBeGreaterThan(0);
    for (let i = 0; i < claimCount; i += 1) {
      await expect(claims.nth(i).locator('.impact-claim-date')).toHaveText(
        /^(Valid|Issued|Published) /
      );
    }
  });
});

test.describe('DDM-P7-T07: the season-ahead heat cell', () => {
  const CELL = '.impact-hazard[data-horizon="longRange"][data-hazard="heat"]';

  test('(a) a stubbed outlook renders an outlook-register claim naming the CPC seasonal temperature outlook, the stubbed season, the fcst_date day and the point geography', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, {
      cat: 'Above',
      prob: 60,
      validSeas: 'DJF 2027',
      fcstDate: Date.UTC(2026, 10, 15)
    });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    await expect(cell.locator('.impact-hazard-pill')).toHaveText('live');
    const claim = cell.locator('.impact-claim');
    await expect(claim).toHaveCount(1);
    await expect(claim.locator('.impact-claim-register')).toHaveText(
      'outlook'
    );
    await expect(claim).toContainText(
      'NOAA Climate Prediction Center seasonal temperature outlook'
    );
    await expect(claim).toContainText(
      'for Dec-Jan-Feb 2027: 60% chance of above-normal temperature, at the selected point.'
    );
    await expect(claim.locator('.impact-claim-date')).toContainText(
      '2026-11-15'
    );

    // DR-019: never presented as an ENSO forecast.
    await expect(claim).not.toContainText('ENSO');
    // The long-range drought cell keeps its own cited CPC Seasonal Drought
    // Outlook prose (hydrate.ts CPC_SEASONAL_OUTLOOK); it must not appear
    // under heat, which would misattribute a drought-tendency claim to heat.
    await expect(cell).not.toContainText('CPC Seasonal Drought Outlook');
  });

  test('(b1) a 500 response renders the named unavailable state, no claim', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, { httpStatus: 500 });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    await expect(cell.locator('.impact-claim')).toHaveCount(0);
    await expect(cell.locator('.impact-horizon-note')).toContainText(
      'NOAA CPC seasonal temperature outlook'
    );
  });

  test('(b2) an empty-features response renders the named unavailable state, no claim', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, { empty: true });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    await expect(cell.locator('.impact-claim')).toHaveCount(0);
    await expect(cell.locator('.impact-horizon-note')).toContainText(
      'NOAA CPC seasonal temperature outlook'
    );
  });

  test('(c) a superseded selection renders only the newer selection\'s claim', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    // A typed holder, not a bare `let`: see oldPoint above.
    const oldOutlook: { release: (() => void) | null } = { release: null };
    const holdFirst = new Promise<void>((resolve) => {
      oldOutlook.release = resolve;
    });
    await stubCpcSeasonalTempOutlook(page, {
      holdFirst,
      sequence: [
        { validSeas: 'DJF 2027 (superseded)' },
        { validSeas: 'MAM 2027' }
      ]
    });

    try {
      await gotoApp(page, '?view=brief&select=state:WA');
      await expect(page.locator('#impact-panel')).toBeVisible();
      await page.locator('#impact-panel .impact-panel-close').click();

      const search = page.locator('#brief-search [data-ddm-search]');
      await search.fill('oregon');
      await page
        .locator(
          '#brief-search [data-search-kind="place"][data-search-id="OR"]'
        )
        .click();
      // The pick opens the chosen place's briefing (owner 2026-11-13).

      const cell = page.locator(CELL);
      await expect(cell.locator('.impact-claim')).toContainText(
        'Mar-Apr-May 2027'
      );

      oldOutlook.release?.();
      await page.waitForTimeout(200);
      await expect(cell.locator('.impact-claim')).toHaveCount(1);
      await expect(cell.locator('.impact-claim')).not.toContainText(
        'DJF 2027 (superseded)'
      );
      await expect(cell.locator('.impact-horizon-note')).toHaveCount(0);
    } finally {
      oldOutlook.release?.();
    }
  });

  test('(d) DR-190 returns Heat to Current; its Long Range chip stays disabled and carries no seasonal product', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    // DR-190 makes this in-session switch agree with found-009's boot:
    // the destination commits Current and the actual HeatRisk product.
    await stubCpcDroughtOutlook(page);
    await gotoApp(page, '?view=console');
    const longRange = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await longRange.click();
    await expect(longRange).toHaveAttribute('aria-pressed', 'true');
    await waitForLayerSettled(page, 'drought');
    await page.locator('.shell-cluster-btn[data-cluster="heat"]').click();
    await expect(
      page.locator('.shell-cluster-btn[data-cluster="heat"]')
    ).toHaveAttribute('aria-pressed', 'true');

    await expect(page.locator('.shell-horizon-btn[data-horizon="current"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => new URL(page.url()).searchParams.get('horizon')).toBeNull();
    await expect(layerCheckbox(page, 'heatrisk')).toBeChecked();
    await expect(layerPill(page, 'heatrisk')).toHaveClass(/\bready\b/);
    await expect(page.locator('#shell-time')).toHaveAttribute('data-has-spec', 'true');
    await expect(page.locator('#shell-time .shell-time-empty')).toHaveCount(0);
    await expect(page.locator('#time-bar .time-bar-stamp-detail')).toContainText('NWS HeatRisk');
    await expect(page.locator('#time-bar')).toBeVisible();
    const chip = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect(chip).toHaveAttribute('aria-disabled', 'true');
    await expect(chip).toHaveAttribute(
      'title',
      'Long Range is off for Extreme Heat: no verified map source for this time horizon exists yet, so none is shown rather than a guess.'
    );
    await expect(page.locator('#map-key')).not.toContainText(
      'seasonal temperature outlook'
    );
  });

  test('(e) a United States selection outside the Pacific Northwest (Texas) reads its season-ahead heat cell live, with no regional gate (DR-096 widened by DR-256; DR-075 a at the source gate)', async ({
    page
  }) => {
    // History, so the change of assertion is not mistaken for a weakening.
    // From DR-090 until DR-256 a Texas selection got only the conus family's
    // "not validated outside the Pacific Northwest" block: the matrix
    // collapse in src/impact/hydrate.ts (matrixEnabled) took this cell with
    // it. DR-096 ruled the matrix render per cell; DR-256 (the owner,
    // 2026-11-13) lifted the regional gate and widened that ruling, so the
    // cell reads wherever the issuer's service covers the place again.
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, {
      cat: 'Below',
      prob: 40,
      validSeas: 'JJA 2027',
      fcstDate: Date.UTC(2027, 5, 1)
    });
    await gotoApp(page, '?embed=true&view=console&select=state:TX');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-capability-unavailable')).toHaveCount(0);
    const cell = page.locator(CELL);
    await expect(cell.locator('.impact-hazard-pill')).toHaveText('live');
    const claim = cell.locator('.impact-claim');
    await expect(claim).toHaveCount(1);
    await expect(claim).toContainText(
      'for Jun-Jul-Aug 2027: 40% chance of below-normal temperature, at the selected point.'
    );
  });

  test('(g) an Equal Chances reading renders "Equal Chances (no favored tercile)" with no percent (the issuer\'s own EC semantics, not a forecast confidence)', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, {
      cat: 'EC',
      prob: 33,
      validSeas: 'JJA 2027',
      fcstDate: Date.UTC(2027, 5, 1)
    });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    const claim = cell.locator('.impact-claim');
    await expect(claim).toHaveCount(1);
    await expect(claim).toContainText(
      'for Jun-Jul-Aug 2027: Equal Chances (no favored tercile), at the selected point.'
    );
    await expect(claim).not.toContainText('33%');
  });

  test('(h) a Normal reading renders the issuer legend label "near-normal"', async ({
    page
  }) => {
    await stubBrowserNwsHeat(page);
    await stubHeatRiskCatalogShared(page);
    await stubCpcSeasonalTempOutlook(page, {
      cat: 'Normal',
      prob: 40,
      validSeas: 'SON 2026',
      fcstDate: Date.UTC(2026, 8, 1)
    });
    await gotoApp(page, '?embed=true&view=console&select=state:WA');

    const cell = page.locator(CELL);
    const claim = cell.locator('.impact-claim');
    await expect(claim).toHaveCount(1);
    await expect(claim).toContainText(
      'for Sep-Oct-Nov 2026: 40% chance of near-normal temperature, at the selected point.'
    );
  });
});
