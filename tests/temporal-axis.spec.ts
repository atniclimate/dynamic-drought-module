import { test, expect, type Page } from '@playwright/test';
import { gotoApp, layerCheckbox, urlLayers, search } from './helpers';

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
 *     (CLAUDE.md section 6 invariant 2).
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
