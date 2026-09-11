import { test, expect, type Page } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import { BIA_ROUTE, NOTCH_BOUNDS, concaveBiaBody, routeGeojson } from './tribal-fixtures';

/**
 * The InteractionCoordinator click-collision contract (D-0.7.0-058
 * ruling 5; the S1 precedence table in src/config/interaction-ranks.ts).
 *
 * Every case drives the two live Tribal-geography layers against the
 * synthetic route fixtures that gotoApp installs on every boot
 * (tests/tribal-fixtures.ts): both fixture
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

    // Frozen-head layout, AMENDED by the owner 2026-09-10 (superseding the
    // 2026-07-18 maintainer directive this comment used to describe): the
    // head now carries the title, then the one-line "kind of place"
    // (.popup-agency), then the Conditions block (.popup-conditions,
    // src/ui/popup-conditions.ts), then the briefing door, then the
    // features switcher, in that order. The boundary detail (acres,
    // classification, and the like) and the representation caveat still
    // scroll in the body, not the head -- that part of the old directive
    // stands.
    const head = popup.locator('.coordinated-response-head');
    await expect(head.locator('.popup-title')).toHaveText('Synthetic Reservation Fixture');
    await expect(head.locator('.popup-agency')).toBeVisible();
    await expect(head.locator('.popup-conditions')).toBeVisible();
    await expect(head.locator('[data-ddm-impact-trigger]')).toBeVisible();
    await expect(head.locator('.popup-other-features')).toBeVisible();
    const headOrder = await head.evaluate((el) =>
      [...el.children].map((c) =>
        c.matches('.popup-title')
          ? 'title'
          : c.matches('.popup-agency')
            ? 'agency'
            : c.matches('.popup-conditions')
              ? 'conditions'
              : c.matches('[data-ddm-impact-trigger]')
                ? 'briefing'
                : c.matches('.popup-other-features')
                  ? 'features'
                  : c.tagName.toLowerCase()
      )
    );
    expect(headOrder).toEqual(['title', 'agency', 'conditions', 'briefing', 'features']);
    // The boundary meta and the descriptive caveat still scroll in the
    // body, not the frozen head.
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

/**
 * The Conditions block's ABSENCE claims, pinned (S24, 2026-09-10).
 *
 * The block shipped in the S23 popup lane with no test on any of its
 * sentences, and an adversarial pass found two places where it turned "we do
 * not know" into "there is nothing here". Nothing about a boundary popup is
 * worth more than that distinction: a person reads this card to decide
 * whether to prepare, and a false all-clear is the one failure this project
 * treats as unacceptable. These cases exist so a future change cannot quietly
 * restore either overstatement with a green suite.
 */
test.describe('the Conditions block never claims an absence it did not read', () => {
  const WWA_QUERY = '/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';

  /** Boot the collision fixture WITH the NWS alerts layer, answering its
   * query with `body`, and open the reservation popup. */
  async function bootWithAlerts(
    page: Page,
    fulfil: (route: import('@playwright/test').Route) => Promise<void> | void
  ): Promise<void> {
    await page.route((url) => url.pathname.endsWith(WWA_QUERY), fulfil);
    await gotoApp(page, '?view=console&layers=aiannh,bia-reservations,nws-alerts');
    await waitForLayerSettled(page, 'aiannh');
    await waitForLayerSettled(page, 'bia-reservations');
    await clickCenterUntilPrimary(page, 'Synthetic Reservation Fixture', 1);
  }

  test('a condition layer that failed to load is named as unread, never as nothing here and never as nothing asked for', async ({
    page
  }) => {
    // The refresh-failure path clears the displayed snapshot and reports
    // `error` while KEEPING the fill layer and the active key
    // (src/layers/nws-alerts.ts), so a reader that asks only "is the layer
    // on and does its fill exist" sees an empty query and cannot tell a
    // quiet sky from a broken pipe.
    await bootWithAlerts(page, (route) => route.abort());

    const conditions = page.locator('.maplibregl-popup-content .popup-conditions');
    await expect(conditions).toBeVisible();
    // An activation that never succeeded leaves no active key and no
    // rendered fill, so the alerts row itself is absent; what must NOT
    // happen is the card describing that as a quiet sky, or as nobody
    // having asked for the layer at all.
    await expect(conditions).not.toContainText('No active');
    await expect(conditions).not.toContainText('No condition layer');
    await expect(conditions).toContainText('could not be read');
  });

  test('a successful empty read scopes its absence to the products actually requested', async ({
    page
  }) => {
    // The layer asks for seven heat and fire weather products only
    // (ALERT_EVENTS in src/layers/nws-alerts.ts). An absence sentence that
    // said "no NWS watch, warning, or advisory" spoke past that query and
    // would have denied an active Flash Flood Warning.
    await bootWithAlerts(page, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [] })
      })
    );

    const conditions = page.locator('.maplibregl-popup-content .popup-conditions');
    await expect(conditions).toBeVisible();
    const alertRow = conditions.locator('.popup-condition-row', {
      hasText: 'NWS alert'
    });
    await expect(alertRow).toHaveCount(1);
    await expect(alertRow).toContainText('heat or fire weather');
    await expect(alertRow).toContainText('Only those products are requested');
  });
});

