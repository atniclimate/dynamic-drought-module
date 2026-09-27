import { expect, test, type Page, type Route } from '@playwright/test';
import type * as maplibregl from 'maplibre-gl';
import { readFileSync } from 'node:fs';

import { pointHasHeatRiskCoverage } from '../src/layers/heatrisk-coverage';
import { RASTER_PROOF_DEADLINE_MS, watchRasterTiles } from '../src/util/raster-status';
import { awaitQuiescence, gotoApp, layerPill, PILL } from './helpers';
import { captureWarnings, type CapturedWarnings } from './map-harness';

type Handler = (event: Record<string, unknown>) => void;

interface StateFeature {
  readonly properties: {
    readonly STUSPS: string;
  };
  readonly geometry: {
    readonly coordinates: unknown;
  };
}

interface StateFeatureCollection {
  readonly features: readonly StateFeature[];
}

const heatRiskSource = readFileSync(
  new URL('../src/layers/heatrisk.ts', import.meta.url),
  'utf8'
);

function visitVertices(
  coordinates: unknown,
  visit: (lng: number, lat: number) => void
): void {
  if (!Array.isArray(coordinates)) {
    throw new Error('Expected an array of GeoJSON coordinates.');
  }
  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    visit(coordinates[0], coordinates[1]);
    return;
  }
  for (const child of coordinates) visitVertices(child, visit);
}

class FakeMap {
  private readonly handlers = new Map<string, Handler[]>();
  /** Sources MapLibre would call settled (`isSourceLoaded`). */
  readonly loadedSources = new Set<string>();

  isSourceLoaded(id: string): boolean {
    return this.loadedSources.has(id);
  }

  on(name: string, handler: Handler): void {
    const current = this.handlers.get(name) ?? [];
    current.push(handler);
    this.handlers.set(name, current);
  }

  off(name: string, handler: Handler): void {
    const current = this.handlers.get(name) ?? [];
    this.handlers.set(
      name,
      current.filter((candidate) => candidate !== handler)
    );
  }

  fire(name: string, event: Record<string, unknown>): void {
    for (const handler of this.handlers.get(name) ?? []) handler(event);
  }
}

// The watcher's degrade paths warn their honest reason (the third error in
// the rolling window, an expired deadline, a cycle with known holes). These
// tests drive every one of them on purpose, so capture the warnings instead
// of printing their stacks into the shard log (DDM-P0-T06). Each test names
// the exact warnings it expects through `expectWarnings`; the default is
// none, and `afterEach` compares the whole list, so a warning that goes
// missing, doubles, or reads differently fails the test that owns it.
const UNAVAILABLE_AFTER_REPEATED_FAILURES = (sourceId: string, error: string): string =>
  `[${sourceId}] repeated tile-load failures; reporting unavailable. Error: ${error}`;
const UNAVAILABLE_AT_DEADLINE = (sourceId: string): string =>
  `[${sourceId}] no selected-frame tile succeeded before the load deadline; reporting unavailable.`;
const PARTIAL_WITH_KNOWN_HOLES = (sourceId: string): string =>
  `[${sourceId}] selected-frame tile requests completed with known holes; reporting live (partial).`;

let warnings: CapturedWarnings;
let expectedWarnings: readonly string[] = [];

function expectWarnings(list: readonly string[]): void {
  expectedWarnings = list;
}

test.beforeEach(() => {
  expectedWarnings = [];
  warnings = captureWarnings();
});

test.afterEach(() => {
  warnings.restore();
  expect(warnings.messages).toEqual(expectedWarnings);
});

test('the raster watcher keeps its existing heal-only success behavior by default', () => {
  // The threshold warns exactly once, at the third error, with the error.
  expectWarnings([
    UNAVAILABLE_AFTER_REPEATED_FAILURES('shared-raster', 'synthetic tile failure')
  ]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'shared-raster',
    (status) => reports.push(status)
  );

  map.fire('sourcedata', {
    sourceId: 'shared-raster',
    dataType: 'source',
    tile: {}
  });
  expect(reports).toEqual([]);

  for (let index = 0; index < 3; index += 1) {
    map.fire('error', {
      sourceId: 'shared-raster',
      error: new Error('synthetic tile failure')
    });
  }
  expect(reports).toEqual(['error']);

  map.fire('sourcedata', {
    sourceId: 'shared-raster',
    dataType: 'source',
    tile: {}
  });
  expect(reports).toEqual(['error', 'ready']);
});

