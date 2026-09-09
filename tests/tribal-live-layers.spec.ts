import { test, expect, type Page } from '@playwright/test';
import {
  PILL,
  gotoApp,
  layerCheckbox,
  layerPill,
  selectRegion,
  urlLayers,
  waitForLayerSettled
} from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  routeBoundary,
  routeGeojson,
  syntheticAiannhBody,
  syntheticBiaBody,
  emptyCollectionBody,
  arcgisErrorBody
} from './tribal-fixtures';
import {
  RAWS_ROUTE,
  RAWS_FIXTURE_MARKER_ID,
  RAWS_FIXTURE_OBSERVED_MS,
  RAWS_MALFORMED_BODY,
  rawsAffirmativeNullBody,
  rawsHappyBody,
  rawsNullWindBody,
  rawsPeakOnlyWindBody
} from './fixtures/raws-fixtures';

/**
 * Unit G: the deterministic backbone for the live Tribal-geography layers
 * (D-0.7.0-033; design Unit G). Every case runs against synthetic
 * route-intercepted fixtures (tests/tribal-fixtures.ts): no real polygon
 * ever enters the repository, and no case depends on a live agency being
 * up. Since DDM-P1-T08 the HAPPY fixture is the suite-wide default that
 * `gotoApp` installs on every boot, so a case that wants the happy bodies
 * declares nothing; a case that wants an empty, aborted, malformed, or
 * geography-keyed response claims the service with `routeBoundary` and the
 * suite-wide stub defers to it. Covered here: boot success, the honest live-zero state, network
 * failure (the deterministic abort stands in for the 15-second budget
 * timeout: both reject into the same layer catch branch, and a literally
 * hung route would cost 15+ suite seconds without covering a different
 * decision), malformed-body handling, EVERY AIANNHCC subtype label
 * including the unknown-code fallback and the never-a-jurisdiction-claim
 * guard, region-change refresh with applied data, URL and embed reloads
 * settled to live pills, the double-draw, and the legacy `?layers=tribal`
 * landing. The umbrella button behavior lives in tests/umbrella.spec.ts
 * (Unit F). The Unit A identity-precedence acceptance is deliberately NOT
 * a Playwright case; see the scope note above the region-change test.
 */

/** The USDM current-conditions query (default-on but not under test here);
 * aborted deterministically so the boot case never touches a live agency. */
const USDM_ROUTE = '**/USDM_current/FeatureServer/0/query*';

/** A single-feature AIANNH body whose polygon covers the viewport center. */
function aiannhSingleFeature(props: Record<string, unknown>): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 1,
        properties: props,
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-123.5, 46.0],
              [-118.0, 46.0],
              [-118.0, 48.6],
              [-123.5, 48.6],
              [-123.5, 46.0]
            ]
          ]
        }
      }
    ]
  };
}

/**
 * A deliberately broad synthetic rectangle covering both the Washington and
 * Columbia and Snake River Basin viewport centers. It makes prior-viewport
 * contamination observable after a refresh failure: if the old source data
 * survives, a center click still opens its popup.
 */
function refreshContaminationBody(
  properties: Record<string, unknown>,
  id: number
): unknown {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id,
        properties,
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-127.0, 45.0],
              [-110.0, 45.0],
              [-110.0, 51.0],
              [-127.0, 51.0],
              [-127.0, 45.0]
            ]
          ]
        }
      }
    ]
  };
}

/** Click the map center until the popup content appears (retry pattern). */
async function clickMapForPopup(page: Page): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const popup = page.locator('.maplibregl-popup-content');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(popup).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

/** Click the map center and prove no stale boundary remains clickable. */
async function expectNoPopupAtMapCenter(page: Page): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(750);
  await expect(page.locator('.maplibregl-popup-content')).toHaveCount(0);
}

