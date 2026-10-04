/**
 * The suite-wide NWS WWA default (S30D P2-CI).
 *
 * `cluster=heat` and `layers=nws-alerts` turn the NWS alerts layer on
 * (src/config/clusters.ts, src/config/layers.ts). The layer reads NOAA's WWA
 * `watch_warn_adv` MapServer (`URLS.nwsWwaMapServer`) with a 15 s budget
 * (src/layers/nws-alerts.ts `FETCH_TIMEOUT_MS`) while `gotoApp` waits 10 s for
 * the boot-idle seam, so a slow NOAA answer from a CI runner decided the test:
 * `tests/map-drawers.spec.ts` failed on GitHub with `pending layer keys =
 * ["nws-alerts"]`. Every routine boot now answers that service locally, the
 * same way `installDefaultNadmStub` (tests/helpers.ts) and
 * `installDefaultNifcStub` (tests/wildfire-fixtures.ts) already answer theirs.
 */

import type { BrowserContext, Page } from '@playwright/test';

/** How a `gotoApp` boot answers the NWS WWA watch/warning/advisory MapServer. */
export type NwsWwaStubMode = 'fixture' | 'live';

/**
 * The valid, EMPTY answer of the shape the layer's reader expects
 * (`parseMapPayload` in src/layers/nws-alerts.ts): a `FeatureCollection` with
 * an empty `features` array and no `exceededTransferLimit`. The layer reads it
 * as the legitimate "no active heat or fire-weather alerts" result and
 * reports `no-data`, never an error and never an invented alert.
 */
export const NWS_WWA_EMPTY = {
  type: 'FeatureCollection',
  features: []
} as const;

/**
 * True for a request to the WWA `watch_warn_adv` MapServer, matched on the
 * path alone (the host is the same NOAA mapservices cloud host the SPC fire
 * outlook shares, and the specs that route this service by hand match the
 * path too).
 */
export function isNwsWwaRequestUrl(url: URL): boolean {
  return url.pathname.includes('/WWA/watch_warn_adv/MapServer');
}

/** What the default stub served for one WWA request. */
export type NwsWwaStubAnswer = 'features' | 'rejected';

/** One WWA request the default stub answered. */
export interface NwsWwaStubEntry {
  readonly method: string;
  readonly url: string;
  readonly answer: NwsWwaStubAnswer;
}

interface NwsWwaStubState {
  mode: NwsWwaStubMode;
  /** Every WWA request the default stub answered in this context, in order. */
  readonly fulfilled: NwsWwaStubEntry[];
}

const nwsWwaStubStates = new WeakMap<BrowserContext, NwsWwaStubState>();

/**
 * Sort one WWA request into the one kind the app issues, or none.
 *
 * - `features`: a GET `/MapServer/1/query?...f=geojson`, the only request the
 *   layer makes (src/layers/nws-alerts.ts `buildQueryUrl`).
 * - `rejected`: anything else, which the app does not issue today.
 */
function classifyNwsWwaRequest(method: string, url: URL): NwsWwaStubAnswer {
  if (
    method === 'GET' &&
    url.pathname.endsWith('/MapServer/1/query') &&
    url.searchParams.get('f') === 'geojson'
  ) {
    return 'features';
  }
  return 'rejected';
}

/**
 * Route the NWS WWA MapServer on the browser CONTEXT, the suite-wide default
 * `gotoApp` installs on every boot, for the same reasons as the NADM and NIFC
 * defaults: a context handler covers a Page this suite never routed by hand,
 * and Playwright checks Page routes before Context routes, so a spec that
 * registers its own `page.route` for WWA (a feature body, a delay, a held
 * request, a failure status) wins over this backstop whatever order the two
 * were registered in. A page route that calls `route.fallback()` for a WWA
 * request now reaches this stub rather than the network (`route.continue()`
 * still goes straight to it).
 *
 * `fixture` is FAIL-CLOSED: every WWA request is answered here and never
 * reaches the network. The one kind the app makes is in
 * `classifyNwsWwaRequest`, answered with `NWS_WWA_EMPTY`; an unrecognised WWA
 * request gets a 400 ArcGIS-style error envelope, `Unknown test WWA
 * request`, rather than a live answer. Every answered request is appended to
 * the log `nwsWwaStubLog` reads.
 *
 * `live` is the explicit opt-out: the same context route stays installed and
 * passes every request through (`route.fallback()`), to a context route the
 * spec registered earlier or, unrouted, the live service.
 *
 * Idempotent per context: a second call only updates the mode, so a spec that
 * boots twice keeps one handler and one log.
 */
export async function installDefaultNwsWwaStub(
  page: Page,
  mode: NwsWwaStubMode
): Promise<void> {
  const context = page.context();
  const existing = nwsWwaStubStates.get(context);
  if (existing) {
    existing.mode = mode;
    return;
  }
  const state: NwsWwaStubState = { mode, fulfilled: [] };
  nwsWwaStubStates.set(context, state);
  await context.route(
    (url) => isNwsWwaRequestUrl(url),
    async (route) => {
      if (state.mode === 'live') {
        await route.fallback();
        return;
      }
      const request = route.request();
      const answer = classifyNwsWwaRequest(request.method(), new URL(request.url()));
      state.fulfilled.push({ method: request.method(), url: request.url(), answer });
      if (answer === 'features') {
        await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(NWS_WWA_EMPTY)
        });
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 400, message: 'Unknown test WWA request' } })
      });
    }
  );
}

/** Every WWA request the suite-wide default answered in this page's context, in order. */
export function nwsWwaStubLog(page: Page): readonly NwsWwaStubEntry[] {
  return nwsWwaStubStates.get(page.context())?.fulfilled ?? [];
}
