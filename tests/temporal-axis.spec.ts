import { test, expect, type Page } from '@playwright/test';
import { gotoApp, layerCheckbox, layerPill, PILL, urlLayers, search } from './helpers';

/**
 * 0.5.0b temporal axis (critical-review Section 5): the honesty-of-time
 * contract, asserted deterministically against stubbed upstreams.
 *
 *   - Authored products (USDM weeks, CPC outlooks) get a discrete rail and
 *     Step; the Play affordance NEVER appears on them.
 *   - The one continuous field (SST anomaly) is the only surface with Play,
 *     and a shared frame link lands PAUSED (maintainer-ratified).
 *   - Crossing observed -> outlook is a real surface switch that visibly
 *     changes instrument (register attribute, Issued stamp).
 *   - Temporal state round-trips through the URL and preserves embed=true
 *     (the URL-as-state invariant).
 *   - A time change never leaves the map both surfaceless and silent
 *     (DDM-P8-T05; the final describe block).
 */

// Two consecutive stub weeks: the "current" release and the prior Tuesday.
const LATEST_MS = Date.UTC(2026, 5, 30); // 2026-06-30
const PRIOR_MS = Date.UTC(2026, 5, 23); // 2026-06-23

const PNW_RING = [
  [-125, 42],
  [-116, 42],
  [-116, 49],
  [-125, 49],
  [-125, 42]
];

function usdmFc(dm: number, mapDateMs: number): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { DM: dm, MapDate: mapDateMs },
        geometry: { type: 'Polygon', coordinates: [PNW_RING] }
      }
    ]
  };
}

/** Stub the USDM current + archive services with distinct weeks. */
async function stubUsdm(page: Page): Promise<void> {
  await page.route('**/USDM_current/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(usdmFc(2, LATEST_MS))
    })
  );
  await page.route('**/USDM_archive/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(usdmFc(4, PRIOR_MS))
    })
  );
}

/** Stub both CPC drought outlook vector layers (monthly /1, seasonal /4). */
async function stubOutlook(page: Page): Promise<void> {
  const fc = (target: string): unknown => ({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { outlook: 'Persistence', fcst_date: '06/30/2026', target },
        geometry: { type: 'Polygon', coordinates: [PNW_RING] }
      }
    ]
  });
  await page.route(
    (url) => url.href.includes('cpc_drought_outlk/MapServer/1/query'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(fc('Jul 2026'))
      })
  );
  await page.route(
    (url) => url.href.includes('cpc_drought_outlk/MapServer/4/query'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(fc('September 30'))
      })
  );
}