/** The three exact AIANNH popup descriptions, copied verbatim from
 * `buildAiannhPopupHtml` (src/ui/popups.ts) so a paraphrase cannot pass.
 * D-0.7.0-059 (research 4c, maintainer-approved): the Oklahoma Tribal
 * Statistical Area (D6) branch carries its own McGirt-aware wording, and
 * every branch ends with the absence-is-not-absence line. */
const AIANNH_LEGAL_DESCRIPTION =
  "This is a US Census Bureau representation of Tribal land (vintage January 1, 2025), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for general spatial reference. It is a representation, not a definitive depiction of Tribal jurisdiction; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.";
const AIANNH_STATISTICAL_DESCRIPTION =
  "This is a US Census Bureau statistical geography (vintage January 1, 2025), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module, for tabulation and general spatial reference. A statistical area is not a reservation, not trust land, and not a depiction of Tribal jurisdiction or land ownership; Tribal sovereignty and a Tribe's own understanding of its territory are matters of sovereign authority. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.";
const AIANNH_OTSA_DESCRIPTION =
  "This boundary is the US Census Bureau's statistical delineation (vintage January 1, 2025) of a reservation as it existed before Oklahoma statehood (1907), requested live from the Census TIGERweb service when the layer needs it, held only in this browser session's memory, and not bundled by this module. 'Statistical area' describes the Census dataset, not the land's status: in McGirt v. Oklahoma (2020) and later rulings, courts affirmed that several of these reservations were never disestablished and remain Indian country. Boundaries and legal status are matters of each Nation's sovereign authority; consult the Nation for any authoritative statement. No federal dataset maps every Tribal Nation; absence from this layer is not absence of a Nation or of its rights.";

/** Every user-visible AIANNHCC branch of `resolveAiannhSubtype`
 * (src/ui/popups.ts), including the unknown-code fallback. */
const SUBTYPE_CASES = [
  { code: 'D1', label: 'Federal reservation', legal: true },
  { code: 'D2', label: 'Federal reservation', legal: true },
  { code: 'D3', label: 'Off-reservation trust land', legal: true },
  { code: 'D4', label: 'State-recognized reservation', legal: true },
  { code: 'D6', label: 'Oklahoma Tribal Statistical Area (statistical)', legal: false },
  { code: 'D0', label: 'Tribal joint-use area (statistical)', legal: false },
  { code: 'E1', label: 'Alaska Native Village Statistical Area (statistical)', legal: false },
  { code: 'F1', label: 'Hawaiian Home Land', legal: true },
  { code: 'Z9', label: 'Census AIANNH area', legal: false }
] as const;

