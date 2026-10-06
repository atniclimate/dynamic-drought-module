/**
 * The NWS alert, SPC fire weather outlook, power plant and power line
 * builders' frame fixtures (S30D D1 M26b, block 5; register owner-1k,
 * DDM-P11-T04), keyed by the manifest's builder id; see
 * tests/frame-fixtures.ts. M26c registers the station builder's own module
 * (tests/frame-fixtures-telemetry.ts), which reuses the tier helpers here.
 *
 * Each fixture routes its own deterministic data (page routes win over
 * gotoApp's context stubs and the census's offline context route), boots
 * ONLY its layer, clicks until its response is up, and reads the response.
 *
 *   - nws: one WWA alert polygon covering the fitted Washington centre
 *     (about 47.3N, 120.8W, src/config/regions.ts), carrying every field the
 *     layer requests (prod_type, onset, ends, expiration, wfo). Its times are
 *     relative to now: the layer prunes an alert whose expiry has passed.
 *   - spc: one Day 1 outlook polygon over the same centre, its category and
 *     its issuer-format (`YYYYMMDDHHMM`, UTC) valid and expire fields.
 *   - power-plant and power-line: the power layer draws from zoom 6 only
 *     (POWER_MIN_ZOOM), so these boot the South Puget Sound framing
 *     (bounds padded by 0.10 degrees, fitted centre about 47.20N, 122.65W),
 *     which fits above zoom 6 at every seat here, the 360x300 embed
 *     included. The plants read is routed to one EIA-shaped plant; the
 *     transmission-line archive is a synthetic PMTiles built here with the
 *     repository's own writer (scripts/lib/geojson-to-pmtiles.mjs) and served
 *     with byte ranges, so no line of the real archive decides a click.
 *
 * Every response here is non-place (the map feature is the subject), so the
 * coordinator's late briefing door (DR-042 a) lands in the actions slot after
 * the paint wherever the click resolves a place; every click here is inside
 * Washington (the South Puget Sound centre is inside the bundled Washington
 * polygon, public/data/us-states.geojson).
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import type { FeatureCollection, LineString } from 'geojson';
import { geojsonLayersToPmtiles } from '../scripts/lib/geojson-to-pmtiles.mjs';
import type { CensusFixture, CensusHelpers, TierFixture } from './frame-fixtures';
import { FRAMED_LATE_DOOR, expectHeadVisibleBodyScrolls, readCard, settleCard, type CardRead } from './frame-fixtures-fires-labels';
import { gotoApp, layerPill, waitForLayerSettled } from './helpers';

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

export type EventStationId = 'nws' | 'spc' | 'power-plant' | 'power-line';
/**
 * `long` is the longest realistic head and body; `embed` places the one
 * plant above the embed's bottom dock at 360x300 (the dock covers the map
 * centre there), and changes nothing for the other builders.
 */
export type EventStationVariant = 'default' | 'long' | 'embed';

/** A rectangle polygon, west, south, east, north. */
function rect(w: number, s: number, e: number, n: number): { type: 'Polygon'; coordinates: number[][][] } {
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** Covers the fitted Washington centre with room for every probe. */
const WA_COVER = rect(-123.5, 46.0, -118.0, 48.6);

const HOUR_MS = 60 * 60 * 1000;

export const NWS_FIXTURE_WFO = 'KSEW';

/** The alert's fields; its times are relative to now, whole hours, so the layer never prunes it mid-case. */
function nwsProperties(variant: EventStationVariant): Record<string, unknown> {
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return {
    // The longest product name the layer requests (src/layers/nws-alerts.ts ALERT_EVENTS).
    prod_type: variant === 'long' ? 'Excessive Heat Warning' : 'Red Flag Warning',
    onset: new Date(hour - 2 * HOUR_MS).toISOString(),
    ends: new Date(hour + 22 * HOUR_MS).toISOString(),
    expiration: hour + 24 * HOUR_MS,
    wfo: NWS_FIXTURE_WFO
  };
}

/** Route the layer's one WWA query (GET .../MapServer/1/query, f=geojson) to the fixture alert. Register before gotoApp. */
export async function routeNwsAlert(page: Page, variant: EventStationVariant = 'default'): Promise<void> {
  const body = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: nwsProperties(variant), geometry: WA_COVER }]
  };
  await page.route(
    (url) => url.pathname.includes('/WWA/watch_warn_adv/MapServer') && url.pathname.endsWith('/MapServer/1/query') && url.searchParams.get('f') === 'geojson',
    (route: Route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(body) })
        : route.fallback()
  );
}

