/**
 * The fire and heat time bar, and the acceptance sentence of DDM-P8-T02
 * (`docs/ROADMAP.yaml:322`):
 *
 *   "Each of the four hazard screens shows a time control whose stamp names
 *    the issuer and the period the displayed surface covers, or states that
 *    the product is undated."
 *
 * Before S13 (2026-09-08) only the drought family and the ocean anomaly
 * surface installed a time bar; the Wildfire and Extreme Heat screens had
 * none. This file drives the two new screens against fixtures only (no
 * live agency is reached: every fire and heat source is intercepted with
 * `page.route`, the way tests/enso-horizons.spec.ts intercepts the ENSO
 * snapshot) and asserts, per stamp:
 *
 *   - the horizon line equals a HORIZON_CHROME title and subtitle (one
 *     grammar; DDM-P8-T03 clause 2, the stamp half S12 assigned here);
 *   - the headline states the period from the fixture's own fields, or says
 *     the product carries none (clauses 3 and 4);
 *   - the detail names the issuer (clause 2);
 *   - an outlook step is labelled as an outlook and an observed step is not
 *     (the S13 doctrine), read from `data-register` AND from the words;
 *   - no forward-looking language from the shared forbidden list;
 *   - the S12 horizon-chip assertions still hold with the bar rendered.
 *
 * HeatRisk fixtures use FIXED literal frame times (the seven 12:00 UTC days
 * from tests/heat-h1-heatrisk.spec.ts) and a FIXED page clock
 * (`page.clock.setFixedTime`), so which frame counts as begun, in progress,
 * or ended never depends on the calendar the suite happens to run on. Three
 * heat cases: a ready day, a day whose tiles never load (unavailable), and a
 * window the service has not advanced (every period ended).
 */
import { expect, test, type Page, type Route } from '@playwright/test';

import { TEMPORAL_HORIZON_KEYS } from '../src/config/clusters';
import { LIVE_NO_FEATURES_LABEL } from '../src/config/layers';
import { HORIZON_CHROME, SHELL_HORIZON_KEY } from '../src/impact/horizon-chrome';
import type { HorizonKey } from '../src/impact/types';
import { expectNoForecastLanguage } from './enso-forecast-language';
import { gotoApp, layerPill, PILL, search } from './helpers';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const HEATRISK_PATH = '/experimental/rest/services/NWS_HeatRisk/ImageServer';
const WWA_PATH = '/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';

/** Seven advertised 24-hour periods, each opening at 12:00 UTC: Jul 28 to
 * Aug 3, 2026. Fixed literals, never derived from the run date. */
const HEAT_TIMES = [
  1785240000000,
  1785326400000,
  1785412800000,
  1785499200000,
  1785585600000,
  1785672000000,
  1785758400000
] as const;

/** Jul 30, 2026 18:00 UTC: days 1 and 2 have ended, day 3 is in progress,
 * days 4 to 7 have not begun. */
const CLOCK_IN_WINDOW = Date.UTC(2026, 6, 30, 18, 0, 0);
/** Aug 10, 2026: every advertised period has ended (a stale window). */
const CLOCK_AFTER_WINDOW = Date.UTC(2026, 7, 10, 0, 0, 0);

const PNW_RING = [
  [-125, 42],
  [-116, 42],
  [-116, 49],
  [-125, 49],
  [-125, 42]
];

function emptyCollection(): string {
  return JSON.stringify({ type: 'FeatureCollection', features: [] });
}

async function fulfilJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/geo+json',
    body: JSON.stringify(body)
  });
}

/** The basemap and every non-fire, non-heat live source, answered locally. */
async function stubCommon(page: Page): Promise<void> {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
  );
  // Broad first, specific later: Playwright matches the most recently
  // registered route, so the fire and heat handlers below win.
  await page.route('https://services5.arcgis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
  );
  await page.route('https://services3.arcgis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
  );
  await page.route('https://services2.arcgis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
  );
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
  );
  await page.route((url) => url.pathname.endsWith(WWA_PATH), (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
  );
}

interface FireStubOptions {
  /** 'outlined': one Critical area with a valid window; 'empty': the
   * common good-news issuance with no area and therefore no window. */
  readonly spc: 'outlined' | 'empty';
}

