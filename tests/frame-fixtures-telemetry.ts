/**
 * The telemetry station builder's PF3 tier fixture (S30D D1 M26c, block 6;
 * register owner-1k, DDM-P11-T04), keyed by the manifest's builder id; see
 * tests/frame-fixtures.ts. The station popup has no click target: a station
 * is a DOM marker whose popup MapLibre opens and the InteractionCoordinator
 * adopts and paints through the frame, so this fixture opens a marker where
 * the other fixtures click the map.
 *
 * The station: the curated NRCS SNOTEL seed Stevens Pass (791) near the
 * fitted Washington centre (src/config/telemetry.ts; the seeds render with
 * no network), dragged onto an uncovered point of the map before each open
 * (the embed's dock covers the centre at small sizes). Its live read (the
 * NRCS AWDB REST data endpoint) is routed to one deterministic daily payload
 * with three elements, so the card is the longest realistic station card:
 * the head value, two more readings each with its own source and time, the
 * seven-day sparkline (drawn into the body), the retrieval time, the
 * description note, the more link and the source again. The fixture reads
 * the card only once the live read has repainted it.
 *
 * Two station-specific facts the rows below honour, neither weakening a
 * promise: (1) every viewport change ends in a moveend that re-runs the
 * layer's debounced viewport discovery, and every discovery rebuilds every
 * marker and closes an open popup with it, so each row waits for the markers
 * to hold still and opens the popup again before it reads; (2) an adopted
 * popup has no Escape handler and is offered no late briefing door (the
 * marker is the subject; the coordinator attaches the door only to its own
 * popup), so it is closed with its own close control and the row asserts
 * the door's absence.
 */
import { expect, type Page, type Route } from '@playwright/test';
import type { TierFixture } from './frame-fixtures';
import { FRAMED_LATE_DOOR, expectHeadVisibleBodyScrolls, readCard, settleCard } from './frame-fixtures-fires-labels';
import {
  COMPACT_BODY_HEIGHT_PX,
  FULL_HEIGHT_PX,
  USABLE_WIDTH_PX,
  bodyLineReachable,
  embedRegion,
  strictHit
} from './frame-fixtures-events-stations';
import { gotoApp, waitForLayerSettled } from './helpers';

/** The adopted station popup's displayed frame root. */
export const STATION_FRAME = '.maplibregl-popup[data-ddm-external-response] .maplibregl-popup-content > [data-popup-frame]';

/** The candidate SNOTEL seeds, in turn, with the links the card must carry (src/config/telemetry.ts). */
const STATIONS = [
  {
    id: 'snotel_791',
    source: { label: 'NRCS station page', href: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=791' }
  },
  {
    id: 'snotel_711',
    source: { label: 'NRCS station page', href: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=711' }
  }
] as const;
const MORE_LINKS = [
  { label: 'WA Water Supply Outlook', href: 'https://www.nrcs.usda.gov/wps/portal/wcc/home/quicklinks/states/wa/' }
] as const;

type StationCase = (typeof STATIONS)[number];

/** Seven daily values per element (the AWDB REST shape src/util/awdb.ts parses). */
function awdbBody(): string {
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  const element = (elementCode: string, values: readonly number[]) => ({
    stationElement: { elementCode, storedUnitCode: 'in' },
    values: values.map((value, i) => ({ date: days[i], value }))
  });
  return JSON.stringify([
    {
      stationTriplet: '791:WA:SNTL',
      data: [
        element('WTEQ', [0, 0, 0.1, 0.2, 0.4, 0.3, 0.5]),
        element('SNWD', [0, 0, 1, 2, 3, 2, 4]),
        element('PREC', [1.2, 1.2, 1.4, 1.5, 1.7, 1.8, 1.9])
      ]
    }
  ]);
}

/** Route the live read (any station triplet) and boot the station layer alone. */
async function bootStation(page: Page, options: { readonly view?: 'console' | 'brief'; readonly embed?: boolean } = {}): Promise<void> {
  await page.route('**/awdbRestApi/services/v1/data**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: awdbBody() })
  );
  await gotoApp(page, `?region=washington_state&view=${options.view ?? 'console'}&layers=telemetry${options.embed ? '&embed=true' : ''}`);
  await settleStations(page);
}

/**
 * Wait for the station markers to hold still: no marker added or removed for
 * a second and a half (the discovery debounce is 350 ms, src/layers/telemetry.ts),
 * then the layer settled. Times out honestly.
 */
async function settleStations(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const host = document.getElementById('map') ?? document.body;
        const quiet = 1500;
        const touched = (records: MutationRecord[]): boolean =>
          records.some((r) =>
            [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some((n) => n instanceof Element && n.classList.contains('telemetry-marker'))
          );
        let timer: ReturnType<typeof setTimeout>;
        const observer = new MutationObserver((records) => {
          if (!touched(records)) return;
          clearTimeout(timer);
          timer = setTimeout(done, quiet);
        });
        const deadline = setTimeout(() => {
          observer.disconnect();
          clearTimeout(timer);
          reject(new Error('the station markers never held still'));
        }, 20_000);
        function done(): void {
          observer.disconnect();
          clearTimeout(deadline);
          resolve();
        }
        timer = setTimeout(done, quiet);
        observer.observe(host, { childList: true, subtree: true });
      })
  );
  await waitForLayerSettled(page, 'telemetry');
}