test.describe('0.5.0b temporal axis', () => {
  test('USDM gets a week rail with Step and no Play; a step writes week=', async ({
    page
  }) => {
    await stubUsdm(page);
    // The temporal controls live in the sidebar since E2 (D-0.7.0-058
    // ruling 1), so the interaction leg runs with the sidebar present; the
    // embed leg (the honest valid-date stamp) is the next test.
    await gotoApp(page, '?region=washington_state&layers=usdm');

    const bar = page.locator('#time-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-register', 'observed');

    // The observed stamp is a hard VALID date; no Play exists on an
    // authored product (the affordance is the lesson).
    await expect(bar.locator('.time-bar-stamp-headline')).toHaveText('Valid Jun 30, 2026');
    await expect(bar.locator('[data-play]')).toHaveCount(0);

    // Discrete rail: 52 real weekly stops, parked on the newest.
    const rail = bar.locator('.time-bar-rail');
    await expect(rail).toHaveAttribute('max', '51');
    await expect(rail).toHaveValue('51');

    // Change chips are honest at the newest stop only.
    await expect(bar.locator('[data-mode="chg1"]')).toBeEnabled();

    // Step one week back: the stamp, the URL, and the chip state follow.
    await bar.locator('[data-step="-1"]').click();
    await expect(bar.locator('.time-bar-stamp-headline')).toHaveText('Valid Jun 23, 2026');
    await expect.poll(async () => new URLSearchParams(await search(page)).get('week')).toBe('20260623');
    await expect(bar.locator('[data-mode="chg1"]')).toBeDisabled();

    // The conditions strip reads the scrubbed week as deliberate history,
    // never as a frozen feed.
    await expect(page.locator('#conditions-date')).toContainText('viewing week of Jun 23, 2026');
    await expect(page.locator('#conditions-date')).not.toHaveAttribute('data-stale', 'true');
  });

  test('an embed keeps the honest valid-date stamp on the map and the embed flag survives (E2, D-0.7.0-058)', async ({
    page
  }) => {
    await stubUsdm(page);
    // A shared historical week INSIDE an embed: the sidebar (and so the
    // full time bar) does not exist there, so the on-map stamp is the
    // honest temporal statement, mirrored from the same spec.
    await gotoApp(page, '?region=washington_state&layers=usdm&week=20260623&embed=true');

    const stamp = page.locator('#embed-date-stamp');
    await expect(stamp).toBeVisible();
    await expect(stamp).toHaveText('Valid Jun 23, 2026');
    await expect(stamp).toHaveAttribute('data-register', 'observed');

    // The full bar stays sidebar-hosted and therefore out of the embed.
    await expect(page.locator('#time-bar')).toBeHidden();

    // Invariant 2: embed= and week= both survive the boot's canonical
    // URL writes.
    expect(new URLSearchParams(await search(page)).get('embed')).toBe('true');
    expect(new URLSearchParams(await search(page)).get('week')).toBe('20260623');
  });

  test('a shared week= link restores its stop; a dishonest dmode heals to absolute', async ({
    page
  }) => {
    await stubUsdm(page);
    await gotoApp(page, '?layers=usdm&week=20260623&dmode=chg1');

    const bar = page.locator('#time-bar');
    await expect(bar.locator('.time-bar-stamp-headline')).toHaveText('Valid Jun 23, 2026');
    await expect(bar.locator('.time-bar-rail')).toHaveValue('50');

    // Change maps exist for the current week only, so the shared chg1 at a
    // historical stop falls back to absolute and the URL heals.
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('dmode'))
      .toBeNull();
  });

  test('the change toggle swaps to the derivative register at the current week', async ({
    page
  }) => {
    await stubUsdm(page);
    const changeFc = {
      date: '20260630',
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { DN: 1 },
          geometry: { type: 'Polygon', coordinates: [PNW_RING] }
        }
      ]
    };
    await page.route(
      (url) => url.href.includes('usdm-change.geojson'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(changeFc)
        })
    );

    await gotoApp(page, '?region=washington_state&layers=usdm');
    const bar = page.locator('#time-bar');
    await expect(bar).toBeVisible();

    await bar.locator('[data-mode="chg1"]').click();

    // URL round-trip, the change stamp, and the swapped legend.
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('dmode'))
      .toBe('chg1');
    await expect(bar.locator('.time-bar-stamp-headline')).toHaveText('Change through Jun 30, 2026');
    await expect(
      page.locator('.legend-section[data-legend="usdm"]')
    ).toContainText('Drought change key (1-week)');

    // The strip names the view instead of faking a worst-category number.
    const drought = page.locator('.conditions-metric[data-metric="drought"]');
    await expect(drought.locator('.conditions-value')).toHaveText('1-wk');
    await expect(drought.locator('.conditions-sublabel')).toContainText('drought change');
    await expect(drought.locator('.conditions-sublabel')).not.toContainText('drought change in view');
    await expect(drought).toHaveAttribute('aria-label', /drought change in view/i);
  });

  test('the outlook jump changes instrument: register switch, Issued stamp, honest URL', async ({
    page
  }) => {
    await stubUsdm(page);
    await stubOutlook(page);
    await gotoApp(page, '?region=washington_state&layers=usdm');

    const bar = page.locator('#time-bar');
    await expect(bar).toBeVisible();

    // Jump into the Monthly outlook: a REAL surface switch.
    await bar.locator('[data-jump="monthly"]').click();

    // The surface switch settles the URL over a few ticks (drought is added,
    // then USDM is removed by the exclusivity rule), so poll for the SETTLED
    // set rather than reading it mid-transition. A non-polled read of the
    // usdm removal can catch the transient both-present window.
    await expect
      .poll(async () => {
        const layers = await urlLayers(page);
        return layers.has('drought') && !layers.has('usdm');
      })
      .toBe(true);
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('outlook'))
      .toBe('monthly');
    await expect(layerCheckbox(page, 'drought')).toBeChecked();
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();

    // The instrument visibly changes: outlook register, Issued stamp with
    // the valid-through range, shift-in-odds copy, still no Play.
    await expect(bar).toHaveAttribute('data-register', 'outlook');
    await expect(bar.locator('.time-bar-stamp-headline')).toHaveText(
      'Issued Jun 30, 2026 · through Jul 2026'
    );
    await expect(bar.locator('.time-bar-stamp-detail')).toContainText(
      'a shift in odds, not a forecast of outcomes'
    );
    await expect(bar.locator('[data-play]')).toHaveCount(0);

    // And the way back is offered: Observed weeks restores the USDM. ONE
    // click must be enough: the bar memoizes content-identical re-renders
    // (src/ui/time-bar.ts), so a status flap can no longer swap the DOM
    // under this click and swallow it (the Unit I session's dead-click
    // finding; this single unretried click is the regression pin).
    await bar.locator('[data-jump="observed"]').click();
    await expect.poll(async () => (await urlLayers(page)).has('usdm')).toBe(true);
    await expect(bar).toHaveAttribute('data-register', 'observed');
  });

  test('SST anomaly is the only Play surface and a shared frame lands paused', async ({
    page
  }) => {
    // A tiny transparent PNG for every GIBS tile; DescribeDomains yields a
    // one-week P1D window so the rail is deterministic.
    const PNG_1PX = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );
    await page.route(
      (url) => url.href.includes('DescribeDomains'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/xml',
          body:
            "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
            '<ows:Identifier>time</ows:Identifier>' +
            '<Domain>2026-07-01/2026-07-07/P1D</Domain>' +
            '<Size>1</Size></DimensionDomain></Domains>'
        })
    );
    await page.route(
      (url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
      (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX })
    );

    await gotoApp(page, '?layers=sst-anomaly&sst=2026-07-03');

    const bar = page.locator('#time-bar');
    await expect(bar).toBeVisible();

    // The continuous field carries the Play affordance, and it is PAUSED:
    // playback is a fresh user gesture, never restored from a link.
    const play = bar.locator('[data-play]');
    await expect(play).toHaveCount(1);
    await expect(play).toHaveAttribute('aria-label', 'Play');

    // The shared frame is restored exactly (observed register, real date).
    await expect(bar.locator('.time-bar-stamp-headline')).toHaveText('Observed Jul 3, 2026');
    expect(new URLSearchParams(await search(page)).get('sst')).toBe('2026-07-03');

    // Seven real dates from the stubbed P1D window, parked on Jul 3.
    const rail = bar.locator('.time-bar-rail');
    await expect(rail).toHaveAttribute('max', '6');
    await expect(rail).toHaveValue('2');
  });
});

