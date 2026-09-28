import { test, expect, type Page } from '@playwright/test';
import {
  MAP_CHROME_SEATS,
  MAP_CHROME_TABLET_BAND,
  MAP_CHROME_TOKENS,
  isTabletBand,
  mapChromeSeatRect,
  tl0SeatRect,
  chipSeatRect,
  type MapChromeRect,
  type MapChromeSlot
} from '../src/config/map-chrome';
import { gotoApp, layerCheckbox, waitForLayerSettled } from './helpers';

/**
 * The desktop map chrome holds its seats to 1 px (S30D D1 M9; register
 * owner-1f, DDM-P10-T11; the 2026-09-13 stable-position rule; design
 * record interface-chrome-popups-text.md section 5, "1 px stability",
 * restricted here to the column's four slots). M10 and M11 append their
 * seats (the chip, TL-0, the pill, the dock, the drawers) to this file.
 *
 * METHOD. Every rectangle is read relative to `#map-container`, over three
 * consecutive animation frames per phase, and checked two ways:
 * - against the token formula in src/config/map-chrome.ts
 *   (`mapChromeSeatRect`): x = W - chromeInset - mapCellW, y = chromeInset
 *   + (slot - 1) * (mapCellH + mapCellGap), mapCellW x mapCellH (128 x 40
 *   on a fine pointer since the director's 2026-09-27 fit measurement;
 *   44 x 44 icon squares on every pointer in the 721 to 1024 px tablet
 *   band, owner ruling DR-153);
 * - against the FIRST sample of the run, on the four numbers a desktop
 *   seat must never change: y, the inset from the container's right edge,
 *   width and height. (x in container px moves by exactly the sidebar's
 *   width when the sidebar opens or closes, because the column is right
 *   anchored; its viewport x does not. The right inset is that invariant
 *   written in container px, and the formula check pins x itself.)
 * Any |d| over 1 px fails. The four slots must also be pairwise disjoint by
 * at least 4 px and lie inside the container.
 *
 * Slot 4 is the reserved Share slot (ruling R2 a). Its box is always
 * measured; the Share button is measured too whenever it is home in the
 * column (Console, or the sidebar collapsed), and must fill exactly that
 * box. In Brief with the sidebar open the shell rehosts Share into the
 * sidebar foot, which must empty slot 4 and move nothing.
 *
 * WHAT IS SAMPLED, AND WHY NOT THE FULL CROSS PRODUCT. At each of the four
 * desktop viewports: the settled boot; EVERY mode read from the rendered
 * `.shell-cluster-btn[data-cluster]` (DR-113: never a literal list), each
 * held in loading by a request gate and then settled; EVERY horizon read
 * from `.shell-horizon-btn`; help's drawer open and closed; Brief and
 * Console, each with the sidebar open and collapsed (the Share rehost and
 * its return); and a second boot with a `select=` selection. Modes and
 * horizons are crossed with Brief and the open sidebar only, because the
 * sidebar and view states are sampled on their own at every viewport and
 * none of the three inputs reaches the column's geometry; the full product
 * would be 4 x 2 x 2 x N x 3 boots of the same numbers.
 *
 * THE LOADING GATE (the s4-shell technique, made mode-neutral). While a
 * phase holds it, every request to another origin waits, then falls back
 * to whatever the suite's stubs answer, so a mode switch sits in its
 * pending state for as long as the phase samples. The gate claims no
 * pattern the shared stubs own, and releases in a `finally`.
 *
 * Predicted red on the pre-M9 tree (93ebe44 to dbbe24b): the module import
 * fails (no src/config/map-chrome.ts); with the table supplied, help sits
 * at the bottom right (y about H - 36, not 100), the old column is 104 wide
 * at x W - 116 (not 128 wide at W - 140), and Reset and SAT move 38 px when
 * Share returns to the column.
 */

const DESKTOP_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const;

const TOLERANCE = 1;
const MIN_GAP = 4;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The container's right edge minus the box's right edge. */
  readonly rightInset: number;
}

interface SeatReading {
  readonly slot: MapChromeSlot;
  readonly box: Box | null;
  /** The control's box when it sits in the column, else null. */
  readonly control: Box | null;
}

interface Sample {
  readonly phase: string;
  readonly frame: number;
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly viewportWidth: number;
  readonly coarse: boolean;
  readonly seats: readonly SeatReading[];
}

const SEAT_QUERIES = MAP_CHROME_SEATS.map((seat) => ({
  slot: seat.slot,
  slotSelector: seat.slotSelector,
  controlSelector: seat.controlSelector
}));

/** Slots whose control must be in the column in every phase (all but Share). */
const ALWAYS_SEATED = new Set<MapChromeSlot>(
  MAP_CHROME_SEATS.filter((seat) => seat.alwaysSeated).map((seat) => seat.slot)
);