/**
 * An uncovered point of the map canvas (or of the station's own marker
 * already there), searched over a grid from the centre outward with a
 * margin for the 16 px marker: at small sizes the embed's dock and map
 * controls cover the centre and most of a narrow map. Throws naming what
 * covers the centre when no grid point is uncovered.
 */
async function openPoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const found = await page.evaluate((stationId) => {
    const map = document.getElementById('map');
    const canvas = map?.querySelector('canvas.maplibregl-canvas') ?? null;
    if (!map || !canvas) return { point: null, error: 'no map canvas' };
    const r = map.getBoundingClientRect();
    const left = Math.max(r.left, 0) + 10;
    const right = Math.min(r.right, window.innerWidth) - 10;
    const top = Math.max(r.top, 0) + 10;
    const bottom = Math.min(r.bottom, window.innerHeight) - 10;
    const open = (x: number, y: number): boolean => {
      // The point and the marker's half-width around it are all canvas (or the marker).
      for (const [dx, dy] of [[0, 0], [-8, 0], [8, 0], [0, -8], [0, 8]] as const) {
        const el = document.elementFromPoint(x + dx, y + dy);
        if (!(el === canvas || el?.closest(`.telemetry-marker[data-telemetry-station-id="${stationId}"]`))) return false;
      }
      return true;
    };
    const fractions = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9];
    for (const fy of [0.3, 0.2, 0.4, 0.5, 0.15, 0.6, 0.1, 0.7, 0.8]) {
      for (const fx of fractions) {
        const x = left + (right - left) * fx;
        const y = top + (bottom - top) * fy;
        if (open(x, y)) return { point: { x, y }, error: null };
      }
    }
    const over = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    const name = over ? `${over.tagName.toLowerCase()}${over.id ? `#${over.id}` : ''}.${Array.from(over.classList).join('.')}` : 'nothing';
    return { point: null, error: `no point of the map is uncovered (map ${Math.round(r.width)}x${Math.round(r.height)}); ${name} is over the centre` };
  }, id);
  if (found.point === null) throw new Error(found.error ?? 'no open point');
  return found.point;
}

/**
 * Drag the map until the station's marker sits on an uncovered point (each
 * drag ends in a moveend, so the markers are let settle after it), in steps
 * that keep the pointer inside the map.
 */
