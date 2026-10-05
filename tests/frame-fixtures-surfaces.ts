/**
 * The surface builders' frame fixtures (S30D D1 M25: USDM, USDM change, NADM,
 * CDM, CPC outlook, HMS; the held BC builder has none while DR-160 holds),
 * keyed by the manifest's builder id; see tests/frame-fixtures.ts.
 *
 * Each fixture routes its own deterministic surface data (page routes win
 * over gotoApp's context stubs and the census's offline context route),
 * boots ONLY its surface (surfaces are exclusive), clicks the map centre
 * until its response is up, and reads the response in one evaluate. Every
 * fixture polygon covers the fitted Washington centre (about 47.3N, 120.5W,
 * src/config/regions.ts) so a centre click lands on it.
 *
 * The named-field reads and the stubs are exported for the M25 cases in
 * tests/identify-paths.spec.ts ("identify paths: the M25 surfaces"). No
 * product value is imported here: the PF3 boundary numbers below restate
 * src/ui/popup-viewport.ts's constants, and each tier read also checks the
 * runtime's own compact class, so a moved boundary fails a premise rather
 * than passing silently.
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { CPC_OUTLOOK_FCST_DATE, CPC_OUTLOOK_TARGET, stubCpcDroughtOutlook } from './cpc-outlook-fixtures';
import type { CensusFixture, CensusHelpers, TierFixture } from './frame-fixtures';
import { gotoApp, waitForLayerSettled } from './helpers';

// ---------------------------------------------------------------------------
// The surface table
// ---------------------------------------------------------------------------

/** A ring that covers every region's fitted centre (the BROAD_CONDITION_FC extent). */
const BROAD_RING: readonly (readonly [number, number])[] = [
  [-140, 20],
  [-50, 20],
  [-50, 75],
  [-140, 75],
  [-140, 20]
];

/**
 * A data variant: the default named-field data, the longest realistic head,
 * malformed issuer time text, or issuer times that are not text (a boolean,
 * which survives MapLibre's feature encoding) or name a year below 1000.
 */
export type SurfaceVariant = 'default' | 'long' | 'malformed' | 'nontext';

export interface SurfaceCase {
  /** The manifest builder id. */
  readonly id: string;
  /** The layers= key that activates it (surfaces are exclusive, one per boot). */
  readonly layerKey: string;
  /** The layer ids its response may be stamped with (data-ddm-response). */
  readonly layerIds: readonly string[];
  /** Any extra query the boot needs (the change register, the monthly register). */
  readonly query: string;
  /** The primary source's label and href (head `source`, body `source-fallback`). */
  readonly source: { readonly label: string; readonly href: string };
  /** Every more link the surface carries, in order (the CDM licence included). */
  readonly moreLinks: readonly { readonly label: string; readonly href: string }[];
}

export const NADM_PRODUCT_PAGE = 'https://www.drought.gov/data-maps-tools/north-american-drought-monitor-nadm';
const CDM_DATASET_URL = 'https://open.canada.ca/data/en/dataset/292646cd-619f-4200-afb1-8b2c52f984a2';
const CDM_LICENSE_TITLE = 'Open Government Licence - Canada';
const CDM_LICENSE_URL = 'https://open.canada.ca/en/open-government-licence-canada';
const DROUGHT_GOV = { label: 'Drought.gov', href: 'https://www.drought.gov/' };

