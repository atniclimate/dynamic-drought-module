import { test, expect, type Page } from '@playwright/test';

import { gotoApp, layerPill, waitForLayerSettled } from './helpers';
import { BOUNDARY_HOSTS, boundaryStubLog, isBoundaryRequestUrl } from './tribal-fixtures';

/**
 * DDM-P1-T08 acceptance, part one: no boot this suite drives through
 * `gotoApp` issues a request to the Census AIANNH or BIA AIAN-LAR services.
 *
 * SCOPE, stated plainly. This file proves the shells `gotoApp` drives, by
 * observation. It does NOT observe the handful of boots that navigate
 * themselves (a Pages subpath mount, an iframe host page, the island-aborted
 * pre-mount window, a framed studio document, three embed boots that assert
 * zero island requests): those answer from their own
 * `routeAllTribalFixtures` handlers, so their requests never enter the
 * suite-wide stub's log and cannot be checked here.
 * `tests/boundary-boot-inventory.test.mjs` covers them statically, by
 * requiring each to be recorded AND to install a stub of its own. The two
 * files together are the coverage claim; neither is it alone.
 *
 * The proof is a comparison, not a hope. `page.on('request')` records every
 * request the page issued to either host, and `boundaryStubLog` records every
 * request the suite-wide stub in `gotoApp` actually answered
 * (tests/tribal-fixtures.ts). A URL in the first list and not the second is a
 * request the glob patterns missed, which would have left the browser and
 * reached a sovereign-geography service; the assertion names it. A boot that
 * asked for nothing at all is also a failure, because a stub that is never
 * exercised proves nothing.
 *
 * The shells are the distinct `gotoApp` boot paths: the bare Brief door, a
 * hazard-cluster boot, the console, the wildfire cluster inside an embed
 * (which routes to the console door and so does mount the catalog), the brief
 * embed (which never mounts the catalog island, so it has no status pills to
 * read), and the phone viewport. Where the catalog exists, the two boundary
 * pills must reach `live`, which can only happen from the fixture body: a
 * request that escaped to a live agency would be answered by that agency, and
 * a request that was neither stubbed nor answered would settle
 * `unavailable`.
 *
 * Nothing here asserts against live geometry, and nothing here can retain it:
 * the synthetic bodies are hand-authored rectangles with obviously synthetic
 * names (hard rule 1; see the NON-REDISTRIBUTION GUARD in
 * `src/layers/aiannh.ts`).
 */

/** Start recording every request this page makes to either boundary host. */
function watchBoundaryRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (isBoundaryRequestUrl(url)) seen.push(url);
  });
  return seen;
}

/**
 * Every boundary request this page made was answered by the suite-wide stub,
 * and the boot really did make some.
 *
 * The comparison POLLS. `page.on('request')` fires when the request is
 * issued, before the route handler runs and appends to the log, so a
 * debounced viewport refresh that is in flight at assertion time would sit in
 * `seen` and not yet in the log, and a straight comparison would report it as
 * an escape with a very alarming message. Polling lets the log catch up; a
 * request that genuinely left the browser never appears in it at all, so the
 * poll times out and still names the URL.
 */
async function expectNothingEscaped(page: Page, seen: readonly string[]): Promise<void> {
  expect(
    seen.length,
    'this shell asked neither boundary service, so the stub proved nothing'
  ).toBeGreaterThan(0);
  await expect
    .poll(
      () => {
        const answered = new Set(boundaryStubLog(page));
        return seen.filter((url) => !answered.has(url));
      },
      {
        message:
          'these requests were not answered by the suite-wide stub and reached a live sovereign-geography service',
        timeout: 15_000
      }
    )
    .toEqual([]);
  const answered = boundaryStubLog(page);
  for (const host of BOUNDARY_HOSTS) {
    expect(
      answered.some((url) => url.includes(host)),
      `the stub answered nothing for ${host}`
    ).toBe(true);
  }
}

/** Wait until the stub has answered at least one request per host. */
async function waitForBothServices(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        BOUNDARY_HOSTS.every((host) =>
          boundaryStubLog(page).some((url) => url.includes(host))
        ),
      { message: 'the boot never reached both boundary services', timeout: 30_000 }
    )
    .toBe(true);
}

/** The shells that mount the catalog, so their boundary pills are readable. */
const CATALOG_SHELLS = [
  { name: 'the bare Brief door', query: '' },
  { name: 'the wildfire cluster', query: '?cluster=wildfire' },
  { name: 'the console', query: '?view=console' },
  // An embed carrying cluster= routes to the console door (the two-doors
  // rule), so unlike the brief embed below it does mount the catalog.
  { name: 'the wildfire cluster in an embed', query: '?embed=true&cluster=wildfire' }
] as const;

test.describe('every suite boot answers the boundary queries from synthetic fixtures', () => {
  for (const shell of CATALOG_SHELLS) {
    test(`${shell.name}: nothing reaches the live services and both pills read live`, async ({
      page
    }) => {
      const seen = watchBoundaryRequests(page);
      await gotoApp(page, shell.query);

      for (const key of ['aiannh', 'bia-reservations'] as const) {
        await waitForLayerSettled(page, key);
        await expect(layerPill(page, key)).toHaveText('live');
      }
      await expectNothingEscaped(page, seen);
    });
  }

  test('the brief embed: nothing reaches the live services with no catalog island at all', async ({
    page
  }) => {
    const seen = watchBoundaryRequests(page);
    await gotoApp(page, '?embed=true');
    // A brief embed never mounts the island (headroom C1), so there are no
    // status pills; the boundary layers still activate through the shared
    // toggle command, which is what the request stream shows.
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
    await waitForBothServices(page);
    await expectNothingEscaped(page, seen);
  });
});

test.describe('the phone shell answers the boundary queries from synthetic fixtures', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the phone console: nothing reaches the live services and both pills read live', async ({
    page
  }) => {
    const seen = watchBoundaryRequests(page);
    await gotoApp(page, '?view=console');

    for (const key of ['aiannh', 'bia-reservations'] as const) {
      await waitForLayerSettled(page, key);
      await expect(layerPill(page, key)).toHaveText('live');
    }
    await expectNothingEscaped(page, seen);
  });
});

test.describe('the documented escape hatch stays explicit', () => {
  test('boundaries: empty serves the honest live-zero collection, still without a live request', async ({
    page
  }) => {
    const seen = watchBoundaryRequests(page);
    await gotoApp(page, '?view=console', { boundaries: 'empty' });

    for (const key of ['aiannh', 'bia-reservations'] as const) {
      await waitForLayerSettled(page, key);
    }
    await expect(layerPill(page, 'aiannh')).toHaveText(
      'no features returned for this view (Census-defined Tribal areas only)'
    );
    await expect(layerPill(page, 'bia-reservations')).toHaveText(
      'no features returned for this view (AIAN-LAR does not cover every Tribal Nation)'
    );
    await expectNothingEscaped(page, seen);
  });
});
