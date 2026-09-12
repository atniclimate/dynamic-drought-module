/**
 * DDM-P2-T08 microtask 1: the failing test for a defect the director
 * already verified line by line (planning/2026-09-01-deep-dive/fixes
 * report for this task carries the citations). Restated here only as much
 * as the test needs:
 *
 * A briefing keys its state-scoped answers off `context.regionKey`
 * (`getCurrentRegion()`) for every selection kind except a state boundary
 * itself carrying its own `STUSPS` (`resolveStateCode`,
 * src/impact/resources.ts:81-92). `getCurrentRegion()` is the CAMERA
 * REGION, seeded once at boot to `washington_state`
 * (src/config/regions.ts:199) and never written by a minimap framing
 * choice (only `selectRegion`, src/ui/sidebar.ts:590, writes it; the
 * framing branch at :726-741 moves the camera and stops there). So a
 * click that lands on a real Alaska place while the camera has FLOWN to
 * Alaska (a `framing=` deep link, exactly the route this file drives)
 * still carries `regionKey: 'washington_state'`, and every non-state-kind
 * selection inherits Washington's answers regardless of where the place
 * actually is:
 *
 *   - the DSCI trend (src/impact/sources.ts:609-620, via
 *     `contextStateFips`/`contextStateName`) reads Washington's series
 *     and prints "for Washington";
 *   - the federal drought.gov anchor (src/impact/resources.ts:162-173)
 *     links Washington's page and labels it "Washington state
 *     conditions", never Alaska;
 *   - the water-supply lane (src/impact/water-supply.ts:162-187) treats
 *     the click as inside the NWRFC domain and asks for the Columbia's
 *     BONO3 forecast point, which is nowhere near Alaska.
 *
 * The condition door specifically (src/map/interaction-coordinator.ts:
 * 608-614) compounds this by also discarding the clicked feature's own
 * properties (`properties: null`), but the region-keying defect above is
 * the same for a DIRECT AIANNH or BIA click too: `buildBoundaryContext`
 * (src/impact/context.ts:167-176) sets `regionKey: getCurrentRegion()`
 * on every commit, place-bearing or not, and Census AIANNH / BIA AIAN-LAR
 * properties never carry a `STUSPS` field for `resolveStateCode` to read
 * regardless.
 *
 * DR-090 microtask 5 UPDATE (2026-09-11, this task's fifth and last
 * microtask): the three leaks named above (DSCI, drought.gov, water-supply)
 * were each fixed in turn by the place-before-camera work microtasks 2 to 4
 * landed (`resolveStateCode`, `resolveCanonicalGeography`,
 * `resolveWaterSupplyPoint`; see tests/camera-region-fallbacks.spec.ts). This
 * microtask fixes the ENCLOSING gate those three leaks sit inside:
 * `briefingSourcePolicy`'s `impactLevel` (src/impact/source-policy.ts) used
 * to read `context.regionKey` (the camera) to decide whether drought impact
 * synthesis runs AT ALL; now it reads the resolved PLACE's coverage family
 * (`src/config/place-coverage.ts`). For a genuinely non-PNW place like this
 * file's Alaska fixtures, that family is `ak-hi`, whose impactSynthesis
 * level is `none` in the coverage matrix, so the WHOLE horizon matrix (and
 * the resources it would have routed) now goes to the single honest
 * `impact-capability-unavailable` state instead of ever composing a claim.
 * That supersedes the four LEAK assertions the shared helper below used to
 * make one at a time: once the matrix never renders for this place, none of
 * the four can leak, so the helper now asserts the honest-unavailable state
 * directly, and its former soft per-leak checks are redundant (a Washington
 * word or a BONO3 id cannot appear in a matrix that never rendered).
 *
 * THREE DOORS, in the three cases below, all under one boot recipe: the
 * camera is sent to Alaska with `?framing=alaska-northwest` (a camera-only
 * deep link; see src/state/framing-store.ts's own doc comment), while
 * `region=` is left unset so `selectRegion` seeds the STATE.currentRegion
 * default (`washington_state`) exactly as a bare boot would.
 *
 *   - the condition door: no Tribal boundary layer is active, so a
 *     non-place point-event (a stubbed NWS alert polygon, the same
 *     `point-event` kind `attachConditionDoor` exists for) wins the
 *     click and the door is appended asynchronously, naming the place
 *     "Alaska" from the real bundled state-boundary fallback
 *     (src/state/location-identity.ts's `resolveState`) while still
 *     discarding it internally;
 *   - an AIANNH click: a synthetic legal-AIANNH-shaped fixture placed at
 *     a real Alaska point, clicked directly (a true boundary commit,
 *     door attached synchronously);
 *   - a BIA click: the same, over the BIA AIAN-LAR fixture.
 *
 * The Alaska fixture geometries are hand-authored rectangles the same way
 * `tests/tribal-fixtures.ts` builds the Washington ones (NO-REDISTRIBUTION
 * GUARD: neither resembles a real AIANNH or AIAN-LAR polygon), just moved
 * to real Alaska coordinates and kept local to this file rather than
 * added to the shared fixture module, so no other spec's fixed WA-viewport
 * geometry shifts under it.
 *
 * The clicked point (screen center after the `alaska-northwest` fit) is
 * real-world approximately (61 N, 155.5 W): the framing's own bounds,
 * `[[50, 172], [72, -123]]` (src/config/framings.ts), average to that
 * point once the antimeridian crossing is unwrapped, and it was checked
 * directly against the bundled `public/data/us-states.geojson` Alaska
 * polygon (a Node point-in-polygon run against the real file) to confirm
 * it, and a wide margin around it, resolves honestly to Alaska. The
 * synthetic AIANNH/BIA rectangles below are sized generously around that
 * same point for the same reason `tests/tribal-fixtures.ts` sizes its
 * Washington rectangles to span the whole default viewport: the exact
 * pixel a `fitBounds` lands on is not worth hand-deriving when a big
 * fixture makes it not matter.
 */