/** Three consecutive painted frames of every seat, relative to the map. */
async function sampleSeats(page: Page, phase: string): Promise<Sample[]> {
  const frames = await page.evaluate(async (queries) => {
    const frame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      await frame();
      const container = document.getElementById('map-container');
      if (!container) throw new Error('#map-container is missing');
      const c = container.getBoundingClientRect();
      const column = document.querySelector('.map-overlay-controls');
      const boxOf = (element: Element | null) => {
        if (!element) return null;
        const r = element.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return {
          x: r.left - c.left,
          y: r.top - c.top,
          width: r.width,
          height: r.height,
          rightInset: c.right - r.right
        };
      };
      out.push({
        containerWidth: c.width,
        containerHeight: c.height,
        viewportWidth: window.innerWidth,
        coarse: window.matchMedia('(pointer: coarse)').matches,
        seats: queries.map((q) => {
          const control = document.querySelector(q.controlSelector);
          return {
            slot: q.slot,
            box: boxOf(document.querySelector(q.slotSelector)),
            control: control && column?.contains(control) ? boxOf(control) : null
          };
        })
      });
    }
    return out;
  }, SEAT_QUERIES);
  return frames.map((f, index) => ({ ...f, phase, frame: index + 1 }) as Sample);
}

/**
 * Wait until the container and the column hold still for two frames (the
 * sidebar's 200 ms width transition, a font swap). Never a fixed sleep.
 */
async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const read = (): string =>
      ['#map-container', '.map-overlay-controls']
        .map((s) => {
          const r = document.querySelector(s)?.getBoundingClientRect();
          return r ? `${r.left},${r.top},${r.width},${r.height}` : 'none';
        })
        .join(';');
    let previous = read();
    let still = 0;
    for (let i = 0; i < 90 && still < 2; i += 1) {
      await frame();
      const next = read();
      still = next === previous ? still + 1 : 0;
      previous = next;
    }
  });
}

function drift(a: number, b: number): boolean {
  return Math.abs(a - b) > TOLERANCE;
}

function formulaProblems(sample: Sample, label: string, box: Box, expected: MapChromeRect): string[] {
  const problems: string[] = [];
  for (const [key, actual, want] of [
    ['x', box.x, expected.x],
    ['y', box.y, expected.y],
    ['width', box.width, expected.width],
    ['height', box.height, expected.height]
  ] as const) {
    if (drift(actual, want)) {
      problems.push(
        `${sample.phase} (frame ${sample.frame}): ${label} ${key} ${actual.toFixed(1)}, formula ${want}`
      );
    }
  }
  return problems;
}

/** Every rule of the method, over every sample of one run. */
function seatProblems(samples: readonly Sample[]): string[] {
  const problems: string[] = [];
  const first = samples[0];
  if (!first) return ['no samples were taken'];
  const firstBox = new Map<MapChromeSlot, Box>();
  for (const seat of first.seats) if (seat.box) firstBox.set(seat.slot, seat.box);

  for (const sample of samples) {
    const boxes: Array<{ slot: MapChromeSlot; box: Box }> = [];
    for (const seat of sample.seats) {
      const expected = mapChromeSeatRect(
        seat.slot,
        sample.containerWidth,
        sample.viewportWidth,
        sample.coarse
      );
      if (!seat.box) {
        problems.push(`${sample.phase} (frame ${sample.frame}): slot ${seat.slot} has no box`);
        continue;
      }
      boxes.push({ slot: seat.slot, box: seat.box });
      problems.push(...formulaProblems(sample, `slot ${seat.slot}`, seat.box, expected));
      if (seat.control) {
        problems.push(
          ...formulaProblems(sample, `slot ${seat.slot} control`, seat.control, expected)
        );
      } else if (ALWAYS_SEATED.has(seat.slot)) {
        problems.push(
          `${sample.phase} (frame ${sample.frame}): slot ${seat.slot}'s control is not in the column`
        );
      }
      const before = firstBox.get(seat.slot);
      if (before) {
        for (const key of ['y', 'rightInset', 'width', 'height'] as const) {
          if (drift(seat.box[key], before[key])) {
            problems.push(
              `${sample.phase} (frame ${sample.frame}): slot ${seat.slot} ${key} moved ` +
                `${before[key].toFixed(1)} -> ${seat.box[key].toFixed(1)} since "${first.phase}"`
            );
          }
        }
      }
      const b = seat.box;
      if (b.x < -0.5 || b.y < -0.5 || b.x + b.width > sample.containerWidth + 0.5 ||
        b.y + b.height > sample.containerHeight + 0.5) {
        problems.push(`${sample.phase}: slot ${seat.slot} leaves the map container`);
      }
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!.box;
        const b = boxes[j]!.box;
        const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
        const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
        if (Math.max(gapX, gapY) < MIN_GAP - 0.01) {
          problems.push(
            `${sample.phase}: slots ${boxes[i]!.slot} and ${boxes[j]!.slot} are ` +
              `${Math.max(gapX, gapY).toFixed(1)} px apart (at least ${MIN_GAP})`
          );
        }
      }
    }
  }
  return problems;
}

