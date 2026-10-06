import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { HAZARD_CLUSTERS } from '../src/config/clusters';
import { syncUrl } from '../src/state/url';
import {
  bootQuery,
  classifyRequest,
  strippedUrl,
  tallyUrls
} from '../scripts/mode-switch-cost-report.mjs';
import { installFakeBrowser } from './map-harness';
import { FLOW_MOTION_STORAGE_KEY, gotoApp, layerCheckbox, noddStubLog, search } from './helpers';

/*
 * ENSO-FLOW-PLAN block E2, unit E2-4 (ENSO-DEFAULT; DR-111 Q-WIND-MODES;
 * design/precedence.md 2.4). ENSO opens with the NOAA GFS wind paths on when
 * its link names no `flow=`: the default is written as the absence of the key,
 * `flow=off` keeps it off and is written back as itself, and every 2026-09-13
 * link (`flow=wind`, `flow=waves`) still opens its kind. The default is the
 * cluster's own `flowDefault` (src/config/clusters.ts), never a literal here.
 *
 * Browser cases fix the page clock where the reader asks for the committed
 * 2026-10-05 06Z f006 fixtures (the same clock as tests/flow-wire.spec.ts),
 * and every NODD read is answered by tests/helpers.ts. A routine boot holds
 * the motion loop (`gotoApp`'s `flowMotion`), so these cases read the still
 * form of the same paths; no case waits on MapLibre 'idle' while a loop runs.
 */

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const OPEN_METEO = /^https:\/\/(?:marine-api|api)\.open-meteo\.com\//;
/** Candidate cycle 06Z, wind (3-hourly) and waves (hourly) both at f006. */
const LIVE_CLOCK = Date.UTC(2026, 9, 5, 12, 30);

