/**
 * The Nino 3.4 box popup's frame fixtures (the 'enso-box' builder of
 * tests/identify-paths-manifest.ts; the sst-anomaly layer's click target on
 * `nino34-box-fill` and `nino34-box-line`), keyed by the manifest's builder
 * id; see tests/frame-fixtures.ts.
 *
 * The box is a place on the open ocean, so the fixtures boot the ENSO mode
 * with the Pacific framing (`?cluster=enso&ocean=pacific`, which holds the
 * box: src/config/oceans.ts) and find the box by clicking down the map
 * rather than at one pixel: the production build carries no map handle, and
 * the framing's fit depends on the seat. The popup reads the bundled snapshot
 * (public/data/enso-indices.json, served by the app itself; the census's
 * catch-all 503 only answers external hosts), and the fixture waits for that
 * response before it clicks, so the popup is the ready one with its source
 * link, its base-period notes and the RONI sparkline. The expected source
 * comes from the same file, so a snapshot refresh moves both together.
 *
 * The click is on the open ocean, outside every supported place, so the
 * coordinator offers no late briefing door and the response never routes to
 * the panel-foot sink. These boots select no place and keep the national
 * view, which has no briefing of its own, so the popup's own door (the
 * selected place, else the region's briefing) is absent here too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { CensusFixture, CensusHelpers, TierFixture } from './frame-fixtures';
import { expectHeadVisibleBodyScrolls, readCard, settleCard } from './frame-fixtures-fires-labels';
import { COMPACT_BODY_HEIGHT_PX, FULL_HEIGHT_PX, USABLE_WIDTH_PX, bodyLineReachable, embedRegion, strictHit } from './frame-fixtures-events-stations';
import { gotoApp, waitForLayerSettled } from './helpers';

const ID = 'enso-box';
const LAYER_KEY = 'sst-anomaly';
const BOX_RESPONSE = /^nino34-box-(fill|line)$/;
const SNAPSHOT_PATH = join(process.cwd(), 'public', 'data', 'enso-indices.json');

/** The primary source the popup states: the RONI index the head reads first (src/ui/enso-box-popup.ts). */
function expectedSource(): { readonly label: string; readonly href: string } {
  const json = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as { roni: { source: string; sourceUrl: string } };
  return { label: json.roni.source, href: json.roni.sourceUrl };
}

/** Boot the ENSO mode on the Pacific and wait for the popup's snapshot read; `extra` adds query keys (`&embed=true`). */
async function bootEnsoBox(page: Page, options: { readonly view?: 'console' | 'brief'; readonly extra?: string } = {}): Promise<void> {
  const snapshot = page.waitForResponse((r) => r.url().includes('/data/enso-indices.json'), { timeout: 30_000 });
  await gotoApp(page, `?cluster=enso&ocean=pacific&view=${options.view ?? 'console'}&basemap=default${options.extra ?? ''}`);
  await waitForLayerSettled(page, LAYER_KEY);
  await snapshot;
}

/**
 * Click points down the map, nearest the expected box row first (the Pacific
 * fit puts the equator in the lower half), centre column first, then two
 * side columns. Only points where the map canvas is the topmost element are
 * kept (the embed's overlays cover parts of a small map).
 */
async function boxProbes(page: Page): Promise<{ x: number; y: number }[]> {
  const found = await page.evaluate(() => {
    const map = document.getElementById('map');
    const canvas = map?.querySelector('canvas.maplibregl-canvas') ?? null;
    if (!map || !canvas) return { points: [], error: 'no map canvas' };
    const r = map.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, window.innerWidth);
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const width = right - left;
    const cx = (left + right) / 2;
    const guess = (top + bottom) / 2 + 0.3 * (bottom - top);
    const rows: number[] = [];
    for (let y = top + 6; y < bottom - 6; y += 12) rows.push(y);
    rows.sort((a, b) => Math.abs(a - guess) - Math.abs(b - guess));
    const points: { x: number; y: number }[] = [];
    for (const dx of [0, -0.15 * width, 0.15 * width]) {
      for (const y of rows) {
        const x = cx + dx;
        if (document.elementFromPoint(x, y) === canvas) points.push({ x, y });
      }
    }
    if (points.length > 0) return { points, error: null };
    const over = document.elementFromPoint(cx, (top + bottom) / 2);
    const name = over ? `${over.tagName.toLowerCase()}${over.id ? `#${over.id}` : ''}.${Array.from(over.classList).join('.')}` : 'nothing';
    return { points: [], error: `no probe point of the map canvas is uncovered; ${name} is over the centre` };
  });
  if (found.error !== null) throw new Error(found.error);
  return found.points;
}

/** The response layer id the map popup currently shows, or null. */
async function shownResponse(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const root = document.querySelector('.maplibregl-popup .maplibregl-popup-content > .coordinated-response');
    return root?.getAttribute('data-ddm-response') ?? null;
  });
}

