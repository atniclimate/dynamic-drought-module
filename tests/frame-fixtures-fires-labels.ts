/**
 * The NIFC perimeter and place-label builders' frame fixtures (S30D D1 M26a,
 * block 4; register owner-1k, DDM-P11-T04), keyed by the manifest's builder
 * id; see tests/frame-fixtures.ts. M26b and M26c register their own modules.
 *
 * Each fixture routes its own deterministic data (page routes win over
 * gotoApp's context stubs and the census's offline context route), boots
 * ONLY its layer, clicks until its response is up, and reads the response.
 *
 *   - nifc: one WFIGS wildfire perimeter covering the fitted Washington
 *     centre (about 47.3N, 120.5W, src/config/regions.ts), carrying every
 *     field the popup reads, the sizes of grouping-contract.md's F1 case
 *     (reported 9,108 acres, mapped 23,783.65 acres) so the record block's
 *     named sizes and their conversions are the contract's own figures.
 *   - places: a one-place bundle standing in for the bundled Natural Earth
 *     points (the D1 M23 C1 case's pattern, tests/popup-viewport.spec.ts),
 *     its point at that centre, so a click at the centre lands on the label.
 *
 * Both are non-place responses (the map feature is the subject), so the
 * coordinator's late briefing door (DR-042 a) lands in the actions slot
 * after the paint wherever the click resolves a place; every click here is
 * inside Washington.
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import type { CensusFixture, CensusHelpers, TierFixture } from './frame-fixtures';
import { gotoApp, waitForLayerSettled } from './helpers';

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

export type FireLabelId = 'nifc' | 'places';
export type FireLabelVariant = 'default' | 'long';

/** A rectangle polygon, west, south, east, north. */
function rect(w: number, s: number, e: number, n: number): { type: 'Polygon'; coordinates: number[][][] } {
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

export const NIFC_FIXTURE_NAME = 'Synthetic Frame Fixture Fire';
export const NIFC_LONG_NAME = 'Synthetic Frame Fixture Fire With A Deliberately Long Incident Name That Wraps In The Head';
export const NIFC_FIXTURE_UFI = '2026-WAFIX-000123';
/** grouping-contract.md 12.1 slot 3 and case F1: each size named, in acres first, with its "about" conversion. */
export const NIFC_SIZE_ROWS: readonly (readonly [string, string])[] = [
  ['Reported size', '9,108 acres (about 3,686 ha)'],
  ['Mapped perimeter area', '23,784 acres (about 9,625 ha)']
];

function nifcProperties(variant: FireLabelVariant): Record<string, unknown> {
  return {
    attr_IncidentName: variant === 'long' ? NIFC_LONG_NAME : NIFC_FIXTURE_NAME,
    poly_IncidentName: variant === 'long' ? NIFC_LONG_NAME : NIFC_FIXTURE_NAME,
    attr_IncidentTypeCategory: 'WF',
    attr_UniqueFireIdentifier: NIFC_FIXTURE_UFI,
    attr_IrwinID: '{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}',
    attr_IncidentSize: 9108,
    poly_GISAcres: 23783.65,
    attr_FireDiscoveryDateTime: Date.UTC(2026, 7, 11, 21, 5),
    attr_POOState: 'US-WA',
    attr_ActiveFireCandidate: 1
  };
}

/** Route the layer's perimeters query (GET, f=geojson) to the one fixture perimeter. Register before gotoApp. */
export async function routeNifcPerimeter(page: Page, variant: FireLabelVariant = 'default'): Promise<void> {
  const body = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 1, properties: nifcProperties(variant), geometry: rect(-123.5, 46.0, -118.0, 48.6) }]
  };
  await page.route(
    (url) => url.href.includes('/WFIGS_Interagency_Perimeters_Current/') && url.pathname.endsWith('/query') && url.searchParams.get('f') === 'geojson',
    (route: Route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(body) })
        : route.fallback()
  );
}

/** The fitted Washington centre (the D1 M23 C1 place-label case's point). */
export const PLACE_CENTRE: readonly [number, number] = [-120.84, 47.29];
export const PLACE_FIXTURE_NAME = 'Fixture Place Label';
/** Long enough to wrap the label over several lines, so it covers the probe pattern around the centre. */
export const PLACE_LONG_NAME = 'Fixture Place Label With A Name Long Enough To Wrap Over Several Lines Of The Map Label';

