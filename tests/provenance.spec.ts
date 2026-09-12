import { test, expect, type Page } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import { caveatFor } from '../src/impact/context';

/**
 * Unit D acceptance (the umbrella build; design finding 5): the provenance
 * story of the live Tribal-geography layers (publisher, requested live and
 * held only in session memory rather than bundled, vintage or a dated
 * as-of statement, jurisdiction caveat) is legible to a USER on surfaces
 * that survive desktop, mobile, and embed:
 *
 *   1. the per-feature POPUP carries the full sentence (asserted for AIANNH
 *      and AIAN-LAR, the design's two named acceptance targets; the
 *      AIAN-LAR case runs in EMBED mode and one AIANNH case runs at a
 *      MOBILE viewport), and
 *   2. the catalog's reference group carries the concise GROUP-LEVEL
 *      disclosure with its expanded Sources (asserted on desktop AND
 *      through the mobile sheet's Layers door).
 *
 * The clause lists are table-driven and exact (Codex Unit D finding 4): a
 * regression that drops any required clause fails its named assertion. All
 * map data is synthetic route-intercepted fixtures (hard rule 1: no real
 * polygon enters the repository).
 */

/** Required clauses for the AIANNH popup (publisher, vintage, live-fetch +
 * session-cache honesty, non-bundling, jurisdiction caveat, and the
 * absence-is-not-absence sentence: no federal dataset maps every Tribal
 * Nation, so a boundary missing from this layer says nothing about a Nation
 * or its rights). */
const AIANNH_POPUP_CLAUSES = [
  'US Census Bureau',
  'vintage January 1, 2025',
  'requested live from the Census TIGERweb service',
  "this browser session's memory",
  'not bundled by this module',
  'not a definitive depiction of Tribal jurisdiction',
  'No federal dataset maps every Tribal Nation',
  'absence from this layer is not absence of a Nation or of its rights'
] as const;

/** Required clauses for the AIAN-LAR popup. Definition publication, live
 * service updates, browser retrieval, and mission-scoped authority are
 * asserted separately from the legal, survey, and jurisdiction caveat. */
const BIA_POPUP_CLAUSES = [
  'Bureau of Indian Affairs',
  'feature definitions were last published in 2019',
  'continuing spatial-accuracy and attribute updates',
  `Retrieved on ${new Date().toISOString().slice(0, 10)}`,
  'BIA-authoritative for BIA mission use only',
  'not legal, survey, or jurisdictional truth',
  'requested live from the BIA service',
  "this browser session's memory",
  'not bundled by this module',
  'matters of sovereign authority',
  'No federal dataset maps every Tribal Nation',
  'absence from this layer is not absence of a Nation or of its rights'
] as const;

/** Required clauses for the group-level disclosure: both source dates, the
 * scoped non-bundling claim, the deployer-slot qualification, the caveat. */
const GROUP_NOTE_CLAUSES = [
  'US Census AIANNH product (vintage January 1, 2025)',
  'feature definitions were last published in 2019',
  'continuing spatial-accuracy and attribute updates',
  'each BIA boundary popup shows the browser retrieval date',
  'BIA authority is limited to BIA mission use',
  'not legal, survey, or jurisdictional truth',
  'requested live from its agency',
  'neither federal dataset is bundled with the module',
  'your own data',
  'under its own authorization',
  'not a definitive depiction of Tribal jurisdiction'
] as const;

/** Click the map center until the popup content appears (the u4-opening-map
 * retry pattern: a click during the region-fit easing is consumed as a
 * camera interaction). */
async function clickMapForPopup(page: Page): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  const popup = page.locator('.maplibregl-popup-content');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(popup).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

async function assertClauses(
  page: Page,
  locatorSelector: string,
  clauses: readonly string[]
): Promise<void> {
  const target = page.locator(locatorSelector);
  for (const clause of clauses) {
    await expect(target, `required provenance clause: "${clause}"`).toContainText(clause);
  }
}

test.describe('Unit D: user-visible provenance', () => {
  test('the AIANNH popup carries every required provenance clause (desktop console)', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=aiannh');
    await waitForLayerSettled(page, 'aiannh');

    await clickMapForPopup(page);
    await assertClauses(page, '.maplibregl-popup-content', AIANNH_POPUP_CLAUSES);
  });

  test('the AIAN-LAR popup carries every required clause, in embed mode', async ({ page }) => {
    // Embed is a constrained surface the design calls out: the popup is
    // the provenance carrier there (the sidebar stays collapsed by design).
    await gotoApp(page, '?embed=true&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');

    await clickMapForPopup(page);
    await assertClauses(page, '.maplibregl-popup-content', BIA_POPUP_CLAUSES);
  });

  test('the reference group discloses the group-level provenance note (desktop)', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');

    const place = page
      .locator('.layer-group')
      .filter({ has: page.locator('input[data-layer-key="aiannh"]') });

    // Hidden until the group's Sources are revealed (the U3a disclosure).
    const note = page.locator('[data-provenance="tribal-nations"]');
    await expect(note).toHaveCount(0);

    await place.locator('.layer-group-sources-toggle').click();
    await expect(note).toBeVisible();
    await assertClauses(page, '[data-provenance="tribal-nations"]', GROUP_NOTE_CLAUSES);
  });
});