async function bringStationIntoReach(page: Page, id: string): Promise<{ x: number; y: number }> {
  const marker = page.locator(`.telemetry-marker[data-telemetry-station-id="${id}"]`);
  await expect(marker, `${id}: the seed marker is rendered`).toHaveCount(1);
  for (let attempt = 0; attempt < 10; attempt++) {
    const target = await openPoint(page, id);
    const box = await marker.boundingBox();
    if (!box) throw new Error(`${id}: the seed marker has no box`);
    const dx = target.x - (box.x + box.width / 2);
    const dy = target.y - (box.y + box.height / 2);
    if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return target;
    // Press on the open point (a canvas point) and move by the step, the
    // pointer kept inside the viewport.
    const vp = page.viewportSize()!;
    const stepX = Math.max(2 - target.x, Math.min(vp.width - 2 - target.x, Math.max(-140, Math.min(140, dx))));
    const stepY = Math.max(2 - target.y, Math.min(vp.height - 2 - target.y, Math.max(-140, Math.min(140, dy))));
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x + stepX, target.y + stepY, { steps: 12 });
    await page.mouse.up();
    await settleStations(page);
  }
  const box = await marker.boundingBox();
  const target = await openPoint(page, id);
  throw new Error(`${id}: the marker never reached an uncovered point (marker at ${JSON.stringify(box)}, open point ${JSON.stringify(target)})`);
}

/** Whether any canvas point of the map is uncovered (a narrow embed's overlays can cover all of it). */
async function anyOpenPoint(page: Page, id: string): Promise<boolean> {
  return openPoint(page, id).then(
    () => true,
    () => false
  );
}

/**
 * Bring the station's marker onto an uncovered point and click it. Where the
 * embed's overlays cover the whole map (the 88 px FULL-width region: the map
 * controls and the full-site notes leave no canvas pixel), no pointer can
 * reach a marker, and the other builders' rows keep the card they opened at
 * 360x300 through the resizes, which a station card cannot (every resize's
 * discovery rebuild closes it). There, and ONLY for the row that passes
 * `coveredMap` (the FULL width tier), the marker, inside the map, gets a
 * dispatched click (MapLibre's marker opens its popup from the map click
 * whose target is the marker), so the row still measures the card at the
 * boundary; any other row with no uncovered canvas point fails at once,
 * naming what covers the map. Then wait for the live read to repaint the
 * card. Returns the station opened.
 */
async function openStation(page: Page, coveredMap: 'fail' | 'dispatch' = 'fail'): Promise<StationCase> {
  const root = page.locator(STATION_FRAME);
  const station = STATIONS[0];
  const marker = page.locator(`.telemetry-marker[data-telemetry-station-id="${station.id}"]`);
  // Loud, not retried: a fully covered map outside the FULL width row.
  if (coveredMap === 'fail' && (await root.count()) === 0) await openPoint(page, station.id);
  let opened: StationCase | null = null;
  await expect(async () => {
    if ((await root.count()) === 0) {
      opened = station;
      if (coveredMap === 'fail' || (await anyOpenPoint(page, station.id))) {
        const at = await bringStationIntoReach(page, station.id);
        await page.mouse.click(at.x, at.y);
      } else {
        const box = await marker.boundingBox();
        const map = await page.locator('#map').boundingBox();
        const inside =
          box !== null && map !== null && box.x >= map.x && box.y >= map.y && box.x + box.width <= map.x + map.width && box.y + box.height <= map.y + map.height;
        if (!inside) throw new Error(`${station.id}: no uncovered map point and the marker is outside the map (${JSON.stringify(box)} in ${JSON.stringify(map)})`);
        await marker.dispatchEvent('click');
      }
    }
    await expect(root.locator(':scope > [data-popup-region="head"] > [data-popup-slot="value"]'), 'the live read repainted the card').toContainText(
      'Snow water equivalent',
      { timeout: 3_000 }
    );
  }).toPass({ timeout: 30_000 });
  if (opened === null) {
    // The card was already open (a straggling rebuild never came): name it by its source.
    const href = await root.locator(':scope > [data-popup-region="body"] > [data-popup-slot="source-fallback"] a').getAttribute('href');
    opened = STATIONS.find((s) => s.source.href === href) ?? null;
  }
  expect(opened, 'the opened station is a candidate').not.toBeNull();
  // The sparkline is drawn into the body before the card is read.
  await expect(root.locator('[data-popup-chart] svg')).toHaveCount(1);
  return opened!;
}

