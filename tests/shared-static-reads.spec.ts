import { expect, test, type Page } from '@playwright/test';

import { gotoApp, waitForLayerSettled } from './helpers';

/**
 * DDM-P14-T06: one session fetches and parses `public/data/us-states.geojson`
 * and `public/data/enso-indices.json` at most once each, through the shared
 * budgeted fetch (`fetchSharedJsonWithBudget`, `src/util/fetch.ts`), no
 * matter how many of the seven us-states readers or the two enso-indices
 * readers a session's own path happens to touch.
 *
 * Before DDM-P14-T06 each reader fetched independently: the states layer's
 * own boot activation, the Place studio's state-type list, the studio's own
 * selection resolve, and (on returning to the map) the emphasis-target
 * resolver in `display-snapshot.ts` each read `us-states.geojson` on their
 * own; the ENSO minimap label and the ENSO briefing claim each read
 * `enso-indices.json` on their own. Counted here on the network layer
 * (`page.route`, installed before `gotoApp` so the boot-time activation is
 * caught too), never on the fulfilled body, so a request that is later held
 * or aborted still counts as a request.
 */

const US_STATES_PATTERN = '**/data/us-states.geojson';
const ENSO_INDICES_PATTERN = '**/data/enso-indices.json';
const ENSO_LOADING_TEXT = 'Reading sources...';

function ensoCurrentCell(page: Page) {
  return page.locator('.impact-hazard[data-horizon="current"][data-hazard="enso"]');
}

/**
 * Installs a request counter on `pattern` that fulfils every request from
 * the real static file (`route.continue()`, never a fixture body), and
 * counts every intercepted request, not every completed fulfilment, so a
 * request this spec later holds open still counts before it releases.
 */
function countRequests(page: Page, pattern: string): () => number {
  let count = 0;
  void page.route(pattern, (route) => {
    count += 1;
    void route.continue();
  });
  return () => count;
}

test.describe('DDM-P14-T06: shared static reads', () => {
  test('the studio flow and the click door share one us-states fetch and one enso fetch', async ({
    page
  }) => {
    const usStatesCount = countRequests(page, US_STATES_PATTERN);
    const ensoCount = countRequests(page, ENSO_INDICES_PATTERN);

    // `states` is in the boot set so its own activation fetch runs before any
    // studio interaction; `studio=place` mounts the Place studio at boot.
    await gotoApp(page, '?view=brief&layers=places,states&studio=place');

    // The studio's own bundled-file readers: the state-type list load, then
    // the single-state selection resolve.
    await page.locator('#place-type-state').click();
    await page.locator('#place-studio-search').fill('Washington');
    await page.locator('#place-option-state-0').click();
    await expect(page.locator('#place-selection-title')).toHaveText('Washington');

    // Back opens the full briefing: the emphasis-target resolver's own
    // us-states read, and the ENSO briefing claim's own enso-indices read
    // (on top of whatever the always-mounted minimap's ENSO label already
    // read at boot).
    await page.locator('#place-studio-back').click();
    await expect(page.locator('#place-studio-root')).toHaveCount(0);
    await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
    await expect(ensoCurrentCell(page)).not.toContainText(ENSO_LOADING_TEXT, {
      timeout: 15_000
    });

    await page.locator('#impact-panel .impact-panel-close').click();
    await expect(page.locator('#impact-panel')).toBeHidden();

    // The click door: a map click resolves through location-identity.ts
    // (the rendered `states` fill first, the bundled-file fallback only if
    // that misses) and opens the same briefing a second time.
    await waitForLayerSettled(page, 'states');
    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('map container has no box');
    const trigger = page.locator('[data-ddm-impact-trigger]');
    await expect(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(trigger).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });
    await trigger.click();
    await expect(page.locator('#impact-panel-title')).toHaveText('Washington');
    await expect(ensoCurrentCell(page)).not.toContainText(ENSO_LOADING_TEXT, {
      timeout: 15_000
    });

    expect(usStatesCount(), 'us-states.geojson request count').toBe(1);
    expect(ensoCount(), 'enso-indices.json request count').toBe(1);
  });

  /**
   * Cancellation still belongs to the consumer (fetch.ts:300-322's refcount):
   * a superseded selection's own wait aborts, but the shared transport keeps
   * running for whichever consumer is still attached, and completes once.
   * The idiom (hold a route on a gate, arm it only once the race is set up,
   * release it later) is `tests/place-studio.spec.ts`'s C3 case.
   */
  test('a superseded state selection cancels only its own wait; the shared transport still completes once', async ({
    page
  }) => {
    let usStatesCount = 0;
    let armed = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    await page.route(US_STATES_PATTERN, async (route) => {
      usStatesCount += 1;
      if (armed) await gate;
      await route.continue();
    });

    // No `states` layer here: the first us-states request must be the
    // studio's own selection resolve, not a boot-time layer activation.
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-type-state').click();
    await page.locator('#place-studio-search').fill('Washington');

    armed = true;
    await page.locator('#place-option-state-0').click();
    // Immediately supersede it, before the held request resolves: newest
    // intent wins (place-studio.tsx's per-selection AbortController aborts
    // Washington's own wait when Oregon's selection effect replaces it).
    await page.locator('#place-studio-search').fill('Oregon');
    await page.locator('#place-option-state-0').click();

    releaseGate();
    await expect(page.locator('#place-selection-title')).toHaveText('Oregon');
    expect(usStatesCount, 'us-states.geojson request count').toBe(1);
  });
});
