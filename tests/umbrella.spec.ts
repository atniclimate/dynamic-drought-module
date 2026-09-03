import { test, expect } from '@playwright/test';
import {
  gotoApp,
  layerCheckbox,
  urlLayers,
  openTribalNationsDetails,
  ROLE_GROUPS
} from './helpers';
import { stubRecentSatellite } from './satellite-fixture';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  routeAllTribalFixtures,
  routeBoundary,
  syntheticAiannhBody,
  syntheticBiaBody
} from './tribal-fixtures';
import { installMinimapAnalysisStubs } from './minimap-fixtures';

/**
 * The Tribal Nations umbrella UI (Unit F, D-0.7.0-033): the featured group
 * card in the Place role group plus the eager Brief-door action. Built to
 * the 2026-07-15 Codex front-end consultation: two separate
 * controls (a command button and a details disclosure), permanently mounted
 * member rows behind a native `hidden` region, group provenance controlled
 * by the role group's Sources state, and the compact Brief action that
 * satisfies "prominent in the initial display" on the door a bare URL
 * actually opens. All live responses are synthetic fixtures.
 */

const UMBRELLA = '[data-layer-group-key="tribal-nations"]';
const CTA = `${UMBRELLA} .layer-umbrella-cta`;
const DETAILS_TOGGLE = '[data-layer-group-toggle="tribal-nations"]';
const CONTROLS = '#tribal-nations-layer-controls';
const COUNT = `${UMBRELLA} .layer-umbrella-count`;
// The deployer own-data slots stay outside the umbrella; its granular
// disclosure carries the two live present-day representations.
const MEMBERS = ['aiannh', 'bia-reservations'] as const;
const BUTTON_SET = ['aiannh', 'bia-reservations'] as const;

