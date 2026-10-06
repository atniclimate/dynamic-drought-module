import { expect, test, type Page } from './offline-test';

import { LAYER_DEFS, LAYER_ROLE_ORDER } from '../src/config/layers';
import { gotoApp, urlLayers } from './helpers';
import { stubCpcDroughtOutlook } from './cpc-outlook-fixtures';
import { stubWildfireFeeds } from './wildfire-fixtures';
import { stubHeatRiskCatalog } from './helpers';

/**
 * D1 M18 (register keys owner-1c, found-013; CODEMAP 3.3 "Which options
 * exist in each studio"): the coverage gap CODEMAP names is real -- about
 * 18 of the Layer studio's rows and surface exclusivity had no test
 * asserting their effect, and the Place studio's four rail kinds had no
 * test proving a selection actually FRAMES the map (only that selection
 * state itself renders). Every case here is a coverage test: its red-first
 * proof is break-to-prove (disable the one thing the assertion depends on
 * and watch it red), named in each case's own comment.
 */

const STUDIO = '#layers-studio-root';
const PLACE_ROOT = '#place-studio-root';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const EMPTY_FC = { type: 'FeatureCollection', features: [] } as const;

/** The Layer studio's own copy of a role's group heading id (catalog.tsx). */
function studioGroupHeadingId(role: string): string {
  return `studio-layer-group-${role}`;
}

/** A layer-key input SCOPED to the studio (the sidebar's own catalog copy
 * carries the identical `data-layer-key`, so an unscoped locator is a
 * Playwright strict-mode violation while the studio is open). */
function studioCheckbox(page: Page, key: string) {
  return page.locator(STUDIO).locator(`input[data-layer-key="${key}"]`);
}

function studioPill(page: Page, key: string) {
  return page.locator(STUDIO).locator(`[data-layer-status="${key}"]`);
}

const TERMINAL_STATUS_CLASSES = ['ready', 'degraded', 'error', 'no-data', 'zoom-in'];

/** Mirrors `waitForLayerSettled` (tests/helpers.ts) but scoped to the
 * studio's own pill, since the sidebar's copy carries the same attribute. */
async function waitForStudioLayerSettled(page: Page, key: string, timeout = 25_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const cls = (await studioPill(page, key).getAttribute('class')) ?? '';
        const tokens = cls.split(/\s+/);
        return TERMINAL_STATUS_CLASSES.some((status) => tokens.includes(status));
      },
      { message: `studio layer "${key}" never left the loading state`, timeout }
    )
    .toBe(true);
}