/** Route the bundled place points to one place at the centre. Register before gotoApp. */
export async function routePlaceLabel(page: Page, name: string, at: readonly [number, number] = PLACE_CENTRE): Promise<void> {
  await page.route('**/data/us-places.json', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meta: { count: 1, retrieved: '2026-07-12' },
        places: [{ name, lon: at[0], lat: at[1], rank: 0 }]
      })
    })
  );
}

interface FireLabelCase {
  readonly id: FireLabelId;
  readonly layerKey: string;
  readonly layerIds: readonly string[];
  readonly source: { readonly label: string; readonly href: string };
  readonly moreLinks: readonly { readonly label: string; readonly href: string }[];
  /** Whether the builder carries qualifications (the body's notes). */
  readonly notes: boolean;
}

export const FIRE_LABEL_CASES: Readonly<Record<FireLabelId, FireLabelCase>> = {
  nifc: {
    id: 'nifc',
    layerKey: 'nifc-fires',
    layerIds: ['nifc-fires-fill', 'nifc-prescribed-fill', 'nifc-other-outline'],
    source: { label: 'NIFC Open Data', href: 'https://data-nifc.opendata.arcgis.com/' },
    moreLinks: [{ label: 'InciWeb', href: 'https://inciweb.wildfire.gov/' }],
    notes: true
  },
  places: {
    id: 'places',
    layerKey: 'places',
    layerIds: ['us-places-labels'],
    source: {
      label: 'Natural Earth',
      href: 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/'
    },
    moreLinks: [],
    notes: false
  }
};

/** Route and boot one builder's layer alone; `extra` adds query keys (`&embed=true`). */
export async function bootFireLabel(
  page: Page,
  id: FireLabelId,
  options: { readonly variant?: FireLabelVariant; readonly view?: 'console' | 'brief'; readonly extra?: string; readonly placeName?: string } = {}
): Promise<void> {
  const c = FIRE_LABEL_CASES[id];
  const variant = options.variant ?? 'default';
  if (id === 'nifc') await routeNifcPerimeter(page, variant);
  else await routePlaceLabel(page, options.placeName ?? (variant === 'long' ? PLACE_LONG_NAME : PLACE_FIXTURE_NAME));
  await gotoApp(page, `?region=washington_state&view=${options.view ?? 'console'}&layers=${c.layerKey}${options.extra ?? ''}`);
  await waitForLayerSettled(page, c.layerKey);
}

// ---------------------------------------------------------------------------
// Clicks and reads
// ---------------------------------------------------------------------------

/**
 * The points a fixture clicks, in turn: the map's on-screen centre and a
 * small probe pattern around it (a label's box is its wrapped text, so a
 * probe a few pixels off the anchor can be the one that lands), keeping
 * only the points where the map canvas is the topmost element (on-map
 * chrome can cover the centre, as the embed's bottom dock does at 360x300).
 * Throws naming the element over the centre when none is uncovered.
 */
