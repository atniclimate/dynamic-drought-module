/**
 * The six CPC outlook popups' frame fixtures (the 'cpc-seasonal-*',
 * 'cpc-610-*' and 'cpc-814-*' builders of tests/identify-paths-manifest.ts;
 * one condition-surface click target on each `<key>-fill`,
 * src/layers/cpc-seasonal-outlook.ts bindPopups), keyed by the manifest's
 * builder id; see tests/frame-fixtures.ts.
 *
 * gotoApp answers every outlook's national read with small squares near 40N
 * (tests/helpers.ts stubCpcSeasonalOutlookMaps), off the fitted Washington
 * map. Each fixture claims gotoApp's two CPC stubs first, so gotoApp's own
 * calls are no-ops, then answers its layer's national read with one polygon
 * over the fitted Washington map (the later page route wins), with the
 * shared stub's class clocks: the seasonal SON 2026 issued 2026-09-01, the
 * day-range Nov 11 to 15, 2026 issued 2026-11-05. It boots ONLY its layer and
 * clicks the map (its centre when uncovered). The popup carries no note: its
 * body is the later clocks and the source, so the last body line the tier rows
 * reach is the last of the more clocks.
 *
 * Every click is inside Washington, so the coordinator's late place door
 * lands after the paint (as for the surfaces, tests/frame-fixtures-surfaces.ts);
 * the long-head rows wait for it before they read the settled card.
 */
import { expect, type Page } from '@playwright/test';
import type { CensusFixture, CensusHelpers, TierFixture } from './frame-fixtures';
import { expectHeadVisibleBodyScrolls, readCard, settleCard } from './frame-fixtures-fires-labels';
import { COMPACT_BODY_HEIGHT_PX, FULL_HEIGHT_PX, USABLE_WIDTH_PX, bodyLineReachable, embedRegion, strictHit } from './frame-fixtures-events-stations';
import { mapClickPoint } from './frame-fixtures-surfaces';
import { gotoApp, stubCpcSeasonalOutlookMaps, stubCpcSeasonalTempOutlook, waitForLayerSettled } from './helpers';

interface OutlookCase {
  /** The layer's national query path (src/layers/cpc-seasonal-read.ts; each day-range service: 0 temperature, 1 precipitation). */
  readonly path: string;
  readonly seasonal: boolean;
  /** The popup's primary source: the layer name, linking the issuer page (src/layers/cpc-seasonal-outlook.ts SOURCE_HREF). */
  readonly source: { readonly label: string; readonly href: string };
}

const OUTLOOKS_PATH = '/vector/rest/services/outlooks';
const SEASONAL_HREF = 'https://www.cpc.ncep.noaa.gov/products/predictions/long_range/';
const EXTENDED_HREF = 'https://www.cpc.ncep.noaa.gov/';

const OUTLOOK_CASES: Readonly<Record<string, OutlookCase>> = {
  'cpc-seasonal-precip': { path: `${OUTLOOKS_PATH}/cpc_sea_precip_outlk/MapServer/0/query`, seasonal: true, source: { label: 'Seasonal Precipitation Outlook', href: SEASONAL_HREF } },
  'cpc-seasonal-temp': { path: `${OUTLOOKS_PATH}/cpc_sea_temp_outlk/MapServer/0/query`, seasonal: true, source: { label: 'Seasonal Temperature Outlook', href: SEASONAL_HREF } },
  'cpc-610-precip': { path: `${OUTLOOKS_PATH}/cpc_6_10_day_outlk/MapServer/1/query`, seasonal: false, source: { label: '6-10 Day Precipitation Outlook', href: EXTENDED_HREF } },
  'cpc-610-temp': { path: `${OUTLOOKS_PATH}/cpc_6_10_day_outlk/MapServer/0/query`, seasonal: false, source: { label: '6-10 Day Temperature Outlook', href: EXTENDED_HREF } },
  'cpc-814-precip': { path: `${OUTLOOKS_PATH}/cpc_8_14_day_outlk/MapServer/1/query`, seasonal: false, source: { label: '8-14 Day Precipitation Outlook', href: EXTENDED_HREF } },
  'cpc-814-temp': { path: `${OUTLOOKS_PATH}/cpc_8_14_day_outlk/MapServer/0/query`, seasonal: false, source: { label: '8-14 Day Temperature Outlook', href: EXTENDED_HREF } }
};

/** One Above 50% polygon (a class in both renderers) over the fitted Washington map. */
function broadOutlook(seasonal: boolean): unknown {
  const clock = seasonal
    ? { valid_seas: 'SON 2026', fcst_date: Date.UTC(2026, 8, 1) }
    : { fcst_date: Date.UTC(2026, 10, 5), start_date: Date.UTC(2026, 10, 11), end_date: Date.UTC(2026, 10, 15) };
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { cat: 'Above', prob: 50, ...clock },
        geometry: { type: 'Polygon', coordinates: [[[-140, 20], [-50, 20], [-50, 75], [-140, 75], [-140, 20]]] }
      }
    ]
  };
}

