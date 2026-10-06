import { readFileSync } from 'node:fs';
import type { Map as MlMap } from 'maplibre-gl';

import { expect, test, type Locator, type Page, type Route } from './offline-test';

import * as ensoFlowData from '../src/layers/enso-flow-data';
import { locateMessage } from '../src/layers/flow/nodd';
import { FLOW_SOURCES, frameGrid } from '../src/layers/flow/source';
import { gotoApp, layerCheckbox, noddStubLog } from './helpers';

/*
 * ENSO-FLOW-PLAN block E2, unit E2-1 (FLOW-WIRE): in ENSO mode, Wind and
 * Waves draw NOAA GFS 10 m wind and GFS-Wave peak direction as flowing paths
 * (or their still form), read from NOAA's public NODD bucket, in place of
 * the static Open-Meteo arrows. Ocean currents keep the interim arrows and
 * their DR-161 credits.
 *
 * Every NODD read is answered by tests/helpers.ts `installDefaultNoddStub`
 * from the 2026-10-05 06Z f006 fixtures (or by a route of the case's own),
 * and `noddStubLog` names exactly which keys and ranges were read. The page
 * clock is fixed (`page.clock.setFixedTime`, timers keep running) at
 * 2026-10-05 12:30 UTC, where the reader's candidate cycle is 06Z and both
 * kinds' forecast hour is 6, so the fixtures are the frame it asks for; the
 * stale case then moves the clock past cycle + 24 h.
 *
 * The panel stamps what the flow view draws (`data-flow-form`,
 * `data-flow-motion`, `data-flow-features`, `data-flow-drawn`, and
 * `data-flow-renders`, the count of MapLibre `render` events while the view
 * is mounted); no case waits on MapLibre 'idle', which a running loop
 * starves.
 */

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const OPEN_METEO = /^https:\/\/(?:marine-api|api)\.open-meteo\.com\//;
const NODD = /^https:\/\/noaa-gfs-bdp-pds\.s3\.amazonaws\.com\//;
const FIXTURE_CYCLE = Date.UTC(2026, 9, 5, 6);
const FIXTURE_VALID = Date.UTC(2026, 9, 5, 12);
/** Candidate cycle 06Z; wind (3-hourly) and waves (hourly) both at f006. */
const LIVE_CLOCK = Date.UTC(2026, 9, 5, 12, 30);
/** Past the fixtures' cycle + 24 h (2026-10-06 06Z). */
const STALE_CLOCK = Date.UTC(2026, 9, 6, 6, 30);
const FAILED_NOTE = 'No direction or calm condition is inferred from a failed request.';
const WIND_IDX = 'gfs.20261005/06/atmos/gfs.t06z.pgrb2.1p00.f006.idx';
// A namespace read, so this file still loads (and each case fails on its own
// assertion) on code that does not export the flow words yet.
const { FLOW_WORDS, flowLiveLine, flowStaleLine } = ensoFlowData;
const WAVE_IDX = 'gfswave.t06z.global.0p25.f006.grib2.idx';

