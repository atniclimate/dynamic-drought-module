import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } from '../src/config/clusters';
import { URLS } from '../src/config/urls';
import { gotoApp } from './helpers';

/**
 * A minimal NWS point-heat stub (mirrors `stubBrowserNwsHeat` in
 * `tests/heat-h2-point-heat.spec.ts`, kept local rather than shared across
 * spec files): answers the Worker-wrapped NWS proxy route with a fixed
 * office/grid and three populated grid metrics, so the M19 disclosure-state
 * cases below never depend on a live network. Coordinates in the fixture
 * URLs are fixed and not read from the request: the NWS `/points/` response
 * always claims the same downstream gridpoints path.
 */
const NWS_PROXY_ROUTE_A11Y = new RegExp(
  `^${URLS.workerProxy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/proxy\\?url=${encodeURIComponent(
    `${URLS.nwsApi}/`
  )}`
);

function nwsA11yUpstreamUrl(requestUrl: string): string {
  const request = new URL(requestUrl);
  const worker = new URL(URLS.workerProxy);
  const upstream = request.searchParams.get('url');
  if (
    request.origin !== worker.origin ||
    request.pathname !== '/proxy' ||
    upstream === null ||
    !upstream.startsWith(`${URLS.nwsApi}/`)
  ) {
    throw new Error(`Expected a Worker-wrapped NWS URL, received ${requestUrl}`);
  }
  return upstream;
}

async function stubGridGuidance(page: Page): Promise<void> {
  await page.route(NWS_PROXY_ROUTE_A11Y, (route) => {
    const url = new URL(nwsA11yUpstreamUrl(route.request().url()));
    let body: unknown;
    if (url.pathname.startsWith('/points/')) {
      body = {
        properties: {
          forecastGridData: 'https://api.weather.gov/gridpoints/TOP/31,80',
          observationStations:
            'https://api.weather.gov/gridpoints/TOP/31,80/stations',
          forecast: 'https://api.weather.gov/gridpoints/TOP/31,80/forecast',
          cwa: 'TOP',
          gridId: 'TOP'
        }
      };
    } else if (url.pathname === '/gridpoints/TOP/31,80/stations') {
      body = { type: 'FeatureCollection', features: [] };
    } else if (url.pathname === '/gridpoints/TOP/31,80/forecast') {
      body = {
        properties: { updateTime: '2026-07-29T11:00:00+00:00', periods: [] }
      };
    } else if (url.pathname === '/gridpoints/TOP/31,80') {
      body = {
        properties: {
          updateTime: '2026-07-29T10:00:00+00:00',
          temperature: {
            uom: 'wmoUnit:degC',
            values: [{ validTime: '2026-07-29T00:00:00+00:00/P2D', value: 31 }]
          },
          apparentTemperature: {
            uom: 'wmoUnit:degC',
            values: [
              { validTime: '2026-07-30T12:00:00+00:00/PT3H', value: 34 }
            ]
          },
          heatIndex: {
            uom: 'wmoUnit:degC',
            values: [
              { validTime: '2026-07-30T12:00:00+00:00/PT3H', value: 36 }
            ]
          }
        }
      };
    } else if (url.pathname === '/alerts/active') {
      body = { type: 'FeatureCollection', features: [] };
    } else {
      return route.abort();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(body)
    });
  });
}

/**
 * Impact briefing panel accessibility (critical-review #16, WCAG 2.4.3 / 2.1.2).
 * The panel is a role="dialog"; while open it must contain keyboard focus (so a
 * keyboard user is never dropped onto the canvas, which has no keyboard path),
 * announce itself modal, and close on Escape.
 *
 * The panel is opened here via the `?select=state:WA` deep link (a boot-time,
 * keyboard-independent path). The focus-RESTORE-to-opener half of #16 needs a
 * focusable opener (the sidebar keyboard trigger tracked as #9) and is exercised
 * once that lands; this spec covers the containment, modality, and Escape close.
 */
