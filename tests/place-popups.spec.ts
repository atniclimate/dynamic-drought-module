import { test, expect, type Page, type Route } from '@playwright/test';
import { gotoApp, layerCheckbox, waitForLayerSettled } from './helpers';
import { AIANNH_ROUTE, routeGeojson } from './tribal-fixtures';
import { HAZARD_CLUSTERS, type HazardClusterKey } from '../src/config/clusters';
import {
  AIANNH_CAVEATS,
  MAP_ROOT,
  PANEL_ROOT,
  PLACE_FRAME_FIXTURES,
  bootPlace,
  clickCentreUntilFramed,
  expectPlaceFields
} from './frame-fixtures-places';

/**
 * S30D D1 M24 (register owner-1k; DDM-P11-T04; D1.md:145 and :424): the place
 * popups in the browser, through the popup frame.
 *
 *   1. Every briefing door names the place it opens, with ONE label in every
 *      mode; the pulse is decoration, earned only where a mapped wildfire
 *      perimeter touches the place, and the condition's words stand in its
 *      value row (design 3.3, "The door pulse").
 *   2. A fire condition lists its names as list items, never one sentence.
 *   3. Every place builder keeps its named fields in its frame, in both sinks
 *      (the Codex Tier 2 review :213, :224), AIANNH in all three branches.
 *   4. The deployer Tribal popup links nowhere, in both sinks (plan_rules 7).
 *
 * The D1.md:424 case "in ENSO mode with the SST anomaly on, a place popup
 * lists that mode's placeConditionRow" is not built: ENSO's place row moves
 * to the ocean sprint (the owner, 2026-10-01; PLACE_CONDITION_ROW_DEFERRED in
 * src/config/place-condition-rows.ts), and tests/chrome-n-modes.test.mjs
 * holds the deferral to its recorded reason.
 *
 * Offline: every external request is answered 503 by a context route
 * registered before gotoApp, so gotoApp's own context stubs (registered
 * later, checked first) keep their fixtures, and this spec's page routes
 * (checked before both) serve its own synthetic perimeters. No live service
 * decides a result.
 */

async function holdExternalNetwork(page: Page): Promise<void> {
  await page.context().route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

/** A small square, `size` degrees, from its south-west corner. */
function square(west: number, south: number, size: number): unknown {
  return {
    type: 'Polygon',
    coordinates: [[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]]
  };
}

/**
 * Named WFIGS wildfire perimeters that touch the synthetic BIA reservation
 * (tests/tribal-fixtures.ts syntheticBiaBody, -123.5..-118.0 by 46.0..48.6)
 * inside its corners, far from the map centre the click lands on, so the
 * reservation, not a perimeter, wins the click (point-event outranks every
 * boundary; src/ui/popup-conditions.ts). The minimap's count POST falls
 * through to the suite's WFIGS default (tests/wildfire-fixtures.ts).
 */
async function routePerimeters(page: Page, names: readonly string[]): Promise<void> {
  const corners: ReadonlyArray<readonly [number, number]> = [
    [-123.4, 46.05],
    [-118.45, 48.2]
  ];
  const body = {
    type: 'FeatureCollection',
    features: names.map((name, i) => ({
      type: 'Feature',
      id: i + 1,
      properties: { attr_IncidentTypeCategory: 'WF', poly_IncidentName: name, attr_ActiveFireCandidate: 1 },
      geometry: square(corners[i % corners.length]![0], corners[i % corners.length]![1], 0.3)
    }))
  };
  await page.route(
    (url) => url.href.includes('/WFIGS_Interagency_Perimeters_Current/'),
    (route: Route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(body) })
        : route.fallback()
  );
}

const BIA_TITLE = 'Synthetic Reservation Fixture';
const DOOR_FIRE = 'Synthetic Door Fixture Fire';

