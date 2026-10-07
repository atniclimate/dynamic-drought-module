import type { Page } from '@playwright/test';

export const USDM_FIXTURE_PRIOR_WEEK = '20260623';

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
