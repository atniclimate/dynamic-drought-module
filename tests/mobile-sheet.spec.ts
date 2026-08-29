import { test, expect } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  layerPill,
  urlLayers,
  waitForLayerSettled,
  PILL
} from './helpers';
import { SHEET_DETENT_SIZE } from '../src/ui/mobile-sheet';

/**
 * U2: the mobile bottom sheet (ratified detent model D-0.7.0-017).
 *
 * Below 720px the sidebar is ONE bottom sheet with three detents that are
 * information depths: peek (the conditions strip), half (the at-hand
 * answer in Brief, compact controls in console), full (the standalone
 * report in Brief, the catalog stack in console). The detent is ephemeral
 * presentation state (never in the URL); the sheet moves only via the
 * grabber and explicit buttons; embeds are sheetless byte for byte, with
 * the expand control revealing the sheet at peek.
 *
 * The pre-existing embed contract at 400x600 stays pinned by
 * embed-viewport.spec.ts UNMODIFIED; this file adds the sheet-side
 * assertions around it.
 */

test.describe('U2 the mobile bottom sheet (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a bare URL boots map-first: the closed sheet, the footer doors, and Brief opens the full report', async ({
    page
  }) => {
    await gotoApp(page);

    // Map-first boot (the mobile shell, from the ratified 2026-07-11
    // mockup): the sheet is CLOSED with no visible edge; the footer nav
    // is the only bottom chrome and the map fills the shell above it.
    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-brief\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    const footer = page.locator('#mobile-footer-nav');
    await expect(footer).toBeVisible();
    await expect(footer.locator('button')).toHaveCount(4);
    await expect(page.locator('#sheet-grabber')).toBeHidden();
    const map = await page.locator('#map').boundingBox();
    expect(map).not.toBeNull();
    expect(map!.height).toBeGreaterThanOrEqual(780);

    // No unsolicited briefing (S2, D-0.7.0-041, superseding the U1
    // answer-first boot): the at-hand block honestly invites a pick and
    // no report is hosted, because nothing opened one.
    await page.waitForTimeout(1_500);
    await expect(page.locator('.sheet-at-hand-title')).toHaveText('Pick a place');
    await expect(page.locator('#sheet-report .impact-panel')).toHaveCount(0);

    // Brief IS the report door (the mockup's rule 4): the door opens at
    // full (the report surface, empty until an explicit selection), and
    // a re-tap closes back to the map.
    await footer.locator('button[data-tab="brief"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await footer.locator('button[data-tab="brief"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');

    // The detent and the door never enter the URL (no second state
    // machine).
    const search = await page.evaluate(() => window.location.search);
    expect(search).not.toMatch(/detent|sheet|tab/i);
  });

  test('the at-hand block carries the ONE shared search (U3), not the legacy place select', async ({
    page
  }) => {
    await gotoApp(page);
    // The Place door raises the at-hand answer with the one search.
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');

    // The U2 stopgap <select> is gone; the shared search input is mounted in
    // the stable container inside the at-hand block.
    await expect(page.locator('#sheet-place-select')).toHaveCount(0);
    const input = page.locator('#sheet-search [data-ddm-search]');
    await expect(input).toBeVisible();

    // Until an explicit selection, the title honestly stays the picker
    // invitation (no unsolicited briefing, S2 D-0.7.0-041). PLACE remains
    // the full-width studio door while the nonexistent report door stays out.
    await expect(page.locator('.sheet-at-hand-title')).toHaveText('Pick a place');
    const actions = page.locator('#sheet-at-hand-actions');
    const placeDoor = page.locator('#sheet-place-studio-entry');
    await expect(placeDoor).toBeVisible();
    await expect(page.locator('#sheet-report-door')).toBeHidden();
    await expect
      .poll(async () => {
        const actionBox = await actions.boundingBox();
        const placeBox = await placeDoor.boundingBox();
        return actionBox && placeBox ? Math.abs(actionBox.width - placeBox.width) : -1;
      })
      .toBeLessThanOrEqual(1);

    // Selecting a place through the sheet search routes the briefing into the
    // at-hand block (the same one search, wired through search-controller),
    // and the briefing push never wipes the mounted search: it survives
    // renderAtHand()'s innerHTML rebuild.
    await input.fill('oregon');
    await page.locator('#sheet-search [data-search-kind="place"][data-search-id="OR"]').click();
    await expect
      .poll(async () => page.locator('.sheet-at-hand-title').textContent())
      .toContain('Oregon');
    await expect(input).toBeVisible();
    await expect(page.locator('#sheet-report-door')).toBeVisible();
    await expect(actions).toHaveClass(/\bhas-briefing\b/);
  });

  test('the bounded at-hand search stays reachable on a short phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await gotoApp(page);
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();

    const input = page.locator('#sheet-search [data-ddm-search]');
    await expect(input).toBeVisible();
    // Poll: the one-shot reads race the 250ms sheet height transition.
    const bottomOf = async (locator: ReturnType<typeof page.locator>): Promise<number> => {
      const box = await locator.boundingBox();
      return box ? box.y + box.height : Number.MAX_SAFE_INTEGER;
    };
    await expect.poll(async () => bottomOf(input)).toBeLessThanOrEqual(600);
    // Place and time lead the short half detent. With no briefing, PLACE keeps
    // the full action width and the report door makes no empty promise.
    await expect(page.locator('#sheet-place-studio-entry')).toBeVisible();
    await expect(page.locator('#sheet-report-door')).toBeHidden();

    await input.fill('a');
    const results = page.locator('#sheet-search .ddm-search-results');
    await expect(results.locator('[role="option"]').first()).toBeVisible();
    const resultsBox = await results.boundingBox();
    const sheetBox = await page.locator('#sidebar').boundingBox();
    expect(resultsBox).not.toBeNull();
    expect(sheetBox).not.toBeNull();
    // The search leads the Place pane (mobile shell), so on a short phone
    // the bounded results open UPWARD over the map, exactly as the native
    // picker they replaced would; the contract is on-screen and
    // scrollable, not sheet containment.
    expect(sheetBox!.y).toBeGreaterThan(0);
    expect(resultsBox!.y).toBeGreaterThanOrEqual(0);
    expect(resultsBox!.y + resultsBox!.height).toBeLessThanOrEqual(600);
    expect(await results.evaluate((el) => el.scrollHeight)).toBeGreaterThan(
      await results.evaluate((el) => el.clientHeight)
    );

    // The honest "No matches" copy stays VISIBLE on a short phone (only the
    // redundant at-rest guidance is hidden to reclaim space): a query that
    // matches nothing must still tell the user so, never blame them.
    await input.fill('zzzqqq');
    const zeroMatch = results.locator('.ddm-search-empty');
    await expect(zeroMatch).toBeVisible();
    await expect(zeroMatch).toContainText('No matches');
  });

  test('a console link boots map-first; the Layers door opens the console at half', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    const app = page.locator('#app');
    await expect(app).toHaveClass(/\bview-console\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');

    // The Layers door: the compact console controls at half. The
    // conditions strip stays out of half (the MINOR 6 duplication); it
    // is the peek detent's content.
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#conditions-strip')).toBeHidden();
    await expect(page.locator('#panel-region')).toBeVisible();
    await expect(page.locator('#panel-quick-views')).toBeVisible();
    await expect(page.locator('#sheet-at-hand')).toBeHidden();
    await expect(page.locator('#panel-layers')).toBeHidden();
  });

  test('the grabber owns movement: Enter cycles, arrows step, down closes', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    const app = page.locator('#app');
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    // Half in console: the compact controls plus the one catalog door.
    await expect(page.locator('#panel-region')).toBeVisible();
    await expect(page.locator('#panel-quick-views')).toBeVisible();
    await expect(page.locator('#sheet-all-layers-btn')).toBeVisible();
    await expect(page.locator('#panel-layers')).toBeHidden();

    const grabber = page.locator('#sheet-grabber');
    await grabber.focus();
    await page.keyboard.press('Enter');
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    // Full in console: the whole stack scrolls internally.
    await expect(page.locator('#panel-layers')).toBeVisible();
    await expect(page.locator('#panel-telemetry')).toBeVisible();
    await expect(page.locator('.sidebar-footer')).toBeVisible();

    // Enter wraps back to peek; arrows step one detent at a time, and
    // stepping below peek closes the sheet (the edgeless map-first state).
    await page.keyboard.press('Enter');
    await expect(app).toHaveAttribute('data-sheet-detent', 'peek');
    await page.keyboard.press('ArrowUp');
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await page.keyboard.press('ArrowDown');
    await expect(app).toHaveAttribute('data-sheet-detent', 'peek');
    await page.keyboard.press('ArrowDown');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(page.locator('#sheet-grabber')).toBeHidden();
  });

  test('the first-use hint fires on the first MANUAL arrival at peek, once ever (W2-D11)', async ({
    page
  }) => {
    await gotoApp(page);
    const app = page.locator('#app');
    const hint = page.locator('.sheet-hint');

    // A normal phone boot lands CLOSED: no hint fires on a surface whose
    // grabber is not even visible yet.
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect(hint).toHaveCount(0);

    // Raise the sheet through a footer door (a programmatic arrival at
    // half; still no hint), then step DOWN to peek by hand: the first
    // manual arrival at peek shows the one-time hint.
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(hint).toHaveCount(0);
    await page.locator('#sheet-grabber').focus();
    await page.keyboard.press('ArrowDown');
    await expect(app).toHaveAttribute('data-sheet-detent', 'peek');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Drag up for the full briefing');

    // Any detent move dismisses it, and the localStorage guard makes the
    // dismissal permanent: a second manual arrival shows nothing.
    await page.keyboard.press('ArrowUp');
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(hint).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(app).toHaveAttribute('data-sheet-detent', 'peek');
    await expect(hint).toHaveCount(0);

    // The guard survives a reload (once EVER, not once per session).
    await gotoApp(page);
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await page.locator('#sheet-grabber').focus();
    await page.keyboard.press('ArrowDown');
    await expect(app).toHaveAttribute('data-sheet-detent', 'peek');
    await expect(hint).toHaveCount(0);
  });

  test('the "All layers" door expands the console sheet to the full catalog', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    const app = page.locator('#app');
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');

    await page.locator('#sheet-all-layers-btn').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(page.locator('#panel-layers')).toBeVisible();
  });

  test('the report door goes full (map receded) and close restores half (Brief)', async ({
    page
  }) => {
    // The briefing arrives via the select= deep link (the boot-time
    // explicit opener since S2, D-0.7.0-041); its open auto-raises the
    // closed sheet to the half detent (the shared link is the ask).
    await gotoApp(page, '?select=state:WA');
    const app = page.locator('#app');
    const hostedPanel = page.locator('#sheet-report .impact-panel');
    await expect(hostedPanel).toHaveCount(1, { timeout: 15_000 });
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');

    await page.locator('#sheet-report-door').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(hostedPanel).toBeVisible();
    // The standalone report: full leaves only the footer bar and the top
    // context gap (844 - 56 - 72 = 716) once the height transition
    // settles (poll: the one-shot read races the 250ms ease).
    await expect
      .poll(async () => (await page.locator('#sidebar').boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(700);
    // Page content, not a modal overlay.
    await expect(hostedPanel).toHaveAttribute('aria-modal', 'false');

    // Dismiss restores the prior detent AND returns to the ANSWER, not
    // an empty picker (adversarial-review findings 4/5): in Brief the
    // briefing stays open below the half detent, the at-hand block
    // keeps its place, and the door can reopen the report.
    await page.locator('.impact-panel-close').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(hostedPanel).toHaveClass(/\bopen\b/);
    expect(await page.locator('.sheet-at-hand-title').textContent()).not.toBe('Pick a place');
    await page.locator('#sheet-report-door').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(hostedPanel).toBeVisible();
  });

  test('a viewport crossing with an open console briefing drives the sheet to full', async ({
    page
  }) => {
    // Start on desktop console with the briefing open (the keyboard
    // region trigger), then cross below 720px: the open report must
    // apply the mode-keyed detent policy on entry (adversarial-review
    // finding 2), never park in a region the peek detent hides.
    await page.setViewportSize({ width: 1100, height: 800 });
    await gotoApp(page, '?view=console');
    await page.locator('.region-briefing-btn').click();
    await expect(page.locator('#impact-panel')).toHaveClass(/\bopen\b/);

    await page.setViewportSize({ width: 390, height: 844 });
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-sheet-detent', 'full');
    await expect(page.locator('#sheet-report .impact-panel')).toBeVisible();
  });

  test('a viewport crossing back to desktop rehosts the open report without a gap', async ({
    page
  }) => {
    // The open report comes from the select= deep link (the boot-time
    // explicit opener since S2, D-0.7.0-041).
    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(page.locator('#sheet-report .impact-panel')).toHaveCount(1, {
      timeout: 15_000
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    // The deactivate settle is synchronous (adversarial-review finding
    // 3): the open report is a document.body overlay again, visible and
    // modal, with no wrong-host gap.
    await expect
      .poll(async () => panel.evaluate((el) => el.parentElement === document.body))
      .toBe(true);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
  });

  test('RELEASE BLOCKER (D-0.7.0-008) inside the sheet: the drought tile label, announcement, and catalog sync move together at peek', async ({
    page
  }) => {
    // The same deterministic USDM week as the desktop release-blocker
    // spec; the tile now lives inside the sheet's peek detent.
    const usdmFc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { DM: 2, MapDate: Date.now() - 24 * 60 * 60 * 1000 },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-125, 42], [-116, 42], [-116, 49], [-125, 49], [-125, 42]]]
          }
        }
      ]
    };
    const fulfill = (route: Parameters<Parameters<typeof page.route>[1]>[0]): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(usdmFc)
      });
    await page.route('**/USDM_current/**', fulfill);
    await page.route('**/USDM_archive/**', fulfill);

    await gotoApp(page, '?region=washington_state&layers=usdm');
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    // Reach the peek detent through the shell grammar: the Layers door
    // opens half; one grabber step down lands peek.
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await page.locator('#sheet-grabber').focus();
    await page.keyboard.press('ArrowDown');
    await expect(app).toHaveAttribute('data-sheet-detent', 'peek');
    await waitForLayerSettled(page, 'usdm');

    const tile = page.locator('.conditions-metric[data-metric="drought"]');
    const live = page.locator('#layer-status-live');
    await expect(tile).toBeVisible();

    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(await tile.getAttribute('aria-label')).toContain('layer on. Press to hide.');

    await tile.click();
    await expect.poll(async () => !(await urlLayers(page)).has('usdm')).toBe(true);
    await expect(layerCheckbox(page, 'usdm')).not.toBeChecked();
    await expect(live).toHaveText('US Drought Monitor: off');
    await expect(tile).toHaveAttribute('aria-pressed', 'false');
    await expect(tile.locator('.conditions-value')).toHaveText('Layer off');
    const offLabel = (await tile.getAttribute('aria-label')) ?? '';
    expect(offLabel).toContain('US Drought Monitor layer off');
    expect(offLabel).toContain('replaces the current condition surface');

    await tile.click();
    await expect.poll(async () => (await urlLayers(page)).has('usdm')).toBe(true);
    await expect(layerCheckbox(page, 'usdm')).toBeChecked();
    await waitForLayerSettled(page, 'usdm');
    await expect(layerPill(page, 'usdm')).toHaveText(PILL.live);
    await expect(live).toHaveText('US Drought Monitor: live');
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('U2 embed stays sheetless; expand reveals the sheet at peek (400x600)', () => {
  test.use({ viewport: { width: 400, height: 600 } });

  test('no sheet exists in embed; the expand control exits embed into peek', async ({
    page
  }) => {
    await gotoApp(page, '?embed=true');
    const app = page.locator('#app');

    // Embed keeps today's hidden-chrome semantics: no detent attribute,
    // no grabber, no footer nav, no hazard rail (the embed row-collapse
    // itself is pinned by embed-viewport.spec.ts, which stays unmodified).
    await expect(app).toHaveClass(/\bembed\b/);
    await expect(app).not.toHaveAttribute('data-sheet-detent', /.+/);
    await expect(page.locator('#sheet-grabber')).toBeHidden();
    await expect(page.locator('#mobile-footer-nav')).toBeHidden();
    await expect(page.locator('#hazard-rail')).toBeHidden();

    // The existing expand control exits embed and reveals the sheet at
    // peek (the ratified embed-exit path).
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(/\bembed\b/);
    await expect(app).toHaveAttribute('data-sheet-detent', 'peek');
    await expect(page.locator('#sheet-grabber')).toBeVisible();
  });
});

