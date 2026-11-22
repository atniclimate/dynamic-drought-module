import { continueLocalRoute } from './offline-test';
import { expect, test, type Page, type Route } from './offline-test';
import { HOLD_PROBE_MS } from './raster-hold-window';

import { awaitQuiescence, gotoApp, layerPill, PILL, search } from './helpers';

// ---------------------------------------------------------------------------
// Tile-proven readiness in the browser (DDM-P14-T04, register item found-001)
// ---------------------------------------------------------------------------

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** A route gate: every request routed through it waits for `release()`. */
function routeGate(): { readonly held: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

async function fulfillPng(route: Route): Promise<void> {
  await route
    .fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    .catch(() => undefined);
}

const isGriddedTile = (url: URL): boolean =>
  url.pathname.includes('/current-conditions/tile/v1/') && url.pathname.endsWith('.png');

async function stubGriddedInfo(page: Page): Promise<void> {
  await page.route('**/current-conditions/tile/v1/*/info.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ date: '2026-09-24', tilezmax: '6' })
    })
  );
}

const isSstTile = (url: URL): boolean =>
  url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png');

/** The provider's `default` (latest) frame, which the layer mounts for instant paint. */
const isSstLatestTile = (url: URL): boolean =>
  isSstTile(url) && url.pathname.includes('/default/default/');

/** One dated frame's own tiles (`URLS.gibsSstAnomalyWmtsTime`). */
const isSstFrameTile = (url: URL, date: string): boolean =>
  isSstTile(url) && url.pathname.includes(`/default/${date}/`);

const isSstDomains = (url: URL): boolean => url.href.includes('REQUEST=DescribeDomains');

/** Five published days, the newest 2026-09-24 (the SST time axis the cases below enumerate). */
const SST_DOMAINS_XML =
  "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
  '<ows:Identifier>time</ows:Identifier>' +
  '<Domain>2026-09-20/2026-09-24/P1D</Domain>' +
  '<Size>1</Size></DimensionDomain></Domains>';

async function stubSstDomains(page: Page): Promise<void> {
  await page.route(isSstDomains, (route) =>
    route.fulfill({ status: 200, contentType: 'text/xml', body: SST_DOMAINS_XML })
  );
}

/** One SST pill reading, with the `sst=` the URL carried at that instant. */
interface SstPillSample {
  readonly text: string;
  readonly sst: string | null;
}

/**
 * Record, from before the first script runs, every text the SST pill shows
 * together with the `sst=` date the URL carried when it showed it. The pill
 * is rendered on an animation frame after the status write, so each sample
 * pairs what the pill said with what the link asked for at that moment:
 * the reading "live while sst= names another date" is one such pair.
 */