/**
 * The Wildfire screen's sources: one current WFIGS wildfire perimeter, no
 * HMS smoke plume, the SPC Day 1 outlook per `spc`, and WHP tiles through
 * the Worker proxy (every other proxied request answers an empty array).
 */
async function stubFire(page: Page, options: FireStubOptions): Promise<void> {
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    fulfilJson(route, {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            attr_IncidentName: 'Fixture Fire',
            poly_IncidentName: 'Fixture Fire',
            attr_IncidentTypeCategory: 'WF',
            attr_UniqueFireIdentifier: '2026-WAFIX-000001',
            attr_IrwinID: '{FIXTURE}',
            attr_IncidentSize: 1200,
            poly_GISAcres: 1200,
            attr_FireDiscoveryDateTime: 1785000000000,
            attr_POOState: 'US-WA'
          },
          geometry: { type: 'Polygon', coordinates: [PNW_RING] }
        }
      ]
    })
  );
  await page.route((url) => url.href.includes('NOAA_Satellite_Smoke_Detection'), (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
  );
  await page.route((url) => url.href.includes('SPC_firewx/MapServer/1/query'), (route) =>
    fulfilJson(route, {
      type: 'FeatureCollection',
      features:
        options.spc === 'empty'
          ? []
          : [
              {
                type: 'Feature',
                properties: { dn: 8, valid: '202609081200', expire: '202609091200' },
                geometry: { type: 'Polygon', coordinates: [PNW_RING] }
              }
            ]
    })
  );
  await page.route('https://ddm-proxy.atniclimate.workers.dev/**', async (route) => {
    const target = new URL(route.request().url()).searchParams.get('url') ?? '';
    if (target.includes('/exportImage')) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

interface HeatStubOptions {
  /** A frame time whose tiles answer HTTP 500, so that day never paints. */
  readonly failTime?: number;
}

/** The HeatRisk service: metadata, the seven-granule catalog, tiles, and
 * identify answers, all from the fixed literals above. */
async function stubHeat(page: Page, options: HeatStubOptions = {}): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith(HEATRISK_PATH),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/query')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            features: HEAT_TIMES.map((validTime, index) => ({
              attributes: { name: `HeatRisk_${index + 1}_Mercator`, idp_validtime: validTime }
            }))
          })
        });
        return;
      }
      if (url.pathname.endsWith('/identify')) {
        const time = Number(url.searchParams.get('time'));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            value: '2',
            catalogItems: {
              objectIdFieldName: 'objectid',
              features: [
                { attributes: { objectid: 1, name: 'HeatRisk_fixture', idp_validtime: time } }
              ]
            }
          })
        });
        return;
      }
      if (url.pathname.endsWith('/exportImage')) {
        const time = Number(url.searchParams.get('time'));
        if (options.failTime !== undefined && time === options.failTime) {
          await route.fulfill({ status: 500, contentType: 'text/plain', body: 'fixture: no tile' });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
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
  await page.route('https://ddm-proxy.atniclimate.workers.dev/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
}

/** The ENSO screen's surface: a one-week P1D window and blank tiles, the
 * same stub tests/temporal-axis.spec.ts uses. */
async function stubSst(page: Page): Promise<void> {
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
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
  );
}

// ---------------------------------------------------------------------------
// Readers and the per-stamp assertions
// ---------------------------------------------------------------------------

interface StampRead {
  readonly register: string;
  readonly horizonKey: string;
  readonly horizon: string;
  readonly headline: string;
  readonly detail: string;
  readonly text: string;
}

/** The DOM's own words. `textContent`, not `innerText`: the stamp's CSS
 * uppercases the horizon and headline lines for display, and the contract
 * is about what the DOM says, not how the stylesheet cases it. */
async function domText(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
}

async function readStamp(page: Page): Promise<StampRead> {
  const bar = page.locator('#time-bar');
  await expect(bar).toBeVisible();
  const horizonEl = bar.locator('.time-bar-stamp-horizon');
  const horizon = await domText(page, '#time-bar .time-bar-stamp-horizon');
  const headline = await domText(page, '#time-bar .time-bar-stamp-headline');
  const detail = await domText(page, '#time-bar .time-bar-stamp-detail');
  return {
    register: (await bar.getAttribute('data-register')) ?? '',
    horizonKey: (await horizonEl.getAttribute('data-horizon')) ?? '',
    horizon,
    headline,
    detail,
    text: `${horizon} ${headline} ${detail}`
  };
}

/** The horizon line is exactly one HORIZON_CHROME entry, title and subtitle. */
function expectHorizonLine(stamp: StampRead, key: HorizonKey): void {
  const chrome = HORIZON_CHROME[key];
  expect(stamp.horizonKey, 'stamp data-horizon').toBe(key);
  expect(stamp.horizon, 'stamp horizon line').toBe(`${chrome.title} · ${chrome.subtitle}`);
}

/**
 * The S13 doctrine for bare stamps: the words carry the register. An
 * `outlook` stamp names the outlook (the issuer's product or the word);
 * an `observed` stamp never calls its product an outlook, though it may
 * deny being one ("not an outlook"), the same denial rule the shared
 * forbidden list applies to "forecast".
 */
function expectRegisterHonest(label: string, stamp: StampRead): void {
  expect(['observed', 'outlook'], `${label} register`).toContain(stamp.register);
  const denial = /\b(not|never|no)\b[^.;]{0,40}\boutlooks?\b/gi;
  const undenied = stamp.text.replace(denial, '');
  const namesOutlook = /\boutlooks?\b/i.test(undenied);
  if (stamp.register === 'outlook') {
    expect(namesOutlook, `${label}: an outlook stamp must say so: "${stamp.text}"`).toBe(true);
  } else {
    expect(namesOutlook, `${label}: an observed stamp must not call itself an outlook: "${stamp.text}"`).toBe(false);
  }
}

/** Everything the acceptance and the doctrine ask of one rendered stamp. */
function expectStampContract(
  label: string,
  stamp: StampRead,
  expected: { horizon: HorizonKey; register: 'observed' | 'outlook'; issuer: string }
): void {
  expectHorizonLine(stamp, expected.horizon);
  expect(stamp.register, `${label} register`).toBe(expected.register);
  expect(stamp.detail, `${label} names its issuer`).toContain(expected.issuer);
  expectRegisterHonest(label, stamp);
  expectNoForecastLanguage(`${label} stamp`, stamp.text);
}

/** The S12 horizon-chip assertions, re-run with a time bar on the page. */
async function expectChipsStillHonest(page: Page): Promise<void> {
  for (const key of TEMPORAL_HORIZON_KEYS) {
    const chrome = HORIZON_CHROME[SHELL_HORIZON_KEY[key]];
    const btn = page.locator(`.shell-horizon-btn[data-horizon="${key}"]`);
    expect((await btn.locator('.shell-horizon-btn-title').innerText()).trim()).toBe(chrome.title);
    expect((await btn.locator('.shell-horizon-btn-sub').innerText()).trim()).toBe(chrome.subtitle);
  }
  const stray = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.preset-chip').forEach((el) => el.remove());
    return /\bWeeks ahead\b|\bSeason ahead\b/.test(clone.textContent ?? '');
  });
  expect(stray, 'the retired chip wording reappeared with the time bar rendered').toBe(false);
}

