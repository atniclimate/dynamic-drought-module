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
 * ROUTE OWNERSHIP (DDM-P1-T08, revised 2026-08-29 for the retention flip).
 * The suite-wide stub is registered on the browser CONTEXT, not on the Page.
 * That buys two things at once.
 *
 * First, COVERAGE. A `page.route` handler governs one Page. A popup, a
 * `window.open`, a `target="_blank"`, or an explicit `context.newPage()`
 * produces a Page the boot never routed, and a request from it would reach
 * the agency. A `context.route` handler governs every Page in the context,
 * including ones created after it was installed. Nothing in this suite opens
 * a second Page today and `tests/boundary-boot-inventory.test.mjs` fails the
 * gate on the first one that does, but the routing no longer depends on that
 * inventory being exhaustive.
 *
 * Second, ORDERING, for free. Playwright checks Page routes BEFORE context
 * routes, so a spec's own handler always wins over the suite-wide stub
 * whatever order the two were registered in. That replaces the claim-and-
 * fallback bookkeeping this module used to carry: `routeBoundary` no longer
 * needs to record ownership for the stub to defer, because Playwright's own
 * precedence rule already defers.
 *
 * The context handler is therefore FAIL-CLOSED: it fulfills from the fixture
 * unconditionally. It never calls `route.fallback()`, because a fallback from
 * the last context handler goes to the network. The one way to reach a live
 * agency is `installBoundaryStubs(page, 'live')`, and that throws when `CI` is
 * set, so no expression of the escape hatch in any spec, alias, wrapper, or
 * variable can put a live sovereign-geometry body into a CI artifact. The
 * check is at runtime, not in a source scan.
 */

import type { BrowserContext, Page, Route } from '@playwright/test';

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
 *   the browser and reaches the agency. REFUSED WITH A THROW WHEN `CI` IS
 *   SET, so it can never reach a retained public artifact. Its one caller is
 *   the fire3d evidence capture, a local-only visual proof that the real
 *   boundary cartography still draws correctly for the owner's review; that
 *   spec is skipped under `CI` and writes to the gitignored
 *   `fire3d-evidence/`. Routine liveness of the two services is proven
 *   separately by the daily source-health probe
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

interface StubState {
  mode: BoundaryStubMode;
  /** Every request URL the suite-wide stub answered in this context. */
  readonly fulfilled: string[];
}

const stubStates = new WeakMap<BrowserContext, StubState>();

/**
 * Register a spec-owned handler for one boundary service.
 *
 * Every spec route on either service goes through here (directly, or through
 * `routeGeojson`), for two reasons that survive the move to context routing:
 * the pattern is validated, so a typo that would silently match nothing is an
 * immediate throw rather than a live request; and
 * `tests/boundary-boot-inventory.test.mjs` fails the gate on a raw
 * `page.route` against either pattern, which keeps every boundary route in
 * this one reviewed place. The handler is installed on the PAGE, which
 * Playwright checks before the context-level suite stub, so it wins.
 */
export async function routeBoundary(
  page: Page,
  pattern: string,
  handler: (route: Route) => unknown
): Promise<void> {
  if (!SERVICE_BY_PATTERN.has(pattern)) {
    throw new Error(
      `routeBoundary needs AIANNH_ROUTE or BIA_ROUTE, received ${JSON.stringify(pattern)}`
    );
  }
  await page.route(pattern, handler);
}

/**
 * Fulfill a route pattern with a GeoJSON body. A boundary pattern goes
 * through `routeBoundary` so the claim is recorded; any other pattern (the
 * quick-view sources in `hazard-rail.spec.ts`, for instance) is an ordinary
 * route with nothing to claim.
 */
export async function routeGeojson(page: Page, pattern: string, body: unknown): Promise<void> {
  const fulfill = (route: Route): unknown =>
    route.fulfill({
      contentType: 'application/geo+json',
      body: JSON.stringify(body)
    });
  if (SERVICE_BY_PATTERN.has(pattern)) {
    await routeBoundary(page, pattern, fulfill);
    return;
  }
  await page.route(pattern, fulfill);
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
 * Install the suite-wide boundary stub on this page's browser CONTEXT.
 * Idempotent per context: a second call only updates the mode, so a spec that
 * boots twice keeps one handler pair and one fulfilled-request log, and a
 * second Page in the same context is covered by the handlers already there.
 *
 * ALWAYS ON, locally and in CI (DDM-P1-T08). The alternative, stubbing only
 * under `CI`, would make a local green and a CI green mean different things,
 * which is exactly the class of divergence the build-identity stamp exists to
 * prevent. One code path, one meaning.
 *
 * `live` is refused outright when `CI` is set. That is the runtime half of
 * the escape-hatch ban: `tests/boundary-boot-inventory.test.mjs` greps the
 * source for the literal option, which an alias or a computed value could
 * slip past, but nothing can slip past this throw. The local exception it
 * protects is the fire3d evidence capture, which renders real boundary
 * cartography for the owner's visual review and is skipped under `CI`.
 */
export async function installBoundaryStubs(
  page: Page,
  mode: BoundaryStubMode = 'fixture'
): Promise<void> {
  if (mode === 'live' && process.env['CI']) {
    throw new Error(
      "boundaries: 'live' is refused under CI: a live AIANNH or BIA response body " +
        'must never reach a retained CI artifact on this public repository ' +
        '(hard rule 1; see the NON-REDISTRIBUTION GUARD in src/layers/aiannh.ts)'
    );
  }
  const context = page.context();
  const existing = stubStates.get(context);
  if (existing) {
    existing.mode = mode;
    return;
  }
  const state: StubState = { mode, fulfilled: [] };
  stubStates.set(context, state);
  for (const service of BOUNDARY_SERVICES) {
    await context.route(BOUNDARY_PATTERNS[service], async (route) => {
      // FAIL-CLOSED. The only path that reaches the agency is the explicit
      // `live` mode, which cannot be selected under CI. Every other request
      // is answered here, including one from a Page this suite never routed:
      // a context handler is the last handler, so falling back would put the
      // request on the wire.
      if (state.mode === 'live') {
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
 * Every boundary request the suite-wide stub answered in this page's context.
 * The proof spec (`tests/boundary-stubs.spec.ts`) compares it against the
 * page's own request stream, so a URL that the glob patterns miss reads as an
 * escape rather than passing unnoticed.
 */
export function boundaryStubLog(page: Page): readonly string[] {
  return stubStates.get(page.context())?.fulfilled ?? [];
}
