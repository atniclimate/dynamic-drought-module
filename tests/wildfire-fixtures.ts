/**
 * Deterministic stubs for the wildfire cluster's live upstreams.
 *
 * The Fire view reads four services at activation: NIFC WFIGS perimeters,
 * NOAA HMS smoke, SPC fire weather, and (when the 3D power context is on)
 * the live EIA plant points. Any spec that drives the Fire view end to end
 * needs all four pinned, or the assertions become a report on today's fire
 * season rather than on the application.
 *
 * These payloads were factored out of `tests/fire3d-mode.spec.ts` so the
 * view-contract matrix (tests/view-contracts.spec.ts) drives the same
 * hermetic world rather than a second, silently drifting copy. The values
 * are load-bearing for both callers: `fire3d-mode.spec.ts` asserts the
 * plant reporting period, and the smoke density classes map to the three
 * stylized volume heights.
 */

import type { BrowserContext, Page, Route } from '@playwright/test';

export async function stubSceneBasemap(page: Page): Promise<void> {
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      )
    })
  );
}

/** A small axis-aligned polygon seated in the PNW envelope. */
export const PNW_POLYGON = (west: number, south: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [west, south],
      [west + 0.6, south],
      [west + 0.6, south + 0.45],
      [west, south + 0.45],
      [west, south]
    ]
  ]
});

export const NIFC_STUB = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        attr_IncidentTypeCategory: 'WF',
        poly_IncidentName: 'Synthetic Ridge',
        // DDM-P14-T07: the minimap's declared count filter
        // (`MINIMAP_ACTIVE_WILDFIRE_FILTER`/`MINIMAP_WILDFIRE_WHERE`) is
        // `attr_ActiveFireCandidate = 1`; both stub features are active so
        // the briefing's and the minimap's collection-read fast paths have
        // something real to count (the briefing's own rule counts every
        // type regardless of this field; see nifc-query-scope.spec.ts's
        // case-local addition of an inactive Prescribed-fire feature for
        // that proof).
        attr_ActiveFireCandidate: 1
      },
      geometry: PNW_POLYGON(-121.4, 44.6)
    },
    {
      type: 'Feature',
      properties: {
        attr_IncidentTypeCategory: 'WF',
        poly_IncidentName: 'Synthetic Butte',
        attr_ActiveFireCandidate: 1
      },
      geometry: PNW_POLYGON(-119.9, 46.1)
    }
  ]
};

export const HMS_STUB = {
  type: 'FeatureCollection',
  features: (
    [
      ['Light', -122.4, 44.2],
      ['Medium', -120.9, 45.2],
      ['Heavy', -119.4, 46.4]
    ] as const
  ).map(([density, west, south]) => ({
    type: 'Feature',
    properties: {
      Density: density,
      Satellite: 'GOES-WEST',
      Start: '2026230 1200',
      End_: '2026230 1800'
    },
    geometry: PNW_POLYGON(west, south)
  }))
};

export const PLANTS_STUB_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        Plant_Name: 'Synthetic Falls',
        PrimSource: 'hydroelectric',
        Total_MW: 24,
        Utility_Na: 'Synthetic Power',
        Period: '202502'
      },
      geometry: { type: 'Point', coordinates: [-120.5, 45.0] }
    }
  ]
};

/** Route every live wildfire-cluster upstream to a fixed payload. */
export async function stubWildfireFeeds(page: Page): Promise<void> {
  const fulfillJson = (route: Route, body: unknown): Promise<void> =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(body)
    });
  await page.route(
    (url) => url.href.includes('WFIGS_Interagency_Perimeters_Current'),
    (route) => fulfillJson(route, NIFC_STUB)
  );
  await page.route(
    (url) => url.href.includes('NOAA_Satellite_Smoke_Detection'),
    (route) => fulfillJson(route, HMS_STUB)
  );
  await page.route(
    (url) => url.href.includes('SPC_firewx'),
    (route) => fulfillJson(route, { type: 'FeatureCollection', features: [] })
  );
  // The 3D power context's live EIA plants read stays hermetic in tests.
  await page.route(
    (url) => url.href.includes('Power_Plants_in_the_US'),
    (route) => fulfillJson(route, PLANTS_STUB_FC)
  );
}