/** Click down the map until the popup shows the box's response. */
async function clickEnsoBox(page: Page): Promise<void> {
  const points = await boxProbes(page);
  let probe = 0;
  await expect(async () => {
    const point = points[probe++ % points.length]!;
    if ((await page.locator('.maplibregl-popup').count()) > 0) await page.keyboard.press('Escape');
    await page.mouse.click(point.x, point.y);
    await expect
      .poll(() => shownResponse(page), { message: `${ID}: a box response after a click at ${Math.round(point.x)},${Math.round(point.y)}`, timeout: 600 })
      .toMatch(BOX_RESPONSE);
  }).toPass({ timeout: 60_000, intervals: [50] });
}

// ---------------------------------------------------------------------------
// The census fixture
// ---------------------------------------------------------------------------

const censusFixture: CensusFixture = async (page: Page, h: CensusHelpers) => {
  await bootEnsoBox(page);
  await clickEnsoBox(page);
  await expect
    .poll(async () => (await h.readAudit(page)).seen.some((entry) => /^map:nino34-box-(fill|line)$/.test(entry)), { timeout: 5_000 })
    .toBe(true);
  // The ONE validator (window.__ddmFrameCheck), as every census fixture asks.
  const verdict = await page.evaluate(() => {
    const w = window as unknown as { __ddmFrameCheck?: (root: Element, sink: Element) => string | null };
    const sink = document.querySelector('.maplibregl-popup .maplibregl-popup-content');
    const root = sink?.querySelector(':scope > [data-popup-frame]') ?? sink?.querySelector(':scope > .coordinated-response');
    if (!sink || !root) return 'no coordinated response in the map sink';
    if (!w.__ddmFrameCheck) return 'the frame validator is not installed';
    return w.__ddmFrameCheck(root, sink);
  });
  expect(verdict, `${ID}: the displayed response is a valid frame`).toBeNull();
  // The snapshot was read before the click, so this is the ready popup: its sparkline is drawn into the body.
  await expect(page.locator('.maplibregl-popup [data-popup-chart="enso-box-roni"] svg'), `${ID}: the RONI sparkline`).toHaveCount(1, { timeout: 10_000 });
  expect((await h.readAudit(page)).violations, `${ID}: observer violations`).toEqual([]);
};

export const ENSO_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {
  [ID]: censusFixture
};

// ---------------------------------------------------------------------------
// The PF3 tier fixture (the pattern of tests/frame-fixtures-events-stations.ts)
// ---------------------------------------------------------------------------

const tierFixture: TierFixture = {
  async sourcesAtTierBoundaries(page) {
    const source = expectedSource();
    await page.setViewportSize({ width: 360, height: 300 });
    await bootEnsoBox(page, { extra: '&embed=true' });
    await clickEnsoBox(page);
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
      expect(at(), `${ID} ${tier.name}: the measured region ${tier.axis} sits at the boundary`).toBeGreaterThanOrEqual(tier.min);
      expect(at(), `${ID} ${tier.name}: the measured region ${tier.axis} sits at the boundary`).toBeLessThanOrEqual(tier.max);
      if (tier.axis === 'height') expect(r.w, `${ID} ${tier.name}: the measured region is usable wide`).toBeGreaterThanOrEqual(USABLE_WIDTH_PX);
      else expect(r.h, `${ID} ${tier.name}: the measured region is FULL tall`).toBeGreaterThanOrEqual(FULL_HEIGHT_PX);
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
          { message: `${ID} ${tier.name}: the card is contained in the region`, timeout: 10_000 }
        )
        .toBe('ok');
      // The primary source, body-reachable under squeeze (PF3).
      const link = body.locator(':scope > [data-popup-slot="source-fallback"] a');
      await expect(link).toHaveAttribute('href', source.href);
      await expect(link).toHaveText(source.label);
      await expect
        .poll(() => bodyLineReachable(link, 'first'), { message: `${ID} ${tier.name}: the primary source is hit-test reachable`, timeout: 7_000 })
        .toBe('ok');
      // The last qualification: the base-period notes.
      const notes = body.locator(':scope > [data-popup-slot="note"]');
      await expect(notes, `${ID}: the popup carries its base-period notes`).not.toHaveCount(0);
      await expect
        .poll(() => bodyLineReachable(notes.last(), 'last'), { message: `${ID} ${tier.name}: the last qualification is scroll-reachable`, timeout: 7_000 })
        .toBe('ok');
      await expect(body.locator(':scope > [data-popup-slot="more-links"] a'), `${ID}: no more links`).toHaveCount(0);
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
    await page.setViewportSize(seats[0]);
    await bootEnsoBox(page);
    const popup = page.locator('.maplibregl-popup');
    for (const seat of seats) {
      await page.setViewportSize(seat);
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await clickEnsoBox(page);
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

    // The panel half: the response is non-place, so it never routes to the
    // panel-foot sink; in the Brief shell with the sidebar open it opens the
    // map popup.
    await page.setViewportSize({ width: 1440, height: 900 });
    await bootEnsoBox(page, { view: 'brief' });
    await clickEnsoBox(page);
    await expect(page.locator('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]')).toHaveCount(1);
    await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
  }
};

export const ENSO_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {
  [ID]: tierFixture
};
