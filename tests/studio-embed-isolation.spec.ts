import { expect, test, type Locator, type Page } from '@playwright/test';

import { FRAMINGS, type FramingKey } from '../src/config/framings';
import { gotoApp } from './helpers';
import { AIANNH_ROUTE, BIA_ROUTE, emptyCollectionBody, routeGeojson } from './tribal-fixtures';
import { stubRecentSatellite } from './satellite-fixture';

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

const FRAMING = Object.keys(FRAMINGS)[0] as FramingKey;
const STUDIO_CHUNK = /\/(?:island|layers-studio|place-studio)-[^/]+\.js(?:\?.*)?$/;

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function stubEmbedDependencies(page: Page): Promise<void> {
  await routeGeojson(page, AIANNH_ROUTE, emptyCollectionBody());
  await routeGeojson(page, BIA_ROUTE, emptyCollectionBody());
  await page.route('**/data/us-places.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: 'Fixture City', lon: -120, lat: 44 }] })
    })
  );
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] })
    })
  );
  await stubRecentSatellite(page);
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

const CASES = [
  {
    studio: 'place',
    durable: `framing=${encodeURIComponent(FRAMING)}&layers=places`,
    expected: { framing: FRAMING, layers: 'places', cluster: null, ocean: null }
  },
  {
    studio: 'layers',
    durable: `framing=${encodeURIComponent(FRAMING)}&cluster=enso&ocean=pacific`,
    expected: { framing: FRAMING, layers: null, cluster: 'enso', ocean: 'pacific' }
  }
] as const;

test.describe('studio embed isolation at 400x600', () => {
  test.use({ viewport: { width: 400, height: 600 } });

  for (const scenario of CASES) {
    test(`${scenario.studio} stays unloaded until embed expansion`, async ({ page }) => {
      await stubEmbedDependencies(page);
      const lazyRequests: string[] = [];
      page.on('request', (request) => {
        const url = request.url();
        if (STUDIO_CHUNK.test(url)) lazyRequests.push(url);
      });

      await gotoApp(
        page,
        `?embed=true&view=brief&${scenario.durable}` +
          `&week=20240702&dmode=chg1&sst=2024-07-01&outlook=monthly` +
          `&basemap=satellite&studio=${scenario.studio}#studio-state`
      );

      await expect(page.locator('#place-studio-root')).toHaveCount(0);
      await expect(page.locator('#layers-studio-root')).toHaveCount(0);
      expect(lazyRequests).toEqual([]);

      const app = page.locator('#app');
      await expect(app).toHaveClass(/\bembed\b/);
      // Embed boot hides the sidebar via the `embed` class alone; the
      // separate `sidebar-collapsed` class marks a MANUAL collapse and is
      // never stamped by embed boot (conductor truing at the F7 gate).
      await expect(page.locator('.sidebar')).not.toBeVisible();
      const mapBox = await page.locator('#map-container').boundingBox();
      expect(mapBox).not.toBeNull();
      expect(mapBox!.height).toBe(600);

      const pair = page.locator('#studio-linkout-pair');
      const placeLink = pair.getByRole('link', { name: 'Open place selection on the full site' });
      const layersLink = pair.getByRole('link', { name: 'Open layer controls on the full site' });
      await expect(placeLink).toBeVisible();
      await expect(layersLink).toBeVisible();
      for (const link of [placeLink, layersLink]) {
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
        await link.focus();
        await expect(link).toBeFocused();
      }

      const [placeBox, layersBox, expandBox] = await Promise.all([
        placeLink.boundingBox(),
        layersLink.boundingBox(),
        page.locator('#sidebar-expand').boundingBox()
      ]);
      expect(placeBox).not.toBeNull();
      expect(layersBox).not.toBeNull();
      expect(expandBox).not.toBeNull();
      expect(overlaps(placeBox!, layersBox!)).toBe(false);
      expect(overlaps(placeBox!, expandBox!)).toBe(false);
      expect(overlaps(layersBox!, expandBox!)).toBe(false);

      for (const [target, link] of [
        ['place', placeLink],
        ['layers', layersLink]
      ] as const) {
        const href = new URL((await link.getAttribute('href')) ?? '');
        expect(href.searchParams.has('embed')).toBe(false);
        expect(href.searchParams.get('studio')).toBe(target);
        expect(href.searchParams.get('view')).toBe('brief');
        expect(href.searchParams.get('framing')).toBe(scenario.expected.framing);
        expect(href.searchParams.get('layers')).toBe(scenario.expected.layers);
        expect(href.searchParams.get('cluster')).toBe(scenario.expected.cluster);
        expect(href.searchParams.get('ocean')).toBe(scenario.expected.ocean);
        expect(href.searchParams.get('week')).toBe('20240702');
        expect(href.searchParams.get('dmode')).toBe('chg1');
        expect(href.searchParams.get('sst')).toBe('2024-07-01');
        expect(href.searchParams.get('outlook')).toBe('monthly');
        expect(href.searchParams.get('basemap')).toBeNull();
        // No hash assertion: URL fragments are not part of the ruled DDM
        // URL schema (URL-as-state rides the query string), and syncUrl
        // canonicalizes to pathname + query by design. The lane's original
        // hash-retention assertion asserted un-ruled behavior; conductor
        // adjudication at the F7 integration gate, 2026-07-17.
      }

      await page.locator('#sidebar-expand').click();
      await expect(app).not.toHaveClass(/\bembed\b/);
      await expect(app).not.toHaveClass(/\bsidebar-collapsed\b/);
      expect(new URL(page.url()).searchParams.has('embed')).toBe(false);

      const requestedRoot = page.locator(`#${scenario.studio}-studio-root`);
      await expect(requestedRoot).toBeVisible();
      await expect.poll(() =>
        lazyRequests.some((url) => new RegExp(`/${scenario.studio}-studio-[^/]+\\.js`).test(url))
      ).toBe(true);
      const otherStudio = scenario.studio === 'place' ? 'layers' : 'place';
      expect(
        lazyRequests.some((url) => new RegExp(`/${otherStudio}-studio-[^/]+\\.js`).test(url))
      ).toBe(false);
    });
  }
});

