import { test, expect, type Locator, type Page } from './offline-test';
import { PNG } from 'pngjs';
import {
  MAP_CELL_ANATOMY,
  MAP_CHROME_SEATS,
  mapCellIconCentreX,
  type MapChromeSeat
} from '../src/config/map-chrome';
import { gotoApp } from './helpers';

/**
 * Every column icon is optically centred, measured (S30D D1 M9; register
 * owner-1f, DDM-P10-T11; design record interface-chrome-popups-text.md
 * section 5, "Optical centring", for the four family icons: no 3D seat,
 * no TL-0 and no chip yet, which arrive with D4 and M10).
 *
 * METHOD. At deviceScaleFactor 2, with the map canvas hidden over a flat
 * ground, animations disabled and after `document.fonts.ready`, each icon's
 * SVG box plus 2 px is captured and decoded with pngjs. A pixel is ink
 * when its relative luminance departs from the cell face's by at least half
 * the ink-to-face difference (the face is read from the capture's own
 * border, the ink from the button's computed colour). Then:
 * - the ink box's centre is within 0.5 CSS px of the icon column's centre
 *   (x: the cell's left edge + 1 px edge + 9 px padding + 10; y: the cell's
 *   middle);
 * - the ink-weighted centroid is within 1 px on each axis the glyph is
 *   symmetric about (GLYPH_OPTICS);
 * - all four icons share one x within 0.5 px, and that x is the formula's
 *   (`mapCellIconCentreX`: W - 120 in container px at the 128 px cell).
 * Under R1 a the words are checked too: their left edges share one x
 * within 0.5 px, each word's trimmed box centres in its cell within 1 px,
 * and each word's text ends at least the 1 px edge plus 9 px padding
 * inside its cell's right edge. That inset check exists because
 * scrollWidth cannot see the failure: at 124 px "Share view" ran about
 * 2.4 px into the padding with scrollWidth equal to clientWidth (the
 * director's probe, 2026-09-27), which raised --map-cell-w to 128 px
 * (D1.md :295: the measured need, never an ellipsis).
 * At rest, on hover, and pressed (SAT on, Help open), then again in 44 px
 * cells under a coarse pointer.
 *
 * Predicted red on the pre-M9 tree: the module import fails; with the table
 * supplied, the icons sit on three axes (about x 1345, 1357 and 1365 at
 * 1440 wide), and the Reset glyph's ink sits 0.83 px left of its box.
 */

test.use({ deviceScaleFactor: 2 });

type Axis = 'x' | 'y';

/** Which axes each glyph is mirror or point symmetric about. */
const GLYPH_OPTICS: Readonly<Record<MapChromeSeat['key'], readonly Axis[]>> = {
  // Feather rotate-ccw: an open arc and an arrowhead, no axis of symmetry;
  // only its ink box is centred.
  reset: [],
  // The satellite: point symmetric about (12, 12), so both axes.
  satellite: ['x', 'y'],
  // A circle around a question mark: the mark is not mirror symmetric.
  help: [],
  // The tray and the arrow mirror about x = 12.
  share: ['x']
};

const ICON_TOLERANCE = 0.5;
const CENTROID_TOLERANCE = 1;
const LABEL_TOLERANCE = 1;

interface IconReading {
  readonly key: string;
  readonly state: string;
  readonly inkCentreX: number;
  readonly inkCentreY: number;
  readonly centroidX: number;
  readonly centroidY: number;
  readonly slotCentreX: number;
  readonly slotCentreY: number;
  readonly containerLeft: number;
  readonly containerWidth: number;
  readonly viewportWidth: number;
}

