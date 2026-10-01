/**
 * Text registration (S30D D1 M27; DDM-P10-T12; register owner-1l; design
 * record interface-chrome-popups-text.md section 5, "Orphans" and "Fit").
 *
 * Two contracts at the four desktop viewports, every mode read from the
 * rendered `.shell-cluster-btn[data-cluster]` (DR-113), never a literal list:
 *
 * 1. No block of two or more lines and three or more words ends in a
 *    single-word line in the sidebar (Brief and console), both drawers,
 *    both popup sinks and the briefing (WA per DR-109, and the national
 *    default with no place). The 20 builder fixtures join after M26.
 * 2. No chrome label or seat text overflows its box: scroll size within
 *    client size plus 0.5 px, no engaged ellipsis or clamp, and the text's
 *    rendered rectangle inside its box (codex C3).
 *
 * Every read is ONE `page.evaluate` after the boot-idle seam, a
 * `whenQuiescent` read and `document.fonts.ready` (tests/text-lines.ts).
 */

import { expect, test, type Page } from '@playwright/test';

import { KEY_ELIGIBLE_LABELS } from '../src/config/chip-labels';
import { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } from '../src/config/clusters';
import { NADM_CATEGORIES, USDM_CATEGORIES } from '../src/config/palette';
import { awaitQuiescence, gotoApp, waitForLayerSettled } from './helpers';
import {
  describeFindings,
  lineCounts,
  scanFit,
  scanOrphans,
  type TextFitFinding,
  type TextLineFinding
} from './text-lines';

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const;

/**
 * The chrome labels the fit scan judges. The cap-trimmed seat words
 * (`.map-overlay-controls .map-cell > span`, M9) and the cap-trimmed data
 * reading (`.conditions-value` in the data tone) are not in this list: a
 * box trimmed to the cap line and baseline leaves the font's descent below
 * it by design, which this Range comparison reads as leaving the box.
 */
const FIT_SELECTORS = [
  ".conditions-metric[data-tone='off'] .conditions-value",
  ".conditions-metric[data-tone='loading'] .conditions-value",
  '.shell-minimap-title',
  '.shell-minimap-scale',
  '.shell-cluster-btn',
  '.shell-horizon-btn-title',
  '.shell-horizon-btn-sub',
  '.map-key-chip-label',
  '.overlay-btn',
  '.layers-studio-linkout',
  '.brand-text h1',
  '.brand-text p'
] as const;

/** Deterministic answers for the briefing hosts a WA boot reaches (codex C6). */
async function stubBriefingHosts(page: Page): Promise<void> {
  const empty = JSON.stringify({ type: 'FeatureCollection', features: [] });
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/geo+json', body: empty })
  );
  await page.route('https://api.weather.gov/alerts/active?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [] }) })
  );
  await page.route('**/proxy?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
}

async function settle(page: Page): Promise<void> {
  await awaitQuiescence(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function renderedModes(page: Page): Promise<string[]> {
  const modes = await page
    .locator('.shell-cluster-btn[data-cluster]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-cluster') ?? ''));
  expect(modes.length, 'the mode switcher renders its modes').toBeGreaterThan(0);
  return modes.filter((mode) => mode !== '');
}