/** Route and boot one outlook alone; `extra` adds query keys (`&embed=true`). */
async function bootOutlook(page: Page, id: string, options: { readonly view?: 'console' | 'brief'; readonly extra?: string } = {}): Promise<void> {
  const c = OUTLOOK_CASES[id]!;
  await stubCpcSeasonalTempOutlook(page);
  await stubCpcSeasonalOutlookMaps(page);
  await page.route(
    (url) => url.pathname === c.path && !url.searchParams.has('geometry'),
    (route) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(broadOutlook(c.seasonal)) })
  );
  await gotoApp(page, `?region=washington_state&view=${options.view ?? 'console'}&layers=${id}${options.extra ?? ''}`);
  await waitForLayerSettled(page, id);
}

/** The response layer id the map popup currently shows, or null. */
async function shownResponse(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const root = document.querySelector('.maplibregl-popup .maplibregl-popup-content > .coordinated-response');
    return root?.getAttribute('data-ddm-response') ?? null;
  });
}

/** Click the map (its centre when uncovered) until the popup shows the outlook's response. */
async function clickUntilOutlookResponse(page: Page, id: string): Promise<void> {
  const point = await mapClickPoint(page);
  await expect(async () => {
    await page.mouse.click(point.x, point.y);
    await expect
      .poll(() => shownResponse(page), { message: `${id}: a response after a click at ${Math.round(point.x)},${Math.round(point.y)}`, timeout: 1500 })
      .toBe(`${id}-fill`);
  }).toPass({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// The census fixtures
// ---------------------------------------------------------------------------

function censusFixture(id: string): CensusFixture {
  return async (page: Page, h: CensusHelpers) => {
    await bootOutlook(page, id);
    await clickUntilOutlookResponse(page, id);
    await expect.poll(async () => (await h.readAudit(page)).seen, { timeout: 5_000 }).toContain(`map:${id}-fill`);
    // The ONE validator (window.__ddmFrameCheck), as every census fixture asks.
    const verdict = await page.evaluate(() => {
      const w = window as unknown as { __ddmFrameCheck?: (root: Element, sink: Element) => string | null };
      const sink = document.querySelector('.maplibregl-popup .maplibregl-popup-content');
      const root = sink?.querySelector(':scope > [data-popup-frame]') ?? sink?.querySelector(':scope > .coordinated-response');
      if (!sink || !root) return 'no coordinated response in the map sink';
      if (!w.__ddmFrameCheck) return 'the frame validator is not installed';
      return w.__ddmFrameCheck(root, sink);
    });
    expect(verdict, `${id}: the displayed response is a valid frame`).toBeNull();
    expect((await h.readAudit(page)).violations, `${id}: observer violations`).toEqual([]);
  };
}

export const CPC_OUTLOOK_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = Object.fromEntries(
  Object.keys(OUTLOOK_CASES).map((id) => [id, censusFixture(id)])
);

// ---------------------------------------------------------------------------
// The PF3 tier fixtures (the pattern of tests/frame-fixtures-enso.ts)
// ---------------------------------------------------------------------------

function tierFixture(id: string): TierFixture {
  const c = OUTLOOK_CASES[id]!;
  return {
    async sourcesAtTierBoundaries(page) {
      await page.setViewportSize({ width: 360, height: 300 });
      await bootOutlook(page, id, { extra: '&embed=true' });
      await clickUntilOutlookResponse(page, id);
      const content = page.locator('.maplibregl-popup .maplibregl-popup-content');
      const body = content.locator('[data-popup-region="body"]');
      const tiers = [
        // The FULL boundary: a region 91 to 93px tall (FULL starts at 91).
        { name: 'FULL', axis: 'height', target: FULL_HEIGHT_PX + 1, min: FULL_HEIGHT_PX, max: FULL_HEIGHT_PX + 2, compact: false },
        // The usable-COMPACT boundary: a region at the 47px usable-body threshold.
        { name: 'usable COMPACT', axis: 'height', target: COMPACT_BODY_HEIGHT_PX + 0.5, min: COMPACT_BODY_HEIGHT_PX, max: COMPACT_BODY_HEIGHT_PX + 2, compact: true },
        // The FULL width boundary: a region 88 to 89px wide (FULL needs 88), 300px tall.
        { name: 'FULL width', axis: 'width', target: USABLE_WIDTH_PX + 0.25, min: USABLE_WIDTH_PX, max: USABLE_WIDTH_PX + 0.99, compact: false }
      ] as const;
      for (const tier of tiers) {
        if (tier.axis === 'width') await page.setViewportSize({ width: 360, height: 300 });
        let r = await embedRegion(page);
        const at = (): number => (tier.axis === 'height' ? r.h : r.w);
        for (let attempt = 0; attempt < 4 && (at() < tier.min || at() > tier.max); attempt++) {
          const vp = page.viewportSize()!;
          await page.setViewportSize(
            tier.axis === 'height'
              ? { width: 360, height: Math.round(vp.height + (tier.target - r.h)) }
              : { width: Math.round(vp.width + (tier.target - r.w)), height: 300 }
          );
          r = await embedRegion(page);
        }
        expect(at(), `${id} ${tier.name}: the measured region ${tier.axis} sits at the boundary`).toBeGreaterThanOrEqual(tier.min);
        expect(at(), `${id} ${tier.name}: the measured region ${tier.axis} sits at the boundary`).toBeLessThanOrEqual(tier.max);
        if (tier.axis === 'height') expect(r.w, `${id} ${tier.name}: the measured region is usable wide`).toBeGreaterThanOrEqual(USABLE_WIDTH_PX);
        else expect(r.h, `${id} ${tier.name}: the measured region is FULL tall`).toBeGreaterThanOrEqual(FULL_HEIGHT_PX);
        if (tier.compact) await expect(content).toHaveClass(/\bddm-popup-compact\b/);
        else await expect(content).not.toHaveClass(/\bddm-popup-compact\b/);
        await expect
          .poll(
            async () => {
              const region = await embedRegion(page);
              const box = await content.boundingBox();
              if (!box) return 'no box';
              return box.y >= region.top - 1 && box.x >= region.left - 1 && box.y + box.height <= region.bottom + 1 && box.x + box.width <= region.right + 1
                ? 'ok'
                : JSON.stringify(box);
            },
            { message: `${id} ${tier.name}: the card is contained in the region`, timeout: 10_000 }
          )
          .toBe('ok');
        // The primary source, body-reachable under squeeze (PF3).
        const link = body.locator(':scope > [data-popup-slot="source-fallback"] a');
        await expect(link).toHaveAttribute('href', c.source.href);
        await expect(link).toHaveText(c.source.label);
        await expect
          .poll(() => bodyLineReachable(link, 'first'), { message: `${id} ${tier.name}: the primary source is hit-test reachable`, timeout: 7_000 })
          .toBe('ok');
        // No note: the last qualification is the last of the later clocks (the Forecast Date).
        await expect(body.locator(':scope > [data-popup-slot="note"]'), `${id}: the popup carries no note`).toHaveCount(0);
        const lastClock = body.locator(':scope > [data-popup-slot="more-clocks"] > p').last();
        await expect(lastClock).toContainText('Forecast Date');
        await expect
          .poll(() => bodyLineReachable(lastClock, 'last'), { message: `${id} ${tier.name}: the last later clock is scroll-reachable`, timeout: 7_000 })
          .toBe('ok');
        await expect(body.locator(':scope > [data-popup-slot="more-links"] a'), `${id}: no more links`).toHaveCount(0);
        await expect
          .poll(() => strictHit(content.locator(':scope > .maplibregl-popup-close-button')), {
            message: `${id} ${tier.name}: the close control is hit-test reachable`,
            timeout: 7_000
          })
          .toBe('ok');
      }
    },

    async longHeadAndPanel(page) {
      const seats = [
        { width: 1280, height: 720 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 }
      ] as const;
      await page.setViewportSize(seats[0]);
      await bootOutlook(page, id);
      const popup = page.locator('.maplibregl-popup');
      for (const seat of seats) {
        await page.setViewportSize(seat);
        await page.keyboard.press('Escape');
        await expect(popup).toHaveCount(0);
        await clickUntilOutlookResponse(page, id);
        const at = `${id} at ${seat.width}x${seat.height}`;
        await expect(page.locator('.maplibregl-popup [data-popup-frame]'), `${at}: the response is a framed card`).toHaveCount(1);
        // The late place door grows the head after the paint; read the card once it has landed and held still.
        await expect(
          page.locator(
            '.maplibregl-popup .maplibregl-popup-content > [data-popup-frame] > [data-popup-region="head"] > [data-popup-slot="actions"] > [data-ddm-impact-trigger]'
          ),
          `${at}: the late door in the actions slot`
        ).toBeVisible({ timeout: 10_000 });
        await settleCard(page);
        expectHeadVisibleBodyScrolls(await readCard(page), at);
        await expect
          .poll(() => strictHit(page.locator('.maplibregl-popup .maplibregl-popup-content > .maplibregl-popup-close-button')), {
            message: `${at}: the close control is hit-test reachable`,
            timeout: 7_000
          })
          .toBe('ok');
      }

      // The panel half: an outlook response is non-place, so it never routes
      // to the panel-foot sink; in the Brief shell with the sidebar open it
      // opens the map popup.
      await page.setViewportSize({ width: 1440, height: 900 });
      await bootOutlook(page, id, { view: 'brief' });
      await clickUntilOutlookResponse(page, id);
      await expect(page.locator('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]')).toHaveCount(1);
      await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
    }
  };
}

export const CPC_OUTLOOK_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = Object.fromEntries(
  Object.keys(OUTLOOK_CASES).map((id) => [id, tierFixture(id)])
);
