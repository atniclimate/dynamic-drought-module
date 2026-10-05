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

/*
 * KEYBOARD IDENTIFY (interface-chrome R3 a; RULINGS.md F; D1.md section 9
 * item 3), Tier 2. It ships behind `KEYBOARD_IDENTIFY` in
 * src/config/map-chrome.ts, which stays FALSE. The cases that need it on
 * set the test seam `window.__ddmKeyboardIdentify = true` before boot
 * (`forceKeyboardIdentify`); no shipped page sets it. This section and the
 * flag leave together.
 */

/** Set the keyboard-identify test seam before the app's own scripts run. */
async function forceKeyboardIdentify(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __ddmKeyboardIdentify?: boolean }).__ddmKeyboardIdentify = true;
  });
}

/** The `#map::after` centre cross, as computed. */
async function readCross(page: Page): Promise<{
  content: string;
  display: string;
  width: string;
  height: string;
  backgroundImage: string;
  animationName: string;
  transitionDuration: string;
}> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('map')!, '::after');
    return {
      content: cs.content,
      display: cs.display,
      width: cs.width,
      height: cs.height,
      backgroundImage: cs.backgroundImage,
      animationName: cs.animationName,
      transitionDuration: cs.transitionDuration
    };
  });
}

function crossShown(cross: { content: string; display: string }): boolean {
  return cross.content !== 'none' && cross.content !== 'normal' && cross.display !== 'none';
}


test.describe('keyboard identify behind KEYBOARD_IDENTIFY (S30D D1 M28)', () => {
  test('Enter on the focused canvas opens the frame for the centre with focus inside, and Escape returns focus to the canvas', async ({
    page
  }) => {
    await forceKeyboardIdentify(page);
    await bootCollision(page);

    const canvas = page.locator('.maplibregl-canvas');
    const popup = page.locator('.maplibregl-popup');
    await expect(async () => {
      await canvas.focus();
      await page.keyboard.press('Enter');
      await expect(popup).toHaveCount(1, { timeout: 1500 });
    }).toPass({ timeout: 20_000 });

    // The frame for the centre: the coordinator's framed response, with focus inside it.
    await expect(popup.locator('[data-popup-frame]')).toHaveCount(1);
    await expect.poll(() => popup.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(canvas).toBeFocused();

    // Space does the same.
    await page.keyboard.press('Space');
    await expect(popup).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(canvas).toBeFocused();
  });

  test('with the shipped KEYBOARD_IDENTIFY (false), Enter and Space on the focused canvas open nothing', async ({ page }) => {
    await bootCollision(page);
    // Prove the centre is identifiable right now (a pointer click answers),
    // then close it, so a missing keyboard answer cannot be a paint delay.
    await clickCentreForPopup(page);
    await page.keyboard.press('Escape');
    const popup = page.locator('.maplibregl-popup');
    await expect(popup).toHaveCount(0);

    const canvas = page.locator('.maplibregl-canvas');
    await canvas.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    // A keyboard commit is synchronous with the keydown (the frame is warm
    // after the pointer commit above), so nothing has painted by now.
    expect(await popup.count()).toBe(0);
    await expect(canvas).toBeFocused();
    await expect(page.locator('#map')).not.toHaveAttribute('data-ddm-keyboard-identify', /.*/);
    expect(crossShown(await readCross(page)), 'no centre cross while the flag is off').toBe(false);
  });

  test('the centre cross shows only under :focus-visible and never under reduced motion change', async ({ page }) => {
    await forceKeyboardIdentify(page);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoApp(page, '?view=console&sidebar=closed');
    const canvas = page.locator('.maplibregl-canvas');

    expect(crossShown(await readCross(page)), 'no cross before focus').toBe(false);

    // Pointer focus (mousedown on the canvas) is :focus but not :focus-visible.
    // The press ends as a drag, so no click commits.
    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('the map has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(canvas).toBeFocused();
    expect(await canvas.evaluate((el) => el.matches(':focus-visible'))).toBe(false);
    expect(crossShown(await readCross(page)), 'no cross under pointer focus').toBe(false);
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 4 });
    await page.mouse.up();

    // Keyboard focus: from the chip, Shift+Tab reaches the canvas.
    await page.locator('#map-key-details-toggle').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(canvas).toBeFocused();
    expect(await canvas.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    const shown = await readCross(page);
    expect(crossShown(shown), 'the cross shows under :focus-visible').toBe(true);
    expect(shown.width).toBe('16px');
    expect(shown.height).toBe('16px');
    expect(shown.animationName).toBe('none');
    expect(shown.transitionDuration).toBe('0s');

    // Reduced motion changes nothing about it: the same static cross.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await readCross(page)).toEqual(shown);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await readCross(page)).toEqual(shown);

    // Focus leaves: the cross goes.
    await page.keyboard.press('Tab');
    expect(crossShown(await readCross(page)), 'no cross once the canvas loses focus').toBe(false);
  });
});