test.describe('the Tribal Nations umbrella (console catalog)', () => {
  test('structure: the four role groups hold, the umbrella is a card inside Place, members stay mounted', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    // The umbrella is NOT a fifth role group; the four-group contract holds.
    await expect(page.locator('#layer-toggles .layer-group')).toHaveCount(ROLE_GROUPS.length);

    const umbrella = page.locator(UMBRELLA);
    await expect(umbrella).toBeVisible();
    // A group container, never a synthetic layer row.
    await expect(umbrella).toHaveAttribute('role', 'group');
    expect(await umbrella.getAttribute('data-layer-key')).toBeNull();

    // The command button: accessible name, effect description, no
    // disclosure semantics (it is a command, not a toggle).
    const cta = page.locator(CTA);
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAccessibleName('Show Tribal Nations layers');
    expect(await cta.getAttribute('aria-expanded')).toBeNull();
    expect(await cta.getAttribute('aria-pressed')).toBeNull();

    // Members are permanently mounted (hidden, not unmounted): read-only
    // locators resolve the live pair with their exact contract attributes.
    for (const key of MEMBERS) {
      await expect(page.locator(`${CONTROLS} input[data-layer-key="${key}"]`)).toHaveCount(1);
      await expect(page.locator(`${CONTROLS} [data-layer-status="${key}"]`)).toHaveCount(1);
    }
    // ...but leave the tab order and visible tree while collapsed.
    await expect(page.locator(CONTROLS)).toBeHidden();

    // The default boot selects the two present-day layers (Unit I narrowed
    // the passive default; since D-0.7.0-064 the button commands the same
    // pair, so a default boot reads fully selected).
    await expect(page.locator(COUNT)).toHaveText('2 of 2 selected');
  });

  test('the details disclosure reveals the member rows with correct aria wiring, keyboard included', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    const toggle = page.locator(DETAILS_TOGGLE);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', 'tribal-nations-layer-controls');

    // Keyboard: activate the disclosure with Enter, reach a member row.
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(CONTROLS)).toBeVisible();
    await expect(page.locator(`${CONTROLS} input[data-layer-key="aiannh"]`)).toBeVisible();

    // Collapse leaves focus on the disclosure button (no focus stranding).
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(CONTROLS)).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('the command button activates the present-day pair from all-off, never the deployer slots', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=');

    await expect(page.locator(COUNT)).toHaveText('0 of 2 selected');
    await page.locator(CTA).click();

    for (const key of BUTTON_SET) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }
    // The deployer slots are ui-hidden while off (Unit I): no row at all.
    await expect(page.locator('input[data-layer-key="tribal"]')).toHaveCount(0);
    await expect(page.locator('input[data-layer-key="treaty"]')).toHaveCount(0);
    await expect(page.locator(COUNT)).toHaveText('2 of 2 selected');

    // The activations flow through the shared command into the URL.
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return BUTTON_SET.every((key) => layers.has(key));
        },
        { timeout: 25_000 }
      )
      .toBe(true);
  });

  test('a partial selection is completed, not reset (the second-click semantics)', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=aiannh');

    await expect(page.locator(COUNT)).toHaveText('1 of 2 selected');
    await page.locator(CTA).click();
    for (const key of BUTTON_SET) {
      await expect(layerCheckbox(page, key)).toBeChecked();
    }
    await expect(page.locator(COUNT)).toHaveText('2 of 2 selected');
  });

  test('an all-on click is a clean no-op and the button stays enabled and reusable', async ({
    page
  }) => {
    // Count the live requests so the no-op is proven at the network layer,
    // not only in the URL.
    let liveRequests = 0;
    const counted = async (pattern: string, body: unknown): Promise<void> => {
      await routeBoundary(page, pattern, (route) => {
        liveRequests += 1;
        void route.fulfill({
          contentType: 'application/geo+json',
          body: JSON.stringify(body)
        });
      });
    };
    await counted(AIANNH_ROUTE, syntheticAiannhBody());
    await counted(BIA_ROUTE, syntheticBiaBody());

    await gotoApp(page, '?view=console&layers=aiannh,bia-reservations');
    await expect(page.locator(COUNT)).toHaveText('2 of 2 selected');
    const before = await urlLayers(page);

    // Wait for the live-request stream to go QUIET before snapshotting: the
    // boot region fit's debounced viewport refresh can legitimately land
    // after the pills settle, and it must not be mistaken for CTA work.
    let lastSeen = -1;
    await expect
      .poll(
        () => {
          const stable = liveRequests === lastSeen;
          lastSeen = liveRequests;
          return stable;
        },
        { intervals: [700], timeout: 20_000 }
      )
      .toBe(true);
    const requestsBefore = liveRequests;

    const cta = page.locator(CTA);
    await expect(cta).toBeEnabled();
    await cta.click();
    // Give a would-be regression time to fire, then prove nothing moved.
    await page.waitForTimeout(750);
    expect(liveRequests).toBe(requestsBefore);
    expect([...(await urlLayers(page))].sort()).toEqual([...before].sort());
    await expect(page.locator(COUNT)).toHaveText('2 of 2 selected');
    await expect(cta).toBeEnabled();

    // Reusability (never a once-only handler): turn ONE member off, click
    // again, and only the missing member returns.
    await openTribalNationsDetails(page);
    await layerCheckbox(page, 'aiannh').uncheck();
    await expect(page.locator(COUNT)).toHaveText('1 of 2 selected');
    await cta.click();
    await expect(layerCheckbox(page, 'aiannh')).toBeChecked();
    await expect(page.locator(COUNT)).toHaveText('2 of 2 selected');
  });

  test('keyboard: the CTA and disclosure are native tab stops; collapsed children are skipped', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=');

    // Native keyboard activation of the CTA does the real work.
    const cta = page.locator(CTA);
    await cta.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return BUTTON_SET.every((key) => layers.has(key));
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // Tab from the CTA: the next stop is the details disclosure, never a
    // collapsed (hidden) member checkbox.
    await cta.focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(DETAILS_TOGGLE)).toBeFocused();

    // Expand from the keyboard: the FIRST member checkbox becomes the next
    // tab stop.
    await page.keyboard.press('Enter');
    await expect(page.locator(DETAILS_TOGGLE)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(page.locator(`${CONTROLS} input[data-layer-key="aiannh"]`)).toBeFocused();
  });

  test('provenance stays controlled by Sources, in both disclosure orders', async ({ page }) => {
    await gotoApp(page, '?view=console');

    const place = page
      .locator('.layer-group')
      .filter({ has: page.locator('input[data-layer-key="aiannh"]') });
    const note = page.locator('[data-provenance="tribal-nations"]');
    const sources = place.locator('.layer-group-sources-toggle');

    // Order 1: Sources first. The note shows while member rows stay
    // collapsed (group provenance is not a child control).
    await sources.click();
    await expect(note).toBeVisible();
    await expect(page.locator(CONTROLS)).toBeHidden();

    // Then details: member rows appear WITH their source lines.
    await openTribalNationsDetails(page);
    await expect(
      page.locator(`${CONTROLS} .layer-toggle`).first().locator('.layer-toggle-source')
    ).toBeVisible();

    // Order 2 (fresh state): details first, then Sources.
    await sources.click(); // close sources
    await expect(note).toHaveCount(0);
    await expect(page.locator(CONTROLS)).toBeVisible(); // details still open
    await sources.click(); // reopen sources
    await expect(note).toBeVisible();
  });
});