test.describe('place popups: the briefing door', () => {
  test('every briefing door names the place it opens, with one label in every mode', async ({ page }) => {
    test.setTimeout(240_000);
    await holdExternalNetwork(page);
    await routePerimeters(page, [DOOR_FIRE]);
    // The modes as the shell renders them (DR-113), never a literal list.
    await gotoApp(page, '?region=washington_state&view=console');
    const modes = await page
      .locator('.shell-cluster-btn[data-cluster]')
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-cluster') ?? ''));
    expect(modes.length, 'the shell renders no mode buttons').toBeGreaterThan(0);
    let pulsed = 0;
    for (const mode of modes) {
      await test.step(`${mode} mode`, async () => {
        expect(Object.prototype.hasOwnProperty.call(HAZARD_CLUSTERS, mode), `${mode} is a cluster`).toBe(true);
        const recipe = HAZARD_CLUSTERS[mode as HazardClusterKey].recipes.current;
        await gotoApp(page, '?region=washington_state&view=console');
        const button = page.locator(`.shell-cluster-btn[data-cluster="${mode}"]`);
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        for (const key of [...recipe, 'bia-reservations']) await waitForLayerSettled(page, key);
        // The reservation outranks the other places under the centre once its
        // fill has painted; a response for a place painted earlier is closed
        // and the click retried (the tests/interaction-coordinator.spec.ts
        // clickCenterUntilPrimary pattern).
        await expect(async () => {
          const framed = await clickCentreUntilFramed(page, MAP_ROOT);
          const got = ((await framed.locator('[data-popup-slot="title"]').textContent()) ?? '').trim();
          if (got !== BIA_TITLE) {
            await page.locator('.maplibregl-popup-close-button').click();
            throw new Error(`the primary was "${got}", waiting for "${BIA_TITLE}" to paint`);
          }
        }).toPass({ timeout: 30_000 });
        const root = page.locator(MAP_ROOT);
        const door = root.locator('[data-popup-slot="actions"] [data-ddm-impact-trigger]');
        await expect(door).toHaveCount(1);
        await expect(door).toHaveText(`Open the Impact Briefing for ${BIA_TITLE}`);
        // The pulse is earned only where the mapped wildfire perimeter is read
        // (the mode whose recipe turns the WFIGS layer on): the head names
        // the Wildfire condition, and its words stand in the Wildfire row,
        // first in the body (the owner's present-only head, 2026-10-01).
        const firesOn = recipe.includes('nifc-fires');
        if (firesOn) {
          pulsed += 1;
          await expect(door).toHaveClass(/popup-impact-btn--pulse/);
          await expect(root.locator('[data-popup-region="head"] [data-popup-slot="value"]')).toContainText('Wildfire');
          const wildfire = root.locator('[data-popup-region="body"] [data-popup-slot="conditions"] [data-value-row]', { hasText: 'Wildfire' });
          await expect(wildfire).toHaveCount(1);
          await expect(wildfire.locator('li')).toHaveText([DOOR_FIRE]);
        } else {
          await expect(door).not.toHaveClass(/popup-impact-btn--pulse/);
        }
        // The door opens the briefing for the place it names.
        await door.click();
        await expect(page.locator('#impact-panel')).toBeVisible();
        await expect(page.locator('#impact-panel-title')).toHaveText(BIA_TITLE);
      });
    }
    expect(pulsed, 'no mode turned the WFIGS layer on, so the pulse was never exercised').toBeGreaterThan(0);
  });
});

/** A clean, empty NWS alerts read, so the alerts row is a confirmed zero. */
async function routeEmptyAlerts(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith('/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query'),
    (route: Route) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) })
  );
}

const NOTHING_MAPPED = "Nothing mapped here on the active condition layers; each layer's reading is below.";
const NOT_EVERY_READ = "Not every condition layer has been read here yet; each layer's state is below.";

/**
 * The owner's "Body slot, present-only head" (2026-10-01): the head's value
 * slot is ONE line naming the conditions PRESENT at the place by their row
 * labels; an absence row is never named there, and every row, absences
 * included, stands in full first in the body. With layers on and nothing
 * present the head says DDM's approved line; with no condition layer on it
 * keeps the existing sentence and the body has no conditions slot.
 */
