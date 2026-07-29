import { test, expect, type Page } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import { routeAllTribalFixtures } from './tribal-fixtures';

/**
 * The InteractionCoordinator click-collision contract (D-0.7.0-058
 * ruling 5; the S1 precedence table in src/config/interaction-ranks.ts).
 *
 * Every case drives the two live Tribal-geography layers against the
 * synthetic route fixtures (tests/tribal-fixtures.ts): both fixture
 * polygons span the viewport center, so a center click is a REAL
 * multi-layer collision. Before the coordinator, that click stacked one
 * popup per layer and the shared place selection was last-writer-wins
 * in listener-registration order; the ruled shape is exactly ONE
 * response, its primary resolved by the semantic precedence table
 * (reservation-boundary above tribal-lands), the rest reachable only
 * through the "Other map features here (n)" disclosure.
 */

/** Click the map center until the coordinated response appears. */
async function clickCenterForResponse(page: Page): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const popup = page.locator('.maplibregl-popup-content');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(popup).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Click the map center until the coordinated response's primary IS the
 * named title. Two overlapping fixture fills cover the center, and a
 * live fill is queryable only after it PAINTS, a frame or two behind its
 * "settled" pill. Under load the decisive click can catch only the
 * topmost-painted fill, and because a place selection is sticky (the
 * selected place is promoted on the next click), a plain retry cannot
 * self-correct. Closing the wrong popup clears the sticky selection and
 * its emphasis, so each retry starts clean; once the lower fill has
 * painted, the precedence table resolves the intended primary. (The
 * production build strips the dev map handle, so the test cannot query
 * the render set directly.)
 */
async function clickCenterUntilPrimary(
  page: Page,
  title: string,
  others?: number
): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const content = page.locator('.maplibregl-popup-content');
  const closeBtn = page.locator('.maplibregl-popup-close-button');
  const wantSummary =
    others === undefined ? null : `Other map features here (${others})`;
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(content).toBeVisible({ timeout: 1500 });
    const got = (await content.locator('.popup-title').textContent())?.trim();
    if (got !== title) {
      await closeBtn.click();
      throw new Error(`primary was "${got}", waiting for "${title}" to paint`);
    }
    // When a caller pins the other-hit count, hold out until every
    // overlapping fill has painted, so the disclosure count is stable
    // (it is fixed at click time and never re-renders).
    if (wantSummary !== null) {
      const summary = content.locator('.popup-other-features summary');
      const label = (await summary.count())
        ? (await summary.textContent())?.trim()
        : 'Other map features here (0)';
      if (label !== wantSummary) {
        await closeBtn.click();
        throw new Error(`disclosure was "${label}", waiting for "${wantSummary}"`);
      }
    }
  }).toPass({ timeout: 20_000 });
}

/** Boot with both live Tribal layers settled over the collision fixtures. */
async function bootCollision(page: Page): Promise<void> {
  await routeAllTribalFixtures(page);
  // The layers= order deliberately activates aiannh FIRST: under the old
  // per-layer handlers, registration order followed activation order, so
  // a rank-blind implementation would answer with the first-registered
  // layer. The assertions below then prove the table, not the order,
  // decides the primary.
  await gotoApp(page, '?view=console&layers=aiannh,bia-reservations');
  await waitForLayerSettled(page, 'aiannh');
  await waitForLayerSettled(page, 'bia-reservations');
}