test.describe('Unit D: provenance survives the mobile shell (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the AIANNH popup opens from a mobile map tap with the full clause set', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=aiannh');
    await waitForLayerSettled(page, 'aiannh');

    // The map-first mobile boot keeps the sheet closed, so the map center
    // is a clean tap target above the footer.
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'closed');
    await clickMapForPopup(page);
    await assertClauses(page, '.maplibregl-popup-content', AIANNH_POPUP_CLAUSES);
  });

  test('the group note is reachable through the sheet Layers door', async ({ page }) => {
    // Boot straight into the console door: a bare mobile boot opens the
    // Brief report at the full detent, which is not the surface under test.
    await gotoApp(page, '?view=console');

    // Open the Layers door (half detent), then its one door to the full
    // catalog stack, then the Place group's Sources disclosure.
    await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'half');
    const allLayers = page.locator('#sheet-all-layers-btn');
    await expect(allLayers).toBeVisible();
    await allLayers.click();
    await expect(page.locator('#app')).toHaveAttribute('data-sheet-detent', 'full');

    const place = page
      .locator('.layer-group')
      .filter({ has: page.locator('input[data-layer-key="aiannh"]') });
    const sourcesToggle = place.locator('.layer-group-sources-toggle');
    await sourcesToggle.scrollIntoViewIfNeeded();
    await sourcesToggle.click();
    await assertClauses(page, '[data-provenance="tribal-nations"]', GROUP_NOTE_CLAUSES);
  });
});

const CONSOLE_SEARCH = '#catalog-search [data-ddm-search]';

/**
 * DDM-P2-T10 (DR-094): the shared structural provenance gate
 * (`gatedDisplayName`, src/state/tribal-roster.ts) now runs in the place
 * catalog too, not only in search. One trusted row and one untrusted row
 * (missing or unverified provenance), both crosswalked to a formal name:
 * both surfaces show the formal name ONLY for the trusted row, the BIA
 * land-area name for the untrusted row, and NEITHER title carries a visible
 * marker (titles stay uniform per DR-094; any caveat lives in metadata or
 * the Impact Briefing, never in a title).
 */
const TRUSTED_LAR = 'Provenance Gate Trusted Fixture Area';
const TRUSTED_NAME = 'Provenance Gate Trusted Fixture Nation';
const UNTRUSTED_LAR = 'Provenance Gate Untrusted Fixture Area';
const UNTRUSTED_NAME = 'Provenance Gate Unverified Fixture Nation Name';

async function stubGateFixtures(page: Page): Promise<void> {
  await page.route('**/data/tribal-roster.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        areas: [
          { larName: TRUSTED_LAR, displayName: TRUSTED_NAME, provenance: 'bia-authoritative' },
          { larName: UNTRUSTED_LAR, displayName: UNTRUSTED_NAME, provenance: 'unverified' }
        ]
      })
    })
  );
  await page.route('**/data/tribal-larname-crosswalk.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        meta: {
          rosterSource: 'Synthetic fixture roster',
          landAreaSource: 'Synthetic fixture land areas'
        },
        matched: [
          { tribe: TRUSTED_NAME, larName: TRUSTED_LAR },
          { tribe: UNTRUSTED_NAME, larName: UNTRUSTED_LAR }
        ],
        rosterNoLar: []
      })
    })
  );
}

test.describe('DDM-P2-T10: the place catalog gates a formal Nation name the same way search does (DR-094)', () => {
  test('the studio\'s Tribal Nations list shows the formal name only for the trusted row, with no visible marker on either title', async ({
    page
  }) => {
    await stubGateFixtures(page);
    await gotoApp(page, '?view=brief&layers=places&studio=place');
    await page.locator('#place-studio-search').fill('Provenance Gate');

    const trustedOption = page.locator('#place-list .place-studio-option', {
      hasText: TRUSTED_NAME
    });
    const untrustedOption = page.locator('#place-list .place-studio-option', {
      hasText: UNTRUSTED_LAR
    });
    await expect(trustedOption).toBeVisible();
    await expect(untrustedOption).toBeVisible();
    // The untrusted crosswalk name never renders anywhere in the list.
    await expect(
      page.locator('#place-list .place-studio-option', { hasText: UNTRUSTED_NAME })
    ).toHaveCount(0);
    // DR-094: no marker distinguishes the two kinds of title.
    await expect(trustedOption).not.toContainText('representation');
    await expect(untrustedOption).not.toContainText('representation');
  });

  test('the search list and the studio list gate the same two rows identically', async ({
    page
  }) => {
    await stubGateFixtures(page);
    await gotoApp(page, '?view=console');
    await page.locator(CONSOLE_SEARCH).fill('provenance gate');

    const tribalGroup = page.locator('#catalog-search [data-search-group="tribal"]');
    await expect(tribalGroup).toBeVisible();
    await expect(tribalGroup).toContainText(TRUSTED_NAME);
    await expect(tribalGroup).toContainText(UNTRUSTED_LAR);
    await expect(tribalGroup).not.toContainText(UNTRUSTED_NAME);
  });

  // WORDING (DR-094): grepping src/ui/island/place-studio.tsx and
  // src/config/place-catalog.ts (this task's owned files) for a string
  // naming the Nation-to-polygon relation found none of their OWN making;
  // the one place-studio.tsx surface that names it (the Tribal overlap
  // row's caveat, `TRIBAL_OVERLAP_CAVEAT`) already reads it from
  // `caveatFor('bia-reservation')` (src/impact/context.ts, not owned by
  // this task), which already says "representation". This pins that
  // inherited wording so a future change to either file cannot drop it
  // silently.
  test('the studio\'s tribal overlap caveat calls the polygon a representation', () => {
    expect(caveatFor('bia-reservation')).toContain('representation');
  });
});