/**
 * DDM-P8-T05: never leave a hazard surface blank across a horizon or day
 * change.
 *
 * The acceptance sentence is a statement about EVERY instant of a
 * transition, so these two tests do not read the interface once. They start
 * a 20 ms in-page sampler before the change, hold the superseding fetch
 * open, and then judge the whole recorded window at once. The judgement is
 * one predicate applied to every sample:
 *
 *     the layer says `loading`  =>  the map says `loading` too
 *
 * The left half comes from the layer's own status pill; the right half from
 * the on-map loading indicator and, for HeatRisk, the on-map key's
 * qualification row. A sample where the pill reads `loading...` while the
 * map shows neither is the defect: for that instant the person looking at
 * the map has no surface and no explanation.
 *
 * Both tests fail on the pre-DDM-P8-T05 code, and for different reasons.
 * The HeatRisk day change tore its raster down and then announced `ready`,
 * so the map went blank while the key claimed a live scale. The drought
 * horizon change kept the previous outlook polygons up (good) but said
 * nothing about the fetch behind them, so a stale product read as current.
 */

const HEAT_SERVICE_PATH =
  '/experimental/rest/services/NWS_HeatRisk/ImageServer';

/** Seven consecutive advertised granules, the issuer's own contract. */
const HEAT_TIMES = [
  1785153600000,
  1785240000000,
  1785326400000,
  1785412800000,
  1785499200000,
  1785585600000,
  1785672000000
] as const;

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** One instant of the whole picture, recorded inside the page. */
interface ContinuitySample {
  readonly pill: string;
  readonly indicator: boolean;
  readonly indicatorText: string;
  readonly keyLoading: boolean;
  readonly stamp: string;
}

