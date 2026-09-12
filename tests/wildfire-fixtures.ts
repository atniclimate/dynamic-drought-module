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

import type { Page, Route } from '@playwright/test';

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