async function clickPoints(page: Page): Promise<{ x: number; y: number }[]> {
  const found = await page.evaluate(() => {
    const map = document.getElementById('map');
    const canvas = map?.querySelector('canvas.maplibregl-canvas') ?? null;
    if (!map || !canvas) return { points: [], error: 'no map canvas' };
    const r = map.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, window.innerWidth);
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const probes: [number, number][] = [
      [0, 0], [0, -8], [0, 8], [0, -16], [0, 16], [-24, 0], [24, 0], [0, -24], [0, 24], [-40, -8], [40, 8], [0, -32], [0, -40]
    ];
    const points = probes
      .map(([dx, dy]) => ({ x: cx + dx, y: cy + dy }))
      .filter(({ x, y }) => x > left + 2 && x < right - 2 && y > top + 2 && y < bottom - 2 && document.elementFromPoint(x, y) === canvas);
    if (points.length > 0) return { points, error: null };
    const over = document.elementFromPoint(cx, cy);
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

/**
 * Click (the centre, then the probes in turn) until the map popup shows
 * one of the builder's responses, or, with `seen`, until the census
 * audit has recorded one.
 */
export async function clickUntilFireLabelResponse(page: Page, id: FireLabelId, seen?: (page: Page) => Promise<readonly string[]>): Promise<void> {
  const c = FIRE_LABEL_CASES[id];
  const points = await clickPoints(page);
  let probe = 0;
  await expect(async () => {
    const point = points[probe++ % points.length]!;
    await page.mouse.click(point.x, point.y);
    if (seen) {
      const wanted = c.layerIds.map((layerId) => `map:${layerId}`);
      await expect.poll(async () => (await seen(page)).some((entry) => wanted.includes(entry)), { timeout: 1500 }).toBe(true);
    }
    await expect
      .poll(() => shownResponse(page), { message: `${id}: a response after a click at ${Math.round(point.x)},${Math.round(point.y)}`, timeout: 1500 })
      .toMatch(new RegExp(`^(${c.layerIds.join('|')})$`));
  }).toPass({ timeout: 30_000 });
}

/** The late door's selector in a framed head (the coordinator's actions slot). */
export const FRAMED_LATE_DOOR =
  '.maplibregl-popup .maplibregl-popup-content > [data-popup-frame] > [data-popup-region="head"] > [data-popup-slot="actions"] > [data-ddm-impact-trigger]';

/** Wait for the card's box to hold still across two animation frames (the clamp re-runs on the next frame). */
export async function settleCard(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const card = document.querySelector('.maplibregl-popup .maplibregl-popup-content');
    if (!card) return;
    const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    let last = '';
    for (let frame = 0; frame < 120; frame++) {
      await nextFrame();
      const box = card.getBoundingClientRect();
      const key = `${box.left},${box.top},${box.width},${box.height}`;
      if (key === last) break;
      last = key;
    }
  });
}

/** Everything the tier rows read off one settled framed card, in one evaluate. */
export interface CardRead {
  readonly viewport: { readonly w: number; readonly h: number };
  readonly card: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number; readonly width: number; readonly height: number };
  readonly framed: boolean;
  readonly head: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number; readonly overflow: number; readonly scrollTop: number } | null;
  readonly contentOverflow: number;
  readonly bodyOverflowY: string | null;
  readonly compact: boolean;
  readonly slotsOutside: readonly string[];
}

export async function readCard(page: Page): Promise<CardRead | null> {
  return page.evaluate(() => {
    const content = document.querySelector('.maplibregl-popup .maplibregl-popup-content');
    if (!(content instanceof HTMLElement)) return null;
    const c = content.getBoundingClientRect();
    const root = content.querySelector(':scope > [data-popup-frame]');
    const head = root?.querySelector(':scope > [data-popup-region="head"]') ?? null;
    const body = root?.querySelector(':scope > [data-popup-region="body"]') ?? null;
    const h = head instanceof HTMLElement ? head.getBoundingClientRect() : null;
    const slotsOutside =
      h === null
        ? ['title', 'issuer', 'value', 'clock', 'source']
        : ['title', 'issuer', 'value', 'clock', 'source'].filter((slot) => {
            const r = head!.querySelector(`:scope > [data-popup-slot="${slot}"]`)?.getBoundingClientRect();
            return !(r && r.height > 0 && r.top >= h.top - 1 && r.bottom <= h.bottom + 1);
          });
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      card: { top: c.top, bottom: c.bottom, left: c.left, right: c.right, width: c.width, height: c.height },
      framed: root !== null,
      head:
        h === null || !(head instanceof HTMLElement)
          ? null
          : { top: h.top, bottom: h.bottom, left: h.left, right: h.right, overflow: head.scrollHeight - head.clientHeight, scrollTop: head.scrollTop },
      contentOverflow: content.scrollHeight - content.clientHeight,
      bodyOverflowY: body instanceof HTMLElement ? getComputedStyle(body).overflowY : null,
      compact: content.classList.contains('ddm-popup-compact'),
      slotsOutside
    };
  });
}