/** The Day 1 outlook period in the issuer's own format (UTC). */
export const SPC_FIXTURE_VALID = '202610051200';
export const SPC_FIXTURE_EXPIRE = '202610061200';

/**
 * Route the layer's Day 1 outlook query (layer 1, `outFields=dn,valid,expire`,
 * no point geometry) to one Critical polygon (Extremely Critical in the long
 * variant, the longest category word). The briefing's own point queries carry
 * a geometry and fall through to gotoApp's SPC stub. Register before gotoApp.
 */
export async function routeSpcOutlook(page: Page, variant: EventStationVariant = 'default'): Promise<void> {
  const body = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { dn: variant === 'long' ? 10 : 8, valid: SPC_FIXTURE_VALID, expire: SPC_FIXTURE_EXPIRE },
        geometry: WA_COVER
      }
    ]
  };
  await page.route(
    (url) =>
      url.pathname.includes('/SPC_firewx/MapServer/1/query') &&
      url.searchParams.get('outFields') === 'dn,valid,expire' &&
      !url.searchParams.has('geometry'),
    (route: Route) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(body) })
  );
}

/** The South Puget Sound framing's fitted centre (the Mercator middle of its padded bounds). */
export const POWER_CENTRE: readonly [number, number] = [-122.65, 47.2015];
/** About 50 to 75 px north of the centre at the 360x300 embed's fitted zoom: above its bottom dock. */
const EMBED_PLANT_NORTH_DEG = 0.2;

export const PLANT_FIXTURE_NAME = 'Synthetic Frame Fixture Generating Station';
export const PLANT_LONG_NAME = 'Synthetic Frame Fixture Generating Station With A Deliberately Long Plant Name That Wraps In The Head';

function plantFeatures(variant: EventStationVariant): unknown[] {
  return [
    {
      type: 'Feature',
      properties: {
        Plant_Name: variant === 'long' ? PLANT_LONG_NAME : PLANT_FIXTURE_NAME,
        PrimSource: 'hydroelectric',
        Total_MW: 24,
        Utility_Na: variant === 'long' ? 'Synthetic Frame Fixture Public Utility District Number Two Of A Long Name County' : 'Synthetic Power',
        Period: '202502'
      },
      geometry: {
        type: 'Point',
        coordinates: [POWER_CENTRE[0], POWER_CENTRE[1] + (variant === 'embed' ? EMBED_PLANT_NORTH_DEG : 0)]
      }
    }
  ];
}

export const LINE_FIXTURE_OWNER = 'BONNEVILLE POWER ADMINISTRATION';
const LINE_LONG_OWNER = 'SYNTHETIC FRAME FIXTURE TRANSMISSION COOPERATIVE WITH A DELIBERATELY LONG OWNER NAME';

function lineProperties(variant: EventStationVariant): Record<string, unknown> {
  return {
    VOLT_CLASS: '500',
    VOLTAGE: 500,
    OWNER: variant === 'long' ? LINE_LONG_OWNER : LINE_FIXTURE_OWNER,
    STATUS: 'IN SERVICE',
    TYPE: 'AC; OVERHEAD'
  };
}

/** The synthetic archive's extent: the framing's padded bounds and a margin. */
const ARCHIVE_BOUNDS: [number, number, number, number] = [-123.6, 46.5, -121.7, 47.9];

/**
 * The transmission-line archive for one case: for the line fixture, a
 * north-south line on the centre's longitude and an east-west line on its
 * latitude (so every centre probe lies within the coordinator's 6 px click
 * box of one); for the plant fixture, one line far west of every probe.
 */
function linesArchive(id: 'power-plant' | 'power-line', variant: EventStationVariant): Buffer {
  const [lon, lat] = POWER_CENTRE;
  const props = lineProperties(variant);
  const lines: [number, number][][] =
    id === 'power-line'
      ? [
          [[lon, ARCHIVE_BOUNDS[1]], [lon, ARCHIVE_BOUNDS[3]]],
          [[ARCHIVE_BOUNDS[0], lat], [ARCHIVE_BOUNDS[2], lat]]
        ]
      : [[[ARCHIVE_BOUNDS[0] + 0.1, ARCHIVE_BOUNDS[1]], [ARCHIVE_BOUNDS[0] + 0.1, ARCHIVE_BOUNDS[3]]]];
  const fc: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: lines.map((coordinates) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates } }))
  };
  return geojsonLayersToPmtiles({ 'power-lines': fc }, { minZoom: 0, maxZoom: 11, bounds: ARCHIVE_BOUNDS, tolerance: 0 }).archive;
}

/**
 * Route the bundled transmission-line archive to `archive`, answering each
 * byte range with a 206 and its Content-Range (the layer's header probe
 * checks the archive's declared extent against that total).
 */
