import { test, expect, type Page } from '@playwright/test';
import { gotoApp, stubHeatRiskCatalog, waitForLayerSettled } from './helpers';

/**
 * Keyboard reach and focus on the desktop map chrome (S30D D1 M28; register
 * owner-1f, owner-1h and found-088; task DDM-P10-T11; design record
 * interface-chrome-popups-text.md section 2.7, "Keyboard reach and focus").
 *
 * THE ORDER. Tab follows today's DOM, with no reorder (a later item). The
 * design record lists Reset, SAT, Help, then Share; the DOM puts Share
 * (`#share-btn`) BEFORE Reset in `.map-overlay-controls` (index.html), and
 * the grid seats it in slot 4 visually. These cases assert the PRESENT
 * order, Share first, and the difference is recorded on the M28 report.
 *
 * THE RING. Every stop shows a 2 px solid outline when reached by keyboard:
 * the column's cells keep the chrome ring (2 px #FFFFFF at offset 0 on a
 * 4 px #010B13 casing); the canvas takes the same 2 px ring in inset form
 * (a negative offset), since an outset ring around the whole map would be
 * clipped by the container.

 */

const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
/** Washington, Console, both live Tribal layers over the centre fixtures (interaction-coordinator.spec.ts). */
const COLLISION_QUERY = '?region=washington_state&view=console&layers=aiannh,bia-reservations';

interface Stop {
  /** The chrome seat the focused element belongs to. */
  readonly name: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly outlineOffset: string;
  readonly boxShadow: string;
}

/** Name and ring of whatever holds focus now. */
async function readStop(page: Page): Promise<Stop> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const inside = (selector: string): boolean => Boolean(el?.closest(selector));
    let name = el ? el.tagName.toLowerCase() : 'none';
    if (!el || el === document.body) name = 'body';
    else if (el.id === 'sidebar-expand') name = 'expand';
    else if (el.matches('.maplibregl-canvas')) name = 'canvas';
    else if (el.id === 'map-key-details-toggle' || el.matches('#conditions-strip-dock .conditions-metric')) name = 'chip';
    else if (inside('#map-key-content')) name = 'key drawer';
    else if (el.id === 'share-btn') name = 'share';
    else if (el.id === 'reset-btn') name = 'reset';
    else if (el.matches('.basemap-switcher-btn')) name = 'sat';
    else if (el.id === 'map-info-btn') name = 'help';
    else if (inside('#map-info-panel')) name = 'help drawer';
    else if (inside('#map-bottom-dock')) name = 'dock';
    const cs = el ? getComputedStyle(el) : null;
    return {
      name,
      outlineStyle: cs?.outlineStyle ?? '',
      outlineWidth: cs?.outlineWidth ?? '',
      outlineOffset: cs?.outlineOffset ?? '',
      boxShadow: cs?.boxShadow ?? ''
    };
  });
}

/** Press Tab until `until` names the stop reached; every stop on the way is returned. */
async function tabUntil(page: Page, until: (stop: Stop) => boolean, max = 30): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await readStop(page);
    stops.push(stop);
    if (until(stop)) return stops;
  }
  throw new Error(`Tab never reached the stop; walked ${stops.map((s) => s.name).join(', ')}`);
}

/** The walk's seat names with consecutive repeats folded (a drawer holds several stops). */
function seats(stops: readonly Stop[]): string[] {
  return stops.map((s) => s.name).filter((name, i, all) => i === 0 || all[i - 1] !== name);
}

/** Every keyboard stop carries the 2 px ring; the canvas carries it inset, the cells on their casing. */
function expectRings(stops: readonly Stop[]): void {
  for (const stop of stops) {
    expect.soft(`${stop.name}: ${stop.outlineStyle} ${stop.outlineWidth}`, 'every stop shows the 2 px ring').toBe(
      `${stop.name}: solid 2px`
    );
    if (stop.name === 'canvas') {
      expect.soft(parseFloat(stop.outlineOffset), 'the canvas ring is inset').toBeLessThan(0);
    }
    if (['share', 'reset', 'sat', 'help'].includes(stop.name)) {
      expect.soft(`${stop.name}: offset ${stop.outlineOffset}`).toBe(`${stop.name}: offset 0px`);
      expect.soft(stop.boxShadow, `${stop.name} keeps the 4 px casing`).toContain('rgb(1, 11, 19) 0px 0px 0px 4px');
    }
  }
}

