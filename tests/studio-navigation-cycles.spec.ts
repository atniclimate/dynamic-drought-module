import { expect, test, type Locator, type Page } from '@playwright/test';

import { gotoApp } from './helpers';

/**
 * DR-065 failure mode 3: the place studio and the layer studio had
 * "inconsistent navigation and did not work correctly" across repeated
 * sessions on a desktop and a phone
 * (planning/user-research/2026-08-reuben-martinez-atni-energy.md).
 *
 * Each half of that sequence already has a good contract, and none of them
 * composes: `studio-restore.spec.ts` proves ONE Back restores its snapshot,
 * `studio-a11y.spec.ts` proves ONE exit returns focus, and
 * `studio-url-matrix.spec.ts` proves ONE studio URL survives a reload. The
 * sequence the observation actually ran is the composition: open the place
 * studio, close it, open the layer studio, switch the view, and reopen. No
 * spec ran that, and no spec ran studio entry and exit on a phone at all.
 *
 * What a repeated cycle can catch that a single cycle cannot is state that
 * survives a close: an `#app` left inert so the map stops responding, a
 * focus anchor stranded on a torn-down opener, a `studio=` token left in a
 * URL that no longer has a studio, or a second open that lands somewhere
 * other than where the first one did. Every one of those reads to a user as
 * "inconsistent navigation", and every one is asserted below on EACH pass,
 * not only on the first.
 *
 * The oracle for "the same place" is the URL the first cycle produced. Both
 * cases capture the map URL at rest and the studio URL on the first open,
 * then require the later cycles to reproduce them exactly.
 */

const PLACE_ROOT = '#place-studio-root';
const LAYERS_ROOT = '#layers-studio-root';

/** Both studios take the whole app out of the accessibility tree while open. */
async function expectAppSealed(page: Page, moment: string): Promise<void> {
  await expect(page.locator('#app'), `${moment}: the app is not hidden behind the studio`)
    .toHaveAttribute('aria-hidden', 'true');
  expect(
    await page.locator('#app').evaluate((app) => app.inert),
    `${moment}: the app is not inert behind the studio`
  ).toBe(true);
}

/** And must hand it back, every time, not only the first time. */
async function expectAppReleased(page: Page, moment: string): Promise<void> {
  await expect(page.locator('#app'), `${moment}: the app is still hidden after the studio closed`)
    .not.toHaveAttribute('aria-hidden', 'true');
  expect(
    await page.locator('#app').evaluate((app) => app.inert),
    `${moment}: the app is still inert after the studio closed`
  ).toBe(false);
}

/**
 * One full open-and-close cycle through a studio, asserted end to end.
 * Returns the URL the studio carried, so a later cycle can be required to
 * reproduce it.
 */
async function studioCycle(
  page: Page,
  opener: Locator,
  root: string,
  kind: 'place' | 'layers',
  mapUrl: string,
  moment: string
): Promise<string> {
  await opener.scrollIntoViewIfNeeded();
  await expect(opener, `${moment}: the ${kind} door is not on screen`).toBeVisible();
  await expect(opener, `${moment}: the ${kind} door is disabled`).toBeEnabled();
  await expect(
    opener,
    `${moment}: the ${kind} door is still marked unavailable`
  ).not.toHaveAttribute('aria-disabled', 'true');
  await opener.focus();
  await opener.click();

  const studio = page.locator(root);
  await expect(studio, `${moment}: the ${kind} studio did not open`).toBeVisible();
  await expectAppSealed(page, `${moment} (${kind} open)`);
  const studioUrl = page.url();
  expect(
    new URL(studioUrl).searchParams.get('studio'),
    `${moment}: the URL does not name the ${kind} studio`
  ).toBe(kind);

  await studio.getByRole('button', { name: 'Back to map' }).click();
  await expect(studio, `${moment}: the ${kind} studio did not close`).toHaveCount(0);
  await expectAppReleased(page, `${moment} (${kind} closed)`);
  await expect(opener, `${moment}: focus did not return to the ${kind} door`).toBeFocused();
  await expect
    .poll(() => page.url(), {
      message: `${moment}: closing the ${kind} studio did not return the map URL`
    })
    .toBe(mapUrl);

  return studioUrl;
}

