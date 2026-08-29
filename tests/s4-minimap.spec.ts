import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { gotoApp, search } from './helpers';
import {
  FRAMINGS,
  FRAMING_KEYS,
  framingFitBounds,
} from '../src/config/framings';
import type { FramingKey } from '../src/config/framings';
import { buildMinimapWildfireQueryBody } from '../src/state/minimap-wildfire';

test('the Alaska framing camera includes the wrapped western Aleutians', () => {
  const [[west], [east]] = framingFitBounds(FRAMINGS['alaska-northwest']);
  expect(west).toBeLessThanOrEqual(172);
  expect(east).toBeGreaterThanOrEqual(237);
});

const NADM_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { DROUGHTCAT: 'd2', YEAR_MONTH: '202607' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-132, 37],
            [-112, 37],
            [-112, 57],
            [-132, 57],
            [-132, 37],
          ],
        ],
      },
    },
  ],
};

const NADM_LAND_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { FIPS_CNTRY: 'US' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-180, 10],
            [-40, 10],
            [-40, 85],
            [-180, 85],
            [-180, 10],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { FIPS_CNTRY: 'US' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [172, 52],
            [174, 52],
            [174, 54],
            [172, 54],
            [172, 52],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { FIPS_CNTRY: 'CA' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-142, 41],
            [-51, 41],
            [-51, 85],
            [-142, 85],
            [-142, 41],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { FIPS_CNTRY: 'MX' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-120, 14],
            [-85, 14],
            [-85, 34],
            [-120, 34],
            [-120, 14],
          ],
        ],
      },
    },
  ],
};

const NADM_ANALYSIS_EXCLUSION_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { PRUID: '62' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-100, 68],
            [-90, 68],
            [-90, 75],
            [-100, 75],
            [-100, 68],
          ],
        ],
      },
    },
  ],
};

const WILDFIRE_GEOMETRY_KEYS = new Map(
  FRAMING_KEYS.map((key) => [
    buildMinimapWildfireQueryBody(key).get('geometry'),
    key,
  ]),
);

async function stubWildfireMinimap(
  page: Page,
  counts: Readonly<Partial<Record<FramingKey, number>>> = {},
  onPost?: () => void,
): Promise<void> {
  await page.route(
    '**/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query**',
    (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
        });
      }
      onPost?.();
      const body = new URLSearchParams(route.request().postData() ?? '');
      const key = WILDFIRE_GEOMETRY_KEYS.get(body.get('geometry'));
      if (key === undefined) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Unknown test geometry' } }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: counts[key] ?? 0 }),
      });
    },
  );
  await page.route('**/NOAA_Satellite_Smoke_Detection_*/FeatureServer/0/query**',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
      }),
  );
}

/**
 * S4b: the framing minimap, pointer and keyboard (the S4 design record
 * section 3; D-0.7.0-039/041/054). Passing this file is the ruled
 * precondition for the staged desktop retirement of #panel-region (the
 * CSS hide shipped with this unit); the panel itself stays in the DOM
 * for the mobile sheet until S6, and legacy region= URLs are parsed
 * regardless.
 */