async function recordSstPill(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: Array<{ text: string; sst: string | null }> = [];
    (window as unknown as { __sstPillLog?: typeof log }).__sstPillLog = log;
    let last: string | null = null;
    new MutationObserver(() => {
      const pill = document.querySelector('[data-layer-status="sst-anomaly"]');
      const text = pill?.textContent?.trim() ?? '';
      if (text === last) return;
      last = text;
      log.push({ text, sst: new URLSearchParams(location.search).get('sst') });
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

async function sstPillLog(page: Page): Promise<SstPillSample[]> {
  return page.evaluate(
    () => (window as unknown as { __sstPillLog?: SstPillSample[] }).__sstPillLog ?? []
  );
}

/** The samples that read live or live (partial) while the URL still named a frame date. */
function liveUnderLinkedDate(samples: readonly SstPillSample[]): SstPillSample[] {
  return samples.filter(
    (sample) => (sample.text === PILL.live || sample.text === PILL.degraded) && sample.sst !== null
  );
}

test.describe('tile-proven raster readiness in the browser (DDM-P14-T04, found-001)', () => {
  test('gridded-index reads loading while its first tile route is held and live after release', async ({
    page
  }) => {
    await stubGriddedInfo(page);
    const gate = routeGate();
    await page.route(isGriddedTile, async (route) => {
      await gate.held;
      await fulfillPng(route);
    });
    await gotoApp(page, '?view=console&layers=gridded-index&region=national', { bootIdle: false });
    // Before DDM-P14-T04 the layer wrote ready right after addSource, so the
    // seam went quiet with every tile still held.
    await expect(awaitQuiescence(page, HOLD_PROBE_MS)).rejects.toThrow(/gridded-index/);
    await expect(layerPill(page, 'gridded-index')).toHaveText(PILL.loading);
    gate.release();
    await awaitQuiescence(page);
    await expect(layerPill(page, 'gridded-index')).toHaveText(PILL.live);
  });

  test('gridded-index reads live (partial) when a stated subset of its tiles fails', async ({ page }) => {
    await stubGriddedInfo(page);
    // Odd x columns answer as NIDIS does outside its CONUS box (404, probed
    // 2026-09-26); even columns load.
    await page.route(isGriddedTile, async (route) => {
      const parts = new URL(route.request().url()).pathname.split('/');
      const x = Number(parts[parts.length - 2]);
      if (x % 2 === 1) {
        await route.fulfill({ status: 404, body: '' }).catch(() => undefined);
        return;
      }
      await fulfillPng(route);
    });
    await gotoApp(page, '?view=console&layers=gridded-index&region=national');
    await expect(layerPill(page, 'gridded-index')).toHaveText(PILL.degraded);
  });

  test('sst-anomaly reads loading while its first tile route is held and live after release', async ({
    page
  }) => {
    await stubSstDomains(page);
    const gate = routeGate();
    await page.route(isSstTile, async (route) => {
      await gate.held;
      await fulfillPng(route);
    });
    await gotoApp(page, '?view=console&layers=sst-anomaly', { bootIdle: false });
    // M7's shape (DDM-P1-T09): a held first tile holds the quiescence seam
    // open, naming the layer, because the layer is still loading.
    await expect(awaitQuiescence(page, HOLD_PROBE_MS)).rejects.toThrow(/sst-anomaly/);
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.loading);
    gate.release();
    await awaitQuiescence(page);
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.live);
  });

  test('sst-anomaly reads unavailable, never live, when every tile of its view fails', async ({ page }) => {
    // M7's zero-proven-tile variant: no tile is ever proven, so the surface
    // never settles live.
    await stubSstDomains(page);
    await page.route(isSstTile, (route) =>
      route.fulfill({ status: 404, body: '' }).catch(() => undefined)
    );
    await gotoApp(page, '?view=console&layers=sst-anomaly', { bootIdle: false });
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.unavailable, { timeout: 20_000 });
  });

  // Review finding C2 (DDM-P14-T04; C4-notes :78-79 and the M1 row at :320):
  // the SST frame proof is DescribeDomains, and it precedes ready. The latest
  // frame is mounted for instant paint before the time axis answers, so its
  // tiles are served at once in the cases below while the axis is held.
  test('sst-anomaly reads loading while DescribeDomains is held, even with the latest frame served, and live once the axis answers', async ({
    page
  }) => {
    const domains = routeGate();
    await page.route(isSstDomains, async (route) => {
      await domains.held;
      await route
        .fulfill({ status: 200, contentType: 'text/xml', body: SST_DOMAINS_XML })
        .catch(() => undefined);
    });
    let latestServed = 0;
    await page.route(isSstTile, async (route) => {
      await fulfillPng(route);
      if (isSstLatestTile(new URL(route.request().url()))) latestServed += 1;
    });
    await gotoApp(page, '?view=console&layers=sst-anomaly', { bootIdle: false });
    await expect.poll(() => latestServed).toBeGreaterThan(0);
    // At 7a2b48d the latest frame's watcher reported live here, before the
    // time axis had answered, so the seam went quiet with DescribeDomains held.
    await expect(awaitQuiescence(page, HOLD_PROBE_MS)).rejects.toThrow(/sst-anomaly/);
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.loading);
    domains.release();
    await awaitQuiescence(page);
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.live);
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText('Observed Sep 24, 2026');
  });

  test('a historical sst= link reads loading through a held DescribeDomains and its own held frame, never live from the latest frame', async ({
    page
  }) => {
    await recordSstPill(page);
    const domains = routeGate();
    const linkedFrame = routeGate();
    await page.route(isSstDomains, async (route) => {
      await domains.held;
      await route
        .fulfill({ status: 200, contentType: 'text/xml', body: SST_DOMAINS_XML })
        .catch(() => undefined);
    });
    let latestServed = 0;
    let linkedRequested = 0;
    await page.route(isSstTile, async (route) => {
      const url = new URL(route.request().url());
      if (isSstFrameTile(url, '2026-09-21')) {
        linkedRequested += 1;
        await linkedFrame.held;
      }
      await fulfillPng(route);
      if (isSstLatestTile(url)) latestServed += 1;
    });
    await gotoApp(page, '?view=console&layers=sst-anomaly&sst=2026-09-21', { bootIdle: false });

    // The axis is held and the latest frame is served: at 7a2b48d the pill
    // read live here, for imagery the link did not ask for.
    await expect.poll(() => latestServed).toBeGreaterThan(0);
    await expect(awaitQuiescence(page, HOLD_PROBE_MS)).rejects.toThrow(/sst-anomaly/);
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.loading);

    // The axis answers and lists the linked date: that frame is requested
    // and named, and the pill waits for its own tiles.
    domains.release();
    await expect.poll(() => linkedRequested).toBeGreaterThan(0);
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText('Observed Sep 21, 2026');
    await expect(awaitQuiescence(page, HOLD_PROBE_MS)).rejects.toThrow(/sst-anomaly/);
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.loading);
    const beforeProof = (await sstPillLog(page)).map((sample) => sample.text);
    expect(beforeProof).not.toContain(PILL.live);
    expect(beforeProof).not.toContain(PILL.degraded);

    linkedFrame.release();
    await awaitQuiescence(page);
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.live);
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText('Observed Sep 21, 2026');
    expect(new URLSearchParams(await search(page)).get('sst')).toBe('2026-09-21');
  });

  test('a DescribeDomains failure under a historical sst= link clears the date and states the fallback, never live while sst= names it', async ({
    page
  }) => {
    await recordSstPill(page);
    await page.route(isSstDomains, (route) =>
      route
        .fulfill({ status: 500, contentType: 'text/plain', body: 'Synthetic outage' })
        .catch(() => undefined)
    );
    await page.route(isSstTile, fulfillPng);
    await gotoApp(page, '?view=console&layers=sst-anomaly&sst=2026-09-21');
    // The stated fallback: the latest frame on its own tile verdict, the link
    // healed so it no longer names a date the layer could not show, and the
    // stamp saying which date that was. At 7a2b48d sst= stayed in the URL,
    // the stamp named no date, and the pill read live under it.
    await expect.poll(async () => new URLSearchParams(await search(page)).get('sst')).toBeNull();
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toContainText('date unavailable');
    await expect(page.locator('#time-bar .time-bar-stamp-detail')).toContainText('Sep 21, 2026');
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.live);
    expect(liveUnderLinkedDate(await sstPillLog(page))).toEqual([]);
  });

  test('an sst= date outside the enumerated window clears the date and states the fallback', async ({ page }) => {
    await recordSstPill(page);
    await stubSstDomains(page);
    await page.route(isSstTile, fulfillPng);
    await gotoApp(page, '?view=console&layers=sst-anomaly&sst=2026-08-01');
    await expect.poll(async () => new URLSearchParams(await search(page)).get('sst')).toBeNull();
    await expect(page.locator('#time-bar .time-bar-stamp-headline')).toHaveText('Observed Sep 24, 2026');
    // At 7a2b48d the fallback was silent: the stamp read as if no date had been asked for.
    await expect(page.locator('#time-bar .time-bar-stamp-detail')).toContainText('Aug 1, 2026');
    await expect(layerPill(page, 'sst-anomaly')).toHaveText(PILL.live);
    expect(liveUnderLinkedDate(await sstPillLog(page))).toEqual([]);
  });

  // Unlike gridded-index and sst-anomaly above, hillshade is a declared
  // tile-proof exception (director's ruling, DDM-P14-T04, measured at build
  // time): with the shared tile-proof watcher wired, the Fire 3D pair
  // (fire3d-mode.spec.ts, view-contracts.spec.ts) fell from 57/59 to 47/59,
  // because the 3D scene's own animation suppresses map idle, so every 3D
  // boot waited out the full proof deadline; restoring a probe-then-add
  // design with no tile wait returned the pair to 58/59. The two cases below
  // (held-tile, out-of-archive) that used to prove tile proof and a no-data
  // reading are replaced by this one guard of the exception itself: the pill
  // still reaches live from the archive header probe alone, holding every
  // tile request open the whole time.
  test('hillshade reads live from its archive probe alone, never waiting on a tile (declared DDM-P14-T04 exception)', async ({
    page
  }) => {
    const gate = routeGate();
    await page.route('**/data/hillshade-dem-pnw.pmtiles*', async (route) => {
      // The header probe reads from byte 0; every tile (and leaf directory)
      // read starts later. Only the tile reads are held, never the probe.
      const range = route.request().headers()['range'] ?? '';
      if (!range.startsWith('bytes=0-')) await gate.held;
      await continueLocalRoute(route).catch(() => undefined);
    });
    await gotoApp(page, '?view=console&layers=hillshade&region=washington_state', {
      bootIdle: false
    });
    await expect(layerPill(page, 'hillshade')).toHaveText(PILL.live);
    gate.release();
  });

  // Same exception, straddling the archive: region=national's view spans a
  // box far larger than the bundled PNW archive's own coverage
  // (-125,41.5,-110.5,49.5), so the raster-dem source may ask for few or
  // zero leaf-directory or tile-data reads at this framing. The guarantee
  // under test is unchanged: the pill reaches live from the archive header
  // probe alone, never waiting on a tile, so it must still pass with every
  // tile and leaf-directory read held open (there may be none to hold).
  test('hillshade reads live from its archive probe alone under region=national too, where the view straddles the bundled archive (declared DDM-P14-T04 exception)', async ({
    page
  }) => {
    const gate = routeGate();
    await page.route('**/data/hillshade-dem-pnw.pmtiles*', async (route) => {
      // Same gate as the washington_state case above: only the combined
      // header-and-root-directory read (a Range starting at byte 0) passes
      // through; every leaf-directory or tile-data read (a Range starting
      // elsewhere) is held.
      const range = route.request().headers()['range'] ?? '';
      if (!range.startsWith('bytes=0-')) await gate.held;
      await continueLocalRoute(route).catch(() => undefined);
    });
    await gotoApp(page, '?view=console&layers=hillshade&region=national', {
      bootIdle: false
    });
    await expect(layerPill(page, 'hillshade')).toHaveText(PILL.live);
    gate.release();
  });
});