test.describe('place popups: the present-only head', () => {
  async function bootReservation(page: Page, layers: readonly string[]): Promise<ReturnType<Page['locator']>> {
    await gotoApp(page, `?region=washington_state&view=console&layers=${['bia-reservations', ...layers].join(',')}`);
    for (const key of ['bia-reservations', ...layers]) await waitForLayerSettled(page, key);
    return clickCentreUntilFramed(page, MAP_ROOT, 'bia-reservations-fill');
  }

  test('the head names only the conditions present; an absence stays in the body', async ({ page }) => {
    await holdExternalNetwork(page);
    await routePerimeters(page, ['Synthetic Alpha Fire']);
    await routeEmptyAlerts(page);
    const root = await bootReservation(page, ['nws-alerts', 'nifc-fires']);
    await expect(root.locator('[data-popup-region="head"] [data-popup-slot="value"]')).toHaveText('Wildfire');
    const rows = root.locator('[data-popup-region="body"] [data-popup-slot="conditions"] [data-value-row]');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'NWS alert' })).toContainText('No active NWS heat or fire weather');
    await expect(rows.filter({ hasText: 'Wildfire' }).locator('li')).toHaveText(['Synthetic Alpha Fire']);
  });

  test('layers on with nothing present at the place: the head says so and every reading is below', async ({ page }) => {
    await holdExternalNetwork(page);
    await routeEmptyAlerts(page);
    const root = await bootReservation(page, ['nws-alerts']);
    await expect(root.locator('[data-popup-region="head"] [data-popup-slot="value"]')).toHaveText(NOTHING_MAPPED);
    const rows = root.locator('[data-popup-region="body"] [data-popup-slot="conditions"] [data-value-row]');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('No active NWS heat or fire weather');
  });

  test('no condition layer on: the head keeps the existing sentence and the body has no conditions slot', async ({ page }) => {
    await holdExternalNetwork(page);
    const root = await bootReservation(page, []);
    await expect(root.locator('[data-popup-region="head"] [data-popup-slot="value"]')).toHaveText(
      'Conditions No condition layer (drought, NWS alerts, or wildfire perimeters) is currently active on the map.'
    );
    await expect(root.locator('[data-popup-slot="conditions"]')).toHaveCount(0);
  });

  // Read completeness apart from presence (draft DR-179; the Codex review of
  // round 1, B2): a layer switched on whose first read has not arrived has no
  // fill in the style yet, and the card must neither call it "not active" nor
  // say nothing is mapped. The WWA query is held unanswered by a page route
  // (it outranks gotoApp's default NWS stub); the layer is switched on only
  // after the reservation has settled, so the click lands well inside the
  // layer's 15 s fetch budget (src/layers/nws-alerts.ts FETCH_TIMEOUT_MS).
  test('a condition layer still loading with no fill: the head says not every layer has been read, never that none is on', async ({ page }) => {
    await holdExternalNetwork(page);
    const held: Route[] = [];
    await page.route(
      (url) => url.pathname.endsWith('/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query'),
      (route: Route) => {
        held.push(route);
      }
    );
    await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await layerCheckbox(page, 'nws-alerts').check();
    await expect.poll(() => held.length, { message: 'the alerts layer never asked for its first read' }).toBeGreaterThan(0);
    const root = await clickCentreUntilFramed(page, MAP_ROOT, 'bia-reservations-fill');
    await expect(root.locator('[data-popup-region="head"] [data-popup-slot="value"]')).toHaveText(NOT_EVERY_READ);
    const rows = root.locator('[data-popup-region="body"] [data-popup-slot="conditions"] [data-value-row]');
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveText('NWS alert Still loading, so this card cannot say whether one is active in this area.');
  });
});

test.describe('place popups: a fire condition', () => {
  test('a fire condition lists its names as a list', async ({ page }) => {
    await holdExternalNetwork(page);
    await routePerimeters(page, ['Synthetic Alpha Fire', 'Synthetic Bravo Fire']);
    await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations,nifc-fires');
    await waitForLayerSettled(page, 'bia-reservations');
    await waitForLayerSettled(page, 'nifc-fires');
    const root = await clickCentreUntilFramed(page, MAP_ROOT);
    await expect(root.locator('[data-popup-slot="title"]')).toHaveText(BIA_TITLE);
    // The head names the condition once; the row with its names is in the body.
    await expect(root.locator('[data-popup-slot="value"]')).toHaveText('Wildfire');
    const row = root.locator('[data-popup-region="body"] [data-popup-slot="conditions"] [data-value-row]', { hasText: 'Wildfire' });
    await expect(row).toHaveCount(1);
    // One item per name, in the order the layer yields them (the product
    // keeps rendered order), so the set is compared, not the sequence.
    await expect(row.locator('li')).toHaveCount(2);
    const names = await row.locator('li').allTextContents();
    expect(names.map((name) => name.trim()).sort()).toEqual(['Synthetic Alpha Fire', 'Synthetic Bravo Fire']);
    await expect(row.locator('.popup-value-text')).toHaveText('Active mapped perimeter in this area (NIFC WFIGS)');
    await expect(row).not.toContainText('Synthetic Alpha Fire, Synthetic Bravo Fire');
  });
});