/**
 * Stub the HeatRisk service: consistent time metadata, seven catalog
 * granules, and a caller-supplied raster responder so a test can hold one
 * frame's tiles open.
 */
async function stubHeatRisk(
  page: Page,
  raster: (
    time: number,
    route: import('@playwright/test').Route
  ) => Promise<void>
): Promise<void> {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: TRANSPARENT_PNG
    })
  );
  await page.route(
    (url) => url.pathname.startsWith(HEAT_SERVICE_PATH),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/query')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            features: HEAT_TIMES.map((validTime, index) => ({
              attributes: {
                name: `HeatRisk_${index + 1}_Mercator`,
                idp_validtime: validTime
              }
            }))
          })
        });
        return;
      }
      if (url.pathname.endsWith('/exportImage')) {
        await raster(Number(url.searchParams.get('time')), route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          timeInfo: {
            startTimeField: 'idp_validtime',
            endTimeField: null,
            timeExtent: [HEAT_TIMES[0], HEAT_TIMES.at(-1)],
            timeReference: null
          }
        })
      });
    }
  );
}

/**
 * Begin recording the whole picture every 20 ms. `setInterval`, not
 * `requestAnimationFrame`: a headless frame callback can be throttled to
 * nothing, and a sampler that stops sampling would pass this test by
 * recording no counter-example.
 */
async function startContinuitySampler(page: Page, key: string): Promise<void> {
  await page.evaluate((layerKey) => {
    const store: { samples: unknown[]; timer: number } = {
      samples: [],
      timer: 0
    };
    (window as unknown as Record<string, unknown>)['__ddmContinuity'] = store;
    const shown = (element: Element | null): boolean =>
      element !== null &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden';
    const text = (selector: string): string =>
      document.querySelector(selector)?.textContent?.trim() ?? '';
    store.timer = window.setInterval(() => {
      store.samples.push({
        pill: text(`[data-layer-status="${layerKey}"]`),
        indicator: shown(document.getElementById('loading-indicator')),
        indicatorText: text('#loading-text'),
        keyLoading: shown(
          document.querySelector(`#map-key [data-key-loading="${layerKey}"]`)
        ),
        stamp: text('#time-bar .time-bar-stamp-headline')
      });
    }, 20);
  }, key);
}

async function stopContinuitySampler(page: Page): Promise<ContinuitySample[]> {
  const raw = await page.evaluate(() => {
    const store = (
      window as unknown as {
        __ddmContinuity?: { samples: unknown[]; timer: number };
      }
    ).__ddmContinuity;
    if (!store) return [];
    window.clearInterval(store.timer);
    return store.samples;
  });
  return raw as ContinuitySample[];
}