test('the HeatRisk opt-in reports its first successful tile once', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  const watcher = watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    { reportInitialSuccess: true }
  );

  const tileEvent = {
    sourceId: 'heatrisk-frame',
    dataType: 'source',
    tile: {}
  };
  map.fire('sourcedata', tileEvent);
  map.fire('sourcedata', tileEvent);
  expect(reports).toEqual(['ready']);

  watcher.reset();
  map.fire('sourcedata', tileEvent);
  expect(reports).toEqual(['ready', 'ready']);
});

test('the HeatRisk opt-in fails when its positive-success deadline expires', async () => {
  expectWarnings([UNAVAILABLE_AT_DEADLINE('heatrisk-frame')]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 30
    }
  );

  map.fire('sourcedataloading', {
    sourceId: 'heatrisk-frame',
    dataType: 'source',
    tile: { tileID: { key: 'missing-1' } }
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(reports).toEqual(['error']);
});

test('the HeatRisk opt-in reports a mixed-success request cycle as partial', () => {
  expectWarnings([PARTIAL_WITH_KNOWN_HOLES('heatrisk-frame')]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  for (const key of ['loaded-1', 'missing-1']) {
    map.fire('sourcedataloading', {
      sourceId: 'heatrisk-frame',
      dataType: 'source',
      tile: { tileID: { key } }
    });
  }
  map.fire('sourcedata', {
    sourceId: 'heatrisk-frame',
    dataType: 'source',
    tile: { tileID: { key: 'loaded-1' } }
  });
  map.fire('idle', {});

  expect(reports).toEqual(['degraded']);
});

test('completeness reports ready when the target source settles without map idle', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'selected-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  map.fire('sourcedata', {
    sourceId: 'unrelated-source',
    dataType: 'source',
    isSourceLoaded: true
  });
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    isSourceLoaded: true
  });
  expect(reports).toEqual([]);

  map.fire('sourcedataloading', {
    sourceId: 'selected-frame',
    dataType: 'source',
    tile: { tileID: { key: 'loaded-1' } }
  });
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    isSourceLoaded: true,
    tile: { tileID: { key: 'loaded-1' } }
  });

  expect(reports).toEqual(['ready']);
});

test('completeness reports partial when the target source settles with known holes', () => {
  expectWarnings([PARTIAL_WITH_KNOWN_HOLES('selected-frame')]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'selected-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  for (const key of ['loaded-1', 'missing-1']) {
    map.fire('sourcedataloading', {
      sourceId: 'selected-frame',
      dataType: 'source',
      tile: { tileID: { key } }
    });
  }
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    isSourceLoaded: false,
    tile: { tileID: { key: 'loaded-1' } }
  });
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    isSourceLoaded: true
  });

  expect(reports).toEqual(['degraded']);
});

test('completeness waits through three early errors and reports mixed success as partial', () => {
  expectWarnings([PARTIAL_WITH_KNOWN_HOLES('selected-frame')]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'selected-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  for (const key of ['failed-1', 'failed-2', 'failed-3', 'loaded-1']) {
    map.fire('sourcedataloading', {
      sourceId: 'selected-frame',
      dataType: 'source',
      tile: { tileID: { key } }
    });
  }
  for (let index = 0; index < 3; index += 1) {
    map.fire('error', {
      sourceId: 'selected-frame',
      error: new Error(`synthetic tile failure ${index + 1}`)
    });
  }

  expect(reports).toEqual([]);
  map.fire('sourcedata', {
    sourceId: 'selected-frame',
    dataType: 'source',
    tile: { tileID: { key: 'loaded-1' } }
  });
  map.fire('idle', {});

  expect(reports).toEqual(['degraded']);
});

test('completeness still reports total failure after three early errors', () => {
  // Completeness accounting reports once at idle; the legacy three-error
  // shortcut stays silent when a deadline is configured.
  expectWarnings([UNAVAILABLE_AT_DEADLINE('selected-frame')]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'selected-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  for (const key of ['failed-1', 'failed-2', 'failed-3']) {
    map.fire('sourcedataloading', {
      sourceId: 'selected-frame',
      dataType: 'source',
      tile: { tileID: { key } }
    });
    map.fire('error', {
      sourceId: 'selected-frame',
      error: new Error(`synthetic tile failure ${key}`)
    });
  }

  expect(reports).toEqual([]);
  map.fire('idle', {});

  expect(reports).toEqual(['error']);
});