test.describe('InteractionCoordinator: one click, one response', () => {
  test('a same-spot collision yields exactly one popup, ranked reservation-first, with the disclosure', async ({
    page
  }) => {
    await bootCollision(page);
    await clickCenterUntilPrimary(page, 'Synthetic Reservation Fixture', 1);

    // ONE response, never a stack (the defect this unit retires).
    await expect(page.locator('.maplibregl-popup')).toHaveCount(1);

    // The primary is the reservation representation: the precedence table
    // ranks reservation-boundary above tribal-lands even though aiannh
    // activated (and therefore registered) first.
    const popup = page.locator('.maplibregl-popup-content');
    await expect(popup.locator('.popup-title')).toHaveText('Synthetic Reservation Fixture');

    // The lower-priority hit is reachable only through the disclosure.
    const disclosure = popup.locator('.popup-other-features');
    await expect(disclosure.locator('summary')).toHaveText('Other map features here (1)');
    await expect(disclosure.locator('.popup-other-item')).toHaveText(
      'Synthetic Legal Fixture Area'
    );

    // Frozen-head layout (maintainer directive 2026-07-18): the head
    // carries the title, then the briefing door, then the features
    // switcher, in that order; the caveat and links live in the scrolling
    // body, not the head.
    const head = popup.locator('.coordinated-response-head');
    await expect(head.locator('.popup-title')).toHaveText('Synthetic Reservation Fixture');
    await expect(head.locator('[data-ddm-impact-trigger]')).toBeVisible();
    await expect(head.locator('.popup-other-features')).toBeVisible();
    const headOrder = await head.evaluate((el) =>
      [...el.children].map((c) =>
        c.matches('.popup-title')
          ? 'title'
          : c.matches('[data-ddm-impact-trigger]')
            ? 'briefing'
            : c.matches('.popup-other-features')
              ? 'features'
              : c.tagName.toLowerCase()
      )
    );
    expect(headOrder).toEqual(['title', 'briefing', 'features']);
    // The descriptive caveat scrolls in the body, not the frozen head.
    await expect(popup.locator('.coordinated-response-body .popup-description')).toHaveCount(1);
    await expect(head.locator('.popup-description')).toHaveCount(0);
  });

  test('choosing a disclosure entry replaces the response in place; the former primary joins the list', async ({
    page
  }) => {
    await bootCollision(page);
    await clickCenterUntilPrimary(page, 'Synthetic Reservation Fixture', 1);

    const popup = page.locator('.maplibregl-popup-content');
    await popup.locator('.popup-other-features summary').click();
    await popup.locator('.popup-other-item', { hasText: 'Synthetic Legal Fixture Area' }).click();

    // Still exactly one popup; the response switched subjects in place.
    await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
    const replaced = page.locator('.maplibregl-popup-content');
    await expect(replaced.locator('.popup-title')).toHaveText('Synthetic Legal Fixture Area');
    await expect(replaced.locator('.popup-other-features summary')).toHaveText(
      'Other map features here (1)'
    );
    await expect(replaced.locator('.popup-other-item')).toHaveText(
      'Synthetic Reservation Fixture'
    );
  });

  test('the one response carries the briefing link and it opens the impact panel', async ({
    page
  }) => {
    await bootCollision(page);
    await clickCenterUntilPrimary(page, 'Synthetic Reservation Fixture');

    const popup = page.locator('.maplibregl-popup-content');
    await popup.locator('[data-ddm-impact-trigger]').click();

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#impact-panel-title')).toHaveText(
      'Synthetic Reservation Fixture'
    );
    // Opening the briefing dismisses the popup so the panel is the focus.
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  });

  test('a click on empty map dismisses the response', async ({ page }) => {
    await bootCollision(page);
    await clickCenterForResponse(page);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(1);

    // The fixture rectangles start at longitude -123.5; the Washington
    // framing shows water and coast west of them, so a click near the
    // map's left edge lands outside every registered feature.
    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('map container has no box');
    await page.mouse.click(box.x + 12, box.y + box.height / 2);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  });

  test('a station marker click yields exactly one popup: the station adopts the response slot', async ({
    page
  }) => {
    // The station popup is DOM-driven (MapLibre marker observer), invisible
    // to rendered-feature arbitration; the 2026-07-17 adversarial pass
    // (finding 1) showed it could stack beside a coordinator response. The
    // adoption seam makes the station win the click as the table's top
    // point-event. Discovery upstreams are aborted so the curated seed
    // markers render deterministically offline (the honest catch path).
    await routeAllTribalFixtures(page);
    await page.route('**/ddm-proxy.atniclimate.workers.dev/**', (route) => route.abort('failed'));
    await page.route('**/waterservices.usgs.gov/**', (route) => route.abort('failed'));
    await gotoApp(page, '?view=console&layers=aiannh,bia-reservations,telemetry');
    await waitForLayerSettled(page, 'bia-reservations');
    await waitForLayerSettled(page, 'telemetry');

    // Puget Sound Vital Signs sits inside both fixture rectangles, so this
    // marker click is a real station-over-boundary collision.
    const marker = page.locator('[data-telemetry-station-id="ps_vital_signs"]');
    await marker.click();

    const popup = page.locator('.maplibregl-popup');
    await expect(popup).toHaveCount(1);
    await expect(page.locator('.maplibregl-popup-content')).toContainText(
      'Puget Sound Vital Signs'
    );
  });

  test('a broad surface never blankets a boundary: SPC ranks as a condition surface', async ({
    page
  }) => {
    await routeAllTribalFixtures(page);
    // A synthetic Day 1 polygon covering the whole fixture area.
    await page.route('**/SPC_firewx/MapServer/**', (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 1,
              properties: { dn: 2, valid: '202607171200', expire: '202607180000' },
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [-124.5, 45.6],
                    [-117.0, 45.6],
                    [-117.0, 48.9],
                    [-124.5, 48.9],
                    [-124.5, 45.6]
                  ]
                ]
              }
            }
          ]
        })
      })
    );
    await gotoApp(page, '?view=console&layers=aiannh,bia-reservations,spc-fire-weather');
    // Settle ALL THREE hit layers before the click: the disclosure-count
    // assertion needs every fixture rendered, and under full-suite load a
    // late activation can lag past the first successful click (the
    // 2026-07-17 sharded-run flake).
    await waitForLayerSettled(page, 'aiannh');
    await waitForLayerSettled(page, 'bia-reservations');
    await waitForLayerSettled(page, 'spc-fire-weather');
    // Hold out until all three fills have painted (the reservation is
    // primary and both the tribal fill and the SPC surface are the two
    // other hits), so the disclosure count is deterministic.
    await clickCenterUntilPrimary(page, 'Synthetic Reservation Fixture', 2);

    // The reservation wins; the outlook surface is reachable only through
    // the disclosure (the table's stated rationale: a blanket ranked higher
    // would make sovereign geography visible but unreachable).
    const popup = page.locator('.maplibregl-popup-content');
    await expect(popup.locator('.popup-title')).toHaveText('Synthetic Reservation Fixture');
    await expect(popup.locator('.popup-other-features summary')).toHaveText(
      'Other map features here (2)'
    );
    await expect(popup.locator('.popup-other-features')).toContainText('fire weather');
  });

  test('the selected place is promoted: a search-selected state wins an in-place click', async ({
    page
  }) => {
    await routeAllTribalFixtures(page);
    // Pin the camera to Washington so the search's fitBounds(Washington) is
    // a near-identity move: a bare URL boots to a wide framing, and the fit
    // then animates across it, which is the camera race that let an earlier
    // click land on a neighbouring state mid-fly. With the boot framing
    // already on Washington there is no large fly to race.
    await gotoApp(page, '?view=console&region=washington_state&layers=aiannh,bia-reservations,states');
    await waitForLayerSettled(page, 'aiannh');
    await waitForLayerSettled(page, 'bia-reservations');
    await waitForLayerSettled(page, 'states');

    // Select Washington through the shared search (summary-first: a
    // selection with no popup and no feature-state emphasis; the promotion
    // must ride the place-selection label, not the emphasis store).
    await page.locator('#catalog-search [data-ddm-search]').fill('washington');
    await page
      .locator('[data-search-group="place"] [data-search-kind="place"]', {
        hasText: 'Washington'
      })
      .first()
      .click();
    await expect(page.locator('#app')).toHaveAttribute('data-place-selected', '');

    // The search flew the camera to Washington; the flyTo briefly widens
    // the view before settling, so the click must wait until the camera has
    // landed ON Washington, not merely on some state. The hover inspector
    // reads us-states-fill, so poll the center until its State readout reads
    // Washington: that holds only once the fly has settled over WA and the
    // state fill is painted and queryable there. A close-reset retry cannot
    // be used here (closing would clear the very selection under test) and a
    // single click mid-fly would commit the wrong state and overwrite it, so
    // the settle gate must precede one deliberate click.
    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('map container has no box');
    // Bias the probe WEST of screen centre: the briefing fit pads for the
    // sidebar, which pushes Washington's centre toward the right and leaves
    // screen centre near the eastern WA / Idaho border. A left-of-centre
    // point lands firmly in central-western Washington, over the fixtures
    // and well clear of the border.
    const cx = box.x + box.width * 0.32;
    const cy = box.y + box.height / 2;
    const inspector = page.locator('#hover-inspector');
    const stateReadout = inspector.locator('.hover-item', { hasText: 'State' });
    await expect(async () => {
      await page.mouse.move(cx, cy);
      await page.mouse.move(cx + 6, cy + 3);
      await expect(stateReadout).toContainText('Washington', { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    // Let the overlapping tribal and reservation fills repaint too, so the
    // reservation appears in the disclosure of the one response.
    await page.waitForTimeout(300);

    // A click inside the selected state re-affirms it: a state is normally
    // the LOWEST-ranked boundary (rank 'state-boundary'), so it can be the
    // primary ONLY because the search selection promoted it to
    // 'selected-place'. The proof that it is a promotion, not a fluke of
    // geometry, is that a normally-higher-ranked Tribal-lands fixture under
    // the same click is demoted into the disclosure. (Which fixture lands
    // under the padded screen centre depends on the briefing camera pad, so
    // the assertion matches any synthetic fixture rather than one by name.)
    await page.mouse.click(cx, cy);
    const popup = page.locator('.maplibregl-popup-content');
    await expect(popup.locator('.popup-title')).toHaveText('Washington');
    await expect(popup.locator('.popup-other-features summary')).toBeVisible();
    await expect(popup.locator('.popup-other-item').first()).toContainText('Fixture');
  });

  test('entering a studio dismisses the open response', async ({ page }) => {
    await routeAllTribalFixtures(page);
    await gotoApp(page, '?view=brief&layers=aiannh,bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    // S4: in desktop Brief the place-bearing response rehosts at the
    // panel foot (the coordinator's swappable sink); the dismissal seam
    // under test is the same coordinator seam, whichever surface holds
    // the response.
    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('map container has no box');
    const foot = page.locator('#panel-response .coordinated-response');
    await expect(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(foot).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

    // The PLACE studio is a left-side route on desktop: without the
    // dismissal seam the response would stay painted beside the studio
    // (adversarial finding 5).
    await page.locator('#place-studio-entry').click();
    await expect(page).toHaveURL(/studio=place/);
    await expect(foot).toHaveCount(0);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  });
});