async function chooseMode(page: Page, mode: string): Promise<void> {
  const button = page.locator(`.shell-cluster-btn[data-cluster="${mode}"]`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('data-pending', 'false', { timeout: 45_000 });
  await settle(page);
}

/**
 * The two Key drawer triggers. On the desktop shell in Brief with the
 * drought family, src/ui/map-key.ts sets `data-key-metric-trigger="true"`
 * on `#map-key`, hazard-indicators.css then hides the host (and its toggle)
 * until the drawer is open, and the docked drought metric opens it
 * (conditions-strip.tsx dispatches `ddm:toggle-map-key-details`). Everywhere
 * else the Key toggle does. interface-responsive.spec.ts's `openMapKey`
 * handles the same two seats.
 */
const DROUGHT_METRIC = '#conditions-strip-dock .conditions-metric[data-metric="drought"][data-layer-on="true"]';
const KEY_TOGGLE = '#map-key .map-key-details-toggle';

interface KeyTriggerState {
  /** The host's own `data-key-metric-trigger` ('true', 'false', or '(no host)'). */
  readonly metricTrigger: string;
  readonly open: boolean;
  readonly metric: boolean;
  readonly toggle: boolean;
}

async function readKeyTrigger(page: Page): Promise<KeyTriggerState> {
  return page.evaluate(
    ([metricSel, toggleSel]) => {
      const shown = (sel: string): boolean => {
        const el = document.querySelector(sel);
        if (!el || el.getClientRects().length === 0) return false;
        const probe = el as Element & { checkVisibility?: (options?: object) => boolean };
        return typeof probe.checkVisibility === 'function' ? probe.checkVisibility({ checkVisibilityCSS: true }) : true;
      };
      const host = document.getElementById('map-key');
      return {
        metricTrigger: host ? (host.dataset.keyMetricTrigger ?? '(unset)') : '(no host)',
        open: host?.dataset.keyDetailsOpen === 'true',
        metric: shown(metricSel),
        toggle: shown(toggleSel)
      };
    },
    [DROUGHT_METRIC, KEY_TOGGLE] as const
  );
}

function keyTriggerFor(state: KeyTriggerState): { selector: string; name: string } {
  return state.metricTrigger === 'true'
    ? { selector: DROUGHT_METRIC, name: 'the docked drought metric' }
    : { selector: KEY_TOGGLE, name: 'the Key toggle' };
}

function keyTriggerVerdict(state: KeyTriggerState): 'open' | 'ready' | 'neither' | 'named-trigger-hidden' {
  if (state.open) return 'open';
  if (state.metricTrigger === 'true' ? state.metric : state.toggle) return 'ready';
  return !state.metric && !state.toggle ? 'neither' : 'named-trigger-hidden';
}

/**
 * Open the Key drawer from the trigger the host itself names. Returns false,
 * without clicking, when neither trigger renders (a mode whose Key has no
 * drawer); fails within 10 s, naming the view, mode and trigger, when the
 * named trigger is hidden while the other one shows.
 */
async function openKeyDrawer(page: Page, where: string): Promise<boolean> {
  let state = await readKeyTrigger(page);
  try {
    await expect
      .poll(async () => {
        state = await readKeyTrigger(page);
        return keyTriggerVerdict(state);
      }, { timeout: 8_000 })
      .toMatch(/^(open|ready)$/);
  } catch {
    if (keyTriggerVerdict(state) === 'neither') return false;
    // Otherwise the visible assertion below fails with the reason.
  }
  if (!state.open) {
    const trigger = keyTriggerFor(state);
    const locator = page.locator(trigger.selector).first();
    await expect(
      locator,
      `${where}: #map-key data-key-metric-trigger="${state.metricTrigger}" names ${trigger.name} ` +
        `(${trigger.selector}) to open the Key drawer, and it is not visible ` +
        `(drought metric visible: ${state.metric}; Key toggle visible: ${state.toggle})`
    ).toBeVisible({ timeout: 2_000 });
    await locator.click({ timeout: 10_000 });
  }
  await expect(page.locator('#map-key-content'), `${where}: the Key drawer opens`).toBeVisible({ timeout: 10_000 });
  await settle(page);
  return true;
}

/** Close the Key drawer with the trigger that opened it; assert it closed. */
async function closeKeyDrawer(page: Page, where: string): Promise<void> {
  const state = await readKeyTrigger(page);
  if (state.open) {
    const trigger = keyTriggerFor(state);
    const locator = page.locator(trigger.selector).first();
    await expect(
      locator,
      `${where}: #map-key data-key-metric-trigger="${state.metricTrigger}" names ${trigger.name} ` +
        `(${trigger.selector}) to close the Key drawer, and it is not visible`
    ).toBeVisible({ timeout: 10_000 });
    await locator.click({ timeout: 10_000 });
  }
  await expect(page.locator('#map-key'), `${where}: the Key drawer closes`).toHaveAttribute(
    'data-key-details-open',
    'false'
  );
  await expect(page.locator('#map-key-content')).toBeHidden();
}

/**
 * The drought READING: the docked drought tile on the desktop shell, whose
 * code and category name the design's "D4 Exceptional Drought" case names.
 */
const DROUGHT_READING = '#conditions-strip-dock .conditions-metric[data-metric="drought"]';

/** Every drought category code and name the reading can show (USDM and NADM share D0 to D4). */
const DROUGHT_CATEGORIES = [...USDM_CATEGORIES, ...NADM_CATEGORIES]
  .map((c) => ({ code: c.code, label: c.label }))
  .filter((c, i, all) => all.findIndex((o) => o.code === c.code && o.label === c.label) === i);

interface DroughtLine {
  readonly code: string;
  readonly label: string;
  /** True for the reading as the app drew it; false for a category set in place. */
  readonly rendered: boolean;
  readonly codeLines: number;
  readonly labelLines: number;
  readonly sameLine: boolean;
  readonly ellipsis: boolean;
}

interface DroughtReading {
  readonly where: string;
  readonly rendered: boolean;
  readonly why: string;
  readonly tone: string;
  readonly code: string;
  readonly label: string;
  readonly lines: readonly DroughtLine[];
}

/**
 * Read the drought reading in ONE evaluate: the category as drawn, then each
 * of `DROUGHT_CATEGORIES` set into the same two text nodes, measured, and
 * the original text restored before the evaluate returns.
 */
async function readDroughtReading(page: Page, where: string): Promise<DroughtReading> {
  // A tile still loading has no category yet: wait for its tone to settle.
  const tile = page.locator(DROUGHT_READING).first();
  if (await tile.isVisible()) {
    await expect
      .poll(async () => (await tile.getAttribute('data-tone')) ?? '', {
        timeout: 15_000,
        message: `${where}: the drought reading settles out of its loading tone`
      })
      .not.toBe('loading');
  }
  const read = await page.evaluate(
    ([sel, categories]) => {
      const none = (why: string, tone: string) => ({ rendered: false, why, tone, code: '', label: '', lines: [] });
      const tile = document.querySelector<HTMLElement>(sel);
      if (!tile) return none('no tile', '(none)');
      const tone = tile.dataset.tone ?? '(unset)';
      const probe = tile as HTMLElement & { checkVisibility?: (options?: object) => boolean };
      if (
        tile.getClientRects().length === 0 ||
        (typeof probe.checkVisibility === 'function' && !probe.checkVisibility({ checkVisibilityCSS: true }))
      ) {
        return none('tile hidden', tone);
      }
      const value = tile.querySelector<HTMLElement>('.conditions-value');
      const sub = tile.querySelector<HTMLElement>('.conditions-sublabel');
      const ownText = (el: HTMLElement | null): Text | null =>
        el
          ? ((Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '') as
              | Text
              | undefined) ?? null)
          : null;
      const codeNode = ownText(value);
      const labelNode = ownText(sub);
      if (!value || !sub || !codeNode || !labelNode) return none('no code or name text', tone);

      const wordLines = (node: Text): { lines: number; box: DOMRect } => {
        const text = node.textContent ?? '';
        const tops: { top: number; bottom: number }[] = [];
        for (const match of text.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index ?? 0);
          range.setEnd(node, (match.index ?? 0) + match[0].length);
          const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
          const last = rects[rects.length - 1];
          if (last) tops.push({ top: last.top, bottom: last.bottom });
        }
        let lines = tops.length > 0 ? 1 : 0;
        for (let i = 1; i < tops.length; i += 1) {
          if (tops[i]!.top >= tops[i - 1]!.bottom - 1) lines += 1;
        }
        const whole = document.createRange();
        whole.selectNodeContents(node);
        return { lines, box: whole.getBoundingClientRect() };
      };
      const measure = (rendered: boolean) => {
        const code = wordLines(codeNode);
        const label = wordLines(labelNode);
        return {
          code: (codeNode.textContent ?? '').trim(),
          label: (labelNode.textContent ?? '').trim(),
          rendered,
          codeLines: code.lines,
          labelLines: label.lines,
          sameLine: code.box.top < label.box.bottom - 1 && label.box.top < code.box.bottom - 1,
          ellipsis: sub.clientWidth > 0 && sub.scrollWidth > sub.clientWidth + 0.5
        };
      };

      const drawn = measure(true);
      const lines = [drawn];
      if (tone === 'data') {
        const originalCode = codeNode.textContent;
        const originalLabel = labelNode.textContent;
        for (const category of categories) {
          codeNode.textContent = category.code;
          labelNode.textContent = category.label;
          lines.push(measure(false));
        }
        codeNode.textContent = originalCode;
        labelNode.textContent = originalLabel;
      }
      return { rendered: true, why: '', tone, code: drawn.code, label: drawn.label, lines };
    },
    [DROUGHT_READING, DROUGHT_CATEGORIES] as const
  );
  return { where, ...read };
}