test.describe('impact panel accessibility', () => {
  test('opens modal with focus on close, traps Tab, and closes on Escape', async ({ page }) => {
    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    // The deep link fetches the bundled state boundary, then opens the panel.
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // While open it is modal to assistive tech and focus sits on the close button.
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    const closeBtn = panel.locator('.impact-panel-close');
    await expect(closeBtn).toBeFocused();

    // Tab containment: shift-Tab from the first focusable (the close button)
    // wraps to the last focusable inside the panel, never escaping to the canvas.
    await page.keyboard.press('Shift+Tab');
    const stillInside = await panel.evaluate((el) => el.contains(document.activeElement));
    expect(stillInside).toBe(true);

    // Escape closes the panel and clears the modal flag.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 5_000 });
    await expect(panel).toHaveAttribute('aria-modal', 'false');
  });

  test('the region briefing trigger opens the state briefing and restores focus (#9, #16)', async ({
    page
  }) => {
    // Pins region=washington_state, anchored to the WA state briefing.
    // The region briefing trigger lives in the region panel, which is a
    // console-only "where" control since U3e (D-0.7.0-009: Brief leads with
    // the place search), so exercise the trigger in console mode.
    await gotoApp(page, '?region=washington_state&view=console');

    const trigger = page.locator('#region-briefing-btn');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('Washington');

    // Open via the keyboard-reachable trigger (focus, then Enter).
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // The briefing describes the anchored state (its own title), not the viewport.
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');

    // Closing returns focus to the trigger (the opener), not the body: the
    // focus-restore half of #16, exercised now that a keyboard opener exists.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 5_000 });
    await expect(trigger).toBeFocused();
  });

  test('Tab reaches Technical information after resources and wraps within the modal', async ({ page }) => {
    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(panel.locator('.impact-horizon-loading')).toHaveCount(0);
    const lastResource = panel.locator('.impact-resources a[href]').last();
    const technical = panel.locator('.impact-technical-information');
    const summary = technical.locator('summary');
    const close = panel.locator('.impact-panel-close');

    // Resource-catalog hydration replaces the whole body independently of
    // horizon hydration. Wait for the deterministic WA catalog row so that
    // replacement cannot retire the focused last link between focus and Tab.
    await expect(
      panel.getByRole('link', { name: 'Agricultural drought relief information' })
    ).toBeVisible();
    await lastResource.focus();
    await page.keyboard.press('Tab');
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(technical).toHaveJSProperty('open', true);
    await expect(technical.locator('#impact-technical-drought')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(summary).toBeFocused();
  });

  test('a region spanning several states shows no briefing trigger (#9)', async ({ page }) => {
    // The national framing has no single briefable boundary, so no trigger.
    await gotoApp(page, '?region=national');
    await expect(page.locator('#region-briefing-btn')).toBeHidden();
  });

  test('after a minimap framing click elsewhere the briefing door says it opens the last selected place, or hides', async ({
    page
  }) => {
    // Start anchored to Washington in Brief, where the inline minimap is
    // visible (the region panel is console-only for the door's OWN click
    // per the test above; the minimap itself renders only in Brief).
    await gotoApp(page, '?region=washington_state&view=brief');
    const trigger = page.locator('#region-briefing-btn');
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('Washington');

    // A framing camera takes the view away from Washington without any
    // region= choice (S2 camera exclusivity).
    await page.locator('.shell-minimap-map [data-framing="southeast-gulf"]').click();
    await page.waitForFunction(() => window.location.search.includes('framing=southeast-gulf'));

    // The door never keeps naming a place the camera has left (D1 M4,
    // found-025): it hides rather than keep reading "Impact briefing:
    // Washington" under the Southeast & Gulf Coast camera.
    await expect(trigger).toBeHidden();
  });

  test('every NWS grid guidance disclosure starts closed in every HAZARD_CLUSTER_KEYS mode', async ({
    page
  }) => {
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    // Registered once: page.route persists across the repeated gotoApp
    // navigations in the loop below (DR-113: every mode is enumerated from
    // HAZARD_CLUSTER_KEYS, never a literal four-item list).
    await stubGridGuidance(page);

    for (const key of HAZARD_CLUSTER_KEYS) {
      const token = HAZARD_CLUSTERS[key].urlToken;
      const clusterQuery = token ? `&cluster=${token}` : '';
      await gotoApp(page, `?select=state:WA${clusterQuery}`);

      const panel = page.locator('#impact-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      const series = panel.locator('.point-heat-series');
      await expect(series.first(), `${key}: grid guidance renders`).toBeVisible();
      expect(
        await series.count(),
        `${key}: at least one NWS grid disclosure renders`
      ).toBeGreaterThan(0);
      await expect(
        panel.locator('.point-heat-series[open]'),
        `${key}: no NWS grid disclosure starts open`
      ).toHaveCount(0);
    }
  });

  test("a reader's open or closed briefing disclosure survives a briefing refresh", async ({
    page
  }) => {
    await page.clock.setFixedTime('2026-07-29T12:30:00+00:00');
    await stubGridGuidance(page);
    // Delay the independent F3 resource-catalog rehydrate so its own,
    // LATER refreshOpenBriefing call is guaranteed to land after this
    // test's toggle below, rather than racing it.
    await page.route(/\/data\/resources\//, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });
    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const series = panel.locator('.point-heat-series');
    await expect(series.first()).toBeVisible();
    await expect(panel.locator('.point-heat-series[open]')).toHaveCount(0);

    const heatIndexSeries = panel.locator('.point-heat-series', {
      hasText: 'Heat index'
    });
    await heatIndexSeries.locator('summary').click();
    await expect(heatIndexSeries).toHaveAttribute('open', '');
    await expect(panel.locator('.point-heat-series[open]')).toHaveCount(1);

    // The F3 resource rehydrate lands later and calls refreshOpenBriefing a
    // second time: waiting for its known WA fixture row proves a refresh
    // happened, not just the panel's first paint.
    await expect(
      panel.getByRole('link', { name: 'Agricultural drought relief information' })
    ).toBeVisible();

    await expect(panel.locator('.point-heat-series[open]')).toHaveCount(1);
    await expect(heatIndexSeries).toHaveAttribute('open', '');
  });
});
