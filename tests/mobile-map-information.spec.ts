import { test, expect, type Page } from '@playwright/test';

import { gotoApp, urlLayers, waitForLayerSettled } from './helpers';
import {
  AIANNH_ROUTE,
  BIA_ROUTE,
  emptyCollectionBody,
  routeGeojson
} from './tribal-fixtures';

async function stubInformationSources(page: Page): Promise<void> {
  const empty = emptyCollectionBody();
  await routeGeojson(page, AIANNH_ROUTE, empty);
  await routeGeojson(page, BIA_ROUTE, empty);
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'text/plain',
      body: 'Synthetic offline response'
    })
  );
}

test.beforeEach(async ({ page }) => {
  await stubInformationSources(page);
});

test.describe('mobile map-information disclosure (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the circular control opens a non-modal region without changing URL state and Escape returns focus', async ({
    page
  }) => {
    await gotoApp(page);

    const button = page.getByRole('button', { name: 'Map information' });
    const panel = page.locator('#map-info-panel');
    const canvasContainer = page.locator('#map .maplibregl-canvas-container');
    const bottomDock = page.locator('#map-bottom-dock');
    const originalUrl = page.url();

    // A focusable descendant proves the dock's inert contract independent of
    // which optional key or temporal control happens to be mounted today.
    await page.evaluate(() => {
      const probe = document.createElement('button');
      probe.id = 'map-info-dock-focus-probe';
      probe.type = 'button';
      probe.textContent = 'Dock focus probe';
      probe.style.position = 'absolute';
      probe.style.width = '1px';
      probe.style.height = '1px';
      probe.style.opacity = '0';
      document.getElementById('map-bottom-dock')?.append(probe);
      probe.focus();
    });
    const dockFocusProbe = page.locator('#map-info-dock-focus-probe');
    await expect(dockFocusProbe).toBeFocused();
    await expect(bottomDock.locator('#map-key-expand')).toHaveCount(1);

    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-controls', 'map-info-panel');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
    const radius = await button.evaluate((element) => getComputedStyle(element).borderRadius);
    expect(radius === '50%' || Number.parseFloat(radius) >= box!.width / 2).toBe(true);

    const rulers = page.locator('.maplibregl-ctrl-scale');
    await expect(rulers).toHaveCount(2);
    const rulerBoxes = await Promise.all([
      rulers.nth(0).boundingBox(),
      rulers.nth(1).boundingBox()
    ]);
    expect(rulerBoxes.every((rulerBox) => rulerBox !== null)).toBe(true);
    const rulerRight = Math.max(
      ...rulerBoxes.map((rulerBox) => rulerBox!.x + rulerBox!.width)
    );
    const rulerTop = Math.min(...rulerBoxes.map((rulerBox) => rulerBox!.y));
    const rulerBottom = Math.max(
      ...rulerBoxes.map((rulerBox) => rulerBox!.y + rulerBox!.height)
    );
    expect(box!.x).toBeGreaterThanOrEqual(rulerRight);
    expect(box!.x - rulerRight).toBeLessThanOrEqual(16);
    expect(box!.y).toBeLessThan(rulerBottom);
    expect(box!.y + box!.height).toBeGreaterThan(rulerTop);
    const rulerStyles = await rulers.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderTopWidth: style.borderTopWidth,
          borderRightWidth: style.borderRightWidth
        };
      })
    );
    for (const style of rulerStyles) {
      expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(style.borderTopWidth).toBe('0px');
      expect(style.borderRightWidth).toBe('0px');
    }

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'region');
    await expect(panel).not.toHaveAttribute('aria-modal', 'true');
    await expect(panel).toHaveAccessibleName('Map information');
    await expect(panel).toBeFocused();
    await expect(canvasContainer).toHaveAttribute('inert', '');
    await expect(bottomDock).toHaveAttribute('inert', '');
    await page.evaluate(() => {
      document.getElementById('map-info-dock-focus-probe')?.focus();
    });
    await expect(dockFocusProbe).not.toBeFocused();
    await expect(panel).toBeFocused();
    await expect.poll(() => page.url()).toBe(originalUrl);

    const stageBox = await page.locator('#map-container').boundingBox();
    const panelBox = await panel.boundingBox();
    const footerBox = await page.locator('#mobile-footer-nav').boundingBox();
    expect(stageBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    const leftInset = panelBox!.x - stageBox!.x;
    const topInset = panelBox!.y - stageBox!.y;
    const rightInset = stageBox!.x + stageBox!.width - (panelBox!.x + panelBox!.width);
    const footerGap = footerBox!.y - (panelBox!.y + panelBox!.height);
    for (const inset of [leftInset, topInset, rightInset, footerGap]) {
      expect(inset).toBeGreaterThanOrEqual(4);
      expect(inset).toBeLessThanOrEqual(16);
    }
    expect(panelBox!.height).toBeGreaterThan((footerBox!.y - stageBox!.y) * 0.9);

    const glass = await panel.evaluate((element) => {
      const root = getComputedStyle(document.documentElement);
      const style = getComputedStyle(element);
      return {
        richBlack: root.getPropertyValue('--rich-black').trim(),
        backgroundColor: style.backgroundColor,
        backdropFilter: style.backdropFilter,
        webkitBackdropFilter: style.getPropertyValue('-webkit-backdrop-filter'),
        borderRadius: style.borderRadius
      };
    });
    expect(glass.richBlack.toLowerCase()).toBe('#004040');
    expect(glass.backgroundColor).toBe('rgba(0, 64, 64, 0.3)');
    expect(glass.borderRadius).toBe('4px');

    await page.evaluate(() => {
      document.documentElement.dataset['mapInfoTestClicks'] = '0';
      const count = (): void => {
        const current = Number(document.documentElement.dataset['mapInfoTestClicks'] ?? '0');
        document.documentElement.dataset['mapInfoTestClicks'] = String(current + 1);
      };
      document.querySelector('#map')?.addEventListener('click', count);
      document
        .querySelector('#map .maplibregl-canvas-container')
        ?.addEventListener('click', count);
    });
    await panel.click({ position: { x: 10, y: 10 } });
    expect(
      await page.evaluate(
        () => document.documentElement.dataset['mapInfoTestClicks']
      )
    ).toBe('0');

    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    await expect(canvasContainer).not.toHaveAttribute('inert', '');
    await expect(bottomDock).not.toHaveAttribute('inert', '');
    await expect.poll(() => page.url()).toBe(originalUrl);
    await page.evaluate(() => {
      document.getElementById('map-info-dock-focus-probe')?.focus();
    });
    await expect(dockFocusProbe).toBeFocused();

    // The same control is also a pointer toggle; no separate close state
    // machine or durable URL token is introduced.
    await button.focus();
    await button.click();
    await expect(panel).toBeVisible();
    await button.click();
    await expect(panel).toBeHidden();
    await expect.poll(() => page.url()).toBe(originalUrl);
    expect([glass.backdropFilter, glass.webkitBackdropFilter]).toContain('blur(15px)');
  });

  test('the right control spine remains above and usable while active-source information stays live', async ({
    page
  }) => {
    await gotoApp(page);

    const infoButton = page.getByRole('button', { name: 'Map information' });
    const panel = page.locator('#map-info-panel');
    const sourceList = page.locator('#map-info-sources');
    const contextLine = page.locator('#map-info-current');
    const ensoButton = page.locator('#hazard-rail button[data-preset="hazard-enso"]');
    const satelliteButton = page.locator('.basemap-switcher-btn');

    await infoButton.click();
    await expect(panel).toBeVisible();
    await expect(sourceList).toContainText('North American Drought Monitor');

    // The license credits (owner direction 2026-08-31): the panel is the
    // only credits surface, so the live per-source attribution strings,
    // links included, must render here.
    const creditsLine = page.locator('#map-info-attribution');
    await expect(creditsLine).toContainText('OpenStreetMap');
    expect(await creditsLine.locator('a').count()).toBeGreaterThan(0);

    // W2-D8: the panel opens with what it uniquely adds (the active view
    // and the basemap state), never a verbatim restatement of the on-map
    // key aria text that sits directly beneath it.
    await expect(contextLine).toContainText(
      'Active view: North American Drought Monitor.'
    );
    await expect(contextLine).toContainText('basemap');
    const keyAria =
      (await page.locator('#map-key').getAttribute('aria-label')) ?? '';
    expect(keyAria.length).toBeGreaterThan(0);
    expect(((await contextLine.textContent()) ?? '').includes(keyAria)).toBe(
      false
    );

    for (const control of [
      page.locator('#share-btn'),
      page.locator('#reset-btn'),
      ensoButton,
      page.locator('#hazard-rail button[data-preset="hazard-fire"]'),
      page.locator('#hazard-rail button[data-preset="hazard-drought"]'),
      page.locator('#hazard-rail button[data-preset="hazard-heat"]'),
      satelliteButton,
      infoButton
    ]) {
      await expect(control).toBeVisible();
    }

    const stackOrder = await page.evaluate(() => {
      const z = (selector: string): number => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return Number.NEGATIVE_INFINITY;
        return Number.parseInt(getComputedStyle(element).zIndex, 10);
      };
      return {
        panel: z('#map-info-panel'),
        utility: z('.map-overlay-controls'),
        hazards: z('#hazard-rail'),
        satellite: z('.basemap-switcher-control'),
        info: z('#map-info-btn')
      };
    });
    expect(stackOrder.utility).toBeGreaterThan(stackOrder.panel);
    expect(stackOrder.hazards).toBeGreaterThan(stackOrder.panel);
    expect(stackOrder.satellite).toBeGreaterThan(stackOrder.panel);
    expect(stackOrder.info).toBeGreaterThan(stackOrder.panel);

    // A click that would be intercepted by a fullscreen modal must remain
    // actionable. It flows through the normal preset controller, updates the
    // shareable URL, and the open panel re-renders from the same registry.
    await ensoButton.click();
    await expect
      .poll(async () => [...(await urlLayers(page))].sort())
      .toEqual(['aiannh', 'sst-anomaly']);
    await waitForLayerSettled(page, 'sst-anomaly');
    await expect(ensoButton).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toBeVisible();
    await expect(infoButton).toHaveAttribute('aria-expanded', 'true');
    await expect(sourceList).toContainText('Ocean Temperature Anomaly');
    await expect(sourceList).not.toContainText('North American Drought Monitor');
    await expect(contextLine).toContainText(
      'Active view: Ocean Temperature Anomaly.'
    );

    // The existing Satellite button remains equally usable above the panel.
    await expect(satelliteButton).toHaveAttribute('aria-pressed', 'true');
    await satelliteButton.click();
    await expect(satelliteButton).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveURL(/(?:\?|&)basemap=default(?:&|$)/);
    await expect(panel).toBeVisible();
  });
});

