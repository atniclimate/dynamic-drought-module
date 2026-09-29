import { expect, test, type Page } from '@playwright/test';

import { gotoApp } from './helpers';

/**
 * D1 M17, DR-169 (ratified 2026-09-29, RATIFICATION-8, "Desktop sidebar
 * inert"; DDM-P10-T08's amended acceptance, .planning/ROADMAP.yaml, grep
 * `amended_2026_09_29_dr169`).
 *
 * At 1025 CSS px and wider a studio covers the MAP AREA beside the
 * sidebar column (the whole width when the sidebar is collapsed or in
 * embed) and centres its content column in that area; the sidebar stays
 * visible and inert. From 721 to 1024 px (the tablet band, DR-153) and
 * below 721 px (the phone shell) a studio covers and centres on the
 * whole viewport, with everything behind it inert.
 *
 * Every geometry read below is one `page.evaluate` taken after the
 * studio's root is visible (Playwright's own auto-retrying wait, which
 * is this suite's settle signal): the studio's CSS is static (no open
 * transition or animation on either root or its content column, grep
 * `.layers-studio` and `.place-studio` for `transition`/`animation`, D1
 * M17 diagnosis), so a mounted, visible root is already a final layout,
 * and there is nothing further to poll for.
 */

const PLACE_ROOT = '#place-studio-root';
const LAYERS_ROOT = '#layers-studio-root';

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const STUDIOS = [
  { kind: 'place', root: PLACE_ROOT, column: '.place-studio-layout', back: '#place-studio-back' },
  { kind: 'layers', root: LAYERS_ROOT, column: '.layers-studio-grid', back: '.layers-studio-back' }
] as const;

/** One evaluate: the studio root's rect and its content column's rect. */
async function studioGeometry(
  page: Page,
  rootSel: string,
  columnSel: string
): Promise<{ root: Rect; column: Rect } | null> {
  return page.evaluate(
    ({ rootSel, columnSel }) => {
      const toRect = (box: DOMRect): {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      } => ({
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height
      });
      const root = document.querySelector(rootSel);
      const column = document.querySelector(columnSel);
      if (!root || !column) return null;
      return { root: toRect(root.getBoundingClientRect()), column: toRect(column.getBoundingClientRect()) };
    },
    { rootSel, columnSel }
  );
}

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth
      }))
    )
    .toEqual({ client: width, document: width, body: width });
}

const DESKTOP_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const;

test.describe('at 1025px and wider, a studio centres its content column in the map area beside the sidebar (DR-169)', () => {
  for (const { width, height } of DESKTOP_VIEWPORTS) {
    for (const studio of STUDIOS) {
      test(`${studio.kind} studio at ${width}x${height}, sidebar open and collapsed`, async ({
        page
      }) => {
        for (const sidebarState of ['open', 'closed'] as const) {
          await page.setViewportSize({ width, height });
          const query =
            sidebarState === 'closed'
              ? `?view=brief&layers=places&studio=${studio.kind}&sidebar=closed`
              : `?view=brief&layers=places&studio=${studio.kind}`;
          await gotoApp(page, query);
          await expect(page.locator(studio.root)).toBeVisible();

          const geometry = await studioGeometry(page, studio.root, studio.column);
          expect(
            geometry,
            `${studio.kind} at ${width}x${height} (${sidebarState}): studio root or content column missing`
          ).not.toBeNull();
          const { root, column } = geometry!;

          if (sidebarState === 'open') {
            // The map area, not the full viewport: the root starts at the
            // sidebar's rendered width, never at 0. Predicted red on the
            // pre-M17 tree: this was already true (the dock existed), but
            // the CENTRING below was on the full viewport, 170px right of
            // the map area's own centre at 1280 wide (the D1 M17 brief's
            // own reading of the D0 diagnosis).
            expect(
              root.left,
              `${studio.kind} at ${width}x${height}: the root does not start beside the sidebar with it open`
            ).toBeGreaterThan(0);
          } else {
            expect(
              root.left,
              `${studio.kind} at ${width}x${height}: the root does not fill the width with the sidebar collapsed`
            ).toBe(0);
          }
          expect(root.right, `${studio.kind} at ${width}x${height} (${sidebarState}): root does not reach the viewport's right edge`).toBe(width);
          expect(root.top, `${studio.kind} at ${width}x${height} (${sidebarState}): root does not start at the top`).toBe(0);
          expect(root.bottom, `${studio.kind} at ${width}x${height} (${sidebarState}): root does not reach the viewport's bottom edge`).toBe(height);

          const rootCenter = (root.left + root.right) / 2;
          const columnCenter = (column.left + column.right) / 2;
          expect(
            Math.abs(columnCenter - rootCenter),
            `${studio.kind} at ${width}x${height} (${sidebarState}): the content column is not centred in the map area within 1px`
          ).toBeLessThanOrEqual(1);
        }
      });
    }
  }
});