/**
 * CODEMAP:1749's sibling inferred defect to found-011 (D1 M16): a reading of
 * `initializeStudioRoute` and the desktop expand control's mount path raised
 * the possibility that an embed boot's studio-entry history synthesis
 * (`synthesizeReturnEntry: false`) leaves the expand control's HELD studio
 * route with no predecessor entry, so Back (`backToMap`'s
 * `history.back()`) would have nowhere to go. The director's browser gate
 * (2026-09-28, M16 repair round) ran both cases below against the base
 * source (no M16 change applied) AND against a break that forced the
 * inferred defect's own condition, and both passed either way: this does
 * NOT reproduce. The two cases below now pin that measured, current,
 * working behaviour as a non-defect (a green receipt, not a fix); neither
 * `src/state/studio-route.ts` nor `src/ui/sidebar.ts` carries any M16
 * change for it.
 */
test.describe('studio embed isolation at desktop width: the exit-then-Back round trip', () => {
  test('Back after an embed-exit studio returns to the map view', async ({ page }) => {
    await stubEmbedDependencies(page);
    await gotoApp(page, '?embed=true&view=brief&layers=places&studio=place');
    await expect(page.locator('#place-studio-root')).toHaveCount(0);

    await page.locator('#sidebar-expand').click();
    const studio = page.locator('#place-studio-root');
    await expect(studio).toBeVisible();
    expect(new URL(page.url()).searchParams.get('studio')).toBe('place');

    await studio.getByRole('button', { name: 'Back to map' }).click();
    await expect(studio).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.has('studio'))
      .toBe(false);
  });

  // The M7 carry (director, 2026-09-27 20:31 PDT; Codex's M7 diff review F3):
  // the same round trip under an explicit sidebar= key. F3's own required
  // change: "An embed exit must never re-emit closed on a subsequent studio
  // write or Back." Expanding drops sidebar= regardless of its boot value
  // (DR-139: "the embed exit opens with the key absent"), so the assertion
  // is that Back neither strands the studio (the inferred, unreproduced
  // defect above) nor resurrects the closed preference the boot never
  // actually applied.
  test('an embed exit under sidebar=closed then Back returns to the map view with sidebar= still absent', async ({
    page
  }) => {
    await stubEmbedDependencies(page);
    await gotoApp(page, '?embed=true&sidebar=closed&view=brief&layers=places&studio=place');
    await expect(page.locator('#place-studio-root')).toHaveCount(0);

    await page.locator('#sidebar-expand').click();
    const studio = page.locator('#place-studio-root');
    await expect(studio).toBeVisible();
    expect(new URL(page.url()).searchParams.has('sidebar')).toBe(false);

    await studio.getByRole('button', { name: 'Back to map' }).click();
    await expect(studio).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.has('studio'))
      .toBe(false);
    expect(new URL(page.url()).searchParams.has('sidebar')).toBe(false);
  });
});
