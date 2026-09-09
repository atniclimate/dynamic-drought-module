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

import { FRAMING_KEYS } from '../src/config/framings';
import type { FramingKey } from '../src/config/framings';
import { buildMinimapWildfireQueryBody } from '../src/state/minimap-wildfire';

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

/**
 * The nine framings' authored geometry, keyed by the SAME `geometry` string
 * `buildMinimapWildfireQueryBody` posts, so a routed WFIGS count query can
 * recover which framing asked without parsing the ArcGIS ring payload.
 * Shared between `tests/s4-minimap.spec.ts` and `tests/minimap-wildfire.spec.ts`
 * (DDM-P11-T01) so both drive the exact same wildfire minimap fixture through
 * the exact same route, rather than one drifting from the other.
 */
const WILDFIRE_GEOMETRY_KEYS = new Map(
  FRAMING_KEYS.map((key) => [
    buildMinimapWildfireQueryBody(key).get('geometry'),
    key,
  ]),
);

/**
 * Route the WFIGS current-perimeter count query (the minimap's live
 * wildfire signal) and the NOAA smoke-detection query it also fires, to a
 * per-framing fixture. `counts` names which framings answer with a
 * positive current-perimeter count; every other framing answers zero,
 * which is the DR-041 b fallback path (a SUCCESSFUL zero, not an
 * unavailable read) unless the caller's own route overrides this one.
 */
export async function stubWildfireMinimap(
  page: Page,
  counts: Readonly<Partial<Record<FramingKey, number>>> = {},
  onPost?: () => void,
): Promise<void> {
  await page.route(
    '**/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query**',
    (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
        });
      }
      onPost?.();
      const body = new URLSearchParams(route.request().postData() ?? '');
      const key = WILDFIRE_GEOMETRY_KEYS.get(body.get('geometry'));
      if (key === undefined) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Unknown test geometry' } }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: counts[key] ?? 0 }),
      });
    },
  );
  await page.route('**/NOAA_Satellite_Smoke_Detection_*/FeatureServer/0/query**',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
      }),
  );
}

/**
 * Fail every WFIGS count query for the named framings (DR-041 b: an
 * unavailable current-fire read must render `unavailable`, never fall
 * through to WHP as if it had answered). Combine with `stubWildfireMinimap`
 * by registering this route SECOND: Playwright's page routes resolve most
 * recently registered first, so this one wins for the framings it names
 * and the earlier stub still answers every other framing.
 */
export async function stubWildfireMinimapUnavailable(
  page: Page,
  framings: readonly FramingKey[],
): Promise<void> {
  const geometries = new Set(
    framings.map((key) => buildMinimapWildfireQueryBody(key).get('geometry')),
  );
  await page.route(
    '**/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query**',
    (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = new URLSearchParams(route.request().postData() ?? '');
      if (!geometries.has(body.get('geometry'))) return route.fallback();
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'synthetic unavailable' } }),
      });
    },
  );
}