async function openTribalNationsDetailsInStudio(page: Page): Promise<void> {
  const toggle = page.locator(STUDIO).locator('[data-layer-group-toggle="tribal-nations"]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
}

/**
 * Answer every live upstream a Layer-studio row can reach, so toggling all
 * 21 rows (LAYER_DEFS minus the two uiHidden deployer slots) never sends a
 * request off this machine (NETWORK, D1 M18 brief).
 */
async function stubEveryStudioLayer(page: Page): Promise<void> {
  // nifc-fires, hms-smoke, spc-fire-weather (empty -> no-data), and the
  // live EIA plant half of power-infrastructure.
  await stubWildfireFeeds(page);
  // drought: the CPC Drought Outlook vector service, both registers.
  await stubCpcDroughtOutlook(page);
  // heatrisk: the NWS HeatRisk ImageServer (metadata, query, identify,
  // exportImage) -- the SAME fixture the map layer's own activation reads.
  await stubHeatRiskCatalog(page);

  // usdm: US Drought Monitor current-conditions FeatureServer.
  await page.route('**/USDM_current/FeatureServer/0/query*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(EMPTY_FC)
    })
  );

  // gridded-index: the NOAA NIDIS gridded drought index tile server (an
  // info.json sidecar plus PNG tiles; src/layers/gridded-index.ts).
  await page.route('**/current-conditions/tile/v1/*/info.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ date: '2026-09-24', tilezmax: '6' })
    })
  );
  await page.route(
    (url) => url.pathname.includes('/current-conditions/tile/v1/') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
  );

  // sst-anomaly: NASA GIBS GHRSST WMTS tiles.
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
  );

  // usfs-whp: the USFS Wildfire Hazard Potential ImageServer, routed
  // through the DDM Worker proxy (src/layers/usfs-whp.ts, buildImageTileTemplate).
  await page.route(
    (url) =>
      url.href.includes('ddm-proxy.atniclimate.workers.dev') &&
      url.href.includes('WildfireHazardPotentialClassified'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
  );

  // nws-alerts: the NOAA NWS watch/warning/advisory MapServer.
  await page.route('**/watch_warn_adv/MapServer/1/query*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(EMPTY_FC)
    })
  );

  // hydrography: the live Overpass API, all three mirrored hosts
  // (src/config/urls.ts overpassMirrors).
  await page.route(
    (url) =>
      url.href.includes('overpass-api.de') ||
      url.href.includes('overpass.kumi.systems') ||
      url.href.includes('overpass.openstreetmap.fr'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ elements: [] })
      })
  );

  // telemetry: activating it hydrates the Water & Snow station VALUES
  // (src/ui/sidebar.ts hydrateStationValues) independently of the layer's
  // own registry status; abort each wired agency deterministically (the
  // honest "values unavailable" fallback) instead of reaching it live.
  for (const pattern of [
    '**/waterservices.usgs.gov/**',
    '**/wcc.sc.egov.usda.gov/**',
    '**/usbr.gov/**',
    '**/cwms-data.usace.army.mil/**'
  ]) {
    await page.route(pattern, (route) => route.abort('failed'));
  }

  // aiannh, bia-reservations and nadm-drought are stubbed by gotoApp's own
  // defaults (installBoundaryStubs, installDefaultNadmStub); nifc-fires is
  // covered twice over (installDefaultNifcStub in gotoApp, stubWildfireFeeds
  // above). cdm-drought, states, places, hillshade, ecoregions and the
  // power-lines half of power-infrastructure read bundled `public/data/*`
  // files served same-origin by the local build, so no live host is ever
  // reached for them. telemetry's OWN registry status needs no stub either:
  // the national default's viewport is far over the discovery area cap
  // (src/config/station-registry.ts), so discoverStationsForViewport
  // returns "zoom-in" before issuing any fetch (the same fact found-013's
  // own case, tests/layers-studio.spec.ts, relies on).
}

