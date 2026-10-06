import { continueLocalRoute } from './offline-test';
/**
 * The layer cancellation seam, and the acceptance sentence of DDM-P1-T02
 * (`docs/ROADMAP.yaml`, phase DDM-P1):
 *
 *   "Held JSON, PMTiles, and viewport discovery requests abort promptly, and
 *    a late response cannot render after intent changes."
 *
 * Before S16 (2026-09-08) each layer module aborted its own fetches, and the
 * controller could reach them only through the optional `cancelActivation`
 * seam, which Hydrography never exported: an Overpass query held open waited
 * out its per-mirror budget behind the serialized teardown after the user
 * had turned the layer off. The controller now owns one AbortController per
 * activation attempt (`src/state/layer-controller.ts`, `attempts`), hands
 * its signal to the module as `LayerActivation`, and aborts it the instant
 * off intent is recorded, when a newer activate of the same key supersedes
 * the attempt, and when the attempt stands down. The four modules named by
 * the task (`aiannh.ts`, `bia-reservations.ts`, `hms-smoke.ts`,
 * `hydrography.ts`) link every fetch they issue to it through
 * `linkAbort` (`src/util/fetch.ts`) and drop a response whose request token
 * is no longer current.
 *
 * One test per clause, plus the late-response case, each driven the way
 * `tests/s4-shell.spec.ts` drives the Drought outlook: the request is HELD by
 * a `page.route` handler that never answers until the test releases it, and
 * the load-bearing observation is the browser's own `requestfailed` event
 * for that request, which fires only when the page aborts it. The checkbox,
 * the pill and the URL are necessary evidence and not sufficient: the
 * controller records off intent synchronously and all three clear even while
 * a hung activation is still draining. Only the abort itself separates a
 * prompt cancellation from a pending one.
 *
 * No live agency is reached. The sovereign boundary queries are answered by
 * the suite-wide synthetic fixtures (`tests/tribal-fixtures.ts`) and held
 * through `routeBoundary`; the fire, smoke and heat services are stubbed
 * empty; the basemap is a one-pixel tile. The PMTiles case reads the bundled
 * ecoregion archive (`public/data/ecoregions-pnw.pmtiles`) through the
 * preview server and holds only its tile-data range reads, which it tells
 * apart from the header read by the archive's own `tileDataOffset`.
 *
 * "Promptly" is a bound: an abort is prompt when it lands well inside the
 * network budget the pre-seam path would first have had to exhaust
 * (`FETCH_TIMEOUT_MS` 15 s in the three ArcGIS-style modules,
 * `PER_MIRROR_TIMEOUT_MS` 12 s per Overpass mirror). Ten seconds is the
 * bound used here: under every budget, and over any honest teardown cost on
 * a slow CI runner.
 */
import { expect, test, type Page, type Route } from './offline-test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HAZARD_CLUSTERS, type HazardClusterKey } from '../src/config/clusters';
import {
  awaitQuiescence,
  gotoApp,
  layerCheckbox,
  layerPill,
  openTribalNationsDetails,
  selectRegion,
  urlLayers,
  waitForLayerSettled
} from './helpers';
import { isNwsWwaRequestUrl, NWS_WWA_EMPTY } from './nws-wwa-fixtures';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  isBoundaryRequestUrl,
  routeBoundary,
  syntheticAiannhBody,
  syntheticBiaBody
} from './tribal-fixtures';

// ---------------------------------------------------------------------------
// Bounds and fixtures
// ---------------------------------------------------------------------------

/** See the module docblock: under every per-call budget in the four modules. */
const ABORT_BOUND_MS = 10_000;

/** How long a released stale response is given to (wrongly) land. */
const STALE_SETTLE_MS = 750;

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const HMS_PATTERN = 'NOAA_Satellite_Smoke_Detection';
const NIFC_PATTERN = 'WFIGS_Interagency_Perimeters_Current';
const OVERPASS_PATH = '/api/interpreter';
const ECOREGIONS_ARCHIVE = '/ecoregions-pnw.pmtiles';

const ECOREGIONS_ARCHIVE_PATH = join(process.cwd(), 'public', 'data', 'ecoregions-pnw.pmtiles');

function emptyCollection(): string {
  return JSON.stringify({ type: 'FeatureCollection', features: [] });
}