async function withMapInformation(page: Page, where: string, read: () => Promise<void>): Promise<void> {
  const button = page.locator('#map-info-btn');
  await expect(button, `${where}: the Map information button (#map-info-btn) is not visible`).toBeVisible({
    timeout: 10_000
  });
  await button.click({ timeout: 10_000 });
  await expect(page.locator('#map-info-panel')).toBeVisible();
  await settle(page);
  await read();
  await page.keyboard.press('Escape');
  await expect(page.locator('#map-info-panel')).toBeHidden();
}

/** Click the map centre until the coordinated response shows in `sink`. */
async function openPlaceResponse(page: Page, sink: string): Promise<void> {
  const mapBox = await page.locator('#map').boundingBox();
  expect(mapBox).not.toBeNull();
  const content = page.locator(sink).first();
  await expect(async () => {
    await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
    await expect(content).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await settle(page);
}

for (const viewport of VIEWPORTS) {
  test.describe(`text registration at ${viewport.width}x${viewport.height} (DDM-P10-T12)`, () => {
    test.use({ viewport });

    test('no block of two or more lines and three or more words ends in a single-word line in the sidebar, the drawers, both popup sinks and the briefing for WA and CONUS', async ({
      page
    }) => {
      test.setTimeout(240_000);
      await stubBriefingHosts(page);
      const findings: TextLineFinding[] = [];
      // Non-vacuity: every scanned root must render and hold measured words,
      // except a root the caller names as optional (CONUS has no briefing).
      const coverageGaps: string[] = [];
      const scan = async (where: string, roots: readonly string[], optional: readonly string[] = []): Promise<void> => {
        const { findings: list, coverage } = await scanOrphans(page, roots);
        for (const f of list) findings.push({ ...f, root: `${where} ${f.root}` });
        for (const c of coverage) {
          if (optional.includes(c.root)) continue;
          if (c.rendered === 0 || c.words === 0) {
            coverageGaps.push(`${where} ${c.root}: found ${c.found}, rendered ${c.rendered}, words measured ${c.words}`);
          }
        }
      };

      // The sidebar and both drawers, Brief then console, every mode.
      for (const view of ['brief', 'console'] as const) {
        await gotoApp(page, `?view=${view}`);
        await settle(page);
        if (view === 'brief') {
          // CONUS with no place: the national default is the `?view=brief`
          // boot itself, so this one navigation serves it. It has no
          // briefing door (impact-panel-a11y.spec.ts "a region spanning
          // several states shows no briefing trigger"), so its Brief sidebar
          // is what a reader gets; `#impact-panel` is scanned if it renders.
          await scan('CONUS brief', ['.sidebar', '#impact-panel'], ['#impact-panel']);
        }
        const noDrawer: string[] = [];
        let drawers = 0;
        const modes = await renderedModes(page);
        for (const mode of modes) {
          const where = `${view}/${mode}`;
          await chooseMode(page, mode);
          await scan(where, ['.sidebar']);
          if (await openKeyDrawer(page, where)) {
            drawers += 1;
            await scan(where, ['#map-key-content']);
            await closeKeyDrawer(page, where);
          } else {
            noDrawer.push(mode);
          }
          await withMapInformation(page, where, async () => {
            await scan(where, ['#map-info-panel']);
          });
        }
        expect(
          drawers,
          `${view}: no rendered mode showed a visible Key trigger, so no Key drawer was scanned (modes: ${modes.join(', ')}; without a drawer: ${noDrawer.join(', ')})`
        ).toBeGreaterThan(0);
      }

      // Both popup sinks with what exists in this wave: the map popup under
      // console and the panel foot under Brief (popup-viewport.spec.ts's
      // fixture path: the WA framing and the reservation fixture fill).
      await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations');
      await waitForLayerSettled(page, 'bia-reservations');
      await openPlaceResponse(page, '.maplibregl-popup-content');
      await scan('console popup', ['.maplibregl-popup-content']);
      await gotoApp(page, '?region=washington_state&view=brief&layers=bia-reservations');
      await waitForLayerSettled(page, 'bia-reservations');
      await openPlaceResponse(page, '#panel-response .coordinated-response');
      await scan('brief panel foot', ['#panel-response']);

      // The briefing for WA (DR-109).
      await gotoApp(page, '?view=brief&layers=places&select=state:WA&region=washington_state');
      await expect(page.locator('#impact-panel')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.impact-horizons .impact-hazard').first()).toBeVisible();
      await settle(page);
      await scan('WA briefing', ['#impact-panel']);

      expect(
        coverageGaps,
        `a scanned root rendered no measurable text, so its scan read nothing:\n${coverageGaps.join('\n')}` +
          `\n(findings so far:\n${describeFindings(findings)})`
      ).toEqual([]);
      expect(findings, describeFindings(findings)).toEqual([]);
    });

    test('the horizon titles are control labels that read on one line (codex C1: "Current Conditions")', async ({
      page
    }) => {
      await gotoApp(page, '?view=brief');
      await settle(page);
      const titles = await lineCounts(page, '.shell-horizon-btn-title');
      expect(titles.length, 'every horizon renders its title').toBeGreaterThan(0);
      expect(
        titles.filter((t) => t.lines !== 1),
        titles.map((t) => `"${t.text}" ${t.lines} lines`).join('; ')
      ).toEqual([]);
    });

    test('no chrome label or seat text overflows its box', async ({ page }) => {
      test.setTimeout(180_000);
      await stubBriefingHosts(page);
      const failures: TextFitFinding[] = [];
      // Non-vacuity: every scan must measure at least one visible label, and
      // the named evidence selectors must be measured somewhere in the case.
      const measuredTotals: Record<string, number> = {};
      const scanGaps: string[] = [];
      const fit = async (where: string): Promise<void> => {
        const { findings: list, measured } = await scanFit(page, FIT_SELECTORS);
        for (const f of list) failures.push({ ...f, selector: `${where} ${f.selector}` });
        let total = 0;
        for (const [selector, count] of Object.entries(measured)) {
          measuredTotals[selector] = (measuredTotals[selector] ?? 0) + count;
          total += count;
        }
        if (total === 0) scanGaps.push(`${where}: no chrome label rendered (${JSON.stringify(measured)})`);
      };

      // Every KEY_ELIGIBLE_LABELS value and every clusters.ts title in the
      // chip's own label box, measured in place and restored in the same
      // evaluate (the chip renders one label at a time). Measured in every
      // view and mode where the chip renders; the only place it may not is
      // the one map-key.ts hides by design (the Brief drought host, whose
      // drawer opens from the docked metric), and a hidden label is never
      // compared (its 0 of 0 would pass vacuously).
      const words = [
        ...Object.values(KEY_ELIGIBLE_LABELS),
        ...HAZARD_CLUSTER_KEYS.map((key) => HAZARD_CLUSTERS[key].title)
      ];
      const chipOverflow: string[] = [];
      const chipGaps: string[] = [];
      let chipMeasured = 0;
      const measureChip = async (where: string): Promise<void> => {
        const chip = await page.evaluate((labels: string[]) => {
          const host = document.getElementById('map-key');
          const hiddenByDesign =
            host?.dataset.keyMetricTrigger === 'true' && host.dataset.keyDetailsOpen === 'false';
          const el = document.querySelector<HTMLElement>('#map-key .map-key-chip-label');
          const rendered = !!el && el.getClientRects().length > 0 && el.clientWidth > 0;
          if (!el || !rendered) {
            return { hiddenByDesign, rendered: false, width: el ? el.clientWidth : -1, overflow: [] as string[] };
          }
          const original = el.textContent;
          const overflow: string[] = [];
          for (const text of labels) {
            el.textContent = text;
            if (el.scrollWidth > el.clientWidth + 0.5) overflow.push(`"${text}" ${el.scrollWidth} > ${el.clientWidth}`);
          }
          el.textContent = original;
          return { hiddenByDesign, rendered: true, width: el.clientWidth, overflow };
        }, words);
        if (chip.rendered) {
          chipMeasured += 1;
          for (const o of chip.overflow) chipOverflow.push(`${where} ${o}`);
        } else if (!chip.hiddenByDesign) {
          chipGaps.push(`${where}: the chip label (#map-key .map-key-chip-label) does not render (clientWidth ${chip.width})`);
        }
      };

      // "The drought reading is 'D4 Exceptional Drought' on one line" (design
      // record section 5 "Fit"): the READING is the docked drought tile, its
      // code (`.conditions-value`) beside its category name
      // (`.conditions-sublabel`); the Key drawer shows code chips only. Read
      // in every view and mode where the tile renders: the category it draws
      // as it is, then every palette category (D4 among them) set into the
      // same two text nodes and restored in the same evaluate, as the chip
      // check above does. Each must read as one line, code and name on the
      // same line, with no ellipsis engaged.
      const readings: DroughtReading[] = [];
      const readDrought = async (where: string): Promise<void> => {
        readings.push(await readDroughtReading(page, where));
      };

      // Every mode in Brief (the minimap scale reads per mode) and console.
      for (const view of ['brief', 'console'] as const) {
        await gotoApp(page, `?view=${view}`);
        await settle(page);
        for (const mode of await renderedModes(page)) {
          const where = `${view}/${mode}`;
          await chooseMode(page, mode);
          await fit(where);
          await measureChip(where);
          await readDrought(where);
        }
      }

      // The off state word: console with an event layer on and the drought
      // surface off (conditions-strip.spec.ts's 'Layer off' fixture).
      await gotoApp(page, '?view=console&layers=nws-alerts');
      await waitForLayerSettled(page, 'nws-alerts');
      await expect(page.locator('.conditions-metric[data-tone="off"] .conditions-value').first()).toBeVisible();
      await settle(page);
      await fit('console/alerts');

      const evidence = [
        ".conditions-metric[data-tone='off'] .conditions-value",
        '.shell-minimap-scale',
        '.shell-cluster-btn',
        '.map-key-chip-label'
      ];
      const unmeasured = evidence.filter((selector) => (measuredTotals[selector] ?? 0) === 0);
      expect(
        [...scanGaps, ...unmeasured.map((selector) => `${selector}: measured 0 times in the whole case`)],
        `a fit scan read nothing; measured per selector: ${JSON.stringify(measuredTotals)}`
      ).toEqual([]);

      expect(chipGaps, chipGaps.join('; ')).toEqual([]);
      expect(chipMeasured, 'the chip label renders and is measured in at least one view and mode').toBeGreaterThan(0);
      expect(chipOverflow, chipOverflow.join('; ')).toEqual([]);

      // Non-vacuity: the tile rendered a category reading somewhere, its
      // name is a palette category name paired with that category's code,
      // and the in-place pass measured D4 "Exceptional drought".
      const seen = readings.map((r) => `${r.where}: ${r.rendered ? `tone ${r.tone} "${r.code}" "${r.label}"` : `not rendered (${r.why})`}`);
      const categoryReadings = readings.filter((r) => r.rendered && r.tone === 'data');
      expect(
        categoryReadings.length,
        `the docked drought reading (${DROUGHT_READING}) rendered a category in no view and mode:\n${seen.join('\n')}`
      ).toBeGreaterThan(0);
      const unpaired = categoryReadings.filter(
        (r) => !DROUGHT_CATEGORIES.some((c) => c.code === r.code && c.label.toLowerCase() === r.label.toLowerCase())
      );
      expect(
        unpaired.map((r) => `${r.where}: "${r.code}" "${r.label}" is not a palette category code and name`),
        seen.join('\n')
      ).toEqual([]);
      const measuredD4 = categoryReadings.some((r) =>
        r.lines.some((line) => line.code === 'D4' && /^exceptional drought$/i.test(line.label))
      );
      expect(measuredD4, `the in-place pass measured D4 Exceptional drought in the reading:\n${seen.join('\n')}`).toBe(true);
      const offLine = categoryReadings.flatMap((r) =>
        r.lines
          .filter((line) => line.codeLines !== 1 || line.labelLines !== 1 || !line.sameLine || line.ellipsis)
          .map(
            (line) =>
              `${r.where} "${line.code} ${line.label}"${line.rendered ? ' (as rendered)' : ''}: code ${line.codeLines} line(s), ` +
              `name ${line.labelLines} line(s), same line ${line.sameLine}, ellipsis ${line.ellipsis}`
          )
      );
      expect(offLine, offLine.join('\n')).toEqual([]);

      expect(failures, describeFindings(failures)).toEqual([]);
    });
  });
}

test.describe('text registration leaves the phone layout alone (codex C5)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('at 390x844 the touched selectors keep the phone rules: no desktop wrapping, measure or trim reaches them', async ({
    page
  }) => {
    await gotoApp(page, '?view=console&layers=nws-alerts');
    await waitForLayerSettled(page, 'nws-alerts');
    const reading = await page.evaluate(() => {
      const style = (selector: string, property: string): string | null => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el).getPropertyValue(property) : null;
      };
      return {
        prose: style('.sidebar p', 'text-wrap-style'),
        measure: style('.sidebar p', 'max-inline-size'),
        overflowWrap: style('.sidebar p', 'overflow-wrap'),
        offWord: style(".conditions-metric[data-tone='off'] .conditions-value", 'text-box-edge'),
        scaleWhiteSpace: style('.shell-minimap-scale', 'white-space'),
        horizonTitle: style('.shell-horizon-btn-title', 'text-wrap-mode')
      };
    });
    // The phone keeps the browser defaults the desktop block overrides.
    expect(reading.prose === null || reading.prose === 'auto', `prose ${reading.prose}`).toBe(true);
    expect(reading.measure === null || reading.measure === 'none', `measure ${reading.measure}`).toBe(true);
    expect(reading.overflowWrap === null || reading.overflowWrap === 'normal', `overflow-wrap ${reading.overflowWrap}`).toBe(true);
    expect(reading.offWord === null || /cap/.test(reading.offWord), `off word ${reading.offWord}`).toBe(true);
    expect(reading.scaleWhiteSpace === null || reading.scaleWhiteSpace === 'nowrap', `scale ${reading.scaleWhiteSpace}`).toBe(true);
    expect(reading.horizonTitle === null || reading.horizonTitle === 'wrap', `horizon ${reading.horizonTitle}`).toBe(true);
  });
});