import { expect, test, type Page } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import { AIANNH_ROUTE, BIA_ROUTE, routeGeojson } from './tribal-fixtures';

const WWA_QUERY = '/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';

/** A rectangle ring, `[w, s, e, n]` in WGS 84, centered on the real Alaska
 * point this file's cases click. */
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

// Generous margin around (-155.5, 61): comfortably inside mainland Alaska
// (checked against the real bundled boundary file), clear of the Yukon
// border to the east and the antimeridian to the west.
const ALASKA_W = -167;
const ALASKA_S = 55;
const ALASKA_E = -144;
const ALASKA_N = 68;

/** A synthetic legal-AIANNH-shaped fixture over the Alaska rectangle.
 * Deliberately named without the word "Alaska": the geography assertion
 * below must be earned from the briefing's own state-scoped resources,
 * never from an incidental echo of this fixture's own title. */
function syntheticAlaskaAiannhBody(): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 101,
        properties: {
          NAME: 'Synthetic Remote Fixture Area',
          BASENAME: 'Synthetic Remote Fixture',
          AIANNHCC: 'D1',
          AIANNHNS: '90000101',
          MTFCC: 'G2100',
          AREALAND: '1000',
          AREAWATER: '0'
        },
        geometry: {
          type: 'Polygon',
          coordinates: rectRing(ALASKA_W, ALASKA_S, ALASKA_E, ALASKA_N)
        }
      }
    ]
  };
}

/** A synthetic BIA AIAN-LAR-shaped fixture over the same rectangle. */
function syntheticAlaskaBiaBody(): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 111,
        properties: {
          LARID: '99101',
          LARNAME: 'Synthetic Remote Reservation Fixture',
          CLASSIFICATION: 'Fixture Classification',
          GISACRES: 1000,
          REGION: 'Fixture Region'
        },
        geometry: {
          type: 'Polygon',
          coordinates: rectRing(ALASKA_W, ALASKA_S, ALASKA_E, ALASKA_N)
        }
      }
    ]
  };
}