test.describe('from 721 to 1024px, a studio covers and centres on the whole viewport (DR-153, DR-169)', () => {
  // Predicted red on the pre-M17 tree: --studio-inset-start docked the
  // root at the tablet band's own fluid --sidebar-w (the same bug this
  // range had at desktop before M17, just with a narrower dock), so the
  // root did not fill the viewport and the column centred on the map
  // area rather than the viewport.
  const CASES = [
    { width: 721, height: 800, note: 'tablet band floor' },
    { width: 820, height: 1180, note: 'tablet band, portrait' },
    { width: 1024, height: 768, note: 'tablet band ceiling' },
    { width: 960, height: 540, note: '200 percent emulation of 1920x1080' }
  ] as const;

  for (const { width, height, note } of CASES) {
    for (const studio of STUDIOS) {
      test(`${studio.kind} studio fills and centres on ${width}x${height} (${note})`, async ({
        page
      }) => {
        await page.setViewportSize({ width, height });
        await gotoApp(page, `?view=brief&layers=places&studio=${studio.kind}`);
        await expect(page.locator(studio.root)).toBeVisible();

        const geometry = await studioGeometry(page, studio.root, studio.column);
        expect(geometry, `${studio.kind} at ${width}x${height}: studio root or content column missing`).not.toBeNull();
        const { root, column } = geometry!;

        expect(root.left, `${studio.kind} at ${width}x${height}: root does not fill the viewport (left)`).toBe(0);
        expect(root.top, `${studio.kind} at ${width}x${height}: root does not fill the viewport (top)`).toBe(0);
        expect(root.width, `${studio.kind} at ${width}x${height}: root does not fill the viewport (width)`).toBe(width);
        expect(root.height, `${studio.kind} at ${width}x${height}: root does not fill the viewport (height)`).toBe(height);

        const rootCenter = (root.left + root.right) / 2;
        const columnCenter = (column.left + column.right) / 2;
        expect(
          Math.abs(columnCenter - rootCenter),
          `${studio.kind} at ${width}x${height}: the content column is not centred on the viewport within 1px`
        ).toBeLessThanOrEqual(1);
      });
    }
  }
});

test('the sidebar stays visible but inert while a studio is open at 1025px and wider (DR-169)', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page, '?view=brief&layers=places');

  const sidebarBoxBefore = await page.locator('#sidebar').boundingBox();
  expect(sidebarBoxBefore, 'the sidebar has no box before a studio opens').not.toBeNull();
  expect(sidebarBoxBefore!.width).toBeGreaterThan(0);

  const clusterBtn = page.locator('.shell-cluster-btn[data-cluster="wildfire"]');
  await expect(clusterBtn).toHaveAttribute('aria-pressed', 'false');

  await page.locator('#place-studio-entry').click();
  await expect(page.locator(PLACE_ROOT)).toBeVisible();

  // Visible rect: the sidebar is still on screen, same size, not moved.
  const sidebarBoxDuring = await page.locator('#sidebar').boundingBox();
  expect(sidebarBoxDuring, 'the sidebar lost its box while a studio is open').not.toBeNull();
  expect(sidebarBoxDuring!.width).toBe(sidebarBoxBefore!.width);
  expect(sidebarBoxDuring!.height).toBe(sidebarBoxBefore!.height);

  // Inert on it or an ancestor (D1 M17 brief): this build marks the whole
  // #app inert, which #sidebar inherits as a descendant.
  const appInert = await page.locator('#app').evaluate((el) => (el as HTMLElement).inert);
  expect(appInert, 'the veil ancestor (#app) is not inert while a studio is open').toBe(true);

  // A click on a sidebar mode button changes nothing: force bypasses
  // Playwright's own actionability pre-check so the real browser hit-test
  // (which an inert subtree fails) decides the outcome, rather than the
  // test hanging on a target that can never become actionable.
  await clusterBtn.click({ force: true, timeout: 5_000 });
  await expect(clusterBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page).not.toHaveURL(/cluster=wildfire/);

  await page.locator(`${PLACE_ROOT} #place-studio-back`).click();
  await expect(page.locator(PLACE_ROOT)).toHaveCount(0);
  expect(await page.locator('#app').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
});