async function stubSst(page: Page): Promise<void> {
  await page.route((url) => url.href.includes('DescribeDomains'), (route) => route.fulfill({
    status: 200, contentType: 'text/xml',
    body: "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-01/2026-09-07/P1D</Domain><Size>1</Size></DimensionDomain></Domains>"
  }));
  await page.route((url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
}

/** Record every Open-Meteo request; wind and waves must make none. */
async function recordOpenMeteo(page: Page): Promise<string[]> {
  const calls: string[] = [];
  await page.route(OPEN_METEO, async (route) => {
    calls.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  return calls;
}

async function prepare(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.setFixedTime(LIVE_CLOCK);
  await stubSst(page);
  return recordOpenMeteo(page);
}

function panel(page: Page): Locator {
  return page.locator('.enso-flow');
}

const flowParams = async (page: Page): Promise<{ flow: string | null; flowink: string | null }> => {
  const params = new URLSearchParams(await search(page));
  return { flow: params.get('flow'), flowink: params.get('flowink') };
};

/** One boot in a mode, then a click on a mode tile, on the measure's own boot query. */
async function bootThenSwitchToEnso(page: Page): Promise<void> {
  await prepare(page);
  await gotoApp(page, bootQuery({ urlToken: null, profile: 'wa' }));
  await expect(page.locator('.shell-cluster-btn[data-cluster="drought"]')).toHaveAttribute('aria-pressed', 'true');
}

test.describe('E2-4 pure: the default is the cluster field, and the hold names the loop key', () => {
  test('ENSO carries flowDefault wind and no other mode carries one', () => {
    const carriers = Object.entries(HAZARD_CLUSTERS)
      .filter(([, def]) => def.flowDefault !== undefined)
      .map(([key, def]) => [key, def.flowDefault]);
    expect(carriers).toEqual([['enso', 'wind']]);
  });

  test('the helper hold writes the key the motion loop reads', () => {
    // Read from the source text: importing the loop would pull the time bar into a Node spec.
    const source = readFileSync(new URL('../src/layers/flow/motion-loop.ts', import.meta.url), 'utf8');
    expect(/export const MOTION_STORAGE_KEY = '([^']+)';/.exec(source)?.[1]).toBe(FLOW_MOTION_STORAGE_KEY);
  });

  test('entering ENSO from a link with no flow key writes no flow key', () => {
    // The write that follows a click on the ENSO tile reads the current link
    // (a mode with no default) and writes the new one (ENSO, default wind).
    for (const inbound of ['?region=washington_state&view=brief', '?cluster=wildfire&region=national', '?layers=places&view=console']) {
      const browser = installFakeBrowser({ search: inbound });
      try {
        syncUrl({ region: null, layers: new Set(['sst-anomaly']), embed: false, view: 'console', cluster: 'enso', ocean: 'pacific' });
        const params = new URLSearchParams(browser.search());
        expect(params.get('cluster'), `${inbound}: the cluster`).toBe('enso');
        expect(params.get('flow'), `${inbound}: no flow key beside the ENSO default`).toBeNull();
      } finally {
        browser.restore();
      }
    }
  });

  test('with the flow panel mounted, the ENSO tile keeps what the panel shows; before it mounts, the entered default applies', () => {
    // The panel parses the link once, when it mounts, and keeps that preference
    // (a custom display already showing SST stays active through an ENSO press),
    // so with the panel mounted the link must keep saying what it shows. A switch
    // from a mode without SST writes the granular SST link first, before the
    // panel exists: that link must not read as a custom display.
    const enso = { region: null, layers: new Set(['sst-anomaly']), embed: false, view: 'console', cluster: 'enso', ocean: 'pacific' } as const;
    for (const [inbound, panelMounted, expected] of [
      ['?layers=sst-anomaly,usdm&view=console', true, 'off'],
      ['?layers=sst-anomaly&view=console', true, 'off'],
      ['?layers=sst-anomaly,usdm&flow=waves', true, 'waves'],
      ['?cluster=enso', true, null],
      ['?layers=sst-anomaly&view=console', false, null],
      ['?region=washington_state&layers=hillshade,sst-anomaly&view=brief', false, null],
      ['?layers=usdm&view=console', false, null]
    ] as const) {
      const browser = installFakeBrowser({ search: inbound });
      const document = globalThis.document as unknown as { querySelector?: (selector: string) => unknown };
      document.querySelector = (selector: string) => (panelMounted && selector === '.enso-flow' ? {} : null);
      try {
        syncUrl(enso);
        const params = new URLSearchParams(browser.search());
        expect(params.get('cluster'), `${inbound}: the cluster`).toBe('enso');
        expect(params.get('flow'), `${inbound} (panel ${panelMounted ? 'mounted' : 'not mounted'})`).toBe(expected);
      } finally {
        browser.restore();
      }
    }
  });

  test('moving from ENSO to the granular display keeps the wind it was showing', () => {
    // The new display has no default, so the link being replaced still decides.
    for (const [inbound, expected] of [['?cluster=enso', 'wind'], ['?cluster=enso&flow=off', 'off'], ['?cluster=enso&flow=waves', 'waves']] as const) {
      const browser = installFakeBrowser({ search: inbound });
      try {
        syncUrl({ region: null, layers: new Set(['sst-anomaly', 'places']), embed: false, view: 'console' });
        const params = new URLSearchParams(browser.search());
        expect(params.get('cluster'), `${inbound}: granular`).toBeNull();
        // Wind is not the granular default (off), so it is named; off is the default, so it is not.
        expect(params.get('flow'), inbound).toBe(expected === 'off' ? null : expected);
      } finally {
        browser.restore();
      }
    }
  });

  test('entering ENSO from a link that names flow=off or a kind keeps it', () => {
    for (const [inbound, expected] of [['?cluster=enso&flow=off', 'off'], ['?cluster=enso&flow=waves', 'waves']] as const) {
      const browser = installFakeBrowser({ search: inbound });
      try {
        syncUrl({ region: null, layers: new Set(['sst-anomaly']), embed: false, view: 'console', cluster: 'enso', ocean: 'pacific' });
        expect(new URLSearchParams(browser.search()).get('flow'), inbound).toBe(expected);
      } finally {
        browser.restore();
      }
    }
  });
});

test.describe('E2-4 ENSO opens with wind', () => {
  test('an ENSO boot with no flow key draws wind and writes no flow key', async ({ page }) => {
    const openMeteo = await prepare(page);
    await gotoApp(page, '?cluster=enso&ocean=pacific');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    await expect(panel(page).locator('[data-flow-kind="wind"]')).toHaveAttribute('aria-pressed', 'true');
    // The one .idx and the two ranges (U and V), from the fixtures; nothing else.
    const log = noddStubLog(page);
    expect(log.map((entry) => entry.answer)).toEqual(['fixture', 'fixture', 'fixture']);
    expect(openMeteo, 'wind reads no Open-Meteo host').toEqual([]);
    // The default is the absence of the key, and it stays absent after the boot's own writes.
    await expect.poll(async () => (await flowParams(page)).flow).toBeNull();
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    expect((await flowParams(page)).flowink).toBeNull();
  });

  test('flow=off in an ENSO link stays off and round-trips', async ({ page }) => {
    const openMeteo = await prepare(page);
    await gotoApp(page, '?cluster=enso&ocean=pacific&flow=off');
    await expect(panel(page)).toHaveAttribute('data-status', 'off');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', '');
    await expect(panel(page).locator('[data-flow-kind="off"]')).toHaveAttribute('aria-pressed', 'true');
    expect(noddStubLog(page), 'off reads nothing').toHaveLength(0);
    expect(openMeteo).toEqual([]);
    await expect.poll(async () => (await flowParams(page)).flow).toBe('off');

    // Reload: still off, still written.
    await page.reload();
    await expect(panel(page)).toHaveAttribute('data-status', 'off');
    await expect.poll(async () => (await flowParams(page)).flow).toBe('off');
    expect(noddStubLog(page), 'still nothing read').toHaveLength(0);

    // Choosing wind is the default again (no key), choosing off writes the key back.
    await panel(page).locator('[data-flow-kind="wind"]').click();
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    await expect.poll(async () => (await flowParams(page)).flow).toBeNull();
    await panel(page).locator('[data-flow-kind="off"]').click();
    await expect(panel(page)).toHaveAttribute('data-status', 'off');
    await expect.poll(async () => (await flowParams(page)).flow).toBe('off');
    await page.reload();
    await expect(panel(page)).toHaveAttribute('data-status', 'off');
  });

  for (const inbound of ['&flow=off', '&flow=waves&flowink=dark']) {
    test(`leaving ENSO drops flow= and flowink= (from ${inbound.slice(1)})`, async ({ page }) => {
      await prepare(page);
      await gotoApp(page, `?cluster=enso&ocean=pacific${inbound}`);
      await expect(panel(page)).toHaveAttribute('data-status', inbound === '&flow=off' ? 'off' : /^live/);
      await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
      await expect(page.locator('.shell-cluster-btn[data-cluster="drought"]')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => new URLSearchParams(await search(page)).get('cluster')).toBeNull();
      expect(await flowParams(page)).toEqual({ flow: null, flowink: null });
      await expect(panel(page)).toHaveCount(0);
    });
  }

  // One title for the pair, one boot per link (`written` is what the link reads as after the boot's own writes:
  // flow=wind is the default now, so it opens wind and is rewritten without the key; waves is a named kind).
  for (const link of [
    { query: 'flow=wind', kind: 'wind', written: null, ink: null },
    { query: 'flow=waves', kind: 'waves', written: 'waves', ink: null },
    { query: 'flow=wind&flowink=dark', kind: 'wind', written: null, ink: 'dark' },
    { query: 'flow=waves&flowink=dark', kind: 'waves', written: 'waves', ink: 'dark' }
  ] as const) {
    test(`every 2026-09-13 flow=wind and flow=waves link still opens its kind (${link.query})`, async ({ page }) => {
      const openMeteo = await prepare(page);
      await gotoApp(page, `?cluster=enso&ocean=pacific&${link.query}`);
      await expect(panel(page)).toHaveAttribute('data-status', link.kind === 'waves' ? /^live/ : 'live');
      await expect(panel(page)).toHaveAttribute('data-flow-drawn', link.kind);
      await expect(panel(page).locator(`[data-flow-kind="${link.kind}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await flowParams(page)).flow).toBe(link.written);
      expect((await flowParams(page)).flowink).toBe(link.ink);
      expect(openMeteo).toEqual([]);
    });
  }

  test('custom display with SST and flow off, then the ENSO tile: the link and the panel agree on the flow', async ({ page }) => {
    await prepare(page);
    await gotoApp(page, '?cluster=enso&ocean=pacific&flow=off');
    await expect(panel(page)).toHaveAttribute('data-status', 'off');
    // One more surface demotes the display to a granular layers= link (flow off is absence there).
    await layerCheckbox(page, 'usdm').check();
    await expect.poll(async () => new URLSearchParams(await search(page)).get('cluster')).toBeNull();
    // The ENSO tile again: the recipe re-applies, usdm goes, sst-anomaly stays active, so the panel keeps off.
    await page.locator('.shell-cluster-btn[data-cluster="enso"]').click();
    await expect.poll(async () => new URLSearchParams(await search(page)).get('cluster')).toBe('enso');
    const status = await panel(page).getAttribute('data-status');
    const flow = (await flowParams(page)).flow;
    if (status === 'off') expect(flow, 'the ENSO link opens wind while the panel shows off').toBe('off');
    else expect(flow, 'the panel switched to wind; the link writes it as absence').toBeNull();
    // A reload agrees with what the panel showed.
    await page.reload();
    await expect(panel(page)).toHaveAttribute('data-status', status === 'off' ? 'off' : 'live');
  });

  test('switching into ENSO from another mode opens wind and writes no flow key', async ({ page }) => {
    const openMeteo = await prepare(page);
    await gotoApp(page, bootQuery({ urlToken: null, profile: 'wa' }));
    await page.locator('.shell-cluster-btn[data-cluster="enso"]').click();
    await expect(page.locator('.shell-cluster-btn[data-cluster="enso"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    expect(new URLSearchParams(await search(page)).get('cluster')).toBe('enso');
    await expect.poll(async () => (await flowParams(page)).flow).toBeNull();
    expect(openMeteo).toEqual([]);
  });
});

test.describe('E2-4 routine boots hold the motion loop', () => {
  test('a routine ENSO boot holds the loop: still form, live data, no repaint', async ({ page }) => {
    await prepare(page);
    await gotoApp(page, '?cluster=enso&ocean=pacific');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    await expect(panel(page)).toHaveAttribute('data-flow-motion', 'paused');
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'still');
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), FLOW_MOTION_STORAGE_KEY)).toBe('paused');
    // No continuous repaint, so MapLibre settles and a spec that waits on idle does not hang.
    const rendersOver = (ms: number): Promise<number> => page.evaluate(async (windowMs) => {
      const node = document.querySelector<HTMLElement>('.enso-flow');
      const read = (): number => Number(node?.dataset['flowRenders'] ?? 0);
      const before = read();
      await new Promise((resolve) => setTimeout(resolve, windowMs));
      return read() - before;
    }, ms);
    await expect.poll(() => rendersOver(500), { timeout: 15_000 }).toBe(0);
    expect(await rendersOver(1500), 'MapLibre renders in 1.5 s with the loop held').toBe(0);
  });

  test('under reduced motion the hold seeds nothing and the loop still reads reduced', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await prepare(page);
    await gotoApp(page, '?cluster=enso&ocean=pacific');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');
    await expect(panel(page)).toHaveAttribute('data-flow-motion', 'reduced');
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), FLOW_MOTION_STORAGE_KEY)).toBeNull();
  });

  test('flowMotion live leaves the loop to the page: the moving form runs', async ({ page }) => {
    await prepare(page);
    await gotoApp(page, '?cluster=enso&ocean=pacific', { flowMotion: 'live' });
    await expect(panel(page)).toHaveAttribute('data-flow-form', 'moving');
    await expect(panel(page)).toHaveAttribute('data-flow-motion', 'moving');
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), FLOW_MOTION_STORAGE_KEY)).toBeNull();
  });

  test('a routine ENSO boot at the real date asks only for .idx files and records no failure', async ({ page }) => {
    // No page clock: the reader asks for the cycles of the machine's own date,
    // which no fixture covers. The stub answers 404 (NODD's answer for a cycle
    // it has not published) without failing the spec.
    await stubSst(page);
    await gotoApp(page, '?cluster=enso&ocean=pacific');
    // Wait for a terminal state first: the reader steps back through three
    // cycles, so reading the log earlier would miss the second and third `.idx`.
    await expect(panel(page)).toHaveAttribute('data-status', /^(unavailable|live)/);
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', /^(wind|)$/);
    expect(noddStubLog(page).length).toBeGreaterThan(0);
    expect(noddStubLog(page).filter((entry) => entry.answer === 'unstubbed')).toEqual([]);
    expect(test.info().errors, 'no unstubbed read recorded').toEqual([]);
    await expect.poll(async () => (await flowParams(page)).flow).toBeNull();
  });
});

test.describe('E2-4 the mode-switch cost record', () => {
  test('the mode-switch measure profile records the added chunk and 3 reads', async ({ page }) => {
    await bootThenSwitchToEnso(page);
    const appOrigin = new URL(page.url()).origin;
    const dataUrls: string[] = [];
    const requested: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      requested.push(url);
      if (classifyRequest(url, appOrigin) === 'data') dataUrls.push(strippedUrl(url, appOrigin));
    });
    await page.locator('.shell-cluster-btn[data-cluster="enso"]').click();
    await expect(page.locator('.shell-cluster-btn[data-cluster="enso"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page)).toHaveAttribute('data-status', 'live');
    await expect(panel(page)).toHaveAttribute('data-flow-drawn', 'wind');

    // The 3 reads the default adds: the .idx and the U and V ranges, counted by
    // the measure's own classifier as data reads.
    const noddReads = dataUrls.filter((url) => url.startsWith('https://noaa-gfs-bdp-pds.'));
    expect(noddReads, 'NODD data reads on the drought to ENSO switch').toHaveLength(3);
    expect(tallyUrls(noddReads).map((entry) => entry.n).sort()).toEqual([1, 2]);

    // The added chunk: the flow module's own file, from the build manifest, requested by the switch.
    const manifest = JSON.parse(readFileSync(new URL('../dist/.vite/manifest.json', import.meta.url), 'utf8')) as Record<string, { file?: string }>;
    const chunk = manifest['src/layers/flow/index.ts']?.file;
    expect(chunk, 'the flow chunk is in the build manifest').toBeDefined();
    expect(requested.filter((url) => url.endsWith(`/${chunk}`)), 'the flow chunk requested by the switch').toHaveLength(1);

    test.info().annotations.push({
      type: 'mode-switch record',
      description: JSON.stringify({ id: 'drought->enso', flowChunk: chunk, noddReads: noddReads.length, dataReads: dataUrls.length, counted: tallyUrls(dataUrls) })
    });
  });
});