test.describe('live Tribal-geography layers: deterministic backbone', () => {
  test('boot success: the default boot settles the two default-on live layers', async ({
    page
  }) => {
    // The remaining live default (USDM) is aborted deterministically: this
    // case is about the Tribal layers and must not ingest a real agency
    // polygon or depend on an upstream being up.
    await page.route(USDM_ROUTE, (route) => route.abort('failed'));
    await gotoApp(page, '?view=console');
    for (const key of ['aiannh', 'bia-reservations'] as const) {
      await waitForLayerSettled(page, key);
      await expect(layerPill(page, key)).toHaveText('live');
    }
  });

  test('the honest live-zero state: an empty response reads as no features, never a placeholder', async ({
    page
  }) => {
    await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
    await routeGeojson(page, BIA_ROUTE, syntheticBiaBody());
    await gotoApp(page, '?view=console&layers=aiannh');
    await waitForLayerSettled(page, 'aiannh');
    await expect(layerPill(page, 'aiannh')).toHaveText(
      'no features returned for this view (Census-defined Tribal areas only)'
    );
  });

  test('a network failure reads unavailable and never enters the share URL', async ({ page }) => {
    await routeBoundary(page, AIANNH_ROUTE, (route) => route.abort('failed'));
    await routeGeojson(page, BIA_ROUTE, syntheticBiaBody());
    await gotoApp(page, '?view=console&layers=aiannh,bia-reservations');
    await waitForLayerSettled(page, 'aiannh');
    await expect(layerPill(page, 'aiannh')).toHaveText('unavailable');
    // The failed layer self-corrects out of the URL; the healthy one stays.
    await expect
      .poll(async () => (await urlLayers(page)).has('aiannh'), { timeout: 25_000 })
      .toBe(false);
    await expect
      .poll(async () => (await urlLayers(page)).has('bia-reservations'), { timeout: 25_000 })
      .toBe(true);
  });

  test('a malformed ArcGIS error body reads unavailable, never renders garbage', async ({
    page
  }) => {
    await routeGeojson(page, AIANNH_ROUTE, arcgisErrorBody());
    await routeGeojson(page, BIA_ROUTE, syntheticBiaBody());
    await gotoApp(page, '?view=console&layers=aiannh');
    await waitForLayerSettled(page, 'aiannh');
    await expect(layerPill(page, 'aiannh')).toHaveText('unavailable');
  });

  for (const subtype of SUBTYPE_CASES) {
    test(`AIANNHCC ${subtype.code} is labeled "${subtype.label}" with the ${
      subtype.legal ? 'legal-representation' : 'statistical'
    } caveat`, async ({ page }) => {
      await routeGeojson(
        page,
        AIANNH_ROUTE,
        aiannhSingleFeature({
          NAME: `Synthetic ${subtype.code} Fixture Area`,
          AIANNHCC: subtype.code,
          AIANNHNS: '90000001'
        })
      );
      await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
      await gotoApp(page, '?view=console&layers=aiannh');
      await waitForLayerSettled(page, 'aiannh');
      await clickMapForPopup(page);

      // Exact field-by-field contract (never fragments on the whole popup):
      // the agency line, the Type line, and the full caveat paragraph, all
      // copied verbatim from src/ui/popups.ts.
      const popup = page.locator('.maplibregl-popup-content');
      await expect(popup.locator('.popup-agency')).toHaveText('US Census Bureau · AIANNH (live)');
      await expect(popup.locator('.popup-treaty-meta')).toHaveText(`Type: ${subtype.label}`);
      await expect(popup.locator('.popup-description')).toHaveText(
        subtype.code === 'D6'
          ? AIANNH_OTSA_DESCRIPTION
          : subtype.legal
            ? AIANNH_LEGAL_DESCRIPTION
            : AIANNH_STATISTICAL_DESCRIPTION
      );
      // The Unit A stewardship guard: no popup field may ever present the
      // feature as the Nation's own data, and a statistical area's only
      // permitted "jurisdiction" text is the explicit NOT-a-depiction caveat.
      await expect(popup).not.toContainText('Nation-owned');
      await expect(popup).not.toContainText('deployer data');
    });
  }

  // Identity precedence is pinned through the Playwright runner's direct,
  // synthetic MapLibre test double in tests/location-identity.spec.ts. No
  // production surface renders `containingTribal` today, and the identity
  // debug handle is development-only while browser cases run the production
  // build, so the pure production-function seam is the observable contract.

  test('a region change refetches AND applies fresh data into the existing source', async ({
    page
  }) => {
    // Geography-keyed fixture: the Washington envelope serves the happy
    // body; the Alaska envelope serves an EMPTY collection. The post-change
    // assertion then proves the refreshed response was APPLIED (the exact
    // live-zero pill), not merely that a request started; a broken setData
    // path cannot stay green.
    await routeBoundary(page, AIANNH_ROUTE, async (route) => {
      const url = new URL(route.request().url());
      const xmin = Number((url.searchParams.get('geometry') ?? '0').split(',')[0]);
      const body = xmin < -130 ? emptyCollectionBody() : syntheticAiannhBody();
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(body)
      });
    });
    await routeGeojson(page, BIA_ROUTE, syntheticBiaBody());
    await gotoApp(page, '?view=console&layers=aiannh');
    await waitForLayerSettled(page, 'aiannh');
    await expect(layerPill(page, 'aiannh')).toHaveText('live');

    // A region change moves the camera far outside the cached envelope; the
    // debounced moveend refresh fetches the Alaska view and setDatas it.
    await selectRegion(page, 'alaska');
    await expect(layerPill(page, 'aiannh')).toHaveText(
      'no features returned for this view (Census-defined Tribal areas only)',
      { timeout: 25_000 }
    );
  });

  test('a refresh failure after a region change reads unavailable and surfaces in the group health', async ({
    page
  }) => {
    // Geography-keyed: the Washington envelope succeeds; the Alaska
    // envelope fails at the network layer, so the REFRESH (not the initial
    // activation) is the failing operation.
    await routeBoundary(page, AIANNH_ROUTE, async (route) => {
      const url = new URL(route.request().url());
      const xmin = Number((url.searchParams.get('geometry') ?? '0').split(',')[0]);
      if (xmin < -130) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(syntheticAiannhBody())
      });
    });
    await routeGeojson(page, BIA_ROUTE, syntheticBiaBody());
    await gotoApp(page, '?view=console&layers=aiannh');
    await waitForLayerSettled(page, 'aiannh');
    await expect(layerPill(page, 'aiannh')).toHaveText('live');

    await selectRegion(page, 'alaska');
    // The failed refresh reports honestly (the rendered data is stale for
    // this view) and the umbrella card's health line names the outage while
    // the intent stays selected (a refresh failure never unchecks).
    await expect(layerPill(page, 'aiannh')).toHaveText('unavailable', { timeout: 25_000 });
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();
    await expect(
      page.locator('[data-layer-group-key="tribal-nations"] .layer-umbrella-count')
    ).toHaveText('1 of 2 selected · 1 unavailable');
  });

  test('an AIANNH refresh failure clears prior-viewport geometry before reporting unavailable', async ({
    page
  }) => {
    let failRefresh = false;
    await routeBoundary(page, AIANNH_ROUTE, async (route) => {
      if (failRefresh) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(
          refreshContaminationBody(
            {
              NAME: 'Synthetic Prior View Census Area',
              AIANNHCC: 'D1',
              AIANNHNS: '90000091'
            },
            91
          )
        )
      });
    });
    await gotoApp(page, '?view=console&layers=aiannh');
    await waitForLayerSettled(page, 'aiannh');
    await expect(layerPill(page, 'aiannh')).toHaveText('live');

    failRefresh = true;
    await selectRegion(page, 'columbia_snake_basin');
    await expect(layerPill(page, 'aiannh')).toHaveText('unavailable', {
      timeout: 25_000
    });
    await expectNoPopupAtMapCenter(page);
  });

  test('a BIA refresh failure clears prior-viewport geometry before reporting unavailable', async ({
    page
  }) => {
    let failRefresh = false;
    await routeBoundary(page, BIA_ROUTE, async (route) => {
      if (failRefresh) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(
          refreshContaminationBody(
            {
              LARID: '99091',
              LARNAME: 'Synthetic Prior View BIA Area',
              CLASSIFICATION: 'Fixture Classification',
              GISACRES: 1000,
              REGION: 'Fixture Region'
            },
            92
          )
        )
      });
    });
    await gotoApp(page, '?view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await expect(layerPill(page, 'bia-reservations')).toHaveText('live');

    failRefresh = true;
    await selectRegion(page, 'columbia_snake_basin');
    await expect(layerPill(page, 'bia-reservations')).toHaveText('unavailable', {
      timeout: 25_000
    });
    await expectNoPopupAtMapCenter(page);
  });

  test('a deep link reloads to the same live layer set, settled live', async ({ page }) => {
    await gotoApp(page, '?view=console&layers=aiannh,bia-reservations');
    await waitForLayerSettled(page, 'aiannh');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();
    await expect(layerCheckbox(page, 'bia-reservations')).toBeChecked();
    for (const key of ['aiannh', 'bia-reservations'] as const) {
      await waitForLayerSettled(page, key);
      await expect(layerPill(page, key)).toHaveText('live');
    }
  });

  test('an embed reload keeps the embed contract with both live layers settled live', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true&layers=aiannh,bia-reservations');
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    // The console-embed island mounts collapsed; the rows are attached but
    // not visible, which the class-based settle and read-only assertions
    // handle.
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();
    await expect(layerCheckbox(page, 'bia-reservations')).toBeChecked();
    for (const key of ['aiannh', 'bia-reservations'] as const) {
      await waitForLayerSettled(page, key);
      await expect(layerPill(page, key)).toHaveText('live');
    }
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return layers.has('aiannh') && layers.has('bia-reservations');
        },
        { timeout: 25_000 }
      )
      .toBe(true);
  });

  test('the double-draw: AIANNH and AIAN-LAR render simultaneously as separate live sources', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=aiannh,bia-reservations');
    await waitForLayerSettled(page, 'aiannh');
    await waitForLayerSettled(page, 'bia-reservations');
    await expect(layerPill(page, 'aiannh')).toHaveText('live');
    await expect(layerPill(page, 'bia-reservations')).toHaveText('live');
    // Production-visible proof of two DISTINCT concurrent sources: each
    // live source contributes its own attribution string at addSource
    // time, and the map-information credits line renders both, never a
    // blended one (owner direction 2026-08-31: the credits live in the
    // question-mark panel; the attribution control is gone).
    await page.locator('#map-info-btn').click();
    const credits = page.locator('#map-info-attribution');
    await expect(credits).toContainText('US Census AIANNH');
    await expect(credits).toContainText('BIA AIAN-LAR');
    await page.keyboard.press('Escape');
  });

  test('legacy ?layers=tribal still lands on the deployer slot, not the live layer', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=tribal');
    await expect(layerCheckbox(page, 'tribal')).toBeChecked();
    await expect(layerCheckbox(page, 'aiannh')).not.toBeChecked();
    // The deployer slot keeps its honest placeholder wording (Unit C).
    await waitForLayerSettled(page, 'tribal');
    await expect(layerPill(page, 'tribal')).toHaveText(
      'no data (see data/README.md)'
    );
  });
});