/**
 * A request gate for loading phases: while held, every request to another
 * origin waits for release, then falls back to the suite's stubs.
 */
async function installLoadingGate(page: Page): Promise<{
  hold(): void;
  release(): void;
}> {
  let holding = false;
  let open: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  let appOrigin = '';
  await page.route(
    (url) => holding && appOrigin !== '' && url.origin !== appOrigin,
    async (route) => {
      await gate;
      await route.fallback();
    }
  );
  return {
    hold() {
      appOrigin = new URL(page.url()).origin;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      holding = true;
    },
    release() {
      holding = false;
      open();
    }
  };
}

async function setSidebar(page: Page, state: 'open' | 'collapsed'): Promise<void> {
  const app = page.locator('#app');
  const collapsed = /\bsidebar-collapsed\b/;
  if (state === 'collapsed') {
    await page.locator('#sidebar-collapse').click();
    await expect(app).toHaveClass(collapsed);
  } else {
    await page.locator('#sidebar-expand').click();
    await expect(app).not.toHaveClass(collapsed);
  }
  await settleLayout(page);
}

async function setView(page: Page, view: 'brief' | 'console'): Promise<void> {
  const button = page.locator(`.view-switch [data-view="${view}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await settleLayout(page);
}

const shareInColumn = (page: Page) => page.locator('.map-overlay-controls > #share-btn');
const shareInSidebar = (page: Page) => page.locator('#shell-share-host > #share-btn');

test.describe('the desktop column holds its four seats (D1 M9)', () => {
  for (const viewport of DESKTOP_VIEWPORTS) {
    test(`Reset, SAT, Help and the reserved Share slot hold their MAP_CHROME_SEATS rects within 1 px across modes, horizons, loading, selection and the Share rehost at ${viewport.width}x${viewport.height}`, async ({
      page
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      const gate = await installLoadingGate(page);
      const samples: Sample[] = [];
      const sample = async (phase: string): Promise<void> => {
        samples.push(...(await sampleSeats(page, phase)));
      };

      try {
        await gotoApp(page);
        await settleLayout(page);
        // The default desktop boot: Brief, sidebar open, Share rehosted.
        await expect(shareInSidebar(page)).toHaveCount(1);
        await sample('Brief, sidebar open, settled (Share rehosted)');

        // Every mode, from the rendered switcher, held in loading and then
        // settled. The committed mode is visited last so each switch is a
        // real change, then the boot mode is restored.
        const modes = await page
          .locator('.shell-cluster-btn[data-cluster]')
          .evaluateAll((buttons) =>
            buttons.map((b) => ({
              key: b.getAttribute('data-cluster') ?? '',
              pressed: b.getAttribute('aria-pressed') === 'true'
            }))
          );
        expect(modes.length, 'the switcher rendered no modes').toBeGreaterThan(0);
        const order = [...modes.filter((m) => !m.pressed), ...modes.filter((m) => m.pressed)];
        for (const { key } of order) {
          const button = page.locator(`.shell-cluster-btn[data-cluster="${key}"]`);
          gate.hold();
          try {
            await button.click();
            await expect(button).toHaveAttribute('aria-pressed', 'true');
            const held = await expect(button)
              .toHaveAttribute('data-pending', 'true', { timeout: 5_000 })
              .then(() => true, () => false);
            await sample(`${key}, ${held ? 'loading (held)' : 'switching (no pending state)'}`);
          } finally {
            gate.release();
          }
          await expect(button).toHaveAttribute('data-pending', 'false', { timeout: 30_000 });
          await settleLayout(page);
          await sample(`${key}, settled`);
        }

        // Every horizon, from the rendered chips; a disabled chip is sampled
        // in place (its click is a no-op by design).
        const horizons = await page
          .locator('.shell-horizon-btn')
          .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-horizon') ?? ''));
        expect(horizons.length, 'the shell rendered no horizons').toBeGreaterThan(0);
        for (const horizon of horizons) {
          const chip = page.locator(`.shell-horizon-btn[data-horizon="${horizon}"]`);
          const disabled = (await chip.getAttribute('aria-disabled')) === 'true';
          if (!disabled) {
            await chip.click();
            await expect(chip).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('.shell-cluster-btn[aria-pressed="true"]')).toHaveAttribute(
              'data-pending',
              'false',
              { timeout: 30_000 }
            );
          }
          await settleLayout(page);
          await sample(`horizon ${horizon}${disabled ? ' (disabled chip)' : ''}`);
        }

        // Help's drawer opens against the column and moves no seat.
        await page.locator('#map-info-btn').click();
        await expect(page.locator('#map-info-panel')).toBeVisible();
        await settleLayout(page);
        await sample('Help drawer open');
        await page.keyboard.press('Escape');
        await expect(page.locator('#map-info-panel')).toBeHidden();
        await sample('Help drawer closed');

        // Brief and Console, each with the sidebar open and collapsed: the
        // Share rehost and its return, and the column's right anchoring.
        await setView(page, 'console');
        await expect(shareInColumn(page)).toHaveCount(1);
        await sample('Console, sidebar open (Share in slot 4)');
        await setSidebar(page, 'collapsed');
        await expect(shareInColumn(page)).toHaveCount(1);
        await sample('Console, sidebar collapsed');
        await setSidebar(page, 'open');
        await setView(page, 'brief');
        await expect(shareInSidebar(page)).toHaveCount(1);
        await sample('Brief, sidebar open again (Share rehosted)');
        await setSidebar(page, 'collapsed');
        await expect(shareInColumn(page)).toHaveCount(1);
        await sample('Brief, sidebar collapsed (Share returned)');
        await setSidebar(page, 'open');
        await expect(shareInSidebar(page)).toHaveCount(1);
        await sample('Brief, sidebar open after the round trip');

        // A selection, from the URL, on a fresh boot of the same viewport.
        await gotoApp(page, '?select=state:WA');
        await settleLayout(page);
        await sample('select=state:WA');
      } finally {
        gate.release();
      }

      // Share filled slot 4 exactly whenever it was home.
      const shareHome = samples.filter((s) => s.seats.find((seat) => seat.slot === 4)?.control);
      expect(shareHome.length, 'Share was never measured in slot 4').toBeGreaterThan(0);
      expect(seatProblems(samples)).toEqual([]);
    });
  }

  test.describe('on a coarse pointer', () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: true });

    test('the cells take the 44 px floor and the slots follow the formula', async ({ page }) => {
      await gotoApp(page, '?view=console');
      expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);
      await settleLayout(page);
      const samples = await sampleSeats(page, 'coarse, Console, sidebar open');
      expect(samples[0]?.seats.find((s) => s.slot === 4)?.control).toBeTruthy();
      expect(seatProblems(samples)).toEqual([]);
      const cell = mapChromeSeatRect(3, samples[0]!.containerWidth, samples[0]!.viewportWidth, true);
      expect(cell.height).toBe(44);
      expect(cell.y).toBe(MAP_CHROME_TOKENS.chromeInset + 2 * (44 + MAP_CHROME_TOKENS.mapCellGap));
    });
  });

  test.describe('the tablet band and its edge', () => {
    // Owner ruling DR-153 (2026-09-28): across the app's own 721 to 1024 px
    // tablet query, sidebar open or collapsed, the family is 44 px icon
    // squares on every pointer, the word visually hidden and every name
    // and title kept (DR-154); from 1025 px the labelled cells of R1 a.
    const NAMES: Readonly<Record<string, string>> = {
      '#reset-btn': 'Reset map view',
      '#basemap-switcher-overlay-host .basemap-switcher-btn': 'SAT: satellite imagery',
      '#map-info-seat > #map-info-btn': 'Help and map information',
      '.map-overlay-controls > #share-btn': 'Share view'
    };
    const SCENARIOS = [
      { width: 820, height: 1180, sidebar: 'open' },
      { width: 1024, height: 768, sidebar: 'collapsed' },
      { width: 1025, height: 768, sidebar: 'open' },
      { width: 1280, height: 720, sidebar: 'open' }
    ] as const;

    test('icon squares from 721 to 1024 px, open or collapsed, labelled cells from 1025, names kept at every width', async ({
      page
    }) => {
      test.setTimeout(120_000);
      for (const scenario of SCENARIOS) {
        const where = `${scenario.width}x${scenario.height}, sidebar ${scenario.sidebar}`;
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        // Console keeps Share home in slot 4, so all four cells are measured.
        await gotoApp(page, '?view=console');
        if (scenario.sidebar === 'collapsed') await setSidebar(page, 'collapsed');
        await settleLayout(page);

        const samples = await sampleSeats(page, where);
        expect(seatProblems(samples), where).toEqual([]);
        const band = isTabletBand(scenario.width);
        const expectedWidth = band ? MAP_CHROME_TABLET_BAND.cell : MAP_CHROME_TOKENS.mapCellW;
        for (const seat of samples[0]!.seats) {
          expect(seat.control?.width ?? 0, `${where}: slot ${seat.slot} width`).toBeCloseTo(expectedWidth, 0);
          if (band) {
            expect(seat.control?.height ?? 0, `${where}: slot ${seat.slot} height`).toBeCloseTo(
              MAP_CHROME_TABLET_BAND.cell,
              0
            );
          }
        }

        for (const [selector, name] of Object.entries(NAMES)) {
          const control = page.locator(selector);
          // The name is kept whether the word shows or not (DR-154).
          await expect(control, `${where}: ${selector}`).toHaveAccessibleName(name);
          const word = await control.locator(':scope > span').boundingBox();
          if (band) {
            // Visually hidden the .sr-only way: a 1 px box, still in the tree.
            expect(word?.width ?? 0, `${where}: ${selector} shows its word`).toBeLessThanOrEqual(1);
          } else {
            expect(word?.width ?? 0, `${where}: ${selector} hides its word`).toBeGreaterThan(10);
          }
        }
        // The hover title stays (no hover tag replaces it).
        await expect(page.locator('#reset-btn')).toHaveAttribute('title', 'Reset to selected region bounds');
      }
    });
  });

  test('phones and embeds keep help, SAT and Share in their homes', async ({ page }) => {
    // The column is desktop-shell-only: at 390x844 and in an embed the
    // seat helper keeps help beside its home anchor and SAT in MapLibre's
    // corner, the slot boxes take no space, and Share stays a direct child
    // of the stack its phone and embed rules order.
    for (const [viewport, query] of [
      [{ width: 390, height: 844 }, ''],
      [{ width: 1280, height: 800 }, '?embed=true']
    ] as const) {
      await page.setViewportSize(viewport);
      await gotoApp(page, query);
      await expect(page.locator('#map-info-home + #map-info-btn + #map-info-panel')).toHaveCount(1);
      await expect(page.locator('#map-info-seat > *')).toHaveCount(0);
      await expect(
        page.locator('.maplibregl-ctrl-bottom-right .basemap-switcher-control')
      ).toHaveCount(1);
      await expect(page.locator('.map-overlay-controls > #share-btn')).toHaveCount(1);
      await expect(page.locator('.map-spine-reserve')).toBeHidden();
      await expect(page.locator('#map-info-btn .map-cell-label')).toBeHidden();
      // The word-less home disclosure keeps its name; only the desktop
      // seat, which shows the word Help, leads with it.
      await expect(page.locator('#map-info-btn')).toHaveAttribute('aria-label', 'Map information');
    }
  });
});

/**
 * S30D D1 M10 (register owner-1h, found-016, found-018, found-019; task
 * DDM-P10-T11; design record interface-chrome-popups-text.md sections 2.2,
 * 2.4 and 2.5): the chip (TL-1), TL-0, the pill and the dock hold their
 * seats the same way the column does above, plus the chip's "never hides"
 * and hand-off rules.
 *
 * SAMPLING NARROWED, NAMED: the column's own suite above already proves
 * the 1 px stability method at all four desktop viewports; this block
 * samples the chip's mode x horizon x loading matrix at 1440x900 only
 * (one representative desktop width) to keep run time sane, and separately
 * checks the four-viewport geometry (chip open/collapsed, TL-0, the pill's
 * unset --desktop-loading-top, the dock insets) without the mode/horizon
 * cross. This is a named narrowing, not a silent one.
 *
 * Predicted red on the pre-M10 tree: the chip is 0x0 (hidden) in Drought
 * Near Term and Long Range and Heat season-ahead (no key: `host.hidden =
 * true`); its width varies with content because `#app
 * #map-key[data-key-details-open='false']` is `width: fit-content`; it is
 * absent 170 to 270ms into a mode switch (map-chrome-contract's held
 * loading window); TL-0 is 28x28, not 40x40; the pill sits at top 12, not
 * 18, and has no max-width clear of the chip; the dock's insets are 12px,
 * not --dock-inset (196px).
 */
interface TransientBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The three top-centre-band transients found-018 governs: the loading
 * pill, the hover inspector, and (pre-M10) the copy toast. A hidden or
 * zero-size element reads as `null` (interface-chrome-popups-text.md
 * section 2.5's "found-018" note: "a hidden element counts as not
 * overlapping").
 */
async function transientRects(page: Page): Promise<{
  pill: TransientBox | null;
  inspector: TransientBox | null;
  toast: TransientBox | null;
}> {
  return page.evaluate(() => {
    const rectOf = (id: string): { x: number; y: number; width: number; height: number } | null => {
      const el = document.getElementById(id);
      if (!el || el.hidden) return null;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    return {
      pill: rectOf('loading-indicator'),
      inspector: rectOf('hover-inspector'),
      toast: rectOf('copy-toast')
    };
  });
}

function rectsOverlap(a: TransientBox, b: TransientBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Pairwise non-intersection of whichever of the three transients are
 * currently visible (found-018: "the pill yields to nothing, the hover
 * inspector yields while the pill shows, and the copy toast moves to the
 * dock"). */
function assertNoTransientOverlap(
  rects: { pill: TransientBox | null; inspector: TransientBox | null; toast: TransientBox | null },
  phase: string
): void {
  const entries = (Object.entries(rects) as Array<[string, TransientBox | null]>).filter(
    (entry): entry is [string, TransientBox] => entry[1] !== null
  );
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [nameA, boxA] = entries[i]!;
      const [nameB, boxB] = entries[j]!;
      expect(rectsOverlap(boxA, boxB), `${phase}: ${nameA} overlaps ${nameB}`).toBe(false);
    }
  }
}

test.describe('the chip, TL-0, the pill and the dock hold their D1 M10 seats', () => {
  const MODE_VIEWPORT = { width: 1440, height: 900 } as const;

  /** The chip's box relative to #map-container, or null if it has no
   * rendered box (the pre-M10 hidden state). The TL-1 seat is shared by
   * two nodes with exactly one visible (interface-chrome-popups-text.md
   * section 2.4): `#map-key` (the toggle, closed) in every mode but
   * desktop Brief-with-the-sidebar-open Drought, and the docked drought
   * tile there. Repair round on M10: measure whichever one is actually
   * rendering, not `#map-key` unconditionally. */
  async function chipBox(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return page.evaluate(() => {
      const container = document.getElementById('map-container');
      if (!container) return null;
      const c = container.getBoundingClientRect();
      const visibleBox = (el: Element | null): DOMRect | null => {
        if (!el) return null;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return r;
      };
      const r =
        visibleBox(document.getElementById('map-key')) ??
        visibleBox(document.querySelector('.conditions-metric[data-metric="drought"]'));
      if (!r) return null;
      return { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height };
    });
  }

  test('the chip holds its seat in every mode and horizon, held through a loading phase, at 1440x900', async ({
    page
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(MODE_VIEWPORT);
    const gate = await installLoadingGate(page);
    try {
      await gotoApp(page);
      await settleLayout(page);

      const check = async (phase: string): Promise<void> => {
        const box = await chipBox(page);
        expect(box, `${phase}: the chip has no box`).not.toBeNull();
        const expected = chipSeatRect(false, false, MODE_VIEWPORT.width);
        expect(box!.x, `${phase}: chip x`).toBeCloseTo(expected.x, 0);
        expect(box!.y, `${phase}: chip y`).toBeCloseTo(expected.y, 0);
        expect(box!.width, `${phase}: chip width`).toBeCloseTo(expected.width, 0);
        expect(box!.height, `${phase}: chip height`).toBeCloseTo(expected.height, 0);
      };

      await check('settled boot');

      const modes = await page
        .locator('.shell-cluster-btn[data-cluster]')
        .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-cluster') ?? ''));
      expect(modes.length).toBeGreaterThan(0);
      for (const key of modes) {
        const button = page.locator(`.shell-cluster-btn[data-cluster="${key}"]`);
        gate.hold();
        try {
          await button.click();
          await check(`${key}, held loading`);
        } finally {
          gate.release();
        }
        await expect(button).toHaveAttribute('data-pending', 'false', { timeout: 30_000 });
        await settleLayout(page);
        await check(`${key}, settled`);

        const horizons = await page
          .locator('.shell-horizon-btn')
          .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-horizon') ?? ''));
        for (const horizon of horizons) {
          const chip = page.locator(`.shell-horizon-btn[data-horizon="${horizon}"]`);
          const disabled = (await chip.getAttribute('aria-disabled')) === 'true';
          if (!disabled) {
            await chip.click();
            await expect(page.locator('.shell-cluster-btn[aria-pressed="true"]')).toHaveAttribute(
              'data-pending',
              'false',
              { timeout: 30_000 }
            );
          }
          await settleLayout(page);
          await check(`${key}, horizon ${horizon}${disabled ? ' (disabled)' : ''}`);
        }
      }
    } finally {
      gate.release();
    }
  });

  test('TL-0 sits at (12, 12) 40x40 (44 coarse) and the chip moves to x 60 (64 coarse) while the sidebar is collapsed', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page);
    await settleLayout(page);
    await setSidebar(page, 'collapsed');

    const tl0 = await page.locator('#sidebar-expand').boundingBox();
    const container = await page.locator('#map-container').boundingBox();
    expect(tl0, 'TL-0 has no box while collapsed').not.toBeNull();
    expect(container).not.toBeNull();
    const expectedTl0 = tl0SeatRect(false);
    expect(tl0!.x - container!.x).toBeCloseTo(expectedTl0.x, 0);
    expect(tl0!.y - container!.y).toBeCloseTo(expectedTl0.y, 0);
    expect(tl0!.width).toBeCloseTo(expectedTl0.width, 0);
    expect(tl0!.height).toBeCloseTo(expectedTl0.height, 0);

    const box = await chipBox(page);
    expect(box, 'the chip has no box while collapsed').not.toBeNull();
    const expectedChip = chipSeatRect(true, false, 1440);
    expect(box!.x).toBeCloseTo(expectedChip.x, 0);

    // found-016: with the sidebar collapsed, elementFromPoint over every
    // line of the open key detail returns the detail, not TL-0's svg.
    await page.locator('#map-key-details-toggle').click();
    const lines = await page.evaluate(() => {
      const content = document.getElementById('map-key-content');
      if (!content) return [];
      const items = Array.from(content.querySelectorAll<HTMLElement>('.map-key-item, .map-key-label'));
      return items.slice(0, 5).map((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + Math.min(4, r.width / 2);
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { insideDetail: Boolean(hit && content.contains(hit)) };
      });
    });
    expect(lines.length, 'the open key detail rendered no lines to sample').toBeGreaterThan(0);
    for (const line of lines) expect(line.insideDetail).toBe(true);
  });

  test('the pill keeps --desktop-loading-top unset from 1280 to 2560 wide', async ({ page }) => {
    for (const viewport of DESKTOP_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await gotoApp(page);
      await settleLayout(page);
      const top = await page.evaluate(() =>
        document.getElementById('app')?.style.getPropertyValue('--desktop-loading-top') ?? ''
      );
      expect(top, `${viewport.width}x${viewport.height}: --desktop-loading-top`).toBe('');
    }
  });

  test('the dock carries symmetric --dock-inset insets on the desktop shell', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page);
    await settleLayout(page);
    const insets = await page.evaluate(() => {
      const container = document.getElementById('map-container')?.getBoundingClientRect();
      const dock = document.getElementById('map-bottom-dock')?.getBoundingClientRect();
      const token = getComputedStyle(document.querySelector('.app-shell')!).getPropertyValue('--dock-inset');
      if (!container || !dock) return null;
      return { left: dock.left - container.left, right: container.right - dock.right, token: parseFloat(token) };
    });
    expect(insets).not.toBeNull();
    expect(insets!.left).toBeCloseTo(insets!.token, 0);
    expect(insets!.right).toBeCloseTo(insets!.token, 0);
    expect(insets!.token).toBeCloseTo(MAP_CHROME_TOKENS.dockInset, 0);
  });

  /**
   * found-018 (D1.md M10 TEST FIRST list): the top-centre band holds one
   * transient at a time. The pill yields to nothing; the hover inspector
   * yields while the pill shows (src/ui/hover-inspector.ts's `pillShowing`
   * plus its MutationObserver on `#loading-indicator`'s `hidden`
   * attribute); the copy toast moved into the bottom dock as a notice
   * (src/ui/overlay.ts's `watchToastSeat`, app.css :2369-2382) so it no
   * longer competes for the top-centre seat at all.
   *
   * Predicted red on the pre-M10 tree: `.loading-indicator` and
   * `.hover-inspector` share byte-identical `position: absolute; top:
   * 12px; left: 50%; transform: translateX(-50%)` rules (app.css
   * :2422-2427, :3620-3624) with no yield code between them, so the pill
   * paints directly over the inspector's "State Kansas" reading; and
   * `.copy-toast`'s un-dock-treated rule (app.css :3592-3596) puts it at
   * that same `top: 12px; left: 50%` seat, so a share click during the
   * hover reading paints the toast over the inspector too.
   */
  test('the loading pill, the hover inspector and the copy toast never overlap (found-018)', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(MODE_VIEWPORT);
    const gate = await installLoadingGate(page);
    try {
      // Console view: the layer catalog checkboxes (states) sit behind the
      // console door in Brief (E1 deliverable 1), the same reason
      // tests/hover-inspector.spec.ts boots to console.
      await gotoApp(page, '?view=console');
      await settleLayout(page);

      // Give the hover inspector something to read: the bundled state
      // boundaries (synchronous, no agency fetch), the same fixture
      // tests/hover-inspector.spec.ts uses.
      await layerCheckbox(page, 'states').check();
      await waitForLayerSettled(page, 'states');

      const mapBox = await page.locator('#map').boundingBox();
      if (!mapBox) throw new Error('no map box');
      const cx = mapBox.x + mapBox.width * 0.5;
      const cy = mapBox.y + mapBox.height * 0.5;
      const inspector = page.locator('#hover-inspector');

      const hover = async (): Promise<void> => {
        await expect(async () => {
          await page.mouse.move(cx - 4, cy - 4);
          await page.mouse.move(cx, cy);
          await expect(inspector, 'hover readout never appeared over the state fill').toBeVisible({
            timeout: 1000
          });
        }).toPass({ timeout: 8000 });
      };

      // Phase 1: idle. Only the inspector is up.
      await hover();
      await expect(inspector.locator('.hover-item', { hasText: 'Kansas' })).toHaveCount(1);
      let rects = await transientRects(page);
      expect(rects.inspector, 'idle phase: the inspector has no box').not.toBeNull();
      expect(rects.pill, 'idle phase: the pill should not be up yet').toBeNull();
      expect(rects.toast, 'idle phase: the toast should not be up yet').toBeNull();
      assertNoTransientOverlap(rects, 'idle phase');

      // Phase 2: loading. Hold a mode switch in flight (the s4-shell
      // technique the chip case above already uses) so the pill shows.
      const modes = await page
        .locator('.shell-cluster-btn[data-cluster]')
        .evaluateAll((buttons) =>
          buttons.map((b) => ({
            cluster: b.getAttribute('data-cluster') ?? '',
            pressed: b.getAttribute('aria-pressed') === 'true'
          }))
        );
      const target = modes.find((m) => !m.pressed) ?? modes[0];
      expect(target, 'no cluster mode button found').toBeTruthy();
      gate.hold();
      try {
        await page.locator(`.shell-cluster-btn[data-cluster="${target!.cluster}"]`).click();
        await expect(page.locator('#loading-indicator')).toBeVisible({ timeout: 10_000 });
        // The pointer never moved, so only the MutationObserver on the
        // pill's `hidden` attribute (not a fresh mousemove) can be what
        // clears the inspector here.
        rects = await transientRects(page);
        expect(rects.pill, 'loading phase: the pill has no box').not.toBeNull();
        expect(rects.inspector, 'loading phase: the inspector should yield while the pill shows').toBeNull();
        assertNoTransientOverlap(rects, 'loading phase');
      } finally {
        gate.release();
      }
      await expect(
        page.locator(`.shell-cluster-btn[data-cluster="${target!.cluster}"]`)
      ).toHaveAttribute('data-pending', 'false', { timeout: 30_000 });
      await expect(page.locator('#loading-indicator')).toBeHidden({ timeout: 15_000 });

      // Phase 3: released. The inspector may show again.
      await hover();
      rects = await transientRects(page);
      expect(rects.inspector, 'released phase: the inspector never came back').not.toBeNull();
      expect(rects.pill, 'released phase: the pill should be down again').toBeNull();
      assertNoTransientOverlap(rects, 'released phase');

      // Phase 4: the copy toast (found-018's dock move). Share sits in
      // whichever seat the shell currently homes it to; `#share-btn` is
      // the one DOM node regardless (tests/s4-shell.spec.ts's pattern).
      await page.locator('#share-btn').click();
      await expect(page.locator('#copy-toast')).toBeVisible();
      // `toBeVisible` only asks whether the toast has a box; it says
      // nothing about whether the 0.2s opacity/transform entrance
      // (app.css ":3606-3628", the design record's "settle, not appear in
      // a single frame") has finished. Reading geometry mid-transition
      // caught the toast a few px into its translateY interpolation, a
      // few px above the dock it had already, correctly, moved into.
      await expect
        .poll(() =>
          page.locator('#copy-toast').evaluate((el) => getComputedStyle(el).transform)
        )
        .toBe('matrix(1, 0, 0, 1, 0, 0)');
      rects = await transientRects(page);
      expect(rects.toast, 'toast phase: the toast has no box').not.toBeNull();
      assertNoTransientOverlap(rects, 'toast phase');

      // The toast's OWN seat, not merely its lack of a collision (nothing
      // else may be up at this instant to collide with): found-018 moved
      // it into the bottom dock (src/ui/overlay.ts's `watchToastSeat`),
      // so it must sit inside `#map-bottom-dock`'s box, never back at the
      // pill/inspector's old top-centre spot (app.css :3592-3596).
      const dockSeat = await page.evaluate(() => {
        const dock = document.getElementById('map-bottom-dock')?.getBoundingClientRect();
        const toast = document.getElementById('copy-toast')?.getBoundingClientRect();
        if (!dock || !toast) return null;
        return { toastTop: toast.top, toastBottom: toast.bottom, dockTop: dock.top, dockBottom: dock.bottom };
      });
      expect(dockSeat, 'toast phase: could not read the dock or toast box').not.toBeNull();
      expect(
        dockSeat!.toastTop,
        'toast phase: the toast sits above the dock (found-018 seat regression)'
      ).toBeGreaterThanOrEqual(dockSeat!.dockTop - 1);
      expect(
        dockSeat!.toastBottom,
        'toast phase: the toast sits below the dock (found-018 seat regression)'
      ).toBeLessThanOrEqual(dockSeat!.dockBottom + 1);
    } finally {
      gate.release();
    }
  });
});