test.describe('U2 the sheet settle survives a main-thread stall (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a long task across the height ease still pads the camera for the rendered half sheet', async ({
    page
  }) => {
    // The camera's bottom padding is not in the DOM, but the BIA layer
    // refetches by viewport envelope after every camera move, so the
    // southern edge of its query envelope is a production-observable
    // reading of how far the map is padded: a taller obstruction pushes
    // the visible envelope north. Boot with the layer on; every CI boot
    // answers its requests from the synthetic fixture.
    const souths: number[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (!url.includes('biamaps.geoplatform.gov')) return;
      const m = /geometry=([^&]+)/.exec(url);
      if (!m) return;
      const parts = decodeURIComponent(m[1]).split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) souths.push(parts[1]);
    });
    await gotoApp(page, '?layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-sheet-detent', 'closed');
    await expect.poll(() => souths.length).toBeGreaterThan(0);
    const closedSouth = souths[souths.length - 1];

    // Open the LAYERS door, then stall the main thread across the sheet's
    // 250 ms height ease. The settle fallback timer fires after the stall
    // while the animation clock still sits mid-ease, so a one-shot rect
    // read there sees a few pixels of sheet; only a re-measure at the
    // rendered end state (`transitionend`) pads the camera for the real
    // half sheet. A live multi-megabyte GeoJSON parse or the minimap
    // analysis stalls a CI runner the same way (FE-23, the
    // popup-viewport:248 signature of 2026-08-29: inset 223 of 388).
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await page.evaluate((ms) => {
      const t = performance.now();
      while (performance.now() - t < ms) {
        // spin: a synthetic long task
      }
    }, 600);
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    await expect
      .poll(async () => page.locator('#sidebar').evaluate((el) => el.getBoundingClientRect().height))
      .toBeCloseTo(viewportHeight * SHEET_DETENT_SIZE.halfFraction, 0);

    // The half sheet covers 388 of the 844 px; at the default camera the
    // padded envelope's southern edge moves north of the closed-sheet
    // reading by about 3.75 degrees. A stale mid-ease measurement moves it
    // by a fraction of that: 2.1 for the 223 px CI signature, 0.2 for an
    // 18 px first frame. Poll the LATEST envelope: a stale settle may
    // refetch first and the corrected one must follow.
    await expect
      .poll(() => (souths.length ? closedSouth - souths[souths.length - 1] : 0), {
        message: 'the BIA envelope never reflected a camera padded for the full half sheet',
        timeout: 10_000
      })
      .toBeGreaterThan(3);
  });
});