async function heatDay(page: Page): Promise<string | null> {
  return new URLSearchParams(await search(page)).get('heatday');
}

// ---------------------------------------------------------------------------
// Wildfire
// ---------------------------------------------------------------------------

test.describe('DDM-P8-T02: the Wildfire screen has a time control at every horizon', () => {
  test('current: the NIFC perimeter stamp says the product carries no single valid time', async ({
    page
  }) => {
    await stubCommon(page);
    await stubFire(page, { spc: 'outlined' });
    await gotoApp(page, '?view=console&cluster=wildfire');
    await expect(layerPill(page, 'nifc-fires')).toHaveText(PILL.live, { timeout: 25_000 });

    const stamp = await readStamp(page);
    expectStampContract('NIFC current', stamp, {
      horizon: 'current',
      register: 'observed',
      issuer: 'NIFC WFIGS'
    });
    // Clause 4: undated, said plainly, and no retrieval clock dressed as a
    // product date.
    expect(stamp.headline).toBe('Current perimeters · no single valid time');
    expect(stamp.detail).toContain('states no product date');
    expect(stamp.detail).toContain('each perimeter carries its own discovery date');
    expect(stamp.headline).not.toMatch(/\d{4}/);
    // An authored current set: no Play, no rail.
    await expect(page.locator('#time-bar [data-play]')).toHaveCount(0);
    await expect(page.locator('#time-bar .time-bar-rail')).toHaveCount(0);

    await expectChipsStillHonest(page);
  });

  test('near term: the SPC Day 1 outlook stamp is an outlook with the issuance window, and the current recipe takes the bar back', async ({
    page
  }) => {
    await stubCommon(page);
    await stubFire(page, { spc: 'outlined' });
    await gotoApp(page, '?view=console&cluster=wildfire&horizon=weeks-ahead');
    await expect(layerPill(page, 'spc-fire-weather')).toHaveText(PILL.live, { timeout: 25_000 });

    const stamp = await readStamp(page);
    expectStampContract('SPC Day 1', stamp, {
      horizon: 'nearTerm',
      register: 'outlook',
      issuer: 'NOAA SPC Day 1 Fire Weather Outlook'
    });
    // Clause 3: the period is the fixture's own valid and expire fields,
    // rendered in UTC.
    expect(stamp.headline).toBe(
      'Outlook valid Sep 8, 2026, 12:00 UTC to Sep 9, 2026, 12:00 UTC'
    );
    await expect(page.locator('#time-bar [data-play]')).toHaveCount(0);

    // The surface outranks the perimeters while it is on; when the current
    // recipe takes the outlook off, the perimeters' statement returns rather
    // than leaving the screen with no time control.
    await page.locator('.shell-horizon-btn[data-horizon="current"]').click();
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText(
      'Current perimeters · no single valid time',
      { timeout: 25_000 }
    );
    await expect(page.locator('#time-bar')).toHaveAttribute('data-register', 'observed');
  });

  test('near term with no area outlined: the outlook stamp says the response states no valid period', async ({
    page
  }) => {
    await stubCommon(page);
    await stubFire(page, { spc: 'empty' });
    await gotoApp(page, '?view=console&cluster=wildfire&horizon=weeks-ahead');
    // The layer declares its own no-data label (src/config/layers.ts), so an
    // empty issuance reads as no features, not as the generic no-data pill.
    await expect(layerPill(page, 'spc-fire-weather')).toHaveText(LIVE_NO_FEATURES_LABEL, {
      timeout: 25_000
    });

    const stamp = await readStamp(page);
    expectStampContract('SPC Day 1 (empty issuance)', stamp, {
      horizon: 'nearTerm',
      register: 'outlook',
      issuer: 'NOAA SPC Day 1 Fire Weather Outlook'
    });
    // Clause 4: no window is invented from the calendar.
    expect(stamp.headline).toBe('Outlook · valid period not stated by the response');
    expect(stamp.detail).toContain('an empty response states no valid period');
    expect(stamp.headline).not.toMatch(/\d{4}/);
  });

  test('long range: the Wildfire Hazard Potential stamp names a static edition, not a dated condition', async ({
    page
  }) => {
    await stubCommon(page);
    await stubFire(page, { spc: 'outlined' });
    await gotoApp(page, '?view=console&cluster=wildfire&horizon=season-ahead');
    await expect(layerPill(page, 'usfs-whp')).toHaveText(PILL.live, { timeout: 25_000 });

    const stamp = await readStamp(page);
    expectStampContract('WHP', stamp, {
      horizon: 'longRange',
      register: 'observed',
      issuer: 'USDA Forest Service Wildfire Hazard Potential'
    });
    expect(stamp.headline).toBe('Static 2023 edition · not a dated condition');
    expect(stamp.detail).toContain('not current fire conditions and not an outlook');
    await expect(page.locator('#time-bar [data-play]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Extreme Heat
// ---------------------------------------------------------------------------

test.describe('DDM-P8-T02: the Extreme Heat screen has a seven-day time control', () => {
  test('a ready day: the period is the frame, the register follows whether the period has begun, and three controls share one day', async ({
    page
  }) => {
    await page.clock.setFixedTime(CLOCK_IN_WINDOW);
    await stubCommon(page);
    await stubHeat(page);
    await gotoApp(page, '?view=console&cluster=heat&heatday=3');
    await expect(layerPill(page, 'heatrisk')).toHaveText(PILL.live, { timeout: 25_000 });

    // Day 3: 12:00 UTC Jul 30 to 12:00 UTC Jul 31, and the clock says 18:00
    // UTC Jul 30. The period is in progress and the value is still the
    // issuer's forecast (HeatRisk "provides a forecast of the potential
    // level of risk for heat-related impacts to occur over a 24-hour
    // period", calculated "from the current date through seven days in the
    // future"; the v2.6 Overview), so the step stays in the outlook
    // register and the product's own horizon, Near Term.
    const day3 = await readStamp(page);
    expectStampContract('HeatRisk day 3 (in progress)', day3, {
      horizon: 'nearTerm',
      register: 'outlook',
      issuer: 'NWS HeatRisk'
    });
    expect(day3.headline).toBe(
      'Outlook valid Jul 30, 2026, 12:00 UTC to Jul 31, 2026, 12:00 UTC'
    );
    expect(day3.detail).toContain('Day 3 of 7');
    expect(day3.detail).toContain('now in progress');

    // An authored, stepped product: a discrete seven-stop rail, no Play.
    const rail = page.locator('#time-bar .time-bar-rail');
    await expect(rail).toHaveAttribute('max', '6');
    await expect(rail).toHaveValue('2');
    await expect(page.locator('#time-bar [data-play]')).toHaveCount(0);
    for (const step of [0, 3, 6]) {
      await rail.evaluate((el, i) => {
        (el as HTMLInputElement).value = String(i);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, step);
      const spoken = (await rail.getAttribute('aria-valuetext')) ?? '';
      expect(spoken).toMatch(/^Day [1-7] · [A-Z][a-z]{2} \d{1,2}, 2026, 12:00 UTC$/);
      expectNoForecastLanguage(`rail stop ${step}`, spoken);
    }
    await rail.evaluate((el) => {
      (el as HTMLInputElement).value = '2';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Step forward to day 4: a period that has not begun is an outlook, and
    // the step is the same day change the key's select and the URL record.
    await page.locator('#time-bar [data-step="1"]').click();
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText(
      'Outlook valid Jul 31, 2026, 12:00 UTC to Aug 1, 2026, 12:00 UTC',
      { timeout: 25_000 }
    );
    const day4 = await readStamp(page);
    expectStampContract('HeatRisk day 4 (not begun)', day4, {
      horizon: 'nearTerm',
      register: 'outlook',
      issuer: 'NWS HeatRisk'
    });
    expect(day4.detail).toContain('Day 4 of 7');
    expect(day4.detail).toContain('has not begun');
    await expect.poll(() => heatDay(page)).toBe('4');
    await expect(page.locator('#map-key select[data-heatrisk-day]')).toHaveValue('4');
    await expect(rail).toHaveValue('3');

    // Back to day 1 through the rail itself: that period has ended, and the
    // stamp says so instead of presenting a spent outlook as one still in force.
    await rail.evaluate((el) => {
      (el as HTMLInputElement).value = '0';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText(
      'Period ended Jul 29, 2026, 12:00 UTC',
      { timeout: 25_000 }
    );
    const day1 = await readStamp(page);
    expectStampContract('HeatRisk day 1 (ended)', day1, {
      horizon: 'nearTerm',
      register: 'observed',
      issuer: 'NWS HeatRisk'
    });
    expect(day1.detail).toContain('Day 1 of 7');
    expect(day1.detail).toContain('has ended');
    await expect.poll(() => heatDay(page)).toBeNull();

    await expectChipsStillHonest(page);
  });

  test('an unavailable day: the stamp keeps the issuer and the period and says no tile loaded', async ({
    page
  }) => {
    await page.clock.setFixedTime(CLOCK_IN_WINDOW);
    await stubCommon(page);
    await stubHeat(page, { failTime: HEAT_TIMES[4] });
    await gotoApp(page, '?view=console&cluster=heat&heatday=5');

    // The frame watcher's deadline turns the failed day into `unavailable`
    // without tearing the layer down (the status settles after activation),
    // so the time control stays and describes the surface honestly.
    await expect(layerPill(page, 'heatrisk')).toHaveText(PILL.unavailable, { timeout: 25_000 });
    await expect(page.locator('#time-bar .time-bar-stamp-detail')).toContainText(
      'no tile of the selected day loaded',
      { timeout: 25_000 }
    );
    const stamp = await readStamp(page);
    expectStampContract('HeatRisk day 5 (unavailable)', stamp, {
      horizon: 'nearTerm',
      register: 'outlook',
      issuer: 'NWS HeatRisk'
    });
    expect(stamp.headline).toBe('Outlook valid Aug 1, 2026, 12:00 UTC to Aug 2, 2026, 12:00 UTC');
    expect(stamp.detail).toContain('Day 5 of 7');
  });

  test('a stale window: every advertised period has ended and no frame is labelled an outlook', async ({
    page
  }) => {
    await page.clock.setFixedTime(CLOCK_AFTER_WINDOW);
    await stubCommon(page);
    await stubHeat(page);
    await gotoApp(page, '?view=console&cluster=heat');
    await expect(layerPill(page, 'heatrisk')).toHaveText(PILL.live, { timeout: 25_000 });

    const first = await readStamp(page);
    expectStampContract('HeatRisk stale day 1', first, {
      horizon: 'nearTerm',
      register: 'observed',
      issuer: 'NWS HeatRisk'
    });
    expect(first.headline).toBe('Period ended Jul 29, 2026, 12:00 UTC');
    expect(first.detail).toContain('has ended');

    // The newest advertised day has ended too; stepping to it must not turn
    // a spent period into an outlook.
    const rail = page.locator('#time-bar .time-bar-rail');
    await rail.evaluate((el) => {
      (el as HTMLInputElement).value = '6';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText(
      'Period ended Aug 4, 2026, 12:00 UTC',
      { timeout: 25_000 }
    );
    const last = await readStamp(page);
    expectStampContract('HeatRisk stale day 7', last, {
      horizon: 'nearTerm',
      register: 'observed',
      issuer: 'NWS HeatRisk'
    });
    expect(last.detail).toContain('Day 7 of 7');
  });

  test('long range: no heat surface exists, and the time row says so rather than borrowing a stamp', async ({
    page
  }) => {
    await page.clock.setFixedTime(CLOCK_IN_WINDOW);
    await stubCommon(page);
    await stubHeat(page);
    await gotoApp(page, '?view=console&cluster=heat&horizon=season-ahead');

    // The season-ahead heat recipe is deliberately empty
    // (src/config/clusters.ts): nothing is displayed, so no stamp may claim
    // a period. The compact WHEN row's honest empty state is the statement.
    await expect(page.locator('#shell-time .shell-time-empty')).toHaveText(
      'No dated product is displayed.'
    );
    await expect(page.locator('#time-bar')).toBeHidden();
    await expect(layerPill(page, 'heatrisk')).toHaveText('');
  });
});

// ---------------------------------------------------------------------------
// The other two screens carry the same grammar
// ---------------------------------------------------------------------------

test.describe('DDM-P8-T02: the Drought and ENSO screens state their horizon in the same grammar', () => {
  test('drought (the default screen): the continental monitor stamp reads Current Conditions', async ({
    page
  }) => {
    await stubCommon(page);
    await gotoApp(page, '?view=console');
    await expect(layerPill(page, 'nadm-drought')).toHaveText(PILL.live, { timeout: 25_000 });
    const stamp = await readStamp(page);
    expectStampContract('NADM', stamp, {
      horizon: 'current',
      register: 'observed',
      issuer: 'North American Drought Monitor'
    });
    expect(stamp.headline).toMatch(/^Consensus month /);
  });

  test('ENSO: the ocean anomaly field is Current Conditions under every horizon chip', async ({
    page
  }) => {
    await stubCommon(page);
    await stubSst(page);
    await gotoApp(page, '?view=console&cluster=enso&horizon=season-ahead&sst=2026-07-03');
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.live, { timeout: 25_000 });
    const stamp = await readStamp(page);
    // The pressed chip says Long Range; the surface is a measured daily
    // field, and the stamp says what the surface is.
    expectStampContract('SST', stamp, {
      horizon: 'current',
      register: 'observed',
      issuer: 'GHRSST MUR'
    });
    expect(stamp.headline).toBe('Observed Jul 3, 2026');
    await expect(page.locator('.shell-horizon-btn[data-horizon="season-ahead"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