export const SURFACE_CASES: Readonly<Record<string, SurfaceCase>> = {
  usdm: {
    id: 'usdm',
    layerKey: 'usdm',
    layerIds: ['usdm-frame-a-fill', 'usdm-frame-b-fill'],
    query: '',
    source: { label: 'U.S. Drought Monitor', href: 'https://droughtmonitor.unl.edu/' },
    moreLinks: [DROUGHT_GOV]
  },
  'usdm-change': {
    id: 'usdm-change',
    layerKey: 'usdm',
    layerIds: ['usdm-change-fill'],
    query: '&dmode=chg1',
    source: { label: 'USDM Change Maps', href: 'https://droughtmonitor.unl.edu/Maps/ChangeMaps.aspx' },
    moreLinks: []
  },
  nadm: {
    id: 'nadm',
    layerKey: 'nadm-drought',
    layerIds: ['nadm-drought-fill'],
    query: '',
    source: { label: 'North American Drought Monitor', href: NADM_PRODUCT_PAGE },
    moreLinks: [
      { label: 'North American Drought Monitor source', href: 'https://www.ncei.noaa.gov/pub/data/nidis/geojson/na/nadm/NADM-current.geojson' }
    ]
  },
  cdm: {
    id: 'cdm',
    layerKey: 'cdm-drought',
    layerIds: ['cdm-drought-fill'],
    query: '',
    source: { label: 'Canadian Drought Monitor source', href: CDM_DATASET_URL },
    moreLinks: [{ label: CDM_LICENSE_TITLE, href: CDM_LICENSE_URL }]
  },
  cpc: {
    id: 'cpc',
    layerKey: 'drought',
    layerIds: ['drought-outlook-fill'],
    query: '',
    source: {
      label: 'CPC Drought Outlook',
      href: 'https://www.cpc.ncep.noaa.gov/products/expert_assessment/sdo_summary.php'
    },
    moreLinks: [DROUGHT_GOV]
  },
  hms: {
    id: 'hms',
    layerKey: 'hms-smoke',
    layerIds: ['hms-smoke-fill'],
    query: '',
    source: { label: 'NOAA OSPO Hazard Mapping System', href: 'https://www.ospo.noaa.gov/products/land/hms.html' },
    moreLinks: []
  }
};

