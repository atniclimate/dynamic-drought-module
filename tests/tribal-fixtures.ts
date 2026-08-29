/**
 * Synthetic Tribal-geography fixtures, and the suite-wide boundary stub that
 * every browser boot installs.
 *
 * NO-REDISTRIBUTION GUARD (a project hard rule; the plan-attack standing guard):
 * nothing in this file is, or resembles, a real AIANNH or AIAN-LAR
 * polygon. Every geometry is a hand-authored rectangle placed inside the
 * default Washington State viewport purely so a map click can hit it, and
 * every name is an obviously synthetic fixture label. Route interception
 * replaces the live agency responses with these bodies so the specs are
 * deterministic offline and no real sovereign-boundary polygon ever enters
 * the repository or a test artifact. See the NON-REDISTRIBUTION GUARD in
 * `src/layers/aiannh.ts` and the cache note in `src/layers/bia-reservations.ts`.
 *
 * ROUTE OWNERSHIP (DDM-P1-T08). Playwright matches route handlers in REVERSE
 * registration order, so the last handler registered wins. `gotoApp`
 * (tests/helpers.ts) installs the suite-wide stub immediately before it
 * navigates, which is after every `beforeEach` and setup helper a spec runs,
 * so a naive stub would shadow the deliberate abort, empty, partial, and
 * error routes the outage specs depend on. The stub therefore CLAIMS-AWARE:
 * any spec handler registered through `routeBoundary` (and so through
 * `routeGeojson` and `routeAllTribalFixtures`) marks its service as
 * spec-owned on that page, and the suite-wide handler answers such a request
 * with `route.fallback()`, which hands it back to the earlier, spec-owned
 * handler. A service the spec did not claim is answered from the fixture, so
 * a spec that stubs only one of the two services can never reach the other
 * agency by accident. The registration ORDER of a spec's own route no longer
 * matters: before or after `gotoApp`, the spec's handler is the one that
 * answers.
 */

import type { Page, Route } from '@playwright/test';

/** Route patterns for the two live Tribal-geography services. */
export const AIANNH_ROUTE = '**/tigerweb.geo.census.gov/**/MapServer/47/query*';
export const BIA_ROUTE = '**/biamaps.geoplatform.gov/**/FeatureServer/0/query*';

/** The two live boundary services this suite must never reach in a routine run. */
export type BoundaryService = 'aiannh' | 'bia';

/** The hostnames behind those two services, for request-level assertions. */
export const BOUNDARY_HOSTS: readonly string[] = [
  'tigerweb.geo.census.gov',
  'biamaps.geoplatform.gov'
];

/** True when a URL addresses either live boundary service. */
export function isBoundaryRequestUrl(url: string): boolean {
  return BOUNDARY_HOSTS.some((host) => url.includes(host));
}

const BOUNDARY_PATTERNS: Readonly<Record<BoundaryService, string>> = {
  aiannh: AIANNH_ROUTE,
  bia: BIA_ROUTE
};

const BOUNDARY_SERVICES: readonly BoundaryService[] = ['aiannh', 'bia'];

const SERVICE_BY_PATTERN = new Map<string, BoundaryService>([
  [AIANNH_ROUTE, 'aiannh'],
  [BIA_ROUTE, 'bia']
]);

/**
 * How the suite-wide stub answers a boot.
 *
 * - `fixture` (the default every boot uses): the happy synthetic bodies, so
 *   both pills settle on `live` and popup, search, and studio surfaces have a
 *   deterministic, obviously synthetic area to name.
 * - `empty`: an empty FeatureCollection, the honest live-zero case.
 * - `live`: no stub at all, the documented escape hatch. The request leaves
 *   the browser and reaches the agency. Nothing in this suite uses it; the
 *   live boundary path is proven by the daily source-health probe
 *   (`scripts/source-health.mjs`), which drives Chromium outside this suite.
 */
export type BoundaryStubMode = 'fixture' | 'empty' | 'live';