test.describe('URL intent durability (the final-pass finding 1 pair)', () => {
  /** Gate both live routes open so no activation can settle. */
  async function holdAllTribal(page: import('@playwright/test').Page): Promise<() => void> {
    const releases: Array<() => void> = [];
    const hold = async (pattern: string, body: unknown): Promise<void> => {
      const gate = new Promise<void>((resolve) => releases.push(resolve));
      await routeBoundary(page, pattern, async (route) => {
        await gate;
        await route.fulfill({
          contentType: 'application/geo+json',
          body: JSON.stringify(body)
        });
      });
    };
    await hold(AIANNH_ROUTE, syntheticAiannhBody());
    await hold(BIA_ROUTE, syntheticBiaBody());
    return () => releases.forEach((release) => release());
  }

  test('the umbrella command enters the URL the moment it is clicked, not when agencies answer', async ({
    page
  }) => {
    const release = await holdAllTribal(page);
    await gotoApp(page, '?view=console&layers=');

    await page.locator(CTA).click();
    // The button's pair is in the URL WHILE the requests are still held: a
    // share or reload in this window reproduces the user's intent.
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return BUTTON_SET.every((key) => layers.has(key));
        },
        { timeout: 5_000 }
      )
      .toBe(true);
    release();
  });

  test('a user toggle during boot serializes immediately alongside the held default set', async ({
    page
  }) => {
    const release = await holdAllTribal(page);
    // holdAllTribal keeps the default boundary layers loading on purpose, so
    // the boot cannot settle: opt out of the boot-idle wait.
    await gotoApp(page, '?view=console', { bootIdle: false });

    // Places is bundled (no live dependency) and not an umbrella member,
    // so its row is actionable without the details disclosure. The held
    // default set is the present-day pair.
    await layerCheckbox(page, 'places').check();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return (
            layers.has('places') &&
            (['aiannh', 'bia-reservations'] as const).every((key) => layers.has(key))
          );
        },
        { timeout: 5_000 }
      )
      .toBe(true);
    release();
  });
});

test.describe('partial-outage visibility (the final-pass finding 2)', () => {
  // The Unit I default boot selects the two present-day layers; the BIA
  // outage unchecks one, leaving one selected and one unavailable.
  const HEALTH_DEGRADED = '1 of 2 selected · 1 unavailable';
  const BRIEF_HEALTH =
    '.tribal-nations-brief-row:not(.tribal-nations-at-hand-row) .tribal-nations-health';

  async function oneAgencyDown(page: import('@playwright/test').Page): Promise<void> {
    await routeGeojsonPair(page);
    await routeBoundary(page, BIA_ROUTE, (route) => route.abort('failed'));
  }
  async function routeGeojsonPair(page: import('@playwright/test').Page): Promise<void> {
    await routeBoundary(page, AIANNH_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(syntheticAiannhBody())
      })
    );
  }

  test('desktop Brief: the action health line names the outage', async ({ page }) => {
    await oneAgencyDown(page);
    // The briefing (which hosts the action row) is opened by the select=
    // deep link: since S2 (D-0.7.0-041) no boot opens one unsolicited.
    await gotoApp(page, '?select=state:WA');
    await expect(page.locator(BRIEF_HEALTH)).toHaveText(HEALTH_DEGRADED, {
      timeout: 25_000
    });
  });

  test('brief embed at 400x600: the outage is visible with zero island requests', async ({
    page
  }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await stubRecentSatellite(page);
    const islandRequests: string[] = [];
    page.on('request', (req) => {
      if (/island-[^/]*\.js/.test(req.url())) islandRequests.push(req.url());
    });
    await oneAgencyDown(page);
    await installMinimapAnalysisStubs(page);
    // select= opens the briefing (the boot-time explicit opener since
    // S2, D-0.7.0-041); select= keeps the brief door, so the embed still
    // never mounts the island.
    await page.goto('?embed=true&view=brief&select=state:WA', {
      waitUntil: 'domcontentloaded'
    });
    await expect(page.locator('#impact-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(BRIEF_HEALTH)).toHaveText(HEALTH_DEGRADED, {
      timeout: 25_000
    });
    expect(islandRequests).toEqual([]);
  });
});