// ---------------------------------------------------------------------------
// The suite-wide WFIGS default (DDM-P10-T13, S30D D1 item J12)
// ---------------------------------------------------------------------------

/** How a `gotoApp` boot answers the NIFC WFIGS current-perimeters service. */
export type NifcStubMode = 'fixture' | 'live';

/** The name every WFIGS current-perimeters URL the app builds carries (`URLS.nifcFires`). */
const NIFC_SERVICE_NAME = 'WFIGS_Interagency_Perimeters_Current';

/**
 * True for a request to the WFIGS current-perimeters service, and for no
 * other service of the same ArcGIS organisation (the RAWS registry and the
 * perimeter history share its host, so a host match would be too wide).
 */
export function isNifcRequestUrl(url: string): boolean {
  return url.includes(`/${NIFC_SERVICE_NAME}/`);
}

/** What the default stub served for one WFIGS request. */
export type NifcStubAnswer = 'features' | 'count' | 'rejected';

/** One WFIGS request the default stub answered. */
export interface NifcStubEntry {
  readonly method: string;
  readonly url: string;
  readonly answer: NifcStubAnswer;
}

interface NifcStubState {
  mode: NifcStubMode;
  /** Every WFIGS request the default stub answered in this context, in order. */
  readonly fulfilled: NifcStubEntry[];
}

const nifcStubStates = new WeakMap<BrowserContext, NifcStubState>();

/**
 * Sort one WFIGS request into the three kinds the app issues, or none.
 *
 * - `features`: a GET `/query?...f=geojson`. The perimeter layer's
 *   viewport read (src/layers/nifc-fires.ts `buildQueryUrl`) and the
 *   briefing's bounded area read (src/impact/sources.ts `fetchNifcClaims`)
 *   both have this shape; both are answered with `NIFC_STUB`, so a briefing
 *   reads the same two synthetic perimeters whether it took the layer's
 *   loaded-collection fast path or its own request.
 * - `count`: a POST `/query` whose form body asks `returnCountOnly=true`,
 *   the minimap's per-framing count (src/state/minimap-wildfire.ts
 *   `buildMinimapWildfireQueryBody`), answered `{ count: 0 }`: a SUCCESSFUL
 *   zero (DR-041 b), not an unavailable read.
 * - `rejected`: anything else, which the app does not issue today.
 */
function classifyNifcRequest(route: Route): NifcStubAnswer {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.pathname.endsWith('/query')) return 'rejected';
  if (request.method() === 'GET' && url.searchParams.get('f') === 'geojson') {
    return 'features';
  }
  if (request.method() === 'POST') {
    const form = new URLSearchParams(request.postData() ?? '');
    if (form.get('returnCountOnly') === 'true') return 'count';
  }
  return 'rejected';
}

/**
 * Route the NIFC WFIGS current-perimeters service on the browser CONTEXT,
 * the suite-wide default `gotoApp` installs on every boot (J12). Since the
 * national region became the default camera (60c3a66), a Wildfire boot with
 * no WFIGS route of its own asked the live service for every current
 * perimeter in the contiguous United States, and the boot-idle seam waited
 * on that payload.
 *
 * Why the CONTEXT, for the same reasons as the NADM default in
 * `tests/helpers.ts` and `installBoundaryStubs` in `tests/tribal-fixtures.ts`:
 * a context handler covers a Page this suite never routed by hand, and
 * Playwright checks Page routes before Context routes, so a spec that
 * registers its own `page.route` for WFIGS (`stubWildfireFeeds` above, a
 * held request, a failure status, a per-framing count) wins over this
 * backstop whatever order the two were registered in. One consequence to
 * know: a page route that calls `route.fallback()` for a WFIGS request used
 * to put that request on the wire when no earlier page route claimed it;
 * it now reaches this stub instead. (`route.continue()` still goes straight
 * to the network.)
 *
 * `fixture` is FAIL-CLOSED: every WFIGS request is answered here and never
 * reaches the network. The three kinds are in `classifyNifcRequest`; an
 * unrecognised WFIGS request gets a 400 ArcGIS-style error envelope,
 * `Unknown test WFIGS request`, rather than a live answer. Every answered
 * request is appended to the log `nifcStubLog` reads.
 *
 * `live` is the explicit opt-out: the same context route stays installed
 * and passes every request through (`route.fallback()`), so it reaches a
 * context route the spec registered earlier or, unrouted, the live
 * service. `tests/mode-switch-cost.spec.ts` opts out, because its recorded
 * baseline measured the live WFIGS reads.
 *
 * Idempotent per context: a second call only updates the mode, so a spec
 * that boots twice keeps one handler and one log.
 */
