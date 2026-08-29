/**
 * The continental analysis inputs the always-mounted minimap fetches, and the
 * suite-wide stub that answers them on every browser boot.
 *
 * WHY THIS EXISTS (DDM-P1-T08, 2026-08-29). `<Minimap>` mounts on every boot
 * that is not a brief embed, and `retainMinimapDrought`
 * (`src/state/minimap-drought.ts`) then fetches three files in one
 * `Promise.all`: the NADM drought snapshot, NCEI's North America country
 * base, and a Statistics Canada province boundary filtered to Nunavut. Only
 * the first was stubbed suite-wide, so nearly every boot sent live requests
 * to `ncei.noaa.gov` and `geo.statcan.gc.ca`. That was invisible while CI
 * retained nothing. It stopped being invisible the day CI began retaining
 * traces, because a trace records response bodies verbatim.
 *
 * NEITHER FILE IS SOVEREIGN GEOMETRY, and this module does not pretend
 * otherwise. The NCEI base is a country mask keyed on `FIPS_CNTRY`; the
 * StatCan file is one province and territory polygon (PRUID 62) under the
 * Open Government Licence for Canada. Both are open-licensed, both are used
 * only as subtractive analysis masks, and neither is ever rendered or
 * redistributed by the application (`src/config/urls.ts` says so at both
 * entries). They are stubbed because the flip's justification is "no live
 * external geometry enters a retained artifact", and that claim should be
 * true in fact rather than true only for the two hosts anyone thought to
 * check.
 *
 * COVERAGE, stated exactly. `gotoApp` installs this on every boot it drives,
 * and each of the six modules that boot themselves (recorded in
 * `tests/boundary-boot-inventory.test.mjs`) installs it by hand beside its
 * `routeAllTribalFixtures` call. The inventory checks the two requirements
 * SEPARATELY, so a raw boot cannot satisfy the boundary rule and quietly skip
 * this one, which is exactly what all six did until 2026-08-29.
 *
 * The bodies are the hand-authored rectangles `tests/s4-minimap.spec.ts` has
 * always used for its own assertions; they moved here so one set of fixtures
 * serves the whole suite instead of one spec. `data-drought-class`,
 * `data-drought-coverage`, and `data-not-analyzed-percent` in that spec read
 * off exactly these shapes.
 *
 * Routed on the browser CONTEXT for the same two reasons as the boundary stub
 * (`tests/tribal-fixtures.ts`): a context route covers a Page the boot never
 * created, and Playwright checks Page routes first, so a spec that wants a
 * different body registers its own `page.route` and wins whatever the order.
 * Fail-closed: there is no live mode here at all.
 */

import type { BrowserContext, Page, Route } from '@playwright/test';

/**
 * Route patterns for the two continental analysis inputs. They match the
 * paths in `URLS.nadmNorthAmericaBaseGeojson` and
 * `URLS.statsCanNunavutBoundaryGeojson`;
 * `tests/boundary-boot-inventory.test.mjs` fails if either URL drifts so the
 * glob stops matching.
 */
export const NA_LAND_BASE_ROUTE = '**/na/base/northamerica.geojson';
export const NUNAVUT_ANALYSIS_ROUTE = '**/Digital_boundary_files/MapServer/0/query?**';

/** The hostnames behind those two files, for request-level assertions. */
export const MINIMAP_ANALYSIS_HOSTS: readonly string[] = [
  'ncei.noaa.gov',
  'geo.statcan.gc.ca'
];

/**
 * NCEI's North America country base, reduced to four rectangles: a United
 * States block wide enough to cover the mainland framings, a second United
 * States block over the wrapped western Aleutians, a Canada block, and a
 * Mexico block. `FIPS_CNTRY` is the field the minimap filters on.
 */
export function northAmericaLandFixture(): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { FIPS_CNTRY: 'US' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-180, 10],
              [-40, 10],
              [-40, 85],
              [-180, 85],
              [-180, 10],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { FIPS_CNTRY: 'US' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [172, 52],
              [174, 52],
              [174, 54],
              [172, 54],
              [172, 52],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { FIPS_CNTRY: 'CA' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-142, 41],
              [-51, 41],
              [-51, 85],
              [-142, 85],
              [-142, 41],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { FIPS_CNTRY: 'MX' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-120, 14],
              [-85, 14],
              [-85, 34],
              [-120, 34],
              [-120, 14],
            ],
          ],
        },
      },
    ],
  };
}

/**
 * The Nunavut analysis mask, one rectangle carrying `PRUID: '62'`. The
 * minimap subtracts it from the land denominator, which is what makes the
 * far-north framing report `live (partial)` with a non-zero
 * not-analyzed share.
 */
export function nunavutAnalysisExclusionFixture(): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { PRUID: '62' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-100, 68],
              [-90, 68],
              [-90, 75],
              [-100, 75],
              [-100, 68],
            ],
          ],
        },
      },
    ],
  };
}

/** Every request URL this stub answered in a context. */
const stubbedContexts = new WeakMap<BrowserContext, string[]>();

/**
 * Install the minimap analysis stub on this page's browser context.
 * Idempotent per context, and always on locally and in CI alike, for the same
 * "one code path, one meaning" reason as the boundary stub.
 */
export async function installMinimapAnalysisStubs(page: Page): Promise<void> {
  const context = page.context();
  if (stubbedContexts.has(context)) return;
  const fulfilled: string[] = [];
  stubbedContexts.set(context, fulfilled);
  const serve = (body: unknown) => async (route: Route) => {
    fulfilled.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(body),
    });
  };
  await context.route(NA_LAND_BASE_ROUTE, serve(northAmericaLandFixture()));
  await context.route(NUNAVUT_ANALYSIS_ROUTE, serve(nunavutAnalysisExclusionFixture()));
}

/** Every minimap analysis request the suite-wide stub answered in this context. */
export function minimapAnalysisStubLog(page: Page): readonly string[] {
  return stubbedContexts.get(page.context()) ?? [];
}