test.describe('DR-065 mode 3: repeated studio cycles stay consistent (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('place, layers, a view switch, and both again land in exactly the same places', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&layers=places');

    const pair = page.locator('#brief-display #layers-studio-entry-host #studio-entry-pair');
    const placeDoor = pair.locator('#place-studio-entry');
    const layersDoor = pair.locator('#layers-studio-entry');
    await expect(pair).toBeVisible();

    const mapUrl = page.url();

    // Cycle 1: the sequence the observation opened with.
    const firstPlaceUrl = await studioCycle(
      page,
      placeDoor,
      PLACE_ROOT,
      'place',
      mapUrl,
      'cycle 1'
    );
    const firstLayersUrl = await studioCycle(
      page,
      layersDoor,
      LAYERS_ROOT,
      'layers',
      mapUrl,
      'cycle 1'
    );

    // The view switch, with no studio open: the doors live inside the Brief
    // display, so Console takes them away and Brief must bring them back.
    const consoleButton = page.locator('.view-switch [data-view="console"]');
    const briefButton = page.locator('.view-switch [data-view="brief"]');

    await consoleButton.click();
    await expect(consoleButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#brief-display')).toBeHidden();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('view'))
      .toBe('console');
    expect(
      new URL(page.url()).searchParams.has('studio'),
      'the view switch invented a studio token'
    ).toBe(false);
    // Neither studio may follow the view switch onto the console.
    await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
    await expect(page.locator(LAYERS_ROOT)).toHaveCount(0);

    await briefButton.click();
    await expect(briefButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#brief-display')).toBeVisible();
    await expect(pair).toBeVisible();
    await expect
      .poll(() => page.url(), { message: 'the view round trip did not return the map URL' })
      .toBe(mapUrl);

    // Cycle 2: the reopen. Same doors, same studios, same URLs.
    const secondPlaceUrl = await studioCycle(
      page,
      placeDoor,
      PLACE_ROOT,
      'place',
      mapUrl,
      'cycle 2'
    );
    const secondLayersUrl = await studioCycle(
      page,
      layersDoor,
      LAYERS_ROOT,
      'layers',
      mapUrl,
      'cycle 2'
    );

    expect(secondPlaceUrl, 'the reopened place studio landed somewhere else').toBe(firstPlaceUrl);
    expect(secondLayersUrl, 'the reopened layer studio landed somewhere else').toBe(
      firstLayersUrl
    );

    // Cycle 3, back to back with no view switch between them: the studios are
    // exclusive, so entering one straight after leaving the other must not
    // leave the first one mounted or its token in the URL.
    await studioCycle(page, placeDoor, PLACE_ROOT, 'place', mapUrl, 'cycle 3');
    await studioCycle(page, layersDoor, LAYERS_ROOT, 'layers', mapUrl, 'cycle 3');
    expect(
      new URL(page.url()).searchParams.has('studio'),
      'a studio token outlived the last cycle'
    ).toBe(false);
  });
});

test.describe('DR-065 mode 3: repeated studio cycles stay consistent (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the sheet place door opens and closes across a footer view switch', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=places');

    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-sheet-detent', /./);

    const placeTab = page.locator('#mobile-footer-nav button[data-tab="place"]');
    const layersTab = page.locator('#mobile-footer-nav button[data-tab="layers"]');

    await placeTab.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect(page.locator('#sheet-search [data-ddm-search]')).toBeVisible();

    const opener = page.locator('#sheet-place-studio-entry');
    const mapUrl = page.url();

    const firstUrl = await studioCycle(page, opener, PLACE_ROOT, 'place', mapUrl, 'phone cycle 1');
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');

    // The phone's own view switch is the footer. Layers rides the console
    // mode; there is no mobile LAYERS studio door, and the desktop door pair
    // is never admitted to the sheet, so that absence is pinned here rather
    // than driven.
    await layersTab.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('view'))
      .toBe('console');
    await expect(page.locator('#studio-entry-pair')).toBeHidden();
    await expect(page.locator(LAYERS_ROOT)).toHaveCount(0);

    await placeTab.click();
    await expect(app).toHaveAttribute('data-sheet-detent', 'half');
    await expect
      .poll(() => page.url(), { message: 'the footer view round trip did not return the map URL' })
      .toBe(mapUrl);

    const secondUrl = await studioCycle(page, opener, PLACE_ROOT, 'place', mapUrl, 'phone cycle 2');
    expect(secondUrl, 'the reopened place studio landed somewhere else on the phone').toBe(
      firstUrl
    );

    // A third pass with no view switch in between, so the phone contract
    // covers the same back-to-back repetition the desktop one does.
    await studioCycle(page, opener, PLACE_ROOT, 'place', mapUrl, 'phone cycle 3');
    expect(
      new URL(page.url()).searchParams.has('studio'),
      'a studio token outlived the last phone cycle'
    ).toBe(false);
  });
});