test.describe('LAYERS studio: every option exercised (owner-1c)', () => {
  // 2026-09-30, found-100 (Codex landed-diff review F5): the title was
  // narrowed from "... toggles its layer on the map and in layers=" because
  // the case never asserted a map effect. DDM-P10-T08's "on the map or the
  // URL" is met by the layers= assertions below. A map-effect assertion
  // needs a read of MapLibre's style membership, and no existing production
  // seam exposes one (src/main.ts:286-298 guards the map handle with
  // import.meta.env.DEV; src/state/boot-idle.ts:71-89 exposes no map member).
  // An uncheck leg is also not added here: unchecking a member of the
  // committed composition demotes the display to custom
  // (src/state/cluster-service.ts:512-544), which would change every later row.
  test('every LayerDef row in the Layer studio, enumerated from LAYER_DEFS by role, checks its box, enters layers= and settles its status pill', async ({
    page
  }) => {
    test.setTimeout(150_000);
    await stubEveryStudioLayer(page);
    await gotoApp(page, '?view=brief');

    await page.locator('#layers-studio-entry').click();
    await expect(page.locator(STUDIO)).toBeVisible();
    // aiannh and bia-reservations render inside the Tribal Nations umbrella's
    // "Layer details" disclosure (catalog.tsx LayerUmbrella), natively
    // hidden until it opens.
    await openTribalNationsDetailsInStudio(page);

    for (const role of LAYER_ROLE_ORDER) {
      const rows = LAYER_DEFS.filter(
        (def) => def.role === role && def.uiHidden !== true
      );
      for (const def of rows) {
        const checkbox = studioCheckbox(page, def.key);
        if (await checkbox.isChecked()) {
          // A default-on row (aiannh, bia-reservations, nadm-drought,
          // states, hillshade): prove its OWN checkbox -> layers= wiring by
          // cycling it off and back on, rather than trusting boot state.
          await checkbox.uncheck();
          await expect
            .poll(async () => (await urlLayers(page)).has(def.key))
            .toBe(false);
        }
        await checkbox.check();
        await expect(checkbox).toBeChecked();
        await expect
          .poll(async () => (await urlLayers(page)).has(def.key))
          .toBe(true);
        await waitForStudioLayerSettled(page, def.key);
      }
    }
  });

  test('a second surface replaces the first (surface exclusivity)', async ({ page }) => {
    await gotoApp(page, '?view=brief');
    await page.locator('#layers-studio-entry').click();
    await expect(page.locator(STUDIO)).toBeVisible();

    // nadm-drought is default-on; cdm-drought reads a bundled local
    // artifact (public/data/cdm-drought-areas.json), so this swap needs no
    // network stub at all.
    await expect(studioCheckbox(page, 'nadm-drought')).toBeChecked();
    await expect.poll(async () => (await urlLayers(page)).has('nadm-drought')).toBe(true);

    await studioCheckbox(page, 'cdm-drought').check();

    await expect(studioCheckbox(page, 'cdm-drought')).toBeChecked();
    await expect(studioCheckbox(page, 'nadm-drought')).not.toBeChecked();
    await expect.poll(async () => (await urlLayers(page)).has('cdm-drought')).toBe(true);
    await expect.poll(async () => (await urlLayers(page)).has('nadm-drought')).toBe(false);
  });

  test('Layer details and each source group open their content', async ({ page }) => {
    await gotoApp(page, '?view=brief');
    await page.locator('#layers-studio-entry').click();
    const studio = page.locator(STUDIO);
    await expect(studio).toBeVisible();

    const detailsToggle = studio.locator('[data-layer-group-toggle="tribal-nations"]');
    await expect(detailsToggle).toHaveText('Layer details');
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
    const controlsId = await detailsToggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    const controls = studio.locator(`#${controlsId}`);
    await expect(controls).toBeHidden();

    await detailsToggle.click();
    await expect(detailsToggle).toHaveText('Hide layer details');
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(controls).toBeVisible();
    await expect(controls.locator('input[data-layer-key="aiannh"]')).toBeVisible();

    for (const role of LAYER_ROLE_ORDER) {
      const group = studio.locator(
        `.layer-group[aria-labelledby="${studioGroupHeadingId(role)}"]`
      );
      const sourcesToggle = group.locator('.layer-group-sources-toggle');
      await expect(sourcesToggle).toHaveText('Sources');
      await expect(sourcesToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(group.locator('.layer-toggle-source')).toHaveCount(0);

      await sourcesToggle.click();

      await expect(sourcesToggle).toHaveText('Hide sources');
      await expect(sourcesToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(group.locator('.layer-toggle-source').first()).toBeVisible();
    }
  });
});

test.describe('PLACE studio: every rail kind exercised (owner-1c)', () => {
  test('each place rail kind (Tribal Nation, state, ecoregion, watershed) selects a place and frames it', async ({
    page
  }) => {
    test.setTimeout(90_000);

    // Tribal Nations: the roster-first list is selectable with no network
    // fetch at all (place-studio.spec.ts's own 573-entry proof, "the
    // roster-first Tribal Nations list includes geometry-less Nations
    // honestly"). Framing a geometry-backed Nation is covered independently
    // (place-studio-map.spec.ts) and is not re-proven in this pass.
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-tribe').click();
    await page
      .locator('#place-studio-search')
      .fill('Absentee-Shawnee Tribe of Indians of Oklahoma');
    await page.locator('#place-option-tribe-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText(
      'Absentee-Shawnee Tribe of Indians of Oklahoma'
    );

    // Ecoregions: the Pacific Northwest catalog is bundled locally too
    // (public/data/ecoregions-pnw-catalog.json).
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-ecoregion').click();
    await page.locator('#place-studio-search').fill('Western Cascades');
    await page.locator('#place-option-ecoregion-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText(
      'Western Cascades Lowlands and Valleys'
    );

    // States: select, return to the map, and prove the FRAME -- the
    // briefing opens named for the selected place (place-studio.tsx's
    // setPlaceStudioReturnAction wiring; the same mechanism
    // place-studio-brief.spec.ts's own "PS-BRIEF return hand-off" describe
    // block proves for this exact fixture shape).
    await page.route('**/data/us-states.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { STUSPS: 'WA', STATEFP: '53', NAME: 'Washington' },
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [-123, 45],
                    [-117, 45],
                    [-117, 49],
                    [-123, 49],
                    [-123, 45]
                  ]
                ]
              }
            }
          ]
        })
      })
    );
    await page.route('**/USDM_current/FeatureServer/0/query*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(EMPTY_FC)
      })
    );
    await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
      route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify(EMPTY_FC) })
    );
    await page.route('https://api.weather.gov/alerts/active?*', (route) =>
      route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify(EMPTY_FC) })
    );
    await page.route('**/proxy?*', (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' })
    );
    await page.route('**/wbd/MapServer/*/query?*', async (route) => {
      const url = new URL(route.request().url());
      const layer = url.pathname.split('/').at(-2) ?? '';
      // src/config/place-catalog.ts's list query asks for `f=json`
      // (ArcGIS-native `attributes`, no geometry); src/state/watershed-geometry.ts's
      // selection-resolve and overlap-candidate queries ask for `f=geojson`
      // and read `properties`/`geometry` on each feature (assertFeatureCollection,
      // isArealGeometry). One route serves both shapes.
      if (url.searchParams.get('f') === 'geojson') {
        const feature =
          layer === '1'
            ? {
                type: 'Feature',
                properties: {
                  huc2: '17',
                  name: 'Pacific Northwest',
                  areasqkm: 714000,
                  states: 'WA'
                },
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [-124, 45],
                      [-117, 45],
                      [-117, 49],
                      [-124, 49],
                      [-124, 45]
                    ]
                  ]
                }
              }
            : {
                type: 'Feature',
                properties: {
                  huc4: '1703',
                  name: 'Yakima',
                  areasqkm: 15928,
                  states: 'WA'
                },
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [-121, 46],
                      [-120, 46],
                      [-120, 47],
                      [-121, 47],
                      [-121, 46]
                    ]
                  ]
                }
              };
        await route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [feature] })
        });
        return;
      }
      const features =
        layer === '1'
          ? [{ attributes: { huc2: '17', name: 'Pacific Northwest', areasqkm: 714000, states: 'WA' } }]
          : [{ attributes: { huc4: '1703', name: 'Yakima', areasqkm: 15928, states: 'WA' } }];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ features })
      });
    });

    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-state').click();
    await page.locator('#place-studio-search').fill('Washington');
    await page.locator('#place-option-state-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Washington');

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    const statePanel = page.locator('#impact-panel');
    await expect(statePanel).toBeVisible();
    await expect(statePanel.locator('.impact-panel-title')).toHaveText('Washington');

    // Watersheds: the same select-then-frame proof, from a fresh PLACE
    // entry (the WBD stub above already answers both watershed layers).
    await page.locator('#place-studio-entry').click();
    await expect(page.locator(PLACE_ROOT)).toBeVisible();
    await page.locator('#place-type-watershed').click();
    await page.locator('#place-studio-search').fill('Yakima');
    await page.locator('#place-option-watershed-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Yakima (HUC 1703)');

    await page.locator('#place-studio-back').click();
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    const watershedPanel = page.locator('#impact-panel');
    await expect(watershedPanel).toBeVisible();
    await expect(watershedPanel.locator('.impact-panel-title')).toHaveText(
      'Yakima (HUC 1703)'
    );
  });
});