/** An NWS Red Flag Warning polygon over the same rectangle: a `point-event`
 * kind (src/layers/nws-alerts.ts), the highest-ranked interaction target
 * (src/config/interaction-ranks.ts), so it wins the click outright over any
 * boundary and leaves `selection` unset, which is what makes
 * `attachConditionDoor` run. */
function alaskaRedFlagWarning(): unknown {
  const hour = 3_600_000;
  const onset = new Date(Date.now() - hour).toISOString();
  const expiry = new Date(Date.now() + 6 * hour).toISOString();
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          prod_type: 'Red Flag Warning', // vocab-allow: verbatim NWS product name, quoted source data
          onset,
          ends: expiry,
          expiration: expiry,
          wfo: 'AFC'
        },
        geometry: {
          type: 'Polygon',
          coordinates: rectRing(ALASKA_W, ALASKA_S, ALASKA_E, ALASKA_N)
        }
      }
    ]
  };
}

function collection(features: unknown[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

/**
 * The baseline hosts every open briefing reaches regardless of which door
 * opened it (mirrors `stubBaselineBriefingHosts` in
 * tests/briefing-matrix.spec.ts, not importable from there since it is not
 * exported): USDM current polygons, NIFC current perimeters, NWS active
 * alerts, and the Worker proxy. The proxy stub is the one addition this
 * file needs beyond that mirror: it answers the USDM Data Services DSCI
 * call with two real rows (so the DSCI claim actually renders a state
 * name, the surface assertion 1 reads) and lets the water-supply CSV call
 * fall through its default empty-body branch, which is what already
 * produces the honest "no forecast for the BONO3 forecast point" note
 * under the bug (assertion 3's surface) with no special-casing needed.
 */
async function stubBaselineBriefingHosts(page: Page): Promise<void> {
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: collection([])
    })
  );
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: collection([])
    })
  );
  await page.route('https://api.weather.gov/alerts/active?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features: [] })
    })
  );
  await page.route('**/proxy?*', (route) => {
    const upstream = new URL(route.request().url()).searchParams.get('url') ?? '';
    if (upstream.includes('GetDSCI')) {
      // Two real rows, three months apart, so `fetchDsciTrendClaims` finds
      // enough points to render a claim rather than an "unavailable" note:
      // the claim's own text is what must (and, under the bug, does) say
      // "for Washington".
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { mapDate: '2026-06-02', dsci: '120' },
          { mapDate: '2026-08-25', dsci: '150' }
        ])
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

/** Click the map's screen center, retrying until a popup paints. Every case
 * in this file has exactly one registered hit at that point, so one
 * successful click is enough; the retry only absorbs a fixture that has
 * not finished painting yet. */
async function clickMapCenterUntilPopup(page: Page): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const popup = page.locator('.maplibregl-popup-content');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(popup).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

/**
 * DR-090 microtask 5's assertion: the honest, fully-disabled state a
 * genuinely non-PNW place (Alaska here) must show once the impact-synthesis
 * gate reads the PLACE instead of the camera. Kept as one function so the
 * three door cases below read as "open this door" plus one shared judgment.
 *
 * Before this microtask, `impactLevel` read `context.regionKey` (the camera,
 * seeded to `washington_state`, a PNW-family region), so the matrix rendered
 * as ENABLED and each of the four assertions below would have had to catch
 * one leaked Washington-flavored answer at a time (the shape this function
 * had before this microtask; see the module doc comment). After the fix,
 * the resolved place's `ak-hi` family is `none` for impactSynthesis, so the
 * whole horizon matrix and its routed resources never render at all: there
 * is nothing left to leak, and the honest unavailable state is the only
 * thing to check.
 */
async function assertNoWashingtonForAlaska(page: Page): Promise<void> {
  const panel = page.locator('#impact-panel');
  await expect(panel).toBeVisible();

  // The matrix never renders: no per-hazard section exists at all (not
  // "unavailable" cells, an absent section), so no claim, note, or resource
  // link can carry a Washington-flavored answer.
  await expect(panel.locator('.impact-hazard')).toHaveCount(0);
  await expect(
    panel.locator('.impact-resource-link', { hasText: 'Drought.gov' })
  ).toHaveCount(0);

  // The honest unavailable block instead carries the coverage matrix's own
  // ak-hi impactSynthesis note (CAPABILITY_MATRIX['ak-hi'].impactSynthesis.note,
  // src/config/capability-matrix.ts), read through the place, never a
  // Washington-scoped sentence.
  const unavailable = panel.locator('.impact-capability-unavailable');
  await expect(unavailable).toBeVisible();
  await expect(unavailable.locator('.impact-horizon-note')).toHaveText(
    'No briefing support for Alaska or Hawaii.'
  );
  await expect(unavailable).not.toContainText('Washington');
  await expect(panel).not.toContainText('BONO3');
}

test.describe('a briefing for an Alaska place under the default washington_state region', () => {
  test('the condition door: a point-event click over Alaska answers honestly, not with Washington (DR-090)', async ({
    page
  }) => {
    await stubBaselineBriefingHosts(page);
    await page.route(
      (url) => url.pathname.endsWith(WWA_QUERY),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(alaskaRedFlagWarning())
        })
    );
    // No aiannh/bia-reservations layer: `resolveContainingTribal` must find
    // nothing, so `doorSubjectFromIdentity` falls to the state, and the
    // alert (a `point-event`, the top-ranked kind) is the only registered
    // hit at the click point, which is what leaves `selection` unset and
    // routes through `attachConditionDoor`.
    await gotoApp(page, '?framing=alaska-northwest&layers=nws-alerts');
    await waitForLayerSettled(page, 'nws-alerts');

    await clickMapCenterUntilPopup(page);
    const popup = page.locator('.maplibregl-popup-content');
    // The door is appended asynchronously, after the non-place popup has
    // already painted (attachConditionDoor's own doc comment); the title at
    // this point is the alert's own label, not a place, so this waits on
    // the door rather than the popup title.
    const door = popup.locator('[data-ddm-impact-trigger]');
    await expect(door).toBeVisible({ timeout: 10_000 });
    await door.click();

    await assertNoWashingtonForAlaska(page);
  });

  test('an AIANNH click over Alaska answers honestly, not with Washington (DR-090)', async ({ page }) => {
    await stubBaselineBriefingHosts(page);
    await routeGeojson(page, AIANNH_ROUTE, syntheticAlaskaAiannhBody());
    await gotoApp(page, '?framing=alaska-northwest&layers=aiannh');
    await waitForLayerSettled(page, 'aiannh');

    await clickMapCenterUntilPopup(page);
    const popup = page.locator('.maplibregl-popup-content');
    await expect(popup.locator('.popup-title')).toHaveText('Synthetic Remote Fixture Area');
    await popup.locator('[data-ddm-impact-trigger]').click();

    await assertNoWashingtonForAlaska(page);
  });

  test('a BIA click over Alaska answers honestly, not with Washington (DR-090)', async ({ page }) => {
    await stubBaselineBriefingHosts(page);
    await routeGeojson(page, BIA_ROUTE, syntheticAlaskaBiaBody());
    await gotoApp(page, '?framing=alaska-northwest&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    await clickMapCenterUntilPopup(page);
    const popup = page.locator('.maplibregl-popup-content');
    await expect(popup.locator('.popup-title')).toHaveText('Synthetic Remote Reservation Fixture');
    await popup.locator('[data-ddm-impact-trigger]').click();

    await assertNoWashingtonForAlaska(page);
  });
});