test.describe('partial-outage visibility on mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the at-hand health line names the outage', async ({ page }) => {
    await routeBoundary(page, AIANNH_ROUTE, (route) =>
      route.fulfill({
        contentType: 'application/geo+json',
        body: JSON.stringify(syntheticAiannhBody())
      })
    );
    await routeBoundary(page, BIA_ROUTE, (route) => route.abort('failed'));
    await gotoApp(page, '?view=console');

    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#sheet-at-hand')).toBeVisible();
    await expect(page.locator('#tribal-nations-at-hand-health')).toHaveText(
      '1 of 2 selected · 1 unavailable',
      { timeout: 25_000 }
    );
  });
});

test.describe('the Brief-door Tribal Nations action', () => {
  test('a bare desktop boot (the Brief door) shows the compact action', async ({ page }) => {
    await gotoApp(page);
    const action = page.locator('#tribal-nations-brief-action');
    await expect(action).toBeVisible();
    await expect(action).toHaveAccessibleName('Show Tribal Nations layers');
  });

  test('activating from the Brief action reaches the map on desktop too', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=');
    const action = page.locator('#tribal-nations-brief-action');
    await expect(action).toBeVisible();
    await action.click();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return BUTTON_SET.every((key) => layers.has(key));
        },
        { timeout: 25_000 }
      )
      .toBe(true);
  });

  test('an exited embed regains the action in the Brief head (Codex S2/E1 integration finding 2)', async ({
    page
  }) => {
    await routeAllTribalFixtures(page);
    await installMinimapAnalysisStubs(page);
    await stubRecentSatellite(page);
    // An embed boot hosts the action on the impact panel only (the
    // sidebar is collapsed); expanding exits embed mode and the Brief
    // head must gain the one instance so the umbrella's default-Brief
    // visibility guarantee survives the exit.
    await page.goto('?embed=true', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    await page.locator('#sidebar-expand').click();
    await expect(page.locator('#app')).not.toHaveClass(/\bembed\b/);
    const action = page.locator('#tribal-nations-brief-action');
    await expect(action).toBeVisible();
    await expect(action).toHaveCount(1);
  });
});

test.describe('the Brief-door action at 400px (mobile and embed)', () => {
  test.use({ viewport: { width: 400, height: 600 } });

  test('non-embed mobile Brief: the at-hand mirror is the reachable, operable instance', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=');

    // The Place door opens the at-hand summary at the half detent (the
    // surface that REPLACES the report on mobile).
    await page.locator('#mobile-footer-nav button[data-tab="place"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sheet-at-hand')).toBeVisible();

    const atHandAction = page.locator('#tribal-nations-at-hand-action');
    await expect(atHandAction).toBeVisible();
    await expect(atHandAction).toHaveAccessibleName('Show Tribal Nations layers');
    // The report-hosted twin is not this surface's instance.
    await expect(page.locator('#tribal-nations-brief-action')).not.toBeVisible();

    await atHandAction.click();
    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return BUTTON_SET.every((key) => layers.has(key));
        },
        { timeout: 25_000 }
      )
      .toBe(true);
  });

  test('the brief embed keeps the C1 boundary: the action works with zero island requests', async ({
    page
  }) => {
    await routeAllTribalFixtures(page);
    await installMinimapAnalysisStubs(page);
    await stubRecentSatellite(page);
    const islandRequests: string[] = [];
    page.on('request', (req) => {
      if (/island-[^/]*\.js/.test(req.url())) islandRequests.push(req.url());
    });

    // An explicit all-off brief embed: the action must do real work here.
    // `view=brief` is explicit because a bare `layers=` would legacy-route
    // the embed to the console door (the two-doors rule). select= opens
    // the briefing that hosts the action (since S2, D-0.7.0-041, no boot
    // opens one unsolicited).
    await page.goto('?embed=true&view=brief&layers=&select=state:WA', {
      waitUntil: 'domcontentloaded'
    });
    await expect(page.locator('#app')).toHaveClass(/\bembed\b/);
    await expect(page.locator('#app')).toHaveClass(/\bview-brief\b/);
    await expect(page.locator('#impact-panel')).toBeVisible({ timeout: 15_000 });

    const action = page.locator('#tribal-nations-brief-action');
    await expect(action).toBeVisible();
    await action.click();

    await expect
      .poll(
        async () => {
          const layers = await urlLayers(page);
          return BUTTON_SET.every((key) => layers.has(key));
        },
        { timeout: 25_000 }
      )
      .toBe(true);

    // The eager action must not have pulled the catalog chunk.
    await expect(page.locator('input[data-layer-key]')).toHaveCount(0);
    expect(islandRequests).toEqual([]);
  });
});