/** The head-visible and body-only-scroll promises on one settled card. */
export function expectHeadVisibleBodyScrolls(read: CardRead | null, at: string): void {
  expect(read, `${at}: a response card`).not.toBeNull();
  const r = read!;
  expect(r.framed, `${at}: the card is a frame (${Math.round(r.card.width)} x ${Math.round(r.card.height)})`).toBe(true);
  expect(r.head, `${at}: a head region`).not.toBeNull();
  expect(r.head!.top, `${at}: the head starts on screen`).toBeGreaterThanOrEqual(-1);
  expect(r.head!.bottom, `${at}: the head ends on screen`).toBeLessThanOrEqual(r.viewport.h + 1);
  expect(r.head!.left, `${at}: the head is on screen`).toBeGreaterThanOrEqual(-1);
  expect(r.head!.right, `${at}: the head is on screen`).toBeLessThanOrEqual(r.viewport.w + 1);
  expect(r.head!.overflow, `${at}: the head is fully visible without scrolling`).toBeLessThanOrEqual(1);
  expect(r.head!.scrollTop, `${at}: the head is unscrolled`).toBe(0);
  expect(r.slotsOutside, `${at}: head slots outside the visible head`).toEqual([]);
  expect(r.bodyOverflowY, `${at}: only the body scrolls`).toBe('auto');
  expect(r.contentOverflow, `${at}: the card itself never scrolls`).toBeLessThanOrEqual(1);
}

// ---------------------------------------------------------------------------
// The census fixtures
// ---------------------------------------------------------------------------

function censusFixture(id: FireLabelId): CensusFixture {
  return async (page: Page, h: CensusHelpers) => {
    await bootFireLabel(page, id, { variant: id === 'places' ? 'long' : 'default' });
    await clickUntilFireLabelResponse(page, id, async (p) => (await h.readAudit(p)).seen);
    // The ONE validator (window.__ddmFrameCheck): the displayed root is the
    // frame article, its regions carry the coordinated classes, and the head
    // slots are non-empty. A legacy response is handed in as the root, so
    // the validator names the failure ("not exactly one frame root").
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

export const FIRE_LABEL_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {
  nifc: censusFixture('nifc'),
  places: censusFixture('places')
};

// ---------------------------------------------------------------------------
// The PF3 tier fixtures (the M25 surfaces' pattern, tests/frame-fixtures-surfaces.ts)
// ---------------------------------------------------------------------------

/** src/ui/popup-viewport.ts: MIN_USABLE_REGION_HEIGHT_PX, MIN_USABLE_REGION_WIDTH_PX, MIN_COMPACT_BODY_REGION_HEIGHT_PX. */
const FULL_HEIGHT_PX = 91;
const USABLE_WIDTH_PX = 88;
const COMPACT_BODY_HEIGHT_PX = 47;

/** The embed's reachable region: the viewport and the map rect, inset by the clamp's 12px margin. */
async function embedRegion(page: Page): Promise<{ top: number; left: number; bottom: number; right: number; h: number; w: number }> {
  const map = await page.locator('#map').boundingBox();
  if (!map) throw new Error('the map has no bounding box');
  const vp = page.viewportSize()!;
  const top = Math.max(0, map.y) + 12;
  const left = Math.max(0, map.x) + 12;
  const bottom = Math.min(vp.height, map.y + map.height) - 12;
  const right = Math.min(vp.width, map.x + map.width) - 12;
  return { top, left, bottom, right, h: bottom - top, w: right - left };
}

/**
 * Scroll ONLY the body region so the target's first or last line box sits in
 * its window, then hit-test that line STRICTLY (the target or inside it,
 * never an ancestor). The external link is never followed.
 */
async function bodyLineReachable(target: Locator, edge: 'first' | 'last'): Promise<string> {
  return target.evaluate((el, which) => {
    const body = el.closest('[data-popup-region="body"]');
    if (!(body instanceof HTMLElement)) return 'not inside the body region';
    const line = (): DOMRect | null => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      return (which === 'first' ? rects[0] : rects[rects.length - 1]) ?? null;
    };
    const before = line();
    if (!before) return 'no line box';
    const window0 = body.getBoundingClientRect();
    if (before.top < window0.top) body.scrollTop -= window0.top - before.top;
    else if (before.bottom > window0.bottom) body.scrollTop += before.bottom - window0.bottom;
    const r = line()!;
    const b = body.getBoundingClientRect();
    if (r.top < b.top - 1 || r.bottom > b.bottom + 1) return `the line stays outside the body window (${r.top}..${r.bottom} vs ${b.top}..${b.bottom})`;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return 'the line is off-screen';
    const found = document.elementFromPoint(x, y);
    return found !== null && (found === el || el.contains(found)) ? 'ok' : `hit ${found ? found.tagName.toLowerCase() : 'nothing'}`;
  }, edge);
}

/** The element under the target's own centre is the target or inside it. */
async function strictHit(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return 'no box';
    const found = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return found !== null && (found === el || el.contains(found)) ? 'ok' : `hit ${found ? found.tagName.toLowerCase() : 'nothing'}`;
  });
}