test.describe('place popups: named fields in both sinks', () => {
  for (const fixture of Object.values(PLACE_FRAME_FIXTURES)) {
    test(`every place builder keeps its named fields in its frame, in both sinks: ${fixture.id}`, async ({ page }) => {
      test.setTimeout(120_000);
      await holdExternalNetwork(page);
      await fixture.prepare(page);
      for (const target of fixture.targets) {
        await bootPlace(page, fixture, target, 'console');
        await expectPlaceFields(await clickCentreUntilFramed(page, MAP_ROOT, target.layerId), target.expected, `${fixture.id} ${target.layerId} map`);
        if (!target.panel) continue;
        await bootPlace(page, fixture, target, 'brief');
        await expectPlaceFields(await clickCentreUntilFramed(page, PANEL_ROOT, target.layerId), target.expected, `${fixture.id} ${target.layerId} panel`);
      }
    });
  }

  // The three AIANNH caveat branches (the review :224: removing the
  // OTSA/legal/statistical branch must red), each in both sinks.
  const aiannh = PLACE_FRAME_FIXTURES['aiannh']!;
  const branches = [
    { code: 'D1', type: 'Federal reservation', variant: 'legal' },
    { code: 'D6', type: 'Oklahoma Tribal Statistical Area (statistical)', variant: 'otsa' },
    { code: 'E1', type: 'Alaska Native Village Statistical Area (statistical)', variant: 'statistical' }
  ] as const;
  for (const branch of branches) {
    test(`every place builder keeps its named fields in its frame, in both sinks: AIANNH ${branch.code}`, async ({ page }) => {
      test.setTimeout(120_000);
      await holdExternalNetwork(page);
      const title = `Synthetic ${branch.code} Fixture Area`;
      await routeGeojson(page, AIANNH_ROUTE, {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 1,
            properties: { NAME: title, AIANNHCC: branch.code, AIANNHNS: '90000001' },
            geometry: { type: 'Polygon', coordinates: [[[-123.5, 46.0], [-118.0, 46.0], [-118.0, 48.6], [-123.5, 48.6], [-123.5, 46.0]]] }
          }
        ]
      });
      const target = aiannh.targets[0];
      const expected = {
        ...target.expected,
        title,
        details: { Type: branch.type },
        note: { variant: `aiannh:${branch.variant}`, text: AIANNH_CAVEATS[branch.variant] }
      };
      await bootPlace(page, aiannh, target, 'console');
      await expectPlaceFields(await clickCentreUntilFramed(page, MAP_ROOT), expected, `AIANNH ${branch.code} map`);
      await bootPlace(page, aiannh, target, 'brief');
      await expectPlaceFields(await clickCentreUntilFramed(page, PANEL_ROOT), expected, `AIANNH ${branch.code} panel`);
    });
  }
});

test.describe('place popups: the deployer slot', () => {
  test('the deployer Tribal popup links nowhere, in both sinks', async ({ page }) => {
    test.setTimeout(120_000);
    await holdExternalNetwork(page);
    const tribal = PLACE_FRAME_FIXTURES['tribal']!;
    await tribal.prepare(page);
    const target = tribal.targets[0];
    for (const [view, rootSelector] of [
      ['console', MAP_ROOT],
      ['brief', PANEL_ROOT]
    ] as const) {
      await bootPlace(page, tribal, target, view);
      const root = await clickCentreUntilFramed(page, rootSelector);
      await expect(root).toHaveAttribute('data-popup-product', 'tribal');
      await expect(root.locator('a[href]')).toHaveCount(0);
      // Nothing around the frame in its sink links either.
      await expect(page.locator(rootSelector.replace(/ > \[data-popup-frame\]$/, '')).locator('a[href]')).toHaveCount(0);
    }
  });
});