function surfaceCase(id: string): SurfaceCase {
  const found = Object.hasOwn(SURFACE_CASES, id) ? SURFACE_CASES[id] : undefined;
  if (!found) throw new Error(`no surface case ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function featureCollection(properties: Record<string, unknown>, ring: readonly (readonly [number, number])[] = BROAD_RING): unknown {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [ring] } }]
  };
}

function fulfillJson(route: Route, body: unknown, contentType = 'application/geo+json'): Promise<void> {
  return route.fulfill({ status: 200, contentType, body: JSON.stringify(body) });
}

/** The USDM week's dates: map date Aug 11, 2026 (the time-zone guard), valid Aug 11 to Aug 17. */
export const USDM_MAP_DATE_MS = Date.UTC(2026, 7, 11);
const USDM_VALID_END_MS = Date.UTC(2026, 7, 17);

async function routeUsdm(page: Page, variant: SurfaceVariant = 'default'): Promise<void> {
  // The nontext variant's dates are booleans: never a date, never Jan 1, 1970.
  const body = featureCollection(
    variant === 'nontext'
      ? { DM: 2, MapDate: false, ValidStart: false, ValidEnd: true }
      : { DM: 2, MapDate: USDM_MAP_DATE_MS, ValidStart: USDM_MAP_DATE_MS, ValidEnd: USDM_VALID_END_MS }
  );
  await page.route('**/USDM_current/**', (route) => fulfillJson(route, body));
  await page.route('**/USDM_archive/**', (route) => fulfillJson(route, body));
}

/** A synthetic CDM artifact (the shape of tests/m-breadth-cdm-drought.spec.ts's fixture) whose D2 polygon covers Washington and British Columbia. */
export function cdmArtifact(): unknown {
  const classes = [0, 1, 2, 3, 4].map((dm) => ({
    class: `D${dm}`,
    state: dm === 2 ? 'present' : 'absent-no-occupied-area',
    member: dm === 2 ? 'CDM_2606_D2_LR.geojson' : null,
    featureCount: dm === 2 ? 1 : 0,
    componentCount: dm === 2 ? 1 : 0
  }));
  return {
    schemaVersion: 1,
    product: 'Canadian Drought Monitor',
    month: '2026-06',
    monthState: 'published',
    attribution: 'Agriculture and Agri-Food Canada',
    license: { title: CDM_LICENSE_TITLE, url: CDM_LICENSE_URL, datasetUrl: CDM_DATASET_URL },
    provenance: {
      sourceUrl: 'https://example.invalid/synthetic-cdm-fixture.zip',
      retrieved: '2026-07-27',
      archiveBytes: 1,
      classesPresent: ['D2'],
      classesAbsent: ['D0', 'D1', 'D3', 'D4'],
      stewardshipCheck: { result: 'PASS: synthetic fixture, no archive member names.' },
      componentPreservation: 'PASS: synthetic fixture, one component.'
    },
    classes,
    data: featureCollection({ dm: 2 }, [
      [-139, 30],
      [-100, 30],
      [-100, 60],
      [-139, 60],
      [-139, 30]
    ])
  };
}

/**
 * HMS plume properties per variant: both window ends; a malformed Start and
 * a blank End_; or a Start that is not text (absent) and an End_ in year 0099
 * (supplied, never read as 1999).
 */
function hmsProperties(variant: SurfaceVariant): Record<string, unknown> {
  if (variant === 'malformed') return { Density: 'Medium', Satellite: 'GOES-WEST', Start: '2026-08-18 12:00Z', End_: '' };
  if (variant === 'nontext') return { Density: 'Medium', Satellite: 'GOES-WEST', Start: true, End_: '0099001 1200' };
  return { Density: 'Medium', Satellite: 'GOES-WEST', Start: '2026230 1200', End_: '2026230 1800' };
}

/**
 * Route one surface's data on the page. Register before gotoApp. The CPC
 * route is registered after the shared stub, so it wins and keeps the
 * stub's `fcst_date` and per-register `target` over a centre-covering polygon.
 */
export async function routeSurface(page: Page, id: string, variant: SurfaceVariant = 'default'): Promise<void> {
  switch (id) {
    case 'usdm':
      await routeUsdm(page, variant);
      return;
    case 'usdm-change':
      await routeUsdm(page);
      await page.route(
        (url) => url.href.includes('usdm-change.geojson'),
        (route) => fulfillJson(route, { date: '20260811', ...(featureCollection({ DN: 1 }) as object) })
      );
      return;
    case 'nadm':
      await page.route('**/NADM-current.geojson', (route) =>
        fulfillJson(route, featureCollection({ DROUGHTCAT: 'd2', YEAR_MONTH: '202606' }))
      );
      return;
    case 'cdm':
      await page.route('**/data/cdm-drought-areas.json', (route) => fulfillJson(route, cdmArtifact(), 'application/json'));
      return;
    case 'cpc':
      await stubCpcDroughtOutlook(page);
      await page.route(
        (url) => url.href.includes('cpc_drought_outlk/MapServer/'),
        (route) => {
          const href = route.request().url();
          const target = href.includes('MapServer/1/')
            ? CPC_OUTLOOK_TARGET.monthly
            : href.includes('MapServer/4/')
              ? CPC_OUTLOOK_TARGET.seasonal
              : null;
          return fulfillJson(
            route,
            target === null
              ? { type: 'FeatureCollection', features: [] }
              : featureCollection({ outlook: 'Persistence', fcst_date: CPC_OUTLOOK_FCST_DATE, target })
          );
        }
      );
      return;
    case 'hms':
      await page.route(
        (url) => url.href.includes('NOAA_Satellite_Smoke_Detection'),
        (route) => fulfillJson(route, featureCollection(hmsProperties(variant)))
      );
      return;
    default:
      throw new Error(`no surface stub for ${id}`);
  }
}

/** Route and boot one surface alone; `extra` adds query keys (`&outlook=monthly`, `&embed=true`). */
export async function bootSurface(
  page: Page,
  id: string,
  options: { readonly variant?: SurfaceVariant; readonly view?: 'console' | 'brief'; readonly extra?: string } = {}
): Promise<void> {
  const c = surfaceCase(id);
  await routeSurface(page, id, options.variant ?? 'default');
  await gotoApp(page, `?region=washington_state&view=${options.view ?? 'console'}&layers=${c.layerKey}${c.query}${options.extra ?? ''}`);
  await waitForLayerSettled(page, c.layerKey);
  if (c.query.includes('dmode=chg1')) {
    // The change register is honoured at the latest week only; a healed URL would test the wrong register.
    await expect.poll(() => new URL(page.url()).searchParams.get('dmode'), { message: 'the change register is active' }).toBe('chg1');
  }
}

// ---------------------------------------------------------------------------
// Clicks and reads
// ---------------------------------------------------------------------------

/**
 * The point a fixture clicks: the centre of the map's on-screen rect when
 * the map canvas is the topmost element there, else the nearest point (on
 * 8 px rings around it) where it is. On-map chrome can cover the centre: in
 * a 360x300 embed the bottom dock carries the map key's strip, stacked
 * above the canvas (and below every popup), so a centre click there lands
 * on the key and never reaches the fixture polygon (gate n2-m25-wt, the PF3
 * "sources and caveat" row, no response in 3 of 3 runs). Every fixture
 * polygon covers the whole fitted map, so any canvas point hits it. Throws
 * naming the element over the centre when no canvas point exists.
 */
async function mapClickPoint(page: Page): Promise<{ x: number; y: number }> {
  const found = await page.evaluate(() => {
    const map = document.getElementById('map');
    const canvas = map?.querySelector('canvas.maplibregl-canvas') ?? null;
    if (!map || !canvas) return { x: 0, y: 0, error: 'no map canvas' };
    const r = map.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, window.innerWidth);
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const onCanvas = (x: number, y: number): boolean =>
      x > left + 2 && x < right - 2 && y > top + 2 && y < bottom - 2 && document.elementFromPoint(x, y) === canvas;
    if (onCanvas(cx, cy)) return { x: cx, y: cy, error: null };
    const reach = Math.max(right - left, bottom - top);
    for (let ring = 8; ring < reach; ring += 8) {
      for (let step = 0; step < 16; step++) {
        const x = cx + ring * Math.cos((step * Math.PI) / 8);
        const y = cy + ring * Math.sin((step * Math.PI) / 8);
        if (onCanvas(x, y)) return { x, y, error: null };
      }
    }
    const over = document.elementFromPoint(cx, cy);
    const name = over ? `${over.tagName.toLowerCase()}${over.id ? `#${over.id}` : ''}.${Array.from(over.classList).join('.')}` : 'nothing';
    return { x: cx, y: cy, error: `no point of the map canvas is uncovered; ${name} is over the centre` };
  });
  if (found.error !== null) throw new Error(found.error);
  return { x: found.x, y: found.y };
}

/** The response layer id the map popup currently shows, or null. */
async function shownResponse(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const root = document.querySelector('.maplibregl-popup .maplibregl-popup-content > .coordinated-response');
    return root?.getAttribute('data-ddm-response') ?? null;
  });
}

/** Click the map (its centre when uncovered) until the map popup shows one of the case's responses. */
export async function clickUntilSurfaceResponse(page: Page, id: string): Promise<void> {
  const c = surfaceCase(id);
  const point = await mapClickPoint(page);
  await expect(async () => {
    await page.mouse.click(point.x, point.y);
    await expect
      .poll(() => shownResponse(page), { message: `${id}: a response after a click at ${Math.round(point.x)},${Math.round(point.y)}`, timeout: 1500 })
      .toMatch(new RegExp(`^(${c.layerIds.join('|')})$`));
  }).toPass({ timeout: 20_000 });
}

/** The census click: until the observer has seen one of the case's map responses. */
async function clickUntilSeen(page: Page, h: CensusHelpers, id: string): Promise<void> {
  const c = surfaceCase(id);
  const wanted = c.layerIds.map((layerId) => `map:${layerId}`);
  const point = await mapClickPoint(page);
  await expect(async () => {
    await page.mouse.click(point.x, point.y);
    await expect
      .poll(async () => (await h.readAudit(page)).seen.some((entry) => wanted.includes(entry)), { timeout: 1500 })
      .toBe(true);
    expect(c.layerIds).toContain(await shownResponse(page));
  }).toPass({ timeout: 20_000 });
}

export interface ClockRead {
  readonly label: string | null;
  readonly time: string | null;
  readonly datetime: string | null;
  readonly supplied: string | null;
  readonly explanation: string | null;
  readonly reason: string | null;
}

export interface FramedRead {
  readonly response: string | null;
  readonly title: string | null;
  readonly issuer: string | null;
  readonly values: readonly string[];
  readonly swatches: readonly string[];
  readonly clocks: readonly ClockRead[];
  readonly source: { readonly label: string; readonly href: string } | null;
  readonly fallback: { readonly label: string; readonly href: string } | null;
  readonly moreLinks: readonly { readonly label: string; readonly href: string }[];
  readonly rows: readonly (readonly [string, string])[];
  readonly notes: readonly string[];
}

/** The displayed framed response's named fields, in one read (U+00A0 read as a space). */
export async function readFramedResponse(page: Page): Promise<FramedRead | null> {
  return page.evaluate(() => {
    const norm = (value: string | null | undefined): string | null =>
      value === null || value === undefined ? null : value.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]');
    if (!root) return null;
    const head = root.querySelector(':scope > [data-popup-region="head"]');
    const body = root.querySelector(':scope > [data-popup-region="body"]');
    if (!head || !body) return null;
    const link = (scope: Element | null): { label: string; href: string } | null => {
      const a = scope?.querySelector('a');
      return a ? { label: norm(a.textContent) ?? '', href: a.getAttribute('href') ?? '' } : null;
    };
    return {
      response: root.getAttribute('data-ddm-response'),
      title: norm(head.querySelector(':scope > [data-popup-slot="title"]')?.textContent),
      issuer: norm(head.querySelector(':scope > [data-popup-slot="issuer"]')?.textContent),
      values: Array.from(head.querySelectorAll(':scope > [data-popup-slot="value"] .popup-value-text')).map((el) => norm(el.textContent) ?? ''),
      swatches: Array.from(head.querySelectorAll(':scope > [data-popup-slot="value"] .popup-swatch')).map(
        (el) => el.getAttribute('data-swatch-class') ?? ''
      ),
      clocks: Array.from(head.querySelectorAll(':scope > [data-popup-slot="clock"] > p')).map((p) => ({
        label: norm(p.querySelector('.popup-clock-label')?.textContent),
        time: norm(p.querySelector('time')?.textContent),
        datetime: p.querySelector('time')?.getAttribute('datetime') ?? null,
        supplied: norm(p.querySelector('[data-clock-supplied]')?.textContent),
        explanation: norm(p.querySelector('[data-clock-explanation]')?.textContent),
        reason: norm(p.querySelector('[data-clock-reason]')?.textContent)
      })),
      source: link(head.querySelector(':scope > [data-popup-slot="source"]')),
      fallback: link(body.querySelector(':scope > [data-popup-slot="source-fallback"]')),
      moreLinks: Array.from(body.querySelectorAll(':scope > [data-popup-slot="more-links"] a')).map((a) => ({
        label: norm(a.textContent) ?? '',
        href: a.getAttribute('href') ?? ''
      })),
      rows: Array.from(body.querySelectorAll('[data-detail="row"]')).map(
        (dl) => [norm(dl.querySelector('dt')?.textContent) ?? '', norm(dl.querySelector('dd')?.textContent) ?? ''] as [string, string]
      ),
      notes: Array.from(body.querySelectorAll(':scope > [data-popup-slot="note"]')).map((el) => norm(el.textContent) ?? '')
    };
  });
}

// ---------------------------------------------------------------------------
// The census fixtures
// ---------------------------------------------------------------------------

function censusFixture(id: string): CensusFixture {
  return async (page, h) => {
    await bootSurface(page, id);
    await clickUntilSeen(page, h, id);
    // The ONE validator (window.__ddmFrameCheck): the displayed root is the
    // frame article, its regions carry the coordinated classes, and the five
    // head slots are non-empty. A legacy response is handed in as the root,
    // so the validator names the failure ("not exactly one frame root").
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

export const SURFACE_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {
  hms: censusFixture('hms'),
  usdm: censusFixture('usdm'),
  'usdm-change': censusFixture('usdm-change'),
  nadm: censusFixture('nadm'),
  cdm: censusFixture('cdm'),
  cpc: censusFixture('cpc')
};

// ---------------------------------------------------------------------------
// The PF3 tier fixtures
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
 * its window, then hit-test that line STRICTLY: the element under the line's
 * centre is the target or inside it (never an ancestor, which could pass for
 * a clipped target). The external link is never followed.
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

function tierFixture(id: string, longVariant: { readonly variant: SurfaceVariant; readonly extra?: string }): TierFixture {
  const c = surfaceCase(id);
  return {
    async sourcesAtTierBoundaries(page) {
      await page.setViewportSize({ width: 360, height: 300 });
      await bootSurface(page, id, { extra: '&embed=true' });
      await clickUntilSurfaceResponse(page, id);
      const content = page.locator('.maplibregl-popup .maplibregl-popup-content');
      const body = content.locator('[data-popup-region="body"]');
      // Each row names the axis it sits AT; the other axis is clear of its
      // boundary. The FULL width row (Codex N2-2 diff review, the shared
      // width gap) is the FULL boundary's width component: a measured
      // usable region 88 to 89 px wide, still FULL (M24's round-1 pattern).
      const tiers = [
        // The FULL boundary: a region 91 to 93px tall (FULL starts at 91).
        { name: 'FULL', axis: 'height', target: FULL_HEIGHT_PX + 1, min: FULL_HEIGHT_PX, max: FULL_HEIGHT_PX + 2, compact: false },
        // The usable-COMPACT boundary: a region at the 47px usable-body threshold.
        { name: 'usable COMPACT', axis: 'height', target: COMPACT_BODY_HEIGHT_PX + 0.5, min: COMPACT_BODY_HEIGHT_PX, max: COMPACT_BODY_HEIGHT_PX + 2, compact: true },
        // The FULL width boundary: a region 88 to 89px wide (FULL needs 88), 300px tall.
        // The target sits a quarter pixel in, so a rounded viewport width lands on 88, never 89.
        { name: 'FULL width', axis: 'width', target: USABLE_WIDTH_PX + 0.25, min: USABLE_WIDTH_PX, max: USABLE_WIDTH_PX + 0.99, compact: false }
      ] as const;
      for (const tier of tiers) {
        // Size the viewport so the MEASURED region lands at the boundary
        // (any chrome beside or under the map is measured, not assumed).
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
        // The primary source, body-reachable under squeeze (PF3), and the last qualification.
        const fallback = body.locator(':scope > [data-popup-slot="source-fallback"] a');
        await expect(fallback).toHaveAttribute('href', c.source.href);
        await expect(fallback).toHaveText(c.source.label);
        await expect
          .poll(() => bodyLineReachable(fallback, 'first'), { message: `${id} ${tier.name}: the primary source is hit-test reachable`, timeout: 7_000 })
          .toBe('ok');
        await expect
          .poll(() => bodyLineReachable(body.locator(':scope > [data-popup-slot="note"]').last(), 'last'), {
            message: `${id} ${tier.name}: the last qualification is scroll-reachable`,
            timeout: 7_000
          })
          .toBe('ok');
        // Every more link the surface carries (the CDM licence included),
        // each hit-test reachable after a body scroll; never followed.
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
      await bootSurface(page, id, { variant: longVariant.variant, extra: longVariant.extra ?? '' });
      const popup = page.locator('.maplibregl-popup');
      for (const seat of seats) {
        await page.setViewportSize(seat);
        await page.keyboard.press('Escape');
        await expect(popup).toHaveCount(0);
        await clickUntilSurfaceResponse(page, id);
        // The settled card (gate n2-m25-wt: "nadm at 1440x900: the head
        // starts on screen", -7.78, 2 of 3 runs). The coordinator's late door
        // lands after the paint (DR-042 a; every fixture click is inside
        // Washington) and grows the head; the viewport clamp re-runs on the
        // NEXT animation frame (src/ui/popup-viewport.ts wirePopup), so a
        // read taken between the two sees the unclamped card. Wait for the
        // door in the actions slot (the head at its longest), then, in the
        // page, for the card's box to hold still across two frames, and
        // read once from the same response root.
        await expect(
          page.locator(
            '.maplibregl-popup .maplibregl-popup-content > [data-popup-frame] > [data-popup-region="head"] > [data-popup-slot="actions"] > [data-ddm-impact-trigger]'
          ),
          `${id} at ${seat.width}x${seat.height}: the late door in the actions slot`
        ).toBeVisible({ timeout: 10_000 });
        const read = await page.evaluate(async () => {
          const root = document.querySelector('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]');
          const card = root?.parentElement;
          if (!root || !card) return null;
          const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
          let last = '';
          for (let frame = 0; frame < 120; frame++) {
            await nextFrame();
            const box = card.getBoundingClientRect();
            const key = `${box.left},${box.top},${box.width},${box.height}`;
            if (key === last) break;
            last = key;
          }
          if (!root.isConnected || document.querySelector('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]') !== root) return null;
          const content = root.parentElement;
          const head = root.querySelector(':scope > [data-popup-region="head"]');
          const body = root.querySelector(':scope > [data-popup-region="body"]');
          if (!(content instanceof HTMLElement) || !(head instanceof HTMLElement) || !(body instanceof HTMLElement)) return null;
          const h = head.getBoundingClientRect();
          const slots = ['title', 'issuer', 'value', 'clock', 'source'].map((slot) => {
            const el = head.querySelector(`:scope > [data-popup-slot="${slot}"]`);
            const r = el?.getBoundingClientRect();
            return { slot, inside: !!r && r.height > 0 && r.top >= h.top - 1 && r.bottom <= h.bottom + 1 };
          });
          return {
            viewport: { w: window.innerWidth, h: window.innerHeight },
            head: { top: h.top, bottom: h.bottom, left: h.left, right: h.right, overflow: head.scrollHeight - head.clientHeight, scrollTop: head.scrollTop },
            contentOverflow: content.scrollHeight - content.clientHeight,
            bodyOverflowY: getComputedStyle(body).overflowY,
            slots
          };
        });
        expect(read, `${id} ${seat.width}x${seat.height}: a framed response`).not.toBeNull();
        const at = `${id} at ${seat.width}x${seat.height}`;
        expect(read!.head.top, `${at}: the head starts on screen`).toBeGreaterThanOrEqual(-1);
        expect(read!.head.bottom, `${at}: the head ends on screen`).toBeLessThanOrEqual(read!.viewport.h + 1);
        expect(read!.head.left, `${at}: the head is on screen`).toBeGreaterThanOrEqual(-1);
        expect(read!.head.right, `${at}: the head is on screen`).toBeLessThanOrEqual(read!.viewport.w + 1);
        expect(read!.head.overflow, `${at}: the head is fully visible without scrolling`).toBeLessThanOrEqual(1);
        expect(read!.head.scrollTop, `${at}: the head is unscrolled`).toBe(0);
        expect(read!.slots.filter((s) => !s.inside).map((s) => s.slot), `${at}: head slots outside the visible head`).toEqual([]);
        expect(read!.bodyOverflowY, `${at}: only the body scrolls`).toBe('auto');
        expect(read!.contentOverflow, `${at}: the card itself never scrolls`).toBeLessThanOrEqual(1);
        await expect
          .poll(() => strictHit(page.locator('.maplibregl-popup .maplibregl-popup-content > .maplibregl-popup-close-button')), {
            message: `${at}: the close control is hit-test reachable`,
            timeout: 7_000
          })
          .toBe('ok');
      }

      // The panel half: a surface response is non-place, so it never routes
      // to the panel-foot sink (interaction-coordinator.ts renderPopup); in
      // the Brief shell with the sidebar open it opens the map popup.
      await page.setViewportSize({ width: 1440, height: 900 });
      await bootSurface(page, id, { view: 'brief', variant: longVariant.variant, extra: longVariant.extra ?? '' });
      await clickUntilSurfaceResponse(page, id);
      await expect(page.locator('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]')).toHaveCount(1);
      await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
    }
  };
}

export const SURFACE_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {
  hms: tierFixture('hms', { variant: 'long' }),
  usdm: tierFixture('usdm', { variant: 'long' }),
  'usdm-change': tierFixture('usdm-change', { variant: 'long' }),
  nadm: tierFixture('nadm', { variant: 'long' }),
  cdm: tierFixture('cdm', { variant: 'long' }),
  // The seasonal register: its 'September 30' valid-through label is shown
  // as supplied with its explanation, the longest realistic CPC head.
  cpc: tierFixture('cpc', { variant: 'long' })
};