function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/flow/${name}`, import.meta.url), 'latin1').replaceAll('\r\n', '\n');
}

/** The Range header the reader sends for a message, from the fixture `.idx`. */
function spanRange(idxFile: string, variable: string, level: string): string {
  const { start, end } = locateMessage(fixtureText(idxFile), { variable, level, parameter: { discipline: 0, category: 0, number: 0 } }, FIXTURE_CYCLE, 6);
  return `bytes=${start}-${end}`;
}

async function stubSst(page: Page): Promise<void> {
  await page.route((url) => url.href.includes('DescribeDomains'), (route) => route.fulfill({
    status: 200, contentType: 'text/xml',
    body: "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-01/2026-09-07/P1D</Domain><Size>1</Size></DimensionDomain></Domains>"
  }));
  await page.route((url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
}

/** Record every Open-Meteo request; answer currents with a 40-cell live sample at the page clock. */
async function stubOpenMeteo(page: Page, clock: number): Promise<URL[]> {
  const calls: URL[] = [];
  await page.route(OPEN_METEO, async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const latitudes = url.searchParams.get('latitude')!.split(',').map(Number);
    const longitudes = url.searchParams.get('longitude')!.split(',').map(Number);
    const time = Math.floor(clock / 900_000) * 900;
    const body = latitudes.map((latitude, i) => ({
      latitude, longitude: longitudes[i],
      current_units: { time: 'unixtime', ocean_current_velocity: 'm/s', ocean_current_direction: '°' },
      current: { time, interval: 900, ocean_current_velocity: 0.4, ocean_current_direction: 90 }
    }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return calls;
}

/**
 * ENSO opens with wind on since E2-4, so a boot that names no `flow=` here
 * adds `flow=off`: every case below starts from off and chooses its kind, as
 * it did before the default. `motion: 'live'` leaves the motion loop to the
 * page (the cases that read the moving form); the rest take `gotoApp`'s hold
 * and read the same paths in their still form.
 */
async function bootEnso(page: Page, query = '', clock = LIVE_CLOCK, motion: 'hold' | 'live' = 'hold'): Promise<URL[]> {
  await page.clock.setFixedTime(clock);
  await stubSst(page);
  const calls = await stubOpenMeteo(page, clock);
  const named = /(?:^|&)flow=/.test(query) ? query : `${query}&flow=off`;
  await gotoApp(page, `?cluster=enso&ocean=pacific${named}`, { flowMotion: motion });
  return calls;
}

function panel(page: Page): Locator {
  return page.locator('.enso-flow');
}

async function choose(page: Page, kind: 'off' | 'currents' | 'wind' | 'waves'): Promise<void> {
  await panel(page).locator(`[data-flow-kind="${kind}"]`).click();
}

async function openKeyDrawer(page: Page): Promise<void> {
  const toggle = page.locator('#map-key-details-toggle');
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(page.locator('#map-key-content')).toBeVisible();
}

const flowStatus = (page: Page): Locator => page.locator('#map-key [data-enso-flow="status"]');
const flowNotes = (page: Page): Locator => page.locator('#map-key [data-enso-flow="notes"]');
const flowProvenance = (page: Page): Locator => page.locator('#map-key [data-enso-flow="provenance"]');

interface FlowRestoreWindow extends Window {
  __flowRestoreMaps?: MlMap[];
  __flowRestoreExtension?: WEBGL_lose_context;
  __flowRestoreComplete?: boolean;
}

/** Observe the actual map constructor, as in flow-plumb; do not replace its methods. */
async function captureFlowRestoreMap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const maps: MlMap[] = [];
    (window as FlowRestoreWindow).__flowRestoreMaps = maps;
    Object.defineProperty(Object.prototype, '_onWindowOnline', {
      configurable: true,
      set(this: MlMap, value: unknown) {
        Object.defineProperty(this, '_onWindowOnline', { configurable: true, enumerable: true, writable: true, value });
        maps.push(this);
      }
    });
  });
}

/** Count geometric grid nodes with the actual camera, independently of masks and direction marks. */
async function geometricNodeCount(page: Page, kind: 'wind' | 'waves'): Promise<number> {
  return page.evaluate((grid) => {
    const map = (window as FlowRestoreWindow).__flowRestoreMaps!.find((candidate) => candidate.getContainer().id === 'map')!;
    const bounds = map.getBounds();
    const canvas = map.getCanvas();
    const center = map.getCenter().lng;
    const first = Math.max(0, Math.ceil((grid.lat0 - bounds.getNorth()) / grid.dlat - 1e-9));
    const last = Math.min(grid.ny - 1, Math.floor((grid.lat0 - bounds.getSouth()) / grid.dlat + 1e-9));
    let count = 0;
    for (let row = first; row <= last; row++) {
      for (let column = 0; column < grid.nx; column++) {
        let longitude = grid.lon0 + column * grid.dlon;
        longitude += Math.round((center - longitude) / 360) * 360;
        const point = map.project([longitude, grid.lat0 - row * grid.dlat]);
        if (point.x >= 0 && point.x <= canvas.clientWidth && point.y >= 0 && point.y <= canvas.clientHeight) count++;
      }
    }
    return count;
  }, frameGrid(kind));
}

/** A dated instant in the page's own Intl, the panel's own format. */
async function pageDate(page: Page, time: number): Promise<string> {
  return page.evaluate((ms) => new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
  }).format(ms), time);
}

/** MapLibre renders counted by the flow view inside one window of `ms` (a sample of a continuous signal). */
async function rendersOver(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (windowMs) => {
    const node = document.querySelector<HTMLElement>('.enso-flow');
    const read = (): number => Number(node?.dataset['flowRenders'] ?? 0);
    const before = read();
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    return read() - before;
  }, ms);
}

/** The ribbon layer's advection steps inside one window of `ms`: it steps only while it is in the style and drawing. */
async function stepsOver(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (windowMs) => {
    const node = document.querySelector<HTMLElement>('.enso-flow');
    const read = (): number => Number(node?.dataset['flowSteps'] ?? 0);
    const before = read();
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    return read() - before;
  }, ms);
}

async function dragMap(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.locator('#map').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
  await page.mouse.up();
}

test.describe('E2-1 flow words', () => {
  /** Every flow sentence: the table's leaves plus each composed line. */
  function flowStrings(): string[] {
    expect(FLOW_WORDS, 'the one table of flow words (src/layers/enso-flow-data.ts)').toBeDefined();
    const out: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') out.push(value);
      else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
    };
    walk(FLOW_WORDS);
    out.push(flowLiveLine('live', FIXTURE_CYCLE, FIXTURE_VALID), flowLiveLine('live (partial)', FIXTURE_CYCLE, FIXTURE_VALID));
    out.push(flowStaleLine('wind', FIXTURE_CYCLE), flowStaleLine('waves', FIXTURE_CYCLE));
    return out;
  }

  test('no flow string contains now, right now, currently, real-time, latest or today', () => {
    const strings = flowStrings();
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) {
      expect(s, s).not.toMatch(/\bnow\b|\bright now\b|\bcurrently\b|\breal-time\b|\blatest\b|\btoday\b/i);
      expect(s, s).not.toMatch(/\bforecasts?\b|\bwill\b|\bexpected\b|\bpredict/i);
    }
  });

  test("no flow string contains trajectory, carries, drift, where the wind goes or travels to, and 'path of' appears only inside the one DRAFT negation 'not the path of anything carried by it'", () => {
    const strings = flowStrings();
    for (const s of strings) {
      expect(s, s).not.toMatch(/\btrajector(?:y|ies)\b|\bcarries\b|\bdrift|where the wind goes|\btravels to\b/i);
    }
    const pathOf = strings.filter((s) => /\bpath of\b/i.test(s));
    expect(pathOf).toEqual([FLOW_WORDS.instant]);
    expect(FLOW_WORDS.instant).toContain('not the path of anything carried by it');
    expect(FLOW_WORDS.instant.match(/\bpath of\b/gi)).toHaveLength(1);
  });
});

test.describe('E2-1 flowing paths in ENSO mode', () => {
  test('ENSO wind reads only the NODD .idx and two ranges, and no Open-Meteo host', async ({ page }) => {
    const calls = await bootEnso(page);
    const requested: string[] = [];
    page.on('request', (request) => { if (OPEN_METEO.test(request.url())) requested.push(request.url()); });
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    const log = noddStubLog(page).map(({ method, url, range, answer }) => ({ method, url, range, answer }));
    const key = `https://noaa-gfs-bdp-pds.s3.amazonaws.com/${WIND_IDX.replace(/\.idx$/, '')}`;
    expect(log).toHaveLength(3);
    expect(log[0]).toEqual({ method: 'GET', url: `${key}.idx`, range: 'bytes=0-65535', answer: 'fixture' });
    // The two message reads run together, so their order is not fixed.
    const messages = log.slice(1).sort((a, b) => (a.range ?? '').localeCompare(b.range ?? ''));
    expect(messages).toEqual([
      { method: 'GET', url: key, range: spanRange('gfs.t06z.pgrb2.1p00.f006.idx', 'UGRD', '10 m above ground'), answer: 'fixture' },
      { method: 'GET', url: key, range: spanRange('gfs.t06z.pgrb2.1p00.f006.idx', 'VGRD', '10 m above ground'), answer: 'fixture' }
    ].sort((a, b) => a.range.localeCompare(b.range)));
    expect(calls, 'no Open-Meteo read for wind').toHaveLength(0);
    expect(requested).toEqual([]);
  });

  test('waves read the .idx, DIRPW and HTSGW, and never PERPW', async ({ page }) => {
    const calls = await bootEnso(page);
    await choose(page, 'waves');
    await expect(panel(page)).toHaveAttribute('data-status', /^live/);
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'waves');
    const log = noddStubLog(page);
    const key = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261005/06/wave/gridded/gfswave.t06z.global.0p25.f006.grib2';
    expect(log.map((e) => e.answer)).toEqual(['fixture', 'fixture', 'fixture']);
    expect(log[0]).toMatchObject({ method: 'GET', url: `${key}.idx`, range: 'bytes=0-4095' });
    const ranges = log.slice(1).map((e) => { expect(e.url).toBe(key); return e.range; }).sort();
    expect(ranges).toEqual([spanRange(WAVE_IDX, 'DIRPW', 'surface'), spanRange(WAVE_IDX, 'HTSGW', 'surface')].sort());
    expect(ranges).not.toContain(spanRange(WAVE_IDX, 'PERPW', 'surface'));
    expect(FLOW_SOURCES.waves.messages.map((m) => m.variable)).toEqual(['DIRPW', 'HTSGW']);
    expect(calls).toHaveLength(0);
  });

  test('the drawer line reads live · Model run <date> · Model valid <date>, with no now and no forecast', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await bootEnso(page, '&embed=true&flow=wind');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await openKeyDrawer(page);
    const run = await pageDate(page, FIXTURE_CYCLE);
    const valid = await pageDate(page, FIXTURE_VALID);
    await expect(flowStatus(page)).toHaveText(`Atmospheric currents · live · Model run ${run} · Model valid ${valid}`);
    const text = `${await flowStatus(page).textContent()} ${await flowNotes(page).textContent()}`;
    expect(text).not.toMatch(/\bnow\b|\bforecast/i);
    await expect(flowNotes(page)).toContainText(FLOW_WORDS.instant);
    await expect(flowNotes(page)).toContainText('This is model context, independently timed from the observed SST map.');
    // Two products, two clocks: the SST date keeps its own node.
    await expect(page.locator('#map-key [data-sst-observed]')).not.toContainText('Model');
    await expect(flowStatus(page)).not.toContainText('Observed');
  });

  test('derived from NOAA GFS shows as text in the drawer and the panel; there is no attribution line', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await bootEnso(page);
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await openKeyDrawer(page);
    await expect(flowProvenance(page)).toHaveText('derived from NOAA GFS');
    await expect(flowProvenance(page).locator('img, svg, a')).toHaveCount(0);
    const credit = panel(page).locator('[data-enso-flow-provenance]');
    await expect(credit).toHaveText('derived from NOAA GFS');
    await expect(credit.locator('img, svg, a')).toHaveCount(0);
    const panelText = (await panel(page).textContent())!;
    expect(panelText).not.toContain('Open-Meteo');
    expect(panelText).not.toContain('Copernicus');
    const attribution = page.locator('.maplibregl-ctrl-attrib');
    for (const text of await attribution.allTextContents()) {
      expect(text).not.toMatch(/Open-Meteo|GFS/);
    }
  });

  test('the provenance item reads derived from NOAA GFS for waves too, marked for read-back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await bootEnso(page);
    await choose(page, 'waves');
    await expect(panel(page)).toHaveAttribute('data-status', /^live/);
    await openKeyDrawer(page);
    await expect(flowStatus(page)).toContainText('Ocean waves · live');
    await expect(flowProvenance(page)).toHaveText('derived from NOAA GFS');
    await expect(panel(page).locator('[data-enso-flow-provenance]')).toHaveText('derived from NOAA GFS');
    // The GFS-Wave use of the owner's words is on the landing read-back (ENSO-FLOW-PLAN question 6).
    const source = readFileSync(new URL('../src/layers/enso-flow-data.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\/\/ DRAFT wording \(DR-177\):[^\n]*GFS-Wave[^\n]*\n\s*provenance: 'derived from NOAA GFS'/);
  });

  test('a 404 thrice reads unavailable plus the FAILED_NOTE, and nothing draws', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const asked: { url: string; range: string | null }[] = [];
    await page.route(NODD, async (route) => {
      asked.push({ url: route.request().url(), range: (await route.request().headerValue('range')) ?? null });
      await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/xml', body: '' });
    });
    await bootEnso(page);
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-status', 'unavailable');
    await expect(panel(page).locator('.enso-flow-status')).toHaveText('unavailable · NOAA GFS wind did not load');
    expect(asked.map((a) => a.url.replace('https://noaa-gfs-bdp-pds.s3.amazonaws.com/', ''))).toEqual([
      'gfs.20261005/06/atmos/gfs.t06z.pgrb2.1p00.f006.idx',
      'gfs.20261005/00/atmos/gfs.t00z.pgrb2.1p00.f012.idx',
      'gfs.20261004/18/atmos/gfs.t18z.pgrb2.1p00.f018.idx'
    ]);
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', '');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'none');
    await openKeyDrawer(page);
    await expect(flowStatus(page)).toHaveText('Atmospheric currents · unavailable · NOAA GFS wind did not load');
    await expect(flowNotes(page)).toHaveText(FAILED_NOTE);
    await expect(flowProvenance(page)).toHaveCount(0);
    await expect(page.locator('#map-key-flow-pause')).toBeHidden();
  });

  test('a frame past cycle + 24 h is never drawn', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bootEnso(page);
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    const reads = noddStubLog(page).length;
    await page.clock.setFixedTime(STALE_CLOCK);
    await dragMap(page, -80, -30);
    await expect(panel(page)).toHaveAttribute('data-status', 'unavailable');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', '');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'none');
    const run = await pageDate(page, FIXTURE_CYCLE);
    await expect(panel(page).locator('.enso-flow-status')).toHaveText(`unavailable · The held NOAA GFS frame from ${run} is past its 24-hour limit`);
    await openKeyDrawer(page);
    await expect(flowStatus(page)).toContainText('past its 24-hour limit');
    await expect(flowProvenance(page)).toHaveCount(0);
    // Nothing is read again for the held frame.
    expect(noddStubLog(page)).toHaveLength(reads);
  });

  test('an all-land wave view reads no data, never calm', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.clock.setFixedTime(LIVE_CLOCK);
    await stubSst(page);
    // Utah, framed by the state deep link: every GFS-Wave node in view is masked
    // (decoded in Node, the fixture's crop holds no water node from 118 W to
    // 100.5 W and 34.5 N to 44 N, which contains this view with room to spare).
    await gotoApp(page, '?cluster=enso&select=state:UT&flow=waves');
    await expect(panel(page)).toHaveAttribute('data-status', 'no data');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'none');
    await expect(panel(page)).toHaveAttribute('data-flow-features', '0');
    await expect(panel(page).locator('.enso-flow-status')).toHaveText('no data · No ocean values in this view');
    await openKeyDrawer(page);
    await expect(flowStatus(page)).toHaveText('Ocean waves · no data · No ocean values in this view');
    await expect(flowStatus(page)).not.toContainText(/calm/i);
    await expect(flowNotes(page)).toContainText('no marks does not mean calm water');
    await expect(page.locator('#map-key-flow-pause')).toBeHidden();
  });

  test('off intent aborts every range and stops the loop with no further render', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      const w = window as unknown as { __rafCalls: number };
      w.__rafCalls = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => raf((time) => { w.__rafCalls += 1; callback(time); });
    });
    // Hold the two message ranges; the .idx falls through to the suite's stub.
    const held: Route[] = [];
    await page.route(NODD, async (route) => {
      if ((await route.request().headerValue('range'))?.startsWith('bytes=0-')) await route.fallback();
      else held.push(route);
    });
    await bootEnso(page, '&view=console', LIVE_CLOCK, 'live');
    await choose(page, 'wind');
    await expect.poll(() => held.length).toBe(2);
    await expect(panel(page)).toHaveAttribute('data-status', 'loading');
    const failed = Promise.all(held.map((route) => page.waitForEvent('requestfailed', (r) => r === route.request())));
    await layerCheckbox(page, 'sst-anomaly').uncheck();
    await failed;
    for (const route of held) await route.fallback().catch(() => undefined);
    await expect(page.locator('#map-key [data-enso-flow]')).toHaveCount(0);

    // The loop: a moving wind field, then off intent, then no more frames.
    await page.unroute(NODD);
    await layerCheckbox(page, 'sst-anomaly').check();
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'moving');
    await expect.poll(() => rendersOver(page, 1000)).toBeGreaterThan(2);
    await layerCheckbox(page, 'sst-anomaly').uncheck();
    await expect(page.locator('.enso-flow')).toHaveCount(0);
    const framesOver = (ms: number): Promise<number> => page.evaluate(async (windowMs) => {
      const w = window as unknown as { __rafCalls: number };
      const before = w.__rafCalls;
      await new Promise((resolve) => setTimeout(resolve, windowMs));
      return w.__rafCalls - before;
    }, ms);
    await expect.poll(() => framesOver(500), { timeout: 15_000 }).toBe(0);
    expect(await framesOver(1500), 'no animation frame after off intent').toBe(0);
  });

  test('a kind change never draws two fields at once', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bootEnso(page);
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>('.enso-flow')!;
      const seen: string[] = [];
      (window as unknown as { __drawn: string[] }).__drawn = seen;
      new MutationObserver(() => {
        const value = `${node.dataset['flowDrawn'] ?? ''}|${node.dataset['status'] ?? ''}`;
        if (seen[seen.length - 1] !== value) seen.push(value);
      }).observe(node, { attributes: true, attributeFilter: ['data-flow-drawn', 'data-status'] });
    });
    await choose(page, 'waves');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'waves');
    const seen = await page.evaluate(() => (window as unknown as { __drawn: string[] }).__drawn);
    // Wind leaves first (nothing drawn, loading), and only then waves draw.
    expect(seen[0]?.startsWith('|')).toBe(true);
    expect(seen).toContain('|loading');
    expect(seen.indexOf('|loading')).toBeLessThan(seen.findIndex((s) => s.startsWith('waves|')));
    expect(seen.every((s) => !s.startsWith('wind|'))).toBe(true);
  });

  test('currents still draw the interim arrows with the DR-161 credits', async ({ page }) => {
    const calls = await bootEnso(page);
    await choose(page, 'currents');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page).locator('.enso-flow-status')).toContainText('Model valid');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchParams.get('models')).toBe('meteofrance_currents');
    expect(calls[0]!.searchParams.get('latitude')!.split(',').length).toBeLessThanOrEqual(40);
    await expect(panel(page).getByRole('link', { name: 'Weather data by Open-Meteo.com' })).toBeVisible();
    await expect(panel(page)).toContainText('Generated using E.U. Copernicus Marine Service Information');
    await expect(panel(page).getByRole('button', { name: 'Update area' })).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', '');
    await expect(panel(page).locator('[data-enso-flow-provenance]')).toHaveCount(0);
    expect(noddStubLog(page)).toHaveLength(0);
  });

  test('under reduced motion, wind shows the still streaks and 0 repaints in 2 s', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bootEnso(page);
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'still');
    await expect(panel(page)).toHaveAttribute('data-flow-motion', 'reduced');
    expect(Number(await panel(page).getAttribute('data-flow-features'))).toBeGreaterThan(20);
    const pause = page.locator('#map-key-flow-pause');
    await expect(pause).toBeVisible();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');
    await openKeyDrawer(page);
    await expect(flowNotes(page)).toContainText(FLOW_WORDS.reduced);
    await expect.poll(() => rendersOver(page, 500), { timeout: 15_000 }).toBe(0);
    expect(await rendersOver(page, 2000), 'MapLibre renders in 2 s under reduced motion').toBe(0);
  });

  test('Update area is hidden for wind and waves', async ({ page }) => {
    await bootEnso(page);
    const update = panel(page).getByRole('button', { name: 'Update area', includeHidden: true });
    await choose(page, 'wind');
    await expect(update).toBeHidden();
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page).locator('.enso-flow-status')).not.toContainText('Update area');
    await choose(page, 'waves');
    await expect(update).toBeHidden();
    await expect(panel(page)).toHaveAttribute('data-status', /^live/);
    await dragMap(page, -60, -20);
    await expect(panel(page).locator('.enso-flow-status')).not.toContainText('Update area');
    await choose(page, 'currents');
    await expect(update).toBeVisible();
  });

  test('after webglcontextlost the status stays, the still form draws, the detail says so, and restore rebuilds from CPU state with no refetch', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await bootEnso(page, '', LIVE_CLOCK, 'live');
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'moving');
    const reads = noddStubLog(page).length;
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#map canvas.maplibregl-canvas')!;
      const gl = canvas.getContext('webgl2')!;
      const lose = gl.getExtension('WEBGL_lose_context')!;
      (window as unknown as { __lose: WEBGL_lose_context }).__lose = lose;
      lose.loseContext();
    });
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'still');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    expect(Number(await panel(page).getAttribute('data-flow-features'))).toBeGreaterThan(20);
    await openKeyDrawer(page);
    await expect(flowStatus(page)).toContainText('Atmospheric currents · live · Model run ');
    await expect(flowNotes(page)).toContainText(FLOW_WORDS.context);
    await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'moving');
    await expect.poll(() => rendersOver(page, 1000)).toBeGreaterThan(2);
    // MapLibre drops custom layers on a lost context; the ribbon is added back
    // and rebuilt from its CPU state, so it advects again.
    await expect.poll(() => stepsOver(page, 1000), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(flowNotes(page)).not.toContainText(FLOW_WORDS.context);
    expect(noddStubLog(page), 'no refetch after the restore').toHaveLength(reads);
  });

  for (const scenario of [
    { kind: 'wind', action: 'off' }, { kind: 'waves', action: 'off' }, { kind: 'wind', action: 'leave' }
  ] as const) {
    test(`${scenario.kind}: ${scenario.action} while graphics are lost cannot restore old native flow marks`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await captureFlowRestoreMap(page);
      await bootEnso(page, '', LIVE_CLOCK, 'live');
      await choose(page, scenario.kind);
      await expect(panel(page)).toHaveAttribute('data-flow-form', 'moving');
      const pause = page.locator('#map-key-flow-pause');
      await pause.click();
      await expect(panel(page)).toHaveAttribute('data-flow-form', 'still');
      expect(Number(await panel(page).getAttribute('data-flow-features'))).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => {
        const map = (window as FlowRestoreWindow).__flowRestoreMaps!.find((candidate) => candidate.getContainer().id === 'map')!;
        return map.queryRenderedFeatures({ layers: ['flow-still', 'flow-still-marks'] }).length;
      })).toBeGreaterThan(0);
      const reads = noddStubLog(page).length;
      await page.evaluate(() => {
        const state = window as FlowRestoreWindow;
        const map = state.__flowRestoreMaps!.find((candidate) => candidate.getContainer().id === 'map')!;
        const extension = map.getCanvas().getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
        state.__flowRestoreExtension = extension;
        extension.loseContext();
      });
      await expect.poll(() => page.evaluate(() => {
        const map = (window as FlowRestoreWindow).__flowRestoreMaps!.find((candidate) => candidate.getContainer().id === 'map')!;
        return map.getStyle() === undefined;
      })).toBe(true);
      if (scenario.action === 'off') {
        await choose(page, 'off');
        await expect(panel(page)).toHaveAttribute('data-status', 'off');
      } else {
        await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
        await expect(page.locator('.shell-cluster-btn[data-cluster="drought"]')).toHaveAttribute('aria-pressed', 'true');
      }
      await page.evaluate(() => {
        const state = window as FlowRestoreWindow;
        const map = state.__flowRestoreMaps!.find((candidate) => candidate.getContainer().id === 'map')!;
        state.__flowRestoreComplete = false;
        map.once('style.load', () => { state.__flowRestoreComplete = true; });
        state.__flowRestoreExtension!.restoreContext();
      });
      await expect.poll(() => page.evaluate(() => (window as FlowRestoreWindow).__flowRestoreComplete)).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const map = (window as FlowRestoreWindow).__flowRestoreMaps!.find((candidate) => candidate.getContainer().id === 'map')!;
        return {
          source: Boolean(map.getSource('flow-still')),
          layers: map.getStyle().layers.filter((layer) => layer.id.startsWith('flow-')).map((layer) => layer.id)
        };
      })).toEqual({ source: false, layers: [] });
      expect(noddStubLog(page), 'restoration after Off or mode exit does not refetch the old frame').toHaveLength(reads);
    });
  }

  /**
   * Zoom the map in with MapLibre's own keyboard handler ("=" zooms to the
   * next whole zoom level), letting each step settle: under reduced motion
   * the map renders nothing once a move has finished.
   */
  async function zoomInSteps(page: Page, steps: number): Promise<void> {
    await page.locator('#map canvas.maplibregl-canvas').focus();
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press('Equal');
      await expect.poll(() => rendersOver(page, 400), { timeout: 15_000 }).toBe(0);
    }
  }

  test('wind zoomed in between grid nodes (z10) reads live with node arrows, never no data or the wave-marks words', async ({ page }) => {
    await captureFlowRestoreMap(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.setFixedTime(LIVE_CLOCK);
    await stubSst(page);
    // Utah framed by the state deep link (about z6.3), then four whole zoom steps: z10.
    await gotoApp(page, '?cluster=enso&select=state:UT&flow=wind');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'still');
    await zoomInSteps(page, 4);
    // Separate geometric coverage from drawable direction marks: an in-view
    // model point can lack a mark. The native camera provides the coverage proof.
    const nodes = await geometricNodeCount(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    const featureStamp = await panel(page).getAttribute('data-flow-features');
    expect(featureStamp).toMatch(/^\d+$/);
    const features = Number(featureStamp);
    expect(Number.isInteger(features) && features >= 0).toBe(true);
    const status = panel(page).locator('.enso-flow-status');
    await expect(status).toContainText('live · Model run ');
    await expect(status).not.toContainText('wave marks');
    await openKeyDrawer(page);
    await expect(flowStatus(page)).toContainText('Atmospheric currents · live · Model run ');
    if (features > 0) {
      expect(nodes).toBeGreaterThan(0);
      await expect(panel(page)).toHaveAttribute('data-flow-form', 'arrows');
      await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
      await expect(flowNotes(page)).toContainText(FLOW_WORDS.pastGrid);
    } else {
      // Native output is empty; the diagnostic stamps must agree with its count.
      await expect(panel(page)).toHaveAttribute('data-flow-form', 'none');
      await expect(panel(page)).toHaveAttribute('data-flow-drawn', '');
      await expect(panel(page)).toHaveAttribute('data-flow-features', '0');
      await expect(flowNotes(page)).toContainText(nodes > 0 ? FLOW_WORDS.noNodeDirection : FLOW_WORDS.noModelPoint);
    }
    await expect(flowNotes(page)).not.toContainText(FLOW_WORDS.waveBox);
  });

  test('waves zoomed in inside the crop (z12) read live with honest native-output stamps, never outside the wave marks area', async ({ page }) => {
    await captureFlowRestoreMap(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.setFixedTime(LIVE_CLOCK);
    await stubSst(page);
    // Hawaii framed by the state deep link, well inside the crop, then whole zoom steps to z12.
    await gotoApp(page, '?cluster=enso&select=state:HI&flow=waves');
    await expect(panel(page)).toHaveAttribute('data-status', /^live/);
    await zoomInSteps(page, 6);
    const nodes = await geometricNodeCount(page, 'waves');
    const featureStamp = await panel(page).getAttribute('data-flow-features');
    expect(featureStamp).toMatch(/^\d+$/);
    const features = Number(featureStamp);
    expect(Number.isInteger(features) && features >= 0).toBe(true);
    await expect(panel(page)).toHaveAttribute('data-flow-form', features > 0 ? 'arrows' : 'none');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', features > 0 ? 'waves' : '');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    const status = panel(page).locator('.enso-flow-status');
    await expect(status).not.toContainText(FLOW_WORDS.outside);
    await expect(status).toContainText('live · Model run ');
    await openKeyDrawer(page);
    await expect(flowStatus(page)).toContainText('Ocean waves · live · Model run ');
    if (features > 0) {
      expect(nodes).toBeGreaterThan(0);
      await expect(flowNotes(page)).toContainText(FLOW_WORDS.pastGrid);
    } else {
      await expect(flowNotes(page)).toContainText(nodes > 0 ? FLOW_WORDS.noNodeDirection : FLOW_WORDS.noModelPoint);
    }
  });

  test('if the ribbon rebuild throws after a context restore, the still form stands and the detail says so', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await bootEnso(page, '', LIVE_CLOCK, 'live');
    await choose(page, 'wind');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'moving');
    const reads = noddStubLog(page).length;
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#map canvas.maplibregl-canvas')!;
      const lose = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
      (window as unknown as { __lose: WEBGL_lose_context }).__lose = lose;
      // Only the flow ribbon's own shaders (u_ring, a_seg) fail to compile on the
      // restored context; MapLibre's shaders compile as usual.
      const proto = WebGL2RenderingContext.prototype;
      const shaderSource = proto.shaderSource;
      proto.shaderSource = function patched(this: WebGL2RenderingContext, shader: WebGLShader, source: string): void {
        shaderSource.call(this, shader, /u_ring|a_seg/.test(source) ? 'not glsl' : source);
      };
      lose.loseContext();
    });
    // Restore only once the page has handled the loss. Chrome dispatches
    // webglcontextlost from its own task, and allows restoreContext() only
    // after a listener (MapLibre's) has called preventDefault on that event;
    // a restore asked for earlier is refused and the context stays lost, so
    // the paths would hold still (`held`) for good. The flow view reports the
    // handled loss as the still form held by the lost context.
    await expect(panel(page)).toHaveAttribute('data-flow-motion', 'held');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'still');
    await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
    // The moving form cannot come back, so Pause is no longer offered and the still form draws.
    await expect(panel(page)).toHaveAttribute('data-flow-motion', 'none');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'still');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    expect(Number(await panel(page).getAttribute('data-flow-features'))).toBeGreaterThan(20);
    await expect(page.locator('#map-key-flow-pause')).toBeHidden();
    await openKeyDrawer(page);
    await expect(flowNotes(page)).toContainText(FLOW_WORDS.rebuildFailed);
    await expect(flowNotes(page)).not.toContainText(FLOW_WORDS.context);
    expect(errors.filter((message) => /flow ribbon|not glsl/i.test(message)), 'no rebuild error escapes').toEqual([]);
    expect(noddStubLog(page), 'nothing is read again').toHaveLength(reads);
  });
});