test.describe('S4b minimap', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/NADM-current.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(NADM_FIXTURE),
      }),
    );
    await page.route('**/na/base/northamerica.geojson', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(NADM_LAND_FIXTURE),
      }),
    );
    await page.route(
      '**/Digital_boundary_files/MapServer/0/query?**',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/geo+json',
          body: JSON.stringify(NADM_ANALYSIS_EXCLUSION_FIXTURE),
        }),
    );
  });

  test('renders the nine framings plus ALL, with the ALL radio checked at boot', async ({
    page,
  }) => {
    await gotoApp(page);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-region'),
    ).toHaveCount(9);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-mainland'),
    ).toHaveCount(8);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-lake'),
    ).toHaveCount(8);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-coastline'),
    ).toHaveCount(1);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-mainland').first(),
    ).toHaveAttribute('clip-path', 'url(#shell-minimap-physical-land)');
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-title'),
    ).toHaveText('Jump to region');
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-scale'),
    ).toHaveText('NADM · Jun 2026');
    await expect(
      page.locator('.shell-minimap-map [role="radiogroup"]'),
    ).toHaveAttribute(
      'aria-labelledby',
      'shell-minimap-heading shell-minimap-scale',
    );
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-drawing'),
    ).toHaveAttribute('viewBox', '0 0 660 348');
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-drawing'),
    ).toHaveAttribute('data-geographic-extent', '-188,14,-52,84');
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-hawaii-label'),
    ).toHaveText('Hawaii (enlarged)');
    const pacificPath = page.locator(
      '.shell-minimap-map [data-framing="pacific-coast"]',
    );
    expect(
      await pacificPath.evaluate((element) => element.tagName.toLowerCase()),
    ).toBe('path');
    expect(
      ((await pacificPath.getAttribute('d'))?.match(/L/g) ?? []).length,
    ).toBeGreaterThan(20);
    await expect(pacificPath).toHaveAttribute('data-drought-class', 'D2');
    await expect(pacificPath).toHaveCSS('fill', 'rgb(255, 170, 0)');
    await expect(
      page.locator(
        '.shell-minimap-map .shell-minimap-impact[data-impact-framing="pacific-coast"]',
      ),
    ).toHaveAttribute('stroke-width', /[2-7](?:\.\d+)?/);
    await expect(
      page.locator('.shell-minimap-map [data-framing="boreal-arctic"]'),
    ).toHaveAttribute('data-drought-coverage', 'live-partial');
    expect(
      Number(
        await page
          .locator('.shell-minimap-map [data-framing="boreal-arctic"]')
          .getAttribute('data-not-analyzed-percent'),
      ),
    ).toBeGreaterThan(0);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-drought-legend'),
    ).toHaveCount(0);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-all'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-all'),
    ).toHaveAttribute('aria-label', 'All: fit North America');
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-divider'),
    ).toBeVisible();
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-note'),
    ).toHaveCount(0);
    // The compact minimap door, combined dropdown, then place refinement
    // follow the inline minimap and retain the detailed legacy cameras.
    await expect(page.locator('#shell-region-host > #panel-region')).toBeVisible();
    await expect(
      page.locator('.shell-minimap-popover-wrap + #shell-region-host'),
    ).toHaveCount(1);
    await expect(page.locator('#shell-region-host + #shell-refine-host')).toHaveCount(1);
    await expect(page.locator('#region-select')).toHaveValue('region:washington_state');
    await expect(page.locator('#region-select optgroup')).toHaveCount(2);
    await expect(page.locator('.shell-minimap-map [role="radiogroup"]')).toHaveCount(1);
    await expect(
      page.locator('.shell-minimap-map [data-framing="boreal-arctic"]'),
    ).toHaveAttribute('d', /^[^M]*M[^M]*$/);
  });

  test('loads dated Drought and verified Wildfire metrics only in their modes', async ({
    page,
  }) => {
    let nadmRequests = 0;
    let wildfirePosts = 0;
    await page.route('**/NADM-current.geojson', (route) => {
      nadmRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify(NADM_FIXTURE),
      });
    });
    await stubWildfireMinimap(
      page,
      { 'alaska-northwest': 1 },
      () => wildfirePosts++,
    );

    await gotoApp(page, '?view=brief&cluster=wildfire');
    const minimap = page.locator('.shell-minimap-map');
    await expect(minimap.locator('.shell-minimap-scale')).toHaveText(
      'NIFC / WHP 2023',
    );
    await expect(minimap.locator('.shell-minimap-metric-note')).toContainText(
      'Red marks a current mapped wildfire perimeter',
    );
    await expect(minimap.locator('.shell-minimap-metric-note')).toContainText(
      'a zero count does not establish no active wildfire',
    );
    await expect(minimap.locator('.shell-minimap-metric-note')).toContainText(
      'light below both thresholds, and dark for no data',
    );
    await expect(minimap.locator('.shell-minimap-metric-note')).toHaveAttribute(
      'role',
      'status',
    );
    await expect(minimap.locator('.shell-minimap-metric-note')).toHaveAttribute(
      'aria-atomic',
      'true',
    );
    await expect(minimap.locator('.shell-minimap-canvas')).toHaveAttribute(
      'data-metric-context',
      'wildfire',
    );
    await expect(minimap.locator('.shell-minimap-canvas')).toHaveAttribute(
      'data-wildfire-status',
      'live-partial',
    );
    await expect(
      minimap.locator('[data-framing="alaska-northwest"]'),
    ).toHaveAttribute('data-wildfire-condition', 'mapped-wildfire');
    await expect(
      minimap.locator('[data-framing="alaska-northwest"]'),
    ).toHaveCSS('fill', 'rgb(215, 48, 39)');
    const pacific = minimap.locator('[data-framing="pacific-coast"]');
    await expect(pacific).toHaveAttribute(
      'data-wildfire-condition',
      'moderate-potential',
    );
    await expect(pacific).toHaveAttribute(
      'data-wildfire-region-status',
      'live-partial',
    );
    await expect(pacific).toHaveAttribute(
      'aria-label',
      /static strategic landscape potential, not current fire conditions or a forecast/i,
    );
    await expect(
      minimap.locator('#shell-minimap-partial-pacific-coast rect'),
    ).toHaveAttribute('fill', '#FFE066');
    await expect(
      minimap.locator('[data-framing="plains-prairies"]'),
    ).toHaveAttribute('data-wildfire-condition', 'below-threshold');
    await expect(
      minimap.locator('[data-framing="mexico"]'),
    ).toHaveAttribute('data-wildfire-condition', 'no-data');
    expect(wildfirePosts).toBe(9);
    expect(nadmRequests).toBe(0);

    await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
    await expect(minimap.locator('.shell-minimap-scale')).toHaveText(
      'NADM · Jul 2026',
    );
    expect(nadmRequests).toBe(1);

    await page.locator('.shell-cluster-btn[data-cluster="heat"]').click();
    await expect(minimap.locator('.shell-minimap-metric-note')).toHaveCount(0);
    await page.locator('.shell-cluster-btn[data-cluster="enso"]').click();
    await expect(minimap.locator('.shell-minimap-metric-note')).toHaveCount(0);
  });

  test('the annotated granular drought URL keeps the selected drought metric and regional fills', async ({
    page,
  }) => {
    await gotoApp(
      page,
      '?region=washington_state&layers=hillshade%2Cnadm-drought%2Caiannh%2Cbia-reservations%2Cstates&view=brief',
    );
    const minimap = page.locator('.shell-minimap-map');
    await expect(minimap.locator('.shell-minimap-canvas')).toHaveAttribute(
      'data-metric-context',
      'drought',
    );
    const pacific = minimap.locator('[data-framing="pacific-coast"]');
    await expect(pacific).toHaveAttribute('data-drought-class', 'D2');
    await expect(pacific).toHaveCSS('fill', 'rgb(255, 170, 0)');
    await expect(minimap.locator('.shell-minimap-metric-note')).toHaveCount(0);
  });

  test('uses the legible Hawaii inset proportions from the desktop rail', async ({
    page,
  }) => {
    await gotoApp(page);
    const proportions = await page
      .locator('.shell-minimap-map .shell-minimap-hawaii')
      .evaluate((inset) => {
        const canvas = inset.closest('.shell-minimap-canvas');
        if (!(canvas instanceof HTMLElement))
          throw new Error('Minimap canvas not found');
        const insetRect = inset.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        return {
          left:
            (insetRect.left - canvasRect.left - canvas.clientLeft) /
            canvas.clientWidth,
          top:
            (insetRect.top - canvasRect.top - canvas.clientTop) /
            canvas.clientHeight,
          width: insetRect.width / canvas.clientWidth,
          height: insetRect.height / canvas.clientHeight,
        };
      });

    expect(proportions.left).toBeCloseTo(0.027, 2);
    expect(proportions.top).toBeCloseTo(0.567, 2);
    expect(proportions.width).toBeCloseTo(0.257, 2);
    expect(proportions.height).toBeCloseTo(0.39, 2);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-island').first(),
    ).toHaveCSS('stroke', 'rgb(241, 245, 249)');
  });

  test('removes minimap transitions when reduced motion is requested', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoApp(page);
    const transitionDuration = await page
      .locator('.shell-minimap-map [data-framing="pacific-coast"]')
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(transitionDuration).toBe('0s');
  });

  test('hover adds a soft visual glow without opening a description', async ({
    page,
  }) => {
    await gotoApp(page);
    const pacific = page.locator(
      '.shell-minimap-map [data-framing="pacific-coast"]',
    );
    expect(await pacific.getAttribute('title')).toBeNull();
    await pacific.hover();
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-tooltip'),
    ).toHaveCount(0);
    await expect(pacific).toHaveCSS('stroke', 'rgb(6, 182, 212)');
    // `.shell-minimap-mainland` transitions `filter 0.12s ease`
    // (src/styles/app.css:6147); a one-shot getComputedStyle read right
    // after hover() can still catch the pre-transition `none` on the first
    // frame (measured report, 2026-08-29: 9 flaky events, zero hard
    // failures). toHaveCSS retries against the settled value instead.
    await expect(pacific).toHaveCSS('filter', /drop-shadow/, {
      timeout: 1_000,
    });
    await pacific.focus();
    await expect(pacific).toHaveAttribute(
      'aria-label',
      /Camera-only; selects nothing/,
    );
  });

  test('pointer: choosing a framing writes framing= instead of region= and shows coverage copy', async ({
    page,
  }) => {
    await gotoApp(page);
    await page
      .locator('.shell-minimap-map [data-framing="pacific-coast"]')
      .click();
    await page.waitForFunction(() =>
      window.location.search.includes('framing=pacific-coast'),
    );
    // Camera exclusivity (S2): one camera vocabulary at a time.
    expect(await search(page)).not.toContain('region=');
    // Coverage honesty: the caption carries the user-facing clause.
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-note'),
    ).toContainText(
      'North American Drought Monitor informs the minimap across the border',
    );
    await expect(
      page.locator('.shell-minimap-map [data-framing="pacific-coast"]'),
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('the required framing provenance remains in the accessible name without repeated visible copy', async ({
    page,
  }) => {
    await gotoApp(page);
    const region = page.locator(
      '.shell-minimap-map [data-framing="pacific-coast"]',
    );
    const qualification =
      /an owned simplification, not an authoritative boundary/;
    // Accessible name: label, coverage clause, then the provenance
    // qualification (FramingDef.provenance is required, D-0.7.0-051).
    await expect(region).toHaveAttribute('aria-label', qualification);
    // Pointer hover stays visual-only; no native description popup.
    expect(await region.getAttribute('title')).toBeNull();
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-provenance'),
    ).toHaveCount(0);
    await region.click();
    await expect(page.locator('#region-select')).toHaveValue('framing:pacific-coast');
    // Coverage copy stays a separate sentence; it does not substitute
    // for the geometry provenance.
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-note'),
    ).toContainText(
      'North American Drought Monitor informs the minimap across the border',
    );
  });

  test('keyboard: arrows move focus WITHOUT committing; Enter commits the focused framing', async ({
    page,
  }) => {
    await gotoApp(page);
    const pacific = page.locator(
      '.shell-minimap-map [data-framing="pacific-coast"]',
    );
    await pacific.click();
    await pacific.focus();
    // Arrow browsing is free: focus moves, the committed claim does not
    // (a commit is a camera flight plus a URL write; deferred to
    // Enter/Space per the WAI-ARIA expensive-side-effect allowance).
    await page.keyboard.press('ArrowRight');
    const arid = page.locator('.shell-minimap-map [data-framing="arid-west"]');
    await expect(arid).toBeFocused();
    await expect(arid).toHaveAttribute('aria-checked', 'false');
    await expect(pacific).toHaveAttribute('aria-checked', 'true');
    expect(await search(page)).toContain('framing=pacific-coast');
    // Enter on the focused option commits it: camera claim and URL.
    await page.keyboard.press('Enter');
    await expect(arid).toHaveAttribute('aria-checked', 'true');
    await page.waitForFunction(() =>
      window.location.search.includes('framing=arid-west'),
    );
    // Browsing back without committing leaves the arid claim standing.
    await page.keyboard.press('ArrowLeft');
    await expect(pacific).toBeFocused();
    await expect(arid).toHaveAttribute('aria-checked', 'true');
    expect(await search(page)).toContain('framing=arid-west');
  });

  test('ocean controls enter ENSO, fit one schematic ocean, and preserve the authored framing', async ({
    page,
  }) => {
    await gotoApp(page, '?view=brief&framing=pacific-coast');
    const minimap = page.locator('.shell-minimap-map');
    await expect(minimap.locator('[data-ocean]')).toHaveCount(3);

    const atlantic = minimap.locator('[data-ocean="atlantic"]');
    await expect(atlantic).toHaveAttribute(
      'aria-label',
      /Switch to the El Nino \/ Southern Oscillation sea-surface-temperature anomaly display/,
    );
    await expect(atlantic).toHaveAttribute(
      'aria-label',
      /Schematic click affordance for camera navigation; not a boundary/,
    );
    await atlantic.click();
    await expect
      .poll(async () => {
        const params = new URLSearchParams(await search(page));
        return {
          cluster: params.get('cluster'),
          ocean: params.get('ocean'),
          framing: params.get('framing'),
        };
      })
      .toEqual({
        cluster: 'enso',
        ocean: 'atlantic',
        framing: 'pacific-coast',
      });
    await expect(atlantic).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('input[data-layer-key="sst-anomaly"]')).toBeChecked();
    await expect(minimap.locator('.shell-minimap-note')).toContainText(
      'Ocean view: Atlantic Ocean',
    );
    await expect(minimap.locator('.shell-minimap-note')).toContainText(
      'Preserved land framing: Pacific Coast',
    );
    await expect(
      minimap.locator('[data-framing="pacific-coast"]'),
    ).toHaveAttribute('aria-checked', 'false');

    const arctic = minimap.locator('[data-ocean="arctic"]');
    await arctic.focus();
    await page.keyboard.press('Space');
    await expect
      .poll(async () => new URLSearchParams(await search(page)).get('ocean'))
      .toBe('arctic');
    await expect(arctic).toHaveAttribute('aria-pressed', 'true');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.locator('.shell-minimap-map [data-ocean="arctic"]'),
    ).toHaveAttribute('aria-pressed', 'true');
    const restored = new URLSearchParams(await search(page));
    expect(restored.get('cluster')).toBe('enso');
    expect(restored.get('ocean')).toBe('arctic');
    expect(restored.get('framing')).toBe('pacific-coast');
  });

  test('ALL writes a restorable North America camera and survives reload', async ({
    page,
  }) => {
    await gotoApp(page);
    await page.locator('.shell-minimap-map [data-framing="mexico"]').click();
    await page.waitForFunction(() =>
      window.location.search.includes('framing=mexico'),
    );
    // The Mexico coverage sentence distinguishes the monthly minimap from
    // place and briefing capability.
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-note'),
    ).toContainText(
      'North American Drought Monitor informs this minimap in Mexico',
    );
    await page.locator('.shell-minimap-map .shell-minimap-all').click();
    await page.waitForFunction(
      () => new URLSearchParams(window.location.search).get('framing') === 'all',
    );
    expect(new URLSearchParams(await search(page)).get('region')).toBeNull();
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-all'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-all'),
    ).toHaveAttribute('aria-label', 'All: fit North America');
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-note'),
    ).toHaveCount(0);
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-divider'),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.locator('.shell-minimap-map .shell-minimap-all'),
    ).toHaveAttribute('aria-checked', 'true');
    expect(new URLSearchParams(await search(page)).get('framing')).toBe('all');
    expect(new URLSearchParams(await search(page)).get('region')).toBeNull();
  });
});