/**
 * DDM-P9-T05: the RAWS station popup reads the served relative humidity,
 * wind, and fuel moisture, with their units and observation time, or says
 * the station reported none for a field the service affirmatively left
 * null.
 *
 * The station-registry viewport discovery query and the popup's own
 * per-station hydration query (`fetchRawsStationConditions`) hit the same
 * `**\/PublicView_RAWS/**` endpoint and parse the same `f=geojson` shape, so
 * one route stub answers both; case (c) below tells them apart by the
 * per-station query's `StationID=` filter, which the bbox discovery query
 * never sends.
 *
 * Discovery only fires inside the RAWS viewport cap, so every case flies to
 * the curated Ice Harbor Dam station first (mirrors
 * tests/telemetry-raws-gate.spec.ts), which the fixture's coordinates sit
 * inside.
 */
test.describe('DDM-P9-T05: RAWS popup readings', () => {
  /**
   * Flying into the RAWS viewport cap fires EVERY discovery source at once
   * (USGS, NRCS AWDB, NOAA CO-OPS, USBR AgriMet, CoCoRaHS), and the merge
   * that produces the RAWS marker waits on all of them to settle. Aborting
   * the other four (mirrors tests/popup-viewport.spec.ts's DEF-4 cases)
   * keeps this suite's own RAWS assertion independent of those agencies'
   * live latency, never the reason a RAWS-focused case is slow or flaky.
   */
  async function abortOtherDiscoverySources(page: Page): Promise<void> {
    const abort = (route: import('@playwright/test').Route): unknown => route.abort('failed');
    await page.route('**/waterservices.usgs.gov/**', abort);
    await page.route('**/wcc.sc.egov.usda.gov/**', abort);
    await page.route('**/api.tidesandcurrents.noaa.gov/**', abort);
    await page.route('**/mesonet.agron.iastate.edu/**', abort);
    await page.route('**/ddm-proxy.atniclimate.workers.dev/**', abort);
  }

  async function flyToIceHarborDam(page: Page): Promise<void> {
    await abortOtherDiscoverySources(page);
    await gotoApp(page, '?layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    await page.locator('#telemetry-reveal').click();
    await page.locator('.telemetry-item', { hasText: 'Ice Harbor Dam' }).click();
  }

  function rawsMarker(page: Page) {
    return page.locator(`.telemetry-marker[data-telemetry-station-id="${RAWS_FIXTURE_MARKER_ID}"]`);
  }

  test('shows relative humidity, wind, fuel moisture, and the served observation time', async ({
    page
  }) => {
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsHappyBody())
      })
    );

    await flyToIceHarborDam(page);

    const marker = rawsMarker(page);
    await expect(marker).toHaveCount(1, { timeout: 20_000 });

    const popup = page.locator('.maplibregl-popup');
    const humidityRow = popup.locator('.popup-data-row', { hasText: 'Relative humidity' });
    await expect(async () => {
      await marker.click();
      await expect(humidityRow).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    await expect(humidityRow).toContainText('21 %');
    const windRow = popup.locator('.popup-data-row', { hasText: 'Wind' });
    await expect(windRow).toContainText('5 mph from 295 degrees');
    const fuelRow = popup.locator('.popup-data-row', { hasText: 'Fuel moisture' });
    await expect(fuelRow).toContainText('7.3 (unk)');

    // The observation time is the FIXTURE'S served ObservedDate, never the
    // wall clock: the same conversion the runtime uses
    // (src/ui/popups.ts renderRawsRows), so a locale mismatch between the
    // test process and the browser would fail this honestly rather than by
    // coincidence.
    const expectedAsOf = new Date(RAWS_FIXTURE_OBSERVED_MS).toLocaleString();
    const asOfRow = popup.locator('.popup-data-row', { hasText: 'As of' });
    await expect(asOfRow).toContainText(expectedAsOf);
    await expect(asOfRow).toContainText('NIFC RAWS');
  });

  test('a field the service affirmatively reports as null reads "Station reported none", the others stay real', async ({
    page
  }) => {
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsAffirmativeNullBody())
      })
    );

    await flyToIceHarborDam(page);

    const marker = rawsMarker(page);
    await expect(marker).toHaveCount(1, { timeout: 20_000 });

    const popup = page.locator('.maplibregl-popup');
    const fuelRow = popup.locator('.popup-data-row', { hasText: 'Fuel moisture' });
    await expect(async () => {
      await marker.click();
      await expect(fuelRow).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    await expect(fuelRow).toContainText('Station reported none');
    const humidityRow = popup.locator('.popup-data-row', { hasText: 'Relative humidity' });
    await expect(humidityRow).toContainText('94 %');
    const windRow = popup.locator('.popup-data-row', { hasText: 'Wind' });
    await expect(windRow).toContainText('0 mph');
  });

  test('a transport failure leaves the slot unavailable, never "reported none"', async ({
    page
  }) => {
    // The bbox discovery query (`where=1=1`) always gets the happy fixture
    // so the marker renders; only the per-station hydration query (its
    // `where` names the StationID) fails, isolating the popup's own live
    // read from the marker's own honest discovery-time value.
    await page.route(RAWS_ROUTE, (route) => {
      // `StationID` also names an OUTPUT field on the bbox discovery query
      // (`outFields=...StationID...`), so the discriminator has to be the
      // `where` clause specifically, which only the per-station hydration
      // query sets to a `StationID=` filter.
      const where = new URL(route.request().url()).searchParams.get('where') ?? '';
      if (where.startsWith('StationID=')) {
        return route.fulfill({ status: 500, contentType: 'text/plain', body: 'synthetic failure' });
      }
      return route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsHappyBody())
      });
    });

    await flyToIceHarborDam(page);

    const marker = rawsMarker(page);
    await expect(marker).toHaveCount(1, { timeout: 20_000 });

    const popup = page.locator('.maplibregl-popup');
    await expect(async () => {
      await marker.click();
      await expect(popup.locator('.popup-data-error')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    await expect(popup).not.toContainText('Station reported none');
  });

  test('a malformed body leaves the slot unavailable, never "reported none"', async ({ page }) => {
    await page.route(RAWS_ROUTE, (route) => {
      // See the transport-failure case above: `StationID` also names an
      // output field on the bbox discovery query, so the discriminator is
      // the `where` clause, not a plain URL substring match.
      const where = new URL(route.request().url()).searchParams.get('where') ?? '';
      if (where.startsWith('StationID=')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: RAWS_MALFORMED_BODY
        });
      }
      return route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsHappyBody())
      });
    });

    await flyToIceHarborDam(page);

    const marker = rawsMarker(page);
    await expect(marker).toHaveCount(1, { timeout: 20_000 });

    const popup = page.locator('.maplibregl-popup');
    await expect(async () => {
      await marker.click();
      await expect(popup.locator('.popup-data-error')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    await expect(popup).not.toContainText('Station reported none');
  });
});