async function routeLinesArchive(page: Page, archive: Buffer): Promise<void> {
  await page.route('**/data/power-lines-pnw.pmtiles', (route: Route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()['range'] ?? '');
    if (!range) {
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: archive });
    }
    const start = Number(range[1]);
    const end = Math.min(range[2] === '' ? archive.length - 1 : Number(range[2]), archive.length - 1);
    return route.fulfill({
      status: 206,
      contentType: 'application/octet-stream',
      headers: { 'Content-Range': `bytes ${start}-${end}/${archive.length}`, 'Accept-Ranges': 'bytes' },
      body: archive.subarray(start, end + 1)
    });
  });
}

/** Route the EIA plants read to the fixture plant (none for the line fixture). Register before gotoApp. */
async function routePlants(page: Page, features: unknown[]): Promise<void> {
  await page.route(
    (url) => url.href.includes('/Power_Plants_in_the_US/') && url.pathname.endsWith('/query'),
    (route: Route) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify({ type: 'FeatureCollection', features }) })
  );
}

interface EventStationCase {
  readonly id: EventStationId;
  readonly layerKey: string;
  readonly region: string;
  readonly layerIds: readonly string[];
  /** The primary source link, or the stated no-source reason (the body's source-fallback slot). */
  readonly source: { readonly label: string; readonly href: string } | { readonly none: string };
  readonly moreLinks: readonly { readonly label: string; readonly href: string }[];
}

/** The line's stated source (the HIFLD acknowledgement credit, src/config/acknowledgements.ts, cite sheet c05). */
export const LINE_SOURCE_STATEMENT =
  'Transmission lines: U.S. Electric Power Transmission Lines (U.S. Government), archived copy last updated 2024-09-30, via the Esri Federal User Community.';

export const EVENT_STATION_CASES: Readonly<Record<EventStationId, EventStationCase>> = {
  nws: {
    id: 'nws',
    layerKey: 'nws-alerts',
    region: 'washington_state',
    layerIds: ['nws-alerts-fill'],
    source: { label: 'NWS Active Alerts', href: 'https://alerts.weather.gov/' },
    moreLinks: [{ label: 'NWS Heat Safety', href: 'https://www.weather.gov/safety/heat' }]
  },
  spc: {
    id: 'spc',
    layerKey: 'spc-fire-weather',
    region: 'washington_state',
    layerIds: ['spc-fire-weather-fill'],
    source: { label: 'SPC Fire Weather Outlooks', href: 'https://www.spc.noaa.gov/products/fire_wx/' },
    moreLinks: []
  },
  'power-plant': {
    id: 'power-plant',
    layerKey: 'power-infrastructure',
    region: 'south_puget_sound',
    layerIds: ['power-plants'],
    source: { label: 'EIA Form 860 documentation', href: 'https://www.eia.gov/electricity/data/eia860/' },
    moreLinks: []
  },
  'power-line': {
    id: 'power-line',
    layerKey: 'power-infrastructure',
    region: 'south_puget_sound',
    layerIds: ['power-lines', 'power-lines-unknown'],
    source: { none: LINE_SOURCE_STATEMENT },
    moreLinks: []
  }
};

/** Route and boot one builder's layer alone; `extra` adds query keys (`&embed=true`). */
export async function bootEventStation(
  page: Page,
  id: EventStationId,
  options: { readonly variant?: EventStationVariant; readonly view?: 'console' | 'brief'; readonly extra?: string } = {}
): Promise<void> {
  const c = EVENT_STATION_CASES[id];
  const variant = options.variant ?? 'default';
  if (id === 'nws') await routeNwsAlert(page, variant);
  else if (id === 'spc') await routeSpcOutlook(page, variant);
  else {
    await routeLinesArchive(page, linesArchive(id, variant));
    await routePlants(page, id === 'power-plant' ? plantFeatures(variant) : []);
  }
  await gotoApp(page, `?region=${c.region}&view=${options.view ?? 'console'}&layers=${c.layerKey}${options.extra ?? ''}`);
  await waitForLayerSettled(page, c.layerKey);
  // A failed read settles too; the click below needs the drawn layer.
  await expect(layerPill(page, c.layerKey), `${id}: the layer drew its fixture`).toHaveClass(/\bready\b/);
}

// ---------------------------------------------------------------------------
// Clicks and reads
// ---------------------------------------------------------------------------

