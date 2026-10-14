/**
 * The tropical cyclones popup's frame fixtures (the 'tropical' builder of
 * tests/identify-paths-manifest.ts; the tropical-cyclones layer's click
 * target on its points, watch-warning lines and cone fill), keyed by the
 * manifest's builder id; see tests/frame-fixtures.ts. The pattern is
 * tests/frame-fixtures-enso.ts.
 *
 * The storm is the fixture's Hurricane Simon (EP5, advisory 24) off western
 * Mexico, served by the `occupiedOne` arm of tests/tropical-fixtures.ts
 * through gotoApp's `tropical` option; the Mexico framing holds it. The
 * production build carries no map handle, so the fixtures find the storm by
 * clicking a grid of map points, nearest the expected storm position first,
 * until the popup shows one of the layer's responses.
 *
 * The click is on the open ocean, outside every supported place, so the
 * response never routes to the panel-foot sink.
 */
import { expect, type Page } from '@playwright/test';
import type { CensusFixture, CensusHelpers, TierFixture } from './frame-fixtures';
import { expectHeadVisibleBodyScrolls, readCard, settleCard } from './frame-fixtures-fires-labels';
import { COMPACT_BODY_HEIGHT_PX, FULL_HEIGHT_PX, USABLE_WIDTH_PX, bodyLineReachable, embedRegion, strictHit } from './frame-fixtures-events-stations';
import { gotoApp, waitForLayerSettled } from './helpers';

const ID = 'tropical';
const LAYER_KEY = 'tropical-cyclones';
const RESPONSE = /^tropical-cyclones-(points|ww|cone-fill)$/;
/** The source the popup states for an EP slot (src/config/tropical-presentation.ts TROPICAL_ISSUERS.nhc). */
const SOURCE = { label: 'National Hurricane Center', href: 'https://www.nhc.noaa.gov/' } as const;

/** Boot the occupied fixture on the Mexico framing; `extra` adds query keys (`&embed=true`). */
export async function bootStorm(page: Page, options: { readonly view?: 'console' | 'brief'; readonly extra?: string } = {}): Promise<void> {
  await gotoApp(page, `?framing=mexico&view=${options.view ?? 'console'}&layers=${LAYER_KEY}&basemap=default${options.extra ?? ''}`, {
    tropical: 'occupiedOne'
  });
  await waitForLayerSettled(page, LAYER_KEY);
}

/** Map points on the uncovered canvas, nearest the storm's expected spot (left of centre, below the middle) first. */
async function stormProbes(page: Page): Promise<{ x: number; y: number }[]> {
  const found = await page.evaluate(() => {
    const map = document.getElementById('map');
    const canvas = map?.querySelector('canvas.maplibregl-canvas') ?? null;
    if (!map || !canvas) return { points: [], error: 'no map canvas' };
    const r = map.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, window.innerWidth);
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const gx = left + 0.36 * (right - left);
    const gy = top + 0.6 * (bottom - top);
    const points: { x: number; y: number }[] = [];
    for (let y = top + 6; y < bottom - 6; y += 8) {
      for (let x = left + 6; x < right - 6; x += 8) {
        if (document.elementFromPoint(x, y) === canvas) points.push({ x, y });
      }
    }
    points.sort((a, b) => Math.hypot(a.x - gx, a.y - gy) - Math.hypot(b.x - gx, b.y - gy));
    return points.length > 0 ? { points, error: null } : { points, error: 'no probe point of the map canvas is uncovered' };
  });
  if (found.error !== null) throw new Error(found.error);
  return found.points;
}

async function shownResponse(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const root = document.querySelector('.maplibregl-popup .maplibregl-popup-content > .coordinated-response');
    return root?.getAttribute('data-ddm-response') ?? null;
  });
}

/** Click down the grid until the popup shows a tropical cyclones response. */
export async function clickStorm(page: Page): Promise<void> {
  const points = await stormProbes(page);
  let probe = 0;
  await expect(async () => {
    const point = points[probe++ % points.length]!;
    if ((await page.locator('.maplibregl-popup').count()) > 0) await page.keyboard.press('Escape');
    await page.mouse.click(point.x, point.y);
    await expect
      .poll(() => shownResponse(page), { message: `${ID}: a storm response after a click at ${Math.round(point.x)},${Math.round(point.y)}`, timeout: 400 })
      .toMatch(RESPONSE);
  }).toPass({ timeout: 90_000, intervals: [50] });
}