test.describe('still-loading sources stay visible during live activation (W2-D6)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the info panel lists a loading NIFC source and the Fire key names its loading section', async ({
    page
  }) => {
    const fireFixture = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            attr_UniqueFireIdentifier: 'w2-d6-fire-1',
            attr_IncidentName: 'Loading Fixture',
            attr_IncidentTypeCategory: 'WF',
            Density: 'Light',
            dn: 5
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-121, 44],
                [-120, 44],
                [-120, 45],
                [-121, 44]
              ]
            ]
          }
        }
      ]
    };
    // SPC and smoke resolve immediately; the NIFC perimeter response is
    // HELD so the activation is genuinely in flight when we look.
    await page.route(
      (url) =>
        url.href.includes('NOAA_Satellite_Smoke_Detection') ||
        url.href.includes('/SPC_firewx/MapServer/1/query'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(fireFixture)
        })
    );
    let releaseNifc: (() => void) | null = null;
    const nifcGate = new Promise<void>((resolve) => {
      releaseNifc = resolve;
    });
    await page.route(
      (url) => url.href.includes('WFIGS_Interagency_Perimeters_Current'),
      async (route) => {
        await nifcGate;
        try {
          await route.fulfill({
            status: 200,
            contentType: 'application/geo+json',
            body: JSON.stringify(fireFixture)
          });
        } catch {
          // The page may already be closing when the gate releases.
        }
      }
    );

    await gotoApp(page);
    await page.locator('#hazard-rail button[data-preset="hazard-fire"]').click();

    // The Fire key renders the SPC scale AND names the still-loading NIFC
    // section as a placeholder row instead of omitting it (W2-D6).
    const key = page.locator('#map-key');
    await expect(key.locator('[data-spc-fire-weather-key]')).toBeVisible();
    await expect(key.locator('[data-nifc-perimeter-key]')).toContainText(
      'NIFC WFIGS current mapped perimeters'
    );
    await expect(
      key.locator('[data-key-loading="nifc-fires"]')
    ).toContainText('loading');

    // The info panel lists the loading source with its loading status.
    await page.getByRole('button', { name: 'Map information' }).click();
    const sourceList = page.locator('#map-info-sources');
    const nifcRow = sourceList.locator('li', {
      hasText: 'Current Mapped Fire Perimeters (NIFC)'
    });
    await expect(nifcRow).toHaveCount(1);
    await expect(nifcRow.locator('.map-info-source-state')).toHaveText(
      'loading...'
    );

    // Release the held response: the placeholder resolves into the real
    // perimeter rows and the panel row leaves the loading state.
    releaseNifc?.();
    await expect(key.locator('[data-key-loading="nifc-fires"]')).toHaveCount(0, {
      timeout: 15_000
    });
    await expect(nifcRow.locator('.map-info-source-state')).not.toHaveText(
      'loading...',
      { timeout: 15_000 }
    );
  });
});

test.describe('map information reaches the desktop and stays out of embeds', () => {
  // Owner direction 2026-08-19: the round bottom-right button carries a
  // question mark, and it is THIS disclosure rather than MapLibre's
  // attribution circle beside it. The panel was desktop-capable all along
  // (it reads the same registry); only its seat was missing.
  test('a desktop viewport offers the question-mark disclosure and opens it in place', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoApp(page);

    const button = page.locator('#map-info-btn');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-label', 'Map information');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#map-info-panel')).toBeHidden();

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('#map-info-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Map information');
    // The disclosure is ephemeral chrome and never enters URL state.
    expect(await page.evaluate(() => window.location.search)).not.toContain(
      'info'
    );

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  test('a 400x600 embed seats the information disclosure as its credits surface', async ({ page }) => {
    // Owner direction 2026-08-31 (superseding the embed-hidden contract):
    // with MapLibre's attribution control removed, the question-mark panel
    // is the iframe's reachable credits surface, closed until asked for.
    await page.setViewportSize({ width: 400, height: 600 });
    await gotoApp(page, '?embed=true');
    await expect(page.locator('#map-info-btn')).toBeVisible();
    await expect(page.locator('#map-info-panel')).toBeHidden();
  });
});
