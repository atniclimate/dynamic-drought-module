import type { BrowserContext, Page, Route } from '@playwright/test';

export const USDM_FIXTURE_PRIOR_WEEK = '20260623';

/** A valid empty collection: the honest answer of a read that found nothing. */
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] } as const;

/**
 * The default boot's North American Drought Monitor read (gotoApp's
 * `installDefaultNadmStub`, tests/helpers.ts): one D2 polygon, consensus
 * month June 2026.
 */
export const TEST_NADM_SNAPSHOT = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { DROUGHTCAT: 'd2', YEAR_MONTH: '202606' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-140, 20], [-50, 20], [-50, 75], [-140, 75], [-140, 20]]]
      }
    }
  ]
} as const;

/** The default boot's weekly U.S. Drought Monitor read: one D2 polygon, map dated Aug 11, 2026. */
export const TEST_USDM_SNAPSHOT = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        DM: 2,
        MapDate: Date.UTC(2026, 7, 11),
        ValidStart: Date.UTC(2026, 7, 11),
        ValidEnd: Date.UTC(2026, 7, 17)
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-140, 20], [-50, 20], [-50, 75], [-140, 75], [-140, 20]]]
      }
    }
  ]
} as const;

/** The default NADM stub's consensus month, `YYYY-MM`, read from the snapshot. */
export const DEFAULT_NADM_MONTH: string = (() => {
  const yearMonth = TEST_NADM_SNAPSHOT.features[0].properties.YEAR_MONTH;
  return `${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}`;
})();

/** The default USDM stub's map date, `YYYY-MM-DD` (UTC), read from the snapshot. */
export const DEFAULT_USDM_MAP_DATE: string = new Date(TEST_USDM_SNAPSHOT.features[0].properties.MapDate)
  .toISOString()
  .slice(0, 10);

/**
 * Whether a U.S. Drought Monitor request is a map frame read. The map layer
 * (src/layers/usdm.ts `buildCurrentQueryUrl`, `buildArchiveQueryUrl`) GETs a
 * whole frame with a `where` and no geometry; the briefing's read
 * (src/impact/sources.ts `fetchUsdmClaims`) asks for one point or one place,
 * as a GET carrying `geometry` or as a form POST.
 */
export function isUsdmMapFrameRead(method: string, url: URL): boolean {
  return method === 'GET' && !url.searchParams.has('geometry');
}

const usdmStubContexts = new WeakSet<BrowserContext>();

/**
 * Route the U.S. Drought Monitor's current and archive services on the browser
 * CONTEXT, as `installDefaultNadmStub` does and for the same reasons. Since
 * DR-270 a boot that lists no layers draws the weekly U.S. map in the default
 * United States geography, so without this every routine boot would read the
 * live service. Only the map's frame reads get the D2 polygon: a briefing's
 * point or place read gets a valid empty collection, so the default map never
 * decides what a briefing leads with. A spec's own `page.route` for these
 * services still wins (Playwright checks Page routes before Context routes).
 */
export async function installDefaultUsdmStub(page: Page): Promise<void> {
  const context = page.context();
  if (usdmStubContexts.has(context)) return;
  usdmStubContexts.add(context);
  const fulfill = (route: Route): Promise<void> => {
    const request = route.request();
    const mapFrame = isUsdmMapFrameRead(request.method(), new URL(request.url()));
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(mapFrame ? TEST_USDM_SNAPSHOT : EMPTY_COLLECTION)
    });
  };
  await context.route('**/USDM_current/**', fulfill);
  await context.route('**/USDM_archive/**', fulfill);
}

/**
 * Answer the briefing's U.S. Drought Monitor point and place reads with
 * `body` (by default a valid empty collection, which the context default
 * already serves), while the weekly map's own frame read falls through to
 * `installDefaultUsdmStub`'s D2 frame. A spec's own route of the whole
 * service would answer the map's frame read too, and a default boot would
 * then draw that body as the map (the DR-270 text-registration cases).
 */
export async function stubUsdmBriefingReads(page: Page, body: unknown = EMPTY_COLLECTION): Promise<void> {
  await page.route('**/USDM_current/**', (route) =>
    isUsdmMapFrameRead(route.request().method(), new URL(route.request().url()))
      ? route.fallback()
      : route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(body) })
  );
}

/** Positive synthetic PNW data for tests that require a surviving USDM layer
 * or a date rail. Opt in per case; error/no-data tests keep their own routes. */
export async function stubUsdmWeeks(page: Page): Promise<void> {
  const frame = (dm: number, date: string) => ({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { DM: dm, MapDate: Date.parse(`${date}T00:00:00Z`) },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-125, 42], [-116, 42], [-116, 49], [-125, 49], [-125, 42]]]
      }
    }]
  });
  await page.route('**/USDM_current/**', (route) => route.fulfill({
    contentType: 'application/geo+json',
    body: JSON.stringify(frame(2, '2026-06-30'))
  }));
  await page.route('**/USDM_archive/**', (route) => {
    const where = new URL(route.request().url()).searchParams.get('where') ?? '';
    const date = /^MapDate=timestamp '(\d{4}-\d{2}-\d{2}) 00:00:00'$/.exec(where)?.[1];
    if (!date) return route.fulfill({ status: 400, body: 'Unknown test USDM archive query' });
    return route.fulfill({
      contentType: 'application/geo+json',
      body: JSON.stringify(frame(4, date))
    });
  });
}