const censusFixture: CensusFixture = async (page: Page, h: CensusHelpers) => {
  await bootStorm(page);
  await clickStorm(page);
  await expect
    .poll(async () => (await h.readAudit(page)).seen.some((entry) => /^map:tropical-cyclones-/.test(entry)), { timeout: 5_000 })
    .toBe(true);
  const verdict = await page.evaluate(() => {
    const w = window as unknown as { __ddmFrameCheck?: (root: Element, sink: Element) => string | null };
    const sink = document.querySelector('.maplibregl-popup .maplibregl-popup-content');
    const root = sink?.querySelector(':scope > [data-popup-frame]') ?? sink?.querySelector(':scope > .coordinated-response');
    if (!sink || !root) return 'no coordinated response in the map sink';
    if (!w.__ddmFrameCheck) return 'the frame validator is not installed';
    return w.__ddmFrameCheck(root, sink);
  });
  expect(verdict, `${ID}: the displayed response is a valid frame`).toBeNull();
  await expect(page.locator('.maplibregl-popup [data-popup-slot="issuer"]')).toContainText('National Hurricane Center');
  expect((await h.readAudit(page)).violations, `${ID}: observer violations`).toEqual([]);
};

export const TROPICAL_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {
  [ID]: censusFixture
};

const tierFixture: TierFixture = {
  async sourcesAtTierBoundaries(page) {
    await page.setViewportSize({ width: 360, height: 300 });
    await bootStorm(page, { extra: '&embed=true' });
    await clickStorm(page);
    const content = page.locator('.maplibregl-popup .maplibregl-popup-content');
    const body = content.locator('[data-popup-region="body"]');
    const tiers = [
      { name: 'FULL', axis: 'height', target: FULL_HEIGHT_PX + 1, min: FULL_HEIGHT_PX, max: FULL_HEIGHT_PX + 2, compact: false },
      { name: 'usable COMPACT', axis: 'height', target: COMPACT_BODY_HEIGHT_PX + 0.5, min: COMPACT_BODY_HEIGHT_PX, max: COMPACT_BODY_HEIGHT_PX + 2, compact: true },
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
      expect(at(), `${ID} ${tier.name}: the measured region ${tier.axis} sits at the boundary`).toBeGreaterThanOrEqual(tier.min);
      expect(at(), `${ID} ${tier.name}: the measured region ${tier.axis} sits at the boundary`).toBeLessThanOrEqual(tier.max);
      if (tier.compact) await expect(content).toHaveClass(/\bddm-popup-compact\b/);
      else await expect(content).not.toHaveClass(/\bddm-popup-compact\b/);
      const link = body.locator(':scope > [data-popup-slot="source-fallback"] a');
      await expect(link).toHaveAttribute('href', SOURCE.href);
      await expect(link).toHaveText(SOURCE.label);
      await expect
        .poll(() => bodyLineReachable(link, 'first'), { message: `${ID} ${tier.name}: the primary source is hit-test reachable`, timeout: 7_000 })
        .toBe('ok');
      // The last body content: the issuer's rows (basin, wind, pressure, movement).
      const rows = body.locator(':scope > [data-popup-slot="rows"]');
      await expect(rows, `${ID}: the popup carries its issuer rows`).toHaveCount(1);
      await expect
        .poll(() => bodyLineReachable(rows, 'last'), { message: `${ID} ${tier.name}: the last row is scroll-reachable`, timeout: 7_000 })
        .toBe('ok');
      await expect
        .poll(() => strictHit(content.locator(':scope > .maplibregl-popup-close-button')), {
          message: `${ID} ${tier.name}: the close control is hit-test reachable`,
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
    for (const seat of seats) {
      // Boot at each seat: a resize keeps the first seat's camera, and the storm drifts out of the probe search.
      await page.setViewportSize(seat);
      await bootStorm(page);
      await clickStorm(page);
      const at = `${ID} at ${seat.width}x${seat.height}`;
      await expect(page.locator('.maplibregl-popup [data-popup-frame]'), `${at}: the response is a framed card`).toHaveCount(1);
      await settleCard(page);
      expectHeadVisibleBodyScrolls(await readCard(page), at);
      await expect
        .poll(() => strictHit(page.locator('.maplibregl-popup .maplibregl-popup-content > .maplibregl-popup-close-button')), {
          message: `${at}: the close control is hit-test reachable`,
          timeout: 7_000
        })
        .toBe('ok');
    }
    // The panel half: a non-place response never routes to the panel-foot sink.
    await page.setViewportSize({ width: 1440, height: 900 });
    await bootStorm(page, { view: 'brief' });
    await clickStorm(page);
    await expect(page.locator('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]')).toHaveCount(1);
    await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
  }
};

export const TROPICAL_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {
  [ID]: tierFixture
};