function luminance(r: number, g: number, b: number): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function parseRgb(value: string): [number, number, number] {
  const m = /rgba?\(\s*([0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)/.exec(value);
  if (!m) throw new Error(`unreadable colour ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function hideCanvas(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '#map .maplibregl-canvas { visibility: hidden !important; }' +
      ' #map, #map-container { background: #808080 !important; }'
  });
  await page.evaluate(() => document.fonts.ready);
}

async function readIcon(page: Page, key: string, state: string, control: Locator): Promise<IconReading> {
  const svg = control.locator(':scope > svg');
  const box = await svg.boundingBox();
  const cell = await control.boundingBox();
  const container = await page.locator('#map-container').boundingBox();
  if (!box || !cell || !container) throw new Error(`${key}: no box to measure`);
  const clip = { x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4 };
  const png = PNG.sync.read(await page.screenshot({ clip, animations: 'disabled' }));
  const scale = png.width / clip.width;
  const ink = parseRgb(await control.evaluate((element) => getComputedStyle(element).color));
  const inkY = luminance(...ink);

  // The face: the median luminance of the capture's outermost ring.
  const ring: number[] = [];
  const lum = (x: number, y: number): number => {
    const i = (y * png.width + x) * 4;
    return luminance(png.data[i]!, png.data[i + 1]!, png.data[i + 2]!);
  };
  for (let x = 0; x < png.width; x += 1) ring.push(lum(x, 0), lum(x, png.height - 1));
  for (let y = 0; y < png.height; y += 1) ring.push(lum(0, y), lum(png.width - 1, y));
  ring.sort((a, b) => a - b);
  const faceY = ring[Math.floor(ring.length / 2)]!;
  const span = Math.abs(inkY - faceY);
  if (span < 0.05) throw new Error(`${key} ${state}: ink and face are indistinguishable`);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const d = Math.abs(lum(x, y) - faceY) / span;
      if (d >= 0.5) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const w = Math.min(1, d);
      weight += w;
      sumX += w * (x + 0.5);
      sumY += w * (y + 0.5);
    }
  }
  if (!Number.isFinite(minX)) throw new Error(`${key} ${state}: no ink found`);
  const { edge, paddingInline, iconColumn } = MAP_CELL_ANATOMY;
  return {
    key,
    state,
    inkCentreX: clip.x + (minX + maxX + 1) / 2 / scale,
    inkCentreY: clip.y + (minY + maxY + 1) / 2 / scale,
    centroidX: clip.x + sumX / weight / scale,
    centroidY: clip.y + sumY / weight / scale,
    slotCentreX: cell.x + edge + paddingInline + iconColumn / 2,
    slotCentreY: cell.y + cell.height / 2,
    containerLeft: container.x,
    containerWidth: container.width,
    viewportWidth: page.viewportSize()?.width ?? 0
  };
}

function iconProblems(readings: readonly IconReading[]): string[] {
  const problems: string[] = [];
  for (const r of readings) {
    const where = `${r.key} (${r.state})`;
    const dx = r.inkCentreX - r.slotCentreX;
    const dy = r.inkCentreY - r.slotCentreY;
    if (Math.abs(dx) > ICON_TOLERANCE) problems.push(`${where}: ink box centre x off by ${dx.toFixed(2)} px`);
    if (Math.abs(dy) > ICON_TOLERANCE) problems.push(`${where}: ink box centre y off by ${dy.toFixed(2)} px`);
    const formulaX = r.containerLeft + mapCellIconCentreX(r.containerWidth, r.viewportWidth);
    if (Math.abs(r.inkCentreX - formulaX) > ICON_TOLERANCE) {
      problems.push(`${where}: ink centre x ${r.inkCentreX.toFixed(2)}, formula ${formulaX}`);
    }
    for (const axis of GLYPH_OPTICS[r.key as MapChromeSeat['key']] ?? []) {
      const off = axis === 'x' ? r.centroidX - r.slotCentreX : r.centroidY - r.slotCentreY;
      if (Math.abs(off) > CENTROID_TOLERANCE) {
        problems.push(`${where}: ink centroid ${axis} off by ${off.toFixed(2)} px`);
      }
    }
  }
  const byState = new Map<string, number[]>();
  for (const r of readings) byState.set(r.state, [...(byState.get(r.state) ?? []), r.inkCentreX]);
  for (const [state, xs] of byState) {
    const spread = Math.max(...xs) - Math.min(...xs);
    if (spread > ICON_TOLERANCE) {
      problems.push(`${state}: the icons sit on ${spread.toFixed(2)} px of x (${xs.map((x) => x.toFixed(2)).join(', ')})`);
    }
  }
  return problems;
}

async function labelProblems(page: Page, state: string): Promise<string[]> {
  const readings = await page.evaluate((selectors) => {
    return selectors.map((selector) => {
      const button = document.querySelector<HTMLElement>(selector);
      const label = button?.querySelector<HTMLElement>(':scope > span');
      if (!button || !label) return { selector, missing: true as const };
      const b = button.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      return {
        selector,
        missing: false as const,
        text: label.textContent?.trim() ?? '',
        left: l.left,
        centreY: l.top + l.height / 2,
        cellCentreY: b.top + b.height / 2,
        visible: getComputedStyle(label).display !== 'none' && l.width > 0,
        overflowX: button.scrollWidth - button.clientWidth,
        labelOverflowX: label.scrollWidth - label.clientWidth,
        // The word's own text box, not the span's grid track: the text can
        // run past the track into the padding with no scroll overflow.
        rightInset: (() => {
          const range = document.createRange();
          range.selectNodeContents(label);
          return b.right - range.getBoundingClientRect().right;
        })()
      };
    });
  }, MAP_CHROME_SEATS.map((seat) => seat.controlSelector));
  const problems: string[] = [];
  const lefts: number[] = [];
  for (const r of readings) {
    if (r.missing) {
      problems.push(`${state}: ${r.selector} or its word is missing`);
      continue;
    }
    if (!r.visible) problems.push(`${state}: ${r.selector} shows no word (R1 a labels every cell)`);
    lefts.push(r.left);
    const off = r.centreY - r.cellCentreY;
    if (Math.abs(off) > LABEL_TOLERANCE) {
      problems.push(`${state}: "${r.text}" sits ${off.toFixed(2)} px off its cell's middle`);
    }
    if (r.overflowX > 0.5 || r.labelOverflowX > 0.5) {
      problems.push(
        `${state}: "${r.text}" overflows its cell by ${Math.max(r.overflowX, r.labelOverflowX).toFixed(1)} px ` +
          '(D1.md :295: raise --map-cell-w to the measured need)'
      );
    }
    const designedInset = MAP_CELL_ANATOMY.edge + MAP_CELL_ANATOMY.paddingInline;
    if (r.rightInset < designedInset - 0.5) {
      problems.push(
        `${state}: "${r.text}" ends ${r.rightInset.toFixed(2)} px inside its cell's right edge, ` +
          `under the designed ${designedInset} px (D1.md :295: raise --map-cell-w to the measured need)`
      );
    }
  }
  if (lefts.length > 1 && Math.max(...lefts) - Math.min(...lefts) > ICON_TOLERANCE) {
    problems.push(`${state}: the words start on ${lefts.map((x) => x.toFixed(2)).join(', ')}`);
  }
  return problems;
}

async function measureColumn(page: Page, mode: string): Promise<string[]> {
  const problems: string[] = [];
  const controls = MAP_CHROME_SEATS.map((seat) => ({
    key: seat.key,
    control: page.locator(seat.controlSelector)
  }));
  for (const { control } of controls) await expect(control).toBeVisible();

  // SAT boots ON (DR-105), so its state is set explicitly for each phase
  // rather than toggled blind: off for rest and hover, on for pressed, and
  // back to its boot state at the end (the director's M9 gate, 2026-09-27).
  const sat = page.locator('#basemap-switcher-overlay-host .basemap-switcher-btn');
  const satBoot = await sat.getAttribute('aria-pressed');
  const setSat = async (on: boolean): Promise<void> => {
    if ((await sat.getAttribute('aria-pressed')) !== String(on)) await sat.click();
    await expect(sat).toHaveAttribute('aria-pressed', String(on));
  };
  await setSat(false);

  const rest: IconReading[] = [];
  const hover: IconReading[] = [];
  for (const { key, control } of controls) {
    await page.mouse.move(0, 0);
    rest.push(await readIcon(page, key, `${mode}, rest`, control));
    await control.hover();
    hover.push(await readIcon(page, key, `${mode}, hover`, control));
  }
  await page.mouse.move(0, 0);
  problems.push(...iconProblems(rest), ...iconProblems(hover));
  problems.push(...(await labelProblems(page, `${mode}, rest`)));

  // Pressed: SAT on (aria-pressed) and Help open (aria-expanded), measured
  // together with the two neighbours at rest so the shared x still holds.
  const help = page.locator('#map-info-seat > #map-info-btn');
  await setSat(true);
  await help.click();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.move(0, 0);
  const pressed: IconReading[] = [];
  for (const { key, control } of controls) {
    pressed.push(await readIcon(page, key, `${mode}, SAT and Help pressed`, control));
  }
  problems.push(...iconProblems(pressed));
  problems.push(...(await labelProblems(page, `${mode}, SAT and Help pressed`)));
  await page.keyboard.press('Escape');
  await expect(help).toHaveAttribute('aria-expanded', 'false');
  await setSat(satBoot === 'true');
  return problems;
}

test.describe('the desktop column icons (D1 M9)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("every column icon's ink box centres in its slot within 0.5 px, and all share one x", async ({
    page
  }) => {
    test.setTimeout(120_000);
    // Console keeps Share home in slot 4, so all four icons are measured.
    await gotoApp(page, '?view=console');
    await hideCanvas(page);
    expect(await measureColumn(page, 'fine pointer')).toEqual([]);
  });

  test.describe('in 44 px cells under a coarse pointer', () => {
    test.use({ hasTouch: true });

    test("every column icon's ink box centres in its 44 px slot within 0.5 px, and all share one x", async ({
      page
    }) => {
      test.setTimeout(120_000);
      await gotoApp(page, '?view=console');
      expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);
      await hideCanvas(page);
      const cell = await page.locator('#reset-btn').boundingBox();
      expect(cell?.height).toBe(44);
      expect(await measureColumn(page, 'coarse pointer')).toEqual([]);
    });
  });
});