test.describe('DDM-P8-T05 surface continuity across a time change', () => {
  test('a HeatRisk day change keeps an honest loading state on the map for the whole fetch', async ({
    page
  }) => {
    let releaseDayTwo!: () => void;
    const dayTwoGate = new Promise<void>((resolve) => {
      releaseDayTwo = resolve;
    });
    await stubHeatRisk(page, async (time, route) => {
      if (time === HEAT_TIMES[1]) await dayTwoGate;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: TRANSPARENT_PNG
        });
      } catch {
        // Removing the superseded source cancels its routed requests.
      }
    });

    await gotoApp(page, '?layers=heatrisk&view=console');
    await expect(layerPill(page, 'heatrisk')).toHaveText(PILL.live, {
      timeout: 25_000
    });
    const select = page.locator('#map-key select[data-heatrisk-day]');
    await expect(select).toHaveValue('1');

    await startContinuitySampler(page, 'heatrisk');
    await select.selectOption('2');
    // Day 2's tiles are held, so this window lies entirely inside the fetch.
    await page.waitForTimeout(700);
    const samples = await stopContinuitySampler(page);
    releaseDayTwo();

    const pending = samples.filter((sample) => sample.pill === PILL.loading);
    // A real window, not one instant: without this the predicate below
    // would pass vacuously on a transition that was never sampled.
    expect(pending.length).toBeGreaterThanOrEqual(15);
    // The acceptance sentence: no sampled instant is surfaceless AND silent.
    expect(
      pending.filter((sample) => !sample.indicator && !sample.keyLoading)
    ).toEqual([]);
    // And both on-map statements agree with the pill at every instant,
    // rather than one of them presenting the unpainted frame as live.
    expect(
      pending.every((sample) => sample.indicator && sample.keyLoading)
    ).toBe(true);

    // The loading statement is bounded by the fetch it describes: once the
    // held tiles land the map reads live and says nothing more.
    await expect(layerPill(page, 'heatrisk')).toHaveText(PILL.live, {
      timeout: 25_000
    });
    await expect(select).toHaveValue('2');
    await expect(
      page.locator('#map-key [data-key-loading="heatrisk"]')
    ).toHaveCount(0);
    await expect(page.locator('#loading-indicator')).toBeHidden({
      timeout: 25_000
    });
  });

  test('a drought horizon change keeps the previous outlook and says it is still loading', async ({
    page
  }) => {
    let releaseSeasonal!: () => void;
    const seasonalGate = new Promise<void>((resolve) => {
      releaseSeasonal = resolve;
    });
    const outlookFc = (target: string): unknown => ({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            outlook: 'Persistence',
            fcst_date: '06/30/2026',
            target
          },
          geometry: { type: 'Polygon', coordinates: [PNW_RING] }
        }
      ]
    });
    await page.route(
      (url) => url.href.includes('cpc_drought_outlk/MapServer/1/query'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(outlookFc('Jul 2026'))
        })
    );
    await page.route(
      (url) => url.href.includes('cpc_drought_outlk/MapServer/4/query'),
      async (route) => {
        await seasonalGate;
        try {
          await route.fulfill({
            status: 200,
            contentType: 'application/geo+json',
            body: JSON.stringify(outlookFc('September 30'))
          });
        } catch {
          // A superseded range request is aborted, not answered.
        }
      }
    );

    // Drive both drought horizon changes through the chips a person uses.
    // The first (current to weeks-ahead) is a recipe swap: the North
    // American Drought Monitor comes off and the CPC Monthly outlook comes
    // on, and the layer controller's own indicator covers that fetch. The
    // one this test samples is the second, where the recipe does not
    // change at all and only the outlook register does, so nothing but
    // this module's own statement stands between a stale surface and a
    // silent one.
    await gotoApp(page, '?view=console');
    await page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]').click();
    await expect(layerPill(page, 'drought')).toHaveText(PILL.live, {
      timeout: 25_000
    });
    const headline = page.locator('#time-bar .time-bar-stamp-headline');
    await expect(headline).toHaveText('Issued Jun 30, 2026 · through Jul 2026');

    await startContinuitySampler(page, 'drought');
    await page
      .locator('.shell-horizon-btn[data-horizon="season-ahead"]')
      .click();
    await page.waitForTimeout(700);
    const samples = await stopContinuitySampler(page);
    releaseSeasonal();

    const pending = samples.filter((sample) => sample.pill === PILL.loading);
    expect(pending.length).toBeGreaterThanOrEqual(15);
    // Never blank: the monthly polygons and their stamp stay on the map for
    // the whole seasonal fetch.
    expect(
      pending.every(
        (sample) => sample.stamp === 'Issued Jun 30, 2026 · through Jul 2026'
      )
    ).toBe(true);
    // Never silently stale: the map names the product it is still fetching
    // at every one of those instants.
    expect(pending.filter((sample) => !sample.indicator)).toEqual([]);
    expect(
      pending.every(
        (sample) =>
          sample.indicatorText ===
          'Loading the CPC Seasonal Drought Outlook...'
      )
    ).toBe(true);

    // The switch completes: the seasonal product replaces the monthly one
    // and the loading statement is withdrawn.
    await expect(headline).toHaveText(
      'Issued Jun 30, 2026 · through September 30',
      { timeout: 25_000 }
    );
    await expect(layerPill(page, 'drought')).toHaveText(PILL.live, {
      timeout: 25_000
    });
    await expect(page.locator('#loading-indicator')).toBeHidden({
      timeout: 25_000
    });
  });
});