test.describe('every studio lies wholly inside the viewport with no horizontal page scroll', () => {
  for (const { width, height } of DESKTOP_VIEWPORTS) {
    for (const studio of STUDIOS) {
      test(`${studio.kind} studio at ${width}x${height}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await gotoApp(page, `?view=brief&layers=places&studio=${studio.kind}`);
        await expect(page.locator(studio.root)).toBeVisible();
        const box = await page.locator(studio.root).boundingBox();
        expect(box, `${studio.kind} at ${width}x${height}: no box`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(height);
        await expectNoHorizontalOverflow(page, width);
      });
    }
  }

  // 200 percent browser page zoom, emulated as a CSS viewport of half the
  // width and height (ROADMAP DDM-P10-T08 acceptance): 1920x1080 at 200
  // percent is 960x540 (the tablet band); 2560x1440 at 200 percent is
  // 1280x720.
  const ZOOM_EMULATIONS = [
    { width: 960, height: 540, of: '1920x1080 at 200 percent' },
    { width: 1280, height: 720, of: '2560x1440 at 200 percent' }
  ] as const;
  for (const { width, height, of } of ZOOM_EMULATIONS) {
    for (const studio of STUDIOS) {
      test(`${studio.kind} studio at ${width}x${height} (${of})`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await gotoApp(page, `?view=brief&layers=places&studio=${studio.kind}`);
        await expect(page.locator(studio.root)).toBeVisible();
        await expectNoHorizontalOverflow(page, width);
      });
    }
  }

  // At 200 percent of 1280x720 and 1440x900 (640x360 and 720x450) the
  // phone shell governs: it has no LAYERS door, so a deep-linked studio
  // fills the viewport with no desktop door (DDM-P10-T08 acceptance,
  // CODEMAP 3.3). The phone route itself (not the desktop dock) is what
  // is asserted here for both studio kinds, since neither door exists to
  // click at this width.
  const PHONE_ROUTE_CASES = [
    { width: 640, height: 360, of: '1280x720 at 200 percent' },
    { width: 720, height: 450, of: '1440x900 at 200 percent' }
  ] as const;
  for (const { width, height, of } of PHONE_ROUTE_CASES) {
    for (const studio of STUDIOS) {
      test(`${studio.kind} studio's phone route at ${width}x${height} (${of})`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await gotoApp(page, `?view=brief&layers=places&studio=${studio.kind}`);
        await expect(page.locator(studio.root)).toBeVisible();
        const box = await page.locator(studio.root).boundingBox();
        expect(box, `${studio.kind} at ${width}x${height}: no box`).not.toBeNull();
        expect(box!.x).toBe(0);
        expect(box!.y).toBe(0);
        expect(box!.width).toBe(width);
        expect(box!.height).toBe(height);
        await expectNoHorizontalOverflow(page, width);
      });
    }
  }
});

// A representative slice of real STUSPS codes (US_STATES_SHARED_KEY, see
// src/config/place-catalog.ts loadStateEntries, which rejects anything
// outside its own STATE_CATALOG_STUSPS set): enough rows to overflow a
// 720px-tall studio regardless of per-row height, without depending on
// the live bundled us-states.geojson asset's exact feature count.
const SYNTHETIC_STATE_CODES: ReadonlyArray<readonly [string, string]> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'],
  ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York']
];

async function stubManyStates(page: Page): Promise<void> {
  const collection = {
    type: 'FeatureCollection',
    features: SYNTHETIC_STATE_CODES.map(([stusps, name]) => ({
      type: 'Feature',
      properties: { STUSPS: stusps, STATEFP: '00', NAME: name },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 40]]]
      }
    }))
  };
  await page.route('**/data/us-states.geojson', (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(collection) })
  );
}