test('the HeatRisk completeness opt-in treats an empty idle cycle as complete', () => {
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000
    }
  );

  map.fire('idle', {});

  expect(reports).toEqual(['ready']);
});

test('a completeness consumer can require positive tile evidence at idle', () => {
  expectWarnings([UNAVAILABLE_AT_DEADLINE('completeness-consumer')]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'completeness-consumer',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000,
      emptyIdleOutcome: 'error'
    }
  );

  map.fire('idle', {});

  expect(reports).toEqual(['error']);
});

test('the HeatRisk completeness opt-in retains its no-evidence deadline', async () => {
  expectWarnings([UNAVAILABLE_AT_DEADLINE('heatrisk-frame')]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'heatrisk-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 30
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 60));

  expect(reports).toEqual(['error']);
});

test('the shared tile-proof deadline sits strictly below the 10 s boot-idle budget', () => {
  // src/state/boot-idle.ts DEFAULT_QUIESCENCE_BUDGET_MS (10_000), which is
  // also Playwright's expect.timeout: a row that never proves a tile must
  // still reach a terminal state inside a settled boot.
  expect(RASTER_PROOF_DEADLINE_MS).toBeLessThan(10_000);
});

test('a completeness watcher is not downgraded below live (partial) when a later cycle\'s deadline fires after a rendered frame', async () => {
  // found-042: the deadline alone is not evidence of failure once a frame
  // has rendered; a finished cycle's evidence still is (next case).
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'proven-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 30,
      emptyIdleOutcome: 'error'
    }
  );

  map.fire('sourcedataloading', { sourceId: 'proven-frame', dataType: 'source', tile: { tileID: { key: 'a' } } });
  map.fire('sourcedata', {
    sourceId: 'proven-frame',
    dataType: 'source',
    isSourceLoaded: true,
    tile: { tileID: { key: 'a' } }
  });
  expect(reports).toEqual(['ready']);

  // A pan opens a new cycle whose tile never answers before the deadline.
  expectWarnings([PARTIAL_WITH_KNOWN_HOLES('proven-frame')]);
  map.fire('sourcedataloading', { sourceId: 'proven-frame', dataType: 'source', tile: { tileID: { key: 'b' } } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(reports).toEqual(['ready', 'degraded']);
});

test('after a rendered frame, a finished cycle with no tile loaded still reads unavailable', () => {
  // The floor is the deadline's alone: a pan wholly off coverage whose every
  // request failed and settled is evidence, and reads unavailable (DR-050 a).
  expectWarnings([UNAVAILABLE_AT_DEADLINE('proven-frame')]);
  const map = new FakeMap();
  const reports: string[] = [];
  watchRasterTiles(
    map as unknown as maplibregl.Map,
    'proven-frame',
    (status) => reports.push(status),
    {
      reportInitialSuccess: true,
      requestCompletenessDeadlineMs: 1_000,
      emptyIdleOutcome: 'error'
    }
  );
  map.fire('sourcedataloading', { sourceId: 'proven-frame', dataType: 'source', tile: { tileID: { key: 'a' } } });
  map.fire('sourcedata', { sourceId: 'proven-frame', dataType: 'source', tile: { tileID: { key: 'a' } } });
  map.fire('idle', {});
  map.fire('sourcedataloading', { sourceId: 'proven-frame', dataType: 'source', tile: { tileID: { key: 'off-1' } } });
  map.fire('idle', {});
  expect(reports).toEqual(['ready', 'error']);
});