/** A hand-authored fixture FeatureCollection. */
interface FixtureCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly {
    readonly type: 'Feature';
    readonly id?: number;
    readonly properties: Readonly<Record<string, unknown>>;
    readonly geometry: unknown;
  }[];
}

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
export function syntheticAiannhBody(): FixtureCollection {
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
export function syntheticBiaBody(): FixtureCollection {
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
export function emptyCollectionBody(): FixtureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** An ArcGIS error-shaped body (HTTP 200 with an error payload). */
export function arcgisErrorBody(): unknown {
  return { error: { code: 500, message: 'Synthetic fixture error' } };
}

// ---------------------------------------------------------------------------
// Route ownership and the suite-wide stub
// ---------------------------------------------------------------------------

/** Services a SPEC has claimed with its own handler, per page. */
const specClaims = new WeakMap<Page, Set<BoundaryService>>();

interface StubState {
  mode: BoundaryStubMode;
  /** Every request URL the suite-wide stub answered on this page. */
  readonly fulfilled: string[];
}

const stubStates = new WeakMap<Page, StubState>();

/**
 * Register a spec-owned handler for one boundary service and record the claim
 * so the suite-wide stub defers to it. Every spec route on either service goes
 * through here (directly, or through `routeGeojson`); a raw `page.route` on
 * one of these patterns would be shadowed by `gotoApp`, and
 * `tests/boundary-boot-inventory.test.mjs` fails the gate on one.
 */
export async function routeBoundary(
  page: Page,
  pattern: string,
  handler: (route: Route) => unknown
): Promise<void> {
  const service = SERVICE_BY_PATTERN.get(pattern);
  if (!service) {
    throw new Error(
      `routeBoundary needs AIANNH_ROUTE or BIA_ROUTE, received ${JSON.stringify(pattern)}`
    );
  }
  const claims = specClaims.get(page) ?? new Set<BoundaryService>();
  claims.add(service);
  specClaims.set(page, claims);
  await page.route(pattern, handler);
}

/** Fulfill a boundary route pattern with a GeoJSON body. */
export async function routeGeojson(page: Page, pattern: string, body: unknown): Promise<void> {
  await routeBoundary(page, pattern, (route) =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: JSON.stringify(body)
    })
  );
}

/**
 * Route both live Tribal-geography services to their happy fixtures.
 *
 * `gotoApp` already does this for every boot it drives, so a spec needs this
 * only for a boot it performs itself (a raw `page.goto`, a `page.setContent`
 * iframe host, or a framed navigation). Calling it before `gotoApp` is
 * harmless: it claims both services and the suite-wide stub defers.
 */
export async function routeAllTribalFixtures(page: Page): Promise<void> {
  await routeGeojson(page, AIANNH_ROUTE, syntheticAiannhBody());
  await routeGeojson(page, BIA_ROUTE, syntheticBiaBody());
}

/** The ESRI-JSON shape (`f=json`): attributes only, never geometry. */
function esriAttributesBody(collection: FixtureCollection): unknown {
  return {
    features: collection.features.map((feature) => ({ attributes: feature.properties }))
  };
}

function fixtureFor(service: BoundaryService, mode: BoundaryStubMode): FixtureCollection {
  if (mode === 'empty') return emptyCollectionBody();
  return service === 'aiannh' ? syntheticAiannhBody() : syntheticBiaBody();
}

/**
 * Install the suite-wide boundary stub on a page. Idempotent: a second call
 * only updates the mode, so a spec that boots twice keeps one handler pair
 * and one fulfilled-request log.
 *
 * ALWAYS ON, locally and in CI (DDM-P1-T08). The alternative, stubbing only
 * under `CI`, would make a local green and a CI green mean different things,
 * which is exactly the class of divergence the build-identity stamp exists to
 * prevent. One code path, one meaning.
 */
export async function installBoundaryStubs(
  page: Page,
  mode: BoundaryStubMode = 'fixture'
): Promise<void> {
  const existing = stubStates.get(page);
  if (existing) {
    existing.mode = mode;
    return;
  }
  const state: StubState = { mode, fulfilled: [] };
  stubStates.set(page, state);
  for (const service of BOUNDARY_SERVICES) {
    await page.route(BOUNDARY_PATTERNS[service], async (route) => {
      if (state.mode === 'live' || specClaims.get(page)?.has(service)) {
        await route.fallback();
        return;
      }
      const url = route.request().url();
      state.fulfilled.push(url);
      const collection = fixtureFor(service, state.mode);
      const wantsEsriJson = new URL(url).searchParams.get('f') === 'json';
      await route.fulfill(
        wantsEsriJson
          ? {
              contentType: 'application/json',
              body: JSON.stringify(esriAttributesBody(collection))
            }
          : {
              contentType: 'application/geo+json',
              body: JSON.stringify(collection)
            }
      );
    });
  }
}

/**
 * Every boundary request the suite-wide stub answered on this page. The proof
 * spec (`tests/boundary-stubs.spec.ts`) compares it against the page's own
 * request stream, so a URL that the glob patterns miss reads as an escape
 * rather than passing unnoticed.
 */
export function boundaryStubLog(page: Page): readonly string[] {
  return stubStates.get(page)?.fulfilled ?? [];
}

/** The services this page's spec claimed with handlers of its own. */
export function claimedBoundaryServices(page: Page): readonly BoundaryService[] {
  return [...(specClaims.get(page) ?? [])];
}