/**
 * The byte offset where the archive's tile data begins, read from the
 * PMTiles v3 header (bytes 56 to 63, little-endian uint64). Every range
 * request at or past it is a tile read; the one below it is the header and
 * root directory read the protocol issues first. Read from the file rather
 * than hard-coded, so a rebuilt archive keeps the test honest.
 */
function readTileDataOffset(): number {
  const header = readFileSync(ECOREGIONS_ARCHIVE_PATH).subarray(0, 127);
  if (header.toString('latin1', 0, 7) !== 'PMTiles') {
    throw new Error('the bundled ecoregion archive does not start with the PMTiles magic');
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return Number(view.getBigUint64(56, true));
}

// ---------------------------------------------------------------------------
// Holding and watching requests
// ---------------------------------------------------------------------------

interface Held {
  /** One release per held request, in arrival order. */
  readonly releases: Array<() => void>;
  /** Release every held request; a release against an aborted request is a no-op. */
  releaseAll(): void;
}

function makeHeld(): Held {
  const releases: Array<() => void> = [];
  return {
    releases,
    releaseAll() {
      for (const release of releases.splice(0, releases.length)) release();
    }
  };
}

/** A fulfil that tolerates the page having aborted the request already. */
function fulfilLater(route: Route, body: string, contentType = 'application/geo+json'): () => void {
  return () => {
    void route.fulfill({ status: 200, contentType, body }).catch(() => {
      /* aborted by the page: cancellation won, which is the point */
    });
  };
}

interface Failure {
  readonly url: string;
  readonly at: number;
  readonly error: string;
}

/** Every `requestfailed` the page reports for URLs `matches` accepts. */
function watchFailures(page: Page, matches: (url: string) => boolean): Failure[] {
  const failures: Failure[] = [];
  page.on('requestfailed', (req) => {
    if (!matches(req.url())) return;
    failures.push({ url: req.url(), at: Date.now(), error: req.failure()?.errorText ?? '' });
  });
  return failures;
}

async function expectAbortedWithin(failures: Failure[], since: number, count = 1): Promise<void> {
  await expect
    .poll(() => failures.filter((f) => f.at >= since).length, { timeout: ABORT_BOUND_MS + 2_000 })
    .toBeGreaterThanOrEqual(count);
  const first = Math.min(...failures.filter((f) => f.at >= since).map((f) => f.at));
  expect(first - since).toBeLessThan(ABORT_BOUND_MS);
}

/** Pill raw class list for a key ('' while off or cleared). */
async function pillClasses(page: Page, key: string): Promise<string> {
  return (await layerPill(page, key).getAttribute('class')) ?? '';
}

/** The basemap and every live condition source, answered locally. */
async function stubCommon(page: Page): Promise<void> {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
  );
  // Broad first, specific later: Playwright matches the most recently
  // registered route, so a test's own held route below wins.
  for (const host of ['services5', 'services3', 'services2']) {
    await page.route(`https://${host}.arcgis.com/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
    );
  }
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
  );
  await page.route('https://ddm-proxy.atniclimate.workers.dev/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
}

/** Hold both sovereign boundary queries; each release answers the synthetic fixture. */
async function holdBoundaries(page: Page, held: Held): Promise<void> {
  await routeBoundary(page, AIANNH_ROUTE, (route) => {
    held.releases.push(fulfilLater(route, JSON.stringify(syntheticAiannhBody())));
  });
  await routeBoundary(page, BIA_ROUTE, (route) => {
    held.releases.push(fulfilLater(route, JSON.stringify(syntheticBiaBody())));
  });
}

// ---------------------------------------------------------------------------
// Clause 1: held JSON requests abort promptly
// ---------------------------------------------------------------------------

test.describe('DDM-P1-T02: held JSON requests abort promptly', () => {
  test('Tribal Lands and Reservation Boundaries toggled off mid-load abort their held queries', async ({
    page
  }) => {
    await stubCommon(page);
    const held = makeHeld();
    await holdBoundaries(page, held);
    const failures = watchFailures(page, isBoundaryRequestUrl);

    // Boot with both boundary layers OFF so the activations below are the
    // held ones, not the boot's.
    await gotoApp(page, '?view=console&layers=states');
    await openTribalNationsDetails(page);
    await layerCheckbox(page, 'aiannh').check();
    await layerCheckbox(page, 'bia-reservations').check();
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(layerPill(page, 'aiannh')).toHaveText('loading...');

    const offAt = Date.now();
    await layerCheckbox(page, 'aiannh').uncheck();
    await layerCheckbox(page, 'bia-reservations').uncheck();

    // THE assertion: both held queries are aborted, well inside the 15 s
    // budget the pre-seam path had to exhaust before its queued teardown.
    await expectAbortedWithin(failures, offAt, 2);
    expect(failures.some((f) => f.url.includes('tigerweb.geo.census.gov'))).toBe(true);
    expect(failures.some((f) => f.url.includes('biamaps.geoplatform.gov'))).toBe(true);

    // The intent surfaces follow.
    await expect(layerCheckbox(page, 'aiannh')).not.toBeChecked();
    await expect(layerCheckbox(page, 'bia-reservations')).not.toBeChecked();
    await expect(layerPill(page, 'aiannh')).toHaveText('', { timeout: 10_000 });
    await expect(layerPill(page, 'bia-reservations')).toHaveText('', { timeout: 10_000 });

    // Release the aborted requests LAST: nothing may come back.
    held.releaseAll();
    await page.waitForTimeout(STALE_SETTLE_MS);
    await expect(layerCheckbox(page, 'aiannh')).not.toBeChecked();
    await expect(layerPill(page, 'aiannh')).toHaveText('');
    await expect(layerPill(page, 'bia-reservations')).toHaveText('');
    const layers = await urlLayers(page);
    expect(layers.has('aiannh')).toBe(false);
    expect(layers.has('bia-reservations')).toBe(false);
  });

  test('Hydrography, which had no module seam of its own, aborts a held Overpass query', async ({
    page
  }) => {
    await stubCommon(page);
    const held = makeHeld();
    await page.route(
      (url) => url.pathname.endsWith(OVERPASS_PATH),
      (route) => {
        held.releases.push(
          fulfilLater(route, JSON.stringify({ elements: [] }), 'application/json')
        );
      }
    );
    const failures = watchFailures(page, (url) => url.endsWith(OVERPASS_PATH));

    // The layer is dormant below zoom 7 and issues no query there, so the
    // boot camera is the Central Oregon framing, which fits well above it
    // at the suite's viewport. Booting there (rather than selecting the
    // region after boot) matters: the query held below must be the
    // ACTIVATION's own, issued inside `activate` while the controller's op
    // chain is blocked on it. A refresh issued after a region animation
    // settles is aborted by the old teardown path too (the chain is free
    // by then), and would not tell the seam apart from its absence.
    await gotoApp(page, '?view=console&region=central_oregon');
    await layerCheckbox(page, 'hydrography').check();
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(layerPill(page, 'hydrography')).toHaveText('loading...');

    const offAt = Date.now();
    await layerCheckbox(page, 'hydrography').uncheck();

    // Before S16 this query ran out its 12 s per-mirror budget behind the
    // serialized teardown (Hydrography exported no cancelActivation); the
    // controller-owned signal now reaches it. Verified as the negative
    // control on 2026-09-08: with the base commit's controller and
    // hydrography restored, this assertion is the one that fails.
    await expectAbortedWithin(failures, offAt);

    await expect(layerCheckbox(page, 'hydrography')).not.toBeChecked();
    await expect(layerPill(page, 'hydrography')).toHaveText('', { timeout: 10_000 });
    held.releaseAll();
    await page.waitForTimeout(STALE_SETTLE_MS);
    await expect(layerPill(page, 'hydrography')).toHaveText('');
    expect((await urlLayers(page)).has('hydrography')).toBe(false);
  });

  test('Smoke Plumes toggled off mid-load aborts its held HMS query', async ({ page }) => {
    await stubCommon(page);
    // The co-activated partner answers at once so only the smoke query is held.
    await page.route(
      (url) => url.href.includes(NIFC_PATTERN),
      (route) =>
        route.fulfill({ status: 200, contentType: 'application/geo+json', body: emptyCollection() })
    );
    const held = makeHeld();
    await page.route(
      (url) => url.href.includes(HMS_PATTERN),
      (route) => {
        held.releases.push(fulfilLater(route, emptyCollection()));
      }
    );
    const failures = watchFailures(page, (url) => url.includes(HMS_PATTERN));

    await gotoApp(page, '?view=console');
    await layerCheckbox(page, 'hms-smoke').check();
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBeGreaterThan(0);

    const offAt = Date.now();
    await layerCheckbox(page, 'hms-smoke').uncheck();
    await expectAbortedWithin(failures, offAt);

    await expect(layerCheckbox(page, 'hms-smoke')).not.toBeChecked();
    await expect(layerPill(page, 'hms-smoke')).toHaveText('', { timeout: 10_000 });
    held.releaseAll();
    await page.waitForTimeout(STALE_SETTLE_MS);
    await expect(layerPill(page, 'hms-smoke')).toHaveText('');
    expect((await urlLayers(page)).has('hms-smoke')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clause 2: held PMTiles requests abort promptly
// ---------------------------------------------------------------------------

test.describe('DDM-P1-T02: held PMTiles requests abort promptly', () => {
  test('removing the ecoregion source aborts its held tile-data range reads', async ({ page }) => {
    await stubCommon(page);
    const tileDataOffset = readTileDataOffset();
    const held = makeHeld();
    // The header read (bytes 0 to 16383) goes through so the protocol can
    // learn the archive's layout; every read at or past tileDataOffset is
    // a tile and is held.
    await page.route(
      (url) => url.pathname.endsWith(ECOREGIONS_ARCHIVE),
      (route) => {
        const range = route.request().headers()['range'] ?? '';
        const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? -1);
        if (start >= tileDataOffset) {
          held.releases.push(() => {
            void continueLocalRoute(route).catch(() => {
              /* aborted by the page: cancellation won */
            });
          });
          return;
        }
        void continueLocalRoute(route);
      }
    );
    const failures = watchFailures(page, (url) => url.endsWith(ECOREGIONS_ARCHIVE));

    await gotoApp(page, '?view=console');
    await layerCheckbox(page, 'ecoregions').check();
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(layerPill(page, 'ecoregions')).toHaveText('loading...');

    const offAt = Date.now();
    await layerCheckbox(page, 'ecoregions').uncheck();

    // MapLibre aborts every in-flight tile of a removed source
    // (`removeSource` -> `TileManager.onRemove` -> `clearTiles` ->
    // `abortTile`), and pmtiles 4.4.1 passes that controller's signal into
    // the range fetch; the browser reports each as a failed request.
    await expectAbortedWithin(failures, offAt);

    await expect(layerCheckbox(page, 'ecoregions')).not.toBeChecked();
    await expect(layerPill(page, 'ecoregions')).toHaveText('', { timeout: 10_000 });
    held.releaseAll();
    await page.waitForTimeout(STALE_SETTLE_MS);
    await expect(layerPill(page, 'ecoregions')).toHaveText('');
    expect((await urlLayers(page)).has('ecoregions')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clause 3: viewport discovery requests abort promptly on supersession
// ---------------------------------------------------------------------------

test.describe('DDM-P1-T02: viewport discovery aborts on supersession', () => {
  test('a new viewport aborts the in-flight boundary refreshes and both layers stay on', async ({
    page
  }) => {
    await stubCommon(page);
    const failures = watchFailures(page, isBoundaryRequestUrl);

    // Boot with both boundary layers on and settled from the suite-wide
    // fixture, so the requests held below are viewport refreshes, not the
    // activations.
    await gotoApp(page, '?view=console');
    await waitForLayerSettled(page, 'aiannh');
    await waitForLayerSettled(page, 'bia-reservations');
    const held = makeHeld();
    await holdBoundaries(page, held);

    // First move: a viewport the boot envelopes do not cover, so each
    // module's debounced refresh issues a query, and both are held.
    await selectRegion(page, 'central_oregon');
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBe(2);

    // Second move while both are still held: each module supersedes its
    // in-flight request before it looks at its cache (aiannh.ts and
    // bia-reservations.ts, the top of fetchAndApply).
    const movedAt = Date.now();
    await selectRegion(page, 'cascades');
    await expectAbortedWithin(failures, movedAt, 2);
    const since = failures.filter((f) => f.at >= movedAt);
    expect(since.some((f) => f.url.includes('tigerweb.geo.census.gov'))).toBe(true);
    expect(since.some((f) => f.url.includes('biamaps.geoplatform.gov'))).toBe(true);

    // Neither layer left the on state: no checkbox or URL change. (These
    // two lines hold with or without the seam; the abort above is the
    // load-bearing observation.)
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();
    await expect(layerCheckbox(page, 'bia-reservations')).toBeChecked();
    const layers = await urlLayers(page);
    expect(layers.has('aiannh')).toBe(true);
    expect(layers.has('bia-reservations')).toBe(true);

    // Whatever the second move issued settles from the fixtures.
    held.releaseAll();
    for (const key of ['aiannh', 'bia-reservations']) {
      await expect.poll(() => pillClasses(page, key), { timeout: 30_000 }).toMatch(
        /\b(ready|no-data|degraded)\b/
      );
      await expect(layerCheckbox(page, key)).toBeChecked();
    }
  });
});

// ---------------------------------------------------------------------------
// Clause 4: a late response cannot render after intent changes
// ---------------------------------------------------------------------------

test.describe('DDM-P1-T02: a late response cannot render after intent changes', () => {
  test('a superseding activate of the same layer aborts the first attempt and settles the fresh one', async ({
    page
  }) => {
    await stubCommon(page);
    const held = makeHeld();
    await holdBoundaries(page, held);
    const failures = watchFailures(page, (url) => url.includes('tigerweb.geo.census.gov'));

    await gotoApp(page, '?view=console&layers=states');
    await openTribalNationsDetails(page);
    const aiannh = layerCheckbox(page, 'aiannh');
    await aiannh.check();
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBe(1);

    // Off then on again while the first request is held: the off aborts the
    // first attempt, the on opens a second one with its own request.
    const flippedAt = Date.now();
    await aiannh.uncheck();
    await aiannh.check();
    await expectAbortedWithin(failures, flippedAt);
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBe(2);

    // Release both. The first fulfil meets an aborted request and is dropped
    // by Playwright; had it slipped through, the module's request token
    // would drop it. The second renders and the layer reads live.
    held.releaseAll();
    await expect.poll(() => pillClasses(page, 'aiannh'), { timeout: 30_000 }).toMatch(
      /\b(ready|no-data|degraded)\b/
    );
    await expect(aiannh).toBeChecked();
    expect((await urlLayers(page)).has('aiannh')).toBe(true);
  });

  test('a response released as intent changes to off renders nothing', async ({ page }) => {
    await stubCommon(page);
    const held = makeHeld();
    await holdBoundaries(page, held);

    await gotoApp(page, '?view=console&layers=states');
    await openTribalNationsDetails(page);
    const aiannh = layerCheckbox(page, 'aiannh');
    await aiannh.check();
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBe(1);

    // The response and the off intent race: the fulfil is issued and, in the
    // same breath, the layer is turned off. Whichever lands first, the
    // acceptance holds only if nothing from that response is on the map
    // afterwards: the controller's abort, the module's token guard, and the
    // controller's post-activate stand-down each cover one interleaving.
    held.releaseAll();
    await aiannh.uncheck();
    await page.waitForTimeout(STALE_SETTLE_MS);

    await expect(aiannh).not.toBeChecked();
    await expect(layerPill(page, 'aiannh')).toHaveText('', { timeout: 10_000 });
    expect((await urlLayers(page)).has('aiannh')).toBe(false);
    // And it stays that way: no deferred render arrives later.
    await page.waitForTimeout(STALE_SETTLE_MS);
    await expect(aiannh).not.toBeChecked();
    await expect(layerPill(page, 'aiannh')).toHaveText('');
  });
});

// ---------------------------------------------------------------------------
// S30D P3-CANCEL (found-117; plan rule 5): HeatRisk and the NWS alerts abort
// their held activation reads when a mode switch records off intent
// ---------------------------------------------------------------------------

const HEATRISK_SERVICE_PATH = '/experimental/rest/services/NWS_HeatRisk/ImageServer';
const HEATRISK_FIRST_TIME = 1_785_153_600_000;
const HEATRISK_DAY_MS = 24 * 60 * 60 * 1000;
const HEATRISK_TIMES = Array.from(
  { length: 7 },
  (_, index) => HEATRISK_FIRST_TIME + index * HEATRISK_DAY_MS
);

/** What the page asked the HeatRisk service for, by kind, in order. */
interface HeatRiskRequests {
  readonly metadata: string[];
  readonly catalog: string[];
  readonly exportImage: string[];
}

/**
 * Answer the HeatRisk ImageServer locally. With `held`, the service metadata
 * read (`?f=json`, the activation's first request) is held until released;
 * the catalog and the raster export are always answered at once, and logged,
 * so a request that should never be issued shows as a log entry.
 */
async function routeHeatRiskService(page: Page, held: Held | null): Promise<HeatRiskRequests> {
  const requests: HeatRiskRequests = { metadata: [], catalog: [], exportImage: [] };
  const metadataBody = JSON.stringify({
    timeInfo: { timeExtent: [HEATRISK_TIMES[0], HEATRISK_TIMES[6]] }
  });
  await page.route(
    (url) => url.pathname.startsWith(HEATRISK_SERVICE_PATH),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/query')) {
        requests.catalog.push(url.href);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            features: HEATRISK_TIMES.map((validTime, index) => ({
              attributes: { name: `HeatRisk_${index + 1}_Mercator`, idp_validtime: validTime }
            }))
          })
        });
        return;
      }
      if (url.pathname.endsWith('/exportImage')) {
        requests.exportImage.push(url.href);
        await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
        return;
      }
      if (url.pathname.endsWith('/ImageServer')) {
        requests.metadata.push(url.href);
        if (held) {
          held.releases.push(fulfilLater(route, metadataBody, 'application/json'));
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: metadataBody });
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 400, message: 'Unknown test HeatRisk request' } })
      });
    }
  );
  return requests;
}

/** The cluster keys the rail renders, in button order. */
async function renderedClusters(page: Page): Promise<string[]> {
  return page
    .locator('.shell-cluster-btn')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-cluster') ?? ''));
}

function clusterShowsLayer(cluster: string, layerKey: string): boolean {
  const def = (HAZARD_CLUSTERS as Record<string, (typeof HAZARD_CLUSTERS)[HazardClusterKey]>)[cluster];
  return Object.values(def?.recipes ?? {}).some((recipe) => recipe.some((key) => key === layerKey));
}

/**
 * A rendered mode that shows `layerKey` (to switch into) and one that shows
 * neither layer in `layerKeys` (to switch away to), both read from the
 * cluster table and the rail, never from a literal list of modes.
 */
async function modesAround(
  page: Page,
  layerKey: string,
  layerKeys: readonly string[]
): Promise<{ readonly into: string; readonly away: string }> {
  const rendered = await renderedClusters(page);
  const into = rendered.find((cluster) => clusterShowsLayer(cluster, layerKey));
  const away = rendered.find((cluster) => layerKeys.every((key) => !clusterShowsLayer(cluster, key)));
  if (into === undefined || away === undefined) {
    throw new Error(`no rendered mode shows ${layerKey}, or none shows none of ${layerKeys.join(', ')}`);
  }
  return { into, away };
}

/**
 * Record, from now on, every legend section for `legendKeys` and every
 * "Loading HeatRisk..." frame indicator the page ever adds, even one removed
 * again within the same task, but only when `legendKeys` names heatrisk: a
 * case that watches the alerts claims nothing about HeatRisk, whose partner
 * frame in the same mode may legitimately still be loading, and whose
 * pending indicator the page re-renders whenever another load settles
 * (S30D block 3: two records before the switch and one after it, from a
 * single frame begun before the watch). The module's late path draws them
 * and the controller's undo removes them, so the end state alone cannot tell
 * a prompt cancellation from a late render that was cleaned up.
 */
async function watchDrawn(page: Page, legendKeys: readonly string[]): Promise<void> {
  await page.evaluate((keys) => {
    const store = window as unknown as { __cancelDrawn: string[] };
    store.__cancelDrawn = [];
    const watchesHeatRisk = keys.includes('heatrisk');
    const inspect = (node: Node): void => {
      if (watchesHeatRisk && (node.textContent ?? '').includes('Loading HeatRisk...')) {
        store.__cancelDrawn.push('indicator');
      }
      if (!(node instanceof Element)) return;
      for (const key of keys) {
        const selector = `.legend-section[data-legend="${key}"]`;
        if (node.matches(selector) || node.querySelector(selector)) {
          store.__cancelDrawn.push(`legend:${key}`);
        }
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach(inspect);
        if (record.type === 'characterData') inspect(record.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }, legendKeys);
}

async function readDrawn(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cancelDrawn?: string[] }).__cancelDrawn ?? []);
}

test.describe('S30D P3-CANCEL: a mode switch aborts the activation reads of HeatRisk and the alerts', () => {
  test('HeatRisk: a mode switch aborts the held metadata read, issues no catalog or export request and draws nothing', async ({
    page
  }) => {
    await stubCommon(page);
    const held = makeHeld();
    const requests = await routeHeatRiskService(page, held);
    const failures = watchFailures(page, (url) => new URL(url).pathname.endsWith('/ImageServer'));

    await gotoApp(page, '?view=console');
    const { into, away } = await modesAround(page, 'heatrisk', ['heatrisk', 'nws-alerts']);
    await page.locator(`.shell-cluster-btn[data-cluster="${into}"]`).click();
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(layerPill(page, 'heatrisk')).toHaveText('loading...');
    expect(requests.catalog).toHaveLength(0);

    await watchDrawn(page, ['heatrisk']);
    const offAt = Date.now();
    await page.locator(`.shell-cluster-btn[data-cluster="${away}"]`).click();

    // THE assertion: the held metadata read is aborted well inside the 10 s
    // budget it would otherwise have run out behind the queued teardown.
    await expectAbortedWithin(failures, offAt);

    // Release the aborted read LAST: nothing may follow it.
    held.releaseAll();
    await expect(layerPill(page, 'heatrisk')).toHaveText('', { timeout: 10_000 });
    await awaitQuiescence(page);
    expect(requests.metadata).toHaveLength(1);
    expect(requests.catalog).toHaveLength(0);
    expect(requests.exportImage).toHaveLength(0);
    expect(await readDrawn(page)).toEqual([]);
    await expect(page.locator('.legend-section[data-legend="heatrisk"]')).toHaveCount(0);
    await expect(page.locator('#map-key [data-key-loading="heatrisk"]')).toHaveCount(0);
    await expect(page.locator('#loading-indicator')).not.toContainText('HeatRisk');
    expect((await urlLayers(page)).has('heatrisk')).toBe(false);
  });

  test('NWS alerts: a mode switch aborts the held WWA read and its legend and key row never appear', async ({
    page
  }) => {
    await stubCommon(page);
    // HeatRisk shares the mode: answer it at once so only the alerts read is held.
    const heatRisk = await routeHeatRiskService(page, null);
    const held = makeHeld();
    const wwaRequests: string[] = [];
    // A page route outranks the suite's context default (tests/nws-wwa-fixtures.ts).
    await page.route(
      (url) => isNwsWwaRequestUrl(url),
      (route) => {
        wwaRequests.push(route.request().url());
        held.releases.push(fulfilLater(route, JSON.stringify(NWS_WWA_EMPTY)));
      }
    );
    const failures = watchFailures(page, (url) => isNwsWwaRequestUrl(new URL(url)));

    await gotoApp(page, '?view=console');
    const { into, away } = await modesAround(page, 'nws-alerts', ['nws-alerts']);
    await page.locator(`.shell-cluster-btn[data-cluster="${into}"]`).click();
    await expect.poll(() => held.releases.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(layerPill(page, 'nws-alerts')).toHaveText('loading...');

    await watchDrawn(page, ['nws-alerts']);
    const offAt = Date.now();
    await page.locator(`.shell-cluster-btn[data-cluster="${away}"]`).click();
    await expectAbortedWithin(failures, offAt);

    held.releaseAll();
    await expect(layerPill(page, 'nws-alerts')).toHaveText('', { timeout: 10_000 });
    await awaitQuiescence(page);
    expect(wwaRequests).toHaveLength(1);
    expect(await readDrawn(page)).toEqual([]);
    await expect(page.locator('.legend-section[data-legend="nws-alerts"]')).toHaveCount(0);
    await expect(page.locator('#map-key [data-key-loading="nws-alerts"]')).toHaveCount(0);
    expect((await urlLayers(page)).has('nws-alerts')).toBe(false);
    // The partner HeatRisk, answered at once, was not held by this case.
    expect(heatRisk.metadata.length).toBeGreaterThan(0);
  });
});