/**
 * The Conditions block attributes an alert to a place only when the alert
 * actually touches that place (Codex adversarial review 2026-09-10, finding 3;
 * the ATTRIBUTION FIX in src/ui/popup-conditions.ts, whose predicate is unit-
 * tested in tests/polygon-overlap.spec.ts).
 *
 * The card retrieves alert candidates with the clicked place's screen-space
 * BOUNDING BOX, deliberately and for a reason that has not changed: nws-alerts
 * registers as the highest-ranked `point-event` kind, so an alert covering the
 * clicked pixel wins the click outright and a bare point query would make the
 * alert row unreachable from a boundary popup entirely. A rectangle is
 * therefore the right RETRIEVAL shape. It is the wrong ATTRIBUTION shape,
 * because a concave place's rectangle also contains ground that is not that
 * place, and until the fix a warning in that gap was reported as this place's
 * warning AND pulsed its briefing door.
 *
 * The pair below is the evidence, and it is a pair on purpose. Both cases boot
 * the SAME camera and the SAME fixture alert at the SAME coordinates; the only
 * thing that differs is whether the reservation polygon has a notch where that
 * alert sits. Same box, same pixels, opposite answers. A single case could be
 * passing because the alert never painted at all.
 */
test.describe('the Conditions block attributes an alert only where it touches the place', () => {
  const WWA_QUERY = '/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';

  /** A Red Flag Warning square, `[w, s, e, n]`, shaped as the layer's own
   * validator requires (a requested product name and an expiry that parses).
   * Placed inside NOTCH_BOUNDS so the concave fixture excludes it. */
  function redFlagAt(w: number, s: number, e: number, n: number): unknown {
    // The window is relative to the run, because src/layers/nws-alerts.ts
    // (activeFeaturesAt) drops an alert whose expiry has passed: fixed dates
    // of 2026-09-10/11 made this block fail from 02:00 UTC on 2026-09-11
    // onward, on every tree (found by the S28 decision-A worker, which saw
    // it fail identically with its change stashed).
    const hour = 3_600_000;
    const onset = new Date(Date.now() - 6 * hour).toISOString();
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
            wfo: 'OTX'
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s]
              ]
            ]
          }
        }
      ]
    };
  }

  /**
   * Boot with the alerts layer holding one Red Flag Warning in the notch, and
   * with the reservation shaped either as the plain rectangle (which CONTAINS
   * the notch region) or as the L (which does not).
   */
  async function bootWithNotchAlert(page: Page, shape: 'rectangle' | 'concave'): Promise<void> {
    const [w, s, e, n] = NOTCH_BOUNDS;
    // Inset from the notch edges so neither answer depends on a boundary case.
    const alert = redFlagAt(w + 0.5, s + 0.2, e - 0.5, n - 0.2);
    await page.route(
      (url) => url.pathname.endsWith(WWA_QUERY),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(alert)
        })
    );
    if (shape === 'concave') {
      await routeGeojson(page, BIA_ROUTE, concaveBiaBody());
    }
    await gotoApp(page, '?view=console&layers=bia-reservations,nws-alerts');
    await waitForLayerSettled(page, 'bia-reservations');
    await waitForLayerSettled(page, 'nws-alerts');
    await clickCenterUntilPrimary(page, 'Synthetic Reservation Fixture');
  }

  test('a rectangular place that really contains the warning reports it', async ({ page }) => {
    // The control. Without this the negative case below proves nothing: it
    // establishes that this alert, at these coordinates, IS retrieved by the
    // box query and IS reportable, so the negative case can only be the
    // polygon test doing its work.
    await bootWithNotchAlert(page, 'rectangle');

    const conditions = page.locator('.maplibregl-popup-content .popup-conditions');
    await expect(conditions).toBeVisible();
    const alertRow = conditions.locator('.popup-condition-row', { hasText: 'NWS alert' });
    await expect(alertRow).toContainText('Red Flag Warning');
    // The place-wide scope is stated, so a reader never reads a box query as a
    // measurement at the pixel they clicked.
    await expect(alertRow).toContainText('in this area');

    // And the emphasis IS earned here: a Warning-tier product really does
    // cover this place, so the briefing door pulses. The negative case asserts
    // the opposite on the same fixture, which is what makes either meaningful.
    const door = page.locator('.maplibregl-popup-content [data-ddm-impact-trigger]');
    await expect(door).toHaveClass(/popup-impact-btn--pulse/);
  });

  test('a concave place whose notch holds the warning does not report it, and does not pulse', async ({
    page
  }) => {
    await bootWithNotchAlert(page, 'concave');

    const conditions = page.locator('.maplibregl-popup-content .popup-conditions');
    await expect(conditions).toBeVisible();
    const alertRow = conditions.locator('.popup-condition-row', { hasText: 'NWS alert' });
    // The row still exists: the layer read cleanly and found nothing HERE,
    // which is a confirmed zero and must be said, not omitted.
    await expect(alertRow).toHaveCount(1);
    await expect(alertRow).not.toContainText('Red Flag Warning');
    await expect(alertRow).toContainText('No active NWS heat or fire weather');

    // Amendment A2 gates the briefing door's emphasis on real issuer evidence
    // AT the clicked place. Somewhere else's warning must not pulse it
    // (`popup-impact-btn--pulse`, src/ui/popups.ts buildImpactTriggerButtonHtml).
    const door = page.locator('.maplibregl-popup-content [data-ddm-impact-trigger]');
    await expect(door).toHaveCount(1);
    await expect(door).not.toHaveClass(/popup-impact-btn--pulse/);
    await expect(door).toHaveAttribute(
      'class',
      /popup-impact-btn/
    );
  });
});