/**
 * DDM-P9-T06: the RAWS marker carries a wind symbol built from the SAME
 * discovery response DDM-P9-T05 already reads (no second fetch: the bbox
 * query's WindSpeedMPH/WindDirDegrees already ride in `RAWS_OUT_FIELDS`).
 * The helpers below intentionally mirror the DDM-P9-T05 describe block's own
 * (module-private) helpers rather than importing them, so this task's tests
 * touch no line of that block.
 */
test.describe('DDM-P9-T06: RAWS wind symbol', () => {
  async function abortOtherDiscoverySources(page: Page): Promise<void> {
    const abort = (route: import('@playwright/test').Route): unknown => route.abort('failed');
    await page.route('**/waterservices.usgs.gov/**', abort);
    await page.route('**/wcc.sc.egov.usda.gov/**', abort);
    await page.route('**/api.tidesandcurrents.noaa.gov/**', abort);
    await page.route('**/mesonet.agron.iastate.edu/**', abort);
    await page.route('**/ddm-proxy.atniclimate.workers.dev/**', abort);
  }

  async function flyToIceHarborDam(page: Page): Promise<void> {
    await abortOtherDiscoverySources(page);
    await gotoApp(page, '?layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    await page.locator('#telemetry-reveal').click();
    await page.locator('.telemetry-item', { hasText: 'Ice Harbor Dam' }).click();
  }

  function rawsMarker(page: Page) {
    return page.locator(`.telemetry-marker[data-telemetry-station-id="${RAWS_FIXTURE_MARKER_ID}"]`);
  }

  function windGlyph(page: Page) {
    return rawsMarker(page).locator('svg[data-telemetry-wind-glyph]');
  }

  test('a served wind renders a glyph on the marker whose rotation and label match the served speed, direction, observation time, and issuer', async ({
    page
  }) => {
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsHappyBody())
      })
    );

    await flyToIceHarborDam(page);

    const marker = rawsMarker(page);
    await expect(marker).toHaveCount(1, { timeout: 20_000 });

    const glyph = windGlyph(page);
    await expect(glyph).toHaveCount(1);
    // The fixture serves "5 mph" and "295 degrees " (rawsHappyBody): the
    // glyph's own accessible name carries both served strings verbatim,
    // the issuer, and the observation time, and its rotation is the parsed
    // leading number from the served direction string, never a re-derived
    // value.
    await expect(glyph).toHaveAttribute(
      'aria-label',
      /^Wind 5 mph from 295 degrees \(NIFC RAWS\), observed .+$/
    );
    const expectedAsOf = new Date(RAWS_FIXTURE_OBSERVED_MS).toLocaleString();
    await expect(glyph).toHaveAttribute('aria-label', new RegExp(escapeRegExp(expectedAsOf)));
    const transform = await glyph.evaluate((el) => (el as SVGElement).style.transform);
    expect(transform).toContain('rotate(295deg)');
  });

  test('a null served wind renders no glyph, and the popup Wind row reads "Station reported none"', async ({
    page
  }) => {
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsNullWindBody())
      })
    );

    await flyToIceHarborDam(page);

    const marker = rawsMarker(page);
    await expect(marker).toHaveCount(1, { timeout: 20_000 });
    await expect(windGlyph(page)).toHaveCount(0);

    const popup = page.locator('.maplibregl-popup');
    const windRow = popup.locator('.popup-data-row', { hasText: 'Wind' });
    await expect(async () => {
      await marker.click();
      await expect(windRow).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(windRow).toContainText('Station reported none');
  });

  test('a sustained speed with no sustained direction renders no glyph, and the popup Wind row carries the NWCG peak wording, never "gusting"', async ({
    page
  }) => {
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsPeakOnlyWindBody())
      })
    );

    await flyToIceHarborDam(page);

    const marker = rawsMarker(page);
    await expect(marker).toHaveCount(1, { timeout: 20_000 });
    // No sustained direction served: the symbol's rotation would have
    // nothing honest to draw from, so no glyph, matching the acceptance's
    // "no value is interpolated" clause (a placeholder rotation would be an
    // invented direction).
    await expect(windGlyph(page)).toHaveCount(0);

    const popup = page.locator('.maplibregl-popup');
    const windRow = popup.locator('.popup-data-row', { hasText: 'Wind' });
    await expect(async () => {
      await marker.click();
      await expect(windRow).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(windRow).toContainText('3 mph, peak 11 mph from 212 degrees over the previous 60 minutes');
    await expect(windRow).not.toContainText('gusting');
  });

  test('a transport failure on RAWS discovery renders no marker and no glyph, and the telemetry layer reads live (partial)', async ({
    page
  }) => {
    await abortOtherDiscoverySources(page);
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'synthetic failure' })
    );

    await gotoApp(page, '?layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    await page.locator('#telemetry-reveal').click();
    await page.locator('.telemetry-item', { hasText: 'Ice Harbor Dam' }).click();

    // The discovery source failed non-abort (0.7.0 H4): the layer reads
    // "live (partial)", never a bare "live" and never a structural "error"
    // (the curated seeds, including the Ice Harbor Dam seed itself, still
    // render).
    await expect(layerPill(page, 'telemetry')).toHaveText(PILL.degraded, { timeout: 20_000 });
    await expect(rawsMarker(page)).toHaveCount(0);
    await expect(page.locator('svg[data-telemetry-wind-glyph]')).toHaveCount(0);
  });

  test('no wind glyph exists anywhere except on the one station marker it belongs to (no interpolation between stations)', async ({
    page
  }) => {
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(rawsHappyBody())
      })
    );

    await flyToIceHarborDam(page);

    const marker = rawsMarker(page);
    await expect(marker).toHaveCount(1, { timeout: 20_000 });
    await expect(windGlyph(page)).toHaveCount(1);

    // Every wind glyph anywhere in the document is a descendant of a
    // `.telemetry-marker`: nothing is drawn off a station's own point (no
    // field, no arrow between stations).
    const totalGlyphs = await page.locator('svg[data-telemetry-wind-glyph]').count();
    const glyphsInsideMarkers = await page
      .locator('.telemetry-marker svg[data-telemetry-wind-glyph]')
      .count();
    expect(totalGlyphs).toBeGreaterThan(0);
    expect(glyphsInsideMarkers).toBe(totalGlyphs);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