/**
 * The points a fixture clicks, in turn: the map's on-screen centre, a column
 * of probes above and below it every 8 px (the plant sits on the centre, or
 * above the embed's dock; every one of them lies within the coordinator's
 * 6 px click box of the line fixture's north-south line), and two probes on
 * the centre's row (the east-west line). Only points where the map canvas is
 * the topmost element are kept (the embed's bottom dock covers the centre at
 * 360x300). Throws naming the element over the centre when none is uncovered.
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
    const probes: [number, number][] = [[0, 0], [-24, 0], [24, 0]];
    for (let dy = 8; dy <= 96; dy += 8) probes.push([0, -dy], [0, dy]);
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
 * Click (the centre, then the probes in turn) until the map popup shows one
 * of the builder's responses, or, with `seen`, until the census audit has
 * recorded one.
 */
export async function clickUntilEventStationResponse(
  page: Page,
  id: EventStationId,
  seen?: (page: Page) => Promise<readonly string[]>
): Promise<void> {
  const c = EVENT_STATION_CASES[id];
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

/**
 * The line count of each head slot of the displayed frame (the M27 line
 * rule, tests/text-lines.ts `lineCounts`: a word starts a new line when its
 * top is at or below the previous word's bottom), keyed by slot; a slot the
 * head does not hold is absent. Null when no frame head is displayed.
 */
export async function headSlotLines(page: Page): Promise<Record<string, number> | null> {
  return page.evaluate(() => {
    const head = document.querySelector('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame] > [data-popup-region="head"]');
    if (!head) return null;
    const out: Record<string, number> = {};
    for (const slot of ['title', 'issuer', 'value', 'clock', 'source']) {
      const el = head.querySelector(`:scope > [data-popup-slot="${slot}"]`);
      if (!el) continue;
      const tops: { top: number; bottom: number }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (const match of text.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index ?? 0);
          range.setEnd(node, (match.index ?? 0) + match[0].length);
          const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
          const last = rects[rects.length - 1];
          if (last) tops.push({ top: last.top, bottom: last.bottom });
        }
      }
      let lines = tops.length > 0 ? 1 : 0;
      for (let i = 1; i < tops.length; i += 1) {
        if (tops[i]!.top >= tops[i - 1]!.bottom - 1) lines += 1;
      }
      out[slot] = lines;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// The census fixtures
// ---------------------------------------------------------------------------

function censusFixture(id: EventStationId): CensusFixture {
  return async (page: Page, h: CensusHelpers) => {
    await bootEventStation(page, id);
    await clickUntilEventStationResponse(page, id, async (p) => (await h.readAudit(p)).seen);
    // The ONE validator (window.__ddmFrameCheck): the displayed root is the
    // frame article, its regions carry the coordinated classes, and the head
    // slots are non-empty (a head with no source link has the stated reason
    // in the body). A legacy response is handed in as the root, so the
    // validator names the failure ("not exactly one frame root").
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

export const EVENT_STATION_CENSUS_FIXTURES: Readonly<Record<string, CensusFixture>> = {
  nws: censusFixture('nws'),
  spc: censusFixture('spc'),
  'power-plant': censusFixture('power-plant'),
  'power-line': censusFixture('power-line')
};

// ---------------------------------------------------------------------------
// The PF3 tier fixtures (the M25 and M26a pattern, tests/frame-fixtures-fires-labels.ts)
// ---------------------------------------------------------------------------

/**
 * src/ui/popup-viewport.ts: MIN_USABLE_REGION_HEIGHT_PX, MIN_USABLE_REGION_WIDTH_PX, MIN_COMPACT_BODY_REGION_HEIGHT_PX.
 * Exported with the three helpers below for the station builder's tier
 * fixture (tests/frame-fixtures-telemetry.ts, M26c).
 */
export const FULL_HEIGHT_PX = 91;
export const USABLE_WIDTH_PX = 88;
export const COMPACT_BODY_HEIGHT_PX = 47;

/** The embed's reachable region: the viewport and the map rect, inset by the clamp's 12px margin. */
export async function embedRegion(page: Page): Promise<{ top: number; left: number; bottom: number; right: number; h: number; w: number }> {
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
export async function bodyLineReachable(target: Locator, edge: 'first' | 'last'): Promise<string> {
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
export async function strictHit(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return 'no box';
    const found = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return found !== null && (found === el || el.contains(found)) ? 'ok' : `hit ${found ? found.tagName.toLowerCase() : 'nothing'}`;
  });
}

/**
 * The M26a card read (tests/frame-fixtures-fires-labels.ts `readCard`), for
 * a builder whose source may have no link. `readCard` lists every one of the
 * five head slots that is not inside the visible head, an absent one too;
 * the frame prints no head source for a source with no link (the head fits,
 * S30D block 3), so for such a builder the absent source slot is checked
 * here instead (no source slot in the head, the stated reason in the body)
 * and left out of that list. Every present slot stays checked.
 */
async function readOwnCard(page: Page, id: EventStationId): Promise<CardRead | null> {
  const read = await readCard(page);
  if (read === null || 'href' in EVENT_STATION_CASES[id].source) return read;
  const frame = page.locator('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]');
  await expect(frame.locator(':scope > [data-popup-region="head"] > [data-popup-slot="source"]'), `${id}: no head source slot`).toHaveCount(0);
  await expect(frame.locator(':scope > [data-popup-region="body"] > [data-popup-slot="source-fallback"]'), `${id}: the stated source`).toHaveText(
    (EVENT_STATION_CASES[id].source as { readonly none: string }).none
  );
  return { ...read, slotsOutside: read.slotsOutside.filter((slot) => slot !== 'source') };
}

function tierFixture(id: EventStationId): TierFixture {
  const c = EVENT_STATION_CASES[id];
  return {
    async sourcesAtTierBoundaries(page) {
      await page.setViewportSize({ width: 360, height: 300 });
      await bootEventStation(page, id, { variant: 'embed', extra: '&embed=true' });
      await clickUntilEventStationResponse(page, id);
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
        // The primary source (or, with no link, its stated reason), body-reachable under squeeze (PF3).
        const fallback = body.locator(':scope > [data-popup-slot="source-fallback"]');
        if ('href' in c.source) {
          const link = fallback.locator('a');
          await expect(link).toHaveAttribute('href', c.source.href);
          await expect(link).toHaveText(c.source.label);
          await expect
            .poll(() => bodyLineReachable(link, 'first'), { message: `${id} ${tier.name}: the primary source is hit-test reachable`, timeout: 7_000 })
            .toBe('ok');
        } else {
          await expect(fallback).toHaveText(c.source.none);
          await expect(fallback.locator('a'), `${id}: the stated reason links nowhere`).toHaveCount(0);
          await expect
            .poll(() => bodyLineReachable(fallback, 'first'), { message: `${id} ${tier.name}: the stated source is hit-test reachable`, timeout: 7_000 })
            .toBe('ok');
        }
        // The last qualification: every builder here carries its caveat.
        const notes = body.locator(':scope > [data-popup-slot="note"]');
        await expect
          .poll(() => bodyLineReachable(notes.last(), 'last'), { message: `${id} ${tier.name}: the last qualification is scroll-reachable`, timeout: 7_000 })
          .toBe('ok');
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
      await bootEventStation(page, id, { variant: 'long' });
      const popup = page.locator('.maplibregl-popup');
      for (const seat of seats) {
        await page.setViewportSize(seat);
        await page.keyboard.press('Escape');
        await expect(popup).toHaveCount(0);
        await clickUntilEventStationResponse(page, id);
        // The response is one framed card (so red on the legacy cards names the
        // missing frame, not the late door).
        await expect(page.locator('.maplibregl-popup [data-popup-frame]'), `${id} at ${seat.width}x${seat.height}: the response is a framed card`).toHaveCount(1);
        // The late door lands after the paint (DR-042 a; every click here is
        // inside Washington) and grows the head; wait for it, then for the
        // card to hold still, and read once.
        await expect(page.locator(FRAMED_LATE_DOOR), `${id} at ${seat.width}x${seat.height}: the late door in the actions slot`).toBeVisible({
          timeout: 10_000
        });
        await settleCard(page);
        const at = `${id} at ${seat.width}x${seat.height}`;
        expectHeadVisibleBodyScrolls(await readOwnCard(page, id), at);
        await expect
          .poll(() => strictHit(page.locator('.maplibregl-popup .maplibregl-popup-content > .maplibregl-popup-close-button')), {
            message: `${at}: the close control is hit-test reachable`,
            timeout: 7_000
          })
          .toBe('ok');
      }

      // The panel half: every response here is non-place, so it never routes
      // to the panel-foot sink (interaction-coordinator.ts renderPopup); in
      // the Brief shell with the sidebar open each opens the map popup.
      await page.setViewportSize({ width: 1440, height: 900 });
      await bootEventStation(page, id, { view: 'brief', variant: 'long' });
      await clickUntilEventStationResponse(page, id);
      await expect(page.locator('.maplibregl-popup .maplibregl-popup-content > [data-popup-frame]')).toHaveCount(1);
      await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
    }
  };
}

export const EVENT_STATION_TIER_FIXTURES: Readonly<Record<string, TierFixture>> = {
  nws: tierFixture('nws'),
  spc: tierFixture('spc'),
  'power-plant': tierFixture('power-plant'),
  'power-line': tierFixture('power-line')
};