function tierFixture(id: FireLabelId): TierFixture {
  const c = FIRE_LABEL_CASES[id];
  return {
    async sourcesAtTierBoundaries(page) {
      await page.setViewportSize({ width: 360, height: 300 });
      // The long label wraps over several lines, so a probe above the
      // embed's dock still lands on it.
      await bootFireLabel(page, id, { variant: id === 'places' ? 'long' : 'default', extra: '&embed=true' });
      await clickUntilFireLabelResponse(page, id);
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
        const fallback = body.locator(':scope > [data-popup-slot="source-fallback"] a');
        await expect(fallback).toHaveAttribute('href', c.source.href);
        await expect(fallback).toHaveText(c.source.label);
        await expect
          .poll(() => bodyLineReachable(fallback, 'first'), { message: `${id} ${tier.name}: the primary source is hit-test reachable`, timeout: 7_000 })
          .toBe('ok');
        // The last qualification, where the builder carries any (a place label carries none).
        const notes = body.locator(':scope > [data-popup-slot="note"]');
        if (c.notes) {
          await expect
            .poll(() => bodyLineReachable(notes.last(), 'last'), { message: `${id} ${tier.name}: the last qualification is scroll-reachable`, timeout: 7_000 })
            .toBe('ok');
        } else {
          await expect(notes, `${id}: no qualification`).toHaveCount(0);
        }
        const more = body.locator(':scope > [data-popup-slot="more-links"] a');
        await expect(more).toHaveCount(c.moreLinks.length);
        for (const [index, link] of c.moreLinks.entries()) {
          await expect(more.nth(index)).toHaveAttribute('href', link.href);
          await expect(more.nth(index)).toHaveText(link.label);
          await expect
            .poll(() => bodyLineReachable(more.nth(index), 'first'), {
              message: `${id} ${tier.name}: the more link "${link.label}" is hit-test reachable`,
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
      const seats = [
        { width: 1280, height: 720 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 }
      ] as const;
      await page.setViewportSize(seats[0]);
      await bootFireLabel(page, id, { variant: 'long' });
      const popup = page.locator('.maplibregl-popup');
      for (const seat of seats) {
        await page.setViewportSize(seat);
        await page.keyboard.press('Escape');
        await expect(popup).toHaveCount(0);
        await clickUntilFireLabelResponse(page, id);
        // The late door lands after the paint (DR-042 a; every click here is
        // inside Washington) and grows the head; wait for it, then for the
        // card to hold still, and read once.
        await expect(page.locator(FRAMED_LATE_DOOR), `${id} at ${seat.width}x${seat.height}: the late door in the actions slot`).toBeVisible({
          timeout: 10_000
        });
        await settleCard(page);
        const at = `${id} at ${seat.width}x${seat.height}`;
        expectHeadVisibleBodyScrolls(await readCard(page), at);
        await expect
          .poll(() => strictHit(page.locator('.maplibregl-popup .maplibregl-popup-content > .maplibregl-popup-close-button')), {
            message: `${at}: the close control is hit-test reachable`,
            timeout: 7_000
          })
          .toBe('ok');
      }

      // The panel half: both responses are non-place, so they never route to
      // the panel-foot sink (interaction-coordinator.ts renderPopup); in the
      // Brief shell with the sidebar open each opens the map popup.
      await page.setViewportSize({ width: 1440, height: 900 });
      await bootFireLabel(page, id, { view: 'brief', variant: 'long' });
      await clickUntilFireLabelResponse(page, id);
      await expect(page.locator('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]')).toHaveCount(1);
      await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
    }
  };
}

export const FIRE_LABEL_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {
  nifc: tierFixture('nifc'),
  places: tierFixture('places')
};
