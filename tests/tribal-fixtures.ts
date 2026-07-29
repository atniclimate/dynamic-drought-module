/**
 * Synthetic Tribal-geography fixtures for the umbrella-build specs.
 *
 * HARD RULE 1 GUARD (CLAUDE.md section 4; the plan-attack standing guard):
 * nothing in this file is, or resembles, a real AIANNH or AIAN-LAR
 * polygon. Every geometry is a hand-authored rectangle placed inside the
 * default Washington State viewport purely so a map click can hit it, and
 * every name is an obviously synthetic fixture label. Route interception
 * replaces the live agency responses with these bodies so the specs are
 * deterministic offline and no real sovereign-boundary polygon ever enters
 * the repository or a test artifact.
 */

import type { Page } from '@playwright/test';

/** Route patterns for the two live Tribal-geography services. */
export const AIANNH_ROUTE = '**/tigerweb.geo.census.gov/**/MapServer/47/query*';
export const BIA_ROUTE = '**/biamaps.geoplatform.gov/**/FeatureServer/0/query*';

/**
 * A rectangle ring, `[w, s, e, n]` in WGS 84. The fixtures cover the middle
 * of the Washington State region (`regions.ts` bounds roughly -124.8..-116.9
 * by 45.5..49.0) so a map-center click lands inside them.
 */
function rectRing(w: number, s: number, e: number, n: number): number[][][] {
  return [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s]
    ]
  ];
}

/** A synthetic AIANNH response: one legal-subtype and one statistical-subtype
 * feature, both spanning the viewport center so either can be clicked. */
export function syntheticAiannhBody(): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 1,
        properties: {
          NAME: 'Synthetic Legal Fixture Area',
          BASENAME: 'Synthetic Legal Fixture',
          AIANNHCC: 'D1',
          AIANNHNS: '90000001',
          MTFCC: 'G2100',
          AREALAND: '1000',
          AREAWATER: '0'
        },
        geometry: { type: 'Polygon', coordinates: rectRing(-123.5, 46.0, -118.0, 48.6) }
      },
      {
        type: 'Feature',
        id: 2,
        properties: {
          NAME: 'Synthetic Statistical Fixture Area (OTSA)',
          BASENAME: 'Synthetic Statistical Fixture',
          AIANNHCC: 'D6',
          AIANNHNS: '90000002',
          MTFCC: 'G2120',
          AREALAND: '1000',
          AREAWATER: '0'
        },
        geometry: { type: 'Polygon', coordinates: rectRing(-118.0, 46.0, -117.2, 48.6) }
      }
    ]
  };
}

/** A synthetic AIAN-LAR response with one fixture land area over center. */
export function syntheticBiaBody(): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 11,
        properties: {
          LARID: '99001',
          LARNAME: 'Synthetic Reservation Fixture',
          CLASSIFICATION: 'Fixture Classification',
          GISACRES: 1000,
          REGION: 'Fixture Region'
        },
        geometry: { type: 'Polygon', coordinates: rectRing(-123.5, 46.0, -118.0, 48.6) }
      }
    ]
  };
}

/** An empty FeatureCollection (the honest live-zero case). */
export function emptyCollectionBody(): unknown {
  return { type: 'FeatureCollection', features: [] };
}

/** An ArcGIS error-shaped body (HTTP 200 with an error payload). */
export function arcgisErrorBody(): unknown {
  return { error: { code: 500, message: 'Synthetic fixture error' } };
}

/** Fulfill a route pattern with a GeoJSON body. */
export async function routeGeojson(page: Page, pattern: string, body: unknown): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: JSON.stringify(body)
    })
  );
}

/** Route both live Tribal-geography services to their happy fixtures. */
export async function routeAllTribalFixtures(page: Page): Promise<void> {
  await routeGeojson(page, AIANNH_ROUTE, syntheticAiannhBody());
  await routeGeojson(page, BIA_ROUTE, syntheticBiaBody());
}