/** Close the adopted popup with its own close control (it binds no Escape). */
async function closeStation(page: Page): Promise<void> {
  const popup = page.locator('.maplibregl-popup');
  if ((await popup.count()) > 0) await page.locator('.maplibregl-popup .maplibregl-popup-close-button').click();
  await expect(popup).toHaveCount(0);
}

const tierFixture: TierFixture = {
  async sourcesAtTierBoundaries(page) {
    const id = 'telemetry';
    await page.setViewportSize({ width: 360, height: 300 });
    await bootStation(page, { embed: true });
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
      // The resizes rebuilt the markers (and closed any open card): open it
      // again at this region, then read it. Only the FULL width region (an
      // 88 px map the embed's overlays cover whole) may open it by a
      // dispatched click; every other tier needs an uncovered canvas point.
      await settleStations(page);
      const station = await openStation(page, tier.name === 'FULL width' ? 'dispatch' : 'fail');
      await settleCard(page);
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
      await expect(link).toHaveAttribute('href', station.source.href);
      await expect(link).toHaveText(station.source.label);
      await expect
        .poll(() => bodyLineReachable(link, 'first'), { message: `${id} ${tier.name}: the primary source is hit-test reachable`, timeout: 7_000 })
        .toBe('ok');
      // The last qualification: the station's description note.
      const notes = body.locator(':scope > [data-popup-slot="note"]');
      await expect(notes, `${id}: the station carries its description note`).not.toHaveCount(0);
      await expect
        .poll(() => bodyLineReachable(notes.last(), 'last'), { message: `${id} ${tier.name}: the last qualification is scroll-reachable`, timeout: 7_000 })
        .toBe('ok');
      const more = body.locator(':scope > [data-popup-slot="more-links"] a');
      await expect(more).toHaveCount(MORE_LINKS.length);
      for (const [index, moreLink] of MORE_LINKS.entries()) {
        await expect(more.nth(index)).toHaveAttribute('href', moreLink.href);
        await expect(more.nth(index)).toHaveText(moreLink.label);
        await expect
          .poll(() => bodyLineReachable(more.nth(index), 'first'), {
            message: `${id} ${tier.name}: the more link "${moreLink.label}" is hit-test reachable`,
            timeout: 7_000
          })
          .toBe('ok');
      }
      await expect
        .poll(() => strictHit(content.locator(':scope > .maplibregl-popup-close-button')), {
          message: `${id} ${tier.name}: the close control is hit-test reachable`,
          timeout: 7_000
        })
        .toBe('ok');
    }
  },

  async longHeadAndPanel(page) {
    const id = 'telemetry';
    const seats = [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 }
    ] as const;
    await page.setViewportSize(seats[0]);
    await bootStation(page);
    for (const seat of seats) {
      await page.setViewportSize(seat);
      await settleStations(page);
      await closeStation(page);
      await openStation(page);
      const at = `${id} at ${seat.width}x${seat.height}`;
      // The response is one framed card.
      await expect(page.locator('.maplibregl-popup [data-popup-frame]'), `${at}: the response is a framed card`).toHaveCount(1);
      // An adopted station card is offered no late briefing door.
      await expect(page.locator(FRAMED_LATE_DOOR), `${at}: no late door on a station card`).toHaveCount(0);
      await settleCard(page);
      expectHeadVisibleBodyScrolls(await readCard(page), at);
      await expect
        .poll(() => strictHit(page.locator('.maplibregl-popup .maplibregl-popup-content > .maplibregl-popup-close-button')), {
          message: `${at}: the close control is hit-test reachable`,
          timeout: 7_000
        })
        .toBe('ok');
    }

    // The panel half: a station response is non-place, so it never routes to
    // the panel-foot sink; in the Brief shell with the sidebar open the
    // adopted map popup shows it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await bootStation(page, { view: 'brief' });
    await openStation(page);
    await expect(page.locator(STATION_FRAME)).toHaveCount(1);
    await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
  }
};

export const TELEMETRY_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {
  telemetry: tierFixture
};