/** Boot the collision fixtures and wait for both Tribal layers. */
async function bootCollision(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await gotoApp(page, COLLISION_QUERY);
  await waitForLayerSettled(page, 'aiannh');
  await waitForLayerSettled(page, 'bia-reservations');
}

/**
 * Click the map centre until the coordinated popup paints (a fill is
 * queryable a frame after it settles; interaction-coordinator.spec.ts uses
 * the same readiness loop). With `withSwitcher`, until both fixture fills
 * answer, so the "Other map features here" switcher is present; a popup
 * without it is closed first, which clears the sticky selection.
 */
async function clickCentreForPopup(page: Page, withSwitcher = false): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('the map has no box');
  const popup = page.locator('.maplibregl-popup-content');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(popup).toBeVisible({ timeout: 1500 });
    if (withSwitcher && (await popup.locator('.popup-other-features').count()) === 0) {
      await page.locator('.maplibregl-popup-close-button').click();
      throw new Error('only one fixture fill has painted yet');
    }
  }).toPass({ timeout: 20_000 });
}

test.describe('map chrome focus (S30D D1 M28)', () => {
  test('Tab visits expand (collapsed), the canvas, the chip and its drawer, Reset, SAT, Help and its drawer, Share and the dock in that order, each with the 2 px ring', async ({
    page
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoApp(page, '?view=console&sidebar=closed');
    await expect(page.locator('#sidebar-expand')).toBeVisible();

    // From a fresh page (nothing clicked) the first Tab lands on expand.
    const toChip = await tabUntil(page, (s) => s.name === 'chip');
    // Enter on the chip opens the Key drawer; Tab walks into it, then on.
    await page.keyboard.press('Enter');
    await expect(page.locator('#map-key-details-toggle')).toHaveAttribute('aria-expanded', 'true');
    const toHelp = await tabUntil(page, (s) => s.name === 'help');
    // Enter on Help opens the Map information drawer (which makes the canvas
    // and the dock inert, map-information.ts); Tab walks into it.
    await page.keyboard.press('Enter');
    await expect(page.locator('#map-info-btn')).toHaveAttribute('aria-expanded', 'true');
    const intoHelpDrawer = await tabUntil(page, (s) => s.name === 'help drawer');
    // Escape in a drawer returns to its trigger (the focus table); the next
    // Tab with the drawer closed reaches the dock.
    await page.keyboard.press('Escape');
    await expect(page.locator('#map-info-btn')).toBeFocused();
    const backToHelp = await readStop(page);
    const toDock = await tabUntil(page, (s) => s.name === 'dock');

    const walk = [...toChip, ...toHelp, ...intoHelpDrawer, backToHelp, ...toDock];
    // PRESENT DOM ORDER: Share precedes Reset (recorded difference; no reorder here).
    expect(seats(walk)).toEqual([
      'expand',
      'canvas',
      'chip',
      'key drawer',
      'share',
      'reset',
      'sat',
      'help',
      'help drawer',
      'help',
      'dock'
    ]);
    expectRings(walk);
  });

  test('a focused drawer control that disappears hands focus to the drawer heading', async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=console&cluster=heat&select=state:WA');

    const toggle = page.locator('#map-key-details-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#map-key-content')).toBeVisible();

    // A HeatRisk sequence cell inside the Key drawer's section holds focus.
    const cell = page.locator('#heatrisk-sequence [data-heatrisk-sequence-day="3"]');
    await expect(cell).toBeVisible();
    await cell.focus();
    await expect(cell).toBeFocused();

    // Leave Heat without moving focus (a programmatic click is the
    // keyboard-free equivalent of a mode change from elsewhere): the
    // section hides with the focused cell in it.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.shell-cluster-btn[data-cluster="drought"]')?.click();
    });
    await expect(page.locator('#detail-section-heatrisk-sequence')).toBeHidden();
    await expect(page.locator('#map-key-content'), 'the drawer stays open across the mode change').toBeVisible();

    const heading = page.locator('#map-key-legend .map-key-label');
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAttribute('tabindex', '-1');
  });

  test('the drought tile and the key toggle hand focus to the shown node when they swap under keyboard focus, both directions (found-088)', async ({
    page
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=brief');
    const tile = page.locator('#conditions-strip-dock .conditions-metric[data-metric="drought"]');
    const toggle = page.locator('#map-key-details-toggle');
    await expect(page.locator('#map-key')).toHaveAttribute('data-key-metric-trigger', 'true');
    await expect(tile).toBeVisible();

    // Tile to toggle: a mode change from elsewhere (a programmatic click
    // moves no focus) while the tile holds focus.
    await tile.focus();
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.shell-cluster-btn[data-cluster="heat"]')?.click();
    });
    await expect(page.locator('#map-key')).toHaveAttribute('data-key-metric-trigger', 'false');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeFocused();

    // Toggle to tile.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.shell-cluster-btn[data-cluster="drought"]')?.click();
    });
    await expect(page.locator('#map-key')).toHaveAttribute('data-key-metric-trigger', 'true');
    await expect(tile).toBeVisible();
    await expect(tile).toBeFocused();
  });

  test('a pointer click that switches mode keeps focus on the clicked button while the tile and the key toggle swap (found-088)', async ({
    page
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await stubHeatRiskCatalog(page);
    await gotoApp(page, '?view=brief');
    const tile = page.locator('#conditions-strip-dock .conditions-metric[data-metric="drought"]');
    const toggle = page.locator('#map-key-details-toggle');

    await tile.focus();
    const heat = page.locator('.shell-cluster-btn[data-cluster="heat"]');
    await heat.click();
    await expect(page.locator('#map-key')).toHaveAttribute('data-key-metric-trigger', 'false');
    await expect(toggle).toBeVisible();
    await expect(heat).toBeFocused();

    await toggle.focus();
    const drought = page.locator('.shell-cluster-btn[data-cluster="drought"]');
    await drought.click();
    await expect(page.locator('#map-key')).toHaveAttribute('data-key-metric-trigger', 'true');
    await expect(tile).toBeVisible();
    await expect(drought).toBeFocused();
  });

  test('a popup closing returns focus to the element focused before the commit', async ({ page }) => {
    await bootCollision(page);

    // Escape: a pointer click focuses the canvas before it commits, and the
    // popup takes focus on open (MapLibre focusAfterOpen).
    await clickCentreForPopup(page);
    const popup = page.locator('.maplibregl-popup');
    await expect.poll(() => popup.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(page.locator('.maplibregl-canvas')).toBeFocused();

    // The close button, pressed from the keyboard.
    await clickCentreForPopup(page);
    await page.locator('.maplibregl-popup-close-button').focus();
    await page.keyboard.press('Enter');
    await expect(popup).toHaveCount(0);
    await expect(page.locator('.maplibregl-canvas')).toBeFocused();

    // A replacement in place (the "Other map features here" switcher) keeps
    // the FIRST commit's element: the switcher's button is gone with the
    // popup it lived in, so the close goes back to the canvas.
    await clickCentreForPopup(page, true);
    const title = (await popup.locator('.popup-title').textContent())?.trim();
    await popup.locator('.popup-other-features > summary').focus();
    await page.keyboard.press('Enter');
    const other = popup.locator('.popup-other-item').first();
    await other.focus();
    await page.keyboard.press('Enter');
    await expect(popup).toHaveCount(1);
    await expect(popup.locator('.popup-title')).not.toHaveText(title ?? '');
    await expect.poll(() => popup.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(page.locator('.maplibregl-canvas')).toBeFocused();
  });
});