export async function installDefaultNifcStub(page: Page, mode: NifcStubMode): Promise<void> {
  const context = page.context();
  const existing = nifcStubStates.get(context);
  if (existing) {
    existing.mode = mode;
    return;
  }
  const state: NifcStubState = { mode, fulfilled: [] };
  nifcStubStates.set(context, state);
  await context.route(
    (url) => isNifcRequestUrl(url.href),
    async (route) => {
      if (state.mode === 'live') {
        await route.fallback();
        return;
      }
      const answer = classifyNifcRequest(route);
      state.fulfilled.push({
        method: route.request().method(),
        url: route.request().url(),
        answer
      });
      if (answer === 'features') {
        await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(NIFC_STUB)
        });
        return;
      }
      if (answer === 'count') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: 0 })
        });
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 400, message: 'Unknown test WFIGS request' } })
      });
    }
  );
}

/**
 * Every WFIGS request the suite-wide default answered in this page's
 * context, in order. The proof in `tests/boundary-stubs.spec.ts` compares it
 * with the page's own request stream, request by request (every minimap
 * count POST shares one URL, so a set of URLs would let one answered POST
 * hide an escaped one).
 */
export function nifcStubLog(page: Page): readonly NifcStubEntry[] {
  return nifcStubStates.get(page.context())?.fulfilled ?? [];
}

/**
 * Stub the deep terrain archive host (DR-083; the R2-backed Worker at
 * `URLS.terrainPmtilesDeep`, src/config/urls.ts) as unreachable, so a case
 * that boots the 3D Fire scene falls back to the bundled archive the
 * preview server already serves with byte ranges, deterministically and
 * offline, instead of streaming a real 6+ MB archive from Cloudflare.
 * `resolveFire3DTerrainUrl` (src/map/fire3d.ts) probes this host FIRST and
 * falls back silently on ANY probe failure, so a 404 here is the same
 * honest "no deep archive published" case the fallback ladder already
 * handles, not a new failure mode; `probeArchiveHeader` throws on a
 * non-`ok` response (src/util/pmtiles-probe.ts), so the fallback triggers
 * immediately rather than after a timeout.
 *
 * The Worker went LIVE on 2026-09-10: before that, every browser case
 * booting the scene got this fallback for free (the archive did not exist
 * yet to answer), which is why no case needed this stub until now. A case
 * that omits it now streams the real archive from Cloudflare instead,
 * which is slower, non-hermetic, and was the direct cause of an
 * intermittent failure in the RAWS station marker case (recorded
 * 2026-09-10/11): it also masks a corrupted BUNDLED archive fixture,
 * because the deep archive is tried first and would resolve successfully
 * over it.
 *
 * A handful of NODE-level cases in fire3d-mode.spec.ts model this host
 * directly (`stubDeepTerrainFetch`, answering with a real or deliberately
 * truncated header) to prove the depth-disclosure and probe-hardening
 * behavior; this is their browser-level opposite number, for every case
 * that only needs the scene to boot fast, offline, and on the bundled
 * archive.
 */
export async function stubDeepTerrainArchive(page: Page): Promise<void> {
  await page.route(
    '**/ddm-terrain.atniclimate.workers.dev/**',
    (route) => route.fulfill({ status: 404, body: 'not found' })
  );
}