test('the Place studio has one scroll container and its last list row is reachable in it at 1280x720', async ({
  page
}) => {
  await stubManyStates(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await gotoApp(page, '?view=brief&layers=places&studio=place');
  await expect(page.locator(PLACE_ROOT)).toBeVisible();

  await page.locator('#place-type-state').click();
  await expect(page.locator('#place-list li').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#place-list li')).toHaveCount(SYNTHETIC_STATE_CODES.length);

  const state = await page.evaluate(() => {
    const outer = document.querySelector('.layers-studio-scroll') as HTMLElement | null;
    const list = document.querySelector('#place-list') as HTMLElement | null;
    if (!outer || !list) return null;
    return {
      outerOverflowY: getComputedStyle(outer).overflowY,
      outerScrollable: outer.scrollHeight > outer.clientHeight,
      listOverflowY: getComputedStyle(list).overflowY,
      listScrollable: list.scrollHeight > list.clientHeight
    };
  });
  expect(state, 'the Place studio scroll containers are missing').not.toBeNull();
  // Predicted red on the pre-fix tree: listOverflowY 'auto' and
  // listScrollable true, a SECOND scroller nested inside the first, with
  // the list's own max-height (calc(100dvh - 250px) at the base rule,
  // narrowed further by the 721px+ and @container 760px+ rules) cutting
  // the last row mid-line inside its own tiny scrollbar.
  expect(state!.listOverflowY, 'the list still declares its own overflow').not.toBe('auto');
  expect(state!.listScrollable, 'the list is still its own nested scroller').toBe(false);
  expect(state!.outerOverflowY, 'the outer .layers-studio-scroll lost its own overflow').toBe('auto');
  expect(state!.outerScrollable, 'the outer scroller has nothing to scroll (the fixture is too short)').toBe(true);

  const reached = await page.evaluate(() => {
    const outer = document.querySelector('.layers-studio-scroll') as HTMLElement;
    const items = document.querySelectorAll('#place-list li');
    const last = items[items.length - 1] as HTMLElement;
    outer.scrollTop = outer.scrollHeight;
    const outerRect = outer.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    return lastRect.bottom <= outerRect.bottom + 1 && lastRect.top >= outerRect.top - 1;
  });
  expect(reached, 'the last list row is not reachable by scrolling the single outer container').toBe(true);
});

test('at 2560x1440 the studio header controls register with the content column', async ({ page }) => {
  // Registration, defined exactly: Back's left edge sits within 1px of the
  // content column's left edge, and the header's own end padding (its
  // rendered right edge minus its computed padding-right, i.e. where its
  // end group's content box stops) sits within 1px of the column's right
  // edge. 1px is this codebase's own "1px stability" tolerance
  // (interface-chrome section 5), reused rather than invented here.
  const N = 1;
  await page.setViewportSize({ width: 2560, height: 1440 });

  for (const studio of STUDIOS) {
    await gotoApp(page, `?view=brief&layers=places&studio=${studio.kind}`);
    await expect(page.locator(studio.root)).toBeVisible();

    const data = await page.evaluate(
      ({ backSel, columnSel }) => {
        const back = document.querySelector(backSel);
        const column = document.querySelector(columnSel);
        const header = document.querySelector('.layers-studio-header');
        if (!back || !column || !header) return null;
        const backRect = back.getBoundingClientRect();
        const columnRect = column.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const paddingRight = parseFloat(getComputedStyle(header).paddingRight);
        return {
          backLeft: backRect.left,
          columnLeft: columnRect.left,
          columnRight: columnRect.right,
          headerContentRight: headerRect.right - paddingRight
        };
      },
      { backSel: studio.back, columnSel: studio.column }
    );
    expect(data, `${studio.kind}: header, Back or the content column is missing`).not.toBeNull();
    const { backLeft, columnLeft, columnRight, headerContentRight } = data!;

    // Predicted red on the pre-fix tree: the header's fixed 18px padding
    // left Back's edge near the root's own edge while the content column
    // (width: min(1080px, 100%), margin: 0 auto) sat about 570px in from
    // it at this width with the sidebar docked (1080px apart end to end,
    // the D1 M17 diagnosis's own number).
    expect(
      Math.abs(backLeft - columnLeft),
      `${studio.kind}: Back's left edge does not register with the content column's left edge`
    ).toBeLessThanOrEqual(N);
    expect(
      Math.abs(headerContentRight - columnRight),
      `${studio.kind}: the header's end group does not register with the content column's right edge`
    ).toBeLessThanOrEqual(N);
  }
});