test('a bounded archive reads an empty cycle as no data, at idle or at a deadline once the source has loaded', async () => {
  // A view wholly outside the archive's declared extent requests no tile.
  const idleMap = new FakeMap();
  const idleReports: string[] = [];
  watchRasterTiles(
    idleMap as unknown as maplibregl.Map,
    'bounded-archive',
    (status) => idleReports.push(status),
    { requestCompletenessDeadlineMs: 1_000, emptyIdleOutcome: 'no-data' }
  );
  idleMap.fire('idle', {});
  expect(idleReports).toEqual(['no-data']);

  // A map that never idles (a pulse animation) still ends the cycle.
  const busyMap = new FakeMap();
  busyMap.loadedSources.add('bounded-archive');
  const busyReports: string[] = [];
  watchRasterTiles(
    busyMap as unknown as maplibregl.Map,
    'bounded-archive',
    (status) => busyReports.push(status),
    { requestCompletenessDeadlineMs: 30, emptyIdleOutcome: 'no-data' }
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(busyReports).toEqual(['no-data']);

  // An archive that never loaded is a failure, not an absence.
  expectWarnings([UNAVAILABLE_AT_DEADLINE('bounded-archive')]);
  const stalledMap = new FakeMap();
  const stalledReports: string[] = [];
  watchRasterTiles(
    stalledMap as unknown as maplibregl.Map,
    'bounded-archive',
    (status) => stalledReports.push(status),
    { requestCompletenessDeadlineMs: 30, emptyIdleOutcome: 'no-data' }
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(stalledReports).toEqual(['error']);
});

test('the HeatRisk coverage gate has no runtime state-geometry request', () => {
  expect(heatRiskSource).not.toContain('URLS.usStatesLocal');
});

test('the HeatRisk coverage ring contains every qualified geometry vertex', () => {
  const states = JSON.parse(
    readFileSync(
      new URL('../public/data/us-states.geojson', import.meta.url),
      'utf8'
    )
  ) as StateFeatureCollection;
  const excluded = new Set(['AK', 'HI', 'PR']);
  let vertexCount = 0;
  let outsideVertexCount = 0;

  for (const feature of states.features) {
    if (excluded.has(feature.properties.STUSPS)) continue;
    visitVertices(feature.geometry.coordinates, (lng, lat) => {
      vertexCount += 1;
      if (!pointHasHeatRiskCoverage(lng, lat)) outsideVertexCount += 1;
    });
  }

  expect(vertexCount).toBe(11_009);
  expect(outsideVertexCount).toBe(0);
});

for (const [name, lng, lat, expected] of [
  ['Presidio, Texas', -104.371, 29.56, true],
  ['Terlingua, Texas', -103.616, 29.321, true],
  ['Chisos Basin, Texas', -103.303, 29.27, true],
  ['Cape Flattery, Washington', -124.735, 48.383, true],
  ['Neah Bay, Washington', -124.625, 48.368, true],
  ['Brownsville, Texas', -97.497, 25.902, true],
  ['Key West, Florida', -81.78, 24.555, true],
  ['Caribou, Maine', -68.016, 46.861, true],
  ['San Diego, California', -117.161, 32.716, true],
  ['Nassau, Bahamas', -77.355, 25.044, false],
  ['Victoria, British Columbia', -123.366, 48.428, true],
  ['Tijuana, Mexico', -117.038, 32.514, true],
] as const) {
  test(`the HeatRisk coverage gate classifies ${name} with its documented outward bias`, () => {
    expect(pointHasHeatRiskCoverage(lng, lat)).toBe(expected);
  });
}

test('the HeatRisk coverage gate excludes distant non-covered centers', () => {
  expect(pointHasHeatRiskCoverage(-122.33, 47.61)).toBe(true);
  expect(pointHasHeatRiskCoverage(-149.9, 61.22)).toBe(false);
  expect(pointHasHeatRiskCoverage(-157.86, 21.31)).toBe(false);
  expect(pointHasHeatRiskCoverage(-66.11, 18.47)).toBe(false);
  expect(pointHasHeatRiskCoverage(-123.12, 49.28)).toBe(false);
});

// ---------------------------------------------------------------------------
// Tile-proven readiness in the browser (DDM-P14-T04, register item found-001)
// ---------------------------------------------------------------------------

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * How long a held first tile is observed before release: well inside the
 * shared proof deadline, so the held layer is still `loading` (not yet
 * `unavailable`) when the route is released.
 */
const HOLD_PROBE_MS = 3_000;

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

async function stubSstDomains(page: Page): Promise<void> {
  await page.route(
    (url) => url.href.includes('REQUEST=DescribeDomains'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/xml',
        body:
          "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
          '<ows:Identifier>time</ows:Identifier>' +
          '<Domain>2026-09-20/2026-09-24/P1D</Domain>' +
          '<Size>1</Size></DimensionDomain></Domains>'
      })
  );
}

test.describe('tile-proven raster readiness in the browser (DDM-P14-T04, found-001)', () => {
  test('the hold window sits inside the shared proof deadline', () => {
    expect(HOLD_PROBE_MS).toBeLessThan(RASTER_PROOF_DEADLINE_MS);
  });

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
      await route.continue().catch(() => undefined);
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
      await route.continue().catch(() => undefined);
    });
    await gotoApp(page, '?view=console&layers=hillshade&region=national', {
      bootIdle: false
    });
    await expect(layerPill(page, 'hillshade')).toHaveText(PILL.live);
    gate.release();
  });
});
