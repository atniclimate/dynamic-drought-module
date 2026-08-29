import { expect, test, type Frame, type Page } from '@playwright/test';
import type { FeatureCollection } from 'geojson';

import { gotoApp, search } from './helpers';
import { routeAllTribalFixtures } from './tribal-fixtures';

const PREVIEW_URL = 'http://localhost:4173/';
const PLACE_ROOT = '#place-studio-root';
const LAYERS_ROOT = '#layers-studio-root';

const STATE_COLLECTION: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { STUSPS: 'WA', STATEFP: '53', NAME: 'Washington' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-123, 45],
          [-117, 45],
          [-117, 49],
          [-123, 49],
          [-123, 45]
        ]]
      }
    },
    {
      type: 'Feature',
      properties: { STUSPS: 'OR', STATEFP: '41', NAME: 'Oregon' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-124, 42],
          [-117, 42],
          [-117, 46],
          [-124, 46],
          [-124, 42]
        ]]
      }
    }
  ]
};

async function stubStateGeometry(page: Page): Promise<void> {
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify(STATE_COLLECTION)
    })
  );
}

async function framedApp(page: Page, studio: 'place' | 'layers'): Promise<Frame> {
  // A raw boot inside a synthesized host document, so the suite-wide
  // boundary stub is installed by hand; page-level routes cover the frame.
  await routeAllTribalFixtures(page);
  await page.setContent(
    `<iframe title="Framed DDM" src="${PREVIEW_URL}?view=brief&layers=places&studio=${studio}"></iframe>`
  );
  await expect
    .poll(() => page.frames().find((frame) => frame.url().startsWith(PREVIEW_URL))?.url())
    .toContain(`studio=${studio}`);
  const frame = page.frames().find((candidate) => candidate.url().startsWith(PREVIEW_URL));
  if (!frame) throw new Error('Framed DDM did not attach.');
  return frame;
}

test.describe('studio route guards', () => {
  test('a physical iframe without embed uses link-outs and synthesizes no studio entry', async ({
    page
  }) => {
    const frame = await framedApp(page, 'place');

    for (const studio of ['place', 'layers'] as const) {
      if (!frame.url().includes(`studio=${studio}`)) {
        await frame.goto(
          `${PREVIEW_URL}?view=brief&layers=places&studio=${studio}`,
          { waitUntil: 'domcontentloaded' }
        );
      }

      const linkouts = frame.locator('#studio-linkout-pair');
      await expect(linkouts).toBeVisible();
      await expect(frame.locator('#app')).not.toHaveClass(/\bembed\b/);
      await expect(frame.locator(PLACE_ROOT)).toHaveCount(0);
      await expect(frame.locator(LAYERS_ROOT)).toHaveCount(0);
      await expect(frame.locator('#studio-entry-pair')).toHaveCount(0);

      const placeLink = linkouts.getByRole('link', {
        name: 'Open place selection on the full site'
      });
      const layersLink = linkouts.getByRole('link', {
        name: 'Open layer controls on the full site'
      });
      await expect(placeLink).toBeVisible();
      await expect(layersLink).toBeVisible();
      await expect(placeLink).toHaveAttribute('target', '_blank');
      await expect(layersLink).toHaveAttribute('target', '_blank');

      const target = studio === 'place' ? placeLink : layersLink;
      const href = new URL((await target.getAttribute('href')) ?? '');
      expect(href.searchParams.get('studio')).toBe(studio);
      expect(href.searchParams.has('embed')).toBe(false);

      const markedStudioEntry = await frame.evaluate(() => {
        const state = window.history.state as { ddmStudioEntry?: boolean } | null;
        return state?.ddmStudioEntry === true;
      });
      expect(markedStudioEntry).toBe(false);
    }
  });

  for (const studio of [
    {
      route: 'place',
      root: PLACE_ROOT,
      chunk: /\/place-studio-[^/]+\.js(?:\?.*)?$/,
      loadedHeading: 'Place studio'
    },
    {
      route: 'layers',
      root: LAYERS_ROOT,
      chunk: /\/layers-studio-[^/]+\.js(?:\?.*)?$/,
      loadedHeading: 'Layer studio'
    }
  ] as const) {
    test(`${studio.route} chunk failure exposes Back and retries the import`, async ({
      page
    }) => {
      // Abort only the FIRST network attempt: Chromium caches the failed
      // dynamic import in the module map, so the in-page re-entry below
      // fails from the cache without a second request; the reload is what
      // refetches (attempt 2), and it must succeed.
      let chunkAttempts = 0;
      await page.route(studio.chunk, async (route) => {
        chunkAttempts += 1;
        if (chunkAttempts <= 1) {
          await route.abort('failed');
        } else {
          await route.continue();
        }
      });

      await gotoApp(
        page,
        `?view=brief&layers=places&studio=${studio.route}`
      );
      const root = page.locator(studio.root);
      const failure = root.getByRole('alert');
      await expect(failure.getByRole('heading', { name: 'Studio unavailable' })).toBeVisible();
      await expect(failure.getByText(
        'This screen failed to load. Check your connection and try again.',
        { exact: true }
      )).toBeVisible();
      await expect(failure.getByRole('button', { name: 'Back to map' })).toBeFocused();

      await failure.getByRole('button', { name: 'Back to map' }).click();
      await expect(root).toHaveCount(0);
      expect(new URLSearchParams(await search(page)).has('studio')).toBe(false);

      await page.locator(`#${studio.route}-studio-entry`).click();
      await expect(root.getByRole('alert')).toBeVisible();
      // Try again is a full reload: Chromium caches a failed dynamic
      // import in the module map, so an in-page re-import can never
      // recover; the studio route is URL state and survives the reload.
      await failure.getByRole('button', { name: 'Try again' }).click();
      await page.waitForLoadState('domcontentloaded');
      await expect(root.getByRole('heading', { name: studio.loadedHeading })).toBeVisible();
      expect(chunkAttempts).toBeGreaterThanOrEqual(2);

      await root.getByRole('button', { name: 'Back to map' }).click();
      await expect(root).toHaveCount(0);
      expect(new URLSearchParams(await search(page)).has('studio')).toBe(false);
    });
  }

  test('a newer select navigation replaces the command held behind LAYERS', async ({
    page
  }) => {
    await stubStateGeometry(page);
    await gotoApp(
      page,
      '?view=brief&layers=places&studio=layers&select=state:WA'
    );

    const studio = page.locator(LAYERS_ROOT);
    await expect(studio).toBeVisible();
    await expect(page.locator('#impact-panel')).toHaveCount(0);

    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set('select', 'state:OR');
      window.history.replaceState(window.history.state, '', url);
      window.dispatchEvent(
        new PopStateEvent('popstate', { state: window.history.state })
      );
    });

    await expect(page.locator('#impact-panel')).toHaveCount(0);
    await studio.getByRole('button', { name: 'Back to map' }).click();

    await expect(studio).toHaveCount(0);
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-panel-title')).toHaveText('Oregon');
    expect(new URLSearchParams(await search(page)).has('studio')).toBe(false);
  });
});
